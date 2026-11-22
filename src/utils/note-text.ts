export const MAX_NOTE_TEXT_LENGTH = 2000;

export function normalizeNoteText(text: string): string | null {
  const trimmedText = text.trim();
  if (!trimmedText || trimmedText.length > MAX_NOTE_TEXT_LENGTH) {
    return null;
  }

  return trimmedText;
}
