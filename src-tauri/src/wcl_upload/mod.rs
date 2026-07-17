mod auth;
mod auth_service;
mod constants;
mod core;
mod error;
mod events;
mod filesystem;
mod parser;
mod payload;
mod state;
mod types;
mod upload_pipeline;
mod validation;

#[tauri::command]
pub async fn start_wcl_upload(
    app_handle: tauri::AppHandle,
    auth_service: tauri::State<'_, auth_service::WclAuthService>,
    request: types::StartWclUploadRequest,
) -> Result<types::StartWclUploadResponse, String> {
    let authenticated = auth_service
        .session_or_restore(&app_handle)
        .map_err(|error| error.to_string())?;
    let result = core::start_wcl_upload(
        app_handle,
        request,
        authenticated.session,
        authenticated.user_name,
    )
    .await;
    if let Err(error) = &result {
        auth_service
            .invalidate_if_authentication_failed(error)
            .map_err(|invalidation_error| invalidation_error.to_string())?;
    }
    result
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
pub fn get_wcl_auth_status(
    app_handle: tauri::AppHandle,
    auth_service: tauri::State<'_, auth_service::WclAuthService>,
    request: Option<types::WclAuthStatusRequest>,
) -> Result<types::WclAuthStatus, String> {
    let email = request.and_then(|request| request.email);
    auth_service
        .status(&app_handle, email.as_deref())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn restore_wcl_session(
    app_handle: tauri::AppHandle,
    auth_service: tauri::State<'_, auth_service::WclAuthService>,
) -> Result<types::WclAuthStatus, String> {
    auth_service
        .restore(&app_handle)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn login_wcl(
    app_handle: tauri::AppHandle,
    auth_service: tauri::State<'_, auth_service::WclAuthService>,
    request: types::WclLoginRequest,
) -> Result<types::WclAuthStatus, String> {
    auth_service
        .login(&app_handle, request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn sign_out_wcl(
    app_handle: tauri::AppHandle,
    auth_service: tauri::State<'_, auth_service::WclAuthService>,
) -> Result<types::WclAuthStatus, String> {
    auth_service
        .sign_out(&app_handle)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn clear_wcl_saved_login(
    app_handle: tauri::AppHandle,
    auth_service: tauri::State<'_, auth_service::WclAuthService>,
) -> Result<types::WclAuthStatus, String> {
    auth_service
        .forget(&app_handle)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn fetch_wcl_guilds(
    app_handle: tauri::AppHandle,
    auth_service: tauri::State<'_, auth_service::WclAuthService>,
) -> Result<types::FetchWclGuildsResponse, String> {
    let authenticated = auth_service
        .session_or_restore(&app_handle)
        .map_err(|error| error.to_string())?;
    match core::fetch_wcl_guilds(&authenticated.session, authenticated.email) {
        Ok(response) => Ok(response),
        Err(error) if error.is_authentication_failure() => {
            auth_service
                .invalidate_if_authentication_failed(&error.to_string())
                .map_err(|invalidation_error| invalidation_error.to_string())?;
            let restored = auth_service
                .session_or_restore(&app_handle)
                .map_err(|restore_error| restore_error.to_string())?;
            core::fetch_wcl_guilds(&restored.session, restored.email)
                .map_err(|retry_error| retry_error.to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn get_wcl_live_upload_state() -> Result<types::WclLiveUploadState, String> {
    core::get_wcl_live_upload_state()
}

#[tauri::command]
pub fn start_wcl_live_upload(
    app_handle: tauri::AppHandle,
    auth_service: tauri::State<'_, auth_service::WclAuthService>,
    request: types::StartWclLiveUploadRequest,
) -> Result<types::StartWclLiveUploadResponse, String> {
    let authenticated = auth_service
        .session_or_restore(&app_handle)
        .map_err(|error| error.to_string())?;
    core::start_wcl_live_upload(
        app_handle,
        request,
        authenticated.session,
        authenticated.user_name,
        auth_service.inner().clone(),
    )
}

pub use auth_service::WclAuthService;

#[tauri::command]
pub fn stop_wcl_live_upload() -> Result<(), String> {
    core::stop_wcl_live_upload()
}
