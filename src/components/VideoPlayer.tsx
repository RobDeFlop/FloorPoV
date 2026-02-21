import { useRef, useState } from "react";
import { useVideo } from "../contexts/VideoContext";
import { useRecording } from "../contexts/RecordingContext";
import { usePreview } from "../hooks/usePreview";
import { Play, Pause, Volume2, VolumeX, Maximize, FolderOpen } from "lucide-react";

const PLACEHOLDER_VIDEO = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

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
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);

  const showCanvas = isPreviewing || isRecording;
  const showVideo = !showCanvas && videoSrc;

  const formatTime = (seconds: number) => {
    if (!seconds || isNaN(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
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
              <div className="w-8 h-8 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-neutral-400 text-sm">Starting preview...</p>
            </div>
          ) : (
            <>
              <p className="text-neutral-500 mb-4">No video loaded</p>
              <div className="flex gap-3">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-2 px-4 py-2 bg-neutral-700 hover:bg-neutral-600 rounded text-neutral-200 transition-colors"
                >
                  <FolderOpen className="w-4 h-4" />
                  Open File
                </button>
                <button
                  onClick={() => loadVideo(PLACEHOLDER_VIDEO)}
                  className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 rounded text-neutral-200 transition-colors"
                >
                  Load Sample
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {videoSrc && (
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4">
          <div className="flex items-center gap-4">
            <button
              onClick={togglePlay}
              className="text-white hover:text-neutral-300 transition-colors"
            >
              {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
            </button>

            <div
              className="relative flex items-center"
              onMouseEnter={() => setShowVolumeSlider(true)}
              onMouseLeave={() => setShowVolumeSlider(false)}
            >
              <button
                onClick={() => setVolume(volume === 0 ? 1 : 0)}
                className="text-white hover:text-neutral-300 transition-colors"
              >
                {volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
              </button>
              {showVolumeSlider && (
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={volume}
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  className="absolute left-7 w-20 h-1 accent-white cursor-pointer"
                />
              )}
            </div>

            <span className="text-xs text-white font-mono">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>

            <div className="relative">
              <button
                onClick={() => setShowSpeedMenu(!showSpeedMenu)}
                className="text-xs text-white hover:text-neutral-300 px-2 py-1 bg-neutral-700 rounded transition-colors"
              >
                {playbackRate}x
              </button>
              {showSpeedMenu && (
                <div className="absolute bottom-full mb-2 left-0 bg-neutral-800 rounded shadow-lg py-1">
                  {PLAYBACK_RATES.map((rate) => (
                    <button
                      key={rate}
                      onClick={() => {
                        setPlaybackRate(rate);
                        setShowSpeedMenu(false);
                      }}
                      className={`block w-full text-left px-3 py-1 text-xs ${
                        playbackRate === rate
                          ? "text-orange-400 bg-neutral-700"
                          : "text-neutral-300 hover:bg-neutral-700"
                      }`}
                    >
                      {rate}x
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex-1" />

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
