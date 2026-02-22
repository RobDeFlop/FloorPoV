use crate::settings::RecordingSettings;
#[cfg(target_os = "windows")]
use std::path::Path;

use super::model::{
    CaptureInput, CaptureWindowInfo, MonitorIndexSearchState, WindowCaptureAvailability,
    WindowCaptureRegion, DEFAULT_CAPTURE_HEIGHT, DEFAULT_CAPTURE_WIDTH, MIN_CAPTURE_DIMENSION,
    WINDOW_CAPTURE_CLOSED_WARNING, WINDOW_CAPTURE_MINIMIZED_WARNING,
};

#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, POINT, RECT};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Gdi::{
    ClientToScreen, EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, HDC, HMONITOR,
    MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClientRect, GetWindow, GetWindowLongW, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, GWL_EXSTYLE, GW_OWNER,
    WS_EX_TOOLWINDOW,
};

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
    if !normalized.is_multiple_of(2) {
        normalized = normalized.saturating_sub(1);
    }
    normalized.max(MIN_CAPTURE_DIMENSION)
}

#[cfg(target_os = "windows")]
fn resolve_process_name(process_id: u32) -> Option<String> {
    if process_id == 0 {
        return None;
    }

    let process_handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if process_handle.is_null() {
        return None;
    }

    let mut process_path_buffer = vec![0u16; 260];
    let mut process_path_length = process_path_buffer.len() as u32;

    let query_result = unsafe {
        QueryFullProcessImageNameW(
            process_handle,
            0,
            process_path_buffer.as_mut_ptr(),
            &mut process_path_length as *mut u32,
        )
    };

    unsafe {
        CloseHandle(process_handle);
    }

    if query_result == 0 || process_path_length == 0 {
        return None;
    }

    let full_process_path =
        String::from_utf16_lossy(&process_path_buffer[..process_path_length as usize]);
    let process_name = Path::new(&full_process_path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            let trimmed_path = full_process_path.trim();
            if trimmed_path.is_empty() {
                None
            } else {
                Some(trimmed_path.to_string())
            }
        });

    process_name
}

pub(crate) fn sanitize_capture_dimensions(width: u32, height: u32) -> (u32, u32) {
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
fn to_window_handle(window_hwnd: usize) -> HWND {
    window_hwnd as isize as HWND
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
pub(crate) fn resolve_window_capture_region(
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
pub(crate) fn resolve_window_capture_region(
    _capture_input: &CaptureInput,
) -> Result<WindowCaptureRegion, String> {
    Err("Window capture regions are only supported on Windows".to_string())
}

pub(crate) fn resolve_capture_dimensions(capture_input: &CaptureInput) -> (u32, u32) {
    #[cfg(target_os = "windows")]
    {
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
    }

    sanitize_capture_dimensions(DEFAULT_CAPTURE_WIDTH, DEFAULT_CAPTURE_HEIGHT)
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

pub(crate) fn evaluate_window_capture_availability(
    capture_input: &CaptureInput,
) -> WindowCaptureAvailability {
    #[cfg(target_os = "windows")]
    {
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
    {
        let _ = capture_input;
        WindowCaptureAvailability::Available
    }
}

pub(crate) fn warning_message_for_window_capture(
    capture_availability: WindowCaptureAvailability,
) -> Option<&'static str> {
    match capture_availability {
        WindowCaptureAvailability::Available => None,
        WindowCaptureAvailability::Minimized => Some(WINDOW_CAPTURE_MINIMIZED_WARNING),
        WindowCaptureAvailability::Closed => Some(WINDOW_CAPTURE_CLOSED_WARNING),
    }
}

pub(crate) fn resolve_capture_input(settings: &RecordingSettings) -> Result<CaptureInput, String> {
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

    let process_name = resolve_process_name(process_id);

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
        process_name,
    });

    1
}

pub(crate) fn list_capture_windows_internal() -> Result<Vec<CaptureWindowInfo>, String> {
    #[cfg(target_os = "windows")]
    {
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
    {
        Err("Window capture is only supported on Windows.".to_string())
    }
}
