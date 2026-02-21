use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecordingSettings {
    pub video_quality: String,
    pub frame_rate: u32,
    pub bitrate: u32,
}

impl RecordingSettings {
    pub fn from_quality(quality: &str, frame_rate: u32) -> Self {
        let bitrate = match quality {
            "low" => 2_000_000,
            "medium" => 5_000_000,
            "high" => 8_000_000,
            "ultra" => 15_000_000,
            _ => 8_000_000,
        };

        Self {
            video_quality: quality.to_string(),
            frame_rate,
            bitrate,
        }
    }

    pub fn estimate_size_bytes(&self) -> u64 {
        let size_per_hour = (self.bitrate as u64 * 3600) / 8;
        (size_per_hour as f64 * 1.1) as u64
    }
}

#[derive(Serialize)]
pub struct RecordingInfo {
    pub filename: String,
    pub file_path: String,
    pub size_bytes: u64,
    pub created_at: u64,
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

    let videos_dir = Path::new(&home_dir).join("Videos").join("Floorpov");

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

fn read_recordings_list(folder_path: &str) -> Result<Vec<RecordingInfo>, String> {
    let path = Path::new(&folder_path);
    if !path.exists() {
        return Ok(Vec::new());
    }

    let mut recordings = Vec::new();

    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.extension().map_or(false, |ext| ext == "mp4") {
            let metadata = entry.metadata().map_err(|e| e.to_string())?;
            let created_at = metadata
                .created()
                .map_err(|e| e.to_string())?
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_secs();

            recordings.push(RecordingInfo {
                filename: path.file_name().unwrap().to_string_lossy().to_string(),
                file_path: path.to_string_lossy().to_string(),
                size_bytes: metadata.len(),
                created_at,
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
        let file_path = Path::new(&folder_path).join(&oldest.filename);

        if let Err(e) = std::fs::remove_file(&file_path) {
            eprintln!("Failed to delete {}: {}", oldest.filename, e);
            continue;
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
