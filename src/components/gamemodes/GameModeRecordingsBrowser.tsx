import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ChevronDown, Clock3, Film, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRecording } from "../../contexts/RecordingContext";
import { useSettings } from "../../contexts/SettingsContext";
import { useVideo } from "../../contexts/VideoContext";
import { useRecordingsList } from "../../hooks/useRecordingsList";
import { RecordingInfo } from "../../types/recording";
import { type GameMode } from "../../types/ui";
import { formatBytes, formatDate } from "../../utils/format";
import { getRecordingDisplayTitle, isRecordingInGameMode } from "../../utils/recording-title";
import { DeleteConfirmDialog } from "../ui/DeleteConfirmDialog";
import { Input } from "../ui/Input";
import { SettingsSelect, type SettingsSelectOption } from "../settings/SettingsSelect";

type DateRangeFilter = "all" | "24h" | "7d" | "30d";

interface GameModeRecordingsBrowserProps {
  gameMode: GameMode;
  onRecordingActivate: (recording: RecordingInfo) => void;
}

interface ModeOverviewCopy {
  zoneLabel: string;
  encounterLabel: string;
}

const modeOverviewCopy: Record<GameMode, ModeOverviewCopy> = {
  "mythic-plus": {
    zoneLabel: "Dungeon",
    encounterLabel: "Encounter",
  },
  raid: {
    zoneLabel: "Raid",
    encounterLabel: "Boss",
  },
  pvp: {
    zoneLabel: "Map",
    encounterLabel: "Match",
  },
};


function getDateThresholdUnixSeconds(dateRange: DateRangeFilter): number | null {
  const currentUnixSeconds = Math.floor(Date.now() / 1000);

  if (dateRange === "24h") {
    return currentUnixSeconds - 60 * 60 * 24;
  }

  if (dateRange === "7d") {
    return currentUnixSeconds - 60 * 60 * 24 * 7;
  }

  if (dateRange === "30d") {
    return currentUnixSeconds - 60 * 60 * 24 * 30;
  }

  return null;
}

function toSearchText(recording: RecordingInfo): string {
  const keyLevelText =
    typeof recording.key_level === "number" ? `+${recording.key_level}` : "";

  return [
    recording.filename,
    recording.zone_name,
    recording.encounter_name,
    recording.encounter_category,
    keyLevelText,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function GameModeRecordingsBrowser({
  gameMode,
  onRecordingActivate,
}: GameModeRecordingsBrowserProps) {
  const { settings } = useSettings();
  const { isRecording, loadPlaybackMetadata } = useRecording();
  const { loadVideo, isVideoLoading } = useVideo();
  const { recordings, isLoading, error: listError, loadRecordings, setRecordings } = useRecordingsList();
  const [actionError, setActionError] = useState<string | null>(null);
  const displayError = actionError ?? listError;
  const [activatingRecordingPath, setActivatingRecordingPath] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedZone, setSelectedZone] = useState<string>("all");
  const [selectedEncounter, setSelectedEncounter] = useState<string>("all");
  const [selectedDateRange, setSelectedDateRange] = useState<DateRangeFilter>("all");
  const [isFiltersOpen, setIsFiltersOpen] = useState(true);
  const [pendingDeleteRecording, setPendingDeleteRecording] = useState<RecordingInfo | null>(null);
  const [isDeletingRecording, setIsDeletingRecording] = useState(false);
  const recordingsListRef = useRef<HTMLUListElement>(null);
  const reduceMotion = useReducedMotion();

  const copy = modeOverviewCopy[gameMode];
  const isActionLocked = isRecording || isVideoLoading || Boolean(activatingRecordingPath);

  const sortedRecordings = useMemo(() => {
    return [...recordings].sort((left, right) => right.created_at - left.created_at);
  }, [recordings]);

  const modeRecordings = useMemo(() => {
    return sortedRecordings.filter((recording) => isRecordingInGameMode(recording, gameMode));
  }, [gameMode, sortedRecordings]);

  const zoneOptions = useMemo(() => {
    return Array.from(
        new Set(
          modeRecordings
            .map((recording) => recording.zone_name?.trim())
            .filter((zoneName): zoneName is string => Boolean(zoneName)),
        ),
      ).sort((left, right) => left.localeCompare(right));
  }, [modeRecordings]);

  const encounterOptions = useMemo(() => {
    return Array.from(
        new Set(
          modeRecordings
            .map((recording) => recording.encounter_name?.trim())
            .filter((encounterName): encounterName is string => Boolean(encounterName)),
        ),
      ).sort((left, right) => left.localeCompare(right));
  }, [modeRecordings]);

  const filteredRecordings = useMemo(() => {
    const threshold = getDateThresholdUnixSeconds(selectedDateRange);
    const normalizedQuery = searchQuery.trim().toLowerCase();

    return modeRecordings.filter((recording) => {
      if (selectedZone !== "all" && recording.zone_name !== selectedZone) {
        return false;
      }

      if (selectedEncounter !== "all" && recording.encounter_name !== selectedEncounter) {
        return false;
      }

      if (threshold !== null && recording.created_at < threshold) {
        return false;
      }

      if (normalizedQuery.length > 0 && !toSearchText(recording).includes(normalizedQuery)) {
        return false;
      }

      return true;
    });
  }, [modeRecordings, searchQuery, selectedDateRange, selectedEncounter, selectedZone]);

  useEffect(() => {
    setSearchQuery("");
    setSelectedZone("all");
    setSelectedEncounter("all");
    setSelectedDateRange("all");
  }, [gameMode]);

  const handleActivateRecording = useCallback(
    (recording: RecordingInfo) => {
      if (isActionLocked) {
        return;
      }

      setActivatingRecordingPath(recording.file_path);
      setActionError(null);
      void loadPlaybackMetadata(recording.file_path);
      loadVideo(convertFileSrc(recording.file_path));
      onRecordingActivate(recording);
      setActivatingRecordingPath(null);
    },
    [isActionLocked, loadPlaybackMetadata, loadVideo, onRecordingActivate],
  );
  const handleDeleteRecording = useCallback(
    async (recording: RecordingInfo) => {
      if (isActionLocked || isDeletingRecording) {
        return;
      }

      setPendingDeleteRecording(recording);
    },
    [isActionLocked, isDeletingRecording],
  );

  const confirmDeleteRecording = useCallback(async () => {
    const recordingToDelete = pendingDeleteRecording;
    if (!recordingToDelete || isDeletingRecording) {
      return;
    }

    setIsDeletingRecording(true);
    setActionError(null);

    try {
      await invoke("delete_recording", { filePath: recordingToDelete.file_path });
      setRecordings((prev) => prev.filter((r) => r.file_path !== recordingToDelete.file_path));
      setPendingDeleteRecording(null);
    } catch (err) {
      console.error("Failed to delete recording:", err);
      setActionError("Could not delete the recording.");
    } finally {
      setIsDeletingRecording(false);
    }
  }, [pendingDeleteRecording, isDeletingRecording, setRecordings]);

  const cancelDeleteRecording = useCallback(() => {
    if (isDeletingRecording) {
      return;
    }

    setPendingDeleteRecording(null);
  }, [isDeletingRecording]);

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-(--surface-1) px-4 py-3">
      {displayError && <p className="mb-2 text-xs text-rose-200">{displayError}</p>}

      <div className="mb-3 rounded-sm border border-white/10 bg-black/20 p-2.5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setIsFiltersOpen((open) => !open)}
            aria-expanded={isFiltersOpen}
            className="inline-flex min-h-7 items-center gap-2 text-xs font-medium uppercase tracking-[0.09em] text-neutral-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60 md:pointer-events-none"
          >
            <Film className="h-3.5 w-3.5 text-neutral-400" aria-hidden="true" />
            Session filters
            <ChevronDown
              className={`h-3.5 w-3.5 text-neutral-500 transition-transform duration-150 motion-reduce:transition-none md:hidden ${isFiltersOpen ? "rotate-180" : ""}`}
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            onClick={() => {
              void loadRecordings();
            }}
            disabled={isLoading || !settings.outputFolder}
            className="inline-flex h-7 items-center gap-1 rounded-sm border border-white/20 bg-black/20 px-2 text-xs text-neutral-200 transition-colors hover:bg-white/10 hover:text-neutral-100 focus-visible:outline-none focus-visible:border-emerald-300/45 focus-visible:ring-2 focus-visible:ring-emerald-300/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
        <div
          className={`${isFiltersOpen ? "grid" : "hidden"} gap-2 md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]`}
        >
          <div className="min-w-0">
            <label htmlFor="gamemode-filter-search" className="mb-1 block text-[10px] uppercase tracking-[0.09em] text-neutral-400">
              Search
            </label>
              <Input
                id="gamemode-filter-search"
                type="text"
                variant="filter"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={`Search by ${copy.zoneLabel.toLowerCase()}, ${copy.encounterLabel.toLowerCase()}, filename`}
              />
            </div>

          <div>
            <label htmlFor="gamemode-filter-zone" className="mb-1 block text-[10px] uppercase tracking-[0.09em] text-neutral-400">
              {copy.zoneLabel}
            </label>
            <SettingsSelect
              id="gamemode-filter-zone"
              value={selectedZone}
              onChange={setSelectedZone}
              options={[
                { value: "all", label: "All" },
                ...zoneOptions.map((zoneName): SettingsSelectOption => ({
                  value: zoneName,
                  label: zoneName,
                })),
              ]}
            />
          </div>

          <div>
            <label htmlFor="gamemode-filter-encounter" className="mb-1 block text-[10px] uppercase tracking-[0.09em] text-neutral-400">
              {copy.encounterLabel}
            </label>
            <SettingsSelect
              id="gamemode-filter-encounter"
              value={selectedEncounter}
              onChange={setSelectedEncounter}
              options={[
                { value: "all", label: "All" },
                ...encounterOptions.map((encounterName): SettingsSelectOption => ({
                  value: encounterName,
                  label: encounterName,
                })),
              ]}
            />
          </div>

          <div>
            <label htmlFor="gamemode-filter-date" className="mb-1 block text-[10px] uppercase tracking-[0.09em] text-neutral-400">
              Date
            </label>
            <SettingsSelect
              id="gamemode-filter-date"
              value={selectedDateRange}
              onChange={(nextValue) => setSelectedDateRange(nextValue as DateRangeFilter)}
              options={[
                { value: "all", label: "All time" },
                { value: "24h", label: "Last 24h" },
                { value: "7d", label: "Last 7 days" },
                { value: "30d", label: "Last 30 days" },
              ]}
            />
          </div>
        </div>
      </div>

      {!settings.outputFolder ? (
        <p className="text-xs text-neutral-400">Select an output folder to browse recordings.</p>
      ) : isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-neutral-300" role="status" aria-live="polite">
          <LoaderCircle className="h-4 w-4 animate-spin text-emerald-300" aria-hidden="true" />
          Loading recordings...
        </div>
      ) : modeRecordings.length === 0 ? (
        <p className="text-xs text-neutral-400">No {gameMode.replace("-", " ")} sessions found yet.</p>
      ) : filteredRecordings.length === 0 && !isLoading ? (
        <p className="text-xs text-neutral-400">No sessions match the current filters.</p>
      ) : (
        <ul
          ref={recordingsListRef}
          tabIndex={-1}
          className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1"
        >
          <AnimatePresence initial={false}>
            {filteredRecordings.map((recording, index) => {
              const isActivating = activatingRecordingPath === recording.file_path;
              const displayTitle = getRecordingDisplayTitle(recording, gameMode);

              return (
                <motion.li
                  key={`${recording.file_path}-${recording.created_at}`}
                  initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduceMotion ? undefined : { opacity: 0, y: -4 }}
                  transition={
                    reduceMotion
                      ? { duration: 0 }
                      : { duration: 0.16, delay: Math.min(index, 5) * 0.025 }
                  }
                >
                  <div className="flex items-center gap-2 rounded-sm border border-white/15 bg-black/25 p-3 transition-colors hover:border-emerald-300/45 hover:bg-emerald-500/10">
                    <button
                      type="button"
                      onClick={() => {
                        void handleActivateRecording(recording);
                      }}
                      disabled={isActionLocked}
                      className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span className="flex items-start justify-between gap-2">
                        <span className="min-w-0">
                          <span
                            className="block truncate text-sm font-medium text-neutral-100"
                            title={displayTitle}
                          >
                            {displayTitle}
                          </span>
                          <span className="mt-1 inline-flex items-center gap-1.5 text-xs text-neutral-400">
                            <Clock3 className="h-3 w-3" aria-hidden="true" />
                            {`${formatDate(recording.created_at)} · ${formatBytes(recording.size_bytes)}`}
                          </span>
                        </span>
                        {isActivating && (
                          <LoaderCircle
                            className="h-4 w-4 shrink-0 animate-spin text-emerald-200"
                            aria-label="Loading recording"
                          />
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void handleDeleteRecording(recording);
                      }}
                      disabled={isActionLocked || isDeletingRecording}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-white/10 bg-black/20 text-neutral-400 transition-colors hover:border-rose-300/35 hover:bg-rose-500/15 hover:text-rose-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/60 disabled:cursor-not-allowed disabled:opacity-50"
                      title="Delete recording"
                      aria-label={`Delete recording ${displayTitle}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}

      {pendingDeleteRecording && (
        <DeleteConfirmDialog
          titleId="gamemode-delete-recording-title"
          descriptionId="gamemode-delete-recording-description"
          fallbackFocusRef={recordingsListRef}
          title="Delete recording?"
          description={
            <>
              This will permanently delete{" "}
              <span className="font-medium text-neutral-100">
                {getRecordingDisplayTitle(pendingDeleteRecording, gameMode)}
              </span>
              . This action cannot be undone.
            </>
          }
          isDeleting={isDeletingRecording}
          onConfirm={() => { void confirmDeleteRecording(); }}
          onCancel={cancelDeleteRecording}
        />
      )}
    </section>
  );
}
