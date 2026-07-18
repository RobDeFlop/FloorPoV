import { Check, ChevronDown, ChevronRight, LoaderCircle, X } from "lucide-react";
import { useMemo, useState } from "react";
import { WclActivityGroup } from "../../contexts/WclUploadContext";
import { Button } from "../ui/Button";

interface WclActivitySelectionModalProps {
  isScanning: boolean;
  scanPercent: number;
  scanStatus: string | null;
  scanError: string | null;
  groups: WclActivityGroup[];
  selectedActivityIds: Set<string>;
  onSelectionChange: (activityIds: Set<string>) => void;
  onUpload: () => void;
  onCancel: () => void;
  onRetry: () => void;
}

function formatTimestamp(timestamp: number | null): string {
  if (timestamp === null) {
    return "Unknown time";
  }
  return new Date(timestamp).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null || durationMs < 0) {
    return "Unknown duration";
  }
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function statusLabel(status: string): string {
  return status === "incomplete" ? "Incomplete" : status[0].toUpperCase() + status.slice(1);
}

export function WclActivitySelectionModal({
  isScanning,
  scanPercent,
  scanStatus,
  scanError,
  groups,
  selectedActivityIds,
  onSelectionChange,
  onUpload,
  onCancel,
  onRetry,
}: WclActivitySelectionModalProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(groups.filter((group) => group.kind !== "other").map((group) => group.id)),
  );
  const [showOther, setShowOther] = useState(false);

  const supportedActivities = useMemo(
    () => groups.filter((group) => group.kind !== "other").flatMap((group) => group.activities),
    [groups],
  );
  const otherGroup = groups.find((group) => group.kind === "other");
  const hasSupportedActivities = supportedActivities.length > 0;
  const visibleGroups = groups.filter((group) => group.kind !== "other" || showOther || !hasSupportedActivities);
  const selectedCount = selectedActivityIds.size;

  const toggleGroup = (group: WclActivityGroup) => {
    const next = new Set(selectedActivityIds);
    const allSelected = group.activities.every((activity) => next.has(activity.id));
    group.activities.forEach((activity) => {
      if (allSelected) {
        next.delete(activity.id);
      } else {
        next.add(activity.id);
      }
    });
    onSelectionChange(next);
  };

  const selectAllSupported = () => onSelectionChange(new Set(supportedActivities.map((activity) => activity.id)));
  const clearSelection = () => onSelectionChange(new Set());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div
        className="flex max-h-[min(780px,calc(100vh-2rem))] w-full max-w-3xl flex-col rounded-sm
          border border-white/15 bg-(--surface-2) shadow-(--surface-glow)"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wcl-activity-selection-title"
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/10 p-4">
          <div>
            <h2
              id="wcl-activity-selection-title"
              className="text-sm font-semibold uppercase tracking-[0.11em] text-neutral-100"
            >
              Select Activities to Upload
            </h2>
            <p className="mt-1 text-xs text-neutral-400">
              Choose raid pulls, whole Mythic+ runs, or PvP matches from this combat log.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-sm p-1 text-neutral-400 hover:bg-white/10 hover:text-neutral-100"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {isScanning ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
            <LoaderCircle className="h-8 w-8 animate-spin text-emerald-300" />
            <p className="text-sm text-neutral-200">{scanStatus ?? "Scanning combat log..."}</p>
            <div className="w-full max-w-md">
              <div className="h-2 overflow-hidden rounded-full bg-neutral-800">
                <div className="h-full bg-emerald-400 transition-all" style={{ width: `${scanPercent}%` }} />
              </div>
              <p className="mt-2 text-xs text-neutral-500">{scanPercent}%</p>
            </div>
            <Button variant="secondary" onClick={onCancel}>Cancel Scan</Button>
          </div>
        ) : scanError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
            <p className="max-w-lg text-sm text-rose-200">{scanError}</p>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={onCancel}>Close</Button>
              <Button variant="primary" onClick={onRetry}>Scan Again</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 p-3">
              <span className="text-xs text-neutral-400">{selectedCount} selected</span>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={selectAllSupported}
                  disabled={!hasSupportedActivities}
                >
                  Select All
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={clearSelection}
                  disabled={selectedCount === 0}
                >
                  Clear Selection
                </Button>
                {otherGroup && hasSupportedActivities && (
                  <Button variant="secondary" size="sm" onClick={() => setShowOther((current) => !current)}>
                    {showOther ? "Hide Other" : "Show Other"}
                  </Button>
                )}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {visibleGroups.length === 0 ? (
                <p className="p-6 text-center text-sm text-neutral-400">No selectable activities were found.</p>
              ) : (
                <div className="space-y-2">
                  {visibleGroups.map((group) => {
                    const selectedChildren = group.activities.filter((activity) =>
                      selectedActivityIds.has(activity.id),
                    ).length;
                    const allSelected = selectedChildren === group.activities.length && group.activities.length > 0;
                    const partiallySelected = selectedChildren > 0 && !allSelected;
                    const expanded = expandedGroups.has(group.id);
                    return (
                      <div key={group.id} className="rounded-sm border border-white/10 bg-black/15">
                        <div className="flex items-center gap-2 p-3">
                          <button
                            type="button"
                            className="text-neutral-400"
                            onClick={() => setExpandedGroups((current) => {
                              const next = new Set(current);
                              if (next.has(group.id)) next.delete(group.id);
                              else next.add(group.id);
                              return next;
                            })}
                            aria-label={`${expanded ? "Collapse" : "Expand"} ${group.title}`}
                          >
                            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleGroup(group)}
                            className="flex h-4 w-4 items-center justify-center rounded-sm border
                              border-white/35 text-emerald-300"
                            aria-label={`Select ${group.title}`}
                          >
                            {allSelected && <Check className="h-3 w-3" />}
                            {partiallySelected && <span className="h-0.5 w-2 bg-emerald-300" />}
                          </button>
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left"
                            onClick={() => setExpandedGroups((current) => new Set(current).add(group.id))}
                          >
                            <span className="block truncate text-sm font-medium text-neutral-100">{group.title}</span>
                            <span className="text-xs text-neutral-500">
                              {group.kind} · {selectedChildren}/{group.activities.length} selected
                              {group.subtitle ? ` · ${group.subtitle}` : ""}
                            </span>
                          </button>
                        </div>
                        {expanded && (
                          <div className="space-y-1 border-t border-white/10 p-2">
                            {group.activities.map((activity) => {
                              const selected = selectedActivityIds.has(activity.id);
                              return (
                                <button key={activity.id} type="button" onClick={() => {
                                  const next = new Set(selectedActivityIds);
                                  if (selected) next.delete(activity.id); else next.add(activity.id);
                                  onSelectionChange(next);
                                }}
                                  className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center
                                    gap-3 rounded-sm p-2 text-left transition-colors
                                    ${selected ? "bg-emerald-500/10" : "hover:bg-white/5"}`}
                                >
                                  <span
                                    className={`flex h-4 w-4 items-center justify-center rounded-sm border
                                      ${selected
                                        ? "border-emerald-300 bg-emerald-400/20 text-emerald-200"
                                        : "border-white/30 text-transparent"}`}
                                  >
                                    <Check className="h-3 w-3" />
                                  </span>
                                  <span className="min-w-0">
                                    <span className="block truncate text-xs font-medium text-neutral-200">
                                      {activity.title}{activity.subtitle ? ` · ${activity.subtitle}` : ""}
                                    </span>
                                    <span className="block truncate text-[11px] text-neutral-500">
                                      {formatTimestamp(activity.startedAt)} · {formatDuration(activity.durationMs)}
                                      {activity.keyLevel ? ` · +${activity.keyLevel}` : ""}
                                    </span>
                                  </span>
                                  <span
                                    className={`text-[10px] uppercase tracking-wide ${
                                      activity.status === "incomplete" || activity.status === "wipe"
                                        ? "text-amber-200"
                                        : "text-neutral-500"
                                    }`}
                                  >
                                    {statusLabel(activity.status)}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-white/10 p-3">
              <Button variant="secondary" onClick={onCancel}>Cancel</Button>
              <Button
                variant="primary"
                onClick={onUpload}
                disabled={selectedCount === 0}
              >
                Upload Selected ({selectedCount})
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
