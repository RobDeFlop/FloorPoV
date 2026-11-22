import { describe, expect, test } from "bun:test";
import {
  convertCombatEvent,
  convertRecordingMetadataToGameEvents,
  convertRecordingNoteToGameEvent,
  getGameEventDescription,
  getManualMarkerLabel,
  isVideoSeekBarEvent,
  MANUAL_MARKER_NAME_MAX_LENGTH,
  manualMarkerOccurrenceIndex,
  normalizeManualMarkerName,
  recordingMetadataHasCombatContent,
  shouldPromptManualMarkerName,
  shouldShowGameEvent,
  type GameEvent,
  type GameEventType,
  type RecordingMetadata,
} from "./events";

interface DocumentFocusStub {
  visibilityState: string;
  hasFocus: () => boolean;
}

function withDocument(stub: DocumentFocusStub | null, assert: () => void): void {
  const globalScope = globalThis as { document?: unknown };
  const originalDocument = globalScope.document;

  if (stub) {
    globalScope.document = stub;
  } else {
    delete globalScope.document;
  }

  try {
    assert();
  } finally {
    if (originalDocument === undefined) {
      delete globalScope.document;
    } else {
      globalScope.document = originalDocument;
    }
  }
}

function metadataWithMarker(name?: string): RecordingMetadata {
  return {
    schemaVersion: 2,
    recordingFile: "screen_recording_20260222_153012.mp4",
    importantEvents: [
      { timestampSeconds: 12.5, eventType: "MANUAL_MARKER", name },
      { timestampSeconds: 30, eventType: "UNIT_DIED", target: "Player-1234-ABCD" },
    ],
  };
}

const ALL_EVENT_TYPES_VISIBLE: Record<GameEventType, boolean> = {
  death: true,
  manual: true,
  bloodlust: true,
  encounterStart: true,
  encounterEnd: true,
  note: true,
};

function metadata(overrides: Partial<RecordingMetadata> = {}): RecordingMetadata {
  return {
    schemaVersion: 2,
    recordingFile: "screen_recording_20260911_175201.mp4",
    ...overrides,
  };
}

function metadataWithEvents(
  importantEvents: NonNullable<RecordingMetadata["importantEvents"]>,
): RecordingMetadata {
  return {
    schemaVersion: 2,
    recordingFile: "clip.mp4",
    importantEvents,
  };
}

describe("normalizeManualMarkerName", () => {
  test("collapses surrounding and repeated whitespace", () => {
    expect(normalizeManualMarkerName("  bad   soak  ")).toBe("bad soak");
    expect(normalizeManualMarkerName("hold\tkick\n")).toBe("hold kick");
  });

  test("treats blank and missing names as unnamed", () => {
    expect(normalizeManualMarkerName("   ")).toBeUndefined();
    expect(normalizeManualMarkerName("")).toBeUndefined();
    expect(normalizeManualMarkerName(undefined)).toBeUndefined();
    expect(normalizeManualMarkerName(null)).toBeUndefined();
  });

  test("caps the name at the shared maximum length", () => {
    const longName = normalizeManualMarkerName("x".repeat(MANUAL_MARKER_NAME_MAX_LENGTH + 16));

    expect(longName).toHaveLength(MANUAL_MARKER_NAME_MAX_LENGTH);
  });

  test("counts code points rather than UTF-16 units when capping", () => {
    const emojiName = normalizeManualMarkerName("💀".repeat(MANUAL_MARKER_NAME_MAX_LENGTH + 4));

    expect(Array.from(emojiName ?? "")).toHaveLength(MANUAL_MARKER_NAME_MAX_LENGTH);
  });
});

describe("getManualMarkerLabel", () => {
  test("prefers the user supplied name", () => {
    expect(getManualMarkerLabel({ name: "bad soak" })).toBe("bad soak");
  });

  test("falls back to a generic label for unnamed markers", () => {
    expect(getManualMarkerLabel({})).toBe("Manual marker");
  });
});

describe("convertRecordingNoteToGameEvent", () => {
  test("maps a persisted note onto the playback event list", () => {
    expect(
      convertRecordingNoteToGameEvent({
        id: "note-1",
        timestampSeconds: 42.25,
        text: "  watch the frontal  ",
      }),
    ).toEqual({
      id: "note-1",
      timestamp: 42.25,
      type: "note",
      note: "watch the frontal",
    });
  });

  test("skips notes without usable text or time", () => {
    expect(
      convertRecordingNoteToGameEvent({
        id: "note-2",
        timestampSeconds: 10,
        text: "   ",
      }),
    ).toBeNull();
    expect(
      convertRecordingNoteToGameEvent({
        id: "note-3",
        timestampSeconds: Number.NaN,
        text: "later",
      }),
    ).toBeNull();
  });
});

describe("recordingMetadataHasCombatContent", () => {
  test("returns false for missing metadata", () => {
    expect(recordingMetadataHasCombatContent(null)).toBe(false);
  });

  test("returns false for an empty sidecar", () => {
    expect(recordingMetadataHasCombatContent(metadata())).toBe(false);
  });

  test("returns true when combat fields are present", () => {
    expect(recordingMetadataHasCombatContent(metadata({ zoneName: "Voidscar Arena" }))).toBe(true);
    expect(
      recordingMetadataHasCombatContent(
        metadata({
          importantEvents: [
            {
              timestampSeconds: 12,
              eventType: "UNIT_DIED",
            },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("convertRecordingMetadataToGameEvents", () => {
  test("maps deaths, bloodlust, and encounter bounds onto the seek bar", () => {
    const events = convertRecordingMetadataToGameEvents(
      metadataWithEvents([
        {
          timestampSeconds: 8,
          eventType: "ENCOUNTER_START",
          encounterName: "Queen Ansurek",
        },
        {
          timestampSeconds: 18,
          eventType: "BLOODLUST",
          source: "MageOne-NA",
        },
        {
          timestampSeconds: 30,
          eventType: "UNIT_DIED",
          target: "DeadOne-NA",
          targetKind: "PLAYER",
          amount: 1_250_000,
        },
        {
          timestampSeconds: 96,
          eventType: "ENCOUNTER_END",
          encounterName: "Queen Ansurek",
        },
      ]),
    );

    expect(events.map((event) => event.type)).toEqual([
      "encounterStart",
      "bloodlust",
      "death",
      "encounterEnd",
    ]);
    expect(events[0]?.name).toBe("Queen Ansurek");
    expect(events[2]?.amount).toBe(1_250_000);
    expect(events.every((event) => isVideoSeekBarEvent(event))).toBe(true);
  });

  test("ignores combat-log action spam left in older sidecars", () => {
    const events = convertRecordingMetadataToGameEvents(
      metadataWithEvents([
        { timestampSeconds: 10, eventType: "SPELL_INTERRUPT", source: "RogueOne-NA" },
        { timestampSeconds: 11, eventType: "SPELL_DISPEL", source: "ShamanOne-NA" },
        { timestampSeconds: 12, eventType: "DEFENSIVE", source: "MageOne-NA" },
        { timestampSeconds: 13, eventType: "BOSS_ABILITY", source: "Queen Ansurek" },
        { timestampSeconds: 14, eventType: "CROWD_CONTROL", source: "PaladinOne-NA" },
        { timestampSeconds: 15, eventType: "BIG_HIT", source: "Boss" },
        { timestampSeconds: 16, eventType: "PARTY_KILL", source: "PlayerOne-NA" },
        { timestampSeconds: 17, eventType: "UNIT_DIED", target: "DeadOne-NA" },
      ]),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("death");
  });

  test("carries the marker name from the sidecar", () => {
    const [marker] = convertRecordingMetadataToGameEvents(metadataWithMarker("  bad soak  "));

    expect(marker.type).toBe("manual");
    expect(marker.name).toBe("bad soak");
  });

  test("leaves unnamed markers without a name", () => {
    const [marker] = convertRecordingMetadataToGameEvents(metadataWithMarker());

    expect(marker.name).toBeUndefined();
  });

  test("includes notes without replacing manual markers", () => {
    const events = convertRecordingMetadataToGameEvents({
      schemaVersion: 2,
      recordingFile: "key.mp4",
      importantEvents: [
        {
          timestampSeconds: 8,
          eventType: "MANUAL_MARKER",
        },
      ],
      notes: [
        {
          id: "note-keep",
          timestampSeconds: 12,
          text: "missed kick",
        },
      ],
    });

    expect(events).toEqual([
      {
        id: "MANUAL_MARKER-8-0",
        timestamp: 8,
        type: "manual",
        source: undefined,
        target: undefined,
        targetKind: undefined,
        abilityName: undefined,
        name: undefined,
      },
      {
        id: "note-keep",
        timestamp: 12,
        type: "note",
        note: "missed kick",
      },
    ]);
  });

  test("collapses nearby duplicate bloodlust from the same source", () => {
    const events = convertRecordingMetadataToGameEvents(
      metadataWithEvents([
        { timestampSeconds: 20, eventType: "BLOODLUST", source: "MageOne-NA" },
        { timestampSeconds: 21.2, eventType: "BLOODLUST", source: "MageOne-NA" },
        { timestampSeconds: 30, eventType: "BLOODLUST", source: "ShamanOne-NA" },
      ]),
    );

    expect(events.map((event) => event.source)).toEqual(["MageOne-NA", "ShamanOne-NA"]);
  });
});

describe("convertCombatEvent", () => {
  test("maps live encounter bounds with the encounter name", () => {
    expect(
      convertCombatEvent({
        timestamp: 8,
        eventType: "ENCOUNTER_START",
        name: "Plexus Sentinel",
      }),
    ).toMatchObject({
      type: "encounterStart",
      name: "Plexus Sentinel",
    });
  });

  test("keeps the name emitted with a live marker", () => {
    const marker = convertCombatEvent({
      timestamp: 12.5,
      eventType: "MANUAL_MARKER",
      name: "hold  kick",
    });

    expect(marker.type).toBe("manual");
    expect(marker.name).toBe("hold kick");
  });

  test("gives markers on the same timestamp distinct ids", () => {
    const first = convertCombatEvent({ timestamp: 12.5, eventType: "MANUAL_MARKER" });
    const second = convertCombatEvent({ timestamp: 12.5, eventType: "MANUAL_MARKER" });

    expect(first.id).not.toBe(second.id);
  });
});

describe("playback timeline visibility", () => {
  test("hides NPC deaths when that filter is on", () => {
    const npcDeath: GameEvent = {
      id: "death-npc",
      timestamp: 13,
      type: "death",
      target: "Enemy5",
      targetKind: "NPC",
    };
    const playerDeath: GameEvent = {
      id: "death-player",
      timestamp: 14,
      type: "death",
      target: "Tank-NA",
      targetKind: "PLAYER",
    };

    expect(shouldShowGameEvent(npcDeath, true, ALL_EVENT_TYPES_VISIBLE)).toBe(false);
    expect(shouldShowGameEvent(playerDeath, true, ALL_EVENT_TYPES_VISIBLE)).toBe(true);
  });

  test("keeps encounters and bloodlust visible when NPC events are hidden", () => {
    expect(
      shouldShowGameEvent(
        { id: "lust", timestamp: 8, type: "bloodlust", source: "MageOne-NA" },
        true,
        ALL_EVENT_TYPES_VISIBLE,
      ),
    ).toBe(true);
    expect(
      shouldShowGameEvent(
        { id: "pull", timestamp: 1, type: "encounterStart", name: "Queen Ansurek" },
        true,
        ALL_EVENT_TYPES_VISIBLE,
      ),
    ).toBe(true);
  });

  test("hides deaths when the type filter is off", () => {
    expect(
      shouldShowGameEvent(
        { id: "death-hidden", timestamp: 4, type: "death", targetKind: "PLAYER" },
        false,
        { ...ALL_EVENT_TYPES_VISIBLE, death: false },
      ),
    ).toBe(false);
  });
});

describe("getGameEventDescription", () => {
  test("names the dead player", () => {
    expect(
      getGameEventDescription({
        id: "death-1",
        timestamp: 18,
        type: "death",
        target: "TankOne-NA",
      }),
    ).toBe("TankOne-NA died");
  });

  test("names the encounter on start and end", () => {
    expect(
      getGameEventDescription({
        id: "start-1",
        timestamp: 1,
        type: "encounterStart",
        name: "Queen Ansurek",
      }),
    ).toBe("Queen Ansurek started");
    expect(
      getGameEventDescription({
        id: "end-1",
        timestamp: 96,
        type: "encounterEnd",
        name: "Queen Ansurek",
      }),
    ).toBe("Queen Ansurek ended");
  });
});

describe("shouldPromptManualMarkerName", () => {
  test("prompts while the window is visible and focused", () => {
    withDocument({ visibilityState: "visible", hasFocus: () => true }, () => {
      expect(shouldPromptManualMarkerName()).toBe(true);
    });
  });

  test("stays quiet while the hotkey is used from the game", () => {
    withDocument({ visibilityState: "visible", hasFocus: () => false }, () => {
      expect(shouldPromptManualMarkerName()).toBe(false);
    });

    withDocument({ visibilityState: "hidden", hasFocus: () => true }, () => {
      expect(shouldPromptManualMarkerName()).toBe(false);
    });
  });

  test("stays quiet without a document", () => {
    withDocument(null, () => {
      expect(shouldPromptManualMarkerName()).toBe(false);
    });
  });
});

describe("manualMarkerOccurrenceIndex", () => {
  const first: GameEvent = { id: "manual-8-0", timestamp: 8, type: "manual", name: "keep" };
  const second: GameEvent = { id: "manual-8-1", timestamp: 8, type: "manual", name: "rename me" };
  const later: GameEvent = { id: "manual-20-2", timestamp: 20, type: "manual" };

  test("counts only manuals inside the same timestamp window", () => {
    const events = [first, second, later];
    expect(manualMarkerOccurrenceIndex(events, first)).toBe(0);
    expect(manualMarkerOccurrenceIndex(events, second)).toBe(1);
    expect(manualMarkerOccurrenceIndex(events, later)).toBe(0);
  });
});
