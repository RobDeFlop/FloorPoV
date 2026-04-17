use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::SystemTime;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

use crate::wcl_upload::constants::{
    CREATE_NO_WINDOW, NODE_RESOURCE_PATH_WINDOWS_X64, PARSER_HARNESS_RESOURCE_PATH,
};
use crate::wcl_upload::error::UploadError;

pub(crate) fn resolve_parser_harness_path(app_handle: &AppHandle) -> Result<PathBuf, UploadError> {
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

pub(crate) fn resolve_node_binary_path(app_handle: &AppHandle) -> Result<PathBuf, UploadError> {
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

pub(crate) fn check_node_runtime(node_binary_path: &Path) -> Result<(), UploadError> {
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

pub(crate) fn build_combat_log_directory_path(wow_folder: &str) -> PathBuf {
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

pub(crate) fn find_latest_combat_log_path(wow_folder: &str) -> Result<Option<PathBuf>, String> {
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

pub(crate) fn read_child_stderr(
    stderr: &mut std::process::ChildStderr,
) -> Result<String, UploadError> {
    let mut buffer = String::new();
    use std::io::Read;
    stderr.read_to_string(&mut buffer)?;
    Ok(buffer)
}
