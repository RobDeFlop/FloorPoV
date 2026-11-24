import { expect, mock, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../types/settings";
import { checkRecordingSettingsPlayback, saveRecordingSettings } from "./save-recording-settings";

test("keeps the startup warning until a retry grants access to the same folder", async () => {
  const folder = "D:\\Recordings";
  const savedSettings = { ...DEFAULT_SETTINGS, outputFolder: folder };
  const persisted = new Map<string, unknown>([["recording-settings", savedSettings]]);
  const store = {
    set: async (key: string, value: unknown) => { persisted.set(key, value); },
    save: async () => {},
  };
  let folderAccessible = false;
  const allowPlayback = mock(async (_folderPath: string) => {
    if (!folderAccessible) {
      throw new Error("Access denied");
    }
  });

  const startup = await checkRecordingSettingsPlayback(savedSettings, allowPlayback);
  expect(startup.settings.outputFolder).toBe(folder);
  expect(startup.playbackUnavailable).toBe(true);
  expect(persisted.get("recording-settings")).toMatchObject({ outputFolder: folder });

  const failedRetry = await saveRecordingSettings(store, startup.settings, startup, allowPlayback);
  expect(failedRetry.settings.outputFolder).toBe(folder);
  expect(failedRetry.playbackUnavailable).toBe(true);
  expect(persisted.get("recording-settings")).toMatchObject({ outputFolder: folder });

  folderAccessible = true;
  const successfulRetry = await saveRecordingSettings(
    store,
    failedRetry.settings,
    failedRetry,
    allowPlayback,
  );
  expect(successfulRetry.settings.outputFolder).toBe(folder);
  expect(successfulRetry.playbackUnavailable).toBe(false);
  expect(persisted.get("recording-settings")).toMatchObject({ outputFolder: folder });
  expect(allowPlayback.mock.calls).toEqual([[folder], [folder], [folder]]);
});

test("checks a changed folder for playback access after saving it", async () => {
  const steps: string[] = [];
  const store = {
    set: mock(async (_key: string, _settings: unknown) => { steps.push("set"); }),
    save: async () => { steps.push("save"); },
  };
  const settings = { ...DEFAULT_SETTINGS, outputFolder: "C:/Recordings" };
  const current = { settings, playbackUnavailable: false };
  const next = { ...settings, outputFolder: "D:/Videos" };
  const allowPlayback = mock(async (_folder: string) => { steps.push("allow"); });

  expect(await saveRecordingSettings(store, next, current, allowPlayback))
    .toEqual({ settings: next, playbackUnavailable: false });
  expect(store.set.mock.calls).toEqual([["recording-settings", next]]);
  expect(allowPlayback.mock.calls).toEqual([[next.outputFolder]]);
  expect(steps).toEqual(["set", "save", "allow"]);
});

test("does not attempt playback access if saving fails", async () => {
  const store = { set: async () => {}, save: async () => { throw new Error("Disk full"); } };
  const allowPlayback = mock(async () => {});
  const current = { settings: DEFAULT_SETTINGS, playbackUnavailable: true };
  await expect(saveRecordingSettings(store, DEFAULT_SETTINGS, current, allowPlayback))
    .rejects.toThrow("Disk full");
  expect(allowPlayback).not.toHaveBeenCalled();
});

test("saving unrelated settings does not request playback access", async () => {
  const store = { set: async () => {}, save: async () => {} };
  const allowPlayback = mock(async () => {});
  const current = { settings: DEFAULT_SETTINGS, playbackUnavailable: false };
  const next = { ...DEFAULT_SETTINGS, enableAutoUpdate: !DEFAULT_SETTINGS.enableAutoUpdate };
  expect(await saveRecordingSettings(store, next, current, allowPlayback))
    .toEqual({ settings: next, playbackUnavailable: false });
  expect(allowPlayback).not.toHaveBeenCalled();
});
