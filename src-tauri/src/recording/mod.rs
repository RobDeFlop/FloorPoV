mod audio_pipeline;
mod ffmpeg;
pub(crate) mod metadata;
mod model;
mod mp4;
mod segments;
mod session;
mod window_capture;

use std::path::Path;

use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, watch};

pub(crate) use ffmpeg::resolve_ffmpeg_binary_path;
pub use model::RecordingState;
pub(crate) use model::SharedRecordingState;
pub(crate) use model::CREATE_NO_WINDOW;
use model::{CaptureInput, RecordingCompletion, RecordingSessionConfig};

fn sanitize_for_filename(input: &str) -> String {
    let mut result = String::new();
    let mut last_was_underscore = false;

    for c in input.chars() {
        if c.is_whitespace() || c == '-' {
            if !last_was_underscore && !result.is_empty() {
                result.push('_');
                last_was_underscore = true;
            }
        } else if c.is_alphanumeric() {
            result.push(c.to_ascii_lowercase());
            last_was_underscore = false;
        }
    }

    result.chars().take(30).collect()
}

#[tauri::command]
pub fn list_capture_windows() -> Result<Vec<model::CaptureWindowInfo>, String> {
    window_capture::list_capture_windows_internal()
}

#[tauri::command]
pub fn is_wow_process_running() -> bool {
    audio_pipeline::is_wow_process_running()
}

#[tauri::command]
pub fn get_available_video_encoders(
    app_handle: AppHandle,
) -> Result<Vec<model::AvailableVideoEncoder>, String> {
    let ffmpeg_binary_path = ffmpeg::resolve_ffmpeg_binary_path(&app_handle)?;
    let mut options = vec![model::AvailableVideoEncoder {
        value: "auto".to_string(),
        label: "Auto (Recommended)".to_string(),
    }];

    let available_encoders = ffmpeg::list_available_video_encoders(&ffmpeg_binary_path);
    options.extend(
        available_encoders
            .into_iter()
            .map(|encoder| model::AvailableVideoEncoder {
                label: ffmpeg::video_encoder_label(&encoder).to_string(),
                value: encoder,
            }),
    );

    Ok(options)
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
        ensure_recording_can_start(&recording_state)?;
    }

    std::fs::create_dir_all(&output_folder)
        .map_err(|error| format!("Failed to create output directory: {error}"))?;

    if let Err(error) =
        crate::settings::register_recordings_folder_scope(&app_handle, &output_folder)
    {
        tracing::warn!(
            output_folder,
            "Recording started without playback access to the output folder: {error}"
        );
    }

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
    let prefix = match &capture_input {
        CaptureInput::Monitor => "screen".to_string(),
        CaptureInput::Window { window_title, .. } => {
            if let Some(title) = window_title {
                let clean_title = sanitize_for_filename(title);
                if clean_title.is_empty() {
                    "window".to_string()
                } else {
                    format!("window_{clean_title}")
                }
            } else {
                "window".to_string()
            }
        }
    };
    let filename = format!("{prefix}_recording_{timestamp}.mp4");
    let output_path = Path::new(&output_folder).join(filename);
    let output_path_str = output_path.to_string_lossy().to_string();

    recording_settings.bitrate = effective_bitrate;
    let output_frame_rate = recording_settings.frame_rate.max(1);
    let ffmpeg_binary_path = ffmpeg::resolve_ffmpeg_binary_path(&app_handle)?;
    let resolved_capture_target = capture_input.target_label();

    if recording_settings.enable_system_audio {
        audio_pipeline::validate_system_audio_capture_available(
            &recording_settings.audio_capture_mode,
        )?;
    }

    tracing::info!(
        backend = "ffmpeg",
        video_quality = %recording_settings.video_quality,
        video_encoder_preference = %recording_settings.video_encoder_preference,
        requested_frame_rate = recording_settings.frame_rate,
        output_frame_rate,
        capture_source = %recording_settings.capture_source,
        resolved_capture_target = %resolved_capture_target,
        include_system_audio = recording_settings.enable_system_audio,
        audio_capture_mode = %recording_settings.audio_capture_mode,
        enable_diagnostics = recording_settings.enable_recording_diagnostics,
        effective_bitrate_bps = recording_settings.bitrate,
        "Using recording settings"
    );

    let (stop_tx, stop_rx) = mpsc::channel(1);
    let (completion_tx, completion_rx) = watch::channel(None);

    {
        let mut recording_state = state.write().await;
        ensure_recording_can_start(&recording_state)?;

        recording_state.is_recording = true;
        recording_state.is_stopping = false;
        recording_state.current_output_path = Some(output_path_str.clone());
        recording_state.stop_tx = Some(stop_tx);
        recording_state.completion = Some(completion_rx);
    }

    session::spawn_ffmpeg_recording_task(
        app_handle.clone(),
        state.inner().clone(),
        RecordingSessionConfig {
            output_path: output_path_str.clone(),
            ffmpeg_binary_path,
            video_quality: recording_settings.video_quality.clone(),
            video_encoder_preference: recording_settings.video_encoder_preference.clone(),
            requested_frame_rate: recording_settings.frame_rate,
            output_frame_rate,
            bitrate: recording_settings.bitrate,
            capture_input,
            include_system_audio: recording_settings.enable_system_audio,
            audio_capture_mode: recording_settings.audio_capture_mode.clone(),
            enable_diagnostics: recording_settings.enable_recording_diagnostics,
        },
        stop_rx,
        completion_tx,
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

        (output_path, recording_state.take_stop_signal())
    };

    if let Some(stop_tx) = stop_tx {
        signal_stop(stop_tx).await;
    }

    Ok(output_path)
}

async fn signal_stop(stop_tx: mpsc::Sender<()>) {
    if let Err(error) = stop_tx.send(()).await {
        tracing::warn!("Failed to send stop signal to recording task: {error}");
    }
}

fn ensure_recording_can_start(state: &RecordingState) -> Result<(), String> {
    if state.starts_blocked_for_quit {
        return Err("Cannot start recording while closing FloorPoV".to_string());
    }
    if state.is_recording || state.is_stopping {
        return Err("Recording already in progress".to_string());
    }
    Ok(())
}

pub(crate) enum RecordingOnQuit {
    Idle,
    Capturing(RecordingCompletion),
    Saving(RecordingCompletion),
}

pub(crate) async fn prepare_for_window_quit(state: &SharedRecordingState) -> RecordingOnQuit {
    let mut state = state.write().await;
    // Take the snapshot under the same lock as start_recording so a new session
    // cannot start between observing an idle recorder and exiting the app.
    state.starts_blocked_for_quit = true;
    match state.completion.clone() {
        None => RecordingOnQuit::Idle,
        Some(completion) if state.is_stopping => RecordingOnQuit::Saving(completion),
        Some(completion) => RecordingOnQuit::Capturing(completion),
    }
}

pub(crate) async fn cancel_window_quit(state: &SharedRecordingState) {
    state.write().await.starts_blocked_for_quit = false;
}

pub(crate) async fn save_before_window_quit(
    state: &SharedRecordingState,
    mut completion: RecordingCompletion,
) -> Result<(), String> {
    let stop_tx = state.write().await.take_stop_signal();
    if let Some(stop_tx) = stop_tx {
        // Manual stops flush combat metadata before finalization can rename the recording.
        if let Err(error) = crate::combat_log::watch::set_combat_watch_recording_output(None) {
            tracing::debug!("Could not detach combat watch for window quit: {error}");
        }
        signal_stop(stop_tx).await;
    }

    let result = completion
        .wait_for(Option::is_some)
        .await
        .map_err(|_| "Recording ended without a save result".to_string())?;
    result
        .as_ref()
        .ok_or_else(|| "Missing recording save result".to_string())?
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeping_the_window_open_releases_the_start_gate_without_stopping_capture() {
        tauri::async_runtime::block_on(async {
            let state = SharedRecordingState::default();
            let (stop_tx, mut stop_rx) = mpsc::channel(1);
            let (_completion_tx, completion_rx) = watch::channel(None);
            *state.write().await = RecordingState {
                is_recording: true,
                stop_tx: Some(stop_tx),
                completion: Some(completion_rx),
                ..RecordingState::default()
            };

            assert!(matches!(
                prepare_for_window_quit(&state).await,
                RecordingOnQuit::Capturing(_)
            ));
            assert!(state.read().await.starts_blocked_for_quit);
            cancel_window_quit(&state).await;

            let recording_state = state.read().await;
            assert!(!recording_state.starts_blocked_for_quit);
            assert!(!recording_state.is_stopping);
            assert_eq!(stop_rx.try_recv(), Err(mpsc::error::TryRecvError::Empty));
        });
    }

    #[test]
    fn closing_while_saving_waits_for_the_result_without_sending_a_second_stop() {
        tauri::async_runtime::block_on(async {
            for outcome in [Ok(()), Err("disk full".to_string())] {
                let state = SharedRecordingState::default();
                let (stop_tx, mut stop_rx) = mpsc::channel(1);
                let (completion_tx, completion_rx) = watch::channel(None);
                *state.write().await = RecordingState {
                    is_recording: true,
                    is_stopping: true,
                    stop_tx: Some(stop_tx),
                    completion: Some(completion_rx),
                    ..RecordingState::default()
                };

                let RecordingOnQuit::Saving(completion) = prepare_for_window_quit(&state).await
                else {
                    panic!("expected saving recording");
                };
                let mut pending_save = Box::pin(save_before_window_quit(&state, completion));
                assert!(
                    std::future::poll_fn(|cx| {
                        std::task::Poll::Ready(
                            std::future::Future::poll(pending_save.as_mut(), cx).is_pending(),
                        )
                    })
                    .await
                );
                assert_eq!(stop_rx.try_recv(), Err(mpsc::error::TryRecvError::Empty));

                completion_tx.send_replace(Some(outcome.clone()));
                assert_eq!(pending_save.await, outcome);
            }
        });
    }

    #[test]
    fn an_idle_quit_blocks_new_recordings_until_cancelled() {
        tauri::async_runtime::block_on(async {
            let state = SharedRecordingState::default();
            assert!(matches!(
                prepare_for_window_quit(&state).await,
                RecordingOnQuit::Idle
            ));
            assert!(ensure_recording_can_start(&*state.read().await).is_err());
            cancel_window_quit(&state).await;
            assert!(ensure_recording_can_start(&*state.read().await).is_ok());
        });
    }
}
