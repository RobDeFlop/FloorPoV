import { GameEvent } from "../../types/events";
import { formatTime } from "../../utils/format";
import { AnimatedTooltip } from "../ui/AnimatedTooltip";

interface EventTooltipProps {
  event: GameEvent;
  x: number;
}

export function EventTooltip({ event, x }: EventTooltipProps) {
  const label =
    event.type === "death" ? "Death" :
    event.type === "manual" ? "Manual marker" :
    "Kill";

  const description =
    event.type === "death" ? `${event.target} died` :
    event.type === "manual" ? "User marked this moment" :
    `${event.source} killed ${event.target}`;

  return (
    <AnimatedTooltip x={x}>
      <div className="font-medium">{label}</div>
      <div className="text-neutral-400">{description}</div>
      <div className="text-neutral-500">{formatTime(event.timestamp)}</div>
    </AnimatedTooltip>
  );
}
