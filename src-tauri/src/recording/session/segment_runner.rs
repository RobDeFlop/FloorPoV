use std::io::{BufRead, BufReader};
use std::net::TcpListener;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TryRecvError;

use super::super::audio_pipeline::{
    is_expected_audio_disconnect_error, run_audio_queue_to_writer,
    run_system_audio_capture_to_queue,
};
use super::super::ffmpeg::{
    append_runtime_capture_input_args, parse_ffmpeg_speed, resolve_video_filter,
};
#[cfg(target_os = "windows")]
use super::super::model::CREATE_NO_WINDOW;
use super::super::model::{
    AudioPipelineStats, CaptureInput, RuntimeCaptureMode, SegmentRunResult, SegmentTransition,
    WindowCaptureAvailability, WindowCaptureRegion, AUDIO_TCP_ACCEPT_WAIT_MS,
    SYSTEM_AUDIO_CHANNEL_COUNT, SYSTEM_AUDIO_QUEUE_CAPACITY, SYSTEM_AUDIO_SAMPLE_RATE_HZ,
    WINDOW_CAPTURE_REGION_CHANGE_DEBOUNCE, WINDOW_CAPTURE_STATUS_POLL_INTERVAL,
    WINDOW_CAPTURE_UNAVAILABLE_WARNING,
};
use super::super::window_capture::{
    evaluate_window_capture_availability, resolve_window_capture_region,
    warning_message_for_window_capture,
};
use super::common::{
    request_ffmpeg_graceful_stop, resolve_stop_timeout, runtime_capture_label,
    signal_audio_threads_stop, RequestedTransitionKind,
};
use super::events::{emit_recording_warning, emit_recording_warning_cleared};

fn segment_result_for_capture_input_error(
    app_handle: &AppHandle,
    runtime_capture_mode: RuntimeCaptureMode,
    capture_input: &CaptureInput,
    error: &str,
) -> SegmentRunResult {
    tracing::warn!(
        runtime_capture_mode = runtime_capture_label(runtime_capture_mode),
        "Failed to prepare capture input: {error}"
    );

    if matches!(runtime_capture_mode, RuntimeCaptureMode::Window) {
        let availability = evaluate_window_capture_availability(capture_input);
        if let Some(warning_message) = warning_message_for_window_capture(availability) {
            emit_recording_warning(app_handle, warning_message);
        } else {
            emit_recording_warning(app_handle, WINDOW_CAPTURE_UNAVAILABLE_WARNING);
        }

        return SegmentRunResult {
            transition: SegmentTransition::Switch(RuntimeCaptureMode::Black),
            ffmpeg_succeeded: false,
            output_written: false,
            force_killed: false,
        };
    }

    SegmentRunResult {
        transition: SegmentTransition::Stop,
        ffmpeg_succeeded: false,
        output_written: false,
        force_killed: false,
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn run_ffmpeg_recording_segment(
    app_handle: &AppHandle,
    ffmpeg_binary_path: &Path,
    runtime_capture_mode: RuntimeCaptureMode,
    capture_input: &CaptureInput,
    output_path: &Path,
    requested_frame_rate: u32,
    output_frame_rate: u32,
    bitrate: u32,
    include_system_audio: bool,
    enable_diagnostics: bool,
    video_encoder: &str,
    encoder_preset: Option<&str>,
    capture_width: u32,
    capture_height: u32,
    stop_rx: &mut mpsc::Receiver<()>,
) -> SegmentRunResult {
    let bitrate_string = bitrate.to_string();
    let maxrate_string = bitrate.to_string();
    let buffer_size_string = bitrate.saturating_mul(2).to_string();
    let output_path_string = output_path.to_string_lossy().to_string();
    let mut active_window_region: Option<WindowCaptureRegion>;

    tracing::info!(
        ffmpeg_path = %ffmpeg_binary_path.display(),
        runtime_capture_mode = runtime_capture_label(runtime_capture_mode),
        output_path = %output_path.display(),
        requested_frame_rate,
        output_frame_rate,
        bitrate,
        include_system_audio,
        enable_diagnostics,
        video_encoder,
        "Starting FFmpeg recording segment"
    );

    let mut command = Command::new(ffmpeg_binary_path);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("warning")
        .arg("-stats")
        .arg("-stats_period")
        .arg("1")
        .arg("-y");

    let mut audio_listener: Option<TcpListener> = None;

    if include_system_audio {
        let listener = match TcpListener::bind(("127.0.0.1", 0)) {
            Ok(listener) => listener,
            Err(error) => {
                tracing::error!("Failed to allocate local audio TCP listener: {error}");
                return SegmentRunResult {
                    transition: SegmentTransition::Stop,
                    ffmpeg_succeeded: false,
                    output_written: false,
                    force_killed: false,
                };
            }
        };

        if let Err(error) = listener.set_nonblocking(true) {
            tracing::error!("Failed to configure audio TCP listener: {error}");
            return SegmentRunResult {
                transition: SegmentTransition::Stop,
                ffmpeg_succeeded: false,
                output_written: false,
                force_killed: false,
            };
        }

        let audio_port = match listener.local_addr() {
            Ok(address) => address.port(),
            Err(error) => {
                tracing::error!("Failed to resolve audio TCP listener port: {error}");
                return SegmentRunResult {
                    transition: SegmentTransition::Stop,
                    ffmpeg_succeeded: false,
                    output_written: false,
                    force_killed: false,
                };
            }
        };

        command
            .arg("-thread_queue_size")
            .arg("1024")
            .arg("-f")
            .arg("s16le")
            .arg("-ar")
            .arg(SYSTEM_AUDIO_SAMPLE_RATE_HZ.to_string())
            .arg("-ac")
            .arg(SYSTEM_AUDIO_CHANNEL_COUNT.to_string())
            .arg("-i")
            .arg(format!("tcp://127.0.0.1:{audio_port}"));

        let capture_input_args = append_runtime_capture_input_args(
            &mut command,
            runtime_capture_mode,
            capture_input,
            requested_frame_rate,
            capture_width,
            capture_height,
        );
        let capture_input_info = match capture_input_args {
            Ok(info) => info,
            Err(error) => {
                return segment_result_for_capture_input_error(
                    app_handle,
                    runtime_capture_mode,
                    capture_input,
                    &error,
                );
            }
        };
        active_window_region = capture_input_info.window_region;

        let video_filter = resolve_video_filter(
            runtime_capture_mode,
            output_frame_rate,
            capture_input_info.width,
            capture_input_info.height,
        );

        command
            .arg("-map")
            .arg("1:v:0")
            .arg("-map")
            .arg("0:a:0")
            .arg("-af")
            .arg("aresample=async=1:min_hard_comp=0.100:first_pts=0,volume=2.2,alimiter=limit=0.98")
            .arg("-vf")
            .arg(&video_filter)
            .arg("-thread_queue_size")
            .arg("512")
            .arg("-c:a")
            .arg("aac")
            .arg("-b:a")
            .arg("192k")
            .arg("-ar")
            .arg("48000")
            .arg("-ac")
            .arg("2");

        audio_listener = Some(listener);
    } else {
        let capture_input_args = append_runtime_capture_input_args(
            &mut command,
            runtime_capture_mode,
            capture_input,
            requested_frame_rate,
            capture_width,
            capture_height,
        );
        let capture_input_info = match capture_input_args {
            Ok(info) => info,
            Err(error) => {
                return segment_result_for_capture_input_error(
                    app_handle,
                    runtime_capture_mode,
                    capture_input,
                    &error,
                );
            }
        };
        active_window_region = capture_input_info.window_region;

        let video_filter = resolve_video_filter(
            runtime_capture_mode,
            output_frame_rate,
            capture_input_info.width,
            capture_input_info.height,
        );

        command.arg("-vf").arg(&video_filter).arg("-an");
    }

    command.arg("-c:v").arg(video_encoder);

    if let Some(preset) = encoder_preset {
        command.arg("-preset").arg(preset);
    }

    command
        .arg("-b:v")
        .arg(&bitrate_string)
        .arg("-maxrate")
        .arg(&maxrate_string)
        .arg("-bufsize")
        .arg(&buffer_size_string)
        .arg("-fps_mode")
        .arg("cfr")
        .arg("-max_muxing_queue_size")
        .arg("2048")
        .arg("-movflags")
        .arg("+faststart")
        .arg(&output_path_string)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(process) => process,
        Err(error) => {
            tracing::error!("Failed to spawn FFmpeg recording process: {error}");
            return SegmentRunResult {
                transition: SegmentTransition::Stop,
                ffmpeg_succeeded: false,
                output_written: false,
                force_killed: false,
            };
        }
    };

    if matches!(runtime_capture_mode, RuntimeCaptureMode::Window) {
        emit_recording_warning_cleared(app_handle);
    }

    let stderr_thread = child.stderr.take().map(|stderr| {
        let diagnostics_enabled = enable_diagnostics;
        thread::spawn(move || {
            let mut low_speed_streak = 0u32;
            let mut low_speed_warned = false;

            for line in BufReader::new(stderr).lines() {
                match line {
                    Ok(content) if !content.trim().is_empty() => {
                        let is_progress_line = content.contains("frame=")
                            || content.contains("fps=")
                            || content.contains("dup=")
                            || content.contains("drop=")
                            || content.contains("speed=");

                        if let Some(speed) = parse_ffmpeg_speed(&content) {
                            if speed < 0.90 {
                                low_speed_streak = low_speed_streak.saturating_add(1);
                                if low_speed_streak >= 3 && !low_speed_warned {
                                    tracing::warn!(
                                        speed,
                                        "FFmpeg encode speed is below realtime; consider lower quality preset"
                                    );
                                    low_speed_warned = true;
                                }
                            } else {
                                low_speed_streak = 0;
                            }
                        }

                        if is_progress_line {
                            if diagnostics_enabled {
                                tracing::info!("ffmpeg: {content}");
                            }
                        } else if diagnostics_enabled {
                            tracing::debug!("ffmpeg: {content}");
                        }
                    }
                    Ok(_) => {}
                    Err(error) => {
                        tracing::warn!("Failed to read FFmpeg stderr: {error}");
                        break;
                    }
                }
            }
        })
    });

    let (
        audio_capture_stop_tx,
        audio_writer_stop_tx,
        audio_capture_thread,
        audio_writer_thread,
        audio_stats,
    ) = if include_system_audio {
        let Some(listener) = audio_listener else {
            tracing::error!("System audio was enabled but audio listener was unavailable");
            return SegmentRunResult {
                transition: SegmentTransition::Stop,
                ffmpeg_succeeded: false,
                output_written: false,
                force_killed: false,
            };
        };

        let (audio_tx, audio_rx) = std_mpsc::sync_channel::<Vec<u8>>(SYSTEM_AUDIO_QUEUE_CAPACITY);
        let (capture_stop_tx, capture_stop_rx) = std_mpsc::channel::<()>();
        let (writer_stop_tx, writer_stop_rx) = std_mpsc::channel::<()>();
        let stats = Arc::new(AudioPipelineStats::default());

        let writer_stats = Arc::clone(&stats);
        let writer_thread = thread::spawn(move || {
            tracing::info!("Waiting for FFmpeg audio socket connection");
            let audio_stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => {
                        tracing::info!("FFmpeg audio socket connected");
                        break Ok(stream);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        match writer_stop_rx.try_recv() {
                            Ok(()) | Err(std_mpsc::TryRecvError::Disconnected) => {
                                return Ok(());
                            }
                            Err(std_mpsc::TryRecvError::Empty) => {
                                thread::sleep(Duration::from_millis(AUDIO_TCP_ACCEPT_WAIT_MS));
                            }
                        }
                    }
                    Err(error) => break Err(format!("Failed to accept audio TCP stream: {error}")),
                }
            }?;

            let _ = audio_stream.set_nodelay(true);
            let _ = audio_stream.set_write_timeout(Some(Duration::from_millis(12)));
            let writer_result =
                run_audio_queue_to_writer(audio_stream, audio_rx, writer_stop_rx, writer_stats);
            tracing::info!("System audio writer thread exited");
            writer_result
        });

        let capture_stats = Arc::clone(&stats);
        let capture_thread = thread::spawn(move || {
            let capture_result =
                run_system_audio_capture_to_queue(audio_tx, capture_stop_rx, capture_stats);
            tracing::info!("System audio capture thread exited");
            capture_result
        });

        (
            Some(capture_stop_tx),
            Some(writer_stop_tx),
            Some(capture_thread),
            Some(writer_thread),
            Some(stats),
        )
    } else {
        (None, None, None, None, None)
    };

    let mut stop_requested_at: Option<Instant> = None;
    let mut kill_sent = false;
    let mut force_killed = false;
    let mut stats_logged_at = Instant::now();
    let mut previous_queued = 0u64;
    let mut previous_dequeued = 0u64;
    let mut previous_dropped = 0u64;
    let mut previous_timeouts = 0u64;
    let mut drop_warning_emitted = false;
    let mut window_status_checked_at = Instant::now();
    let mut active_window_warning: Option<&'static str> = None;
    let mut stop_requested_by_user = false;
    let mut requested_transition: Option<RuntimeCaptureMode> = None;
    let mut requested_transition_kind: Option<RequestedTransitionKind> = None;
    let mut pending_window_region_change: Option<(WindowCaptureRegion, Instant)> = None;

    let exit_status = loop {
        if stop_requested_at.is_none() {
            match stop_rx.try_recv() {
                Ok(()) | Err(TryRecvError::Disconnected) => {
                    stop_requested_by_user = true;
                    request_ffmpeg_graceful_stop(
                        &mut stop_requested_at,
                        &mut child,
                        &audio_capture_stop_tx,
                        &audio_writer_stop_tx,
                    );
                }
                Err(TryRecvError::Empty) => {}
            }
        }

        if let Some(requested_at) = stop_requested_at {
            let stop_timeout =
                resolve_stop_timeout(stop_requested_by_user, requested_transition_kind);

            if !kill_sent && requested_at.elapsed() >= stop_timeout {
                match child.kill() {
                    Ok(()) => {
                        force_killed = true;
                    }
                    Err(error) => {
                        tracing::warn!("Failed to force-stop FFmpeg process: {error}");
                    }
                }
                kill_sent = true;
            }
        }

        if let Some(audio_stats) = &audio_stats {
            if stats_logged_at.elapsed() >= Duration::from_secs(1) {
                let queued_total = audio_stats.queued_chunks.load(Ordering::Relaxed);
                let dequeued_total = audio_stats.dequeued_chunks.load(Ordering::Relaxed);
                let dropped_total = audio_stats.dropped_chunks.load(Ordering::Relaxed);
                let timeouts_total = audio_stats.write_timeouts.load(Ordering::Relaxed);
                let queue_depth = queued_total.saturating_sub(dequeued_total);
                let dropped_delta = dropped_total.saturating_sub(previous_dropped);
                let timeout_delta = timeouts_total.saturating_sub(previous_timeouts);

                if dropped_delta > 0 && !drop_warning_emitted {
                    tracing::warn!(
                        dropped_delta,
                        "Audio chunks were dropped to keep video smooth"
                    );
                    drop_warning_emitted = true;
                }

                if timeout_delta > 0 {
                    tracing::warn!(
                        timeout_delta,
                        "Audio writer hit socket timeouts during this interval"
                    );
                }

                if enable_diagnostics {
                    tracing::info!(
                        audio_queue_depth = queue_depth,
                        audio_chunks_queued = queued_total.saturating_sub(previous_queued),
                        audio_chunks_written = dequeued_total.saturating_sub(previous_dequeued),
                        audio_chunks_dropped = dropped_delta,
                        audio_write_timeouts = timeout_delta,
                        "Audio pipeline stats"
                    );
                }

                previous_queued = queued_total;
                previous_dequeued = dequeued_total;
                previous_dropped = dropped_total;
                previous_timeouts = timeouts_total;
                stats_logged_at = Instant::now();
            }
        }

        if matches!(capture_input, CaptureInput::Window { .. })
            && window_status_checked_at.elapsed() >= WINDOW_CAPTURE_STATUS_POLL_INTERVAL
        {
            window_status_checked_at = Instant::now();
            let capture_availability = evaluate_window_capture_availability(capture_input);
            let next_window_warning = if matches!(runtime_capture_mode, RuntimeCaptureMode::Black)
                && capture_availability == WindowCaptureAvailability::Available
            {
                Some(WINDOW_CAPTURE_UNAVAILABLE_WARNING)
            } else {
                warning_message_for_window_capture(capture_availability)
            };

            if next_window_warning != active_window_warning {
                if let Some(warning_message) = next_window_warning {
                    emit_recording_warning(app_handle, warning_message);
                } else {
                    emit_recording_warning_cleared(app_handle);
                }

                active_window_warning = next_window_warning;
            }

            if requested_transition.is_none() {
                match runtime_capture_mode {
                    RuntimeCaptureMode::Window
                        if capture_availability != WindowCaptureAvailability::Available =>
                    {
                        requested_transition = Some(RuntimeCaptureMode::Black);
                        requested_transition_kind =
                            Some(RequestedTransitionKind::ModeSwitchToBlack);
                        request_ffmpeg_graceful_stop(
                            &mut stop_requested_at,
                            &mut child,
                            &audio_capture_stop_tx,
                            &audio_writer_stop_tx,
                        );
                    }
                    RuntimeCaptureMode::Black
                        if capture_availability == WindowCaptureAvailability::Available =>
                    {
                        match resolve_window_capture_region(capture_input) {
                            Ok(region) => {
                                tracing::info!(
                                    output_idx = region.output_idx,
                                    offset_x = region.offset_x,
                                    offset_y = region.offset_y,
                                    width = region.width,
                                    height = region.height,
                                    "Window capture region is ready; restoring capture from black mode"
                                );
                                requested_transition = Some(RuntimeCaptureMode::Window);
                                requested_transition_kind =
                                    Some(RequestedTransitionKind::ModeSwitchToWindow);
                                request_ffmpeg_graceful_stop(
                                    &mut stop_requested_at,
                                    &mut child,
                                    &audio_capture_stop_tx,
                                    &audio_writer_stop_tx,
                                );
                            }
                            Err(error) => {
                                tracing::debug!(
                                    "Window is available but capture region is not ready yet: {error}"
                                );
                            }
                        }
                    }
                    _ => {}
                }
            }

            if requested_transition.is_none()
                && matches!(runtime_capture_mode, RuntimeCaptureMode::Window)
                && capture_availability == WindowCaptureAvailability::Available
            {
                match resolve_window_capture_region(capture_input) {
                    Ok(current_region) => {
                        if let Some(previous_region) = active_window_region {
                            if current_region != previous_region {
                                match pending_window_region_change {
                                    Some((pending_region, changed_at))
                                        if pending_region == current_region
                                            && changed_at.elapsed()
                                                >= WINDOW_CAPTURE_REGION_CHANGE_DEBOUNCE =>
                                    {
                                        tracing::info!(
                                            old_output_idx = previous_region.output_idx,
                                            old_offset_x = previous_region.offset_x,
                                            old_offset_y = previous_region.offset_y,
                                            old_width = previous_region.width,
                                            old_height = previous_region.height,
                                            new_output_idx = current_region.output_idx,
                                            new_offset_x = current_region.offset_x,
                                            new_offset_y = current_region.offset_y,
                                            new_width = current_region.width,
                                            new_height = current_region.height,
                                            "Window capture region changed; restarting capture segment"
                                        );
                                        requested_transition = Some(RuntimeCaptureMode::Window);
                                        requested_transition_kind =
                                            Some(RequestedTransitionKind::RegionRetarget);
                                        request_ffmpeg_graceful_stop(
                                            &mut stop_requested_at,
                                            &mut child,
                                            &audio_capture_stop_tx,
                                            &audio_writer_stop_tx,
                                        );
                                    }
                                    Some((pending_region, _))
                                        if pending_region == current_region => {}
                                    _ => {
                                        pending_window_region_change =
                                            Some((current_region, Instant::now()));
                                    }
                                }
                            } else {
                                pending_window_region_change = None;
                            }
                        } else {
                            active_window_region = Some(current_region);
                            pending_window_region_change = None;
                        }
                    }
                    Err(error) => {
                        tracing::debug!(
                            "Failed to resolve window capture region while polling: {error}"
                        );
                    }
                }
            } else if capture_availability != WindowCaptureAvailability::Available {
                pending_window_region_change = None;
            }
        }

        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(error) => break Err(error),
        }
    };

    signal_audio_threads_stop(&audio_capture_stop_tx, &audio_writer_stop_tx);

    if let Some(stderr_thread) = stderr_thread {
        if let Err(error) = stderr_thread.join() {
            tracing::warn!("Failed to join FFmpeg stderr thread: {error:?}");
        }
    }

    if let Some(audio_capture_thread) = audio_capture_thread {
        match audio_capture_thread.join() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::error!("System audio capture thread failed: {error}");
            }
            Err(error) => {
                tracing::error!("System audio capture thread panicked: {error:?}");
            }
        }
    }

    if let Some(audio_writer_thread) = audio_writer_thread {
        match audio_writer_thread.join() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                let expected_disconnect =
                    stop_requested_by_user || requested_transition.is_some() || kill_sent;
                if expected_disconnect && is_expected_audio_disconnect_error(&error) {
                    tracing::debug!("System audio writer closed after FFmpeg shutdown: {error}");
                } else {
                    tracing::error!("System audio writer thread failed: {error}");
                }
            }
            Err(error) => {
                tracing::error!("System audio writer thread panicked: {error:?}");
            }
        }
    }

    let ffmpeg_completed_successfully = match exit_status {
        Ok(status) if status.success() => {
            tracing::info!("FFmpeg recording process finished successfully");
            true
        }
        Ok(status) => {
            if requested_transition.is_some() || stop_requested_by_user {
                tracing::warn!("FFmpeg recording process exited while transitioning: {status}");
            } else {
                tracing::error!("FFmpeg recording process exited with status: {status}");
            }
            false
        }
        Err(error) => {
            tracing::error!("Failed while waiting for FFmpeg recording process: {error}");
            match child.kill() {
                Ok(()) => {
                    force_killed = true;
                }
                Err(kill_error) => {
                    tracing::debug!("FFmpeg kill after wait failure returned: {kill_error}");
                }
            }
            if let Err(wait_error) = child.wait() {
                tracing::warn!("Failed to collect FFmpeg exit status after kill: {wait_error}");
            }
            false
        }
    };

    let output_written = output_path.exists()
        && output_path
            .metadata()
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false);

    let transition = if stop_requested_by_user {
        SegmentTransition::Stop
    } else if let Some(next_runtime_capture_mode) = requested_transition {
        SegmentTransition::Switch(next_runtime_capture_mode)
    } else if ffmpeg_completed_successfully {
        SegmentTransition::RestartSameMode
    } else {
        match runtime_capture_mode {
            RuntimeCaptureMode::Window => {
                let availability = evaluate_window_capture_availability(capture_input);
                if availability != WindowCaptureAvailability::Available {
                    SegmentTransition::Switch(RuntimeCaptureMode::Black)
                } else {
                    SegmentTransition::RestartSameMode
                }
            }
            RuntimeCaptureMode::Black => {
                let availability = evaluate_window_capture_availability(capture_input);
                if availability == WindowCaptureAvailability::Available {
                    SegmentTransition::Switch(RuntimeCaptureMode::Window)
                } else {
                    SegmentTransition::RestartSameMode
                }
            }
            RuntimeCaptureMode::Monitor => SegmentTransition::Stop,
        }
    };

    SegmentRunResult {
        transition,
        ffmpeg_succeeded: ffmpeg_completed_successfully,
        output_written,
        force_killed,
    }
}
