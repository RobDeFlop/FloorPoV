import { invoke } from "@tauri-apps/api/core";
import {
  Clapperboard,
  FileSearch,
  LoaderCircle,
  Shield,
  Sword,
  Trophy,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { GameEvents } from "../events/GameEvents";
import { GameModeRecordingsBrowser } from "./GameModeRecordingsBrowser";
import { VideoPlayer } from "../playback/VideoPlayer";
import { TabControls, type TabControlItem } from "../ui/TabControls";
import { RecordingMetadata } from "../../types/events";
import { RecordingInfo } from "../../types/recording";
import { formatBytes, formatDate, formatTime } from "../../utils/format";

type GameMode = "mythic-plus" | "raid" | "pvp";
type AnalysisTab = "video-analysis" | "log-analysis";

const ANALYSIS_TAB_ITEMS: TabControlItem<AnalysisTab>[] = [
  {
    value: "video-analysis",
    label: "Video Analysis",
    icon: Clapperboard,
  },
  {
    value: "log-analysis",
    label: "Log Analysis",
    icon: FileSearch,
  },
];

const ANALYSIS_TABS_ID_BASE = "recording-analysis";

interface GameModePageProps {
  gameMode: GameMode;
}

interface GameModeConfigItem {
  overviewTitle: string;
  analysisTitle: string;
  description: string;
  icon: typeof Sword;
}

const gameModeConfig: Record<GameMode, GameModeConfigItem> = {
  "mythic-plus": {
    overviewTitle: "Mythic+ Sessions",
    analysisTitle: "Mythic+ Analysis",
    description: "Browse sessions and open one to inspect pulls, events, and pace.",
    icon: Sword,
  },
  raid: {
    overviewTitle: "Raid Sessions",
    analysisTitle: "Raid Analysis",
    description: "Browse sessions and open one for timeline and event review.",
    icon: Shield,
  },
  pvp: {
    overviewTitle: "PvP Sessions",
    analysisTitle: "PvP Analysis",
    description: "Browse sessions and drill into footage or combat metadata.",
    icon: Trophy,
  },
};

function getEventTypeLabel(eventType: string): string {
  switch (eventType) {
    case "PARTY_KILL":
      return "Kill";
    case "UNIT_DIED":
      return "Death";
    case "SPELL_INTERRUPT":
      return "Interrupt";
    case "SPELL_DISPEL":
      return "Dispel";
    case "MANUAL_MARKER":
      return "Manual Marker";
    case "ENCOUNTER_START":
      return "Encounter Start";
    case "ENCOUNTER_END":
      return "Encounter End";
    default:
      return eventType;
  }
}

function formatEncounterCategory(category?: string): string {
  if (!category) {
    return "Unknown";
  }

  if (category === "mythicPlus" || category === "mythic-plus") {
    return "Mythic+";
  }

  if (category === "pvp") {
    return "PvP";
  }

  return category.charAt(0).toUpperCase() + category.slice(1);
}

export function GameModePage({ gameMode }: GameModePageProps) {
  const config = gameModeConfig[gameMode];
  const Icon = config.icon;
  const [selectedRecording, setSelectedRecording] = useState<RecordingInfo | null>(null);
  const [activeTab, setActiveTab] = useState<AnalysisTab>("video-analysis");
  const [recordingMetadata, setRecordingMetadata] = useState<RecordingMetadata | null>(null);
  const [isMetadataLoading, setIsMetadataLoading] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const metadataRequestPathRef = useRef<string | null>(null);

  const loadRecordingMetadata = useCallback(async (recordingPath: string) => {
    metadataRequestPathRef.current = recordingPath;
    setIsMetadataLoading(true);
    setMetadataError(null);

    try {
      const metadata = await invoke<RecordingMetadata | null>("get_recording_metadata", {
        filePath: recordingPath,
      });

      if (metadataRequestPathRef.current !== recordingPath) {
        return;
      }

      setRecordingMetadata(metadata);
    } catch (error) {
      if (metadataRequestPathRef.current !== recordingPath) {
        return;
      }

      console.error("Failed to load recording details:", error);
      setRecordingMetadata(null);
      setMetadataError("Could not load recording details.");
    } finally {
      if (metadataRequestPathRef.current === recordingPath) {
        setIsMetadataLoading(false);
      }
    }
  }, []);

  const handleRecordingActivate = useCallback(
    (recording: RecordingInfo) => {
      setSelectedRecording(recording);
      setActiveTab("video-analysis");
      void loadRecordingMetadata(recording.file_path);
    },
    [loadRecordingMetadata],
  );

  const sortedEventCounts = useMemo(() => {
    if (!recordingMetadata?.importantEventCounts) {
      return [] as [string, number][];
    }

    return Object.entries(recordingMetadata.importantEventCounts).sort((left, right) => {
      return right[1] - left[1];
    });
  }, [recordingMetadata?.importantEventCounts]);

  const importantEvents = recordingMetadata?.importantEvents ?? [];
  const encounters = recordingMetadata?.encounters ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!selectedRecording ? (
        <>
          <header className="border-b border-white/10 bg-(--surface-1) px-4 py-4 md:px-6">
            <div className="flex items-center gap-3">
              <Icon className="h-5 w-5 text-neutral-300" />
              <div>
                <h1 className="inline-flex items-center gap-2 text-lg font-semibold text-neutral-100">
                  {config.overviewTitle}
                </h1>
                <p className="text-xs text-neutral-400">{config.description}</p>
              </div>
            </div>
          </header>
          <GameModeRecordingsBrowser
            gameMode={gameMode}
            onRecordingActivate={handleRecordingActivate}
          />
        </>
      ) : (
        <>
          <header className="border-b border-white/10 bg-(--surface-1) px-4 py-4 md:px-6">
            <div className="flex items-center gap-3">
              <Icon className="h-5 w-5 text-neutral-300" />
              <div>
                <h1 className="inline-flex items-center gap-2 text-lg font-semibold text-neutral-100">
                  {config.analysisTitle}
                </h1>
                <p className="max-w-[60ch] truncate text-xs text-neutral-400">
                  {selectedRecording.filename}
                </p>
              </div>
            </div>
          </header>
          <TabControls
            value={activeTab}
            onChange={setActiveTab}
            items={ANALYSIS_TAB_ITEMS}
            ariaLabel="Recording analysis tabs"
            idBase={ANALYSIS_TABS_ID_BASE}
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            {activeTab === "video-analysis" ? (
              <div
                id={`${ANALYSIS_TABS_ID_BASE}-video-analysis-panel`}
                role="tabpanel"
                aria-labelledby={`${ANALYSIS_TABS_ID_BASE}-video-analysis-tab`}
                className="flex h-full min-h-0 flex-col"
              >
                <main className="min-h-0 flex-1 overflow-hidden">
                  <VideoPlayer />
                </main>
                <GameEvents />
              </div>
            ) : (
              <div
                id={`${ANALYSIS_TABS_ID_BASE}-log-analysis-panel`}
                role="tabpanel"
                aria-labelledby={`${ANALYSIS_TABS_ID_BASE}-log-analysis-tab`}
                className="h-full overflow-y-auto px-4 py-3"
              >
                <section className="rounded-sm border border-white/10 bg-(--surface-1)/80 p-3">
                  <h2 className="text-sm font-semibold text-neutral-100">Recording Summary</h2>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-neutral-300">
                    <div className="rounded-sm border border-white/10 bg-black/20 px-2 py-1.5">
                      <div className="text-[10px] uppercase tracking-[0.09em] text-neutral-500">File</div>
                      <div className="mt-1 truncate text-neutral-100" title={selectedRecording.filename}>
                        {selectedRecording.filename}
                      </div>
                    </div>
                    <div className="rounded-sm border border-white/10 bg-black/20 px-2 py-1.5">
                      <div className="text-[10px] uppercase tracking-[0.09em] text-neutral-500">Created</div>
                      <div className="mt-1 text-neutral-100">{formatDate(selectedRecording.created_at)}</div>
                    </div>
                    <div className="rounded-sm border border-white/10 bg-black/20 px-2 py-1.5">
                      <div className="text-[10px] uppercase tracking-[0.09em] text-neutral-500">Size</div>
                      <div className="mt-1 text-neutral-100">{formatBytes(selectedRecording.size_bytes)}</div>
                    </div>
                    <div className="rounded-sm border border-white/10 bg-black/20 px-2 py-1.5">
                      <div className="text-[10px] uppercase tracking-[0.09em] text-neutral-500">Category</div>
                      <div className="mt-1 text-neutral-100">
                        {formatEncounterCategory(recordingMetadata?.encounterCategory || selectedRecording.encounter_category)}
                      </div>
                    </div>
                    {gameMode === "mythic-plus" && (
                      <div className="rounded-sm border border-white/10 bg-black/20 px-2 py-1.5">
                        <div className="text-[10px] uppercase tracking-[0.09em] text-neutral-500">Key</div>
                        <div className="mt-1 text-neutral-100">
                          {typeof (recordingMetadata?.keyLevel ?? selectedRecording.key_level) === "number"
                            ? `+${recordingMetadata?.keyLevel ?? selectedRecording.key_level}`
                            : "Unknown"}
                        </div>
                      </div>
                    )}
                  </div>
                </section>

                {isMetadataLoading ? (
                  <div className="mt-3 inline-flex items-center gap-2 rounded-sm border border-white/10 bg-(--surface-1)/70 px-3 py-2 text-xs text-neutral-300">
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    Loading log metadata...
                  </div>
                ) : metadataError ? (
                  <div className="mt-3 rounded-sm border border-rose-300/30 bg-rose-500/12 px-3 py-2 text-xs text-rose-100">
                    {metadataError}
                  </div>
                ) : !recordingMetadata ? (
                  <div className="mt-3 rounded-sm border border-white/10 bg-(--surface-1)/70 px-3 py-2 text-xs text-neutral-400">
                    No log metadata is available for this recording yet.
                  </div>
                ) : (
                  <>
                    <section className="mt-3 rounded-sm border border-white/10 bg-(--surface-1)/80 p-3">
                      <h3 className="text-xs font-semibold uppercase tracking-[0.1em] text-neutral-300">
                        Event Counts
                      </h3>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {sortedEventCounts.length > 0 ? (
                          sortedEventCounts.map(([eventType, count]) => (
                            <span
                              key={eventType}
                              className="inline-flex items-center gap-1 rounded-sm border border-white/15 bg-black/25 px-2 py-1 text-xs text-neutral-200"
                            >
                              <span>{getEventTypeLabel(eventType)}</span>
                              <span className="text-neutral-400">{count}</span>
                            </span>
                          ))
                        ) : (
                          <p className="text-xs text-neutral-500">No important events recorded.</p>
                        )}
                      </div>
                      {(recordingMetadata.importantEventsDroppedCount ?? 0) > 0 && (
                        <p className="mt-2 text-xs text-neutral-500">
                          {recordingMetadata.importantEventsDroppedCount} high-volume events were dropped during buffering.
                        </p>
                      )}
                    </section>

                    <section className="mt-3 rounded-sm border border-white/10 bg-(--surface-1)/80 p-3">
                      <h3 className="text-xs font-semibold uppercase tracking-[0.1em] text-neutral-300">
                        Encounter Segments
                      </h3>
                      {encounters.length === 0 ? (
                        <p className="mt-2 text-xs text-neutral-500">No encounter segments in metadata.</p>
                      ) : (
                        <ul className="mt-2 space-y-1.5">
                          {encounters.map((encounter, index) => (
                            <li
                              key={`${encounter.name}-${encounter.category}-${index}`}
                              className="rounded-sm border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-neutral-200"
                            >
                              <div className="font-medium text-neutral-100">{encounter.name}</div>
                              <div className="mt-0.5 text-neutral-400">
                                {formatEncounterCategory(encounter.category)}
                                {typeof encounter.startedAtSeconds === "number"
                                  ? ` · Start ${formatTime(encounter.startedAtSeconds)}`
                                  : ""}
                                {typeof encounter.endedAtSeconds === "number"
                                  ? ` · End ${formatTime(encounter.endedAtSeconds)}`
                                  : ""}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    <section className="mt-3 rounded-sm border border-white/10 bg-(--surface-1)/80 p-3">
                      <h3 className="text-xs font-semibold uppercase tracking-[0.1em] text-neutral-300">
                        Important Events
                      </h3>
                      {importantEvents.length === 0 ? (
                        <p className="mt-2 text-xs text-neutral-500">No important events in metadata.</p>
                      ) : (
                        <div className="mt-2 overflow-hidden rounded-sm border border-white/10 bg-black/20">
                          <table className="min-w-full text-left text-xs text-neutral-300">
                            <thead className="bg-(--surface-2) text-neutral-400">
                              <tr>
                                <th className="px-2 py-1.5 font-medium">Time</th>
                                <th className="px-2 py-1.5 font-medium">Event</th>
                                <th className="px-2 py-1.5 font-medium">Source</th>
                                <th className="px-2 py-1.5 font-medium">Target</th>
                              </tr>
                            </thead>
                            <tbody>
                              {importantEvents.map((event, index) => (
                                <tr
                                  key={`${event.eventType}-${event.timestampSeconds}-${index}`}
                                  className="border-t border-white/10"
                                >
                                  <td className="px-2 py-1.5 text-neutral-200">
                                    {formatTime(event.timestampSeconds)}
                                  </td>
                                  <td className="px-2 py-1.5 text-amber-200">
                                    {getEventTypeLabel(event.eventType)}
                                  </td>
                                  <td className="px-2 py-1.5 text-neutral-300">{event.source || "-"}</td>
                                  <td className="px-2 py-1.5 text-neutral-300">{event.target || "-"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </section>
                  </>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
