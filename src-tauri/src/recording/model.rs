use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, RwLock};

#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Gdi::HMONITOR;

#[derive(Clone, serde::Serialize)]
pub struct RecordingStartedPayload {
    pub(crate) output_path: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[derive(Clone, serde::Serialize)]
pub struct CaptureWindowInfo {
    pub(crate) hwnd: String,
    pub(crate) title: String,
}

#[derive(Clone)]
pub(crate) enum CaptureInput {
    Monitor,
    Window {
        input_target: String,
        window_hwnd: Option<usize>,
        window_title: Option<String>,
    },
}

impl CaptureInput {
    pub(crate) fn target_label(&self) -> String {
        match self {
            CaptureInput::Monitor => "primary_monitor".to_string(),
            CaptureInput::Window { input_target, .. } => input_target.clone(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowCaptureAvailability {
    Available,
    Minimized,
    Closed,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum RuntimeCaptureMode {
    Monitor,
    Window,
    Black,
}

#[derive(Clone, Copy)]
pub(crate) enum SegmentTransition {
    Stop,
    Switch(RuntimeCaptureMode),
    RestartSameMode,
}

pub(crate) struct SegmentRunResult {
    pub(crate) transition: SegmentTransition,
    pub(crate) ffmpeg_succeeded: bool,
    pub(crate) output_written: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowCaptureRegion {
    pub(crate) output_idx: u32,
    pub(crate) offset_x: i32,
    pub(crate) offset_y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[cfg(target_os = "windows")]
pub(crate) struct MonitorIndexSearchState {
    pub(crate) target_monitor: HMONITOR,
    pub(crate) current_index: u32,
    pub(crate) found_index: Option<u32>,
}

pub(crate) const FFMPEG_RESOURCE_PATH: &str = "bin/ffmpeg.exe";
pub(crate) const FFMPEG_STOP_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const FFMPEG_TRANSITION_TIMEOUT: Duration = Duration::from_millis(900);
pub(crate) const FFMPEG_MODE_SWITCH_TO_BLACK_TIMEOUT: Duration = Duration::from_millis(1200);
pub(crate) const FFMPEG_MODE_SWITCH_TO_WINDOW_TIMEOUT: Duration = Duration::from_millis(450);
pub(crate) const SYSTEM_AUDIO_SAMPLE_RATE_HZ: usize = 48_000;
pub(crate) const SYSTEM_AUDIO_CHANNEL_COUNT: usize = 2;
pub(crate) const SYSTEM_AUDIO_BITS_PER_SAMPLE: usize = 16;
pub(crate) const SYSTEM_AUDIO_CHUNK_FRAMES: usize = 960;
pub(crate) const SYSTEM_AUDIO_EVENT_TIMEOUT_MS: u32 = 500;
pub(crate) const AUDIO_TCP_ACCEPT_WAIT_MS: u64 = 25;
pub(crate) const SYSTEM_AUDIO_QUEUE_CAPACITY: usize = 256;
#[cfg(target_os = "windows")]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x08000000;
pub(crate) const WINDOW_CAPTURE_STATUS_POLL_INTERVAL: Duration = Duration::from_millis(150);
pub(crate) const WINDOW_CAPTURE_REGION_CHANGE_DEBOUNCE: Duration = Duration::from_millis(180);
pub(crate) const WINDOW_CAPTURE_MINIMIZED_WARNING: &str = "Selected window is minimized. Recording continues, but the video may be black until the window is restored.";
pub(crate) const WINDOW_CAPTURE_CLOSED_WARNING: &str = "Selected window is unavailable or closed. Recording continues, but the video may be black until the window is available again.";
pub(crate) const WINDOW_CAPTURE_UNAVAILABLE_WARNING: &str = "Selected window is currently unavailable for capture. Recording continues, but the video may be black until the window is available.";
pub(crate) const DEFAULT_CAPTURE_WIDTH: u32 = 1920;
pub(crate) const DEFAULT_CAPTURE_HEIGHT: u32 = 1080;
pub(crate) const MIN_CAPTURE_DIMENSION: u32 = 2;

#[derive(Default)]
pub(crate) struct AudioPipelineStats {
    pub(crate) queued_chunks: AtomicU64,
    pub(crate) dequeued_chunks: AtomicU64,
    pub(crate) dropped_chunks: AtomicU64,
    pub(crate) write_timeouts: AtomicU64,
}

pub struct RecordingState {
    pub(crate) is_recording: bool,
    pub(crate) is_stopping: bool,
    pub(crate) current_output_path: Option<String>,
    pub(crate) stop_tx: Option<mpsc::Sender<()>>,
}

impl RecordingState {
    pub fn new() -> Self {
        Self {
            is_recording: false,
            is_stopping: false,
            current_output_path: None,
            stop_tx: None,
        }
    }
}

pub type SharedRecordingState = Arc<RwLock<RecordingState>>;
