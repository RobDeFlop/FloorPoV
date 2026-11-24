"use client";

import {
  CheckCircle2,
  Circle,
  FileText,
  Flag,
  Folder,
  Shield,
  Swords,
  Trophy,
  UploadCloud,
  Video,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { EventMarker, type DemoEventType } from "./app-demo";

// Every widget here reuses classes and copy from the desktop app's Sidebar, Settings,
// GameModePage, and VideoPlayer components.

const SURFACE_1 = "bg-[rgba(14,14,16,0.9)]";
const SURFACE_GLOW = "shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_10px_24px_rgba(0,0,0,0.45)]";
const SIDEBAR_ACTIVE = "border-l-2 border-l-emerald-300/75 bg-emerald-500/10 text-neutral-100";
const SIDEBAR_DEFAULT =
  "border-l-2 border-l-transparent text-neutral-300 hover:border-white/20 hover:bg-white/5 hover:text-neutral-100";
const SECONDARY_BUTTON =
  "inline-flex items-center justify-center gap-2 rounded-sm border border-white/20 bg-white/6 px-4 py-2 text-sm text-neutral-100 transition-colors hover:bg-white/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45";
const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

function formatTime(totalSeconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(wholeSeconds / 60)}:${(wholeSeconds % 60).toString().padStart(2, "0")}`;
}

function SettingsToggle({ label, description, checked, onChange }: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-sm border border-white/20 bg-black/20 px-3 py-2.5 text-neutral-200">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-500"
      />
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {description && (
          <span className="mt-1 block text-xs font-normal text-neutral-400">{description}</span>
        )}
      </span>
    </label>
  );
}

function RecordingStatus({ isRecording, seconds }: { isRecording: boolean; seconds: number }) {
  const prefersReducedMotion = useReducedMotion();
  return (
    <div
      className={`relative rounded-sm px-3 py-2 transition-colors ${
        isRecording
          ? "border border-rose-300/40 bg-rose-500/15 shadow-[0_0_0_1px_rgba(251,113,133,0.22)]"
          : "border border-emerald-300/20 bg-emerald-500/12 shadow-[0_0_0_1px_rgba(16,185,129,0.14)]"
      }`}
    >
      <AnimatePresence>
        {isRecording && !prefersReducedMotion && (
          <motion.div
            key="burst"
            className="pointer-events-none absolute inset-0 rounded-sm border border-rose-200/55"
            initial={{ scale: 0.72, opacity: 0 }}
            animate={{ scale: [0.72, 1.03, 1.06], opacity: [0, 0.45, 0] }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.55, ease: "easeOut" }}
          />
        )}
      </AnimatePresence>
      <div className="flex items-start gap-1.5">
        <span className="mt-0.5 inline-flex h-3 w-3 shrink-0 items-center justify-center">
          {isRecording ? (
            <motion.span
              className="inline-flex h-3 w-3 rounded-full bg-rose-300"
              animate={prefersReducedMotion ? undefined : { opacity: [0.55, 1, 0.55], scale: [0.95, 1.05, 0.95] }}
              transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
            />
          ) : (
            <Circle className="h-3 w-3 text-emerald-300" fill="currentColor" />
          )}
        </span>
        <div className="flex-1">
          <div
            className={`text-[11px] uppercase tracking-[0.12em] ${
              isRecording ? "text-rose-200" : "text-emerald-300"
            }`}
          >
            Recording
          </div>
          <div className="mt-1 h-4 overflow-hidden">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={isRecording ? "recording" : "idle"}
                className={`flex h-4 items-center whitespace-nowrap text-xs ${
                  isRecording ? "text-rose-100" : "text-neutral-300"
                }`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
              >
                {isRecording ? (
                  <span>
                    Recording <span className="font-mono">{formatTime(seconds)}</span>
                  </span>
                ) : (
                  "Ready to record."
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}

const IDLE_MS = 2500;
const RECORDING_SECONDS = 7;

function AutoRecordDemo() {
  const [isEnabled, setIsEnabled] = useState(true);
  const [phase, setPhase] = useState<"idle" | "recording">("idle");
  const [seconds, setSeconds] = useState(0);
  const isRecording = isEnabled && phase === "recording";

  useEffect(() => {
    if (!isEnabled) return;
    if (phase === "idle") {
      const timeoutId = window.setTimeout(() => {
        setSeconds(0);
        setPhase("recording");
      }, IDLE_MS);
      return () => window.clearTimeout(timeoutId);
    }
    const intervalId = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    const stopTimeoutId = window.setTimeout(() => setPhase("idle"), RECORDING_SECONDS * 1000);
    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(stopTimeoutId);
    };
  }, [isEnabled, phase]);

  return (
    <div className="space-y-4">
      <SettingsToggle
        label="Enable auto recording"
        description="Start recordings automatically when M+, raid, or PvP combat begins."
        checked={isEnabled}
        onChange={(checked) => {
          setIsEnabled(checked);
          setPhase("idle");
        }}
      />
      <div className="max-w-56">
        <RecordingStatus isRecording={isRecording} seconds={seconds} />
      </div>
      <p className="h-4 text-xs text-neutral-500">
        {!isEnabled
          ? "Auto recording is off."
          : isRecording
            ? "Encounter start: The Coiled Altar"
            : "Waiting for combat to start."}
      </p>
    </div>
  );
}

const DROP_MARKERS: { type: DemoEventType; position: number }[] = [
  { type: "encounterStart", position: 1 },
  { type: "death", position: 27 },
  { type: "death", position: 29 },
  { type: "bloodlust", position: 54 },
  { type: "death", position: 74 },
  { type: "death", position: 81 },
  { type: "encounterEnd", position: 97 },
];

const MARKER_LEGEND: [DemoEventType, string][] = [
  ["encounterStart", "Encounter start"],
  ["death", "Deaths"],
  ["bloodlust", "Bloodlust"],
  ["encounterEnd", "Encounter end"],
];

function SeekBar({ children, progress }: { children?: ReactNode; progress?: ReactNode }) {
  return (
    <div className="relative h-3 w-full rounded-full border border-white/15 bg-neutral-700/80">
      {progress}
      {children}
    </div>
  );
}

function CombatMarkersDemo() {
  const containerRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(containerRef, { once: true, amount: 0.6 });
  const [runId, setRunId] = useState(0);

  return (
    <div ref={containerRef} className="space-y-5">
      <div className="pt-4">
        <SeekBar>
          {isInView &&
            DROP_MARKERS.map((marker, idx) => (
              <motion.span
                key={`${runId}-${idx}`}
                className="absolute top-1/2 -ml-2 -translate-y-1/2"
                style={{ left: `${marker.position}%` }}
                initial={{ opacity: 0, y: -18, scale: 0.6 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ type: "spring", stiffness: 420, damping: 22, delay: 0.15 + idx * 0.18 }}
              >
                <EventMarker type={marker.type} />
              </motion.span>
            ))}
        </SeekBar>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5 text-[11px] text-neutral-300">
          {MARKER_LEGEND.map(([type, label]) => (
            <span key={type} className="inline-flex items-center gap-1.5 rounded border border-white/20 bg-black/20 px-2 py-1">
              <EventMarker type={type} />
              {label}
            </span>
          ))}
        </div>
        <button type="button" onClick={() => setRunId((id) => id + 1)} className="rounded-sm border border-white/20 bg-black/20 px-2.5 py-1 text-xs text-neutral-200 transition-colors hover:bg-white/5">
          Replay
        </button>
      </div>
    </div>
  );
}

const LOOP_MS = 12000;
const LOOP_SECONDS = 392;

function ManualMarkerDemo() {
  const startRef = useRef(0);
  const [markers, setMarkers] = useState<{ id: number; position: number }[]>([]);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    startRef.current = performance.now();
  }, []);

  function addMarker() {
    const position = prefersReducedMotion
      ? 50
      : (((performance.now() - startRef.current) % LOOP_MS) / LOOP_MS) * 100;
    setMarkers((current) => [...current.slice(-4), { id: performance.now(), position }]);
  }

  useEffect(() => {
    function handleKeyDown(keyEvent: KeyboardEvent) {
      const target = keyEvent.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, [role=region]")) return;
      if (keyEvent.key.toLowerCase() === "m") addMarker();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  return (
    <div className="space-y-5">
      <div className="pt-4">
        <SeekBar
          progress={
            <motion.div
              className="h-full origin-left rounded-full bg-emerald-400/85"
              initial={{ scaleX: prefersReducedMotion ? 0.5 : 0 }}
              animate={{ scaleX: prefersReducedMotion ? 0.5 : 1 }}
              transition={prefersReducedMotion ? undefined : { duration: LOOP_MS / 1000, ease: "linear", repeat: Infinity }}
            />
          }
        >
          <AnimatePresence>
            {markers.map((marker) => (
              <motion.span
                key={marker.id}
                className="absolute top-1/2 -ml-2 -translate-y-1/2"
                style={{ left: `${marker.position}%` }}
                initial={{ opacity: 0, scale: 0.4 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.4 }}
                transition={{ type: "spring", stiffness: 500, damping: 24 }}
              >
                <EventMarker type="manual" />
              </motion.span>
            ))}
          </AnimatePresence>
        </SeekBar>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <motion.button
          type="button"
          onClick={addMarker}
          whileTap={prefersReducedMotion ? undefined : { scale: 0.96 }}
          className="inline-flex items-center gap-2 rounded-sm border border-emerald-300/35 bg-emerald-500/20 px-3 py-1.5 text-sm text-emerald-100 transition-colors hover:bg-emerald-500/30"
        >
          <Flag className="h-4 w-4" />
          Add marker
          <kbd className="rounded border border-white/15 bg-black/30 px-1.5 py-0.5 font-mono text-[11px] text-neutral-100">
            M
          </kbd>
        </motion.button>
        <span className="text-xs text-neutral-500">
          {markers.length === 0
            ? "Press M anywhere on the page."
            : `Marker at ${formatTime((markers[markers.length - 1].position / 100) * LOOP_SECONDS)}`}
        </span>
      </div>
    </div>
  );
}

function VideoAudioDemo() {
  const [isSystemAudioOn, setIsSystemAudioOn] = useState(true);
  const prefersReducedMotion = useReducedMotion();
  return (
    <div className="space-y-4">
      <div className="inline-flex items-center gap-2 text-sm font-semibold text-neutral-200">
        <Video className="h-4 w-4" aria-hidden="true" />
        Video & audio
      </div>
      <p className="text-sm text-neutral-400">
        FFmpeg records H.264 MP4 and uses your GPU encoder if you have one.
      </p>
      <div className="border-t border-white/10 pt-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-neutral-200">
          <Volume2 className="h-4 w-4 text-neutral-400" aria-hidden="true" />
          Audio
        </div>
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <SettingsToggle label="Enable system audio" checked={isSystemAudioOn} onChange={setIsSystemAudioOn} />
          </div>
          <div className="flex h-8 items-end gap-1" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((bar) => (
              <motion.span
                key={bar}
                className="h-full w-1.5 origin-bottom rounded-full bg-emerald-400/85"
                animate={
                  isSystemAudioOn && !prefersReducedMotion
                    ? { scaleY: [0.2, 0.9, 0.4, 0.7, 0.2] }
                    : { scaleY: 0.12 }
                }
                transition={
                  isSystemAudioOn && !prefersReducedMotion
                    ? { duration: 1.1 + bar * 0.17, repeat: Infinity, ease: "easeInOut" }
                    : { duration: 0.3 }
                }
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const GAME_MODES: { label: string; title: string; description: string; icon: LucideIcon }[] = [
  {
    label: "Mythic+",
    title: "Mythic+ sessions",
    description: "Browse sessions and inspect pulls, events, and pace.",
    icon: Swords,
  },
  {
    label: "Raid",
    title: "Raid sessions",
    description: "Browse sessions and review timelines and key events.",
    icon: Shield,
  },
  {
    label: "PvP",
    title: "PvP sessions",
    description: "Browse sessions and analyze footage and combat metadata.",
    icon: Trophy,
  },
];

function LibraryDemo() {
  const [activeIdx, setActiveIdx] = useState(1);
  const activeMode = GAME_MODES[activeIdx];
  const ActiveIcon = activeMode.icon;
  return (
    <div className="grid items-start gap-4 sm:grid-cols-[10rem_1fr]">
      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-300">
          Game modes
        </div>
        <div className="grid gap-1.5">
          {GAME_MODES.map((mode, idx) => {
            const Icon = mode.icon;
            return (
              <button
                key={mode.label}
                type="button"
                onClick={() => setActiveIdx(idx)}
                className={`flex w-full items-center gap-2 rounded-sm border border-transparent px-4 py-2 text-sm font-medium transition-colors ${
                  idx === activeIdx ? SIDEBAR_ACTIVE : SIDEBAR_DEFAULT
                }`}
              >
                <Icon className="h-4 w-4" />
                {mode.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="overflow-hidden rounded-sm border border-white/10">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={activeMode.label}
            className={`flex items-center gap-3 ${SURFACE_1} px-4 py-4`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
          >
            <ActiveIcon className="h-4 w-4 shrink-0 text-neutral-300" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-lg font-semibold text-neutral-100">{activeMode.title}</p>
              <p className="mt-1 text-sm text-neutral-400">{activeMode.description}</p>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function WarcraftLogsDemo() {
  const [isLive, setIsLive] = useState(false);
  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-400">
        Upload a finished log in one go, or log live while you play. A live log shows up in the
        sidebar so you can stop it from anywhere.
      </p>
      <div className="max-w-56">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-300">
          Integrations
        </div>
        <div className="grid gap-1.5">
          <div className={`flex w-full items-center gap-2 rounded-sm border border-transparent px-4 py-2 text-sm font-medium ${SIDEBAR_DEFAULT}`}>
            <UploadCloud className="h-4 w-4" />
            Upload
          </div>
          <AnimatePresence initial={false}>
            {isLive && (
              <motion.button
                type="button"
                onClick={() => setIsLive(false)}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: EASE_OUT }}
                className="inline-flex items-center justify-between overflow-hidden rounded-sm border border-emerald-300/35 bg-emerald-500/12 px-3 py-2 text-xs text-emerald-100 transition-colors hover:bg-emerald-500/20"
              >
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" />
                  Live log active
                </span>
                <span className="font-medium text-emerald-50">Stop</span>
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
      {!isLive && (
        <button type="button" onClick={() => setIsLive(true)} className={SECONDARY_BUTTON}>
          Start a live log
        </button>
      )}
    </div>
  );
}

function MetadataDemo() {
  const fields: [string, string][] = [
    ["Category", "Raid"],
    ["Zone", "The Venomous Abyss"],
    ["Encounter", "The Coiled Altar"],
    ["Events", "Encounter start, deaths, Bloodlust, encounter end"],
  ];
  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-400">
        A .meta.json file next to each recording keeps its events, so markers are still there the
        next time you open it.
      </p>
      <section className={`rounded-sm border border-white/10 ${SURFACE_1} p-3`}>
        <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-neutral-100">
          <FileText className="h-4 w-4 text-neutral-400" aria-hidden="true" />
          Recording summary
        </h3>
        <div className="mt-2 grid grid-cols-1 gap-2 text-xs text-neutral-300 sm:grid-cols-2">
          {fields.map(([label, value], idx) => (
            <motion.div
              key={label}
              className="rounded-sm border border-white/10 bg-black/20 px-2 py-1.5"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: idx * 0.06, ease: EASE_OUT }}
            >
              <div className="text-[10px] uppercase tracking-[0.09em] text-neutral-500">{label}</div>
              <div className="mt-1 truncate text-neutral-100">{value}</div>
            </motion.div>
          ))}
        </div>
      </section>
    </div>
  );
}

interface FeatureItem {
  label: string;
  title: string;
  body: string;
  icon: LucideIcon;
  demo: () => ReactNode;
}

const FEATURES: FeatureItem[] = [
  {
    label: "Auto recording",
    title: "Recording starts on its own",
    body: "FloorPoV watches the combat log and starts recording when Mythic+, raid, or PvP combat begins.",
    icon: Circle,
    demo: () => <AutoRecordDemo />,
  },
  {
    label: "Combat log markers",
    title: "Markers from the combat log",
    body: "Deaths, kills, interrupts, dispels, and boss encounters are marked on the timeline for you.",
    icon: Swords,
    demo: () => <CombatMarkersDemo />,
  },
  {
    label: "Your own markers",
    title: "Flag a moment with a hotkey",
    body: "Press your global hotkey during a pull and a marker lands at that moment. You choose the key.",
    icon: Flag,
    demo: () => <ManualMarkerDemo />,
  },
  {
    label: "Video and audio",
    title: "Hardware encoding and game audio",
    body: "Recordings use your GPU encoder when there is one. Desktop and game audio come through WASAPI loopback if you turn it on.",
    icon: Video,
    demo: () => <VideoAudioDemo />,
  },
  {
    label: "Library",
    title: "Recordings sorted by game mode",
    body: "Mythic+, raid, and PvP recordings each get their own list.",
    icon: Shield,
    demo: () => <LibraryDemo />,
  },
  {
    label: "WarcraftLogs",
    title: "Upload to WarcraftLogs",
    body: "Send a combat log to WarcraftLogs without leaving FloorPoV.",
    icon: UploadCloud,
    demo: () => <WarcraftLogsDemo />,
  },
  {
    label: "Saved events",
    title: "Markers stay with the video",
    body: "Each recording keeps its events in a file saved next to the video.",
    icon: FileText,
    demo: () => <MetadataDemo />,
  },
];

export function FeatureExplorer() {
  const [activeIdx, setActiveIdx] = useState(0);
  const activeFeature = FEATURES[activeIdx];
  const prefersReducedMotion = useReducedMotion();

  return (
    <div className={`grid overflow-hidden rounded-md border border-white/10 bg-neutral-950 ${SURFACE_GLOW} md:grid-cols-[15rem_1fr]`}>
      <div className={`border-b border-white/10 ${SURFACE_1} p-3 md:border-b-0 md:border-r`} role="tablist" aria-label="Features" aria-orientation="vertical">
        <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-300">
          Features
        </div>
        <div className="grid gap-1.5 sm:grid-cols-2 md:grid-cols-1">
          {FEATURES.map((feature, idx) => {
            const Icon = feature.icon;
            const isActive = idx === activeIdx;
            return (
              <button
                key={feature.label}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveIdx(idx)}
                className={`flex w-full items-center gap-2 rounded-sm border border-transparent px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 ${
                  isActive ? SIDEBAR_ACTIVE : SIDEBAR_DEFAULT
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {feature.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="min-h-[22rem] p-6" role="tabpanel">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={activeFeature.label}
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={prefersReducedMotion ? undefined : { opacity: 0 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
          >
            <h3 className="text-xl font-semibold text-neutral-100">{activeFeature.title}</h3>
            <p className="mt-2 max-w-xl leading-7 text-neutral-400">{activeFeature.body}</p>
            <div className="mt-6">{activeFeature.demo()}</div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

const EXAMPLE_WOW_FOLDER = "C:\\Program Files (x86)\\World of Warcraft\\_retail_";

export function WowFolderDemo() {
  const [folder, setFolder] = useState("");
  const [isChecking, setIsChecking] = useState(false);

  function browse() {
    if (isChecking) return;
    setIsChecking(true);
    setFolder(EXAMPLE_WOW_FOLDER);
    window.setTimeout(() => setIsChecking(false), 600);
  }

  return (
    <section className={`rounded-sm border border-white/10 ${SURFACE_1} p-3.5 ${SURFACE_GLOW}`}>
      <h3 className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-neutral-200">
        <Swords className="h-4 w-4" aria-hidden="true" />
        WoW & combat log
      </h3>
      <label htmlFor="demo-wow-folder" className="mb-2 block text-sm text-neutral-300">
        WoW folder
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id="demo-wow-folder"
          readOnly
          value={folder}
          placeholder="No folder selected"
          className="min-w-0 flex-1 rounded-sm border border-white/20 bg-black/20 px-3 py-2 text-sm text-neutral-300 placeholder:text-neutral-500"
        />
        <button type="button" onClick={browse} className={SECONDARY_BUTTON}>
          <Folder className="h-4 w-4" />
          Browse
        </button>
      </div>
      <p className="mt-2 text-xs text-neutral-400">
        Select your WoW client folder. FloorPoV reads{" "}
        <span className="font-mono">Logs\WoWCombatLog*.txt</span>.
      </p>
      <div className="mt-2 h-7">
        <AnimatePresence>
          {folder && !isChecking && (
            <motion.p
              className="inline-flex items-center gap-1.5 rounded-sm border border-emerald-300/30 bg-emerald-500/12 px-2 py-1 text-xs text-emerald-100"
              initial={{ opacity: 0, y: 4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: EASE_OUT }}
            >
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" aria-hidden="true" />
              Combat log found!
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
