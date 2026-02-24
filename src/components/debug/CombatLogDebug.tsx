import { useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  Bug,
  FileText,
  FolderOpen,
  RefreshCw,
  ShieldOff,
  Skull,
  Sparkles,
  Sword,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { ParseCombatLogDebugResult } from "../../types/events";
import { panelVariants, smoothTransition } from "../../lib/motion";

interface EncounterTimelineSegment {
  id: string;
  name: string;
  category: "mythicPlus" | "raid" | "pvp" | "unknown";
  zoneName?: string;
  startLine: number;
  endLine: number;
  startTimestamp: string;
  endTimestamp?: string;
}

interface EncounterTimelineMarker {
  id: string;
  lineNumber: number;
  eventType: string;
  timestamp: string;
  source?: string;
  target?: string;
}

interface EncounterTimelineMarkerBucket {
  visible: EncounterTimelineMarker[];
  hiddenCount: number;
}

interface TimelineTooltipState {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

const MAX_MARKERS_PER_SEGMENT = 120;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getEncounterCategoryLabel(category: EncounterTimelineSegment["category"]): string {
  switch (category) {
    case "mythicPlus":
      return "M+";
    case "raid":
      return "RAID";
    case "pvp":
      return "PVP";
    default:
      return "UNKNOWN";
  }
}

function getEncounterCategoryClassName(category: EncounterTimelineSegment["category"]): string {
  switch (category) {
    case "mythicPlus":
      return "border-neutral-300/30 bg-white/6 text-neutral-200";
    case "raid":
      return "border-neutral-300/30 bg-white/8 text-neutral-100";
    case "pvp":
      return "border-rose-300/35 bg-rose-500/12 text-rose-200";
    default:
      return "border-neutral-300/25 bg-neutral-500/12 text-neutral-300";
  }
}

function getEventMarkerClassName(eventType: string): string {
  switch (eventType) {
    case "PARTY_KILL":
      return "bg-neutral-200 border-neutral-50/85";
    case "UNIT_DIED":
      return "bg-rose-200 border-rose-50/85";
    case "SPELL_INTERRUPT":
      return "bg-amber-200 border-amber-50/85";
    case "SPELL_DISPEL":
      return "bg-neutral-300 border-neutral-100/85";
    default:
      return "bg-neutral-200 border-neutral-50/80";
  }
}

function getEventMarkerIcon(eventType: string) {
  switch (eventType) {
    case "PARTY_KILL":
      return Sword;
    case "UNIT_DIED":
      return Skull;
    case "SPELL_INTERRUPT":
      return ShieldOff;
    case "SPELL_DISPEL":
      return Sparkles;
    default:
      return Sparkles;
  }
}

function getEventIconClassName(eventType: string): string {
  switch (eventType) {
    case "PARTY_KILL":
      return "text-neutral-950";
    case "UNIT_DIED":
      return "text-rose-950";
    case "SPELL_INTERRUPT":
      return "text-amber-950";
    case "SPELL_DISPEL":
      return "text-neutral-950";
    default:
      return "text-neutral-900";
  }
}

function getEventTypeLabel(eventType: string): string {
  switch (eventType) {
    case "PARTY_KILL":
      return "Kill";
    case "UNIT_DIED":
      return "Death";
    case "SPELL_INTERRUPT":
      return "Interrupt";
    case "SPELL_DISPEL":
      return "Dispel";
    default:
      return eventType;
  }
}

export function CombatLogDebug() {
  const reduceMotion = useReducedMotion();
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [parseResult, setParseResult] = useState<ParseCombatLogDebugResult | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [isParsing, setIsParsing] = useState(false);
  const [timelineTooltip, setTimelineTooltip] = useState<TimelineTooltipState | null>(null);
  const timelineSectionRef = useRef<HTMLDivElement>(null);

  const showTimelineTooltip = (
    event: React.MouseEvent<HTMLElement>,
    title: string,
    lines: string[],
  ) => {
    const container = timelineSectionRef.current;
    if (!container) {
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const rawX = event.clientX - containerRect.left;
    const rawY = event.clientY - containerRect.top;
    const clampedX = Math.max(160, Math.min(containerRect.width - 160, rawX));
    const clampedY = Math.max(60, rawY - 14);

    setTimelineTooltip({
      x: clampedX,
      y: clampedY,
      title,
      lines,
    });
  };

  const hideTimelineTooltip = () => {
    setTimelineTooltip(null);
  };

  const totalImportantEvents = useMemo(() => {
    if (!parseResult) {
      return 0;
    }

    return Object.values(parseResult.eventCounts).reduce((total, count) => total + count, 0);
  }, [parseResult]);

  const encounterTimeline = useMemo<EncounterTimelineSegment[]>(() => {
    if (!parseResult) {
      return [];
    }

    const openEncounters = new Map<string, EncounterTimelineSegment>();
    const timelineSegments: EncounterTimelineSegment[] = [];

    for (const event of parseResult.parsedEvents) {
      if (event.eventType !== "ENCOUNTER_START" && event.eventType !== "ENCOUNTER_END") {
        continue;
      }

      const encounterName = event.encounterName || "Unknown Encounter";
      const encounterCategory = event.encounterCategory || "unknown";
      const encounterKey = `${encounterName}:${encounterCategory}`;

      if (event.eventType === "ENCOUNTER_START") {
        if (openEncounters.has(encounterKey)) {
          const previousSegment = openEncounters.get(encounterKey);
          if (previousSegment) {
            previousSegment.endLine = Math.max(previousSegment.startLine, event.lineNumber - 1);
            previousSegment.endTimestamp = event.logTimestamp;
            timelineSegments.push(previousSegment);
          }
        }

        openEncounters.set(encounterKey, {
          id: `${encounterKey}-${event.lineNumber}`,
          name: encounterName,
          category: encounterCategory,
          zoneName: event.zoneName,
          startLine: event.lineNumber,
          endLine: event.lineNumber,
          startTimestamp: event.logTimestamp,
        });
        continue;
      }

      const currentSegment = openEncounters.get(encounterKey);
      if (currentSegment) {
        currentSegment.endLine = Math.max(currentSegment.startLine, event.lineNumber);
        currentSegment.endTimestamp = event.logTimestamp;
        if (!currentSegment.zoneName && event.zoneName) {
          currentSegment.zoneName = event.zoneName;
        }
        timelineSegments.push(currentSegment);
        openEncounters.delete(encounterKey);
      } else {
        timelineSegments.push({
          id: `${encounterKey}-${event.lineNumber}`,
          name: encounterName,
          category: encounterCategory,
          zoneName: event.zoneName,
          startLine: event.lineNumber,
          endLine: event.lineNumber,
          startTimestamp: event.logTimestamp,
          endTimestamp: event.logTimestamp,
        });
      }
    }

    for (const openSegment of openEncounters.values()) {
      openSegment.endLine = Math.max(openSegment.startLine, parseResult.totalLines || openSegment.startLine);
      timelineSegments.push(openSegment);
    }

    return timelineSegments.sort((left, right) => left.startLine - right.startLine);
  }, [parseResult]);

  const encounterMarkersBySegment = useMemo<Map<string, EncounterTimelineMarkerBucket>>(() => {
    if (!parseResult || encounterTimeline.length === 0) {
      return new Map<string, EncounterTimelineMarkerBucket>();
    }

    const importantEventTypes = new Set(["PARTY_KILL", "UNIT_DIED", "SPELL_INTERRUPT", "SPELL_DISPEL"]);
    const markers = parseResult.parsedEvents
      .filter((event) => importantEventTypes.has(event.eventType))
      .map<EncounterTimelineMarker>((event) => ({
        id: `${event.lineNumber}-${event.eventType}-${event.source || ""}-${event.target || ""}`,
        lineNumber: event.lineNumber,
        eventType: event.eventType,
        timestamp: event.logTimestamp,
        source: event.source,
        target: event.target,
      }));

    const markerBuckets = new Map<string, EncounterTimelineMarkerBucket>();

    for (const segment of encounterTimeline) {
      const inSegmentMarkers = markers.filter(
        (marker) => marker.lineNumber >= segment.startLine && marker.lineNumber <= segment.endLine,
      );
      markerBuckets.set(segment.id, {
        visible: inSegmentMarkers.slice(0, MAX_MARKERS_PER_SEGMENT),
        hiddenCount: Math.max(0, inSegmentMarkers.length - MAX_MARKERS_PER_SEGMENT),
      });
    }

    return markerBuckets;
  }, [encounterTimeline, parseResult]);

  const handleSelectCombatLog = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Combat Logs", extensions: ["txt", "log"] }],
      });

      if (typeof selected === "string") {
        setSelectedFilePath(selected);
        setParseResult(null);
        setErrorMessage("");
      }
    } catch (error) {
      console.error("Failed to open combat log picker:", error);
      setErrorMessage("Could not open file picker.");
    }
  };

  const handleParseCombatLog = async () => {
    if (!selectedFilePath || isParsing) {
      return;
    }

    setIsParsing(true);
    setErrorMessage("");

    try {
      const result = await invoke<ParseCombatLogDebugResult>("parse_combat_log_file", {
        filePath: selectedFilePath,
      });
      setParseResult(result);
    } catch (error) {
      console.error("Failed to parse combat log file:", error);
      setParseResult(null);
      setErrorMessage(typeof error === "string" ? error : "Could not parse combat log file.");
    } finally {
      setIsParsing(false);
    }
  };

  return (
    <motion.section
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-white/10 bg-(--surface-0) shadow-(--surface-glow)"
      variants={panelVariants}
      initial={reduceMotion ? false : "initial"}
      animate="animate"
      transition={smoothTransition}
    >
      <div className="shrink-0 border-b border-white/10 bg-(--surface-1) px-4 py-4 md:px-6">
        <h1 className="inline-flex items-center gap-2 text-lg font-semibold text-neutral-100">
          <Bug className="h-4 w-4 text-amber-400" />
          Combat Log Debug
        </h1>
        <p className="mt-1 text-xs text-neutral-400">
          Select a combat log file, parse important happenings, and inspect extracted events.
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        <div className="space-y-4">
          <section className="rounded-sm border border-white/10 bg-(--surface-1)/80 p-4">
            <div className="flex flex-col gap-2 md:flex-row md:items-center">
              <button
                onClick={handleSelectCombatLog}
                className="inline-flex items-center gap-2 rounded-sm border border-white/25 bg-white/6 px-4 py-2 text-sm text-neutral-100 transition-colors hover:bg-white/12"
              >
                <FolderOpen className="h-4 w-4" />
                Select Combat Log
              </button>
              <button
                onClick={handleParseCombatLog}
                disabled={!selectedFilePath || isParsing}
                className="inline-flex items-center gap-2 rounded-sm border border-amber-300/30 bg-amber-500/12 px-4 py-2 text-sm text-amber-100 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${isParsing ? "animate-spin" : ""}`} />
                {isParsing ? "Parsing..." : "Parse"}
              </button>
            </div>
            <p className="mt-3 inline-flex items-center gap-2 break-all text-xs text-neutral-300">
              <FileText className="h-3.5 w-3.5 text-neutral-400" />
              {selectedFilePath || "No file selected"}
            </p>
            {errorMessage && <p className="mt-2 text-xs text-rose-300">{errorMessage}</p>}
          </section>

          {parseResult && (
            <>
              <section className="grid gap-3 md:grid-cols-4">
                <div className="rounded-sm border border-white/12 bg-black/20 p-3">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-neutral-500">File Size</div>
                  <div className="mt-1 text-sm text-neutral-100">{formatBytes(parseResult.fileSizeBytes)}</div>
                </div>
                <div className="rounded-sm border border-white/12 bg-black/20 p-3">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-neutral-500">Lines Scanned</div>
                  <div className="mt-1 text-sm text-neutral-100">{parseResult.totalLines.toLocaleString()}</div>
                </div>
                <div className="rounded-sm border border-white/12 bg-black/20 p-3">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-neutral-500">Important Events</div>
                  <div className="mt-1 text-sm text-neutral-100">{totalImportantEvents.toLocaleString()}</div>
                </div>
                <div className="rounded-sm border border-white/12 bg-black/20 p-3">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-neutral-500">Events Shown</div>
                  <div className="mt-1 text-sm text-neutral-100">
                    {parseResult.parsedEvents.length.toLocaleString()}
                    {parseResult.truncated ? " (truncated)" : ""}
                  </div>
                </div>
              </section>

              <section className="rounded-sm border border-white/10 bg-(--surface-1)/80 p-4">
                <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-neutral-200">
                  Event Counts
                </h2>
                <div className="mt-3 flex flex-wrap gap-2">
                  {Object.entries(parseResult.eventCounts).map(([eventType, count]) => (
                    <span
                      key={eventType}
                      className="rounded-sm border border-white/20 bg-black/20 px-2 py-1 text-xs text-neutral-200"
                    >
                      {eventType}: {count.toLocaleString()}
                    </span>
                  ))}
                  {Object.keys(parseResult.eventCounts).length === 0 && (
                    <span className="text-xs text-neutral-500">No important events found.</span>
                  )}
                </div>
              </section>

              <section
                ref={timelineSectionRef}
                onMouseLeave={hideTimelineTooltip}
                className="relative rounded-sm border border-white/10 bg-(--surface-1)/80 p-4"
              >
                <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-neutral-200">
                  Encounter Timeline
                </h2>
                <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-neutral-400">
                  {["PARTY_KILL", "UNIT_DIED", "SPELL_INTERRUPT", "SPELL_DISPEL"].map((eventType) => {
                    const MarkerIcon = getEventMarkerIcon(eventType);
                    return (
                      <span
                        key={eventType}
                        className="inline-flex items-center gap-1.5 rounded border border-white/20 bg-black/20 px-2 py-1"
                      >
                        <span
                          className={`inline-flex h-4 w-4 items-center justify-center rounded-full border ${getEventMarkerClassName(eventType)}`}
                        >
                          <MarkerIcon
                            className={`h-2.5 w-2.5 ${getEventIconClassName(eventType)}`}
                            strokeWidth={2.25}
                          />
                        </span>
                        {getEventTypeLabel(eventType)}
                      </span>
                    );
                  })}
                </div>
                {encounterTimeline.length === 0 ? (
                  <p className="mt-3 text-xs text-neutral-500">No encounter segments detected in this log.</p>
                ) : (
                  <div className="mt-3 space-y-3">
                    {encounterTimeline.map((segment) => {
                      const totalLines = Math.max(1, parseResult.totalLines);
                      const markerBucket = encounterMarkersBySegment.get(segment.id) || {
                        visible: [],
                        hiddenCount: 0,
                      };
                      const startPercent = Math.max(
                        0,
                        Math.min(100, ((segment.startLine - 1) / totalLines) * 100),
                      );
                      const widthPercent = Math.max(
                        1,
                        Math.min(
                          100 - startPercent,
                          ((Math.max(segment.startLine, segment.endLine) - segment.startLine + 1) /
                            totalLines) *
                            100,
                        ),
                      );

                      return (
                        <div
                          key={segment.id}
                          className="rounded-sm border border-white/12 bg-black/20 p-3"
                          onMouseEnter={hideTimelineTooltip}
                        >
                          <div className="mb-2 flex items-center gap-2">
                            <span className="text-sm font-medium text-neutral-100">{segment.name}</span>
                            <span
                              className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] ${getEncounterCategoryClassName(segment.category)}`}
                            >
                              {getEncounterCategoryLabel(segment.category)}
                            </span>
                          </div>
                          <div className="relative h-2 rounded-full bg-neutral-900/70">
                            <div
                              className="h-full rounded-full bg-emerald-500/45"
                              style={{ marginLeft: `${startPercent}%`, width: `${widthPercent}%` }}
                            />
                            {markerBucket.visible.map((marker) => {
                              const markerPercent = Math.max(
                                0,
                                Math.min(100, ((marker.lineNumber - 1) / totalLines) * 100),
                              );
                              const MarkerIcon = getEventMarkerIcon(marker.eventType);

                              return (
                                <span
                                  key={marker.id}
                                  className={`absolute top-1/2 inline-flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border transition-transform duration-150 hover:scale-110 ${getEventMarkerClassName(marker.eventType)}`}
                                  style={{ left: `${markerPercent}%` }}
                                  onMouseEnter={(event) =>
                                    showTimelineTooltip(event, getEventTypeLabel(marker.eventType), [
                                      `Timestamp: ${marker.timestamp}`,
                                      marker.source || marker.target
                                        ? `Actors: ${marker.source || "Unknown"} -> ${marker.target || "Unknown"}`
                                        : "Actors: Unknown",
                                      `Line: ${marker.lineNumber}`,
                                    ])
                                  }
                                  onMouseMove={(event) =>
                                    showTimelineTooltip(event, getEventTypeLabel(marker.eventType), [
                                      `Timestamp: ${marker.timestamp}`,
                                      marker.source || marker.target
                                        ? `Actors: ${marker.source || "Unknown"} -> ${marker.target || "Unknown"}`
                                        : "Actors: Unknown",
                                      `Line: ${marker.lineNumber}`,
                                    ])
                                  }
                                >
                                  <MarkerIcon
                                    className={`h-2.5 w-2.5 ${getEventIconClassName(marker.eventType)}`}
                                    strokeWidth={2.25}
                                  />
                                </span>
                              );
                            })}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-neutral-400">
                            <span>
                              Lines: {segment.startLine} - {segment.endLine}
                            </span>
                            <span>
                              Time: {segment.startTimestamp} - {segment.endTimestamp || "Ongoing"}
                            </span>
                            <span>Zone: {segment.zoneName || "Unknown"}</span>
                            {markerBucket.hiddenCount > 0 && (
                              <span>+{markerBucket.hiddenCount} more markers</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {timelineTooltip && (
                  <motion.div
                    className="pointer-events-none absolute z-30 w-[320px] rounded-sm border border-white/20 bg-(--surface-2) px-3 py-2 text-xs text-neutral-200 shadow-(--surface-glow)"
                    style={{
                      left: timelineTooltip.x,
                      top: timelineTooltip.y,
                      transform: "translate(-50%, -100%)",
                    }}
                    initial={reduceMotion ? false : { opacity: 0, y: 4, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={reduceMotion ? undefined : { opacity: 0, y: 4, scale: 0.98 }}
                    transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <div className="font-medium text-neutral-100">{timelineTooltip.title}</div>
                    {timelineTooltip.lines.map((line) => (
                      <div key={line} className="mt-1 text-neutral-300">
                        {line}
                      </div>
                    ))}
                  </motion.div>
                )}
              </section>

              <section className="rounded-sm border border-white/10 bg-(--surface-1)/80 p-4">
                <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-neutral-200">
                  Important Happenings
                </h2>
                <div className="mt-3 max-h-96 overflow-auto rounded-sm border border-white/10 bg-black/20">
                  <table className="min-w-full text-left text-xs text-neutral-300">
                    <thead className="sticky top-0 bg-(--surface-2) text-neutral-400">
                      <tr>
                        <th className="px-3 py-2 font-medium">Line</th>
                        <th className="px-3 py-2 font-medium">Timestamp</th>
                        <th className="px-3 py-2 font-medium">Event</th>
                        <th className="px-3 py-2 font-medium">Source</th>
                        <th className="px-3 py-2 font-medium">Target</th>
                        <th className="px-3 py-2 font-medium">Context</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parseResult.parsedEvents.map((event) => (
                        <tr key={`${event.lineNumber}-${event.eventType}`} className="border-t border-white/8">
                          <td className="px-3 py-2 text-neutral-400">{event.lineNumber}</td>
                          <td className="px-3 py-2 text-neutral-300">{event.logTimestamp}</td>
                          <td className="px-3 py-2 text-amber-200">{event.eventType}</td>
                          <td className="px-3 py-2 text-neutral-300">{event.source || "-"}</td>
                          <td className="px-3 py-2 text-neutral-300">
                            {event.target ? (
                              <span className="inline-flex items-center gap-1.5">
                                <span>{event.target}</span>
                                {event.targetKind && (
                                  <span className="rounded border border-amber-300/35 bg-amber-500/12 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-amber-200">
                                    {event.targetKind}
                                  </span>
                                )}
                              </span>
                            ) : (
                              "-"
                            )}
                          </td>
                          <td className="px-3 py-2 text-neutral-300">
                            <span className="block text-[11px] text-neutral-400">
                              Zone: {event.zoneName || "Unknown"}
                            </span>
                            <span className="block text-[11px] text-neutral-500">
                              Encounter: {event.encounterName || "None"}
                            </span>
                          </td>
                        </tr>
                      ))}
                      {parseResult.parsedEvents.length === 0 && (
                        <tr>
                          <td className="px-3 py-3 text-neutral-500" colSpan={6}>
                            No important happenings found in this file.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </motion.section>
  );
}
