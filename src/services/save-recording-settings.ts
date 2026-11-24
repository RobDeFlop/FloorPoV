import type { Store } from "@tauri-apps/plugin-store";
import type { RecordingSettings } from "../types/settings";
import { allowRecordingsFolderForPlayback } from "../utils/recording-playback";

export enum SettingsSaveResult {
  Saved = "saved",
  PlaybackUnavailable = "playback-unavailable",
}

export interface RecordingSettingsState {
  settings: RecordingSettings;
  playbackUnavailable: boolean;
}

export async function checkRecordingSettingsPlayback(
  settings: RecordingSettings,
  allowPlayback = allowRecordingsFolderForPlayback,
): Promise<RecordingSettingsState> {
  try {
    await allowPlayback(settings.outputFolder);
    return { settings, playbackUnavailable: false };
  } catch (error) {
    console.error("Failed to allow recordings folder for playback:", settings.outputFolder, error);
    return { settings, playbackUnavailable: true };
  }
}

export async function saveRecordingSettings(
  store: Pick<Store, "set" | "save">,
  settings: RecordingSettings,
  current: RecordingSettingsState,
  allowPlayback = allowRecordingsFolderForPlayback,
): Promise<RecordingSettingsState> {
  await store.set("recording-settings", settings);
  await store.save();

  if (current.playbackUnavailable || current.settings.outputFolder !== settings.outputFolder) {
    return checkRecordingSettingsPlayback(settings, allowPlayback);
  }

  return { settings, playbackUnavailable: false };
}
