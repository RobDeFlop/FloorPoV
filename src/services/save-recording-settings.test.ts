import { expect, mock, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../types/settings";
import { saveRecordingSettings } from "./save-recording-settings";

test("keeps the saved folder on playback failure and grants access on retry", async () => {
  const steps: string[] = [];
  const store = {
    set: async () => { steps.push("set"); },
    save: async () => { steps.push("save"); },
  };
  const allowPlayback = async (folder: string) => {
    steps.push(`allow ${folder}`);
    if (folder === "unavailable") throw new Error("Access denied");
  };
  for (const [outputFolder, result] of [
    ["unavailable", "playback-unavailable"],
    ["accessible", "saved"],
  ]) {
    expect(await saveRecordingSettings(store, { ...DEFAULT_SETTINGS, outputFolder }, true, allowPlayback))
      .toBe(result);
  }
  expect(steps).toEqual(["set", "save", "allow unavailable", "set", "save", "allow accessible"]);
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
  expect(await saveRecordingSettings(store, DEFAULT_SETTINGS, false, allowPlayback)).toBe("saved");
  expect(allowPlayback).not.toHaveBeenCalled();
});
