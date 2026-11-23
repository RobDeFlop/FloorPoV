import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Store } from '@tauri-apps/plugin-store';
import { RecordingSettings, DEFAULT_SETTINGS } from '../types/settings';
import { allowRecordingsFolderForPlayback } from '../utils/recording-playback';
import { applyAppTheme, normalizeAppTheme, persistAppTheme } from '../utils/theme';
import { saveRecordingSettings, SettingsSaveResult } from "../services/save-recording-settings";

interface SettingsContextType {
  playbackUnavailable: boolean;
  settings: RecordingSettings;
  isLoading: boolean;
  updateSettings: (newSettings: RecordingSettings) => Promise<SettingsSaveResult>;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

const FORK_IN_APP_UPDATES_KEY = "fork-in-app-updates-v1";

function getLegacyDefaultOutputFolderPath(defaultFolder: string): string | null {
  if (defaultFolder.endsWith('\\FloorPoV')) {
    return defaultFolder.slice(0, -'\\FloorPoV'.length) + '\\Floorpov';
  }

  if (defaultFolder.endsWith('/FloorPoV')) {
    return defaultFolder.slice(0, -'/FloorPoV'.length) + '/Floorpov';
  }

  return null;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<RecordingSettings>(DEFAULT_SETTINGS);
  const [playbackUnavailable, setPlaybackUnavailable] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [store, setStore] = useState<Store | null>(null);

  useEffect(() => {
    const initStore = async () => {
      const storeInstance = await Store.load('settings.json');
      setStore(storeInstance);
    };
    initStore();
  }, []);

  useEffect(() => {
    if (store) {
      loadSettings();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  const loadSettings = useCallback(async () => {
    if (!store) return;
    
    try {
      const stored = await store.get<RecordingSettings>('recording-settings');
      
      if (stored) {
        const mergedSettings: RecordingSettings = {
          ...DEFAULT_SETTINGS,
          ...stored,
          appTheme: normalizeAppTheme(stored.appTheme),
        };

        const defaultFolder = await invoke<string>('get_default_output_folder');
        const legacyDefaultFolder = getLegacyDefaultOutputFolderPath(defaultFolder);
        const hasEnabledInAppUpdates =
          (await store.get<boolean>(FORK_IN_APP_UPDATES_KEY)) === true;
        let shouldPersistMergedSettings = false;

        if (!mergedSettings.outputFolder) {
          mergedSettings.outputFolder = defaultFolder;
          shouldPersistMergedSettings = true;
        }

        if (
          legacyDefaultFolder &&
          mergedSettings.outputFolder === legacyDefaultFolder
        ) {
          mergedSettings.outputFolder = defaultFolder;
          shouldPersistMergedSettings = true;
        }

        if (!hasEnabledInAppUpdates && !mergedSettings.enableAutoUpdate) {
          mergedSettings.enableAutoUpdate = true;
          shouldPersistMergedSettings = true;
        }

        if (shouldPersistMergedSettings) {
          await store.set('recording-settings', mergedSettings);
        }

        if (!hasEnabledInAppUpdates) {
          await store.set(FORK_IN_APP_UPDATES_KEY, true);
        }

        if (shouldPersistMergedSettings || !hasEnabledInAppUpdates) {
          await store.save();
        }

        try {
          await allowRecordingsFolderForPlayback(mergedSettings.outputFolder);
        } catch (error) {
          console.error('Failed to allow recordings folder for playback:', error);
        }

        setSettings(mergedSettings);
        
        if (mergedSettings.markerHotkey && mergedSettings.markerHotkey !== 'none') {
          try {
            await invoke('register_marker_hotkey', { hotkey: mergedSettings.markerHotkey });
          } catch (error) {
            console.error('Failed to register hotkey:', error);
          }
        }
      } else {
        const defaultFolder = await invoke<string>('get_default_output_folder');
        const initialSettings = { ...DEFAULT_SETTINGS, outputFolder: defaultFolder };
        try {
          await allowRecordingsFolderForPlayback(initialSettings.outputFolder);
        } catch (error) {
          console.error('Failed to allow recordings folder for playback:', error);
        }
        setSettings(initialSettings);
        await store.set('recording-settings', initialSettings);
        await store.set(FORK_IN_APP_UPDATES_KEY, true);
        await store.save();
        
        if (initialSettings.markerHotkey !== 'none') {
          try {
            await invoke('register_marker_hotkey', { hotkey: initialSettings.markerHotkey });
          } catch (error) {
            console.error('Failed to register hotkey:', error);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    } finally {
      setIsLoading(false);
    }
  }, [store]);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    persistAppTheme(applyAppTheme(settings.appTheme, document.documentElement));
  }, [isLoading, settings.appTheme]);

  const updateSettings = async (newSettings: RecordingSettings) => {
    try {
      if (!store) {
        throw new Error("Settings store is unavailable");
      }

      const oldHotkey = settings.markerHotkey;
      const newHotkey = newSettings.markerHotkey;
      const nextSettings: RecordingSettings = {
        ...newSettings,
        appTheme: normalizeAppTheme(newSettings.appTheme),
      };
      
      if (oldHotkey !== newHotkey) {
        if (oldHotkey !== 'none') {
          await invoke('unregister_marker_hotkey');
        }
        
        if (newHotkey !== 'none') {
          try {
            await invoke('register_marker_hotkey', { hotkey: newHotkey });
          } catch (error) {
            console.error('Failed to register hotkey:', error);
            throw error;
          }
        }
      }
      
      const result = await saveRecordingSettings(
        store,
        nextSettings,
        playbackUnavailable || settings.outputFolder !== nextSettings.outputFolder,
      );
      setSettings(nextSettings);
      setPlaybackUnavailable(result === SettingsSaveResult.PlaybackUnavailable);
      return result;
    } catch (error) {
      console.error('Failed to save settings:', error);
      throw error;
    }
  };

  return (
    <SettingsContext.Provider value={{ settings, isLoading, playbackUnavailable, updateSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (context === undefined) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
}
