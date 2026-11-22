import type { AutoTriggerMode, RecordingOrigin } from "../types/recording";

export const AUTO_STOP_GRACE_MS = 5000;
export const WOW_PROCESS_GONE_POLL_MS = 3000;
export const WOW_PROCESS_GONE_CHECKS_BEFORE_STOP = 2;

export interface AutoRecordSessionState {
  enableAutoRecording: boolean;
  isRecording: boolean;
  recordingOrigin: RecordingOrigin | null;
  activeAutoTriggerMode: AutoTriggerMode | null;
  operationInFlight: boolean;
  pendingAutoStopMode: AutoTriggerMode | null;
}

export interface AutoRecordTrigger {
  triggerType: "start" | "end";
  mode: AutoTriggerMode;
}

export type AutoRecordTriggerAction =
  | { type: "ignore" }
  | { type: "keepRecording" }
  | { type: "start"; mode: AutoTriggerMode }
  | { type: "queueStart"; mode: AutoTriggerMode }
  | { type: "stopThenStart"; mode: AutoTriggerMode }
  | { type: "scheduleStop"; mode: AutoTriggerMode };

export function resolveAutoRecordTriggerAction(
  state: AutoRecordSessionState,
  trigger: AutoRecordTrigger,
): AutoRecordTriggerAction {
  if (!state.enableAutoRecording) {
    return { type: "ignore" };
  }

  if (trigger.triggerType === "start") {
    const shouldKeepRaidRecording =
      trigger.mode === "raid" && state.pendingAutoStopMode === "raid";
    if (shouldKeepRaidRecording) {
      return { type: "keepRecording" };
    }

    if (state.operationInFlight) {
      if (trigger.mode === "raid") {
        return { type: "ignore" };
      }
      return { type: "queueStart", mode: trigger.mode };
    }

    if (state.isRecording) {
      if (state.recordingOrigin !== "auto" || trigger.mode === "raid") {
        return { type: "ignore" };
      }
      return { type: "stopThenStart", mode: trigger.mode };
    }

    return { type: "start", mode: trigger.mode };
  }

  if (
    !state.operationInFlight &&
    state.isRecording &&
    state.recordingOrigin === "auto" &&
    state.activeAutoTriggerMode === trigger.mode
  ) {
    if (state.pendingAutoStopMode !== null) {
      return { type: "ignore" };
    }
    return { type: "scheduleStop", mode: trigger.mode };
  }

  return { type: "ignore" };
}

export function nextMissingWowCheckCount(
  wowIsRunning: boolean,
  consecutiveMissingChecks: number,
): number {
  if (wowIsRunning) {
    return 0;
  }
  return consecutiveMissingChecks + 1;
}

export function shouldStopAutoRecordForMissingWow(
  consecutiveMissingChecks: number,
  isRecording: boolean,
  recordingOrigin: RecordingOrigin | null,
  operationInFlight: boolean,
): boolean {
  if (consecutiveMissingChecks < WOW_PROCESS_GONE_CHECKS_BEFORE_STOP) {
    return false;
  }
  return isRecording && recordingOrigin === "auto" && !operationInFlight;
}
