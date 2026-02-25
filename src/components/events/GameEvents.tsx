import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Activity } from "lucide-react";
import { EventTooltip } from "./EventTooltip";
import { EventMarker } from "./EventMarker";
import { useVideo } from "../../contexts/VideoContext";
import { useMarker } from "../../contexts/MarkerContext";
import { GameEvent } from "../../types/events";

export function GameEvents() {
  const { duration, seek } = useVideo();
  const { filteredEvents } = useMarker();
  const reduceMotion = useReducedMotion();
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
    <div className="game-events-container bg-(--surface-2) border-t border-white/10 px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.12em] text-neutral-400">
        <Activity className="h-3.5 w-3.5 text-neutral-300" />
        Game Events
      </div>
      <div className="relative h-6 rounded-sm border border-white/10 bg-black/20 px-1">
        <div className="absolute inset-1 rounded-full bg-neutral-800" />
        {filteredEvents.map((event) => {
          const position = duration > 0 ? (event.timestamp / duration) * 100 : 0;
          return (
            <motion.button
              key={event.id}
              type="button"
               className="absolute top-1/2 -ml-2 -translate-y-1/2 rounded-sm p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
              style={{ left: `${position}%` }}
              onClick={() => handleEventClick(event.timestamp)}
              onMouseEnter={(e) => handleEventHover(event, e)}
              onMouseLeave={() => setHoveredEvent(null)}
              aria-label={`Seek to ${event.type} event at ${event.timestamp.toFixed(1)} seconds`}
              initial={reduceMotion ? false : { opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            >
              <EventMarker
                type={event.type}
                variant="detailed"
                className="transition-transform hover:scale-125"
              />
            </motion.button>
          );
        })}
        <AnimatePresence>{hoveredEvent && <EventTooltip event={hoveredEvent} x={tooltipX} />}</AnimatePresence>
      </div>
    </div>
  );
}
