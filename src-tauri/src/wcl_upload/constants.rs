pub(crate) const BASE_URL: &str = "https://www.warcraftlogs.com";
pub(crate) const CLIENT_VERSION_FALLBACK: &str = "9.0.1";
pub(crate) const CHROME_VERSION_FALLBACK: &str = "134.0.6998.205";
pub(crate) const ELECTRON_VERSION_FALLBACK: &str = "37.7.0";
pub(crate) const PARSER_VERSION_FALLBACK: u32 = 59;
pub(crate) const BATCH_SIZE: usize = 100_000;
pub(crate) const MAX_RETRIES: u8 = 3;
pub(crate) const RETRY_BASE_DELAY_MS: u64 = 1_000;
pub(crate) const PARSER_HARNESS_RESOURCE_PATH: &str = "bin/parser-harness.cjs";
pub(crate) const NODE_RESOURCE_PATH_WINDOWS_X64: &str = "bin/node/win-x64/node.exe";
pub(crate) const WCL_LOGIN_SERVICE: &str = "com.r0b.floorpov.wcl";
pub(crate) const WCL_LOGIN_METADATA_FILE: &str = "wcl-login.json";
pub(crate) const LIVE_POLL_INTERVAL_MS: u64 = 1_000;
pub(crate) const LIVE_FLUSH_INTERVAL_MS: u64 = 5_000;
pub(crate) const LIVE_MAX_READ_LINES_PER_POLL: usize = 4_000;

#[cfg(target_os = "windows")]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x08000000;
