mod audio_pipeline;
mod ffmpeg;
mod model;
mod segments;
mod session;
mod window_capture;

use std::path::Path;

use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

pub use model::RecordingState;

#[tauri::command]
pub fn list_capture_windows() -> Result<Vec<model::CaptureWindowInfo>, String> {
    window_capture::list_capture_windows_internal()
}

#[tauri::command]
pub async fn start_recording(
    app_handle: AppHandle,
    state: tauri::State<'_, model::SharedRecordingState>,
    settings: crate::settings::RecordingSettings,
    output_folder: String,
    max_storage_bytes: u64,
) -> Result<model::RecordingStartedPayload, String> {
    {
        let recording_state = state.read().await;
        if recording_state.is_recording || recording_state.is_stopping {
            return Err("Recording already in progress".to_string());
        }
    }

    std::fs::create_dir_all(&output_folder)
        .map_err(|error| format!("Failed to create output directory: {error}"))?;

    let mut recording_settings = settings;
    let capture_input = window_capture::resolve_capture_input(&recording_settings)?;
    let (width, height) = window_capture::resolve_capture_dimensions(&capture_input);
    let effective_bitrate = recording_settings.effective_bitrate(width, height);
    let estimated_size = recording_settings.estimate_size_bytes_for_capture(width, height);

    let current_size = crate::settings::get_folder_size(output_folder.clone())?;
    if current_size + estimated_size > max_storage_bytes {
        let cleanup_result = crate::settings::cleanup_old_recordings(
            output_folder.clone(),
            max_storage_bytes,
            estimated_size,
        )?;

        if cleanup_result.deleted_count > 0 {
            if let Err(error) = app_handle.emit("storage-cleanup", cleanup_result) {
                tracing::warn!("Failed to emit storage-cleanup event: {error}");
            }
        }
    }

    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let filename = format!("screen_recording_{timestamp}.mp4");
    let output_path = Path::new(&output_folder).join(filename);
    let output_path_str = output_path.to_string_lossy().to_string();

    recording_settings.bitrate = effective_bitrate;
    if recording_settings.enable_system_audio {
        recording_settings.bitrate = recording_settings.bitrate.min(16_000_000);
    }
    let output_frame_rate = recording_settings.frame_rate.max(1);
    let ffmpeg_binary_path = ffmpeg::resolve_ffmpeg_binary_path(&app_handle)?;
    let resolved_capture_target = capture_input.target_label();

    if recording_settings.enable_system_audio {
        audio_pipeline::validate_system_audio_capture_available()?;
    }

    tracing::info!(
        backend = "ffmpeg",
        video_quality = %recording_settings.video_quality,
        requested_frame_rate = recording_settings.frame_rate,
        output_frame_rate,
        capture_source = %recording_settings.capture_source,
        resolved_capture_target = %resolved_capture_target,
        include_system_audio = recording_settings.enable_system_audio,
        enable_diagnostics = recording_settings.enable_recording_diagnostics,
        effective_bitrate_bps = recording_settings.bitrate,
        "Using recording settings"
    );

    let (stop_tx, stop_rx) = mpsc::channel(1);

    {
        let mut recording_state = state.write().await;
        if recording_state.is_recording || recording_state.is_stopping {
            return Err("Recording already in progress".to_string());
        }

        recording_state.is_recording = true;
        recording_state.is_stopping = false;
        recording_state.current_output_path = Some(output_path_str.clone());
        recording_state.stop_tx = Some(stop_tx);
    }

    session::spawn_ffmpeg_recording_task(
        app_handle.clone(),
        state.inner().clone(),
        output_path_str.clone(),
        ffmpeg_binary_path,
        recording_settings.frame_rate,
        output_frame_rate,
        recording_settings.bitrate,
        capture_input,
        recording_settings.enable_system_audio,
        recording_settings.enable_recording_diagnostics,
        stop_rx,
    );

    Ok(model::RecordingStartedPayload {
        output_path: output_path_str,
        width,
        height,
    })
}

#[tauri::command]
pub async fn stop_recording(
    state: tauri::State<'_, model::SharedRecordingState>,
) -> Result<String, String> {
    let (output_path, stop_tx) = {
        let mut recording_state = state.write().await;

        if !recording_state.is_recording {
            return Err("No active recording to stop".to_string());
        }

        let output_path = recording_state
            .current_output_path
            .clone()
            .ok_or_else(|| "No output path found".to_string())?;

        if recording_state.is_stopping {
            return Ok(output_path);
        }

        recording_state.is_stopping = true;

        (output_path, recording_state.stop_tx.take())
    };

    if let Some(stop_tx) = stop_tx {
        if let Err(error) = stop_tx.send(()).await {
            tracing::warn!("Failed to send stop signal to recording task: {error}");
        }
    }

    Ok(output_path)
}
