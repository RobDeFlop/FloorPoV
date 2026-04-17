use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::wcl_upload::constants::{WCL_LOGIN_METADATA_FILE, WCL_LOGIN_SERVICE};
use crate::wcl_upload::error::UploadError;
use crate::wcl_upload::types::{ResolvedLoginCredentials, SavedLoginMetadata};

pub(crate) fn resolve_login_credentials(
    app_handle: &AppHandle,
    email: &str,
    password: Option<String>,
    use_saved_login: bool,
    _remember_login: bool,
) -> Result<ResolvedLoginCredentials, UploadError> {
    let trimmed_email = email.trim();
    if trimmed_email.is_empty() {
        return Err(UploadError::Message(
            "WarcraftLogs email is required".to_string(),
        ));
    }

    if let Some(password_value) = password {
        let trimmed_password = password_value.trim();
        if trimmed_password.is_empty() {
            return Err(UploadError::Message(
                "WarcraftLogs password is required".to_string(),
            ));
        }

        return Ok(ResolvedLoginCredentials {
            email: trimmed_email.to_string(),
            password: trimmed_password.to_string(),
            used_saved_password: false,
        });
    }

    if !use_saved_login {
        return Err(UploadError::Message(
            "WarcraftLogs password is required".to_string(),
        ));
    }

    let saved_password = resolve_saved_login_for_email(app_handle, trimmed_email)?;
    let Some(saved_password) = saved_password else {
        return Err(UploadError::Message(format!(
            "No saved credentials found for {trimmed_email}"
        )));
    };

    Ok(ResolvedLoginCredentials {
        email: trimmed_email.to_string(),
        password: saved_password,
        used_saved_password: true,
    })
}

fn login_metadata_path(app_handle: &AppHandle) -> Result<PathBuf, UploadError> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|error| {
        UploadError::Message(format!("Failed to resolve app data dir: {error}"))
    })?;
    Ok(app_data_dir.join(WCL_LOGIN_METADATA_FILE))
}

pub(crate) fn read_saved_login_email(
    app_handle: &AppHandle,
) -> Result<Option<String>, UploadError> {
    let metadata_path = login_metadata_path(app_handle)?;
    if !metadata_path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&metadata_path)?;
    let parsed = serde_json::from_str::<SavedLoginMetadata>(&content)?;
    let email = parsed.saved_email.trim().to_string();
    if email.is_empty() {
        return Ok(None);
    }

    Ok(Some(email))
}

fn write_saved_login_email(app_handle: &AppHandle, email: &str) -> Result<(), UploadError> {
    let metadata_path = login_metadata_path(app_handle)?;
    if let Some(parent) = metadata_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let payload = SavedLoginMetadata {
        saved_email: email.to_string(),
    };
    let json_content = serde_json::to_string_pretty(&payload)?;
    std::fs::write(metadata_path, json_content)?;
    Ok(())
}

pub(crate) fn save_login_credentials(
    app_handle: &AppHandle,
    email: &str,
    password: &str,
) -> Result<(), UploadError> {
    let entry = keyring::Entry::new(WCL_LOGIN_SERVICE, email).map_err(|error| {
        UploadError::Message(format!("Failed to open secure credential store: {error}"))
    })?;
    entry.set_password(password).map_err(|error| {
        UploadError::Message(format!("Failed to save WarcraftLogs credentials: {error}"))
    })?;

    write_saved_login_email(app_handle, email)?;
    Ok(())
}

fn read_saved_password(email: &str) -> Result<Option<String>, UploadError> {
    let entry = keyring::Entry::new(WCL_LOGIN_SERVICE, email).map_err(|error| {
        UploadError::Message(format!("Failed to open secure credential store: {error}"))
    })?;

    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(UploadError::Message(format!(
            "Failed to read saved WarcraftLogs credentials: {error}"
        ))),
    }
}

pub(crate) fn clear_saved_login(app_handle: &AppHandle) -> Result<(), UploadError> {
    let saved_email = read_saved_login_email(app_handle)?;
    if let Some(email) = saved_email {
        let entry = keyring::Entry::new(WCL_LOGIN_SERVICE, &email).map_err(|error| {
            UploadError::Message(format!("Failed to open secure credential store: {error}"))
        })?;

        match entry.delete_password() {
            Ok(_) => {}
            Err(keyring::Error::NoEntry) => {}
            Err(error) => {
                return Err(UploadError::Message(format!(
                    "Failed to clear saved WarcraftLogs credentials: {error}"
                )));
            }
        }
    }

    let metadata_path = login_metadata_path(app_handle)?;
    if metadata_path.exists() {
        std::fs::remove_file(metadata_path)?;
    }
    Ok(())
}

pub(crate) fn resolve_saved_login_for_email(
    app_handle: &AppHandle,
    email: &str,
) -> Result<Option<String>, UploadError> {
    let metadata_email = read_saved_login_email(app_handle)?;
    match metadata_email {
        Some(saved_email) if saved_email.eq_ignore_ascii_case(email) => {
            read_saved_password(&saved_email)
        }
        _ => Ok(None),
    }
}
