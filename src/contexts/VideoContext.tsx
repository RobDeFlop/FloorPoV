import { createContext, useContext, useState, useRef, useCallback, useEffect, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
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
  const fullscreenTransitionRef = useRef<Promise<void> | null>(null);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const needsPlacementRestoreRef = useRef(false);
  const closeAfterFullscreenExitRef = useRef(false);
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

  const restorePlaybackWindow = useCallback(async () => {
    try {
      await invoke<void>("exit_playback_fullscreen");
      needsPlacementRestoreRef.current = false;
      setFullscreenPhase("windowed");
    } catch (error) {
      console.error("Fullscreen exit failed:", error);
      setFullscreenError("Could not restore the playback window.");
      needsPlacementRestoreRef.current = true;
      // Playback fullscreen uses Win32 monitor bounds, not Tauri's fullscreen flag.
      try {
        const appWindow = getCurrentWindow();
        const [monitor, position, size] = await Promise.all([
          currentMonitor(), appWindow.outerPosition(), appWindow.outerSize(),
        ]);
        if (!monitor) throw new Error("No current monitor");
        const coversMonitor = (
          position.x === monitor.position.x && position.y === monitor.position.y &&
          size.width === monitor.size.width && size.height === monitor.size.height
        );
        setFullscreenPhase(coversMonitor ? "fullscreen" : "windowed");
      } catch (queryError) {
        console.error("Could not check playback window bounds:", queryError);
        // Keep Exit available so the user can retry the native restore.
        setFullscreenPhase("fullscreen");
      }
    }
  }, [setFullscreenPhase]);

  const exitFullscreen = useCallback(async () => {
    if (!isTauri()) return;
    await fullscreenTransitionRef.current;
    if (fullscreenPhaseRef.current !== "fullscreen") return;

    setFullscreenError(null);
    setFullscreenPhase("exiting");
    const transition = restorePlaybackWindow();
    fullscreenTransitionRef.current = transition;
    try {
      await transition;
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
    if (fullscreenPhaseRef.current !== "windowed") return;

    setFullscreenError(null);
    setFullscreenPhase("entering");
    const transition = (async () => {
      try {
        // A failed frame refresh can leave a saved native placement in a windowed UI.
        if (needsPlacementRestoreRef.current) {
          await invoke<void>("exit_playback_fullscreen");
          needsPlacementRestoreRef.current = false;
        }
        await invoke<void>("enter_playback_fullscreen");
        setFullscreenPhase("fullscreen");
      } catch (error) {
        console.error("Fullscreen entry failed:", error);
        setFullscreenError("Could not enter fullscreen.");
        await restorePlaybackWindow();
      }
    })();
    fullscreenTransitionRef.current = transition;
    try {
      await transition;
    } finally {
      if (fullscreenTransitionRef.current === transition) {
        fullscreenTransitionRef.current = null;
      }
    }
  }, [exitFullscreen, restorePlaybackWindow, setFullscreenPhase]);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    const appWindow = getCurrentWindow();
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    void appWindow
      .onCloseRequested((event) => {
        if (
          fullscreenPhaseRef.current === "windowed" ||
          closeAfterFullscreenExitRef.current
        ) {
          return;
        }

        event.preventDefault();
        closeAfterFullscreenExitRef.current = true;

        void (async () => {
          try {
            await exitFullscreen();

            if (fullscreenPhaseRef.current === "windowed") {
              await appWindow.close();
              return;
            }
          } finally {
            closeAfterFullscreenExitRef.current = false;
          }
        })();
      })
      .then((unlisten) => {
        if (isCancelled) {
          unlisten();
        } else {
          unsubscribe = unlisten;
        }
      })
      .catch((error) => {
        console.error("Fullscreen close listener failed:", error);
      });

    return () => {
      isCancelled = true;
      unsubscribe?.();
    };
  }, [exitFullscreen]);

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
    const unlistenHiddenToTray = listen("window-hidden-to-tray", () => {
      videoRef.current?.pause();
    });

    return () => {
      unlistenHiddenToTray.then((unsubscribe) => unsubscribe());
    };
  }, []);

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
