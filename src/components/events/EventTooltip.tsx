import {
  GameEvent,
  GameEventType,
  getGameEventDescription,
  getManualMarkerLabel,
} from "../../types/events";
import { formatCompactAmount, formatTime } from "../../utils/format";
import { AnimatedTooltip } from "../ui/AnimatedTooltip";

interface EventTooltipProps {
  event: GameEvent;
  x: number;
}

const EVENT_LABELS: Record<GameEventType, string> = {
  death: "Death",
  manual: "Manual Marker",
  bloodlust: "Bloodlust",
  encounterStart: "Encounter Start",
  encounterEnd: "Encounter End",
  note: "Note",
};

export function EventTooltip({ event, x }: EventTooltipProps) {
  const compactAmount = formatCompactAmount(event.amount);

  return (
    <AnimatedTooltip x={x}>
      <div className="font-medium">
        {event.type === "manual" ? getManualMarkerLabel(event) : EVENT_LABELS[event.type]}
      </div>
      <div className="text-neutral-400">{getGameEventDescription(event)}</div>
      {compactAmount ? <div className="text-orange-300">{compactAmount}</div> : null}
      <div className="text-neutral-500">{formatTime(event.timestamp)}</div>
    </AnimatedTooltip>
  );
}
