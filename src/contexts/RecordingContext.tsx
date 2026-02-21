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
  const [captureSource, setCaptureSource] = useState<string | null>(null);
  const [captureWidth, setCaptureWidth] = useState(0);
  const [captureHeight, setCaptureHeight] = useState(0);
  const [recordingPath, setRecordingPath] = useState<string | null>(null);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [recordingStartTime, setRecordingStartTime] = useState<number | null>(null);
  const isRestartingPreviewRef = useRef(false);
  const isStoppingPreviewRef = useRef(false);
  const { settings } = useSettings();
  const { addEvent, clearEvents } = useMarker();

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
    isRestartingPreviewRef.current = true;
    isStoppingPreviewRef.current = false;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await invoke<CaptureStartedPayload>("start_preview", {
            captureSource: settings.captureSource,
            selectedWindow: settings.selectedWindow,
          });
          setIsPreviewing(true);
          setCaptureSource(result.source);
          setCaptureWidth(result.width);
          setCaptureHeight(result.height);
          return;
        } catch (error) {
          const message = getErrorMessage(error);
          const isCaptureBusy = message.includes("Capture already in progress");
          const canRetry = isCaptureBusy && attempt === 0;

          if (!canRetry) {
            console.error("Failed to start preview:", error);
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

  const startRecording = async () => {
    let recordingStarted = false;
    try {
      clearEvents();
      
      const bitrateSettings = QUALITY_SETTINGS[settings.videoQuality];
      const recordingSettings = {
        video_quality: settings.videoQuality,
        frame_rate: settings.frameRate,
        bitrate: bitrateSettings.bitrate,
      };

      const result = await invoke<RecordingStartedPayload>("start_recording", {
        settings: recordingSettings,
        outputFolder: settings.outputFolder,
        maxStorageBytes: settings.maxStorageGB * 1024 * 1024 * 1024,
        captureSource: settings.captureSource,
        selectedWindow: settings.selectedWindow,
      });

      recordingStarted = true;

      setIsRecording(true);
      setRecordingPath(result.output_path);
      setCaptureWidth(result.width);
      setCaptureHeight(result.height);
      setRecordingStartTime(Date.now());

      await invoke("start_combat_watch");
    } catch (error) {
      if (recordingStarted) {
        await invoke("stop_recording").catch(() => undefined);
        await invoke("stop_combat_watch").catch(() => undefined);
        setIsRecording(false);
        setRecordingStartTime(null);
      }
      console.error("Failed to start recording:", error);
      throw error;
    }
  };

  const stopRecording = async () => {
    try {
      await invoke("stop_combat_watch").catch(() => undefined);
      await invoke("stop_recording");
      setIsRecording(false);
      setRecordingStartTime(null);
    } catch (error) {
      console.error("Failed to stop recording:", error);
      throw error;
    }
  };

  return (
    <RecordingContext.Provider
      value={{
        isRecording,
        isPreviewing,
        isInitializing,
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
