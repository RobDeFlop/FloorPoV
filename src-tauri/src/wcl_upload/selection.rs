use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use crate::combat_log::parse::extract_raw_event_type_from_line;
use crate::wcl_upload::types::{ParserFight, WclActivity, WclActivityGroup};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActivityKind {
    Raid,
    MythicPlus,
    Pvp,
    Other,
}

impl ActivityKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Raid => "raid",
            Self::MythicPlus => "mythicPlus",
            Self::Pvp => "pvp",
            Self::Other => "other",
        }
    }
}

#[derive(Debug)]
struct ActivityWindow {
    kind: ActivityKind,
    fights: Vec<ParserFight>,
    raw_activity: Option<RawActivity>,
}

#[derive(Debug, Clone)]
pub(crate) struct RawActivity {
    id: usize,
    kind: ActivityKind,
    title: Option<String>,
    status: String,
    difficulty: Option<i64>,
    key_level: Option<u32>,
}

#[derive(Debug)]
struct OpenRawActivity {
    id: usize,
    kind: ActivityKind,
    title: Option<String>,
    difficulty: Option<i64>,
    key_level: Option<u32>,
}

#[derive(Debug, Default)]
pub(crate) struct RawActivityTracker {
    activities: Vec<RawActivity>,
    open_activity: Option<OpenRawActivity>,
    next_activity_id: usize,
}

impl RawActivityTracker {
    pub(crate) fn observe_line(&mut self, line: &str) {
        let Some(event_type) = extract_raw_event_type_from_line(line) else {
            return;
        };
        let fields = raw_event_fields(line);

        match event_type {
            "CHALLENGE_MODE_START" => {
                self.close_open_activity("incomplete");
                self.open_activity = Some(OpenRawActivity {
                    id: self.take_activity_id(),
                    kind: ActivityKind::MythicPlus,
                    title: fields.first().and_then(|value| non_empty(value)),
                    difficulty: None,
                    key_level: fields.get(3).and_then(|value| value.parse::<u32>().ok()),
                });
            }
            "CHALLENGE_MODE_END" => {
                let status = if fields.get(1).is_some_and(|value| value == "1") {
                    "complete"
                } else {
                    "incomplete"
                };
                self.close_matching_activity(ActivityKind::MythicPlus, status);
            }
            "ARENA_MATCH_START" | "PVP_MATCH_START" | "BATTLEGROUND_START" => {
                self.close_open_activity("incomplete");
                self.open_activity = Some(OpenRawActivity {
                    id: self.take_activity_id(),
                    kind: ActivityKind::Pvp,
                    title: None,
                    difficulty: None,
                    key_level: None,
                });
            }
            "ARENA_MATCH_END" | "PVP_MATCH_COMPLETE" | "BATTLEGROUND_END" => {
                self.close_matching_activity(ActivityKind::Pvp, "complete");
            }
            "ENCOUNTER_START" => {
                if self.open_activity.as_ref().is_some_and(|activity| {
                    matches!(activity.kind, ActivityKind::MythicPlus | ActivityKind::Pvp)
                }) {
                    return;
                }
                self.close_open_activity("incomplete");
                self.open_activity = Some(OpenRawActivity {
                    id: self.take_activity_id(),
                    kind: ActivityKind::Raid,
                    title: fields.get(1).and_then(|value| non_empty(value)),
                    difficulty: fields.get(2).and_then(|value| value.parse::<i64>().ok()),
                    key_level: None,
                });
            }
            "ENCOUNTER_END" => {
                let status = if fields.get(4).is_some_and(|value| value == "1") {
                    "kill"
                } else {
                    "wipe"
                };
                self.close_matching_activity(ActivityKind::Raid, status);
            }
            _ => {}
        }
    }

    pub(crate) fn finish(mut self) -> Vec<RawActivity> {
        if let Some(open_activity) = self.open_activity.take() {
            self.activities.push(RawActivity {
                id: open_activity.id,
                kind: open_activity.kind,
                title: open_activity.title,
                status: "incomplete".to_string(),
                difficulty: open_activity.difficulty,
                key_level: open_activity.key_level,
            });
        }
        self.activities
    }

    pub(crate) fn active_activity_id(&self) -> Option<usize> {
        self.open_activity.as_ref().map(|activity| activity.id)
    }

    fn take_activity_id(&mut self) -> usize {
        let id = self.next_activity_id;
        self.next_activity_id += 1;
        id
    }

    fn close_matching_activity(&mut self, kind: ActivityKind, status: &str) {
        if self
            .open_activity
            .as_ref()
            .is_some_and(|activity| activity.kind == kind)
        {
            self.close_open_activity(status);
        }
    }

    fn close_open_activity(&mut self, status: &str) {
        let Some(open_activity) = self.open_activity.take() else {
            return;
        };
        self.activities.push(RawActivity {
            id: open_activity.id,
            kind: open_activity.kind,
            title: open_activity.title,
            status: status.to_string(),
            difficulty: open_activity.difficulty,
            key_level: open_activity.key_level,
        });
    }
}

pub(crate) fn starts_activity_boundary(line: &str) -> bool {
    extract_raw_event_type_from_line(line).is_some_and(|event_type| {
        matches!(
            event_type,
            "CHALLENGE_MODE_START"
                | "ENCOUNTER_START"
                | "ARENA_MATCH_START"
                | "PVP_MATCH_START"
                | "BATTLEGROUND_START"
        )
    })
}

pub(crate) fn ends_activity_boundary(line: &str) -> bool {
    extract_raw_event_type_from_line(line).is_some_and(|event_type| {
        matches!(
            event_type,
            "CHALLENGE_MODE_END"
                | "ENCOUNTER_END"
                | "ARENA_MATCH_END"
                | "PVP_MATCH_COMPLETE"
                | "BATTLEGROUND_END"
        )
    })
}

pub(crate) fn fight_selection_key(fight: &ParserFight) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    fight.event_count.hash(&mut hasher);
    fight.events_string.hash(&mut hasher);
    fight.start_time.hash(&mut hasher);
    fight.end_time.hash(&mut hasher);
    fight.encounter_id.hash(&mut hasher);
    fight.encounter_name.hash(&mut hasher);
    fight.enemy_npc_id.hash(&mut hasher);
    fight.enemy_id.hash(&mut hasher);
    fight.difficulty.hash(&mut hasher);
    fight.zone_id.hash(&mut hasher);
    format!("fight-{:016x}", hasher.finish())
}

pub(crate) fn record_fight_activity(
    fights: &[ParserFight],
    activity_id: Option<usize>,
    activity_by_fight: &mut HashMap<String, usize>,
) {
    let Some(activity_id) = activity_id else {
        return;
    };
    for fight in fights {
        activity_by_fight.insert(fight_selection_key(fight), activity_id);
    }
}

pub(crate) fn build_activity_groups(
    fights: &[ParserFight],
    raw_activities: &[RawActivity],
    activity_by_fight: &HashMap<String, usize>,
) -> (Vec<WclActivityGroup>, HashMap<String, Vec<String>>) {
    let windows = build_activity_windows(fights, raw_activities, activity_by_fight);
    let mut groups = Vec::<WclActivityGroup>::new();
    let mut group_indexes = HashMap::<String, usize>::new();
    let mut activity_fight_keys = HashMap::<String, Vec<String>>::new();
    let mut occurrence_by_group = HashMap::<String, usize>::new();

    for (window_index, window) in windows.into_iter().enumerate() {
        let kind = window.kind;
        let group_key = group_key(&window);
        let group_index = if let Some(index) = group_indexes.get(&group_key) {
            *index
        } else {
            let index = groups.len();
            groups.push(WclActivityGroup {
                id: format!("group-{index}"),
                kind: kind.as_str().to_string(),
                title: group_title(&window),
                subtitle: group_subtitle(&window),
                activities: Vec::new(),
            });
            group_indexes.insert(group_key.clone(), index);
            index
        };

        let occurrence = occurrence_by_group.entry(group_key).or_insert(0);
        *occurrence += 1;
        let activity_id = format!("activity-{window_index}");
        let keys = window
            .fights
            .iter()
            .map(fight_selection_key)
            .collect::<Vec<_>>();
        let activity = build_activity(&window, &activity_id, *occurrence);
        activity_fight_keys.insert(activity_id, keys);
        groups[group_index].activities.push(activity);
    }

    (groups, activity_fight_keys)
}

fn build_activity(window: &ActivityWindow, activity_id: &str, occurrence: usize) -> WclActivity {
    let kind = window.kind;
    let fights = &window.fights;
    let started_at = fights.iter().filter_map(|fight| fight.start_time).min();
    let ended_at = fights.iter().filter_map(|fight| fight.end_time).max();
    let duration_ms = match (started_at, ended_at) {
        (Some(start), Some(end)) if end >= start => Some(end - start),
        _ => None,
    };
    let incomplete = !has_end_marker(kind, fights);
    let status = window.raw_activity.as_ref().map_or_else(
        || match kind {
            ActivityKind::Raid => raid_status(fights)
                .unwrap_or_else(|| if incomplete { "incomplete" } else { "unknown" }.to_string()),
            ActivityKind::MythicPlus | ActivityKind::Pvp => {
                if incomplete {
                    "incomplete".to_string()
                } else {
                    "complete".to_string()
                }
            }
            ActivityKind::Other => "unknown".to_string(),
        },
        |activity| activity.status.clone(),
    );

    let title = match kind {
        ActivityKind::Raid => format!("Pull {occurrence}"),
        ActivityKind::MythicPlus => format!("Run {occurrence}"),
        ActivityKind::Pvp => format!("Match {occurrence}"),
        ActivityKind::Other => format!("Fight {occurrence}"),
    };
    let subtitle = match kind {
        ActivityKind::Raid => fights
            .first()
            .and_then(|fight| fight.encounter_name.clone()),
        ActivityKind::MythicPlus => window
            .raw_activity
            .as_ref()
            .and_then(|activity| activity.key_level)
            .or_else(|| extract_key_level(fights))
            .map(|level| format!("Keystone +{level}")),
        ActivityKind::Pvp => fights.first().and_then(|fight| fight.zone_name.clone()),
        ActivityKind::Other => fights
            .first()
            .and_then(|fight| fight.encounter_name.clone()),
    };

    WclActivity {
        id: activity_id.to_string(),
        kind: kind.as_str().to_string(),
        title,
        subtitle,
        started_at,
        ended_at,
        duration_ms,
        status,
        difficulty: window
            .raw_activity
            .as_ref()
            .and_then(|activity| activity.difficulty)
            .or_else(|| fights.iter().find_map(|fight| fight.difficulty)),
        key_level: window
            .raw_activity
            .as_ref()
            .and_then(|activity| activity.key_level)
            .or_else(|| extract_key_level(fights)),
        fight_count: fights.len(),
    }
}

fn build_activity_windows(
    fights: &[ParserFight],
    raw_activities: &[RawActivity],
    activity_by_fight: &HashMap<String, usize>,
) -> Vec<ActivityWindow> {
    let assignments = fights
        .iter()
        .map(|fight| {
            let activity_id = activity_by_fight.get(&fight_selection_key(fight))?;
            raw_activities
                .iter()
                .position(|activity| activity.id == *activity_id)
        })
        .collect::<Vec<_>>();
    let mut windows = Vec::new();
    for (activity_index, raw_activity) in raw_activities.iter().enumerate() {
        let activity_fights = fights
            .iter()
            .zip(&assignments)
            .filter(|(_, assigned_index)| **assigned_index == Some(activity_index))
            .map(|(fight, _)| fight.clone())
            .collect::<Vec<_>>();
        if !activity_fights.is_empty() {
            windows.push(ActivityWindow {
                kind: raw_activity.kind,
                fights: activity_fights,
                raw_activity: Some(raw_activity.clone()),
            });
        }
    }

    let unassigned_fights = fights
        .iter()
        .zip(assignments)
        .filter(|(_, assigned_index)| assigned_index.is_none())
        .map(|(fight, _)| fight.clone())
        .collect::<Vec<_>>();
    windows.extend(build_marker_activity_windows(&unassigned_fights));
    windows.sort_by_key(|window| {
        window
            .fights
            .iter()
            .filter_map(|fight| fight.start_time)
            .min()
            .unwrap_or(i64::MAX)
    });
    windows
}

fn build_marker_activity_windows(fights: &[ParserFight]) -> Vec<ActivityWindow> {
    let mut windows = Vec::new();
    let mut open_window: Option<ActivityWindow> = None;

    for fight in fights {
        let has_mythic_start = contains_event(fight, "CHALLENGE_MODE_START");
        let has_mythic_end = contains_event(fight, "CHALLENGE_MODE_END");
        let has_pvp_start = contains_any_event(
            fight,
            &["ARENA_MATCH_START", "PVP_MATCH_START", "BATTLEGROUND_START"],
        );
        let has_pvp_end = contains_any_event(
            fight,
            &["ARENA_MATCH_END", "PVP_MATCH_COMPLETE", "BATTLEGROUND_END"],
        );

        let starts_same_mode = open_window
            .as_ref()
            .is_some_and(|window| match window.kind {
                ActivityKind::MythicPlus => has_mythic_start,
                ActivityKind::Pvp => has_pvp_start,
                _ => false,
            });
        if starts_same_mode {
            windows.push(open_window.take().expect("open activity window"));
        }

        if let Some(window) = open_window.as_mut() {
            let closes = match window.kind {
                ActivityKind::MythicPlus => has_mythic_end,
                ActivityKind::Pvp => has_pvp_end,
                _ => false,
            };
            window.fights.push(fight.clone());
            if closes {
                windows.push(open_window.take().expect("open activity window"));
            }
            continue;
        }

        if has_mythic_start {
            let window = ActivityWindow {
                kind: ActivityKind::MythicPlus,
                fights: vec![fight.clone()],
                raw_activity: None,
            };
            if has_mythic_end {
                windows.push(window);
            } else {
                open_window = Some(window);
            }
            continue;
        }

        if has_pvp_start {
            let window = ActivityWindow {
                kind: ActivityKind::Pvp,
                fights: vec![fight.clone()],
                raw_activity: None,
            };
            if has_pvp_end {
                windows.push(window);
            } else {
                open_window = Some(window);
            }
            continue;
        }

        if is_raid_fight(fight) {
            windows.push(ActivityWindow {
                kind: ActivityKind::Raid,
                fights: vec![fight.clone()],
                raw_activity: None,
            });
        } else {
            windows.push(ActivityWindow {
                kind: ActivityKind::Other,
                fights: vec![fight.clone()],
                raw_activity: None,
            });
        }
    }

    if let Some(window) = open_window {
        windows.push(window);
    }

    windows
}

fn is_raid_fight(fight: &ParserFight) -> bool {
    contains_event(fight, "ENCOUNTER_START")
        || (fight.is_trash != Some(true)
            && fight.encounter_name.as_deref().is_some_and(|name| {
                !name.trim().is_empty() && !name.eq_ignore_ascii_case("Unknown")
            }))
}

fn raw_event_fields(line: &str) -> Vec<String> {
    line.split(',')
        .skip(1)
        .map(|value| value.trim().trim_matches('"').to_string())
        .collect()
}

fn non_empty(value: &str) -> Option<String> {
    (!value.trim().is_empty()).then(|| value.trim().to_string())
}

fn group_key(window: &ActivityWindow) -> String {
    let kind = window.kind;
    let fight = window.fights.first();
    if let Some(title) = window
        .raw_activity
        .as_ref()
        .and_then(|activity| activity.title.as_deref())
    {
        return format!(
            "{}:{title}:{}",
            kind.as_str(),
            window
                .raw_activity
                .as_ref()
                .and_then(|activity| activity.difficulty)
                .unwrap_or_default()
        );
    }
    let Some(fight) = fight else {
        return format!("{}:unknown", kind.as_str());
    };

    match kind {
        ActivityKind::Raid => format!(
            "raid:{}:{}:{}",
            fight.zone_id.unwrap_or_default(),
            fight.encounter_name.as_deref().unwrap_or("Unknown"),
            fight.difficulty.unwrap_or_default()
        ),
        ActivityKind::MythicPlus => format!(
            "mythicPlus:{}:{}",
            fight.zone_id.unwrap_or_default(),
            fight.zone_name.as_deref().unwrap_or("Unknown")
        ),
        ActivityKind::Pvp => format!(
            "pvp:{}:{}",
            fight.zone_id.unwrap_or_default(),
            fight.zone_name.as_deref().unwrap_or("Unknown")
        ),
        ActivityKind::Other => "other".to_string(),
    }
}

fn group_title(window: &ActivityWindow) -> String {
    if let Some(title) = window
        .raw_activity
        .as_ref()
        .and_then(|activity| activity.title.clone())
    {
        return title;
    }
    let kind = window.kind;
    let fight = window.fights.first();
    match kind {
        ActivityKind::Raid => fight
            .and_then(|fight| fight.encounter_name.clone())
            .unwrap_or_else(|| "Raid Encounter".to_string()),
        ActivityKind::MythicPlus => fight
            .and_then(|fight| fight.zone_name.clone())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "Mythic+ Dungeon".to_string()),
        ActivityKind::Pvp => fight
            .and_then(|fight| fight.zone_name.clone())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "PvP".to_string()),
        ActivityKind::Other => "Other Fights".to_string(),
    }
}

fn group_subtitle(window: &ActivityWindow) -> Option<String> {
    let kind = window.kind;
    let fight = window.fights.first();
    match kind {
        ActivityKind::Raid => window
            .raw_activity
            .as_ref()
            .and_then(|activity| activity.difficulty)
            .or_else(|| fight.and_then(|fight| fight.difficulty))
            .map(|difficulty| format!("Difficulty {difficulty}")),
        ActivityKind::MythicPlus | ActivityKind::Pvp | ActivityKind::Other => None,
    }
}

fn has_end_marker(kind: ActivityKind, fights: &[ParserFight]) -> bool {
    match kind {
        ActivityKind::Raid => fights
            .iter()
            .any(|fight| contains_event(fight, "ENCOUNTER_END")),
        ActivityKind::MythicPlus => fights
            .iter()
            .any(|fight| contains_event(fight, "CHALLENGE_MODE_END")),
        ActivityKind::Pvp => fights.iter().any(|fight| {
            contains_any_event(
                fight,
                &["ARENA_MATCH_END", "PVP_MATCH_COMPLETE", "BATTLEGROUND_END"],
            )
        }),
        ActivityKind::Other => true,
    }
}

fn raid_status(fights: &[ParserFight]) -> Option<String> {
    let end_line = fights
        .iter()
        .flat_map(|fight| fight.events_string.lines())
        .find(|line| line.contains("ENCOUNTER_END"))?;
    let success = end_line
        .split(',')
        .rev()
        .find_map(|value| value.trim().trim_matches('"').parse::<u8>().ok())?;
    Some(if success == 1 {
        "kill".to_string()
    } else {
        "wipe".to_string()
    })
}

fn extract_key_level(fights: &[ParserFight]) -> Option<u32> {
    fights
        .iter()
        .flat_map(|fight| fight.events_string.lines())
        .filter(|line| line.contains("CHALLENGE_MODE_START"))
        .flat_map(|line| line.split(','))
        .filter_map(|value| {
            value
                .trim()
                .trim_matches('"')
                .parse::<u32>()
                .ok()
                .filter(|level| (1..=40).contains(level))
        })
        .next_back()
}

fn contains_event(fight: &ParserFight, event: &str) -> bool {
    fight.events_string.contains(event)
}

fn contains_any_event(fight: &ParserFight, events: &[&str]) -> bool {
    events.iter().any(|event| contains_event(fight, event))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{build_activity_groups, record_fight_activity, ActivityKind, RawActivityTracker};
    use crate::wcl_upload::types::ParserFight;

    fn fight(
        events: &str,
        name: Option<&str>,
        zone: Option<&str>,
        start: i64,
        end: i64,
    ) -> ParserFight {
        ParserFight {
            event_count: 1,
            events_string: events.to_string(),
            boss_percentage: None,
            encounter_id: name.map(|_| 42),
            encounter_name: name.map(str::to_string),
            start_time: Some(start),
            end_time: Some(end),
            is_trash: Some(false),
            enemy_npc_id: None,
            enemy_id: None,
            difficulty: Some(16),
            zone_id: Some(1),
            zone_name: zone.map(str::to_string),
        }
    }

    #[test]
    fn groups_whole_mythic_run_and_repeated_raid_pulls() {
        let fights = vec![
            fight(
                "CHALLENGE_MODE_START,1,14",
                None,
                Some("The Dawning Halls"),
                0,
                100,
            ),
            fight(
                "ENCOUNTER_START",
                Some("Boss One"),
                Some("The Dawning Halls"),
                100,
                200,
            ),
            fight(
                "CHALLENGE_MODE_END",
                None,
                Some("The Dawning Halls"),
                200,
                300,
            ),
            fight(
                "ENCOUNTER_START\nENCOUNTER_END,1",
                Some("Queen"),
                Some("Raid"),
                400,
                500,
            ),
            fight(
                "ENCOUNTER_START\nENCOUNTER_END,0",
                Some("Queen"),
                Some("Raid"),
                600,
                700,
            ),
        ];

        let (groups, keys) = build_activity_groups(&fights, &[], &HashMap::new());

        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].kind, "mythicPlus");
        assert_eq!(groups[0].activities.len(), 1);
        assert_eq!(groups[0].activities[0].key_level, Some(14));
        assert_eq!(groups[1].kind, "raid");
        assert_eq!(groups[1].activities.len(), 2);
        assert_eq!(groups[1].activities[0].status, "kill");
        assert_eq!(groups[1].activities[1].status, "wipe");
        assert_eq!(keys.len(), 3);
    }

    #[test]
    fn marks_open_activity_incomplete_at_end_of_file() {
        let fights = vec![fight(
            "PVP_MATCH_START",
            None,
            Some("Warsong Gulch"),
            0,
            100,
        )];

        let (groups, _) = build_activity_groups(&fights, &[], &HashMap::new());

        assert_eq!(groups[0].kind, "pvp");
        assert_eq!(groups[0].activities[0].status, "incomplete");
    }

    #[test]
    fn classifies_wcl_encoded_fight_from_raw_mythic_plus_batch_context() {
        let mut tracker = RawActivityTracker::default();
        tracker.observe_line(
            "7/14/2026 21:46:23.8302  CHALLENGE_MODE_START,\"Windrunner Spire\",2805,557,10,[148,9,10]",
        );
        let fights = vec![fight(
            "0,SPELL_DAMAGE,Player-1,Creature-1,123",
            None,
            None,
            100,
            200,
        )];
        let mut activity_by_fight = HashMap::new();
        record_fight_activity(
            &fights,
            tracker.active_activity_id(),
            &mut activity_by_fight,
        );
        tracker.observe_line("7/14/2026 22:05:00.0002  CHALLENGE_MODE_END,2805,1,10,1116000,0,0");

        let (groups, _) = build_activity_groups(&fights, &tracker.finish(), &activity_by_fight);

        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].kind, "mythicPlus");
        assert_eq!(groups[0].title, "Windrunner Spire");
    }

    #[test]
    fn marks_failed_mythic_run_incomplete() {
        let mut tracker = RawActivityTracker::default();
        tracker.observe_line(
            "7/14/2026 21:46:23.8302  CHALLENGE_MODE_START,\"Windrunner Spire\",2805,557,10,[148,9,10]",
        );
        let fights = vec![fight("0,SPELL_DAMAGE", None, None, 100, 200)];
        let mut activity_by_fight = HashMap::new();
        record_fight_activity(
            &fights,
            tracker.active_activity_id(),
            &mut activity_by_fight,
        );
        tracker.observe_line(
            "7/14/2026 21:55:00.0002  CHALLENGE_MODE_END,2805,0,0,0,0.000000,0.000000",
        );

        let (groups, _) = build_activity_groups(&fights, &tracker.finish(), &activity_by_fight);

        assert_eq!(groups[0].activities[0].status, "incomplete");
    }

    #[test]
    fn keeps_dungeon_encounters_inside_the_mythic_plus_run() {
        let mut tracker = RawActivityTracker::default();
        for line in [
            "7/17/2026 18:12:00.8102  CHALLENGE_MODE_END,2811,0,0,0,0.000000,0.000000",
            "7/17/2026 18:12:01.1042  CHALLENGE_MODE_START,\"Magisters' Terrace\",2811,558,20,[10,9,147]",
            "7/17/2026 18:16:18.1282  ENCOUNTER_START,3071,\"Arcanotron Custos\",8,5,2811",
            "7/17/2026 18:19:19.9022  ENCOUNTER_END,3071,\"Arcanotron Custos\",8,5,1,181780",
            "7/17/2026 18:37:39.4782  CHALLENGE_MODE_END,2811,1,20,1529712,494.380310,3982.610596",
        ] {
            tracker.observe_line(line);
        }

        let activities = tracker.finish();

        assert_eq!(activities.len(), 1);
        assert_eq!(activities[0].kind, ActivityKind::MythicPlus);
        assert_eq!(activities[0].status, "complete");
    }
}
