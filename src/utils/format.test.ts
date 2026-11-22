import { describe, expect, test } from "bun:test";
import { formatCompactAmount, getEventTypeLabel } from "./format";

describe("formatCompactAmount", () => {
  test("uses compact suffixes for playback amounts", () => {
    expect(formatCompactAmount(1_250_000)).toBe("1.3M");
    expect(formatCompactAmount(2_400_000)).toBe("2.4M");
    expect(formatCompactAmount(12_500)).toBe("12.5K");
    expect(formatCompactAmount(850)).toBe("850");
    expect(formatCompactAmount(undefined)).toBe("");
  });
});

describe("getEventTypeLabel", () => {
  test("labels review markers", () => {
    expect(getEventTypeLabel("UNIT_DIED")).toBe("Death");
    expect(getEventTypeLabel("BLOODLUST")).toBe("Bloodlust");
    expect(getEventTypeLabel("ENCOUNTER_START")).toBe("Encounter start");
    expect(getEventTypeLabel("ENCOUNTER_END")).toBe("Encounter end");
  });
});
