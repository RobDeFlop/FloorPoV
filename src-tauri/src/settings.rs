use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::recording::metadata as recording_metadata;

fn default_capture_source() -> String {
    "monitor".to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecordingSettings {
    pub video_quality: String,
    pub frame_rate: u32,
    pub bitrate: u32,
    #[serde(default = "default_capture_source")]
    pub capture_source: String,
    #[serde(default)]
    pub capture_window_hwnd: Option<String>,
    #[serde(default)]
    pub capture_window_title: Option<String>,
    pub enable_system_audio: bool,
    pub enable_recording_diagnostics: bool,
}

impl RecordingSettings {
    const REFERENCE_WIDTH: u32 = 1920;
    const REFERENCE_HEIGHT: u32 = 1080;
    const REFERENCE_FRAME_RATE: u32 = 30;

    fn bitrate_bounds_bps(quality: &str) -> (u32, u32) {
        match quality {
            "low" => (2_000_000, 8_000_000),
            "medium" => (4_000_000, 14_000_000),
            "high" => (6_000_000, 22_000_000),
            "ultra" => (10_000_000, 35_000_000),
            _ => (6_000_000, 22_000_000),
        }
    }

    pub fn effective_bitrate(&self, width: u32, height: u32) -> u32 {
        let reference_workload = (Self::REFERENCE_WIDTH as f64)
            * (Self::REFERENCE_HEIGHT as f64)
            * (Self::REFERENCE_FRAME_RATE as f64);
        let capture_workload = (width as f64) * (height as f64) * (self.frame_rate as f64);

        let normalized_scale = if reference_workload > 0.0 {
            (capture_workload / reference_workload).powf(0.85)
        } else {
            1.0
        };

        let target_bitrate = (self.bitrate as f64 * normalized_scale).round() as u32;
        let (minimum_bitrate, maximum_bitrate) = Self::bitrate_bounds_bps(&self.video_quality);

        target_bitrate.clamp(minimum_bitrate, maximum_bitrate)
    }

    pub fn estimate_size_bytes_for_capture(&self, width: u32, height: u32) -> u64 {
        let effective_bitrate = self.effective_bitrate(width, height) as u64;
        let size_per_hour = (effective_bitrate * 3600) / 8;
        (size_per_hour as f64 * 1.1) as u64
    }
}

#[derive(Serialize)]
pub struct RecordingInfo {
    pub filename: String,
    pub file_path: String,
    pub size_bytes: u64,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zone_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encounter_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encounter_category: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct CleanupResult {
    pub deleted_count: usize,
    pub freed_bytes: u64,
    pub deleted_files: Vec<String>,
}

#[tauri::command]
pub fn get_default_output_folder() -> Result<String, String> {
    let home_dir = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "Unable to determine home directory")?;

    let videos_dir = Path::new(&home_dir).join("Videos").join("FloorPoV");

    Ok(videos_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_folder_size(path: String) -> Result<u64, String> {
    let path = Path::new(&path);
    if !path.exists() {
        return Ok(0);
    }

    let mut total_size: u64 = 0;
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        if metadata.is_file() {
            if let Some(ext) = entry.path().extension() {
                if ext == "mp4" {
                    total_size += metadata.len();
                }
            }
        }
    }

    Ok(total_size)
}

#[tauri::command]
pub fn get_recordings_list(folder_path: String) -> Result<Vec<RecordingInfo>, String> {
    read_recordings_list(&folder_path)
}

#[tauri::command]
pub fn get_recording_metadata(
    file_path: String,
) -> Result<Option<recording_metadata::RecordingMetadata>, String> {
    let recording_path = Path::new(&file_path);
    if recording_path.extension().and_then(|value| value.to_str()) != Some("mp4") {
        return Err("Only .mp4 recordings are supported".to_string());
    }

    recording_metadata::read_recording_metadata(recording_path)
}

#[tauri::command]
pub fn delete_recording(file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);

    if !path.exists() {
        return Err("Recording file does not exist".to_string());
    }

    if !path.is_file() {
        return Err("Selected path is not a file".to_string());
    }

    if path.extension().and_then(|value| value.to_str()) != Some("mp4") {
        return Err("Only .mp4 recordings can be deleted".to_string());
    }

    std::fs::remove_file(path).map_err(|error| format!("Failed to delete recording: {error}"))?;

    if let Err(error) = recording_metadata::delete_recording_metadata(path) {
        tracing::warn!(
            recording_path = %path.display(),
            metadata_error = %error,
            "Recording file deleted but metadata cleanup failed"
        );
    }

    Ok(())
}

fn read_recordings_list(folder_path: &str) -> Result<Vec<RecordingInfo>, String> {
    let path = Path::new(&folder_path);
    if !path.exists() {
        return Ok(Vec::new());
    }

    let mut recordings = Vec::new();

    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.extension().is_some_and(|ext| ext == "mp4") {
            let metadata = entry.metadata().map_err(|e| e.to_string())?;
            let created_at = metadata
                .created()
                .map_err(|e| e.to_string())?
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_secs();

            let sidecar_metadata = match recording_metadata::read_recording_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    tracing::warn!(
                        recording_path = %path.display(),
                        metadata_error = %error,
                        "Failed to read recording metadata sidecar"
                    );
                    None
                }
            };
            let (zone_name, encounter_name, encounter_category) =
                if let Some(metadata) = sidecar_metadata {
                    (
                        metadata.zone_name,
                        metadata.encounter_name,
                        metadata.encounter_category,
                    )
                } else {
                    (None, None, None)
                };

            recordings.push(RecordingInfo {
                filename: path.file_name().unwrap().to_string_lossy().to_string(),
                file_path: path.to_string_lossy().to_string(),
                size_bytes: metadata.len(),
                created_at,
                zone_name,
                encounter_name,
                encounter_category,
            });
        }
    }

    recordings.sort_by_key(|r| r.created_at);

    Ok(recordings)
}

#[tauri::command]
pub fn cleanup_old_recordings(
    folder_path: String,
    max_bytes: u64,
    required_space: u64,
) -> Result<CleanupResult, String> {
    let current_size = get_folder_size(folder_path.clone())?;
    let target_size = max_bytes.saturating_sub(required_space);

    if current_size <= target_size {
        return Ok(CleanupResult {
            deleted_count: 0,
            freed_bytes: 0,
            deleted_files: Vec::new(),
        });
    }

    let mut recordings = read_recordings_list(&folder_path)?;
    let mut freed_bytes: u64 = 0;
    let mut deleted_files = Vec::new();

    if recordings.len() <= 1 {
        return Err("Cannot delete the only recording. Increase storage limit.".to_string());
    }

    while current_size - freed_bytes > target_size && recordings.len() > 1 {
        let oldest = recordings.remove(0);
        let file_path = Path::new(&oldest.file_path);

        if let Err(e) = std::fs::remove_file(file_path) {
            tracing::warn!(
                filename = %oldest.filename,
                path = %file_path.display(),
                error = %e,
                "Failed to delete old recording during cleanup"
            );
            continue;
        }

        if let Err(error) = recording_metadata::delete_recording_metadata(file_path) {
            tracing::warn!(
                filename = %oldest.filename,
                path = %file_path.display(),
                metadata_error = %error,
                "Failed to delete recording metadata during cleanup"
            );
        }

        freed_bytes += oldest.size_bytes;
        deleted_files.push(oldest.filename);
    }

    Ok(CleanupResult {
        deleted_count: deleted_files.len(),
        freed_bytes,
        deleted_files,
    })
}
