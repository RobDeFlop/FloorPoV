use std::fs;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use super::model::CREATE_NO_WINDOW;

pub(crate) fn create_segment_workspace(output_path: &str) -> Result<PathBuf, String> {
    let output = PathBuf::from(output_path);
    let parent = output
        .parent()
        .ok_or_else(|| "Output path does not have a parent directory".to_string())?;
    let stem = output
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("recording");
    let unique_suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let workspace = parent.join(format!(".{stem}_segments_{unique_suffix}"));
    fs::create_dir_all(&workspace)
        .map_err(|error| format!("Failed to create recording segment workspace: {error}"))?;
    Ok(workspace)
}

pub(crate) fn build_segment_output_path(segment_workspace: &Path, index: usize) -> PathBuf {
    segment_workspace.join(format!("segment_{index:04}.mp4"))
}

fn concat_file_path(segment_workspace: &Path) -> PathBuf {
    segment_workspace.join("segments.txt")
}

fn format_concat_entry(path: &Path, duration: Option<Duration>) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let escaped = normalized.replace('\'', "\\'");
    let mut entry = format!("file '{escaped}'\n");
    if let Some(dur) = duration {
        // The `duration` directive tells the concat demuxer the wall-clock length of each
        // segment, overriding any internal timestamps. This prevents synthetic sources
        // (like `color`) from inflating the final video duration beyond real time.
        entry.push_str(&format!("duration {:.6}\n", dur.as_secs_f64()));
    }
    entry
}

fn write_concat_file(
    segment_workspace: &Path,
    segment_paths: &[PathBuf],
    segment_durations: &[Duration],
) -> Result<PathBuf, String> {
    let concat_path = concat_file_path(segment_workspace);
    let mut contents = String::new();
    for (index, segment_path) in segment_paths.iter().enumerate() {
        let duration = segment_durations.get(index).copied();
        contents.push_str(&format_concat_entry(segment_path, duration));
    }

    fs::write(&concat_path, contents)
        .map_err(|error| format!("Failed to write FFmpeg concat file: {error}"))?;

    Ok(concat_path)
}

fn move_segment_to_final_output(segment_path: &Path, output_path: &str) -> Result<(), String> {
    let output = PathBuf::from(output_path);

    if output.exists() {
        fs::remove_file(&output)
            .map_err(|error| format!("Failed to replace existing output recording: {error}"))?;
    }

    match fs::rename(segment_path, &output) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            fs::copy(segment_path, &output).map_err(|copy_error| {
                format!(
                    "Failed to move final segment into output recording. rename error: {rename_error}; copy error: {copy_error}"
                )
            })?;
            fs::remove_file(segment_path).map_err(|remove_error| {
                format!("Failed to remove copied segment file after fallback copy: {remove_error}")
            })?;
            Ok(())
        }
    }
}

fn finalize_with_exact_segments(
    ffmpeg_binary_path: &Path,
    segment_workspace: &Path,
    segment_paths: &[PathBuf],
    segment_durations: &[Duration],
    output_path: &str,
) -> Result<(), String> {
    if segment_paths.is_empty() {
        return Err("No recording segments were produced".to_string());
    }

    if segment_paths.len() == 1 {
        return move_segment_to_final_output(&segment_paths[0], output_path);
    }

    let concat_path = write_concat_file(segment_workspace, segment_paths, segment_durations)?;

    let mut command = Command::new(ffmpeg_binary_path);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let status = command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("warning")
        .arg("-y")
        .arg("-f")
        .arg("concat")
        .arg("-safe")
        .arg("0")
        .arg("-i")
        .arg(&concat_path)
        .arg("-c")
        .arg("copy")
        .arg(output_path)
        .status()
        .map_err(|error| format!("Failed to start FFmpeg concat process: {error}"))?;

    if !status.success() {
        return Err(format!(
            "FFmpeg concat process failed with status: {status}"
        ));
    }

    Ok(())
}

fn finalize_and_verify(
    ffmpeg_binary_path: &Path,
    segment_workspace: &Path,
    segment_paths: &[PathBuf],
    segment_durations: &[Duration],
    output_path: &str,
) -> Result<(), String> {
    finalize_with_exact_segments(
        ffmpeg_binary_path,
        segment_workspace,
        segment_paths,
        segment_durations,
        output_path,
    )?;
    remux_to_library_mp4(ffmpeg_binary_path, Path::new(output_path))
}

pub(crate) fn remux_to_library_mp4(
    ffmpeg_binary_path: &Path,
    output_path: &Path,
) -> Result<(), String> {
    let probe = super::mp4::probe_mp4(output_path);
    if probe.is_library_ready() {
        return Ok(());
    }
    if !probe.has_media_fragment() {
        return Err(
            "Recording is missing media fragments and a duration-bearing MP4 header".to_string(),
        );
    }

    let file_stem = output_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("recording");
    let temp_path = output_path.with_file_name(format!(".{file_stem}.library.mp4"));

    if temp_path.exists() {
        fs::remove_file(&temp_path).map_err(|error| {
            format!(
                "Failed to replace leftover remux file {}: {error}",
                temp_path.display()
            )
        })?;
    }

    let mut command = Command::new(ffmpeg_binary_path);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let status = command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-y")
        .arg("-i")
        .arg(output_path)
        .arg("-c")
        .arg("copy")
        .arg("-movflags")
        .arg(super::mp4::LIBRARY_MOVFLAGS)
        .arg(&temp_path)
        .status()
        .map_err(|error| format!("Failed to start FFmpeg remux process: {error}"))?;

    if !status.success() {
        remove_temp_remux_file(&temp_path);
        return Err(format!("FFmpeg remux process failed with status: {status}"));
    }

    let remuxed = super::mp4::probe_mp4(&temp_path);
    if !remuxed.is_library_ready() {
        remove_temp_remux_file(&temp_path);
        return Err("Remuxed recording is missing a duration-bearing MP4 movie header".to_string());
    }

    if output_path.exists() {
        fs::remove_file(output_path).map_err(|error| {
            remove_temp_remux_file(&temp_path);
            format!("Failed to replace live recording with remuxed library file: {error}")
        })?;
    }

    match fs::rename(&temp_path, output_path) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            fs::copy(&temp_path, output_path).map_err(|copy_error| {
                remove_temp_remux_file(&temp_path);
                format!(
                    "Failed to move remuxed library file into place. rename error: {rename_error}; copy error: {copy_error}"
                )
            })?;
            fs::remove_file(&temp_path).map_err(|remove_error| {
                format!("Failed to remove remux temp file after fallback copy: {remove_error}")
            })?;
            Ok(())
        }
    }
}

fn collect_non_empty_segments(
    segment_paths: &[PathBuf],
    segment_durations: &[Duration],
) -> (Vec<PathBuf>, Vec<Duration>) {
    let mut paths = Vec::new();
    let mut durations = Vec::new();
    for (index, segment_path) in segment_paths.iter().enumerate() {
        if segment_path.exists()
            && segment_path
                .metadata()
                .is_ok_and(|metadata| metadata.len() > 0)
            && super::mp4::probe_mp4(segment_path).is_usable_segment()
        {
            paths.push(segment_path.clone());
            if let Some(dur) = segment_durations.get(index) {
                durations.push(*dur);
            }
        }
    }
    (paths, durations)
}

fn segment_is_decodable(ffmpeg_binary_path: &Path, segment_path: &Path) -> bool {
    let mut command = Command::new(ffmpeg_binary_path);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let status = command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-nostdin")
        .arg("-i")
        .arg(segment_path)
        .arg("-frames:v")
        .arg("1")
        .arg("-f")
        .arg("null")
        .arg("-")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    match status {
        Ok(status) => status.success(),
        Err(error) => {
            tracing::warn!(
                segment_path = %segment_path.display(),
                "Failed to validate recording segment readability: {error}"
            );
            false
        }
    }
}

fn collect_decodable_segments(
    ffmpeg_binary_path: &Path,
    segment_paths: &[PathBuf],
    segment_durations: &[Duration],
) -> (Vec<PathBuf>, Vec<Duration>) {
    let mut paths = Vec::new();
    let mut durations = Vec::new();
    for (index, segment_path) in segment_paths.iter().enumerate() {
        let is_decodable = segment_is_decodable(ffmpeg_binary_path, segment_path);
        if !is_decodable {
            tracing::warn!(
                segment_path = %segment_path.display(),
                "Skipping recording segment because FFmpeg could not decode it"
            );
        } else {
            paths.push(segment_path.clone());
            if let Some(dur) = segment_durations.get(index) {
                durations.push(*dur);
            }
        }
    }
    (paths, durations)
}

pub(crate) fn finalize_segmented_recording(
    ffmpeg_binary_path: &Path,
    segment_workspace: &Path,
    segment_paths: &[PathBuf],
    segment_durations: &[Duration],
    output_path: &str,
) -> Result<(), String> {
    let (non_empty_paths, non_empty_durations) =
        collect_non_empty_segments(segment_paths, segment_durations);

    if non_empty_paths.is_empty() {
        return Err("No recording segments were produced".to_string());
    }

    // Fast path: try concat with all non-empty segments first.
    // Only run decodability probing if this fails.
    if finalize_and_verify(
        ffmpeg_binary_path,
        segment_workspace,
        &non_empty_paths,
        &non_empty_durations,
        output_path,
    )
    .is_ok()
    {
        return Ok(());
    }

    tracing::warn!(
        "FFmpeg concat failed for full segment set. Probing segment decodability and trying recovery strategies"
    );

    // Slow path: probe each segment for decodability, then run recovery
    let (valid_paths, valid_durations) =
        collect_decodable_segments(ffmpeg_binary_path, &non_empty_paths, &non_empty_durations);

    if valid_paths.is_empty() {
        return Err("No valid recording segments were produced".to_string());
    }

    let mut last_error = String::new();

    if valid_paths.len() > 2 {
        for remove_index in 1..(valid_paths.len() - 1) {
            let mut candidate_paths = valid_paths.clone();
            let mut candidate_durations = valid_durations.clone();
            let removed_segment = candidate_paths.remove(remove_index);
            if remove_index < candidate_durations.len() {
                candidate_durations.remove(remove_index);
            }

            match finalize_and_verify(
                ffmpeg_binary_path,
                segment_workspace,
                &candidate_paths,
                &candidate_durations,
                output_path,
            ) {
                Ok(()) => {
                    tracing::warn!(
                        remove_index,
                        removed_segment = %removed_segment.display(),
                        total_segments = valid_paths.len(),
                        "Recovered recording by dropping one invalid middle segment"
                    );
                    return Ok(());
                }
                Err(error) => {
                    last_error = error;
                }
            }
        }
    }

    for prefix_len in (1..valid_paths.len()).rev() {
        let prefix_paths = &valid_paths[..prefix_len];
        let prefix_durations = &valid_durations[..prefix_len.min(valid_durations.len())];
        match finalize_and_verify(
            ffmpeg_binary_path,
            segment_workspace,
            prefix_paths,
            prefix_durations,
            output_path,
        ) {
            Ok(()) => {
                tracing::warn!(
                    prefix_len,
                    total_segments = valid_paths.len(),
                    "Recovered recording by concatenating the longest valid prefix"
                );
                return Ok(());
            }
            Err(error) => {
                last_error = error;
            }
        }
    }

    for suffix_start in 1..valid_paths.len() {
        let suffix_paths = &valid_paths[suffix_start..];
        let suffix_durations = if suffix_start < valid_durations.len() {
            &valid_durations[suffix_start..]
        } else {
            &[]
        };
        match finalize_and_verify(
            ffmpeg_binary_path,
            segment_workspace,
            suffix_paths,
            suffix_durations,
            output_path,
        ) {
            Ok(()) => {
                tracing::warn!(
                    suffix_start,
                    suffix_len = suffix_paths.len(),
                    total_segments = valid_paths.len(),
                    "Recovered recording by concatenating a valid suffix"
                );
                return Ok(());
            }
            Err(error) => {
                last_error = error;
            }
        }
    }

    Err(format!(
        "Failed to finalize recording after trying full/middle-drop/prefix/suffix concat strategies. Last error: {last_error}"
    ))
}

fn remove_temp_remux_file(temp_path: &Path) {
    if let Err(error) = fs::remove_file(temp_path) {
        tracing::warn!(
            temp_path = %temp_path.display(),
            "Failed to remove remux temp file: {error}"
        );
    }
}

pub(crate) fn cleanup_segment_workspace(segment_workspace: &Path) {
    if let Err(error) = fs::remove_dir_all(segment_workspace) {
        tracing::warn!(
            segment_workspace = %segment_workspace.display(),
            "Failed to remove recording segment workspace: {error}"
        );
    }
}
