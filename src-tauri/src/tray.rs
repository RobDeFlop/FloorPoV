//! System tray and window visibility controls.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager};

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

pub(crate) fn hide_main_window(app_handle: &AppHandle, is_windowed: bool) {
    let Some(window) = app_handle.get_webview_window("main") else {
        tracing::warn!("Cannot hide to tray because the main window is missing");
        return;
    };

    if let Err(error) = window.hide() {
        tracing::warn!("Failed to hide FloorPoV to the tray: {error}");
    }

    if let Err(error) = window.set_skip_taskbar(true) {
        tracing::warn!("Failed to hide FloorPoV from the taskbar: {error}");
    }

    if let Err(error) = app_handle.emit("window-hidden-to-tray", is_windowed) {
        tracing::warn!("Failed to emit window-hidden-to-tray: {error}");
    }
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
