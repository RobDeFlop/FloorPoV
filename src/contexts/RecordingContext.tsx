import { createContext, useContext, useState, useEffect, useRef, ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "./SettingsContext";
import { useMarker } from "./MarkerContext";
import { QUALITY_SETTINGS } from "../types/settings";
import { convertCombatEvent, CombatEvent } from "../types/events";

interface CaptureStartedPayload {
  width: number;
  height: number;
  source: string;
}

interface PreviewFramePayload {
  dataBase64: string;
}

interface RecordingStartedPayload {
  output_path: string;
  width: number;
  height: number;
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
  previewFrameUrl: string | null;
  captureSource: string | null;
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
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [previewFrameUrl, setPreviewFrameUrl] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [captureSource, setCaptureSource] = useState<string | null>(null);
  const [captureWidth, setCaptureWidth] = useState(0);
  const [captureHeight, setCaptureHeight] = useState(0);
  const [recordingPath, setRecordingPath] = useState<string | null>(null);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [recordingStartTime, setRecordingStartTime] = useState<number | null>(null);
  const appliedPreviewSettingsKeyRef = useRef<string>("");
  const isApplyingPreviewSettingsRef = useRef(false);
  const shouldResumePreviewAfterRecordingRef = useRef(false);
  const isRestartingPreviewRef = useRef(false);
  const isStoppingPreviewRef = useRef(false);
  const { settings } = useSettings();
  const { addEvent, clearEvents } = useMarker();
  const previewSettingsKey = `${settings.captureSource}::${settings.selectedWindow ?? ""}`;

  const waitForCaptureStopped = async () => {
    let done = false;
    let disposeListener: (() => void) | null = null;

    await Promise.race([
      new Promise<void>((resolve) => {
        listen("capture-stopped", () => {
          if (done) return;
          done = true;
          if (disposeListener) {
            disposeListener();
          }
          resolve();
        }).then((unlisten) => {
          if (done) {
            unlisten();
            return;
          }
          disposeListener = unlisten;
        });
      }),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          if (done) return;
          done = true;
          if (disposeListener) {
            disposeListener();
          }
          resolve();
        }, 1200);
      }),
    ]);
  };

  const waitForRecordingStopped = async () => {
    return waitForEvent("recording-stopped", 1200);
  };

  const waitForRecordingFinalized = async () => {
    return waitForEvent("recording-finalized", 3000);
  };

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
    if (typeof error === 'string') {
      return error;
    }

    if (error && typeof error === 'object') {
      const maybeMessage = (error as { message?: unknown }).message;
      if (typeof maybeMessage === 'string') {
        return maybeMessage;
      }

      const maybeError = (error as { error?: unknown }).error;
      if (typeof maybeError === 'string') {
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
    const unlistenPreviewFrame = listen<PreviewFramePayload>("preview-frame", (event) => {
      if (isStoppingPreviewRef.current) {
        return;
      }
      setPreviewFrameUrl(`data:image/jpeg;base64,${event.payload.dataBase64}`);
      setIsPreviewing(true);
    });

    const unlistenCaptureStopped = listen("capture-stopped", () => {
      isStoppingPreviewRef.current = false;
      if (!isRestartingPreviewRef.current) {
        setIsPreviewing(false);
        setCaptureSource(null);
        setPreviewFrameUrl(null);
      }
    });

    const unlistenRecordingStopped = listen("recording-stopped", () => {
      setIsRecording(false);
      setRecordingStartTime(null);
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
      unlistenPreviewFrame.then((fn) => fn());
      unlistenCaptureStopped.then((fn) => fn());
      unlistenRecordingStopped.then((fn) => fn());
      unlistenCleanup.then((fn) => fn());
      unlistenCombatEvent.then((fn) => fn());
    };
  }, [addEvent]);

  useEffect(() => {
    const initPreview = async () => {
      try {
        await startPreview();
        setIsInitializing(false);
      } catch (error) {
        console.error("Failed to auto-start preview:", error);
        setIsInitializing(false);
      }
    };

    const timeoutId = setTimeout(initPreview, 150);

    return () => clearTimeout(timeoutId);
  }, []);

  const startPreview = async () => {
    setLastError(null);
    isRestartingPreviewRef.current = true;
    isStoppingPreviewRef.current = false;
    const requestedCaptureSource = settings.captureSource;
    const requestedSelectedWindow = settings.selectedWindow ?? "";
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await invoke<CaptureStartedPayload>("start_preview", {
            captureSource: requestedCaptureSource,
            selectedWindow: requestedSelectedWindow || null,
          });
          setIsPreviewing(true);
          setCaptureSource(result.source);
          setCaptureWidth(result.width);
          setCaptureHeight(result.height);
          appliedPreviewSettingsKeyRef.current =
            `${requestedCaptureSource}::${requestedSelectedWindow}`;
          return;
        } catch (error) {
          const message = getErrorMessage(error);
          const isCaptureBusy = message.includes("Capture already in progress");
          const canRetry = isCaptureBusy && attempt === 0;

          if (!canRetry) {
            console.error("Failed to start preview:", error);
            setLastError(getErrorMessage(error));
            throw error;
          }

          await invoke("stop_preview").catch(() => undefined);
          await waitForCaptureStopped();
        }
      }
    } finally {
      isRestartingPreviewRef.current = false;
    }
  };

  const stopPreview = async () => {
    setLastError(null);
    isStoppingPreviewRef.current = true;
    try {
      setIsPreviewing(false);
      await invoke("stop_preview");
      await waitForCaptureStopped();
      setPreviewFrameUrl(null);
    } catch (error) {
      isStoppingPreviewRef.current = false;
      console.error("Failed to stop preview:", error);
      throw error;
    }
  };

  useEffect(() => {
    const syncPreviewWithSettings = async () => {
      if (isInitializing || isRecording || !isPreviewing) {
        return;
      }

      if (isApplyingPreviewSettingsRef.current) {
        return;
      }

      if (appliedPreviewSettingsKeyRef.current === previewSettingsKey) {
        return;
      }

      isApplyingPreviewSettingsRef.current = true;
      try {
        await stopPreview();
        await startPreview();
      } catch (error) {
        console.error("Failed to apply preview settings change:", error);
      } finally {
        isApplyingPreviewSettingsRef.current = false;
      }
    };

    void syncPreviewWithSettings();
  }, [
    isInitializing,
    isPreviewing,
    isRecording,
    previewSettingsKey,
    startPreview,
    stopPreview,
  ]);

  const startRecording = async () => {
    setLastError(null);
    let recordingStarted = false;
    const shouldResumePreviewAfterRecording = isPreviewing;
    try {
      clearEvents();

      if (isPreviewing) {
        await stopPreview();
      }
      
      const bitrateSettings = QUALITY_SETTINGS[settings.videoQuality];
      const recordingSettings = {
        video_quality: settings.videoQuality,
        frame_rate: settings.frameRate,
        bitrate: bitrateSettings.bitrate,
      };

      let result: RecordingStartedPayload | null = null;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          result = await invoke<RecordingStartedPayload>("start_recording", {
            settings: recordingSettings,
            outputFolder: settings.outputFolder,
            maxStorageBytes: settings.maxStorageGB * 1024 * 1024 * 1024,
            captureSource: settings.captureSource,
            selectedWindow: settings.selectedWindow,
          });
          break;
        } catch (error) {
          const message = getErrorMessage(error);
          const isAlreadyRecording = message.includes("Recording already in progress");
          const canRetry = isAlreadyRecording && attempt === 0;

          if (!canRetry) {
            throw error;
          }

          await invoke("stop_recording").catch(() => undefined);
          await waitForRecordingStopped();
        }
      }

      if (!result) {
        throw new Error("Could not start recording. Please try again.");
      }

      recordingStarted = true;
      shouldResumePreviewAfterRecordingRef.current = shouldResumePreviewAfterRecording;

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
      } else if (shouldResumePreviewAfterRecording) {
        await startPreview().catch(() => undefined);
      }
      shouldResumePreviewAfterRecordingRef.current = false;
      console.error("Failed to start recording:", error);
      setLastError(getErrorMessage(error));
      throw error;
    }
  };

  const stopRecording = async () => {
    setLastError(null);
    try {
      const waitForFinalize = waitForRecordingFinalized();
      const waitForStopped = waitForRecordingStopped();
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

      if (shouldResumePreviewAfterRecordingRef.current) {
        shouldResumePreviewAfterRecordingRef.current = false;
        await startPreview();
      }
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
        isPreviewing,
        isInitializing,
        lastError,
        previewFrameUrl,
        captureSource,
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
