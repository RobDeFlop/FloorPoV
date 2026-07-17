use std::ffi::OsStr;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::json;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::wcl_upload::constants::CREATE_NO_WINDOW;
use crate::wcl_upload::error::UploadError;
use crate::wcl_upload::filesystem::read_child_stderr;
use crate::wcl_upload::types::{
    CollectFightsResponse, CollectMasterInfoResponse, ParseLinesResponse,
};

pub(crate) struct ParserBridge {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    stderr: Option<ChildStderr>,
}

impl ParserBridge {
    pub(crate) fn new(
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

    pub(crate) fn clear_state(&mut self) -> Result<(), UploadError> {
        self.send_action_and_expect_ok(json!({ "action": "clear-state" }))
    }

    pub(crate) fn set_start_date(&mut self, start_date: &str) -> Result<(), UploadError> {
        self.send_action_and_expect_ok(json!({
            "action": "set-start-date",
            "startDate": start_date,
        }))
    }

    pub(crate) fn parse_lines(
        &mut self,
        lines: &[String],
        selected_region: u8,
    ) -> Result<(), UploadError> {
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

    pub(crate) fn collect_fights(
        &mut self,
        push_fight_if_needed: bool,
    ) -> Result<CollectFightsResponse, UploadError> {
        let payload = self.send_action(json!({
            "action": "collect-fights",
            "pushFightIfNeeded": push_fight_if_needed,
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

    pub(crate) fn collect_master_info(&mut self) -> Result<CollectMasterInfoResponse, UploadError> {
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

    pub(crate) fn clear_fights(&mut self) -> Result<(), UploadError> {
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
