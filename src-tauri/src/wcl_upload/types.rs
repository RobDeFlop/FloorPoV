use serde::de::Deserializer;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWclUploadRequest {
    pub log_file_path: String,
    pub email: String,
    pub password: Option<String>,
    pub use_saved_login: Option<bool>,
    pub remember_login: Option<bool>,
    pub description: Option<String>,
    pub region: u8,
    pub visibility: u8,
    pub guild_id: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWclLiveUploadRequest {
    pub wow_folder: String,
    pub email: String,
    pub password: Option<String>,
    pub use_saved_login: Option<bool>,
    pub remember_login: Option<bool>,
    pub description: Option<String>,
    pub region: u8,
    pub visibility: u8,
    pub guild_id: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchWclGuildsRequest {
    pub email: String,
    pub password: Option<String>,
    pub use_saved_login: Option<bool>,
    pub remember_login: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WclGuild {
    pub id: u32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchWclGuildsResponse {
    pub email: String,
    pub guilds: Vec<WclGuild>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WclLoginState {
    pub saved_email: Option<String>,
    pub has_saved_credentials: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWclUploadResponse {
    pub report_url: String,
    pub report_code: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWclLiveUploadResponse {
    pub report_url: Option<String>,
    pub report_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WclLiveUploadState {
    pub is_running: bool,
    pub report_url: Option<String>,
    pub report_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WclUploadProgressEvent {
    pub step: String,
    pub message: String,
    pub percent: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WclUploadErrorEvent {
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WclUploadCompleteEvent {
    pub report_url: String,
    pub report_code: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WclLiveUploadCompleteEvent {
    pub report_url: Option<String>,
    pub report_code: Option<String>,
}

pub(crate) struct ActiveUpload {
    pub cancel_flag: Arc<AtomicBool>,
}

pub(crate) struct ActiveLiveUpload {
    pub cancel_flag: Arc<AtomicBool>,
    pub handle: Option<std::thread::JoinHandle<()>>,
    pub is_running: bool,
    pub report_url: Option<String>,
    pub report_code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoginResponse {
    pub user: Option<LoginUser>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidebarGuildsResponse {
    pub guilds: Option<SidebarGuildsContainer>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidebarGuildsContainer {
    pub guilds_panel: Option<SidebarGuildsPanel>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidebarGuildsPanel {
    #[serde(default)]
    pub sections: Vec<SidebarGuildSection>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidebarGuildSection {
    pub header: Option<SidebarGuildHeader>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidebarGuildHeader {
    pub id: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoginUser {
    pub user_name: String,
}

#[derive(Debug)]
pub(crate) struct ParserAssets {
    pub gamedata_code: String,
    pub parser_code: String,
    pub parser_version: u32,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CreateReportResponse {
    pub code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddSegmentResponse {
    pub next_segment_id: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ParseLinesResponse {
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ParserFight {
    pub event_count: u64,
    pub events_string: String,
    #[allow(dead_code)]
    pub start_time: Option<i64>,
    #[allow(dead_code)]
    pub end_time: Option<i64>,
    pub boss_percentage: Option<f64>,
    #[allow(dead_code)]
    pub is_trash: Option<bool>,
    #[allow(dead_code)]
    pub enemy_npcid: Option<i64>,
    #[allow(dead_code)]
    pub enemy_id: Option<i64>,
    pub encounter_id: Option<i64>,
    #[allow(dead_code)]
    pub difficulty: Option<i64>,
    #[allow(dead_code)]
    pub zone_id: Option<i64>,
    pub encounter_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectFightsResponse {
    pub ok: bool,
    pub error: Option<String>,
    pub log_version: i64,
    pub game_version: i64,
    #[serde(deserialize_with = "deserialize_i64_from_bool_or_int")]
    pub mythic: i64,
    pub start_time: i64,
    pub end_time: i64,
    pub fights: Vec<ParserFight>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectMasterInfoResponse {
    pub ok: bool,
    pub error: Option<String>,
    #[serde(rename = "lastAssignedActorID")]
    pub last_assigned_actor_id: i64,
    pub actors_string: String,
    #[serde(rename = "lastAssignedAbilityID")]
    pub last_assigned_ability_id: i64,
    pub abilities_string: String,
    #[serde(rename = "lastAssignedTupleID")]
    pub last_assigned_tuple_id: i64,
    pub tuples_string: String,
    #[serde(rename = "lastAssignedPetID")]
    pub last_assigned_pet_id: i64,
    pub pets_string: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MasterIds {
    pub actor_id: i64,
    pub ability_id: i64,
    pub tuple_id: i64,
    pub pet_id: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct CreateReportRequest {
    pub file_name: String,
    pub parser_version: u32,
    pub start_time: i64,
    pub end_time: i64,
    pub description: String,
    pub region: u8,
    pub visibility: u8,
    pub guild_id: Option<u32>,
}

#[derive(Debug, Clone)]
pub(crate) struct UploadSessionParams {
    pub region: u8,
    pub visibility: u8,
    pub guild_id: Option<u32>,
    pub description: String,
}

pub(crate) struct LiveUploadRuntime {
    pub session: crate::wcl_upload::core::PublicWclSession,
    pub parser: crate::wcl_upload::core::PublicParserBridge,
    pub parser_version: u32,
    pub report_code: Option<String>,
    pub segment_id: u64,
    pub last_master_ids: Option<MasterIds>,
    pub upload_params: UploadSessionParams,
    pub wow_folder: String,
    pub file_name: String,
    pub log_path: PathBuf,
    pub file_offset: u64,
    pub buffered_lines: Vec<String>,
    pub last_flush_at: Instant,
    pub total_uploaded_lines: u64,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct SavedLoginMetadata {
    pub saved_email: String,
}

#[derive(Debug)]
pub(crate) struct ResolvedLoginCredentials {
    pub email: String,
    pub password: String,
    pub used_saved_password: bool,
}

pub(crate) fn deserialize_i64_from_bool_or_int<'de, D>(deserializer: D) -> Result<i64, D::Error>
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
