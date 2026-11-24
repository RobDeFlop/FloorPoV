import { motion, useReducedMotion } from "motion/react";

export interface PlayerStatEntry {
  player: string;
  count: number;
}

interface PlayerStatChartProps {
  title: string;
  data: PlayerStatEntry[];
  color: string;
}

export function PlayerStatChart({ title, data, color }: PlayerStatChartProps) {
  const reduceMotion = useReducedMotion();
  const sanitizedData = data.map((entry) => ({
    player: entry.player.trim() || "Unknown",
    count: Math.max(0, entry.count),
  }));

  if (sanitizedData.length === 0) {
    return (
      <div>
        <p className="mb-2 text-xs font-medium text-neutral-400">{title}</p>
        <p className="text-xs text-neutral-400">No data</p>
      </div>
    );
  }

  const maxCount = Math.max(...sanitizedData.map((entry) => entry.count), 1);

  return (
    <div>
      <p className="mb-2 text-xs font-medium text-neutral-400">{title}</p>
      <div className="space-y-1.5" role="list" aria-label={title}>
        {sanitizedData.map((entry, index) => (
          <div key={`${entry.player}-${index}`} className="flex items-center gap-2 text-xs" role="listitem">
            <span className="w-32 shrink-0 truncate text-neutral-300" title={entry.player}>
              {entry.player}
            </span>
            <div className="h-5 min-w-0 flex-1 rounded-sm bg-white/5" title={`${entry.player}: ${entry.count}`}>
              <motion.div
                className="h-full origin-left rounded-sm opacity-75"
                initial={reduceMotion ? false : { scaleX: 0, opacity: 0.45 }}
                animate={{ scaleX: 1, opacity: 0.75 }}
                transition={
                  reduceMotion
                    ? { duration: 0 }
                    : { duration: 0.18, delay: Math.min(index, 6) * 0.025 }
                }
                style={{ width: `${(entry.count / maxCount) * 100}%`, backgroundColor: color }}
              />
            </div>
            <span className="w-8 shrink-0 text-right font-mono text-neutral-400">{entry.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
