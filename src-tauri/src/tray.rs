//! System tray and window visibility controls.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager};

use crate::playback_window::restore_playback_for_tray;

pub(crate) struct AppExitState {
    pub(crate) allow_exit: AtomicBool,
    pub(crate) window_close_pending: AtomicBool,
}

impl AppExitState {
    pub(crate) fn new() -> Self {
        Self {
            allow_exit: AtomicBool::new(false),
            window_close_pending: AtomicBool::new(false),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrayPlacementRestored {
    tray_generation: u32,
}

pub(crate) fn hide_main_window(app_handle: &AppHandle) -> Result<(), String> {
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "Cannot hide to tray because the main window is missing".to_string())?;
    hide_to_tray(
        || restore_playback_for_tray(&window, app_handle.state()),
        || {
            window
                .hide()
                .map_err(|error| format!("Failed to hide FloorPoV to the tray: {error}"))
        },
        || {
            if let Err(error) = window.set_skip_taskbar(true) {
                tracing::warn!("Failed to hide FloorPoV from the taskbar: {error}");
            }
        },
        |event, payload| {
            if let Err(error) = app_handle.emit(event, payload) {
                tracing::warn!("Failed to emit {event}: {error}");
            }
        },
    )
}

fn hide_to_tray(
    restore: impl FnOnce() -> Result<u32, String>,
    hide: impl FnOnce() -> Result<(), String>,
    skip_taskbar: impl FnOnce(),
    emit: impl FnOnce(&'static str, TrayPlacementRestored),
) -> Result<(), String> {
    let payload = TrayPlacementRestored {
        tray_generation: restore()?,
    };

    if let Err(error) = hide() {
        // Placement is already restored, but playback should only pause on a successful hide.
        emit("playback-placement-restored", payload);
        return Err(error);
    }

    skip_taskbar();
    emit("window-hidden-to-tray", payload);
    Ok(())
}

pub(crate) fn show_main_window(app_handle: &AppHandle) {
    let Some(window) = app_handle.get_webview_window("main") else {
        tracing::warn!("Cannot restore from tray because the main window is missing");
        return;
    };

    if let Err(error) = window.set_skip_taskbar(false) {
        tracing::warn!("Failed to restore FloorPoV to the taskbar: {error}");
    }

    if let Err(error) = window.unminimize() {
        tracing::warn!("Failed to unminimize FloorPoV: {error}");
    }

    if let Err(error) = window.show() {
        tracing::warn!("Failed to show FloorPoV from the tray: {error}");
    }

    if let Err(error) = window.set_focus() {
        tracing::warn!("Failed to focus FloorPoV after restoring from the tray: {error}");
    }
}

pub(crate) fn request_quit(app_handle: &AppHandle) {
    app_handle
        .state::<AppExitState>()
        .allow_exit
        .store(true, Ordering::Relaxed);
    app_handle.exit(0);
}

pub(crate) fn install_tray(app: &App) -> Result<(), String> {
    let show_item = MenuItem::with_id(app, "show", "Show FloorPoV", true, None::<&str>)
        .map_err(|error| format!("Failed to create tray Show item: {error}"))?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)
        .map_err(|error| format!("Failed to create tray Quit item: {error}"))?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])
        .map_err(|error| format!("Failed to create tray menu: {error}"))?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "Missing default window icon for the tray".to_string())?;

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("FloorPoV")
        .show_menu_on_left_click(false)
        .on_menu_event(|app_handle, event| match event.id().as_ref() {
            "show" => show_main_window(app_handle),
            "quit" => request_quit(app_handle),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|error| format!("Failed to install the system tray icon: {error}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::hide_to_tray;

    #[test]
    fn failed_hide_acknowledges_restore_without_announcing_hide() {
        let calls = RefCell::new(Vec::new());
        let result = hide_to_tray(
            || {
                calls.borrow_mut().push(("restore", None));
                Ok(7)
            },
            || {
                calls.borrow_mut().push(("hide", None));
                Err("native hide failed".to_string())
            },
            || calls.borrow_mut().push(("skip taskbar", None)),
            |event, payload| {
                calls
                    .borrow_mut()
                    .push((event, Some(payload.tray_generation)))
            },
        );

        assert_eq!(result, Err("native hide failed".to_string()));
        assert_eq!(
            calls.into_inner(),
            [
                ("restore", None),
                ("hide", None),
                ("playback-placement-restored", Some(7)),
            ]
        );
    }
}
