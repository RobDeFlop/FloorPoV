mod metadata;
pub(crate) mod parse;
pub(crate) mod watch;

use serde::Serialize;
use std::collections::BTreeMap;

const MAX_DEBUG_EVENTS: usize = 2_000;
const MAX_PERSISTED_HIGH_VOLUME_EVENTS: usize = 20_000;
const EVENT_MANUAL_MARKER: &str = "MANUAL_MARKER";
const EVENT_ENCOUNTER_START: &str = "ENCOUNTER_START";
const EVENT_ENCOUNTER_END: &str = "ENCOUNTER_END";

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

#[cfg(test)]
mod tests;
