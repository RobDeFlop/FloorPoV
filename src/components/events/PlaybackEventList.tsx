import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";
import { Check, ListVideo, Pencil, Trash2, X } from "lucide-react";
import { useMarker } from "../../contexts/MarkerContext";
import { useRecording } from "../../contexts/RecordingContext";
import { useVideo } from "../../contexts/VideoContext";
import { getErrorMessage } from "../../services/tauri";
import {
  EVENT_SEEK_OFFSET_SECONDS,
  getManualMarkerLabel,
  isVideoSeekBarEvent,
  MANUAL_MARKER_NAME_MAX_LENGTH,
  manualMarkerOccurrenceIndex,
  normalizeManualMarkerName,
  type GameEvent,
  type GameEventType,
} from "../../types/events";
import { formatCompactAmount, formatTime, formatUnitName } from "../../utils/format";
import { deleteRecordingNote, saveRecordingNote } from "../../utils/recording-notes";
import { DeleteConfirmDialog } from "../ui/DeleteConfirmDialog";
import { EventMarker, EventTypeFilter } from "./EventMarker";
import { NoteEditorDialog } from "./NoteEditorDialog";

const EVENT_LIST_LABELS: Record<GameEventType, string> = {
  death: "Death",
  manual: "Marker",
  bloodlust: "Bloodlust",
  encounterStart: "Encounter start",
  encounterEnd: "Encounter end",
  note: "Note",
};

const EVENT_LIST_FILTER_TYPES: GameEventType[] = [
  "encounterStart",
  "encounterEnd",
  "death",
  "manual",
  "bloodlust",
  "note",
];

function getEventListDetail(event: GameEvent): string {
  if (event.type === "death") {
    return formatUnitName(event.target);
  }

  if (event.type === "manual") {
    return getManualMarkerLabel(event);
  }

  if (event.type === "bloodlust") {
    return formatUnitName(event.source);
  }

  if (event.type === "encounterStart" || event.type === "encounterEnd") {
    return event.name ?? "Encounter";
  }

  if (event.type === "note") {
    return event.note ?? "Review note";
  }

  return formatUnitName(event.source);
}

interface ManualMarkerNameFormProps {
  initialName: string;
  isSaving: boolean;
  errorMessage: string | null;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

function ManualMarkerNameForm({
  initialName,
  isSaving,
  errorMessage,
  onSubmit,
  onCancel,
}: ManualMarkerNameFormProps) {
  const [draftName, setDraftName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }

    input.focus();
    input.select();
  }, []);

  return (
    <div className="px-3 pb-2">
      <form
        className="flex items-center gap-1.5"
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          onSubmit(draftName);
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={draftName}
          maxLength={MANUAL_MARKER_NAME_MAX_LENGTH}
          placeholder="Name this marker"
          disabled={isSaving}
          aria-label="Marker name"
          onChange={(changeEvent) => setDraftName(changeEvent.target.value)}
          onKeyDown={(keyEvent) => {
            if (keyEvent.key !== "Escape") {
              return;
            }

            keyEvent.preventDefault();
            onCancel();
          }}
          className="min-w-0 flex-1 rounded-sm border border-white/20 bg-black/30 px-2 py-1 text-xs text-neutral-100 transition-colors placeholder:text-neutral-500 focus:border-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:text-neutral-500"
        />
        <button
          type="submit"
          disabled={isSaving}
          aria-label="Save marker name"
          className="shrink-0 rounded-sm border border-white/20 bg-black/20 p-1 text-neutral-300 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled={isSaving}
          onClick={onCancel}
          aria-label="Cancel marker name"
          className="shrink-0 rounded-sm border border-transparent p-1 text-neutral-400 transition-colors hover:bg-white/10 hover:text-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </form>
      {errorMessage && <p className="mt-1 text-[11px] text-rose-300">{errorMessage}</p>}
    </div>
  );
}

interface PlaybackEventListProps {
  variant?: "sidebar" | "overlay";
}

export function PlaybackEventList({ variant = "sidebar" }: PlaybackEventListProps) {
  const { currentTime, loadedFilePath, seek, videoSrc } = useVideo();
  const { isRecording, recordingPath } = useRecording();
  const {
    events,
    filteredEvents,
    updateEvent,
    updateEventName,
    removeEvent,
    pendingRenameEventId,
    clearPendingRename,
  } = useMarker();
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [isSavingName, setIsSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState<GameEvent | null>(null);
  const [notePendingDelete, setNotePendingDelete] = useState<GameEvent | null>(null);
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [isDeletingNote, setIsDeletingNote] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const listEvents = useMemo(() => filteredEvents.filter(isVideoSeekBarEvent), [filteredEvents]);
  const hasTimelineEvents = events.some(isVideoSeekBarEvent);
  const isOverlay = variant === "overlay";
  const canEditNotes = Boolean(loadedFilePath) && !isRecording;

  const activeEventId = useMemo(() => {
    let activeId: string | null = null;

    for (const event of listEvents) {
      if (event.timestamp <= currentTime) {
        activeId = event.id;
        continue;
      }

      break;
    }

    return activeId;
  }, [currentTime, listEvents]);

  // A marker placed while the app is focused opens its editor right away. Markers placed
  // from the background stay anonymous until the user renames them from this list.
  useEffect(() => {
    if (!pendingRenameEventId) {
      return;
    }

    setEditingEventId(pendingRenameEventId);
    setIsSavingName(false);
    setNameError(null);
    clearPendingRename();
  }, [clearPendingRename, pendingRenameEventId]);

  const stopEditing = useCallback(() => {
    setEditingEventId(null);
    setIsSavingName(false);
    setNameError(null);
  }, []);

  const startEditing = useCallback((eventId: string) => {
    setEditingEventId(eventId);
    setIsSavingName(false);
    setNameError(null);
  }, []);

  const saveMarkerName = useCallback(
    async (markerEvent: GameEvent, draftName: string) => {
      if (isSavingName) {
        return;
      }

      const nextName = normalizeManualMarkerName(draftName);
      if (nextName === markerEvent.name) {
        stopEditing();
        return;
      }

      setIsSavingName(true);
      setNameError(null);

      try {
        await invoke("update_manual_marker_name", {
          filePath: isRecording ? recordingPath : loadedFilePath ?? recordingPath,
          timestampSeconds: markerEvent.timestamp,
          occurrence: manualMarkerOccurrenceIndex(events, markerEvent),
          name: nextName ?? null,
        });
        updateEventName(markerEvent.id, nextName);
        stopEditing();
      } catch (error) {
        console.error("Failed to save manual marker name:", error);
        setNameError(getErrorMessage(error));
        setIsSavingName(false);
      }
    },
    [events, isRecording, isSavingName, loadedFilePath, recordingPath, stopEditing, updateEventName],
  );

  const handleEventClick = (timestamp: number) => {
    seek(Math.max(0, timestamp - EVENT_SEEK_OFFSET_SECONDS));
  };

  const handleSaveEditedNote = async (text: string) => {
    if (!editingNote || !loadedFilePath || isSavingNote) {
      return;
    }

    setIsSavingNote(true);
    setNoteError(null);

    try {
      const savedNote = await saveRecordingNote({
        filePath: loadedFilePath,
        noteId: editingNote.id,
        timestampSeconds: editingNote.timestamp,
        text,
      });
      updateEvent(editingNote.id, savedNote);
      setEditingNote(null);
    } catch (error) {
      setNoteError(getErrorMessage(error) || "Could not save the note.");
    } finally {
      setIsSavingNote(false);
    }
  };

  const handleConfirmDeleteNote = async () => {
    if (!notePendingDelete || !loadedFilePath || isDeletingNote) {
      return;
    }

    setIsDeletingNote(true);

    try {
      await deleteRecordingNote(loadedFilePath, notePendingDelete.id);
      removeEvent(notePendingDelete.id);
      setNotePendingDelete(null);
    } catch (error) {
      setNoteError(getErrorMessage(error) || "Could not delete the note.");
    } finally {
      setIsDeletingNote(false);
    }
  };

  return (
    <aside
      className={
        isOverlay
          ? "flex h-full w-full flex-col border-l border-white/10 bg-neutral-950/92 backdrop-blur-sm"
          : "flex h-full w-72 shrink-0 flex-col border-l border-white/10 bg-(--surface-2)"
      }
    >
      <div className="flex flex-col gap-2 border-b border-white/10 px-3 py-2">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.12em] text-neutral-400">
          <ListVideo className="h-3.5 w-3.5 text-neutral-300" />
          Events
        </div>
        <EventTypeFilter types={EVENT_LIST_FILTER_TYPES} />
        {noteError && !editingNote ? (
          <p className="text-xs text-rose-300" role="alert">
            {noteError}
          </p>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        {!videoSrc && !isRecording ? (
          <p className="px-3 py-4 text-xs text-neutral-500">
            Load a recording to see boss encounters, deaths, bloodlust, markers, and notes.
          </p>
        ) : !hasTimelineEvents ? (
          <p className="px-3 py-4 text-xs text-neutral-500">
            No encounters, deaths, bloodlust, markers, or notes in this recording. Import a combat
            log from the player controls to add them.
          </p>
        ) : listEvents.length === 0 ? (
          <p className="px-3 py-4 text-xs text-neutral-500">No events match the current filters.</p>
        ) : (
          <ul className="py-1">
            {listEvents.map((event) => {
              const isActive = event.id === activeEventId;
              const compactAmount = formatCompactAmount(event.amount);
              const isManualMarker = event.type === "manual";
              const isEditing = isManualMarker && event.id === editingEventId;

              return (
                <li key={event.id} className={isActive ? "bg-white/10" : undefined}>
                  <div
                    className={`flex w-full items-start gap-2 px-3 py-2 transition-colors ${
                      isActive ? "" : "hover:bg-white/5"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleEventClick(event.timestamp)}
                      className="flex min-w-0 flex-1 items-start gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
                      aria-current={isActive ? "true" : undefined}
                      aria-label={`Seek to ${EVENT_LIST_LABELS[event.type]} at ${formatTime(event.timestamp)}`}
                    >
                      <span className="mt-0.5 shrink-0">
                        <EventMarker type={event.type} variant="compact" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="text-xs font-medium text-neutral-100">
                            {EVENT_LIST_LABELS[event.type]}
                          </span>
                          <span className="flex shrink-0 items-baseline gap-2">
                            {compactAmount ? (
                              <span
                                className="font-mono text-[11px] text-orange-300"
                              >
                                {compactAmount}
                              </span>
                            ) : null}
                            <span className="font-mono text-[11px] text-neutral-400">
                              {formatTime(event.timestamp)}
                            </span>
                          </span>
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-neutral-400">
                          {getEventListDetail(event)}
                        </span>
                      </span>
                    </button>
                    {isManualMarker && !isEditing && (
                      <button
                        type="button"
                        onClick={() => startEditing(event.id)}
                        aria-label={`Name marker at ${formatTime(event.timestamp)}`}
                        className="mt-0.5 shrink-0 rounded-sm border border-transparent p-1 text-neutral-500 transition-colors hover:bg-white/10 hover:text-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    )}
                    {event.type === "note" && canEditNotes ? (
                      <div className="flex shrink-0 items-center pt-1">
                        <button
                          type="button"
                          onClick={() => {
                            setNoteError(null);
                            setEditingNote(event);
                          }}
                          className="rounded p-1 text-neutral-400 transition-colors hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
                          aria-label={`Edit note at ${formatTime(event.timestamp)}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setNoteError(null);
                            setNotePendingDelete(event);
                          }}
                          className="rounded p-1 text-neutral-400 transition-colors hover:text-rose-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
                          aria-label={`Delete note at ${formatTime(event.timestamp)}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : null}
                  </div>
                  {isEditing && (
                    <ManualMarkerNameForm
                      key={event.id}
                      initialName={event.name ?? ""}
                      isSaving={isSavingName}
                      errorMessage={nameError}
                      onSubmit={(draftName) => void saveMarkerName(event, draftName)}
                      onCancel={stopEditing}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {editingNote
        ? createPortal(
            <NoteEditorDialog
              title="Edit note"
              timestamp={editingNote.timestamp}
              initialText={editingNote.note ?? ""}
              isSaving={isSavingNote}
              error={noteError}
              onSave={(text) => {
                void handleSaveEditedNote(text);
              }}
              onCancel={() => {
                if (isSavingNote) {
                  return;
                }

                setEditingNote(null);
                setNoteError(null);
              }}
            />,
            document.body,
          )
        : null}
      {notePendingDelete
        ? createPortal(
            <DeleteConfirmDialog
              title="Delete note"
              description={`Delete the note at ${formatTime(notePendingDelete.timestamp)}? This cannot be undone.`}
              isDeleting={isDeletingNote}
              confirmLabel="Delete note"
              onConfirm={() => {
                void handleConfirmDeleteNote();
              }}
              onCancel={() => {
                if (isDeletingNote) {
                  return;
                }

                setNotePendingDelete(null);
              }}
            />,
            document.body,
          )
        : null}
    </aside>
  );
}
