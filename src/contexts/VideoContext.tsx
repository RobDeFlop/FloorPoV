import { createContext, useContext, useState, useRef, useCallback, ReactNode } from "react";

interface VideoContextType {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
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
}

const VideoContext = createContext<VideoContextType | null>(null);

export function VideoProvider({ children }: { children: ReactNode }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
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

  const setVolume = useCallback((vol: number) => {
    if (videoRef.current) {
      videoRef.current.volume = vol;
    }
    setVolumeState(vol);
  }, []);

  const setPlaybackRate = useCallback((rate: number) => {
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
    }
    setPlaybackRateState(rate);
  }, []);

  const loadVideo = useCallback((src: string) => {
    setVideoSrc(src);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (videoRef.current) {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        videoRef.current.requestFullscreen();
      }
    }
  }, []);

  return (
    <VideoContext.Provider
      value={{
        videoRef,
        currentTime,
        duration,
        isPlaying,
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
