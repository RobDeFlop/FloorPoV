import { useState } from "react";
import { Crosshair, Skull } from "lucide-react";
import { mockEvents, GameEvent } from "../data/mockEvents";
import { EventTooltip } from "./EventTooltip";
import { useVideo } from "../contexts/VideoContext";

export function GameEvents() {
  const { duration, seek } = useVideo();
  const [hoveredEvent, setHoveredEvent] = useState<GameEvent | null>(null);
  const [tooltipX, setTooltipX] = useState(0);

  const handleEventClick = (timestamp: number) => {
    seek(timestamp);
  };

  const handleEventHover = (event: GameEvent, e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const containerRect = (e.currentTarget.closest(".game-events-container") as HTMLElement).getBoundingClientRect();
    const x = rect.left - containerRect.left + rect.width / 2;
    setTooltipX(x);
    setHoveredEvent(event);
  };

  return (
    <div className="game-events-container bg-neutral-900 border-t border-neutral-800 px-3 py-2">
      <div className="text-xs text-neutral-500 mb-1.5">Game Events</div>
      <div className="relative h-5">
        <div className="absolute inset-0 bg-neutral-800 rounded-full" />
        {mockEvents.map((event) => {
          const position = duration > 0 ? (event.timestamp / duration) * 100 : 0;
          const isDeath = event.type === "death";
          return (
            <div
              key={event.id}
              className="absolute top-1/2 -translate-y-1/2 cursor-pointer -ml-2"
              style={{ left: `${position}%` }}
              onClick={() => handleEventClick(event.timestamp)}
              onMouseEnter={(e) => handleEventHover(event, e)}
              onMouseLeave={() => setHoveredEvent(null)}
            >
              {isDeath ? (
                <Skull className="w-4 h-4 text-orange-400 hover:scale-125 transition-transform" />
              ) : (
                <Crosshair className="w-4 h-4 text-emerald-400 hover:scale-125 transition-transform" />
              )}
            </div>
          );
        })}
        {hoveredEvent && <EventTooltip event={hoveredEvent} x={tooltipX} />}
      </div>
    </div>
  );
}
