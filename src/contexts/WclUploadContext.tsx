import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getErrorMessage } from "../services/tauri";

const MAX_PROGRESS_LINES = 220;
const LIVE_STATE_SYNC_INTERVAL_MS = 8000;

interface WclUploadProgressPayload {
  step: string;
  message: string;
  percent: number;
}

interface WclUploadErrorPayload {
  message: string;
}

interface WclUploadCompletePayload {
  reportUrl: string;
}

interface WclLiveUploadCompletePayload {
  reportUrl: string | null;
  reportCode: string | null;
}

interface WclLiveUploadState {
  isRunning: boolean;
  reportUrl: string | null;
}

interface StartWclUploadResponse {
  reportUrl: string;
}

interface StartWclLiveUploadResponse {
  reportUrl: string | null;
}

export interface StartWclUploadPayload {
  logFilePath: string;
  email: string;
  password: string | null;
  useSavedLogin: boolean;
  rememberLogin: boolean;
  description: string;
  region: number;
  visibility: number;
  guildId: number | null;
}

export interface StartWclLiveUploadPayload {
  wowFolder: string;
  email: string;
  password: string | null;
  useSavedLogin: boolean;
  rememberLogin: boolean;
  description: string;
  region: number;
  visibility: number;
  guildId: number | null;
}

interface WclUploadContextType {
  isUploading: boolean;
  isLiveUploading: boolean;
  progressPercent: number;
  progressStatus: string | null;
  progressLines: string[];
  errorMessage: string | null;
  reportUrl: string | null;
  setWclError: (message: string | null) => void;
  appendProgressLine: (line: string) => void;
  clearProgress: () => void;
  startUpload: (payload: StartWclUploadPayload) => Promise<void>;
  cancelUpload: () => Promise<void>;
  startLiveUpload: (payload: StartWclLiveUploadPayload) => Promise<void>;
  stopLiveUpload: () => Promise<void>;
  refreshLiveState: () => Promise<void>;
}

const WclUploadContext = createContext<WclUploadContextType | undefined>(undefined);

export function WclUploadProvider({ children }: { children: ReactNode }) {
  const [isUploading, setIsUploading] = useState(false);
  const [isLiveUploading, setIsLiveUploading] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressStatus, setProgressStatus] = useState<string | null>(null);
  const [progressLines, setProgressLines] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reportUrl, setReportUrl] = useState<string | null>(null);

  const appendProgressLine = useCallback((line: string) => {
    setProgressLines((previous) => {
      const next = [...previous, line];
      if (next.length > MAX_PROGRESS_LINES) {
        return next.slice(next.length - MAX_PROGRESS_LINES);
      }
      return next;
    });
  }, []);

  const clearProgress = useCallback(() => {
    setProgressPercent(0);
    setProgressStatus(null);
    setProgressLines([]);
  }, []);

  const refreshLiveState = useCallback(async () => {
    try {
      const liveState = await invoke<WclLiveUploadState>("get_wcl_live_upload_state");
      setIsLiveUploading(liveState.isRunning);
      if (liveState.reportUrl) {
        setReportUrl(liveState.reportUrl);
      }
    } catch {
      // keep current state on failed refresh
    }
  }, []);

  useEffect(() => {
    void refreshLiveState();
  }, [refreshLiveState]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (isLiveUploading) {
        void refreshLiveState();
      }
    }, LIVE_STATE_SYNC_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isLiveUploading, refreshLiveState]);

  useEffect(() => {
    let disposed = false;

    const bindListeners = async () => {
      const unlistenProgress = await listen<WclUploadProgressPayload>(
        "wcl-upload-progress",
        (event) => {
          if (disposed) {
            return;
          }

          setProgressPercent((previous) => Math.max(previous, event.payload.percent));
          setProgressStatus(event.payload.message);
          appendProgressLine(event.payload.message);
        },
      );

      const unlistenComplete = await listen<WclUploadCompletePayload>("wcl-upload-complete", (event) => {
        if (disposed) {
          return;
        }

        setIsUploading(false);
        setErrorMessage(null);
        setReportUrl(event.payload.reportUrl);
        setProgressPercent(100);
        setProgressStatus("Upload complete");
        appendProgressLine(`Report ready: ${event.payload.reportUrl}`);
      });

      const unlistenError = await listen<WclUploadErrorPayload>("wcl-upload-error", (event) => {
        if (disposed) {
          return;
        }

        setIsUploading(false);
        setErrorMessage(event.payload.message);
        setProgressStatus("Upload failed");
        appendProgressLine(`Error: ${event.payload.message}`);
      });

      const unlistenLiveProgress = await listen<WclUploadProgressPayload>(
        "wcl-live-upload-progress",
        (event) => {
          if (disposed) {
            return;
          }

          setProgressPercent((previous) => Math.max(previous, event.payload.percent));
          setProgressStatus(event.payload.message);
          appendProgressLine(event.payload.message);
        },
      );

      const unlistenLiveComplete = await listen<WclLiveUploadCompletePayload>(
        "wcl-live-upload-complete",
        (event) => {
          if (disposed) {
            return;
          }

          setIsLiveUploading(false);
          if (event.payload.reportUrl) {
            setReportUrl(event.payload.reportUrl);
          }
          setProgressStatus("Live upload stopped");
          setProgressPercent(100);
        },
      );

      const unlistenLiveReportCreated = await listen<WclLiveUploadCompletePayload>(
        "wcl-live-upload-report-created",
        (event) => {
          if (disposed) {
            return;
          }

          if (event.payload.reportUrl) {
            setReportUrl(event.payload.reportUrl);
            appendProgressLine(`Live report ready: ${event.payload.reportUrl}`);
            setProgressStatus("Live report created");
            setProgressPercent((previous) => Math.max(previous, 35));
          }
        },
      );

      const unlistenLiveError = await listen<WclUploadErrorPayload>("wcl-live-upload-error", (event) => {
        if (disposed) {
          return;
        }

        setIsLiveUploading(false);
        setErrorMessage(event.payload.message);
        setProgressStatus("Live upload failed");
        appendProgressLine(`Live upload error: ${event.payload.message}`);
      });

      return () => {
        unlistenProgress();
        unlistenComplete();
        unlistenError();
        unlistenLiveProgress();
        unlistenLiveComplete();
        unlistenLiveReportCreated();
        unlistenLiveError();
      };
    };

    let disposeListeners: (() => void) | undefined;
    void bindListeners().then((dispose) => {
      disposeListeners = dispose;
    });

    return () => {
      disposed = true;
      if (disposeListeners) {
        disposeListeners();
      }
    };
  }, [appendProgressLine]);

  const startUpload = useCallback(async (payload: StartWclUploadPayload) => {
    setIsUploading(true);
    setErrorMessage(null);
    setReportUrl(null);
    setProgressPercent(0);
    setProgressStatus("Starting upload...");
    setProgressLines([]);

    try {
      const result = await invoke<StartWclUploadResponse>("start_wcl_upload", { request: payload });
      setReportUrl(result.reportUrl);
      setProgressPercent(100);
      setProgressStatus("Upload complete");
      setIsUploading(false);
    } catch (error) {
      setIsUploading(false);
      const message = getErrorMessage(error);
      setErrorMessage(message);
      throw new Error(message);
    }
  }, []);

  const cancelUpload = useCallback(async () => {
    try {
      await invoke("cancel_wcl_upload");
    } catch (error) {
      const message = getErrorMessage(error);
      setErrorMessage(message);
      throw new Error(message);
    }
  }, []);

  const startLiveUpload = useCallback(async (payload: StartWclLiveUploadPayload) => {
    setErrorMessage(null);
    setProgressPercent(0);
    setProgressStatus("Starting live upload...");
    setProgressLines([]);

    try {
      const result = await invoke<StartWclLiveUploadResponse>("start_wcl_live_upload", {
        request: payload,
      });
      setIsLiveUploading(true);
      if (result.reportUrl) {
        setReportUrl(result.reportUrl);
      }
      appendProgressLine("Live upload started.");
    } catch (error) {
      setIsLiveUploading(false);
      const message = getErrorMessage(error);
      setErrorMessage(message);
      throw new Error(message);
    }
  }, [appendProgressLine]);

  const stopLiveUpload = useCallback(async () => {
    try {
      await invoke("stop_wcl_live_upload");
      setIsLiveUploading(false);
      appendProgressLine("Stopping live upload...");
    } catch (error) {
      const message = getErrorMessage(error);
      setErrorMessage(message);
      throw new Error(message);
    }
  }, [appendProgressLine]);

  const value = useMemo<WclUploadContextType>(
    () => ({
      isUploading,
      isLiveUploading,
      progressPercent,
      progressStatus,
      progressLines,
      errorMessage,
      reportUrl,
      setWclError: setErrorMessage,
      appendProgressLine,
      clearProgress,
      startUpload,
      cancelUpload,
      startLiveUpload,
      stopLiveUpload,
      refreshLiveState,
    }),
    [
      appendProgressLine,
      clearProgress,
      errorMessage,
      isLiveUploading,
      isUploading,
      progressLines,
      progressPercent,
      progressStatus,
      refreshLiveState,
      reportUrl,
      startLiveUpload,
      startUpload,
      stopLiveUpload,
      cancelUpload,
    ],
  );

  return <WclUploadContext.Provider value={value}>{children}</WclUploadContext.Provider>;
}

export function useWclUpload() {
  const context = useContext(WclUploadContext);
  if (!context) {
    throw new Error("useWclUpload must be used within WclUploadProvider");
  }
  return context;
}
