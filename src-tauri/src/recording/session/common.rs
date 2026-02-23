use std::io::Write;
use std::sync::mpsc as std_mpsc;
use std::time::{Duration, Instant};

use super::super::model::{
    CaptureInput, RuntimeCaptureMode, SharedRecordingState, FFMPEG_MODE_SWITCH_TO_BLACK_TIMEOUT,
    FFMPEG_MODE_SWITCH_TO_WINDOW_TIMEOUT, FFMPEG_STOP_TIMEOUT,
};

pub(super) fn to_runtime_capture_mode(capture_input: &CaptureInput) -> RuntimeCaptureMode {
    match capture_input {
        CaptureInput::Monitor => RuntimeCaptureMode::Monitor,
        CaptureInput::Window { .. } => RuntimeCaptureMode::Window,
    }
}

pub(super) fn runtime_capture_label(runtime_capture_mode: RuntimeCaptureMode) -> &'static str {
    match runtime_capture_mode {
        RuntimeCaptureMode::Monitor => "monitor",
        RuntimeCaptureMode::Window => "window",
        RuntimeCaptureMode::Black => "black",
    }
}

#[derive(Clone, Copy)]
pub(super) enum RequestedTransitionKind {
    ModeSwitchToBlack,
    ModeSwitchToWindow,
}

pub(super) fn clear_recording_state(state: &SharedRecordingState) {
    let mut recording_state = state.blocking_write();
    recording_state.is_recording = false;
    recording_state.is_stopping = false;
    recording_state.current_output_path = None;
    recording_state.stop_tx = None;
}

pub(super) fn signal_audio_threads_stop(
    audio_capture_stop_tx: &Option<&std_mpsc::Sender<()>>,
    audio_writer_stop_tx: &Option<&std_mpsc::Sender<()>>,
) {
    if let Some(capture_stop_tx) = audio_capture_stop_tx {
        if let Err(error) = capture_stop_tx.send(()) {
            tracing::debug!("Audio capture stop signal channel is closed: {error}");
        }
    }

    if let Some(writer_stop_tx) = audio_writer_stop_tx {
        if let Err(error) = writer_stop_tx.send(()) {
            tracing::debug!("Audio writer stop signal channel is closed: {error}");
        }
    }
}

pub(super) fn request_ffmpeg_graceful_stop(
    stop_requested_at: &mut Option<Instant>,
    child: &mut std::process::Child,
    audio_capture_stop_tx: &Option<&std_mpsc::Sender<()>>,
    audio_writer_stop_tx: &Option<&std_mpsc::Sender<()>>,
) {
    if stop_requested_at.is_none() {
        *stop_requested_at = Some(Instant::now());
        signal_audio_threads_stop(audio_capture_stop_tx, audio_writer_stop_tx);

        // Pipe may already be broken if FFmpeg exited; ignore write errors.
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(b"q\n");
            let _ = stdin.flush();
        }
    }
}

pub(super) fn resolve_stop_timeout(
    stop_requested_by_user: bool,
    requested_transition_kind: Option<RequestedTransitionKind>,
) -> Duration {
    if !stop_requested_by_user {
        match requested_transition_kind {
            Some(RequestedTransitionKind::ModeSwitchToBlack) => FFMPEG_MODE_SWITCH_TO_BLACK_TIMEOUT,
            Some(RequestedTransitionKind::ModeSwitchToWindow) => {
                FFMPEG_MODE_SWITCH_TO_WINDOW_TIMEOUT
            }
            None => FFMPEG_STOP_TIMEOUT,
        }
    } else {
        FFMPEG_STOP_TIMEOUT
    }
}
