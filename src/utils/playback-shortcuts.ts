export type PlaybackShortcutAction =
  | "toggle-play"
  | "seek-back"
  | "seek-forward"
  | "seek-back-fine"
  | "seek-forward-fine"
  | "seek-back-coarse"
  | "seek-forward-coarse"
  | "seek-start"
  | "seek-end";

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

  if (event.key === "j" || event.key === "J") {
    return "seek-back";
  }

  if (event.key === "l" || event.key === "L") {
    return "seek-forward";
  }

  if (!context.isPlayerFocused) {
    return null;
  }

  if (event.key === "ArrowLeft") {
    return event.shiftKey ? "seek-back-coarse" : "seek-back-fine";
  }

  if (event.key === "ArrowRight") {
    return event.shiftKey ? "seek-forward-coarse" : "seek-forward-fine";
  }

  if (event.key === "Home") {
    return "seek-start";
  }

  if (event.key === "End") {
    return "seek-end";
  }

  if (event.key !== " " || event.repeat) {
    return null;
  }

  return "toggle-play";
}
