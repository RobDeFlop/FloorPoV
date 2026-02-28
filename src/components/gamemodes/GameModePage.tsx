import { invoke } from "@tauri-apps/api/core";
import {
  Clapperboard,
  ChevronDown,
  FileSearch,
  FileText,
  LoaderCircle,
  Shield,
  Sword,
  Trophy,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useMarker } from "../../contexts/MarkerContext";
import { RecordingMetadata } from "../../types/events";
import { RecordingInfo } from "../../types/recording";
import { type GameMode } from "../../types/ui";
import { formatBytes, formatDate, formatEncounterCategory, formatTime, getEventTypeLabel } from "../../utils/format";
import { getRecordingDisplayTitle } from "../../utils/recording-title";
import { GameEvents } from "../events/GameEvents";
import { VideoPlayer } from "../playback/VideoPlayer";
import { TabControls, type TabControlItem } from "../ui/TabControls";
import { GameModeRecordingsBrowser } from "./GameModeRecordingsBrowser";
import { PlayerOverviewTable } from "./PlayerOverviewTable";
import { PlayerStatChart } from "./PlayerStatChart";

type AnalysisTab = "video-analysis" | "log-analysis" | "metadata";

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
  {
    value: "metadata",
    label: "Metadata",
    icon: FileText,
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

export function GameModePage({ gameMode }: GameModePageProps) {
  const config = gameModeConfig[gameMode];
  const Icon = config.icon;
  const [selectedRecording, setSelectedRecording] = useState<RecordingInfo | null>(null);
  const [activeTab, setActiveTab] = useState<AnalysisTab>("video-analysis");
  const [recordingMetadata, setRecordingMetadata] = useState<RecordingMetadata | null>(null);
  const [isMetadataLoading, setIsMetadataLoading] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    npc: true,
    pet: true,
    guardian: true,
    unknown: true,
  });
  const [isEventsOpen, setIsEventsOpen] = useState(false);
  const metadataRequestPathRef = useRef<string | null>(null);
  const { setEncounters } = useMarker();

  const filterEvent = useCallback(
    (targetKind: string | undefined, target: string | undefined) => {
      if (!targetKind) {
        targetKind = target?.includes("-") ? "PLAYER" : undefined;
      }
      if (targetKind === "NPC" && !filters.npc) return false;
      if (targetKind === "PET" && !filters.pet) return false;
      if (targetKind === "GUARDIAN" && !filters.guardian) return false;
      if (targetKind === "UNKNOWN" && !filters.unknown) return false;
      return true;
    },
    [filters],
  );

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

  const importantEvents = useMemo(() => {
    const events = recordingMetadata?.importantEvents ?? [];
    return events.filter((event) => filterEvent(event.targetKind, event.target));
  }, [recordingMetadata?.importantEvents, filterEvent]);

  const playerStats = useMemo(() => {
    const events = recordingMetadata?.importantEvents ?? [];

    const toPlayerLabel = (name: string): string => {
      const trimmedName = name.trim();
      if (!trimmedName) {
        return "Unknown";
      }

      // Strip the realm suffix from "PlayerName-ServerName" WoW name format.
      const [baseName] = trimmedName.split("-");
      const normalizedBaseName = (baseName ?? "").trim();
      if (normalizedBaseName) {
        return normalizedBaseName;
      }

      return "Unknown";
    };

    const kickCounts: Record<string, number> = {};
    const dispelCounts: Record<string, number> = {};
    const deathCounts: Record<string, number> = {};

    for (const event of events) {
      if (event.eventType === "SPELL_INTERRUPT" && event.source) {
        const key = toPlayerLabel(event.source);
        kickCounts[key] = (kickCounts[key] ?? 0) + 1;
      } else if (event.eventType === "SPELL_DISPEL" && event.source) {
        const key = toPlayerLabel(event.source);
        dispelCounts[key] = (dispelCounts[key] ?? 0) + 1;
      } else if (event.eventType === "UNIT_DIED" && event.target && event.targetKind === "PLAYER") {
        const key = toPlayerLabel(event.target);
        deathCounts[key] = (deathCounts[key] ?? 0) + 1;
      }
    }

    const toSorted = (counts: Record<string, number>) =>
      Object.entries(counts)
        .map(([player, count]) => ({ player, count }))
        .sort((a, b) => {
          if (b.count !== a.count) {
            return b.count - a.count;
          }

          return a.player.localeCompare(b.player);
        });

    return {
      kicks: toSorted(kickCounts),
      dispels: toSorted(dispelCounts),
      deaths: toSorted(deathCounts),
    };
  }, [recordingMetadata?.importantEvents]);

  const encounters = recordingMetadata?.encounters ?? [];

  useEffect(() => {
    if (gameMode === "mythic-plus" && recordingMetadata?.encounters) {
      setEncounters(recordingMetadata.encounters);
    } else {
      setEncounters([]);
    }
  }, [recordingMetadata?.encounters, gameMode, setEncounters]);

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
                  {getRecordingDisplayTitle(selectedRecording, gameMode)}
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
            ) : activeTab === "metadata" ? (
              <div
                id={`${ANALYSIS_TABS_ID_BASE}-metadata-panel`}
                role="tabpanel"
                aria-labelledby={`${ANALYSIS_TABS_ID_BASE}-metadata-tab`}
                className="h-full overflow-y-auto px-4 py-3"
              >
                <section className="rounded-sm border border-white/10 bg-(--surface-1)/80 p-3">
                  <h2 className="text-sm font-semibold text-neutral-100">Recording Summary</h2>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-neutral-300">
                    <div className="rounded-sm border border-white/10 bg-black/20 px-2 py-1.5">
                      <div className="text-[10px] uppercase tracking-[0.09em] text-neutral-500">File</div>
                      <div className="mt-1 truncate text-neutral-100" title={selectedRecording.file_path}>
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
                        {formatEncounterCategory(
                          recordingMetadata?.encounterCategory ||
                            (gameMode === "mythic-plus" ? "mythicPlus" : gameMode),
                        )}
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
              </div>
            ) : (
              <div
                id={`${ANALYSIS_TABS_ID_BASE}-log-analysis-panel`}
                role="tabpanel"
                aria-labelledby={`${ANALYSIS_TABS_ID_BASE}-log-analysis-tab`}
                className="h-full overflow-y-auto px-4 py-3"
              >
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
                        Player Overview
                      </h3>
                      <PlayerOverviewTable players={recordingMetadata.players ?? []} />
                    </section>

                    {(playerStats.kicks.length > 0 ||
                      playerStats.dispels.length > 0 ||
                      playerStats.deaths.length > 0) && (
                      <section className="mt-3 rounded-sm border border-white/10 bg-(--surface-1)/80 p-3">
                        <h3 className="text-xs font-semibold uppercase tracking-[0.1em] text-neutral-300">
                          Player Stats
                        </h3>
                        <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-3">
                          <PlayerStatChart
                            title="Kicks"
                            data={playerStats.kicks}
                            color="#34d399"
                          />
                          <PlayerStatChart
                            title="Dispels"
                            data={playerStats.dispels}
                            color="#60a5fa"
                          />
                          <PlayerStatChart
                            title="Deaths"
                            data={playerStats.deaths}
                            color="#f87171"
                          />
                        </div>
                      </section>
                    )}

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

                    <section className="mt-3 rounded-sm border border-white/10 bg-(--surface-1)/80">
                      <button
                        type="button"
                        onClick={() => setIsEventsOpen((o) => !o)}
                        className="flex w-full items-center gap-2 px-4 py-3 text-left"
                      >
                        <ChevronDown
                          className={`h-3.5 w-3.5 shrink-0 text-neutral-400 transition-transform duration-200 ${isEventsOpen ? "rotate-180" : ""}`}
                        />
                        <h3 className="text-sm font-semibold uppercase tracking-caps text-neutral-200">
                          Important Events
                        </h3>
                        <div className="ml-1 flex items-center gap-2">
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-[10px] uppercase tracking-caps text-neutral-500">Showing:</span>
                            <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-300 border border-emerald-500/25">
                              {importantEvents.length}
                            </span>
                          </div>
                          <span className="text-neutral-600">|</span>
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-[10px] uppercase tracking-caps text-neutral-500">Total:</span>
                            <span className="rounded bg-white/10 px-2 py-0.5 text-xs font-medium text-neutral-300 border border-white/15">
                              {recordingMetadata?.importantEvents?.length ?? 0}
                            </span>
                          </div>
                        </div>
                      </button>

                      <AnimatePresence initial={false}>
                        {isEventsOpen && (
                          <motion.div
                            key="events-body"
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2, ease: "easeInOut" }}
                            style={{ overflow: "hidden" }}
                          >
                            <div className="flex flex-col gap-3 border-t border-white/10 px-4 pb-4 pt-3">
                              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                                <span className="text-xs font-medium uppercase tracking-caps text-neutral-400">Show:</span>
                                <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300 hover:text-neutral-100 transition-colors">
                                  <input
                                    type="checkbox"
                                    checked={filters.npc}
                                    onChange={(e) => setFilters((f) => ({ ...f, npc: e.target.checked }))}
                                    className="h-4 w-4 rounded border-neutral-600 bg-neutral-800 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-0"
                                  />
                                  NPC
                                </label>
                                <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300 hover:text-neutral-100 transition-colors">
                                  <input
                                    type="checkbox"
                                    checked={filters.pet}
                                    onChange={(e) => setFilters((f) => ({ ...f, pet: e.target.checked }))}
                                    className="h-4 w-4 rounded border-neutral-600 bg-neutral-800 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-0"
                                  />
                                  Pet
                                </label>
                                <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300 hover:text-neutral-100 transition-colors">
                                  <input
                                    type="checkbox"
                                    checked={filters.guardian}
                                    onChange={(e) => setFilters((f) => ({ ...f, guardian: e.target.checked }))}
                                    className="h-4 w-4 rounded border-neutral-600 bg-neutral-800 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-0"
                                  />
                                  Guardian
                                </label>
                                <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300 hover:text-neutral-100 transition-colors">
                                  <input
                                    type="checkbox"
                                    checked={filters.unknown}
                                    onChange={(e) => setFilters((f) => ({ ...f, unknown: e.target.checked }))}
                                    className="h-4 w-4 rounded border-neutral-600 bg-neutral-800 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-0"
                                  />
                                  Unknown
                                </label>
                              </div>
                              {importantEvents.length === 0 ? (
                                <p className="text-xs text-neutral-500">No important events in metadata.</p>
                              ) : (
                                <div className="overflow-hidden rounded-sm border border-white/10 bg-black/20">
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
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
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
