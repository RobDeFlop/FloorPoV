import type { Store } from "@tauri-apps/plugin-store";
import type { RecordingSettings } from "../types/settings";
import { allowRecordingsFolderForPlayback } from "../utils/recording-playback";

export enum SettingsSaveResult {
  Saved = "saved",
  PlaybackUnavailable = "playback-unavailable",
}

export async function saveRecordingSettings(
  store: Pick<Store, "set" | "save">,
  settings: RecordingSettings,
  needsPlaybackAccess: boolean,
  allowPlayback = allowRecordingsFolderForPlayback,
): Promise<SettingsSaveResult> {
  await store.set("recording-settings", settings);
  await store.save();

  if (needsPlaybackAccess) {
    try {
      await allowPlayback(settings.outputFolder);
    } catch (error) {
      console.error("Failed to allow saved recordings folder for playback:", error);
      return SettingsSaveResult.PlaybackUnavailable;
    }
  }

  return SettingsSaveResult.Saved;
}
