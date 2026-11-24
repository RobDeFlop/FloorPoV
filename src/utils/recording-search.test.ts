import { describe, expect, test } from "bun:test";
import { RecordingInfo } from "../types/recording";
import {
  filterRecordingsBySearchQuery,
  recordingMatchesSearchQuery,
} from "./recording-search";

function recording(overrides: Partial<RecordingInfo> = {}): RecordingInfo {
  return {
    filename: "ara-kara-12.mp4",
    file_path: "C:/vods/ara-kara-12.mp4",
    size_bytes: 2048,
    created_at: 1_700_000_000,
    zone_name: "Ara-Kara, City of Echoes",
    encounter_name: "Avanoxx",
    encounter_category: "mythicPlus",
    key_level: 12,
    ...overrides,
  };
}

describe("recordingMatchesSearchQuery", () => {
  test("matches every recording when the query is empty or whitespace", () => {
    const session = recording();

    expect(recordingMatchesSearchQuery(session, "")).toBe(true);
    expect(recordingMatchesSearchQuery(session, "   ")).toBe(true);
  });

  test("matches title, zone, encounter, and file name case-insensitively", () => {
    const session = recording();

    expect(recordingMatchesSearchQuery(session, "Ara-Kara, City of Echoes · +12")).toBe(true);
    expect(recordingMatchesSearchQuery(session, "city of echoes")).toBe(true);
    expect(recordingMatchesSearchQuery(session, "avanoxx")).toBe(true);
    expect(recordingMatchesSearchQuery(session, "ARA-KARA-12.MP4")).toBe(true);
  });

  test("matches key level text from the display title", () => {
    expect(recordingMatchesSearchQuery(recording(), "+12")).toBe(true);
  });

  test("does not match unrelated queries", () => {
    expect(recordingMatchesSearchQuery(recording(), "nerub-ar palace")).toBe(false);
  });
});

describe("filterRecordingsBySearchQuery", () => {
  const sessions = [
    recording(),
    recording({
      filename: "palace-rashanan.mp4",
      file_path: "C:/vods/palace-rashanan.mp4",
      zone_name: "Nerub-ar Palace",
      encounter_name: "Rashanan",
      encounter_category: "raid",
      key_level: undefined,
    }),
  ];

  test("returns the original list when the query is blank", () => {
    expect(filterRecordingsBySearchQuery(sessions, " ")).toBe(sessions);
  });

  test("keeps only recordings whose title, zone, encounter, or file name match", () => {
    expect(filterRecordingsBySearchQuery(sessions, "palace")).toEqual([sessions[1]]);
    expect(filterRecordingsBySearchQuery(sessions, "avanoxx")).toEqual([sessions[0]]);
    expect(filterRecordingsBySearchQuery(sessions, "missing")).toEqual([]);
  });
});
