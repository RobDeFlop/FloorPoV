import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AlertTriangle,
  Camera,
  Clapperboard,
  Keyboard,
  ListVideo,
  LoaderCircle,
  Maximize,
  Minimize,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  StickyNote,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { KeyCode } from "../../types/key-code";
import { useVideo } from "../../contexts/VideoContext";
import { useRecording } from "../../contexts/RecordingContext";
import { useMarker } from "../../contexts/MarkerContext";
import { useSettings } from "../../contexts/SettingsContext";
import { EventMarker } from "../events/EventMarker";
import { EventTooltip } from "../events/EventTooltip";
import { NoteEditorDialog } from "../events/NoteEditorDialog";
import { PlaybackEventList } from "../events/PlaybackEventList";
import { ControlIconButton } from "./ControlIconButton";
import { ImportCombatLogControl } from "./ImportCombatLogControl";
import { EVENT_SEEK_OFFSET_SECONDS, isVideoSeekBarEvent, type GameEvent } from "../../types/events";
import { getErrorMessage } from "../../services/tauri";
import { formatTime } from "../../utils/format";
import { saveRecordingNote } from "../../utils/recording-notes";
import { screenshotFileStemFromPath } from "../../utils/playback-screenshot";
import {
  documentHasOpenModalDialog,
  isEditableKeyboardTarget,
  isPlayerKeyboardFocus,
  PlaybackShortcutAction,
  resolvePlaybackShortcut,
} from "../../utils/playback-shortcuts";
import { smoothTransition } from "../../lib/motion";

const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const FINE_SEEK_SECONDS = 1;
const COARSE_SEEK_SECONDS = 5;
const SKIP_SEEK_SECONDS = 10;
const FULLSCREEN_EVENTS_PANEL_WIDTH_PX = 320;
const FULLSCREEN_EVENTS_PANEL_ID = "fullscreen-events-panel";
const PLAYBACK_SHORTCUT_HELP_ID = "playback-shortcut-help";
const PLAYBACK_SHORTCUTS = [
  { keys: "Space", action: "Play / pause" },
  { keys: "J / L", action: "Seek 10 seconds back / forward" },
  { keys: "← / →", action: "Seek 1 second when the player is focused" },
  { keys: "Shift + ← / →", action: "Seek 5 seconds when the player is focused" },
  { keys: "Home / End", action: "Jump to start / end when the player is focused" },
  { keys: "S", action: "Save a screenshot of the current frame" },
  { keys: "N", action: "Add a note at the current time" },
];

export function VideoPlayer() {
  const {
    videoRef,
    currentTime,
    duration,
    isPlaying,
    isVideoLoading,
    volume,
    playbackRate,
    videoSrc,
    loadedFilePath,
    isFullscreen: isImmersiveMode,
    toggleFullscreen,
    exitFullscreen,
    fullscreenPhase,
    togglePlay,
    pause,
    setVolume,
    setPlaybackRate,
    seek,
    updateTime,
    updateDuration,
    syncIsPlaying,
    setVideoLoading,
  } = useVideo();

  const { isRecording, recordingWarning } = useRecording();
  const { addEvent, filteredEvents } = useMarker();
  const { settings } = useSettings();
  const reduceMotion = useReducedMotion();
  const prefersReducedMotion = reduceMotion !== false;

  const inlineSurfaceHostRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const volumeRef = useRef<HTMLDivElement>(null);
  const speedMenuRef = useRef<HTMLDivElement>(null);
  const shortcutHelpRef = useRef<HTMLDivElement>(null);
  const immersiveSurfaceRef = useRef<HTMLDivElement>(null);
  const fullscreenEventsTabRef = useRef<HTMLButtonElement>(null);
  const previousImmersiveModeRef = useRef(false);
  const tweenSurfaceUntilRef = useRef(0);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [volumeBeforeMute, setVolumeBeforeMute] = useState(1);
  const [isImmersiveLayerActive, setIsImmersiveLayerActive] = useState(false);
  const [isFullscreenEventsOpen, setIsFullscreenEventsOpen] = useState(false);
  const [inlineSurfaceRect, setInlineSurfaceRect] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [videoNativeSize, setVideoNativeSize] = useState({ width: 0, height: 0 });
  const [devicePixelRatio, setDevicePixelRatio] = useState(() => window.devicePixelRatio || 1);
  const [viewportSize, setViewportSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const [immersiveViewportSize, setImmersiveViewportSize] = useState({ width: 0, height: 0 });
  const [hoveredSeekBarEvent, setHoveredSeekBarEvent] = useState<GameEvent | null>(null);
  const [seekBarTooltipX, setSeekBarTooltipX] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [hoverPreview, setHoverPreview] = useState<{ time: number; x: number } | null>(null);
  const [isNoteEditorOpen, setIsNoteEditorOpen] = useState(false);
  const [noteEditorTimestamp, setNoteEditorTimestamp] = useState(0);
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
  const [screenshotNotice, setScreenshotNotice] = useState<{
    kind: "error" | "success";
    message: string;
  } | null>(null);
  const isCapturingScreenshotRef = useRef(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  const showVideo = Boolean(videoSrc) && !isRecording;
  const autoExitAttemptedRef = useRef(false);
  useEffect(() => {
    if (showVideo || fullscreenPhase === "windowed") {
      autoExitAttemptedRef.current = false;
      return;
    }
    if (fullscreenPhase === "fullscreen" && !autoExitAttemptedRef.current) {
      autoExitAttemptedRef.current = true;
      void exitFullscreen();
    }
  }, [showVideo, fullscreenPhase, exitFullscreen]);
  const controlsRef = useRef<HTMLDivElement>(null);
  const controlsHideTimeoutRef = useRef<number | null>(null);
  const [showControls, setShowControls] = useState(true);
  const resetControlsHideTimer = useCallback(() => {
    setShowControls(true);

    if (controlsHideTimeoutRef.current !== null) {
      window.clearTimeout(controlsHideTimeoutRef.current);
      controlsHideTimeoutRef.current = null;
    }

    if (isImmersiveMode) {
      controlsHideTimeoutRef.current = window.setTimeout(() => {
        if (!controlsRef.current?.contains(document.activeElement)) {
          setShowControls(false);
        }
        controlsHideTimeoutRef.current = null;
      }, 3000);
    }
  }, [isImmersiveMode]);

  useEffect(() => {
    if (!isImmersiveMode || !showVideo) {
      setShowControls(true);
      if (controlsHideTimeoutRef.current !== null) {
        window.clearTimeout(controlsHideTimeoutRef.current);
        controlsHideTimeoutRef.current = null;
      }
      return;
    }

    resetControlsHideTimer();
    return () => {
      if (controlsHideTimeoutRef.current !== null) {
        window.clearTimeout(controlsHideTimeoutRef.current);
        controlsHideTimeoutRef.current = null;
      }
    };
  }, [isImmersiveMode, resetControlsHideTimer, showVideo]);

  const canAddNote = showVideo && Boolean(loadedFilePath);

  const openNoteEditor = useCallback(() => {
    if (!canAddNote) {
      return;
    }

    pause();
    setNoteEditorTimestamp(currentTime);
    setNoteError(null);
    setIsNoteEditorOpen(true);
  }, [canAddNote, currentTime, pause]);

  const handleSaveNote = useCallback(async (text: string) => {
    if (!loadedFilePath || isSavingNote) {
      return;
    }

    setIsSavingNote(true);
    setNoteError(null);

    try {
      const savedNote = await saveRecordingNote({
        filePath: loadedFilePath,
        timestampSeconds: noteEditorTimestamp,
        text,
      });
      addEvent(savedNote);
      setIsNoteEditorOpen(false);
    } catch (error) {
      setNoteError(getErrorMessage(error) || "Could not save the note.");
    } finally {
      setIsSavingNote(false);
    }
  }, [addEvent, isSavingNote, loadedFilePath, noteEditorTimestamp]);
  const canShowFullscreenEvents = isImmersiveMode && showVideo && settings.showFullscreenEventsPanel;
  const toggleImmersiveMode = () => {
    void toggleFullscreen();
  };
  const toggleFullscreenEventsPanel = () => {
    setIsFullscreenEventsOpen((currentValue) => !currentValue);
  };

  const hasInlineSurfaceRect = inlineSurfaceRect.width > 0 && inlineSurfaceRect.height > 0;
  const surfacePosition = isImmersiveMode
    ? { left: 0, top: 0, width: viewportSize.width, height: viewportSize.height }
    : hasInlineSurfaceRect
      ? inlineSurfaceRect
      : null;
  const shouldTweenSurface =
    !prefersReducedMotion &&
    (previousImmersiveModeRef.current !== isImmersiveMode ||
      performance.now() < tweenSurfaceUntilRef.current);

  const handleVolumeToggle = useCallback(() => {
    if (volume === 0) {
      setVolume(volumeBeforeMute > 0 ? volumeBeforeMute : 1);
    } else {
      setVolumeBeforeMute(volume);
      setVolume(0);
    }
  }, [setVolume, volume, volumeBeforeMute]);

  const skipPlaybackBySeconds = useCallback((deltaSeconds: number) => {
    const videoElement = videoRef.current;
    if (!videoElement || !Number.isFinite(videoElement.duration) || videoElement.duration <= 0) {
      return;
    }

    seek(videoElement.currentTime + deltaSeconds);
  }, [seek, videoRef]);

  const capturePlaybackScreenshot = useCallback(async () => {
    if (isCapturingScreenshotRef.current || !showVideo) {
      return;
    }

    if (!settings.outputFolder) {
      setScreenshotNotice({
        kind: "error",
        message: "Choose an output folder in Settings before saving screenshots.",
      });
      return;
    }

    if (!loadedFilePath) {
      setScreenshotNotice({
        kind: "error",
        message: "Load a recording before capturing a screenshot.",
      });
      return;
    }

    isCapturingScreenshotRef.current = true;
    setIsCapturingScreenshot(true);
    setScreenshotNotice(null);

    try {
      const savedPath = await invoke<string>("save_playback_screenshot", {
        outputFolder: settings.outputFolder,
        recordingPath: loadedFilePath,
        timestampSeconds: currentTime,
        fileStem: screenshotFileStemFromPath(loadedFilePath),
      });
      setScreenshotNotice({
        kind: "success",
        message: `Saved to ${savedPath}`,
      });
    } catch (error) {
      setScreenshotNotice({
        kind: "error",
        message: getErrorMessage(error) || "Could not save the screenshot.",
      });
    } finally {
      isCapturingScreenshotRef.current = false;
      setIsCapturingScreenshot(false);
    }
  }, [currentTime, loadedFilePath, settings.outputFolder, showVideo]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const seekBarEvents = useMemo(() => {
    if (duration <= 0) {
      return [];
    }

    return filteredEvents.filter(isVideoSeekBarEvent);
  }, [duration, filteredEvents]);
  const volumeProgress = Math.max(0, Math.min(volume * 100, 100));
  const immersiveVideoStyle =
    isImmersiveMode &&
    videoNativeSize.width > 0 &&
    videoNativeSize.height > 0 &&
    immersiveViewportSize.width > 0 &&
    immersiveViewportSize.height > 0
      ? (() => {
          const safeDevicePixelRatio = Math.max(1, devicePixelRatio);
          const nativeCssWidth = Math.max(1, Math.floor(videoNativeSize.width / safeDevicePixelRatio));
          const nativeCssHeight = Math.max(1, Math.floor(videoNativeSize.height / safeDevicePixelRatio));
          const widthScale = immersiveViewportSize.width / nativeCssWidth;
          const heightScale = immersiveViewportSize.height / nativeCssHeight;
          const scale = Math.min(widthScale, heightScale, 1);

          return {
            width: `${Math.max(1, Math.floor(nativeCssWidth * scale))}px`,
            height: `${Math.max(1, Math.floor(nativeCssHeight * scale))}px`,
          };
        })()
      : undefined;
  const immersiveControlsStyle =
    isImmersiveMode && immersiveVideoStyle?.width
      ? { width: immersiveVideoStyle.width }
      : undefined;
  const playerSurfaceClassName = isImmersiveLayerActive
    ? "theme-on-media fixed z-[200] flex items-center justify-center overflow-hidden bg-neutral-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/45"
    : "theme-on-media fixed z-40 overflow-hidden bg-neutral-950/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/45";

  useEffect(() => {
    if (!showSpeedMenu && !showShortcutHelp) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const pointerTarget = event.target as Node;
      if (!speedMenuRef.current?.contains(pointerTarget)) {
        setShowSpeedMenu(false);
      }

      if (!shortcutHelpRef.current?.contains(pointerTarget)) {
        setShowShortcutHelp(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== KeyCode.Escape) {
        return;
      }

      if (showShortcutHelp) {
        setShowShortcutHelp(false);
        return;
      }

      if (showSpeedMenu) {
        setShowSpeedMenu(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [showShortcutHelp, showSpeedMenu]);

  useEffect(() => {
    if (!isImmersiveMode) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== KeyCode.Escape) {
        return;
      }

      if (showSpeedMenu || showShortcutHelp || isNoteEditorOpen) {
        return;
      }

      if (isFullscreenEventsOpen) {
        setIsFullscreenEventsOpen(false);
        window.requestAnimationFrame(() => {
          fullscreenEventsTabRef.current?.focus();
        });
        return;
      }

      void exitFullscreen();
    };

    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, [exitFullscreen, isFullscreenEventsOpen, isImmersiveMode, isNoteEditorOpen, showShortcutHelp, showSpeedMenu]);

  useEffect(() => {
    if (isImmersiveMode) {
      setIsImmersiveLayerActive(true);
      return;
    }

    if (prefersReducedMotion) {
      setIsImmersiveLayerActive(false);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setIsImmersiveLayerActive(false);
    }, smoothTransition.duration * 1000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isImmersiveMode, prefersReducedMotion]);

  useEffect(() => {
    if (previousImmersiveModeRef.current === isImmersiveMode) {
      return;
    }

    if (!prefersReducedMotion) {
      tweenSurfaceUntilRef.current = performance.now() + smoothTransition.duration * 1000;
    }

    previousImmersiveModeRef.current = isImmersiveMode;
  }, [isImmersiveMode, prefersReducedMotion]);

  useEffect(() => {
    if (!canShowFullscreenEvents) {
      setIsFullscreenEventsOpen(false);
    }
  }, [canShowFullscreenEvents]);

  useEffect(() => {
    if (!showVideo) {
      return;
    }

    const handlePlaybackShortcut = (event: KeyboardEvent) => {
      if (
        !event.defaultPrevented &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !isEditableKeyboardTarget(event.target) &&
        !documentHasOpenModalDialog() &&
        event.key.toLowerCase() === KeyCode.S
      ) {
        event.preventDefault();
        void capturePlaybackScreenshot();
        return;
      }

      if (
        !event.defaultPrevented &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !isEditableKeyboardTarget(event.target) &&
        !documentHasOpenModalDialog() &&
        event.key.toLowerCase() === KeyCode.N
      ) {
        event.preventDefault();
        openNoteEditor();
        return;
      }

      if (!event.defaultPrevented && !event.repeat && !event.ctrlKey && !event.altKey && !event.metaKey &&
          !isEditableKeyboardTarget(event.target) && !documentHasOpenModalDialog()) {
        if (event.key.toLowerCase() === KeyCode.M) {
          event.preventDefault();
          handleVolumeToggle();
          return;
        }
        if (event.key.toLowerCase() === KeyCode.F) {
          event.preventDefault();
          void toggleFullscreen();
          return;
        }
      }

      const action = resolvePlaybackShortcut(event, {
        isEditableTarget: isEditableKeyboardTarget(event.target),
        isModalDialogOpen: documentHasOpenModalDialog(),
        isPlayerFocused: isPlayerKeyboardFocus(
          immersiveSurfaceRef.current,
          event.target,
          document.activeElement,
        ),
      });

      if (!action) {
        return;
      }

      event.preventDefault();

      if (action === PlaybackShortcutAction.TogglePlay) {
        togglePlay();
        return;
      }

      if (action === PlaybackShortcutAction.SeekStart) {
        seek(0);
        return;
      }

      if (action === PlaybackShortcutAction.SeekEnd) {
        seek(duration);
        return;
      }

      const seekDeltaSeconds = {
        [PlaybackShortcutAction.SeekBack]: -SKIP_SEEK_SECONDS,
        [PlaybackShortcutAction.SeekForward]: SKIP_SEEK_SECONDS,
        [PlaybackShortcutAction.SeekBackFine]: -FINE_SEEK_SECONDS,
        [PlaybackShortcutAction.SeekForwardFine]: FINE_SEEK_SECONDS,
        [PlaybackShortcutAction.SeekBackCoarse]: -COARSE_SEEK_SECONDS,
        [PlaybackShortcutAction.SeekForwardCoarse]: COARSE_SEEK_SECONDS,
      }[action];

      skipPlaybackBySeconds(seekDeltaSeconds);
    };

    window.addEventListener("keydown", handlePlaybackShortcut);
    return () => {
      window.removeEventListener("keydown", handlePlaybackShortcut);
    };
  }, [handleVolumeToggle, toggleFullscreen, capturePlaybackScreenshot, duration, openNoteEditor, seek, showVideo, skipPlaybackBySeconds, togglePlay]);

  useEffect(() => {
    if (!showVideo) {
      syncIsPlaying(false);
      return;
    }

    const syncPlaybackState = () => {
      const videoElement = videoRef.current;
      if (!videoElement) {
        return;
      }

      syncIsPlaying(!videoElement.paused && !videoElement.ended);
    };

    syncPlaybackState();
    const syncTimeout = window.setTimeout(syncPlaybackState, 0);
    const syncFrame = window.requestAnimationFrame(syncPlaybackState);

    return () => {
      window.clearTimeout(syncTimeout);
      window.cancelAnimationFrame(syncFrame);
    };
  }, [isImmersiveMode, showVideo, syncIsPlaying, videoRef]);

  useEffect(() => {
    setPlaybackError(null);
    if (!videoSrc) {
      setVideoNativeSize({ width: 0, height: 0 });
    }

    setScreenshotNotice(null);
  }, [videoSrc]);

  useEffect(() => {
    if (screenshotNotice?.kind !== "success") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setScreenshotNotice(null);
    }, 3000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [screenshotNotice]);

  useEffect(() => {
    const updateInlineSurfaceRect = () => {
      const hostRect = inlineSurfaceHostRef.current?.getBoundingClientRect();
      if (!hostRect) {
        setInlineSurfaceRect({ left: 0, top: 0, width: 0, height: 0 });
        return;
      }

      const nextRect = {
        left: Math.round(hostRect.left),
        top: Math.round(hostRect.top),
        width: Math.max(0, Math.round(hostRect.width)),
        height: Math.max(0, Math.round(hostRect.height)),
      };

      setInlineSurfaceRect((currentRect) => {
        if (
          currentRect.left === nextRect.left &&
          currentRect.top === nextRect.top &&
          currentRect.width === nextRect.width &&
          currentRect.height === nextRect.height
        ) {
          return currentRect;
        }

        return nextRect;
      });
    };

    updateInlineSurfaceRect();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateInlineSurfaceRect);
      window.addEventListener("scroll", updateInlineSurfaceRect, true);
      return () => {
        window.removeEventListener("resize", updateInlineSurfaceRect);
        window.removeEventListener("scroll", updateInlineSurfaceRect, true);
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      updateInlineSurfaceRect();
    });

    if (inlineSurfaceHostRef.current) {
      resizeObserver.observe(inlineSurfaceHostRef.current);
    }

    window.addEventListener("resize", updateInlineSurfaceRect);
    window.addEventListener("scroll", updateInlineSurfaceRect, true);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateInlineSurfaceRect);
      window.removeEventListener("scroll", updateInlineSurfaceRect, true);
    };
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setDevicePixelRatio(window.devicePixelRatio || 1);
      setViewportSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    if (!isImmersiveMode || !showVideo) {
      setImmersiveViewportSize({ width: 0, height: 0 });
      return;
    }

    const updateViewportSize = () => {
      const surfaceRect = immersiveSurfaceRef.current?.getBoundingClientRect();
      if (!surfaceRect) {
        return;
      }

      const nextWidth = Math.max(0, Math.floor(surfaceRect.width));
      const nextHeight = Math.max(0, Math.floor(surfaceRect.height));

      setImmersiveViewportSize((currentSize) =>
        currentSize.width === nextWidth && currentSize.height === nextHeight
          ? currentSize
          : { width: nextWidth, height: nextHeight }
      );
    };

    updateViewportSize();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateViewportSize);
      return () => {
        window.removeEventListener("resize", updateViewportSize);
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      updateViewportSize();
    });

    if (immersiveSurfaceRef.current) {
      resizeObserver.observe(immersiveSurfaceRef.current);
    }

    window.addEventListener("resize", updateViewportSize);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateViewportSize);
    };
  }, [isImmersiveMode, showVideo]);

  const timeFromClientX = (clientX: number) => {
    if (!progressRef.current || duration <= 0) {
      return 0;
    }

    const rect = progressRef.current.getBoundingClientRect();
    if (rect.width <= 0) {
      return 0;
    }

    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * duration;
  };

  const handleProgressPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (duration <= 0) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    setIsScrubbing(true);
    const nextTime = timeFromClientX(event.clientX);
    setHoverPreview({ time: nextTime, x: event.clientX - event.currentTarget.getBoundingClientRect().left });
    seek(nextTime);
  };

  const handleProgressPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (duration <= 0) {
      return;
    }

    const barRect = event.currentTarget.getBoundingClientRect();
    const nextTime = timeFromClientX(event.clientX);
    setHoverPreview({ time: nextTime, x: event.clientX - barRect.left });

    if (isScrubbing) {
      seek(nextTime);
    }
  };

  const handleProgressPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsScrubbing(false);
  };

  const handleProgressPointerLeave = () => {
    if (!isScrubbing) {
      setHoverPreview(null);
    }
  };

  const handleSeekBarEventClick = (timestamp: number) => {
    seek(Math.max(0, timestamp - EVENT_SEEK_OFFSET_SECONDS));
  };

  const handleSeekBarEventHover = (event: GameEvent, mouseEvent: React.MouseEvent<HTMLButtonElement>) => {
    const markerRect = mouseEvent.currentTarget.getBoundingClientRect();
    const barRect = progressRef.current?.getBoundingClientRect();
    if (!barRect) {
      return;
    }

    setSeekBarTooltipX(markerRect.left - barRect.left + markerRect.width / 2);
    setHoveredSeekBarEvent(event);
  };

  const handleVolumeClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!volumeRef.current) {
      return;
    }

    const rect = volumeRef.current.getBoundingClientRect();
    const clickPosition = (e.clientX - rect.left) / rect.width;
    const nextVolume = Math.max(0, Math.min(clickPosition, 1));
    setVolume(nextVolume);
  };

  const playerSurface = (
    <motion.div
      ref={immersiveSurfaceRef}
      onPointerMove={resetControlsHideTimer}
      onFocusCapture={resetControlsHideTimer}
      onKeyDownCapture={resetControlsHideTimer}
      className={playerSurfaceClassName}
      tabIndex={showVideo ? 0 : undefined}
      role={showVideo ? "region" : undefined}
      aria-label={showVideo ? "Video player" : undefined}
      initial={false}
      animate={
        surfacePosition
          ? {
              left: surfacePosition.left,
              top: surfacePosition.top,
              width: surfacePosition.width,
              height: surfacePosition.height,
            }
          : undefined
      }
      style={surfacePosition ? undefined : { visibility: "hidden" }}
      transition={shouldTweenSurface ? smoothTransition : { duration: 0 }}
      aria-busy={isVideoLoading}
    >
      {showVideo && (
        <div
          className={
            isImmersiveMode
              ? "flex h-full w-full items-center justify-center overflow-hidden"
              : "h-full w-full"
          }
        >
          <video
            ref={videoRef}
            src={videoSrc || undefined}
            className={
              isImmersiveMode
                ? "block h-auto w-auto max-h-full max-w-full object-contain"
                : "h-full w-full object-contain"
            }
            style={immersiveVideoStyle}
            controls={false}
            playsInline
            disablePictureInPicture
            preload="auto"
            onPointerDown={() => {
              immersiveSurfaceRef.current?.focus({ preventScroll: true });
            }}
            onLoadStart={() => {
              setVideoLoading(true);
              setPlaybackError(null);
            }}
            onCanPlay={() => {
              setVideoLoading(false);
              setPlaybackError(null);
            }}
            onError={(event) => {
              setVideoLoading(false);
              const mediaError = event.currentTarget.error;
              console.error("[VideoPlayer] Video load error", {
                code: mediaError?.code,
                message: mediaError?.message,
                networkState: event.currentTarget.networkState,
                readyState: event.currentTarget.readyState,
                src: videoSrc,
              });

              // Switching or clearing recordings aborts the pending load, which is not a
              // playback failure the viewer needs to see.
              if (mediaError?.code === MediaError.MEDIA_ERR_ABORTED) {
                return;
              }

              setPlaybackError("This recording could not be played.");
            }}
            onTimeUpdate={(e) => updateTime(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => {
              setVideoLoading(false);
              setPlaybackError(null);
              updateDuration(e.currentTarget.duration);
              setVideoNativeSize({
                width: e.currentTarget.videoWidth,
                height: e.currentTarget.videoHeight,
              });
            }}
            onPlay={() => syncIsPlaying(true)}
            onPause={() => syncIsPlaying(false)}
            onEnded={() => {
              syncIsPlaying(false);
            }}
          />
        </div>
      )}

      {showVideo && playbackError && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-neutral-950/80 px-6 text-center">
          <AlertTriangle className="h-5 w-5 text-amber-200" />
          <p className="text-sm font-medium text-neutral-100">{playbackError}</p>
          <p className="text-xs text-neutral-400">
            The file may be unreadable, or the output folder is not allowed for playback.
          </p>
        </div>
      )}

      {showVideo && isVideoLoading && (
        <div
          className="absolute inset-0 z-10 flex cursor-wait flex-col items-center justify-center gap-2 bg-neutral-950/60 backdrop-blur-sm"
          role="status"
          aria-live="polite"
        >
          <LoaderCircle className="h-6 w-6 animate-spin text-neutral-200" />
          <p className="text-sm font-medium text-neutral-100">Loading recording...</p>
        </div>
      )}

      {isRecording && recordingWarning && (
        <div
          className="absolute left-3 right-3 top-3 z-20 inline-flex items-start gap-2 rounded-sm border border-amber-300/35 bg-amber-500/15 px-3 py-2 text-amber-100"
          role="status"
          aria-live="polite"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="text-xs leading-5">{recordingWarning}</p>
        </div>
      )}

      {screenshotNotice && (
        <div
          className={
            screenshotNotice.kind === "error"
              ? "absolute left-3 right-3 top-3 z-20 inline-flex items-start gap-2 rounded-sm border border-red-300/35 bg-red-500/15 px-3 py-2 text-red-100"
              : "absolute left-3 right-3 top-3 z-20 inline-flex items-start gap-2 rounded-sm border border-emerald-300/35 bg-emerald-500/15 px-3 py-2 text-emerald-100"
          }
          role={screenshotNotice.kind === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {screenshotNotice.kind === "error" ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <Camera className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <p className="min-w-0 flex-1 break-all text-xs leading-5">{screenshotNotice.message}</p>
          {screenshotNotice.kind === "error" && (
            <button
              type="button"
              className="rounded p-0.5 text-red-100 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
              onClick={() => setScreenshotNotice(null)}
              aria-label="Dismiss screenshot error"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      {!videoSrc && !isRecording && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <>
            <div className="mb-3 rounded-full border border-white/20 bg-white/5 p-2">
              <Clapperboard className="h-5 w-5 text-neutral-200" />
            </div>
            <p className="mt-1 text-sm text-neutral-200">Select a recording below</p>
          </>
        </div>
      )}

      {showVideo && (
        <div
          className={
            isImmersiveMode
              ? "absolute bottom-0 left-1/2 w-full -translate-x-1/2 bg-gradient-to-t from-neutral-950/95 via-neutral-950/70 to-transparent p-3 sm:p-4"
              : "absolute bottom-0 left-0 right-0 bg-gradient-to-t from-neutral-950/95 via-neutral-950/70 to-transparent p-3 sm:p-4"
          }
          ref={controlsRef}
          style={{ ...immersiveControlsStyle, visibility: showControls ? "visible" : "hidden" }}
        >
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-3">
            <div className="flex items-center gap-2 sm:gap-3 md:shrink-0">
              <ControlIconButton
                label="Skip back 10 seconds (J)"
                onClick={() => {
                  skipPlaybackBySeconds(-SKIP_SEEK_SECONDS);
                }}
                disabled={duration <= 0}
              >
                <SkipBack className="w-5 h-5" />
              </ControlIconButton>

              <ControlIconButton
                label={isPlaying ? "Pause playback (Space)" : "Play recording (Space)"}
                onClick={togglePlay}
              >
                {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
              </ControlIconButton>

              <ControlIconButton
                label="Skip forward 10 seconds (L)"
                onClick={() => {
                  skipPlaybackBySeconds(SKIP_SEEK_SECONDS);
                }}
                disabled={duration <= 0}
              >
                <SkipForward className="w-5 h-5" />
              </ControlIconButton>

              <ControlIconButton
                label={volume === 0 ? "Unmute audio" : "Mute audio"}
                onClick={handleVolumeToggle}
              >
                {volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
              </ControlIconButton>

              <div className="flex items-center gap-2">
                <div
                  ref={volumeRef}
                  className="group relative h-2 w-20 cursor-pointer rounded-full border border-white/15 bg-neutral-700/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
                  onClick={handleVolumeClick}
                  onKeyDown={(event) => {
                    if (event.key === KeyCode.ArrowLeft || event.key === KeyCode.ArrowDown) {
                      event.preventDefault();
                      setVolume(Math.max(0, volume - 0.05));
                      return;
                    }

                    if (event.key === KeyCode.ArrowRight || event.key === KeyCode.ArrowUp) {
                      event.preventDefault();
                      setVolume(Math.min(1, volume + 0.05));
                      return;
                    }

                    if (event.key === KeyCode.Home) {
                      event.preventDefault();
                      setVolume(0);
                      return;
                    }

                    if (event.key === KeyCode.End) {
                      event.preventDefault();
                      setVolume(1);
                    }
                  }}
                  role="slider"
                  aria-label="Volume"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(volumeProgress)}
                  aria-valuetext={`${Math.round(volumeProgress)}%`}
                  tabIndex={0}
                >
                  <div
                    className="h-full rounded-full bg-emerald-400/85 transition-colors"
                    style={{ width: `${volumeProgress}%` }}
                  />
                  <div
                    className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-emerald-100"
                    style={{ left: `calc(${volumeProgress}% - 6px)` }}
                  />
                </div>
              </div>

              <span className="text-xs font-mono text-white">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
              <span className="hidden text-[10px] uppercase tracking-[0.12em] text-neutral-500 sm:inline">
                Space play/pause · J/L ±10s
              </span>
            </div>

            <div
              ref={progressRef}
              className="group relative h-3 w-full cursor-pointer overflow-visible rounded-full border border-white/15 bg-neutral-700/80 md:min-w-0 md:flex-1"
              onPointerDown={handleProgressPointerDown}
              onPointerMove={handleProgressPointerMove}
              onPointerUp={handleProgressPointerUp}
              onPointerCancel={handleProgressPointerUp}
              onPointerLeave={handleProgressPointerLeave}
              onKeyDown={(event) => {
                if (duration <= 0) {
                  return;
                }

                const seekStep = event.shiftKey ? COARSE_SEEK_SECONDS : FINE_SEEK_SECONDS;

                if (event.key === KeyCode.ArrowLeft) {
                  event.preventDefault();
                  seek(Math.max(0, currentTime - seekStep));
                  return;
                }

                if (event.key === KeyCode.ArrowRight) {
                  event.preventDefault();
                  seek(Math.min(duration, currentTime + seekStep));
                  return;
                }

                if (event.key === KeyCode.Home) {
                  event.preventDefault();
                  seek(0);
                  return;
                }

                if (event.key === KeyCode.End) {
                  event.preventDefault();
                  seek(duration);
                }
              }}
              role="slider"
              aria-label="Timeline"
              aria-valuemin={0}
              aria-valuemax={Math.max(duration, 0)}
              aria-valuenow={Math.max(currentTime, 0)}
              aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
              tabIndex={0}
            >
              <div
                className="h-full rounded-full bg-emerald-400/85 transition-colors"
                style={{ width: `${progress}%` }}
              />
              <div
                className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-emerald-100 opacity-0 transition-opacity group-hover:opacity-100"
                style={{ left: `calc(${progress}% - 6px)` }}
              />
              {seekBarEvents.map((event) => {
                const position = (event.timestamp / duration) * 100;
                return (
                  <button
                    key={event.id}
                    type="button"
                    className="absolute top-1/2 z-10 -ml-2 -translate-y-1/2 rounded-sm p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
                    style={{ left: `${position}%` }}
                    onPointerDown={(mouseEvent) => {
                      mouseEvent.stopPropagation();
                    }}
                    onClick={(mouseEvent) => {
                      mouseEvent.stopPropagation();
                      handleSeekBarEventClick(event.timestamp);
                    }}
                    onMouseEnter={(mouseEvent) => handleSeekBarEventHover(event, mouseEvent)}
                    onMouseLeave={() => setHoveredSeekBarEvent(null)}
                    aria-label={`Seek to ${event.type} at ${formatTime(event.timestamp)}`}
                  >
                    <EventMarker type={event.type} variant="compact" />
                  </button>
                );
              })}
              <AnimatePresence>
                {hoveredSeekBarEvent ? (
                  <EventTooltip event={hoveredSeekBarEvent} x={seekBarTooltipX} />
                ) : (
                  hoverPreview && (
                    <div
                      className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-100"
                      style={{ left: hoverPreview.x }}
                    >
                      {formatTime(hoverPreview.time)}
                    </div>
                  )
                )}
              </AnimatePresence>
            </div>

            <div className="flex items-center gap-2 md:shrink-0">
              <ControlIconButton
                label="Add note (N)"
                onClick={openNoteEditor}
                disabled={!canAddNote}
              >
                <StickyNote className="w-5 h-5" />
              </ControlIconButton>
              <ImportCombatLogControl />
              <div ref={speedMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setShowShortcutHelp(false);
                    setShowSpeedMenu(!showSpeedMenu);
                  }}
                  className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-100 transition-colors hover:text-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
                  aria-haspopup="menu"
                  aria-expanded={showSpeedMenu}
                  aria-label="Playback speed"
                >
                  {playbackRate}x
                </button>
                {showSpeedMenu && (
                  <div
                    className="absolute bottom-full left-0 mb-2 rounded border border-neutral-700 bg-neutral-900 py-1 shadow-lg"
                    role="menu"
                    aria-label="Playback speed options"
                  >
                    {PLAYBACK_RATES.map((rate) => (
                      <button
                        key={rate}
                        type="button"
                        onClick={() => {
                          setPlaybackRate(rate);
                          setShowSpeedMenu(false);
                        }}
                        role="menuitemradio"
                        aria-checked={playbackRate === rate}
                        className={`block w-full px-3 py-1 text-left text-xs ${
                          playbackRate === rate
                            ? "bg-white/12 text-neutral-100"
                            : "text-neutral-300 hover:bg-neutral-800"
                        }`}
                      >
                        {rate}x
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <ControlIconButton
                label="Save screenshot (S)"
                onClick={() => {
                  void capturePlaybackScreenshot();
                }}
                disabled={duration <= 0 || isCapturingScreenshot || isVideoLoading}
              >
                {isCapturingScreenshot ? (
                  <LoaderCircle className="w-5 h-5 animate-spin" />
                ) : (
                  <Camera className="w-5 h-5" />
                )}
              </ControlIconButton>

              <div ref={shortcutHelpRef} className="relative">
                <ControlIconButton
                  label="Keyboard shortcuts"
                  onClick={() => {
                    setShowSpeedMenu(false);
                    setShowShortcutHelp((currentValue) => !currentValue);
                  }}
                  pressed={showShortcutHelp}
                  controls={PLAYBACK_SHORTCUT_HELP_ID}
                >
                  <Keyboard className="w-5 h-5" />
                </ControlIconButton>
                {showShortcutHelp && (
                  <div
                    id={PLAYBACK_SHORTCUT_HELP_ID}
                    className="absolute bottom-full right-0 mb-2 w-72 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 shadow-lg"
                    role="region"
                    aria-label="Keyboard shortcuts"
                  >
                    <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-400">
                      Keyboard shortcuts
                    </p>
                    <ul className="space-y-1.5">
                      {PLAYBACK_SHORTCUTS.map((shortcut) => (
                        <li
                          key={shortcut.keys}
                          className="flex items-start justify-between gap-3 text-xs text-neutral-200"
                        >
                          <kbd className="shrink-0 rounded border border-white/15 bg-black/30 px-1.5 py-0.5 font-mono text-[11px] text-neutral-100">
                            {shortcut.keys}
                          </kbd>
                          <span className="text-right text-neutral-300">{shortcut.action}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {canShowFullscreenEvents && (
                <ControlIconButton
                  label={isFullscreenEventsOpen ? "Hide events" : "Show events"}
                  onClick={toggleFullscreenEventsPanel}
                  pressed={isFullscreenEventsOpen}
                  controls={FULLSCREEN_EVENTS_PANEL_ID}
                >
                  <ListVideo className="w-5 h-5" />
                </ControlIconButton>
              )}

              <ControlIconButton
                label={isImmersiveMode ? "Exit fullscreen" : "Toggle fullscreen"}
                onClick={toggleImmersiveMode}
              >
                {isImmersiveMode ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
              </ControlIconButton>
            </div>
          </div>
        </div>
      )}

      {canShowFullscreenEvents && (
        <div className="pointer-events-none absolute inset-y-0 right-0 z-[210] flex">
          <motion.div
            className="pointer-events-none ml-auto flex h-full"
            initial={false}
            animate={{ x: isFullscreenEventsOpen ? 0 : FULLSCREEN_EVENTS_PANEL_WIDTH_PX }}
            transition={prefersReducedMotion ? { duration: 0 } : smoothTransition}
          >
            <button
              ref={fullscreenEventsTabRef}
              type="button"
              className="pointer-events-auto mt-[28vh] flex h-fit flex-col items-center gap-2 rounded-l-sm border border-r-0 border-white/15 bg-neutral-950/90 px-1.5 py-3 text-neutral-200 transition-colors hover:bg-neutral-900 hover:text-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
              onClick={toggleFullscreenEventsPanel}
              aria-expanded={isFullscreenEventsOpen}
              aria-controls={FULLSCREEN_EVENTS_PANEL_ID}
            >
              <ListVideo className="h-3.5 w-3.5" />
              <span
                className="text-[11px] font-medium uppercase tracking-[0.14em]"
                style={{ writingMode: "vertical-rl" }}
              >
                Events
              </span>
            </button>
            <div
              id={FULLSCREEN_EVENTS_PANEL_ID}
              className={`h-full ${isFullscreenEventsOpen ? "pointer-events-auto" : ""}`}
              style={{ width: FULLSCREEN_EVENTS_PANEL_WIDTH_PX }}
              inert={!isFullscreenEventsOpen}
              aria-hidden={!isFullscreenEventsOpen}
            >
              <PlaybackEventList variant="overlay" />
            </div>
          </motion.div>
        </div>
      )}
    </motion.div>
  );

  return (
    <div ref={inlineSurfaceHostRef} className="relative h-full w-full">
      {createPortal(playerSurface, document.body)}
      {isNoteEditorOpen
        ? createPortal(
            <NoteEditorDialog
              title="Add note"
              timestamp={noteEditorTimestamp}
              isSaving={isSavingNote}
              error={noteError}
              onSave={(text) => {
                void handleSaveNote(text);
              }}
              onCancel={() => {
                if (isSavingNote) {
                  return;
                }

                setIsNoteEditorOpen(false);
                setNoteError(null);
              }}
            />,
            document.body,
          )
        : null}
    </div>
  );
}
