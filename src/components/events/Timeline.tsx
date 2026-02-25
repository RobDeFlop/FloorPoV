import { useState, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { EventTooltip } from "./EventTooltip";
import { EventMarker } from "./EventMarker";
import { useVideo } from "../../contexts/VideoContext";
import { useMarker } from "../../contexts/MarkerContext";
import { GameEvent } from "../../types/events";
import { formatTime } from "../../utils/format";

export function Timeline() {
  const { currentTime, duration, seek } = useVideo();
  const { filteredEvents } = useMarker();
  const reduceMotion = useReducedMotion();
  const [hoveredEvent, setHoveredEvent] = useState<GameEvent | null>(null);
  const [tooltipX, setTooltipX] = useState(0);
  const progressRef = useRef<HTMLDivElement>(null);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressRef.current || duration === 0) return;
    const rect = progressRef.current.getBoundingClientRect();
    const clickPosition = (e.clientX - rect.left) / rect.width;
    const newTime = clickPosition * duration;
    seek(newTime);
  };

  const handleEventClick = (timestamp: number) => {
    seek(timestamp);
  };

  const handleEventHover = (event: GameEvent, e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const containerRect = (e.currentTarget.closest(".timeline-container") as HTMLElement).getBoundingClientRect();
    const x = rect.left - containerRect.left + rect.width / 2;
    setTooltipX(x);
    setHoveredEvent(event);
  };

  return (
    <div className="bg-neutral-900 border-t border-neutral-800/80 p-3">
      <div className="timeline-container flex items-center gap-3 relative">
        <span className="text-xs text-neutral-400 font-mono w-12">{formatTime(currentTime)}</span>
        <div
          ref={progressRef}
          className="flex-1 h-2 bg-neutral-800 rounded-full cursor-pointer group relative"
          onClick={handleProgressClick}
        >
          <div
            className="h-full bg-emerald-400/80 rounded-full relative group-hover:bg-emerald-300 transition-colors"
            style={{ width: `${progress}%` }}
          >
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-emerald-100 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          {filteredEvents.map((event) => {
            const position = duration > 0 ? (event.timestamp / duration) * 100 : 0;
            return (
              <motion.button
                key={event.id}
                type="button"
                className="absolute top-1/2 -ml-1.5 -translate-y-1/2 rounded-sm p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
                style={{ left: `${position}%` }}
                onClick={(e) => {
                  e.stopPropagation();
                  handleEventClick(event.timestamp);
                }}
                onMouseEnter={(e) => handleEventHover(event, e)}
                onMouseLeave={() => setHoveredEvent(null)}
                aria-label={`Seek to ${event.type} event at ${event.timestamp.toFixed(1)} seconds`}
                initial={reduceMotion ? false : { opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              >
                <EventMarker type={event.type} className="transition-transform hover:scale-125" />
              </motion.button>
            );
          })}
        </div>
        <span className="text-xs text-neutral-400 font-mono w-12 text-right">{formatTime(duration)}</span>
        <AnimatePresence>{hoveredEvent && <EventTooltip event={hoveredEvent} x={tooltipX} />}</AnimatePresence>
      </div>
    </div>
  );
}
