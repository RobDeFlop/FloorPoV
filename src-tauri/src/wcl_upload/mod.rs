mod auth;
mod constants;
mod core;
mod error;
mod events;
mod filesystem;
mod state;
mod types;
mod validation;

#[tauri::command]
pub async fn start_wcl_upload(
    app_handle: tauri::AppHandle,
    request: types::StartWclUploadRequest,
) -> Result<types::StartWclUploadResponse, String> {
    core::start_wcl_upload(app_handle, request).await
}

#[tauri::command]
pub fn cancel_wcl_upload() -> Result<(), String> {
    core::cancel_wcl_upload()
}

#[tauri::command]
pub fn get_latest_combat_log_path(wow_folder: Option<String>) -> Result<Option<String>, String> {
    core::get_latest_combat_log_path(wow_folder)
}

#[tauri::command]
pub fn get_wcl_login_state(app_handle: tauri::AppHandle) -> Result<types::WclLoginState, String> {
    core::get_wcl_login_state(app_handle)
}

#[tauri::command]
pub fn clear_wcl_saved_login(app_handle: tauri::AppHandle) -> Result<(), String> {
    core::clear_wcl_saved_login(app_handle)
}

#[tauri::command]
pub fn fetch_wcl_guilds(
    app_handle: tauri::AppHandle,
    request: types::FetchWclGuildsRequest,
) -> Result<types::FetchWclGuildsResponse, String> {
    core::fetch_wcl_guilds(app_handle, request)
}

#[tauri::command]
pub fn get_wcl_live_upload_state() -> Result<types::WclLiveUploadState, String> {
    core::get_wcl_live_upload_state()
}

#[tauri::command]
pub fn start_wcl_live_upload(
    app_handle: tauri::AppHandle,
    request: types::StartWclLiveUploadRequest,
) -> Result<types::StartWclLiveUploadResponse, String> {
    core::start_wcl_live_upload(app_handle, request)
}

#[tauri::command]
pub fn stop_wcl_live_upload() -> Result<(), String> {
    core::stop_wcl_live_upload()
}
