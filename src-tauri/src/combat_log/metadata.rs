use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::recording::metadata::{
    RecordingEncounterSnapshot, RecordingImportantEventMetadata, RecordingMetadata,
    RecordingMetadataSnapshot, RecordingPlayerMetadata,
};

use super::parse::{
    extract_raw_event_type_from_line, is_context_only_event, normalize_name,
    parse_combatant_info_snapshot, parse_important_combat_event,
    parse_player_identities_from_log_line, should_reset_player_roster_for_event, DebugParseContext,
    ImportantCombatEvent, LogTimestamp,
};
use super::{
    EVENT_ENCOUNTER_END, EVENT_ENCOUNTER_START, EVENT_MANUAL_MARKER,
    MAX_PERSISTED_HIGH_VOLUME_EVENTS,
};

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
    pub(crate) fn consume_combat_log_line(
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

    pub(crate) fn begin_recording_session(&mut self, elapsed_seconds: f64) {
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

    pub(crate) fn finish_recording_session(&mut self) {
        self.recording_active = false;
    }

    pub(crate) fn is_recording_session_active(&self) -> bool {
        self.recording_active
    }

    pub(crate) fn current_context_zone_name(&self) -> Option<String> {
        self.context.current_zone.clone()
    }

    pub(crate) fn recording_elapsed_seconds(
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

    pub(crate) fn record_manual_marker(&mut self, elapsed_seconds: f64) {
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

pub(crate) fn persist_recording_metadata_snapshot(
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
