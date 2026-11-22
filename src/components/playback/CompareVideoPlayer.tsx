import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  Columns2,
  Link2,
  Link2Off,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  XCircle,
} from "lucide-react";
import { useVideo } from "../../contexts/VideoContext";
import { VOLUME_MIN } from "../../types/settings";
import {
  COMPARE_SLOT_INDEXES,
  clampCompareVolume,
  clampMediaTime,
  compareClockSlotIndex,
  compareResyncTime,
  compareSeekTimes,
  otherCompareSlotIndex,
  sharedCompareDuration,
  shouldRestartSharedCompare,
  shouldResumeCompareSlot,
  type CompareSlotIndex,
} from "../../utils/compare-playback";
import { formatTime } from "../../utils/format";
import { ControlIconButton } from "./ControlIconButton";

const COMPARE_PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const COMPARE_SKIP_SECONDS = 10;
const COMPARE_FINE_SEEK_SECONDS = 1;
const COMPARE_COARSE_SEEK_SECONDS = 5;
const COMPARE_VOLUME_STEP = 0.05;

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

interface CompareSlotPlaybackState {
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  hasError: boolean;
}

type CompareSlotPlaybackStates = [CompareSlotPlaybackState, CompareSlotPlaybackState];

function createSlotPlaybackState(index: CompareSlotIndex): CompareSlotPlaybackState {
  return {
    currentTime: 0,
    duration: 0,
    volume: 1,
    // Only the first recording starts audible so the two soundtracks do not overlap.
    isMuted: index !== 0,
    hasError: false,
  };
}

function createSlotPlaybackStates(): CompareSlotPlaybackStates {
  return [createSlotPlaybackState(0), createSlotPlaybackState(1)];
}

interface CompareTimelineProps {
  label: string;
  currentTime: number;
  duration: number;
  onSeek: (time: number) => void;
}

function CompareTimeline({ label, currentTime, duration, onSeek }: CompareTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const timeFromClientX = (clientX: number): number => {
    const trackRect = trackRef.current?.getBoundingClientRect();
    if (!trackRect || trackRect.width <= 0) {
      return 0;
    }

    const ratio = Math.min(1, Math.max(0, (clientX - trackRect.left) / trackRect.width));
    return ratio * duration;
  };

  return (
    <div
      ref={trackRef}
      className="group relative h-2.5 w-full cursor-pointer rounded-full border border-white/15 bg-neutral-700/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
      onPointerDown={(event) => {
        if (duration <= 0) {
          return;
        }

        event.currentTarget.setPointerCapture(event.pointerId);
        setIsScrubbing(true);
        onSeek(timeFromClientX(event.clientX));
      }}
      onPointerMove={(event) => {
        if (!isScrubbing || duration <= 0) {
          return;
        }

        onSeek(timeFromClientX(event.clientX));
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }

        setIsScrubbing(false);
      }}
      onPointerCancel={() => {
        setIsScrubbing(false);
      }}
      onKeyDown={(event) => {
        if (duration <= 0) {
          return;
        }

        const seekStep = event.shiftKey ? COMPARE_COARSE_SEEK_SECONDS : COMPARE_FINE_SEEK_SECONDS;

        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onSeek(currentTime - seekStep);
          return;
        }

        if (event.key === "ArrowRight") {
          event.preventDefault();
          onSeek(currentTime + seekStep);
          return;
        }

        if (event.key === "Home") {
          event.preventDefault();
          onSeek(0);
          return;
        }

        if (event.key === "End") {
          event.preventDefault();
          onSeek(duration);
        }
      }}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.max(duration, 0)}
      aria-valuenow={Math.max(currentTime, 0)}
      aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
      tabIndex={0}
    >
      <div className="h-full rounded-full bg-emerald-400/85" style={{ width: `${progress}%` }} />
      <div
        className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-emerald-100 opacity-0 transition-opacity group-hover:opacity-100"
        style={{ left: `calc(${progress}% - 6px)` }}
      />
    </div>
  );
}

interface CompareVolumeSliderProps {
  label: string;
  volume: number;
  onVolumeChange: (volume: number) => void;
}

function CompareVolumeSlider({ label, volume, onVolumeChange }: CompareVolumeSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const volumeProgress = Math.max(0, Math.min(volume * 100, 100));

  return (
    <div
      ref={trackRef}
      className="relative h-2 w-20 cursor-pointer rounded-full border border-white/15 bg-neutral-700/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
      onClick={(event) => {
        const trackRect = trackRef.current?.getBoundingClientRect();
        if (!trackRect || trackRect.width <= 0) {
          return;
        }

        onVolumeChange((event.clientX - trackRect.left) / trackRect.width);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
          event.preventDefault();
          onVolumeChange(volume - COMPARE_VOLUME_STEP);
          return;
        }

        if (event.key === "ArrowRight" || event.key === "ArrowUp") {
          event.preventDefault();
          onVolumeChange(volume + COMPARE_VOLUME_STEP);
          return;
        }

        if (event.key === "Home") {
          event.preventDefault();
          onVolumeChange(0);
          return;
        }

        if (event.key === "End") {
          event.preventDefault();
          onVolumeChange(1);
        }
      }}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(volumeProgress)}
      aria-valuetext={`${Math.round(volumeProgress)}%`}
      tabIndex={0}
    >
      <div
        className="h-full rounded-full bg-emerald-400/85"
        style={{ width: `${volumeProgress}%` }}
      />
      <div
        className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-emerald-100"
        style={{ left: `calc(${volumeProgress}% - 6px)` }}
      />
    </div>
  );
}

export function CompareVideoPlayer() {
  const { compareVideos, compareSeekMode, setCompareSeekMode, exitCompareMode } = useVideo();
  const videoElementsRef = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null]);
  const speedMenuRef = useRef<HTMLDivElement>(null);
  const [slotStates, setSlotStates] = useState<CompareSlotPlaybackStates>(createSlotPlaybackStates);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);

  const isSharedSeek = compareSeekMode === "shared";

  const updateSlotState = useCallback(
    (index: CompareSlotIndex, patch: Partial<CompareSlotPlaybackState>) => {
      setSlotStates((currentStates) => {
        const nextStates: CompareSlotPlaybackStates = [currentStates[0], currentStates[1]];
        nextStates[index] = { ...nextStates[index], ...patch };
        return nextStates;
      });
    },
    [],
  );

  const syncPlayingState = useCallback(() => {
    const isAnySlotPlaying = videoElementsRef.current.some((element) => {
      return element !== null && !element.paused && !element.ended;
    });
    setIsPlaying(isAnySlotPlaying);
  }, []);

  const readSharedTime = useCallback((): number => {
    const [leftElement, rightElement] = videoElementsRef.current;
    const clockIndex = compareClockSlotIndex(
      leftElement?.duration ?? 0,
      rightElement?.duration ?? 0,
    );
    return videoElementsRef.current[clockIndex]?.currentTime ?? 0;
  }, []);

  const seekBothSlots = useCallback((time: number) => {
    const [leftElement, rightElement] = videoElementsRef.current;
    const { leftTime, rightTime } = compareSeekTimes(
      time,
      leftElement?.duration ?? 0,
      rightElement?.duration ?? 0,
    );

    if (leftElement) {
      leftElement.currentTime = leftTime;
    }

    if (rightElement) {
      rightElement.currentTime = rightTime;
    }

    setSlotStates((currentStates) => [
      { ...currentStates[0], currentTime: leftTime },
      { ...currentStates[1], currentTime: rightTime },
    ]);
  }, []);

  const seekSlot = useCallback(
    (index: CompareSlotIndex, time: number) => {
      const element = videoElementsRef.current[index];
      if (!element) {
        return;
      }

      const nextTime = clampMediaTime(time, element.duration);
      element.currentTime = nextTime;
      updateSlotState(index, { currentTime: nextTime });
    },
    [updateSlotState],
  );

  const skipBySeconds = useCallback(
    (deltaSeconds: number) => {
      if (isSharedSeek) {
        seekBothSlots(readSharedTime() + deltaSeconds);
        return;
      }

      COMPARE_SLOT_INDEXES.forEach((index) => {
        const element = videoElementsRef.current[index];
        if (!element) {
          return;
        }

        seekSlot(index, element.currentTime + deltaSeconds);
      });
    },
    [isSharedSeek, readSharedTime, seekBothSlots, seekSlot],
  );

  const togglePlayAll = useCallback(() => {
    const shouldPause = videoElementsRef.current.some((element) => {
      return element !== null && !element.paused;
    });

    if (shouldPause) {
      videoElementsRef.current.forEach((element) => {
        element?.pause();
      });
      return;
    }

    const [leftElement, rightElement] = videoElementsRef.current;
    if (isSharedSeek) {
      const resumeTime = shouldRestartSharedCompare(
        Boolean(leftElement?.ended),
        Boolean(rightElement?.ended),
      )
        ? 0
        : readSharedTime();
      seekBothSlots(resumeTime);

      COMPARE_SLOT_INDEXES.forEach((index) => {
        const element = videoElementsRef.current[index];
        if (!element || !shouldResumeCompareSlot(resumeTime, element.duration)) {
          return;
        }

        element.play().catch((playError: unknown) => {
          console.error("[CompareVideoPlayer] Could not start playback", playError);
        });
      });
      return;
    }

    videoElementsRef.current.forEach((element) => {
      if (!element) {
        return;
      }

      element.play().catch((playError: unknown) => {
        console.error("[CompareVideoPlayer] Could not start playback", playError);
      });
    });
  }, [isSharedSeek, readSharedTime, seekBothSlots]);

  const toggleSlotMute = useCallback(
    (index: CompareSlotIndex) => {
      const element = videoElementsRef.current[index];
      if (!element) {
        return;
      }

      const nextMuted = !element.muted;
      element.muted = nextMuted;
      updateSlotState(index, { isMuted: nextMuted });
    },
    [updateSlotState],
  );

  const setSlotVolume = useCallback(
    (index: CompareSlotIndex, volume: number) => {
      const nextVolume = clampCompareVolume(volume);
      const shouldUnmute = nextVolume > VOLUME_MIN;
      const element = videoElementsRef.current[index];

      if (element) {
        element.volume = nextVolume;
        if (shouldUnmute) {
          element.muted = false;
        }
      }

      updateSlotState(
        index,
        shouldUnmute ? { volume: nextVolume, isMuted: false } : { volume: nextVolume },
      );
    },
    [updateSlotState],
  );

  useEffect(() => {
    setSlotStates(createSlotPlaybackStates());
    setIsPlaying(false);
  }, [compareVideos]);

  useEffect(() => {
    videoElementsRef.current.forEach((element) => {
      if (element) {
        element.playbackRate = playbackRate;
      }
    });
  }, [playbackRate]);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }

    let frameId = 0;
    const syncPlaybackFrame = () => {
      const [leftElement, rightElement] = videoElementsRef.current;

      if (isSharedSeek && leftElement && rightElement) {
        const clockIndex = compareClockSlotIndex(leftElement.duration, rightElement.duration);
        const trailingIndex = otherCompareSlotIndex(clockIndex);
        const clockElement = videoElementsRef.current[clockIndex];
        const trailingElement = videoElementsRef.current[trailingIndex];

        if (clockElement && trailingElement) {
          const resyncTime = compareResyncTime(
            clockElement.currentTime,
            trailingElement.currentTime,
            trailingElement.duration,
          );

          if (resyncTime !== null) {
            trailingElement.currentTime = resyncTime;
          }
        }
      }

      setSlotStates((currentStates) => {
        const leftTime = leftElement?.currentTime ?? currentStates[0].currentTime;
        const rightTime = rightElement?.currentTime ?? currentStates[1].currentTime;

        if (
          leftTime === currentStates[0].currentTime &&
          rightTime === currentStates[1].currentTime
        ) {
          return currentStates;
        }

        return [
          { ...currentStates[0], currentTime: leftTime },
          { ...currentStates[1], currentTime: rightTime },
        ];
      });

      frameId = window.requestAnimationFrame(syncPlaybackFrame);
    };

    frameId = window.requestAnimationFrame(syncPlaybackFrame);
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [isPlaying, isSharedSeek]);

  useEffect(() => {
    if (!showSpeedMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!speedMenuRef.current?.contains(event.target as Node)) {
        setShowSpeedMenu(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [showSpeedMenu]);

  useEffect(() => {
    const unlistenHiddenToTray = listen("window-hidden-to-tray", () => {
      videoElementsRef.current.forEach((element) => {
        element?.pause();
      });
    });

    return () => {
      unlistenHiddenToTray.then((unsubscribe) => unsubscribe());
    };
  }, []);

  useEffect(() => {
    const handleSkipShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      if (isEditableKeyboardTarget(event.target)) {
        return;
      }

      if (event.key === "j" || event.key === "J") {
        event.preventDefault();
        skipBySeconds(-COMPARE_SKIP_SECONDS);
        return;
      }

      if (event.key === "l" || event.key === "L") {
        event.preventDefault();
        skipBySeconds(COMPARE_SKIP_SECONDS);
      }
    };

    window.addEventListener("keydown", handleSkipShortcut);
    return () => {
      window.removeEventListener("keydown", handleSkipShortcut);
    };
  }, [skipBySeconds]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }

      if (showSpeedMenu) {
        setShowSpeedMenu(false);
        return;
      }

      // A confirmation dialog owns Escape while it is open, so compare mode stays put.
      if (document.querySelector('[role="dialog"]')) {
        return;
      }

      exitCompareMode();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [exitCompareMode, showSpeedMenu]);

  if (!compareVideos) {
    return null;
  }

  const sharedDuration = sharedCompareDuration(slotStates[0].duration, slotStates[1].duration);
  const clockSlotIndex = compareClockSlotIndex(slotStates[0].duration, slotStates[1].duration);
  const sharedTime = slotStates[clockSlotIndex].currentTime;
  const hasPlayableDuration = sharedDuration > 0;

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-neutral-950/70">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-(--surface-1) px-3 py-2">
        <div className="inline-flex min-w-0 items-center gap-2">
          <Columns2 className="h-4 w-4 shrink-0 text-neutral-300" />
          <h2 className="truncate text-sm font-medium text-neutral-100">Compare mode</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setCompareSeekMode(isSharedSeek ? "dual" : "shared");
            }}
            aria-pressed={isSharedSeek}
            title={
              isSharedSeek
                ? "Both recordings follow one timeline"
                : "Each recording keeps its own timeline"
            }
            className="inline-flex h-7 items-center gap-1 rounded-sm border border-white/20 bg-black/20 px-2 text-xs text-neutral-200 transition-colors hover:bg-white/10 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
          >
            {isSharedSeek ? (
              <Link2 className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <Link2Off className="h-3.5 w-3.5 shrink-0" />
            )}
            {isSharedSeek ? "Shared seek" : "Dual seek"}
          </button>
          <button
            type="button"
            onClick={exitCompareMode}
            className="inline-flex h-7 items-center gap-1 rounded-sm border border-white/20 bg-black/20 px-2 text-xs text-neutral-200 transition-colors hover:bg-white/10 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
          >
            <XCircle className="h-3.5 w-3.5 shrink-0" />
            Exit compare
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 p-2 md:grid-cols-2">
        {COMPARE_SLOT_INDEXES.map((index) => {
          const slot = compareVideos[index];
          const slotState = slotStates[index];

          return (
            <div
              key={`${index}-${slot.filePath}`}
              className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-sm border border-white/10 bg-black/30"
            >
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-2 py-1.5">
                <p className="min-w-0 truncate text-xs text-neutral-200" title={slot.title}>
                  {slot.title}
                </p>
                <span className="shrink-0 font-mono text-[11px] text-neutral-400">
                  {formatTime(slotState.currentTime)} / {formatTime(slotState.duration)}
                </span>
              </div>

              <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-neutral-950">
                <video
                  ref={(element) => {
                    videoElementsRef.current[index] = element;
                    return () => {
                      element?.pause();
                      videoElementsRef.current[index] = null;
                    };
                  }}
                  src={slot.src}
                  className="h-full w-full object-contain"
                  controls={false}
                  playsInline
                  disablePictureInPicture
                  preload="auto"
                  muted={slotState.isMuted}
                  onLoadedMetadata={(event) => {
                    const element = event.currentTarget;
                    element.volume = slotState.volume;
                    element.muted = slotState.isMuted;
                    element.playbackRate = playbackRate;
                    updateSlotState(index, { duration: element.duration, hasError: false });
                  }}
                  onTimeUpdate={(event) => {
                    updateSlotState(index, { currentTime: event.currentTarget.currentTime });
                  }}
                  onPlay={syncPlayingState}
                  onPause={syncPlayingState}
                  onEnded={syncPlayingState}
                  onError={(event) => {
                    const mediaError = event.currentTarget.error;
                    console.error("[CompareVideoPlayer] Video load error", {
                      code: mediaError?.code,
                      message: mediaError?.message,
                      filePath: slot.filePath,
                    });

                    // Swapping the compared recordings aborts the pending load, which is
                    // not a failure the viewer needs to see.
                    if (mediaError?.code === MediaError.MEDIA_ERR_ABORTED) {
                      return;
                    }

                    updateSlotState(index, { hasError: true });
                  }}
                />

                {slotState.hasError && (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-neutral-950/80 px-4 text-center">
                    <AlertTriangle className="h-5 w-5 text-amber-200" />
                    <p className="text-xs font-medium text-neutral-100">
                      This recording could not be played.
                    </p>
                  </div>
                )}
              </div>

              <div className="flex shrink-0 flex-col gap-1.5 border-t border-white/10 px-2 py-1.5">
                {!isSharedSeek && (
                  <CompareTimeline
                    label={`Timeline for ${slot.title}`}
                    currentTime={slotState.currentTime}
                    duration={slotState.duration}
                    onSeek={(time) => {
                      seekSlot(index, time);
                    }}
                  />
                )}
                <div className="flex items-center gap-2">
                  <ControlIconButton
                    label={
                      slotState.isMuted
                        ? `Unmute audio for ${slot.title}`
                        : `Mute audio for ${slot.title}`
                    }
                    onClick={() => {
                      toggleSlotMute(index);
                    }}
                  >
                    {slotState.isMuted ? (
                      <VolumeX className="h-4 w-4" />
                    ) : (
                      <Volume2 className="h-4 w-4" />
                    )}
                  </ControlIconButton>
                  <CompareVolumeSlider
                    label={`Volume for ${slot.title}`}
                    volume={slotState.volume}
                    onVolumeChange={(volume) => {
                      setSlotVolume(index, volume);
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="shrink-0 border-t border-white/10 bg-neutral-950/85 px-3 py-2">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
          <div className="flex items-center gap-2 md:shrink-0">
            <ControlIconButton
              label="Skip both back 10 seconds"
              onClick={() => {
                skipBySeconds(-COMPARE_SKIP_SECONDS);
              }}
              disabled={!hasPlayableDuration}
            >
              <SkipBack className="h-5 w-5" />
            </ControlIconButton>

            <ControlIconButton
              label={isPlaying ? "Pause both recordings" : "Play both recordings"}
              onClick={togglePlayAll}
            >
              {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
            </ControlIconButton>

            <ControlIconButton
              label="Skip both forward 10 seconds"
              onClick={() => {
                skipBySeconds(COMPARE_SKIP_SECONDS);
              }}
              disabled={!hasPlayableDuration}
            >
              <SkipForward className="h-5 w-5" />
            </ControlIconButton>

            <span className="font-mono text-xs text-white">
              {formatTime(sharedTime)} / {formatTime(sharedDuration)}
            </span>
          </div>

          {isSharedSeek ? (
            <div className="md:min-w-0 md:flex-1">
              <CompareTimeline
                label="Shared timeline"
                currentTime={sharedTime}
                duration={sharedDuration}
                onSeek={seekBothSlots}
              />
            </div>
          ) : (
            <p className="text-[11px] text-neutral-400 md:min-w-0 md:flex-1">
              Dual seek is on. Scrub each recording with its own timeline.
            </p>
          )}

          <div ref={speedMenuRef} className="relative md:shrink-0">
            <button
              type="button"
              onClick={() => {
                setShowSpeedMenu((currentValue) => !currentValue);
              }}
              className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-100 transition-colors hover:text-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
              aria-haspopup="menu"
              aria-expanded={showSpeedMenu}
              aria-label="Playback speed for both recordings"
            >
              {playbackRate}x
            </button>
            {showSpeedMenu && (
              <div
                className="absolute bottom-full right-0 mb-2 rounded border border-neutral-700 bg-neutral-900 py-1 shadow-lg"
                role="menu"
                aria-label="Playback speed options"
              >
                {COMPARE_PLAYBACK_RATES.map((rate) => (
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
        </div>
      </div>
    </div>
  );
}
