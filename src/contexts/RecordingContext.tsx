import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "./SettingsContext";
import { useMarker } from "./MarkerContext";
import { QUALITY_SETTINGS, RECORDING_EVENT_TIMEOUT_MS } from "../types/settings";
import { getErrorMessage } from "../services/tauri";
import {
  convertCombatEvent,
  convertRecordingMetadataToGameEvents,
  CombatEvent,
  CombatTriggerEvent,
  CombatWatchStatusEvent,
  RecordingMetadata,
} from "../types/events";
import { RecordingStartedPayload, CleanupResult } from "../types/recording";

interface RecordingCommandSettings {
  video_quality: string;
  frame_rate: number;
  bitrate: number;
  capture_source: string;
  capture_window_hwnd: string;
  capture_window_title: string;
  enable_system_audio: boolean;
  enable_recording_diagnostics: boolean;
}

interface RecordingContextType {
  isRecording: boolean;
  lastError: string | null;
  recordingWarning: string | null;
  captureWidth: number;
  captureHeight: number;
  recordingPath: string | null;
  recordingDuration: number;
  appStatusDetail: string | null;
  isSelectedWindowAlive: boolean;
  loadPlaybackMetadata: (filePath: string) => Promise<void>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
}

type RecordingOrigin = "manual" | "auto";
type AutoTriggerMode = "mythicPlus" | "raid" | "pvp";
const AUTO_STOP_GRACE_MS = 5000;

const RecordingContext = createContext<RecordingContextType | undefined>(undefined);

export function RecordingProvider({ children }: { children: ReactNode }) {
  const [isRecording, setIsRecording] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [recordingWarning, setRecordingWarning] = useState<string | null>(null);
  const [captureWidth, setCaptureWidth] = useState(0);
  const [captureHeight, setCaptureHeight] = useState(0);
  const [recordingPath, setRecordingPath] = useState<string | null>(null);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [recordingStartTime, setRecordingStartTime] = useState<number | null>(null);
  const [recordingOrigin, setRecordingOrigin] = useState<RecordingOrigin | null>(null);
  const [activeAutoTriggerMode, setActiveAutoTriggerMode] = useState<AutoTriggerMode | null>(null);
  const [isCombatWatchRunning, setIsCombatWatchRunning] = useState(false);
  const [combatWatchWowFolder, setCombatWatchWowFolder] = useState<string | null>(null);
  // Three priority-ordered slots for the sidebar App Status detail line.
  // Priority: windowGoneDetail (1, highest) > combatWatchDetail (2) > autoRecordingConfigDetail (3).
  // appStatusDetail is derived from these and passed to consumers.
  const [windowGoneDetail, setWindowGoneDetail] = useState<string | null>(null);
  const [combatWatchDetail, setCombatWatchDetail] = useState<string | null>(null);
  const [autoRecordingConfigDetail, setAutoRecordingConfigDetail] = useState<string | null>(null);
  const [isSelectedWindowAlive, setIsSelectedWindowAlive] = useState(true);
  const appStatusDetail = windowGoneDetail ?? combatWatchDetail ?? autoRecordingConfigDetail;
  const { settings, updateSettings } = useSettings();
  const { addEvent, setEvents, clearEvents } = useMarker();
  const operationInFlightRef = useRef(false);
  const isRecordingRef = useRef(false);
  const recordingOriginRef = useRef<RecordingOrigin | null>(null);
  const pendingAutoStopTimeoutRef = useRef<number | null>(null);
  const pendingAutoStopModeRef = useRef<AutoTriggerMode | null>(null);

  const clearPendingAutoStop = useCallback(() => {
    if (pendingAutoStopTimeoutRef.current !== null) {
      window.clearTimeout(pendingAutoStopTimeoutRef.current);
      pendingAutoStopTimeoutRef.current = null;
    }
    pendingAutoStopModeRef.current = null;
  }, []);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    recordingOriginRef.current = recordingOrigin;
  }, [recordingOrigin]);

  const ensureCombatWatchRunning = useCallback(async () => {
    const wowFolder = settings.wowFolder.trim();
    if (!wowFolder) {
      if (settings.enableAutoRecording) {
        setAutoRecordingConfigDetail("Auto recording: set WoW folder in Settings.");
      }
      return false;
    }

    const wowFolderIsValid = await invoke<boolean>("validate_wow_folder", {
      path: wowFolder,
    });
    if (!wowFolderIsValid) {
      if (settings.enableAutoRecording) {
        setAutoRecordingConfigDetail("Auto recording: no WoWCombatLog*.txt found.");
      }
      return false;
    }

    await invoke("start_combat_watch", {
      wowFolder,
      recordingOutputPath: null,
    });
    setIsCombatWatchRunning(true);
    setCombatWatchWowFolder(wowFolder);
    return true;
  }, [settings.enableAutoRecording, settings.wowFolder]);

  const detachCombatWatchRecordingOutput = useCallback(async () => {
    try {
      await invoke("set_combat_watch_recording_output", {
        recordingOutputPath: null,
      });
    } catch (error) {
      console.warn("Failed to detach combat watch recording output:", error);
    }
  }, []);

  const waitForEvent = async (eventName: string, timeoutMs: number): Promise<boolean> => {
    return new Promise((resolve) => {
      let settled = false;
      let disposeListener: (() => void) | null = null;

      const finish = (receivedEvent: boolean) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutId);

        if (disposeListener) {
          disposeListener();
        }

        resolve(receivedEvent);
      };

      const timeoutId = window.setTimeout(() => {
        finish(false);
      }, timeoutMs);

      listen(eventName, () => {
        finish(true);
      }).then((unlisten) => {
        if (settled) {
          unlisten();
          return;
        }

        disposeListener = unlisten;
      });
    });
  };

  useEffect(() => {
    let intervalId: number | undefined;

    if (isRecording && recordingStartTime) {
      intervalId = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
        setRecordingDuration(elapsed);
      }, 1000);
    } else {
      setRecordingDuration(0);
    }

    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [isRecording, recordingStartTime]);

  // Poll the running window list every 3 seconds while idle to detect if the selected window
  // has been closed. Paused during recording because the Rust backend handles that at 150 ms.
  // Falls back to title matching when the saved HWND is stale (e.g. after the program restarts).
  useEffect(() => {
    const hwnd = settings.captureWindowHwnd;
    const title = settings.captureWindowTitle;
    if (isRecording || settings.captureSource !== "window" || !hwnd) {
      setWindowGoneDetail(null);
      setIsSelectedWindowAlive(true);
      return;
    }

    let cancelled = false;

    const checkWindowAlive = async () => {
      try {
        const windows = await invoke<{ hwnd: string; title: string }[]>("list_capture_windows");
        if (cancelled) {
          return;
        }

        const exactMatch = windows.some((w) => w.hwnd === hwnd);
        if (exactMatch) {
          setIsSelectedWindowAlive(true);
          setWindowGoneDetail(null);
          return;
        }

        // HWND may be stale (program restarted and got a new HWND). Fall back to
        // title matching, the same strategy the Rust backend uses at recording time.
        const titleMatch = title ? windows.find((w) => w.title === title) : null;
        if (titleMatch) {
          // Silently recover the HWND in persisted settings so the rest of the app
          // (and the next recording) uses the current handle without user action.
          await updateSettings({ ...settings, captureWindowHwnd: titleMatch.hwnd });
          setIsSelectedWindowAlive(true);
          setWindowGoneDetail(null);
          return;
        }

        setIsSelectedWindowAlive(false);
        setWindowGoneDetail("Selected window is not running.");
      } catch (error) {
        console.warn("Failed to check if selected window is still running:", error);
      }
    };

    void checkWindowAlive();
    const intervalId = window.setInterval(checkWindowAlive, 3000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [isRecording, settings, updateSettings]);

  useEffect(() => {
    const unlistenRecordingStopped = listen("recording-stopped", () => {
      clearPendingAutoStop();
      setIsRecording(false);
      setRecordingStartTime(null);
      setRecordingWarning(null);
      setRecordingOrigin(null);
      setActiveAutoTriggerMode(null);
      operationInFlightRef.current = false;
    });

    const unlistenRecordingWarning = listen<string>("recording-warning", (event) => {
      setRecordingWarning(event.payload);
    });

    const unlistenRecordingWarningCleared = listen("recording-warning-cleared", () => {
      setRecordingWarning(null);
    });

    const unlistenCleanup = listen<CleanupResult>("storage-cleanup", (event) => {
      const { deleted_count, freed_bytes } = event.payload;
      console.info(`Deleted ${deleted_count} old recording(s) (${(freed_bytes / (1024 ** 3)).toFixed(2)} GB) to stay within storage limit`);
    });

    const unlistenCombatEvent = listen<CombatEvent>("combat-event", (event) => {
      if (!isRecordingRef.current) {
        return;
      }

      const gameEvent = convertCombatEvent(event.payload);
      addEvent(gameEvent);
    });

    const unlistenCombatTrigger = listen<CombatTriggerEvent>("combat-trigger", (event) => {
      const trigger = event.payload;
      if (!settings.enableAutoRecording) {
        return;
      }

      if (trigger.triggerType === "start") {
        if (
          pendingAutoStopTimeoutRef.current !== null &&
          (pendingAutoStopModeRef.current === null || pendingAutoStopModeRef.current === trigger.mode)
        ) {
          clearPendingAutoStop();
        }

        if (operationInFlightRef.current || isRecordingRef.current) {
          return;
        }

        void startRecordingInternal("auto", trigger.mode);
        return;
      }

      if (
        trigger.triggerType === "end" &&
        !operationInFlightRef.current &&
        isRecordingRef.current &&
        recordingOriginRef.current === "auto" &&
        activeAutoTriggerMode === trigger.mode
      ) {
        if (pendingAutoStopTimeoutRef.current !== null) {
          return;
        }

        pendingAutoStopModeRef.current = trigger.mode;
        pendingAutoStopTimeoutRef.current = window.setTimeout(() => {
          pendingAutoStopTimeoutRef.current = null;
          pendingAutoStopModeRef.current = null;

          if (
            !isRecordingRef.current ||
            recordingOriginRef.current !== "auto" ||
            operationInFlightRef.current
          ) {
            return;
          }

          void stopRecordingInternal(false);
        }, AUTO_STOP_GRACE_MS);
      }
    });

    const unlistenCombatWatchStatus = listen<CombatWatchStatusEvent>("combat-watch-status", (event) => {
      const statusPayload = event.payload;
      const logSuffix = statusPayload.watchedLogPath
        ? ` (${statusPayload.watchedLogPath})`
        : "";
      setCombatWatchDetail(`${statusPayload.message}${logSuffix}`);
    });

    return () => {
      unlistenRecordingStopped.then((unsubscribe) => unsubscribe());
      unlistenRecordingWarning.then((unsubscribe) => unsubscribe());
      unlistenRecordingWarningCleared.then((unsubscribe) => unsubscribe());
      unlistenCleanup.then((unsubscribe) => unsubscribe());
      unlistenCombatEvent.then((unsubscribe) => unsubscribe());
      unlistenCombatTrigger.then((unsubscribe) => unsubscribe());
      unlistenCombatWatchStatus.then((unsubscribe) => unsubscribe());
    };
  }, [activeAutoTriggerMode, addEvent, clearPendingAutoStop, settings.enableAutoRecording]);

  const loadPlaybackMetadata = async (filePath: string) => {
    if (isRecording) {
      return;
    }

    const normalizedPath = filePath.trim();
    if (!normalizedPath) {
      setEvents([]);
      return;
    }

    try {
      const metadata = await invoke<RecordingMetadata | null>("get_recording_metadata", {
        filePath: normalizedPath,
      });

      setEvents(convertRecordingMetadataToGameEvents(metadata));
    } catch (error) {
      console.warn("Failed to load recording metadata. Falling back to no markers.", error);
      setEvents([]);
    }
  };

  const startRecordingInternal = useCallback(
    async (origin: RecordingOrigin, autoTriggerMode: AutoTriggerMode | null = null) => {
      if (operationInFlightRef.current || isRecordingRef.current) {
        return;
      }

      operationInFlightRef.current = true;
      setLastError(null);
      setRecordingWarning(null);
      let recordingStarted = false;

      try {
        clearEvents();

        const bitrateSettings = QUALITY_SETTINGS[settings.videoQuality];
        const recordingSettings: RecordingCommandSettings = {
          video_quality: settings.videoQuality,
          frame_rate: settings.frameRate,
          bitrate: bitrateSettings.bitrate,
          capture_source: settings.captureSource,
          capture_window_hwnd: settings.captureWindowHwnd,
          capture_window_title: settings.captureWindowTitle,
          enable_system_audio: settings.enableSystemAudio,
          enable_recording_diagnostics: settings.enableRecordingDiagnostics,
        };

        const result = await invoke<RecordingStartedPayload>("start_recording", {
          settings: recordingSettings,
          outputFolder: settings.outputFolder,
          maxStorageBytes: settings.maxStorageGB * 1024 * 1024 * 1024,
        });

        recordingStarted = true;

        setIsRecording(true);
        setRecordingOrigin(origin);
        setActiveAutoTriggerMode(origin === "auto" ? autoTriggerMode : null);
        setRecordingPath(result.output_path);
        setCaptureWidth(result.width);
        setCaptureHeight(result.height);
        setRecordingStartTime(Date.now());

        const watchStarted = await ensureCombatWatchRunning();
        if (watchStarted) {
          await invoke("set_combat_watch_recording_output", {
            recordingOutputPath: result.output_path,
          });
        }
      } catch (error) {
        if (recordingStarted) {
          await detachCombatWatchRecordingOutput();
          await invoke("stop_recording").catch(() => undefined);
          setIsRecording(false);
          setRecordingStartTime(null);
          setRecordingOrigin(null);
          setActiveAutoTriggerMode(null);
        }
        setRecordingWarning(null);
        console.error("Failed to start recording:", error);
        setLastError(getErrorMessage(error));
        throw error;
      } finally {
        operationInFlightRef.current = false;
      }
    },
    [
      clearEvents,
      detachCombatWatchRecordingOutput,
      ensureCombatWatchRunning,
      settings.captureSource,
      settings.captureWindowHwnd,
      settings.captureWindowTitle,
      settings.enableRecordingDiagnostics,
      settings.enableSystemAudio,
      settings.frameRate,
      settings.maxStorageGB,
      settings.outputFolder,
      settings.videoQuality,
    ],
  );

  const stopRecordingInternal = useCallback(
    async (isManualStop: boolean) => {
      if (operationInFlightRef.current) {
        return;
      }

      clearPendingAutoStop();

      operationInFlightRef.current = true;
      setLastError(null);
      try {
        const waitForFinalize = waitForEvent("recording-finalized", RECORDING_EVENT_TIMEOUT_MS);
        const waitForStopped = waitForEvent("recording-stopped", RECORDING_EVENT_TIMEOUT_MS);

        await detachCombatWatchRecordingOutput();
        await invoke("stop_recording");

        const [finalizedReceived, stoppedReceived] = await Promise.all([
          waitForFinalize,
          waitForStopped,
        ]);

        if (!finalizedReceived) {
          console.warn("Timed out waiting for recording-finalized event");
        }
        if (!stoppedReceived) {
          console.warn("Timed out waiting for recording-stopped event");
        }

        setIsRecording(false);
        setRecordingStartTime(null);
        setRecordingWarning(null);
        setRecordingOrigin(null);
        setActiveAutoTriggerMode(null);

        if (isManualStop && !settings.enableAutoRecording && isCombatWatchRunning) {
          await invoke("stop_combat_watch").catch(() => undefined);
          setIsCombatWatchRunning(false);
          setCombatWatchWowFolder(null);
        }
      } catch (error) {
        console.error("Failed to stop recording:", error);
        setLastError(getErrorMessage(error));
        throw error;
      } finally {
        operationInFlightRef.current = false;
      }
    },
    [clearPendingAutoStop, detachCombatWatchRecordingOutput, isCombatWatchRunning, settings.enableAutoRecording],
  );

  const startRecording = useCallback(async () => {
    await startRecordingInternal("manual", null);
  }, [startRecordingInternal]);

  const stopRecording = useCallback(async () => {
    await stopRecordingInternal(true);
  }, [stopRecordingInternal]);

  useEffect(() => {
    let isDisposed = false;

    const syncCombatWatch = async () => {
      const wowFolder = settings.wowFolder.trim();
      const shouldKeepWatchRunning = settings.enableAutoRecording || isRecording;

      if (!wowFolder || !shouldKeepWatchRunning) {
        if (isCombatWatchRunning) {
          await invoke("stop_combat_watch").catch(() => undefined);
          if (!isDisposed) {
            setIsCombatWatchRunning(false);
            setCombatWatchWowFolder(null);
          }
        }
        return;
      }

      if (isCombatWatchRunning && combatWatchWowFolder && combatWatchWowFolder !== wowFolder) {
        await invoke("stop_combat_watch").catch(() => undefined);
        if (!isDisposed) {
          setIsCombatWatchRunning(false);
          setCombatWatchWowFolder(null);
        }
      }

      try {
        const watchStarted = await ensureCombatWatchRunning();
        if (!isDisposed) {
          if (watchStarted) {
            setIsCombatWatchRunning(true);
            setCombatWatchWowFolder(wowFolder);
          } else if (isCombatWatchRunning) {
            await invoke("stop_combat_watch").catch(() => undefined);
            setIsCombatWatchRunning(false);
            setCombatWatchWowFolder(null);
          }
        }
      } catch (error) {
        console.warn("Failed to synchronize combat watch:", error);
      }
    };

    void syncCombatWatch();

    return () => {
      isDisposed = true;
    };
  }, [
    combatWatchWowFolder,
    ensureCombatWatchRunning,
    isCombatWatchRunning,
    isRecording,
    settings.enableAutoRecording,
    settings.wowFolder,
  ]);

  useEffect(() => {
    return () => {
      clearPendingAutoStop();
    };
  }, [clearPendingAutoStop]);

  return (
    <RecordingContext.Provider
      value={{
        isRecording,
        lastError,
        recordingWarning,
        captureWidth,
        captureHeight,
        recordingPath,
        recordingDuration,
        appStatusDetail,
        isSelectedWindowAlive,
        loadPlaybackMetadata,
        startRecording,
        stopRecording,
      }}
    >
      {children}
    </RecordingContext.Provider>
  );
}

export function useRecording() {
  const context = useContext(RecordingContext);
  if (!context) {
    throw new Error("useRecording must be used within a RecordingProvider");
  }
  return context;
}
