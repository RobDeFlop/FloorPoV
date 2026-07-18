use regex::Regex;
use reqwest::blocking::{Client, RequestBuilder, Response};
use serde::Deserialize;
use serde_json::json;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use crate::wcl_upload::constants::{
    BASE_URL, BATCH_SIZE, CHROME_VERSION_FALLBACK, CLIENT_VERSION_FALLBACK,
    ELECTRON_VERSION_FALLBACK, LIVE_FLUSH_INTERVAL_MS, LIVE_MAX_READ_LINES_PER_POLL,
    LIVE_POLL_INTERVAL_MS, MAX_RETRIES, PARSER_VERSION_FALLBACK, RETRY_BASE_DELAY_MS,
};
use crate::wcl_upload::error::UploadError;
use crate::wcl_upload::events::{
    emit_live_report_created, emit_live_upload_complete, emit_live_upload_error,
    emit_live_upload_progress, emit_log_scan_progress, emit_upload_complete, emit_upload_error,
    emit_upload_progress,
};
use crate::wcl_upload::filesystem::{
    check_node_runtime, find_latest_combat_log_path, resolve_node_binary_path,
    resolve_parser_harness_path,
};
use crate::wcl_upload::parser::ParserBridge;
use crate::wcl_upload::payload::{
    is_encounter_fight_candidate, normalize_report_description, parse_start_date_from_filename,
};
use crate::wcl_upload::selection::{
    build_activity_groups, ends_activity_boundary, fight_selection_key, record_fight_activity,
    starts_activity_boundary, RawActivityTracker,
};
use crate::wcl_upload::state::{
    begin_scan_session, begin_upload_session, check_cancelled, clear_scan, end_scan_session,
    end_upload_session, get_scan, set_live_report_info, store_scan, ACTIVE_LIVE_UPLOAD,
    ACTIVE_UPLOAD,
};
use crate::wcl_upload::types::{
    ActiveLiveUpload, AddSegmentResponse, CreateReportRequest, CreateReportResponse,
    FetchWclGuildsResponse, LiveUploadRuntime, LoginResponse, MasterIds, ParserAssets, ParserFight,
    SidebarGuildsResponse, StartWclLiveUploadRequest, StartWclLiveUploadResponse,
    StartWclUploadRequest, StartWclUploadResponse, UploadSessionParams, WclGuild,
    WclLiveUploadState, WclLogScanResponse, WclScanSession,
};
use crate::wcl_upload::upload_pipeline::UploadPipeline;
use crate::wcl_upload::validation::{validate_live_request, validate_request};

enum MultipartFieldValue {
    Text(String),
    File {
        file_name: String,
        content_type: String,
        bytes: Vec<u8>,
    },
}

struct MultipartBody {
    boundary: String,
    payload: Vec<u8>,
}

fn build_multipart_body(
    fields: Vec<(String, MultipartFieldValue)>,
    boundary: String,
) -> MultipartBody {
    let mut payload = Vec::<u8>::new();

    for (name, value) in fields {
        payload.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        match value {
            MultipartFieldValue::Text(text) => {
                payload.extend_from_slice(
                    format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
                );
                payload.extend_from_slice(text.as_bytes());
                payload.extend_from_slice(b"\r\n");
            }
            MultipartFieldValue::File {
                file_name,
                content_type,
                bytes,
            } => {
                payload.extend_from_slice(
                    format!(
                        "Content-Disposition: form-data; name=\"{name}\"; filename=\"{file_name}\"\r\n"
                    )
                    .as_bytes(),
                );
                payload
                    .extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
                payload.extend_from_slice(&bytes);
                payload.extend_from_slice(b"\r\n");
            }
        }
    }

    payload.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

    MultipartBody { boundary, payload }
}

pub async fn scan_wcl_log(
    app_handle: AppHandle,
    log_file_path: String,
    region: u8,
    session: WclSession,
) -> Result<WclLogScanResponse, String> {
    crate::wcl_upload::validation::validate_scan_request(&log_file_path, region)?;
    if ACTIVE_UPLOAD
        .lock()
        .map_err(|error| format!("Failed to lock upload state: {error}"))?
        .is_some()
        || ACTIVE_LIVE_UPLOAD
            .lock()
            .map_err(|error| format!("Failed to lock live upload state: {error}"))?
            .is_some()
    {
        return Err("Stop the active WarcraftLogs upload before scanning a log".to_string());
    }

    clear_scan()?;
    let cancel_flag = begin_scan_session()?;
    let app_handle_for_task = app_handle.clone();
    let task_result = tokio::task::spawn_blocking(move || {
        run_log_scan(
            app_handle_for_task,
            log_file_path,
            region,
            session,
            cancel_flag,
        )
    })
    .await;
    let cleanup_result = end_scan_session();
    let result = task_result.map_err(|error| format!("Combat-log scan task failed: {error}"))?;
    cleanup_result?;

    match result {
        Ok(scan_session) => {
            let response = scan_session.response.clone();
            store_scan(scan_session)?;
            Ok(response)
        }
        Err(error) => Err(error.to_string()),
    }
}

pub fn cancel_wcl_log_scan() -> Result<(), String> {
    crate::wcl_upload::state::cancel_scan_session()
}

pub fn validate_wcl_upload_scan(request: &StartWclUploadRequest) -> Result<(), String> {
    validate_request(request)?;
    let scan = get_scan(
        request
            .scan_id
            .as_deref()
            .ok_or_else(|| "Scan the combat log before uploading".to_string())?,
    )?;
    validate_scan_fingerprint(&scan, &request.log_file_path)?;
    for activity_id in &request.selected_activity_ids {
        if !scan.activity_fight_keys.contains_key(activity_id) {
            return Err(
                "The selected activities are no longer available. Scan the file again.".to_string(),
            );
        }
    }
    Ok(())
}

fn run_log_scan(
    app_handle: AppHandle,
    log_file_path: String,
    region: u8,
    session: WclSession,
    cancel_flag: Arc<AtomicBool>,
) -> Result<WclScanSession, UploadError> {
    let log_path = PathBuf::from(log_file_path.trim());
    let metadata = std::fs::metadata(&log_path)?;
    let file_name = log_path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| UploadError::Message("Invalid combat log filename".to_string()))?
        .to_string();
    let total_bytes = metadata.len();
    let modified_at_ms = file_modified_at_ms(&metadata)?;
    let canonical_path = log_path.canonicalize()?.to_string_lossy().to_string();

    emit_log_scan_progress(
        &app_handle,
        "Preparing combat-log scanner...",
        0,
        total_bytes,
    );
    check_cancelled(&cancel_flag)?;
    let node_binary_path = resolve_node_binary_path(&app_handle)?;
    check_node_runtime(&node_binary_path)?;
    let parser_assets = session.fetch_parser_assets()?;
    let parser_harness_path = resolve_parser_harness_path(&app_handle)?;
    let mut parser = ParserBridge::new(
        &node_binary_path,
        &parser_harness_path,
        &parser_assets.gamedata_code,
        &parser_assets.parser_code,
    )?;
    parser.clear_state()?;
    if let Some(start_date) = parse_start_date_from_filename(&file_name) {
        parser.set_start_date(&start_date)?;
    }

    let mut reader = BufReader::new(File::open(&log_path)?);
    let mut line = String::new();
    let mut batch = Vec::with_capacity(BATCH_SIZE);
    let mut processed_bytes = 0u64;
    let mut fights = Vec::<ParserFight>::new();
    let mut raw_activity_tracker = RawActivityTracker::default();
    let mut batch_activity_id = None;
    let mut activity_by_fight = HashMap::<String, usize>::new();

    loop {
        check_cancelled(&cancel_flag)?;
        line.clear();
        let bytes_read = reader.read_line(&mut line)?;
        if bytes_read == 0 {
            flush_scan_batch(
                &mut parser,
                &mut batch,
                region,
                batch_activity_id.take(),
                &mut fights,
                &mut activity_by_fight,
            )?;
            break;
        }
        processed_bytes = processed_bytes.saturating_add(bytes_read as u64);
        let trimmed_line = line.trim_end_matches(['\r', '\n']);
        if starts_activity_boundary(trimmed_line) {
            flush_scan_batch(
                &mut parser,
                &mut batch,
                region,
                batch_activity_id.take(),
                &mut fights,
                &mut activity_by_fight,
            )?;
        }
        let active_before_line = raw_activity_tracker.active_activity_id();
        raw_activity_tracker.observe_line(trimmed_line);
        if batch.is_empty() {
            batch_activity_id = raw_activity_tracker
                .active_activity_id()
                .or(active_before_line);
        }
        batch.push(trimmed_line.to_string());
        if ends_activity_boundary(trimmed_line) || batch.len() >= BATCH_SIZE {
            flush_scan_batch(
                &mut parser,
                &mut batch,
                region,
                batch_activity_id.take(),
                &mut fights,
                &mut activity_by_fight,
            )?;
            emit_log_scan_progress(
                &app_handle,
                "Scanning combat log activities...",
                processed_bytes,
                total_bytes,
            );
        }
    }

    if fights.is_empty() {
        return Err(UploadError::Message(
            "No fights or activities were detected in this combat log".to_string(),
        ));
    }

    let raw_activities = raw_activity_tracker.finish();
    let (groups, activity_fight_keys) =
        build_activity_groups(&fights, &raw_activities, &activity_by_fight);
    if groups.is_empty() {
        return Err(UploadError::Message(
            "No selectable activities were detected in this combat log".to_string(),
        ));
    }
    let scan_id = format!(
        "scan-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    );
    emit_log_scan_progress(
        &app_handle,
        "Activity scan complete",
        total_bytes,
        total_bytes,
    );
    Ok(WclScanSession {
        response: WclLogScanResponse {
            scan_id,
            file_name,
            file_size_bytes: total_bytes,
            modified_at_ms,
            groups,
        },
        canonical_path,
        activity_fight_keys,
    })
}

fn flush_scan_batch(
    parser: &mut ParserBridge,
    batch: &mut Vec<String>,
    region: u8,
    activity_id: Option<usize>,
    fights: &mut Vec<ParserFight>,
    activity_by_fight: &mut HashMap<String, usize>,
) -> Result<(), UploadError> {
    if batch.is_empty() {
        return Ok(());
    }
    parser.parse_lines(batch, region)?;
    let batch_fights = parser.collect_fights(true)?.fights;
    record_fight_activity(&batch_fights, activity_id, activity_by_fight);
    fights.extend(batch_fights);
    parser.clear_fights()?;
    batch.clear();
    Ok(())
}

fn file_modified_at_ms(metadata: &std::fs::Metadata) -> Result<u64, UploadError> {
    Ok(metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            UploadError::Message(format!("Invalid combat-log modified time: {error}"))
        })?
        .as_millis() as u64)
}

fn validate_scan_fingerprint(scan: &WclScanSession, requested_path: &str) -> Result<(), String> {
    let current_path = PathBuf::from(requested_path.trim())
        .canonicalize()
        .map_err(|error| format!("Could not re-check combat log before upload: {error}"))?;
    if current_path.to_string_lossy() != scan.canonical_path {
        return Err(
            "The selected combat log path changed since scanning. Scan it again.".to_string(),
        );
    }
    let metadata = std::fs::metadata(&current_path)
        .map_err(|error| format!("Could not re-check combat log before upload: {error}"))?;
    let modified_at_ms = file_modified_at_ms(&metadata).map_err(|error| error.to_string())?;
    if metadata.len() != scan.response.file_size_bytes
        || modified_at_ms != scan.response.modified_at_ms
    {
        return Err(
            "The combat log changed since scanning. Scan it again before uploading.".to_string(),
        );
    }
    Ok(())
}

fn random_multipart_boundary() -> String {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("----WebKitFormBoundary{nonce:x}")
}

#[derive(Clone)]
pub(crate) struct WclSession {
    client: Client,
    client_version: String,
    user_agent: String,
}

impl WclSession {
    pub(crate) fn new(client_version: String) -> Result<Self, UploadError> {
        let client = Client::builder()
            .cookie_store(true)
            .timeout(Duration::from_secs(60))
            .build()?;

        let chrome_version = std::env::var("WCL_CHROME_VERSION")
            .unwrap_or_else(|_| CHROME_VERSION_FALLBACK.to_string());
        let electron_version = std::env::var("WCL_ELECTRON_VERSION")
            .unwrap_or_else(|_| ELECTRON_VERSION_FALLBACK.to_string());
        let user_agent = format!(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ArchonApp/{} Chrome/{} Electron/{} Safari/537.36",
            client_version, chrome_version, electron_version,
        );

        Ok(Self {
            client,
            client_version,
            user_agent,
        })
    }

    fn request_with_retry<F>(
        &self,
        request_label: &str,
        mut make_request: F,
    ) -> Result<Response, UploadError>
    where
        F: FnMut() -> RequestBuilder,
    {
        for attempt in 0..=MAX_RETRIES {
            let response = make_request().send();

            match response {
                Ok(response) => {
                    let status = response.status();
                    if status.is_success() {
                        return Ok(response);
                    }

                    if (status.as_u16() == 429 || status.is_server_error()) && attempt < MAX_RETRIES
                    {
                        sleep_with_backoff(attempt);
                        continue;
                    }

                    return Err(UploadError::HttpStatus {
                        request_label: request_label.to_string(),
                        status: status.as_u16(),
                    });
                }
                Err(error) => {
                    if attempt < MAX_RETRIES {
                        sleep_with_backoff(attempt);
                        continue;
                    }
                    return Err(UploadError::Http(error));
                }
            }
        }

        Err(UploadError::Message(
            "WarcraftLogs request failed after retries".to_string(),
        ))
    }

    pub(crate) fn login(&self, email: &str, password: &str) -> Result<Option<String>, UploadError> {
        let response = self.request_with_retry("POST /desktop-client/log-in", || {
            self.client
                .post(format!("{BASE_URL}/desktop-client/log-in"))
                .header("User-Agent", &self.user_agent)
                .json(&json!({
                    "email": email,
                    "password": password,
                    "version": self.client_version,
                }))
        })?;

        let parsed = response.json::<LoginResponse>()?;
        Ok(parsed.user.map(|user| user.user_name))
    }

    pub(crate) fn fetch_sidebar_guilds(&self) -> Result<Vec<WclGuild>, UploadError> {
        let response = self.request_with_retry("GET /user-sidebar/v2/", || {
            self.client
                .get(format!("{BASE_URL}/user-sidebar/v2/"))
                .header("User-Agent", &self.user_agent)
        })?;

        let payload = response.json::<SidebarGuildsResponse>()?;
        let sections = payload
            .guilds
            .and_then(|guilds| guilds.guilds_panel)
            .map(|panel| panel.sections)
            .unwrap_or_default();

        let mut unique_ids = BTreeSet::new();
        let mut guilds = Vec::<WclGuild>::new();

        for section in sections {
            let Some(header) = section.header else {
                continue;
            };
            let Some(id_string) = header.id else {
                continue;
            };
            let Ok(id) = id_string.parse::<u32>() else {
                continue;
            };
            if !unique_ids.insert(id) {
                continue;
            }

            let name = header
                .title
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| format!("Guild {id}"));
            guilds.push(WclGuild { id, name });
        }

        Ok(guilds)
    }

    pub(crate) fn fetch_parser_assets(&self) -> Result<ParserAssets, UploadError> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let parser_url = format!(
            "{BASE_URL}/desktop-client/parser?id=1&ts={timestamp}&gameContentDetectionEnabled=false&metersEnabled=false&liveFightDataEnabled=false"
        );

        let parser_page = self
            .request_with_retry("GET /desktop-client/parser", || {
                self.client
                    .get(&parser_url)
                    .header("User-Agent", &self.user_agent)
            })?
            .text()?;

        let parser_asset_regex =
            Regex::new(r#"src=\"(https://assets\.rpglogs\.com/js/parser-warcraft[^\"]+)\""#)
                .map_err(|error| {
                    UploadError::Message(format!("Invalid parser URL regex: {error}"))
                })?;
        let parser_asset_url = parser_asset_regex
            .captures(&parser_page)
            .and_then(|captures| captures.get(1))
            .map(|match_value| match_value.as_str().to_string())
            .ok_or_else(|| {
                UploadError::Message(
                    "Could not find parser-warcraft asset URL in parser page".to_string(),
                )
            })?;

        let parser_version_regex =
            Regex::new(r"const parserVersion\s*=\s*(\d+)").map_err(|error| {
                UploadError::Message(format!("Invalid parser version regex: {error}"))
            })?;
        let parser_version = parser_version_regex
            .captures(&parser_page)
            .and_then(|captures| captures.get(1))
            .and_then(|match_value| match_value.as_str().parse::<u32>().ok())
            .unwrap_or(PARSER_VERSION_FALLBACK);

        let gamedata_regex =
            Regex::new(r"<script[^>]*>([\s\S]*?window\.gameContentTypes[\s\S]*?)</script>")
                .map_err(|error| {
                    UploadError::Message(format!("Invalid gamedata regex: {error}"))
                })?;
        let gamedata_code = gamedata_regex
            .captures(&parser_page)
            .and_then(|captures| captures.get(1))
            .map(|match_value| match_value.as_str().trim().to_string())
            .unwrap_or_default();

        let parser_code = self
            .request_with_retry("GET parser-warcraft asset", || {
                self.client
                    .get(&parser_asset_url)
                    .header("User-Agent", &self.user_agent)
            })?
            .text()?;

        Ok(ParserAssets {
            gamedata_code,
            parser_code,
            parser_version,
        })
    }

    pub(crate) fn create_report(
        &self,
        request: &CreateReportRequest,
    ) -> Result<String, UploadError> {
        let response = self.request_with_retry("POST /desktop-client/create-report", || {
            self.client
                .post(format!("{BASE_URL}/desktop-client/create-report"))
                .header("User-Agent", &self.user_agent)
                .json(&json!({
                    "clientVersion": self.client_version,
                    "parserVersion": request.parser_version,
                    "startTime": request.start_time,
                    "endTime": request.end_time,
                    "guildId": request.guild_id,
                    "fileName": request.file_name,
                    "serverOrRegion": request.region,
                    "visibility": request.visibility,
                    "reportTagId": serde_json::Value::Null,
                    "description": request.description,
                }))
        })?;

        let payload = response.json::<CreateReportResponse>()?;
        Ok(payload.code)
    }

    pub(crate) fn set_master_table(
        &self,
        report_code: &str,
        segment_id: u64,
        zip_bytes: Vec<u8>,
    ) -> Result<(), UploadError> {
        let endpoint = format!("{BASE_URL}/desktop-client/set-report-master-table/{report_code}");

        let body = build_multipart_body(
            vec![
                (
                    "segmentId".to_string(),
                    MultipartFieldValue::Text(segment_id.to_string()),
                ),
                (
                    "isRealTime".to_string(),
                    MultipartFieldValue::Text("false".to_string()),
                ),
                (
                    "logfile".to_string(),
                    MultipartFieldValue::File {
                        file_name: "blob".to_string(),
                        content_type: "application/zip".to_string(),
                        bytes: zip_bytes.clone(),
                    },
                ),
            ],
            random_multipart_boundary(),
        );

        self.request_with_retry(
            "POST /desktop-client/set-report-master-table/{reportCode}",
            || {
                self.client
                    .post(&endpoint)
                    .header("User-Agent", &self.user_agent)
                    .header(
                        "Content-Type",
                        format!("multipart/form-data; boundary={}", body.boundary),
                    )
                    .body(body.payload.clone())
            },
        )?;

        Ok(())
    }

    pub(crate) fn add_segment(
        &self,
        request: crate::wcl_upload::types::AddSegmentRequest,
    ) -> Result<u64, UploadError> {
        let endpoint = format!(
            "{BASE_URL}/desktop-client/add-report-segment/{}",
            request.report_code
        );
        let parameters = json!({
            "startTime": request.start_time,
            "endTime": request.end_time,
            "mythic": request.mythic,
            "isLiveLog": request.is_live_log,
            "isRealTime": false,
            "inProgressEventCount": 0,
            "segmentId": request.segment_id,
        })
        .to_string();

        let body = build_multipart_body(
            vec![
                (
                    "parameters".to_string(),
                    MultipartFieldValue::Text(parameters.clone()),
                ),
                (
                    "logfile".to_string(),
                    MultipartFieldValue::File {
                        file_name: "blob".to_string(),
                        content_type: "application/zip".to_string(),
                        bytes: request.zip_bytes.clone(),
                    },
                ),
            ],
            random_multipart_boundary(),
        );

        let response = self.request_with_retry(
            "POST /desktop-client/add-report-segment/{reportCode}",
            || {
                self.client
                    .post(&endpoint)
                    .header("User-Agent", &self.user_agent)
                    .header(
                        "Content-Type",
                        format!("multipart/form-data; boundary={}", body.boundary),
                    )
                    .body(body.payload.clone())
            },
        )?;

        let payload = response.json::<AddSegmentResponse>()?;
        Ok(payload.next_segment_id.unwrap_or(request.segment_id + 1))
    }

    fn terminate_report(&self, report_code: &str) -> Result<(), UploadError> {
        self.request_with_retry("POST /desktop-client/terminate-report/{reportCode}", || {
            self.client
                .post(format!(
                    "{BASE_URL}/desktop-client/terminate-report/{report_code}"
                ))
                .header("User-Agent", &self.user_agent)
        })?;

        Ok(())
    }
}

pub async fn start_wcl_upload(
    app_handle: AppHandle,
    request: StartWclUploadRequest,
    session: WclSession,
    user_name: Option<String>,
) -> Result<StartWclUploadResponse, String> {
    validate_wcl_upload_scan(&request)?;
    let selected_fight_keys = selected_fight_keys_for_request(&request)?;
    clear_scan()?;

    let cancel_flag = begin_upload_session()?;
    let app_handle_for_task = app_handle.clone();
    let request_for_task = request.clone();
    let cancel_flag_for_task = cancel_flag.clone();

    let upload_result = tokio::task::spawn_blocking(move || {
        run_upload(
            app_handle_for_task,
            request_for_task,
            cancel_flag_for_task,
            session,
            user_name,
            selected_fight_keys,
        )
    })
    .await;

    end_upload_session();

    let upload_result = upload_result.map_err(|error| format!("Upload task failed: {error}"))?;

    match upload_result {
        Ok(response) => {
            emit_upload_complete(&app_handle, &response);
            Ok(response)
        }
        Err(error) => {
            let message = error.to_string();
            emit_upload_error(&app_handle, &message);
            Err(message)
        }
    }
}

fn selected_fight_keys_for_request(
    request: &StartWclUploadRequest,
) -> Result<HashSet<String>, String> {
    let scan_id = request
        .scan_id
        .as_deref()
        .ok_or_else(|| "Scan the combat log before uploading".to_string())?;
    let scan = get_scan(scan_id)?;
    let mut keys = HashSet::new();
    for activity_id in &request.selected_activity_ids {
        let Some(activity_keys) = scan.activity_fight_keys.get(activity_id) else {
            return Err(
                "The selected activities are no longer available. Scan the file again.".to_string(),
            );
        };
        keys.extend(activity_keys.iter().cloned());
    }
    if keys.is_empty() {
        return Err("The selected activities contain no uploadable fights".to_string());
    }
    Ok(keys)
}

pub fn cancel_wcl_upload() -> Result<(), String> {
    let state = ACTIVE_UPLOAD
        .lock()
        .map_err(|error| format!("Failed to lock upload state: {error}"))?;

    let Some(active_upload) = state.as_ref() else {
        return Err("No WarcraftLogs upload is currently in progress".to_string());
    };

    active_upload.cancel_flag.store(true, Ordering::SeqCst);
    Ok(())
}

pub fn get_latest_combat_log_path(wow_folder: Option<String>) -> Result<Option<String>, String> {
    let Some(folder) = wow_folder else {
        return Ok(None);
    };

    let trimmed_folder = folder.trim();
    if trimmed_folder.is_empty() {
        return Ok(None);
    }

    find_latest_combat_log_path(trimmed_folder)
        .map(|maybe_path| maybe_path.map(|path| path.to_string_lossy().to_string()))
}

pub fn fetch_wcl_guilds(
    session: &WclSession,
    email: String,
) -> Result<FetchWclGuildsResponse, UploadError> {
    let guilds = session.fetch_sidebar_guilds()?;

    Ok(FetchWclGuildsResponse { email, guilds })
}

pub fn get_wcl_live_upload_state() -> Result<WclLiveUploadState, String> {
    let state = ACTIVE_LIVE_UPLOAD
        .lock()
        .map_err(|error| format!("Failed to lock live upload state: {error}"))?;
    if let Some(active) = state.as_ref() {
        return Ok(WclLiveUploadState {
            is_running: active.is_running,
            report_url: active.report_url.clone(),
            report_code: active.report_code.clone(),
        });
    }

    Ok(WclLiveUploadState {
        is_running: false,
        report_url: None,
        report_code: None,
    })
}

pub fn start_wcl_live_upload(
    app_handle: AppHandle,
    request: StartWclLiveUploadRequest,
    session: WclSession,
    user_name: Option<String>,
    auth_service: crate::wcl_upload::auth_service::WclAuthService,
) -> Result<StartWclLiveUploadResponse, String> {
    validate_live_request(&request)?;

    let mut state = ACTIVE_LIVE_UPLOAD
        .lock()
        .map_err(|error| format!("Failed to lock live upload state: {error}"))?;
    if state.is_some() {
        return Err("WarcraftLogs live upload is already running".to_string());
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    let cancel_for_worker = Arc::clone(&cancel_flag);
    let app_handle_for_worker = app_handle.clone();

    let handle = std::thread::spawn(move || {
        let worker_handle_clone = app_handle_for_worker.clone();
        let live_result = run_live_upload(
            app_handle_for_worker,
            request,
            cancel_for_worker,
            session,
            user_name,
        );
        if let Err(error) = live_result {
            if let Err(invalidation_error) =
                auth_service.invalidate_if_authentication_failed(&error.to_string())
            {
                tracing::warn!("Failed to invalidate WarcraftLogs session: {invalidation_error}");
            }
            if let Ok(mut state) = ACTIVE_LIVE_UPLOAD.lock() {
                if let Some(active) = state.as_mut() {
                    active.is_running = false;
                }
            }
            emit_live_upload_error(&worker_handle_clone, &error.to_string());
            set_live_report_info(None, None, false);
        }

        if let Ok(mut state) = ACTIVE_LIVE_UPLOAD.lock() {
            *state = None;
        }
    });

    *state = Some(ActiveLiveUpload {
        cancel_flag,
        handle: Some(handle),
        is_running: true,
        report_url: None,
        report_code: None,
    });

    Ok(StartWclLiveUploadResponse {
        report_url: None,
        report_code: None,
    })
}

pub fn stop_wcl_live_upload() -> Result<(), String> {
    let handle_to_join = {
        let mut state = ACTIVE_LIVE_UPLOAD
            .lock()
            .map_err(|error| format!("Failed to lock live upload state: {error}"))?;
        let Some(active) = state.as_mut() else {
            return Err("No WarcraftLogs live upload is currently running".to_string());
        };

        active.cancel_flag.store(true, Ordering::SeqCst);
        active.is_running = false;
        active.handle.take()
    };

    if let Some(handle) = handle_to_join {
        let _ = handle.join();
    }

    let mut state = ACTIVE_LIVE_UPLOAD
        .lock()
        .map_err(|error| format!("Failed to lock live upload state: {error}"))?;
    *state = None;
    Ok(())
}

fn run_live_upload(
    app_handle: AppHandle,
    request: StartWclLiveUploadRequest,
    cancel_flag: Arc<AtomicBool>,
    session: WclSession,
    user_name: Option<String>,
) -> Result<(), UploadError> {
    set_live_report_info(None, None, true);
    let normalized_description = normalize_report_description(request.description.as_deref());

    let wow_folder = request.wow_folder.trim();
    if wow_folder.is_empty() {
        return Err(UploadError::Message("WoW folder is required".to_string()));
    }

    let log_path = find_latest_combat_log_path(wow_folder)
        .map_err(UploadError::Message)?
        .ok_or_else(|| UploadError::Message("No WoWCombatLog*.txt file found".to_string()))?;

    let file_name = log_path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| UploadError::Message("Invalid combat log filename".to_string()))?
        .to_string();

    emit_live_upload_progress(&app_handle, "live", "Starting live upload session...", 2);
    check_cancelled(&cancel_flag)?;

    let node_binary_path = resolve_node_binary_path(&app_handle)?;
    check_node_runtime(&node_binary_path)?;

    emit_live_upload_progress(
        &app_handle,
        "auth",
        "Authenticating with WarcraftLogs...",
        4,
    );
    if let Some(user_name) = user_name {
        emit_live_upload_progress(&app_handle, "auth", &format!("Logged in as {user_name}"), 6);
    } else {
        emit_live_upload_progress(&app_handle, "auth", "Authenticated with WarcraftLogs", 6);
    }

    emit_live_upload_progress(
        &app_handle,
        "parser",
        "Fetching latest WarcraftLogs parser...",
        8,
    );
    let parser_assets = session.fetch_parser_assets()?;
    let parser_harness_path = resolve_parser_harness_path(&app_handle)?;
    let mut parser = ParserBridge::new(
        &node_binary_path,
        &parser_harness_path,
        &parser_assets.gamedata_code,
        &parser_assets.parser_code,
    )?;
    parser.clear_state()?;
    if let Some(start_date) = parse_start_date_from_filename(&file_name) {
        parser.set_start_date(&start_date)?;
    }

    let initial_file_length = std::fs::metadata(&log_path)?.len();
    let initial_offset = if request.include_existing_contents {
        0
    } else {
        initial_file_length
    };
    let mut runtime = LiveUploadRuntime {
        session,
        parser,
        parser_version: parser_assets.parser_version,
        report_code: None,
        segment_id: 1,
        last_master_ids: None,
        upload_params: UploadSessionParams {
            region: request.region,
            visibility: request.visibility,
            guild_id: request.guild_id,
            description: normalized_description,
        },
        wow_folder: wow_folder.to_string(),
        file_name,
        log_path,
        file_offset: initial_offset,
        buffered_lines: Vec::new(),
        last_flush_at: Instant::now(),
        total_uploaded_lines: 0,
        initial_file_length,
        include_existing_contents: request.include_existing_contents,
        reported_existing_contents: !request.include_existing_contents,
    };

    // WarcraftLogs requires a valid initial time range even when no encounter
    // has been parsed yet. The live segments update the report with real event
    // timestamps as soon as combat data becomes available.
    let report_start_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    emit_live_upload_progress(
        &app_handle,
        "report",
        "Creating WarcraftLogs live report...",
        10,
    );
    let created_code = runtime.session.create_report(&CreateReportRequest {
        file_name: runtime.file_name.clone(),
        parser_version: runtime.parser_version,
        start_time: report_start_time,
        end_time: report_start_time.saturating_add(1),
        description: runtime.upload_params.description.clone(),
        region: runtime.upload_params.region,
        visibility: runtime.upload_params.visibility,
        guild_id: runtime.upload_params.guild_id,
    })?;
    let report_url = format!("https://www.warcraftlogs.com/reports/{created_code}");
    runtime.report_code = Some(created_code.clone());
    emit_live_upload_progress(
        &app_handle,
        "report",
        &format!("Live report created: {report_url}"),
        12,
    );
    emit_live_report_created(&app_handle, &report_url, &created_code);
    set_live_report_info(Some(report_url), Some(created_code), true);

    emit_live_upload_progress(
        &app_handle,
        "live",
        if runtime.include_existing_contents {
            "Live upload is active. Processing existing combat log contents..."
        } else {
            "Live upload is active. Waiting for new combat log lines..."
        },
        14,
    );

    loop {
        if cancel_flag.load(Ordering::SeqCst) {
            break;
        }

        read_live_log_lines(&mut runtime)?;

        let should_flush = runtime.buffered_lines.len() >= BATCH_SIZE
            || (!runtime.buffered_lines.is_empty()
                && runtime.last_flush_at.elapsed()
                    >= Duration::from_millis(LIVE_FLUSH_INTERVAL_MS));

        if should_flush {
            flush_live_buffer(&app_handle, &mut runtime, &cancel_flag, false)?;
        }

        if runtime.include_existing_contents
            && !runtime.reported_existing_contents
            && runtime.file_offset >= runtime.initial_file_length
        {
            runtime.reported_existing_contents = true;
            emit_live_upload_progress(
                &app_handle,
                "live",
                "Existing combat log contents processed. Waiting for new lines...",
                30,
            );
        }

        std::thread::sleep(Duration::from_millis(LIVE_POLL_INTERVAL_MS));
    }

    if !runtime.buffered_lines.is_empty() {
        flush_live_buffer(&app_handle, &mut runtime, &cancel_flag, true)?;
    }

    if let Some(report_code) = runtime.report_code.clone() {
        runtime.session.terminate_report(&report_code)?;
        let report_url = format!("https://www.warcraftlogs.com/reports/{report_code}");
        emit_live_upload_complete(
            &app_handle,
            Some(report_url.clone()),
            Some(report_code.clone()),
        );
        set_live_report_info(Some(report_url), Some(report_code), false);
    } else {
        emit_live_upload_complete(&app_handle, None, None);
        set_live_report_info(None, None, false);
    }

    Ok(())
}

fn run_upload(
    app_handle: AppHandle,
    request: StartWclUploadRequest,
    cancel_flag: Arc<AtomicBool>,
    session: WclSession,
    user_name: Option<String>,
    selected_fight_keys: HashSet<String>,
) -> Result<StartWclUploadResponse, UploadError> {
    let normalized_description = normalize_report_description(request.description.as_deref());

    let log_path = PathBuf::from(request.log_file_path.trim());
    if !log_path.exists() {
        return Err(UploadError::Message(format!(
            "Combat log file does not exist: {}",
            log_path.display()
        )));
    }

    let file_name = log_path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| UploadError::Message("Invalid combat log filename".to_string()))?
        .to_string();

    emit_upload_progress(&app_handle, "read", "Reading combat log metadata...", 2);
    check_cancelled(&cancel_flag)?;
    let total_lines = count_file_lines(&log_path, &cancel_flag)?;
    emit_upload_progress(
        &app_handle,
        "read",
        &format!("Combat log contains {total_lines} lines"),
        4,
    );

    check_cancelled(&cancel_flag)?;
    let node_binary_path = resolve_node_binary_path(&app_handle)?;
    emit_upload_progress(
        &app_handle,
        "parser",
        &format!(
            "Using bundled Node runtime at {}",
            node_binary_path.display()
        ),
        5,
    );

    check_cancelled(&cancel_flag)?;
    check_node_runtime(&node_binary_path)?;

    check_cancelled(&cancel_flag)?;
    emit_upload_progress(
        &app_handle,
        "auth",
        "Authenticating with WarcraftLogs...",
        6,
    );
    if let Some(user_name) = user_name {
        emit_upload_progress(&app_handle, "auth", &format!("Logged in as {user_name}"), 8);
    } else {
        emit_upload_progress(&app_handle, "auth", "Authenticated with WarcraftLogs", 8);
    }

    check_cancelled(&cancel_flag)?;
    emit_upload_progress(
        &app_handle,
        "parser",
        "Fetching latest WarcraftLogs parser...",
        10,
    );
    let parser_assets = session.fetch_parser_assets()?;
    emit_upload_progress(
        &app_handle,
        "parser",
        &format!("Loaded parser v{}", parser_assets.parser_version),
        12,
    );

    check_cancelled(&cancel_flag)?;
    let parser_harness_path = resolve_parser_harness_path(&app_handle)?;
    emit_upload_progress(
        &app_handle,
        "parser",
        &format!("Using parser harness at {}", parser_harness_path.display()),
        13,
    );
    let mut parser = ParserBridge::new(
        &node_binary_path,
        &parser_harness_path,
        &parser_assets.gamedata_code,
        &parser_assets.parser_code,
    )?;
    parser.clear_state()?;

    if let Some(start_date) = parse_start_date_from_filename(&file_name) {
        parser.set_start_date(&start_date)?;
    }

    emit_upload_progress(
        &app_handle,
        "parser",
        "Parser ready. Beginning upload...",
        14,
    );

    let total_batches = if total_lines == 0 {
        0
    } else {
        (total_lines as usize).div_ceil(BATCH_SIZE)
    };

    let mut line_reader = BufReader::new(File::open(&log_path)?);
    let mut line = String::new();
    let mut batch_lines: Vec<String> = Vec::with_capacity(BATCH_SIZE);
    let mut processed_lines: u64 = 0;
    let mut batch_number: usize = 0;
    let mut report_code: Option<String> = None;
    let mut segment_id: u64 = 1;
    let mut last_master_ids: Option<MasterIds> = None;

    let resolved_guild_id = request.guild_id;

    loop {
        check_cancelled(&cancel_flag)?;

        line.clear();
        let bytes_read = line_reader.read_line(&mut line)?;
        if bytes_read == 0 {
            if !batch_lines.is_empty() {
                batch_number += 1;
                process_batch(
                    &app_handle,
                    &session,
                    &mut parser,
                    &request,
                    &normalized_description,
                    resolved_guild_id,
                    &file_name,
                    &batch_lines,
                    batch_number,
                    total_batches,
                    parser_assets.parser_version,
                    &mut report_code,
                    &mut segment_id,
                    &mut last_master_ids,
                    &cancel_flag,
                    &selected_fight_keys,
                )?;
                batch_lines.clear();
            }
            break;
        }

        let trimmed_line = line.trim_end_matches(['\r', '\n']);
        if starts_activity_boundary(trimmed_line) && !batch_lines.is_empty() {
            batch_number += 1;
            process_batch(
                &app_handle,
                &session,
                &mut parser,
                &request,
                &normalized_description,
                resolved_guild_id,
                &file_name,
                &batch_lines,
                batch_number,
                total_batches,
                parser_assets.parser_version,
                &mut report_code,
                &mut segment_id,
                &mut last_master_ids,
                &cancel_flag,
                &selected_fight_keys,
            )?;
            processed_lines += batch_lines.len() as u64;
            batch_lines.clear();
        }

        batch_lines.push(trimmed_line.to_string());

        if ends_activity_boundary(trimmed_line) || batch_lines.len() >= BATCH_SIZE {
            batch_number += 1;
            process_batch(
                &app_handle,
                &session,
                &mut parser,
                &request,
                &normalized_description,
                resolved_guild_id,
                &file_name,
                &batch_lines,
                batch_number,
                total_batches,
                parser_assets.parser_version,
                &mut report_code,
                &mut segment_id,
                &mut last_master_ids,
                &cancel_flag,
                &selected_fight_keys,
            )?;
            processed_lines += batch_lines.len() as u64;
            batch_lines.clear();

            let progress_percent = if total_lines == 0 {
                90
            } else {
                let fraction = (processed_lines as f64 / total_lines as f64).clamp(0.0, 1.0);
                14 + (fraction * 82.0) as u8
            };
            emit_upload_progress(
                &app_handle,
                "upload",
                &format!("Processed {processed_lines}/{total_lines} lines"),
                progress_percent.min(96),
            );
        }
    }

    let Some(report_code) = report_code else {
        return Err(UploadError::Message(
            "No fights found in combat log. Nothing was uploaded.".to_string(),
        ));
    };

    check_cancelled(&cancel_flag)?;
    emit_upload_progress(
        &app_handle,
        "finalize",
        "Finalizing WarcraftLogs report...",
        98,
    );
    session.terminate_report(&report_code)?;

    let report_url = format!("https://www.warcraftlogs.com/reports/{report_code}");
    emit_upload_progress(&app_handle, "done", "Upload complete", 100);

    Ok(StartWclUploadResponse {
        report_url,
        report_code,
    })
}

#[allow(clippy::too_many_arguments)]
fn process_batch(
    app_handle: &AppHandle,
    session: &WclSession,
    parser: &mut ParserBridge,
    request: &StartWclUploadRequest,
    description: &str,
    resolved_guild_id: Option<u32>,
    file_name: &str,
    lines: &[String],
    batch_number: usize,
    total_batches: usize,
    parser_version: u32,
    report_code: &mut Option<String>,
    segment_id: &mut u64,
    last_master_ids: &mut Option<MasterIds>,
    cancel_flag: &Arc<AtomicBool>,
    selected_fight_keys: &HashSet<String>,
) -> Result<(), UploadError> {
    check_cancelled(cancel_flag)?;

    parser.parse_lines(lines, request.region)?;
    let mut fights_data = parser.collect_fights(true)?;
    fights_data
        .fights
        .retain(|fight| selected_fight_keys.contains(&fight_selection_key(fight)));

    if fights_data.fights.is_empty() {
        parser.clear_fights()?;
        emit_upload_progress(
            app_handle,
            "parse",
            &format!("Batch {batch_number}/{total_batches}: no fights found yet"),
            20,
        );
        return Ok(());
    }

    if report_code.is_none() {
        check_cancelled(cancel_flag)?;
        emit_upload_progress(app_handle, "report", "Creating WarcraftLogs report...", 21);

        let created_code = session.create_report(&CreateReportRequest {
            file_name: file_name.to_string(),
            parser_version,
            start_time: fights_data.start_time,
            end_time: fights_data.end_time,
            description: description.to_string(),
            region: request.region,
            visibility: request.visibility,
            guild_id: resolved_guild_id,
        })?;

        *report_code = Some(created_code.clone());
        emit_upload_progress(
            app_handle,
            "report",
            &format!("Created report {created_code}"),
            22,
        );
    }

    let code = report_code
        .as_ref()
        .ok_or_else(|| UploadError::Message("Report code missing during upload".to_string()))?;

    check_cancelled(cancel_flag)?;
    let segment_number = *segment_id;
    let mut pipeline = UploadPipeline::new(
        session,
        parser,
        code,
        segment_id,
        last_master_ids,
        cancel_flag,
    );
    let master_uploaded = pipeline.prepare_master_info()?;
    let master_message = if master_uploaded {
        format!("Uploading master table for segment {segment_number}...")
    } else {
        format!("Master table unchanged for segment {segment_number}")
    };
    emit_upload_progress(app_handle, "master", &master_message, 23);

    emit_upload_progress(
        app_handle,
        "segment",
        &format!("Uploading segment {segment_number}..."),
        24,
    );
    let (total_events, _) = pipeline.upload_segment(&fights_data, false)?;

    emit_upload_progress(
        app_handle,
        "upload",
        &format!("Batch {batch_number}/{total_batches}: uploaded {total_events} events"),
        24,
    );

    Ok(())
}

fn flush_live_buffer(
    app_handle: &AppHandle,
    runtime: &mut LiveUploadRuntime,
    cancel_flag: &Arc<AtomicBool>,
    push_fight_if_needed: bool,
) -> Result<(), UploadError> {
    if runtime.buffered_lines.is_empty() {
        return Ok(());
    }

    runtime
        .parser
        .parse_lines(&runtime.buffered_lines, runtime.upload_params.region)?;
    let mut fights_data = runtime.parser.collect_fights(push_fight_if_needed)?;
    let original_fights = fights_data.fights.clone();

    let original_count = fights_data.fights.len();
    fights_data.fights.retain(is_encounter_fight_candidate);
    let filtered_count = fights_data.fights.len();
    if filtered_count != original_count {
        emit_live_upload_progress(
            app_handle,
            "live",
            &format!("Encounter filter kept {filtered_count}/{original_count} fights"),
            34,
        );
    }

    if fights_data.fights.is_empty() && !original_fights.is_empty() {
        let non_challenge_fights = original_fights
            .iter()
            .filter(|fight| !fight.events_string.contains("CHALLENGE_MODE_START"))
            .cloned()
            .collect::<Vec<ParserFight>>();

        fights_data.fights = if non_challenge_fights.is_empty() {
            original_fights
        } else {
            non_challenge_fights
        };

        emit_live_upload_progress(
            app_handle,
            "live",
            "Encounter markers missing in this flush. Applying safe fallback to keep upload moving.",
            34,
        );
    }

    if fights_data.fights.is_empty() {
        runtime.parser.clear_fights()?;
        runtime.buffered_lines.clear();
        runtime.last_flush_at = Instant::now();
        return Ok(());
    }

    emit_live_upload_progress(
        app_handle,
        "live",
        &format!(
            "Live flush encounter fights: {} (pushFightIfNeeded={})",
            fights_data.fights.len(),
            push_fight_if_needed
        ),
        33,
    );

    let code = runtime
        .report_code
        .as_ref()
        .ok_or_else(|| UploadError::Message("Live upload missing report code".to_string()))?;

    let (total_events, _) = UploadPipeline::new(
        &runtime.session,
        &mut runtime.parser,
        code,
        &mut runtime.segment_id,
        &mut runtime.last_master_ids,
        cancel_flag,
    )
    .upload_segment(&fights_data, false)?;

    runtime.total_uploaded_lines += runtime.buffered_lines.len() as u64;
    runtime.buffered_lines.clear();
    runtime.last_flush_at = Instant::now();

    emit_live_upload_progress(
        app_handle,
        "live",
        &format!(
            "Uploaded live segment with {total_events} events. Total lines sent: {}",
            runtime.total_uploaded_lines
        ),
        60,
    );

    Ok(())
}

fn read_live_log_lines(runtime: &mut LiveUploadRuntime) -> Result<(), UploadError> {
    if let Some(latest_path) =
        find_latest_combat_log_path(&runtime.wow_folder).map_err(UploadError::Message)?
    {
        if latest_path != runtime.log_path {
            let current_file_complete = std::fs::metadata(&runtime.log_path)
                .map(|metadata| runtime.file_offset >= metadata.len())
                .unwrap_or(true);
            if current_file_complete {
                // Finish the previous file before switching so an initial backfill
                // cannot abandon unread lines when WoW rotates the combat log.
                runtime.log_path = latest_path;
                runtime.file_offset = 0;
            }
        }
    }

    let mut file = File::open(&runtime.log_path)?;
    let file_length = file.metadata()?.len();
    if file_length < runtime.file_offset {
        runtime.file_offset = 0;
    }
    file.seek(SeekFrom::Start(runtime.file_offset))?;

    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut read_count = 0usize;
    loop {
        if read_count >= LIVE_MAX_READ_LINES_PER_POLL {
            break;
        }
        line.clear();
        let bytes_read = reader.read_line(&mut line)?;
        if bytes_read == 0 {
            break;
        }
        runtime.file_offset = runtime.file_offset.saturating_add(bytes_read as u64);
        runtime
            .buffered_lines
            .push(line.trim_end_matches(['\r', '\n']).to_string());
        read_count += 1;
    }

    Ok(())
}

fn count_file_lines(path: &Path, cancel_flag: &Arc<AtomicBool>) -> Result<u64, UploadError> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut count: u64 = 0;

    loop {
        check_cancelled(cancel_flag)?;
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        count += 1;
    }

    Ok(count)
}

pub(crate) fn resolve_client_version() -> String {
    if let Ok(env_value) = std::env::var("WCL_CLIENT_VERSION") {
        let trimmed = env_value.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    if let Ok(version) = fetch_latest_archon_version() {
        return version;
    }

    CLIENT_VERSION_FALLBACK.to_string()
}

pub(crate) type PublicWclSession = WclSession;
pub(crate) type PublicParserBridge = ParserBridge;

fn fetch_latest_archon_version() -> Result<String, UploadError> {
    #[derive(Deserialize)]
    struct LatestRelease {
        name: String,
    }

    let client = Client::builder().timeout(Duration::from_secs(10)).build()?;
    let response = client
        .get("https://api.github.com/repos/RPGLogs/Uploaders-archon/releases/latest")
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "floorpov-wcl-upload")
        .send()?;

    if !response.status().is_success() {
        return Err(UploadError::Message(
            "Failed to fetch latest Archon version".to_string(),
        ));
    }

    let payload = response.json::<LatestRelease>()?;
    let version = payload.name.trim();
    if version.is_empty() {
        return Err(UploadError::Message(
            "Latest Archon version response was empty".to_string(),
        ));
    }

    Ok(version.to_string())
}

fn sleep_with_backoff(attempt: u8) {
    let exponential = 2_u64.pow(attempt as u32);
    let delay = RETRY_BASE_DELAY_MS.saturating_mul(exponential);
    thread::sleep(Duration::from_millis(delay));
}
