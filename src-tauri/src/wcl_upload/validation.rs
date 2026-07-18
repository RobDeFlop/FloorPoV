use crate::wcl_upload::types::{StartWclLiveUploadRequest, StartWclUploadRequest};

pub(crate) fn validate_request(request: &StartWclUploadRequest) -> Result<(), String> {
    if request.log_file_path.trim().is_empty() {
        return Err("Please choose a combat log file".to_string());
    }

    if !(1..=5).contains(&request.region) {
        return Err("Region must be one of: 1 (US), 2 (EU), 3 (KR), 4 (TW), 5 (CN)".to_string());
    }

    if request.visibility > 2 {
        return Err("Visibility must be one of: 0 (Public), 1 (Private), 2 (Unlisted)".to_string());
    }

    if request.scan_id.as_deref().is_none_or(str::is_empty) {
        return Err(
            "Scan the combat log and select at least one activity before uploading".to_string(),
        );
    }

    if request.selected_activity_ids.is_empty() {
        return Err("Select at least one activity before uploading".to_string());
    }

    Ok(())
}

pub(crate) fn validate_scan_request(log_file_path: &str, region: u8) -> Result<(), String> {
    if log_file_path.trim().is_empty() {
        return Err("Please choose a combat log file".to_string());
    }

    if !(1..=5).contains(&region) {
        return Err("Region must be one of: 1 (US), 2 (EU), 3 (KR), 4 (TW), 5 (CN)".to_string());
    }

    Ok(())
}

pub(crate) fn validate_live_request(request: &StartWclLiveUploadRequest) -> Result<(), String> {
    if request.wow_folder.trim().is_empty() {
        return Err("WoW folder is required for live upload".to_string());
    }

    if !(1..=5).contains(&request.region) {
        return Err("Region must be one of: 1 (US), 2 (EU), 3 (KR), 4 (TW), 5 (CN)".to_string());
    }

    if request.visibility > 2 {
        return Err("Visibility must be one of: 0 (Public), 1 (Private), 2 (Unlisted)".to_string());
    }

    Ok(())
}
