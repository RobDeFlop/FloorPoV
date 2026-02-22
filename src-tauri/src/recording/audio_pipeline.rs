use std::collections::VecDeque;
use std::io::Write;
use std::sync::atomic::Ordering;
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use wasapi::{initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

use super::model::{
    AudioPipelineStats, SYSTEM_AUDIO_BITS_PER_SAMPLE, SYSTEM_AUDIO_CHANNEL_COUNT,
    SYSTEM_AUDIO_CHUNK_FRAMES, SYSTEM_AUDIO_EVENT_TIMEOUT_MS, SYSTEM_AUDIO_SAMPLE_RATE_HZ,
};

fn build_loopback_capture_context(
) -> Result<(wasapi::AudioClient, wasapi::AudioCaptureClient, WaveFormat), String> {
    initialize_mta()
        .ok()
        .map_err(|error| format!("Failed to initialize COM for system audio capture: {error}"))?;

    let enumerator = DeviceEnumerator::new()
        .map_err(|error| format!("Failed to enumerate audio devices: {error}"))?;
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|error| format!("Failed to access default output audio device: {error}"))?;
    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|error| format!("Failed to create WASAPI audio client: {error}"))?;

    let wave_format = WaveFormat::new(
        SYSTEM_AUDIO_BITS_PER_SAMPLE,
        SYSTEM_AUDIO_BITS_PER_SAMPLE,
        &SampleType::Int,
        SYSTEM_AUDIO_SAMPLE_RATE_HZ,
        SYSTEM_AUDIO_CHANNEL_COUNT,
        None,
    );
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: 0,
    };

    audio_client
        .initialize_client(&wave_format, &Direction::Capture, &mode)
        .map_err(|error| {
            format!("Failed to initialize WASAPI loopback client for system audio: {error}")
        })?;

    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|error| format!("Failed to create WASAPI capture client: {error}"))?;

    Ok((audio_client, capture_client, wave_format))
}

pub(crate) fn validate_system_audio_capture_available() -> Result<(), String> {
    let _ = build_loopback_capture_context()?;
    Ok(())
}

pub(crate) fn run_system_audio_capture_to_queue(
    audio_tx: std_mpsc::SyncSender<Vec<u8>>,
    stop_rx: std_mpsc::Receiver<()>,
    stats: Arc<AudioPipelineStats>,
) -> Result<(), String> {
    let (audio_client, capture_client, wave_format) = build_loopback_capture_context()?;
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
                    if dropped_chunks % 64 == 0 {
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

        if let Err(error) = event_handle.wait_for_event(SYSTEM_AUDIO_EVENT_TIMEOUT_MS) {
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

pub(crate) fn run_audio_queue_to_writer<TWriter: Write>(
    mut writer: TWriter,
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
