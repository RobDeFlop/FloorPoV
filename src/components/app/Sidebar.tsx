import {
  Bug,
  Circle,
  ExternalLink,
  Github,
  LoaderCircle,
  Radar,
  Shield,
  SlidersHorizontal,
  Swords,
  Trophy,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { useRecording } from "../../contexts/RecordingContext";
import { SidebarDividerBlock } from "./sidebar/SidebarDividerBlock";
import { SidebarNavButton } from "./sidebar/SidebarNavButton";
import { SidebarSectionLabel } from "./sidebar/SidebarSectionLabel";


const gameModes = ["Mythic+", "Raid", "PvP"];
const REPOSITORY_URL = "https://github.com/RobDeFlop/FloorPoV";

interface SidebarProps {
  onNavigate: (view: "main" | "settings" | "debug" | "mythic-plus" | "raid" | "pvp") => void;
  currentView: "main" | "settings" | "debug" | "mythic-plus" | "raid" | "pvp";
  isDebugMode: boolean;
}

export function Sidebar({ onNavigate, currentView, isDebugMode }: SidebarProps) {
  const [isRecordingBusy, setIsRecordingBusy] = useState(false);
  const [recordingAction, setRecordingAction] = useState<'starting' | 'stopping' | null>(null);
  const reduceMotion = useReducedMotion();
  const {
    isRecording,
    recordingDuration,
    appStatusDetail,
    startRecording,
    stopRecording,
  } = useRecording();
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
    <aside className="flex w-full shrink-0 flex-col border-b border-white/10 bg-(--surface-1) backdrop-blur-md lg:w-56 lg:border-b-0 lg:border-r">
      <div className="px-3 py-3">
        <SidebarSectionLabel label="Navigation" />
        <nav className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-1" aria-label="Primary">
          <SidebarNavButton
            label="Home"
            icon={Radar}
            isActive={isMain}
            activeClassName="border-emerald-300/30 bg-emerald-500/15 text-emerald-100"
            defaultClassName="border-transparent text-neutral-300 hover:border-white/20 hover:bg-white/5 hover:text-neutral-100"
            onClick={() => onNavigate("main")}
          />
          <SidebarNavButton
            label="Settings"
            icon={SlidersHorizontal}
            isActive={isSettings}
            activeClassName="border-emerald-300/30 bg-emerald-500/15 text-emerald-100"
            defaultClassName="border-transparent text-neutral-300 hover:border-white/20 hover:bg-white/5 hover:text-neutral-100"
            onClick={() => onNavigate("settings")}
          />
        </nav>
      </div>

      <nav className="flex-1 px-3 pb-3" aria-label="Game mode">
        <SidebarDividerBlock>
          <SidebarSectionLabel label="Game Mode" />
          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-1">
              {gameModes.map((mode) => {
              const isActive = 
                (mode === "Mythic+" && currentView === "mythic-plus") ||
                (mode === "Raid" && currentView === "raid") ||
                (mode === "PvP" && currentView === "pvp");
             
             const getGameModeIcon = () => {
               switch (mode) {
                 case "Mythic+":
                   return Swords;
                 case "Raid":
                   return Shield;
                 case "PvP":
                   return Trophy;
                 default:
                   return () => null;
               }
             };
             
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
                <SidebarNavButton
                  key={mode}
                  label={mode}
                  icon={getGameModeIcon()}
                  isActive={isActive}
                  activeClassName="border-emerald-300/30 bg-emerald-500/15 text-emerald-100"
                  defaultClassName="border-transparent text-neutral-300 hover:border-white/20 hover:bg-white/5 hover:text-neutral-100"
                  onClick={navigateTo}
                />
              );
            })}
          </div>
        </SidebarDividerBlock>
      </nav>

      <div className="p-3">
        {isDebugMode && (
          <SidebarDividerBlock>
            <SidebarSectionLabel label="Developer" />
            <SidebarNavButton
              label="Debug"
              icon={Bug}
              isActive={isDebug}
              activeClassName="border-neutral-300/25 bg-neutral-500/10 text-neutral-200"
              defaultClassName="border-transparent text-neutral-500 hover:border-neutral-300/15 hover:bg-white/3 hover:text-neutral-300"
              onClick={() => onNavigate("debug")}
            />
          </SidebarDividerBlock>
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
              {appStatusDetail && (
                <p className="mt-1 truncate text-[10px] text-neutral-400" title={appStatusDetail}>
                  {appStatusDetail}
                </p>
              )}
            </div>
          </div>
        </motion.button>

        <a
          href={REPOSITORY_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-3 inline-flex w-full items-center justify-between rounded-sm border border-transparent px-2.5 py-2 text-xs text-neutral-400 transition-colors hover:border-white/15 hover:bg-white/5 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 focus-visible:ring-offset-2 focus-visible:ring-offset-(--surface-1)"
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
