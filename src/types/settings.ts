export type VideoQuality = 'low' | 'medium' | 'high' | 'ultra';
export type VideoEncoderPreference = 'auto' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264';
export type FrameRate = 30 | 60;
export type MarkerHotkey = 'F9' | 'F10' | 'F11' | 'F12' | 'none';
export type CaptureSource = 'monitor' | 'window';

export interface RecordingSettings {
  videoQuality: VideoQuality;
  videoEncoderPreference: VideoEncoderPreference;
  frameRate: FrameRate;
  captureSource: CaptureSource;
  captureWindowHwnd: string;
  captureWindowTitle: string;
  outputFolder: string;
  wowFolder: string;
  maxStorageGB: number;
  enableSystemAudio: boolean;
  enableRecordingDiagnostics: boolean;
  enableAutoRecording: boolean;
  minAutoRaidRecordingSeconds: number;
  enableAutoUpdate: boolean;
  markerHotkey: MarkerHotkey;
}

export const DEFAULT_SETTINGS: RecordingSettings = {
  videoQuality: 'high',
  videoEncoderPreference: 'auto',
  frameRate: 30,
  captureSource: 'monitor',
  captureWindowHwnd: '',
  captureWindowTitle: '',
  outputFolder: '',
  wowFolder: '',
  maxStorageGB: 30,
  enableSystemAudio: false,
  enableRecordingDiagnostics: false,
  enableAutoRecording: false,
  minAutoRaidRecordingSeconds: 25,
  enableAutoUpdate: true,
  markerHotkey: 'F9',
};

export const QUALITY_SETTINGS = {
  low: { bitrate: 2_000_000, label: 'Low (2 Mbps)' },
  medium: { bitrate: 5_000_000, label: 'Medium (5 Mbps)' },
  high: { bitrate: 12_000_000, label: 'High (12 Mbps)' },
  ultra: { bitrate: 20_000_000, label: 'Ultra (20 Mbps)' },
} as const;

export const MIN_STORAGE_GB = 5;
export const MAX_STORAGE_GB = 1000;
export const MIN_AUTO_RAID_RECORDING_SECONDS = 0;
export const MAX_AUTO_RAID_RECORDING_SECONDS = 300;

export const HOTKEY_OPTIONS = [
  { value: "F9", label: "F9" },
  { value: "F10", label: "F10" },
  { value: "F11", label: "F11" },
  { value: "F12", label: "F12" },
  { value: "none", label: "None (Disabled)" },
] as const;

export const RECORDING_EVENT_TIMEOUT_MS = 15000;
export const VIDEO_LOADING_TIMEOUT_MS = 8000;
export const VOLUME_MIN = 0;
export const VOLUME_MAX = 1;
export const MEDIA_SECTION_RESIZE_DELTA = 24;
