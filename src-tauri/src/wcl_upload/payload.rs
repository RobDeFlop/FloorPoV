use std::io::{Cursor, Write};

use regex::Regex;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::wcl_upload::error::UploadError;
use crate::wcl_upload::types::{CollectFightsResponse, CollectMasterInfoResponse, ParserFight};

pub(crate) fn make_zip_payload(content: &str) -> Result<Vec<u8>, UploadError> {
    let mut buffer = Cursor::new(Vec::<u8>::new());
    let mut zip = ZipWriter::new(&mut buffer);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6));
    zip.start_file("log.txt", options)?;
    zip.write_all(content.as_bytes())?;
    zip.finish()?;
    Ok(buffer.into_inner())
}

pub(crate) fn build_master_table_string(
    master_info: &CollectMasterInfoResponse,
    log_version: i64,
    game_version: i64,
) -> String {
    let mut parts = vec![format!("{log_version}|{game_version}|")];

    append_master_table_part(
        &mut parts,
        master_info.last_assigned_actor_id,
        &master_info.actors_string,
    );
    append_master_table_part(
        &mut parts,
        master_info.last_assigned_ability_id,
        &master_info.abilities_string,
    );
    append_master_table_part(
        &mut parts,
        master_info.last_assigned_tuple_id,
        &master_info.tuples_string,
    );
    append_master_table_part(
        &mut parts,
        master_info.last_assigned_pet_id,
        &master_info.pets_string,
    );

    format!("{}\n", parts.join("\n"))
}

fn append_master_table_part(parts: &mut Vec<String>, id: i64, entries: &str) {
    parts.push(id.to_string());
    if !entries.is_empty() {
        parts.push(entries.trim_end_matches('\n').to_string());
    }
}

pub(crate) fn build_fights_string(fights_data: &CollectFightsResponse) -> String {
    let total_events: u64 = fights_data
        .fights
        .iter()
        .map(|fight| fight.event_count)
        .sum();
    let events_combined = fights_data
        .fights
        .iter()
        .map(|fight| fight.events_string.as_str())
        .collect::<String>();

    format!(
        "{}|{}\n{}\n{}",
        fights_data.log_version, fights_data.game_version, total_events, events_combined
    )
}

pub(crate) fn is_encounter_fight_candidate(fight: &ParserFight) -> bool {
    fight.events_string.contains("ENCOUNTER_START")
        || fight.encounter_id.unwrap_or(0) > 0
        || fight
            .encounter_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .is_some_and(|name| !name.eq_ignore_ascii_case("Unknown"))
        || fight.boss_percentage.is_some()
}

pub(crate) fn parse_start_date_from_filename(file_name: &str) -> Option<String> {
    let regex = Regex::new(r"WoWCombatLog-(\d{2})(\d{2})(\d{2})_").ok()?;
    let captures = regex.captures(file_name)?;

    let month = captures.get(1)?.as_str().parse::<u32>().ok()?;
    let day = captures.get(2)?.as_str().parse::<u32>().ok()?;
    let year_suffix = captures.get(3)?.as_str().parse::<u32>().ok()?;
    let year = 2000 + year_suffix;

    Some(format!("{month}/{day}/{year}"))
}

pub(crate) fn normalize_report_description(description: Option<&str>) -> String {
    description
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        is_encounter_fight_candidate, normalize_report_description, parse_start_date_from_filename,
    };
    use crate::wcl_upload::types::ParserFight;

    fn fight(
        events_string: &str,
        encounter_id: Option<i64>,
        encounter_name: Option<&str>,
        boss_percentage: Option<f64>,
    ) -> ParserFight {
        ParserFight {
            event_count: 1,
            events_string: events_string.to_string(),
            boss_percentage,
            encounter_id,
            encounter_name: encounter_name.map(str::to_string),
        }
    }

    #[test]
    fn normalizes_optional_description() {
        assert_eq!(normalize_report_description(None), "");
        assert_eq!(
            normalize_report_description(Some("  raid night  ")),
            "raid night"
        );
        assert_eq!(normalize_report_description(Some("   ")), "");
    }

    #[test]
    fn parses_wow_log_start_date() {
        assert_eq!(
            parse_start_date_from_filename("WoWCombatLog-071726_123456.txt"),
            Some("7/17/2026".to_string())
        );
        assert_eq!(parse_start_date_from_filename("combat-log.txt"), None);
    }

    #[test]
    fn recognizes_encounter_fights() {
        assert!(is_encounter_fight_candidate(&fight(
            "ENCOUNTER_START",
            None,
            None,
            None
        )));
        assert!(is_encounter_fight_candidate(&fight(
            "events",
            Some(42),
            None,
            None
        )));
        assert!(is_encounter_fight_candidate(&fight(
            "events",
            None,
            Some("Boss"),
            None
        )));
        assert!(is_encounter_fight_candidate(&fight(
            "events",
            None,
            None,
            Some(50.0)
        )));
        assert!(!is_encounter_fight_candidate(&fight(
            "events",
            None,
            Some("Unknown"),
            None
        )));
    }
}
