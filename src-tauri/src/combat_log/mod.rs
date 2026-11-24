pub(crate) mod debug;
pub(crate) mod import;
pub(crate) mod metadata;
pub(crate) mod parse;
pub(crate) mod watch;

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const MAX_DEBUG_EVENTS: usize = 2_000;
const MAX_PERSISTED_HIGH_VOLUME_EVENTS: usize = 20_000;
const EVENT_MANUAL_MARKER: &str = "MANUAL_MARKER";
const EVENT_ENCOUNTER_START: &str = "ENCOUNTER_START";
const EVENT_ENCOUNTER_END: &str = "ENCOUNTER_END";

pub(crate) fn build_combat_log_directory_path(wow_folder: &str) -> PathBuf {
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

pub(crate) fn is_combat_log_file_name(file_name: &str) -> bool {
    let lower_file_name = file_name.to_ascii_lowercase();
    lower_file_name.starts_with("wowcombatlog") && lower_file_name.ends_with(".txt")
}

pub(crate) fn find_latest_combat_log_path(wow_folder: &str) -> Result<Option<PathBuf>, String> {
    let logs_directory = build_combat_log_directory_path(wow_folder);
    find_latest_combat_log_in_directory(&logs_directory)
}

pub(crate) fn find_latest_combat_log_in_directory(
    logs_directory: &Path,
) -> Result<Option<PathBuf>, String> {
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CombatEvent {
    pub timestamp: f64,
    pub event_type: String,
    pub source: Option<String>,
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_spell_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<u64>,
    pub ability_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
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
    pub ability_name: Option<String>,
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
