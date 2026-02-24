use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::recording::metadata::{
    RecordingEncounterSnapshot, RecordingImportantEventMetadata, RecordingMetadata,
    RecordingMetadataSnapshot,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CombatEvent {
    pub timestamp: f64,
    pub event_type: String,
    pub source: Option<String>,
    pub target: Option<String>,
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

    if state.is_some() {
        return Err("Combat watch already running".to_string());
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
    let log_path_clone = log_path.clone();
    let start_time = Instant::now();
    let metadata_accumulator = Arc::new(Mutex::new(RecordingMetadataAccumulator::default()));
    let metadata_accumulator_clone = Arc::clone(&metadata_accumulator);

    let handle = tokio::spawn(async move {
        if let Err(error) = watch_combat_log(
            app_handle_clone,
            &log_path_clone,
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

    Ok(())
}

fn normalized_output_recording_path(recording_output_path: Option<&str>) -> Option<PathBuf> {
    recording_output_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

#[tauri::command]
pub async fn stop_combat_watch() -> Result<(), String> {
    let mut state = WATCH_STATE.lock().map_err(|error| error.to_string())?;

    if let Some(watch_state) = state.take() {
        if let Some(handle) = watch_state.handle.as_ref() {
            handle.abort();
        }

        persist_watch_metadata_if_configured(&watch_state);
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
        let event = CombatEvent {
            timestamp: elapsed,
            event_type: EVENT_MANUAL_MARKER.to_string(),
            source: None,
            target: None,
        };

        match watch_state.metadata_accumulator.lock() {
            Ok(mut metadata_accumulator) => metadata_accumulator.record_manual_marker(elapsed),
            Err(error) => {
                tracing::error!(
                    metadata_error = %error,
                    "Failed to lock metadata accumulator for manual marker"
                );
            }
        }

        emit_combat_event(&app_handle, &event);
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
    Path::new(wow_folder).join("Logs")
}

fn is_combat_log_file_name(file_name: &str) -> bool {
    let lower_file_name = file_name.to_ascii_lowercase();
    lower_file_name.starts_with("wowcombatlog") && lower_file_name.ends_with(".txt")
}

fn find_latest_combat_log_path(wow_folder: &str) -> Result<Option<PathBuf>, String> {
    let logs_directory = build_combat_log_directory_path(wow_folder);
    let directory_entries = match std::fs::read_dir(&logs_directory) {
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
    log_path: &Path,
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

    let watch_directory = log_path
        .parent()
        .ok_or_else(|| "Invalid WoW combat log path".to_string())?;
    watcher
        .watch(watch_directory, RecursiveMode::NonRecursive)
        .map_err(|error| error.to_string())?;

    let mut file_offset = initial_offset;
    while let Some(notification_result) = notify_receiver.recv().await {
        match notification_result {
            Ok(event) => {
                if !is_relevant_notification(&event, log_path) {
                    continue;
                }

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
            Err(error) => {
                tracing::warn!("Combat log watcher error: {error}");
            }
        }
    }

    Ok(())
}

fn is_relevant_notification(event: &Event, log_path: &Path) -> bool {
    let relevant_kind = matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_));
    if !relevant_kind {
        return false;
    }

    let Some(log_file_name) = log_path.file_name() else {
        return false;
    };

    event.paths.iter().any(|path| {
        path == log_path
            || path
                .file_name()
                .map(|file_name| file_name == log_file_name)
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
        let parsed_event = {
            let mut accumulator = metadata_accumulator
                .lock()
                .map_err(|error| error.to_string())?;
            accumulator.consume_combat_log_line(&line, elapsed_seconds)
        };

        if let Some(event) = parsed_event.and_then(|value| value.into_live_event(elapsed_seconds)) {
            emit_combat_event(app_handle, &event);
        }
    }

    Ok(())
}

#[derive(Debug, Clone)]
struct ImportantCombatEvent {
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

impl ImportantCombatEvent {
    fn into_live_event(self, elapsed_seconds: f64) -> Option<CombatEvent> {
        match self.event_type.as_str() {
            "PARTY_KILL" | "UNIT_DIED" => Some(CombatEvent {
                timestamp: elapsed_seconds,
                event_type: self.event_type,
                source: self.source,
                target: self.target,
            }),
            _ => None,
        }
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

    if is_context_only_event(&parsed_line.raw_event_type) {
        return None;
    }

    if is_guardian_target(parsed_line.target_kind.as_deref()) {
        return None;
    }

    Some(ImportantCombatEvent {
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
    current_key_level: Option<u32>,
    in_challenge_mode: bool,
    in_pvp_match: bool,
}

#[derive(Debug, Default)]
pub(crate) struct RecordingMetadataAccumulator {
    context: DebugParseContext,
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
}

impl RecordingMetadataAccumulator {
    fn consume_combat_log_line(
        &mut self,
        line: &str,
        elapsed_seconds: f64,
    ) -> Option<ImportantCombatEvent> {
        let parsed_event = parse_important_combat_event(line, &mut self.context)?;
        self.record_important_event(&parsed_event, elapsed_seconds);
        Some(parsed_event)
    }

    fn record_manual_marker(&mut self, elapsed_seconds: f64) {
        let manual_event = ImportantCombatEvent {
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
            EVENT_ENCOUNTER_START => self.record_encounter_start(event, elapsed_seconds),
            EVENT_ENCOUNTER_END => self.record_encounter_end(event, elapsed_seconds),
            _ => {}
        }

        self.push_event_with_cap(RecordingImportantEventMetadata {
            timestamp_seconds: elapsed_seconds,
            log_timestamp: event.log_timestamp.clone(),
            event_type: event.event_type.clone(),
            source: event.source.clone(),
            target: event.target.clone(),
            zone_name: event.zone_name.clone(),
            encounter_name: event.encounter_name.clone(),
            encounter_category: event.encounter_category.clone(),
            key_level: event.key_level,
        });
    }

    fn record_encounter_start(&mut self, event: &ImportantCombatEvent, elapsed_seconds: f64) {
        let Some((encounter_name, encounter_category)) = encounter_identity(event) else {
            return;
        };

        let encounter_key = encounter_key(&encounter_name, &encounter_category);
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
            started_at_seconds: elapsed_seconds,
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
    metadata.apply_combat_log_snapshot(snapshot);

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
        "ZONE_CHANGE"
        | "ZONE_CHANGE_NEW_AREA"
        | "ZONE_CHANGED"
        | "ZONE_CHANGED_INDOORS"
        | "PLAYER_ENTERING_WORLD"
        | "MAP_CHANGE" => Some("ZONE_CONTEXT"),
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
        }
        "CHALLENGE_MODE_END" => {
            context.in_challenge_mode = false;
            context.current_key_level = None;
        }
        "ARENA_MATCH_START" | "PVP_MATCH_START" | "BATTLEGROUND_START" => {
            context.in_pvp_match = true;
        }
        "ARENA_MATCH_END" | "PVP_MATCH_COMPLETE" | "BATTLEGROUND_END" => {
            context.in_pvp_match = false;
        }
        _ => {}
    }
}

fn extract_challenge_mode_key_level(fields: &[String]) -> Option<u32> {
    fields
        .get(1)
        .and_then(|value| value.trim_matches('"').parse::<u32>().ok())
        .filter(|value| *value > 0)
}

fn is_context_only_event(raw_event_type: &str) -> bool {
    matches!(
        raw_event_type,
        "ZONE_CHANGE"
            | "ZONE_CHANGE_NEW_AREA"
            | "ZONE_CHANGED"
            | "ZONE_CHANGED_INDOORS"
            | "PLAYER_ENTERING_WORLD"
            | "MAP_CHANGE"
            | "CHALLENGE_MODE_START"
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
    let is_zone_context_event = matches!(
        raw_event_type,
        "ZONE_CHANGE"
            | "ZONE_CHANGE_NEW_AREA"
            | "ZONE_CHANGED"
            | "ZONE_CHANGED_INDOORS"
            | "PLAYER_ENTERING_WORLD"
            | "MAP_CHANGE"
    );

    if !is_zone_context_event {
        return None;
    }

    fields
        .iter()
        .find_map(|value| normalize_name(Some(value.as_str())))
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

#[cfg(test)]
mod tests {
    use super::{RecordingMetadataAccumulator, MAX_PERSISTED_HIGH_VOLUME_EVENTS};

    #[test]
    fn caps_high_volume_events_but_keeps_structural_events() {
        let mut accumulator = RecordingMetadataAccumulator::default();
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

        let challenge_start_line = build_line("CHALLENGE_MODE_START", &["2451", "14"]);
        accumulator.consume_combat_log_line(&challenge_start_line, 0.25);

        let party_kill_line = build_party_kill_line(1);
        accumulator.consume_combat_log_line(&party_kill_line, 1.0);

        let snapshot = accumulator.snapshot();
        assert_eq!(snapshot.key_level, Some(14));
        assert_eq!(snapshot.important_events.len(), 1);
        assert_eq!(snapshot.important_events[0].event_type, "PARTY_KILL");
        assert_eq!(snapshot.important_events[0].key_level, Some(14));
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
        let mut line = format!("2/22 20:15:11.000  {event_type}");
        if !fields.is_empty() {
            line.push(',');
            line.push_str(&fields.join(","));
        }
        line
    }
}
