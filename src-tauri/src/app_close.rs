//! Coordinates main-window close requests without changing the tray menu's Quit action.

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogBuilder, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tokio::sync::oneshot;

use crate::recording::{self, RecordingOnQuit, SharedRecordingState};
use crate::tray::{self, AppExitState};

const STOP_AND_QUIT: &str = "Stop recording and quit";

pub(crate) fn request_main_window_close(app: &AppHandle) {
    if app
        .state::<AppExitState>()
        .window_close_pending
        .swap(true, Ordering::Relaxed)
    {
        return;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        close_main_window(app).await;
    });
}

async fn close_main_window(app: AppHandle) {
    // Read the saved preference, not the settings form or the store's unsaved cache.
    let settings_app = app.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        crate::settings::read_saved_close_to_tray(&settings_app)
    })
    .await
    {
        Ok(true) => {
            schedule_window_close(&app, CloseAction::Hide);
            return;
        }
        Ok(false) => {}
        Err(error) => {
            tracing::error!("Could not check close-to-tray preference: {error}");
            show_close_error(
                app,
                "Could not close FloorPoV. Try closing the window again.",
                "Window not closed",
            );
            return;
        }
    }

    let state = app.state::<SharedRecordingState>();
    let completion = match recording::prepare_for_window_quit(&state).await {
        RecordingOnQuit::Idle => {
            schedule_window_close(&app, CloseAction::Quit);
            return;
        }
        RecordingOnQuit::Capturing(completion) => {
            if !confirm_stop_and_quit(&app).await {
                cancel_quit(&app).await;
                release_close_request(&app);
                return;
            }
            completion
        }
        RecordingOnQuit::Saving(completion) => completion,
    };

    match recording::save_before_window_quit(&state, completion).await {
        Ok(()) => schedule_window_close(&app, CloseAction::Quit),
        Err(error) => {
            tracing::error!("Cannot quit after recording save failed: {error}");
            cancel_quit(&app).await;
            show_close_error(
                app,
                "Could not save the recording. FloorPoV will stay open.",
                "Recording not saved",
            );
        }
    }
}

fn window_close_dialog(app: &AppHandle, message: &str) -> MessageDialogBuilder<tauri::Wry> {
    let dialog = app.dialog().message(message);
    match app.get_webview_window("main") {
        Some(window) => dialog.parent(&window),
        None => dialog,
    }
}

fn show_close_error(app: AppHandle, message: &str, title: &str) {
    window_close_dialog(&app, message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .show(move |_| release_close_request(&app));
}

async fn confirm_stop_and_quit(app: &AppHandle) -> bool {
    let (answer_tx, answer_rx) = oneshot::channel();
    window_close_dialog(
        app,
        "A recording is in progress. Stop and save it before quitting?",
    )
    .title("Recording in progress")
    .kind(MessageDialogKind::Warning)
    .buttons(MessageDialogButtons::OkCancelCustom(
        STOP_AND_QUIT.to_string(),
        "Keep recording".to_string(),
    ))
    .show_with_result(move |answer| {
        if answer_tx.send(answer).is_err() {
            tracing::debug!("Window close no longer awaiting confirmation");
        }
    });

    matches!(answer_rx.await, Ok(MessageDialogResult::Custom(button)) if button == STOP_AND_QUIT)
}

enum CloseAction {
    Hide,
    Quit,
}

fn schedule_window_close(app: &AppHandle, action: CloseAction) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let placement_restored = restore_playback_window(&handle);
        match action {
            CloseAction::Hide => {
                tray::hide_main_window(&handle, placement_restored);
                release_close_request(&handle);
            }
            CloseAction::Quit => tray::request_quit(&handle),
        }
    }) {
        tracing::error!("Could not schedule window close: {error}");
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            cancel_quit(&app).await;
            release_close_request(&app);
        });
    }
}

fn restore_playback_window(app: &AppHandle) -> bool {
    #[cfg(target_os = "windows")]
    if let Some(window) = app.get_webview_window("main") {
        // Restore placement before hiding or letting the window-state plugin save on exit.
        if let Err(error) = crate::playback_window::exit_playback_fullscreen(window, app.state()) {
            tracing::warn!("Could not restore playback window before closing: {error}");
            return false;
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
    true
}

async fn cancel_quit(app: &AppHandle) {
    recording::cancel_window_quit(&app.state::<SharedRecordingState>()).await;
}

fn release_close_request(app: &AppHandle) {
    app.state::<AppExitState>()
        .window_close_pending
        .store(false, Ordering::Relaxed);
}
