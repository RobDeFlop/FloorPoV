import { useEffect, useId, useRef, useState } from "react";
import { StickyNote } from "lucide-react";
import { Button } from "../ui/Button";
import { formatTime } from "../../utils/format";
import { MAX_NOTE_TEXT_LENGTH, normalizeNoteText } from "../../utils/note-text";

interface NoteEditorDialogProps {
  title: string;
  timestamp: number;
  initialText?: string;
  isSaving: boolean;
  error: string | null;
  onSave: (text: string) => void;
  onCancel: () => void;
}

export function NoteEditorDialog({
  title,
  timestamp,
  initialText = "",
  isSaving,
  error,
  onSave,
  onCancel,
}: NoteEditorDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const textareaId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draftText, setDraftText] = useState(initialText);
  const canSave = Boolean(normalizeNoteText(draftText)) && !isSaving;

  useEffect(() => {
    textareaRef.current?.focus();
    textareaRef.current?.select();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <form
        className="w-full max-w-md rounded-sm border border-white/15 bg-(--surface-2) p-4 shadow-(--surface-glow)"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSave) {
            return;
          }

          onSave(draftText);
        }}
      >
        <div className="mb-3 inline-flex h-8 w-8 items-center justify-center rounded-sm border border-violet-300/25 bg-violet-500/12">
          <StickyNote className="h-4 w-4 text-violet-200" />
        </div>
        <h3
          id={titleId}
          className="text-sm font-semibold uppercase tracking-[0.11em] text-neutral-100"
        >
          {title}
        </h3>
        <p id={descriptionId} className="mt-2 text-sm text-neutral-300">
          Attached to {formatTime(timestamp)}.
        </p>
        <label htmlFor={textareaId} className="mt-3 block text-xs uppercase tracking-[0.12em] text-neutral-400">
          Note
        </label>
        <textarea
          ref={textareaRef}
          id={textareaId}
          value={draftText}
          maxLength={MAX_NOTE_TEXT_LENGTH}
          rows={5}
          disabled={isSaving}
          onChange={(event) => setDraftText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (!isSaving) {
                onCancel();
              }
            }
          }}
          className="mt-1 w-full resize-y rounded-sm border border-white/20 bg-black/20 px-3 py-2 text-sm text-neutral-100 transition-colors placeholder:text-neutral-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:opacity-50"
          placeholder="Add a review note for this timestamp"
        />
        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-neutral-500">
          <span>
            {draftText.trim().length}/{MAX_NOTE_TEXT_LENGTH}
          </span>
          {error ? (
            <span className="text-rose-300" role="alert">
              {error}
            </span>
          ) : null}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button type="button" size="sm" onClick={onCancel} disabled={isSaving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={!canSave}>
            {isSaving ? "Saving..." : "Save note"}
          </Button>
        </div>
      </form>
    </div>
  );
}
