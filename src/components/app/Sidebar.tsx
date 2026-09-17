import { getVersion } from "@tauri-apps/api/app";
import {
  AlertTriangle,
  Bug,
  Circle,
  ExternalLink,
  GitBranch,
  LoaderCircle,
  Radar,
  Shield,
  SlidersHorizontal,
  Swords,
  Trophy,
  UploadCloud,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { useRecording } from "../../contexts/RecordingContext";
import { useWclUpload } from "../../contexts/WclUploadContext";
import { type AppView } from "../../types/ui";
import { formatTime } from "../../utils/format";
import { SidebarDividerBlock } from "./sidebar/SidebarDividerBlock";
import { SidebarNavButton } from "./sidebar/SidebarNavButton";
import { SidebarSectionLabel } from "./sidebar/SidebarSectionLabel";

const gameModes = [
  { label: "Mythic+", view: "mythic-plus", icon: Swords },
  { label: "Raid", view: "raid", icon: Shield },
  { label: "PvP", view: "pvp", icon: Trophy },
] as const;
const REPOSITORY_URL = "https://github.com/RobDeFlop/FloorPoV";

interface SidebarProps {
  onNavigate: (view: AppView) => void;
  currentView: AppView;
  isDebugMode: boolean;
}

export function Sidebar({ onNavigate, currentView, isDebugMode }: SidebarProps) {
  const [isRecordingBusy, setIsRecordingBusy] = useState(false);
  const [recordingAction, setRecordingAction] = useState<'starting' | 'stopping' | null>(null);
  const [appVersion, setAppVersion] = useState<string>("...");
  const reduceMotion = useReducedMotion();
  const {
    isRecording,
    recordingDuration,
    appStatusDetail,
    lastError,
    isSelectedWindowAlive,
    startRecording,
    stopRecording,
  } = useRecording();
  const { isLiveUploading, stopLiveUpload } = useWclUpload();
  const isMain = currentView === "main";
  const isSettings = currentView === "settings";
  const isWarcraftLogs = currentView === "warcraftlogs";
  const isDebug = currentView === "debug";
  // When idle and the selected window is gone, shift the status box to amber.
  const idleTheme = isSelectedWindowAlive ? "emerald" : "amber";

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

  const getRecordingIcon = () => {
    const iconClass = recordingAction 
      ? "text-amber-300" 
      : isRecording 
        ? "text-rose-300" 
        : idleTheme === "amber" ? "text-amber-300" : "text-emerald-300";
    
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

    if (!isRecording && !isSelectedWindowAlive) {
      return 'Selected window is not running';
    }

    if (isRecording) {
      return `Stop recording (${formatTime(recordingDuration)})`;
    }

    return 'Start recording';
  };

  useEffect(() => {
    let isMounted = true;

    const loadAppVersion = async () => {
      try {
        const version = await getVersion();
        if (isMounted) {
          setAppVersion(version);
        }
      } catch (error) {
        console.error("Failed to load app version:", error);
        if (isMounted) {
          setAppVersion("unknown");
        }
      }
    };

    loadAppVersion();

    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <aside className="flex max-h-[45vh] min-h-0 w-full shrink-0 flex-col overflow-y-auto border-b border-white/10 bg-(--surface-1) backdrop-blur-md md:h-full md:max-h-none md:w-56 md:min-w-56 md:border-b-0 md:border-r">
      <div className="px-3 py-3">
        <SidebarSectionLabel label="Navigation" />
        <nav className="grid gap-1.5 sm:grid-cols-2 md:grid-cols-1" aria-label="Primary">
          <SidebarNavButton
            label="Home"
            icon={Radar}
            isActive={isMain}
            activeClassName="border-l-2 border-l-emerald-300/75 bg-emerald-500/10 text-neutral-100"
            defaultClassName="border-l-2 border-l-transparent text-neutral-300 hover:border-white/20 hover:bg-white/5 hover:text-neutral-100"
            onClick={() => onNavigate("main")}
          />
          <SidebarNavButton
            label="Settings"
            icon={SlidersHorizontal}
            isActive={isSettings}
            activeClassName="border-l-2 border-l-emerald-300/75 bg-emerald-500/10 text-neutral-100"
            defaultClassName="border-l-2 border-l-transparent text-neutral-300 hover:border-white/20 hover:bg-white/5 hover:text-neutral-100"
            onClick={() => onNavigate("settings")}
          />
        </nav>
      </div>

      <nav className="flex-1 px-3 pb-3" aria-label="Game modes">
        <SidebarDividerBlock>
          <SidebarSectionLabel label="Game modes" />
          <div className="grid gap-1.5 sm:grid-cols-2 md:grid-cols-1">
            {gameModes.map(({ label, view, icon: Icon }) => (
              <SidebarNavButton
                key={view}
                label={label}
                icon={Icon}
                isActive={currentView === view}
                activeClassName="border-l-2 border-l-emerald-300/75 bg-emerald-500/10 text-neutral-100"
                defaultClassName="border-l-2 border-l-transparent text-neutral-300 hover:border-white/20 hover:bg-white/5 hover:text-neutral-100"
                onClick={() => onNavigate(view)}
              />
            ))}
          </div>
        </SidebarDividerBlock>

        <SidebarDividerBlock>
          <SidebarSectionLabel label="Integrations" />
          <div className="grid gap-1.5 sm:grid-cols-2 md:grid-cols-1">
            <SidebarNavButton
              label="Upload"
              icon={UploadCloud}
              isActive={isWarcraftLogs}
              activeClassName="border-l-2 border-l-emerald-300/75 bg-emerald-500/10 text-neutral-100"
              defaultClassName="border-l-2 border-l-transparent text-neutral-300 hover:border-white/20 hover:bg-white/5 hover:text-neutral-100"
              onClick={() => onNavigate("warcraftlogs")}
            />
            {isLiveUploading && (
              <button
                type="button"
                className="inline-flex items-center justify-between rounded-sm border border-emerald-300/35 bg-emerald-500/12 px-3 py-2 text-xs text-emerald-100 transition-colors hover:bg-emerald-500/20"
                onClick={() => {
                  void stopLiveUpload();
                }}
              >
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 animate-pulse" />
                  Live log active
                </span>
                <span className="font-medium text-emerald-50">Stop</span>
              </button>
            )}
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
              activeClassName="border-l-2 border-l-neutral-300/70 bg-neutral-500/10 text-neutral-100"
              defaultClassName="border-l-2 border-l-transparent text-neutral-500 hover:border-neutral-300/15 hover:bg-white/3 hover:text-neutral-300"
              onClick={() => onNavigate("debug")}
            />
          </SidebarDividerBlock>
        )}

        <motion.button
          type="button"
          onClick={handleRecordingToggle}
          disabled={isRecordingBusy || (!isRecording && !isSelectedWindowAlive)}
          className={`relative rounded-sm px-3 py-2 transition-colors cursor-pointer w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 ${
            isRecording
              ? "border border-rose-300/40 bg-rose-500/15 shadow-[0_0_0_1px_rgba(251,113,133,0.22)] hover:bg-rose-500/20"
              : idleTheme === "amber"
                ? "border border-amber-300/40 bg-amber-500/15 shadow-[0_0_0_1px_rgba(251,191,36,0.22)] hover:bg-amber-500/20"
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
                    isRecording ? "text-rose-200" : idleTheme === "amber" ? "text-amber-300" : "text-emerald-300"
                  }`}
                >
                  Recording
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
                        Recording <span className="font-mono">{formatTime(recordingDuration)}</span>
                      </span>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="idle-status"
                      className={`flex h-4 items-center whitespace-nowrap text-xs ${idleTheme === "amber" ? "text-amber-200" : "text-neutral-300"}`}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2, ease: "easeOut" }}
                    >
                      {idleTheme === "amber" ? "Window not running." : "Ready to record."}
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

        {lastError && (
          <p
            className="mt-2 rounded-sm border border-rose-300/30 bg-rose-500/10 px-2.5 py-2 text-xs leading-5 text-rose-200"
            role="alert"
          >
            <span className="inline-flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-300" aria-hidden="true" />
              <span>Recording failed. Try again: {lastError}</span>
            </span>
          </p>
        )}

        <footer className="mt-3 border-t border-white/5 pt-3" aria-label="About">
          <a
            href={REPOSITORY_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex w-full items-center justify-between rounded-sm border border-transparent px-2.5 py-2 text-xs text-neutral-400 transition-colors hover:border-white/15 hover:bg-white/5 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 focus-visible:ring-offset-2 focus-visible:ring-offset-(--surface-1)"
          >
            <span className="inline-flex items-center gap-1.5">
              <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
              GitHub
            </span>
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
          <p className="mt-2 text-center text-[10px] tracking-[0.08em] text-neutral-500">{appVersion}</p>
        </footer>
      </div>
    </aside>
  );
}
