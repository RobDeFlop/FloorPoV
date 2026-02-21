mod capture;
mod recording;
mod settings;
mod combat_log;
mod hotkey;

use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tokio::sync::RwLock;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .try_init();

    let capture_state = Arc::new(RwLock::new(capture::CaptureState::new()));
    let recording_state = Arc::new(RwLock::new(recording::RecordingState::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(capture_state)
        .manage(recording_state)
        .setup(|app| {
            let output_folder = match settings::get_default_output_folder() {
                Ok(path) => path,
                Err(error) => {
                    tracing::error!("Failed to determine default output folder: {error}");
                    app.dialog()
                        .message("Could not determine the recordings output folder. Video playback may not work.")
                        .title("Floorpov warning")
                        .kind(MessageDialogKind::Warning)
                        .show(|_| {});
                    return Ok(());
                }
            };

            if let Err(error) = std::fs::create_dir_all(&output_folder) {
                tracing::warn!(
                    "Failed to create output folder '{output_folder}': {error}"
                );
                app.dialog()
                    .message(format!(
                        "Could not create the recordings folder at '{output_folder}'. Video playback may not work until this is fixed."
                    ))
                    .title("Floorpov warning")
                    .kind(MessageDialogKind::Warning)
                    .show(|_| {});
            }

            if let Err(error) = app.handle().asset_protocol_scope().allow_directory(&output_folder, true) {
                tracing::error!(
                    "Failed to allow output folder '{output_folder}' in asset scope: {error}"
                );
                app.dialog()
                    .message(format!(
                        "Could not allow the recordings folder in the asset scope. Video playback may not work.\n\nFolder: {output_folder}"
                    ))
                    .title("Floorpov warning")
                    .kind(MessageDialogKind::Warning)
                    .show(|_| {});
            } else {
                tracing::info!("Registered asset scope for output folder '{output_folder}'");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            capture::start_preview,
            capture::stop_preview,
            capture::list_windows,
            recording::start_recording,
            recording::stop_recording,
            settings::get_default_output_folder,
            settings::get_folder_size,
            settings::get_recordings_list,
            settings::cleanup_old_recordings,
            combat_log::start_combat_watch,
            combat_log::stop_combat_watch,
            combat_log::emit_manual_marker,
            hotkey::register_marker_hotkey,
            hotkey::unregister_marker_hotkey,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
