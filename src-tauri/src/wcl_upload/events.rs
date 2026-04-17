use tauri::{AppHandle, Emitter};

use crate::wcl_upload::types::{
    StartWclUploadResponse, WclLiveUploadCompleteEvent, WclUploadCompleteEvent,
    WclUploadErrorEvent, WclUploadProgressEvent,
};

pub(crate) fn emit_upload_progress(app_handle: &AppHandle, step: &str, message: &str, percent: u8) {
    let payload = WclUploadProgressEvent {
        step: step.to_string(),
        message: message.to_string(),
        percent,
    };
    let _ = app_handle.emit("wcl-upload-progress", payload);
}

pub(crate) fn emit_upload_complete(app_handle: &AppHandle, result: &StartWclUploadResponse) {
    let payload = WclUploadCompleteEvent {
        report_url: result.report_url.clone(),
        report_code: result.report_code.clone(),
    };
    let _ = app_handle.emit("wcl-upload-complete", payload);
}

pub(crate) fn emit_upload_error(app_handle: &AppHandle, message: &str) {
    let payload = WclUploadErrorEvent {
        message: message.to_string(),
    };
    let _ = app_handle.emit("wcl-upload-error", payload);
}

pub(crate) fn emit_live_upload_error(app_handle: &AppHandle, message: &str) {
    let payload = WclUploadErrorEvent {
        message: message.to_string(),
    };
    let _ = app_handle.emit("wcl-live-upload-error", payload);
}

pub(crate) fn emit_live_upload_progress(
    app_handle: &AppHandle,
    step: &str,
    message: &str,
    percent: u8,
) {
    let payload = WclUploadProgressEvent {
        step: step.to_string(),
        message: message.to_string(),
        percent,
    };
    let _ = app_handle.emit("wcl-live-upload-progress", payload);
}

pub(crate) fn emit_live_upload_complete(
    app_handle: &AppHandle,
    report_url: Option<String>,
    report_code: Option<String>,
) {
    let payload = WclLiveUploadCompleteEvent {
        report_url,
        report_code,
    };
    let _ = app_handle.emit("wcl-live-upload-complete", payload);
}

pub(crate) fn emit_live_report_created(
    app_handle: &AppHandle,
    report_url: &str,
    report_code: &str,
) {
    let payload = WclLiveUploadCompleteEvent {
        report_url: Some(report_url.to_string()),
        report_code: Some(report_code.to_string()),
    };
    let _ = app_handle.emit("wcl-live-upload-report-created", payload);
}
