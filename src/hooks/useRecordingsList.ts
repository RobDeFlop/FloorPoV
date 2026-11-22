import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettings } from "../contexts/SettingsContext";
import { RecordingInfo } from "../types/recording";

export interface UseRecordingsListResult {
  recordings: RecordingInfo[];
  isLoading: boolean;
  error: string | null;
  loadRecordings: () => Promise<void>;
  setRecordings: React.Dispatch<React.SetStateAction<RecordingInfo[]>>;
}

/**
 * Fetches the recordings list from the output folder and reloads automatically
 * whenever a new recording finishes (recording-stopped event).
 */
export function useRecordingsList(): UseRecordingsListResult {
  const { settings } = useSettings();
  const [recordings, setRecordings] = useState<RecordingInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRecordings = useCallback(async () => {
    if (!settings.outputFolder) {
      setRecordings([]);
      setError(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await invoke<RecordingInfo[]>("get_recordings_list", {
        folderPath: settings.outputFolder,
      });
      setRecordings([...result].reverse());
    } catch (loadError) {
      console.error("Failed to load recordings:", loadError);
      setError("Could not load recordings from the output folder.");
    } finally {
      setIsLoading(false);
    }
  }, [settings.outputFolder]);

  useEffect(() => {
    void loadRecordings();
  }, [loadRecordings]);

  useEffect(() => {
    const unlistenRecordingStopped = listen("recording-stopped", () => {
      void loadRecordings();
    });
    const unlistenCombatLogImported = listen("combat-log-imported", () => {
      void loadRecordings();
    });

    return () => {
      unlistenRecordingStopped.then((unsubscribe) => unsubscribe());
      unlistenCombatLogImported.then((unsubscribe) => unsubscribe());
    };
  }, [loadRecordings]);

  return { recordings, isLoading, error, loadRecordings, setRecordings };
}
