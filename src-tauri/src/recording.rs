use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::error::TryRecvError;
use tokio::sync::{mpsc, RwLock};
use wasapi::{initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, POINT, RECT};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Gdi::{
    ClientToScreen, EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, HDC, HMONITOR,
    MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClientRect, GetWindow, GetWindowLongW, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, GWL_EXSTYLE, GW_OWNER,
    WS_EX_TOOLWINDOW,
};

#[derive(Clone, serde::Serialize)]
pub struct RecordingStartedPayload {
    output_path: String,
    width: u32,
    height: u32,
}

#[derive(Clone, serde::Serialize)]
pub struct CaptureWindowInfo {
    hwnd: String,
    title: String,
}

#[derive(Clone)]
enum CaptureInput {
    Monitor,
    Window {
        input_target: String,
        window_hwnd: Option<usize>,
        window_title: Option<String>,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WindowCaptureAvailability {
    Available,
    Minimized,
    Closed,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RuntimeCaptureMode {
    Monitor,
    Window,
    Black,
}

enum SegmentTransition {
    Stop,
    Switch(RuntimeCaptureMode),
    RestartSameMode,
}

struct SegmentRunResult {
    transition: SegmentTransition,
    ffmpeg_succeeded: bool,
    output_written: bool,
}

#[derive(Clone, Copy)]
struct WindowCaptureRegion {
    output_idx: u32,
    offset_x: i32,
    offset_y: i32,
    width: u32,
    height: u32,
}

#[cfg(target_os = "windows")]
struct MonitorIndexSearchState {
    target_monitor: HMONITOR,
    current_index: u32,
    found_index: Option<u32>,
}

const FFMPEG_RESOURCE_PATH: &str = "bin/ffmpeg.exe";
const FFMPEG_STOP_TIMEOUT: Duration = Duration::from_secs(5);
const SYSTEM_AUDIO_SAMPLE_RATE_HZ: usize = 48_000;
const SYSTEM_AUDIO_CHANNEL_COUNT: usize = 2;
const SYSTEM_AUDIO_BITS_PER_SAMPLE: usize = 16;
const SYSTEM_AUDIO_CHUNK_FRAMES: usize = 960;
const SYSTEM_AUDIO_EVENT_TIMEOUT_MS: u32 = 500;
const AUDIO_TCP_ACCEPT_WAIT_MS: u64 = 25;
const SYSTEM_AUDIO_QUEUE_CAPACITY: usize = 256;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const WINDOW_CAPTURE_STATUS_POLL_INTERVAL: Duration = Duration::from_millis(500);
const WINDOW_CAPTURE_MINIMIZED_WARNING: &str = "Selected window is minimized. Recording continues, but the video may be black until the window is restored.";
const WINDOW_CAPTURE_CLOSED_WARNING: &str = "Selected window is unavailable or closed. Recording continues, but the video may be black until the window is available again.";
const DEFAULT_CAPTURE_WIDTH: u32 = 1920;
const DEFAULT_CAPTURE_HEIGHT: u32 = 1080;
const MIN_CAPTURE_DIMENSION: u32 = 2;

#[derive(Default)]
struct AudioPipelineStats {
    queued_chunks: AtomicU64,
    dequeued_chunks: AtomicU64,
    dropped_chunks: AtomicU64,
    write_timeouts: AtomicU64,
}

pub struct RecordingState {
    is_recording: bool,
    is_stopping: bool,
    current_output_path: Option<String>,
    stop_tx: Option<mpsc::Sender<()>>,
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

fn normalize_optional_setting(value: Option<&String>) -> Option<String> {
    value
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
}

fn parse_window_handle(raw_hwnd: &str) -> Option<usize> {
    raw_hwnd
        .trim()
        .parse::<usize>()
        .ok()
        .filter(|hwnd| *hwnd != 0)
}

fn normalize_capture_dimension(value: u32) -> u32 {
    let mut normalized = value.max(MIN_CAPTURE_DIMENSION);
    if normalized % 2 != 0 {
        normalized = normalized.saturating_sub(1);
    }
    normalized.max(MIN_CAPTURE_DIMENSION)
}

fn sanitize_capture_dimensions(width: u32, height: u32) -> (u32, u32) {
    (
        normalize_capture_dimension(width),
        normalize_capture_dimension(height),
    )
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn find_monitor_index_callback(
    monitor: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let state = &mut *(lparam as *mut MonitorIndexSearchState);
    if monitor == state.target_monitor {
        state.found_index = Some(state.current_index);
        return 0;
    }

    state.current_index = state.current_index.saturating_add(1);
    1
}

#[cfg(target_os = "windows")]
fn find_monitor_index(target_monitor: HMONITOR) -> Option<u32> {
    let mut state = MonitorIndexSearchState {
        target_monitor,
        current_index: 0,
        found_index: None,
    };

    let callback_result = unsafe {
        EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(find_monitor_index_callback),
            (&mut state as *mut MonitorIndexSearchState) as LPARAM,
        )
    };

    if callback_result == 0 && state.found_index.is_none() {
        return None;
    }

    state.found_index
}

#[cfg(target_os = "windows")]
fn find_window_handle_by_title(window_title: &str) -> Option<usize> {
    let available_windows = list_capture_windows_internal().ok()?;
    available_windows
        .iter()
        .find(|window| window.title == window_title)
        .and_then(|window| parse_window_handle(&window.hwnd))
}

#[cfg(target_os = "windows")]
fn resolve_window_handle(capture_input: &CaptureInput) -> Option<usize> {
    match capture_input {
        CaptureInput::Window {
            window_hwnd: Some(window_hwnd),
            window_title,
            ..
        } => {
            if evaluate_window_capture_by_hwnd(*window_hwnd) != WindowCaptureAvailability::Closed {
                Some(*window_hwnd)
            } else {
                window_title
                    .as_ref()
                    .and_then(|title| find_window_handle_by_title(title))
            }
        }
        CaptureInput::Window {
            window_title: Some(window_title),
            ..
        } => find_window_handle_by_title(window_title),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn window_client_rect_in_screen(window_hwnd: HWND) -> Option<RECT> {
    let mut client_rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };

    if unsafe { GetClientRect(window_hwnd, &mut client_rect as *mut RECT) } == 0 {
        return None;
    }

    let mut top_left = POINT {
        x: client_rect.left,
        y: client_rect.top,
    };
    let mut bottom_right = POINT {
        x: client_rect.right,
        y: client_rect.bottom,
    };

    if unsafe { ClientToScreen(window_hwnd, &mut top_left as *mut POINT) } == 0 {
        return None;
    }
    if unsafe { ClientToScreen(window_hwnd, &mut bottom_right as *mut POINT) } == 0 {
        return None;
    }

    if bottom_right.x <= top_left.x || bottom_right.y <= top_left.y {
        return None;
    }

    Some(RECT {
        left: top_left.x,
        top: top_left.y,
        right: bottom_right.x,
        bottom: bottom_right.y,
    })
}

#[cfg(target_os = "windows")]
fn resolve_window_capture_region(
    capture_input: &CaptureInput,
) -> Result<WindowCaptureRegion, String> {
    let window_hwnd = resolve_window_handle(capture_input)
        .ok_or_else(|| "Failed to resolve selected window handle".to_string())?;
    let hwnd = to_window_handle(window_hwnd);

    if unsafe { IsWindow(hwnd) } == 0 {
        return Err("Selected window is no longer valid".to_string());
    }

    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_null() {
        return Err("Failed to resolve monitor for selected window".to_string());
    }

    let output_idx = find_monitor_index(monitor).ok_or_else(|| {
        "Failed to map selected window monitor to capture output index".to_string()
    })?;

    let mut monitor_info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        rcMonitor: RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        },
        rcWork: RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        },
        dwFlags: 0,
    };
    if unsafe { GetMonitorInfoW(monitor, &mut monitor_info as *mut MONITORINFO) } == 0 {
        return Err("Failed to read monitor information for selected window".to_string());
    }

    let client_rect = window_client_rect_in_screen(hwnd)
        .ok_or_else(|| "Failed to read selected window bounds".to_string())?;

    let capture_left = client_rect.left.max(monitor_info.rcMonitor.left);
    let capture_top = client_rect.top.max(monitor_info.rcMonitor.top);
    let capture_right = client_rect.right.min(monitor_info.rcMonitor.right);
    let capture_bottom = client_rect.bottom.min(monitor_info.rcMonitor.bottom);

    if capture_right <= capture_left || capture_bottom <= capture_top {
        return Err("Selected window has no capturable area".to_string());
    }

    let raw_width = (capture_right - capture_left) as u32;
    let raw_height = (capture_bottom - capture_top) as u32;
    let (width, height) = sanitize_capture_dimensions(raw_width, raw_height);

    let offset_x = capture_left - monitor_info.rcMonitor.left;
    let offset_y = capture_top - monitor_info.rcMonitor.top;

    Ok(WindowCaptureRegion {
        output_idx,
        offset_x,
        offset_y,
        width,
        height,
    })
}

#[cfg(not(target_os = "windows"))]
fn resolve_window_capture_region(
    _capture_input: &CaptureInput,
) -> Result<WindowCaptureRegion, String> {
    Err("Window capture regions are only supported on Windows".to_string())
}

fn to_runtime_capture_mode(capture_input: &CaptureInput) -> RuntimeCaptureMode {
    match capture_input {
        CaptureInput::Monitor => RuntimeCaptureMode::Monitor,
        CaptureInput::Window { .. } => RuntimeCaptureMode::Window,
    }
}

fn runtime_capture_label(runtime_capture_mode: RuntimeCaptureMode) -> &'static str {
    match runtime_capture_mode {
        RuntimeCaptureMode::Monitor => "monitor",
        RuntimeCaptureMode::Window => "window",
        RuntimeCaptureMode::Black => "black",
    }
}

fn is_expected_audio_disconnect_error(error: &str) -> bool {
    error.contains("os error 10053")
        || error.contains("Broken pipe")
        || error.contains("connection reset")
}

fn create_segment_workspace(output_path: &str) -> Result<PathBuf, String> {
    let output = PathBuf::from(output_path);
    let parent = output
        .parent()
        .ok_or_else(|| "Output path does not have a parent directory".to_string())?;
    let stem = output
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("recording");
    let unique_suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let workspace = parent.join(format!(".{stem}_segments_{unique_suffix}"));
    fs::create_dir_all(&workspace)
        .map_err(|error| format!("Failed to create recording segment workspace: {error}"))?;
    Ok(workspace)
}

fn build_segment_output_path(segment_workspace: &Path, index: usize) -> PathBuf {
    segment_workspace.join(format!("segment_{index:04}.mp4"))
}

fn concat_file_path(segment_workspace: &Path) -> PathBuf {
    segment_workspace.join("segments.txt")
}

fn format_concat_entry(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let escaped = normalized.replace('\'', "\\'");
    format!("file '{escaped}'\n")
}

fn write_concat_file(
    segment_workspace: &Path,
    segment_paths: &[PathBuf],
) -> Result<PathBuf, String> {
    let concat_path = concat_file_path(segment_workspace);
    let mut contents = String::new();
    for segment_path in segment_paths {
        contents.push_str(&format_concat_entry(segment_path));
    }

    fs::write(&concat_path, contents)
        .map_err(|error| format!("Failed to write FFmpeg concat file: {error}"))?;

    Ok(concat_path)
}

fn move_segment_to_final_output(segment_path: &Path, output_path: &str) -> Result<(), String> {
    let output = PathBuf::from(output_path);

    if output.exists() {
        fs::remove_file(&output)
            .map_err(|error| format!("Failed to replace existing output recording: {error}"))?;
    }

    match fs::rename(segment_path, &output) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            fs::copy(segment_path, &output).map_err(|copy_error| {
                format!(
                    "Failed to move final segment into output recording. rename error: {rename_error}; copy error: {copy_error}"
                )
            })?;
            fs::remove_file(segment_path).map_err(|remove_error| {
                format!("Failed to remove copied segment file after fallback copy: {remove_error}")
            })?;
            Ok(())
        }
    }
}

fn finalize_segmented_recording(
    ffmpeg_binary_path: &Path,
    segment_workspace: &Path,
    segment_paths: &[PathBuf],
    output_path: &str,
) -> Result<(), String> {
    if segment_paths.is_empty() {
        return Err("No recording segments were produced".to_string());
    }

    if segment_paths.len() == 1 {
        return move_segment_to_final_output(&segment_paths[0], output_path);
    }

    let concat_path = write_concat_file(segment_workspace, segment_paths)?;

    let mut command = Command::new(ffmpeg_binary_path);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let status = command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("warning")
        .arg("-y")
        .arg("-f")
        .arg("concat")
        .arg("-safe")
        .arg("0")
        .arg("-i")
        .arg(&concat_path)
        .arg("-c")
        .arg("copy")
        .arg("-movflags")
        .arg("+faststart")
        .arg(output_path)
        .status()
        .map_err(|error| format!("Failed to start FFmpeg concat process: {error}"))?;

    if !status.success() {
        return Err(format!(
            "FFmpeg concat process failed with status: {status}"
        ));
    }

    Ok(())
}

fn cleanup_segment_workspace(segment_workspace: &Path) {
    if let Err(error) = fs::remove_dir_all(segment_workspace) {
        tracing::warn!(
            segment_workspace = %segment_workspace.display(),
            "Failed to remove recording segment workspace: {error}"
        );
    }
}

#[cfg(target_os = "windows")]
fn resolve_capture_dimensions(capture_input: &CaptureInput) -> (u32, u32) {
    if let CaptureInput::Window { .. } = capture_input {
        if let Ok(region) = resolve_window_capture_region(capture_input) {
            return (region.width, region.height);
        }

        if evaluate_window_capture_availability(capture_input)
            != WindowCaptureAvailability::Available
        {
            return (DEFAULT_CAPTURE_WIDTH, DEFAULT_CAPTURE_HEIGHT);
        }
    }

    sanitize_capture_dimensions(DEFAULT_CAPTURE_WIDTH, DEFAULT_CAPTURE_HEIGHT)
}

#[cfg(not(target_os = "windows"))]
fn resolve_capture_dimensions(_capture_input: &CaptureInput) -> (u32, u32) {
    sanitize_capture_dimensions(DEFAULT_CAPTURE_WIDTH, DEFAULT_CAPTURE_HEIGHT)
}

#[cfg(target_os = "windows")]
fn to_window_handle(window_hwnd: usize) -> HWND {
    window_hwnd as isize as HWND
}

#[cfg(target_os = "windows")]
fn evaluate_window_capture_by_hwnd(window_hwnd: usize) -> WindowCaptureAvailability {
    let hwnd = to_window_handle(window_hwnd);
    if unsafe { IsWindow(hwnd) } == 0 {
        return WindowCaptureAvailability::Closed;
    }

    if unsafe { IsIconic(hwnd) } != 0 {
        return WindowCaptureAvailability::Minimized;
    }

    WindowCaptureAvailability::Available
}

#[cfg(target_os = "windows")]
fn evaluate_window_capture_by_title(window_title: &str) -> WindowCaptureAvailability {
    let available_windows = match list_capture_windows_internal() {
        Ok(windows) => windows,
        Err(error) => {
            tracing::debug!(
                error,
                "Failed to enumerate windows while checking capture warning state"
            );
            return WindowCaptureAvailability::Available;
        }
    };

    let mut found_minimized_window = false;

    for capture_window in available_windows
        .iter()
        .filter(|window| window.title == window_title)
    {
        let Some(window_hwnd) = parse_window_handle(&capture_window.hwnd) else {
            continue;
        };

        match evaluate_window_capture_by_hwnd(window_hwnd) {
            WindowCaptureAvailability::Available => return WindowCaptureAvailability::Available,
            WindowCaptureAvailability::Minimized => {
                found_minimized_window = true;
            }
            WindowCaptureAvailability::Closed => {}
        }
    }

    if found_minimized_window {
        WindowCaptureAvailability::Minimized
    } else {
        WindowCaptureAvailability::Closed
    }
}

#[cfg(target_os = "windows")]
fn evaluate_window_capture_availability(capture_input: &CaptureInput) -> WindowCaptureAvailability {
    match capture_input {
        CaptureInput::Window {
            window_hwnd: Some(window_hwnd),
            window_title,
            ..
        } => {
            let availability = evaluate_window_capture_by_hwnd(*window_hwnd);
            if availability == WindowCaptureAvailability::Closed {
                if let Some(window_title) = window_title {
                    return evaluate_window_capture_by_title(window_title);
                }
            }
            availability
        }
        CaptureInput::Window {
            window_title: Some(window_title),
            ..
        } => evaluate_window_capture_by_title(window_title),
        CaptureInput::Window { .. } => WindowCaptureAvailability::Closed,
        CaptureInput::Monitor => WindowCaptureAvailability::Available,
    }
}

#[cfg(not(target_os = "windows"))]
fn evaluate_window_capture_availability(
    _capture_input: &CaptureInput,
) -> WindowCaptureAvailability {
    WindowCaptureAvailability::Available
}

fn warning_message_for_window_capture(
    capture_availability: WindowCaptureAvailability,
) -> Option<&'static str> {
    match capture_availability {
        WindowCaptureAvailability::Available => None,
        WindowCaptureAvailability::Minimized => Some(WINDOW_CAPTURE_MINIMIZED_WARNING),
        WindowCaptureAvailability::Closed => Some(WINDOW_CAPTURE_CLOSED_WARNING),
    }
}

fn append_capture_input_args(
    command: &mut Command,
    capture_input: &CaptureInput,
    requested_frame_rate: u32,
) {
    match capture_input {
        CaptureInput::Monitor => {
            command
                .arg("-f")
                .arg("lavfi")
                .arg("-i")
                .arg(format!(
                    "ddagrab=output_idx=0:framerate={requested_frame_rate}:draw_mouse=1,hwdownload,format=bgra"
                ));
        }
        CaptureInput::Window { .. } => {
            command
                .arg("-f")
                .arg("lavfi")
                .arg("-i")
                .arg(format!(
                    "ddagrab=output_idx=0:framerate={requested_frame_rate}:draw_mouse=1,hwdownload,format=bgra"
                ));
        }
    }
}

fn append_window_capture_input_args(
    command: &mut Command,
    requested_frame_rate: u32,
    region: WindowCaptureRegion,
) {
    command.arg("-f").arg("lavfi").arg("-i").arg(format!(
        "ddagrab=output_idx={}:framerate={requested_frame_rate}:draw_mouse=1:offset_x={}:offset_y={}:video_size={}x{},hwdownload,format=bgra",
        region.output_idx, region.offset_x, region.offset_y, region.width, region.height
    ));
}

fn resolve_capture_input(
    settings: &crate::settings::RecordingSettings,
) -> Result<CaptureInput, String> {
    match settings.capture_source.as_str() {
        "monitor" => Ok(CaptureInput::Monitor),
        "window" => {
            let requested_hwnd = normalize_optional_setting(settings.capture_window_hwnd.as_ref());
            let requested_title =
                normalize_optional_setting(settings.capture_window_title.as_ref());

            if requested_hwnd.is_none() && requested_title.is_none() {
                return Err(
                    "Select a window in Settings before starting a window capture recording."
                        .to_string(),
                );
            }

            let available_windows = list_capture_windows_internal()
                .map_err(|error| format!("Failed to list capturable windows: {error}"))?;

            if let Some(hwnd) = requested_hwnd {
                if available_windows.iter().any(|window| window.hwnd == hwnd) {
                    return Ok(CaptureInput::Window {
                        input_target: format!("hwnd={hwnd}"),
                        window_hwnd: parse_window_handle(&hwnd),
                        window_title: requested_title.clone(),
                    });
                }

                if let Some(title) = requested_title.clone() {
                    if let Some(matching_window) = available_windows
                        .iter()
                        .find(|window| window.title == title)
                    {
                        tracing::info!(
                            requested_hwnd = %hwnd,
                            recovered_hwnd = %matching_window.hwnd,
                            window_title = %title,
                            "Recovered selected capture window from saved title"
                        );
                        return Ok(CaptureInput::Window {
                            input_target: format!("hwnd={}", matching_window.hwnd),
                            window_hwnd: parse_window_handle(&matching_window.hwnd),
                            window_title: Some(title),
                        });
                    }

                    tracing::warn!(
                        requested_hwnd = %hwnd,
                        window_title = %title,
                        "Selected window handle is stale; falling back to title capture"
                    );
                    return Ok(CaptureInput::Window {
                        input_target: format!("title={title}"),
                        window_hwnd: None,
                        window_title: Some(title),
                    });
                }

                return Err(
                    "The selected window is no longer available. Open Settings and choose another window."
                        .to_string(),
                );
            }

            if let Some(title) = requested_title {
                if let Some(matching_window) = available_windows
                    .iter()
                    .find(|window| window.title == title)
                {
                    return Ok(CaptureInput::Window {
                        input_target: format!("hwnd={}", matching_window.hwnd),
                        window_hwnd: parse_window_handle(&matching_window.hwnd),
                        window_title: Some(title),
                    });
                }

                return Ok(CaptureInput::Window {
                    input_target: format!("title={title}"),
                    window_hwnd: None,
                    window_title: Some(title),
                });
            }

            Err(
                "Select a window in Settings before starting a window capture recording."
                    .to_string(),
            )
        }
        other => {
            tracing::warn!(
                capture_source = %other,
                "Unknown capture source value. Falling back to primary monitor capture"
            );
            Ok(CaptureInput::Monitor)
        }
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn collect_capture_windows_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if IsWindowVisible(hwnd) == 0 {
        return 1;
    }

    if !GetWindow(hwnd, GW_OWNER).is_null() {
        return 1;
    }

    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if ex_style & WS_EX_TOOLWINDOW != 0 {
        return 1;
    }

    let mut process_id: u32 = 0;
    GetWindowThreadProcessId(hwnd, &mut process_id as *mut u32);
    if process_id == std::process::id() {
        return 1;
    }

    let title_length = GetWindowTextLengthW(hwnd);
    if title_length <= 0 {
        return 1;
    }

    let mut title_buffer = vec![0u16; (title_length + 1) as usize];
    let copied_length = GetWindowTextW(hwnd, title_buffer.as_mut_ptr(), title_length + 1);
    if copied_length <= 0 {
        return 1;
    }

    let title = String::from_utf16_lossy(&title_buffer[..copied_length as usize])
        .trim()
        .to_string();
    if title.is_empty() {
        return 1;
    }

    let capture_windows = &mut *(lparam as *mut Vec<CaptureWindowInfo>);
    capture_windows.push(CaptureWindowInfo {
        hwnd: (hwnd as usize).to_string(),
        title,
    });

    1
}

#[cfg(target_os = "windows")]
fn list_capture_windows_internal() -> Result<Vec<CaptureWindowInfo>, String> {
    let mut capture_windows: Vec<CaptureWindowInfo> = Vec::new();
    let callback_result = unsafe {
        EnumWindows(
            Some(collect_capture_windows_callback),
            (&mut capture_windows as *mut Vec<CaptureWindowInfo>) as LPARAM,
        )
    };

    if callback_result == 0 {
        return Err("Windows API returned an error while enumerating windows".to_string());
    }

    capture_windows.sort_by(|left, right| {
        left.title
            .to_lowercase()
            .cmp(&right.title.to_lowercase())
            .then_with(|| left.hwnd.cmp(&right.hwnd))
    });

    Ok(capture_windows)
}

#[cfg(not(target_os = "windows"))]
fn list_capture_windows_internal() -> Result<Vec<CaptureWindowInfo>, String> {
    Err("Window capture is only supported on Windows.".to_string())
}

#[tauri::command]
pub fn list_capture_windows() -> Result<Vec<CaptureWindowInfo>, String> {
    list_capture_windows_internal()
}

fn resolve_ffmpeg_binary_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(resource_path) = app_handle
        .path()
        .resolve(FFMPEG_RESOURCE_PATH, BaseDirectory::Resource)
    {
        candidates.push(resource_path);
    }

    let manifest_candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bin")
        .join("ffmpeg.exe");
    candidates.push(manifest_candidate.clone());

    if let Ok(current_executable) = std::env::current_exe() {
        if let Some(executable_directory) = current_executable.parent() {
            candidates.push(executable_directory.join("ffmpeg.exe"));
            candidates.push(
                executable_directory
                    .join("resources")
                    .join("bin")
                    .join("ffmpeg.exe"),
            );
        }
    }

    if let Some(found_path) = candidates.into_iter().find(|path| path.exists()) {
        return Ok(found_path);
    }

    Err(format!(
        "FFmpeg binary was not found. Place ffmpeg.exe at '{}' or rebuild the app so bundled resources are available.",
        manifest_candidate.display()
    ))
}

fn select_video_encoder(ffmpeg_binary_path: &Path) -> (String, Option<String>) {
    let mut command = Command::new(ffmpeg_binary_path);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .arg("-hide_banner")
        .arg("-encoders")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();

    let encoders_output = match output {
        Ok(result) => String::from_utf8(result.stdout)
            .unwrap_or_default()
            .to_lowercase(),
        Err(_) => String::new(),
    };

    if encoders_output.contains(" h264_nvenc") {
        return ("h264_nvenc".to_string(), Some("p3".to_string()));
    }

    if encoders_output.contains(" h264_qsv") {
        return ("h264_qsv".to_string(), None);
    }

    if encoders_output.contains(" h264_amf") {
        return ("h264_amf".to_string(), None);
    }

    ("libx264".to_string(), Some("superfast".to_string()))
}

fn parse_ffmpeg_speed(line: &str) -> Option<f64> {
    let speed_index = line.find("speed=")?;
    let speed_slice = &line[speed_index + 6..];
    let speed_token = speed_slice.split_whitespace().next()?;
    let numeric = speed_token.trim_end_matches('x');
    numeric.parse::<f64>().ok()
}

fn build_loopback_capture_context(
) -> Result<(wasapi::AudioClient, wasapi::AudioCaptureClient, WaveFormat), String> {
    initialize_mta()
        .ok()
        .map_err(|error| format!("Failed to initialize COM for system audio capture: {error}"))?;

    let enumerator = DeviceEnumerator::new()
        .map_err(|error| format!("Failed to enumerate audio devices: {error}"))?;
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|error| format!("Failed to access default output audio device: {error}"))?;
    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|error| format!("Failed to create WASAPI audio client: {error}"))?;

    let wave_format = WaveFormat::new(
        SYSTEM_AUDIO_BITS_PER_SAMPLE,
        SYSTEM_AUDIO_BITS_PER_SAMPLE,
        &SampleType::Int,
        SYSTEM_AUDIO_SAMPLE_RATE_HZ,
        SYSTEM_AUDIO_CHANNEL_COUNT,
        None,
    );
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: 0,
    };

    audio_client
        .initialize_client(&wave_format, &Direction::Capture, &mode)
        .map_err(|error| {
            format!("Failed to initialize WASAPI loopback client for system audio: {error}")
        })?;

    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|error| format!("Failed to create WASAPI capture client: {error}"))?;

    Ok((audio_client, capture_client, wave_format))
}

fn validate_system_audio_capture_available() -> Result<(), String> {
    let _ = build_loopback_capture_context()?;
    Ok(())
}

fn run_system_audio_capture_to_queue(
    audio_tx: std_mpsc::SyncSender<Vec<u8>>,
    stop_rx: std_mpsc::Receiver<()>,
    stats: Arc<AudioPipelineStats>,
) -> Result<(), String> {
    let (audio_client, capture_client, wave_format) = build_loopback_capture_context()?;
    let event_handle = audio_client
        .set_get_eventhandle()
        .map_err(|error| format!("Failed to configure WASAPI event handle: {error}"))?;

    audio_client
        .start_stream()
        .map_err(|error| format!("Failed to start system audio stream: {error}"))?;

    let mut sample_queue: VecDeque<u8> = VecDeque::new();
    let chunk_size_bytes = wave_format.get_blockalign() as usize * SYSTEM_AUDIO_CHUNK_FRAMES;
    let mut should_stop = false;
    loop {
        match stop_rx.try_recv() {
            Ok(()) | Err(std_mpsc::TryRecvError::Disconnected) => {
                should_stop = true;
            }
            Err(std_mpsc::TryRecvError::Empty) => {}
        }

        let next_packet_frames = match capture_client.get_next_packet_size() {
            Ok(packet_size) => packet_size.unwrap_or(0),
            Err(error) => {
                tracing::warn!("Failed to poll system audio packets: {error}");
                thread::sleep(Duration::from_millis(10));
                continue;
            }
        };

        if next_packet_frames > 0 {
            if let Err(error) = capture_client.read_from_device_to_deque(&mut sample_queue) {
                tracing::warn!("Failed to read system audio packet: {error}");
                thread::sleep(Duration::from_millis(10));
                continue;
            }
        }

        while sample_queue.len() >= chunk_size_bytes {
            let mut chunk = Vec::with_capacity(chunk_size_bytes);
            chunk.extend(sample_queue.drain(..chunk_size_bytes));

            match audio_tx.try_send(chunk) {
                Ok(()) => {
                    stats.queued_chunks.fetch_add(1, Ordering::Relaxed);
                }
                Err(std_mpsc::TrySendError::Full(_)) => {
                    let dropped_chunks = stats.dropped_chunks.fetch_add(1, Ordering::Relaxed) + 1;
                    if dropped_chunks % 64 == 0 {
                        tracing::warn!(
                            dropped_chunks,
                            "Dropping system audio chunks due to queue backpressure"
                        );
                    }
                }
                Err(std_mpsc::TrySendError::Disconnected(_)) => return Ok(()),
            }
        }

        if should_stop {
            break;
        }

        if let Err(error) = event_handle.wait_for_event(SYSTEM_AUDIO_EVENT_TIMEOUT_MS) {
            tracing::debug!("System audio wait event timed/failed: {error}");
        }
    }

    if !sample_queue.is_empty() {
        let mut remaining = Vec::with_capacity(sample_queue.len());
        remaining.extend(sample_queue.drain(..));
        if audio_tx.try_send(remaining).is_ok() {
            stats.queued_chunks.fetch_add(1, Ordering::Relaxed);
        }
    }

    if let Err(error) = audio_client.stop_stream() {
        tracing::warn!("Failed to stop system audio stream cleanly: {error}");
    }

    Ok(())
}

fn run_audio_queue_to_writer<TWriter: Write>(
    mut writer: TWriter,
    audio_rx: std_mpsc::Receiver<Vec<u8>>,
    stop_rx: std_mpsc::Receiver<()>,
    stats: Arc<AudioPipelineStats>,
) -> Result<(), String> {
    loop {
        match stop_rx.try_recv() {
            Ok(()) | Err(std_mpsc::TryRecvError::Disconnected) => break,
            Err(std_mpsc::TryRecvError::Empty) => {}
        }

        match audio_rx.recv_timeout(Duration::from_millis(10)) {
            Ok(chunk) => {
                stats.dequeued_chunks.fetch_add(1, Ordering::Relaxed);
                if let Err(error) = writer.write_all(&chunk) {
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) {
                        stats.write_timeouts.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                    return Err(format!(
                        "Failed to write system audio buffer to FFmpeg: {error}"
                    ));
                }
            }
            Err(std_mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std_mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    let _ = writer.flush();
    Ok(())
}

fn clear_recording_state(state: &SharedRecordingState) {
    let mut recording_state = state.blocking_write();
    recording_state.is_recording = false;
    recording_state.is_stopping = false;
    recording_state.current_output_path = None;
    recording_state.stop_tx = None;
}

fn signal_audio_threads_stop(
    audio_capture_stop_tx: &Option<std_mpsc::Sender<()>>,
    audio_writer_stop_tx: &Option<std_mpsc::Sender<()>>,
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

fn request_ffmpeg_graceful_stop(
    stop_requested_at: &mut Option<Instant>,
    child: &mut std::process::Child,
    audio_capture_stop_tx: &Option<std_mpsc::Sender<()>>,
    audio_writer_stop_tx: &Option<std_mpsc::Sender<()>>,
) {
    if stop_requested_at.is_none() {
        *stop_requested_at = Some(Instant::now());
        signal_audio_threads_stop(audio_capture_stop_tx, audio_writer_stop_tx);

        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(b"q\n");
            let _ = stdin.flush();
        }
    }
}

fn emit_recording_stopped(app_handle: &AppHandle) {
    if let Err(error) = app_handle.emit("recording-stopped", ()) {
        tracing::error!("Failed to emit recording-stopped event: {error}");
    }
}

fn emit_recording_finalized(app_handle: &AppHandle, output_path: &str) {
    if let Err(error) = app_handle.emit("recording-finalized", output_path) {
        tracing::error!("Failed to emit recording-finalized event: {error}");
    }
}

fn emit_recording_warning(app_handle: &AppHandle, warning_message: &str) {
    if let Err(error) = app_handle.emit("recording-warning", warning_message.to_string()) {
        tracing::error!("Failed to emit recording-warning event: {error}");
    }
}

fn emit_recording_warning_cleared(app_handle: &AppHandle) {
    if let Err(error) = app_handle.emit("recording-warning-cleared", ()) {
        tracing::error!("Failed to emit recording-warning-cleared event: {error}");
    }
}

fn append_runtime_capture_input_args(
    command: &mut Command,
    runtime_capture_mode: RuntimeCaptureMode,
    capture_input: &CaptureInput,
    requested_frame_rate: u32,
    capture_width: u32,
    capture_height: u32,
) -> Result<(u32, u32), String> {
    match runtime_capture_mode {
        RuntimeCaptureMode::Monitor => {
            append_capture_input_args(command, &CaptureInput::Monitor, requested_frame_rate);
            Ok(sanitize_capture_dimensions(capture_width, capture_height))
        }
        RuntimeCaptureMode::Window => {
            let region = resolve_window_capture_region(capture_input)?;
            append_window_capture_input_args(command, requested_frame_rate, region);
            Ok((region.width, region.height))
        }
        RuntimeCaptureMode::Black => {
            let (safe_width, safe_height) =
                sanitize_capture_dimensions(capture_width, capture_height);
            command.arg("-f").arg("lavfi").arg("-i").arg(format!(
                "color=c=black:s={safe_width}x{safe_height}:r={requested_frame_rate}"
            ));
            Ok((safe_width, safe_height))
        }
    }
}

fn resolve_video_filter(
    runtime_capture_mode: RuntimeCaptureMode,
    output_frame_rate: u32,
    capture_width: u32,
    capture_height: u32,
) -> String {
    if matches!(
        runtime_capture_mode,
        RuntimeCaptureMode::Window | RuntimeCaptureMode::Black
    ) {
        return format!(
            "fps={output_frame_rate},scale={capture_width}:{capture_height}:flags=bicubic,format=yuv420p"
        );
    }

    format!("fps={output_frame_rate},format=yuv420p")
}

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
        }

        let transition = if availability != WindowCaptureAvailability::Available {
            SegmentTransition::Switch(RuntimeCaptureMode::Black)
        } else {
            SegmentTransition::RestartSameMode
        };

        return SegmentRunResult {
            transition,
            ffmpeg_succeeded: false,
            output_written: false,
        };
    }

    SegmentRunResult {
        transition: SegmentTransition::Stop,
        ffmpeg_succeeded: false,
        output_written: false,
    }
}

#[allow(clippy::too_many_arguments)]
fn run_ffmpeg_recording_segment(
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
                };
            }
        };

        if let Err(error) = listener.set_nonblocking(true) {
            tracing::error!("Failed to configure audio TCP listener: {error}");
            return SegmentRunResult {
                transition: SegmentTransition::Stop,
                ffmpeg_succeeded: false,
                output_written: false,
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
        let (effective_capture_width, effective_capture_height) = match capture_input_args {
            Ok((resolved_width, resolved_height)) => (resolved_width, resolved_height),
            Err(error) => {
                return segment_result_for_capture_input_error(
                    app_handle,
                    runtime_capture_mode,
                    capture_input,
                    &error,
                );
            }
        };

        let video_filter = resolve_video_filter(
            runtime_capture_mode,
            output_frame_rate,
            effective_capture_width,
            effective_capture_height,
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
        let (effective_capture_width, effective_capture_height) = match capture_input_args {
            Ok((resolved_width, resolved_height)) => (resolved_width, resolved_height),
            Err(error) => {
                return segment_result_for_capture_input_error(
                    app_handle,
                    runtime_capture_mode,
                    capture_input,
                    &error,
                );
            }
        };

        let video_filter = resolve_video_filter(
            runtime_capture_mode,
            output_frame_rate,
            effective_capture_width,
            effective_capture_height,
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
            };
        }
    };

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
            if !kill_sent && requested_at.elapsed() >= FFMPEG_STOP_TIMEOUT {
                if let Err(error) = child.kill() {
                    tracing::warn!("Failed to force-stop FFmpeg process: {error}");
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
            let next_window_warning = warning_message_for_window_capture(capture_availability);

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
                        requested_transition = Some(RuntimeCaptureMode::Window);
                        request_ffmpeg_graceful_stop(
                            &mut stop_requested_at,
                            &mut child,
                            &audio_capture_stop_tx,
                            &audio_writer_stop_tx,
                        );
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
            if let Err(kill_error) = child.kill() {
                tracing::debug!("FFmpeg kill after wait failure returned: {kill_error}");
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
    }
}

fn spawn_ffmpeg_recording_task(
    app_handle: AppHandle,
    state: SharedRecordingState,
    output_path: String,
    ffmpeg_binary_path: PathBuf,
    requested_frame_rate: u32,
    output_frame_rate: u32,
    bitrate: u32,
    capture_input: CaptureInput,
    include_system_audio: bool,
    enable_diagnostics: bool,
    mut stop_rx: mpsc::Receiver<()>,
) {
    thread::spawn(move || {
        let (video_encoder, encoder_preset) = select_video_encoder(&ffmpeg_binary_path);
        let mut runtime_capture_mode = to_runtime_capture_mode(&capture_input);
        let capture_target = match &capture_input {
            CaptureInput::Monitor => "primary_monitor".to_string(),
            CaptureInput::Window { input_target, .. } => input_target.clone(),
        };
        let (capture_width, capture_height) = resolve_capture_dimensions(&capture_input);

        if matches!(runtime_capture_mode, RuntimeCaptureMode::Window) {
            let initial_availability = evaluate_window_capture_availability(&capture_input);
            if initial_availability != WindowCaptureAvailability::Available {
                runtime_capture_mode = RuntimeCaptureMode::Black;
                if let Some(warning_message) =
                    warning_message_for_window_capture(initial_availability)
                {
                    emit_recording_warning(&app_handle, warning_message);
                }
            }
        }

        let segment_workspace = if matches!(capture_input, CaptureInput::Window { .. }) {
            match create_segment_workspace(&output_path) {
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
            ffmpeg_path = %ffmpeg_binary_path.display(),
            requested_frame_rate,
            output_frame_rate,
            bitrate,
            capture_source = runtime_capture_label(runtime_capture_mode),
            capture_target = %capture_target,
            include_system_audio,
            enable_diagnostics,
            video_encoder,
            "Starting FFmpeg recording"
        );

        let mut segment_paths: Vec<PathBuf> = Vec::new();
        let mut segment_index: usize = 0;
        let mut consecutive_segment_failures = 0u32;

        loop {
            let segment_output_path = if let Some(workspace) = &segment_workspace {
                build_segment_output_path(workspace, segment_index)
            } else {
                PathBuf::from(&output_path)
            };

            let run_result = run_ffmpeg_recording_segment(
                &app_handle,
                &ffmpeg_binary_path,
                runtime_capture_mode,
                &capture_input,
                &segment_output_path,
                requested_frame_rate,
                output_frame_rate,
                bitrate,
                include_system_audio,
                enable_diagnostics,
                &video_encoder,
                encoder_preset.as_deref(),
                capture_width,
                capture_height,
                &mut stop_rx,
            );

            if run_result.output_written {
                segment_paths.push(segment_output_path);
            }

            if run_result.ffmpeg_succeeded {
                consecutive_segment_failures = 0;
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
                &ffmpeg_binary_path,
                workspace,
                &segment_paths,
                &output_path,
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
            let output_file = Path::new(&output_path);
            output_file.exists()
                && output_file
                    .metadata()
                    .map(|metadata| metadata.len() > 0)
                    .unwrap_or(false)
        };

        if finalized_successfully {
            emit_recording_finalized(&app_handle, &output_path);
        }

        emit_recording_warning_cleared(&app_handle);
        clear_recording_state(&state);
        emit_recording_stopped(&app_handle);
    });
}

#[tauri::command]
pub async fn start_recording(
    app_handle: AppHandle,
    state: tauri::State<'_, SharedRecordingState>,
    settings: crate::settings::RecordingSettings,
    output_folder: String,
    max_storage_bytes: u64,
) -> Result<RecordingStartedPayload, String> {
    {
        let recording_state = state.read().await;
        if recording_state.is_recording || recording_state.is_stopping {
            return Err("Recording already in progress".to_string());
        }
    }

    std::fs::create_dir_all(&output_folder)
        .map_err(|error| format!("Failed to create output directory: {error}"))?;

    let mut recording_settings = settings;
    let capture_input = resolve_capture_input(&recording_settings)?;
    let (width, height) = resolve_capture_dimensions(&capture_input);
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
    let ffmpeg_binary_path = resolve_ffmpeg_binary_path(&app_handle)?;
    let resolved_capture_target = match &capture_input {
        CaptureInput::Monitor => "primary_monitor".to_string(),
        CaptureInput::Window { input_target, .. } => input_target.clone(),
    };

    if recording_settings.enable_system_audio {
        validate_system_audio_capture_available()?;
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

    spawn_ffmpeg_recording_task(
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
