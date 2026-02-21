use std::sync::Arc;
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
        ColorFormat, CursorCaptureSettings, DrawBorderSettings, 
        DirtyRegionSettings, MinimumUpdateIntervalSettings, 
        SecondaryWindowSettings, Settings
    },
};

#[derive(Clone, serde::Serialize)]
pub struct RecordingStartedPayload {
    output_path: String,
    width: u32,
    height: u32,
}

struct RecordingHandler {
    app_handle: AppHandle,
    encoder: Option<VideoEncoder>,
    stop_rx: mpsc::Receiver<()>,
    state: SharedRecordingState,
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
            encoder: Some(encoder),
            stop_rx,
            state,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.stop_rx.try_recv().is_ok() {
            if let Some(encoder) = self.encoder.take() {
                encoder.finish()?;
            }
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
            encoder.finish()?;
        }
        if let Ok(mut recording_state) = self.state.try_write() {
            recording_state.is_recording = false;
            recording_state.current_output_path = None;
            recording_state.stop_tx = None;
        }
        self.app_handle.emit("recording-stopped", ())?;
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

    let current_size = crate::settings::get_folder_size(output_folder.clone())?;
    let estimated_size = settings.estimate_size_bytes();
    
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

    let monitor = match capture_source.as_str() {
        "primary-monitor" => Monitor::primary().map_err(|e| e.to_string())?,
        "window" => {
            let window_name = selected_window.unwrap_or_else(|| "selected window".to_string());
            return Err(format!(
                "Window capture is not implemented yet (requested: {}). Use Primary Monitor.",
                window_name
            ));
        }
        _ => return Err(format!("Unsupported capture source: {}", capture_source)),
    };

    let width = monitor.width().map_err(|e| e.to_string())?;
    let height = monitor.height().map_err(|e| e.to_string())?;

    let (stop_tx, stop_rx) = mpsc::channel(1);

    recording_state.is_recording = true;
    recording_state.current_output_path = Some(output_path_str.clone());
    recording_state.stop_tx = Some(stop_tx);

    let capture_settings = Settings::new(
        monitor,
        CursorCaptureSettings::Default,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        (
            output_path_str.clone(),
            width,
            height,
            settings,
            app_handle.clone(),
            stop_rx,
            state.inner().clone(),
        ),
    );

    let shared_state = state.inner().clone();

    tokio::spawn(async move {
        if let Err(e) = RecordingHandler::start(capture_settings) {
            eprintln!("Recording error: {}", e);
            if let Ok(mut recording_state) = shared_state.try_write() {
                recording_state.is_recording = false;
                recording_state.current_output_path = None;
                recording_state.stop_tx = None;
            }
            let _ = app_handle.emit("recording-stopped", ());
        }
    });

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

    if let Some(stop_tx) = recording_state.stop_tx.take() {
        let _ = stop_tx.send(()).await;
    }

    Ok(output_path)
}
