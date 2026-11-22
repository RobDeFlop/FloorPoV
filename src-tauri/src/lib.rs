mod combat_log;
mod hotkey;
mod playback_window;
mod recording;
mod screenshot;
mod settings;
mod tray;
mod wcl_upload;

use std::sync::atomic::Ordering;
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

    let recording_state = Arc::new(RwLock::new(recording::RecordingState::default()));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE
                        & !tauri_plugin_window_state::StateFlags::MAXIMIZED
                        & !tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(recording_state)
        .manage(playback_window::PlaybackWindowState::default())
        .manage(wcl_upload::WclAuthService::new())
        .manage(tray::AppExitState::new())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                tray::hide_main_window(window.app_handle());
            }
        })
        .setup(|app| {
            let main_window = app
                .get_webview_window("main")
                .ok_or_else(|| "Main application window was not created".to_string())?;
            main_window.set_icon(tauri::include_image!("./icons/128x128.png"))?;

            let tray_ready = match tray::install_tray(app) {
                Ok(()) => true,
                Err(error) => {
                    tracing::error!("Failed to install the system tray: {error}");
                    false
                }
            };

            if tray_ready && tray::should_start_minimized(app.handle()) {
                tray::hide_main_window(app.handle());
            } else {
                tray::show_main_window(app.handle());
            }

            let output_folder = match settings::resolve_startup_recordings_folder(app.handle()) {
                Ok(path) => path,
                Err(error) => {
                    tracing::error!("Failed to determine recordings output folder: {error}");
                    app.dialog()
                        .message("Could not determine the recordings output folder. Video playback may not work.")
                        .title("FloorPoV warning")
                        .kind(MessageDialogKind::Warning)
                        .show(|_| {});
                    return Ok(());
                }
            };

            if let Err(error) = settings::register_recordings_folder_scope(app.handle(), &output_folder) {
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
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            is_debug_build,
            playback_window::enter_playback_fullscreen,
            playback_window::exit_playback_fullscreen,
            recording::start_recording,
            recording::stop_recording,
            recording::list_capture_windows,
            recording::is_wow_process_running,
            recording::get_available_video_encoders,
            settings::get_default_output_folder,
            settings::allow_recordings_folder,
            settings::get_folder_size,
            settings::get_recordings_list,
            settings::get_recording_metadata,
            settings::write_export_file,
            settings::save_recording_note,
            settings::delete_recording_note,
            settings::delete_recording,
            settings::cleanup_old_recordings,
            screenshot::save_playback_screenshot,
            combat_log::watch::start_combat_watch,
            combat_log::watch::stop_combat_watch,
            combat_log::watch::set_combat_watch_recording_output,
            combat_log::watch::validate_wow_folder,
            combat_log::watch::emit_manual_marker,
            combat_log::watch::update_manual_marker_name,
            combat_log::debug::parse_combat_log_file,
            combat_log::import::import_combat_log_onto_recording,
            wcl_upload::start_wcl_upload,
            wcl_upload::scan_wcl_log,
            wcl_upload::cancel_wcl_log_scan,
            wcl_upload::validate_wcl_upload_scan,
            wcl_upload::cancel_wcl_upload,
            wcl_upload::get_latest_combat_log_path,
            wcl_upload::fetch_wcl_guilds,
            wcl_upload::get_wcl_auth_status,
            wcl_upload::restore_wcl_session,
            wcl_upload::login_wcl,
            wcl_upload::sign_out_wcl,
            wcl_upload::clear_wcl_saved_login,
            wcl_upload::start_wcl_live_upload,
            wcl_upload::stop_wcl_live_upload,
            wcl_upload::get_wcl_live_upload_state,
            hotkey::register_marker_hotkey,
            hotkey::unregister_marker_hotkey,
            tray::hide_to_tray,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !app_handle
                    .state::<tray::AppExitState>()
                    .allow_exit
                    .load(Ordering::Relaxed)
                {
                    api.prevent_exit();
                }
            }
        });
}
