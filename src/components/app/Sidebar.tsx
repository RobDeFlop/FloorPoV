import { useState, type ComponentType } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Activity, Bug, PanelLeft, Radar, SlidersHorizontal } from "lucide-react";
import { useRecording } from "../../contexts/RecordingContext";

const gameModes = ["Mythic+", "Raid", "PvP"];

interface SidebarProps {
  onNavigate: (view: "main" | "settings" | "debug") => void;
  currentView: "main" | "settings" | "debug";
  showDebug: boolean;
}

interface SidebarNavButtonProps {
  label: string;
  icon: ComponentType<{ className?: string }>;
  isActive: boolean;
  activeClassName: string;
  defaultClassName: string;
  onClick: () => void;
  reduceMotion: boolean | null;
}

function SidebarNavButton({
  label,
  icon: Icon,
  isActive,
  activeClassName,
  defaultClassName,
  onClick,
  reduceMotion,
}: SidebarNavButtonProps) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-current={isActive ? "page" : undefined}
      className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-1)] ${
        isActive ? activeClassName : defaultClassName
      }`}
      whileHover={reduceMotion ? undefined : { x: 2 }}
      whileTap={reduceMotion ? undefined : { scale: 0.99 }}
    >
      <Icon className="h-4 w-4" />
      {label}
    </motion.button>
  );
}

export function Sidebar({ onNavigate, currentView, showDebug }: SidebarProps) {
  const [activeMode, setActiveMode] = useState<string | null>(null);
  const reduceMotion = useReducedMotion();
  const { isRecording, recordingDuration } = useRecording();
  const isMain = currentView === "main";
  const isSettings = currentView === "settings";
  const isDebug = currentView === "debug";

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <aside className="flex w-full shrink-0 flex-col border-b border-emerald-300/10 bg-[var(--surface-1)]/95 backdrop-blur-md lg:w-56 lg:border-b-0 lg:border-r">
      <div className="border-b border-emerald-300/10 px-3 py-3">
        <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-200">
          <PanelLeft className="h-3.5 w-3.5" />
          Navigation
        </div>
        <nav className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-1" aria-label="Primary">
          <SidebarNavButton
            label="Home"
            icon={Radar}
            isActive={isMain}
            activeClassName="border-emerald-300/30 bg-emerald-500/15 text-emerald-100"
            defaultClassName="border-transparent text-neutral-300 hover:border-emerald-300/20 hover:bg-white/5 hover:text-neutral-100"
            onClick={() => onNavigate("main")}
            reduceMotion={reduceMotion}
          />
          <SidebarNavButton
            label="Settings"
            icon={SlidersHorizontal}
            isActive={isSettings}
            activeClassName="border-emerald-300/30 bg-emerald-500/15 text-emerald-100"
            defaultClassName="border-transparent text-neutral-300 hover:border-emerald-300/20 hover:bg-white/5 hover:text-neutral-100"
            onClick={() => onNavigate("settings")}
            reduceMotion={reduceMotion}
          />
          {showDebug && (
            <SidebarNavButton
              label="Debug"
              icon={Bug}
              isActive={isDebug}
              activeClassName="border-amber-300/35 bg-amber-500/15 text-amber-100"
              defaultClassName="border-transparent text-neutral-300 hover:border-amber-300/25 hover:bg-white/5 hover:text-neutral-100"
              onClick={() => onNavigate("debug")}
              reduceMotion={reduceMotion}
            />
          )}
        </nav>
      </div>

      <nav className="flex-1 p-3" aria-label="Game mode">
        <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-neutral-500">
          <Activity className="h-3.5 w-3.5" />
          Game Mode
        </div>
        <div className="space-y-1.5">
          {gameModes.map((mode) => (
            <motion.button
              key={mode}
              type="button"
              onClick={() => setActiveMode(activeMode === mode ? null : mode)}
              aria-pressed={activeMode === mode}
              className={`w-full text-left px-3 py-2 rounded-md text-sm border transition-colors ${
                activeMode === mode
                  ? "border-emerald-300/30 bg-emerald-500/12 text-emerald-100"
                  : "border-transparent text-neutral-400 hover:text-neutral-100 hover:border-emerald-300/15 hover:bg-white/5"
              }`}
              whileHover={reduceMotion ? undefined : { x: 2 }}
              whileTap={reduceMotion ? undefined : { scale: 0.99 }}
            >
              {mode}
            </motion.button>
          ))}
        </div>
      </nav>

      <div className="border-t border-emerald-300/10 p-3">
        <motion.div
          className={`relative rounded-md px-3 py-2 transition-colors ${
            isRecording
              ? "border border-rose-300/40 bg-rose-500/15 shadow-[0_0_0_1px_rgba(251,113,133,0.22)]"
              : "border border-emerald-300/15 bg-emerald-500/10"
          }`}
          initial={false}
          animate={{ scale: isRecording ? [1, 1.008, 1] : [1, 1, 1] }}
          transition={{ duration: 0.24, ease: "easeOut" }}
          role="status"
          aria-live="polite"
        >
          <AnimatePresence>
            {isRecording && (
              <motion.div
                key="recording-border-burst"
                className="pointer-events-none absolute inset-0 rounded-md border border-rose-200/55"
                initial={{ scale: 0.72, opacity: 0 }}
                animate={{
                  scale: [0.72, 1.03, 1.06],
                  opacity: [0, 0.45, 0],
                }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.55, ease: "easeOut" }}
              />
            )}
          </AnimatePresence>

          <div
            className={`text-[11px] uppercase tracking-[0.12em] ${
              isRecording ? "text-rose-200" : "text-emerald-300"
            }`}
          >
            App Status
          </div>
          <AnimatePresence mode="wait" initial={false}>
            {isRecording ? (
              <motion.div
                key="recording-status"
                className="mt-1 inline-flex items-center gap-1.5 text-xs text-rose-100"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
              >
                <motion.span
                  className="h-2 w-2 rounded-full bg-rose-300"
                  animate={{
                    opacity: [0.55, 1, 0.55],
                    scale: [0.95, 1.05, 0.95],
                  }}
                  transition={{
                    duration: 1.2,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                />
                <span>
                  Recording <span className="font-mono">{formatDuration(recordingDuration)}</span>
                </span>
              </motion.div>
            ) : (
              <motion.div
                key="idle-status"
                className="mt-1 text-xs text-neutral-300"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
              >
                Ready to record.
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </aside>
  );
}
