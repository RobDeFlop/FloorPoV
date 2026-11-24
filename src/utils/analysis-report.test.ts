import { describe, expect, test } from "bun:test";
import type { RecordingMetadata } from "../types/events";
import {
  ANALYSIS_REPORT_SCHEMA_VERSION,
  buildAnalysisReportContents,
  buildAnalysisReportJson,
  buildAnalysisReportMarkdown,
  buildAnalysisReportPayload,
  ensureAnalysisReportDestination,
  recordingFileStem,
  resolveAnalysisReportFormat,
  suggestedAnalysisReportFilename,
} from "./analysis-report";

function sampleMetadata(): RecordingMetadata {
  return {
    schemaVersion: 2,
    recordingFile: "voidscar-arena-14-20260908-1518.mp4",
    zoneName: "Voidscar Arena",
    encounterName: "Boss One",
    encounterCategory: "mythicPlus",
    keyLevel: 14,
    capturedAtUnix: 1_778_000_000,
    encounters: [
      {
        name: "Boss One",
        category: "mythicPlus",
        startedAtSeconds: 12,
        endedAtSeconds: 125,
      },
    ],
    importantEvents: [
      {
        timestampSeconds: 12.4,
        eventType: "SPELL_INTERRUPT",
        source: "Kicker-Realm",
        target: "Caster|Mob",
        encounterName: "Boss One",
      },
    ],
    importantEventCounts: {
      SPELL_INTERRUPT: 3,
      UNIT_DIED: 1,
    },
    importantEventsDroppedCount: 2,
    players: [
      {
        guid: "Player-1",
        name: "Tank|One",
        className: "Warrior",
        specName: "Protection",
      },
    ],
  };
}

describe("analysis report filenames", () => {
  test("derives a stem from a recording path or filename", () => {
    expect(recordingFileStem("voidscar-arena-14-20260908-1518.mp4")).toBe(
      "voidscar-arena-14-20260908-1518",
    );
    expect(recordingFileStem(String.raw`C:\Recordings\capture.mp4`)).toBe("capture");
    expect(recordingFileStem("")).toBe("recording");
  });

  test("suggests an analysis filename", () => {
    expect(suggestedAnalysisReportFilename("capture.mp4")).toBe("capture-analysis.md");
    expect(suggestedAnalysisReportFilename("capture.mp4", "json")).toBe("capture-analysis.json");
  });

  test("resolves format from the destination extension", () => {
    expect(resolveAnalysisReportFormat("report.json")).toBe("json");
    expect(resolveAnalysisReportFormat("report.MD")).toBe("md");
    expect(resolveAnalysisReportFormat("report")).toBe("md");
    expect(ensureAnalysisReportDestination("C:/Exports/report")).toBe("C:/Exports/report.md");
    expect(ensureAnalysisReportDestination("C:/Exports/report.json")).toBe(
      "C:/Exports/report.json",
    );
  });
});

describe("analysis report contents", () => {
  test("builds a payload from stored metadata", () => {
    const payload = buildAnalysisReportPayload(sampleMetadata(), "fallback.mp4");

    expect(payload.schemaVersion).toBe(ANALYSIS_REPORT_SCHEMA_VERSION);
    expect(payload.recordingFile).toBe("voidscar-arena-14-20260908-1518.mp4");
    expect(payload.players).toHaveLength(1);
    expect(payload.encounters).toHaveLength(1);
    expect(payload.importantEvents).toHaveLength(1);
  });

  test("fills empty collections when no sidecar exists", () => {
    const payload = buildAnalysisReportPayload(null, "capture.mp4");

    expect(payload.recordingFile).toBe("capture.mp4");
    expect(payload.encounters).toEqual([]);
    expect(payload.importantEvents).toEqual([]);
    expect(payload.players).toEqual([]);
    expect(payload.importantEventCounts).toEqual({});
  });

  test("renders markdown with players, encounters, and events", () => {
    const markdown = buildAnalysisReportMarkdown(sampleMetadata(), "fallback.mp4");

    expect(markdown).toContain("# Analysis Report");
    expect(markdown).toContain("Use WarcraftLogs for a full combat report.");
    expect(markdown).toContain("`voidscar-arena-14-20260908-1518.mp4`");
    expect(markdown).toContain("`Voidscar Arena`");
    expect(markdown).toContain("+14");
    expect(markdown).toContain("`Mythic+`");
    expect(markdown).toContain("| `Tank|One` | `Warrior` | `Protection` |");
    expect(markdown).toContain("| `Boss One` | `Mythic+` | 0:12 | 2:05 |");
    expect(markdown).toContain("- `SPELL_INTERRUPT`: 3");
    expect(markdown).toContain("2 high-volume events were dropped during buffering.");
    expect(markdown).toContain("| 0:12 | `SPELL_INTERRUPT` | `Kicker-Realm` | `Caster|Mob` | `Boss One` |");
  });

  test("wraps sidecar text so markdown viewers do not interpret links or headings", () => {
    const markdown = buildAnalysisReportMarkdown(
      {
        ...sampleMetadata(),
        zoneName: "[Click](https://evil.example)\n# Fake heading",
      },
      "fallback.mp4",
    );

    expect(markdown).toContain("`[Click](https://evil.example) # Fake heading`");
    expect(markdown).not.toContain("](https://evil.example)\n#");
  });

  test("renders empty markdown sections when metadata is missing", () => {
    const markdown = buildAnalysisReportMarkdown(null, "capture.mp4");

    expect(markdown).toContain("- File: `capture.mp4`");
    expect(markdown.match(/None recorded\./g)?.length).toBe(4);
  });

  test("serializes JSON from stored metadata", () => {
    const parsed = JSON.parse(buildAnalysisReportJson(sampleMetadata(), "fallback.mp4")) as {
      players: Array<{ name?: string }>;
      importantEvents: Array<{ eventType: string }>;
    };

    expect(parsed.players[0]?.name).toBe("Tank|One");
    expect(parsed.importantEvents[0]?.eventType).toBe("SPELL_INTERRUPT");
  });

  test("chooses contents from the destination extension", () => {
    const markdown = buildAnalysisReportContents("report.md", null, "capture.mp4");
    const json = buildAnalysisReportContents("report.json", null, "capture.mp4");

    expect(markdown.startsWith("# Analysis Report")).toBe(true);
    expect(JSON.parse(json).recordingFile).toBe("capture.mp4");
  });
});
