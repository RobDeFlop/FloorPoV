import { createContext, useContext, useState, useEffect, ReactNode } from "react";
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
  const { settings } = useSettings();
  const { addEvent, clearEvents } = useMarker();

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
      setPreviewFrameUrl(`data:image/jpeg;base64,${event.payload.dataBase64}`);
    });

    const unlistenCaptureStopped = listen("capture-stopped", () => {
      setIsPreviewing(false);
      setCaptureSource(null);
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
    try {
      const result = await invoke<CaptureStartedPayload>("start_preview", {
        captureSource: settings.captureSource,
        selectedWindow: settings.selectedWindow,
      });
      setIsPreviewing(true);
      setCaptureSource(result.source);
      setCaptureWidth(result.width);
      setCaptureHeight(result.height);
    } catch (error) {
      console.error("Failed to start preview:", error);
      throw error;
    }
  };

  const stopPreview = async () => {
    try {
      await invoke("stop_preview");
      setIsPreviewing(false);
      setCaptureSource(null);
      setPreviewFrameUrl(null);
    } catch (error) {
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
