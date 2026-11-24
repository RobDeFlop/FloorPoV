import { describe, expect, test } from "bun:test";
import { KeyCode } from "../types/key-code";
import {
  documentHasOpenModalDialog,
  isEditableKeyboardTarget,
  isPlayerKeyboardFocus,
  PlaybackShortcutAction,
  resolvePlaybackShortcut,
} from "./playback-shortcuts";

function shortcutEvent(
  key: string,
  overrides: Partial<{
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    repeat: boolean;
    defaultPrevented: boolean;
  }> = {},
) {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    ...overrides,
  };
}

describe("isEditableKeyboardTarget", () => {
  test("ignores non-elements", () => {
    expect(isEditableKeyboardTarget(null)).toBe(false);
    expect(isEditableKeyboardTarget({} as EventTarget)).toBe(false);
  });

  test("treats form fields and contenteditable as editable", () => {
    expect(isEditableKeyboardTarget({ tagName: "INPUT" } as EventTarget)).toBe(true);
    expect(isEditableKeyboardTarget({ tagName: "TEXTAREA" } as EventTarget)).toBe(true);
    expect(isEditableKeyboardTarget({ tagName: "SELECT" } as EventTarget)).toBe(true);
    expect(isEditableKeyboardTarget({ tagName: "DIV", isContentEditable: true } as EventTarget)).toBe(
      true,
    );
  });

  test("allows ordinary buttons and the player surface", () => {
    expect(isEditableKeyboardTarget({ tagName: "BUTTON" } as EventTarget)).toBe(false);
    expect(isEditableKeyboardTarget({ tagName: "DIV" } as EventTarget)).toBe(false);
  });
});

describe("isPlayerKeyboardFocus", () => {
  test("requires the player element", () => {
    const target = { id: "outside" };
    expect(isPlayerKeyboardFocus(null, target as EventTarget, target)).toBe(false);
  });

  test("treats the player or a descendant as focused", () => {
    const control = { id: "control" };
    const player = {
      contains(node: unknown) {
        return node === player || node === control;
      },
    };

    expect(isPlayerKeyboardFocus(player, player as unknown as EventTarget, player)).toBe(true);
    expect(isPlayerKeyboardFocus(player, control as EventTarget, control)).toBe(true);
  });

  test("ignores focus outside the player", () => {
    const player = {
      contains() {
        return false;
      },
    };
    const outside = { id: "input" };

    expect(isPlayerKeyboardFocus(player, outside as EventTarget, outside)).toBe(false);
  });
});

describe("documentHasOpenModalDialog", () => {
  test("detects an open modal dialog", () => {
    expect(
      documentHasOpenModalDialog({
        querySelector: (selectors: string) =>
          selectors === '[role="dialog"][aria-modal="true"]' ? { role: "dialog" } : null,
      }),
    ).toBe(true);
    expect(
      documentHasOpenModalDialog({
        querySelector: () => null,
      }),
    ).toBe(false);
  });
});

describe("resolvePlaybackShortcut", () => {
  const idleContext = {
    isEditableTarget: false,
    isModalDialogOpen: false,
    isPlayerFocused: false,
    isFullscreen: false,
  };
  const playerFocused = { ...idleContext, isPlayerFocused: true };

  test("keeps J and L seek when the player is not focused", () => {
    expect(resolvePlaybackShortcut(shortcutEvent(KeyCode.J), idleContext)).toBe(
      PlaybackShortcutAction.SeekBack,
    );
    expect(resolvePlaybackShortcut(shortcutEvent(KeyCode.J.toUpperCase()), idleContext)).toBe(
      PlaybackShortcutAction.SeekBack,
    );
    expect(resolvePlaybackShortcut(shortcutEvent(KeyCode.L), idleContext)).toBe(
      PlaybackShortcutAction.SeekForward,
    );
    expect(resolvePlaybackShortcut(shortcutEvent(KeyCode.L.toUpperCase()), idleContext)).toBe(
      PlaybackShortcutAction.SeekForward,
    );
  });

  test("toggles play only when the player is focused", () => {
    expect(resolvePlaybackShortcut(shortcutEvent(KeyCode.Space), idleContext)).toBe(null);
    expect(resolvePlaybackShortcut(shortcutEvent(KeyCode.Space), playerFocused)).toBe(
      PlaybackShortcutAction.TogglePlay,
    );
  });

  test("does not steal keys from inputs, dialogs, or modified presses", () => {
    expect(
      resolvePlaybackShortcut(shortcutEvent(KeyCode.Space), { ...playerFocused, isEditableTarget: true }),
    ).toBe(null);
    expect(
      resolvePlaybackShortcut(shortcutEvent(KeyCode.J), { ...idleContext, isEditableTarget: true }),
    ).toBe(null);
    expect(
      resolvePlaybackShortcut(shortcutEvent(KeyCode.Space), { ...playerFocused, isModalDialogOpen: true }),
    ).toBe(null);
    expect(
      resolvePlaybackShortcut(shortcutEvent(KeyCode.L), { ...idleContext, isModalDialogOpen: true }),
    ).toBe(null);
    expect(
      resolvePlaybackShortcut(shortcutEvent(KeyCode.Space, { defaultPrevented: true }), playerFocused),
    ).toBe(null);
    expect(resolvePlaybackShortcut(shortcutEvent(KeyCode.J, { ctrlKey: true }), idleContext)).toBe(null);
    expect(resolvePlaybackShortcut(shortcutEvent(KeyCode.L, { metaKey: true }), idleContext)).toBe(null);
    expect(
      resolvePlaybackShortcut(shortcutEvent(KeyCode.Space, { altKey: true }), playerFocused),
    ).toBe(null);
  });

  test("ignores held Space so play/pause does not chatter", () => {
    expect(
      resolvePlaybackShortcut(shortcutEvent(KeyCode.Space, { repeat: true }), playerFocused),
    ).toBe(null);
  });

  test("plain fullscreen arrows seek five seconds without Shift", () => {
    const fullscreen = { ...playerFocused, isFullscreen: true };
    expect(resolvePlaybackShortcut(shortcutEvent(KeyCode.ArrowLeft), fullscreen)).toBe(
      PlaybackShortcutAction.SeekBackCoarse,
    );
    expect(resolvePlaybackShortcut(shortcutEvent(KeyCode.ArrowRight), fullscreen)).toBe(
      PlaybackShortcutAction.SeekForwardCoarse,
    );
  });

  test("seeks with arrows and Home/End only when the player is focused", () => {
    expect(resolvePlaybackShortcut(shortcutEvent(KeyCode.ArrowLeft), idleContext)).toBe(null);
    expect(resolvePlaybackShortcut(shortcutEvent(KeyCode.ArrowLeft), playerFocused)).toBe(
      PlaybackShortcutAction.SeekBackFine,
    );
    expect(
      resolvePlaybackShortcut(shortcutEvent(KeyCode.ArrowLeft, { shiftKey: true }), playerFocused),
    ).toBe(PlaybackShortcutAction.SeekBackCoarse);
    expect(resolvePlaybackShortcut(shortcutEvent(KeyCode.ArrowRight), playerFocused)).toBe(
      PlaybackShortcutAction.SeekForwardFine,
    );
    expect(
      resolvePlaybackShortcut(shortcutEvent(KeyCode.ArrowRight, { shiftKey: true }), playerFocused),
    ).toBe(PlaybackShortcutAction.SeekForwardCoarse);
    expect(resolvePlaybackShortcut(shortcutEvent(KeyCode.Home), playerFocused)).toBe(
      PlaybackShortcutAction.SeekStart,
    );
    expect(resolvePlaybackShortcut(shortcutEvent(KeyCode.End), playerFocused)).toBe(
      PlaybackShortcutAction.SeekEnd,
    );
  });
});
