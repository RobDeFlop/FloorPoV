import { useRef, useState } from "react";
import { useVideo } from "../contexts/VideoContext";
import { useRecording } from "../contexts/RecordingContext";
import { usePreview } from "../hooks/usePreview";
import { Play, Pause, Volume2, VolumeX, Maximize, FolderOpen } from "lucide-react";

const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

export function VideoPlayer() {
  const {
    videoRef,
    currentTime,
    duration,
    isPlaying,
    volume,
    playbackRate,
    videoSrc,
    togglePlay,
    setVolume,
    setPlaybackRate,
    loadVideo,
    toggleFullscreen,
    updateTime,
    updateDuration,
    syncIsPlaying,
  } = useVideo();

  const {
    isPreviewing,
    isRecording,
    isInitializing,
    previewFrameUrl,
    captureWidth,
    captureHeight,
  } = useRecording();

  const canvasRef = usePreview({
    previewFrameUrl,
    width: captureWidth,
    height: captureHeight,
    enabled: isPreviewing || isRecording,
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [volumeBeforeMute, setVolumeBeforeMute] = useState(1);

  const showCanvas = isPreviewing || isRecording;
  const showVideo = !showCanvas && videoSrc;

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

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      loadVideo(url);
    }
  };

  return (
    <div className="w-full h-full flex flex-col items-center justify-center bg-neutral-950 relative">
      {showCanvas && (
        <canvas
          ref={canvasRef}
          className="max-w-full max-h-full"
          style={{ objectFit: "contain" }}
        />
      )}

      {showVideo && (
        <video
          ref={videoRef}
          src={videoSrc || undefined}
          className="max-w-full max-h-full"
          preload="metadata"
          onTimeUpdate={(e) => updateTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => updateDuration(e.currentTarget.duration)}
          onPlay={() => syncIsPlaying(true)}
          onPause={() => syncIsPlaying(false)}
          onEnded={() => syncIsPlaying(false)}
        />
      )}

      {!videoSrc && !showCanvas && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {isInitializing ? (
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
              <p className="text-neutral-400 text-sm">Starting preview...</p>
            </div>
          ) : (
            <>
              <p className="text-neutral-500 mb-4">No video loaded</p>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-200 transition-colors border border-neutral-700"
              >
                <FolderOpen className="w-4 h-4" />
                Open File
              </button>
            </>
          )}
        </div>
      )}

      {videoSrc && (
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-neutral-950/95 to-transparent p-4">
          <div className="flex items-center gap-6">
            <button
              onClick={togglePlay}
              className="text-white hover:text-neutral-300 transition-colors"
            >
              {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
            </button>

            <div className="flex items-center gap-3">
              <button
                onClick={handleVolumeToggle}
                className="text-white hover:text-neutral-300 transition-colors"
              >
                {volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
              </button>
              
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={volume}
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
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
                <span className="text-xs text-neutral-300 font-mono w-8 text-right">
                  {Math.round(volume * 100)}%
                </span>
              </div>
            </div>

            <span className="text-xs text-white font-mono">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>

            <div className="flex-1" />

            <div className="relative">
              <button
                onClick={() => setShowSpeedMenu(!showSpeedMenu)}
                className="text-xs text-neutral-100 hover:text-emerald-200 px-2 py-1 bg-neutral-800 rounded border border-neutral-700 transition-colors"
              >
                {playbackRate}x
              </button>
              {showSpeedMenu && (
                <div className="absolute bottom-full mb-2 left-0 bg-neutral-900 rounded shadow-lg py-1 border border-neutral-700">
                  {PLAYBACK_RATES.map((rate) => (
                    <button
                      key={rate}
                      onClick={() => {
                        setPlaybackRate(rate);
                        setShowSpeedMenu(false);
                      }}
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

            <button
              onClick={toggleFullscreen}
              className="text-white hover:text-neutral-300 transition-colors"
            >
              <Maximize className="w-5 h-5" />
            </button>

            <button
              onClick={() => fileInputRef.current?.click()}
              className="text-white hover:text-neutral-300 transition-colors"
              title="Open Video"
            >
              <FolderOpen className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}

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
