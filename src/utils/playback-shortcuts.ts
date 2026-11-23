import { KeyCode } from "../types/key-code";

export enum PlaybackShortcutAction {
  TogglePlay = "toggle-play",
  SeekBack = "seek-back",
  SeekForward = "seek-forward",
  SeekBackFine = "seek-back-fine",
  SeekForwardFine = "seek-forward-fine",
  SeekBackCoarse = "seek-back-coarse",
  SeekForwardCoarse = "seek-forward-coarse",
  SeekStart = "seek-start",
  SeekEnd = "seek-end",
}

interface PlaybackShortcutEvent {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
}

interface PlaybackShortcutContext {
  isEditableTarget: boolean;
  isModalDialogOpen: boolean;
  isPlayerFocused: boolean;
}

interface KeyboardElementLike {
  tagName?: string;
  isContentEditable?: boolean;
}

interface NodeContainer {
  contains(node: unknown): boolean;
}

interface QueryRoot {
  querySelector(selectors: string): unknown;
}

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (target == null || typeof target !== "object") {
    return false;
  }

  const element = target as KeyboardElementLike;
  if (element.isContentEditable) {
    return true;
  }

  return element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT";
}

export function isPlayerKeyboardFocus(
  playerElement: NodeContainer | null,
  eventTarget: EventTarget | null,
  activeElement: unknown,
): boolean {
  if (!playerElement) {
    return false;
  }

  if (activeElement != null && playerElement.contains(activeElement)) {
    return true;
  }

  return eventTarget != null && playerElement.contains(eventTarget);
}

export function documentHasOpenModalDialog(
  root: QueryRoot | null = typeof document === "undefined" ? null : document,
): boolean {
  if (!root) {
    return false;
  }

  return Boolean(root.querySelector('[role="dialog"][aria-modal="true"]'));
}

export function resolvePlaybackShortcut(
  event: PlaybackShortcutEvent,
  context: PlaybackShortcutContext,
): PlaybackShortcutAction | null {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
    return null;
  }

  if (context.isEditableTarget || context.isModalDialogOpen) {
    return null;
  }

  if (event.key.toLowerCase() === KeyCode.J) {
    return PlaybackShortcutAction.SeekBack;
  }

  if (event.key.toLowerCase() === KeyCode.L) {
    return PlaybackShortcutAction.SeekForward;
  }

  if (!context.isPlayerFocused) {
    return null;
  }

  if (event.key === KeyCode.ArrowLeft) {
    return event.shiftKey ? PlaybackShortcutAction.SeekBackCoarse : PlaybackShortcutAction.SeekBackFine;
  }

  if (event.key === KeyCode.ArrowRight) {
    return event.shiftKey ? PlaybackShortcutAction.SeekForwardCoarse : PlaybackShortcutAction.SeekForwardFine;
  }

  if (event.key === KeyCode.Home) {
    return PlaybackShortcutAction.SeekStart;
  }

  if (event.key === KeyCode.End) {
    return PlaybackShortcutAction.SeekEnd;
  }

  if (event.key !== KeyCode.Space || event.repeat) {
    return null;
  }

  return PlaybackShortcutAction.TogglePlay;
}
