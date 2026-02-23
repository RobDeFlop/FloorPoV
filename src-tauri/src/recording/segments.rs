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
        .arg("-movflags")
        .arg("+faststart")
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

    let (valid_paths, valid_durations) =
        collect_decodable_segments(ffmpeg_binary_path, &non_empty_paths, &non_empty_durations);

    if valid_paths.is_empty() {
        return Err("No valid recording segments were produced".to_string());
    }

    if let Err(initial_error) = finalize_with_exact_segments(
        ffmpeg_binary_path,
        segment_workspace,
        &valid_paths,
        &valid_durations,
        output_path,
    ) {
        tracing::warn!(
            error = %initial_error,
            "FFmpeg concat failed for full segment set. Trying middle-drop and edge recovery strategies"
        );

        let mut last_error = initial_error;

        if valid_paths.len() > 2 {
            for remove_index in 1..(valid_paths.len() - 1) {
                let mut candidate_paths = valid_paths.clone();
                let mut candidate_durations = valid_durations.clone();
                let removed_segment = candidate_paths.remove(remove_index);
                if remove_index < candidate_durations.len() {
                    candidate_durations.remove(remove_index);
                }

                match finalize_with_exact_segments(
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
            match finalize_with_exact_segments(
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
            match finalize_with_exact_segments(
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

        return Err(format!(
            "Failed to finalize recording after trying full/middle-drop/prefix/suffix concat strategies. Last error: {last_error}"
        ));
    }

    Ok(())
}

pub(crate) fn cleanup_segment_workspace(segment_workspace: &Path) {
    if let Err(error) = fs::remove_dir_all(segment_workspace) {
        tracing::warn!(
            segment_workspace = %segment_workspace.display(),
            "Failed to remove recording segment workspace: {error}"
        );
    }
}
