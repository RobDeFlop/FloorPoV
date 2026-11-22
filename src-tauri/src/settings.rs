use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::recording::metadata as recording_metadata;

fn default_capture_source() -> String {
    "monitor".to_string()
}

fn default_audio_capture_mode() -> String {
    "wow".to_string()
}

fn default_video_encoder_preference() -> String {
    "auto".to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecordingSettings {
    pub video_quality: String,
    pub frame_rate: u32,
    pub bitrate: u32,
    #[serde(default = "default_video_encoder_preference")]
    pub video_encoder_preference: String,
    #[serde(default = "default_capture_source")]
    pub capture_source: String,
    #[serde(default)]
    pub capture_window_hwnd: Option<String>,
    #[serde(default)]
    pub capture_window_title: Option<String>,
    pub enable_system_audio: bool,
    #[serde(default = "default_audio_capture_mode")]
    pub audio_capture_mode: String,
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
            "high" => (8_000_000, 28_000_000),
            "ultra" => (14_000_000, 50_000_000),
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_level: Option<u32>,
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

pub(crate) fn output_folder_from_settings_value(value: &serde_json::Value) -> Option<String> {
    value
        .get("recording-settings")
        .and_then(|settings| settings.get("outputFolder"))
        .and_then(|folder| folder.as_str())
        .map(str::trim)
        .filter(|folder| !folder.is_empty())
        .map(ToOwned::to_owned)
}

pub(crate) fn read_stored_output_folder(app_handle: &AppHandle) -> Option<String> {
    let app_data_dir = app_handle.path().app_data_dir().ok()?;
    let settings_path = app_data_dir.join("settings.json");
    let contents = std::fs::read_to_string(settings_path).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&contents).ok()?;
    output_folder_from_settings_value(&value)
}

pub(crate) fn resolve_startup_recordings_folder(app_handle: &AppHandle) -> Result<String, String> {
    if let Some(stored_folder) = read_stored_output_folder(app_handle) {
        return Ok(stored_folder);
    }

    get_default_output_folder()
}

pub(crate) fn register_recordings_folder_scope(
    app_handle: &AppHandle,
    folder_path: &str,
) -> Result<(), String> {
    let folder = folder_path.trim();
    if folder.is_empty() {
        return Err("Output folder path is empty".to_string());
    }

    let path = PathBuf::from(folder);
    std::fs::create_dir_all(&path).map_err(|error| {
        format!(
            "Could not create the recordings folder '{}': {error}",
            path.display()
        )
    })?;

    app_handle
        .asset_protocol_scope()
        .allow_directory(&path, true)
        .map_err(|error| {
            format!(
                "Could not allow the recordings folder '{}' for playback: {error}",
                path.display()
            )
        })?;

    tracing::info!(
        folder = %path.display(),
        "Registered asset scope for recordings folder"
    );
    Ok(())
}

#[tauri::command]
pub fn allow_recordings_folder(app: AppHandle, folder_path: String) -> Result<(), String> {
    register_recordings_folder_scope(&app, &folder_path)
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

    let mut metadata = recording_metadata::read_recording_metadata(recording_path)?;
    if let Some(loaded_metadata) = metadata.as_mut() {
        crate::combat_log::metadata::rebase_recording_metadata_from_log_clock(loaded_metadata);
    }

    Ok(metadata)
}

#[tauri::command]
pub fn write_export_file(file_path: String, contents: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());

    if extension.as_deref() != Some("md") && extension.as_deref() != Some("json") {
        return Err("Export file must be .md or .json".to_string());
    }

    if let Some(parent_directory) = path.parent() {
        if !parent_directory.as_os_str().is_empty() {
            std::fs::create_dir_all(parent_directory).map_err(|error| {
                format!(
                    "Failed to create export directory '{}': {error}",
                    parent_directory.display()
                )
            })?;
        }
    }

    std::fs::write(path, contents)
        .map_err(|error| format!("Failed to write export file '{}': {error}", path.display()))?;

    Ok(())
}

#[tauri::command]
pub fn save_recording_note(
    file_path: String,
    note_id: Option<String>,
    timestamp_seconds: f64,
    text: String,
) -> Result<recording_metadata::RecordingNoteMetadata, String> {
    recording_metadata::upsert_recording_note(
        Path::new(&file_path),
        note_id,
        timestamp_seconds,
        &text,
    )
}

#[tauri::command]
pub fn delete_recording_note(file_path: String, note_id: String) -> Result<(), String> {
    recording_metadata::delete_recording_note(Path::new(&file_path), &note_id)
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
            let (zone_name, encounter_name, encounter_category, key_level) =
                if let Some(metadata) = sidecar_metadata {
                    (
                        metadata.zone_name,
                        metadata.encounter_name,
                        metadata.encounter_category,
                        metadata.key_level,
                    )
                } else {
                    (None, None, None, None)
                };

            recordings.push(RecordingInfo {
                filename: path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "unknown".to_string()),
                file_path: path.to_string_lossy().to_string(),
                size_bytes: metadata.len(),
                created_at,
                zone_name,
                encounter_name,
                encounter_category,
                key_level,
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

#[cfg(test)]
mod tests {
    use super::output_folder_from_settings_value;

    #[test]
    fn reads_custom_output_folder_from_stored_settings() {
        let value = serde_json::json!({
            "recording-settings": {
                "outputFolder": "D:\\videos"
            }
        });

        assert_eq!(
            output_folder_from_settings_value(&value).as_deref(),
            Some("D:\\videos")
        );
    }

    #[test]
    fn ignores_blank_output_folder_in_stored_settings() {
        let value = serde_json::json!({
            "recording-settings": {
                "outputFolder": "   "
            }
        });

        assert_eq!(output_folder_from_settings_value(&value), None);
    }

    #[test]
    fn ignores_settings_without_output_folder() {
        let value = serde_json::json!({
            "recording-settings": {
                "startMinimized": true
            }
        });

        assert_eq!(output_folder_from_settings_value(&value), None);
    }
}
