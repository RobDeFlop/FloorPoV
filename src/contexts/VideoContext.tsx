import { createContext, useContext, useState, useRef, useCallback, useEffect, ReactNode } from "react";
import { VIDEO_LOADING_TIMEOUT_MS, VOLUME_MAX, VOLUME_MIN } from "../types/settings";

interface VideoContextType {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  isVideoLoading: boolean;
  volume: number;
  playbackRate: number;
  videoSrc: string | null;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  seek: (time: number) => void;
  setVolume: (volume: number) => void;
  setPlaybackRate: (rate: number) => void;
  loadVideo: (src: string) => void;
  toggleFullscreen: () => void;
  updateTime: (time: number) => void;
  updateDuration: (duration: number) => void;
  syncIsPlaying: (playing: boolean) => void;
  setVideoLoading: (loading: boolean) => void;
}

const VideoContext = createContext<VideoContextType | null>(null);

export function VideoProvider({ children }: { children: ReactNode }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const loadingTimeoutRef = useRef<number | null>(null);
  const videoSrcRef = useRef<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isVideoLoading, setIsVideoLoading] = useState(false);
  const [volume, setVolumeState] = useState(1);
  const [playbackRate, setPlaybackRateState] = useState(1);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);

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
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
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

  const loadVideo = useCallback(
    (src: string) => {
      const currentSrc = videoSrcRef.current;
      if (src === currentSrc) {
        if (videoRef.current) {
          videoRef.current.pause();
          videoRef.current.currentTime = 0;
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
    [setVideoLoading]
  );

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

  const toggleFullscreen = useCallback(() => {
    void (async () => {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
          return;
        }

        const targetElement = videoRef.current?.parentElement ?? videoRef.current;
        await targetElement?.requestFullscreen();
      } catch (error) {
        console.error("Failed to toggle fullscreen:", error);
      }
    })();
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
        play,
        pause,
        togglePlay,
        seek,
        setVolume,
        setPlaybackRate,
        loadVideo,
        toggleFullscreen,
        updateTime,
        updateDuration,
        syncIsPlaying,
        setVideoLoading,
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
