use super::metadata::RecordingMetadataAccumulator;
use super::parse::LogTimestamp;
use super::MAX_PERSISTED_HIGH_VOLUME_EVENTS;

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

    let challenge_start_line = build_line("CHALLENGE_MODE_START", &["2451", "2662", "505", "14"]);
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

    let stale_zone_line = build_line_at("ZONE_CHANGED", &["\"Stale Zone\""], "2/22 10:00:00.000");
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
            "\"Nuggie-Blackrock\"",
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
            "\"Medokar-Rajaxx\"",
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
        (snapshot.encounters[0].ended_at_seconds.unwrap() - expected_encounter_end).abs() < 0.001,
        "Encounter should end at ~96.1s, got {:?}",
        snapshot.encounters[0].ended_at_seconds
    );
}

#[test]
fn ignores_unconscious_death_events() {
    let mut accumulator = RecordingMetadataAccumulator::default();
    accumulator.begin_recording_session(0.0);

    let unconscious_death = build_line_at(
        "UNIT_DIED",
        &[
            "0000000000000000",
            "nil",
            "0x80000000",
            "0x80000000",
            "Player-3682-0B561573",
            "\"Aliandria-Ragnaros-EU\"",
            "0x512",
            "0x80000000",
            "1",
        ],
        "4/21/2026 04:04:59.4742",
    );
    accumulator.consume_combat_log_line(&unconscious_death, 5.0);

    let normal_death = build_line_at(
        "UNIT_DIED",
        &[
            "0000000000000000",
            "nil",
            "0x80000000",
            "0x80000000",
            "Player-3682-0B561573",
            "\"Aliandria-Ragnaros-EU\"",
            "0x512",
            "0x80000000",
            "0",
        ],
        "4/21/2026 04:05:10.0000",
    );
    accumulator.consume_combat_log_line(&normal_death, 10.0);

    let no_flag_death = build_line_at(
        "UNIT_DIED",
        &[
            "0000000000000000",
            "nil",
            "0x80000000",
            "0x80000000",
            "Player-3682-0B561573",
            "\"Aliandria-Ragnaros-EU\"",
            "0x512",
            "0x80000000",
        ],
        "4/21/2026 04:05:20.0000",
    );
    accumulator.consume_combat_log_line(&no_flag_death, 15.0);

    let snapshot = accumulator.snapshot();
    let death_events: Vec<_> = snapshot
        .important_events
        .iter()
        .filter(|event| event.event_type == "UNIT_DIED")
        .collect();

    assert_eq!(
        death_events.len(),
        2,
        "Unconscious deaths should be ignored"
    );
}
