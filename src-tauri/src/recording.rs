use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, RwLock};
use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    encoder::{
        AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
        VideoSettingsSubType,
    },
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
    window::Window,
};

#[derive(Clone, serde::Serialize)]
pub struct RecordingStartedPayload {
    output_path: String,
    width: u32,
    height: u32,
}

struct RecordingHandler {
    app_handle: AppHandle,
    output_path: String,
    encoder: Option<VideoEncoder>,
    stop_rx: mpsc::Receiver<()>,
    state: SharedRecordingState,
    finalized_emitted: bool,
}

impl RecordingHandler {
    fn emit_recording_finalized(&mut self) {
        if self.finalized_emitted {
            return;
        }

        if let Err(error) = self
            .app_handle
            .emit("recording-finalized", &self.output_path)
        {
            tracing::error!("Failed to emit recording-finalized event: {error}");
            return;
        }

        self.finalized_emitted = true;
    }
}

impl GraphicsCaptureApiHandler for RecordingHandler {
    type Flags = (
        String,
        u32,
        u32,
        crate::settings::RecordingSettings,
        AppHandle,
        mpsc::Receiver<()>,
        SharedRecordingState,
    );
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(context: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let (output_path, width, height, settings, app_handle, stop_rx, state) = context.flags;

        let video_settings = VideoSettingsBuilder::new(width, height)
            .sub_type(VideoSettingsSubType::H264)
            .frame_rate(settings.frame_rate)
            .bitrate(settings.bitrate);

        let audio_settings = AudioSettingsBuilder::default().disabled(true);
        let container_settings = ContainerSettingsBuilder::default();

        let encoder = VideoEncoder::new(
            video_settings,
            audio_settings,
            container_settings,
            &output_path,
        )?;

        Ok(Self {
            app_handle,
            output_path,
            encoder: Some(encoder),
            stop_rx,
            state,
            finalized_emitted: false,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.stop_rx.try_recv().is_ok() {
            if let Some(encoder) = self.encoder.take() {
                if let Err(error) = encoder.finish() {
                    tracing::error!("Failed to finalize recording encoder: {error}");
                }
            }
            self.emit_recording_finalized();
            capture_control.stop();
            return Ok(());
        }

        if let Some(encoder) = &mut self.encoder {
            encoder.send_frame(frame)?;
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        if let Some(encoder) = self.encoder.take() {
            if let Err(error) = encoder.finish() {
                tracing::error!("Failed to finalize recording encoder on close: {error}");
            }
        }
        self.emit_recording_finalized();
        if let Ok(mut recording_state) = self.state.try_write() {
            recording_state.is_recording = false;
            recording_state.current_output_path = None;
            recording_state.stop_tx = None;
        }
        if let Err(error) = self.app_handle.emit("recording-stopped", ()) {
            tracing::error!("Failed to emit recording-stopped event: {error}");
        }
        Ok(())
    }
}

pub struct RecordingState {
    is_recording: bool,
    current_output_path: Option<String>,
    stop_tx: Option<mpsc::Sender<()>>,
}

impl RecordingState {
    pub fn new() -> Self {
        Self {
            is_recording: false,
            current_output_path: None,
            stop_tx: None,
        }
    }
}

pub type SharedRecordingState = Arc<RwLock<RecordingState>>;

enum CaptureTarget {
    Monitor(Monitor),
    Window(Window),
}

fn window_id(window: &Window) -> String {
    format!("hwnd:{}", window.as_raw_hwnd() as usize)
}

fn find_window_by_selection(selection: &str) -> Result<Window, String> {
    let windows = Window::enumerate().map_err(|error| error.to_string())?;

    if let Some(window) = windows
        .iter()
        .copied()
        .find(|window| window_id(window) == selection)
    {
        return Ok(window);
    }

    if let Some(window) = windows.iter().copied().find(|window| {
        window
            .title()
            .map(|title| title.trim() == selection)
            .unwrap_or(false)
    }) {
        return Ok(window);
    }

    Window::from_contains_name(selection).map_err(|_| {
        format!("Could not find window '{selection}'. Refresh the window list and try again.")
    })
}

fn resolve_capture_target(
    capture_source: &str,
    selected_window: Option<&str>,
) -> Result<(CaptureTarget, u32, u32), String> {
    match capture_source {
        "primary-monitor" => {
            let monitor = Monitor::primary().map_err(|error| error.to_string())?;
            let width = monitor.width().map_err(|error| error.to_string())?;
            let height = monitor.height().map_err(|error| error.to_string())?;
            Ok((CaptureTarget::Monitor(monitor), width, height))
        }
        "window" => {
            let selected_value = selected_window
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("Select a window before starting recording".to_string())?;

            let window = find_window_by_selection(selected_value)?;

            let window_name = window
                .title()
                .unwrap_or_else(|_| selected_value.to_string());

            if !window.is_valid() {
                return Err(format!(
                    "Window '{window_name}' is not capturable right now. Try a different window."
                ));
            }

            let width = window.width().map_err(|error| error.to_string())?;
            let height = window.height().map_err(|error| error.to_string())?;

            if width <= 0 || height <= 0 {
                return Err(format!(
                    "Window '{window_name}' has an invalid size and cannot be captured."
                ));
            }

            Ok((CaptureTarget::Window(window), width as u32, height as u32))
        }
        _ => Err(format!("Unsupported capture source: {capture_source}")),
    }
}

fn minimum_update_interval_for_frame_rate(frame_rate: u32) -> Duration {
    let bounded_frame_rate = frame_rate.max(1) as u64;
    Duration::from_millis((1000 / bounded_frame_rate).max(1))
}

#[tauri::command]
pub async fn start_recording(
    app_handle: AppHandle,
    state: tauri::State<'_, SharedRecordingState>,
    settings: crate::settings::RecordingSettings,
    output_folder: String,
    max_storage_bytes: u64,
    capture_source: String,
    selected_window: Option<String>,
) -> Result<RecordingStartedPayload, String> {
    let mut recording_state = state.write().await;

    if recording_state.is_recording {
        return Err("Recording already in progress".to_string());
    }

    std::fs::create_dir_all(&output_folder)
        .map_err(|e| format!("Failed to create output directory: {}", e))?;

    let (capture_target, width, height) =
        resolve_capture_target(capture_source.as_str(), selected_window.as_deref())?;

    let effective_bitrate = settings.effective_bitrate(width, height);
    let estimated_size = settings.estimate_size_bytes_for_capture(width, height);

    tracing::info!(
        video_quality = %settings.video_quality,
        frame_rate = settings.frame_rate,
        capture_width = width,
        capture_height = height,
        requested_bitrate_bps = settings.bitrate,
        effective_bitrate_bps = effective_bitrate,
        "Using adaptive recording bitrate"
    );

    let current_size = crate::settings::get_folder_size(output_folder.clone())?;

    if current_size + estimated_size > max_storage_bytes {
        let cleanup_result = crate::settings::cleanup_old_recordings(
            output_folder.clone(),
            max_storage_bytes,
            estimated_size,
        )?;

        if cleanup_result.deleted_count > 0 {
            let _ = app_handle.emit("storage-cleanup", cleanup_result);
        }
    }

    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let filename = format!("recording_{}.mp4", timestamp);
    let output_path = std::path::Path::new(&output_folder).join(filename);
    let output_path_str = output_path.to_string_lossy().to_string();

    let mut recording_settings = settings;
    recording_settings.bitrate = effective_bitrate;
    let minimum_update_interval =
        minimum_update_interval_for_frame_rate(recording_settings.frame_rate);

    let (stop_tx, stop_rx) = mpsc::channel(1);

    recording_state.is_recording = true;
    recording_state.current_output_path = Some(output_path_str.clone());
    recording_state.stop_tx = Some(stop_tx);

    let shared_state = state.inner().clone();
    let app_handle_for_task = app_handle.clone();

    match capture_target {
        CaptureTarget::Monitor(monitor) => {
            let capture_settings = Settings::new(
                monitor,
                CursorCaptureSettings::Default,
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Custom(minimum_update_interval),
                DirtyRegionSettings::ReportAndRender,
                ColorFormat::Bgra8,
                (
                    output_path_str.clone(),
                    width,
                    height,
                    recording_settings,
                    app_handle.clone(),
                    stop_rx,
                    state.inner().clone(),
                ),
            );

            tokio::spawn(async move {
                if let Err(e) = RecordingHandler::start(capture_settings) {
                    tracing::error!("Recording error: {e}");
                    if let Ok(mut recording_state) = shared_state.try_write() {
                        recording_state.is_recording = false;
                        recording_state.current_output_path = None;
                        recording_state.stop_tx = None;
                    }
                    let _ = app_handle_for_task.emit("recording-stopped", ());
                }
            });
        }
        CaptureTarget::Window(window) => {
            let capture_settings = Settings::new(
                window,
                CursorCaptureSettings::Default,
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Custom(minimum_update_interval),
                DirtyRegionSettings::ReportAndRender,
                ColorFormat::Bgra8,
                (
                    output_path_str.clone(),
                    width,
                    height,
                    recording_settings,
                    app_handle.clone(),
                    stop_rx,
                    state.inner().clone(),
                ),
            );

            tokio::spawn(async move {
                if let Err(e) = RecordingHandler::start(capture_settings) {
                    tracing::error!("Recording error: {e}");
                    if let Ok(mut recording_state) = shared_state.try_write() {
                        recording_state.is_recording = false;
                        recording_state.current_output_path = None;
                        recording_state.stop_tx = None;
                    }
                    let _ = app_handle_for_task.emit("recording-stopped", ());
                }
            });
        }
    }

    Ok(RecordingStartedPayload {
        output_path: output_path_str,
        width,
        height,
    })
}

#[tauri::command]
pub async fn stop_recording(
    state: tauri::State<'_, SharedRecordingState>,
) -> Result<String, String> {
    let mut recording_state = state.write().await;

    if !recording_state.is_recording {
        return Err("No active recording to stop".to_string());
    }

    let output_path = recording_state
        .current_output_path
        .clone()
        .ok_or("No output path found")?;

    recording_state.is_recording = false;

    if let Some(stop_tx) = recording_state.stop_tx.take() {
        let _ = stop_tx.send(()).await;
    }

    Ok(output_path)
}
