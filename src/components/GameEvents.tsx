import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Crosshair, Skull, MapPin } from "lucide-react";
import { EventTooltip } from "./EventTooltip";
import { useVideo } from "../contexts/VideoContext";
import { useMarker } from "../contexts/MarkerContext";
import { GameEvent } from "../types/events";

export function GameEvents() {
  const { duration, seek } = useVideo();
  const { events } = useMarker();
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
    <div className="game-events-container bg-neutral-900 border-t border-neutral-800/80 px-3 py-2">
      <div className="text-xs text-neutral-500 mb-1.5">Game Events</div>
      <div className="relative h-5">
        <div className="absolute inset-0 bg-neutral-800 rounded-full" />
        {events.map((event) => {
          const position = duration > 0 ? (event.timestamp / duration) * 100 : 0;
          const isDeath = event.type === "death";
          const isManual = event.type === "manual";
          return (
            <motion.div
              key={event.id}
              className="absolute top-1/2 -translate-y-1/2 cursor-pointer -ml-2"
              style={{ left: `${position}%` }}
              onClick={() => handleEventClick(event.timestamp)}
              onMouseEnter={(e) => handleEventHover(event, e)}
              onMouseLeave={() => setHoveredEvent(null)}
              initial={reduceMotion ? false : { opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            >
              {isManual ? (
                <MapPin className="w-4 h-4 text-cyan-400 hover:scale-125 transition-transform" />
              ) : isDeath ? (
                <Skull className="w-4 h-4 text-rose-400 hover:scale-125 transition-transform" />
              ) : (
                <Crosshair className="w-4 h-4 text-emerald-300 hover:scale-125 transition-transform" />
              )}
            </motion.div>
          );
        })}
        <AnimatePresence>{hoveredEvent && <EventTooltip event={hoveredEvent} x={tooltipX} />}</AnimatePresence>
      </div>
    </div>
  );
}
