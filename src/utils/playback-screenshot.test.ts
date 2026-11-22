import { describe, expect, test } from "bun:test";
import {
  getVideoFrameCaptureError,
  screenshotFileNameFromPath,
  screenshotFileStemFromPath,
} from "./playback-screenshot";

describe("screenshotFileStemFromPath", () => {
  test("uses a generic stem when no recording is loaded", () => {
    expect(screenshotFileStemFromPath(null)).toBe("screenshot");
    expect(screenshotFileStemFromPath("")).toBe("screenshot");
  });

  test("uses the recording file name without its extension", () => {
    expect(screenshotFileStemFromPath("C:\\Videos\\FloorPoV\\key_recording_20260101.mp4")).toBe(
      "key_recording_20260101",
    );
    expect(screenshotFileStemFromPath("/home/user/Videos/boss.kill.mp4")).toBe("boss.kill");
  });
});

describe("getVideoFrameCaptureError", () => {
  test("rejects a video that has not decoded a frame", () => {
    expect(
      getVideoFrameCaptureError({
        readyState: 1,
        videoWidth: 1920,
        videoHeight: 1080,
      }),
    ).toBe("The video frame is not ready yet.");
  });

  test("rejects a video without visible dimensions", () => {
    expect(
      getVideoFrameCaptureError({
        readyState: 2,
        videoWidth: 0,
        videoHeight: 1080,
      }),
    ).toBe("The video has no visible frame to capture.");
  });

  test("allows a decoded frame with dimensions", () => {
    expect(
      getVideoFrameCaptureError({
        readyState: 4,
        videoWidth: 1920,
        videoHeight: 1080,
      }),
    ).toBeNull();
  });
});

describe("screenshotFileNameFromPath", () => {
  test("returns the file name from a windows path", () => {
    expect(
      screenshotFileNameFromPath("C:\\Videos\\FloorPoV\\screenshots\\key_recording_20260101.png"),
    ).toBe("key_recording_20260101.png");
  });
});
