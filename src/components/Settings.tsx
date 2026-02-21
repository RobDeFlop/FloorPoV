import { useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { ArrowLeft, Folder } from 'lucide-react';
import { useSettings } from '../contexts/SettingsContext';
import { useRecording } from '../contexts/RecordingContext';
import { RecordingSettings, QUALITY_SETTINGS, MIN_STORAGE_GB, MAX_STORAGE_GB, HOTKEY_OPTIONS } from '../types/settings';

interface SettingsProps {
  onBack: () => void;
}

export function Settings({ onBack }: SettingsProps) {
  const { settings, updateSettings } = useSettings();
  const { isRecording } = useRecording();
  const [formData, setFormData] = useState<RecordingSettings>(settings);
  const [folderSize, setFolderSize] = useState<number>(0);
  const [isWowFolderValid, setIsWowFolderValid] = useState<boolean>(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    setFormData(settings);
  }, [settings]);

  useEffect(() => {
    if (formData.outputFolder) {
      loadFolderSize();
    }
  }, [formData.outputFolder]);

  useEffect(() => {
    let isMounted = true;

    const validateWowFolder = async () => {
      if (!formData.wowFolder) {
        if (isMounted) {
          setIsWowFolderValid(false);
        }
        return;
      }

      try {
        const isValid = await invoke<boolean>('validate_wow_folder', {
          path: formData.wowFolder,
        });

        if (isMounted) {
          setIsWowFolderValid(isValid);
        }
      } catch (error) {
        if (isMounted) {
          setIsWowFolderValid(false);
        }
        console.error('Failed to validate WoW folder:', error);
      }
    };

    validateWowFolder();

    return () => {
      isMounted = false;
    };
  }, [formData.wowFolder]);

  useEffect(() => {
    setHasChanges(JSON.stringify(formData) !== JSON.stringify(settings));
  }, [formData, settings]);

  const loadFolderSize = async () => {
    try {
      const size = await invoke<number>('get_folder_size', { 
        path: formData.outputFolder 
      });
      setFolderSize(size);
    } catch (error) {
      console.error('Failed to get folder size:', error);
    }
  };

  const handleBrowseFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: formData.outputFolder,
      });
      
      if (selected && typeof selected === 'string') {
        setFormData({ ...formData, outputFolder: selected });
      }
    } catch (error) {
      console.error('Failed to open folder picker:', error);
    }
  };

  const handleSave = async () => {
    if (formData.maxStorageGB < MIN_STORAGE_GB) {
      return;
    }
    
    if (formData.maxStorageGB > MAX_STORAGE_GB) {
      return;
    }

    try {
      await updateSettings(formData);
      setHasChanges(false);
    } catch (error) {
      // Error already logged in context
    }
  };

  const handleCancel = () => {
    setFormData(settings);
    setHasChanges(false);
  };

  const handleBrowseWowFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: formData.wowFolder || formData.outputFolder,
      });

      if (selected && typeof selected === 'string') {
        setFormData({ ...formData, wowFolder: selected });
      }
    } catch (error) {
      console.error('Failed to open WoW folder picker:', error);
    }
  };

  const formatBytes = (bytes: number) => {
    const gb = bytes / (1024 ** 3);
    return gb.toFixed(2) + ' GB';
  };

  const usagePercentage = formData.maxStorageGB > 0 
    ? Math.min(100, (folderSize / (formData.maxStorageGB * 1024 ** 3)) * 100)
    : 0;

  return (
    <div className="flex-1 min-h-0 overflow-hidden flex flex-col bg-neutral-950 relative">
      {isRecording && (
        <div className="absolute inset-0 bg-neutral-950/90 z-50 flex items-center justify-center">
          <div className="bg-neutral-900 border border-neutral-700 rounded-lg p-8 max-w-md text-center">
            <div className="w-12 h-12 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
            </div>
            <h2 className="text-xl font-semibold mb-2">Recording in Progress</h2>
            <p className="text-neutral-400">
              Stop recording to change settings
            </p>
          </div>
        </div>
      )}

      <div className="shrink-0 px-6 py-4 border-b border-neutral-800/80 flex items-center gap-4">
        <button
          onClick={onBack}
          className="p-2 rounded hover:bg-neutral-800 transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-xl font-semibold">Settings</h1>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6 pb-10">
        <div className="max-w-2xl space-y-8">
          
          <section>
            <h2 className="text-lg font-medium mb-4">Video Settings</h2>
            <div className="space-y-4">
              
              <div>
                <label className="block text-sm font-medium mb-2">Video Quality</label>
                <select
                  value={formData.videoQuality}
                  onChange={(e) => setFormData({ ...formData, videoQuality: e.target.value as any })}
                  className="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 rounded focus:outline-none focus:ring-2 focus:ring-emerald-400"
                >
                  {Object.entries(QUALITY_SETTINGS).map(([key, { label }]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
                <p className="text-xs text-neutral-500 mt-1">
                  Higher quality uses more disk space
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Frame Rate</label>
                <select
                  value={formData.frameRate}
                  onChange={(e) => setFormData({ ...formData, frameRate: parseInt(e.target.value) as any })}
                  className="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 rounded focus:outline-none focus:ring-2 focus:ring-emerald-400"
                >
                  <option value={30}>30 FPS</option>
                  <option value={60}>60 FPS</option>
                </select>
              </div>

            </div>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-4">Output Settings</h2>
            <div className="space-y-4">
              
              <div>
                <label className="block text-sm font-medium mb-2">Output Folder</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={formData.outputFolder}
                    readOnly
                    className="flex-1 px-3 py-2 bg-neutral-900 border border-neutral-700 rounded text-neutral-400"
                  />
                  <button
                    onClick={handleBrowseFolder}
                    className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 rounded transition-colors flex items-center gap-2 border border-neutral-700"
                  >
                    <Folder className="w-4 h-4" />
                    Browse
                  </button>
                </div>
                <p className="text-xs text-neutral-500 mt-1">
                  Current usage: {formatBytes(folderSize)} / {formData.maxStorageGB} GB ({usagePercentage.toFixed(0)}%)
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">
                  Maximum Storage (GB)
                </label>
                <input
                  type="number"
                  min={MIN_STORAGE_GB}
                  max={MAX_STORAGE_GB}
                  value={formData.maxStorageGB}
                  onChange={(e) => setFormData({ ...formData, maxStorageGB: parseInt(e.target.value) || MIN_STORAGE_GB })}
                  className="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 rounded focus:outline-none focus:ring-2 focus:ring-emerald-400"
                />
                <p className="text-xs text-neutral-500 mt-1">
                  Old recordings will be automatically deleted when this limit is reached (minimum {MIN_STORAGE_GB} GB)
                </p>
              </div>

            </div>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-4">Capture Settings</h2>
            <div className="space-y-4">
              
              <div>
                <label className="block text-sm font-medium mb-2">Capture Source</label>
                <select
                  value={formData.captureSource}
                  onChange={(e) => setFormData({ ...formData, captureSource: e.target.value as any })}
                  className="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 rounded focus:outline-none focus:ring-2 focus:ring-emerald-400"
                >
                  <option value="primary-monitor">Primary Monitor</option>
                  <option value="window" disabled>Specific Window (Coming Soon)</option>
                </select>
              </div>

            </div>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-4">Combat Log</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">WoW Folder</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={formData.wowFolder}
                    readOnly
                    className="flex-1 px-3 py-2 bg-neutral-900 border border-neutral-700 rounded text-neutral-400"
                  />
                  <button
                    onClick={handleBrowseWowFolder}
                    className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 rounded transition-colors flex items-center gap-2 border border-neutral-700"
                  >
                    <Folder className="w-4 h-4" />
                    Browse
                  </button>
                </div>
                {!formData.wowFolder && (
                  <p className="text-xs text-neutral-500 mt-1">
                    Select your WoW installation folder. Floorpov reads combat events from Logs/WoWCombatLog.txt.
                  </p>
                )}
                {formData.wowFolder && isWowFolderValid && (
                  <p className="text-xs text-emerald-400 mt-1">
                    Combat log found at Logs/WoWCombatLog.txt.
                  </p>
                )}
                {formData.wowFolder && !isWowFolderValid && (
                  <p className="text-xs text-red-400 mt-1">
                    Could not find Logs/WoWCombatLog.txt in this folder.
                  </p>
                )}
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-4">Hotkeys</h2>
            <div className="space-y-4">
              
              <div>
                <label className="block text-sm font-medium mb-2">Manual Marker Hotkey</label>
                <select
                  value={formData.markerHotkey}
                  onChange={(e) => setFormData({ ...formData, markerHotkey: e.target.value as any })}
                  className="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 rounded focus:outline-none focus:ring-2 focus:ring-emerald-400"
                >
                  {HOTKEY_OPTIONS.map(({ value, label }) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                <p className="text-xs text-neutral-500 mt-1">
                  Press this key during recording to add a manual marker. If the key is already in use by another application, try a different one.
                </p>
              </div>

            </div>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-4">Audio Settings</h2>
            <div className="space-y-4 opacity-50">
              <p className="text-sm text-neutral-500">Audio recording will be available in Phase 4</p>
              
              <label className="flex items-center gap-3 cursor-not-allowed">
                <input
                  type="checkbox"
                  disabled
                  checked={formData.enableSystemAudio}
                  className="w-4 h-4"
                />
                <span className="text-sm">Enable System Audio</span>
              </label>

              <label className="flex items-center gap-3 cursor-not-allowed">
                <input
                  type="checkbox"
                  disabled
                  checked={formData.enableMicrophone}
                  className="w-4 h-4"
                />
                <span className="text-sm">Enable Microphone</span>
              </label>
            </div>
          </section>

        </div>
      </div>

      <div className="shrink-0 px-6 py-4 border-t border-neutral-800/80 flex justify-end gap-3">
        <button
          onClick={handleCancel}
          disabled={!hasChanges}
          className="px-4 py-2 rounded text-sm font-medium transition-colors bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!hasChanges}
          className="px-4 py-2 rounded text-sm font-medium transition-colors bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Save Changes
        </button>
      </div>
    </div>
  );
}
