import { VOLUME_MAX, VOLUME_MIN } from "../types/settings";

export type CompareSeekMode = "shared" | "dual";

export type CompareSlotIndex = 0 | 1;

export interface CompareVideoSlot {
  src: string;
  filePath: string;
  title: string;
}

/** Compare slots in render order, so callers can iterate without index casts. */
export const COMPARE_SLOT_INDEXES: readonly CompareSlotIndex[] = [0, 1];

/**
 * Drift the shared timeline tolerates before nudging the trailing video. Correcting
 * smaller gaps on every frame is audible as stutter and is not worth the accuracy.
 */
export const COMPARE_SYNC_TOLERANCE_SECONDS = 0.25;

export function canEnterCompareMode(selectedCount: number): boolean {
  return selectedCount === 2;
}

export function clampMediaTime(time: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) {
    return 0;
  }

  if (!Number.isFinite(time)) {
    return 0;
  }

  return Math.min(duration, Math.max(0, time));
}

export function clampCompareVolume(volume: number): number {
  if (!Number.isFinite(volume)) {
    return VOLUME_MAX;
  }

  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, volume));
}

export function sharedCompareDuration(leftDuration: number, rightDuration: number): number {
  const left = Number.isFinite(leftDuration) ? Math.max(0, leftDuration) : 0;
  const right = Number.isFinite(rightDuration) ? Math.max(0, rightDuration) : 0;
  return Math.max(left, right);
}

export function compareSeekTimes(
  time: number,
  leftDuration: number,
  rightDuration: number,
): { leftTime: number; rightTime: number } {
  return {
    leftTime: clampMediaTime(time, leftDuration),
    rightTime: clampMediaTime(time, rightDuration),
  };
}

/**
 * Slot that drives the shared timeline. The longer recording keeps the clock moving
 * after the shorter one has stopped at its final frame.
 */
export function compareClockSlotIndex(
  leftDuration: number,
  rightDuration: number,
): CompareSlotIndex {
  const left = Number.isFinite(leftDuration) ? Math.max(0, leftDuration) : 0;
  const right = Number.isFinite(rightDuration) ? Math.max(0, rightDuration) : 0;
  return right > left ? 1 : 0;
}

export function otherCompareSlotIndex(index: CompareSlotIndex): CompareSlotIndex {
  return index === 0 ? 1 : 0;
}

/**
 * Time the trailing video should jump to, or `null` when it already tracks the shared
 * clock closely enough. A shorter recording that ran out stays parked at its end.
 */
export function compareResyncTime(
  clockTime: number,
  slotTime: number,
  slotDuration: number,
  toleranceSeconds: number = COMPARE_SYNC_TOLERANCE_SECONDS,
): number | null {
  const targetTime = clampMediaTime(clockTime, slotDuration);

  if (!Number.isFinite(slotTime)) {
    return targetTime;
  }

  const tolerance = Number.isFinite(toleranceSeconds) ? Math.max(0, toleranceSeconds) : 0;
  if (Math.abs(targetTime - slotTime) <= tolerance) {
    return null;
  }

  return targetTime;
}

export function compareFilePaths(
  compareVideos: [CompareVideoSlot, CompareVideoSlot] | null,
): [string, string] | null {
  if (!compareVideos) {
    return null;
  }

  return [compareVideos[0].filePath, compareVideos[1].filePath];
}

export function isComparedRecordingPath(
  filePath: string,
  compareVideos: [CompareVideoSlot, CompareVideoSlot] | null,
): boolean {
  if (!compareVideos) {
    return false;
  }

  return compareVideos[0].filePath === filePath || compareVideos[1].filePath === filePath;
}

export function shouldExitCompareMode(
  comparedFilePaths: [string, string] | null,
  recordings: Array<{ file_path: string }>,
): boolean {
  if (!comparedFilePaths) {
    return false;
  }

  const availablePathSet = new Set(recordings.map((recording) => recording.file_path));
  return (
    !availablePathSet.has(comparedFilePaths[0]) || !availablePathSet.has(comparedFilePaths[1])
  );
}

/** Keep compare up when both files are still in the list, even if leftover single playback is stale. */
export function shouldPreserveCompareSession(
  comparedFilePaths: [string, string] | null,
  recordings: Array<{ file_path: string }>,
): boolean {
  return comparedFilePaths !== null && !shouldExitCompareMode(comparedFilePaths, recordings);
}

/** After both recordings finish, play-all should rewind the shared clock instead of no-op. */
export function shouldRestartSharedCompare(leftEnded: boolean, rightEnded: boolean): boolean {
  return leftEnded && rightEnded;
}

/**
 * Whether a slot should receive play() when resuming shared seek. An ended shorter
 * recording stays parked; play() on ended media restarts from zero.
 */
export function shouldResumeCompareSlot(clockTime: number, slotDuration: number): boolean {
  if (!Number.isFinite(clockTime) || clockTime < 0) {
    return false;
  }

  if (!Number.isFinite(slotDuration) || slotDuration <= 0) {
    return false;
  }

  return clockTime < slotDuration;
}
