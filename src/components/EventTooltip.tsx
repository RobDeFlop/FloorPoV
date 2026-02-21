import { GameEvent } from "../types/events";
import { motion, useReducedMotion } from 'motion/react';

interface EventTooltipProps {
  event: GameEvent;
  x: number;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function EventTooltip({ event, x }: EventTooltipProps) {
  const reduceMotion = useReducedMotion();
  const label = 
    event.type === "death" ? "Death" :
    event.type === "manual" ? "Manual Marker" :
    "Kill";
  
  const description =
    event.type === "death" ? `${event.target} died` :
    event.type === "manual" ? "User marked this moment" :
    `${event.source} killed ${event.target}`;

  return (
    <motion.div
      className="absolute bottom-full mb-2 px-2 py-1 bg-neutral-900 border border-neutral-700 text-neutral-200 text-xs rounded whitespace-nowrap pointer-events-none z-10"
      style={{ left: x }}
      initial={reduceMotion ? false : { opacity: 0, y: 4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduceMotion ? undefined : { opacity: 0, y: 4, scale: 0.98 }}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="font-medium">{label}</div>
      <div className="text-neutral-400">{description}</div>
      <div className="text-neutral-500">{formatTime(event.timestamp)}</div>
    </motion.div>
  );
}
