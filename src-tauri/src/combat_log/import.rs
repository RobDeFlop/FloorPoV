//! Import a saved combat log onto an existing recording sidecar.

use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::recording::metadata::{
    backup_recording_metadata, read_recording_metadata, write_recording_metadata,
    RecordingEncounterMetadata, RecordingEncounterSnapshot, RecordingImportantEventMetadata,
    RecordingMetadata, RecordingMetadataSnapshot, RecordingPlayerMetadata,
};

use super::metadata::{rebase_recording_metadata_from_log_clock, RecordingMetadataAccumulator};
use super::parse::{extract_raw_event_type_from_line, log_clock_diff_seconds, LogTimestamp};
use super::{EVENT_ENCOUNTER_END, EVENT_ENCOUNTER_START, EVENT_MANUAL_MARKER};

const MATCH_SLACK_SECONDS: f64 = 90.0;
const NEGATIVE_EVENT_SLACK_SECONDS: f64 = 1.0;
const SHORT_LOG_MAX_SPAN_WITHOUT_DURATION: f64 = 3.0 * 3600.0;
const WINDOW_MAX_SPAN_WITHOUT_DURATION: f64 = 4.0 * 3600.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportCombatLogMode {
    Overwrite,
    Merge,
}

impl ImportCombatLogMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Overwrite => "overwrite",
            Self::Merge => "merge",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCombatLogResult {
    pub recording_path: String,
    pub mode: String,
    pub imported_event_count: u64,
    pub total_event_count: u64,
    pub backup_path: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct RecordingClock {
    pub(crate) month: u32,
    pub(crate) day: u32,
    pub(crate) seconds_since_midnight: f64,
}

#[tauri::command]
pub fn import_combat_log_onto_recording(
    app_handle: AppHandle,
    recording_path: String,
    combat_log_path: String,
    mode: ImportCombatLogMode,
    video_duration_seconds: Option<f64>,
) -> Result<ImportCombatLogResult, String> {
    let result = import_combat_log_onto_recording_inner(
        recording_path,
        combat_log_path,
        mode,
        video_duration_seconds,
    )?;

    if let Err(error) = app_handle.emit("combat-log-imported", result.recording_path.clone()) {
        tracing::warn!(
            recording_path = %result.recording_path,
            "Failed to emit combat-log-imported: {error}"
        );
    }

    Ok(result)
}

fn import_combat_log_onto_recording_inner(
    recording_path: String,
    combat_log_path: String,
    mode: ImportCombatLogMode,
    video_duration_seconds: Option<f64>,
) -> Result<ImportCombatLogResult, String> {
    let recording_file = PathBuf::from(recording_path.trim());
    validate_recording_path(&recording_file)?;

    let combat_log_file = PathBuf::from(combat_log_path.trim());
    validate_combat_log_path(&combat_log_file)?;

    let parsed_snapshot = parse_combat_log_file_to_snapshot(&combat_log_file)?;
    let existing_metadata = read_recording_metadata(&recording_file)?;
    let video_duration_seconds = required_video_duration(video_duration_seconds)?;
    let aligned_snapshot = align_snapshot_to_recording(
        parsed_snapshot,
        &recording_file,
        existing_metadata.as_ref(),
        Some(video_duration_seconds),
    )?;

    let imported_event_count = aligned_snapshot.important_events.len() as u64;
    let backup_path = if existing_metadata
        .as_ref()
        .is_some_and(RecordingMetadata::has_combat_content)
    {
        backup_recording_metadata(&recording_file)?.map(|path| path.to_string_lossy().to_string())
    } else {
        None
    };

    let mut metadata = existing_metadata.unwrap_or_else(|| RecordingMetadata::new(&recording_file));
    match mode {
        ImportCombatLogMode::Overwrite => {
            let preserved_manual_markers = take_manual_markers(&metadata);
            metadata.apply_combat_log_snapshot(aligned_snapshot);
            restore_manual_markers(&mut metadata, preserved_manual_markers);
        }
        ImportCombatLogMode::Merge => {
            merge_imported_snapshot(&mut metadata, aligned_snapshot);
        }
    }

    rebase_recording_metadata_from_log_clock(&mut metadata);
    write_recording_metadata(&recording_file, &metadata)?;

    Ok(ImportCombatLogResult {
        recording_path: recording_file.to_string_lossy().to_string(),
        mode: mode.as_str().to_string(),
        imported_event_count,
        total_event_count: metadata.important_events.len() as u64,
        backup_path,
    })
}

fn validate_recording_path(recording_path: &Path) -> Result<(), String> {
    if recording_path.as_os_str().is_empty() {
        return Err("Choose a recording before importing a combat log".to_string());
    }

    if recording_path.extension().and_then(|value| value.to_str()) != Some("mp4") {
        return Err("Only .mp4 recordings can receive an imported combat log".to_string());
    }

    if !recording_path.is_file() {
        return Err(format!(
            "Recording file not found: {}",
            recording_path.display()
        ));
    }

    Ok(())
}

fn validate_combat_log_path(combat_log_path: &Path) -> Result<(), String> {
    if combat_log_path.as_os_str().is_empty() {
        return Err("Choose a combat log .txt file".to_string());
    }

    let extension = combat_log_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension != "txt" && extension != "log" {
        return Err("Choose a combat log .txt file".to_string());
    }

    if !combat_log_path.is_file() {
        return Err(format!(
            "Combat log file not found: {}",
            combat_log_path.display()
        ));
    }

    Ok(())
}

fn sanitized_duration(video_duration_seconds: Option<f64>) -> Option<f64> {
    video_duration_seconds.filter(|duration| duration.is_finite() && *duration > 0.0)
}

fn required_video_duration(video_duration_seconds: Option<f64>) -> Result<f64, String> {
    sanitized_duration(video_duration_seconds)
        .ok_or_else(|| "Wait until the video duration is available before importing.".to_string())
}

fn parse_combat_log_file_to_snapshot(
    combat_log_path: &Path,
) -> Result<RecordingMetadataSnapshot, String> {
    let reader = BufReader::new(
        File::open(combat_log_path)
            .map_err(|error| format!("Failed to open combat log: {error}"))?,
    );

    let mut accumulator = RecordingMetadataAccumulator::default();
    accumulator.begin_import_session();

    let mut saw_non_empty_line = false;
    let mut last_non_empty_line = String::new();

    for line_result in reader.lines() {
        let line = line_result.map_err(|error| format!("Failed to read combat log: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }

        saw_non_empty_line = true;
        last_non_empty_line = line.clone();
        let _ = accumulator.consume_combat_log_line(&line, 0.0);
    }

    accumulator.finish_recording_session();

    if !saw_non_empty_line {
        return Err("This combat log is empty.".to_string());
    }

    if !looks_like_complete_combat_log_line(&last_non_empty_line) {
        return Err(
            "This combat log looks truncated. The last line is incomplete. Choose a complete copy of the file."
                .to_string(),
        );
    }

    let snapshot = accumulator.snapshot();
    if !snapshot.has_content() {
        return Err("This combat log has no importable combat events.".to_string());
    }

    Ok(snapshot)
}

pub(crate) fn looks_like_complete_combat_log_line(line: &str) -> bool {
    let trimmed_line = line.trim();
    if trimmed_line.is_empty() || !quotes_are_balanced(trimmed_line) {
        return false;
    }

    let header = trimmed_line.split(',').next().unwrap_or("").trim();
    let Some((_, event_type)) = header.rsplit_once("  ") else {
        return false;
    };

    let event_type = event_type.trim();
    !event_type.is_empty()
        && event_type.chars().all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
        && event_type
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_uppercase())
        && extract_raw_event_type_from_line(trimmed_line).is_some()
}

fn quotes_are_balanced(line: &str) -> bool {
    line.chars().filter(|character| *character == '"').count() % 2 == 0
}

fn align_snapshot_to_recording(
    snapshot: RecordingMetadataSnapshot,
    recording_path: &Path,
    existing_metadata: Option<&RecordingMetadata>,
    video_duration_seconds: Option<f64>,
) -> Result<RecordingMetadataSnapshot, String> {
    let unmatched_message = "This combat log does not overlap the recording timeline. Choose a log from the same session.";

    if snapshot.important_events.is_empty() {
        if duration_fits(0.0, video_duration_seconds) {
            return Ok(snapshot);
        }
        return Err(unmatched_message.to_string());
    }

    if let Some(clock) = recording_clock_from_path(recording_path) {
        if let Some(windowed) =
            window_snapshot_to_clock(snapshot.clone(), clock, video_duration_seconds)
        {
            return Ok(windowed);
        }
    }

    if let Some(existing_origin) = first_existing_log_origin(existing_metadata) {
        if let Some(windowed) =
            window_snapshot_to_origin(snapshot.clone(), existing_origin, video_duration_seconds)
        {
            return Ok(windowed);
        }
    }

    let span = snapshot_event_span(&snapshot);
    if duration_fits(span, video_duration_seconds) {
        return Ok(shift_short_log_to_recording_clock(
            snapshot,
            recording_path,
            video_duration_seconds,
        ));
    }

    Err(unmatched_message.to_string())
}

fn snapshot_event_span(snapshot: &RecordingMetadataSnapshot) -> f64 {
    let mut min_seconds = f64::INFINITY;
    let mut max_seconds = f64::NEG_INFINITY;
    for event in &snapshot.important_events {
        min_seconds = min_seconds.min(event.timestamp_seconds);
        max_seconds = max_seconds.max(event.timestamp_seconds);
    }

    if !min_seconds.is_finite() || !max_seconds.is_finite() {
        return 0.0;
    }

    (max_seconds - min_seconds).max(0.0)
}

fn duration_fits(span: f64, video_duration_seconds: Option<f64>) -> bool {
    match video_duration_seconds {
        Some(duration) => span <= duration + MATCH_SLACK_SECONDS,
        None => span <= SHORT_LOG_MAX_SPAN_WITHOUT_DURATION,
    }
}

fn window_limit(video_duration_seconds: Option<f64>) -> f64 {
    video_duration_seconds
        .map(|duration| duration + MATCH_SLACK_SECONDS)
        .unwrap_or(WINDOW_MAX_SPAN_WITHOUT_DURATION)
}

fn shift_short_log_to_recording_clock(
    mut snapshot: RecordingMetadataSnapshot,
    recording_path: &Path,
    video_duration_seconds: Option<f64>,
) -> RecordingMetadataSnapshot {
    let Some(clock) = recording_clock_from_path(recording_path) else {
        return snapshot;
    };
    let Some(first_log_timestamp) = first_event_log_timestamp(&snapshot.important_events) else {
        return snapshot;
    };
    if event_time_on_clock(clock, first_log_timestamp).is_none() {
        return snapshot;
    }

    let shift = log_clock_diff_seconds(
        clock.seconds_since_midnight,
        first_log_timestamp.to_seconds_since_midnight(),
    );
    if !shift.is_finite() || shift.abs() < 1.0 {
        return snapshot;
    }

    let max_seconds = window_limit(video_duration_seconds);
    if shift < -MATCH_SLACK_SECONDS || shift > max_seconds {
        return snapshot;
    }

    for event in &mut snapshot.important_events {
        event.timestamp_seconds += shift;
    }
    for encounter in &mut snapshot.encounters {
        encounter.started_at_seconds += shift;
        if let Some(ended_at_seconds) = encounter.ended_at_seconds.as_mut() {
            *ended_at_seconds += shift;
        }
    }

    drop_events_outside_window(&mut snapshot, max_seconds);
    snapshot
}

fn window_snapshot_to_clock(
    snapshot: RecordingMetadataSnapshot,
    clock: RecordingClock,
    video_duration_seconds: Option<f64>,
) -> Option<RecordingMetadataSnapshot> {
    let max_seconds = window_limit(video_duration_seconds);
    let mut windowed = snapshot;
    let mut kept_events = Vec::new();

    for mut event in windowed.important_events {
        let Some(log_timestamp) = event.log_timestamp.as_deref().and_then(LogTimestamp::parse)
        else {
            continue;
        };
        let Some(video_seconds) = event_time_on_clock(clock, log_timestamp) else {
            continue;
        };
        if video_seconds < -NEGATIVE_EVENT_SLACK_SECONDS || video_seconds > max_seconds {
            continue;
        }

        event.timestamp_seconds = video_seconds.max(0.0);
        kept_events.push(event);
    }

    if kept_events.is_empty() {
        return None;
    }

    windowed.important_events = kept_events;
    finalize_windowed_snapshot(&mut windowed);
    Some(windowed)
}

fn window_snapshot_to_origin(
    snapshot: RecordingMetadataSnapshot,
    origin_seconds: f64,
    video_duration_seconds: Option<f64>,
) -> Option<RecordingMetadataSnapshot> {
    let max_seconds = window_limit(video_duration_seconds);
    let mut windowed = snapshot;
    let mut kept_events = Vec::new();

    for mut event in windowed.important_events {
        let Some(log_timestamp) = event.log_timestamp.as_deref().and_then(LogTimestamp::parse)
        else {
            continue;
        };
        let video_seconds =
            log_clock_diff_seconds(origin_seconds, log_timestamp.to_seconds_since_midnight());
        if !video_seconds.is_finite()
            || video_seconds < -NEGATIVE_EVENT_SLACK_SECONDS
            || video_seconds > max_seconds
        {
            continue;
        }

        event.timestamp_seconds = video_seconds.max(0.0);
        kept_events.push(event);
    }

    if kept_events.is_empty() {
        return None;
    }

    windowed.important_events = kept_events;
    finalize_windowed_snapshot(&mut windowed);
    Some(windowed)
}

fn drop_events_outside_window(snapshot: &mut RecordingMetadataSnapshot, max_seconds: f64) {
    snapshot.important_events.retain(|event| {
        event.timestamp_seconds >= -NEGATIVE_EVENT_SLACK_SECONDS
            && event.timestamp_seconds <= max_seconds
    });
    for event in &mut snapshot.important_events {
        event.timestamp_seconds = event.timestamp_seconds.max(0.0);
    }
    finalize_windowed_snapshot(snapshot);
}

fn finalize_windowed_snapshot(snapshot: &mut RecordingMetadataSnapshot) {
    snapshot.encounters = rebuild_encounters_from_events(&snapshot.important_events);
    snapshot.important_event_counts = recount_events(&snapshot.important_events);
    snapshot.zone_name =
        last_present_field(&snapshot.important_events, |event| event.zone_name.clone());
    snapshot.encounter_name = last_present_field(&snapshot.important_events, |event| {
        event.encounter_name.clone()
    });
    snapshot.encounter_category = last_present_field(&snapshot.important_events, |event| {
        event.encounter_category.clone()
    });
    snapshot.key_level = snapshot
        .important_events
        .iter()
        .rev()
        .find_map(|event| event.key_level);
}

fn last_present_field(
    events: &[RecordingImportantEventMetadata],
    read_field: impl Fn(&RecordingImportantEventMetadata) -> Option<String>,
) -> Option<String> {
    events.iter().rev().find_map(read_field)
}

fn recount_events(events: &[RecordingImportantEventMetadata]) -> BTreeMap<String, u64> {
    let mut counts = BTreeMap::new();
    for event in events {
        *counts.entry(event.event_type.clone()).or_insert(0) += 1;
    }
    counts
}

fn rebuild_encounters_from_events(
    events: &[RecordingImportantEventMetadata],
) -> Vec<RecordingEncounterSnapshot> {
    let mut active_encounters = BTreeMap::new();
    let mut encounters = Vec::new();

    for event in events {
        let Some(encounter_name) = event.encounter_name.clone() else {
            continue;
        };
        let encounter_category = event
            .encounter_category
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
        let encounter_key = format!("{encounter_name}:{encounter_category}");

        match event.event_type.as_str() {
            value if value == EVENT_ENCOUNTER_START => {
                if active_encounters.contains_key(&encounter_key) {
                    continue;
                }

                let index = encounters.len();
                encounters.push(RecordingEncounterSnapshot {
                    name: encounter_name,
                    category: encounter_category,
                    started_at_seconds: event.timestamp_seconds,
                    ended_at_seconds: None,
                });
                active_encounters.insert(encounter_key, index);
            }
            value if value == EVENT_ENCOUNTER_END => {
                if let Some(index) = active_encounters.remove(&encounter_key) {
                    if let Some(encounter) = encounters.get_mut(index) {
                        encounter.ended_at_seconds = Some(event.timestamp_seconds);
                    }
                    continue;
                }

                encounters.push(RecordingEncounterSnapshot {
                    name: encounter_name,
                    category: encounter_category,
                    started_at_seconds: 0.0,
                    ended_at_seconds: Some(event.timestamp_seconds),
                });
            }
            _ => {}
        }
    }

    encounters
}

fn first_event_log_timestamp(events: &[RecordingImportantEventMetadata]) -> Option<LogTimestamp> {
    events
        .iter()
        .find_map(|event| event.log_timestamp.as_deref().and_then(LogTimestamp::parse))
}

fn first_existing_log_origin(existing_metadata: Option<&RecordingMetadata>) -> Option<f64> {
    existing_metadata.and_then(|metadata| {
        metadata.important_events.iter().find_map(|event| {
            event
                .log_timestamp
                .as_deref()
                .and_then(LogTimestamp::parse)
                .map(|timestamp| timestamp.to_seconds_since_midnight())
        })
    })
}

fn event_time_on_clock(clock: RecordingClock, event: LogTimestamp) -> Option<f64> {
    if clock.month == event.month && clock.day == event.day {
        return Some(log_clock_diff_seconds(
            clock.seconds_since_midnight,
            event.to_seconds_since_midnight(),
        ));
    }

    if clock.seconds_since_midnight >= 4.0 * 3600.0 {
        return None;
    }

    let (previous_month, previous_day) = previous_calendar_day(clock.month, clock.day)?;
    if event.month == previous_month && event.day == previous_day {
        return Some(log_clock_diff_seconds(
            clock.seconds_since_midnight,
            event.to_seconds_since_midnight(),
        ));
    }

    None
}

fn previous_calendar_day(month: u32, day: u32) -> Option<(u32, u32)> {
    use chrono::Datelike;

    let date = chrono::NaiveDate::from_ymd_opt(2024, month, day)?;
    let previous = date.pred_opt()?;
    Some((previous.month(), previous.day()))
}

fn recording_clock_from_path(recording_path: &Path) -> Option<RecordingClock> {
    recording_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .and_then(parse_recording_clock_from_stem)
        .or_else(|| recording_clock_from_file_created(recording_path))
}

pub(crate) fn parse_recording_clock_from_stem(stem: &str) -> Option<RecordingClock> {
    let bytes = stem.as_bytes();
    let mut last_match = None;
    let mut index = 0;

    while index + 13 <= bytes.len() {
        if !bytes[index..index + 8].iter().all(u8::is_ascii_digit) {
            index += 1;
            continue;
        }

        let separator = bytes[index + 8];
        if separator != b'_' && separator != b'-' {
            index += 1;
            continue;
        }

        let remaining = bytes.len() - (index + 9);
        let time_len = if remaining >= 6
            && bytes[index + 9..index + 15].iter().all(u8::is_ascii_digit)
        {
            6
        } else if remaining >= 4 && bytes[index + 9..index + 13].iter().all(u8::is_ascii_digit) {
            4
        } else {
            index += 1;
            continue;
        };

        if index + 9 + time_len < bytes.len() && bytes[index + 9 + time_len].is_ascii_digit() {
            index += 1;
            continue;
        }

        let date = std::str::from_utf8(&bytes[index..index + 8]).ok()?;
        let time_text = std::str::from_utf8(&bytes[index + 9..index + 9 + time_len]).ok()?;
        let month: u32 = date.get(4..6)?.parse().ok()?;
        let day: u32 = date.get(6..8)?.parse().ok()?;
        let hour: u32 = time_text.get(0..2)?.parse().ok()?;
        let minute: u32 = time_text.get(2..4)?.parse().ok()?;
        let second: u32 = if time_len == 6 {
            time_text.get(4..6)?.parse().ok()?
        } else {
            0
        };

        if !(1..=12).contains(&month)
            || !(1..=31).contains(&day)
            || hour > 23
            || minute > 59
            || second > 59
        {
            index += 1;
            continue;
        }

        last_match = Some(RecordingClock {
            month,
            day,
            seconds_since_midnight: (hour as f64) * 3600.0
                + (minute as f64) * 60.0
                + (second as f64),
        });
        index += 1;
    }

    last_match
}

fn recording_clock_from_file_created(recording_path: &Path) -> Option<RecordingClock> {
    let created = std::fs::metadata(recording_path).ok()?.created().ok()?;
    let datetime = chrono::DateTime::<chrono::Local>::from(created);
    use chrono::{Datelike, Timelike};

    Some(RecordingClock {
        month: datetime.month(),
        day: datetime.day(),
        seconds_since_midnight: (datetime.hour() as f64) * 3600.0
            + (datetime.minute() as f64) * 60.0
            + (datetime.second() as f64)
            + (datetime.nanosecond() as f64 / 1_000_000_000.0),
    })
}

fn take_manual_markers(metadata: &RecordingMetadata) -> Vec<RecordingImportantEventMetadata> {
    metadata
        .important_events
        .iter()
        .filter(|event| event.event_type == EVENT_MANUAL_MARKER)
        .cloned()
        .collect()
}

fn restore_manual_markers(
    metadata: &mut RecordingMetadata,
    manual_markers: Vec<RecordingImportantEventMetadata>,
) {
    if manual_markers.is_empty() {
        return;
    }

    let manual_count = manual_markers.len() as u64;
    metadata.important_events.extend(manual_markers);
    sort_important_events(&mut metadata.important_events);
    metadata
        .important_event_counts
        .insert(EVENT_MANUAL_MARKER.to_string(), manual_count);
}

fn merge_imported_snapshot(existing: &mut RecordingMetadata, imported: RecordingMetadataSnapshot) {
    if let Some(zone_name) = imported.zone_name {
        existing.zone_name = Some(zone_name);
    }
    if let Some(encounter_name) = imported.encounter_name {
        existing.encounter_name = Some(encounter_name);
    }
    if let Some(encounter_category) = imported.encounter_category {
        existing.encounter_category = Some(encounter_category);
    }
    if let Some(key_level) = imported.key_level {
        existing.key_level = Some(key_level);
    }

    merge_players(&mut existing.players, imported.players);
    merge_encounters(&mut existing.encounters, imported.encounters);
    merge_important_events(&mut existing.important_events, imported.important_events);
    existing.important_event_counts = recount_events(&existing.important_events);
    existing.important_events_dropped_count = existing
        .important_events_dropped_count
        .saturating_add(imported.important_events_dropped_count);
}

fn merge_players(
    existing_players: &mut Vec<RecordingPlayerMetadata>,
    imported_players: Vec<RecordingPlayerMetadata>,
) {
    let mut players_by_guid = existing_players
        .drain(..)
        .map(|player| (player.guid.clone(), player))
        .collect::<BTreeMap<_, _>>();

    for imported_player in imported_players {
        let entry = players_by_guid
            .entry(imported_player.guid.clone())
            .or_insert_with(|| RecordingPlayerMetadata {
                guid: imported_player.guid.clone(),
                name: None,
                class_name: None,
                spec_name: None,
                spec_id: None,
            });

        if imported_player.name.is_some() {
            entry.name = imported_player.name;
        }
        if imported_player.class_name.is_some() {
            entry.class_name = imported_player.class_name;
        }
        if imported_player.spec_name.is_some() {
            entry.spec_name = imported_player.spec_name;
        }
        if imported_player.spec_id.is_some() {
            entry.spec_id = imported_player.spec_id;
        }
    }

    *existing_players = players_by_guid.into_values().collect();
}

fn merge_encounters(
    existing_encounters: &mut Vec<RecordingEncounterMetadata>,
    imported_encounters: Vec<RecordingEncounterSnapshot>,
) {
    let mut seen_keys = existing_encounters
        .iter()
        .map(encounter_identity_key)
        .collect::<HashSet<_>>();

    for imported in imported_encounters {
        let encounter = RecordingEncounterMetadata {
            name: imported.name,
            category: imported.category,
            started_at_seconds: Some(imported.started_at_seconds),
            ended_at_seconds: imported.ended_at_seconds,
        };
        let key = encounter_identity_key(&encounter);
        if seen_keys.insert(key) {
            existing_encounters.push(encounter);
        }
    }
}

fn encounter_identity_key(encounter: &RecordingEncounterMetadata) -> String {
    format!(
        "{}:{}:{:.3}",
        encounter.name,
        encounter.category,
        encounter.started_at_seconds.unwrap_or(0.0)
    )
}

fn merge_important_events(
    existing_events: &mut Vec<RecordingImportantEventMetadata>,
    imported_events: Vec<RecordingImportantEventMetadata>,
) {
    let mut seen_keys = existing_events
        .iter()
        .map(event_identity_key)
        .collect::<HashSet<_>>();

    for imported_event in imported_events {
        if seen_keys.insert(event_identity_key(&imported_event)) {
            existing_events.push(imported_event);
        }
    }

    sort_important_events(existing_events);
}

fn event_identity_key(event: &RecordingImportantEventMetadata) -> String {
    if let Some(log_timestamp) = event
        .log_timestamp
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        return format!(
            "{}|{}|{}|{}",
            event.event_type,
            log_timestamp,
            event.source.as_deref().unwrap_or(""),
            event.target.as_deref().unwrap_or(""),
        );
    }

    format!(
        "{}||{}|{}|{:.3}",
        event.event_type,
        event.source.as_deref().unwrap_or(""),
        event.target.as_deref().unwrap_or(""),
        event.timestamp_seconds
    )
}

fn sort_important_events(events: &mut [RecordingImportantEventMetadata]) {
    events.sort_by(|left, right| {
        left.timestamp_seconds
            .partial_cmp(&right.timestamp_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.event_type.cmp(&right.event_type))
    });
}

#[cfg(test)]
mod tests {
    use super::{
        import_combat_log_onto_recording_inner, looks_like_complete_combat_log_line,
        parse_combat_log_file_to_snapshot, parse_recording_clock_from_stem,
        window_snapshot_to_clock, ImportCombatLogMode, RecordingClock, MATCH_SLACK_SECONDS,
    };
    use crate::recording::metadata::{
        backup_recording_metadata, metadata_sidecar_backup_path, read_recording_metadata,
        write_recording_metadata, RecordingImportantEventMetadata, RecordingMetadata,
        RecordingMetadataSnapshot,
    };
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_directory() -> PathBuf {
        let timestamp_nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let directory = std::env::temp_dir().join(format!(
            "floorpov_combat_log_import_{}_{timestamp_nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).expect("temp directory");
        directory
    }

    fn write_log(directory: &Path, file_name: &str, contents: &str) -> PathBuf {
        let path = directory.join(file_name);
        std::fs::write(&path, contents).expect("write combat log");
        path
    }

    fn player_death_line(timestamp: &str, player_name: &str) -> String {
        format!(
            "{timestamp}  UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,Player-1111-00000001,\"{player_name}\",0x512,0x80000000,0"
        )
    }

    #[test]
    fn accepts_complete_combat_log_lines() {
        assert!(looks_like_complete_combat_log_line(
            "9/11/2026 17:52:01.123  SPELL_DAMAGE,Player-1-1,\"Mage\""
        ));
        assert!(looks_like_complete_combat_log_line(
            "2/22 20:15:11.000  ENCOUNTER_START,1,\"Training Boss\",16"
        ));
    }

    #[test]
    fn rejects_truncated_combat_log_lines() {
        assert!(!looks_like_complete_combat_log_line(
            "9/11/2026 17:52:01.123  SPELL_DAMAGE,Player-1-1,\"Mage"
        ));
        assert!(!looks_like_complete_combat_log_line(
            "9/11/2026 17:52:01.123"
        ));
        assert!(!looks_like_complete_combat_log_line(""));
    }

    #[test]
    fn parses_recording_clock_from_common_stems() {
        let screen = parse_recording_clock_from_stem("screen_recording_20260911_175201")
            .expect("screen recording stem");
        assert_eq!(screen.month, 9);
        assert_eq!(screen.day, 11);
        assert!((screen.seconds_since_midnight - (17.0 * 3600.0 + 52.0 * 60.0 + 1.0)).abs() < 0.01);

        let library = parse_recording_clock_from_stem("voidscar-arena-14-20260911-1752")
            .expect("library stem");
        assert_eq!(library.month, 9);
        assert_eq!(library.day, 11);
        assert!((library.seconds_since_midnight - (17.0 * 3600.0 + 52.0 * 60.0)).abs() < 0.01);
    }

    #[test]
    fn empty_combat_log_is_rejected() {
        let directory = unique_temp_directory();
        let log_path = write_log(&directory, "WoWCombatLog.txt", "\n\n");
        let error = parse_combat_log_file_to_snapshot(&log_path).expect_err("empty log");
        assert!(error.to_lowercase().contains("empty"));
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn truncated_combat_log_is_rejected() {
        let directory = unique_temp_directory();
        let log_path = write_log(
            &directory,
            "WoWCombatLog.txt",
            &format!(
                "{}\n9/11/2026 17:52:01.123  SPELL_DAMAGE,Player-1-1,\"Mage",
                player_death_line("9/11/2026 17:52:01.000", "Enemy0")
            ),
        );
        let error = parse_combat_log_file_to_snapshot(&log_path).expect_err("truncated log");
        assert!(error.to_lowercase().contains("truncated"));
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn short_log_maps_first_event_to_zero() {
        let directory = unique_temp_directory();
        let log_path = write_log(
            &directory,
            "WoWCombatLog.txt",
            &format!(
                "{}\n{}\n",
                player_death_line("9/11/2026 17:52:05.000", "Enemy0"),
                player_death_line("9/11/2026 17:52:30.000", "Enemy1")
            ),
        );
        let snapshot = parse_combat_log_file_to_snapshot(&log_path).expect("parse");
        assert_eq!(snapshot.important_events.len(), 2);
        assert!((snapshot.important_events[0].timestamp_seconds - 0.0).abs() < 0.01);
        assert!((snapshot.important_events[1].timestamp_seconds - 25.0).abs() < 0.01);
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn windows_long_log_to_recording_clock() {
        let first = player_death_line("9/11/2026 10:00:00.000", "Morning");
        let matched = player_death_line("9/11/2026 17:52:05.000", "Pull");
        let later = player_death_line("9/11/2026 17:52:20.000", "Later");
        let directory = unique_temp_directory();
        let log_path = write_log(
            &directory,
            "WoWCombatLog.txt",
            &format!("{first}\n{matched}\n{later}\n"),
        );
        let snapshot = parse_combat_log_file_to_snapshot(&log_path).expect("parse");
        assert!(snapshot.important_events[2].timestamp_seconds > 7.0 * 3600.0);

        let windowed = window_snapshot_to_clock(
            snapshot,
            RecordingClock {
                month: 9,
                day: 11,
                seconds_since_midnight: 17.0 * 3600.0 + 52.0 * 60.0,
            },
            Some(40.0),
        )
        .expect("window");

        assert_eq!(windowed.important_events.len(), 2);
        assert!((windowed.important_events[0].timestamp_seconds - 5.0).abs() < 0.01);
        assert!((windowed.important_events[1].timestamp_seconds - 20.0).abs() < 0.01);
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn unmatched_clock_yields_no_window() {
        let directory = unique_temp_directory();
        let log_path = write_log(
            &directory,
            "WoWCombatLog.txt",
            &format!(
                "{}\n{}\n",
                player_death_line("9/10/2026 10:00:00.000", "A"),
                player_death_line("9/10/2026 18:00:00.000", "B")
            ),
        );
        let snapshot = parse_combat_log_file_to_snapshot(&log_path).expect("parse");
        assert!(window_snapshot_to_clock(
            snapshot,
            RecordingClock {
                month: 9,
                day: 11,
                seconds_since_midnight: 17.0 * 3600.0,
            },
            Some(60.0),
        )
        .is_none());
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn short_span_log_still_windows_to_recording_clock() {
        let directory = unique_temp_directory();
        let recording_path = directory.join("screen_recording_20260911_175201.mp4");
        std::fs::write(&recording_path, b"test").expect("recording file");
        let log_path = write_log(
            &directory,
            "WoWCombatLog.txt",
            &format!(
                "{}\n{}\n",
                player_death_line("9/11/2026 17:52:05.000", "Enemy0"),
                player_death_line("9/11/2026 17:52:30.000", "Enemy1")
            ),
        );

        import_combat_log_onto_recording_inner(
            recording_path.to_string_lossy().to_string(),
            log_path.to_string_lossy().to_string(),
            ImportCombatLogMode::Overwrite,
            Some(40.0),
        )
        .expect("import");

        let loaded = read_recording_metadata(&recording_path)
            .expect("read")
            .expect("sidecar");
        let kills: Vec<_> = loaded
            .important_events
            .iter()
            .filter(|event| event.event_type == "UNIT_DIED")
            .collect();
        assert_eq!(kills.len(), 2);
        assert!((kills[0].timestamp_seconds - 4.0).abs() < 0.01);
        assert!((kills[1].timestamp_seconds - 29.0).abs() < 0.01);
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn rejects_import_without_video_duration() {
        let directory = unique_temp_directory();
        let recording_path = directory.join("screen_recording_20260911_175201.mp4");
        std::fs::write(&recording_path, b"test").expect("recording file");
        let log_path = write_log(
            &directory,
            "WoWCombatLog.txt",
            &format!(
                "{}\n",
                player_death_line("9/11/2026 17:52:05.000", "Enemy0")
            ),
        );

        let error = import_combat_log_onto_recording_inner(
            recording_path.to_string_lossy().to_string(),
            log_path.to_string_lossy().to_string(),
            ImportCombatLogMode::Overwrite,
            None,
        )
        .expect_err("duration required");
        assert!(error.to_lowercase().contains("duration"));
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn backup_copies_existing_sidecar() {
        let directory = unique_temp_directory();
        let recording_path = directory.join("screen_recording_20260911_175201.mp4");
        std::fs::write(&recording_path, b"test").expect("recording file");

        let mut metadata = RecordingMetadata::new(&recording_path);
        metadata.zone_name = Some("Voidscar Arena".to_string());
        write_recording_metadata(&recording_path, &metadata).expect("write sidecar");

        let backup_path = backup_recording_metadata(&recording_path)
            .expect("backup")
            .expect("backup path");
        assert_eq!(backup_path, metadata_sidecar_backup_path(&recording_path));
        assert!(backup_path.exists());

        let loaded = read_recording_metadata(&recording_path)
            .expect("read")
            .expect("sidecar");
        assert_eq!(loaded.zone_name.as_deref(), Some("Voidscar Arena"));

        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn slack_covers_minute_precision_filenames() {
        assert!(MATCH_SLACK_SECONDS >= 60.0);
    }

    #[test]
    fn event_identity_ignores_duplicate_imported_rows() {
        let event = RecordingImportantEventMetadata {
            timestamp_seconds: 12.0,
            log_timestamp: Some("9/11/2026 17:52:12.000".to_string()),
            event_type: "UNIT_DIED".to_string(),
            source: None,
            target: Some("MageOne".to_string()),
            target_kind: Some("PLAYER".to_string()),
            extra_spell_name: None,
            ability_name: None,
            amount: None,
            zone_name: None,
            encounter_name: None,
            encounter_category: None,
            key_level: None,
            name: None,
        };
        let mut existing = vec![event.clone()];
        super::merge_important_events(&mut existing, vec![event]);
        assert_eq!(existing.len(), 1);
    }

    #[test]
    fn overwrites_sidecar_and_keeps_manual_markers() {
        let directory = unique_temp_directory();
        let recording_path = directory.join("screen_recording_20260911_175201.mp4");
        std::fs::write(&recording_path, b"test").expect("recording file");

        let mut metadata = RecordingMetadata::new(&recording_path);
        metadata.zone_name = Some("Old Zone".to_string());
        metadata.important_events = vec![
            RecordingImportantEventMetadata {
                timestamp_seconds: 8.0,
                log_timestamp: None,
                event_type: "MANUAL_MARKER".to_string(),
                source: None,
                target: None,
                target_kind: None,
                extra_spell_name: None,
                ability_name: None,
                amount: None,
                zone_name: None,
                encounter_name: None,
                encounter_category: None,
                key_level: None,
                name: None,
            },
            RecordingImportantEventMetadata {
                timestamp_seconds: 3.0,
                log_timestamp: Some("9/11/2026 17:52:03.000".to_string()),
                event_type: "UNIT_DIED".to_string(),
                source: None,
                target: Some("OldPlayer".to_string()),
                target_kind: Some("PLAYER".to_string()),
                extra_spell_name: None,
                ability_name: None,
                amount: None,
                zone_name: Some("Old Zone".to_string()),
                encounter_name: None,
                encounter_category: None,
                key_level: None,
                name: None,
            },
        ];
        write_recording_metadata(&recording_path, &metadata).expect("write sidecar");

        let log_path = write_log(
            &directory,
            "WoWCombatLog.txt",
            &format!(
                "{}\n{}\n",
                player_death_line("9/11/2026 17:52:05.000", "Enemy0"),
                player_death_line("9/11/2026 17:52:20.000", "Enemy1")
            ),
        );

        let result = import_combat_log_onto_recording_inner(
            recording_path.to_string_lossy().to_string(),
            log_path.to_string_lossy().to_string(),
            ImportCombatLogMode::Overwrite,
            Some(40.0),
        )
        .expect("import");

        assert_eq!(result.mode, "overwrite");
        assert!(result.backup_path.is_some());
        assert!(metadata_sidecar_backup_path(&recording_path).exists());

        let loaded = read_recording_metadata(&recording_path)
            .expect("read")
            .expect("sidecar");
        assert_eq!(
            loaded
                .important_events
                .iter()
                .filter(|event| event.event_type == "MANUAL_MARKER")
                .count(),
            1
        );
        assert_eq!(
            loaded
                .important_events
                .iter()
                .filter(|event| event.event_type == "UNIT_DIED")
                .count(),
            2
        );

        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn merge_keeps_existing_unique_events() {
        let directory = unique_temp_directory();
        let recording_path = directory.join("screen_recording_20260911_175201.mp4");
        std::fs::write(&recording_path, b"test").expect("recording file");

        let mut metadata = RecordingMetadata::new(&recording_path);
        metadata.important_events = vec![RecordingImportantEventMetadata {
            timestamp_seconds: 12.0,
            log_timestamp: Some("9/11/2026 17:52:12.000".to_string()),
            event_type: "UNIT_DIED".to_string(),
            source: None,
            target: Some("MageOne".to_string()),
            target_kind: Some("PLAYER".to_string()),
            extra_spell_name: None,
            ability_name: None,
            amount: None,
            zone_name: None,
            encounter_name: None,
            encounter_category: None,
            key_level: None,
            name: None,
        }];
        write_recording_metadata(&recording_path, &metadata).expect("write sidecar");

        let log_path = write_log(
            &directory,
            "WoWCombatLog.txt",
            &format!(
                "{}\n",
                player_death_line("9/11/2026 17:52:05.000", "Enemy0")
            ),
        );

        let result = import_combat_log_onto_recording_inner(
            recording_path.to_string_lossy().to_string(),
            log_path.to_string_lossy().to_string(),
            ImportCombatLogMode::Merge,
            Some(40.0),
        )
        .expect("merge");

        assert_eq!(result.mode, "merge");
        let loaded = read_recording_metadata(&recording_path)
            .expect("read")
            .expect("sidecar");
        assert_eq!(
            loaded
                .important_events
                .iter()
                .filter(|event| event.event_type == "UNIT_DIED")
                .count(),
            2
        );

        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn unmatched_long_log_returns_user_facing_error() {
        let directory = unique_temp_directory();
        let recording_path = directory.join("screen_recording_20260911_175201.mp4");
        std::fs::write(&recording_path, b"test").expect("recording file");
        let log_path = write_log(
            &directory,
            "WoWCombatLog.txt",
            &format!(
                "{}\n{}\n",
                player_death_line("9/10/2026 10:00:00.000", "A"),
                player_death_line("9/10/2026 18:00:00.000", "B")
            ),
        );

        let error = import_combat_log_onto_recording_inner(
            recording_path.to_string_lossy().to_string(),
            log_path.to_string_lossy().to_string(),
            ImportCombatLogMode::Overwrite,
            Some(60.0),
        )
        .expect_err("unmatched");
        assert!(
            error.to_lowercase().contains("overlap")
                || error.to_lowercase().contains("unmatch")
                || error.to_lowercase().contains("timeline")
        );

        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn snapshot_without_events_still_has_zone_content() {
        let snapshot = RecordingMetadataSnapshot {
            zone_name: Some("Voidscar Arena".to_string()),
            encounter_name: None,
            encounter_category: None,
            key_level: Some(14),
            encounters: Vec::new(),
            important_events: Vec::new(),
            important_event_counts: BTreeMap::new(),
            important_events_dropped_count: 0,
            players: Vec::new(),
        };
        assert!(snapshot.has_content());
    }
}
