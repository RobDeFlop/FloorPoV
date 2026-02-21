import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { Store } from '@tauri-apps/plugin-store';
import { invoke } from '@tauri-apps/api/core';
import { RecordingSettings, DEFAULT_SETTINGS } from '../types/settings';

interface SettingsContextType {
  settings: RecordingSettings;
  isLoading: boolean;
  updateSettings: (newSettings: RecordingSettings) => Promise<void>;
  resetToDefaults: () => void;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<RecordingSettings>(DEFAULT_SETTINGS);
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
        };

        if (!mergedSettings.outputFolder) {
          const defaultFolder = await invoke<string>('get_default_output_folder');
          mergedSettings.outputFolder = defaultFolder;
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
        setSettings(initialSettings);
        await store.set('recording-settings', initialSettings);
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

  const updateSettings = async (newSettings: RecordingSettings) => {
    if (!store) return;
    
    try {
      const oldHotkey = settings.markerHotkey;
      const newHotkey = newSettings.markerHotkey;
      
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
      
      await store.set('recording-settings', newSettings);
      await store.save();
      setSettings(newSettings);
    } catch (error) {
      console.error('Failed to save settings:', error);
      throw error;
    }
  };

  const resetToDefaults = () => {
    setSettings(DEFAULT_SETTINGS);
  };

  return (
    <SettingsContext.Provider value={{ settings, isLoading, updateSettings, resetToDefaults }}>
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
