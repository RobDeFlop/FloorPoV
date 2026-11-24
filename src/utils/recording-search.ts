import { RecordingInfo } from "../types/recording";
import { type GameMode } from "../types/ui";
import { getRecordingDisplayTitle } from "./recording-title";

function getRecordingSearchText(
  recording: RecordingInfo,
  modeContext?: GameMode,
): string {
  const keyLevelText =
    typeof recording.key_level === "number" ? `+${recording.key_level}` : "";

  return [
    getRecordingDisplayTitle(recording, modeContext),
    recording.filename,
    recording.zone_name,
    recording.encounter_name,
    recording.encounter_category,
    keyLevelText,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
}

export function recordingMatchesSearchQuery(
  recording: RecordingInfo,
  query: string,
  modeContext?: GameMode,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return true;
  }

  return getRecordingSearchText(recording, modeContext).includes(normalizedQuery);
}

export function filterRecordingsBySearchQuery(
  recordings: RecordingInfo[],
  query: string,
  modeContext?: GameMode,
): RecordingInfo[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return recordings;
  }

  return recordings.filter((recording) =>
    recordingMatchesSearchQuery(recording, normalizedQuery, modeContext),
  );
}
