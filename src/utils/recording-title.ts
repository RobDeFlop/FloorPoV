import { RecordingInfo } from "../types/recording";
import { type GameMode } from "../types/ui";

/** Alias kept for backward compatibility; prefer `GameMode` from `types/ui`. */
export type RecordingTitleMode = GameMode;

function normalizeEncounterCategory(category?: string): string | null {
  if (!category) {
    return null;
  }

  const normalized = category.trim();
  if (!normalized) {
    return null;
  }

  if (normalized === "mythicPlus") {
    return "mythic-plus";
  }

  return normalized;
}

export function inferRecordingMode(
  recording: RecordingInfo,
  modeContext?: RecordingTitleMode,
): RecordingTitleMode | null {
  if (modeContext) {
    return modeContext;
  }

  const category = normalizeEncounterCategory(recording.encounter_category);

  if (typeof recording.key_level === "number" || category === "mythic-plus") {
    return "mythic-plus";
  }

  if (category === "raid") {
    return "raid";
  }

  if (category === "pvp") {
    return "pvp";
  }

  return null;
}

export function getRecordingDisplayTitle(
  recording: RecordingInfo,
  modeContext?: RecordingTitleMode,
): string {
  const resolvedMode = inferRecordingMode(recording, modeContext);

  if (resolvedMode === "mythic-plus") {
    const primary = recording.zone_name?.trim() || "Mythic+ Session";
    const secondary =
      typeof recording.key_level === "number"
        ? `+${recording.key_level}`
        : recording.encounter_name?.trim();
    return secondary ? `${primary} · ${secondary}` : primary;
  }

  if (resolvedMode === "raid") {
    const primary = recording.zone_name?.trim() || "Raid session";
    const secondary = recording.encounter_name?.trim();
    return secondary ? `${primary} · ${secondary}` : primary;
  }

  if (resolvedMode === "pvp") {
    const primary = recording.zone_name?.trim() || "PvP session";
    const secondary = recording.encounter_name?.trim() || "Match";
    return `${primary} · ${secondary}`;
  }

  const primary = recording.zone_name?.trim() || recording.encounter_name?.trim() || "Session";
  const secondary =
    recording.zone_name?.trim() && recording.encounter_name?.trim() !== recording.zone_name?.trim()
      ? recording.encounter_name?.trim()
      : null;
  return secondary ? `${primary} · ${secondary}` : primary;
}

export function isRecordingInGameMode(
  recording: RecordingInfo,
  gameMode: RecordingTitleMode,
): boolean {
  return inferRecordingMode(recording) === gameMode;
}
