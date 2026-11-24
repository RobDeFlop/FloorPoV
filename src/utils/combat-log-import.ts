import type { ImportCombatLogMode } from "../types/events";

interface CombatLogImportSteps {
  pickFile: () => Promise<string | null>;
  chooseMode: () => Promise<ImportCombatLogMode | null>;
  importFile: (path: string, mode: ImportCombatLogMode) => Promise<void>;
}

export function createCombatLogImport(setBusy: (busy: boolean) => void) {
  let active = false;

  return async ({ pickFile, chooseMode, importFile }: CombatLogImportSteps): Promise<void> => {
    if (active) {
      return;
    }

    active = true;
    try {
      setBusy(true);
      const path = await pickFile();
      if (!path?.trim()) {
        return;
      }
      const mode = await chooseMode();
      if (mode) {
        await importFile(path, mode);
      }
    } finally {
      active = false;
      setBusy(false);
    }
  };
}
