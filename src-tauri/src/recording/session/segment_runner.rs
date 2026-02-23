use std::io::{BufRead, BufReader};
use std::net::TcpListener;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::Ordering;
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
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
    AudioPipelineStats, CaptureInput, RuntimeCaptureMode, SegmentConfig, SegmentRunResult,
    SegmentTransition, WindowCaptureAvailability, AUDIO_TCP_ACCEPT_WAIT,
    SYSTEM_AUDIO_CHANNEL_COUNT, SYSTEM_AUDIO_QUEUE_CAPACITY, SYSTEM_AUDIO_SAMPLE_RATE_HZ,
    WINDOW_CAPTURE_STATUS_POLL_INTERVAL, WINDOW_CAPTURE_UNAVAILABLE_WARNING,
};
use super::super::window_capture::{
    evaluate_window_capture_availability, resolve_window_capture_handle,
    warning_message_for_window_capture,
};
use super::common::{
    request_ffmpeg_graceful_stop, resolve_stop_timeout, runtime_capture_label,
    signal_audio_threads_stop, RequestedTransitionKind,
};
use super::events::{emit_recording_warning, emit_recording_warning_cleared};

fn early_exit_result(
    transition: SegmentTransition,
    segment_started_at: Instant,
) -> SegmentRunResult {
    SegmentRunResult {
        transition,
        ffmpeg_succeeded: false,
        output_written: false,
        force_killed: false,
        wall_clock_duration: segment_started_at.elapsed(),
    }
}

fn segment_result_for_capture_input_error(
    app_handle: &AppHandle,
    runtime_capture_mode: RuntimeCaptureMode,
    capture_input: &CaptureInput,
    error: &str,
    segment_started_at: Instant,
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

        return early_exit_result(
            SegmentTransition::Switch(RuntimeCaptureMode::Black),
            segment_started_at,
        );
    }

    early_exit_result(SegmentTransition::Stop, segment_started_at)
}

fn should_fallback_window_capture_to_region(
    capture_input: &CaptureInput,
    ffmpeg_exit_status: &ExitStatus,
    stderr_hints: &[String],
) -> bool {
    if !matches!(capture_input, CaptureInput::Window { .. })
        || !capture_input.uses_wgc_window_capture()
    {
        return false;
    }

    if let Some(exit_code) = ffmpeg_exit_status.code() {
        if exit_code == -40 || exit_code == 0xD8 {
            return true;
        }
    }

    stderr_hints.iter().any(|line| {
        line.contains("Failed to setup graphics capture")
            || line.contains("Failed to start WGC thread")
            || line.contains("graphics capture")
            || line.contains("gfxcapture")
            || line.contains("Function not implemented")
    })
}

struct AudioListenerSetup {
    listener: TcpListener,
    port: u16,
}

fn bind_audio_listener(
    segment_started_at: Instant,
) -> Result<AudioListenerSetup, SegmentRunResult> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
        tracing::error!("Failed to allocate local audio TCP listener: {error}");
        early_exit_result(SegmentTransition::Stop, segment_started_at)
    })?;

    listener.set_nonblocking(true).map_err(|error| {
        tracing::error!("Failed to configure audio TCP listener: {error}");
        early_exit_result(SegmentTransition::Stop, segment_started_at)
    })?;

    let port = listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|error| {
            tracing::error!("Failed to resolve audio TCP listener port: {error}");
            early_exit_result(SegmentTransition::Stop, segment_started_at)
        })?;

    Ok(AudioListenerSetup { listener, port })
}

fn spawn_stderr_reader(
    child: &mut Child,
    enable_diagnostics: bool,
) -> (Arc<Mutex<Vec<String>>>, Option<thread::JoinHandle<()>>) {
    let stderr_hints: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_hints_for_thread = Arc::clone(&stderr_hints);

    let stderr_thread = child.stderr.take().map(|stderr| {
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
                            if enable_diagnostics {
                                tracing::info!("ffmpeg: {content}");
                            }
                        } else {
                            let trimmed = content.trim();
                            if !trimmed.is_empty() {
                                if let Ok(mut hints) = stderr_hints_for_thread.lock() {
                                    if hints.len() < 32 {
                                        hints.push(trimmed.to_string());
                                    }
                                }

                                if enable_diagnostics {
                                    tracing::debug!("ffmpeg: {trimmed}");
                                }
                            }
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

    (stderr_hints, stderr_thread)
}

struct AudioPipelineHandles {
    capture_stop_tx: std_mpsc::Sender<()>,
    writer_stop_tx: std_mpsc::Sender<()>,
    capture_thread: thread::JoinHandle<Result<(), String>>,
    writer_thread: thread::JoinHandle<Result<(), String>>,
    stats: Arc<AudioPipelineStats>,
}

fn setup_audio_pipeline(listener: TcpListener) -> AudioPipelineHandles {
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
                            thread::sleep(AUDIO_TCP_ACCEPT_WAIT);
                        }
                    }
                }
                Err(error) => break Err(format!("Failed to accept audio TCP stream: {error}")),
            }
        }?;

        // Non-fatal socket tuning; recording proceeds with defaults if these fail.
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

    AudioPipelineHandles {
        capture_stop_tx,
        writer_stop_tx,
        capture_thread,
        writer_thread,
        stats,
    }
}

struct PollLoopState {
    stop_requested_at: Option<Instant>,
    kill_sent: bool,
    force_killed: bool,
    stop_requested_by_user: bool,
    requested_transition: Option<RuntimeCaptureMode>,
    requested_transition_kind: Option<RequestedTransitionKind>,
}

struct PollLoopOutcome {
    exit_status: Result<ExitStatus, std::io::Error>,
    state: PollLoopState,
}

fn run_segment_poll_loop(
    app_handle: &AppHandle,
    child: &mut Child,
    capture_input: &CaptureInput,
    runtime_capture_mode: RuntimeCaptureMode,
    enable_diagnostics: bool,
    audio: &Option<AudioPipelineHandles>,
    stop_rx: &mut mpsc::Receiver<()>,
) -> PollLoopOutcome {
    let mut state = PollLoopState {
        stop_requested_at: None,
        kill_sent: false,
        force_killed: false,
        stop_requested_by_user: false,
        requested_transition: None,
        requested_transition_kind: None,
    };

    let mut stats_logged_at = Instant::now();
    let mut previous_queued = 0u64;
    let mut previous_dequeued = 0u64;
    let mut previous_dropped = 0u64;
    let mut previous_timeouts = 0u64;
    let mut drop_warning_emitted = false;
    let mut window_status_checked_at = Instant::now();
    let mut active_window_warning: Option<&'static str> = None;

    // For request_ffmpeg_graceful_stop.
    let audio_capture_stop_tx = audio.as_ref().map(|a| &a.capture_stop_tx);
    let audio_writer_stop_tx = audio.as_ref().map(|a| &a.writer_stop_tx);

    let exit_status = loop {
        if state.stop_requested_at.is_none() {
            match stop_rx.try_recv() {
                Ok(()) | Err(TryRecvError::Disconnected) => {
                    state.stop_requested_by_user = true;
                    request_ffmpeg_graceful_stop(
                        &mut state.stop_requested_at,
                        child,
                        &audio_capture_stop_tx,
                        &audio_writer_stop_tx,
                    );
                }
                Err(TryRecvError::Empty) => {}
            }
        }

        if let Some(requested_at) = state.stop_requested_at {
            let stop_timeout = resolve_stop_timeout(
                state.stop_requested_by_user,
                state.requested_transition_kind,
            );

            if !state.kill_sent && requested_at.elapsed() >= stop_timeout {
                match child.kill() {
                    Ok(()) => {
                        state.force_killed = true;
                    }
                    Err(error) => {
                        tracing::warn!("Failed to force-stop FFmpeg process: {error}");
                    }
                }
                state.kill_sent = true;
            }
        }

        if let Some(audio_handles) = audio {
            if stats_logged_at.elapsed() >= Duration::from_secs(1) {
                let queued_total = audio_handles.stats.queued_chunks.load(Ordering::Relaxed);
                let dequeued_total = audio_handles.stats.dequeued_chunks.load(Ordering::Relaxed);
                let dropped_total = audio_handles.stats.dropped_chunks.load(Ordering::Relaxed);
                let timeouts_total = audio_handles.stats.write_timeouts.load(Ordering::Relaxed);
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

            if state.requested_transition.is_none() {
                match runtime_capture_mode {
                    RuntimeCaptureMode::Window
                        if capture_availability != WindowCaptureAvailability::Available =>
                    {
                        state.requested_transition = Some(RuntimeCaptureMode::Black);
                        state.requested_transition_kind =
                            Some(RequestedTransitionKind::ModeSwitchToBlack);
                        request_ffmpeg_graceful_stop(
                            &mut state.stop_requested_at,
                            child,
                            &audio_capture_stop_tx,
                            &audio_writer_stop_tx,
                        );
                    }
                    RuntimeCaptureMode::Black
                        if capture_availability == WindowCaptureAvailability::Available =>
                    {
                        match resolve_window_capture_handle(capture_input) {
                            Ok(window_hwnd) => {
                                tracing::info!(
                                    window_hwnd,
                                    "Window capture target is ready; restoring capture from black mode"
                                );
                                state.requested_transition = Some(RuntimeCaptureMode::Window);
                                state.requested_transition_kind =
                                    Some(RequestedTransitionKind::ModeSwitchToWindow);
                                request_ffmpeg_graceful_stop(
                                    &mut state.stop_requested_at,
                                    child,
                                    &audio_capture_stop_tx,
                                    &audio_writer_stop_tx,
                                );
                            }
                            Err(error) => {
                                tracing::debug!(
                                    "Window is available but capture target is not ready yet: {error}"
                                );
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(error) => break Err(error),
        }
    };

    PollLoopOutcome { exit_status, state }
}

fn join_worker_threads(
    audio: Option<AudioPipelineHandles>,
    stderr_thread: Option<thread::JoinHandle<()>>,
    stderr_hints: &Arc<Mutex<Vec<String>>>,
    stop_requested_by_user: bool,
    requested_transition: Option<RuntimeCaptureMode>,
    kill_sent: bool,
) -> Vec<String> {
    if let Some(handle) = stderr_thread {
        if let Err(error) = handle.join() {
            tracing::warn!("Failed to join FFmpeg stderr thread: {error:?}");
        }
    }

    let stderr_hint_lines = stderr_hints
        .lock()
        .map(|lines| lines.clone())
        .unwrap_or_default();

    if let Some(audio_handles) = audio {
        match audio_handles.capture_thread.join() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::error!("System audio capture thread failed: {error}");
            }
            Err(error) => {
                tracing::error!("System audio capture thread panicked: {error:?}");
            }
        }

        match audio_handles.writer_thread.join() {
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

    stderr_hint_lines
}

fn determine_segment_transition(
    runtime_capture_mode: RuntimeCaptureMode,
    capture_input: &CaptureInput,
    stop_requested_by_user: bool,
    requested_transition: Option<RuntimeCaptureMode>,
    ffmpeg_succeeded: bool,
) -> SegmentTransition {
    if stop_requested_by_user {
        return SegmentTransition::Stop;
    }

    if let Some(next_mode) = requested_transition {
        return SegmentTransition::Switch(next_mode);
    }

    if ffmpeg_succeeded {
        return SegmentTransition::RestartSameMode;
    }

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
}

pub(super) fn run_ffmpeg_recording_segment(
    app_handle: &AppHandle,
    config: &SegmentConfig,
    capture_input: &mut CaptureInput,
    stop_rx: &mut mpsc::Receiver<()>,
) -> SegmentRunResult {
    tracing::info!(
        ffmpeg_path = %config.ffmpeg_binary_path.display(),
        runtime_capture_mode = runtime_capture_label(config.runtime_capture_mode),
        output_path = %config.output_path.display(),
        requested_frame_rate = config.requested_frame_rate,
        output_frame_rate = config.output_frame_rate,
        bitrate = config.bitrate,
        include_system_audio = config.include_system_audio,
        enable_diagnostics = config.enable_diagnostics,
        video_encoder = config.video_encoder,
        "Starting FFmpeg recording segment"
    );

    let segment_started_at = Instant::now();

    // Bind audio listener before building the command so we know the port.
    let audio_setup = if config.include_system_audio {
        match bind_audio_listener(segment_started_at) {
            Ok(setup) => Some(setup),
            Err(result) => return result,
        }
    } else {
        None
    };

    let audio_port = audio_setup.as_ref().map(|s| s.port);

    let bitrate_string = config.bitrate.to_string();
    let buffer_size_string = config.bitrate.saturating_mul(2).to_string();
    let output_path_string = config.output_path.to_string_lossy().to_string();

    let mut command = Command::new(config.ffmpeg_binary_path);
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

    if let Some(port) = audio_port {
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
            .arg(format!("tcp://127.0.0.1:{port}"));
    }

    let capture_input_info = match append_runtime_capture_input_args(
        &mut command,
        config.runtime_capture_mode,
        capture_input,
        config.requested_frame_rate,
        config.capture_width,
        config.capture_height,
    ) {
        Ok(info) => info,
        Err(error) => {
            return segment_result_for_capture_input_error(
                app_handle,
                config.runtime_capture_mode,
                capture_input,
                &error,
                segment_started_at,
            );
        }
    };

    let video_filter = resolve_video_filter(
        config.runtime_capture_mode,
        config.output_frame_rate,
        capture_input_info.width,
        capture_input_info.height,
    );

    if audio_port.is_some() {
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
    } else {
        command.arg("-vf").arg(&video_filter).arg("-an");
    }

    command.arg("-c:v").arg(config.video_encoder);

    if let Some(preset) = config.encoder_preset {
        command.arg("-preset").arg(preset);
    }

    command
        .arg("-b:v")
        .arg(&bitrate_string)
        .arg("-maxrate")
        .arg(&bitrate_string)
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
            return early_exit_result(SegmentTransition::Stop, segment_started_at);
        }
    };

    if matches!(config.runtime_capture_mode, RuntimeCaptureMode::Window) {
        emit_recording_warning_cleared(app_handle);
    }

    let (stderr_hints, stderr_thread) = spawn_stderr_reader(&mut child, config.enable_diagnostics);

    let audio_handles = if let Some(setup) = audio_setup {
        Some(setup_audio_pipeline(setup.listener))
    } else {
        None
    };

    // Ensure audio threads are signaled to stop even if the poll loop exited unexpectedly.
    let outcome = run_segment_poll_loop(
        app_handle,
        &mut child,
        capture_input,
        config.runtime_capture_mode,
        config.enable_diagnostics,
        &audio_handles,
        stop_rx,
    );

    // Ensure audio threads are signaled to stop even if the poll loop exited unexpectedly.
    if let Some(ref audio) = audio_handles {
        signal_audio_threads_stop(&Some(&audio.capture_stop_tx), &Some(&audio.writer_stop_tx));
    }

    let stderr_hint_lines = join_worker_threads(
        audio_handles,
        stderr_thread,
        &stderr_hints,
        outcome.state.stop_requested_by_user,
        outcome.state.requested_transition,
        outcome.state.kill_sent,
    );

    let mut force_killed = outcome.state.force_killed;

    let ffmpeg_succeeded = match outcome.exit_status {
        Ok(status) if status.success() => {
            tracing::info!("FFmpeg recording process finished successfully");
            true
        }
        Ok(status) => {
            if should_fallback_window_capture_to_region(capture_input, &status, &stderr_hint_lines)
            {
                tracing::warn!(
                    exit_status = %status,
                    "WGC window capture failed. Falling back to region-based window capture"
                );
                capture_input.disable_wgc_window_capture();
                emit_recording_warning(
                    app_handle,
                    "Exclusive window capture is unavailable on this system. Falling back to region-based capture, so overlapping windows may appear.",
                );
            }

            if !stderr_hint_lines.is_empty() {
                let joined_hints = stderr_hint_lines.join(" | ");
                tracing::warn!(ffmpeg_stderr = %joined_hints, "FFmpeg stderr details");
            }

            if outcome.state.requested_transition.is_some() || outcome.state.stop_requested_by_user
            {
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

    let output_written = config.output_path.exists()
        && config
            .output_path
            .metadata()
            .is_ok_and(|metadata| metadata.len() > 0);

    let transition = determine_segment_transition(
        config.runtime_capture_mode,
        capture_input,
        outcome.state.stop_requested_by_user,
        outcome.state.requested_transition,
        ffmpeg_succeeded,
    );

    SegmentRunResult {
        transition,
        ffmpeg_succeeded,
        output_written,
        force_killed,
        wall_clock_duration: segment_started_at.elapsed(),
    }
}
