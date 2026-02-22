use base64::Engine;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, RwLock};
use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    encoder::{ImageEncoder, ImageEncoderPixelFormat, ImageFormat},
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
pub struct CaptureStartedPayload {
    width: u32,
    height: u32,
    source: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFramePayload {
    data_base64: String,
}

struct PreviewCaptureHandler {
    app_handle: AppHandle,
    encoder: ImageEncoder,
    buffer: Vec<u8>,
    stop_rx: mpsc::Receiver<()>,
    state: SharedCaptureState,
}

impl GraphicsCaptureApiHandler for PreviewCaptureHandler {
    type Flags = (AppHandle, mpsc::Receiver<()>, SharedCaptureState);
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(context: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let encoder = ImageEncoder::new(ImageFormat::Jpeg, ImageEncoderPixelFormat::Bgra8)?;
        Ok(Self {
            app_handle: context.flags.0,
            encoder,
            buffer: Vec::new(),
            stop_rx: context.flags.1,
            state: context.flags.2,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        // Check if stop signal was received
        if self.stop_rx.try_recv().is_ok() {
            capture_control.stop();
            return Ok(());
        }

        let width = frame.width();
        let height = frame.height();

        let mut frame_buffer = frame.buffer()?;

        let pixels: &[u8] = if frame_buffer.has_padding() {
            let bytes_per_pixel = match frame_buffer.color_format() {
                ColorFormat::Rgba16F => 8usize,
                ColorFormat::Rgba8 | ColorFormat::Bgra8 => 4usize,
            };

            let width_usize = width as usize;
            let height_usize = height as usize;
            let row_bytes = width_usize * bytes_per_pixel;
            let row_pitch = frame_buffer.row_pitch() as usize;

            if row_bytes > row_pitch {
                return Err(std::io::Error::other("Invalid frame row pitch for preview").into());
            }

            let frame_size = row_bytes * height_usize;
            self.buffer.resize(frame_size, 0);

            let raw_buffer = frame_buffer.as_raw_buffer();

            for row in 0..height_usize {
                let source_start = row * row_pitch;
                let source_end = source_start + row_bytes;
                let target_start = row * row_bytes;
                let target_end = target_start + row_bytes;

                if source_end > raw_buffer.len() || target_end > self.buffer.len() {
                    return Err(
                        std::io::Error::other("Invalid frame buffer bounds for preview").into(),
                    );
                }

                self.buffer[target_start..target_end]
                    .copy_from_slice(&raw_buffer[source_start..source_end]);
            }

            &self.buffer
        } else {
            frame_buffer.as_raw_buffer()
        };

        let jpeg_bytes = self.encoder.encode(pixels, width, height)?;
        let data_base64 = base64::engine::general_purpose::STANDARD.encode(jpeg_bytes);

        self.app_handle
            .emit("preview-frame", PreviewFramePayload { data_base64 })?;

        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        if let Ok(mut capture_state) = self.state.try_write() {
            capture_state.is_capturing = false;
            capture_state.stop_tx = None;
        }
        self.app_handle.emit("capture-stopped", ())?;
        Ok(())
    }
}

pub struct CaptureState {
    is_capturing: bool,
    stop_tx: Option<mpsc::Sender<()>>,
}

impl CaptureState {
    pub fn new() -> Self {
        Self {
            is_capturing: false,
            stop_tx: None,
        }
    }
}

pub type SharedCaptureState = Arc<RwLock<CaptureState>>;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowOptionPayload {
    id: String,
    title: String,
    process_name: Option<String>,
}

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
) -> Result<(CaptureTarget, u32, u32, String), String> {
    match capture_source {
        "primary-monitor" => {
            let monitor = Monitor::primary().map_err(|error| error.to_string())?;
            let width = monitor.width().map_err(|error| error.to_string())?;
            let height = monitor.height().map_err(|error| error.to_string())?;

            Ok((
                CaptureTarget::Monitor(monitor),
                width,
                height,
                "Primary Monitor".to_string(),
            ))
        }
        "window" => {
            let selected_value = selected_window
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("Select a window before starting preview".to_string())?;

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

            Ok((
                CaptureTarget::Window(window),
                width as u32,
                height as u32,
                format!("Window: {window_name}"),
            ))
        }
        _ => Err(format!("Unsupported capture source: {capture_source}")),
    }
}

fn list_capturable_windows_internal() -> Result<Vec<WindowOptionPayload>, String> {
    let windows = Window::enumerate().map_err(|error| error.to_string())?;

    let mut window_options: Vec<WindowOptionPayload> = windows
        .into_iter()
        .filter_map(|window| {
            if !window.is_valid() {
                return None;
            }

            match window.title() {
                Ok(title) => {
                    let trimmed = title.trim();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(WindowOptionPayload {
                            id: window_id(&window),
                            title: trimmed.to_string(),
                            process_name: window.process_name().ok(),
                        })
                    }
                }
                Err(_) => None,
            }
        })
        .collect();

    window_options.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    window_options.dedup_by(|a, b| a.id == b.id);

    Ok(window_options)
}

#[tauri::command]
pub async fn start_preview(
    app_handle: AppHandle,
    state: tauri::State<'_, SharedCaptureState>,
    capture_source: String,
    selected_window: Option<String>,
) -> Result<CaptureStartedPayload, String> {
    let mut capture_state = state.write().await;

    if capture_state.is_capturing {
        return Err("Capture already in progress".to_string());
    }

    let (capture_target, width, height, source_label) =
        resolve_capture_target(capture_source.as_str(), selected_window.as_deref())?;

    // Create channel for stop signal
    let (stop_tx, stop_rx) = mpsc::channel(1);

    capture_state.is_capturing = true;
    capture_state.stop_tx = Some(stop_tx);

    let shared_state = state.inner().clone();
    let app_handle_for_task = app_handle.clone();

    match capture_target {
        CaptureTarget::Monitor(monitor) => {
            let settings = Settings::new(
                monitor,
                CursorCaptureSettings::Default,
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                (app_handle.clone(), stop_rx, state.inner().clone()),
            );

            tokio::spawn(async move {
                if let Err(e) = PreviewCaptureHandler::start(settings) {
                    tracing::error!("Capture error: {e}");
                    if let Ok(mut capture_state) = shared_state.try_write() {
                        capture_state.is_capturing = false;
                        capture_state.stop_tx = None;
                    }
                    let _ = app_handle_for_task.emit("capture-stopped", ());
                }
            });
        }
        CaptureTarget::Window(window) => {
            let settings = Settings::new(
                window,
                CursorCaptureSettings::Default,
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                (app_handle.clone(), stop_rx, state.inner().clone()),
            );

            tokio::spawn(async move {
                if let Err(e) = PreviewCaptureHandler::start(settings) {
                    tracing::error!("Capture error: {e}");
                    if let Ok(mut capture_state) = shared_state.try_write() {
                        capture_state.is_capturing = false;
                        capture_state.stop_tx = None;
                    }
                    let _ = app_handle_for_task.emit("capture-stopped", ());
                }
            });
        }
    }

    Ok(CaptureStartedPayload {
        width,
        height,
        source: source_label,
    })
}

#[tauri::command]
pub async fn stop_preview(state: tauri::State<'_, SharedCaptureState>) -> Result<(), String> {
    let mut capture_state = state.write().await;

    if !capture_state.is_capturing {
        return Err("No active capture to stop".to_string());
    }

    capture_state.is_capturing = false;

    // Send stop signal to the capture handler
    if let Some(stop_tx) = capture_state.stop_tx.take() {
        let _ = stop_tx.send(()).await;
    }

    Ok(())
}

#[tauri::command]
pub async fn list_windows() -> Result<Vec<WindowOptionPayload>, String> {
    list_capturable_windows_internal()
}
