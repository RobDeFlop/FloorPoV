import { afterEach, beforeEach, expect, test } from "bun:test";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VideoProvider, useVideo } from "./VideoContext";

function FullscreenControls() {
  const { fullscreenPhase, toggleFullscreen } = useVideo();
  return createElement("button", { onClick: () => void toggleFullscreen() }, fullscreenPhase);
}

let dom: Window;
let root: Root;
let restoreGlobals: () => void;

beforeEach(() => {
  dom = new Window();
  const globals = {
    window: dom,
    document: dom.document,
    HTMLElement: dom.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    isTauri: true,
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

async function mountPlayer() {
  await act(async () => root.render(createElement(VideoProvider, {
    children: createElement(FullscreenControls),
  })));
  const button = document.querySelector("button");
  if (!button) throw new Error("Missing fullscreen control");
  return button;
}

test("the first fullscreen click uses the native tray generation after a webview reload", async () => {
  const generations: unknown[] = [];
  mockIPC((command, args) => {
    if (command === "get_playback_tray_generation") return 3;
    if (command === "enter_playback_fullscreen" && args && "trayGeneration" in args) {
      generations.push(args.trayGeneration);
      return { outcome: args.trayGeneration === 3 ? "entered" : "skipped", trayGeneration: 3 };
    }
    throw new Error(`Unexpected command: ${command}`);
  }, { shouldMockEvents: true });
  const button = await mountPlayer();

  await act(async () => button.click());

  expect(generations).toEqual([3]);
  expect(button.textContent).toBe("fullscreen");
});

test("a delayed fullscreen reply does not block a new click after reopening from tray", async () => {
  const generations: unknown[] = [];
  const oldEntry = Promise.withResolvers<{ outcome: string; trayGeneration: number }>();
  mockIPC((command, args) => {
    if (command === "get_playback_tray_generation") return 0;
    if (command === "enter_playback_fullscreen" && args && "trayGeneration" in args) {
      generations.push(args.trayGeneration);
      if (args.trayGeneration === 0) return oldEntry.promise;
      return { outcome: "entered", trayGeneration: 1 };
    }
    throw new Error(`Unexpected command: ${command}`);
  }, { shouldMockEvents: true });
  const button = await mountPlayer();
  try {
    await act(async () => button.click());
    expect(button.textContent).toBe("entering");
    await act(async () => emit("window-hidden-to-tray", { trayGeneration: 1 }));
    expect(button.textContent).toBe("windowed");

    await act(async () => button.click());
    expect(generations).toEqual([0, 1]);
    expect(button.textContent).toBe("fullscreen");
  } finally {
    await act(async () => oldEntry.resolve({ outcome: "skipped", trayGeneration: 0 }));
  }
  expect(button.textContent).toBe("fullscreen");
});
