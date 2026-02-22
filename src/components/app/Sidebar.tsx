import { type ComponentType, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Button } from "../ui/Button";
import {
  Activity,
  Bug,
  Circle,
  ExternalLink,
  Github,
  LoaderCircle,
  PanelLeft,
  Radar,
  SlidersHorizontal,
} from "lucide-react";
import { useRecording } from "../../contexts/RecordingContext";


const gameModes = ["Mythic+", "Raid", "PvP"];
const REPOSITORY_URL = "https://github.com/RobDeFlop/FloorPoV";

interface SidebarProps {
  onNavigate: (view: "main" | "settings" | "debug" | "mythic-plus" | "raid" | "pvp") => void;
  currentView: "main" | "settings" | "debug" | "mythic-plus" | "raid" | "pvp";
  isDebugMode: boolean;
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
}: SidebarNavButtonProps) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className={`flex w-full items-center gap-2 ${
        isActive ? activeClassName : defaultClassName
      }`}
      ariaLabel={label}
    >
      <Icon className="h-4 w-4" />
      {label}
    </Button>
  );
}

export function Sidebar({ onNavigate, currentView, isDebugMode }: SidebarProps) {
  const [isRecordingBusy, setIsRecordingBusy] = useState(false);
  const [recordingAction, setRecordingAction] = useState<'starting' | 'stopping' | null>(null);
  const reduceMotion = useReducedMotion();
  const { isRecording, recordingDuration, startRecording, stopRecording } = useRecording();
  const isMain = currentView === "main";
  const isSettings = currentView === "settings";
  const isDebug = currentView === "debug";

  const handleRecordingToggle = async () => {
    if (isRecordingBusy) {
      return;
    }

    setIsRecordingBusy(true);
    const shouldStopRecording = isRecording;
    setRecordingAction(shouldStopRecording ? 'stopping' : 'starting');
    
    try {
      if (shouldStopRecording) {
        await stopRecording();
      } else {
        await startRecording();
      }
    } catch (error) {
      console.error("Recording toggle failed:", error);
    } finally {
      setIsRecordingBusy(false);
      setRecordingAction(null);
    }
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const getRecordingIcon = () => {
    const iconClass = recordingAction 
      ? "text-amber-300" 
      : isRecording 
        ? "text-rose-300" 
        : "text-emerald-300";
    
    if (recordingAction) {
      return <LoaderCircle className={`h-3 w-3 animate-spin ${iconClass}`} />;
    }
    
    if (isRecording) {
      return (
        <motion.span
          className="inline-flex h-3 w-3 rounded-full bg-rose-300"
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
      );
    }
    
    return <Circle className={`h-3 w-3 ${iconClass}`} fill="currentColor" />;
  };

  const getRecordingTooltip = () => {
    if (recordingAction) {
      return recordingAction === 'stopping' ? 'Stopping...' : 'Starting...';
    }
    
    if (isRecording) {
      return `Stop recording (${formatDuration(recordingDuration)})`;
    }
    
    return 'Start recording';
  };

  return (
    <aside className="flex w-full shrink-0 flex-col border-b border-white/10 bg-[var(--surface-1)]/95 backdrop-blur-md lg:w-56 lg:border-b-0 lg:border-r">
      <div className="border-b border-white/10 px-3 py-3">
        <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-300">
          <PanelLeft className="h-3.5 w-3.5" />
          Navigation
        </div>
        <nav className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-1" aria-label="Primary">
          <SidebarNavButton
            label="Home"
            icon={Radar}
            isActive={isMain}
            activeClassName="border-emerald-300/30 bg-emerald-500/15 text-emerald-100"
            defaultClassName="border-transparent text-neutral-300 hover:border-white/20 hover:bg-white/5 hover:text-neutral-100"
            onClick={() => onNavigate("main")}
            reduceMotion={reduceMotion}
          />
          <SidebarNavButton
            label="Settings"
            icon={SlidersHorizontal}
            isActive={isSettings}
            activeClassName="border-emerald-300/30 bg-emerald-500/15 text-emerald-100"
            defaultClassName="border-transparent text-neutral-300 hover:border-white/20 hover:bg-white/5 hover:text-neutral-100"
            onClick={() => onNavigate("settings")}
            reduceMotion={reduceMotion}
          />
        </nav>
      </div>

      <nav className="flex-1 p-3" aria-label="Game mode">
        <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-neutral-500">
          <Activity className="h-3.5 w-3.5" />
          Game Mode
        </div>
        <div className="space-y-1.5">
           {gameModes.map((mode) => {
            const isActive = 
              (mode === "Mythic+" && currentView === "mythic-plus") ||
              (mode === "Raid" && currentView === "raid") ||
              (mode === "PvP" && currentView === "pvp");
            
            const navigateTo = () => {
              switch (mode) {
                case "Mythic+":
                  onNavigate("mythic-plus");
                  break;
                case "Raid":
                  onNavigate("raid");
                  break;
                case "PvP":
                  onNavigate("pvp");
                  break;
              }
            };
            
            return (
              <motion.button
                key={mode}
                type="button"
                onClick={navigateTo}
                aria-pressed={isActive}
                className={`w-full text-left px-3 py-2 rounded-sm text-sm border transition-colors ${
                  isActive
                    ? "border-emerald-300/30 bg-emerald-500/12 text-emerald-100"
                    : "border-transparent text-neutral-400 hover:text-neutral-100 hover:border-white/15 hover:bg-white/5"
                }`}
                whileHover={reduceMotion ? undefined : { x: 2 }}
                whileTap={reduceMotion ? undefined : { scale: 0.99 }}
              >
                {mode}
              </motion.button>
            );
          })}
        </div>
      </nav>

      <div className="border-t border-white/10 p-3">
        {isDebugMode && (
          <div className="mb-3">
            <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-neutral-500">
              Developer
            </div>
            <SidebarNavButton
              label="Debug"
              icon={Bug}
              isActive={isDebug}
              activeClassName="border-amber-300/35 bg-amber-500/15 text-amber-100"
              defaultClassName="border-transparent text-neutral-300 hover:border-amber-300/25 hover:bg-white/5 hover:text-neutral-100"
              onClick={() => onNavigate("debug")}
              reduceMotion={reduceMotion}
            />
          </div>
        )}

        <motion.button
          type="button"
          onClick={handleRecordingToggle}
          disabled={isRecordingBusy}
          className={`relative rounded-sm px-3 py-2 transition-colors cursor-pointer w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 ${
            isRecording
              ? "border border-rose-300/40 bg-rose-500/15 shadow-[0_0_0_1px_rgba(251,113,133,0.22)] hover:bg-rose-500/20"
              : "border border-emerald-300/20 bg-emerald-500/12 shadow-[0_0_0_1px_rgba(16,185,129,0.14)] hover:bg-emerald-500/18"
          } disabled:opacity-50 disabled:cursor-not-allowed`}
          whileHover={reduceMotion ? undefined : { y: -1 }}
          whileTap={reduceMotion ? undefined : { scale: 0.98 }}
          title={getRecordingTooltip()}
          aria-label={getRecordingTooltip()}
          role="button"
          aria-pressed={isRecording}
        >
          <AnimatePresence>
            {isRecording && (
              <motion.div
                key="recording-border-burst"
                className="pointer-events-none absolute inset-0 rounded-sm border border-rose-200/55"
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

          <div className="flex items-start gap-1.5">
            <span className="mt-0.5 inline-flex h-3 w-3 shrink-0 items-center justify-center">
              {getRecordingIcon()}
            </span>
            <div className="flex-1">
              <div className="flex items-center gap-1.5">
                <div
                  className={`text-[11px] uppercase tracking-[0.12em] ${
                    isRecording ? "text-rose-200" : "text-emerald-300"
                  }`}
                >
                  App Status
                </div>
              </div>
              <div className="mt-1 h-4 overflow-hidden">
                <AnimatePresence mode="wait" initial={false}>
                  {isRecording ? (
                    <motion.div
                      key="recording-status"
                      className="flex h-4 items-center whitespace-nowrap text-xs text-rose-100"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2, ease: "easeOut" }}
                    >
                      <span>
                        Recording <span className="font-mono">{formatDuration(recordingDuration)}</span>
                      </span>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="idle-status"
                      className="flex h-4 items-center whitespace-nowrap text-xs text-neutral-300"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2, ease: "easeOut" }}
                    >
                      Ready to record.
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>
        </motion.button>

        <a
          href={REPOSITORY_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-3 inline-flex w-full items-center justify-between rounded-sm border border-transparent px-2.5 py-2 text-xs text-neutral-400 transition-colors hover:border-white/15 hover:bg-white/5 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-1)]"
        >
          <span className="inline-flex items-center gap-1.5">
            <Github className="h-3.5 w-3.5" />
            GitHub
          </span>
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    </aside>
  );
}
