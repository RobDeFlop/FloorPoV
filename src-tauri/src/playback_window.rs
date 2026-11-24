//! Preserves native Windows placement while playback uses the full monitor.

use serde::Serialize;
use tauri::{State, WebviewWindow};

#[cfg(target_os = "windows")]
use std::mem::size_of;
#[cfg(target_os = "windows")]
use std::sync::{Mutex, MutexGuard};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::HWND;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetWindowPlacement, IsWindowVisible, IsZoomed, SetWindowPlacement, SetWindowPos, ShowWindow,
    HWND_TOP, SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER,
    SW_RESTORE, SW_SHOWMAXIMIZED, SW_SHOWNORMAL, WINDOWPLACEMENT,
};

#[derive(Default)]
pub(crate) struct PlaybackWindowState {
    #[cfg(target_os = "windows")]
    placement: Mutex<PlaybackPlacement>,
}

#[cfg(target_os = "windows")]
#[derive(Default)]
struct PlaybackPlacement {
    saved: Option<WINDOWPLACEMENT>,
    tray_generation: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FullscreenEntry {
    outcome: FullscreenEntryOutcome,
    tray_generation: u32,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
enum FullscreenEntryOutcome {
    Entered,
    Skipped,
}

#[cfg(target_os = "windows")]
impl PlaybackWindowState {
    fn lock(&self) -> Result<MutexGuard<'_, PlaybackPlacement>, String> {
        self.placement
            .lock()
            .map_err(|_| "Playback window state lock is poisoned".to_string())
    }
}

#[cfg(target_os = "windows")]
fn window_hwnd(window: &WebviewWindow) -> Result<HWND, String> {
    window
        .hwnd()
        .map(|hwnd| hwnd.0)
        .map_err(|error| format!("Failed to access the application window: {error}"))
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
unsafe fn restore_placement(hwnd: HWND, placement: &WINDOWPLACEMENT) -> Result<(), String> {
    let was_maximized = placement.showCmd == SW_SHOWMAXIMIZED as u32;
    if was_maximized {
        // Re-establish the normal bounds before maximizing on the former monitor.
        let mut normal_placement = *placement;
        normal_placement.showCmd = SW_SHOWNORMAL as u32;
        if unsafe { SetWindowPlacement(hwnd, &normal_placement) } == 0 {
            return Err(windows_error(
                "Failed to restore the normal window placement",
            ));
        }
    }
    if unsafe { SetWindowPlacement(hwnd, placement) } == 0 {
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

    if (unsafe { IsZoomed(hwnd) } != 0) != was_maximized {
        return Err("Windows did not restore the previous maximized state".to_string());
    }

    Ok(())
}

#[cfg(target_os = "windows")]
impl PlaybackPlacement {
    fn enter(&mut self, hwnd: HWND, tray_generation: u32) -> Result<FullscreenEntry, String> {
        // A close can restore and reopen the window before an older IPC request arrives.
        let outcome =
            if tray_generation != self.tray_generation || unsafe { IsWindowVisible(hwnd) } == 0 {
                FullscreenEntryOutcome::Skipped
            } else {
                if self.saved.is_none() {
                    self.enter_monitor_bounds(hwnd)?;
                }
                FullscreenEntryOutcome::Entered
            };
        Ok(FullscreenEntry {
            outcome,
            tray_generation: self.tray_generation,
        })
    }

    fn enter_monitor_bounds(&mut self, hwnd: HWND) -> Result<(), String> {
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
            self.saved = Some(placement);
            ShowWindow(hwnd, SW_RESTORE);

            if SetWindowPos(
                hwnd,
                HWND_TOP,
                x,
                y,
                width,
                height,
                SWP_FRAMECHANGED | SWP_NOOWNERZORDER,
            ) == 0
            {
                let entry_error = windows_error("Failed to enter playback fullscreen");
                if let Err(rollback_error) = self.restore(hwnd) {
                    return Err(format!(
                        "{entry_error}; rollback also failed: {rollback_error}"
                    ));
                }
                return Err(entry_error);
            }
        }

        Ok(())
    }

    fn restore(&mut self, hwnd: HWND) -> Result<(), String> {
        if let Some(placement) = self.saved.as_ref() {
            unsafe { restore_placement(hwnd, placement)? };
            self.saved = None;
        }
        Ok(())
    }

    fn restore_for_tray(&mut self, hwnd: HWND) -> Result<u32, String> {
        self.restore(hwnd)?;
        self.tray_generation += 1;
        Ok(self.tray_generation)
    }
}

#[tauri::command]
pub(crate) fn get_playback_tray_generation(
    state: State<'_, PlaybackWindowState>,
) -> Result<u32, String> {
    #[cfg(target_os = "windows")]
    {
        Ok(state.lock()?.tray_generation)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
        Ok(0)
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) fn enter_playback_fullscreen(
    window: WebviewWindow,
    state: State<'_, PlaybackWindowState>,
    tray_generation: u32,
) -> Result<FullscreenEntry, String> {
    let hwnd = window_hwnd(&window)?;
    state.lock()?.enter(hwnd, tray_generation)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) fn enter_playback_fullscreen(
    _window: WebviewWindow,
    _state: State<'_, PlaybackWindowState>,
) -> Result<FullscreenEntry, String> {
    Err("Playback fullscreen is only supported on Windows".to_string())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) fn exit_playback_fullscreen(
    window: WebviewWindow,
    state: State<'_, PlaybackWindowState>,
) -> Result<(), String> {
    let hwnd = window_hwnd(&window)?;
    state.lock()?.restore(hwnd)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) fn exit_playback_fullscreen(
    _window: WebviewWindow,
    _state: State<'_, PlaybackWindowState>,
) -> Result<(), String> {
    Ok(())
}

pub(crate) fn restore_playback_for_tray(
    window: &WebviewWindow,
    state: State<'_, PlaybackWindowState>,
) -> Result<u32, String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = window_hwnd(window)?;
        state.lock()?.restore_for_tray(hwnd)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, state);
        Ok(0)
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GetWindowRect, SW_HIDE, SW_MAXIMIZE, SW_SHOW,
        WS_EX_NOACTIVATE, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    };

    struct TestWindow(HWND);

    impl TestWindow {
        fn new() -> Self {
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let hwnd = unsafe {
                CreateWindowExW(
                    WS_EX_NOACTIVATE,
                    class.as_ptr(),
                    class.as_ptr(),
                    WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                    120,
                    140,
                    850,
                    600,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                )
            };
            assert!(!hwnd.is_null(), "{}", windows_error("CreateWindowExW"));
            Self(hwnd)
        }
    }

    impl Drop for TestWindow {
        fn drop(&mut self) {
            unsafe { DestroyWindow(self.0) };
        }
    }

    fn measure_window(hwnd: HWND) -> (u32, [i32; 4], [i32; 4]) {
        let mut placement = WINDOWPLACEMENT {
            length: size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        assert_ne!(unsafe { GetWindowPlacement(hwnd, &mut placement) }, 0);
        let normal = placement.rcNormalPosition;
        let mut outer = RECT::default();
        assert_ne!(unsafe { GetWindowRect(hwnd, &mut outer) }, 0);
        (
            placement.showCmd,
            [normal.left, normal.top, normal.right, normal.bottom],
            [outer.left, outer.top, outer.right, outer.bottom],
        )
    }

    #[test]
    fn tray_restore_then_delayed_entry_keeps_reopened_window_placement() {
        let window = TestWindow::new();
        let before = measure_window(window.0);
        let mut playback = PlaybackPlacement::default();
        let entry_generation = 0;

        let reopened_generation = playback.restore_for_tray(window.0).unwrap();
        unsafe {
            ShowWindow(window.0, SW_HIDE);
            assert_eq!(
                playback
                    .enter(window.0, reopened_generation)
                    .unwrap()
                    .outcome,
                FullscreenEntryOutcome::Skipped
            );
            assert_eq!(IsWindowVisible(window.0), 0);
            ShowWindow(window.0, SW_SHOW);
        }

        assert_eq!(
            playback.enter(window.0, entry_generation).unwrap().outcome,
            FullscreenEntryOutcome::Skipped
        );
        assert_eq!(measure_window(window.0), before);
        assert_eq!(
            playback
                .enter(window.0, reopened_generation)
                .unwrap()
                .outcome,
            FullscreenEntryOutcome::Entered
        );
        assert_ne!(measure_window(window.0), before);
        playback.restore(window.0).unwrap();
        assert_eq!(measure_window(window.0), before);
    }

    #[test]
    fn entry_then_tray_restore_keeps_previous_maximized_placement() {
        let window = TestWindow::new();
        unsafe { ShowWindow(window.0, SW_MAXIMIZE) };
        let before = measure_window(window.0);
        assert_eq!(before.0, SW_SHOWMAXIMIZED as u32);
        let mut playback = PlaybackPlacement::default();

        assert_eq!(
            playback.enter(window.0, 0).unwrap().outcome,
            FullscreenEntryOutcome::Entered
        );
        assert_ne!(measure_window(window.0), before);
        playback.restore_for_tray(window.0).unwrap();
        unsafe {
            ShowWindow(window.0, SW_HIDE);
            ShowWindow(window.0, SW_SHOW);
        }
        assert_eq!(measure_window(window.0), before);
    }

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
