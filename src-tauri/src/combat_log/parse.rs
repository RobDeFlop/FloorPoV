use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use super::{
    CombatTriggerEvent, ParseCombatLogDebugResult, ParsedCombatEvent, EVENT_ENCOUNTER_END,
    EVENT_ENCOUNTER_START, MAX_DEBUG_EVENTS,
};

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

#[derive(Debug, Clone)]
pub(crate) struct ImportantCombatEvent {
    pub(crate) raw_event_type: String,
    pub(crate) log_timestamp: Option<String>,
    pub(crate) event_type: String,
    pub(crate) source: Option<String>,
    pub(crate) target: Option<String>,
    pub(crate) target_kind: Option<String>,
    pub(crate) zone_name: Option<String>,
    pub(crate) encounter_name: Option<String>,
    pub(crate) encounter_category: Option<String>,
    pub(crate) key_level: Option<u32>,
}

#[derive(Debug, Clone)]
pub(crate) struct CombatantInfoSnapshot {
    pub(crate) player_guid: String,
    pub(crate) spec_id: Option<u32>,
    pub(crate) class_name: Option<String>,
    pub(crate) spec_name: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct PlayerIdentity {
    pub(crate) guid: String,
    pub(crate) name: Option<String>,
}

impl ImportantCombatEvent {
    pub(crate) fn into_live_event(
        self,
        recording_elapsed_seconds: Option<f64>,
    ) -> Option<super::CombatEvent> {
        let timestamp = recording_elapsed_seconds?;
        match self.event_type.as_str() {
            "PARTY_KILL" | "UNIT_DIED" => Some(super::CombatEvent {
                timestamp,
                event_type: self.event_type,
                source: self.source,
                target: self.target,
            }),
            _ => None,
        }
    }
}

pub(crate) fn extract_combat_trigger_event(
    event: &ImportantCombatEvent,
) -> Option<CombatTriggerEvent> {
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

pub(crate) fn parse_important_combat_event(
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

    if should_ignore_unconscious_death(&parsed_line) {
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
pub(crate) struct DebugParseContext {
    pub(crate) current_zone: Option<String>,
    pub(crate) current_encounter: Option<String>,
    pub(crate) current_encounter_category: Option<String>,
    pub(crate) current_encounter_log_timestamp: Option<String>,
    pub(crate) current_key_level: Option<u32>,
    pub(crate) challenge_mode_start_log_timestamp: Option<String>,
    pub(crate) pvp_match_start_log_timestamp: Option<String>,
    pub(crate) in_challenge_mode: bool,
    pub(crate) in_pvp_match: bool,
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
    let source_kind = classify_unit_type(source_flags, source_guid).map(str::to_string);
    let target_kind = classify_unit_type(dest_flags, dest_guid).map(str::to_string);

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

fn should_ignore_unconscious_death(parsed_line: &ParsedLogLine) -> bool {
    if parsed_line.normalized_event_type != "UNIT_DIED" {
        return false;
    }

    matches!(
        extract_unconscious_on_death(&parsed_line.fields),
        Some(true)
    )
}

fn extract_unconscious_on_death(fields: &[String]) -> Option<bool> {
    if fields.len() <= 8 {
        return None;
    }

    let extra_count = fields.len().saturating_sub(8);
    let candidate = match extra_count {
        1 => fields.get(8),
        2 => fields.get(9),
        _ => None,
    }?;

    parse_unconscious_flag(candidate)
}

fn parse_unconscious_flag(value: &str) -> Option<bool> {
    let trimmed = value.trim().trim_matches('"');
    if trimmed.is_empty() || trimmed == "nil" {
        return None;
    }

    match trimmed.to_ascii_lowercase().as_str() {
        "1" | "true" => Some(true),
        "0" | "false" => Some(false),
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

pub(crate) fn is_context_only_event(raw_event_type: &str) -> bool {
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

fn classify_unit_type(unit_flags: Option<&str>, unit_guid: Option<&str>) -> Option<&'static str> {
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

pub(crate) fn extract_raw_event_type_from_line(line: &str) -> Option<&str> {
    let header = line.trim().split(',').next()?.trim();
    extract_event_type(header)
}

pub(crate) fn should_reset_player_roster_for_event(raw_event_type: &str) -> bool {
    matches!(
        raw_event_type,
        "ENCOUNTER_START"
            | "CHALLENGE_MODE_START"
            | "ARENA_MATCH_START"
            | "PVP_MATCH_START"
            | "BATTLEGROUND_START"
    )
}

pub(crate) fn extract_log_timestamp(header: &str) -> String {
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
pub(crate) struct LogTimestamp {
    pub(crate) month: u32,
    pub(crate) day: u32,
    pub(crate) hour: u32,
    pub(crate) minute: u32,
    pub(crate) second: u32,
    pub(crate) fractional_seconds: f64,
}

impl LogTimestamp {
    pub(crate) fn parse(value: &str) -> Option<Self> {
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
    pub(crate) fn to_seconds_since_midnight(&self) -> f64 {
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

pub(crate) fn normalize_name(name: Option<&str>) -> Option<String> {
    let value = name?.trim();
    if value.is_empty() || value == "nil" {
        return None;
    }

    let normalized = value.trim_matches('"').trim();
    if normalized.is_empty() {
        return None;
    }

    Some(normalized.to_string())
}

pub(crate) fn parse_player_identities_from_log_line(
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
    if classify_unit_type(raw_flags, Some(guid.as_str())) != Some("PLAYER") {
        return None;
    }

    let name = normalize_entity_name(raw_name, Some("PLAYER"));
    Some(PlayerIdentity { guid, name })
}

pub(crate) fn parse_combatant_info_snapshot(line: &str) -> Option<CombatantInfoSnapshot> {
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
