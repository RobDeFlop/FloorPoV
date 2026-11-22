//! Save a still frame from a recording file to the recordings output folder.

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::AppHandle;

use crate::recording::{resolve_ffmpeg_binary_path, CREATE_NO_WINDOW};

use base64::{engine::general_purpose::STANDARD, Engine as _};

const SCREENSHOTS_FOLDER_NAME: &str = "screenshots";
const MAX_SCREENSHOT_BYTES: usize = 25 * 1024 * 1024;
const DEFAULT_STEM: &str = "screenshot";

#[tauri::command]
pub fn save_playback_screenshot(
    app_handle: AppHandle,
    output_folder: String,
    recording_path: String,
    timestamp_seconds: f64,
    file_stem: Option<String>,
) -> Result<String, String> {
    let recording_file = PathBuf::from(recording_path.trim());
    validate_recording_path(&recording_file)?;
    validate_timestamp(timestamp_seconds)?;

    let screenshots_dir = screenshots_dir(&output_folder)?;
    std::fs::create_dir_all(&screenshots_dir)
        .map_err(|error| format!("Could not create the screenshots folder: {error}"))?;

    let clock_stamp = chrono::Local::now().format("%Y%m%d_%H%M%S_%3f").to_string();
    let stem = sanitize_screenshot_stem(file_stem.as_deref().unwrap_or(DEFAULT_STEM));
    let file_name = format!("{stem}_{clock_stamp}.png");
    if Path::new(&file_name).components().count() != 1 {
        return Err("Invalid screenshot file name.".to_string());
    }

    let saved_path = unique_screenshot_path(&screenshots_dir.join(file_name));
    if saved_path.parent() != Some(screenshots_dir.as_path()) {
        return Err("Screenshot path escaped the screenshots folder.".to_string());
    }

    let ffmpeg_binary_path = resolve_ffmpeg_binary_path(&app_handle)?;
    extract_frame_with_ffmpeg(
        &ffmpeg_binary_path,
        &recording_file,
        timestamp_seconds,
        &saved_path,
    )?;

    tracing::info!(path = %saved_path.display(), "Saved playback screenshot");
    Ok(saved_path.to_string_lossy().to_string())
}

fn validate_recording_path(recording_path: &Path) -> Result<(), String> {
    if recording_path.as_os_str().is_empty() {
        return Err("Load a recording before capturing a screenshot.".to_string());
    }

    if recording_path
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("mp4"))
    {
        return Err("Only .mp4 recordings can be captured.".to_string());
    }

    if !recording_path.is_file() {
        return Err(format!(
            "Recording file not found: {}",
            recording_path.display()
        ));
    }

    Ok(())
}

fn validate_timestamp(timestamp_seconds: f64) -> Result<(), String> {
    if !timestamp_seconds.is_finite() || timestamp_seconds < 0.0 {
        return Err("The video timestamp is not valid.".to_string());
    }

    Ok(())
}

fn extract_frame_with_ffmpeg(
    ffmpeg_binary_path: &Path,
    recording_path: &Path,
    timestamp_seconds: f64,
    output_path: &Path,
) -> Result<(), String> {
    let mut command = Command::new(ffmpeg_binary_path);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let status = command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-nostdin")
        .arg("-ss")
        .arg(format!("{timestamp_seconds:.3}"))
        .arg("-i")
        .arg(recording_path)
        .arg("-frames:v")
        .arg("1")
        .arg("-y")
        .arg(output_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .status()
        .map_err(|error| format!("Could not start FFmpeg for the screenshot: {error}"))?;

    if !status.success() {
        return Err("FFmpeg could not capture this video frame.".to_string());
    }

    if !output_path.is_file() {
        return Err("FFmpeg did not write a screenshot file.".to_string());
    }

    Ok(())
}

fn screenshots_dir(output_folder: &str) -> Result<PathBuf, String> {
    let trimmed_folder = output_folder.trim();
    if trimmed_folder.is_empty() {
        return Err("Choose an output folder in Settings before saving screenshots.".to_string());
    }

    Ok(Path::new(trimmed_folder).join(SCREENSHOTS_FOLDER_NAME))
}

fn write_playback_screenshot(
    screenshots_dir: &Path,
    file_stem: Option<&str>,
    data_url: &str,
    timestamp: &str,
) -> Result<PathBuf, String> {
    let decoded = decode_image_data_url(data_url)?;
    let stem = sanitize_screenshot_stem(file_stem.unwrap_or(DEFAULT_STEM));
    let file_name = format!("{stem}_{timestamp}.{}", decoded.extension);

    if Path::new(&file_name).components().count() != 1 {
        return Err("Invalid screenshot file name.".to_string());
    }

    let file_path = unique_screenshot_path(&screenshots_dir.join(file_name));
    if file_path.parent() != Some(screenshots_dir) {
        return Err("Screenshot path escaped the screenshots folder.".to_string());
    }

    std::fs::write(&file_path, decoded.bytes)
        .map_err(|error| format!("Could not write the screenshot: {error}"))?;

    Ok(file_path)
}

#[derive(Debug)]
struct DecodedScreenshot {
    extension: &'static str,
    bytes: Vec<u8>,
}

fn decode_image_data_url(data_url: &str) -> Result<DecodedScreenshot, String> {
    let trimmed_data_url = data_url.trim();
    let (header, payload) = trimmed_data_url
        .split_once(',')
        .ok_or_else(|| "Screenshot data is not a valid image data URL.".to_string())?;

    let normalized_header = header.to_ascii_lowercase();
    let extension = if normalized_header.starts_with("data:image/png;base64") {
        "png"
    } else if normalized_header.starts_with("data:image/jpeg;base64")
        || normalized_header.starts_with("data:image/jpg;base64")
    {
        "jpeg"
    } else {
        return Err("Screenshots must be PNG or JPEG.".to_string());
    };

    let bytes = STANDARD
        .decode(payload.trim())
        .map_err(|_| "Screenshot data could not be decoded.".to_string())?;

    if bytes.is_empty() {
        return Err("Screenshot data is empty.".to_string());
    }

    if bytes.len() > MAX_SCREENSHOT_BYTES {
        return Err("Screenshot is too large to save.".to_string());
    }

    Ok(DecodedScreenshot { extension, bytes })
}

fn sanitize_screenshot_stem(input: &str) -> String {
    let mut sanitized = String::new();
    let mut last_was_separator = false;

    for character in input.chars() {
        if character.is_ascii_alphanumeric() {
            sanitized.push(character);
            last_was_separator = false;
            continue;
        }

        if matches!(character, '_' | '-' | '.') && !last_was_separator && !sanitized.is_empty() {
            sanitized.push(character);
            last_was_separator = true;
        }
    }

    let trimmed = sanitized.trim_end_matches(['_', '-', '.']);
    let truncated: String = trimmed.chars().take(80).collect();
    if truncated.is_empty() {
        DEFAULT_STEM.to_string()
    } else {
        truncated
    }
}

fn unique_screenshot_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }

    let parent = path.parent().unwrap_or(Path::new("."));
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(DEFAULT_STEM);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png");

    for index in 2..1000 {
        let candidate = parent.join(format!("{stem}_{index}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }

    parent.join(format!(
        "{stem}_{}.{extension}",
        chrono::Local::now().timestamp_millis()
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        decode_image_data_url, sanitize_screenshot_stem, screenshots_dir, validate_recording_path,
        validate_timestamp, write_playback_screenshot,
    };
    use std::time::{SystemTime, UNIX_EPOCH};

    const ONE_PIXEL_PNG_BASE64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    fn unique_temp_directory() -> std::path::PathBuf {
        let timestamp_nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "floorpov_screenshot_test_{}_{timestamp_nanos}",
            std::process::id()
        ))
    }

    fn png_data_url() -> String {
        format!("data:image/png;base64,{ONE_PIXEL_PNG_BASE64}")
    }

    #[test]
    fn uses_screenshots_folder_under_output_folder() {
        let destination = screenshots_dir(r"C:\Videos\FloorPoV").expect("folder should be valid");
        assert_eq!(
            destination.to_string_lossy(),
            r"C:\Videos\FloorPoV\screenshots"
        );
    }

    #[test]
    fn rejects_empty_output_folder() {
        let error = screenshots_dir("   ").expect_err("empty folder should fail");
        assert!(error.contains("output folder"));
    }

    #[test]
    fn decodes_png_data_url() {
        let decoded = decode_image_data_url(&png_data_url()).expect("png data url should decode");
        assert_eq!(decoded.extension, "png");
        assert!(!decoded.bytes.is_empty());
    }

    #[test]
    fn rejects_non_image_data_url() {
        let error = decode_image_data_url("data:text/plain;base64,YQ==")
            .expect_err("non-image data url should fail");
        assert!(error.contains("PNG or JPEG"));
    }

    #[test]
    fn sanitizes_path_traversal_stems() {
        assert_eq!(sanitize_screenshot_stem(".."), "screenshot");
        assert_eq!(sanitize_screenshot_stem("../evil"), "evil");
        assert_eq!(
            sanitize_screenshot_stem(r"screen_recording_20260101"),
            "screen_recording_20260101"
        );
    }

    #[test]
    fn writes_png_into_screenshots_folder() {
        let temp_directory = unique_temp_directory();
        let screenshots_dir = temp_directory.join("screenshots");
        std::fs::create_dir_all(&screenshots_dir)
            .expect("Failed to create temporary screenshots directory");

        let saved_path = write_playback_screenshot(
            &screenshots_dir,
            Some("key_recording"),
            &png_data_url(),
            "20260101_120000_000",
        )
        .expect("Expected screenshot write to succeed");

        assert_eq!(
            saved_path.file_name().and_then(|name| name.to_str()),
            Some("key_recording_20260101_120000_000.png")
        );
        assert_eq!(saved_path.parent(), Some(screenshots_dir.as_path()));
        assert!(saved_path.is_file());

        std::fs::remove_dir_all(&temp_directory)
            .expect("Failed to remove temporary screenshots directory");
    }

    #[test]
    fn writes_unique_path_when_file_already_exists() {
        let temp_directory = unique_temp_directory();
        let screenshots_dir = temp_directory.join("screenshots");
        std::fs::create_dir_all(&screenshots_dir)
            .expect("Failed to create temporary screenshots directory");

        let first_path = write_playback_screenshot(
            &screenshots_dir,
            Some("key_recording"),
            &png_data_url(),
            "20260101_120000_000",
        )
        .expect("Expected first screenshot write to succeed");
        let second_path = write_playback_screenshot(
            &screenshots_dir,
            Some("key_recording"),
            &png_data_url(),
            "20260101_120000_000",
        )
        .expect("Expected unique screenshot write to succeed");

        assert_ne!(first_path, second_path);
        assert!(second_path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.contains("_2.")));

        std::fs::remove_dir_all(&temp_directory)
            .expect("Failed to remove temporary screenshots directory");
    }

    #[test]
    fn surfaces_write_failures() {
        let temp_directory = unique_temp_directory();
        std::fs::create_dir_all(&temp_directory)
            .expect("Failed to create temporary screenshots directory");
        let blocking_file = temp_directory.join("screenshots");
        std::fs::write(&blocking_file, b"not-a-directory").expect("Failed to create blocking file");

        let error = write_playback_screenshot(
            &blocking_file,
            Some("key_recording"),
            &png_data_url(),
            "20260101_120000_000",
        )
        .expect_err("writing into a file path should fail");

        assert!(error.contains("Could not write the screenshot"));

        std::fs::remove_dir_all(&temp_directory)
            .expect("Failed to remove temporary screenshots directory");
    }

    #[test]
    fn rejects_invalid_recording_paths() {
        let error = validate_recording_path(std::path::Path::new(""))
            .expect_err("empty recording path should fail");
        assert!(error.contains("Load a recording"));

        let error = validate_recording_path(std::path::Path::new(r"C:\Videos\clip.mkv"))
            .expect_err("non-mp4 recordings should fail");
        assert!(error.contains(".mp4"));
    }

    #[test]
    fn rejects_invalid_timestamps() {
        assert!(validate_timestamp(-1.0).is_err());
        assert!(validate_timestamp(f64::NAN).is_err());
        assert!(validate_timestamp(12.5).is_ok());
    }
}
