mod combat_log;
mod hotkey;
mod recording;
mod settings;

use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tokio::sync::RwLock;

#[tauri::command]
fn is_debug_build() -> bool {
    cfg!(debug_assertions)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--disable-features=HardwareMediaKeyHandling",
    );

    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .try_init();

    let recording_state = Arc::new(RwLock::new(recording::RecordingState::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(recording_state)
        .setup(|app| {
            let output_folder = match settings::get_default_output_folder() {
                Ok(path) => path,
                Err(error) => {
                    tracing::error!("Failed to determine default output folder: {error}");
                    app.dialog()
                        .message("Could not determine the recordings output folder. Video playback may not work.")
                        .title("FloorPoV warning")
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
                    .title("FloorPoV warning")
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
                    .title("FloorPoV warning")
                    .kind(MessageDialogKind::Warning)
                    .show(|_| {});
            } else {
                tracing::info!("Registered asset scope for output folder '{output_folder}'");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            is_debug_build,
            recording::start_recording,
            recording::stop_recording,
            recording::list_capture_windows,
            settings::get_default_output_folder,
            settings::get_folder_size,
            settings::get_recordings_list,
            settings::get_recording_metadata,
            settings::delete_recording,
            settings::cleanup_old_recordings,
            combat_log::start_combat_watch,
            combat_log::stop_combat_watch,
            combat_log::set_combat_watch_recording_output,
            combat_log::validate_wow_folder,
            combat_log::emit_manual_marker,
            combat_log::parse_combat_log_file,
            hotkey::register_marker_hotkey,
            hotkey::unregister_marker_hotkey,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
