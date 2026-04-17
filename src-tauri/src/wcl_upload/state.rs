use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::wcl_upload::error::UploadError;
use crate::wcl_upload::types::{ActiveLiveUpload, ActiveUpload};

lazy_static::lazy_static! {
    pub(crate) static ref ACTIVE_UPLOAD: Mutex<Option<ActiveUpload>> = Mutex::new(None);
    pub(crate) static ref ACTIVE_LIVE_UPLOAD: Mutex<Option<ActiveLiveUpload>> = Mutex::new(None);
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
