import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "./SettingsContext";
import { useMarker } from "./MarkerContext";
import { QUALITY_SETTINGS } from "../types/settings";
import { convertCombatEvent, CombatEvent } from "../types/events";

interface RecordingStartedPayload {
  output_path: string;
  width: number;
  height: number;
}

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

interface CleanupResult {
  deleted_count: number;
  freed_bytes: number;
  deleted_files: string[];
}

interface RecordingContextType {
  isRecording: boolean;
  isPreviewing: boolean;
  isInitializing: boolean;
  lastError: string | null;
  recordingWarning: string | null;
  previewFrameUrl: string | null;
  captureWidth: number;
  captureHeight: number;
  recordingPath: string | null;
  recordingDuration: number;
  startPreview: () => Promise<void>;
  stopPreview: () => Promise<void>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
}

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
  const { settings } = useSettings();
  const { addEvent, clearEvents } = useMarker();

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

  const getErrorMessage = (error: unknown): string => {
    if (typeof error === "string") {
      return error;
    }

    if (error && typeof error === "object") {
      const maybeMessage = (error as { message?: unknown }).message;
      if (typeof maybeMessage === "string") {
        return maybeMessage;
      }

      const maybeError = (error as { error?: unknown }).error;
      if (typeof maybeError === "string") {
        return maybeError;
      }
    }

    return String(error);
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

  useEffect(() => {
    const unlistenRecordingStopped = listen("recording-stopped", () => {
      setIsRecording(false);
      setRecordingStartTime(null);
      setRecordingWarning(null);
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
      const gameEvent = convertCombatEvent(event.payload);
      addEvent(gameEvent);
    });

    return () => {
      unlistenRecordingStopped.then((fn) => fn());
      unlistenRecordingWarning.then((fn) => fn());
      unlistenRecordingWarningCleared.then((fn) => fn());
      unlistenCleanup.then((fn) => fn());
      unlistenCombatEvent.then((fn) => fn());
    };
  }, [addEvent]);

  const startPreview = async () => {
    return Promise.resolve();
  };

  const stopPreview = async () => {
    return Promise.resolve();
  };

  const startRecording = async () => {
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
      setRecordingPath(result.output_path);
      setCaptureWidth(result.width);
      setCaptureHeight(result.height);
      setRecordingStartTime(Date.now());

      if (settings.wowFolder.trim().length > 0) {
        try {
          const wowFolderIsValid = await invoke<boolean>("validate_wow_folder", {
            path: settings.wowFolder,
          });

          if (wowFolderIsValid) {
            await invoke("start_combat_watch", { wowFolder: settings.wowFolder });
          }
        } catch (error) {
          console.warn("Failed to start combat watch, continuing recording:", error);
        }
      }
    } catch (error) {
      if (recordingStarted) {
        await invoke("stop_recording").catch(() => undefined);
        await invoke("stop_combat_watch").catch(() => undefined);
        setIsRecording(false);
        setRecordingStartTime(null);
      }
      setRecordingWarning(null);
      console.error("Failed to start recording:", error);
      setLastError(getErrorMessage(error));
      throw error;
    }
  };

  const stopRecording = async () => {
    setLastError(null);
    try {
      const waitForFinalize = waitForEvent("recording-finalized", 15000);
      const waitForStopped = waitForEvent("recording-stopped", 15000);

      await invoke("stop_combat_watch").catch(() => undefined);
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
    } catch (error) {
      console.error("Failed to stop recording:", error);
      setLastError(getErrorMessage(error));
      throw error;
    }
  };

  return (
    <RecordingContext.Provider
      value={{
        isRecording,
        isPreviewing: false,
        isInitializing: false,
        lastError,
        recordingWarning,
        previewFrameUrl: null,
        captureWidth,
        captureHeight,
        recordingPath,
        recordingDuration,
        startPreview,
        stopPreview,
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
  if (context === undefined) {
    throw new Error("useRecording must be used within a RecordingProvider");
  }
  return context;
}
