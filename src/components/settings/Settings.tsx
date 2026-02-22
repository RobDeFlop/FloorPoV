import { useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft,
  CheckCircle2,
  HardDrive,
  Keyboard,
  Monitor,
  Settings2,
  Video,
  Volume2,
  XCircle,
} from "lucide-react";
import { useSettings } from "../../contexts/SettingsContext";
import { useRecording } from "../../contexts/RecordingContext";
import {
  RecordingSettings,
  QUALITY_SETTINGS,
  MIN_STORAGE_GB,
  MAX_STORAGE_GB,
  HOTKEY_OPTIONS,
} from "../../types/settings";
import { ReadOnlyPathField } from "./ReadOnlyPathField";
import { SettingsSelect, type SettingsSelectOption } from "./SettingsSelect";
import { SettingsSection } from "./SettingsSection";
import { SettingsToggleField } from "./SettingsToggleField";

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
      const size = await invoke<number>("get_folder_size", {
        path: formData.outputFolder,
      });
      setFolderSize(size);
    } catch (error) {
      console.error("Failed to get folder size:", error);
    }
  };

  const handleBrowseFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: formData.outputFolder,
      });
      
        if (selected && typeof selected === "string") {
          setFormData({ ...formData, outputFolder: selected });
        }
    } catch (error) {
      console.error("Failed to open folder picker:", error);
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

        if (selected && typeof selected === "string") {
          setFormData({ ...formData, wowFolder: selected });
        }
    } catch (error) {
      console.error("Failed to open WoW folder picker:", error);
    }
  };

  const formatBytes = (bytes: number) => {
    const gb = bytes / (1024 ** 3);
    return gb.toFixed(2) + " GB";
  };

  const usagePercentage = formData.maxStorageGB > 0 
    ? Math.min(100, (folderSize / (formData.maxStorageGB * 1024 ** 3)) * 100)
    : 0;

  const fieldClassName =
    "w-full rounded-md border border-emerald-300/20 bg-black/20 px-3 py-2 text-sm text-neutral-100 transition-colors placeholder:text-neutral-400 focus:border-emerald-300/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/45 disabled:cursor-not-allowed disabled:border-emerald-300/10 disabled:bg-black/10 disabled:text-neutral-500";
  const videoQualityOptions: SettingsSelectOption[] = Object.entries(QUALITY_SETTINGS).map(
    ([key, { label }]) => ({ value: key, label }),
  );
  const frameRateOptions: SettingsSelectOption[] = [
    { value: "30", label: "30 FPS" },
    { value: "60", label: "60 FPS" },
  ];
  const markerHotkeyOptions: SettingsSelectOption[] = HOTKEY_OPTIONS.map(({ value, label }) => ({
    value,
    label,
  }));
  const fieldIds = {
    videoQuality: 'settings-video-quality',
    frameRate: 'settings-frame-rate',
    outputFolder: 'settings-output-folder',
    maxStorageGB: 'settings-max-storage',
    wowFolder: 'settings-wow-folder',
    markerHotkey: 'settings-marker-hotkey',
    enableSystemAudio: 'settings-enable-system-audio',
    enableRecordingDiagnostics: 'settings-enable-recording-diagnostics',
  };

  return (
    <div className="relative flex flex-1 min-h-0 flex-col overflow-hidden bg-[var(--surface-0)]">
      {isRecording && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm">
          <div
            className="max-w-md rounded-[var(--radius-md)] border border-rose-300/25 bg-[var(--surface-2)] p-8 text-center shadow-[var(--surface-glow)]"
            role="status"
            aria-live="polite"
          >
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/15">
              <Settings2 className="h-5 w-5 text-amber-200" aria-hidden="true" />
            </div>
            <h2 className="mb-2 text-lg font-semibold text-neutral-100">Settings are temporarily locked</h2>
            <p className="text-sm text-neutral-300">
              Stop recording from Home to edit settings. Current recording status remains in App Status.
            </p>
          </div>
        </div>
      )}

      <div className="flex shrink-0 items-center gap-4 border-b border-emerald-300/10 bg-[var(--surface-1)] px-4 py-4 md:px-6">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-emerald-300/20 bg-black/20 text-neutral-200 transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60"
            aria-label="Back to main view"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="inline-flex items-center gap-2 text-lg font-semibold text-neutral-100">
              <Settings2 className="h-4 w-4 text-emerald-300" />
              Settings
            </h1>
            <p className="text-xs uppercase tracking-[0.12em] text-neutral-500">Capture and recording configuration</p>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-6 pb-10 md:px-6">
        <div className="mx-auto w-full max-w-6xl space-y-4">
          <SettingsSection title="Video" icon={<Video className="h-4 w-4" />}>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label htmlFor={fieldIds.videoQuality} className="mb-2 block text-sm text-neutral-300">Quality Preset</label>
                <SettingsSelect
                  id={fieldIds.videoQuality}
                  value={formData.videoQuality}
                  options={videoQualityOptions}
                  onChange={(nextValue) => setFormData({ ...formData, videoQuality: nextValue as any })}
                  ariaDescribedBy="settings-video-quality-help"
                />
                <p id="settings-video-quality-help" className="mt-1 text-xs text-neutral-400">
                  Higher presets increase bitrate and disk usage.
                </p>
              </div>

              <div>
                <label htmlFor={fieldIds.frameRate} className="mb-2 block text-sm text-neutral-300">Frame Rate</label>
                <SettingsSelect
                  id={fieldIds.frameRate}
                  value={String(formData.frameRate)}
                  options={frameRateOptions}
                  onChange={(nextValue) => {
                    setFormData({ ...formData, frameRate: parseInt(nextValue) as any });
                  }}
                />
                <p className="mt-1 text-xs text-neutral-400">
                  This is your target capture rate.
                </p>
              </div>

            </div>
          </SettingsSection>

          <SettingsSection title="Output" icon={<HardDrive className="h-4 w-4" />}>
            <div className="space-y-4">
              <div>
                <ReadOnlyPathField
                  inputId={fieldIds.outputFolder}
                  label="Output Folder"
                  value={formData.outputFolder}
                  onBrowse={handleBrowseFolder}
                />
                <div className="mt-3 rounded-md border border-emerald-300/10 bg-black/20 p-3">
                  <div className="mb-2 flex items-center justify-between text-xs text-neutral-300">
                    <span>Current usage</span>
                    <span className="font-mono text-neutral-200">
                      {formatBytes(folderSize)} / {formData.maxStorageGB} GB ({usagePercentage.toFixed(0)}%)
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-neutral-800">
                    <div
                      className="h-full rounded-full bg-emerald-400/80"
                      style={{ width: `${usagePercentage}%` }}
                    />
                  </div>
                </div>
              </div>

              <div>
                <label htmlFor={fieldIds.maxStorageGB} className="mb-2 block text-sm text-neutral-300">
                  Maximum Storage (GB)
                </label>
                <input
                  id={fieldIds.maxStorageGB}
                  type="number"
                  min={MIN_STORAGE_GB}
                  max={MAX_STORAGE_GB}
                  value={formData.maxStorageGB}
                  onChange={(e) => setFormData({ ...formData, maxStorageGB: parseInt(e.target.value) || MIN_STORAGE_GB })}
                  className={fieldClassName}
                  aria-describedby="settings-max-storage-help"
                />
                <p id="settings-max-storage-help" className="mt-1 text-xs text-neutral-400">
                  Old recordings will be automatically deleted when this limit is reached (minimum {MIN_STORAGE_GB} GB)
                </p>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection title="Capture" icon={<Monitor className="h-4 w-4" />}>
            <div className="space-y-4">
              <p className="text-sm text-neutral-300">
                Capture uses the FFmpeg pipeline and records your primary monitor.
              </p>
              <div className="rounded-md border border-emerald-300/15 bg-black/20 p-3">
                <p className="mb-2 text-xs uppercase tracking-[0.08em] text-neutral-500">Troubleshooting</p>
                <SettingsToggleField
                  id={fieldIds.enableRecordingDiagnostics}
                  checked={formData.enableRecordingDiagnostics}
                  onChange={(checked) => {
                    setFormData({
                      ...formData,
                      enableRecordingDiagnostics: checked,
                    });
                  }}
                  label="Enable Recording Diagnostics"
                  description="Writes per-second audio and FFmpeg pacing logs to help debug stutter and crackle."
                />
              </div>
            </div>
          </SettingsSection>

          <SettingsSection title="Combat Log" icon={<CheckCircle2 className="h-4 w-4" />}>
            <div className="space-y-4">
              <div>
                <ReadOnlyPathField
                  inputId={fieldIds.wowFolder}
                  label="WoW Folder"
                  value={formData.wowFolder}
                  onBrowse={handleBrowseWowFolder}
                />
                {!formData.wowFolder && (
                  <p className="mt-2 text-xs text-neutral-400">
                    Select your WoW installation folder. Floorpov reads combat events from Logs/WoWCombatLog.txt.
                  </p>
                )}
                {formData.wowFolder && isWowFolderValid && (
                  <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-emerald-300">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Combat log found at Logs/WoWCombatLog.txt.
                  </p>
                )}
                {formData.wowFolder && !isWowFolderValid && (
                  <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-rose-300">
                    <XCircle className="h-3.5 w-3.5" />
                    Could not find Logs/WoWCombatLog.txt in this folder.
                  </p>
                )}
              </div>
            </div>
          </SettingsSection>

          <SettingsSection title="Hotkeys" icon={<Keyboard className="h-4 w-4" />}>
            <div className="space-y-4">
              <div>
                <label htmlFor={fieldIds.markerHotkey} className="mb-2 block text-sm text-neutral-300">Manual Marker Hotkey</label>
                <SettingsSelect
                  id={fieldIds.markerHotkey}
                  value={formData.markerHotkey}
                  options={markerHotkeyOptions}
                  onChange={(nextValue) => setFormData({ ...formData, markerHotkey: nextValue as any })}
                  ariaDescribedBy="settings-marker-hotkey-help"
                />
                <p id="settings-marker-hotkey-help" className="mt-1 text-xs text-neutral-400">
                  Press this key during recording to add a manual marker. If the key is already in use by another application, try a different one.
                </p>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection
            title="Audio"
            icon={<Volume2 className="h-4 w-4" />}
          >
            <div className="space-y-4">
              <p className="text-sm text-neutral-400">
                System audio recording is available in the FFmpeg recorder pipeline.
              </p>

              <SettingsToggleField
                id={fieldIds.enableSystemAudio}
                checked={formData.enableSystemAudio}
                onChange={(checked) => {
                  setFormData({
                    ...formData,
                    enableSystemAudio: checked,
                  });
                }}
                label="Enable System Audio"
              />
            </div>
          </SettingsSection>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap justify-end gap-3 border-t border-emerald-300/10 bg-[var(--surface-1)] px-4 py-4 md:px-6">
        <button
          type="button"
          onClick={handleCancel}
          disabled={!hasChanges}
          className="rounded-md border border-emerald-300/20 bg-black/20 px-4 py-2 text-sm font-medium text-neutral-200 transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!hasChanges}
          className="rounded-md border border-emerald-300/35 bg-emerald-500/20 px-4 py-2 text-sm font-semibold text-emerald-100 transition-colors hover:bg-emerald-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Save Changes
        </button>
      </div>
    </div>
  );
}
