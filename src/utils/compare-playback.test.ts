import { describe, expect, test } from "bun:test";
import {
  COMPARE_SYNC_TOLERANCE_SECONDS,
  canEnterCompareMode,
  clampCompareVolume,
  clampMediaTime,
  compareClockSlotIndex,
  compareFilePaths,
  compareResyncTime,
  compareSeekTimes,
  isComparedRecordingPath,
  otherCompareSlotIndex,
  sharedCompareDuration,
  shouldExitCompareMode,
  shouldPreserveCompareSession,
  shouldRestartSharedCompare,
  shouldResumeCompareSlot,
  type CompareVideoSlot,
} from "./compare-playback";

const COMPARE_SLOTS: [CompareVideoSlot, CompareVideoSlot] = [
  { src: "asset://left", filePath: "C:\\Videos\\a.mp4", title: "Left key" },
  { src: "asset://right", filePath: "C:\\Videos\\b.mp4", title: "Right key" },
];

describe("canEnterCompareMode", () => {
  test("allows compare only when exactly two recordings are selected", () => {
    expect(canEnterCompareMode(0)).toBe(false);
    expect(canEnterCompareMode(1)).toBe(false);
    expect(canEnterCompareMode(2)).toBe(true);
    expect(canEnterCompareMode(3)).toBe(false);
  });
});

describe("clampMediaTime", () => {
  test("clamps to the media duration", () => {
    expect(clampMediaTime(-4, 30)).toBe(0);
    expect(clampMediaTime(12, 30)).toBe(12);
    expect(clampMediaTime(40, 30)).toBe(30);
  });

  test("returns zero for invalid media", () => {
    expect(clampMediaTime(8, 0)).toBe(0);
    expect(clampMediaTime(8, Number.NaN)).toBe(0);
    expect(clampMediaTime(Number.NaN, 20)).toBe(0);
  });
});

describe("sharedCompareDuration", () => {
  test("uses the longer recording as the shared timeline", () => {
    expect(sharedCompareDuration(40, 25)).toBe(40);
    expect(sharedCompareDuration(10, 18)).toBe(18);
  });

  test("ignores invalid durations", () => {
    expect(sharedCompareDuration(Number.NaN, 12)).toBe(12);
    expect(sharedCompareDuration(-3, 0)).toBe(0);
  });
});

describe("compareSeekTimes", () => {
  test("keeps both videos on the same clock and clamps the shorter one", () => {
    expect(compareSeekTimes(20, 45, 16)).toEqual({
      leftTime: 20,
      rightTime: 16,
    });
  });
});

describe("clampCompareVolume", () => {
  test("keeps the volume inside the player range", () => {
    expect(clampCompareVolume(-0.5)).toBe(0);
    expect(clampCompareVolume(0.4)).toBe(0.4);
    expect(clampCompareVolume(1.8)).toBe(1);
  });

  test("falls back to full volume for invalid input", () => {
    expect(clampCompareVolume(Number.NaN)).toBe(1);
  });
});

describe("compareClockSlotIndex", () => {
  test("picks the longer recording as the shared clock", () => {
    expect(compareClockSlotIndex(40, 25)).toBe(0);
    expect(compareClockSlotIndex(25, 40)).toBe(1);
  });

  test("prefers the left slot when the durations match or are unknown", () => {
    expect(compareClockSlotIndex(30, 30)).toBe(0);
    expect(compareClockSlotIndex(Number.NaN, Number.NaN)).toBe(0);
  });
});

describe("otherCompareSlotIndex", () => {
  test("returns the opposite slot", () => {
    expect(otherCompareSlotIndex(0)).toBe(1);
    expect(otherCompareSlotIndex(1)).toBe(0);
  });
});

describe("compareResyncTime", () => {
  test("ignores drift inside the tolerance", () => {
    expect(compareResyncTime(10, 10 + COMPARE_SYNC_TOLERANCE_SECONDS / 2, 60)).toBeNull();
  });

  test("returns the clock time once the trailing video drifts too far", () => {
    expect(compareResyncTime(10, 8, 60)).toBe(10);
  });

  test("leaves a shorter recording parked at its end", () => {
    expect(compareResyncTime(50, 20, 20)).toBeNull();
  });

  test("clamps the correction to the trailing recording duration", () => {
    expect(compareResyncTime(50, 5, 20)).toBe(20);
  });

  test("recovers when the trailing time is unknown", () => {
    expect(compareResyncTime(12, Number.NaN, 60)).toBe(12);
  });
});

describe("compareFilePaths", () => {
  test("returns null when compare is inactive", () => {
    expect(compareFilePaths(null)).toBeNull();
  });

  test("returns both slot file paths", () => {
    expect(compareFilePaths(COMPARE_SLOTS)).toEqual(["C:\\Videos\\a.mp4", "C:\\Videos\\b.mp4"]);
  });
});

describe("isComparedRecordingPath", () => {
  test("matches either compared file", () => {
    expect(isComparedRecordingPath("C:\\Videos\\a.mp4", COMPARE_SLOTS)).toBe(true);
    expect(isComparedRecordingPath("C:\\Videos\\b.mp4", COMPARE_SLOTS)).toBe(true);
  });

  test("ignores other files and an inactive compare", () => {
    expect(isComparedRecordingPath("C:\\Videos\\c.mp4", COMPARE_SLOTS)).toBe(false);
    expect(isComparedRecordingPath("C:\\Videos\\a.mp4", null)).toBe(false);
  });
});

describe("shouldExitCompareMode", () => {
  test("keeps compare when both files remain", () => {
    expect(
      shouldExitCompareMode(["C:\\Videos\\a.mp4", "C:\\Videos\\b.mp4"], [
        { file_path: "C:\\Videos\\a.mp4" },
        { file_path: "C:\\Videos\\b.mp4" },
      ]),
    ).toBe(false);
  });

  test("exits when either compared file is gone", () => {
    expect(
      shouldExitCompareMode(["C:\\Videos\\a.mp4", "C:\\Videos\\b.mp4"], [
        { file_path: "C:\\Videos\\a.mp4" },
      ]),
    ).toBe(true);
  });

  test("does nothing when compare is inactive", () => {
    expect(shouldExitCompareMode(null, [])).toBe(false);
  });
});

describe("shouldPreserveCompareSession", () => {
  test("keeps compare when both files remain", () => {
    expect(
      shouldPreserveCompareSession(["C:\\Videos\\a.mp4", "C:\\Videos\\b.mp4"], [
        { file_path: "C:\\Videos\\a.mp4" },
        { file_path: "C:\\Videos\\b.mp4" },
        { file_path: "C:\\Videos\\c.mp4" },
      ]),
    ).toBe(true);
  });

  test("does not preserve when a compared file is gone", () => {
    expect(
      shouldPreserveCompareSession(["C:\\Videos\\a.mp4", "C:\\Videos\\b.mp4"], [
        { file_path: "C:\\Videos\\a.mp4" },
      ]),
    ).toBe(false);
  });

  test("does not preserve an inactive compare", () => {
    expect(shouldPreserveCompareSession(null, [{ file_path: "C:\\Videos\\a.mp4" }])).toBe(false);
  });
});

describe("shouldRestartSharedCompare", () => {
  test("rewinds only after both recordings have ended", () => {
    expect(shouldRestartSharedCompare(true, true)).toBe(true);
    expect(shouldRestartSharedCompare(true, false)).toBe(false);
    expect(shouldRestartSharedCompare(false, false)).toBe(false);
  });
});

describe("shouldResumeCompareSlot", () => {
  test("plays a slot that still has time on the shared clock", () => {
    expect(shouldResumeCompareSlot(10, 20)).toBe(true);
  });

  test("leaves a shorter recording parked once the clock is past its end", () => {
    expect(shouldResumeCompareSlot(20, 20)).toBe(false);
    expect(shouldResumeCompareSlot(50, 20)).toBe(false);
  });

  test("rejects invalid clock or duration", () => {
    expect(shouldResumeCompareSlot(Number.NaN, 20)).toBe(false);
    expect(shouldResumeCompareSlot(8, 0)).toBe(false);
  });
});
