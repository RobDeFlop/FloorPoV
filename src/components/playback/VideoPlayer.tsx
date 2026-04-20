import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Clapperboard,
  LoaderCircle,
  Maximize,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useVideo } from "../../contexts/VideoContext";
import { useRecording } from "../../contexts/RecordingContext";
import { ControlIconButton } from "./ControlIconButton";
import { formatTime } from "../../utils/format";

const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

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
    togglePlay,
    setVolume,
    setPlaybackRate,
    seek,
    updateTime,
    updateDuration,
    syncIsPlaying,
    setVideoLoading,
  } = useVideo();

  const { isRecording, recordingWarning } = useRecording();

  const inlineSurfaceHostRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const volumeRef = useRef<HTMLDivElement>(null);
  const speedMenuRef = useRef<HTMLDivElement>(null);
  const immersiveSurfaceRef = useRef<HTMLDivElement>(null);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [volumeBeforeMute, setVolumeBeforeMute] = useState(1);
  const [isImmersiveMode, setIsImmersiveMode] = useState(false);
  const [inlineSurfaceRect, setInlineSurfaceRect] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [videoNativeSize, setVideoNativeSize] = useState({ width: 0, height: 0 });
  const [devicePixelRatio, setDevicePixelRatio] = useState(() => window.devicePixelRatio || 1);
  const [immersiveViewportSize, setImmersiveViewportSize] = useState({ width: 0, height: 0 });

  const showVideo = Boolean(videoSrc) && !isRecording;
  const toggleImmersiveMode = () => {
    setIsImmersiveMode((currentValue) => !currentValue);
  };

  const inlineSurfaceStyle: CSSProperties | undefined = isImmersiveMode
    ? undefined
    : inlineSurfaceRect.width > 0 && inlineSurfaceRect.height > 0
      ? {
          left: `${inlineSurfaceRect.left}px`,
          top: `${inlineSurfaceRect.top}px`,
          width: `${inlineSurfaceRect.width}px`,
          height: `${inlineSurfaceRect.height}px`,
        }
      : { visibility: "hidden" };

  const handleVolumeToggle = () => {
    if (volume === 0) {
      setVolume(volumeBeforeMute > 0 ? volumeBeforeMute : 1);
    } else {
      setVolumeBeforeMute(volume);
      setVolume(0);
    }
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
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
  const playerSurfaceClassName = isImmersiveMode
    ? "fixed inset-0 z-[200] flex items-center justify-center overflow-hidden bg-neutral-950"
    : "fixed z-40 overflow-hidden bg-neutral-950/90";

  useEffect(() => {
    if (!showSpeedMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!speedMenuRef.current?.contains(event.target as Node)) {
        setShowSpeedMenu(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowSpeedMenu(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [showSpeedMenu]);

  useEffect(() => {
    if (!isImmersiveMode) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsImmersiveMode(false);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isImmersiveMode]);

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
    if (!videoSrc) {
      setVideoNativeSize({ width: 0, height: 0 });
    }
  }, [videoSrc]);

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

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressRef.current || duration === 0) return;
    const rect = progressRef.current.getBoundingClientRect();
    const clickPosition = (e.clientX - rect.left) / rect.width;
    seek(clickPosition * duration);
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
    <div
      ref={immersiveSurfaceRef}
      className={playerSurfaceClassName}
      style={inlineSurfaceStyle}
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
            preload="metadata"
            onLoadStart={() => {
              setVideoLoading(true);
            }}
            onCanPlay={() => {
              setVideoLoading(false);
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
            }}
            onTimeUpdate={(e) => updateTime(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => {
              setVideoLoading(false);
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

      {!videoSrc && !isRecording && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <>
            <div className="mb-3 rounded-full border border-white/20 bg-white/5 p-2">
              <Clapperboard className="h-5 w-5 text-neutral-200" />
            </div>
            <p className="text-neutral-400">No recording loaded</p>
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
          style={immersiveControlsStyle}
        >
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-3">
            <div className="flex items-center gap-2 sm:gap-3 md:shrink-0">
              <ControlIconButton
                label={isPlaying ? "Pause playback" : "Play recording"}
                onClick={togglePlay}
              >
                {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
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
                    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
                      event.preventDefault();
                      setVolume(Math.max(0, volume - 0.05));
                      return;
                    }

                    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
                      event.preventDefault();
                      setVolume(Math.min(1, volume + 0.05));
                      return;
                    }

                    if (event.key === "Home") {
                      event.preventDefault();
                      setVolume(0);
                      return;
                    }

                    if (event.key === "End") {
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
            </div>

            <div
              ref={progressRef}
              className="group relative h-2 w-full cursor-pointer rounded-full border border-white/15 bg-neutral-700/80 md:min-w-0 md:flex-1"
              onClick={handleProgressClick}
              onKeyDown={(event) => {
                if (duration <= 0) {
                  return;
                }

                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  seek(Math.max(0, currentTime - 5));
                }

                if (event.key === "ArrowRight") {
                  event.preventDefault();
                  seek(Math.min(duration, currentTime + 5));
                  return;
                }

                if (event.key === "Home") {
                  event.preventDefault();
                  seek(0);
                  return;
                }

                if (event.key === "End") {
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
            </div>

            <div className="flex items-center gap-2 md:shrink-0">
              <div ref={speedMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setShowSpeedMenu(!showSpeedMenu)}
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
                label={isImmersiveMode ? "Exit fullscreen" : "Toggle fullscreen"}
                onClick={toggleImmersiveMode}
              >
                <Maximize className="w-5 h-5" />
              </ControlIconButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div ref={inlineSurfaceHostRef} className="relative h-full w-full">
      {createPortal(playerSurface, document.body)}
    </div>
  );
}
