import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithRef,
} from "react";
import { listen } from "@tauri-apps/api/event";
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
  shouldRestartBothRecordings,
  shouldResumeCompareSlot,
  type CompareSeekMode,
  type CompareSlotIndex,
  type CompareVideoSlot,
} from "../../utils/compare-playback";

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

type CompareVideoProps = Pick<
  ComponentPropsWithRef<"video">,
  "ref" | "muted" | "onLoadedMetadata" | "onTimeUpdate" | "onSeeked" |
  "onPlay" | "onPause" | "onEnded" | "onError"
>;

// "rejoin" follows a playing peer. "play" is a Play request with no running peer yet.
type SharedSeekIntent = "rejoin" | "play" | null;

interface ComparePlayback {
  slots: (CompareSlotPlaybackState & { videoProps: CompareVideoProps })[];
  isPlaying: boolean;
  isSharedSeek: boolean;
  sharedTime: number;
  sharedDuration: number;
  playbackRate: number;
  setPlaybackRate: (rate: number) => void;
  togglePlayAll: () => void;
  seekBothSlots: (time: number) => void;
  seekSlot: (index: CompareSlotIndex, time: number) => void;
  skipBySeconds: (deltaSeconds: number) => void;
  toggleSlotMute: (index: CompareSlotIndex) => void;
  setSlotVolume: (index: CompareSlotIndex, volume: number) => void;
}

function isVideoPlaying(element: HTMLVideoElement | null): boolean {
  return element !== null && !element.paused && !element.ended;
}

async function playVideo(element: HTMLVideoElement): Promise<void> {
  try {
    await element.play();
  } catch (playError) {
    console.error("[CompareVideoPlayer] Could not start playback", playError);
  }
}

export function useComparePlayback(
  compareVideos: [CompareVideoSlot, CompareVideoSlot] | null,
  seekMode: CompareSeekMode,
): ComparePlayback {
  const videoElementsRef = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null]);
  const sharedSeekIntentsRef = useRef<[SharedSeekIntent, SharedSeekIntent]>([null, null]);
  // A new ref callback on a playback update would detach the video and pause it.
  const [videoSlotRefs] = useState(() => COMPARE_SLOT_INDEXES.map((index) => (
    (element: HTMLVideoElement | null) => {
      videoElementsRef.current[index] = element;
      if (!element) return;

      return () => {
        sharedSeekIntentsRef.current[index] = null;
        element.pause();
        videoElementsRef.current[index] = null;
      };
    }
  )));
  const [slotStates, setSlotStates] = useState<CompareSlotPlaybackStates>(createSlotPlaybackStates);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);

  const isSharedSeek = seekMode === "shared";
  const wasSharedSeekRef = useRef(isSharedSeek);

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
    setIsPlaying(
      videoElementsRef.current.some(isVideoPlaying) || sharedSeekIntentsRef.current.includes("play"),
    );
  }, []);

  const pauseAll = useCallback(() => {
    for (const index of COMPARE_SLOT_INDEXES) {
      const element = videoElementsRef.current[index];
      if (sharedSeekIntentsRef.current[index] === "play") {
        sharedSeekIntentsRef.current[index] = "rejoin";
      }
      if (element && isVideoPlaying(element)) element.pause();
    }
    syncPlayingState();
  }, [syncPlayingState]);

  const readSharedTime = useCallback((): number => {
    const [leftElement, rightElement] = videoElementsRef.current;
    const clockIndex = compareClockSlotIndex(
      leftElement?.duration ?? 0,
      rightElement?.duration ?? 0,
    );
    return videoElementsRef.current[clockIndex]?.currentTime ?? 0;
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

  const rejoinAfterSharedSeek = useCallback((index: CompareSlotIndex, element: HTMLVideoElement) => {
    const intent = sharedSeekIntentsRef.current[index];
    if (!intent || element.seeking || element !== videoElementsRef.current[index]) return;

    sharedSeekIntentsRef.current[index] = null;
    // Check the live clock and playback state, not their values when the seek began.
    if (
      element.paused && !element.ended &&
      shouldResumeCompareSlot(readSharedTime(), element.duration) &&
      (intent === "play" || videoElementsRef.current.some(isVideoPlaying))
    ) {
      void playVideo(element);
    }
    if (intent === "play") syncPlayingState();
  }, [readSharedTime, syncPlayingState]);

  const seekSharedSlots = useCallback((time: number, aligning = false) => {
    const elements = videoElementsRef.current;
    const intents = sharedSeekIntentsRef.current;
    const { leftTime, rightTime } = compareSeekTimes(
      time,
      elements[0]?.duration ?? 0,
      elements[1]?.duration ?? 0,
    );
    const targetTimes = [leftTime, rightTime];
    for (const index of COMPARE_SLOT_INDEXES) {
      const element = elements[index];
      if (!element) continue;

      const targetTime = targetTimes[index];
      // Remember the parked slot before assigning currentTime, which may clear ended.
      const mayRejoin = element.paused && (aligning || element.ended || intents[index]) &&
        shouldResumeCompareSlot(targetTime, element.duration);
      intents[index] = mayRejoin ? (intents[index] ?? "rejoin") : null;
      if (!aligning || element.currentTime !== targetTime) {
        element.currentTime = targetTime;
      }
    }
    setSlotStates((currentStates) => [
      { ...currentStates[0], currentTime: leftTime },
      { ...currentStates[1], currentTime: rightTime },
    ]);

    for (const index of COMPARE_SLOT_INDEXES) {
      const element = elements[index];
      if (element) rejoinAfterSharedSeek(index, element);
    }
    syncPlayingState();
  }, [rejoinAfterSharedSeek, syncPlayingState]);

  const seekBothSlots = useCallback((time: number) => seekSharedSlots(time), [seekSharedSlots]);

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
    const elements = videoElementsRef.current;
    const intents = sharedSeekIntentsRef.current;
    if (elements.some(isVideoPlaying) || intents.includes("play")) {
      pauseAll();
      return;
    }

    const restartBoth = shouldRestartBothRecordings(
      Boolean(elements[0]?.ended && !intents[0]),
      Boolean(elements[1]?.ended && !intents[1]),
    );
    const resumeTime = isSharedSeek ? (restartBoth ? 0 : readSharedTime()) : null;
    for (const index of COMPARE_SLOT_INDEXES) {
      const element = elements[index];
      // Pending backward seeks may still report ended, so don't call play() or reseek yet.
      if (!element || intents[index]) continue;
      // Don't restart a parked shorter video just because the shared clock is slightly behind.
      if (element.ended && !restartBoth) continue;

      if (resumeTime !== null) {
        seekSlot(index, resumeTime);
        if (!shouldResumeCompareSlot(resumeTime, element.duration)) continue;
      }
      void playVideo(element);
    }

    const needsDeferredStart = !elements.some(isVideoPlaying);
    for (const index of COMPARE_SLOT_INDEXES) {
      const element = elements[index];
      if (!element || !intents[index]) continue;
      if (needsDeferredStart) intents[index] = "play";
      rejoinAfterSharedSeek(index, element);
    }
    syncPlayingState();
  }, [isSharedSeek, pauseAll, readSharedTime, rejoinAfterSharedSeek, seekSlot, syncPlayingState]);

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
  }, [compareVideos]);

  useEffect(() => {
    videoElementsRef.current.forEach((element) => {
      if (element) {
        element.playbackRate = playbackRate;
      }
    });
  }, [playbackRate]);

  useLayoutEffect(() => {
    // A pending seek belongs to the current seek mode and recording pair.
    sharedSeekIntentsRef.current = [null, null];
    const enteringSharedSeek = isSharedSeek && !wasSharedSeekRef.current;
    wasSharedSeekRef.current = isSharedSeek;
    if (enteringSharedSeek) seekSharedSlots(readSharedTime(), true);
    else syncPlayingState();
  }, [compareVideos, isSharedSeek, readSharedTime, seekSharedSlots, syncPlayingState]);

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

        // Don't replace an unfinished seek while the clock keeps moving.
        if (clockElement && trailingElement && !trailingElement.ended && !trailingElement.seeking) {
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
    const unlistenHiddenToTray = listen("window-hidden-to-tray", pauseAll);

    return () => {
      void unlistenHiddenToTray.then((unsubscribe) => unsubscribe());
    };
  }, [pauseAll]);

  const slots = COMPARE_SLOT_INDEXES.map((index) => {
    const slotState = slotStates[index];
    const videoProps: CompareVideoProps = {
      ref: videoSlotRefs[index],
      muted: slotState.isMuted,
      onLoadedMetadata: ({ currentTarget: element }) => {
        element.volume = slotState.volume;
        element.muted = slotState.isMuted;
        element.playbackRate = playbackRate;
        updateSlotState(index, { duration: element.duration, hasError: false });
      },
      onTimeUpdate: ({ currentTarget: element }) => {
        updateSlotState(index, { currentTime: element.currentTime });
      },
      onSeeked: ({ currentTarget: element }) => {
        if (isSharedSeek) rejoinAfterSharedSeek(index, element);
      },
      onPlay: syncPlayingState,
      onPause: syncPlayingState,
      onEnded: syncPlayingState,
      onError: ({ currentTarget: element }) => {
        const mediaError = element.error;
        console.error("[CompareVideoPlayer] Video load error", {
          code: mediaError?.code,
          message: mediaError?.message,
          filePath: compareVideos?.[index].filePath,
        });

        // Swapping recordings can abort a pending load without a playback failure.
        if (mediaError?.code === MediaError.MEDIA_ERR_ABORTED) {
          return;
        }

        updateSlotState(index, { hasError: true });
      },
    };
    return { ...slotState, videoProps };
  });
  const leftDuration = slotStates[0].duration;
  const rightDuration = slotStates[1].duration;

  return {
    slots,
    isPlaying,
    isSharedSeek,
    sharedTime: slotStates[compareClockSlotIndex(leftDuration, rightDuration)].currentTime,
    sharedDuration: sharedCompareDuration(leftDuration, rightDuration),
    playbackRate,
    setPlaybackRate,
    togglePlayAll,
    seekBothSlots,
    seekSlot,
    skipBySeconds,
    toggleSlotMute,
    setSlotVolume,
  };
}
