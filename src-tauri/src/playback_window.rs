//! Preserves native Windows placement while playback uses the full monitor.

use tauri::{State, WebviewWindow};

#[cfg(target_os = "windows")]
use std::mem::size_of;
#[cfg(target_os = "windows")]
use std::sync::Mutex;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetWindowPlacement, SetWindowPlacement, SetWindowPos, ShowWindow, HWND_TOP, SWP_FRAMECHANGED,
    SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_MAXIMIZE,
    SW_RESTORE, SW_SHOWMAXIMIZED, SW_SHOWNORMAL, WINDOWPLACEMENT,
};

#[derive(Default)]
pub(crate) struct PlaybackWindowState {
    #[cfg(target_os = "windows")]
    placement: Mutex<Option<WINDOWPLACEMENT>>,
}

#[cfg(target_os = "windows")]
fn windows_error(action: &str) -> String {
    format!("{action}: {}", std::io::Error::last_os_error())
}

#[cfg(target_os = "windows")]
fn monitor_geometry(info: &MONITORINFO) -> Result<(i32, i32, i32, i32), String> {
    let width = info.rcMonitor.right - info.rcMonitor.left;
    let height = info.rcMonitor.bottom - info.rcMonitor.top;

    if width <= 0 || height <= 0 {
        return Err("Active monitor reported invalid dimensions".to_string());
    }

    Ok((info.rcMonitor.left, info.rcMonitor.top, width, height))
}

#[cfg(target_os = "windows")]
unsafe fn restore_placement(
    hwnd: windows_sys::Win32::Foundation::HWND,
    placement: &WINDOWPLACEMENT,
) -> Result<(), String> {
    if placement.showCmd == SW_SHOWMAXIMIZED as u32 {
        let mut normal_placement = *placement;
        normal_placement.showCmd = SW_SHOWNORMAL as u32;
        if unsafe { SetWindowPlacement(hwnd, &normal_placement) } == 0 {
            return Err(windows_error(
                "Failed to restore the normal window placement",
            ));
        }
        unsafe { ShowWindow(hwnd, SW_MAXIMIZE) };
    } else if unsafe { SetWindowPlacement(hwnd, placement) } == 0 {
        return Err(windows_error("Failed to restore the window placement"));
    }

    if unsafe {
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER,
        )
    } == 0
    {
        return Err(windows_error("Failed to refresh the restored window frame"));
    }

    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) fn enter_playback_fullscreen(
    window: WebviewWindow,
    state: State<'_, PlaybackWindowState>,
) -> Result<(), String> {
    let mut saved_placement = state
        .placement
        .lock()
        .map_err(|_| "Playback window state lock is poisoned".to_string())?;

    if saved_placement.is_some() {
        return Ok(());
    }

    let hwnd = window
        .hwnd()
        .map_err(|error| format!("Failed to access the application window: {error}"))?
        .0;
    let mut placement = WINDOWPLACEMENT {
        length: size_of::<WINDOWPLACEMENT>() as u32,
        ..Default::default()
    };

    unsafe {
        if GetWindowPlacement(hwnd, &mut placement) == 0 {
            return Err(windows_error("Failed to read the current window placement"));
        }

        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if monitor.is_null() {
            return Err(windows_error("Failed to find the active monitor"));
        }

        let mut monitor_info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut monitor_info) == 0 {
            return Err(windows_error("Failed to read the active monitor geometry"));
        }

        let (x, y, width, height) = monitor_geometry(&monitor_info)?;
        *saved_placement = Some(placement);
        ShowWindow(hwnd, SW_RESTORE);

        if SetWindowPos(
            hwnd,
            HWND_TOP,
            x,
            y,
            width,
            height,
            SWP_FRAMECHANGED | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
        ) == 0
        {
            let entry_error = windows_error("Failed to enter playback fullscreen");
            match restore_placement(hwnd, &placement) {
                Ok(()) => *saved_placement = None,
                Err(rollback_error) => {
                    return Err(format!(
                        "{entry_error}; rollback also failed: {rollback_error}"
                    ));
                }
            }
            return Err(entry_error);
        }
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) fn enter_playback_fullscreen(
    _window: WebviewWindow,
    _state: State<'_, PlaybackWindowState>,
) -> Result<(), String> {
    Err("Playback fullscreen is only supported on Windows".to_string())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) fn exit_playback_fullscreen(
    window: WebviewWindow,
    state: State<'_, PlaybackWindowState>,
) -> Result<(), String> {
    let mut saved_placement = state
        .placement
        .lock()
        .map_err(|_| "Playback window state lock is poisoned".to_string())?;
    let Some(placement) = saved_placement.as_ref() else {
        return Ok(());
    };
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("Failed to access the application window: {error}"))?
        .0;

    unsafe { restore_placement(hwnd, placement)? };
    *saved_placement = None;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) fn exit_playback_fullscreen(
    _window: WebviewWindow,
    _state: State<'_, PlaybackWindowState>,
) -> Result<(), String> {
    Err("Playback fullscreen is only supported on Windows".to_string())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use windows_sys::Win32::Foundation::RECT;

    #[test]
    fn monitor_geometry_supports_offset_monitors() {
        let info = MONITORINFO {
            rcMonitor: RECT {
                left: -1920,
                top: 0,
                right: 0,
                bottom: 1080,
            },
            ..Default::default()
        };

        assert_eq!(monitor_geometry(&info), Ok((-1920, 0, 1920, 1080)));
    }

    #[test]
    fn monitor_geometry_rejects_empty_bounds() {
        let info = MONITORINFO::default();

        assert!(monitor_geometry(&info).is_err());
    }
}
