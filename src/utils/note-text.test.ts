import { describe, expect, test } from "bun:test";
import { MAX_NOTE_TEXT_LENGTH, normalizeNoteText } from "./note-text";

describe("normalizeNoteText", () => {
  test("trims review notes and rejects empty text", () => {
    expect(normalizeNoteText("  hold the soak  ")).toBe("hold the soak");
    expect(normalizeNoteText("   ")).toBeNull();
    expect(normalizeNoteText("n".repeat(MAX_NOTE_TEXT_LENGTH + 1))).toBeNull();
  });
});
