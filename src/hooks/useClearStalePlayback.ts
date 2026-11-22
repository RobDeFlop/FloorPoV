import { useEffect, useRef } from "react";
import { useMarker } from "../contexts/MarkerContext";
import { useVideo } from "../contexts/VideoContext";
import {
  compareFilePaths,
  shouldExitCompareMode,
  shouldPreserveCompareSession,
} from "../utils/compare-playback";
import { shouldClearStalePlayback } from "../utils/playback-session";

interface PlaybackRecordingItem {
  file_path: string;
}

export function useClearStalePlayback(
  recordings: PlaybackRecordingItem[],
  isListReady: boolean,
  onCleared?: () => void,
): void {
  const { loadedFilePath, videoSrc, clearPlayback, compareVideos, exitCompareMode } = useVideo();
  const { clearEvents } = useMarker();
  const onClearedRef = useRef(onCleared);
  onClearedRef.current = onCleared;

  useEffect(() => {
    if (!isListReady) {
      return;
    }

    const comparedFilePaths = compareFilePaths(compareVideos);
    if (shouldPreserveCompareSession(comparedFilePaths, recordings)) {
      return;
    }

    if (shouldExitCompareMode(comparedFilePaths, recordings)) {
      exitCompareMode();
      return;
    }

    if (shouldClearStalePlayback(loadedFilePath, Boolean(videoSrc), recordings)) {
      clearPlayback();
      clearEvents();
      onClearedRef.current?.();
    }
  }, [
    clearEvents,
    clearPlayback,
    compareVideos,
    exitCompareMode,
    isListReady,
    loadedFilePath,
    recordings,
    videoSrc,
  ]);
}
