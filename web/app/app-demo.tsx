"use client";

import {
  ArrowLeft,
  Camera,
  Circle,
  CircleStop,
  Clapperboard,
  Download,
  ExternalLink,
  FileInput,
  FileSearch,
  FileText,
  Flag,
  GitBranch,
  Keyboard,
  ListVideo,
  Maximize,
  Pause,
  Play,
  Radar,
  Shield,
  SkipBack,
  SkipForward,
  Skull,
  SlidersHorizontal,
  StickyNote,
  Swords,
  Trophy,
  UploadCloud,
  Volume2,
  VolumeX,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  AnimatePresence,
  motion,
  useInView,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "motion/react";
import Image from "next/image";
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

// The demo reuses markup and classes from the desktop app's Layout, TitleBar, Sidebar,
// PageHeader, TabControls, VideoPlayer, and PlaybackEventList components.

export type DemoEventType = "encounterStart" | "encounterEnd" | "death" | "bloodlust" | "manual" | "note";
type AnalysisTab = "video-analysis" | "log-analysis" | "metadata";

interface DemoEvent {
  id: string;
  type: DemoEventType;
  timestamp: number;
  unit?: string;
  name?: string;
}

// The app is laid out at a fixed desktop size and scaled to fit, so proportions match the app.
const DESIGN_WIDTH = 1440;
const DESIGN_HEIGHT = 900;
const DURATION_SECONDS = 392;
const ENCOUNTER_END_SECONDS = 386;
const START_SECONDS = 98;
const EVENT_SEEK_OFFSET_SECONDS = 5;
const SKIP_SEEK_SECONDS = 10;
const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const APP_VERSION = "0.2.2";

// From the raid recording in the README screenshots. The log lists 20 deaths; these are the
// ones visible in the screenshots.
const RECORDED_EVENTS: DemoEvent[] = [
  { id: "r1", type: "encounterStart", timestamp: 0, name: "The Coiled Altar" },
  { id: "r2", type: "death", timestamp: 106, unit: "Daélya-ArgentDawn" },
  { id: "r3", type: "death", timestamp: 108, unit: "Trackpad-Draenor" },
  { id: "r4", type: "death", timestamp: 110, unit: "Fknm-TwistingNether" },
  { id: "r5", type: "bloodlust", timestamp: 308, unit: "Trackpad-Draenor" },
  { id: "r6", type: "bloodlust", timestamp: 308, unit: "Ieá-TarrenMill" },
  { id: "r7", type: "death", timestamp: 352, unit: "Fknm-TwistingNether" },
  { id: "r8", type: "death", timestamp: 352, unit: "Invaria-Silvermoon" },
  { id: "r9", type: "death", timestamp: 375, unit: "Trackpad-Draenor" },
  { id: "r10", type: "death", timestamp: 375, unit: "Örklock-TarrenMill" },
  { id: "r11", type: "death", timestamp: 375, unit: "Lockopewpew-Zul'jin" },
  { id: "r12", type: "death", timestamp: 376, unit: "Ninesecrets-Archimonde" },
  { id: "r13", type: "death", timestamp: 376, unit: "Ieá-TarrenMill" },
  { id: "r14", type: "death", timestamp: 377, unit: "Silvash-Kazzak" },
  { id: "r15", type: "death", timestamp: 377, unit: "Faradk-Draenor" },
  { id: "r16", type: "death", timestamp: 377, unit: "Disqualified-Ravencrest" },
  { id: "r17", type: "death", timestamp: 377, unit: "Amirxd-Silvermoon" },
  { id: "r18", type: "encounterEnd", timestamp: ENCOUNTER_END_SECONDS, name: "The Coiled Altar" },
];

const MARKER_ICONS: Record<DemoEventType, LucideIcon> = {
  death: Skull,
  manual: Flag,
  bloodlust: Zap,
  encounterStart: Swords,
  encounterEnd: CircleStop,
  note: StickyNote,
};

const MARKER_CLASS_NAMES: Record<DemoEventType, string> = {
  death: "rounded-full bg-rose-500 text-rose-950",
  manual: "rounded-sm bg-neutral-400 text-neutral-900",
  bloodlust: "rounded-full bg-sky-400 text-sky-950",
  encounterStart: "rounded-full bg-fuchsia-400 text-fuchsia-950",
  encounterEnd: "rounded-full bg-neutral-300 text-neutral-900",
  note: "rounded-sm bg-violet-400 text-violet-950",
};

const EVENT_LIST_LABELS: Record<DemoEventType, string> = {
  death: "Death",
  manual: "Marker",
  bloodlust: "Bloodlust",
  encounterStart: "Encounter start",
  encounterEnd: "Encounter end",
  note: "Note",
};

const TOOLTIP_LABELS: Record<DemoEventType, string> = {
  death: "Death",
  manual: "Manual Marker",
  bloodlust: "Bloodlust",
  encounterStart: "Encounter Start",
  encounterEnd: "Encounter End",
  note: "Note",
};

const FILTER_LABELS: Record<DemoEventType, string> = {
  death: "Deaths",
  manual: "Markers",
  bloodlust: "Bloodlust",
  encounterStart: "Encounter start",
  encounterEnd: "Encounter end",
  note: "Notes",
};

const FILTER_TYPES: DemoEventType[] = [
  "encounterStart",
  "encounterEnd",
  "death",
  "manual",
  "bloodlust",
  "note",
];

const ANALYSIS_TABS: { value: AnalysisTab; label: string; icon: LucideIcon }[] = [
  { value: "video-analysis", label: "Video analysis", icon: Clapperboard },
  { value: "log-analysis", label: "Log analysis", icon: FileSearch },
  { value: "metadata", label: "Metadata", icon: FileText },
];

const SHORTCUTS = [
  { keys: "Space", action: "Play or pause" },
  { keys: "J / L", action: "Skip 10 seconds" },
  { keys: "M", action: "Add a marker (global hotkey in the app)" },
  { keys: "N", action: "Add a note" },
];

const SURFACE_0 = "bg-[rgba(10,10,11,0.88)]";
const SURFACE_1 = "bg-[rgba(14,14,16,0.9)]";
const SURFACE_2 = "bg-[rgba(20,20,22,0.92)]";
const SURFACE_GLOW =
  "shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_10px_24px_rgba(0,0,0,0.45)]";
const SIDEBAR_ACTIVE = "border-l-2 border-l-emerald-300/75 bg-emerald-500/10 text-neutral-100";
const SIDEBAR_DEFAULT =
  "border-l-2 border-l-transparent text-neutral-300 hover:border-white/20 hover:bg-white/5 hover:text-neutral-100";

function formatTime(totalSeconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${(wholeSeconds % 60).toString().padStart(2, "0")}`;
}

function formatUnitName(unit?: string): string {
  return unit ? unit.split("-")[0] : "Unknown";
}

function getEventDetail(event: DemoEvent): string {
  if (event.type === "death" || event.type === "bloodlust") return formatUnitName(event.unit);
  return event.name ?? "Encounter";
}

function getEventDescription(event: DemoEvent): string {
  if (event.type === "death") return `${formatUnitName(event.unit)} died`;
  if (event.type === "bloodlust") return `${formatUnitName(event.unit)} used Bloodlust`;
  if (event.type === "manual") return "User marked this moment";
  return event.name ?? "";
}

export function EventMarker({ type, className = "" }: { type: DemoEventType; className?: string }) {
  const Icon = MARKER_ICONS[type];
  return (
    <span
      className={`flex h-4 w-4 items-center justify-center ${MARKER_CLASS_NAMES[type]} ${className}`}
    >
      <Icon className="h-2.5 w-2.5" />
    </span>
  );
}

function ControlIconButton({ label, onClick, children }: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded p-1 text-white transition-colors hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function SidebarSectionLabel({ label }: { label: string }) {
  return (
    <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-300">
      {label}
    </div>
  );
}

function SidebarNavItem({ label, icon: Icon, isActive = false }: {
  label: string;
  icon: LucideIcon;
  isActive?: boolean;
}) {
  return (
    <div
      className={`flex w-full items-center gap-2 rounded-sm border border-transparent px-4 py-2 text-sm font-medium transition-colors ${
        isActive ? SIDEBAR_ACTIVE : SIDEBAR_DEFAULT
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </div>
  );
}

function PlaybackClock({ playbackTime }: { playbackTime: MotionValue<number> }) {
  const [wholeSeconds, setWholeSeconds] = useState(() => Math.floor(playbackTime.get()));
  // Setting the same number bails out, so this renders once per displayed second.
  useMotionValueEvent(playbackTime, "change", (value) => setWholeSeconds(Math.floor(value)));
  return (
    <span className="font-mono text-xs text-white">
      {formatTime(wholeSeconds)} / {formatTime(DURATION_SECONDS)}
    </span>
  );
}

function findActiveEventId(events: DemoEvent[], time: number): string | null {
  let activeId: string | null = null;
  for (const event of events) {
    if (event.timestamp > time) break;
    activeId = event.id;
  }
  return activeId;
}

const EventListItems = memo(function EventListItems({ events, playbackTime, onSelect }: {
  events: DemoEvent[];
  playbackTime: MotionValue<number>;
  onSelect: (timestamp: number) => void;
}) {
  // The state only triggers a render when the highlighted event changes. Reading the motion
  // value during render keeps the highlight right after filters change the event list.
  const [, setActiveEventId] = useState<string | null>(null);
  useMotionValueEvent(playbackTime, "change", (value) =>
    setActiveEventId(findActiveEventId(events, value)),
  );
  const currentActiveId = findActiveEventId(events, playbackTime.get());

  return (
    <ul className="py-1">
      {events.map((event) => {
        const isActive = event.id === currentActiveId;
        return (
          <li key={event.id} className={isActive ? "bg-white/10" : undefined}>
            <div className={`flex w-full items-start gap-2 px-3 py-2 transition-colors ${isActive ? "" : "hover:bg-white/5"}`}>
              <button
                type="button"
                onClick={() => onSelect(event.timestamp)}
                className="flex min-w-0 flex-1 items-start gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
                aria-current={isActive ? "true" : undefined}
                aria-label={`Seek to ${EVENT_LIST_LABELS[event.type]} at ${formatTime(event.timestamp)}`}
              >
                <span className="mt-0.5 shrink-0">
                  <EventMarker type={event.type} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium text-neutral-100">
                      {EVENT_LIST_LABELS[event.type]}
                    </span>
                    <span className="font-mono text-[11px] text-neutral-400">
                      {formatTime(event.timestamp)}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-neutral-400">
                    {getEventDetail(event)}
                  </span>
                </span>
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
});

function useFitScale(): [React.RefObject<HTMLDivElement | null>, number] {
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => {
      setScale(entry.contentRect.width / DESIGN_WIDTH);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  return [frameRef, scale];
}

export function AppDemo() {
  const [frameRef, scale] = useFitScale();
  const isInView = useInView(frameRef, { amount: 0.3 });
  const prefersReducedMotion = useReducedMotion();

  // Playback time lives in a motion value so the seek bar moves every frame without
  // re-rendering the whole app copy. React state only follows the displayed whole second.
  const playbackTime = useMotionValue(START_SECONDS);
  const timelineRef = useRef<HTMLDivElement>(null);
  useMotionValueEvent(playbackTime, "change", (value) => {
    timelineRef.current?.setAttribute("aria-valuenow", String(Math.round(value)));
    timelineRef.current?.setAttribute("aria-valuetext", `${formatTime(value)} of ${formatTime(DURATION_SECONDS)}`);
  });
  const progressWidth = useTransform(playbackTime, (value) => `${(value / DURATION_SECONDS) * 100}%`);
  const progressKnobLeft = useTransform(
    playbackTime,
    (value) => `calc(${(value / DURATION_SECONDS) * 100}% - 6px)`,
  );
  // "auto" plays while the demo is on screen until the visitor takes control.
  const [playMode, setPlayMode] = useState<"auto" | "playing" | "paused">("auto");
  const [playbackRate, setPlaybackRate] = useState(1);
  const [volume, setVolume] = useState(0.8);
  const [activeTab, setActiveTab] = useState<AnalysisTab>("video-analysis");
  const [hiddenTypes, setHiddenTypes] = useState<Set<DemoEventType>>(new Set());
  const [addedEvents, setAddedEvents] = useState<DemoEvent[]>([]);
  const [hoveredEvent, setHoveredEvent] = useState<DemoEvent | null>(null);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);

  const isPlaying = playMode === "playing" || (playMode === "auto" && !prefersReducedMotion);
  const effectivelyPlaying = isPlaying && isInView && activeTab === "video-analysis";

  const allEvents = useMemo(
    () => [...RECORDED_EVENTS, ...addedEvents].sort((a, b) => a.timestamp - b.timestamp),
    [addedEvents],
  );
  const listEvents = useMemo(
    () => allEvents.filter((event) => !hiddenTypes.has(event.type)),
    [allEvents, hiddenTypes],
  );
  const availableFilterTypes = FILTER_TYPES.filter((type) =>
    allEvents.some((event) => event.type === type),
  );

  useEffect(() => {
    if (!effectivelyPlaying) return;
    let frameId = 0;
    let lastFrame = performance.now();
    function tick(now: number) {
      const elapsedSeconds = ((now - lastFrame) / 1000) * playbackRate;
      lastFrame = now;
      const nextTime = playbackTime.get() + elapsedSeconds;
      if (nextTime >= DURATION_SECONDS) {
        playbackTime.set(DURATION_SECONDS);
        setPlayMode("paused");
        return;
      }
      playbackTime.set(nextTime);
      frameId = requestAnimationFrame(tick);
    }
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [effectivelyPlaying, playbackRate, playbackTime]);

  function seek(time: number) {
    playbackTime.set(Math.min(DURATION_SECONDS, Math.max(0, time)));
  }

  function seekBy(offsetSeconds: number) {
    seek(playbackTime.get() + offsetSeconds);
  }

  function togglePlay() {
    if (!isPlaying && playbackTime.get() >= DURATION_SECONDS) seek(0);
    setPlayMode(isPlaying ? "paused" : "playing");
  }

  function seekToEvent(timestamp: number) {
    seek(timestamp - EVENT_SEEK_OFFSET_SECONDS);
    if (playMode === "auto") setPlayMode("playing");
  }

  function addEvent(type: "manual" | "note") {
    const sameTypeCount = addedEvents.filter((event) => event.type === type).length + 1;
    setAddedEvents((events) => [
      ...events,
      {
        id: `${type}-${sameTypeCount}`,
        type,
        timestamp: playbackTime.get(),
        name: type === "manual" ? `Marker ${sameTypeCount}` : "Review this pull",
      },
    ]);
    setHiddenTypes((types) => {
      const nextTypes = new Set(types);
      nextTypes.delete(type);
      return nextTypes;
    });
  }

  function toggleFilter(type: DemoEventType) {
    setHiddenTypes((types) => {
      const nextTypes = new Set(types);
      if (nextTypes.has(type)) nextTypes.delete(type);
      else nextTypes.add(type);
      return nextTypes;
    });
  }

  function seekFromPointer(pointerEvent: PointerEvent<HTMLDivElement>) {
    const bounds = pointerEvent.currentTarget.getBoundingClientRect();
    seek(((pointerEvent.clientX - bounds.left) / bounds.width) * DURATION_SECONDS);
  }

  function handleKeyDown(keyEvent: KeyboardEvent<HTMLDivElement>) {
    const key = keyEvent.key.toLowerCase();
    const isOnControl =
      keyEvent.target instanceof HTMLElement && keyEvent.target.closest("button") !== null;
    if (key === " " && !isOnControl) togglePlay();
    else if (key === "j") seekBy(-SKIP_SEEK_SECONDS);
    else if (key === "l") seekBy(SKIP_SEEK_SECONDS);
    else if (key === "m") addEvent("manual");
    else if (key === "n") addEvent("note");
    else if (key === "arrowleft" && !isOnControl) seekBy(-5);
    else if (key === "arrowright" && !isOnControl) seekBy(5);
    else return;
    keyEvent.preventDefault();
  }

  const volumeProgress = volume * 100;

  return (
    <div ref={frameRef} className="relative w-full" style={{ height: DESIGN_HEIGHT * scale }}>
      <div
        tabIndex={0}
        role="region"
        aria-label="Interactive FloorPoV demo"
        onKeyDown={handleKeyDown}
        className={`absolute left-0 top-0 flex origin-top-left flex-col overflow-hidden rounded-md border border-white/10 bg-neutral-950 text-neutral-100 ${SURFACE_GLOW} focus-visible:outline-none`}
        style={{ width: DESIGN_WIDTH, height: DESIGN_HEIGHT, transform: `scale(${scale})` }}
      >
        <div className={`flex h-10 shrink-0 items-stretch justify-between border-b border-white/10 ${SURFACE_1} backdrop-blur-md select-none`}>
          <div className="flex h-full min-w-0 flex-1 items-center gap-3 px-3">
            <div className="inline-flex items-center gap-2 rounded-sm border border-white/15 bg-white/5 px-2 py-1">
              <Image src="/floorpov-icon.png" alt="" width={16} height={16} className="h-4 w-4 object-contain" />
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-100">
                FloorPoV
              </span>
            </div>
            <div className="h-4 w-px bg-white/15" />
            <div className="text-[11px] uppercase tracking-[0.14em] text-neutral-500">
              Gameplay analyzer
            </div>
          </div>
          <div className="flex h-full shrink-0 text-neutral-400" aria-hidden="true">
            <span className="flex h-full w-12 items-center justify-center">
              <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor"><rect width="10" height="1" /></svg>
            </span>
            <span className="flex h-full w-12 items-center justify-center">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor"><rect x="0.5" y="0.5" width="9" height="9" /></svg>
            </span>
            <span className="flex h-full w-12 items-center justify-center">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor"><path d="M1 1L9 9M9 1L1 9" strokeWidth="1.2" /></svg>
            </span>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-row gap-3 overflow-hidden p-3">
          <aside className={`flex h-full w-56 min-w-56 shrink-0 flex-col overflow-y-auto border-r border-white/10 ${SURFACE_1} backdrop-blur-md`}>
            <div className="px-3 py-3">
              <SidebarSectionLabel label="Navigation" />
              <div className="grid gap-1.5">
                <SidebarNavItem label="Home" icon={Radar} />
                <SidebarNavItem label="Settings" icon={SlidersHorizontal} />
              </div>
            </div>
            <div className="flex-1 px-3 pb-3">
              <div className="border-t border-white/5 pt-3">
                <SidebarSectionLabel label="Game modes" />
                <div className="grid gap-1.5">
                  <SidebarNavItem label="Mythic+" icon={Swords} />
                  <SidebarNavItem label="Raid" icon={Shield} isActive />
                  <SidebarNavItem label="PvP" icon={Trophy} />
                </div>
              </div>
              <div className="border-t border-white/5 pt-3">
                <SidebarSectionLabel label="Integrations" />
                <SidebarNavItem label="Upload" icon={UploadCloud} />
              </div>
            </div>
            <div className="p-3">
              <div className="rounded-sm border border-emerald-300/20 bg-emerald-500/12 px-3 py-2 shadow-[0_0_0_1px_rgba(16,185,129,0.14)]">
                <div className="flex items-start gap-1.5">
                  <span className="mt-0.5 inline-flex h-3 w-3 shrink-0 items-center justify-center">
                    <Circle className="h-3 w-3 text-emerald-300" fill="currentColor" />
                  </span>
                  <div className="flex-1">
                    <div className="text-[11px] uppercase tracking-[0.12em] text-emerald-300">
                      Recording
                    </div>
                    <div className="mt-1 flex h-4 items-center text-xs text-neutral-300">
                      Ready to record.
                    </div>
                  </div>
                </div>
              </div>
              <div className="mt-3 border-t border-white/5 pt-3">
                <div className="inline-flex w-full items-center justify-between rounded-sm border border-transparent px-2.5 py-2 text-xs text-neutral-400">
                  <span className="inline-flex items-center gap-1.5">
                    <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
                    GitHub
                  </span>
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </div>
                <p className="mt-2 text-center text-[10px] tracking-[0.08em] text-neutral-500">
                  {APP_VERSION}
                </p>
              </div>
            </div>
          </aside>

          <div className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-sm border border-white/10 ${SURFACE_1} ${SURFACE_GLOW}`}>
            <header className={`flex shrink-0 flex-wrap items-center gap-3 border-b border-white/10 ${SURFACE_1} px-6 py-4`}>
              <span className="inline-flex min-h-8 items-center gap-1.5 rounded-sm border border-white/15 bg-black/20 px-2.5 text-xs text-neutral-300">
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                Back to sessions
              </span>
              <Shield className="h-4 w-4 shrink-0 text-neutral-300" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-lg font-semibold text-neutral-100">Raid analysis</p>
                <p className="mt-1 truncate text-sm text-neutral-400">
                  The Venomous Abyss · The Coiled Altar
                </p>
              </div>
              <div className="ml-auto">
                <span className="inline-flex h-7 items-center gap-1 rounded-sm border border-white/20 bg-black/20 px-2 text-xs text-neutral-200">
                  <Download className="h-3.5 w-3.5 shrink-0" />
                  Export report
                </span>
              </div>
            </header>

            <div className={`border-b border-white/10 ${SURFACE_1} px-4 pt-2`}>
              <div className="-mb-px flex items-end gap-2" role="tablist" aria-label="Recording analysis tabs">
                {ANALYSIS_TABS.map(({ value, label, icon: Icon }) => {
                  const isActive = value === activeTab;
                  return (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => setActiveTab(value)}
                      className={`inline-flex min-h-9 items-center gap-1.5 rounded-t-sm border border-b-0 px-3.5 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60 ${
                        isActive
                          ? `border-emerald-300/40 ${SURFACE_0} text-emerald-100`
                          : "border-white/15 bg-black/20 text-neutral-300 hover:bg-white/8 hover:text-neutral-100"
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={activeTab}
                  className="h-full min-h-0"
                  initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={prefersReducedMotion ? undefined : { opacity: 0, y: -4 }}
                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                >
                  {activeTab === "video-analysis" ? (
                    <div className="flex h-full min-h-0 overflow-hidden">
                      <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-neutral-950/90">
                        <div className="absolute inset-0 flex items-center justify-center [container-type:size]">
                          <div className="relative aspect-video w-[min(100cqw,calc(100cqh*16/9))] overflow-hidden">
                            <div className="absolute inset-0 bg-[url(/screenshots/video-analysis.webp)] bg-[length:152.4%_auto] bg-[position:45.3%_70.7%]" />
                          </div>
                        </div>

                        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-neutral-950/95 via-neutral-950/70 to-transparent p-4">
                          <div className="flex flex-row items-center gap-3">
                            <div className="flex shrink-0 items-center gap-3">
                              <ControlIconButton label="Skip back 10 seconds (J)" onClick={() => seekBy(-SKIP_SEEK_SECONDS)}>
                                <SkipBack className="h-5 w-5" />
                              </ControlIconButton>
                              <ControlIconButton label={isPlaying ? "Pause playback (Space)" : "Play recording (Space)"} onClick={togglePlay}>
                                {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
                              </ControlIconButton>
                              <ControlIconButton label="Skip forward 10 seconds (L)" onClick={() => seekBy(SKIP_SEEK_SECONDS)}>
                                <SkipForward className="h-5 w-5" />
                              </ControlIconButton>
                              <ControlIconButton label={volume === 0 ? "Unmute audio" : "Mute audio"} onClick={() => setVolume(volume === 0 ? 0.8 : 0)}>
                                {volume === 0 ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
                              </ControlIconButton>
                              <div
                                className="group relative h-2 w-20 cursor-pointer rounded-full border border-white/15 bg-neutral-700/80"
                                onPointerDown={(pointerEvent) => {
                                  const bounds = pointerEvent.currentTarget.getBoundingClientRect();
                                  setVolume(Math.min(1, Math.max(0, (pointerEvent.clientX - bounds.left) / bounds.width)));
                                }}
                                role="slider"
                                aria-label="Volume"
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={Math.round(volumeProgress)}
                              >
                                <div className="h-full rounded-full bg-emerald-400/85" style={{ width: `${volumeProgress}%` }} />
                                <div className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-emerald-100" style={{ left: `calc(${volumeProgress}% - 6px)` }} />
                              </div>
                              <span className="font-mono text-xs text-white">
                                <PlaybackClock playbackTime={playbackTime} />
                              </span>
                            </div>

                            <div
                              className="group relative h-3 min-w-0 flex-1 cursor-pointer overflow-visible rounded-full border border-white/15 bg-neutral-700/80 touch-none"
                              onPointerDown={(pointerEvent) => {
                                pointerEvent.currentTarget.setPointerCapture(pointerEvent.pointerId);
                                seekFromPointer(pointerEvent);
                              }}
                              onPointerMove={(pointerEvent) => {
                                if (pointerEvent.currentTarget.hasPointerCapture(pointerEvent.pointerId)) {
                                  seekFromPointer(pointerEvent);
                                }
                              }}
                              role="slider"
                              aria-label="Timeline"
                              aria-valuemin={0}
                              aria-valuemax={DURATION_SECONDS}
                              ref={timelineRef}
                              aria-valuenow={START_SECONDS}
                            >
                              <motion.div className="h-full rounded-full bg-emerald-400/85" style={{ width: progressWidth }} />
                              <motion.div className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-emerald-100 opacity-0 transition-opacity group-hover:opacity-100" style={{ left: progressKnobLeft }} />
                              {listEvents.map((event) => (
                                <button
                                  key={event.id}
                                  type="button"
                                  className="absolute top-1/2 z-10 -ml-2 -translate-y-1/2 rounded-sm p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
                                  style={{ left: `${(event.timestamp / DURATION_SECONDS) * 100}%` }}
                                  onPointerDown={(pointerEvent) => pointerEvent.stopPropagation()}
                                  onClick={() => seekToEvent(event.timestamp)}
                                  onMouseEnter={() => setHoveredEvent(event)}
                                  onMouseLeave={() => setHoveredEvent(null)}
                                  aria-label={`Seek to ${event.type} at ${formatTime(event.timestamp)}`}
                                >
                                  <EventMarker type={event.type} />
                                </button>
                              ))}
                              <AnimatePresence>
                                {hoveredEvent && (
                                  <motion.div
                                    className="pointer-events-none absolute bottom-full z-[45] mb-2 -translate-x-1/2 whitespace-nowrap rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
                                    style={{ left: `${(hoveredEvent.timestamp / DURATION_SECONDS) * 100}%` }}
                                    initial={{ opacity: 0, y: 4, scale: 0.98 }}
                                    animate={{ opacity: 1, y: 0, scale: 1 }}
                                    exit={{ opacity: 0, y: 4, scale: 0.98 }}
                                    transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                                  >
                                    <div className="font-medium">
                                      {hoveredEvent.type === "manual" ? hoveredEvent.name : TOOLTIP_LABELS[hoveredEvent.type]}
                                    </div>
                                    <div className="text-neutral-400">{getEventDescription(hoveredEvent)}</div>
                                    <div className="text-neutral-500">{formatTime(hoveredEvent.timestamp)}</div>
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </div>

                            <div className="flex shrink-0 items-center gap-2">
                              <ControlIconButton label="Add note (N)" onClick={() => addEvent("note")}>
                                <StickyNote className="h-5 w-5" />
                              </ControlIconButton>
                              <ControlIconButton label="Import combat log">
                                <FileInput className="h-5 w-5" />
                              </ControlIconButton>
                              <div className="relative">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setShowShortcutHelp(false);
                                    setShowSpeedMenu(!showSpeedMenu);
                                  }}
                                  className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-100 transition-colors hover:text-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
                                  aria-haspopup="menu"
                                  aria-expanded={showSpeedMenu}
                                  aria-label="Playback speed"
                                >
                                  {playbackRate}x
                                </button>
                                {showSpeedMenu && (
                                  <div className="absolute bottom-full left-0 mb-2 rounded border border-neutral-700 bg-neutral-900 py-1 shadow-lg" role="menu">
                                    {PLAYBACK_RATES.map((rate) => (
                                      <button
                                        key={rate}
                                        type="button"
                                        role="menuitemradio"
                                        aria-checked={rate === playbackRate}
                                        onClick={() => {
                                          setPlaybackRate(rate);
                                          setShowSpeedMenu(false);
                                        }}
                                        className={`block w-full px-3 py-1 text-left text-xs ${
                                          rate === playbackRate ? "bg-white/10 text-neutral-50" : "text-neutral-300 hover:bg-white/5"
                                        }`}
                                      >
                                        {rate}x
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <ControlIconButton label="Save screenshot">
                                <Camera className="h-5 w-5" />
                              </ControlIconButton>
                              <div className="relative">
                                <ControlIconButton
                                  label="Keyboard shortcuts"
                                  onClick={() => {
                                    setShowSpeedMenu(false);
                                    setShowShortcutHelp(!showShortcutHelp);
                                  }}
                                >
                                  <Keyboard className="h-5 w-5" />
                                </ControlIconButton>
                                {showShortcutHelp && (
                                  <div className="absolute bottom-full right-0 mb-2 w-72 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 shadow-lg">
                                    <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-400">
                                      Keyboard shortcuts
                                    </p>
                                    <ul className="space-y-1.5">
                                      {SHORTCUTS.map((shortcut) => (
                                        <li key={shortcut.keys} className="flex items-start justify-between gap-3 text-xs text-neutral-200">
                                          <kbd className="shrink-0 rounded border border-white/15 bg-black/30 px-1.5 py-0.5 font-mono text-[11px] text-neutral-100">
                                            {shortcut.keys}
                                          </kbd>
                                          <span className="text-right text-neutral-300">{shortcut.action}</span>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                              </div>
                              <ControlIconButton label="Event list">
                                <ListVideo className="h-5 w-5" />
                              </ControlIconButton>
                              <ControlIconButton label="Full screen">
                                <Maximize className="h-5 w-5" />
                              </ControlIconButton>
                            </div>
                          </div>
                        </div>
                      </main>

                      <aside className={`flex h-full w-72 shrink-0 flex-col border-l border-white/10 ${SURFACE_2}`}>
                        <div className="flex flex-col gap-2 border-b border-white/10 px-3 py-2">
                          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.12em] text-neutral-400">
                            <ListVideo className="h-3.5 w-3.5 text-neutral-300" />
                            Events
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Event type filters">
                            {availableFilterTypes.map((type) => {
                              const isVisible = !hiddenTypes.has(type);
                              return (
                                <button
                                  key={type}
                                  type="button"
                                  aria-pressed={isVisible}
                                  onClick={() => toggleFilter(type)}
                                  className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] transition-colors ${
                                    isVisible
                                      ? "border-white/20 bg-black/20 text-neutral-200"
                                      : "border-white/10 bg-transparent text-neutral-500"
                                  }`}
                                >
                                  <EventMarker type={type} className={isVisible ? "" : "opacity-40"} />
                                  {FILTER_LABELS[type]}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                          {listEvents.length === 0 ? (
                            <p className="px-3 py-4 text-xs text-neutral-500">No events match the current filters.</p>
                          ) : (
                            <EventListItems events={listEvents} playbackTime={playbackTime} onSelect={seekToEvent} />
                          )}
                        </div>
                      </aside>
                    </div>
                  ) : activeTab === "log-analysis" ? (
                    <LogAnalysisPanel events={allEvents} />
                  ) : (
                    <MetadataPanel />
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const PANEL_SECTION = `mt-3 rounded-sm border border-white/10 ${SURFACE_1} p-3`;

function LogAnalysisPanel({ events }: { events: DemoEvent[] }) {
  const loggedEvents = events.filter((event) => event.type !== "manual" && event.type !== "note");
  const eventCounts = new Map<DemoEventType, number>();
  for (const event of loggedEvents) {
    eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1);
  }
  const sortedCounts = [...eventCounts.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <div className="h-full overflow-y-auto px-4 py-3 [scrollbar-gutter:stable]">
      <section className={PANEL_SECTION}>
        <h3 className="text-xs font-semibold uppercase tracking-[0.1em] text-neutral-300">
          Encounter segments
        </h3>
        <ul className="mt-2 space-y-1.5">
          <li className="rounded-sm border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-neutral-200">
            <div className="font-medium text-neutral-100">The Coiled Altar</div>
            <div className="mt-0.5 text-neutral-400">
              Raid · Start 0:00 · End {formatTime(ENCOUNTER_END_SECONDS)}
            </div>
          </li>
        </ul>
      </section>

      <section className={PANEL_SECTION}>
        <h3 className="text-xs font-semibold uppercase tracking-[0.1em] text-neutral-300">
          Event counts
        </h3>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {sortedCounts.map(([eventType, count]) => (
            <span
              key={eventType}
              className="inline-flex items-center gap-1 rounded-sm border border-white/15 bg-black/25 px-2 py-1 text-xs text-neutral-200"
            >
              <span>{EVENT_LIST_LABELS[eventType]}</span>
              <span className="text-neutral-400">{count}</span>
            </span>
          ))}
        </div>
      </section>

      <section className={`mt-3 rounded-sm border border-white/10 ${SURFACE_1}`}>
        <div className="flex w-full items-center gap-2 px-4 py-3">
          <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-neutral-200">
            Important events
          </h3>
          <div className="ml-1 flex items-center gap-2">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[10px] uppercase tracking-[0.12em] text-neutral-500">Showing:</span>
              <span className="rounded border border-emerald-500/25 bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-300">
                {loggedEvents.length}
              </span>
            </div>
          </div>
        </div>
        <div className="border-t border-white/10 px-4 pb-4 pt-3">
          <div className="overflow-x-auto rounded-sm border border-white/10 bg-black/20">
            <table className="min-w-[40rem] text-left text-xs text-neutral-300">
              <thead className={`${SURFACE_2} text-neutral-400`}>
                <tr>
                  {["Time", "Event", "Ability", "Source", "Target", "Amount"].map((heading) => (
                    <th key={heading} className="px-2 py-1.5 font-medium">{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loggedEvents.map((event) => (
                  <tr key={event.id} className="border-t border-white/10">
                    <td className="px-2 py-1.5 text-neutral-200">{formatTime(event.timestamp)}</td>
                    <td className="px-2 py-1.5 text-amber-200">{EVENT_LIST_LABELS[event.type]}</td>
                    <td className="px-2 py-1.5">-</td>
                    <td className="px-2 py-1.5">{event.type === "bloodlust" ? event.unit : "-"}</td>
                    <td className="px-2 py-1.5">{event.type === "death" ? event.unit : "-"}</td>
                    <td className="px-2 py-1.5 font-mono">-</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

function MetadataPanel() {
  const fields: [string, string][] = [
    ["Category", "Raid"],
    ["Zone", "The Venomous Abyss"],
    ["Encounter", "The Coiled Altar"],
    ["Length", formatTime(DURATION_SECONDS)],
  ];
  return (
    <div className="h-full overflow-y-auto px-4 py-3 [scrollbar-gutter:stable]">
      <section className={`rounded-sm border border-white/10 ${SURFACE_1} p-3`}>
        <h2 className="text-sm font-semibold text-neutral-100">Recording summary</h2>
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-neutral-300">
          {fields.map(([label, value]) => (
            <div key={label} className="rounded-sm border border-white/10 bg-black/20 px-2 py-1.5">
              <div className="text-[10px] uppercase tracking-[0.09em] text-neutral-500">{label}</div>
              <div className="mt-1 truncate text-neutral-100">{value}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
