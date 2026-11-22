import { describe, expect, test } from "bun:test";
import { isPlaybackRecordingMissing, shouldClearStalePlayback } from "./playback-session";

describe("isPlaybackRecordingMissing", () => {
  test("keeps playback when nothing is loaded", () => {
    expect(isPlaybackRecordingMissing(null, [])).toBe(false);
    expect(
      isPlaybackRecordingMissing(null, [{ file_path: "C:\\Videos\\key.mp4" }]),
    ).toBe(false);
  });

  test("keeps playback when the loaded file is still in the list", () => {
    expect(
      isPlaybackRecordingMissing("C:\\Videos\\key.mp4", [
        { file_path: "C:\\Videos\\other.mp4" },
        { file_path: "C:\\Videos\\key.mp4" },
      ]),
    ).toBe(false);
  });

  test("clears playback when the loaded file is gone", () => {
    expect(
      isPlaybackRecordingMissing("C:\\Videos\\key.mp4", [
        { file_path: "C:\\Videos\\other.mp4" },
      ]),
    ).toBe(true);
  });

  test("clears playback when the recordings folder is empty", () => {
    expect(isPlaybackRecordingMissing("C:\\Videos\\key.mp4", [])).toBe(true);
  });
});

describe("shouldClearStalePlayback", () => {
  test("clears a leftover player when the folder is empty", () => {
    expect(shouldClearStalePlayback(null, true, [])).toBe(true);
  });

  test("does not clear an idle player", () => {
    expect(shouldClearStalePlayback(null, false, [])).toBe(false);
  });

  test("does not guess when a src exists without a path and other files remain", () => {
    expect(
      shouldClearStalePlayback(null, true, [{ file_path: "C:\\Videos\\other.mp4" }]),
    ).toBe(false);
  });
});
