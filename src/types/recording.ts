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
