import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { FileInput, LoaderCircle } from "lucide-react";
import { useRecording } from "../../contexts/RecordingContext";
import { useVideo } from "../../contexts/VideoContext";
import { getErrorMessage } from "../../services/tauri";
import {
  recordingMetadataHasCombatContent,
  type ImportCombatLogMode,
  type ImportCombatLogResult,
  type RecordingMetadata,
} from "../../types/events";
import { ControlIconButton } from "./ControlIconButton";

interface ImportModeDialogState {
  combatLogPath: string;
}

export function ImportCombatLogControl() {
  const { loadedFilePath, duration } = useVideo();
  const { isRecording, loadPlaybackMetadata, bumpPlaybackMetadataEpoch } = useRecording();
  const [isImporting, setIsImporting] = useState(false);
  const [modeDialog, setModeDialog] = useState<ImportModeDialogState | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ tone: "error" | "success"; text: string } | null>(
    null,
  );
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);

  const hasVideoDuration = Number.isFinite(duration) && duration > 0;
  const canImport = Boolean(loadedFilePath) && hasVideoDuration && !isRecording && !isImporting;

  const closeModeDialog = useCallback(() => {
    setModeDialog(null);
    const previouslyFocusedElement = previouslyFocusedElementRef.current;
    previouslyFocusedElementRef.current = null;
    window.requestAnimationFrame(() => {
      previouslyFocusedElement?.focus();
    });
  }, []);

  useEffect(() => {
    if (!modeDialog) {
      return;
    }

    cancelButtonRef.current?.focus();

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isImporting) {
        event.preventDefault();
        closeModeDialog();
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, [closeModeDialog, isImporting, modeDialog]);

  const importCombatLog = useCallback(
    async (combatLogPath: string, mode: ImportCombatLogMode) => {
      if (!loadedFilePath || isImporting || !hasVideoDuration) {
        return;
      }

      setIsImporting(true);
      setStatusMessage(null);

      try {
        const result = await invoke<ImportCombatLogResult>("import_combat_log_onto_recording", {
          recordingPath: loadedFilePath,
          combatLogPath,
          mode,
          videoDurationSeconds: duration,
        });

        await loadPlaybackMetadata(loadedFilePath);
        bumpPlaybackMetadataEpoch();

        const backupHint = result.backupPath
          ? " Previous metadata was saved as a .meta.json.bak sidecar."
          : "";
        const modeHint =
          result.mode === "merge"
            ? " New events were merged into the existing sidecar."
            : " Combat events were replaced. Manual markers were kept.";
        setStatusMessage({
          tone: "success",
          text: `Imported ${result.importedEventCount.toLocaleString()} combat events.${modeHint}${backupHint}`,
        });
        closeModeDialog();
      } catch (error) {
        setStatusMessage({
          tone: "error",
          text: getErrorMessage(error),
        });
      } finally {
        setIsImporting(false);
      }
    },
    [
      bumpPlaybackMetadataEpoch,
      closeModeDialog,
      duration,
      hasVideoDuration,
      isImporting,
      loadPlaybackMetadata,
      loadedFilePath,
    ],
  );

  const handleSelectCombatLog = async () => {
    if (!canImport || !loadedFilePath) {
      return;
    }

    setStatusMessage(null);

    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Combat Logs", extensions: ["txt", "log"] }],
      });

      if (typeof selected !== "string" || !selected.trim()) {
        return;
      }

      let metadata: RecordingMetadata | null = null;
      try {
        metadata = await invoke<RecordingMetadata | null>("get_recording_metadata", {
          filePath: loadedFilePath,
        });
      } catch (error) {
        console.warn("Failed to read existing recording metadata before import.", error);
      }

      if (recordingMetadataHasCombatContent(metadata)) {
        previouslyFocusedElementRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setModeDialog({ combatLogPath: selected });
        return;
      }

      await importCombatLog(selected, "overwrite");
    } catch (error) {
      console.error("Failed to open combat log picker:", error);
      setStatusMessage({
        tone: "error",
        text: "Could not open the combat log file picker.",
      });
    }
  };

  if (!loadedFilePath || isRecording) {
    return null;
  }

  return (
    <div className="relative">
      <ControlIconButton
        label={
          isImporting
            ? "Importing combat log"
            : hasVideoDuration
              ? "Import combat log"
              : "Wait for the video to load before importing"
        }
        onClick={() => {
          void handleSelectCombatLog();
        }}
        disabled={!canImport}
      >
        {isImporting ? (
          <LoaderCircle className="h-5 w-5 animate-spin" />
        ) : (
          <FileInput className="h-5 w-5" />
        )}
      </ControlIconButton>

      {statusMessage && (
        <div
          className={`absolute bottom-full right-0 z-30 mb-2 w-72 rounded-sm border px-3 py-2 text-xs shadow-(--surface-glow) ${
            statusMessage.tone === "error"
              ? "border-rose-300/35 bg-rose-950/95 text-rose-100"
              : "border-emerald-300/35 bg-emerald-950/95 text-emerald-100"
          }`}
          role="status"
          aria-live="polite"
        >
          {statusMessage.text}
        </div>
      )}

      {modeDialog && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div
            className="w-full max-w-md rounded-sm border border-white/15 bg-(--surface-2) p-4 shadow-(--surface-glow)"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-combat-log-title"
            aria-describedby="import-combat-log-description"
          >
            <h3
              id="import-combat-log-title"
              className="text-sm font-semibold uppercase tracking-[0.11em] text-neutral-100"
            >
              Import combat log
            </h3>
            <p id="import-combat-log-description" className="mt-2 text-sm text-neutral-300">
              This recording already has combat metadata. Overwrite replaces parsed combat events and
              keeps manual markers. Merge adds events that are not already on the sidecar. Either
              choice copies the current sidecar to a <span className="font-mono">.meta.json.bak</span>{" "}
              file first.
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <button
                ref={cancelButtonRef}
                type="button"
                onClick={closeModeDialog}
                disabled={isImporting}
                className="inline-flex h-8 items-center rounded-sm border border-white/20 bg-black/20 px-3 text-xs text-neutral-200 transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void importCombatLog(modeDialog.combatLogPath, "merge");
                }}
                disabled={isImporting}
                className="inline-flex h-8 items-center rounded-sm border border-white/20 bg-black/20 px-3 text-xs text-neutral-100 transition-colors hover:bg-white/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isImporting ? "Importing..." : "Merge"}
              </button>
              <button
                type="button"
                onClick={() => {
                  void importCombatLog(modeDialog.combatLogPath, "overwrite");
                }}
                disabled={isImporting}
                className="inline-flex h-8 items-center rounded-sm border border-amber-300/35 bg-amber-500/14 px-3 text-xs font-semibold text-amber-100 transition-colors hover:bg-amber-500/22 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isImporting ? "Importing..." : "Overwrite"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
