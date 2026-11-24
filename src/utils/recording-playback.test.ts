import { describe, expect, test } from "bun:test";
import { recordingsFolderFromFilePath } from "./recording-playback";

describe("recordingsFolderFromFilePath", () => {
  test("reads a Windows recordings folder", () => {
    expect(recordingsFolderFromFilePath("D:\\videos\\augurs-terrace-13.mp4")).toBe("D:\\videos");
  });

  test("keeps a Windows drive root", () => {
    expect(recordingsFolderFromFilePath("D:\\clip.mp4")).toBe("D:\\");
  });

  test("reads a posix recordings folder", () => {
    expect(recordingsFolderFromFilePath("/home/marco/Videos/FloorPoV/key.mp4")).toBe(
      "/home/marco/Videos/FloorPoV",
    );
  });

  test("ignores blank paths", () => {
    expect(recordingsFolderFromFilePath("   ")).toBeNull();
  });
});
