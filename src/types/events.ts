export interface GameEvent {
  id: string;
  timestamp: number;
  type: "kill" | "death" | "manual";
  source?: string;
  target?: string;
}

export interface RecordingImportantEventMetadata {
  timestampSeconds: number;
  logTimestamp?: string;
  eventType: string;
  source?: string;
  target?: string;
  zoneName?: string;
  encounterName?: string;
  encounterCategory?: string;
  keyLevel?: number;
}

export interface RecordingEncounterMetadata {
  name: string;
  category: string;
  startedAtSeconds?: number;
  endedAtSeconds?: number;
}

export interface RecordingMetadata {
  schemaVersion: number;
  recordingFile: string;
  zoneName?: string;
  encounterName?: string;
  encounterCategory?: string;
  keyLevel?: number;
  encounters?: RecordingEncounterMetadata[];
  importantEvents?: RecordingImportantEventMetadata[];
  importantEventCounts?: Record<string, number>;
  importantEventsDroppedCount?: number;
}

export interface CombatEvent {
  timestamp: number;
  eventType: string;
  source?: string;
  target?: string;
}

export interface CombatTriggerEvent {
  triggerType: "start" | "end";
  mode: "mythicPlus" | "raid" | "pvp";
  eventType: string;
  encounterName?: string;
  keyLevel?: number;
}

export interface CombatWatchStatusEvent {
  level: "info" | "warn" | "error";
  message: string;
  watchedLogPath?: string;
}

export interface ParsedCombatEvent {
  lineNumber: number;
  logTimestamp: string;
  eventType: string;
  source?: string;
  target?: string;
  targetKind?: string;
  zoneName?: string;
  encounterName?: string;
  encounterCategory?: "mythicPlus" | "raid" | "pvp" | "unknown";
  keyLevel?: number;
}

export interface ParseCombatLogDebugResult {
  filePath: string;
  fileSizeBytes: number;
  totalLines: number;
  parsedEvents: ParsedCombatEvent[];
  eventCounts: Record<string, number>;
  truncated: boolean;
}

const SUPPORTED_PLAYBACK_EVENT_TYPES = new Set(["PARTY_KILL", "UNIT_DIED", "MANUAL_MARKER"]);

function mapEventTypeToGameEventType(eventType: string): GameEvent["type"] {
  if (eventType === "PARTY_KILL") {
    return "kill";
  }

  if (eventType === "UNIT_DIED") {
    return "death";
  }

  return "manual";
}

export function convertRecordingMetadataToGameEvents(
  metadata: RecordingMetadata | null,
): GameEvent[] {
  if (!metadata?.importantEvents?.length) {
    return [];
  }

  return metadata.importantEvents
    .flatMap((importantEvent, index) => {
      if (!SUPPORTED_PLAYBACK_EVENT_TYPES.has(importantEvent.eventType)) {
        return [];
      }

      if (!Number.isFinite(importantEvent.timestampSeconds) || importantEvent.timestampSeconds < 0) {
        return [];
      }

      return [{
        id: `${importantEvent.eventType}-${importantEvent.timestampSeconds}-${index}`,
        timestamp: importantEvent.timestampSeconds,
        type: mapEventTypeToGameEventType(importantEvent.eventType),
        source: importantEvent.source,
        target: importantEvent.target,
      }];
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

export function convertCombatEvent(combatEvent: CombatEvent): GameEvent {
  const type = mapEventTypeToGameEventType(combatEvent.eventType);

  return {
    id: `${combatEvent.timestamp}-${combatEvent.eventType}`,
    timestamp: combatEvent.timestamp,
    type,
    source: combatEvent.source,
    target: combatEvent.target,
  };
}
