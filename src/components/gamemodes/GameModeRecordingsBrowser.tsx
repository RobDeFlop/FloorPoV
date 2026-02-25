import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Clock3, Film, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRecording } from "../../contexts/RecordingContext";
import { useSettings } from "../../contexts/SettingsContext";
import { useVideo } from "../../contexts/VideoContext";
import { RecordingInfo } from "../../types/recording";
import { formatBytes, formatDate } from "../../utils/format";
import { getRecordingDisplayTitle, isRecordingInGameMode } from "../../utils/recording-title";
import { SettingsSelect, type SettingsSelectOption } from "../settings/SettingsSelect";

type GameMode = "mythic-plus" | "raid" | "pvp";
type DateRangeFilter = "all" | "24h" | "7d" | "30d";

interface GameModeRecordingsBrowserProps {
  gameMode: GameMode;
  onRecordingActivate: (recording: RecordingInfo) => void;
}

interface ModeField {
  label: string;
  value: string;
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

const filterControlClassName =
  "w-full rounded-sm border border-white/20 bg-black/20 px-3 py-2 text-sm text-neutral-100 " +
  "transition-colors placeholder:text-neutral-400 focus:border-emerald-300/45 focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-emerald-300/60";

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

function getModeFields(recording: RecordingInfo, gameMode: GameMode): ModeField[] {
  if (gameMode === "mythic-plus") {
    return [
      {
        label: "Dungeon",
        value: recording.zone_name ?? "Unknown",
      },
      {
        label: "Key",
        value: typeof recording.key_level === "number" ? `+${recording.key_level}` : "Unknown",
      },
    ];
  }

  if (gameMode === "raid") {
    return [
      {
        label: "Raid",
        value: recording.zone_name ?? "Unknown",
      },
      {
        label: "Encounter",
        value: recording.encounter_name ?? "Unknown",
      },
    ];
  }

  return [
    {
      label: "Map",
      value: recording.zone_name ?? "Unknown",
    },
    {
      label: "Match",
      value: recording.encounter_name ?? "Unknown",
    },
  ];
}

export function GameModeRecordingsBrowser({
  gameMode,
  onRecordingActivate,
}: GameModeRecordingsBrowserProps) {
  const { settings } = useSettings();
  const { isRecording, loadPlaybackMetadata } = useRecording();
  const { loadVideo, isVideoLoading } = useVideo();
  const [recordings, setRecordings] = useState<RecordingInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activatingRecordingPath, setActivatingRecordingPath] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedZone, setSelectedZone] = useState<string>("all");
  const [selectedEncounter, setSelectedEncounter] = useState<string>("all");
  const [selectedDateRange, setSelectedDateRange] = useState<DateRangeFilter>("all");

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

  const loadRecordings = useCallback(async () => {
    if (!settings.outputFolder) {
      setRecordings([]);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await invoke<RecordingInfo[]>("get_recordings_list", {
        folderPath: settings.outputFolder,
      });
      setRecordings(result);
    } catch (loadError) {
      console.error("Failed to load recordings:", loadError);
      setError("Could not load recordings from the output folder.");
    } finally {
      setIsLoading(false);
    }
  }, [settings.outputFolder]);

  useEffect(() => {
    void loadRecordings();
  }, [loadRecordings]);

  useEffect(() => {
    const unlistenRecordingStopped = listen("recording-stopped", () => {
      void loadRecordings();
    });

    const unlistenRecordingFinalized = listen("recording-finalized", () => {
      void loadRecordings();
    });

    return () => {
      unlistenRecordingStopped.then((unsubscribe) => unsubscribe());
      unlistenRecordingFinalized.then((unsubscribe) => unsubscribe());
    };
  }, [loadRecordings]);

  useEffect(() => {
    setSearchQuery("");
    setSelectedZone("all");
    setSelectedEncounter("all");
    setSelectedDateRange("all");
  }, [gameMode]);

  const handleActivateRecording = useCallback(
    async (recording: RecordingInfo) => {
      if (isActionLocked) {
        return;
      }

      setActivatingRecordingPath(recording.file_path);
      setError(null);

      try {
        await loadPlaybackMetadata(recording.file_path);
        loadVideo(convertFileSrc(recording.file_path));
        onRecordingActivate(recording);
      } catch (loadError) {
        console.error("Failed to activate recording:", loadError);
        setError("Could not open the selected recording.");
      } finally {
        setActivatingRecordingPath(null);
      }
    },
    [isActionLocked, loadPlaybackMetadata, loadVideo, onRecordingActivate],
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-(--surface-1) px-4 py-3">
      {error && <p className="mb-2 text-xs text-rose-200">{error}</p>}

      <div className="mb-3 rounded-sm border border-white/10 bg-black/20 p-2.5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.09em] text-neutral-300">
            <Film className="h-3.5 w-3.5 text-neutral-400" />
            Session Filters
          </h2>
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
        <div className="grid gap-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <label className="mb-1 block text-[10px] uppercase tracking-[0.09em] text-neutral-500">
              Search
            </label>
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={`Search by ${copy.zoneLabel.toLowerCase()}, ${copy.encounterLabel.toLowerCase()}, filename`}
                className={filterControlClassName}
              />
            </div>

          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-[0.09em] text-neutral-500">
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
            <label className="mb-1 block text-[10px] uppercase tracking-[0.09em] text-neutral-500">
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
            <label className="mb-1 block text-[10px] uppercase tracking-[0.09em] text-neutral-500">
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
      ) : modeRecordings.length === 0 && !isLoading ? (
        <p className="text-xs text-neutral-400">No {gameMode.replace("-", " ")} sessions found yet.</p>
      ) : filteredRecordings.length === 0 && !isLoading ? (
        <p className="text-xs text-neutral-400">No sessions match the current filters.</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {filteredRecordings.map((recording) => {
            const modeFields = getModeFields(recording, gameMode);
            const isActivating = activatingRecordingPath === recording.file_path;
            const displayTitle = getRecordingDisplayTitle(recording, gameMode);

            return (
              <li key={`${recording.file_path}-${recording.created_at}`}>
                <button
                  type="button"
                  onClick={() => {
                    void handleActivateRecording(recording);
                  }}
                  disabled={isActionLocked}
                  className="w-full rounded-sm border border-white/15 bg-black/25 p-3 text-left transition-colors hover:border-emerald-300/45 hover:bg-emerald-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-neutral-100" title={displayTitle}>
                        {displayTitle}
                      </p>
                      <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-neutral-400">
                        <Clock3 className="h-3 w-3" />
                        {`${formatDate(recording.created_at)} · ${formatBytes(recording.size_bytes)}`}
                      </p>
                    </div>
                    {isActivating && <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-emerald-200" />}
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    {modeFields.map((field) => (
                      <div
                        key={`${recording.file_path}-${field.label}`}
                        className="rounded-sm border border-white/10 bg-black/20 px-2 py-1.5"
                      >
                        <p className="text-[10px] uppercase tracking-[0.09em] text-neutral-500">{field.label}</p>
                        <p className="mt-0.5 truncate text-neutral-200" title={field.value}>
                          {field.value}
                        </p>
                      </div>
                    ))}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
