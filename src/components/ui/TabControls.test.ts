import { describe, expect, test } from "bun:test";
import { getNextTabIndex } from "./TabControls";

describe("getNextTabIndex", () => {
  test("moves forward and wraps with ArrowRight and ArrowDown", () => {
    expect(getNextTabIndex(0, 3, "ArrowRight")).toBe(1);
    expect(getNextTabIndex(2, 3, "ArrowRight")).toBe(0);
    expect(getNextTabIndex(1, 3, "ArrowDown")).toBe(2);
  });

  test("moves backward and wraps with ArrowLeft and ArrowUp", () => {
    expect(getNextTabIndex(2, 3, "ArrowLeft")).toBe(1);
    expect(getNextTabIndex(0, 3, "ArrowLeft")).toBe(2);
    expect(getNextTabIndex(1, 3, "ArrowUp")).toBe(0);
  });

  test("jumps to the first and last tab with Home and End", () => {
    expect(getNextTabIndex(2, 4, "Home")).toBe(0);
    expect(getNextTabIndex(0, 4, "End")).toBe(3);
  });

  test("ignores unrelated keys and empty tab lists", () => {
    expect(getNextTabIndex(1, 3, "Enter")).toBeNull();
    expect(getNextTabIndex(0, 0, "ArrowRight")).toBeNull();
  });
});
