use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::recording::metadata::{
    RecordingEncounterSnapshot, RecordingImportantEventMetadata, RecordingMetadata,
    RecordingMetadataSnapshot, RecordingPlayerMetadata,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CombatEvent {
    pub timestamp: f64,
    pub event_type: String,
    pub source: Option<String>,
    pub target: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CombatTriggerEvent {
    pub trigger_type: String,
    pub mode: String,
    pub event_type: String,
    pub encounter_name: Option<String>,
    pub key_level: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CombatWatchStatusEvent {
    pub level: String,
    pub message: String,
    pub watched_log_path: Option<String>,
}

const MAX_DEBUG_EVENTS: usize = 2_000;
const MAX_PERSISTED_HIGH_VOLUME_EVENTS: usize = 20_000;
const EVENT_MANUAL_MARKER: &str = "MANUAL_MARKER";
const EVENT_ENCOUNTER_START: &str = "ENCOUNTER_START";
const EVENT_ENCOUNTER_END: &str = "ENCOUNTER_END";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedCombatEvent {
    pub line_number: u64,
    pub log_timestamp: String,
    pub event_type: String,
    pub source: Option<String>,
    pub target: Option<String>,
    pub target_kind: Option<String>,
    pub zone_name: Option<String>,
    pub encounter_name: Option<String>,
    pub encounter_category: Option<String>,
    pub key_level: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseCombatLogDebugResult {
    pub file_path: String,
    pub file_size_bytes: u64,
    pub total_lines: u64,
    pub parsed_events: Vec<ParsedCombatEvent>,
    pub event_counts: BTreeMap<String, u64>,
    pub truncated: bool,
}

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

#[tauri::command]
pub fn parse_combat_log_file(file_path: String) -> Result<ParseCombatLogDebugResult, String> {
    if !cfg!(debug_assertions) {
        return Err("Combat log debug parsing is only available in debug builds".to_string());
    }

    if file_path.trim().is_empty() {
        return Err("Combat log file path is required".to_string());
    }

    let path = Path::new(&file_path);
    if !path.is_file() {
        return Err(format!("Combat log file not found: {}", file_path));
    }

    let file_size_bytes = std::fs::metadata(path)
        .map_err(|error| error.to_string())?
        .len();
    let file = File::open(path).map_err(|error| error.to_string())?;
    let reader = BufReader::new(file);

    let mut total_lines = 0_u64;
    let mut parsed_events: Vec<ParsedCombatEvent> = Vec::new();
    let mut event_counts: BTreeMap<String, u64> = BTreeMap::new();
    let mut truncated = false;
    let mut debug_context = DebugParseContext::default();

    for line_result in reader.lines() {
        let line = line_result.map_err(|error| error.to_string())?;
        total_lines += 1;

        if let Some(parsed_event) = parse_important_log_line(&line, total_lines, &mut debug_context)
        {
            *event_counts
                .entry(parsed_event.event_type.clone())
                .or_insert(0) += 1;
            if parsed_events.len() < MAX_DEBUG_EVENTS {
                parsed_events.push(parsed_event);
            } else {
                truncated = true;
            }
        }
    }

    Ok(ParseCombatLogDebugResult {
        file_path,
        file_size_bytes,
        total_lines,
        parsed_events,
        event_counts,
        truncated,
    })
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

#[derive(Debug, Clone)]
struct ImportantCombatEvent {
    raw_event_type: String,
    log_timestamp: Option<String>,
    event_type: String,
    source: Option<String>,
    target: Option<String>,
    target_kind: Option<String>,
    zone_name: Option<String>,
    encounter_name: Option<String>,
    encounter_category: Option<String>,
    key_level: Option<u32>,
}

#[derive(Debug, Clone)]
struct CombatantInfoSnapshot {
    player_guid: String,
    spec_id: Option<u32>,
    class_name: Option<String>,
    spec_name: Option<String>,
}

#[derive(Debug, Clone)]
struct PlayerIdentity {
    guid: String,
    name: Option<String>,
}

impl ImportantCombatEvent {
    fn into_live_event(self, recording_elapsed_seconds: Option<f64>) -> Option<CombatEvent> {
        let timestamp = recording_elapsed_seconds?;
        match self.event_type.as_str() {
            "PARTY_KILL" | "UNIT_DIED" => Some(CombatEvent {
                timestamp,
                event_type: self.event_type,
                source: self.source,
                target: self.target,
            }),
            _ => None,
        }
    }
}

fn extract_combat_trigger_event(event: &ImportantCombatEvent) -> Option<CombatTriggerEvent> {
    match event.raw_event_type.as_str() {
        "CHALLENGE_MODE_START" => Some(CombatTriggerEvent {
            trigger_type: "start".to_string(),
            mode: "mythicPlus".to_string(),
            event_type: "CHALLENGE_MODE_START".to_string(),
            encounter_name: event.encounter_name.clone(),
            key_level: event.key_level,
        }),
        "CHALLENGE_MODE_END" => Some(CombatTriggerEvent {
            trigger_type: "end".to_string(),
            mode: "mythicPlus".to_string(),
            event_type: "CHALLENGE_MODE_END".to_string(),
            encounter_name: event.encounter_name.clone(),
            key_level: event.key_level,
        }),
        "ENCOUNTER_START" => {
            if event.encounter_category.as_deref() != Some("raid") {
                return None;
            }

            Some(CombatTriggerEvent {
                trigger_type: "start".to_string(),
                mode: "raid".to_string(),
                event_type: "ENCOUNTER_START".to_string(),
                encounter_name: event.encounter_name.clone(),
                key_level: event.key_level,
            })
        }
        "ENCOUNTER_END" => {
            if event.encounter_category.as_deref() != Some("raid") {
                return None;
            }

            Some(CombatTriggerEvent {
                trigger_type: "end".to_string(),
                mode: "raid".to_string(),
                event_type: "ENCOUNTER_END".to_string(),
                encounter_name: event.encounter_name.clone(),
                key_level: event.key_level,
            })
        }
        "ARENA_MATCH_START" | "PVP_MATCH_START" | "BATTLEGROUND_START" => {
            Some(CombatTriggerEvent {
                trigger_type: "start".to_string(),
                mode: "pvp".to_string(),
                event_type: event.raw_event_type.clone(),
                encounter_name: event.encounter_name.clone(),
                key_level: event.key_level,
            })
        }
        "ARENA_MATCH_END" | "PVP_MATCH_COMPLETE" | "BATTLEGROUND_END" => Some(CombatTriggerEvent {
            trigger_type: "end".to_string(),
            mode: "pvp".to_string(),
            event_type: event.raw_event_type.clone(),
            encounter_name: event.encounter_name.clone(),
            key_level: event.key_level,
        }),
        _ => None,
    }
}

fn parse_important_combat_event(
    line: &str,
    context: &mut DebugParseContext,
) -> Option<ImportantCombatEvent> {
    let parsed_line = parse_log_line_fields(line)?;

    update_debug_context(context, &parsed_line);

    if let Some(zone_name) = extract_zone_name(&parsed_line.raw_event_type, &parsed_line.fields) {
        context.current_zone = Some(zone_name);
    }

    let (encounter_name, encounter_category) =
        resolve_encounter_state_for_event(context, &parsed_line);

    if is_guardian_target(parsed_line.target_kind.as_deref()) {
        return None;
    }

    Some(ImportantCombatEvent {
        raw_event_type: parsed_line.raw_event_type,
        log_timestamp: Some(parsed_line.log_timestamp),
        event_type: parsed_line.normalized_event_type,
        source: parsed_line.source,
        target: parsed_line.target,
        target_kind: parsed_line.target_kind,
        zone_name: context.current_zone.clone(),
        encounter_name,
        encounter_category,
        key_level: context.current_key_level,
    })
}

fn resolve_encounter_state_for_event(
    context: &mut DebugParseContext,
    parsed_line: &ParsedLogLine,
) -> (Option<String>, Option<String>) {
    let mut encounter_name = context.current_encounter.clone();
    let mut encounter_category = context.current_encounter_category.clone();

    match parsed_line.raw_event_type.as_str() {
        EVENT_ENCOUNTER_START => {
            if let Some(new_encounter_name) = extract_encounter_name(&parsed_line.fields) {
                context.current_encounter = Some(new_encounter_name.clone());
                encounter_name = Some(new_encounter_name);
            }
            let category = classify_encounter_category(context, &parsed_line.fields).to_string();
            context.current_encounter_category = Some(category.clone());
            encounter_category = Some(category);
            // Store the log timestamp so we can use it as anchor when recording starts mid-encounter
            context.current_encounter_log_timestamp = Some(parsed_line.log_timestamp.clone());
        }
        EVENT_ENCOUNTER_END => {
            if let Some(finished_encounter_name) = extract_encounter_name(&parsed_line.fields) {
                encounter_name = Some(finished_encounter_name);
            }
            if encounter_category.is_none() {
                encounter_category =
                    Some(classify_encounter_category(context, &parsed_line.fields).to_string());
            }
            context.current_encounter = None;
            context.current_encounter_category = None;
            context.current_encounter_log_timestamp = None;
        }
        _ => {}
    }

    (encounter_name, encounter_category)
}

fn parse_important_log_line(
    line: &str,
    line_number: u64,
    context: &mut DebugParseContext,
) -> Option<ParsedCombatEvent> {
    let parsed_event = parse_important_combat_event(line, context)?;

    if is_context_only_event(&parsed_event.raw_event_type) {
        return None;
    }

    Some(ParsedCombatEvent {
        line_number,
        log_timestamp: parsed_event.log_timestamp.unwrap_or_default(),
        event_type: parsed_event.event_type,
        source: parsed_event.source,
        target: parsed_event.target,
        target_kind: parsed_event.target_kind,
        zone_name: parsed_event.zone_name,
        encounter_name: parsed_event.encounter_name,
        encounter_category: parsed_event.encounter_category,
        key_level: parsed_event.key_level,
    })
}

#[derive(Debug, Default)]
struct DebugParseContext {
    current_zone: Option<String>,
    current_encounter: Option<String>,
    current_encounter_category: Option<String>,
    current_encounter_log_timestamp: Option<String>,
    current_key_level: Option<u32>,
    challenge_mode_start_log_timestamp: Option<String>,
    pvp_match_start_log_timestamp: Option<String>,
    in_challenge_mode: bool,
    in_pvp_match: bool,
}

#[derive(Debug, Default)]
pub(crate) struct RecordingMetadataAccumulator {
    context: DebugParseContext,
    context_players: BTreeMap<String, RecordingPlayerMetadata>,
    recording_players: BTreeMap<String, RecordingPlayerMetadata>,
    zone_name: Option<String>,
    latest_encounter_name: Option<String>,
    latest_encounter_category: Option<String>,
    key_level: Option<u32>,
    active_encounters: BTreeMap<String, usize>,
    encounters: Vec<RecordingEncounterSnapshot>,
    important_events: Vec<RecordingImportantEventMetadata>,
    important_event_counts: BTreeMap<String, u64>,
    important_events_dropped_count: u64,
    high_volume_events_in_buffer: usize,
    recording_active: bool,
    recording_elapsed_origin_seconds: f64,
    session_log_origin_seconds: Option<f64>,
}

impl RecordingMetadataAccumulator {
    fn consume_combat_log_line(
        &mut self,
        line: &str,
        elapsed_seconds: f64,
    ) -> Option<ImportantCombatEvent> {
        if let Some(raw_event_type) = extract_raw_event_type_from_line(line) {
            if should_reset_player_roster_for_event(raw_event_type) {
                self.reset_player_roster();
            }
        }

        self.capture_combatant_info_snapshot(line);
        self.capture_player_names_for_known_roster(line);

        let parsed_event = parse_important_combat_event(line, &mut self.context)?;

        if self.recording_active && !is_context_only_event(&parsed_event.raw_event_type) {
            self.record_important_event(&parsed_event, elapsed_seconds);
        }
        Some(parsed_event)
    }

    fn begin_recording_session(&mut self, elapsed_seconds: f64) {
        self.reset_recording_data();
        self.recording_active = true;
        self.recording_elapsed_origin_seconds = elapsed_seconds;
        self.recording_players = self.context_players.clone();
        self.zone_name = self.context.current_zone.clone();
        self.latest_encounter_name = self.context.current_encounter.clone();
        self.latest_encounter_category = self.context.current_encounter_category.clone();
        self.key_level = self.context.current_key_level;

        // Try to anchor log-clock to activity start time (encounter, M+, or PvP)
        // Priority: ENCOUNTER_START > CHALLENGE_MODE_START > PVP_MATCH_START
        let anchor_log_timestamp = self
            .context
            .current_encounter_log_timestamp
            .clone()
            .or_else(|| self.context.challenge_mode_start_log_timestamp.clone())
            .or_else(|| self.context.pvp_match_start_log_timestamp.clone());

        if let Some(ref log_ts) = anchor_log_timestamp {
            if let Some(timestamp_seconds) =
                LogTimestamp::parse(log_ts).map(|t| t.to_seconds_since_midnight())
            {
                self.session_log_origin_seconds = Some(timestamp_seconds);
            }
        }

        if let (Some(encounter_name), Some(encounter_category)) = (
            self.context.current_encounter.clone(),
            self.context.current_encounter_category.clone(),
        ) {
            let encounter_key = encounter_key(&encounter_name, &encounter_category);
            let index = self.encounters.len();
            self.encounters.push(RecordingEncounterSnapshot {
                name: encounter_name,
                category: encounter_category,
                started_at_seconds: 0.0,
                ended_at_seconds: None,
            });
            self.active_encounters.insert(encounter_key, index);

            *self
                .important_event_counts
                .entry(EVENT_ENCOUNTER_START.to_string())
                .or_insert(0) += 1;
            self.push_event_with_cap(RecordingImportantEventMetadata {
                timestamp_seconds: 0.0,
                log_timestamp: self.context.current_encounter_log_timestamp.clone(),
                event_type: EVENT_ENCOUNTER_START.to_string(),
                source: None,
                target: None,
                target_kind: None,
                zone_name: self.zone_name.clone(),
                encounter_name: self.latest_encounter_name.clone(),
                encounter_category: self.latest_encounter_category.clone(),
                key_level: self.key_level,
            });
        }
    }

    fn finish_recording_session(&mut self) {
        self.recording_active = false;
    }

    fn is_recording_session_active(&self) -> bool {
        self.recording_active
    }

    fn current_context_zone_name(&self) -> Option<String> {
        self.context.current_zone.clone()
    }

    fn recording_elapsed_seconds(
        &self,
        elapsed_seconds: f64,
        log_timestamp_seconds: Option<f64>,
    ) -> Option<f64> {
        if !self.recording_active {
            return None;
        }

        // If we have both log origin and current log timestamp, use log-clock
        if let (Some(origin), Some(current)) =
            (self.session_log_origin_seconds, log_timestamp_seconds)
        {
            let diff = current - origin;

            // Normal case: current >= origin
            if diff >= 0.0 {
                return Some(diff);
            }

            // Midnight rollover: current < origin means we crossed midnight
            let next_day_diff = current + 86400.0 - origin;
            if next_day_diff >= 0.0 {
                return Some(next_day_diff);
            }

            tracing::warn!(
                origin_seconds = origin,
                current_seconds = current,
                diff_seconds = diff,
                "Log-clock produced negative diff even after midnight adjustment, using fallback"
            );
        }

        // Fallback to wall-clock (for manual markers or when log timestamps unavailable)
        let fallback = elapsed_seconds - self.recording_elapsed_origin_seconds;
        if !fallback.is_finite() || fallback < 0.0 {
            return None;
        }

        Some(fallback)
    }

    fn reset_recording_data(&mut self) {
        self.zone_name = None;
        self.latest_encounter_name = None;
        self.latest_encounter_category = None;
        self.key_level = None;
        self.recording_players.clear();
        self.active_encounters.clear();
        self.encounters.clear();
        self.important_events.clear();
        self.important_event_counts.clear();
        self.important_events_dropped_count = 0;
        self.high_volume_events_in_buffer = 0;
        self.session_log_origin_seconds = None;
    }

    fn record_manual_marker(&mut self, elapsed_seconds: f64) {
        if !self.recording_active {
            return;
        }

        let manual_event = ImportantCombatEvent {
            raw_event_type: EVENT_MANUAL_MARKER.to_string(),
            log_timestamp: None,
            event_type: EVENT_MANUAL_MARKER.to_string(),
            source: None,
            target: None,
            target_kind: None,
            zone_name: self.zone_name.clone(),
            encounter_name: self.latest_encounter_name.clone(),
            encounter_category: self.latest_encounter_category.clone(),
            key_level: self.key_level,
        };
        self.record_important_event(&manual_event, elapsed_seconds);
    }

    fn record_important_event(&mut self, event: &ImportantCombatEvent, elapsed_seconds: f64) {
        let log_timestamp_seconds = event
            .log_timestamp
            .as_ref()
            .and_then(|ts| LogTimestamp::parse(ts).map(|t| t.to_seconds_since_midnight()));

        // Anchor the log origin to the first recorded event with a log timestamp
        if log_timestamp_seconds.is_some() && self.session_log_origin_seconds.is_none() {
            self.session_log_origin_seconds = log_timestamp_seconds;
        }

        let Some(recording_elapsed_seconds) =
            self.recording_elapsed_seconds(elapsed_seconds, log_timestamp_seconds)
        else {
            return;
        };

        *self
            .important_event_counts
            .entry(event.event_type.clone())
            .or_insert(0) += 1;

        update_option_if_some(&mut self.zone_name, event.zone_name.as_ref());
        update_option_if_some(
            &mut self.latest_encounter_name,
            event.encounter_name.as_ref(),
        );
        update_option_if_some(
            &mut self.latest_encounter_category,
            event.encounter_category.as_ref(),
        );
        if let Some(key_level) = event.key_level {
            self.key_level = Some(key_level);
        }

        match event.event_type.as_str() {
            EVENT_ENCOUNTER_START => self.record_encounter_start(event, recording_elapsed_seconds),
            EVENT_ENCOUNTER_END => self.record_encounter_end(event, recording_elapsed_seconds),
            _ => {}
        }

        self.push_event_with_cap(RecordingImportantEventMetadata {
            timestamp_seconds: recording_elapsed_seconds,
            log_timestamp: event.log_timestamp.clone(),
            event_type: event.event_type.clone(),
            source: event.source.clone(),
            target: event.target.clone(),
            target_kind: event.target_kind.clone(),
            zone_name: event.zone_name.clone(),
            encounter_name: event.encounter_name.clone(),
            encounter_category: event.encounter_category.clone(),
            key_level: event.key_level,
        });
    }

    fn reset_player_roster(&mut self) {
        self.context_players.clear();
        if self.recording_active {
            self.recording_players.clear();
        }
    }

    fn capture_combatant_info_snapshot(&mut self, line: &str) {
        let Some(combatant_info) = parse_combatant_info_snapshot(line) else {
            return;
        };

        self.apply_player_update(RecordingPlayerMetadata {
            guid: combatant_info.player_guid,
            name: None,
            class_name: combatant_info.class_name,
            spec_name: combatant_info.spec_name,
            spec_id: combatant_info.spec_id,
        });
    }

    fn capture_player_names_for_known_roster(&mut self, line: &str) {
        let Some((source_identity, target_identity)) = parse_player_identities_from_log_line(line)
        else {
            return;
        };

        if let Some(source_player) = source_identity {
            self.update_player_name_if_known(&source_player.guid, source_player.name.as_deref());
        }

        if let Some(target_player) = target_identity {
            self.update_player_name_if_known(&target_player.guid, target_player.name.as_deref());
        }
    }

    fn update_player_name_if_known(&mut self, player_guid: &str, player_name: Option<&str>) {
        let Some(name) = player_name else {
            return;
        };

        let normalized_name = name.to_string();

        if let Some(player) = self.context_players.get_mut(player_guid) {
            player.name = Some(normalized_name.clone());
        }

        if self.recording_active {
            if let Some(player) = self.recording_players.get_mut(player_guid) {
                player.name = Some(normalized_name);
            }
        }
    }

    fn apply_player_update(&mut self, update: RecordingPlayerMetadata) {
        merge_player_update(&mut self.context_players, &update);

        if self.recording_active {
            merge_player_update(&mut self.recording_players, &update);
        }
    }

    fn record_encounter_start(&mut self, event: &ImportantCombatEvent, elapsed_seconds: f64) {
        let Some((encounter_name, encounter_category)) = encounter_identity(event) else {
            return;
        };

        let encounter_key = encounter_key(&encounter_name, &encounter_category);
        if self.active_encounters.contains_key(&encounter_key) {
            return;
        }

        let index = self.encounters.len();
        self.encounters.push(RecordingEncounterSnapshot {
            name: encounter_name,
            category: encounter_category,
            started_at_seconds: elapsed_seconds,
            ended_at_seconds: None,
        });
        self.active_encounters.insert(encounter_key, index);
    }

    fn record_encounter_end(&mut self, event: &ImportantCombatEvent, elapsed_seconds: f64) {
        let Some((encounter_name, encounter_category)) = encounter_identity(event) else {
            return;
        };

        let encounter_key = encounter_key(&encounter_name, &encounter_category);
        if let Some(index) = self.active_encounters.remove(&encounter_key) {
            if let Some(encounter) = self.encounters.get_mut(index) {
                encounter.ended_at_seconds = Some(elapsed_seconds);
            }
            return;
        }

        self.encounters.push(RecordingEncounterSnapshot {
            name: encounter_name,
            category: encounter_category,
            started_at_seconds: 0.0,
            ended_at_seconds: Some(elapsed_seconds),
        });
    }

    fn push_event_with_cap(&mut self, event: RecordingImportantEventMetadata) {
        if is_structural_event_type(&event.event_type) {
            self.important_events.push(event);
            return;
        }

        if self.high_volume_events_in_buffer >= MAX_PERSISTED_HIGH_VOLUME_EVENTS
            && !self.trim_oldest_high_volume_event()
        {
            self.important_events_dropped_count =
                self.important_events_dropped_count.saturating_add(1);
            return;
        }

        self.important_events.push(event);
        self.high_volume_events_in_buffer = self.high_volume_events_in_buffer.saturating_add(1);
    }

    fn trim_oldest_high_volume_event(&mut self) -> bool {
        let Some(oldest_high_volume_index) = self
            .important_events
            .iter()
            .position(|event| !is_structural_event_type(&event.event_type))
        else {
            return false;
        };

        self.important_events.remove(oldest_high_volume_index);
        self.high_volume_events_in_buffer = self.high_volume_events_in_buffer.saturating_sub(1);
        self.important_events_dropped_count = self.important_events_dropped_count.saturating_add(1);
        true
    }

    pub(crate) fn snapshot(&self) -> RecordingMetadataSnapshot {
        RecordingMetadataSnapshot {
            zone_name: self.zone_name.clone(),
            encounter_name: self.latest_encounter_name.clone(),
            encounter_category: self.latest_encounter_category.clone(),
            key_level: self.key_level,
            encounters: self.encounters.clone(),
            important_events: self.important_events.clone(),
            important_event_counts: self.important_event_counts.clone(),
            important_events_dropped_count: self.important_events_dropped_count,
            players: self.recording_players.values().cloned().collect(),
        }
    }
}

fn update_option_if_some(slot: &mut Option<String>, value: Option<&String>) {
    if let Some(value) = value {
        *slot = Some(value.clone());
    }
}

fn encounter_identity(event: &ImportantCombatEvent) -> Option<(String, String)> {
    let encounter_name = event.encounter_name.as_ref()?.clone();
    let encounter_category = event.encounter_category.as_ref()?.clone();
    Some((encounter_name, encounter_category))
}

fn encounter_key(encounter_name: &str, encounter_category: &str) -> String {
    format!("{encounter_name}:{encounter_category}")
}

fn is_structural_event_type(event_type: &str) -> bool {
    matches!(
        event_type,
        EVENT_MANUAL_MARKER | EVENT_ENCOUNTER_START | EVENT_ENCOUNTER_END
    )
}

fn persist_recording_metadata_snapshot(
    recording_output_path: &Path,
    metadata_accumulator: &Arc<Mutex<RecordingMetadataAccumulator>>,
) -> Result<(), String> {
    let snapshot = {
        let accumulator = metadata_accumulator
            .lock()
            .map_err(|error| error.to_string())?;
        accumulator.snapshot()
    };

    if !snapshot.has_content() {
        return Ok(());
    }

    let mut metadata = crate::recording::metadata::read_recording_metadata(recording_output_path)?
        .unwrap_or_else(|| RecordingMetadata::new(recording_output_path));
    metadata.apply_combat_log_snapshot(snapshot.clone());

    crate::recording::metadata::write_recording_metadata(recording_output_path, &metadata)?;
    Ok(())
}

#[derive(Debug)]
struct ParsedLogLine {
    raw_event_type: String,
    normalized_event_type: String,
    log_timestamp: String,
    source: Option<String>,
    target: Option<String>,
    target_kind: Option<String>,
    fields: Vec<String>,
}

fn parse_log_line_fields(line: &str) -> Option<ParsedLogLine> {
    let trimmed_line = line.trim();
    if trimmed_line.is_empty() {
        return None;
    }

    let mut fields = trimmed_line.split(',');
    let header = fields.next()?.trim();
    let raw_event_type = extract_event_type(header)?;
    let normalized_event_type = normalize_important_event_type(raw_event_type)?;
    let remaining_fields = fields
        .map(|value| value.trim().to_string())
        .collect::<Vec<String>>();

    let source_name = remaining_fields.get(1).map(|value| value.as_str());
    let source_guid = remaining_fields.first().map(|value| value.as_str());
    let source_flags = remaining_fields.get(2).map(|value| value.as_str());
    let dest_guid = remaining_fields.get(4).map(|value| value.as_str());
    let dest_name = remaining_fields.get(5).map(|value| value.as_str());
    let dest_flags = remaining_fields.get(6).map(|value| value.as_str());
    let source_kind = classify_unit_kind(source_flags, source_guid).map(str::to_string);
    let target_kind = classify_unit_kind(dest_flags, dest_guid).map(str::to_string);

    Some(ParsedLogLine {
        raw_event_type: raw_event_type.to_string(),
        normalized_event_type: normalized_event_type.to_string(),
        log_timestamp: extract_log_timestamp(header),
        source: normalize_entity_name(source_name, source_kind.as_deref()),
        target: normalize_entity_name(dest_name, target_kind.as_deref()),
        target_kind,
        fields: remaining_fields,
    })
}

fn normalize_important_event_type(event_type: &str) -> Option<&'static str> {
    match event_type {
        "PARTY_KILL" => Some("PARTY_KILL"),
        "UNIT_DIED" | "UNIT_DESTROYED" => Some("UNIT_DIED"),
        "SPELL_INTERRUPT" => Some("SPELL_INTERRUPT"),
        "SPELL_DISPEL" => Some("SPELL_DISPEL"),
        "ENCOUNTER_START" => Some("ENCOUNTER_START"),
        "ENCOUNTER_END" => Some("ENCOUNTER_END"),
        event_type if is_zone_context_event_type(event_type) => Some("ZONE_CONTEXT"),
        "CHALLENGE_MODE_START" | "CHALLENGE_MODE_END" => Some("CHALLENGE_CONTEXT"),
        "ARENA_MATCH_START" | "ARENA_MATCH_END" | "PVP_MATCH_START" | "PVP_MATCH_COMPLETE"
        | "BATTLEGROUND_START" | "BATTLEGROUND_END" => Some("PVP_CONTEXT"),
        _ => None,
    }
}

fn update_debug_context(context: &mut DebugParseContext, parsed_line: &ParsedLogLine) {
    match parsed_line.raw_event_type.as_str() {
        "CHALLENGE_MODE_START" => {
            context.in_challenge_mode = true;
            context.current_key_level = extract_challenge_mode_key_level(&parsed_line.fields);
            context.challenge_mode_start_log_timestamp = Some(parsed_line.log_timestamp.clone());
        }
        "CHALLENGE_MODE_END" => {
            context.in_challenge_mode = false;
            context.current_key_level = None;
            context.challenge_mode_start_log_timestamp = None;
        }
        "ARENA_MATCH_START" | "PVP_MATCH_START" | "BATTLEGROUND_START" => {
            context.in_pvp_match = true;
            context.pvp_match_start_log_timestamp = Some(parsed_line.log_timestamp.clone());
        }
        "ARENA_MATCH_END" | "PVP_MATCH_COMPLETE" | "BATTLEGROUND_END" => {
            context.in_pvp_match = false;
            context.pvp_match_start_log_timestamp = None;
        }
        _ => {}
    }
}

fn extract_challenge_mode_key_level(fields: &[String]) -> Option<u32> {
    fields.iter().find_map(|value| {
        let trimmed = value.trim_matches('"');
        trimmed
            .parse::<u32>()
            .ok()
            .filter(|&level| level > 0 && level <= 40)
    })
}

fn is_context_only_event(raw_event_type: &str) -> bool {
    is_zone_context_event_type(raw_event_type)
        || matches!(
            raw_event_type,
            "CHALLENGE_MODE_START"
                | "CHALLENGE_MODE_END"
                | "ARENA_MATCH_START"
                | "ARENA_MATCH_END"
                | "PVP_MATCH_START"
                | "PVP_MATCH_COMPLETE"
                | "BATTLEGROUND_START"
                | "BATTLEGROUND_END"
        )
}

fn classify_encounter_category(context: &DebugParseContext, fields: &[String]) -> &'static str {
    if context.in_challenge_mode {
        return "mythicPlus";
    }

    if context.in_pvp_match {
        return "pvp";
    }

    if let Some(difficulty_id) = extract_encounter_difficulty_id(fields) {
        if is_raid_difficulty(difficulty_id) {
            return "raid";
        }
    }

    "unknown"
}

fn extract_encounter_difficulty_id(fields: &[String]) -> Option<u32> {
    fields
        .get(2)
        .and_then(|value| value.trim_matches('"').parse::<u32>().ok())
}

fn is_raid_difficulty(difficulty_id: u32) -> bool {
    matches!(difficulty_id, 3 | 4 | 5 | 6 | 14 | 15 | 16 | 17)
}

fn extract_encounter_name(fields: &[String]) -> Option<String> {
    normalize_name(fields.get(1).map(|value| value.as_str()))
}

fn extract_zone_name(raw_event_type: &str, fields: &[String]) -> Option<String> {
    if !is_zone_context_event_type(raw_event_type) {
        return None;
    }

    fields.iter().find_map(|value| {
        let normalized = normalize_name(Some(value.as_str()))?;
        if is_likely_zone_name(&normalized) {
            Some(normalized)
        } else {
            None
        }
    })
}

fn is_zone_context_event_type(raw_event_type: &str) -> bool {
    matches!(
        raw_event_type,
        "ZONE_CHANGE"
            | "ZONE_CHANGE_NEW_AREA"
            | "ZONE_CHANGED"
            | "ZONE_CHANGED_INDOORS"
            | "PLAYER_ENTERING_WORLD"
            | "MAP_CHANGE"
    )
}

fn is_likely_zone_name(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }

    if value.chars().all(|character| character.is_ascii_digit()) {
        return false;
    }

    value.chars().any(|character| {
        character.is_alphabetic() || character == ' ' || character == '-' || character == '\''
    })
}

fn classify_unit_kind(unit_flags: Option<&str>, unit_guid: Option<&str>) -> Option<&'static str> {
    if let Some(flags_value) = parse_combat_log_flags(unit_flags) {
        const TYPE_PLAYER: u32 = 0x0000_0400;
        const TYPE_NPC: u32 = 0x0000_0800;
        const TYPE_PET: u32 = 0x0000_1000;
        const TYPE_GUARDIAN: u32 = 0x0000_2000;
        const TYPE_OBJECT: u32 = 0x0000_4000;

        if flags_value & TYPE_PLAYER != 0 {
            return Some("PLAYER");
        }
        if flags_value & TYPE_PET != 0 {
            return Some("PET");
        }
        if flags_value & TYPE_GUARDIAN != 0 {
            return Some("GUARDIAN");
        }
        if flags_value & TYPE_NPC != 0 {
            return Some("NPC");
        }
        if flags_value & TYPE_OBJECT != 0 {
            return Some("OBJECT");
        }
    }

    let normalized_guid = normalize_name(unit_guid);
    if let Some(guid) = normalized_guid.as_deref() {
        if guid.starts_with("Player-") {
            return Some("PLAYER");
        }
        if guid.starts_with("Pet-") {
            return Some("PET");
        }
        if guid.starts_with("Creature-") || guid.starts_with("Vehicle-") {
            return Some("NPC");
        }
        if guid.starts_with("GameObject-") {
            return Some("OBJECT");
        }

        return Some("UNKNOWN");
    }

    None
}

fn parse_combat_log_flags(raw_flags: Option<&str>) -> Option<u32> {
    let value = raw_flags?.trim();
    if value.is_empty() || value == "nil" {
        return None;
    }

    let unquoted = value.trim_matches('"');
    if let Some(hex_value) = unquoted
        .strip_prefix("0x")
        .or_else(|| unquoted.strip_prefix("0X"))
    {
        return u32::from_str_radix(hex_value, 16).ok();
    }

    unquoted.parse::<u32>().ok()
}

fn is_guardian_target(target_kind: Option<&str>) -> bool {
    matches!(target_kind, Some("GUARDIAN"))
}

fn extract_event_type(header: &str) -> Option<&str> {
    if let Some((_, event_type)) = header.rsplit_once("  ") {
        return Some(event_type.trim());
    }

    header.split_whitespace().last().map(str::trim)
}

fn extract_raw_event_type_from_line(line: &str) -> Option<&str> {
    let header = line.trim().split(',').next()?.trim();
    extract_event_type(header)
}

fn should_reset_player_roster_for_event(raw_event_type: &str) -> bool {
    matches!(
        raw_event_type,
        "ENCOUNTER_START"
            | "CHALLENGE_MODE_START"
            | "ARENA_MATCH_START"
            | "PVP_MATCH_START"
            | "BATTLEGROUND_START"
    )
}

fn extract_log_timestamp(header: &str) -> String {
    if let Some((timestamp, _)) = header.rsplit_once("  ") {
        return timestamp.trim().to_string();
    }

    header
        .split_whitespace()
        .take(2)
        .collect::<Vec<&str>>()
        .join(" ")
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
struct LogTimestamp {
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
    fractional_seconds: f64,
}

impl LogTimestamp {
    fn parse(value: &str) -> Option<Self> {
        let parts: Vec<&str> = value.split_whitespace().collect();
        if parts.len() < 2 {
            return None;
        }

        let date_part = parts[0];
        let time_part = parts[1];

        let date_parts: Vec<&str> = date_part.split('/').collect();
        if date_parts.len() != 2 && date_parts.len() != 3 {
            return None;
        }

        let month: u32 = date_parts[0].parse().ok()?;
        let day: u32 = date_parts[1].parse().ok()?;
        // date_parts[2] would be the year (if present), but we ignore it since we only care about time-of-day

        let time_parts: Vec<&str> = time_part.split(':').collect();
        if time_parts.len() != 3 {
            return None;
        }

        let hour: u32 = time_parts[0].parse().ok()?;
        let minute: u32 = time_parts[1].parse().ok()?;

        let second_and_millis = time_parts[2];
        let (second, fractional) = if let Some((sec, frac_str)) = second_and_millis.split_once('.')
        {
            let sec_val: u32 = sec.parse().ok()?;
            let frac_val: f64 = format!("0.{}", frac_str).parse().ok()?;
            (sec_val, frac_val)
        } else {
            (second_and_millis.parse().ok()?, 0.0)
        };

        Some(LogTimestamp {
            month,
            day,
            hour,
            minute,
            second,
            fractional_seconds: fractional,
        })
    }

    #[allow(clippy::wrong_self_convention)]
    fn to_seconds_since_midnight(&self) -> f64 {
        (self.hour as f64) * 3600.0
            + (self.minute as f64) * 60.0
            + (self.second as f64)
            + self.fractional_seconds
    }
}

fn normalize_entity_name(name: Option<&str>, unit_kind: Option<&str>) -> Option<String> {
    let normalized_name = normalize_name(name)?;
    if unit_kind != Some("PLAYER") {
        return Some(normalized_name);
    }

    Some(trim_player_region_suffix(&normalized_name))
}

fn trim_player_region_suffix(name: &str) -> String {
    let Some((without_region, region)) = name.rsplit_once('-') else {
        return name.to_string();
    };

    if !without_region.contains('-') {
        return name.to_string();
    }

    if looks_like_region_code(region) {
        return without_region.to_string();
    }

    name.to_string()
}

fn looks_like_region_code(value: &str) -> bool {
    let length = value.len();
    if !(2..=4).contains(&length) {
        return false;
    }

    value
        .chars()
        .all(|character| character.is_ascii_uppercase())
}

fn normalize_name(name: Option<&str>) -> Option<String> {
    let value = name?.trim();
    if value.is_empty() || value == "nil" {
        return None;
    }

    Some(value.trim_matches('"').to_string())
}

fn merge_player_update(
    players_by_guid: &mut BTreeMap<String, RecordingPlayerMetadata>,
    update: &RecordingPlayerMetadata,
) {
    let entry = players_by_guid
        .entry(update.guid.clone())
        .or_insert_with(|| RecordingPlayerMetadata {
            guid: update.guid.clone(),
            name: None,
            class_name: None,
            spec_name: None,
            spec_id: None,
        });

    if let Some(player_name) = update
        .name
        .as_ref()
        .and_then(|value| normalize_name(Some(value)))
    {
        entry.name = Some(player_name);
    }

    if let Some(class_name) = update.class_name.as_ref() {
        entry.class_name = Some(class_name.clone());
    }

    if let Some(spec_name) = update.spec_name.as_ref() {
        entry.spec_name = Some(spec_name.clone());
    }

    if let Some(spec_id) = update.spec_id {
        entry.spec_id = Some(spec_id);
    }
}

fn parse_player_identities_from_log_line(
    line: &str,
) -> Option<(Option<PlayerIdentity>, Option<PlayerIdentity>)> {
    let trimmed_line = line.trim();
    if trimmed_line.is_empty() {
        return None;
    }

    let mut fields = trimmed_line.split(',');
    let header = fields.next()?.trim();
    let event_type = extract_event_type(header)?;
    if event_type == "COMBATANT_INFO" {
        return None;
    }

    let remaining_fields = fields.map(str::trim).collect::<Vec<&str>>();
    if remaining_fields.is_empty() {
        return None;
    }

    let source_identity = parse_player_identity(
        remaining_fields.first().copied(),
        remaining_fields.get(1).copied(),
        remaining_fields.get(2).copied(),
    );
    let target_identity = parse_player_identity(
        remaining_fields.get(4).copied(),
        remaining_fields.get(5).copied(),
        remaining_fields.get(6).copied(),
    );

    if source_identity.is_none() && target_identity.is_none() {
        return None;
    }

    Some((source_identity, target_identity))
}

fn parse_player_identity(
    raw_guid: Option<&str>,
    raw_name: Option<&str>,
    raw_flags: Option<&str>,
) -> Option<PlayerIdentity> {
    let guid = normalize_name(raw_guid)?;
    if classify_unit_kind(raw_flags, Some(guid.as_str())) != Some("PLAYER") {
        return None;
    }

    let name = normalize_entity_name(raw_name, Some("PLAYER"));
    Some(PlayerIdentity { guid, name })
}

fn parse_combatant_info_snapshot(line: &str) -> Option<CombatantInfoSnapshot> {
    let trimmed_line = line.trim();
    if trimmed_line.is_empty() {
        return None;
    }

    let mut fields = trimmed_line.split(',');
    let header = fields.next()?.trim();
    let event_type = extract_event_type(header)?;
    if event_type != "COMBATANT_INFO" {
        return None;
    }

    let remaining_fields = fields.map(str::trim).collect::<Vec<&str>>();
    let player_guid = normalize_name(remaining_fields.first().copied())?;
    let spec_id = extract_combatant_info_spec_id(&remaining_fields);
    let (class_name, spec_name) = spec_id
        .and_then(resolve_spec_details)
        .map(|(class_name, spec_name)| (Some(class_name.to_string()), Some(spec_name.to_string())))
        .unwrap_or((None, None));

    Some(CombatantInfoSnapshot {
        player_guid,
        spec_id,
        class_name,
        spec_name,
    })
}

fn extract_combatant_info_spec_id(fields: &[&str]) -> Option<u32> {
    const SPEC_INDEX_CANDIDATES: [usize; 2] = [23, 22];

    let indexed_spec = SPEC_INDEX_CANDIDATES.iter().find_map(|index| {
        let spec_id = parse_u32_field_value(fields.get(*index).copied())?;
        let next_field = fields
            .get(index.saturating_add(1))
            .map(|value| value.trim())
            .unwrap_or_default();
        if !next_field.is_empty() && !next_field.starts_with('(') && !next_field.starts_with('[') {
            return None;
        }

        Some(spec_id)
    });

    if indexed_spec.is_some() {
        return indexed_spec;
    }

    // COMBATANT_INFO payloads can shift between patches. The current spec id is
    // the numeric value immediately before the first list-like segment
    // (class talents or powers block), so use that as a resilient fallback.
    for index in 1..fields.len() {
        let current = fields[index].trim();
        if !current.starts_with('(') && !current.starts_with('[') {
            continue;
        }

        let previous = fields[index - 1].trim();
        if let Some(spec_id) = parse_u32_field_value(Some(previous)) {
            return Some(spec_id);
        }
    }

    None
}

fn parse_u32_field_value(value: Option<&str>) -> Option<u32> {
    let raw = value?.trim().trim_matches('"');
    if raw.is_empty() {
        return None;
    }

    if let Ok(parsed) = raw.parse::<u32>() {
        return Some(parsed);
    }

    let digit_prefix = raw
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    if digit_prefix.is_empty() {
        return None;
    }

    digit_prefix.parse::<u32>().ok()
}

fn resolve_spec_details(spec_id: u32) -> Option<(&'static str, &'static str)> {
    match spec_id {
        62 => Some(("Mage", "Arcane")),
        63 => Some(("Mage", "Fire")),
        64 => Some(("Mage", "Frost")),
        65 => Some(("Paladin", "Holy")),
        66 => Some(("Paladin", "Protection")),
        70 => Some(("Paladin", "Retribution")),
        71 => Some(("Warrior", "Arms")),
        72 => Some(("Warrior", "Fury")),
        73 => Some(("Warrior", "Protection")),
        102 => Some(("Druid", "Balance")),
        103 => Some(("Druid", "Feral")),
        104 => Some(("Druid", "Guardian")),
        105 => Some(("Druid", "Restoration")),
        250 => Some(("Death Knight", "Blood")),
        251 => Some(("Death Knight", "Frost")),
        252 => Some(("Death Knight", "Unholy")),
        253 => Some(("Hunter", "Beast Mastery")),
        254 => Some(("Hunter", "Marksmanship")),
        255 => Some(("Hunter", "Survival")),
        256 => Some(("Priest", "Discipline")),
        257 => Some(("Priest", "Holy")),
        258 => Some(("Priest", "Shadow")),
        259 => Some(("Rogue", "Assassination")),
        260 => Some(("Rogue", "Outlaw")),
        261 => Some(("Rogue", "Subtlety")),
        262 => Some(("Shaman", "Elemental")),
        263 => Some(("Shaman", "Enhancement")),
        264 => Some(("Shaman", "Restoration")),
        265 => Some(("Warlock", "Affliction")),
        266 => Some(("Warlock", "Demonology")),
        267 => Some(("Warlock", "Destruction")),
        268 => Some(("Monk", "Brewmaster")),
        269 => Some(("Monk", "Windwalker")),
        270 => Some(("Monk", "Mistweaver")),
        577 => Some(("Demon Hunter", "Havoc")),
        581 => Some(("Demon Hunter", "Vengeance")),
        1480 => Some(("Demon Hunter", "Devourer")),
        1467 => Some(("Evoker", "Devastation")),
        1468 => Some(("Evoker", "Preservation")),
        1473 => Some(("Evoker", "Augmentation")),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{RecordingMetadataAccumulator, MAX_PERSISTED_HIGH_VOLUME_EVENTS};

    #[test]
    fn caps_high_volume_events_but_keeps_structural_events() {
        let mut accumulator = RecordingMetadataAccumulator::default();
        accumulator.begin_recording_session(0.0);
        accumulator.record_manual_marker(0.25);

        let encounter_start_line = build_line("ENCOUNTER_START", &["1", "\"Training Boss\"", "16"]);
        accumulator.consume_combat_log_line(&encounter_start_line, 0.5);

        let total_party_kills = MAX_PERSISTED_HIGH_VOLUME_EVENTS + 25;
        for index in 0..total_party_kills {
            let party_kill_line = build_party_kill_line(index);
            accumulator.consume_combat_log_line(&party_kill_line, 1.0 + index as f64);
        }

        let snapshot = accumulator.snapshot();
        let buffered_party_kill_count = snapshot
            .important_events
            .iter()
            .filter(|event| event.event_type == "PARTY_KILL")
            .count();

        assert_eq!(
            buffered_party_kill_count, MAX_PERSISTED_HIGH_VOLUME_EVENTS,
            "High-volume party kill events should be capped"
        );
        assert_eq!(
            snapshot.important_event_counts.get("PARTY_KILL").copied(),
            Some(total_party_kills as u64),
            "Counts should include all seen events, not only buffered events"
        );
        assert_eq!(
            snapshot.important_events_dropped_count, 25,
            "Dropped count should reflect events removed due to cap"
        );
        assert!(snapshot
            .important_events
            .iter()
            .any(|event| event.event_type == "MANUAL_MARKER"));
        assert!(snapshot
            .important_events
            .iter()
            .any(|event| event.event_type == "ENCOUNTER_START"));
    }

    #[test]
    fn updates_zone_context_without_persisting_context_only_events() {
        let mut accumulator = RecordingMetadataAccumulator::default();
        accumulator.begin_recording_session(0.0);

        let zone_line = build_line("ZONE_CHANGED", &["\"Nerub-ar Palace\""]);
        accumulator.consume_combat_log_line(&zone_line, 0.5);

        let party_kill_line = build_party_kill_line(1);
        accumulator.consume_combat_log_line(&party_kill_line, 1.0);

        let snapshot = accumulator.snapshot();
        assert_eq!(snapshot.zone_name.as_deref(), Some("Nerub-ar Palace"));
        assert_eq!(snapshot.important_events.len(), 1);
        assert_eq!(snapshot.important_events[0].event_type, "PARTY_KILL");
    }

    #[test]
    fn captures_mythic_plus_key_level_from_challenge_start() {
        let mut accumulator = RecordingMetadataAccumulator::default();
        accumulator.begin_recording_session(0.0);

        let challenge_start_line =
            build_line("CHALLENGE_MODE_START", &["2451", "2662", "505", "14"]);
        accumulator.consume_combat_log_line(&challenge_start_line, 0.25);

        let party_kill_line = build_party_kill_line(1);
        accumulator.consume_combat_log_line(&party_kill_line, 1.0);

        let snapshot = accumulator.snapshot();
        assert_eq!(snapshot.key_level, Some(14));
        assert_eq!(snapshot.important_events.len(), 1);
        assert_eq!(snapshot.important_events[0].event_type, "PARTY_KILL");
        assert_eq!(snapshot.important_events[0].key_level, Some(14));
    }

    #[test]
    fn captures_player_overview_from_combatant_info() {
        let mut accumulator = RecordingMetadataAccumulator::default();

        let combatant_info_line = build_line(
            "COMBATANT_INFO",
            &[
                "Player-1111-00000001",
                "1",
                "132",
                "184",
                "906",
                "653",
                "0",
                "0",
                "0",
                "257",
                "257",
                "257",
                "11",
                "0",
                "188",
                "188",
                "188",
                "0",
                "118",
                "90",
                "90",
                "90",
                "120",
                "257",
                "(193155)",
            ],
        );
        accumulator.consume_combat_log_line(&combatant_info_line, 0.0);

        accumulator.begin_recording_session(1.0);

        let party_kill_line = build_line(
            "PARTY_KILL",
            &[
                "Player-1111-00000001",
                "\"PlayerOne-NA\"",
                "0x514",
                "0x0",
                "Creature-0-0-0-0-1001-0000000000",
                "\"Enemy0\"",
                "0x10a48",
                "0x0",
            ],
        );
        accumulator.consume_combat_log_line(&party_kill_line, 2.0);

        let snapshot = accumulator.snapshot();
        assert_eq!(snapshot.players.len(), 1);

        let player = &snapshot.players[0];
        assert_eq!(player.guid, "Player-1111-00000001");
        assert_eq!(player.name.as_deref(), Some("PlayerOne-NA"));
        assert_eq!(player.class_name.as_deref(), Some("Priest"));
        assert_eq!(player.spec_name.as_deref(), Some("Holy"));
        assert_eq!(player.spec_id, Some(257));
    }

    #[test]
    fn ignores_non_roster_players_from_regular_combat_events() {
        let mut accumulator = RecordingMetadataAccumulator::default();
        accumulator.begin_recording_session(0.0);

        let party_kill_line = build_line(
            "PARTY_KILL",
            &[
                "Player-1111-00000001",
                "\"PlayerOne-NA\"",
                "0x514",
                "0x0",
                "Creature-0-0-0-0-1001-0000000000",
                "\"Enemy0\"",
                "0x10a48",
                "0x0",
            ],
        );
        accumulator.consume_combat_log_line(&party_kill_line, 1.0);

        let snapshot = accumulator.snapshot();
        assert_eq!(snapshot.players.len(), 0);
    }

    #[test]
    fn enriches_names_only_for_players_seen_in_combatant_info() {
        let mut accumulator = RecordingMetadataAccumulator::default();
        accumulator.begin_recording_session(0.0);

        let combatant_info_line = build_line(
            "COMBATANT_INFO",
            &[
                "Player-1111-00000001",
                "1",
                "132",
                "184",
                "906",
                "653",
                "0",
                "0",
                "0",
                "257",
                "257",
                "257",
                "11",
                "0",
                "188",
                "188",
                "188",
                "0",
                "118",
                "90",
                "90",
                "90",
                "120",
                "257",
                "(193155)",
            ],
        );
        accumulator.consume_combat_log_line(&combatant_info_line, 0.25);

        let party_kill_line = build_line(
            "PARTY_KILL",
            &[
                "Player-1111-00000001",
                "\"RosteredOne-NA\"",
                "0x514",
                "0x0",
                "Player-1111-00000002",
                "\"Stranger-NA\"",
                "0x514",
                "0x0",
            ],
        );
        accumulator.consume_combat_log_line(&party_kill_line, 1.0);

        let snapshot = accumulator.snapshot();
        assert_eq!(snapshot.players.len(), 1);

        let player = &snapshot.players[0];
        assert_eq!(player.guid, "Player-1111-00000001");
        assert_eq!(player.name.as_deref(), Some("RosteredOne-NA"));
    }

    #[test]
    fn keeps_unknown_spec_ids_without_class_mapping() {
        let mut accumulator = RecordingMetadataAccumulator::default();
        accumulator.begin_recording_session(0.0);

        let combatant_info_line = build_line(
            "COMBATANT_INFO",
            &[
                "Player-1111-00000001",
                "1",
                "132",
                "184",
                "906",
                "653",
                "0",
                "0",
                "0",
                "257",
                "257",
                "257",
                "11",
                "0",
                "188",
                "188",
                "188",
                "0",
                "118",
                "90",
                "90",
                "90",
                "120",
                "9999",
                "(193155)",
            ],
        );
        accumulator.consume_combat_log_line(&combatant_info_line, 0.5);

        let snapshot = accumulator.snapshot();
        assert_eq!(snapshot.players.len(), 1);

        let player = &snapshot.players[0];
        assert_eq!(player.guid, "Player-1111-00000001");
        assert_eq!(player.class_name, None);
        assert_eq!(player.spec_name, None);
        assert_eq!(player.spec_id, Some(9999));
    }

    #[test]
    fn clears_stale_roster_when_new_encounter_starts() {
        let mut accumulator = RecordingMetadataAccumulator::default();

        let first_roster = build_line(
            "COMBATANT_INFO",
            &[
                "Player-1111-00000001",
                "1",
                "132",
                "184",
                "906",
                "653",
                "0",
                "0",
                "0",
                "257",
                "257",
                "257",
                "11",
                "0",
                "188",
                "188",
                "188",
                "0",
                "118",
                "90",
                "90",
                "90",
                "120",
                "257",
                "(193155)",
            ],
        );
        accumulator.consume_combat_log_line(&first_roster, 0.0);

        let encounter_start_line = build_line("ENCOUNTER_START", &["1234", "\"Boss One\"", "16"]);
        accumulator.consume_combat_log_line(&encounter_start_line, 1.0);

        let second_roster = build_line(
            "COMBATANT_INFO",
            &[
                "Player-1111-00000002",
                "1",
                "132",
                "184",
                "906",
                "653",
                "0",
                "0",
                "0",
                "257",
                "257",
                "257",
                "11",
                "0",
                "188",
                "188",
                "188",
                "0",
                "118",
                "90",
                "90",
                "90",
                "120",
                "258",
                "(193155)",
            ],
        );
        accumulator.consume_combat_log_line(&second_roster, 1.25);

        accumulator.begin_recording_session(2.0);
        let snapshot = accumulator.snapshot();
        assert_eq!(snapshot.players.len(), 1);

        let player = &snapshot.players[0];
        assert_eq!(player.guid, "Player-1111-00000002");
        assert_eq!(player.spec_id, Some(258));
    }

    #[test]
    fn captures_spec_id_when_combatant_info_stats_shift() {
        let mut accumulator = RecordingMetadataAccumulator::default();
        accumulator.begin_recording_session(0.0);

        // Simulates a patch that inserts an extra scalar stat before armor/spec,
        // shifting the historical fixed spec index by one.
        let combatant_info_line = build_line(
            "COMBATANT_INFO",
            &[
                "Player-1111-00000001",
                "1",
                "132",
                "184",
                "906",
                "653",
                "0",
                "0",
                "0",
                "257",
                "257",
                "257",
                "11",
                "0",
                "188",
                "188",
                "188",
                "0",
                "118",
                "90",
                "90",
                "90",
                "77",
                "120",
                "257",
                "(193155,64129,238136)",
            ],
        );
        accumulator.consume_combat_log_line(&combatant_info_line, 0.5);

        let snapshot = accumulator.snapshot();
        assert_eq!(snapshot.players.len(), 1);

        let player = &snapshot.players[0];
        assert_eq!(player.guid, "Player-1111-00000001");
        assert_eq!(player.class_name.as_deref(), Some("Priest"));
        assert_eq!(player.spec_name.as_deref(), Some("Holy"));
        assert_eq!(player.spec_id, Some(257));
    }

    #[test]
    fn seeds_recording_context_from_recent_zone_state() {
        let mut accumulator = RecordingMetadataAccumulator::default();

        let zone_line = build_line("ZONE_CHANGED", &["\"Nerub-ar Palace\""]);
        accumulator.consume_combat_log_line(&zone_line, 0.25);

        let encounter_start_line = build_line("ENCOUNTER_START", &["1", "\"Queen Ansurek\"", "16"]);
        accumulator.consume_combat_log_line(&encounter_start_line, 0.5);

        accumulator.begin_recording_session(2.0);
        let snapshot = accumulator.snapshot();

        assert_eq!(snapshot.zone_name.as_deref(), Some("Nerub-ar Palace"));
        assert_eq!(snapshot.encounter_name.as_deref(), Some("Queen Ansurek"));
        assert_eq!(snapshot.encounter_category.as_deref(), Some("raid"));
        assert_eq!(snapshot.encounters.len(), 1);
        assert_eq!(snapshot.encounters[0].started_at_seconds, 0.0);
        assert!(snapshot.encounters[0].ended_at_seconds.is_none());
    }

    #[test]
    fn unmatched_encounter_end_uses_zero_start_time() {
        // An ENCOUNTER_END with no prior ENCOUNTER_START synthesizes a segment starting at 0.0.
        // The end time is the log-clock diff from the origin anchor.
        // We anchor with a PARTY_KILL at 20:15:11.000, then end the encounter 42 s later
        // at 20:15:53.000, so ended_at_seconds should be 42.0.
        let mut accumulator = RecordingMetadataAccumulator::default();
        accumulator.begin_recording_session(0.0);

        // First event: anchors session_log_origin_seconds to 20:15:11.000 (72911.0 s)
        let anchor_line = build_line_at(
            "PARTY_KILL",
            &[
                "Player-1111-00000001",
                "\"PlayerOne-NA\"",
                "0x514",
                "0x0",
                "Creature-0-0-0-0-1001-0000000000",
                "\"Enemy0\"",
                "0x10a48",
                "0x0",
            ],
            "2/22 20:15:11.000",
        );
        accumulator.consume_combat_log_line(&anchor_line, 0.0);

        // Second event: 42 log-seconds later at 20:15:53.000 (72953.0 s)
        let encounter_end_line = build_line_at(
            "ENCOUNTER_END",
            &["1", "\"Queen Ansurek\"", "16"],
            "2/22 20:15:53.000",
        );
        accumulator.consume_combat_log_line(&encounter_end_line, 42.0);

        let snapshot = accumulator.snapshot();
        assert_eq!(snapshot.encounters.len(), 1);
        assert_eq!(snapshot.encounters[0].started_at_seconds, 0.0);
        assert_eq!(snapshot.encounters[0].ended_at_seconds, Some(42.0));
    }

    #[test]
    fn prefers_zone_name_over_numeric_zone_id() {
        let mut accumulator = RecordingMetadataAccumulator::default();
        accumulator.begin_recording_session(0.0);

        let zone_line = build_line("ZONE_CHANGED", &["2450", "\"Nerub-ar Palace\""]);
        accumulator.consume_combat_log_line(&zone_line, 0.5);

        let party_kill_line = build_party_kill_line(5);
        accumulator.consume_combat_log_line(&party_kill_line, 1.0);

        let snapshot = accumulator.snapshot();
        assert_eq!(snapshot.zone_name.as_deref(), Some("Nerub-ar Palace"));
    }

    #[test]
    fn map_change_updates_zone_context_with_zone_name() {
        let mut accumulator = RecordingMetadataAccumulator::default();
        accumulator.begin_recording_session(0.0);

        let map_change_line = build_line("MAP_CHANGE", &["2450", "\"Nerub-ar Palace\""]);
        accumulator.consume_combat_log_line(&map_change_line, 0.5);

        let party_kill_line = build_party_kill_line(6);
        accumulator.consume_combat_log_line(&party_kill_line, 1.0);

        let snapshot = accumulator.snapshot();
        assert_eq!(snapshot.zone_name.as_deref(), Some("Nerub-ar Palace"));
    }

    #[test]
    fn stale_log_timestamp_before_session_does_not_corrupt_event_timestamps() {
        let mut accumulator = RecordingMetadataAccumulator::default();

        let stale_zone_line =
            build_line_at("ZONE_CHANGED", &["\"Stale Zone\""], "2/22 10:00:00.000");
        accumulator.consume_combat_log_line(&stale_zone_line, 0.0);

        accumulator.begin_recording_session(100.0);

        let first_kill = build_line_at(
            "PARTY_KILL",
            &[
                "Player-1111-00000001",
                "\"PlayerOne-NA\"",
                "0x514",
                "0x0",
                "Creature-0-0-0-0-1001-0000000000",
                "\"Enemy0\"",
                "0x10a48",
                "0x0",
            ],
            "2/22 10:00:05.000",
        );
        accumulator.consume_combat_log_line(&first_kill, 105.0);

        let snapshot = accumulator.snapshot();
        assert_eq!(snapshot.important_events.len(), 1);
        assert!(
            snapshot.important_events[0].timestamp_seconds < 10.0,
            "Event should be near recording start, got {}",
            snapshot.important_events[0].timestamp_seconds
        );
    }

    #[test]
    fn first_event_after_idle_gap_anchors_log_origin() {
        let mut accumulator = RecordingMetadataAccumulator::default();
        accumulator.begin_recording_session(0.0);

        let first_kill = build_line_at(
            "PARTY_KILL",
            &[
                "Player-1111-00000001",
                "\"PlayerOne-NA\"",
                "0x514",
                "0x0",
                "Creature-0-0-0-0-1001-0000000000",
                "\"Enemy0\"",
                "0x10a48",
                "0x0",
            ],
            "2/22 20:00:00.000",
        );
        accumulator.consume_combat_log_line(&first_kill, 0.0);

        let second_kill = build_line_at(
            "PARTY_KILL",
            &[
                "Player-1111-00000001",
                "\"PlayerOne-NA\"",
                "0x514",
                "0x0",
                "Creature-0-0-0-0-1002-0000000000",
                "\"Enemy1\"",
                "0x10a48",
                "0x0",
            ],
            "2/22 20:00:30.000",
        );
        accumulator.consume_combat_log_line(&second_kill, 30.0);

        let snapshot = accumulator.snapshot();
        assert_eq!(snapshot.important_events.len(), 2);
        assert_eq!(snapshot.important_events[0].timestamp_seconds, 0.0);
        assert_eq!(snapshot.important_events[1].timestamp_seconds, 30.0);
    }

    #[test]
    fn midnight_rollover_computes_correct_elapsed_time() {
        let mut accumulator = RecordingMetadataAccumulator::default();
        accumulator.begin_recording_session(0.0);

        let before_midnight = build_line_at(
            "PARTY_KILL",
            &[
                "Player-1111-00000001",
                "\"PlayerOne-NA\"",
                "0x514",
                "0x0",
                "Creature-0-0-0-0-1001-0000000000",
                "\"Enemy0\"",
                "0x10a48",
                "0x0",
            ],
            "2/22 23:59:50.000",
        );
        accumulator.consume_combat_log_line(&before_midnight, 0.0);

        let after_midnight = build_line_at(
            "PARTY_KILL",
            &[
                "Player-1111-00000001",
                "\"PlayerOne-NA\"",
                "0x514",
                "0x0",
                "Creature-0-0-0-0-1002-0000000000",
                "\"Enemy1\"",
                "0x10a48",
                "0x0",
            ],
            "2/23 00:00:10.000",
        );
        accumulator.consume_combat_log_line(&after_midnight, 20.0);

        let snapshot = accumulator.snapshot();
        assert_eq!(snapshot.important_events.len(), 2);
        assert_eq!(snapshot.important_events[0].timestamp_seconds, 0.0);
        assert_eq!(snapshot.important_events[1].timestamp_seconds, 20.0);
    }

    fn build_party_kill_line(index: usize) -> String {
        build_line(
            "PARTY_KILL",
            &[
                "Player-1111-00000001",
                "\"PlayerOne-NA\"",
                "0x514",
                "0x0",
                &format!("Creature-0-0-0-0-{}-0000000000", index + 1000),
                &format!("\"Enemy{}\"", index),
                "0x10a48",
                "0x0",
            ],
        )
    }

    fn build_line(event_type: &str, fields: &[&str]) -> String {
        build_line_at(event_type, fields, "2/22 20:15:11.000")
    }

    fn build_line_at(event_type: &str, fields: &[&str], log_timestamp: &str) -> String {
        let mut line = format!("{log_timestamp}  {event_type}");
        if !fields.is_empty() {
            line.push(',');
            line.push_str(&fields.join(","));
        }
        line
    }

    #[test]
    fn parses_real_world_log_timestamp_format() {
        use super::LogTimestamp;

        let timestamp_str = "2/17 12:42:43.224";
        let parsed = LogTimestamp::parse(timestamp_str);
        assert!(parsed.is_some());
        let ts = parsed.unwrap();
        assert_eq!(ts.month, 2);
        assert_eq!(ts.day, 17);
        assert_eq!(ts.hour, 12);
        assert_eq!(ts.minute, 42);
        assert_eq!(ts.second, 43);
        assert!((ts.fractional_seconds - 0.224).abs() < 0.0001);

        let seconds = ts.to_seconds_since_midnight();
        let expected = 12.0 * 3600.0 + 42.0 * 60.0 + 43.0 + 0.224;
        assert!((seconds - expected).abs() < 0.001);

        let timestamp_4digit = "2/17 12:42:43.2241";
        let parsed_4 = LogTimestamp::parse(timestamp_4digit);
        assert!(parsed_4.is_some());
        let ts4 = parsed_4.unwrap();
        assert!((ts4.fractional_seconds - 0.2241).abs() < 0.00001);

        let seconds_4 = ts4.to_seconds_since_midnight();
        let expected_4 = 12.0 * 3600.0 + 42.0 * 60.0 + 43.0 + 0.2241;
        assert!((seconds_4 - expected_4).abs() < 0.001);

        // Test format with year (real WoW log format as of 2026)
        let timestamp_with_year = "2/17/2026 12:42:43.2241";
        let parsed_year = LogTimestamp::parse(timestamp_with_year);
        assert!(parsed_year.is_some());
        let ts_year = parsed_year.unwrap();
        assert_eq!(ts_year.month, 2);
        assert_eq!(ts_year.day, 17);
        assert_eq!(ts_year.hour, 12);
        assert_eq!(ts_year.minute, 42);
        assert_eq!(ts_year.second, 43);
        assert!((ts_year.fractional_seconds - 0.2241).abs() < 0.00001);

        let seconds_year = ts_year.to_seconds_since_midnight();
        let expected_year = 12.0 * 3600.0 + 42.0 * 60.0 + 43.0 + 0.2241;
        assert!((seconds_year - expected_year).abs() < 0.001);
    }

    #[test]
    fn real_world_scenario_events_hours_apart_in_log() {
        let mut accumulator = RecordingMetadataAccumulator::default();

        // User starts combat watch at 10 AM, context gets seeded from log tail
        let old_zone_line = build_line_at("ZONE_CHANGED", &["\"Old Zone\""], "2/17 10:00:00.000");
        accumulator.consume_combat_log_line(&old_zone_line, 0.0);

        // User clicks record at 2 PM (4 hours later), recording starts
        let recording_start_elapsed = 4.0 * 3600.0; // 14400 seconds
        accumulator.begin_recording_session(recording_start_elapsed);

        // First kill happens at 2:00:05 PM, 5 seconds into recording (wall-clock)
        // This anchors the log-clock origin to 14:00:05 (50405 seconds since midnight)
        let first_kill = build_line_at(
            "PARTY_KILL",
            &[
                "Player-1111-00000001",
                "\"PlayerOne-NA\"",
                "0x514",
                "0x0",
                "Creature-0-0-0-0-1001-0000000000",
                "\"Enemy0\"",
                "0x10a48",
                "0x0",
            ],
            "2/17 14:00:05.000", // 2 PM + 5 seconds
        );
        let first_kill_elapsed = recording_start_elapsed + 5.0;
        accumulator.consume_combat_log_line(&first_kill, first_kill_elapsed);

        // Second kill at 2:00:30 PM, 30 seconds into recording (wall-clock)
        // Log-clock: 14:00:30 (50430) - 14:00:05 (50405) = 25 seconds
        let second_kill = build_line_at(
            "PARTY_KILL",
            &[
                "Player-1111-00000001",
                "\"PlayerOne-NA\"",
                "0x514",
                "0x0",
                "Creature-0-0-0-0-1002-0000000000",
                "\"Enemy1\"",
                "0x10a48",
                "0x0",
            ],
            "2/17 14:00:30.000", // 2 PM + 30 seconds
        );
        let second_kill_elapsed = recording_start_elapsed + 30.0;
        accumulator.consume_combat_log_line(&second_kill, second_kill_elapsed);

        let snapshot = accumulator.snapshot();
        assert_eq!(snapshot.important_events.len(), 2);

        // First event anchors the log-clock origin, so it's at t=0
        // Second event is 25 seconds later in log time (50430 - 50405 = 25)
        assert_eq!(
            snapshot.important_events[0].timestamp_seconds, 0.0,
            "First kill anchors timeline at t=0"
        );
        assert_eq!(
            snapshot.important_events[1].timestamp_seconds, 25.0,
            "Second kill should be 25s after first kill (log-clock)"
        );
    }

    #[test]
    fn log_clock_fixes_time_compression_from_stale_watcher() {
        // This test demonstrates the fix for the time compression bug where
        // elapsed_seconds from the watcher doesn't update frequently, causing
        // events that are 25 seconds apart in log time to appear only 0.33s apart.
        let mut accumulator = RecordingMetadataAccumulator::default();
        accumulator.begin_recording_session(0.0);

        // First UNIT_DIED at 15:35:00.9481 (log time)
        let first_death = build_line_at(
            "UNIT_DIED",
            &[
                "Creature-0-0-0-0-1001-0000000000",
                "\"Stonewing-Garrosh\"",
                "0xa48",
                "0x0",
            ],
            "2/25/2026 15:35:00.9481",
        );
        // Wall-clock thinks only 90.11 seconds have passed since app start
        accumulator.consume_combat_log_line(&first_death, 90.1099539);

        // Second UNIT_DIED at 15:35:25.3621 (log time) - 24.414 seconds later!
        let second_death = build_line_at(
            "UNIT_DIED",
            &[
                "Creature-0-0-0-0-1002-0000000000",
                "\"Nûggîe-Blackrock\"",
                "0xa48",
                "0x0",
            ],
            "2/25/2026 15:35:25.3621",
        );
        // Wall-clock thinks only 0.332 seconds passed (90.44 - 90.11)
        accumulator.consume_combat_log_line(&second_death, 90.4418244);

        // Third UNIT_DIED at 15:35:35.8541 (log time) - 10.492 seconds after second
        let third_death = build_line_at(
            "UNIT_DIED",
            &[
                "Creature-0-0-0-0-1003-0000000000",
                "\"Ahyawaska-KhazModan\"",
                "0xa48",
                "0x0",
            ],
            "2/25/2026 15:35:35.8541",
        );
        // Wall-clock thinks only 0.086 seconds passed (90.527 - 90.441)
        accumulator.consume_combat_log_line(&third_death, 90.52762179999999);

        let snapshot = accumulator.snapshot();
        assert_eq!(snapshot.important_events.len(), 3);

        // With log-clock fix:
        // Event 1: anchors at t=0 (15:35:00.9481)
        // Event 2: 15:35:25.3621 - 15:35:00.9481 = 24.414 seconds
        // Event 3: 15:35:35.8541 - 15:35:00.9481 = 34.906 seconds

        let log_time_1 = 15.0 * 3600.0 + 35.0 * 60.0 + 0.9481;
        let log_time_2 = 15.0 * 3600.0 + 35.0 * 60.0 + 25.3621;
        let log_time_3 = 15.0 * 3600.0 + 35.0 * 60.0 + 35.8541;

        let expected_diff_2 = log_time_2 - log_time_1;
        let expected_diff_3 = log_time_3 - log_time_1;

        assert_eq!(snapshot.important_events[0].timestamp_seconds, 0.0);
        assert!(
            (snapshot.important_events[1].timestamp_seconds - expected_diff_2).abs() < 0.001,
            "Second event should be ~24.4s after first, got {}",
            snapshot.important_events[1].timestamp_seconds
        );
        assert!(
            (snapshot.important_events[2].timestamp_seconds - expected_diff_3).abs() < 0.001,
            "Third event should be ~34.9s after first, got {}",
            snapshot.important_events[2].timestamp_seconds
        );
    }

    #[test]
    fn encounter_start_anchors_timeline_when_recording_starts_mid_encounter() {
        // This test replicates the exact bug scenario from the user's report:
        // ENCOUNTER_START happens at 15:46:32.9921, user starts recording ~73s later,
        // then deaths happen at 15:47:46.5961, 15:47:54.8351, etc.
        // Expected: ENCOUNTER_START at t=0, deaths at t=73.6s, t=81.8s, etc.
        let mut accumulator = RecordingMetadataAccumulator::default();

        // ENCOUNTER_START arrives before recording starts (context seeding)
        let encounter_start_line = build_line_at(
            "ENCOUNTER_START",
            &["3129", "\"Plexus Sentinel\"", "15", "30", "2810"],
            "2/25/2026 15:46:32.9921",
        );
        accumulator.consume_combat_log_line(&encounter_start_line, 0.0);

        // User clicks "Start Recording" ~73 seconds later (wall-clock)
        accumulator.begin_recording_session(73.0);

        // First UNIT_DIED at 15:47:46.5961 (73.604s after ENCOUNTER_START in log time)
        let first_death = build_line_at(
            "UNIT_DIED",
            &[
                "0000000000000000",
                "nil",
                "0x80000000",
                "0x80000000",
                "Player-1104-09EB9A1B",
                "\"Mêdokar-Rajaxx\"",
                "0x514",
                "0x80000000",
                "0",
            ],
            "2/25/2026 15:47:46.5961",
        );
        accumulator.consume_combat_log_line(&first_death, 146.0); // wall-clock is unreliable

        // Second UNIT_DIED at 15:47:54.8351 (8.239s after first death in log time)
        let second_death = build_line_at(
            "UNIT_DIED",
            &[
                "0000000000000000",
                "nil",
                "0x80000000",
                "0x80000000",
                "Creature-0-4239-2810-5244-233815-00001F0A58",
                "\"Sieve Mouse\"",
                "0xa48",
                "0x80000000",
                "0",
            ],
            "2/25/2026 15:47:54.8351",
        );
        accumulator.consume_combat_log_line(&second_death, 146.3); // wall-clock barely moved

        // ENCOUNTER_END at 15:48:09.1331 (36.141s after ENCOUNTER_START)
        let encounter_end_line = build_line_at(
            "ENCOUNTER_END",
            &["3129", "\"Plexus Sentinel\"", "15", "1"],
            "2/25/2026 15:48:09.1331",
        );
        accumulator.consume_combat_log_line(&encounter_end_line, 146.5);

        let snapshot = accumulator.snapshot();

        // Verify ENCOUNTER_START exists with log timestamp
        let encounter_start_event = snapshot
            .important_events
            .iter()
            .find(|e| e.event_type == "ENCOUNTER_START")
            .expect("ENCOUNTER_START event should exist");

        assert_eq!(
            encounter_start_event.timestamp_seconds, 0.0,
            "ENCOUNTER_START should anchor timeline at t=0"
        );
        assert!(
            encounter_start_event.log_timestamp.is_some(),
            "ENCOUNTER_START should have log timestamp"
        );
        assert_eq!(
            encounter_start_event.log_timestamp.as_deref(),
            Some("2/25/2026 15:46:32.9921"),
            "ENCOUNTER_START should store original log timestamp"
        );

        // Calculate expected timestamps (relative to ENCOUNTER_START)
        let encounter_start_time = 15.0 * 3600.0 + 46.0 * 60.0 + 32.9921;
        let first_death_time = 15.0 * 3600.0 + 47.0 * 60.0 + 46.5961;
        let second_death_time = 15.0 * 3600.0 + 47.0 * 60.0 + 54.8351;
        let encounter_end_time = 15.0 * 3600.0 + 48.0 * 60.0 + 9.1331;

        let expected_first_death = first_death_time - encounter_start_time;
        let expected_second_death = second_death_time - encounter_start_time;
        let expected_encounter_end = encounter_end_time - encounter_start_time;

        // Find death events
        let death_events: Vec<_> = snapshot
            .important_events
            .iter()
            .filter(|e| e.event_type == "UNIT_DIED")
            .collect();

        assert_eq!(death_events.len(), 2, "Should have 2 death events");

        assert!(
            (death_events[0].timestamp_seconds - expected_first_death).abs() < 0.001,
            "First death should be ~73.6s after ENCOUNTER_START, got {}",
            death_events[0].timestamp_seconds
        );

        assert!(
            (death_events[1].timestamp_seconds - expected_second_death).abs() < 0.001,
            "Second death should be ~81.8s after ENCOUNTER_START, got {}",
            death_events[1].timestamp_seconds
        );

        // Verify encounter duration
        assert_eq!(snapshot.encounters.len(), 1);
        assert_eq!(snapshot.encounters[0].started_at_seconds, 0.0);
        assert!(
            (snapshot.encounters[0].ended_at_seconds.unwrap() - expected_encounter_end).abs()
                < 0.001,
            "Encounter should end at ~96.1s, got {:?}",
            snapshot.encounters[0].ended_at_seconds
        );
    }
}
