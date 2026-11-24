import { createContext, useContext, useState, useRef, useCallback, useEffect, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { VIDEO_LOADING_TIMEOUT_MS, VOLUME_MAX, VOLUME_MIN } from "../types/settings";
import type { CompareSeekMode, CompareVideoSlot } from "../utils/compare-playback";

interface VideoContextType {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  isVideoLoading: boolean;
  volume: number;
  playbackRate: number;
  videoSrc: string | null;
  loadedFilePath: string | null;
  isCompareMode: boolean;
  compareVideos: [CompareVideoSlot, CompareVideoSlot] | null;
  compareSeekMode: CompareSeekMode;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  seek: (time: number) => void;
  setVolume: (volume: number) => void;
  setPlaybackRate: (rate: number) => void;
  loadVideo: (src: string, filePath: string) => void;
  clearPlayback: () => void;
  enterCompareMode: (left: CompareVideoSlot, right: CompareVideoSlot) => void;
  exitCompareMode: () => void;
  setCompareSeekMode: (mode: CompareSeekMode) => void;
  updateTime: (time: number) => void;
  updateDuration: (duration: number) => void;
  syncIsPlaying: (playing: boolean) => void;
  setVideoLoading: (loading: boolean) => void;
  isFullscreen: boolean;
  fullscreenPhase: FullscreenPhase;
  fullscreenError: string | null;
  toggleFullscreen: () => Promise<void>;
  exitFullscreen: () => Promise<void>;
}

const VideoContext = createContext<VideoContextType | null>(null);
interface TrayPlacementRestored {
  trayGeneration: number;
}

enum FullscreenEntryOutcome {
  Entered = "entered",
  Skipped = "skipped",
}

interface FullscreenEntry {
  outcome: FullscreenEntryOutcome;
  trayGeneration: number;
}

interface FullscreenTransition {
  completion: Promise<void>;
  entry?: { invalidated: boolean };
}

type FullscreenPhase = "windowed" | "entering" | "fullscreen" | "exiting";

export function VideoProvider({ children }: { children: ReactNode }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const loadingTimeoutRef = useRef<number | null>(null);
  const videoSrcRef = useRef<string | null>(null);
  const loadedFilePathRef = useRef<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isVideoLoading, setIsVideoLoading] = useState(false);
  const [volume, setVolumeState] = useState(1);
  const [playbackRate, setPlaybackRateState] = useState(1);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [fullscreenPhase, setFullscreenPhaseState] = useState<FullscreenPhase>("windowed");
  const fullscreenPhaseRef = useRef<FullscreenPhase>("windowed");
  const fullscreenTransitionRef = useRef<FullscreenTransition | null>(null);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const trayGenerationRef = useRef<number | null>(null);
  const isFullscreen = fullscreenPhase !== "windowed";
  const [loadedFilePath, setLoadedFilePath] = useState<string | null>(null);
  const [isCompareMode, setIsCompareMode] = useState(false);
  const [compareVideos, setCompareVideos] = useState<[CompareVideoSlot, CompareVideoSlot] | null>(
    null,
  );
  // Kept outside compare state so the choice survives leaving and re-entering compare mode.
  const [compareSeekMode, setCompareSeekMode] = useState<CompareSeekMode>("shared");

  const resetCompareMode = useCallback(() => {
    setIsCompareMode(false);
    setCompareVideos(null);
  }, []);

  const play = useCallback(() => {
    videoRef.current?.play();
  }, []);

  const pause = useCallback(() => {
    videoRef.current?.pause();
  }, []);

  const togglePlay = useCallback(() => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play();
    } else {
      videoRef.current.pause();
    }
  }, []);

  const seek = useCallback((time: number) => {
    const videoElement = videoRef.current;
    if (!videoElement) {
      return;
    }

    const mediaDuration = videoElement.duration;
    const upperBound = Number.isFinite(mediaDuration) ? mediaDuration : Number.POSITIVE_INFINITY;
    const nextTime = Number.isFinite(time) ? Math.min(upperBound, Math.max(0, time)) : 0;
    videoElement.currentTime = nextTime;
    setCurrentTime(nextTime);
  }, []);

  const updateTime = useCallback((time: number) => {
    setCurrentTime(time);
  }, []);

  const updateDuration = useCallback((dur: number) => {
    setDuration(dur);
  }, []);

  const syncIsPlaying = useCallback((playing: boolean) => {
    setIsPlaying(playing);
  }, []);

  const setVideoLoading = useCallback((loading: boolean) => {
    if (loadingTimeoutRef.current !== null) {
      clearTimeout(loadingTimeoutRef.current);
      loadingTimeoutRef.current = null;
    }

    setIsVideoLoading(loading);

    if (loading) {
      loadingTimeoutRef.current = window.setTimeout(() => {
        setIsVideoLoading(false);
        loadingTimeoutRef.current = null;
      }, VIDEO_LOADING_TIMEOUT_MS);
    }
  }, []);

  const setVolume = useCallback((vol: number) => {
    const nextVolume = Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, vol));

    if (videoRef.current) {
      videoRef.current.volume = nextVolume;
    }

    setVolumeState(nextVolume);
  }, []);

  const setPlaybackRate = useCallback((rate: number) => {
    if (!Number.isFinite(rate) || rate <= 0) {
      return;
    }

    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
    }
    setPlaybackRateState(rate);
  }, []);

  const setFullscreenPhase = useCallback((phase: FullscreenPhase) => {
    fullscreenPhaseRef.current = phase;
    setFullscreenPhaseState(phase);
  }, []);

  const restorePlaybackWindow = useCallback(async (trayGeneration: number) => {
    try {
      await invoke<void>("exit_playback_fullscreen");
      if (trayGeneration === trayGenerationRef.current) setFullscreenPhase("windowed");
    } catch (error) {
      console.error("Fullscreen exit failed:", error);
      if (trayGeneration !== trayGenerationRef.current) return;
      setFullscreenError("Could not restore the playback window.");
      // Only native restoration can confirm completion. Keep Exit available for a retry.
      setFullscreenPhase("fullscreen");
    }
  }, [setFullscreenPhase]);

  const exitFullscreen = useCallback(async () => {
    if (!isTauri()) return;
    const pending = fullscreenTransitionRef.current;
    if (pending) await pending.completion;
    if (pending?.entry?.invalidated || fullscreenPhaseRef.current !== "fullscreen") return;

    const trayGeneration = trayGenerationRef.current;
    if (trayGeneration === null) return;
    setFullscreenError(null);
    setFullscreenPhase("exiting");
    const transition = { completion: restorePlaybackWindow(trayGeneration) };
    fullscreenTransitionRef.current = transition;
    try {
      await transition.completion;
    } finally {
      if (fullscreenTransitionRef.current === transition) {
        fullscreenTransitionRef.current = null;
      }
    }
  }, [restorePlaybackWindow, setFullscreenPhase]);

  const toggleFullscreen = useCallback(async () => {
    if (!isTauri()) return;
    if (fullscreenPhaseRef.current === "fullscreen") {
      await exitFullscreen();
      return;
    }
    if (fullscreenPhaseRef.current !== "windowed" || fullscreenTransitionRef.current) return;

    setFullscreenError(null);
    setFullscreenPhase("entering");
    const entry = { invalidated: false };
    const completion = (async () => {
      let trayGeneration = trayGenerationRef.current;
      try {
        if (trayGeneration === null) {
          // The native generation survives a webview reload.
          trayGeneration = await invoke<number>("get_playback_tray_generation");
          if (entry.invalidated) return;
          trayGenerationRef.current = trayGeneration;
        }
        const result = await invoke<FullscreenEntry>("enter_playback_fullscreen", { trayGeneration });
        if (entry.invalidated) return;
        trayGenerationRef.current = result.trayGeneration;
        setFullscreenPhase(
          result.outcome === FullscreenEntryOutcome.Entered ? "fullscreen" : "windowed",
        );
      } catch (error) {
        console.error("Fullscreen entry failed:", error);
        if (entry.invalidated) return;
        setFullscreenError("Could not enter fullscreen.");
        if (trayGeneration === null) {
          setFullscreenPhase("windowed");
          return;
        }
        // An issued restore must settle before a new entry can change placement.
        setFullscreenPhase("exiting");
        await restorePlaybackWindow(trayGeneration);
      }
    })();
    const transition = { completion, entry };
    fullscreenTransitionRef.current = transition;
    try {
      await completion;
    } finally {
      if (fullscreenTransitionRef.current === transition) {
        fullscreenTransitionRef.current = null;
      }
    }
  }, [exitFullscreen, restorePlaybackWindow, setFullscreenPhase]);

  const clearSinglePlayback = useCallback(() => {
    if (loadingTimeoutRef.current !== null) {
      clearTimeout(loadingTimeoutRef.current);
      loadingTimeoutRef.current = null;
    }

    const videoElement = videoRef.current;
    if (videoElement) {
      videoElement.pause();
      videoElement.removeAttribute("src");
      videoElement.load();
    }

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }

    videoSrcRef.current = null;
    loadedFilePathRef.current = null;
    setVideoSrc(null);
    setLoadedFilePath(null);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setIsVideoLoading(false);
  }, []);
  const loadVideo = useCallback(
    (src: string, filePath: string) => {
      resetCompareMode();

      const currentSrc = videoSrcRef.current;
      loadedFilePathRef.current = filePath;
      setLoadedFilePath(filePath);

      if (src === currentSrc) {
        const videoElement = videoRef.current;

        // Re-selecting a recording that failed to load should retry it rather than
        // leave the previous failure on screen.
        if (videoElement?.error) {
          setCurrentTime(0);
          setDuration(0);
          setIsPlaying(false);
          setVideoLoading(true);
          videoElement.load();
          return;
        }

        if (videoElement) {
          videoElement.pause();
          videoElement.currentTime = 0;
        }
        setCurrentTime(0);
        setIsPlaying(false);
        setVideoLoading(false);
        return;
      }

      if (objectUrlRef.current && objectUrlRef.current !== src) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }

      if (src.startsWith("blob:")) {
        objectUrlRef.current = src;
      }

      videoSrcRef.current = src;
      setVideoSrc(src);
      setCurrentTime(0);
      setDuration(0);
      setIsPlaying(false);
      setVideoLoading(true);
    },
    [resetCompareMode, setVideoLoading]
  );

  const enterCompareMode = useCallback(
    (left: CompareVideoSlot, right: CompareVideoSlot) => {
      clearSinglePlayback();
      setCompareVideos([left, right]);
      setIsCompareMode(true);
    },
    [clearSinglePlayback],
  );

  const exitCompareMode = useCallback(() => {
    resetCompareMode();
  }, [resetCompareMode]);

  const clearPlayback = useCallback(() => {
    resetCompareMode();
    clearSinglePlayback();
  }, [clearSinglePlayback, resetCompareMode]);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }

    let frameId = 0;
    const syncPlaybackTime = () => {
      const videoElement = videoRef.current;
      if (videoElement) {
        setCurrentTime(videoElement.currentTime);
      }
      frameId = window.requestAnimationFrame(syncPlaybackTime);
    };

    frameId = window.requestAnimationFrame(syncPlaybackTime);
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [isPlaying]);

  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    const subscribe = (
      eventName: string,
      onPayload: (payload: TrayPlacementRestored) => void,
    ) => {
      const register = async () => {
        try {
          return await listen<TrayPlacementRestored>(eventName, ({ payload }) => {
            if (!disposed) onPayload(payload);
          });
        } catch (error) {
          console.error(`Failed to listen for ${eventName}:`, error);
        }
      };
      const registration = register();

      return async () => {
        const unlisten = await registration;
        if (!unlisten) return;
        try {
          await unlisten();
        } catch (error) {
          console.error(`Failed to unlisten from ${eventName}:`, error);
        }
      };
    };

    const acknowledgePlacementRestore = ({ trayGeneration }: TrayPlacementRestored) => {
      const currentGeneration = trayGenerationRef.current;
      if (currentGeneration !== null && trayGeneration <= currentGeneration) return;
      trayGenerationRef.current = trayGeneration;
      const transition = fullscreenTransitionRef.current;
      if (fullscreenPhaseRef.current === "entering" && transition?.entry) {
        // The old entry cannot affect the restored window. Don't wait for its IPC reply.
        transition.entry.invalidated = true;
        fullscreenTransitionRef.current = null;
      }
      setFullscreenError(null);
      setFullscreenPhase("windowed");
    };

    const unlistenHiddenToTray = subscribe("window-hidden-to-tray", (payload) => {
      videoRef.current?.pause();
      acknowledgePlacementRestore(payload);
    });
    const unlistenPlacementRestored = subscribe(
      "playback-placement-restored",
      acknowledgePlacementRestore,
    );

    return () => {
      disposed = true;
      void unlistenHiddenToTray();
      void unlistenPlacementRestored();
    };
  }, [setFullscreenPhase]);

  useEffect(() => {
    return () => {
      if (loadingTimeoutRef.current !== null) {
        clearTimeout(loadingTimeoutRef.current);
      }
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
    };
  }, []);

  return (
    <VideoContext.Provider
      value={{
        videoRef,
        currentTime,
        duration,
        isPlaying,
        isVideoLoading,
        volume,
        playbackRate,
        videoSrc,
        loadedFilePath,
        isCompareMode,
        compareVideos,
        compareSeekMode,
        play,
        pause,
        togglePlay,
        seek,
        setVolume,
        setPlaybackRate,
        loadVideo,
        clearPlayback,
        enterCompareMode,
        exitCompareMode,
        setCompareSeekMode,
        updateTime,
        updateDuration,
        syncIsPlaying,
        setVideoLoading,
        isFullscreen,
        fullscreenPhase,
        fullscreenError,
        toggleFullscreen,
        exitFullscreen,
      }}
    >
      {children}
    </VideoContext.Provider>
  );
}

export function useVideo() {
  const context = useContext(VideoContext);
  if (!context) {
    throw new Error("useVideo must be used within a VideoProvider");
  }
  return context;
}
