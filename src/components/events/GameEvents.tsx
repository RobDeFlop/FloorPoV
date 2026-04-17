import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Activity } from "lucide-react";
import { EventTooltip } from "./EventTooltip";
import { EventMarker } from "./EventMarker";
import { useVideo } from "../../contexts/VideoContext";
import { useMarker } from "../../contexts/MarkerContext";
import { GameEvent, RecordingEncounterMetadata } from "../../types/events";
import { formatTime } from "../../utils/format";
import { AnimatedTooltip } from "../ui/AnimatedTooltip";

const EVENT_SEEK_OFFSET_SECONDS = 5;

interface EncounterTooltipProps {
  encounter: RecordingEncounterMetadata;
  x: number;
}

function EncounterTooltip({ encounter, x }: EncounterTooltipProps) {
  const startTime = encounter.startedAtSeconds ?? 0;
  const endTime = encounter.endedAtSeconds;
  const duration = endTime !== undefined ? endTime - startTime : undefined;

  return (
    <AnimatedTooltip x={x}>
      <div className="font-medium">{encounter.name}</div>
      <div className="text-neutral-400">Start: {formatTime(startTime)}</div>
      {endTime !== undefined && (
        <div className="text-neutral-400">End: {formatTime(endTime)}</div>
      )}
      {duration !== undefined && (
        <div className="text-neutral-500">Duration: {formatTime(duration)}</div>
      )}
    </AnimatedTooltip>
  );
}

function getEncounterSegmentColor(): { bg: string; border: string; hover: string } {
  return { bg: "bg-emerald-500/50", border: "border-emerald-400/80", hover: "hover:bg-emerald-400/70" };
}

export function GameEvents() {
  const { duration, seek } = useVideo();
  const { filteredEvents, encounters } = useMarker();
  const reduceMotion = useReducedMotion();
  const [hoveredEvent, setHoveredEvent] = useState<GameEvent | null>(null);
  const [hoveredEncounter, setHoveredEncounter] = useState<RecordingEncounterMetadata | null>(null);
  const [tooltipX, setTooltipX] = useState(0);

  const handleEventClick = (timestamp: number) => {
    const seekTime = Math.max(0, timestamp - EVENT_SEEK_OFFSET_SECONDS);
    seek(seekTime);
  };

  const handleEventHover = (event: GameEvent, e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const containerRect = (e.currentTarget.closest(".game-events-container") as HTMLElement).getBoundingClientRect();
    const x = rect.left - containerRect.left + rect.width / 2;
    setTooltipX(x);
    setHoveredEvent(event);
  };

  const handleEncounterHover = (encounter: RecordingEncounterMetadata, e: React.MouseEvent) => {
    const containerRect = (e.currentTarget.closest(".timeline-bar") as HTMLElement).getBoundingClientRect();
    const x = e.clientX - containerRect.left;
    setTooltipX(x);
    setHoveredEncounter(encounter);
  };

  const handleEncounterMove = (e: React.MouseEvent) => {
    const containerRect = (e.currentTarget.closest(".timeline-bar") as HTMLElement).getBoundingClientRect();
    const x = e.clientX - containerRect.left;
    setTooltipX(x);
  };

  return (
    <div className="game-events-container bg-(--surface-2) border-t border-white/10 px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.12em] text-neutral-400">
        <Activity className="h-3.5 w-3.5 text-neutral-300" />
        Game Events
      </div>
      <div className="timeline-bar relative h-6 rounded-sm border border-white/10 bg-neutral-800 px-1">
        {encounters.map((encounter, index) => {
          if (typeof encounter.startedAtSeconds !== "number") {
            return null;
          }

          const startPercent = duration > 0 ? (encounter.startedAtSeconds / duration) * 100 : 0;
          const endPercent =
            typeof encounter.endedAtSeconds === "number" && duration > 0
              ? (encounter.endedAtSeconds / duration) * 100
              : 100;
          const widthPercent = Math.max(0, endPercent - startPercent);

          if (widthPercent <= 0) {
            return null;
          }

          const startTime = encounter.startedAtSeconds as number;
          const segmentColors = getEncounterSegmentColor();

          return (
            <button
              type="button"
              key={`${encounter.name}-${encounter.category}-${index}`}
              className={`absolute top-0 bottom-0 rounded-sm ${segmentColors.bg} ${segmentColors.border} border cursor-pointer transition-colors ${segmentColors.hover}`}
              style={{ left: `calc(${startPercent}% + 4px)`, width: `calc(${widthPercent}% - 8px)` }}
              onClick={() => seek(startTime)}
              onMouseEnter={(e) => handleEncounterHover(encounter, e)}
              onMouseMove={handleEncounterMove}
              onMouseLeave={() => setHoveredEncounter(null)}
              aria-label={`Jump to encounter ${encounter.name} at ${formatTime(startTime)}`}
            />
          );
        })}
        {filteredEvents.map((event) => {
          const position = duration > 0 ? (event.timestamp / duration) * 100 : 0;
          return (
            <motion.button
              key={event.id}
              type="button"
               className="absolute top-1/2 -ml-3.5 -translate-y-1/2 rounded-sm p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
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
        <AnimatePresence>{hoveredEncounter && <EncounterTooltip encounter={hoveredEncounter} x={tooltipX} />}</AnimatePresence>
      </div>
    </div>
  );
}
