use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const RECORDING_METADATA_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingEncounterMetadata {
    pub name: String,
    pub category: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingImportantEventMetadata {
    pub timestamp_seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_timestamp: Option<String>,
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zone_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encounter_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encounter_category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_level: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingPlayerMetadata {
    pub guid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spec_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spec_id: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingMetadata {
    pub schema_version: u32,
    pub recording_file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zone_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encounter_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encounter_category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_level: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub encounters: Vec<RecordingEncounterMetadata>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub important_events: Vec<RecordingImportantEventMetadata>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub important_event_counts: BTreeMap<String, u64>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub important_events_dropped_count: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub players: Vec<RecordingPlayerMetadata>,
    pub captured_at_unix: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct RecordingEncounterSnapshot {
    pub(crate) name: String,
    pub(crate) category: String,
    pub(crate) started_at_seconds: f64,
    pub(crate) ended_at_seconds: Option<f64>,
}

#[derive(Debug, Clone)]
pub(crate) struct RecordingMetadataSnapshot {
    pub(crate) zone_name: Option<String>,
    pub(crate) encounter_name: Option<String>,
    pub(crate) encounter_category: Option<String>,
    pub(crate) key_level: Option<u32>,
    pub(crate) encounters: Vec<RecordingEncounterSnapshot>,
    pub(crate) important_events: Vec<RecordingImportantEventMetadata>,
    pub(crate) important_event_counts: BTreeMap<String, u64>,
    pub(crate) important_events_dropped_count: u64,
    pub(crate) players: Vec<RecordingPlayerMetadata>,
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}

impl RecordingMetadata {
    pub(crate) fn new(recording_path: &Path) -> Self {
        let recording_file = recording_path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| recording_path.to_string_lossy().to_string());

        let captured_at_unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);

        Self {
            schema_version: RECORDING_METADATA_SCHEMA_VERSION,
            recording_file,
            zone_name: None,
            encounter_name: None,
            encounter_category: None,
            key_level: None,
            encounters: Vec::new(),
            important_events: Vec::new(),
            important_event_counts: BTreeMap::new(),
            important_events_dropped_count: 0,
            players: Vec::new(),
            captured_at_unix,
        }
    }

    pub(crate) fn apply_combat_log_snapshot(&mut self, snapshot: RecordingMetadataSnapshot) {
        self.zone_name = snapshot.zone_name;
        self.encounter_name = snapshot.encounter_name;
        self.encounter_category = snapshot.encounter_category;
        self.key_level = snapshot.key_level;
        self.encounters = snapshot
            .encounters
            .into_iter()
            .map(|encounter| RecordingEncounterMetadata {
                name: encounter.name,
                category: encounter.category,
                started_at_seconds: Some(encounter.started_at_seconds),
                ended_at_seconds: encounter.ended_at_seconds,
            })
            .collect();
        self.important_events = snapshot.important_events;
        self.important_event_counts = snapshot.important_event_counts;
        self.important_events_dropped_count = snapshot.important_events_dropped_count;
        self.players = snapshot.players;
    }
}

impl RecordingMetadataSnapshot {
    pub(crate) fn has_content(&self) -> bool {
        self.zone_name.is_some()
            || self.encounter_name.is_some()
            || self.encounter_category.is_some()
            || self.key_level.is_some()
            || !self.encounters.is_empty()
            || !self.important_events.is_empty()
            || !self.important_event_counts.is_empty()
            || self.important_events_dropped_count > 0
            || !self.players.is_empty()
    }
}

pub(crate) fn metadata_sidecar_path(recording_path: &Path) -> PathBuf {
    recording_path.with_extension("meta.json")
}

pub(crate) fn read_recording_metadata(
    recording_path: &Path,
) -> Result<Option<RecordingMetadata>, String> {
    let sidecar_path = metadata_sidecar_path(recording_path);
    let raw_json = match std::fs::read_to_string(&sidecar_path) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Failed to read recording metadata '{}': {error}",
                sidecar_path.display()
            ));
        }
    };

    let metadata = serde_json::from_str::<RecordingMetadata>(&raw_json).map_err(|error| {
        format!(
            "Failed to parse recording metadata '{}': {error}",
            sidecar_path.display()
        )
    })?;

    Ok(Some(metadata))
}

pub(crate) fn write_recording_metadata(
    recording_path: &Path,
    metadata: &RecordingMetadata,
) -> Result<PathBuf, String> {
    let sidecar_path = metadata_sidecar_path(recording_path);
    if let Some(parent_directory) = sidecar_path.parent() {
        std::fs::create_dir_all(parent_directory).map_err(|error| {
            format!(
                "Failed to create recording metadata directory '{}': {error}",
                parent_directory.display()
            )
        })?;
    }

    let temp_path = temporary_sidecar_path(&sidecar_path);
    let serialized = serde_json::to_string_pretty(metadata)
        .map_err(|error| format!("Failed to serialize recording metadata: {error}"))?;

    std::fs::write(&temp_path, serialized).map_err(|error| {
        format!(
            "Failed to write temporary recording metadata '{}': {error}",
            temp_path.display()
        )
    })?;

    if sidecar_path.exists() {
        std::fs::remove_file(&sidecar_path).map_err(|error| {
            format!(
                "Failed to replace existing recording metadata '{}': {error}",
                sidecar_path.display()
            )
        })?;
    }

    if let Err(error) = std::fs::rename(&temp_path, &sidecar_path) {
        let cleanup_error = std::fs::remove_file(&temp_path).err();
        if let Some(cleanup_error) = cleanup_error {
            return Err(format!(
                "Failed to finalize recording metadata '{}': {error}; temporary cleanup failed '{}': {cleanup_error}",
                sidecar_path.display(),
                temp_path.display()
            ));
        }

        return Err(format!(
            "Failed to finalize recording metadata '{}': {error}",
            sidecar_path.display()
        ));
    }

    Ok(sidecar_path)
}

pub(crate) fn delete_recording_metadata(recording_path: &Path) -> Result<(), String> {
    let sidecar_path = metadata_sidecar_path(recording_path);
    match std::fs::remove_file(&sidecar_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to delete recording metadata '{}': {error}",
            sidecar_path.display()
        )),
    }
}

fn temporary_sidecar_path(sidecar_path: &Path) -> PathBuf {
    let Some(file_name) = sidecar_path.file_name().and_then(|value| value.to_str()) else {
        return sidecar_path.with_extension("meta.json.tmp");
    };

    sidecar_path.with_file_name(format!("{file_name}.tmp"))
}

#[cfg(test)]
mod tests {
    use super::{
        delete_recording_metadata, metadata_sidecar_path, read_recording_metadata,
        write_recording_metadata, RecordingImportantEventMetadata, RecordingMetadata,
    };
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_directory() -> std::path::PathBuf {
        let timestamp_nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let process_id = std::process::id();
        std::env::temp_dir().join(format!(
            "floorpov_metadata_test_{process_id}_{timestamp_nanos}"
        ))
    }

    #[test]
    fn derives_sidecar_path_from_recording_path() {
        let recording_path = Path::new(r"C:\Recordings\capture.mp4");
        let sidecar_path = metadata_sidecar_path(recording_path);

        assert_eq!(
            sidecar_path.to_string_lossy(),
            r"C:\Recordings\capture.meta.json"
        );
    }

    #[test]
    fn writes_reads_and_deletes_recording_metadata() {
        let temp_directory = unique_temp_directory();
        std::fs::create_dir_all(&temp_directory)
            .expect("Failed to create temporary metadata test directory");

        let recording_path = temp_directory.join("screen_recording_20260222_153012.mp4");
        std::fs::write(&recording_path, b"test")
            .expect("Failed to create test recording file for metadata roundtrip");

        let mut metadata = RecordingMetadata::new(&recording_path);
        metadata.zone_name = Some("Nerub-ar Palace".to_string());
        metadata.encounter_name = Some("Queen Ansurek".to_string());
        metadata.encounter_category = Some("raid".to_string());
        metadata.key_level = Some(12);

        write_recording_metadata(&recording_path, &metadata)
            .expect("Expected metadata write to succeed");

        let loaded_metadata = read_recording_metadata(&recording_path)
            .expect("Expected metadata read to succeed")
            .expect("Expected metadata sidecar to exist");

        assert_eq!(loaded_metadata.zone_name, metadata.zone_name);
        assert_eq!(loaded_metadata.encounter_name, metadata.encounter_name);
        assert_eq!(
            loaded_metadata.encounter_category,
            metadata.encounter_category
        );
        assert_eq!(loaded_metadata.key_level, metadata.key_level);
        assert_eq!(
            loaded_metadata.important_events_dropped_count,
            metadata.important_events_dropped_count
        );

        delete_recording_metadata(&recording_path).expect("Expected metadata delete to succeed");
        let sidecar_path = metadata_sidecar_path(&recording_path);
        assert!(!sidecar_path.exists());

        std::fs::remove_file(&recording_path).expect("Failed to remove test recording file");
        std::fs::remove_dir_all(&temp_directory)
            .expect("Failed to remove temporary metadata test directory");
    }

    #[test]
    fn roundtrips_important_events_and_counts() {
        let temp_directory = unique_temp_directory();
        std::fs::create_dir_all(&temp_directory)
            .expect("Failed to create temporary metadata test directory");

        let recording_path = temp_directory.join("screen_recording_20260222_153013.mp4");
        std::fs::write(&recording_path, b"test")
            .expect("Failed to create test recording file for metadata roundtrip");

        let mut metadata = RecordingMetadata::new(&recording_path);
        metadata
            .important_events
            .push(RecordingImportantEventMetadata {
                timestamp_seconds: 12.5,
                log_timestamp: Some("2/22 20:15:11.000".to_string()),
                event_type: "SPELL_INTERRUPT".to_string(),
                source: Some("PlayerOne".to_string()),
                target: Some("Boss".to_string()),
                target_kind: Some("NPC".to_string()),
                zone_name: Some("Test Zone".to_string()),
                encounter_name: Some("Test Encounter".to_string()),
                encounter_category: Some("raid".to_string()),
                key_level: None,
            });
        metadata
            .important_event_counts
            .insert("SPELL_INTERRUPT".to_string(), 42);
        metadata.important_events_dropped_count = 5;

        write_recording_metadata(&recording_path, &metadata)
            .expect("Expected metadata write to succeed");

        let loaded_metadata = read_recording_metadata(&recording_path)
            .expect("Expected metadata read to succeed")
            .expect("Expected metadata sidecar to exist");

        assert_eq!(loaded_metadata.important_events.len(), 1);
        assert_eq!(
            loaded_metadata
                .important_event_counts
                .get("SPELL_INTERRUPT")
                .copied(),
            Some(42)
        );
        assert_eq!(loaded_metadata.important_events_dropped_count, 5);

        delete_recording_metadata(&recording_path).expect("Expected metadata delete to succeed");
        let sidecar_path = metadata_sidecar_path(&recording_path);
        assert!(!sidecar_path.exists());

        std::fs::remove_file(&recording_path).expect("Failed to remove test recording file");
        std::fs::remove_dir_all(&temp_directory)
            .expect("Failed to remove temporary metadata test directory");
    }
}
