// src/types/recording.ts
export interface RecordingStartedPayload {
  output_path: string;
  width: number;
  height: number;
}

export interface CaptureWindowInfo {
  hwnd: string;
  title: string;
  process_name: string | null;
}

export interface AvailableVideoEncoder {
  value: string;
  label: string;
}

export interface CleanupResult {
  deleted_count: number;
  freed_bytes: number;
  deleted_files: string[];
}

export interface RecordingInfo {
  filename: string;
  file_path: string;
  size_bytes: number;
  created_at: number;
  zone_name?: string;
  encounter_name?: string;
  encounter_category?: string;
  key_level?: number;
}

/** Settings payload sent to the Rust `start_recording` command. */
export interface RecordingCommandSettings {
  video_quality: string;
  frame_rate: number;
  bitrate: number;
  video_encoder_preference: string;
  capture_source: string;
  capture_window_hwnd: string;
  capture_window_title: string;
  enable_system_audio: boolean;
  enable_recording_diagnostics: boolean;
}

export type RecordingOrigin = "manual" | "auto";
export type AutoTriggerMode = "mythicPlus" | "raid" | "pvp";
