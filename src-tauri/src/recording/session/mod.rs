mod common;
mod events;
mod segment_runner;

use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use tauri::AppHandle;
use tokio::sync::mpsc;

use super::ffmpeg::select_video_encoder;
use super::model::{
    RecordingSessionConfig, RuntimeCaptureMode, SegmentConfig, SegmentTransition,
    SharedRecordingState, WindowCaptureAvailability, WINDOW_CAPTURE_UNAVAILABLE_WARNING,
};
use super::segments::{
    build_segment_output_path, cleanup_segment_workspace, create_segment_workspace,
    finalize_segmented_recording,
};
use super::window_capture::{
    evaluate_window_capture_availability, resolve_capture_dimensions,
    resolve_window_capture_region, warning_message_for_window_capture,
};

use self::common::{clear_recording_state, runtime_capture_label, to_runtime_capture_mode};
use self::events::{
    emit_recording_finalized, emit_recording_stopped, emit_recording_warning,
    emit_recording_warning_cleared,
};
use self::segment_runner::run_ffmpeg_recording_segment;

pub(crate) fn spawn_ffmpeg_recording_task(
    app_handle: AppHandle,
    state: SharedRecordingState,
    session_config: RecordingSessionConfig,
    mut stop_rx: mpsc::Receiver<()>,
) {
    thread::spawn(move || {
        let mut capture_input = session_config.capture_input;
        let (video_encoder, encoder_preset) =
            select_video_encoder(&session_config.ffmpeg_binary_path);
        let mut runtime_capture_mode = to_runtime_capture_mode(&capture_input);
        let capture_target = capture_input.target_label();
        let (capture_width, capture_height) = resolve_capture_dimensions(&capture_input);

        if matches!(runtime_capture_mode, RuntimeCaptureMode::Window) {
            let initial_availability = evaluate_window_capture_availability(&capture_input);
            let mut startup_warning: Option<&str> = None;

            if initial_availability != WindowCaptureAvailability::Available {
                runtime_capture_mode = RuntimeCaptureMode::Black;
                startup_warning = warning_message_for_window_capture(initial_availability);
            } else if let Err(error) = resolve_window_capture_region(&capture_input) {
                tracing::warn!("Failed to resolve initial window capture region: {error}");
                runtime_capture_mode = RuntimeCaptureMode::Black;
                startup_warning = Some(WINDOW_CAPTURE_UNAVAILABLE_WARNING);
            }

            if matches!(runtime_capture_mode, RuntimeCaptureMode::Black) {
                emit_recording_warning(
                    &app_handle,
                    startup_warning.unwrap_or(WINDOW_CAPTURE_UNAVAILABLE_WARNING),
                );
            }
        }

        let segment_workspace =
            if matches!(capture_input, super::model::CaptureInput::Window { .. }) {
                match create_segment_workspace(&session_config.output_path) {
                    Ok(workspace) => Some(workspace),
                    Err(error) => {
                        tracing::error!("{error}");
                        clear_recording_state(&state);
                        emit_recording_stopped(&app_handle);
                        return;
                    }
                }
            } else {
                None
            };

        tracing::info!(
            ffmpeg_path = %session_config.ffmpeg_binary_path.display(),
            requested_frame_rate = session_config.requested_frame_rate,
            output_frame_rate = session_config.output_frame_rate,
            bitrate = session_config.bitrate,
            capture_source = runtime_capture_label(runtime_capture_mode),
            capture_target = %capture_target,
            include_system_audio = session_config.include_system_audio,
            enable_diagnostics = session_config.enable_diagnostics,
            video_encoder,
            "Starting FFmpeg recording"
        );

        let mut segment_paths: Vec<PathBuf> = Vec::new();
        let mut segment_durations: Vec<Duration> = Vec::new();
        let mut segment_index: usize = 0;
        let mut consecutive_segment_failures = 0u32;

        loop {
            let segment_output_path = if let Some(workspace) = &segment_workspace {
                build_segment_output_path(workspace, segment_index)
            } else {
                PathBuf::from(&session_config.output_path)
            };

            let segment_config = SegmentConfig {
                ffmpeg_binary_path: &session_config.ffmpeg_binary_path,
                runtime_capture_mode,
                output_path: &segment_output_path,
                requested_frame_rate: session_config.requested_frame_rate,
                output_frame_rate: session_config.output_frame_rate,
                bitrate: session_config.bitrate,
                include_system_audio: session_config.include_system_audio,
                enable_diagnostics: session_config.enable_diagnostics,
                video_encoder: &video_encoder,
                encoder_preset: encoder_preset.as_deref(),
                capture_width,
                capture_height,
            };

            let run_result = run_ffmpeg_recording_segment(
                &app_handle,
                &segment_config,
                &mut capture_input,
                &mut stop_rx,
            );

            if run_result.output_written {
                if run_result.force_killed {
                    tracing::warn!(
                        segment_path = %segment_output_path.display(),
                        "Skipping segment because FFmpeg was force-killed before clean finalization"
                    );
                } else {
                    segment_paths.push(segment_output_path);
                    segment_durations.push(run_result.wall_clock_duration);
                }
            }

            if run_result.ffmpeg_succeeded {
                consecutive_segment_failures = 0;
            } else if matches!(run_result.transition, SegmentTransition::Switch(_)) {
                tracing::debug!(
                    runtime_capture_mode = runtime_capture_label(runtime_capture_mode),
                    "Ignoring non-zero FFmpeg exit for expected capture transition"
                );
            } else {
                consecutive_segment_failures = consecutive_segment_failures.saturating_add(1);
            }

            if consecutive_segment_failures >= 3 {
                tracing::error!(
                    runtime_capture_mode = runtime_capture_label(runtime_capture_mode),
                    "Stopping recording after repeated FFmpeg segment failures"
                );
                break;
            }

            match run_result.transition {
                SegmentTransition::Stop => {
                    break;
                }
                SegmentTransition::Switch(next_runtime_capture_mode) => {
                    runtime_capture_mode = next_runtime_capture_mode;
                    segment_index = segment_index.saturating_add(1);
                }
                SegmentTransition::RestartSameMode => {
                    if matches!(runtime_capture_mode, RuntimeCaptureMode::Monitor) {
                        break;
                    }
                    segment_index = segment_index.saturating_add(1);
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }

        let finalized_successfully = if let Some(workspace) = &segment_workspace {
            let finalize_result = finalize_segmented_recording(
                &session_config.ffmpeg_binary_path,
                workspace,
                &segment_paths,
                &segment_durations,
                &session_config.output_path,
            );

            let was_successful = match finalize_result {
                Ok(()) => true,
                Err(error) => {
                    if !segment_paths.is_empty() {
                        tracing::error!("Failed to finalize segmented recording: {error}");
                    } else {
                        tracing::warn!("No recording segments were produced before stop");
                    }
                    false
                }
            };

            cleanup_segment_workspace(workspace);
            was_successful
        } else {
            let output_file = Path::new(&session_config.output_path);
            output_file.exists()
                && output_file
                    .metadata()
                    .map(|metadata| metadata.len() > 0)
                    .unwrap_or(false)
        };

        if finalized_successfully {
            emit_recording_finalized(&app_handle, &session_config.output_path);
        }

        emit_recording_warning_cleared(&app_handle);
        clear_recording_state(&state);
        emit_recording_stopped(&app_handle);
    });
}
