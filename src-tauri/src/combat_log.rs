use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CombatEvent {
    pub timestamp: f64,
    pub event_type: String,
    pub source: Option<String>,
    pub target: Option<String>,
}

struct WatchState {
    handle: Option<JoinHandle<()>>,
    start_time: Instant,
}

lazy_static::lazy_static! {
    static ref WATCH_STATE: Arc<Mutex<Option<WatchState>>> = Arc::new(Mutex::new(None));
}

#[tauri::command]
pub async fn start_combat_watch(app_handle: AppHandle, wow_folder: String) -> Result<(), String> {
    let mut state = WATCH_STATE.lock().map_err(|error| error.to_string())?;

    if state.is_some() {
        return Err("Combat watch already running".to_string());
    }

    let log_path = build_combat_log_path(&wow_folder);
    if !log_path.is_file() {
        return Err(format!(
            "WoW combat log file not found at '{}'. Expected '{}'.",
            wow_folder,
            log_path.to_string_lossy()
        ));
    }

    let initial_offset = std::fs::metadata(&log_path)
        .map_err(|error| error.to_string())?
        .len();

    let app_handle_clone = app_handle.clone();
    let log_path_clone = log_path.clone();
    let start_time = Instant::now();

    let handle = tokio::spawn(async move {
        if let Err(error) = watch_combat_log(app_handle_clone, &log_path_clone, initial_offset, start_time).await {
            tracing::error!("Combat log watcher stopped: {error}");
        }
    });

    *state = Some(WatchState {
        handle: Some(handle),
        start_time,
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_combat_watch() -> Result<(), String> {
    let mut state = WATCH_STATE.lock().map_err(|error| error.to_string())?;

    if let Some(watch_state) = state.take() {
        if let Some(handle) = watch_state.handle {
            handle.abort();
        }
    }

    Ok(())
}

#[tauri::command]
pub fn validate_wow_folder(path: String) -> bool {
    if path.trim().is_empty() {
        return false;
    }

    build_combat_log_path(&path).is_file()
}

#[tauri::command]
pub async fn emit_manual_marker(app_handle: AppHandle) -> Result<(), String> {
    let state = WATCH_STATE.lock().map_err(|error| error.to_string())?;

    if let Some(watch_state) = state.as_ref() {
        let elapsed = watch_state.start_time.elapsed().as_secs_f64();
        let event = CombatEvent {
            timestamp: elapsed,
            event_type: "MANUAL_MARKER".to_string(),
            source: None,
            target: None,
        };

        let _ = app_handle.emit("combat-event", &event);
        return Ok(());
    }

    Err("Combat watch not running".to_string())
}

fn build_combat_log_path(wow_folder: &str) -> PathBuf {
    Path::new(wow_folder).join("Logs").join("WoWCombatLog.txt")
}

async fn watch_combat_log(
    app_handle: AppHandle,
    log_path: &Path,
    initial_offset: u64,
    start_time: Instant,
) -> Result<(), String> {
    let (notify_sender, mut notify_receiver) = mpsc::unbounded_channel::<Result<Event, notify::Error>>();

    let mut watcher = notify::recommended_watcher(move |result| {
        let _ = notify_sender.send(result);
    })
    .map_err(|error| error.to_string())?;

    let watch_directory = log_path.parent().ok_or_else(|| "Invalid WoW combat log path".to_string())?;
    watcher
        .watch(watch_directory, RecursiveMode::NonRecursive)
        .map_err(|error| error.to_string())?;

    let mut file_offset = initial_offset;
    while let Some(notification_result) = notify_receiver.recv().await {
        match notification_result {
            Ok(event) => {
                if !is_relevant_notification(&event, log_path) {
                    continue;
                }

                if let Err(error) = read_and_emit_new_events(&app_handle, log_path, &mut file_offset, start_time) {
                    tracing::warn!("Failed to parse combat log update: {error}");
                }
            }
            Err(error) => {
                tracing::warn!("Combat log watcher error: {error}");
            }
        }
    }

    Ok(())
}

fn is_relevant_notification(event: &Event, log_path: &Path) -> bool {
    let relevant_kind = matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_));
    if !relevant_kind {
        return false;
    }

    let Some(log_file_name) = log_path.file_name() else {
        return false;
    };

    event.paths.iter().any(|path| {
        path == log_path
            || path
                .file_name()
                .map(|file_name| file_name == log_file_name)
                .unwrap_or(false)
    })
}

fn read_and_emit_new_events(
    app_handle: &AppHandle,
    log_path: &Path,
    file_offset: &mut u64,
    start_time: Instant,
) -> Result<(), String> {
    let mut file = File::open(log_path).map_err(|error| error.to_string())?;
    let file_length = file.metadata().map_err(|error| error.to_string())?.len();

    if file_length < *file_offset {
        *file_offset = 0;
    }

    file.seek(SeekFrom::Start(*file_offset))
        .map_err(|error| error.to_string())?;

    let mut reader = BufReader::new(file);
    let mut line = String::new();

    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line).map_err(|error| error.to_string())?;
        if bytes_read == 0 {
            break;
        }

        *file_offset = file_offset.saturating_add(bytes_read as u64);
        if let Some(event) = parse_combat_log_line(&line, start_time.elapsed().as_secs_f64()) {
            let _ = app_handle.emit("combat-event", event);
        }
    }

    Ok(())
}

fn parse_combat_log_line(line: &str, elapsed_seconds: f64) -> Option<CombatEvent> {
    let trimmed_line = line.trim();
    if trimmed_line.is_empty() {
        return None;
    }

    let mut fields = trimmed_line.split(',');
    let header = fields.next()?.trim();
    let event_type = extract_event_type(header)?;

    let normalized_event_type = match event_type {
        "PARTY_KILL" => "PARTY_KILL",
        "UNIT_DIED" | "UNIT_DESTROYED" => "UNIT_DIED",
        _ => return None,
    };

    let source_name = fields.nth(1);
    let _source_flags = fields.next();
    let _source_raid_flags = fields.next();
    let _dest_guid = fields.next();
    let dest_name = fields.next();

    Some(CombatEvent {
        timestamp: elapsed_seconds,
        event_type: normalized_event_type.to_string(),
        source: normalize_name(source_name),
        target: normalize_name(dest_name),
    })
}

fn extract_event_type(header: &str) -> Option<&str> {
    if let Some((_, event_type)) = header.rsplit_once("  ") {
        return Some(event_type.trim());
    }

    header.split_whitespace().last().map(str::trim)
}

fn normalize_name(name: Option<&str>) -> Option<String> {
    let value = name?.trim();
    if value.is_empty() || value == "nil" {
        return None;
    }

    Some(value.trim_matches('"').to_string())
}
