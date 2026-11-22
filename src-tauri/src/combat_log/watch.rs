use notify::{Event, EventKind, RecursiveMode, Watcher};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::recording::metadata::{
    normalize_manual_marker_name, update_manual_marker_name_in_sidecar,
};

use super::metadata::{persist_recording_metadata_snapshot, RecordingMetadataAccumulator};
use super::parse::{extract_combat_trigger_event, extract_log_timestamp, LogTimestamp};
use super::{
    build_combat_log_directory_path, find_latest_combat_log_in_directory,
    find_latest_combat_log_path, is_combat_log_file_name, CombatEvent, CombatTriggerEvent,
    CombatWatchStatusEvent, EVENT_MANUAL_MARKER,
};

struct WatchState {
    handle: Option<JoinHandle<()>>,
    start_time: Instant,
    recording_output_path: Option<PathBuf>,
    metadata_accumulator: Arc<Mutex<RecordingMetadataAccumulator>>,
}

static WATCH_STATE: LazyLock<Arc<Mutex<Option<WatchState>>>> =
    LazyLock::new(|| Arc::new(Mutex::new(None)));

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

    let wow_folder_path = Path::new(&wow_folder);
    if !wow_folder_is_valid(wow_folder_path) {
        return Err(format!(
            "WoW folder is invalid: '{wow_folder}'. Select the retail client folder or its Logs directory."
        ));
    }

    let logs_directory = build_combat_log_directory_path(&wow_folder);
    std::fs::create_dir_all(&logs_directory).map_err(|error| {
        format!(
            "Failed to prepare combat log directory '{}': {error}",
            logs_directory.display()
        )
    })?;

    let log_path = find_latest_combat_log_path(&wow_folder)?;
    let initial_offset = match &log_path {
        Some(path) => std::fs::metadata(path)
            .map_err(|error| error.to_string())?
            .len(),
        None => 0,
    };

    let app_handle_clone = app_handle.clone();
    let logs_directory_clone = logs_directory.clone();
    let log_path_clone = log_path.clone();
    let start_time = Instant::now();
    let metadata_accumulator = Arc::new(Mutex::new(RecordingMetadataAccumulator::default()));
    if let Some(existing_log_path) = &log_path {
        if let Err(error) =
            seed_metadata_context_from_log_tail(existing_log_path, &metadata_accumulator)
        {
            emit_combat_watch_status(
                &app_handle,
                "warn",
                &format!("Combat context seed failed: {error}"),
                Some(existing_log_path),
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
                    Some(existing_log_path),
                );
            }
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

    if let Some(existing_log_path) = &log_path {
        emit_combat_watch_status(
            &app_handle,
            "info",
            "Combatlog watcher active!",
            Some(existing_log_path),
        );
    } else {
        emit_combat_watch_status(
            &app_handle,
            "info",
            "Combatlog watcher waiting for WoWCombatLog*.txt",
            None,
        );
    }

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
    wow_folder_is_valid(Path::new(path.trim()))
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
                extra_spell_name: None,
                amount: None,
                ability_name: None,
                name: None,
            };
            emit_combat_event(&app_handle, &event);
            persist_watch_metadata_if_configured(watch_state);
        }

        return Ok(());
    }

    Err("Combat watch not running".to_string())
}

/// Names the manual marker at `timestamp_seconds`, or clears the name when `name` is absent.
///
/// A marker from the session that is still recording lives in the accumulator, which owns the
/// sidecar while the watch runs. Markers from an older recording are edited in the sidecar
/// directly, so `file_path` is required for that case.
#[tauri::command]
pub fn update_manual_marker_name(
    file_path: Option<String>,
    timestamp_seconds: f64,
    occurrence: Option<u32>,
    name: Option<String>,
) -> Result<(), String> {
    let normalized_name = normalize_manual_marker_name(name);
    let occurrence = occurrence.unwrap_or(0) as usize;

    if update_live_manual_marker_name(timestamp_seconds, occurrence, normalized_name.clone())? {
        return Ok(());
    }

    let recording_path = file_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Recording path is required to name a marker".to_string())?;

    update_manual_marker_name_in_sidecar(
        Path::new(recording_path),
        timestamp_seconds,
        occurrence,
        normalized_name,
    )
}

fn update_live_manual_marker_name(
    timestamp_seconds: f64,
    occurrence: usize,
    name: Option<String>,
) -> Result<bool, String> {
    let state = WATCH_STATE.lock().map_err(|error| error.to_string())?;
    let Some(watch_state) = state.as_ref() else {
        return Ok(false);
    };

    let marker_was_named = {
        let mut metadata_accumulator = watch_state
            .metadata_accumulator
            .lock()
            .map_err(|error| error.to_string())?;
        if !metadata_accumulator.is_recording_session_active() {
            return Ok(false);
        }

        metadata_accumulator.set_manual_marker_name(timestamp_seconds, occurrence, name)
    };

    if !marker_was_named {
        return Ok(false);
    }

    if let Some(recording_output_path) = watch_state.recording_output_path.as_deref() {
        persist_recording_metadata_snapshot(
            recording_output_path,
            &watch_state.metadata_accumulator,
        )?;
    } else {
        tracing::warn!(
            timestamp_seconds,
            "Named a live manual marker with no recording output path, name is not persisted yet"
        );
    }

    Ok(true)
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

fn directory_name_eq(path: &Path, expected: &str) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case(expected))
        .unwrap_or(false)
}

fn wow_folder_is_valid(path: &Path) -> bool {
    if path.as_os_str().is_empty() || !path.is_dir() {
        return false;
    }

    if directory_name_eq(path, "Logs") {
        return true;
    }

    const WOW_CLIENT_DIRECTORY_NAMES: &[&str] =
        &["_retail_", "_classic_", "_classic_era_", "_ptr_", "_beta_"];
    if WOW_CLIENT_DIRECTORY_NAMES
        .iter()
        .any(|name| directory_name_eq(path, name))
    {
        return true;
    }

    path.join("Wow.exe").is_file()
        || path.join("WowClassic.exe").is_file()
        || path.join("Logs").is_dir()
}

async fn watch_combat_log(
    app_handle: AppHandle,
    logs_directory: PathBuf,
    initial_log_path: Option<PathBuf>,
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
                    apply_latest_combat_log_path(
                        &app_handle,
                        &mut current_log_path,
                        &mut file_offset,
                        latest_log_path,
                        start_time,
                        &metadata_accumulator,
                    )?;
                }

                if let Some(log_path) = current_log_path.as_ref() {
                    if let Err(error) = read_and_emit_new_events(
                        &app_handle,
                        log_path,
                        &mut file_offset,
                        start_time,
                        &metadata_accumulator,
                    ) {
                        tracing::warn!("Failed to parse combat log update: {error}");
                    }
                }
            }
            Err(error) => {
                tracing::warn!("Combat log watcher error: {error}");
            }
        }
    }

    Ok(())
}

fn apply_latest_combat_log_path(
    app_handle: &AppHandle,
    current_log_path: &mut Option<PathBuf>,
    file_offset: &mut u64,
    latest_log_path: PathBuf,
    start_time: Instant,
    metadata_accumulator: &Arc<Mutex<RecordingMetadataAccumulator>>,
) -> Result<(), String> {
    let switched = match current_log_path.as_ref() {
        None => true,
        Some(current) => current != &latest_log_path,
    };
    if !switched {
        return Ok(());
    }

    if let Some(old_log_path) = current_log_path.as_ref() {
        if let Err(error) = read_and_emit_new_events(
            app_handle,
            old_log_path,
            file_offset,
            start_time,
            metadata_accumulator,
        ) {
            tracing::warn!(
                old_log = %old_log_path.display(),
                "Failed to drain combat log before switching files: {error}"
            );
        }

        let abandoned_end = {
            let mut accumulator = metadata_accumulator
                .lock()
                .map_err(|error| error.to_string())?;
            accumulator.take_abandoned_auto_session_end_trigger()
        };
        if let Some(trigger_event) = abandoned_end {
            tracing::info!(
                mode = %trigger_event.mode,
                "Combat log rotated while an auto session was still active; emitting end trigger"
            );
            emit_combat_trigger_event(app_handle, &trigger_event);
        }
    }

    *current_log_path = Some(latest_log_path.clone());
    *file_offset = 0;
    emit_combat_watch_status(
        app_handle,
        "info",
        "Combatlog watcher active!",
        Some(&latest_log_path),
    );
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

#[cfg(test)]
mod tests {
    use super::{find_latest_combat_log_in_directory, wow_folder_is_valid};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let directory = std::env::temp_dir().join(format!("floorpov-{label}-{unique}"));
        fs::create_dir_all(&directory).expect("temp directory");
        directory
    }

    #[test]
    fn accepts_retail_folder_without_combat_log() {
        let root = temp_dir("retail");
        let retail = root.join("_retail_");
        fs::create_dir(&retail).expect("retail directory");

        assert!(wow_folder_is_valid(&retail));
        assert_eq!(
            find_latest_combat_log_in_directory(&retail.join("Logs")).unwrap(),
            None
        );

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn accepts_logs_folder_without_combat_log() {
        let root = temp_dir("logs");
        let logs = root.join("Logs");
        fs::create_dir(&logs).expect("logs directory");

        assert!(wow_folder_is_valid(&logs));
        assert_eq!(find_latest_combat_log_in_directory(&logs).unwrap(), None);

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn rejects_empty_or_missing_folder() {
        assert!(!wow_folder_is_valid(std::path::Path::new("")));
        let missing = std::env::temp_dir().join("floorpov-missing-wow-folder");
        let _ = fs::remove_dir_all(&missing);
        assert!(!wow_folder_is_valid(&missing));
    }
}
