use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::wcl_upload::error::UploadError;
use crate::wcl_upload::types::{ActiveLiveUpload, ActiveUpload, WclScanSession};

lazy_static::lazy_static! {
    pub(crate) static ref ACTIVE_UPLOAD: Mutex<Option<ActiveUpload>> = Mutex::new(None);
    pub(crate) static ref ACTIVE_LIVE_UPLOAD: Mutex<Option<ActiveLiveUpload>> = Mutex::new(None);
    pub(crate) static ref ACTIVE_SCAN: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);
    pub(crate) static ref PENDING_SCAN: Mutex<Option<WclScanSession>> = Mutex::new(None);
}

pub(crate) fn begin_scan_session() -> Result<Arc<AtomicBool>, String> {
    let mut state = ACTIVE_SCAN
        .lock()
        .map_err(|error| format!("Failed to lock scan state: {error}"))?;
    if state.is_some() {
        return Err("A combat log scan is already in progress".to_string());
    }
    let cancel_flag = Arc::new(AtomicBool::new(false));
    *state = Some(cancel_flag.clone());
    Ok(cancel_flag)
}

pub(crate) fn end_scan_session() -> Result<(), String> {
    let mut state = ACTIVE_SCAN
        .lock()
        .map_err(|error| format!("Failed to lock scan state: {error}"))?;
    *state = None;
    Ok(())
}

pub(crate) fn cancel_scan_session() -> Result<(), String> {
    let state = ACTIVE_SCAN
        .lock()
        .map_err(|error| format!("Failed to lock scan state: {error}"))?;
    if let Some(cancel_flag) = state.as_ref() {
        cancel_flag.store(true, Ordering::SeqCst);
    }
    drop(state);
    let mut pending = PENDING_SCAN
        .lock()
        .map_err(|error| format!("Failed to lock pending scan state: {error}"))?;
    *pending = None;
    Ok(())
}

pub(crate) fn store_scan(session: WclScanSession) -> Result<(), String> {
    let mut pending = PENDING_SCAN
        .lock()
        .map_err(|error| format!("Failed to lock pending scan state: {error}"))?;
    *pending = Some(session);
    Ok(())
}

pub(crate) fn get_scan(scan_id: &str) -> Result<WclScanSession, String> {
    let pending = PENDING_SCAN
        .lock()
        .map_err(|error| format!("Failed to lock pending scan state: {error}"))?;
    let Some(session) = pending.as_ref() else {
        return Err("The combat-log scan has expired. Scan the file again.".to_string());
    };
    if session.response.scan_id != scan_id {
        return Err(
            "The combat-log scan does not match this upload. Scan the file again.".to_string(),
        );
    }
    Ok(session.clone())
}

pub(crate) fn clear_scan() -> Result<(), String> {
    let mut pending = PENDING_SCAN
        .lock()
        .map_err(|error| format!("Failed to lock pending scan state: {error}"))?;
    *pending = None;
    Ok(())
}

pub(crate) fn begin_upload_session() -> Result<Arc<AtomicBool>, String> {
    let mut state = ACTIVE_UPLOAD
        .lock()
        .map_err(|error| format!("Failed to lock upload state: {error}"))?;

    if state.is_some() {
        return Err("A WarcraftLogs upload is already in progress".to_string());
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    *state = Some(ActiveUpload {
        cancel_flag: cancel_flag.clone(),
    });
    Ok(cancel_flag)
}

pub(crate) fn end_upload_session() {
    if let Ok(mut state) = ACTIVE_UPLOAD.lock() {
        *state = None;
    }
}

pub(crate) fn check_cancelled(cancel_flag: &Arc<AtomicBool>) -> Result<(), UploadError> {
    if cancel_flag.load(Ordering::SeqCst) {
        Err(UploadError::Cancelled)
    } else {
        Ok(())
    }
}

pub(crate) fn set_live_report_info(
    report_url: Option<String>,
    report_code: Option<String>,
    is_running: bool,
) {
    if let Ok(mut state) = ACTIVE_LIVE_UPLOAD.lock() {
        if let Some(active) = state.as_mut() {
            active.report_url = report_url;
            active.report_code = report_code;
            active.is_running = is_running;
        }
    }
}
