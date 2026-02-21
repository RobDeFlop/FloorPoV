export type VideoQuality = 'low' | 'medium' | 'high' | 'ultra';
export type FrameRate = 30 | 60;
export type CaptureSource = 'primary-monitor' | 'window';
export type MarkerHotkey = 'F9' | 'F10' | 'F11' | 'F12' | 'none';

export interface RecordingSettings {
  videoQuality: VideoQuality;
  frameRate: FrameRate;
  outputFolder: string;
  wowFolder: string;
  maxStorageGB: number;
  captureSource: CaptureSource;
  selectedWindow?: string;
  enableSystemAudio: boolean;
  enableMicrophone: boolean;
  markerHotkey: MarkerHotkey;
}

export const DEFAULT_SETTINGS: RecordingSettings = {
  videoQuality: 'high',
  frameRate: 30,
  outputFolder: '',
  wowFolder: '',
  maxStorageGB: 30,
  captureSource: 'primary-monitor',
  enableSystemAudio: false,
  enableMicrophone: false,
  markerHotkey: 'F9',
};

export const QUALITY_SETTINGS = {
  low: { bitrate: 2_000_000, label: 'Low (2 Mbps)' },
  medium: { bitrate: 5_000_000, label: 'Medium (5 Mbps)' },
  high: { bitrate: 8_000_000, label: 'High (8 Mbps)' },
  ultra: { bitrate: 15_000_000, label: 'Ultra (15 Mbps)' },
} as const;

export const MIN_STORAGE_GB = 5;
export const MAX_STORAGE_GB = 1000;

export const HOTKEY_OPTIONS = [
  { value: 'F9', label: 'F9' },
  { value: 'F10', label: 'F10' },
  { value: 'F11', label: 'F11' },
  { value: 'F12', label: 'F12' },
  { value: 'none', label: 'None (Disabled)' },
] as const;
