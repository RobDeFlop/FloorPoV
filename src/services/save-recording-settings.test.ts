import { expect, mock, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../types/settings";
import { saveRecordingSettings, SettingsSaveResult } from "./save-recording-settings";

enum FolderAccess {
  Unavailable = "unavailable",
  Accessible = "accessible",
}

test("keeps the saved folder on playback failure and grants access on retry", async () => {
  const steps: string[] = [];
  const store = {
    set: async () => { steps.push("set"); },
    save: async () => { steps.push("save"); },
  };
  const originalSettings = { ...DEFAULT_SETTINGS, outputFolder: "C:/Recordings" };
  const retrySettings = { ...originalSettings, outputFolder: "D:/Videos" };
  const accessByFolder = new Map<string, FolderAccess>([
    [originalSettings.outputFolder, FolderAccess.Unavailable],
    [retrySettings.outputFolder, FolderAccess.Accessible],
  ]);
  const allowPlayback = mock(async (folder: string) => {
    steps.push("allow");
    if (accessByFolder.get(folder) !== FolderAccess.Accessible) {
      throw new Error("Access denied");
    }
  });

  expect(await saveRecordingSettings(store, originalSettings, true, allowPlayback))
    .toBe(SettingsSaveResult.PlaybackUnavailable);
  expect(await saveRecordingSettings(store, originalSettings, true, allowPlayback))
    .toBe(SettingsSaveResult.PlaybackUnavailable);
  expect(await saveRecordingSettings(store, retrySettings, true, allowPlayback))
    .toBe(SettingsSaveResult.Saved);

  expect(allowPlayback.mock.calls).toEqual([
    [originalSettings.outputFolder],
    [originalSettings.outputFolder],
    [retrySettings.outputFolder],
  ]);
  expect(steps).toEqual(["set", "save", "allow", "set", "save", "allow", "set", "save", "allow"]);
});

test("does not attempt playback access if saving fails", async () => {
  const store = { set: async () => {}, save: async () => { throw new Error("Disk full"); } };
  const allowPlayback = mock(async () => {});
  await expect(saveRecordingSettings(store, DEFAULT_SETTINGS, true, allowPlayback))
    .rejects.toThrow("Disk full");
  expect(allowPlayback).not.toHaveBeenCalled();
});

test("saving unrelated settings does not request playback access", async () => {
  const store = { set: async () => {}, save: async () => {} };
  const allowPlayback = mock(async () => {});
  expect(await saveRecordingSettings(store, DEFAULT_SETTINGS, false, allowPlayback)).toBe(SettingsSaveResult.Saved);
  expect(allowPlayback).not.toHaveBeenCalled();
});
