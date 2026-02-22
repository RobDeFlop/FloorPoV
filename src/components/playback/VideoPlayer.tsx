import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Clapperboard, FolderOpen, LoaderCircle, Maximize, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useVideo } from "../../contexts/VideoContext";
import { useRecording } from "../../contexts/RecordingContext";
import { useMarker } from "../../contexts/MarkerContext";
import { EventMarker } from "../events/EventMarker";
import { ControlIconButton } from "./ControlIconButton";

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
    loadVideo,
    toggleFullscreen,
    seek,
    updateTime,
    updateDuration,
    syncIsPlaying,
    setVideoLoading,
  } = useVideo();
  const { events } = useMarker();

  const { isRecording } = useRecording();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const speedMenuRef = useRef<HTMLDivElement>(null);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [volumeBeforeMute, setVolumeBeforeMute] = useState(1);

  const showVideo = Boolean(videoSrc) && !isRecording;

  const formatTime = (seconds: number) => {
    if (!seconds || isNaN(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const handleVolumeToggle = () => {
    if (volume === 0) {
      setVolume(volumeBeforeMute > 0 ? volumeBeforeMute : 1);
    } else {
      setVolumeBeforeMute(volume);
      setVolume(0);
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      loadVideo(url);
    }

    e.target.value = "";
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

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

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressRef.current || duration === 0) return;
    const rect = progressRef.current.getBoundingClientRect();
    const clickPosition = (e.clientX - rect.left) / rect.width;
    seek(clickPosition * duration);
  };

  return (
    <div className="h-full w-full">
      <div
        className="relative h-full w-full overflow-hidden bg-neutral-950/90"
        aria-busy={isVideoLoading}
      >
        {showVideo && (
          <video
            ref={videoRef}
            src={videoSrc || undefined}
            className="h-full w-full object-contain"
            preload="metadata"
            onLoadStart={() => {
              setVideoLoading(true);
              console.log("[VideoPlayer] Video load started", { src: videoSrc });
            }}
            onCanPlay={() => {
              setVideoLoading(false);
              console.log("[VideoPlayer] Video can play");
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
            }}
            onPlay={() => syncIsPlaying(true)}
            onPause={() => syncIsPlaying(false)}
            onEnded={() => syncIsPlaying(false)}
          />
        )}

        {showVideo && isVideoLoading && (
          <div
            className="absolute inset-0 z-10 flex cursor-wait flex-col items-center justify-center gap-2 bg-neutral-950/60 backdrop-blur-sm"
            role="status"
            aria-live="polite"
          >
            <LoaderCircle className="h-6 w-6 animate-spin text-emerald-200" />
            <p className="text-sm font-medium text-neutral-100">Loading recording...</p>
          </div>
        )}

        {!videoSrc && !isRecording && (
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <>
              <div className="mb-3 rounded-full border border-emerald-300/20 bg-emerald-500/10 p-2">
                <Clapperboard className="h-5 w-5 text-emerald-200" />
              </div>
              <p className="text-neutral-400">No recording loaded</p>
            </>
          </div>
        )}

        {showVideo && (
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-neutral-950/95 via-neutral-950/70 to-transparent p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <ControlIconButton
                label={isPlaying ? "Pause playback" : "Play recording"}
                onClick={togglePlay}
              >
                {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
              </ControlIconButton>

              <div className="flex items-center gap-2 sm:gap-3">
                <ControlIconButton
                  label={volume === 0 ? "Unmute audio" : "Mute audio"}
                  onClick={handleVolumeToggle}
                >
                  {volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                </ControlIconButton>

                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={volume}
                    onChange={(e) => setVolume(parseFloat(e.target.value))}
                    aria-label="Volume"
                    className="w-20 h-3 appearance-none cursor-pointer bg-transparent
                            [&::-webkit-slider-thumb]:appearance-none 
                            [&::-webkit-slider-thumb]:w-3 
                            [&::-webkit-slider-thumb]:h-3 
                            [&::-webkit-slider-thumb]:rounded-full 
                            [&::-webkit-slider-thumb]:bg-white
                            [&::-webkit-slider-thumb]:cursor-pointer
                            [&::-webkit-slider-thumb]:mt-[-4px]
                            [&::-webkit-slider-runnable-track]:h-1
                            [&::-webkit-slider-runnable-track]:bg-neutral-600
                            [&::-webkit-slider-runnable-track]:rounded-full"
                  />
                  <span className="w-8 text-right font-mono text-xs text-neutral-200">
                    {Math.round(volume * 100)}%
                  </span>
                </div>
              </div>

              <span className="text-xs font-mono text-white">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>

              <div
                ref={progressRef}
                className="group relative order-last h-2 w-full cursor-pointer rounded-full border border-emerald-300/10 bg-neutral-700/80 md:order-none md:min-w-0 md:flex-1"
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
                {events.map((event) => {
                  const position = duration > 0 ? (event.timestamp / duration) * 100 : 0;
                  return (
                    <button
                      key={event.id}
                      type="button"
                      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-sm p-0.5 text-neutral-200 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/70"
                      style={{ left: `${position}%` }}
                      onClick={(eventClick) => {
                        eventClick.stopPropagation();
                        seek(event.timestamp);
                      }}
                      aria-label={`Seek to marker at ${formatTime(event.timestamp)}`}
                    >
                      <EventMarker type={event.type} />
                    </button>
                  );
                })}
              </div>

              <div ref={speedMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setShowSpeedMenu(!showSpeedMenu)}
                  className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-100 transition-colors hover:text-emerald-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/70"
                  aria-haspopup="menu"
                  aria-expanded={showSpeedMenu}
                  aria-label="Playback speed"
                >
                  {playbackRate}x
                </button>
                {showSpeedMenu && (
                  <div className="absolute bottom-full left-0 mb-2 rounded border border-neutral-700 bg-neutral-900 py-1 shadow-lg" role="menu" aria-label="Playback speed options">
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
                        className={`block w-full text-left px-3 py-1 text-xs ${
                          playbackRate === rate
                            ? "text-emerald-300 bg-emerald-500/20"
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
                label="Toggle fullscreen"
                onClick={toggleFullscreen}
              >
                <Maximize className="w-5 h-5" />
              </ControlIconButton>

              <ControlIconButton
                label="Open video file"
                onClick={() => fileInputRef.current?.click()}
              >
                <FolderOpen className="w-5 h-5" />
              </ControlIconButton>
            </div>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        onChange={handleFileChange}
        className="hidden"
      />
    </div>
  );
}
