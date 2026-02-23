#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

use super::model::{CaptureInput, RuntimeCaptureMode, CREATE_NO_WINDOW, FFMPEG_RESOURCE_PATH};
use super::window_capture::{
    resolve_window_capture_handle, resolve_window_capture_region, sanitize_capture_dimensions,
};

pub(crate) fn resolve_ffmpeg_binary_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(resource_path) = app_handle
        .path()
        .resolve(FFMPEG_RESOURCE_PATH, BaseDirectory::Resource)
    {
        candidates.push(resource_path);
    }

    let manifest_candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bin")
        .join("ffmpeg.exe");
    candidates.push(manifest_candidate.clone());

    if let Ok(current_executable) = std::env::current_exe() {
        if let Some(executable_directory) = current_executable.parent() {
            candidates.push(executable_directory.join("ffmpeg.exe"));
            candidates.push(
                executable_directory
                    .join("resources")
                    .join("bin")
                    .join("ffmpeg.exe"),
            );
        }
    }

    if let Some(found_path) = candidates.into_iter().find(|path| path.exists()) {
        return Ok(found_path);
    }

    Err(format!(
        "FFmpeg binary was not found. Place ffmpeg.exe at '{}' or rebuild the app so bundled resources are available.",
        manifest_candidate.display()
    ))
}

pub(crate) fn select_video_encoder(ffmpeg_binary_path: &Path) -> (String, Option<String>) {
    let mut command = Command::new(ffmpeg_binary_path);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .arg("-hide_banner")
        .arg("-encoders")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();

    let encoders_output = match output {
        Ok(result) => String::from_utf8(result.stdout)
            .unwrap_or_default()
            .to_lowercase(),
        Err(_) => String::new(),
    };

    if encoders_output.contains(" h264_nvenc") {
        return ("h264_nvenc".to_string(), Some("p3".to_string()));
    }

    if encoders_output.contains(" h264_qsv") {
        return ("h264_qsv".to_string(), None);
    }

    if encoders_output.contains(" h264_amf") {
        return ("h264_amf".to_string(), None);
    }

    ("libx264".to_string(), Some("superfast".to_string()))
}

pub(crate) fn parse_ffmpeg_speed(line: &str) -> Option<f64> {
    let speed_index = line.find("speed=")?;
    let speed_slice = &line[speed_index + 6..];
    let speed_token = speed_slice.split_whitespace().next()?;
    let numeric = speed_token.trim_end_matches('x');
    numeric.parse::<f64>().ok()
}

fn append_monitor_capture_input_args(command: &mut Command, requested_frame_rate: u32) {
    command.arg("-f").arg("lavfi").arg("-i").arg(format!(
        "ddagrab=output_idx=0:framerate={requested_frame_rate}:draw_mouse=1,hwdownload,format=bgra"
    ));
}

fn append_window_capture_input_args(
    command: &mut Command,
    requested_frame_rate: u32,
    window_hwnd: usize,
    capture_width: u32,
    capture_height: u32,
) {
    let (safe_width, safe_height) = sanitize_capture_dimensions(capture_width, capture_height);

    command.arg("-f").arg("lavfi").arg("-i").arg(format!(
        "gfxcapture=hwnd={window_hwnd}:max_framerate={requested_frame_rate}:capture_cursor=1:capture_border=0:output_fmt=bgra:width={safe_width}:height={safe_height}:resize_mode=scale_aspect,hwdownload,format=bgra",
    ));
}

fn append_window_region_capture_input_args(
    command: &mut Command,
    requested_frame_rate: u32,
    region: super::model::WindowCaptureRegion,
) {
    command.arg("-f").arg("lavfi").arg("-i").arg(format!(
        "ddagrab=output_idx={}:framerate={requested_frame_rate}:draw_mouse=1:offset_x={}:offset_y={}:video_size={}x{},hwdownload,format=bgra",
        region.output_idx, region.offset_x, region.offset_y, region.width, region.height
    ));
}

pub(crate) struct RuntimeCaptureInputInfo {
    pub(crate) width: u32,
    pub(crate) height: u32,
}

pub(crate) fn append_runtime_capture_input_args(
    command: &mut Command,
    runtime_capture_mode: RuntimeCaptureMode,
    capture_input: &CaptureInput,
    requested_frame_rate: u32,
    capture_width: u32,
    capture_height: u32,
) -> Result<RuntimeCaptureInputInfo, String> {
    match runtime_capture_mode {
        RuntimeCaptureMode::Monitor => {
            append_monitor_capture_input_args(command, requested_frame_rate);
            let (width, height) = sanitize_capture_dimensions(capture_width, capture_height);
            Ok(RuntimeCaptureInputInfo { width, height })
        }
        RuntimeCaptureMode::Window => {
            if capture_input.uses_wgc_window_capture() {
                let window_hwnd = resolve_window_capture_handle(capture_input)?;
                append_window_capture_input_args(
                    command,
                    requested_frame_rate,
                    window_hwnd,
                    capture_width,
                    capture_height,
                );
                let (width, height) = sanitize_capture_dimensions(capture_width, capture_height);
                Ok(RuntimeCaptureInputInfo { width, height })
            } else {
                let region = resolve_window_capture_region(capture_input)?;
                append_window_region_capture_input_args(command, requested_frame_rate, region);
                Ok(RuntimeCaptureInputInfo {
                    width: region.width,
                    height: region.height,
                })
            }
        }
        RuntimeCaptureMode::Black => {
            let (safe_width, safe_height) =
                sanitize_capture_dimensions(capture_width, capture_height);
            // The `realtime` filter inside the lavfi graph throttles frame emission to
            // wall-clock speed, preventing the `color` source from generating frames
            // faster than real-time. Placing `realtime` here (in the input graph) rather
            // than in the `-vf` output filter chain avoids flush-blocking on graceful stop.
            command.arg("-f").arg("lavfi").arg("-i").arg(format!(
                "color=c=black:s={safe_width}x{safe_height}:r={requested_frame_rate},realtime"
            ));
            Ok(RuntimeCaptureInputInfo {
                width: safe_width,
                height: safe_height,
            })
        }
    }
}

pub(crate) fn resolve_video_filter(
    runtime_capture_mode: RuntimeCaptureMode,
    output_frame_rate: u32,
    capture_width: u32,
    capture_height: u32,
) -> String {
    if matches!(
        runtime_capture_mode,
        RuntimeCaptureMode::Window | RuntimeCaptureMode::Black
    ) {
        return format!(
            "fps={output_frame_rate},scale={capture_width}:{capture_height}:flags=bicubic,format=yuv420p"
        );
    }

    format!("fps={output_frame_rate},format=yuv420p")
}
