import { describe, expect, test } from "bun:test";
import {
  documentHasOpenModalDialog,
  isEditableKeyboardTarget,
  isPlayerKeyboardFocus,
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
  };
  const playerFocused = { ...idleContext, isPlayerFocused: true };

  test("keeps J and L seek when the player is not focused", () => {
    expect(resolvePlaybackShortcut(shortcutEvent("j"), idleContext)).toBe("seek-back");
    expect(resolvePlaybackShortcut(shortcutEvent("J"), idleContext)).toBe("seek-back");
    expect(resolvePlaybackShortcut(shortcutEvent("l"), idleContext)).toBe("seek-forward");
    expect(resolvePlaybackShortcut(shortcutEvent("L"), idleContext)).toBe("seek-forward");
  });

  test("toggles play only when the player is focused", () => {
    expect(resolvePlaybackShortcut(shortcutEvent(" "), idleContext)).toBe(null);
    expect(resolvePlaybackShortcut(shortcutEvent(" "), playerFocused)).toBe("toggle-play");
  });

  test("does not steal keys from inputs, dialogs, or modified presses", () => {
    expect(
      resolvePlaybackShortcut(shortcutEvent(" "), { ...playerFocused, isEditableTarget: true }),
    ).toBe(null);
    expect(resolvePlaybackShortcut(shortcutEvent("j"), { ...idleContext, isEditableTarget: true })).toBe(
      null,
    );
    expect(
      resolvePlaybackShortcut(shortcutEvent(" "), { ...playerFocused, isModalDialogOpen: true }),
    ).toBe(null);
    expect(resolvePlaybackShortcut(shortcutEvent("l"), { ...idleContext, isModalDialogOpen: true })).toBe(
      null,
    );
    expect(
      resolvePlaybackShortcut(shortcutEvent(" ", { defaultPrevented: true }), playerFocused),
    ).toBe(null);
    expect(resolvePlaybackShortcut(shortcutEvent("j", { ctrlKey: true }), idleContext)).toBe(null);
    expect(resolvePlaybackShortcut(shortcutEvent("l", { metaKey: true }), idleContext)).toBe(null);
    expect(resolvePlaybackShortcut(shortcutEvent(" ", { altKey: true }), playerFocused)).toBe(null);
  });

  test("ignores held Space so play/pause does not chatter", () => {
    expect(resolvePlaybackShortcut(shortcutEvent(" ", { repeat: true }), playerFocused)).toBe(null);
  });

  test("seeks with arrows and Home/End only when the player is focused", () => {
    expect(resolvePlaybackShortcut(shortcutEvent("ArrowLeft"), idleContext)).toBe(null);
    expect(resolvePlaybackShortcut(shortcutEvent("ArrowLeft"), playerFocused)).toBe("seek-back-fine");
    expect(
      resolvePlaybackShortcut(shortcutEvent("ArrowLeft", { shiftKey: true }), playerFocused),
    ).toBe("seek-back-coarse");
    expect(resolvePlaybackShortcut(shortcutEvent("ArrowRight"), playerFocused)).toBe(
      "seek-forward-fine",
    );
    expect(
      resolvePlaybackShortcut(shortcutEvent("ArrowRight", { shiftKey: true }), playerFocused),
    ).toBe("seek-forward-coarse");
    expect(resolvePlaybackShortcut(shortcutEvent("Home"), playerFocused)).toBe("seek-start");
    expect(resolvePlaybackShortcut(shortcutEvent("End"), playerFocused)).toBe("seek-end");
  });
});
