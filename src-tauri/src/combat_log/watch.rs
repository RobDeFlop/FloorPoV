use notify::{Event, EventKind, RecursiveMode, Watcher};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::metadata::{persist_recording_metadata_snapshot, RecordingMetadataAccumulator};
use super::parse::{extract_combat_trigger_event, extract_log_timestamp, LogTimestamp};
use super::{CombatEvent, CombatTriggerEvent, CombatWatchStatusEvent, EVENT_MANUAL_MARKER};

struct WatchState {
    handle: Option<JoinHandle<()>>,
    start_time: Instant,
    recording_output_path: Option<PathBuf>,
    metadata_accumulator: Arc<Mutex<RecordingMetadataAccumulator>>,
}

lazy_static::lazy_static! {
    static ref WATCH_STATE: Arc<Mutex<Option<WatchState>>> = Arc::new(Mutex::new(None));
}

#[tauri::command]
pub async fn start_combat_watch(
    app_handle: AppHandle,
    wow_folder: String,
    recording_output_path: Option<String>,
) -> Result<(), String> {
    let mut state = WATCH_STATE.lock().map_err(|error| error.to_string())?;

    if let Some(watch_state) = state.as_mut() {
        if let Some(output_path) =
            normalized_output_recording_path(recording_output_path.as_deref())
        {
            begin_watch_recording_session(watch_state, output_path);
        }
        emit_combat_watch_status(&app_handle, "info", "Combatlog watcher active!", None);
        return Ok(());
    }

    let logs_directory = build_combat_log_directory_path(&wow_folder);
    let log_path = find_latest_combat_log_path(&wow_folder)?.ok_or_else(|| {
        format!(
            "WoW combat log file not found at '{}'. Expected a file like '{}'.",
            wow_folder,
            logs_directory.join("WoWCombatLog*.txt").to_string_lossy()
        )
    })?;

    let initial_offset = std::fs::metadata(&log_path)
        .map_err(|error| error.to_string())?
        .len();

    let app_handle_clone = app_handle.clone();
    let logs_directory_clone = logs_directory.clone();
    let log_path_clone = log_path.clone();
    let start_time = Instant::now();
    let metadata_accumulator = Arc::new(Mutex::new(RecordingMetadataAccumulator::default()));
    if let Err(error) = seed_metadata_context_from_log_tail(&log_path, &metadata_accumulator) {
        emit_combat_watch_status(
            &app_handle,
            "warn",
            &format!("Combat context seed failed: {error}"),
            Some(&log_path),
        );
    } else {
        let seeded_zone = metadata_accumulator
            .lock()
            .ok()
            .and_then(|accumulator| accumulator.current_context_zone_name());
        if let Some(zone_name) = seeded_zone {
            emit_combat_watch_status(
                &app_handle,
                "info",
                &format!("Context seeded: {zone_name}"),
                Some(&log_path),
            );
        }
    }
    let metadata_accumulator_clone = Arc::clone(&metadata_accumulator);

    let handle = tokio::spawn(async move {
        if let Err(error) = watch_combat_log(
            app_handle_clone,
            logs_directory_clone,
            log_path_clone,
            initial_offset,
            start_time,
            metadata_accumulator_clone,
        )
        .await
        {
            tracing::error!("Combat log watcher stopped: {error}");
        }
    });

    *state = Some(WatchState {
        handle: Some(handle),
        start_time,
        recording_output_path: normalized_output_recording_path(recording_output_path.as_deref()),
        metadata_accumulator,
    });

    if let Some(watch_state) = state.as_mut() {
        if let Some(output_path) = watch_state.recording_output_path.clone() {
            begin_watch_recording_session(watch_state, output_path);
        }
    }

    emit_combat_watch_status(
        &app_handle,
        "info",
        "Combatlog watcher active!",
        Some(&log_path),
    );

    Ok(())
}

fn normalized_output_recording_path(recording_output_path: Option<&str>) -> Option<PathBuf> {
    recording_output_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

#[tauri::command]
pub async fn stop_combat_watch(app_handle: AppHandle) -> Result<(), String> {
    let mut state = WATCH_STATE.lock().map_err(|error| error.to_string())?;

    if let Some(watch_state) = state.take() {
        if let Some(handle) = watch_state.handle.as_ref() {
            handle.abort();
        }

        persist_watch_metadata_if_configured(&watch_state);
    }

    emit_combat_watch_status(&app_handle, "info", "Combatlog watcher stopped", None);

    Ok(())
}

#[tauri::command]
pub fn set_combat_watch_recording_output(
    recording_output_path: Option<String>,
) -> Result<(), String> {
    let mut state = WATCH_STATE.lock().map_err(|error| error.to_string())?;
    let Some(watch_state) = state.as_mut() else {
        return Err("Combat watch not running".to_string());
    };

    if let Some(output_path) = normalized_output_recording_path(recording_output_path.as_deref()) {
        begin_watch_recording_session(watch_state, output_path);
        return Ok(());
    }

    persist_watch_metadata_if_configured(watch_state);
    watch_state.recording_output_path = None;
    match watch_state.metadata_accumulator.lock() {
        Ok(mut metadata_accumulator) => metadata_accumulator.finish_recording_session(),
        Err(error) => {
            tracing::warn!(
                metadata_error = %error,
                "Failed to lock metadata accumulator while clearing recording output"
            );
        }
    }

    Ok(())
}

fn begin_watch_recording_session(watch_state: &mut WatchState, output_path: PathBuf) {
    watch_state.recording_output_path = Some(output_path);
    let elapsed_seconds = watch_state.start_time.elapsed().as_secs_f64();

    match watch_state.metadata_accumulator.lock() {
        Ok(mut metadata_accumulator) => {
            metadata_accumulator.begin_recording_session(elapsed_seconds)
        }
        Err(error) => {
            tracing::warn!(
                metadata_error = %error,
                "Failed to lock metadata accumulator while starting recording session"
            );
        }
    }
}

fn seed_metadata_context_from_log_tail(
    log_path: &Path,
    metadata_accumulator: &Arc<Mutex<RecordingMetadataAccumulator>>,
) -> Result<(), String> {
    const CONTEXT_SEED_BYTES: u64 = 256 * 1024;

    let mut file = File::open(log_path).map_err(|error| error.to_string())?;
    let file_length = file.metadata().map_err(|error| error.to_string())?.len();
    let seed_start_offset = file_length.saturating_sub(CONTEXT_SEED_BYTES);

    file.seek(SeekFrom::Start(seed_start_offset))
        .map_err(|error| error.to_string())?;

    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer)
        .map_err(|error| error.to_string())?;

    let text = String::from_utf8_lossy(&buffer);
    let mut lines = text.lines();
    if seed_start_offset > 0 {
        let _ = lines.next();
    }

    let mut accumulator = metadata_accumulator
        .lock()
        .map_err(|error| error.to_string())?;
    for line in lines {
        let _ = accumulator.consume_combat_log_line(line, 0.0);
    }

    Ok(())
}

fn persist_watch_metadata_if_configured(watch_state: &WatchState) {
    let Some(recording_output_path) = watch_state.recording_output_path.as_deref() else {
        return;
    };

    if let Err(error) = persist_recording_metadata_snapshot(
        recording_output_path,
        &watch_state.metadata_accumulator,
    ) {
        tracing::warn!(
            recording_path = %recording_output_path.display(),
            metadata_error = %error,
            "Failed to persist combat metadata sidecar"
        );
    }
}

#[tauri::command]
pub fn validate_wow_folder(path: String) -> bool {
    if path.trim().is_empty() {
        return false;
    }

    match find_latest_combat_log_path(&path) {
        Ok(log_path) => log_path.is_some(),
        Err(_) => false,
    }
}

#[tauri::command]
pub async fn emit_manual_marker(app_handle: AppHandle) -> Result<(), String> {
    let state = WATCH_STATE.lock().map_err(|error| error.to_string())?;

    if let Some(watch_state) = state.as_ref() {
        let elapsed = watch_state.start_time.elapsed().as_secs_f64();
        let mut should_emit_event = false;
        let mut event_timestamp = elapsed;

        match watch_state.metadata_accumulator.lock() {
            Ok(mut metadata_accumulator) => {
                if metadata_accumulator.is_recording_session_active() {
                    metadata_accumulator.record_manual_marker(elapsed);
                    if let Some(recording_elapsed_seconds) =
                        metadata_accumulator.recording_elapsed_seconds(elapsed, None)
                    {
                        event_timestamp = recording_elapsed_seconds;
                    }
                    should_emit_event = true;
                }
            }
            Err(error) => {
                tracing::error!(
                    metadata_error = %error,
                    "Failed to lock metadata accumulator for manual marker"
                );
            }
        }

        if should_emit_event {
            let event = CombatEvent {
                timestamp: event_timestamp,
                event_type: EVENT_MANUAL_MARKER.to_string(),
                source: None,
                target: None,
            };
            emit_combat_event(&app_handle, &event);
        }

        return Ok(());
    }

    Err("Combat watch not running".to_string())
}

fn emit_combat_event(app_handle: &AppHandle, event: &CombatEvent) {
    if let Err(error) = app_handle.emit("combat-event", event) {
        tracing::warn!(
            event_type = %event.event_type,
            emit_error = %error,
            "Failed to emit combat event"
        );
    }
}

fn emit_combat_trigger_event(app_handle: &AppHandle, event: &CombatTriggerEvent) {
    if let Err(error) = app_handle.emit("combat-trigger", event) {
        tracing::warn!(
            event_type = %event.event_type,
            emit_error = %error,
            "Failed to emit combat trigger event"
        );
    }
}

fn emit_combat_watch_status(
    app_handle: &AppHandle,
    level: &str,
    message: &str,
    watched_log_path: Option<&Path>,
) {
    let status_event = CombatWatchStatusEvent {
        level: level.to_string(),
        message: message.to_string(),
        watched_log_path: watched_log_path.map(|path| path.to_string_lossy().to_string()),
    };

    if let Err(error) = app_handle.emit("combat-watch-status", status_event) {
        tracing::warn!(emit_error = %error, "Failed to emit combat watch status event");
    }
}

fn build_combat_log_directory_path(wow_folder: &str) -> PathBuf {
    let candidate_path = Path::new(wow_folder);
    let is_logs_directory = candidate_path
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("Logs"))
        .unwrap_or(false);

    if is_logs_directory {
        candidate_path.to_path_buf()
    } else {
        candidate_path.join("Logs")
    }
}

fn is_combat_log_file_name(file_name: &str) -> bool {
    let lower_file_name = file_name.to_ascii_lowercase();
    lower_file_name.starts_with("wowcombatlog") && lower_file_name.ends_with(".txt")
}

fn find_latest_combat_log_path(wow_folder: &str) -> Result<Option<PathBuf>, String> {
    let logs_directory = build_combat_log_directory_path(wow_folder);
    find_latest_combat_log_in_directory(&logs_directory)
}

fn find_latest_combat_log_in_directory(logs_directory: &Path) -> Result<Option<PathBuf>, String> {
    let directory_entries = match std::fs::read_dir(logs_directory) {
        Ok(entries) => entries,
        Err(error) => {
            if logs_directory.exists() {
                return Err(error.to_string());
            }
            return Ok(None);
        }
    };

    let mut latest_match: Option<(SystemTime, PathBuf)> = None;

    for entry_result in directory_entries {
        let entry = entry_result.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !is_combat_log_file_name(file_name) {
            continue;
        }

        let modified_time = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);

        if latest_match
            .as_ref()
            .map(|(latest_time, _)| modified_time > *latest_time)
            .unwrap_or(true)
        {
            latest_match = Some((modified_time, path));
        }
    }

    Ok(latest_match.map(|(_, path)| path))
}

async fn watch_combat_log(
    app_handle: AppHandle,
    logs_directory: PathBuf,
    initial_log_path: PathBuf,
    initial_offset: u64,
    start_time: Instant,
    metadata_accumulator: Arc<Mutex<RecordingMetadataAccumulator>>,
) -> Result<(), String> {
    let (notify_sender, mut notify_receiver) =
        mpsc::unbounded_channel::<Result<Event, notify::Error>>();

    let mut watcher = notify::recommended_watcher(move |result| {
        if notify_sender.send(result).is_err() {
            tracing::debug!("Combat log watcher notification receiver dropped");
        }
    })
    .map_err(|error| error.to_string())?;

    watcher
        .watch(&logs_directory, RecursiveMode::NonRecursive)
        .map_err(|error| error.to_string())?;

    let mut current_log_path = initial_log_path;
    let mut file_offset = initial_offset;
    while let Some(notification_result) = notify_receiver.recv().await {
        match notification_result {
            Ok(event) => {
                if !is_relevant_notification(&event) {
                    continue;
                }

                if let Some(latest_log_path) = find_latest_combat_log_in_directory(&logs_directory)?
                {
                    if latest_log_path != current_log_path {
                        current_log_path = latest_log_path.clone();
                        file_offset = 0;
                        // emit_combat_watch_status(
                        //     &app_handle,
                        //     "info",
                        //     "Switched watched combat log file",
                        //     Some(&latest_log_path),
                        // );
                    }
                }

                if let Err(error) = read_and_emit_new_events(
                    &app_handle,
                    &current_log_path,
                    &mut file_offset,
                    start_time,
                    &metadata_accumulator,
                ) {
                    tracing::warn!("Failed to parse combat log update: {error}");
                }
            }
            Err(error) => {
                tracing::warn!("Combat log watcher error: {error}");
            }
        }
    }

    Ok(())
}

fn is_relevant_notification(event: &Event) -> bool {
    let relevant_kind = matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_));
    if !relevant_kind {
        return false;
    }

    event.paths.iter().any(|path| {
        path.file_name()
            .and_then(|value| value.to_str())
            .map(is_combat_log_file_name)
            .unwrap_or(false)
    })
}

fn read_and_emit_new_events(
    app_handle: &AppHandle,
    log_path: &Path,
    file_offset: &mut u64,
    start_time: Instant,
    metadata_accumulator: &Arc<Mutex<RecordingMetadataAccumulator>>,
) -> Result<(), String> {
    let mut file = File::open(log_path).map_err(|error| error.to_string())?;
    let file_length = file.metadata().map_err(|error| error.to_string())?.len();

    if file_length < *file_offset {
        *file_offset = 0;
    }

    file.seek(SeekFrom::Start(*file_offset))
        .map_err(|error| error.to_string())?;

    let mut reader = BufReader::new(file);
    let mut line = String::new();

    loop {
        line.clear();
        let bytes_read = reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if bytes_read == 0 {
            break;
        }

        *file_offset = file_offset.saturating_add(bytes_read as u64);
        let elapsed_seconds = start_time.elapsed().as_secs_f64();
        let log_timestamp_seconds = line.trim().split(',').next().and_then(|header| {
            let ts = extract_log_timestamp(header);
            LogTimestamp::parse(&ts).map(|t| t.to_seconds_since_midnight())
        });
        let (parsed_event, recording_active, recording_elapsed_seconds) = {
            let mut accumulator = metadata_accumulator
                .lock()
                .map_err(|error| error.to_string())?;
            let parsed_event = accumulator.consume_combat_log_line(&line, elapsed_seconds);
            let recording_active = accumulator.is_recording_session_active();
            let recording_elapsed_seconds =
                accumulator.recording_elapsed_seconds(elapsed_seconds, log_timestamp_seconds);
            (parsed_event, recording_active, recording_elapsed_seconds)
        };

        if let Some(trigger_event) = parsed_event.as_ref().and_then(extract_combat_trigger_event) {
            emit_combat_trigger_event(app_handle, &trigger_event);
        }

        if recording_active {
            if let Some(event) =
                parsed_event.and_then(|value| value.into_live_event(recording_elapsed_seconds))
            {
                emit_combat_event(app_handle, &event);
            }
        }
    }

    Ok(())
}
