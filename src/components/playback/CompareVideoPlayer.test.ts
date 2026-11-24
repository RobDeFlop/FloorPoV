import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VideoProvider, useVideo } from "../../contexts/VideoContext";
import { CompareVideoPlayer } from "./CompareVideoPlayer";

const SHORT = { src: "asset://short.mp4", filePath: "short.mp4", title: "Short" };
const LONG = { src: "asset://long.mp4", filePath: "long.mp4", title: "Long" };
const REPLACEMENT = {
  src: "asset://replacement.mp4", filePath: "replacement.mp4", title: "Replacement",
};

function CompareScreen({ revision }: { revision: number }) {
  const { enterCompareMode } = useVideo();
  return createElement(
    "main",
    null,
    createElement("p", null, `Screen revision ${revision}`),
    createElement("button", { onClick: () => enterCompareMode(SHORT, LONG) }, "Compare"),
    createElement("button", { onClick: () => enterCompareMode(SHORT, REPLACEMENT) }, "Swap long"),
    createElement(CompareVideoPlayer),
  );
}

interface MediaOptions {
  deferSeek?: boolean;
  deferEndedSeek?: boolean;
}

// The DOM does not decode recordings. Model the media API that React actually calls,
// including the browser's restart-from-zero behavior if play() is called at the end.
function installMedia(
  video: HTMLVideoElement,
  duration: number,
  { deferSeek = false, deferEndedSeek = false }: MediaOptions = {},
) {
  let currentTime = 0;
  let paused = true;
  let seeking = false;
  let stillEnded = false;
  const seek = mock((time: number) => {
    // An ended clip can still report ended until a backward seek settles.
    stillEnded = deferEndedSeek && video.ended && time < duration;
    seeking = deferSeek || stillEnded;
    currentTime = time;
  });
  const play = mock(async () => {
    if (video.ended) {
      currentTime = 0;
      seeking = false;
      stillEnded = false;
    }
    paused = false;
    video.dispatchEvent(new window.Event("play"));
  });
  const pause = mock(() => {
    if (paused) return;
    paused = true;
    video.dispatchEvent(new window.Event("pause"));
  });
  Object.defineProperties(video, {
    duration: { value: duration },
    currentTime: { get: () => currentTime, set: seek },
    paused: { get: () => paused },
    ended: { get: () => currentTime >= duration || stillEnded },
    seeking: { get: () => seeking },
    play: { value: play },
    pause: { value: pause },
  });

  return {
    video, play, pause, seek,
    finishSeek() {
      if (!seeking) return;
      seeking = false;
      stillEnded = false;
      video.dispatchEvent(new window.Event("timeupdate"));
      video.dispatchEvent(new window.Event("seeked"));
    },
    advanceTo(time: number) {
      currentTime = time;
      video.dispatchEvent(new window.Event("timeupdate"));
      if (time >= duration) {
        paused = true;
        video.dispatchEvent(new window.Event("pause"));
        video.dispatchEvent(new window.Event("ended"));
      }
    },
  };
}

describe("comparison playback", () => {
  let dom: Window;
  let root: Root;
  let restoreGlobals: () => void;
  let pendingFrames: Map<number, FrameRequestCallback>;

  beforeEach(() => {
    dom = new Window();
    const globals = {
      window: dom,
      document: dom.document,
      HTMLElement: dom.HTMLElement,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const originalDescriptors = Object.getOwnPropertyDescriptors(globalThis);
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    restoreGlobals = () => {
      for (const name of Object.keys(globals)) {
        const descriptor = originalDescriptors[name];
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    };
    mockIPC(() => undefined, { shouldMockEvents: true });

    pendingFrames = new Map();
    let nextFrame = 0;
    dom.requestAnimationFrame = (callback) => {
      const frame = ++nextFrame;
      pendingFrames.set(frame, callback);
      return frame;
    };
    dom.cancelAnimationFrame = (frame) => { pendingFrames.delete(frame); };
    root = createRoot(document.body);
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      try {
        clearMocks();
        await dom.happyDOM.close();
      } finally {
        restoreGlobals();
      }
    }
  });

  function runPlaybackFrame() {
    const callbacks = [...pendingFrames.values()];
    pendingFrames.clear();
    for (const callback of callbacks) callback(0);
  }

  function renderScreen(revision: number) {
    act(() => root.render(createElement(VideoProvider, {
      children: createElement(CompareScreen, { revision }),
    })));
  }

  function clickButton(label: string) {
    const button = Array.from(document.querySelectorAll("button")).find((candidate) => (
      (candidate.getAttribute("aria-label") ?? candidate.textContent?.trim()) === label
    ));
    if (!button) throw new Error(`Missing button: ${label}`);
    act(() => button.click());
  }

  function pressTimelineKey(label: string, key: string, shiftKey = false) {
    const timeline = document.querySelector(`[aria-label="${label}"]`);
    if (!timeline) throw new Error(`Missing timeline: ${label}`);
    act(() => {
      timeline.dispatchEvent(new window.KeyboardEvent("keydown", {
        key, shiftKey, bubbles: true, cancelable: true,
      }));
    });
  }

  function mountComparison(shortOptions?: MediaOptions, longOptions?: MediaOptions) {
    renderScreen(1);
    clickButton("Compare");
    const videos = document.querySelectorAll("video");
    expect(videos.length).toBe(2);
    const short = installMedia(videos[0], 10, shortOptions);
    const long = installMedia(videos[1], 30, longOptions);
    act(() => {
      short.video.dispatchEvent(new window.Event("loadedmetadata"));
      long.video.dispatchEvent(new window.Event("loadedmetadata"));
    });
    return { short, long };
  }

  function rewindInSharedSeek(longTime = 12) {
    const { short, long } = mountComparison({ deferEndedSeek: true, deferSeek: true });
    clickButton("Play both recordings");
    act(() => {
      short.finishSeek();
      short.advanceTo(10);
      long.advanceTo(longTime);
    });
    clickButton("Pause both recordings");
    clickButton("Skip both back 10 seconds");
    return { short, long };
  }

  function rewindLongInDualSeek({ keepPlaying = false, deferEndedSeek = false } = {}) {
    const { short, long } = mountComparison({ deferEndedSeek });
    clickButton("Shared seek");
    clickButton("Play both recordings");
    act(() => {
      long.advanceTo(12);
      short.advanceTo(10);
    });
    if (!keepPlaying) clickButton("Pause both recordings");
    pressTimelineKey("Timeline for Long", "ArrowLeft", true);
    pressTimelineKey("Timeline for Long", "ArrowLeft", true);
    expect(short.video.ended).toBe(true);
    expect(long.video.currentTime).toBe(2);
    return { short, long };
  }

  test("keeps both videos playing through control and screen updates", () => {
    const { short, long } = mountComparison();
    clickButton("Play both recordings");
    short.seek.mockClear();
    long.seek.mockClear();

    clickButton("Playback speed for both recordings");
    clickButton("1.25x");
    expect(short.video.playbackRate).toBe(1.25);
    expect(long.video.playbackRate).toBe(1.25);
    clickButton("Mute audio for Short");
    expect(short.video.muted).toBe(true);
    renderScreen(2);
    expect(document.querySelector("main > p")?.textContent).toBe("Screen revision 2");

    act(() => {
      short.advanceTo(4);
      long.advanceTo(4);
      runPlaybackFrame();
    });
    const videos = document.querySelectorAll("video");
    expect(videos[0]).toBe(short.video);
    expect(videos[1]).toBe(long.video);
    const timeline = document.querySelector('[aria-label="Shared timeline"]');
    expect(timeline?.getAttribute("aria-valuenow")).toBe("4");
    for (const media of [short, long]) {
      expect(media.play).toHaveBeenCalledTimes(1);
      expect(media.pause).not.toHaveBeenCalled();
      expect(media.seek).not.toHaveBeenCalled();
      expect(media.video.paused).toBe(false);
    }
  });

  test("shared seeking writes each video's clamped time and can scrub backwards again", () => {
    const { short, long } = mountComparison();
    pressTimelineKey("Shared timeline", "End");
    pressTimelineKey("Shared timeline", "ArrowLeft", true);
    expect(short.seek.mock.calls).toEqual([[10], [10]]);
    expect(long.seek.mock.calls).toEqual([[30], [25]]);

    pressTimelineKey("Shared timeline", "Home");
    expect(short.video.currentTime).toBe(0);
    expect(long.video.currentTime).toBe(0);
  });

  test("does not resync a non-ended trailing recording until its seek settles", () => {
    const { short, long } = mountComparison({ deferSeek: true });
    clickButton("Play both recordings");
    act(() => short.finishSeek());
    pressTimelineKey("Shared timeline", "ArrowRight");
    expect(short.video.currentTime).toBe(1);
    expect(short.video.ended).toBe(false);
    expect(short.video.seeking).toBe(true);
    short.seek.mockClear();

    act(() => {
      long.advanceTo(2);
      runPlaybackFrame();
    });
    expect(short.seek).not.toHaveBeenCalled();

    act(() => {
      short.finishSeek();
      runPlaybackFrame();
    });
    expect(short.seek.mock.calls).toEqual([[2]]);
  });

  test.each([
    { longTime: 12, targetTime: 2 },
    { longTime: 9.7, targetTime: 0 },
  ])("rejoins an ended short recording after a shared rewind to $targetTime", ({ longTime, targetTime }) => {
    const { short, long } = rewindInSharedSeek(longTime);
    expect(short.video.currentTime).toBe(targetTime);
    expect(long.video.currentTime).toBe(targetTime);
    expect(short.video.ended).toBe(true);
    expect(short.video.seeking).toBe(true);

    clickButton("Play both recordings");
    expect(short.play).toHaveBeenCalledTimes(1);
    expect(long.video.paused).toBe(false);
    act(() => short.finishSeek());

    expect(short.video.paused).toBe(false);
    expect(short.video.currentTime).toBe(targetTime);
  });

  test("waits for the latest shared seek before rejoining", () => {
    const { short } = rewindInSharedSeek();
    clickButton("Play both recordings");
    pressTimelineKey("Shared timeline", "ArrowRight");

    act(() => short.video.dispatchEvent(new window.Event("seeked")));
    expect(short.video.seeking).toBe(true);
    expect(short.video.paused).toBe(true);
    act(() => short.finishSeek());
    expect(short.video.currentTime).toBe(3);
    expect(short.video.paused).toBe(false);
  });

  test.each([
    ["Pause both recordings", 2],
    ["Skip both forward 10 seconds", 10],
    ["Shared seek", 2],
  ] as const)("does not rejoin after %s supersedes a shared rewind", (button, expectedTime) => {
    const { short } = rewindInSharedSeek();
    clickButton("Play both recordings");
    clickButton(button);
    act(() => short.finishSeek());

    expect(short.video.currentTime).toBe(expectedTime);
    expect(short.video.paused).toBe(true);
  });

  test("does not rejoin a retained slot after the other recording changes", async () => {
    const { short } = rewindInSharedSeek();
    clickButton("Swap long");
    const videos = document.querySelectorAll("video");
    expect(videos[0]).toBe(short.video);
    const replacement = installMedia(videos[1], 40);
    await act(async () => {
      replacement.advanceTo(2);
      await replacement.play();
      short.finishSeek();
    });

    expect(replacement.video.paused).toBe(false);
    expect(short.video.paused).toBe(true);
  });

  test("can cancel and resume Play while both recordings are seeking away from their ends", () => {
    const options = { deferEndedSeek: true };
    const { short, long } = mountComparison(options, options);
    clickButton("Play both recordings");
    act(() => {
      short.advanceTo(10);
      long.advanceTo(30);
    });
    pressTimelineKey("Shared timeline", "Home");
    pressTimelineKey("Shared timeline", "ArrowRight");

    clickButton("Play both recordings");
    expect(short.video.paused).toBe(true);
    expect(long.video.paused).toBe(true);
    clickButton("Pause both recordings");
    act(() => short.finishSeek());
    expect(short.video.paused).toBe(true);

    clickButton("Play both recordings");
    act(() => long.finishSeek());
    expect(short.video.paused).toBe(false);
    expect(long.video.paused).toBe(false);
    expect(short.video.currentTime).toBe(1);
    expect(long.video.currentTime).toBe(1);
  });

  test("realigns an ended short recording when switching from dual to shared seek", () => {
    const { short, long } = rewindLongInDualSeek();

    clickButton("Dual seek");
    expect(short.video.currentTime).toBe(2);
    expect(short.video.paused).toBe(true);
    clickButton("Play both recordings");
    act(runPlaybackFrame);

    expect(short.video.currentTime).toBe(2);
    expect(long.video.currentTime).toBe(2);
    expect(short.video.paused).toBe(false);
    expect(long.video.paused).toBe(false);
  });

  test.each(["on Play", "during playback"])(
    "rejoins the short recording after its shared realignment seek %s",
    (scenario) => {
      const keepPlaying = scenario === "during playback";
      const { short, long } = rewindLongInDualSeek({ keepPlaying, deferEndedSeek: true });
      clickButton("Dual seek");
      if (!keepPlaying) clickButton("Play both recordings");

      // play() while the short recording still reports ended would rewind it to zero.
      expect(short.video.ended).toBe(true);
      expect(short.video.paused).toBe(true);
      expect(long.video.paused).toBe(false);
      act(() => short.finishSeek());
      act(runPlaybackFrame);
      expect(short.video.paused).toBe(false);
      expect(short.video.currentTime).toBe(2);
      expect(long.video.currentTime).toBe(2);
    },
  );

  test("keeps both recordings paused if playback is paused during shared realignment", () => {
    const { short, long } = rewindLongInDualSeek({ keepPlaying: true, deferEndedSeek: true });
    clickButton("Dual seek");
    clickButton("Pause both recordings");
    act(() => short.finishSeek());

    expect(short.video.currentTime).toBe(2);
    expect(short.video.paused).toBe(true);
    expect(long.video.paused).toBe(true);
  });

  test.each(["shared", "dual"])("resumes only the longer video in %s seek mode", (mode) => {
    const { short, long } = mountComparison();
    if (mode === "dual") clickButton("Shared seek");
    clickButton("Play both recordings");
    expect(short.play).toHaveBeenCalledTimes(1);
    expect(long.play).toHaveBeenCalledTimes(1);

    // The streams can still differ slightly when the shorter one reaches its end.
    act(() => {
      long.advanceTo(9.7);
      short.advanceTo(10);
      runPlaybackFrame();
    });
    clickButton("Pause both recordings");
    expect(short.pause).not.toHaveBeenCalled();
    expect(long.pause).toHaveBeenCalledTimes(1);
    expect(long.video.paused).toBe(true);

    clickButton("Play both recordings");
    expect(long.play).toHaveBeenCalledTimes(2);
    expect(long.video.paused).toBe(false);
    expect(long.video.currentTime).toBe(9.7);
    expect(short.play).toHaveBeenCalledTimes(1);
    expect(short.video.currentTime).toBe(10);
    expect(short.video.paused).toBe(true);

    act(() => {
      long.advanceTo(30);
      runPlaybackFrame();
    });
    clickButton("Play both recordings");
    expect(short.play).toHaveBeenCalledTimes(2);
    expect(long.play).toHaveBeenCalledTimes(3);
    expect(short.video.currentTime).toBe(0);
    expect(long.video.currentTime).toBe(0);
  });
});
