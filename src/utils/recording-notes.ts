import { invoke } from "@tauri-apps/api/core";
import {
  convertRecordingNoteToGameEvent,
  type GameEvent,
  type RecordingNoteMetadata,
} from "../types/events";
import { MAX_NOTE_TEXT_LENGTH, normalizeNoteText } from "./note-text";

export { MAX_NOTE_TEXT_LENGTH, normalizeNoteText };

export async function saveRecordingNote(options: {
  filePath: string;
  noteId?: string;
  timestampSeconds: number;
  text: string;
}): Promise<GameEvent> {
  const normalizedText = normalizeNoteText(options.text);
  if (!normalizedText) {
    throw new Error(
      options.text.trim()
        ? `Note text cannot exceed ${MAX_NOTE_TEXT_LENGTH} characters`
        : "Note text cannot be empty",
    );
  }

  const savedNote = await invoke<RecordingNoteMetadata>("save_recording_note", {
    filePath: options.filePath,
    noteId: options.noteId ?? null,
    timestampSeconds: options.timestampSeconds,
    text: normalizedText,
  });
  const gameEvent = convertRecordingNoteToGameEvent(savedNote);
  if (!gameEvent) {
    throw new Error("Saved note could not be loaded");
  }

  return gameEvent;
}

export async function deleteRecordingNote(filePath: string, noteId: string): Promise<void> {
  await invoke("delete_recording_note", { filePath, noteId });
}
