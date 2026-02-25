import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AppWindow,
  CheckCircle2,
  HardDrive,
  Keyboard,
  Monitor,
  RefreshCw,
  Settings2,
  Video,
  Volume2,
  XCircle,
} from "lucide-react";
import { useRecording } from "../../contexts/RecordingContext";
import { useSettings } from "../../contexts/SettingsContext";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";
import {
  CaptureSource,
  FrameRate,
  HOTKEY_OPTIONS,
  MAX_STORAGE_GB,
  MarkerHotkey,
  MIN_STORAGE_GB,
  QUALITY_SETTINGS,
  RecordingSettings,
  VideoQuality,
} from "../../types/settings";
import { ReadOnlyPathField } from "./ReadOnlyPathField";
import { SettingsSection } from "./SettingsSection";
import { SettingsSelect, type SettingsSelectOption } from "./SettingsSelect";
import { SettingsToggleField } from "./SettingsToggleField";
import { shallowEqual } from "../../utils/comparison";
import { formatBytes } from "../../utils/format";
import { CaptureWindowInfo } from "../../types/recording";

const VIDEO_QUALITY_OPTIONS: SettingsSelectOption[] = Object.entries(QUALITY_SETTINGS).map(
  ([key, { label }]) => ({ value: key, label }),
);

const FRAME_RATE_OPTIONS: SettingsSelectOption[] = [
  { value: "30", label: "30 FPS" },
  { value: "60", label: "60 FPS" },
];

const MARKER_HOTKEY_OPTIONS: SettingsSelectOption[] = HOTKEY_OPTIONS.map(({ value, label }) => ({
  value,
  label,
}));

const CAPTURE_SOURCE_OPTIONS: SettingsSelectOption[] = [
  { value: "monitor", label: "Primary Monitor" },
  { value: "window", label: "Specific Window" },
];

const FIELD_IDS = {
  videoQuality: "settings-video-quality",
  frameRate: "settings-frame-rate",
  captureSource: "settings-capture-source",
  captureWindow: "settings-capture-window",
  outputFolder: "settings-output-folder",
  maxStorageGB: "settings-max-storage",
  wowFolder: "settings-wow-folder",
  markerHotkey: "settings-marker-hotkey",
  enableSystemAudio: "settings-enable-system-audio",
  enableRecordingDiagnostics: "settings-enable-recording-diagnostics",
  enableAutoRecording: "settings-enable-auto-recording",
};

const NUMBER_FIELD_CLASS_NAME =
  "w-full rounded-md border border-white/20 bg-black/20 px-3 py-2 text-sm text-neutral-100 transition-colors placeholder:text-neutral-400 focus:border-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-black/10 disabled:text-neutral-500";

function formatCaptureWindowLabel(title: string, processName: string | null): string {
  return processName && processName.trim().length > 0 ? `${title} (${processName})` : title;
}

function isStorageLimitWithinBounds(maxStorageGB: number): boolean {
  return maxStorageGB >= MIN_STORAGE_GB && maxStorageGB <= MAX_STORAGE_GB;
}

function isVideoQuality(value: string): value is VideoQuality {
  return Object.prototype.hasOwnProperty.call(QUALITY_SETTINGS, value);
}

function isFrameRate(value: number): value is FrameRate {
  return value === 30 || value === 60;
}

function isMarkerHotkey(value: string): value is MarkerHotkey {
  return HOTKEY_OPTIONS.some((option) => option.value === value);
}

export function Settings() {
  const { settings, updateSettings } = useSettings();
  const { isRecording } = useRecording();
  const [formData, setFormData] = useState<RecordingSettings>(settings);
  const [folderSize, setFolderSize] = useState<number>(0);
  const [isWowFolderValid, setIsWowFolderValid] = useState<boolean>(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [captureWindows, setCaptureWindows] = useState<CaptureWindowInfo[]>([]);
  const [isLoadingCaptureWindows, setIsLoadingCaptureWindows] = useState(false);
  const [captureWindowsError, setCaptureWindowsError] = useState<string | null>(null);

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
    setHasChanges(!shallowEqual(formData, settings));
  }, [formData, settings]);

  const loadCaptureWindows = useCallback(async () => {
    setIsLoadingCaptureWindows(true);
    setCaptureWindowsError(null);

    try {
      const windows = await invoke<CaptureWindowInfo[]>("list_capture_windows");
      setCaptureWindows(windows);
    } catch (error) {
      console.error("Failed to list capturable windows:", error);
      setCaptureWindowsError("Could not list open windows. Try Refresh or restart the app.");
      setCaptureWindows([]);
    } finally {
      setIsLoadingCaptureWindows(false);
    }
  }, []);

  useEffect(() => {
    if (formData.captureSource === "window") {
      loadCaptureWindows();
    }
  }, [formData.captureSource, loadCaptureWindows]);

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
    if (!isStorageLimitWithinBounds(formData.maxStorageGB)) {
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

  const usagePercentage = formData.maxStorageGB > 0 
    ? Math.min(100, (folderSize / (formData.maxStorageGB * 1024 ** 3)) * 100)
    : 0;

  const availableCaptureWindowOptions: SettingsSelectOption[] = useMemo(() => {
    return captureWindows.map(({ hwnd, title, process_name }) => ({
      value: hwnd,
      label: formatCaptureWindowLabel(title, process_name),
    }));
  }, [captureWindows]);

  const isSavedCaptureWindowUnavailable = useMemo(() => {
    return (
      formData.captureSource === "window" &&
      formData.captureWindowHwnd.length > 0 &&
      !availableCaptureWindowOptions.some(({ value }) => value === formData.captureWindowHwnd)
    );
  }, [availableCaptureWindowOptions, formData.captureSource, formData.captureWindowHwnd]);

  const captureWindowOptions: SettingsSelectOption[] = useMemo(() => {
    const nextCaptureWindowOptions = [...availableCaptureWindowOptions];

    if (isSavedCaptureWindowUnavailable) {
      nextCaptureWindowOptions.unshift({
        value: formData.captureWindowHwnd,
        label: formData.captureWindowTitle
          ? `${formData.captureWindowTitle} (Unavailable)`
          : "Previously selected window (Unavailable)",
        disabled: true,
      });
    }

    if (nextCaptureWindowOptions.length === 0) {
      nextCaptureWindowOptions.push({
        value: "",
        label: isLoadingCaptureWindows ? "Loading windows..." : "No capturable windows found",
        disabled: true,
      });
    }

    return nextCaptureWindowOptions;
  }, [
    availableCaptureWindowOptions,
    formData.captureWindowHwnd,
    formData.captureWindowTitle,
    isLoadingCaptureWindows,
    isSavedCaptureWindowUnavailable,
  ]);

  const isCaptureWindowSelectDisabled = useMemo(() => {
    return isLoadingCaptureWindows || captureWindowOptions.every((option) => option.disabled);
  }, [captureWindowOptions, isLoadingCaptureWindows]);

  return (
    <div className="relative flex flex-1 min-h-0 flex-col overflow-hidden bg-(--surface-0)">
      {isRecording && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm">
          <div
            className="max-w-md rounded-sm border border-rose-300/25 bg-(--surface-2) p-8 text-center shadow-(--surface-glow)"
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

      <div className="flex shrink-0 items-center gap-4 border-b border-white/10 bg-(--surface-1) px-4 py-4 md:px-6">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="inline-flex items-center gap-2 text-lg font-semibold text-neutral-100">
              <Settings2 className="h-4 w-4 text-neutral-300" />
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
                <label htmlFor={FIELD_IDS.videoQuality} className="mb-2 block text-sm text-neutral-300">Quality Preset</label>
                <SettingsSelect
                  id={FIELD_IDS.videoQuality}
                  value={formData.videoQuality}
                  options={VIDEO_QUALITY_OPTIONS}
                  onChange={(nextValue) => {
                    if (isVideoQuality(nextValue)) {
                      setFormData({ ...formData, videoQuality: nextValue });
                    }
                  }}
                  ariaDescribedBy="settings-video-quality-help"
                />
                <p id="settings-video-quality-help" className="mt-1 text-xs text-neutral-400">
                  Higher presets increase bitrate and disk usage.
                </p>
              </div>

              <div>
                <label htmlFor={FIELD_IDS.frameRate} className="mb-2 block text-sm text-neutral-300">Frame Rate</label>
                <SettingsSelect
                  id={FIELD_IDS.frameRate}
                  value={String(formData.frameRate)}
                  options={FRAME_RATE_OPTIONS}
                  onChange={(nextValue) => {
                    const nextFrameRate = Number(nextValue);
                    if (isFrameRate(nextFrameRate)) {
                      setFormData({ ...formData, frameRate: nextFrameRate });
                    }
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
                  inputId={FIELD_IDS.outputFolder}
                  label="Output Folder"
                  value={formData.outputFolder}
                  onBrowse={handleBrowseFolder}
                />
                <div className="mt-3 rounded-sm border border-white/10 bg-black/20 p-3">
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

              <FormField
                id={FIELD_IDS.maxStorageGB}
                label="Maximum Storage (GB)"
                description={`Old recordings will be automatically deleted when this limit is reached (minimum ${MIN_STORAGE_GB} GB)`}
              >
                <input
                  id={FIELD_IDS.maxStorageGB}
                  type="number"
                  min={MIN_STORAGE_GB}
                  max={MAX_STORAGE_GB}
                  value={formData.maxStorageGB}
                  onChange={(e) => setFormData({ ...formData, maxStorageGB: parseInt(e.target.value) || MIN_STORAGE_GB })}
                  className={NUMBER_FIELD_CLASS_NAME}
                />
              </FormField>
            </div>
          </SettingsSection>

          <SettingsSection title="Capture" icon={<Monitor className="h-4 w-4" />}>
            <div className="space-y-4">
              <div>
                <label htmlFor={FIELD_IDS.captureSource} className="mb-2 inline-flex items-center gap-1.5 text-sm text-neutral-300">
                  <AppWindow className="h-3.5 w-3.5" />
                  Capture Source
                </label>
                <SettingsSelect
                  id={FIELD_IDS.captureSource}
                  value={formData.captureSource}
                  options={CAPTURE_SOURCE_OPTIONS}
                  onChange={(nextValue) => {
                    setFormData({
                      ...formData,
                      captureSource: nextValue as CaptureSource,
                    });
                  }}
                  ariaDescribedBy="settings-capture-source-help"
                />
                <p id="settings-capture-source-help" className="mt-1 text-xs text-neutral-400">
                  Choose whether FloorPoV captures your primary monitor or one specific window.
                </p>
              </div>

              {formData.captureSource === "window" && (
                <div className="space-y-2 rounded-sm border border-white/15 bg-black/20 p-3">
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <label htmlFor={FIELD_IDS.captureWindow} className="mb-2 block text-sm text-neutral-300">
                        Window
                      </label>
                      <SettingsSelect
                        id={FIELD_IDS.captureWindow}
                        value={formData.captureWindowHwnd}
                        options={captureWindowOptions}
                        placeholder="Select a window"
                        disabled={isCaptureWindowSelectDisabled}
                        onChange={(nextValue) => {
                          const selectedWindow = captureWindows.find((window) => window.hwnd === nextValue);
                          setFormData({
                            ...formData,
                            captureWindowHwnd: nextValue,
                            captureWindowTitle: selectedWindow?.title ?? "",
                          });
                        }}
                        ariaDescribedBy="settings-capture-window-help"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={loadCaptureWindows}
                      disabled={isLoadingCaptureWindows}
                      className="inline-flex h-9 items-center justify-center gap-2 rounded-sm border border-white/20 bg-white/6 px-3 text-sm text-neutral-100 transition-colors hover:bg-white/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <RefreshCw className={`h-4 w-4 ${isLoadingCaptureWindows ? "animate-spin" : ""}`} />
                      Refresh
                    </button>
                  </div>

                  <p id="settings-capture-window-help" className="text-xs text-neutral-400">
                    Select a visible top-level window. Minimized windows can produce black frames until restored.
                  </p>

                  {isSavedCaptureWindowUnavailable && (
                    <p className="inline-flex items-center gap-1.5 text-xs text-amber-200">
                      <XCircle className="h-3.5 w-3.5" />
                      Your previously selected window is unavailable.
                    </p>
                  )}

                  {captureWindowsError && (
                    <p className="inline-flex items-center gap-1.5 text-xs text-rose-300">
                      <XCircle className="h-3.5 w-3.5" />
                      {captureWindowsError}
                    </p>
                  )}
                </div>
              )}

              {formData.captureSource === "monitor" && (
                <p className="text-sm text-neutral-300">
                  Capture records your primary monitor using the FFmpeg desktop duplication pipeline.
                </p>
              )}

              <div className="rounded-sm border border-white/10 bg-black/10 p-3 mt-4">
                <p className="mb-2 text-xs uppercase tracking-[0.08em] text-neutral-600">Troubleshooting</p>
                <SettingsToggleField
                  id={FIELD_IDS.enableRecordingDiagnostics}
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
              <SettingsToggleField
                id={FIELD_IDS.enableAutoRecording}
                checked={formData.enableAutoRecording}
                onChange={(checked) => {
                  setFormData({
                    ...formData,
                    enableAutoRecording: checked,
                  });
                }}
                label="Enable Auto Recording"
                description="Arms combat-log triggers and starts recordings on M+, raid, or PvP start events."
              />

              <div>
                <ReadOnlyPathField
                  inputId={FIELD_IDS.wowFolder}
                  label="WoW Folder"
                  value={formData.wowFolder}
                  onBrowse={handleBrowseWowFolder}
                />
                <p className="mt-2 text-xs text-neutral-400">
                  Select your WoW client folder. FloorPoV looks for{" "}
                  <span className="font-mono">Logs\WoWCombatLog*.txt</span> (for example{" "}
                  <span className="font-mono">WoWCombatLog-021726_124240.txt</span>).
                </p>
                {formData.wowFolder && isWowFolderValid && (
                  <p className="mt-2 inline-flex items-center gap-1.5 rounded-sm border border-emerald-300/30 bg-emerald-500/12 px-2 py-1 text-xs text-emerald-100">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
                    Combat log found!
                  </p>
                )}
                {formData.wowFolder && !isWowFolderValid && (
                  <p className="mt-2 inline-flex items-center gap-1.5 rounded-sm border border-rose-300/30 bg-rose-500/12 px-2 py-1 text-xs text-rose-200">
                    <XCircle className="h-3.5 w-3.5 text-rose-300" />
                    Could not find any logs this folder.
                  </p>
                )}
              </div>
            </div>
          </SettingsSection>

          <SettingsSection title="Hotkeys" icon={<Keyboard className="h-4 w-4" />}>
            <div className="space-y-4">
              <div>
                <label htmlFor={FIELD_IDS.markerHotkey} className="mb-2 block text-sm text-neutral-300">Manual Marker Hotkey</label>
                <SettingsSelect
                  id={FIELD_IDS.markerHotkey}
                  value={formData.markerHotkey}
                  options={MARKER_HOTKEY_OPTIONS}
                  onChange={(nextValue) => {
                    if (isMarkerHotkey(nextValue)) {
                      setFormData({ ...formData, markerHotkey: nextValue });
                    }
                  }}
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
                id={FIELD_IDS.enableSystemAudio}
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

      <div className="flex shrink-0 flex-wrap justify-end gap-3 border-t border-white/10 bg-(--surface-1) px-4 py-4 md:px-6">
        <Button
          variant="secondary"
          onClick={handleCancel}
          disabled={!hasChanges}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={!hasChanges}
        >
          Save Changes
        </Button>
      </div>
    </div>
  );
}
