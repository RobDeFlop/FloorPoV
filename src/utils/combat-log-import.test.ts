import { expect, mock, test } from "bun:test";
import type { ImportCombatLogMode } from "../types/events";
import { createCombatLogImport } from "./combat-log-import";

test("rapid activation cannot overlap the picker, mode choice, or import", async () => {
  const selection = Promise.withResolvers<string>();
  const choice = Promise.withResolvers<ImportCombatLogMode>();
  const completion = Promise.withResolvers<void>();
  const busy = mock((_busy: boolean) => {});
  const runImport = createCombatLogImport(busy);
  const steps = {
    pickFile: mock(() => selection.promise),
    chooseMode: mock(() => choice.promise),
    importFile: mock(() => completion.promise),
  };

  const first = runImport(steps);
  await runImport(steps);
  selection.resolve("combat.log");
  await Promise.resolve();
  expect(steps.chooseMode).toHaveBeenCalledTimes(1);
  await runImport(steps);
  choice.resolve("merge");
  await Promise.resolve();
  await runImport(steps);
  expect(steps.pickFile).toHaveBeenCalledTimes(1);
  expect(steps.importFile.mock.calls).toEqual([["combat.log", "merge"]]);
  expect(busy.mock.calls).toEqual([[true]]);
  completion.resolve();
  await first;
  expect(busy.mock.calls).toEqual([[true], [false]]);
});

test("cancelling the picker or mode dialog releases Import without importing", async () => {
  const busy = mock((_busy: boolean) => {});
  const runImport = createCombatLogImport(busy);
  const chooseMode = mock(async () => null);
  const importFile = mock(async () => {});
  for (const selection of [null, "combat.log"]) {
    await runImport({ pickFile: async () => selection, chooseMode, importFile });
  }
  expect(chooseMode).toHaveBeenCalledTimes(1);
  expect(importFile).not.toHaveBeenCalled();
  expect(busy.mock.calls).toEqual([[true], [false], [true], [false]]);
});

test("an import error reaches the caller and the same control can retry", async () => {
  const busy = mock((_busy: boolean) => {});
  const runImport = createCombatLogImport(busy);
  const steps = {
    pickFile: async () => "combat.log",
    chooseMode: async () => "overwrite" as const,
    importFile: mock(async () => {}),
  };
  steps.importFile.mockRejectedValueOnce(new Error("Import failed"));
  await expect(runImport(steps)).rejects.toThrow("Import failed");
  await runImport(steps);
  expect(steps.importFile).toHaveBeenCalledTimes(2);
  expect(busy.mock.calls).toEqual([[true], [false], [true], [false]]);
});
