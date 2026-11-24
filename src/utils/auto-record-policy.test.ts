import { describe, expect, test } from "bun:test";
import type { AutoTriggerMode, RecordingOrigin } from "../types/recording";
import {
  nextMissingWowCheckCount,
  resolveAutoRecordTriggerAction,
  shouldStopAutoRecordForMissingWow,
  WOW_PROCESS_GONE_CHECKS_BEFORE_STOP,
  type AutoRecordSessionState,
} from "./auto-record-policy";

function session(
  overrides: Partial<AutoRecordSessionState> = {},
): AutoRecordSessionState {
  return {
    enableAutoRecording: true,
    isRecording: false,
    recordingOrigin: null,
    activeAutoTriggerMode: null,
    operationInFlight: false,
    pendingAutoStopMode: null,
    ...overrides,
  };
}

function autoRecording(mode: AutoTriggerMode): AutoRecordSessionState {
  return session({
    isRecording: true,
    recordingOrigin: "auto",
    activeAutoTriggerMode: mode,
  });
}

describe("auto-record trigger policy", () => {
  test("starts a mythic plus VOD from idle on CHALLENGE_MODE_START", () => {
    expect(
      resolveAutoRecordTriggerAction(session(), {
        triggerType: "start",
        mode: "mythicPlus",
      }),
    ).toEqual({ type: "start", mode: "mythicPlus" });
  });

  test("schedules a stop when the current mythic plus key ends", () => {
    expect(
      resolveAutoRecordTriggerAction(autoRecording("mythicPlus"), {
        triggerType: "end",
        mode: "mythicPlus",
      }),
    ).toEqual({ type: "scheduleStop", mode: "mythicPlus" });
  });

  test("does not stack a second stop timer during the grace period", () => {
    expect(
      resolveAutoRecordTriggerAction(
        {
          ...autoRecording("mythicPlus"),
          pendingAutoStopMode: "mythicPlus",
        },
        { triggerType: "end", mode: "mythicPlus" },
      ),
    ).toEqual({ type: "ignore" });
  });

  test("splits to a new VOD when a new key starts while already auto-recording", () => {
    expect(
      resolveAutoRecordTriggerAction(autoRecording("mythicPlus"), {
        triggerType: "start",
        mode: "mythicPlus",
      }),
    ).toEqual({ type: "stopThenStart", mode: "mythicPlus" });
  });

  test("splits when a new key starts during the previous key stop grace", () => {
    expect(
      resolveAutoRecordTriggerAction(
        {
          ...autoRecording("mythicPlus"),
          pendingAutoStopMode: "mythicPlus",
        },
        { triggerType: "start", mode: "mythicPlus" },
      ),
    ).toEqual({ type: "stopThenStart", mode: "mythicPlus" });
  });

  test("does not interrupt a manual recording for a key start", () => {
    expect(
      resolveAutoRecordTriggerAction(
        session({
          isRecording: true,
          recordingOrigin: "manual" satisfies RecordingOrigin,
        }),
        { triggerType: "start", mode: "mythicPlus" },
      ),
    ).toEqual({ type: "ignore" });
  });

  test("ignores start and end triggers when auto-record is disabled", () => {
    const disabled = session({ enableAutoRecording: false });
    expect(
      resolveAutoRecordTriggerAction(disabled, {
        triggerType: "start",
        mode: "mythicPlus",
      }),
    ).toEqual({ type: "ignore" });
    expect(
      resolveAutoRecordTriggerAction(
        { ...autoRecording("mythicPlus"), enableAutoRecording: false },
        { triggerType: "end", mode: "mythicPlus" },
      ),
    ).toEqual({ type: "ignore" });
  });

  test("keeps one raid VOD when the next pull starts during stop grace", () => {
    expect(
      resolveAutoRecordTriggerAction(
        {
          ...autoRecording("raid"),
          pendingAutoStopMode: "raid",
        },
        { triggerType: "start", mode: "raid" },
      ),
    ).toEqual({ type: "keepRecording" });
  });

  test("does not start a second raid VOD while already raid recording", () => {
    expect(
      resolveAutoRecordTriggerAction(autoRecording("raid"), {
        triggerType: "start",
        mode: "raid",
      }),
    ).toEqual({ type: "ignore" });
  });

  test("starts raid and pvp recordings from idle", () => {
    expect(
      resolveAutoRecordTriggerAction(session(), {
        triggerType: "start",
        mode: "raid",
      }),
    ).toEqual({ type: "start", mode: "raid" });
    expect(
      resolveAutoRecordTriggerAction(session(), {
        triggerType: "start",
        mode: "pvp",
      }),
    ).toEqual({ type: "start", mode: "pvp" });
  });

  test("splits an auto M+ VOD if a pvp match starts", () => {
    expect(
      resolveAutoRecordTriggerAction(autoRecording("mythicPlus"), {
        triggerType: "start",
        mode: "pvp",
      }),
    ).toEqual({ type: "stopThenStart", mode: "pvp" });
  });

  test("ignores a raid pull start while a mythic plus key is recording", () => {
    expect(
      resolveAutoRecordTriggerAction(autoRecording("mythicPlus"), {
        triggerType: "start",
        mode: "raid",
      }),
    ).toEqual({ type: "ignore" });
  });

  test("ignores an end trigger whose mode does not match the active session", () => {
    expect(
      resolveAutoRecordTriggerAction(autoRecording("mythicPlus"), {
        triggerType: "end",
        mode: "pvp",
      }),
    ).toEqual({ type: "ignore" });
  });

  test("ignores auto-stop while a manual recording is active", () => {
    expect(
      resolveAutoRecordTriggerAction(
        session({
          isRecording: true,
          recordingOrigin: "manual",
          activeAutoTriggerMode: null,
        }),
        { triggerType: "end", mode: "mythicPlus" },
      ),
    ).toEqual({ type: "ignore" });
  });

  test("queues a mythic plus start when a start/stop is already in flight", () => {
    expect(
      resolveAutoRecordTriggerAction(
        session({ operationInFlight: true }),
        { triggerType: "start", mode: "mythicPlus" },
      ),
    ).toEqual({ type: "queueStart", mode: "mythicPlus" });
  });

  test("does not queue a raid start while an operation is in flight", () => {
    expect(
      resolveAutoRecordTriggerAction(
        {
          ...autoRecording("raid"),
          operationInFlight: true,
        },
        { triggerType: "start", mode: "raid" },
      ),
    ).toEqual({ type: "ignore" });
  });

  test("does not stop for an end trigger while a start/stop is in flight", () => {
    expect(
      resolveAutoRecordTriggerAction(
        {
          ...autoRecording("mythicPlus"),
          operationInFlight: true,
        },
        { triggerType: "end", mode: "mythicPlus" },
      ),
    ).toEqual({ type: "ignore" });
  });
});

describe("auto-record wow process policy", () => {
  test("requires two missed polls before stopping auto-record", () => {
    let missing = 0;
    missing = nextMissingWowCheckCount(false, missing);
    expect(missing).toBe(1);
    expect(
      shouldStopAutoRecordForMissingWow(missing, true, "auto", false),
    ).toBe(false);

    missing = nextMissingWowCheckCount(false, missing);
    expect(missing).toBe(WOW_PROCESS_GONE_CHECKS_BEFORE_STOP);
    expect(
      shouldStopAutoRecordForMissingWow(missing, true, "auto", false),
    ).toBe(true);
  });

  test("resets the miss count when wow is running again", () => {
    const missing = nextMissingWowCheckCount(true, 1);
    expect(missing).toBe(0);
    expect(
      shouldStopAutoRecordForMissingWow(missing, true, "auto", false),
    ).toBe(false);
  });

  test("does not stop a manual recording when wow exits", () => {
    expect(
      shouldStopAutoRecordForMissingWow(
        WOW_PROCESS_GONE_CHECKS_BEFORE_STOP,
        true,
        "manual",
        false,
      ),
    ).toBe(false);
  });

  test("does not stop while a recording operation is in flight", () => {
    expect(
      shouldStopAutoRecordForMissingWow(
        WOW_PROCESS_GONE_CHECKS_BEFORE_STOP,
        true,
        "auto",
        true,
      ),
    ).toBe(false);
  });
});
