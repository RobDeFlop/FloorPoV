use crate::wcl_upload::types::{StartWclLiveUploadRequest, StartWclUploadRequest};

pub(crate) fn validate_request(request: &StartWclUploadRequest) -> Result<(), String> {
    if request.log_file_path.trim().is_empty() {
        return Err("Please choose a combat log file".to_string());
    }

    if request.email.trim().is_empty() {
        return Err("WarcraftLogs email is required".to_string());
    }

    if request.password.is_none() && !request.use_saved_login.unwrap_or(false) {
        return Err("WarcraftLogs password is required".to_string());
    }

    if let Some(password) = request.password.as_ref() {
        if password.trim().is_empty() {
            return Err("WarcraftLogs password is required".to_string());
        }
    }

    if !(1..=5).contains(&request.region) {
        return Err("Region must be one of: 1 (US), 2 (EU), 3 (KR), 4 (TW), 5 (CN)".to_string());
    }

    if request.visibility > 2 {
        return Err("Visibility must be one of: 0 (Public), 1 (Private), 2 (Unlisted)".to_string());
    }

    Ok(())
}

pub(crate) fn validate_live_request(request: &StartWclLiveUploadRequest) -> Result<(), String> {
    if request.wow_folder.trim().is_empty() {
        return Err("WoW folder is required for live upload".to_string());
    }

    if request.email.trim().is_empty() {
        return Err("WarcraftLogs email is required".to_string());
    }

    if request.password.is_none() && !request.use_saved_login.unwrap_or(false) {
        return Err("WarcraftLogs password is required".to_string());
    }

    if let Some(password) = request.password.as_ref() {
        if password.trim().is_empty() {
            return Err("WarcraftLogs password is required".to_string());
        }
    }

    if !(1..=5).contains(&request.region) {
        return Err("Region must be one of: 1 (US), 2 (EU), 3 (KR), 4 (TW), 5 (CN)".to_string());
    }

    if request.visibility > 2 {
        return Err("Visibility must be one of: 0 (Public), 1 (Private), 2 (Unlisted)".to_string());
    }

    Ok(())
}
