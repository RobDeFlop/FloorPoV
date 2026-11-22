use std::collections::VecDeque;
use std::io::Write;
use std::mem::size_of;
use std::sync::atomic::Ordering;
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use wasapi::{
    initialize_mta, AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat,
};
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

use super::model::{
    AudioPipelineStats, SYSTEM_AUDIO_BITS_PER_SAMPLE, SYSTEM_AUDIO_CHANNEL_COUNT,
    SYSTEM_AUDIO_CHUNK_FRAMES, SYSTEM_AUDIO_EVENT_TIMEOUT, SYSTEM_AUDIO_SAMPLE_RATE_HZ,
};

const WOW_PROCESS_NAMES: &[&str] = &["wow.exe", "wowclassic.exe"];

fn is_wow_process_name(file_name: &str) -> bool {
    WOW_PROCESS_NAMES
        .iter()
        .any(|expected| file_name.eq_ignore_ascii_case(expected))
}

fn find_wow_process_id() -> Result<u32, String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err("Failed to snapshot running processes for WoW audio capture".to_string());
    }

    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        cntUsage: 0,
        th32ProcessID: 0,
        th32DefaultHeapID: 0,
        th32ModuleID: 0,
        cntThreads: 0,
        th32ParentProcessID: 0,
        pcPriClassBase: 0,
        dwFlags: 0,
        szExeFile: [0; 260],
    };

    let mut wow_process_id = None;
    let first_ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    if first_ok {
        loop {
            let name_len = entry
                .szExeFile
                .iter()
                .position(|value| *value == 0)
                .unwrap_or(entry.szExeFile.len());
            let process_name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
            if is_wow_process_name(&process_name) {
                wow_process_id = Some(entry.th32ProcessID);
                break;
            }

            if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                break;
            }
        }
    }

    unsafe {
        CloseHandle(snapshot);
    }

    wow_process_id.ok_or_else(|| {
        "World of Warcraft is not running. Start the game or switch audio capture to Entire desktop."
            .to_string()
    })
}

pub(crate) fn is_wow_process_running() -> bool {
    find_wow_process_id().is_ok()
}

fn desired_wave_format() -> WaveFormat {
    WaveFormat::new(
        SYSTEM_AUDIO_BITS_PER_SAMPLE,
        SYSTEM_AUDIO_BITS_PER_SAMPLE,
        &SampleType::Int,
        SYSTEM_AUDIO_SAMPLE_RATE_HZ,
        SYSTEM_AUDIO_CHANNEL_COUNT,
        None,
    )
}

fn initialize_capture_client(
    mut audio_client: AudioClient,
    wave_format: &WaveFormat,
) -> Result<(AudioClient, wasapi::AudioCaptureClient), String> {
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: 0,
    };

    audio_client
        .initialize_client(wave_format, &Direction::Capture, &mode)
        .map_err(|error| {
            format!("Failed to initialize WASAPI loopback client for system audio: {error}")
        })?;

    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|error| format!("Failed to create WASAPI capture client: {error}"))?;

    Ok((audio_client, capture_client))
}

fn build_loopback_capture_context(
    audio_capture_mode: &str,
) -> Result<(AudioClient, wasapi::AudioCaptureClient, WaveFormat), String> {
    initialize_mta()
        .ok()
        .map_err(|error| format!("Failed to initialize COM for system audio capture: {error}"))?;

    let wave_format = desired_wave_format();

    if audio_capture_mode == "wow" {
        let process_id = find_wow_process_id()?;
        tracing::info!(process_id, "Capturing audio from the WoW process");
        let audio_client = AudioClient::new_application_loopback_client(process_id, true)
            .map_err(|error| format!("Failed to create WoW process audio loopback: {error}"))?;
        let (audio_client, capture_client) = initialize_capture_client(audio_client, &wave_format)?;
        return Ok((audio_client, capture_client, wave_format));
    }

    let enumerator = DeviceEnumerator::new()
        .map_err(|error| format!("Failed to enumerate audio devices: {error}"))?;
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|error| format!("Failed to access default output audio device: {error}"))?;
    let audio_client = device
        .get_iaudioclient()
        .map_err(|error| format!("Failed to create WASAPI audio client: {error}"))?;
    let (audio_client, capture_client) = initialize_capture_client(audio_client, &wave_format)?;

    Ok((audio_client, capture_client, wave_format))
}

pub(crate) fn validate_system_audio_capture_available(
    audio_capture_mode: &str,
) -> Result<(), String> {
    let _ = build_loopback_capture_context(audio_capture_mode)?;
    Ok(())
}

pub(crate) fn run_system_audio_capture_to_queue(
    audio_tx: std_mpsc::SyncSender<Vec<u8>>,
    stop_rx: std_mpsc::Receiver<()>,
    stats: Arc<AudioPipelineStats>,
    audio_capture_mode: String,
) -> Result<(), String> {
    let (audio_client, capture_client, wave_format) =
        build_loopback_capture_context(&audio_capture_mode)?;
    let event_handle = audio_client
        .set_get_eventhandle()
        .map_err(|error| format!("Failed to configure WASAPI event handle: {error}"))?;

    audio_client
        .start_stream()
        .map_err(|error| format!("Failed to start system audio stream: {error}"))?;

    let mut sample_queue: VecDeque<u8> = VecDeque::new();
    let chunk_size_bytes = wave_format.get_blockalign() as usize * SYSTEM_AUDIO_CHUNK_FRAMES;
    let mut should_stop = false;
    loop {
        match stop_rx.try_recv() {
            Ok(()) | Err(std_mpsc::TryRecvError::Disconnected) => {
                should_stop = true;
            }
            Err(std_mpsc::TryRecvError::Empty) => {}
        }

        let next_packet_frames = match capture_client.get_next_packet_size() {
            Ok(packet_size) => packet_size.unwrap_or(0),
            Err(error) => {
                tracing::warn!("Failed to poll system audio packets: {error}");
                thread::sleep(Duration::from_millis(10));
                continue;
            }
        };

        if next_packet_frames > 0 {
            if let Err(error) = capture_client.read_from_device_to_deque(&mut sample_queue) {
                tracing::warn!("Failed to read system audio packet: {error}");
                thread::sleep(Duration::from_millis(10));
                continue;
            }
        }

        while sample_queue.len() >= chunk_size_bytes {
            let mut chunk = Vec::with_capacity(chunk_size_bytes);
            chunk.extend(sample_queue.drain(..chunk_size_bytes));

            match audio_tx.try_send(chunk) {
                Ok(()) => {
                    stats.queued_chunks.fetch_add(1, Ordering::Relaxed);
                }
                Err(std_mpsc::TrySendError::Full(_)) => {
                    let dropped_chunks = stats.dropped_chunks.fetch_add(1, Ordering::Relaxed) + 1;
                    if dropped_chunks.is_multiple_of(64) {
                        tracing::warn!(
                            dropped_chunks,
                            "Dropping system audio chunks due to queue backpressure"
                        );
                    }
                }
                Err(std_mpsc::TrySendError::Disconnected(_)) => return Ok(()),
            }
        }

        if should_stop {
            break;
        }

        if let Err(error) =
            event_handle.wait_for_event(SYSTEM_AUDIO_EVENT_TIMEOUT.as_millis() as u32)
        {
            tracing::debug!("System audio wait event timed/failed: {error}");
        }
    }

    if !sample_queue.is_empty() {
        let mut remaining = Vec::with_capacity(sample_queue.len());
        remaining.extend(sample_queue.drain(..));
        if audio_tx.try_send(remaining).is_ok() {
            stats.queued_chunks.fetch_add(1, Ordering::Relaxed);
        }
    }

    if let Err(error) = audio_client.stop_stream() {
        tracing::warn!("Failed to stop system audio stream cleanly: {error}");
    }

    Ok(())
}

pub(crate) fn run_audio_queue_to_writer<W: Write>(
    mut writer: W,
    audio_rx: std_mpsc::Receiver<Vec<u8>>,
    stop_rx: std_mpsc::Receiver<()>,
    stats: Arc<AudioPipelineStats>,
) -> Result<(), String> {
    loop {
        match stop_rx.try_recv() {
            Ok(()) | Err(std_mpsc::TryRecvError::Disconnected) => break,
            Err(std_mpsc::TryRecvError::Empty) => {}
        }

        match audio_rx.recv_timeout(Duration::from_millis(10)) {
            Ok(chunk) => {
                stats.dequeued_chunks.fetch_add(1, Ordering::Relaxed);
                if let Err(error) = writer.write_all(&chunk) {
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) {
                        stats.write_timeouts.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                    return Err(format!(
                        "Failed to write system audio buffer to FFmpeg: {error}"
                    ));
                }
            }
            Err(std_mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std_mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    let _ = writer.flush();
    Ok(())
}

pub(crate) fn is_expected_audio_disconnect_error(error: &str) -> bool {
    error.contains("os error 10053")
        || error.contains("Broken pipe")
        || error.contains("connection reset")
}

#[cfg(test)]
mod tests {
    use super::is_wow_process_name;

    #[test]
    fn recognizes_wow_process_names() {
        assert!(is_wow_process_name("Wow.exe"));
        assert!(is_wow_process_name("wowclassic.exe"));
        assert!(!is_wow_process_name("Discord.exe"));
    }
}
