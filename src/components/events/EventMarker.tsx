import { GameEvent } from "../../types/events";

type EventMarkerVariant = "compact" | "detailed";

interface EventMarkerProps {
  type: GameEvent["type"];
  variant?: EventMarkerVariant;
  className?: string;
}

const VARIANT_CLASS_NAMES: Record<EventMarkerVariant, string> = {
  compact: "h-2.5 w-2.5",
  detailed: "h-3 w-3",
};

export function EventMarker({ type, variant = "compact", className }: EventMarkerProps) {
  const colorClassName =
    type === "manual"
      ? variant === "detailed"
        ? "rounded-sm border border-neutral-100/55 bg-neutral-200"
        : "rounded-sm bg-neutral-200"
      : type === "death"
        ? variant === "detailed"
          ? "rounded-full border border-rose-200/40 bg-rose-400"
          : "rounded-full bg-rose-300"
        : variant === "detailed"
          ? "rounded-full border border-neutral-100/45 bg-neutral-300"
          : "rounded-full bg-neutral-300";

  return (
    <span
      className={`block ${VARIANT_CLASS_NAMES[variant]} ${colorClassName} ${className || ""}`.trim()}
    />
  );
}
