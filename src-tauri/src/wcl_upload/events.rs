use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::wcl_upload::types::{
    StartWclUploadResponse, WclLiveUploadCompleteEvent, WclLogScanProgressEvent,
    WclUploadCompleteEvent, WclUploadErrorEvent, WclUploadProgressEvent,
};

pub(crate) fn emit_log_scan_progress(
    app_handle: &AppHandle,
    message: &str,
    processed_bytes: u64,
    total_bytes: u64,
) {
    let percent = if total_bytes == 0 {
        100
    } else {
        ((processed_bytes as f64 / total_bytes as f64) * 100.0).round() as u8
    };
    emit_event(
        app_handle,
        "wcl-log-scan-progress",
        WclLogScanProgressEvent {
            message: message.to_string(),
            processed_bytes,
            total_bytes,
            percent: percent.min(100),
        },
    );
}

pub(crate) fn emit_upload_progress(app_handle: &AppHandle, step: &str, message: &str, percent: u8) {
    let payload = WclUploadProgressEvent {
        step: step.to_string(),
        message: message.to_string(),
        percent,
    };
    emit_event(app_handle, "wcl-upload-progress", payload);
}

pub(crate) fn emit_upload_complete(app_handle: &AppHandle, result: &StartWclUploadResponse) {
    let payload = WclUploadCompleteEvent {
        report_url: result.report_url.clone(),
        report_code: result.report_code.clone(),
    };
    emit_event(app_handle, "wcl-upload-complete", payload);
}

pub(crate) fn emit_upload_error(app_handle: &AppHandle, message: &str) {
    let payload = WclUploadErrorEvent {
        message: message.to_string(),
    };
    emit_event(app_handle, "wcl-upload-error", payload);
}

pub(crate) fn emit_live_upload_error(app_handle: &AppHandle, message: &str) {
    let payload = WclUploadErrorEvent {
        message: message.to_string(),
    };
    emit_event(app_handle, "wcl-live-upload-error", payload);
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
    emit_event(app_handle, "wcl-live-upload-progress", payload);
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
    emit_event(app_handle, "wcl-live-upload-complete", payload);
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
    emit_event(app_handle, "wcl-live-upload-report-created", payload);
}

fn emit_event<T: Serialize + Clone>(app_handle: &AppHandle, event_name: &str, payload: T) {
    if let Err(error) = app_handle.emit(event_name, payload) {
        tracing::warn!(event_name, %error, "Failed to emit WarcraftLogs event");
    }
}
