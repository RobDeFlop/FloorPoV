use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::wcl_upload::constants::{
    WCL_LOGIN_METADATA_LEGACY_FILE, WCL_LOGIN_SAVED_EMAIL_ACCOUNT,
    WCL_LOGIN_SAVED_EMAIL_INDEX_ACCOUNT, WCL_LOGIN_SERVICE,
};
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
    Ok(app_data_dir.join(WCL_LOGIN_METADATA_LEGACY_FILE))
}

pub(crate) fn read_saved_login_email(
    app_handle: &AppHandle,
) -> Result<Option<String>, UploadError> {
    let entry =
        keyring::Entry::new(WCL_LOGIN_SERVICE, WCL_LOGIN_SAVED_EMAIL_ACCOUNT).map_err(|error| {
            UploadError::Message(format!("Failed to open secure credential store: {error}"))
        })?;

    match entry.get_password() {
        Ok(saved_email) => {
            let trimmed = saved_email.trim().to_string();
            if trimmed.is_empty() {
                return Ok(None);
            }
            Ok(Some(trimmed))
        }
        Err(keyring::Error::NoEntry) => migrate_legacy_saved_login_email(app_handle),
        Err(error) => Err(UploadError::Message(format!(
            "Failed to read saved WarcraftLogs email: {error}"
        ))),
    }
}

fn migrate_legacy_saved_login_email(app_handle: &AppHandle) -> Result<Option<String>, UploadError> {
    let legacy_email = read_legacy_saved_login_email(app_handle)?;
    let Some(legacy_email) = legacy_email else {
        return Ok(None);
    };

    write_saved_login_email(&legacy_email)?;
    save_email_to_index(&legacy_email)?;

    let metadata_path = login_metadata_path(app_handle)?;
    if metadata_path.exists() {
        std::fs::remove_file(metadata_path)?;
    }

    Ok(Some(legacy_email))
}

fn read_legacy_saved_login_email(app_handle: &AppHandle) -> Result<Option<String>, UploadError> {
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

fn write_saved_login_email(email: &str) -> Result<(), UploadError> {
    let entry =
        keyring::Entry::new(WCL_LOGIN_SERVICE, WCL_LOGIN_SAVED_EMAIL_ACCOUNT).map_err(|error| {
            UploadError::Message(format!("Failed to open secure credential store: {error}"))
        })?;
    entry.set_password(email).map_err(|error| {
        UploadError::Message(format!("Failed to save WarcraftLogs login email: {error}"))
    })?;

    Ok(())
}

fn normalize_email_for_match(email: &str) -> String {
    email.trim().to_ascii_lowercase()
}

fn read_saved_email_index() -> Result<Vec<String>, UploadError> {
    let entry = keyring::Entry::new(WCL_LOGIN_SERVICE, WCL_LOGIN_SAVED_EMAIL_INDEX_ACCOUNT)
        .map_err(|error| {
            UploadError::Message(format!("Failed to open secure credential store: {error}"))
        })?;

    match entry.get_password() {
        Ok(raw) => match serde_json::from_str::<Vec<String>>(&raw) {
            Ok(values) => Ok(values
                .into_iter()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .collect()),
            Err(_) => Ok(Vec::new()),
        },
        Err(keyring::Error::NoEntry) => Ok(Vec::new()),
        Err(error) => Err(UploadError::Message(format!(
            "Failed to read saved WarcraftLogs login index: {error}"
        ))),
    }
}

fn write_saved_email_index(emails: &[String]) -> Result<(), UploadError> {
    let entry = keyring::Entry::new(WCL_LOGIN_SERVICE, WCL_LOGIN_SAVED_EMAIL_INDEX_ACCOUNT)
        .map_err(|error| {
            UploadError::Message(format!("Failed to open secure credential store: {error}"))
        })?;

    let serialized = serde_json::to_string(emails).map_err(UploadError::Json)?;
    entry.set_password(&serialized).map_err(|error| {
        UploadError::Message(format!("Failed to save WarcraftLogs login index: {error}"))
    })?;

    Ok(())
}

fn save_email_to_index(email: &str) -> Result<(), UploadError> {
    let trimmed = email.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    let mut emails = read_saved_email_index()?;
    let normalized = normalize_email_for_match(trimmed);
    if !emails
        .iter()
        .any(|existing| normalize_email_for_match(existing) == normalized)
    {
        emails.push(trimmed.to_string());
        write_saved_email_index(&emails)?;
    }

    Ok(())
}

fn clear_saved_email_entry() -> Result<(), UploadError> {
    let entry =
        keyring::Entry::new(WCL_LOGIN_SERVICE, WCL_LOGIN_SAVED_EMAIL_ACCOUNT).map_err(|error| {
            UploadError::Message(format!("Failed to open secure credential store: {error}"))
        })?;

    match entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(UploadError::Message(format!(
            "Failed to clear saved WarcraftLogs login email: {error}"
        ))),
    }
}

fn clear_saved_email_index_entry() -> Result<(), UploadError> {
    let entry = keyring::Entry::new(WCL_LOGIN_SERVICE, WCL_LOGIN_SAVED_EMAIL_INDEX_ACCOUNT)
        .map_err(|error| {
            UploadError::Message(format!("Failed to open secure credential store: {error}"))
        })?;

    match entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(UploadError::Message(format!(
            "Failed to clear saved WarcraftLogs login index: {error}"
        ))),
    }
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

    write_saved_login_email(email)?;
    save_email_to_index(email)?;

    let metadata_path = login_metadata_path(app_handle)?;
    if metadata_path.exists() {
        std::fs::remove_file(metadata_path)?;
    }

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
    let mut emails_to_clear = read_saved_email_index()?;

    if let Some(saved_email) = read_saved_login_email(app_handle)? {
        if !emails_to_clear
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(&saved_email))
        {
            emails_to_clear.push(saved_email);
        }
    }

    if let Some(legacy_email) = read_legacy_saved_login_email(app_handle)? {
        if !emails_to_clear
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(&legacy_email))
        {
            emails_to_clear.push(legacy_email);
        }
    }

    for email in emails_to_clear {
        let entry = keyring::Entry::new(WCL_LOGIN_SERVICE, &email).map_err(|error| {
            UploadError::Message(format!("Failed to open secure credential store: {error}"))
        })?;

        match entry.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => {}
            Err(error) => {
                return Err(UploadError::Message(format!(
                    "Failed to clear saved WarcraftLogs credentials: {error}"
                )));
            }
        }
    }

    clear_saved_email_entry()?;
    clear_saved_email_index_entry()?;

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
