import { useState, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Crosshair, Skull, MapPin } from "lucide-react";
import { EventTooltip } from "./EventTooltip";
import { useVideo } from "../contexts/VideoContext";
import { useMarker } from "../contexts/MarkerContext";
import { GameEvent } from "../types/events";

export function Timeline() {
  const { currentTime, duration, seek } = useVideo();
  const { events } = useMarker();
  const reduceMotion = useReducedMotion();
  const [hoveredEvent, setHoveredEvent] = useState<GameEvent | null>(null);
  const [tooltipX, setTooltipX] = useState(0);
  const progressRef = useRef<HTMLDivElement>(null);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const formatTime = (seconds: number) => {
    if (isNaN(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

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
          {events.map((event) => {
            const position = duration > 0 ? (event.timestamp / duration) * 100 : 0;
            const isDeath = event.type === "death";
            const isManual = event.type === "manual";
            return (
              <motion.div
                key={event.id}
                className="absolute top-1/2 -translate-y-1/2 cursor-pointer -ml-1.5"
                style={{ left: `${position}%` }}
                onClick={(e) => {
                  e.stopPropagation();
                  handleEventClick(event.timestamp);
                }}
                onMouseEnter={(e) => handleEventHover(event, e)}
                onMouseLeave={() => setHoveredEvent(null)}
                initial={reduceMotion ? false : { opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              >
                {isManual ? (
                  <MapPin className="w-3 h-3 text-cyan-400 hover:scale-125 transition-transform" />
                ) : isDeath ? (
                  <Skull className="w-3 h-3 text-rose-400 hover:scale-125 transition-transform" />
                ) : (
                  <Crosshair className="w-3 h-3 text-emerald-300 hover:scale-125 transition-transform" />
                )}
              </motion.div>
            );
          })}
        </div>
        <span className="text-xs text-neutral-400 font-mono w-12 text-right">{formatTime(duration)}</span>
        <AnimatePresence>{hoveredEvent && <EventTooltip event={hoveredEvent} x={tooltipX} />}</AnimatePresence>
      </div>
    </div>
  );
}
