use regex::Regex;
use reqwest::blocking::{Client, RequestBuilder, Response};
use serde::de::Deserializer;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::ffi::OsStr;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Cursor, Read, Write};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const BASE_URL: &str = "https://www.warcraftlogs.com";
const CLIENT_VERSION_FALLBACK: &str = "9.0.1";
const CHROME_VERSION_FALLBACK: &str = "134.0.6998.205";
const ELECTRON_VERSION_FALLBACK: &str = "37.7.0";
const PARSER_VERSION_FALLBACK: u32 = 59;
const BATCH_SIZE: usize = 100_000;
const MAX_RETRIES: u8 = 3;
const RETRY_BASE_DELAY_MS: u64 = 1_000;
const PARSER_HARNESS_RESOURCE_PATH: &str = "bin/parser-harness.cjs";
const NODE_RESOURCE_PATH_WINDOWS_X64: &str = "bin/node/win-x64/node.exe";

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWclUploadRequest {
    pub log_file_path: String,
    pub email: String,
    pub password: String,
    pub region: u8,
    pub visibility: u8,
    pub guild_id: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWclUploadResponse {
    pub report_url: String,
    pub report_code: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WclUploadProgressEvent {
    step: String,
    message: String,
    percent: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WclUploadErrorEvent {
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WclUploadCompleteEvent {
    report_url: String,
    report_code: String,
}

struct ActiveUpload {
    cancel_flag: Arc<AtomicBool>,
}

lazy_static::lazy_static! {
    static ref ACTIVE_UPLOAD: Mutex<Option<ActiveUpload>> = Mutex::new(None);
}

#[derive(Debug)]
enum UploadError {
    Message(String),
    Cancelled,
    Io(std::io::Error),
    Json(serde_json::Error),
    Http(reqwest::Error),
    HttpStatus {
        request_label: String,
        status: u16,
        body: String,
    },
    Zip(zip::result::ZipError),
}

impl std::fmt::Display for UploadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Message(message) => write!(formatter, "{message}"),
            Self::Cancelled => write!(formatter, "WarcraftLogs upload cancelled"),
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Json(error) => write!(formatter, "{error}"),
            Self::Http(error) => write!(formatter, "{error}"),
            Self::HttpStatus {
                request_label,
                status,
                body,
            } => {
                if body.trim().is_empty() {
                    write!(
                        formatter,
                        "WarcraftLogs request '{request_label}' failed with status {status}"
                    )
                } else {
                    write!(
                        formatter,
                        "WarcraftLogs request '{request_label}' failed with status {status}: {body}"
                    )
                }
            }
            Self::Zip(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for UploadError {}

impl From<std::io::Error> for UploadError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for UploadError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl From<reqwest::Error> for UploadError {
    fn from(error: reqwest::Error) -> Self {
        Self::Http(error)
    }
}

impl From<zip::result::ZipError> for UploadError {
    fn from(error: zip::result::ZipError) -> Self {
        Self::Zip(error)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginResponse {
    user: Option<LoginUser>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginUser {
    user_name: String,
}

#[derive(Debug)]
struct ParserAssets {
    gamedata_code: String,
    parser_code: String,
    parser_version: u32,
}

#[derive(Debug, Deserialize)]
struct CreateReportResponse {
    code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddSegmentResponse {
    next_segment_id: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParseLinesResponse {
    ok: bool,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParserFight {
    event_count: u64,
    events_string: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectFightsResponse {
    ok: bool,
    error: Option<String>,
    log_version: i64,
    game_version: i64,
    #[serde(deserialize_with = "deserialize_i64_from_bool_or_int")]
    mythic: i64,
    start_time: i64,
    end_time: i64,
    fights: Vec<ParserFight>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectMasterInfoResponse {
    ok: bool,
    error: Option<String>,
    #[serde(rename = "lastAssignedActorID")]
    last_assigned_actor_id: i64,
    actors_string: String,
    #[serde(rename = "lastAssignedAbilityID")]
    last_assigned_ability_id: i64,
    abilities_string: String,
    #[serde(rename = "lastAssignedTupleID")]
    last_assigned_tuple_id: i64,
    tuples_string: String,
    #[serde(rename = "lastAssignedPetID")]
    last_assigned_pet_id: i64,
    pets_string: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MasterIds {
    actor_id: i64,
    ability_id: i64,
    tuple_id: i64,
    pet_id: i64,
}

#[derive(Debug, Clone)]
struct CreateReportRequest {
    file_name: String,
    parser_version: u32,
    start_time: i64,
    end_time: i64,
    region: u8,
    visibility: u8,
    guild_id: Option<u32>,
}

fn deserialize_i64_from_bool_or_int<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Bool(boolean) => Ok(i64::from(boolean)),
        serde_json::Value::Number(number) => {
            if let Some(as_i64) = number.as_i64() {
                return Ok(as_i64);
            }
            Err(serde::de::Error::custom(
                "expected boolean or integer for numeric field",
            ))
        }
        _ => Err(serde::de::Error::custom(
            "expected boolean or integer value",
        )),
    }
}

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

fn random_multipart_boundary() -> String {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("----WebKitFormBoundary{nonce:x}")
}

struct WclSession {
    client: Client,
    client_version: String,
    user_agent: String,
}

impl WclSession {
    fn new(client_version: String) -> Result<Self, UploadError> {
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

                    let body = response.text().unwrap_or_default();
                    return Err(UploadError::HttpStatus {
                        request_label: request_label.to_string(),
                        status: status.as_u16(),
                        body: sanitize_http_error_body(&body),
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

    fn login(&self, email: &str, password: &str) -> Result<Option<String>, UploadError> {
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

    fn fetch_parser_assets(&self) -> Result<ParserAssets, UploadError> {
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

    fn create_report(&self, request: &CreateReportRequest) -> Result<String, UploadError> {
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
                    "description": "",
                }))
        })?;

        let payload = response.json::<CreateReportResponse>()?;
        Ok(payload.code)
    }

    fn set_master_table(
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

    fn add_segment(
        &self,
        report_code: &str,
        segment_id: u64,
        start_time: i64,
        end_time: i64,
        mythic: i64,
        zip_bytes: Vec<u8>,
    ) -> Result<u64, UploadError> {
        let endpoint = format!("{BASE_URL}/desktop-client/add-report-segment/{report_code}");
        let parameters = json!({
            "startTime": start_time,
            "endTime": end_time,
            "mythic": mythic,
            "isLiveLog": false,
            "isRealTime": false,
            "inProgressEventCount": 0,
            "segmentId": segment_id,
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
                        bytes: zip_bytes.clone(),
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
        Ok(payload.next_segment_id.unwrap_or(segment_id + 1))
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

fn sanitize_http_error_body(body: &str) -> String {
    let compact = body.split_whitespace().collect::<Vec<&str>>().join(" ");
    if compact.len() <= 600 {
        compact
    } else {
        format!("{}...", &compact[..600])
    }
}

struct ParserBridge {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    stderr: Option<ChildStderr>,
}

impl ParserBridge {
    fn new(
        node_binary_path: &Path,
        parser_harness_path: &Path,
        gamedata_code: &str,
        parser_code: &str,
    ) -> Result<Self, UploadError> {
        if !node_binary_path.is_file() {
            return Err(UploadError::Message(format!(
                "Bundled Node runtime was not found at {}",
                node_binary_path.display()
            )));
        }

        if !parser_harness_path.is_file() {
            return Err(UploadError::Message(format!(
                "Parser harness path is not a file: {}",
                parser_harness_path.display()
            )));
        }

        let harness_parent = parser_harness_path.parent().ok_or_else(|| {
            UploadError::Message(format!(
                "Parser harness has no parent directory: {}",
                parser_harness_path.display()
            ))
        })?;
        let harness_file_name = parser_harness_path
            .file_name()
            .and_then(OsStr::to_str)
            .ok_or_else(|| {
                UploadError::Message(format!(
                    "Parser harness filename could not be resolved: {}",
                    parser_harness_path.display()
                ))
            })?;

        let mut command = Command::new(node_binary_path);
        command.current_dir(harness_parent);
        command.arg(harness_file_name);
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        command.creation_flags(CREATE_NO_WINDOW);

        let mut child = command.spawn().map_err(|error| {
            UploadError::Message(format!(
                "Could not launch Node.js parser harness '{}'. Ensure bundled Node runtime is available. Details: {error}",
                parser_harness_path.display(),
            ))
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| UploadError::Message("Failed to open parser stdin".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| UploadError::Message("Failed to open parser stdout".to_string()))?;
        let stderr = child.stderr.take();

        let mut bridge = Self {
            child,
            stdin: BufWriter::new(stdin),
            stdout: BufReader::new(stdout),
            stderr,
        };

        bridge.send_json_line(&json!({
            "gamedataCode": gamedata_code,
            "parserCode": parser_code,
        }))?;

        let ready_payload = bridge.read_json_line()?;
        let is_ready = ready_payload
            .get("ready")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        if !is_ready {
            return Err(UploadError::Message(
                "Failed to initialize WarcraftLogs parser harness".to_string(),
            ));
        }

        Ok(bridge)
    }

    fn clear_state(&mut self) -> Result<(), UploadError> {
        self.send_action_and_expect_ok(json!({ "action": "clear-state" }))
    }

    fn set_start_date(&mut self, start_date: &str) -> Result<(), UploadError> {
        self.send_action_and_expect_ok(json!({
            "action": "set-start-date",
            "startDate": start_date,
        }))
    }

    fn parse_lines(&mut self, lines: &[String], selected_region: u8) -> Result<(), UploadError> {
        let payload = self.send_action(json!({
            "action": "parse-lines",
            "lines": lines,
            "selectedRegion": selected_region,
        }))?;
        let parsed = serde_json::from_value::<ParseLinesResponse>(payload)?;

        if parsed.ok {
            Ok(())
        } else {
            Err(UploadError::Message(format!(
                "Parser failed to parse lines: {}",
                parsed
                    .error
                    .unwrap_or_else(|| "Unknown parser error".to_string())
            )))
        }
    }

    fn collect_fights(&mut self) -> Result<CollectFightsResponse, UploadError> {
        let payload = self.send_action(json!({
            "action": "collect-fights",
            "pushFightIfNeeded": true,
            "scanningOnly": false,
        }))?;
        let parsed = serde_json::from_value::<CollectFightsResponse>(payload)?;

        if parsed.ok {
            Ok(parsed)
        } else {
            Err(UploadError::Message(format!(
                "Parser failed to collect fights: {}",
                parsed
                    .error
                    .unwrap_or_else(|| "Unknown parser error".to_string())
            )))
        }
    }

    fn collect_master_info(&mut self) -> Result<CollectMasterInfoResponse, UploadError> {
        let payload = self.send_action(json!({ "action": "collect-master-info" }))?;
        let parsed = serde_json::from_value::<CollectMasterInfoResponse>(payload)?;

        if parsed.ok {
            Ok(parsed)
        } else {
            Err(UploadError::Message(format!(
                "Parser failed to collect master info: {}",
                parsed
                    .error
                    .unwrap_or_else(|| "Unknown parser error".to_string())
            )))
        }
    }

    fn clear_fights(&mut self) -> Result<(), UploadError> {
        self.send_action_and_expect_ok(json!({ "action": "clear-fights" }))
    }

    fn send_action(
        &mut self,
        payload: serde_json::Value,
    ) -> Result<serde_json::Value, UploadError> {
        self.send_json_line(&payload)?;
        self.read_json_line()
    }

    fn send_action_and_expect_ok(&mut self, payload: serde_json::Value) -> Result<(), UploadError> {
        let response = self.send_action(payload)?;
        let is_ok = response
            .get("ok")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);

        if is_ok {
            Ok(())
        } else {
            let message = response
                .get("error")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Unknown parser bridge error")
                .to_string();
            Err(UploadError::Message(message))
        }
    }

    fn send_json_line(&mut self, payload: &serde_json::Value) -> Result<(), UploadError> {
        let encoded = serde_json::to_string(payload)?;
        if let Err(error) = self.stdin.write_all(encoded.as_bytes()) {
            return Err(self.map_stdin_write_error(error));
        }
        if let Err(error) = self.stdin.write_all(b"\n") {
            return Err(self.map_stdin_write_error(error));
        }
        if let Err(error) = self.stdin.flush() {
            return Err(self.map_stdin_write_error(error));
        }
        Ok(())
    }

    fn map_stdin_write_error(&mut self, error: std::io::Error) -> UploadError {
        if error.kind() != std::io::ErrorKind::BrokenPipe {
            return UploadError::Io(error);
        }

        let stderr_output = self
            .stderr
            .as_mut()
            .map(read_child_stderr)
            .transpose()
            .unwrap_or(None)
            .unwrap_or_default();

        if stderr_output.trim().is_empty() {
            return UploadError::Message(
                "Parser process exited unexpectedly before initialization. Ensure parser-harness.cjs is present and bundled Node runtime can execute CommonJS scripts."
                    .to_string(),
            );
        }

        UploadError::Message(format!(
            "Parser process exited unexpectedly before initialization. stderr: {}",
            stderr_output.trim()
        ))
    }

    fn read_json_line(&mut self) -> Result<serde_json::Value, UploadError> {
        let mut line = String::new();
        let bytes_read = self.stdout.read_line(&mut line)?;
        if bytes_read == 0 {
            let stderr_output = self
                .stderr
                .as_mut()
                .map(read_child_stderr)
                .transpose()?
                .unwrap_or_default();
            let stderr_suffix = if stderr_output.trim().is_empty() {
                String::new()
            } else {
                format!(" stderr: {}", stderr_output.trim())
            };
            return Err(UploadError::Message(format!(
                "Parser process exited unexpectedly.{stderr_suffix}"
            )));
        }

        serde_json::from_str(line.trim()).map_err(|error| {
            UploadError::Message(format!("Failed to parse parser response JSON: {error}"))
        })
    }
}

impl Drop for ParserBridge {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[tauri::command]
pub async fn start_wcl_upload(
    app_handle: AppHandle,
    request: StartWclUploadRequest,
) -> Result<StartWclUploadResponse, String> {
    validate_request(&request)?;

    let cancel_flag = begin_upload_session()?;
    let app_handle_for_task = app_handle.clone();
    let request_for_task = request.clone();
    let cancel_flag_for_task = cancel_flag.clone();

    let upload_result = tokio::task::spawn_blocking(move || {
        run_upload(app_handle_for_task, request_for_task, cancel_flag_for_task)
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

#[tauri::command]
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

#[tauri::command]
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

fn run_upload(
    app_handle: AppHandle,
    request: StartWclUploadRequest,
    cancel_flag: Arc<AtomicBool>,
) -> Result<StartWclUploadResponse, UploadError> {
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
    let client_version = resolve_client_version();
    let session = WclSession::new(client_version)?;
    emit_upload_progress(&app_handle, "auth", "Logging in to WarcraftLogs...", 6);
    let login_username = session.login(&request.email, &request.password)?;
    if let Some(user_name) = login_username {
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
        ((total_lines as usize) + BATCH_SIZE - 1) / BATCH_SIZE
    };

    let mut line_reader = BufReader::new(File::open(&log_path)?);
    let mut line = String::new();
    let mut batch_lines: Vec<String> = Vec::with_capacity(BATCH_SIZE);
    let mut processed_lines: u64 = 0;
    let mut batch_number: usize = 0;
    let mut report_code: Option<String> = None;
    let mut segment_id: u64 = 1;
    let mut last_master_ids: Option<MasterIds> = None;

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
                    &file_name,
                    &batch_lines,
                    batch_number,
                    total_batches,
                    parser_assets.parser_version,
                    &mut report_code,
                    &mut segment_id,
                    &mut last_master_ids,
                    &cancel_flag,
                )?;
                batch_lines.clear();
            }
            break;
        }

        batch_lines.push(line.trim_end_matches(['\r', '\n']).to_string());

        if batch_lines.len() >= BATCH_SIZE {
            batch_number += 1;
            process_batch(
                &app_handle,
                &session,
                &mut parser,
                &request,
                &file_name,
                &batch_lines,
                batch_number,
                total_batches,
                parser_assets.parser_version,
                &mut report_code,
                &mut segment_id,
                &mut last_master_ids,
                &cancel_flag,
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
    file_name: &str,
    lines: &[String],
    batch_number: usize,
    total_batches: usize,
    parser_version: u32,
    report_code: &mut Option<String>,
    segment_id: &mut u64,
    last_master_ids: &mut Option<MasterIds>,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<(), UploadError> {
    check_cancelled(cancel_flag)?;

    parser.parse_lines(lines, request.region)?;
    let fights_data = parser.collect_fights()?;

    if fights_data.fights.is_empty() {
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
            region: request.region,
            visibility: request.visibility,
            guild_id: request.guild_id,
        })?;

        *report_code = Some(created_code.clone());
        emit_upload_progress(
            app_handle,
            "report",
            &format!("Created report {created_code}"),
            22,
        );
    }

    let master_info = parser.collect_master_info()?;
    let current_master_ids = MasterIds {
        actor_id: master_info.last_assigned_actor_id,
        ability_id: master_info.last_assigned_ability_id,
        tuple_id: master_info.last_assigned_tuple_id,
        pet_id: master_info.last_assigned_pet_id,
    };

    let code = report_code
        .as_ref()
        .ok_or_else(|| UploadError::Message("Report code missing during upload".to_string()))?;

    if Some(current_master_ids) != *last_master_ids {
        check_cancelled(cancel_flag)?;
        emit_upload_progress(
            app_handle,
            "master",
            &format!("Uploading master table for segment {}...", *segment_id),
            23,
        );
        let master_payload = build_master_table_string(
            &master_info,
            fights_data.log_version,
            fights_data.game_version,
        );
        let master_zip = make_zip_payload(&master_payload)?;
        session.set_master_table(code, *segment_id, master_zip)?;
        *last_master_ids = Some(current_master_ids);
    } else {
        emit_upload_progress(
            app_handle,
            "master",
            &format!("Master table unchanged for segment {}", *segment_id),
            23,
        );
    }

    check_cancelled(cancel_flag)?;
    emit_upload_progress(
        app_handle,
        "segment",
        &format!("Uploading segment {}...", *segment_id),
        24,
    );
    let fights_payload = build_fights_string(&fights_data);
    let fights_zip = make_zip_payload(&fights_payload)?;
    let total_events: u64 = fights_data
        .fights
        .iter()
        .map(|fight| fight.event_count)
        .sum();
    *segment_id = session.add_segment(
        code,
        *segment_id,
        fights_data.start_time,
        fights_data.end_time,
        fights_data.mythic,
        fights_zip,
    )?;

    parser.clear_fights()?;

    emit_upload_progress(
        app_handle,
        "upload",
        &format!("Batch {batch_number}/{total_batches}: uploaded {total_events} events"),
        24,
    );

    Ok(())
}

fn make_zip_payload(content: &str) -> Result<Vec<u8>, UploadError> {
    let mut buffer = Cursor::new(Vec::<u8>::new());
    let mut zip = ZipWriter::new(&mut buffer);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6));
    zip.start_file("log.txt", options)?;
    zip.write_all(content.as_bytes())?;
    zip.finish()?;
    Ok(buffer.into_inner())
}

fn build_master_table_string(
    master_info: &CollectMasterInfoResponse,
    log_version: i64,
    game_version: i64,
) -> String {
    let mut parts = vec![format!("{log_version}|{game_version}|")];

    parts.push(master_info.last_assigned_actor_id.to_string());
    if !master_info.actors_string.is_empty() {
        parts.push(master_info.actors_string.trim_end_matches('\n').to_string());
    }

    parts.push(master_info.last_assigned_ability_id.to_string());
    if !master_info.abilities_string.is_empty() {
        parts.push(
            master_info
                .abilities_string
                .trim_end_matches('\n')
                .to_string(),
        );
    }

    parts.push(master_info.last_assigned_tuple_id.to_string());
    if !master_info.tuples_string.is_empty() {
        parts.push(master_info.tuples_string.trim_end_matches('\n').to_string());
    }

    parts.push(master_info.last_assigned_pet_id.to_string());
    if !master_info.pets_string.is_empty() {
        parts.push(master_info.pets_string.trim_end_matches('\n').to_string());
    }

    format!("{}\n", parts.join("\n"))
}

fn build_fights_string(fights_data: &CollectFightsResponse) -> String {
    let total_events: u64 = fights_data
        .fights
        .iter()
        .map(|fight| fight.event_count)
        .sum();
    let events_combined = fights_data
        .fights
        .iter()
        .map(|fight| fight.events_string.as_str())
        .collect::<String>();

    format!(
        "{}|{}\n{}\n{}",
        fights_data.log_version, fights_data.game_version, total_events, events_combined
    )
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

fn parse_start_date_from_filename(file_name: &str) -> Option<String> {
    let regex = Regex::new(r"WoWCombatLog-(\d{2})(\d{2})(\d{2})_").ok()?;
    let captures = regex.captures(file_name)?;

    let month = captures.get(1)?.as_str().parse::<u32>().ok()?;
    let day = captures.get(2)?.as_str().parse::<u32>().ok()?;
    let year_suffix = captures.get(3)?.as_str().parse::<u32>().ok()?;
    let year = 2000 + year_suffix;

    Some(format!("{month}/{day}/{year}"))
}

fn resolve_client_version() -> String {
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

fn resolve_parser_harness_path(app_handle: &AppHandle) -> Result<PathBuf, UploadError> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(resource_path) = app_handle
        .path()
        .resolve(PARSER_HARNESS_RESOURCE_PATH, BaseDirectory::Resource)
    {
        candidates.push(resource_path);
    }

    let manifest_candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bin")
        .join("parser-harness.cjs");
    candidates.push(manifest_candidate.clone());
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("bin")
            .join("parser-harness.js"),
    );

    if let Ok(current_executable) = std::env::current_exe() {
        if let Some(executable_directory) = current_executable.parent() {
            candidates.push(executable_directory.join("parser-harness.js"));
            candidates.push(executable_directory.join("parser-harness.cjs"));
            candidates.push(
                executable_directory
                    .join("resources")
                    .join("bin")
                    .join("parser-harness.js"),
            );
            candidates.push(
                executable_directory
                    .join("resources")
                    .join("bin")
                    .join("parser-harness.cjs"),
            );
        }
    }

    if let Some(found_path) = candidates.into_iter().find(|candidate| {
        candidate
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| {
                (name.eq_ignore_ascii_case("parser-harness.cjs")
                    || name.eq_ignore_ascii_case("parser-harness.js"))
                    && candidate.is_file()
            })
            .unwrap_or(false)
    }) {
        return found_path.canonicalize().map_err(|error| {
            UploadError::Message(format!(
                "Failed to canonicalize parser harness path '{}': {error}",
                found_path.display()
            ))
        });
    }

    Err(UploadError::Message(format!(
        "Parser harness was not found. Expected '{}'.",
        manifest_candidate.display()
    )))
}

fn read_child_stderr(stderr: &mut ChildStderr) -> Result<String, UploadError> {
    let mut buffer = String::new();
    stderr.read_to_string(&mut buffer)?;
    Ok(buffer)
}

fn resolve_node_binary_path(app_handle: &AppHandle) -> Result<PathBuf, UploadError> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(resource_path) = app_handle
        .path()
        .resolve(NODE_RESOURCE_PATH_WINDOWS_X64, BaseDirectory::Resource)
    {
        candidates.push(resource_path);
    }

    let manifest_candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bin")
        .join("node")
        .join("win-x64")
        .join("node.exe");
    candidates.push(manifest_candidate.clone());

    if let Ok(current_executable) = std::env::current_exe() {
        if let Some(executable_directory) = current_executable.parent() {
            candidates.push(executable_directory.join("node.exe"));
            candidates.push(
                executable_directory
                    .join("resources")
                    .join("bin")
                    .join("node")
                    .join("win-x64")
                    .join("node.exe"),
            );
        }
    }

    if let Some(found_path) = candidates.into_iter().find(|candidate| candidate.is_file()) {
        return found_path.canonicalize().map_err(|error| {
            UploadError::Message(format!(
                "Failed to canonicalize bundled Node path '{}': {error}",
                found_path.display()
            ))
        });
    }

    Err(UploadError::Message(format!(
        "Bundled Node runtime was not found. Expected '{}'.",
        manifest_candidate.display()
    )))
}

fn check_node_runtime(node_binary_path: &Path) -> Result<(), UploadError> {
    let mut command = Command::new(node_binary_path);
    command.arg("--version");
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command.output().map_err(|error| {
        UploadError::Message(format!(
            "Bundled Node runtime failed to start. Ensure node runtime exists at '{}'. Details: {error}",
            node_binary_path.display()
        ))
    })?;

    if !output.status.success() {
        let stderr_text = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr_text.is_empty() {
            return Err(UploadError::Message(
                "Failed to run bundled 'node --version'.".to_string(),
            ));
        }

        return Err(UploadError::Message(format!(
            "Failed to run bundled 'node --version'. Details: {stderr_text}"
        )));
    }

    let stdout_text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let version_text = if stdout_text.is_empty() {
        String::from_utf8_lossy(&output.stderr).trim().to_string()
    } else {
        stdout_text
    };

    let major = parse_node_major_version(&version_text).ok_or_else(|| {
        UploadError::Message(format!(
            "Could not parse bundled Node.js version '{version_text}'."
        ))
    })?;

    if major < 18 {
        return Err(UploadError::Message(format!(
            "Node.js 18+ is required. Bundled runtime reports '{version_text}'."
        )));
    }

    Ok(())
}

fn parse_node_major_version(version_text: &str) -> Option<u32> {
    let trimmed = version_text.trim();
    let normalized = trimmed.strip_prefix('v').unwrap_or(trimmed);
    normalized.split('.').next()?.parse::<u32>().ok()
}

fn begin_upload_session() -> Result<Arc<AtomicBool>, String> {
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

fn end_upload_session() {
    if let Ok(mut state) = ACTIVE_UPLOAD.lock() {
        *state = None;
    }
}

fn check_cancelled(cancel_flag: &Arc<AtomicBool>) -> Result<(), UploadError> {
    if cancel_flag.load(Ordering::SeqCst) {
        Err(UploadError::Cancelled)
    } else {
        Ok(())
    }
}

fn sleep_with_backoff(attempt: u8) {
    let exponential = 2_u64.pow(attempt as u32);
    let delay = RETRY_BASE_DELAY_MS.saturating_mul(exponential);
    thread::sleep(Duration::from_millis(delay));
}

fn emit_upload_progress(app_handle: &AppHandle, step: &str, message: &str, percent: u8) {
    let payload = WclUploadProgressEvent {
        step: step.to_string(),
        message: message.to_string(),
        percent,
    };
    let _ = app_handle.emit("wcl-upload-progress", payload);
}

fn emit_upload_complete(app_handle: &AppHandle, result: &StartWclUploadResponse) {
    let payload = WclUploadCompleteEvent {
        report_url: result.report_url.clone(),
        report_code: result.report_code.clone(),
    };
    let _ = app_handle.emit("wcl-upload-complete", payload);
}

fn emit_upload_error(app_handle: &AppHandle, message: &str) {
    let payload = WclUploadErrorEvent {
        message: message.to_string(),
    };
    let _ = app_handle.emit("wcl-upload-error", payload);
}

fn validate_request(request: &StartWclUploadRequest) -> Result<(), String> {
    if request.log_file_path.trim().is_empty() {
        return Err("Please choose a combat log file".to_string());
    }

    if request.email.trim().is_empty() {
        return Err("WarcraftLogs email is required".to_string());
    }

    if request.password.trim().is_empty() {
        return Err("WarcraftLogs password is required".to_string());
    }

    if !(1..=5).contains(&request.region) {
        return Err("Region must be one of: 1 (US), 2 (EU), 3 (KR), 4 (TW), 5 (CN)".to_string());
    }

    if request.visibility > 2 {
        return Err("Visibility must be one of: 0 (Public), 1 (Private), 2 (Unlisted)".to_string());
    }

    Ok(())
}

fn build_combat_log_directory_path(wow_folder: &str) -> PathBuf {
    let candidate_path = Path::new(wow_folder);
    let is_logs_directory = candidate_path
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("Logs"))
        .unwrap_or(false);

    if is_logs_directory {
        candidate_path.to_path_buf()
    } else {
        candidate_path.join("Logs")
    }
}

fn is_combat_log_file_name(file_name: &str) -> bool {
    let lower_file_name = file_name.to_ascii_lowercase();
    lower_file_name.starts_with("wowcombatlog") && lower_file_name.ends_with(".txt")
}

fn find_latest_combat_log_path(wow_folder: &str) -> Result<Option<PathBuf>, String> {
    let logs_directory = build_combat_log_directory_path(wow_folder);
    let directory_entries = match std::fs::read_dir(&logs_directory) {
        Ok(entries) => entries,
        Err(error) => {
            if logs_directory.exists() {
                return Err(error.to_string());
            }
            return Ok(None);
        }
    };

    let mut latest_match: Option<(SystemTime, PathBuf)> = None;

    for entry_result in directory_entries {
        let entry = entry_result.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };

        if !is_combat_log_file_name(file_name) {
            continue;
        }

        let modified_time = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);

        if latest_match
            .as_ref()
            .map(|(latest_time, _)| modified_time > *latest_time)
            .unwrap_or(true)
        {
            latest_match = Some((modified_time, path));
        }
    }

    Ok(latest_match.map(|(_, path)| path))
}
