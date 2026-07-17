use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use super::parse::{parse_important_log_line, DebugParseContext};
use super::{ParseCombatLogDebugResult, ParsedCombatEvent, MAX_DEBUG_EVENTS};

#[tauri::command]
pub(crate) fn parse_combat_log_file(
    file_path: String,
) -> Result<ParseCombatLogDebugResult, String> {
    if !cfg!(debug_assertions) {
        return Err("Combat log debug parsing is only available in debug builds".to_string());
    }

    if file_path.trim().is_empty() {
        return Err("Combat log file path is required".to_string());
    }

    let path = Path::new(&file_path);
    if !path.is_file() {
        return Err(format!("Combat log file not found: {file_path}"));
    }

    let file_size_bytes = std::fs::metadata(path)
        .map_err(|error| error.to_string())?
        .len();
    let reader = BufReader::new(File::open(path).map_err(|error| error.to_string())?);

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
