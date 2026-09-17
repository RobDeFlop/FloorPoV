import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { motion, useReducedMotion } from "motion/react";
import {
  AlertTriangle,
  AppWindow,
  CheckCircle2,
  ChevronDown,
  HardDrive,
  Keyboard,
  Monitor,
  RefreshCw,
  Settings2,
  Swords,
  Video,
  Volume2,
  XCircle,
} from "lucide-react";
import { useRecording } from "../../contexts/RecordingContext";
import { smoothTransition } from "../../lib/motion";
import { useSettings } from "../../contexts/SettingsContext";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { FormField } from "../ui/FormField";
import {
  CaptureSource,
  FrameRate,
  HOTKEY_OPTIONS,
  MAX_AUTO_RAID_RECORDING_SECONDS,
  MAX_STORAGE_GB,
  MarkerHotkey,
  MIN_AUTO_RAID_RECORDING_SECONDS,
  MIN_STORAGE_GB,
  QUALITY_SETTINGS,
  RecordingSettings,
  VideoEncoderPreference,
  VideoQuality,
} from "../../types/settings";
import { ReadOnlyPathField } from "./ReadOnlyPathField";
import { SettingsSection } from "./SettingsSection";
import { SettingsSelect, type SettingsSelectOption } from "./SettingsSelect";
import { useModalFocus } from "../../hooks/useModalFocus";
import { SettingsToggleField } from "./SettingsToggleField";
import { shallowEqual } from "../../utils/comparison";
import { formatBytes } from "../../utils/format";
import { AvailableVideoEncoder, CaptureWindowInfo } from "../../types/recording";
import { type AppView } from "../../types/ui";

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
  { value: "monitor", label: "Primary monitor" },
  { value: "window", label: "Specific window" },
];

const VIDEO_ENCODER_PREFERENCE_VALUES: VideoEncoderPreference[] = [
  "auto",
  "h264_nvenc",
  "h264_qsv",
  "h264_amf",
  "libx264",
];

const FIELD_IDS = {
  videoQuality: "settings-video-quality",
  videoEncoderPreference: "settings-video-encoder-preference",
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
  minAutoRaidRecordingSeconds: "settings-min-auto-raid-recording-seconds",
  enableAutoUpdate: "settings-enable-auto-update",
};



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

function isVideoEncoderPreference(value: string): value is VideoEncoderPreference {
  return VIDEO_ENCODER_PREFERENCE_VALUES.includes(value as VideoEncoderPreference);
}

function isMarkerHotkey(value: string): value is MarkerHotkey {
  return HOTKEY_OPTIONS.some((option) => option.value === value);
}

export type SettingsGroupId = "recording" | "storage" | "wow" | "controls" | "app";

interface SettingsGroupProps {
  contentId: string;
  description: string;
  icon: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}

function SettingsGroup({
  contentId,
  description,
  icon,
  open,
  onOpenChange,
  title,
  children,
}: SettingsGroupProps) {
  const reduceMotion = useReducedMotion();

  return (
    <section
      className={`overflow-hidden rounded-sm border bg-(--surface-1)/80 transition-colors duration-150 motion-reduce:transition-none ${
        open ? "border-emerald-300/25" : "border-white/10"
      }`}
    >
      <button
        type="button"
        aria-controls={contentId}
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className={`flex min-h-16 w-full cursor-pointer items-center gap-3 border-l-2 border-transparent px-4 py-3 text-left transition-colors duration-150 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-300/60 motion-reduce:transition-none ${
          open ? "border-l-emerald-300/70 bg-white/[0.04]" : ""
        }`}
      >
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-white/5 text-neutral-300 transition-colors motion-reduce:transition-none ${
            open ? "bg-emerald-300/10 text-emerald-200" : ""
          }`}
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-neutral-100">{title}</span>
          <span className="mt-0.5 block text-xs text-neutral-500">{description}</span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-neutral-400 transition-transform duration-150 motion-reduce:transition-none ${
            open ? "rotate-180 text-emerald-200" : ""
          }`}
          aria-hidden="true"
        />
      </button>
      <motion.div
        className="overflow-hidden"
        initial={false}
        animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
        transition={reduceMotion ? { duration: 0 } : smoothTransition}
        aria-hidden={!open}
        inert={!open}
      >
        <div id={contentId} className="space-y-6 border-t border-white/10 px-4 pb-4 pt-4">
          {children}
        </div>
      </motion.div>
    </section>
  );
}

interface SettingsProps {
  navigationRequest: AppView | null;
  openGroups: Record<SettingsGroupId, boolean>;
  onDirtyChange: (hasChanges: boolean) => void;
  onGroupToggle: (groupId: SettingsGroupId, open: boolean) => void;
  onNavigationHandled: () => void;
  onNavigateWithoutGuard: (view: AppView) => void;
}

export function Settings({
  navigationRequest,
  openGroups,
  onDirtyChange,
  onGroupToggle,
  onNavigationHandled,
  onNavigateWithoutGuard,
}: SettingsProps) {
  const { settings, updateSettings } = useSettings();
  const { isRecording, isSelectedWindowAlive } = useRecording();
  const [formData, setFormData] = useState<RecordingSettings>(settings);
  const [folderSize, setFolderSize] = useState<number>(0);
  const [isWowFolderValid, setIsWowFolderValid] = useState<boolean>(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [isLeaveDialogOpen, setIsLeaveDialogOpen] = useState(false);
  const leaveDialogRef = useRef<HTMLDivElement>(null);
  const cancelLeaveButtonRef = useRef<HTMLButtonElement>(null);
  const [captureWindows, setCaptureWindows] = useState<CaptureWindowInfo[]>([]);
  const [isLoadingCaptureWindows, setIsLoadingCaptureWindows] = useState(false);
  const [captureWindowsError, setCaptureWindowsError] = useState<string | null>(null);
  const [videoEncoderOptions, setVideoEncoderOptions] = useState<SettingsSelectOption[]>([
    { value: "auto", label: "Auto (recommended)" },
  ]);
  const [isLoadingVideoEncoders, setIsLoadingVideoEncoders] = useState(false);
  const [videoEncodersError, setVideoEncodersError] = useState<string | null>(null);

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

  useEffect(() => {
    onDirtyChange(hasChanges);
  }, [hasChanges, onDirtyChange]);

  useEffect(() => {
    if (!navigationRequest) {
      return;
    }

    if (hasChanges) {
      setIsLeaveDialogOpen(true);
      return;
    }

    onNavigateWithoutGuard(navigationRequest);
  }, [hasChanges, navigationRequest, onNavigateWithoutGuard]);

  const loadCaptureWindows = useCallback(async () => {
    setIsLoadingCaptureWindows(true);
    setCaptureWindowsError(null);

    try {
      const windows = await invoke<CaptureWindowInfo[]>("list_capture_windows");
      setCaptureWindows(windows);

      // If the saved HWND is stale but a window with the same title is now running
      // (e.g. the game was restarted and got a new HWND), silently recover to the new
      // HWND. This mirrors what the Rust backend does at recording time.
      setFormData((prev) => {
        if (
          prev.captureSource !== "window" ||
          !prev.captureWindowHwnd ||
          windows.some((w) => w.hwnd === prev.captureWindowHwnd)
        ) {
          return prev;
        }

        const titleMatch = prev.captureWindowTitle
          ? windows.find((w) => w.title === prev.captureWindowTitle)
          : null;

        return titleMatch
          ? { ...prev, captureWindowHwnd: titleMatch.hwnd }
          : prev;
      });
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

  const loadAvailableVideoEncoders = useCallback(async () => {
    setIsLoadingVideoEncoders(true);
    setVideoEncodersError(null);

    try {
      const encoders = await invoke<AvailableVideoEncoder[]>("get_available_video_encoders");
      if (encoders.length === 0) {
        setVideoEncoderOptions([{ value: "auto", label: "Auto (recommended)" }]);
        return;
      }

      setVideoEncoderOptions(
        encoders.map((encoder) => ({
          value: encoder.value,
          label: encoder.label,
        })),
      );

      setFormData((prev) => {
        const currentIsAvailable = encoders.some((encoder) => encoder.value === prev.videoEncoderPreference);
        return currentIsAvailable ? prev : { ...prev, videoEncoderPreference: "auto" };
      });
    } catch (error) {
      console.error("Failed to list available video encoders:", error);
      setVideoEncodersError("Could not detect video encoders. Auto fallback will still work.");
      setVideoEncoderOptions([{ value: "auto", label: "Auto (recommended)" }]);
    } finally {
      setIsLoadingVideoEncoders(false);
    }
  }, []);

  useEffect(() => {
    loadAvailableVideoEncoders();
  }, [loadAvailableVideoEncoders]);

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

  const handleSave = async (): Promise<boolean> => {
    if (!isStorageLimitWithinBounds(formData.maxStorageGB)) {
      return false;
    }

    try {
      await updateSettings(formData);
      setHasChanges(false);
      return true;
    } catch (error) {
      // Error already logged in context
      return false;
    }
  };

  const handleCancel = () => {
    setFormData(settings);
    setHasChanges(false);
  };

  const handleCancelNavigation = () => {
    setIsLeaveDialogOpen(false);
    onNavigationHandled();
  };

  const handleDiscardAndLeave = () => {
    if (!navigationRequest) {
      return;
    }

    handleCancel();
    setIsLeaveDialogOpen(false);
    onNavigateWithoutGuard(navigationRequest);
  };

  const handleSaveAndLeave = async () => {
    if (!navigationRequest || !(await handleSave())) {
      return;
    }

    setIsLeaveDialogOpen(false);
    onNavigateWithoutGuard(navigationRequest);
  };

  useModalFocus({
    isOpen: isLeaveDialogOpen,
    dialogRef: leaveDialogRef,
    initialFocusRef: cancelLeaveButtonRef,
    onEscape: handleCancelNavigation,
  });

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
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div
            className="max-w-md rounded-sm border border-amber-300/30 bg-(--surface-2) p-8 text-center shadow-(--surface-glow)"
            role="status"
            aria-live="polite"
          >
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/15">
              <Settings2 className="h-5 w-5 text-amber-200" aria-hidden="true" />
            </div>
            <h2 className="mb-2 text-lg font-semibold text-neutral-100">Settings are temporarily locked</h2>
            <p className="text-sm text-neutral-300">
              Stop recording from Home to edit settings. Your current recording remains safe.
            </p>
          </div>
        </div>
      )}

      <fieldset
        disabled={isRecording}
        className="m-0 flex min-h-0 flex-1 flex-col border-0 p-0"
        aria-label="Recording settings"
      >
        <div className="flex shrink-0 flex-wrap items-center gap-4 border-b border-white/10 bg-(--surface-1) px-4 py-4 md:px-6">
          <div>
            <h1 className="inline-flex items-center gap-2 text-lg font-semibold text-neutral-100">
              <Settings2 className="h-4 w-4 text-neutral-300" aria-hidden="true" />
              Settings
            </h1>
            <p className="mt-1 text-sm text-neutral-400">Configure capture before the next pull.</p>
          </div>
          {(isRecording || hasChanges) && (
            <div
              className="ml-auto inline-flex items-center gap-2 rounded-sm border border-amber-300/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-200"
              role="status"
              aria-live="polite"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-300" aria-hidden="true" />
              {isRecording ? "Settings locked while recording" : "Unsaved changes"}
            </div>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-6 pb-10 [scrollbar-gutter:stable] md:px-6">
          <div className="w-full space-y-4">
            <SettingsGroup
              contentId="settings-group-recording"
              description="What FloorPoV captures and how it sounds"
              icon={<Monitor className="h-4 w-4" aria-hidden="true" />}
              open={openGroups.recording}
              onOpenChange={(open) => onGroupToggle("recording", open)}
              title="Recording"
            >
              <SettingsSection
                title="Capture"
                icon={<Monitor className="h-4 w-4" aria-hidden="true" />}
                className="rounded-none border-0 bg-transparent p-0"
              >
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
                  disabled={isRecording}
                  onChange={(nextValue) => {
                    setFormData({
                      ...formData,
                      captureSource: nextValue as CaptureSource,
                    });
                  }}
                  ariaDescribedBy="settings-capture-source-help"
                />
                <p id="settings-capture-source-help" className="mt-1 text-xs text-neutral-400">
                  Choose your source: primary monitor or one specific window.
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
                        disabled={isRecording || isCaptureWindowSelectDisabled}
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
                    Pick a visible top-level window. Minimized windows can show black frames.
                  </p>

                  {isSavedCaptureWindowUnavailable && (
                    <p className="inline-flex items-center gap-1.5 text-xs text-amber-200">
                      <XCircle className="h-3.5 w-3.5" />
                      Your previously selected window is unavailable.
                    </p>
                  )}

                  {!isSavedCaptureWindowUnavailable && !isSelectedWindowAlive && formData.captureWindowHwnd && (
                    <p className="inline-flex items-center gap-1.5 text-xs text-amber-200">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Selected window is not currently running.
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
                <p className="text-sm text-neutral-300">Records your primary monitor via desktop duplication.</p>
              )}
            </div>
          </SettingsSection>

              <SettingsSection
                title="Video & audio"
                icon={<Video className="h-4 w-4" aria-hidden="true" />}
                className="rounded-none border-0 bg-transparent p-0"
              >
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label htmlFor={FIELD_IDS.videoQuality} className="mb-2 block text-sm text-neutral-300">Quality preset</label>
                <SettingsSelect
                  id={FIELD_IDS.videoQuality}
                  value={formData.videoQuality}
                  options={VIDEO_QUALITY_OPTIONS}
                  disabled={isRecording}
                  onChange={(nextValue) => {
                    if (isVideoQuality(nextValue)) {
                      setFormData({ ...formData, videoQuality: nextValue });
                    }
                  }}
                  ariaDescribedBy="settings-video-quality-help"
                />
                <p id="settings-video-quality-help" className="mt-1 text-xs text-neutral-400">
                  Higher presets improve clarity but increase file size.
                </p>
              </div>

              <div>
                <label htmlFor={FIELD_IDS.frameRate} className="mb-2 block text-sm text-neutral-300">Frame rate</label>
                <SettingsSelect
                  id={FIELD_IDS.frameRate}
                  value={String(formData.frameRate)}
                  options={FRAME_RATE_OPTIONS}
                  disabled={isRecording}
                  onChange={(nextValue) => {
                    const nextFrameRate = Number(nextValue);
                    if (isFrameRate(nextFrameRate)) {
                      setFormData({ ...formData, frameRate: nextFrameRate });
                    }
                  }}
                />
                <p className="mt-1 text-xs text-neutral-400">Sets your target capture FPS.</p>
              </div>

            </div>
          </SettingsSection>

          <div className="mt-5 border-t border-white/10 pt-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-neutral-200">
              <Volume2 className="h-4 w-4 text-neutral-400" aria-hidden="true" />
              Audio
            </div>
            <div className="space-y-4">
              <p className="text-sm text-neutral-400">Include game and desktop audio in your recordings.</p>

              <SettingsToggleField
                id={FIELD_IDS.enableSystemAudio}
                checked={formData.enableSystemAudio}
                onChange={(checked) => {
                  setFormData({
                    ...formData,
                    enableSystemAudio: checked,
                  });
                }}
                label="Enable system audio"
              />
            </div>
          </div>
            </SettingsGroup>

            <SettingsGroup
              contentId="settings-group-storage"
              description="Where recordings go and when they are cleaned up"
              icon={<HardDrive className="h-4 w-4" aria-hidden="true" />}
              open={openGroups.storage}
              onOpenChange={(open) => onGroupToggle("storage", open)}
              title="Storage"
            >
              <SettingsSection
                title="Output"
                icon={<HardDrive className="h-4 w-4" aria-hidden="true" />}
                className="rounded-none border-0 bg-transparent p-0"
              >
            <div className="space-y-4">
              <div>
                <ReadOnlyPathField
                  inputId={FIELD_IDS.outputFolder}
                  label="Output folder"
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
                label="Maximum storage (GB)"
                description={`Oldest recordings are removed when this limit is reached (minimum ${MIN_STORAGE_GB} GB)`}
              >
                <Input
                  id={FIELD_IDS.maxStorageGB}
                  type="number"
                  min={MIN_STORAGE_GB}
                  max={MAX_STORAGE_GB}
                  value={formData.maxStorageGB}
                  onChange={(e) => setFormData({ ...formData, maxStorageGB: parseInt(e.target.value) || MIN_STORAGE_GB })}
                />
              </FormField>
            </div>
              </SettingsSection>
            </SettingsGroup>

            <SettingsGroup
              contentId="settings-group-wow"
              description="WoW combat detection and automatic recording"
              icon={<Swords className="h-4 w-4" aria-hidden="true" />}
              open={openGroups.wow}
              onOpenChange={(open) => onGroupToggle("wow", open)}
              title="WoW integration"
            >
              <SettingsSection
                title="Automation"
                icon={<CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
                className="rounded-none border-0 bg-transparent p-0"
              >
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
                label="Enable auto recording"
                description="Start recordings automatically when M+, raid, or PvP combat begins."
              />

              <FormField
                id={FIELD_IDS.minAutoRaidRecordingSeconds}
                label="Minimum auto raid recording length (seconds)"
                description="Auto raid recordings shorter than this are treated as likely resets and deleted. Set 0 to disable this filter."
              >
                <Input
                  id={FIELD_IDS.minAutoRaidRecordingSeconds}
                  type="number"
                  min={MIN_AUTO_RAID_RECORDING_SECONDS}
                  max={MAX_AUTO_RAID_RECORDING_SECONDS}
                  value={formData.minAutoRaidRecordingSeconds}
                  onChange={(e) => {
                    const parsed = Number.parseInt(e.target.value, 10);
                    const normalized = Number.isFinite(parsed)
                      ? Math.min(
                          MAX_AUTO_RAID_RECORDING_SECONDS,
                          Math.max(MIN_AUTO_RAID_RECORDING_SECONDS, parsed),
                        )
                      : MIN_AUTO_RAID_RECORDING_SECONDS;
                    setFormData({
                      ...formData,
                      minAutoRaidRecordingSeconds: normalized,
                    });
                  }}
                />
              </FormField>

            </div>
          </SettingsSection>

              <SettingsSection
                title="WoW & combat log"
                icon={<Swords className="h-4 w-4" aria-hidden="true" />}
                className="rounded-none border-0 bg-transparent p-0"
              >
            <div>
              <ReadOnlyPathField
                inputId={FIELD_IDS.wowFolder}
                label="WoW folder"
                value={formData.wowFolder}
                onBrowse={handleBrowseWowFolder}
              />
              <p className="mt-2 text-xs text-neutral-400">
                Select your WoW client folder. FloorPoV reads{" "}
                <span className="font-mono">Logs\WoWCombatLog*.txt</span> (for example{" "}
                <span className="font-mono">WoWCombatLog-021726_124240.txt</span>).
              </p>
              {formData.wowFolder && isWowFolderValid && (
                <p className="mt-2 inline-flex items-center gap-1.5 rounded-sm border border-emerald-300/30 bg-emerald-500/12 px-2 py-1 text-xs text-emerald-100">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" aria-hidden="true" />
                  Combat log found!
                </p>
              )}
              {formData.wowFolder && !isWowFolderValid && (
                <p className="mt-2 inline-flex items-center gap-1.5 rounded-sm border border-rose-300/30 bg-rose-500/12 px-2 py-1 text-xs text-rose-200">
                  <XCircle className="h-3.5 w-3.5 text-rose-300" aria-hidden="true" />
                  Could not find any logs in this folder.
                </p>
              )}
            </div>
              </SettingsSection>
            </SettingsGroup>

            <SettingsGroup
              contentId="settings-group-controls"
              description="Keyboard controls used during recording"
              icon={<Keyboard className="h-4 w-4" aria-hidden="true" />}
              open={openGroups.controls}
              onOpenChange={(open) => onGroupToggle("controls", open)}
              title="Controls"
            >
              <SettingsSection
                title="Hotkeys"
                icon={<Keyboard className="h-4 w-4" aria-hidden="true" />}
                className="rounded-none border-0 bg-transparent p-0"
              >
            <div className="space-y-4">
              <div>
                <label htmlFor={FIELD_IDS.markerHotkey} className="mb-2 block text-sm text-neutral-300">Manual marker hotkey</label>
                <SettingsSelect
                  id={FIELD_IDS.markerHotkey}
                  value={formData.markerHotkey}
                  options={MARKER_HOTKEY_OPTIONS}
                  disabled={isRecording}
                  onChange={(nextValue) => {
                    if (isMarkerHotkey(nextValue)) {
                      setFormData({ ...formData, markerHotkey: nextValue });
                    }
                  }}
                  ariaDescribedBy="settings-marker-hotkey-help"
                />
                <p id="settings-marker-hotkey-help" className="mt-1 text-xs text-neutral-400">
                  Press this key during recording to add a marker. If it conflicts, choose another key.
                </p>
              </div>
            </div>
              </SettingsSection>
            </SettingsGroup>

            <SettingsGroup
              contentId="settings-group-app"
              description="Updates and diagnostic tools"
              icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
              open={openGroups.app}
              onOpenChange={(open) => onGroupToggle("app", open)}
              title="App"
            >
              <SettingsSection
                title="Updates"
                icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
                className="rounded-none border-0 bg-transparent p-0"
              >
            <div className="space-y-4">
              <SettingsToggleField
                id={FIELD_IDS.enableAutoUpdate}
                checked={formData.enableAutoUpdate}
                onChange={(checked) => {
                  setFormData({
                    ...formData,
                    enableAutoUpdate: checked,
                  });
                }}
                label="Enable auto updates"
                description="Check for beta updates on launch and install them automatically."
              />
            </div>
          </SettingsSection>

          <div className="rounded-sm border border-white/10 bg-(--surface-1)/80 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-neutral-200">
              <AlertTriangle className="h-4 w-4 text-neutral-400" aria-hidden="true" />
              <span className="flex-1">Advanced & troubleshooting</span>
              <span className="text-xs font-normal text-neutral-500">Optional</span>
            </div>
            <div className="mt-4 space-y-4 border-t border-white/10 pt-4">
              <div>
                <label htmlFor={FIELD_IDS.videoEncoderPreference} className="mb-2 block text-sm text-neutral-300">
                  Video Encoder
                </label>
                <SettingsSelect
                  id={FIELD_IDS.videoEncoderPreference}
                  value={formData.videoEncoderPreference}
                  options={videoEncoderOptions}
                  disabled={isRecording || isLoadingVideoEncoders}
                  onChange={(nextValue) => {
                    if (isVideoEncoderPreference(nextValue)) {
                      setFormData({ ...formData, videoEncoderPreference: nextValue });
                    }
                  }}
                  ariaDescribedBy="settings-video-encoder-help"
                />
                <p id="settings-video-encoder-help" className="mt-1 text-xs text-neutral-400">
                  Auto picks the best available encoder. Hardware encoders usually reduce in-game stutter.
                </p>
                {videoEncodersError && (
                  <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-amber-200">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                    {videoEncodersError}
                  </p>
                )}
              </div>
              <SettingsToggleField
                id={FIELD_IDS.enableRecordingDiagnostics}
                checked={formData.enableRecordingDiagnostics}
                onChange={(checked) => {
                  setFormData({
                    ...formData,
                    enableRecordingDiagnostics: checked,
                  });
                }}
                label="Enable recording diagnostics"
                description="Write per-second audio and FFmpeg pacing logs for stutter or crackle debugging."
              />
            </div>
          </div>
            </SettingsGroup>
          </div>
        </div>

        <div className="shrink-0 border-t border-white/10 bg-(--surface-1) px-4 py-4 md:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3 pr-2">
            <span className={`text-xs ${hasChanges ? "text-amber-200" : "text-neutral-500"}`}>
              {hasChanges ? "Changes are not saved" : "All changes saved"}
            </span>
            <div className="flex flex-wrap justify-end gap-3">
              <Button
                variant="secondary"
                onClick={handleCancel}
                disabled={!hasChanges}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => void handleSave()}
                disabled={!hasChanges}
              >
                Save Changes
              </Button>
            </div>
          </div>
        </div>
      </fieldset>

      {isLeaveDialogOpen && navigationRequest && createPortal(
        <div data-modal-root className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div
            ref={leaveDialogRef}
            className="w-full max-w-md rounded-sm border border-amber-300/25 bg-(--surface-2) p-5 shadow-(--surface-glow)"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-leave-title"
            aria-describedby="settings-leave-description"
            tabIndex={-1}
          >
            <h2 id="settings-leave-title" className="text-sm font-semibold text-neutral-100">
              Leave Settings with unsaved changes?
            </h2>
            <p id="settings-leave-description" className="mt-2 text-sm leading-6 text-neutral-300">
              Save your changes before leaving, or discard them and continue without saving.
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button ref={cancelLeaveButtonRef} variant="secondary" onClick={handleCancelNavigation}>
                Cancel
              </Button>
              <Button variant="secondary" onClick={handleDiscardAndLeave}>
                Discard changes
              </Button>
              <Button variant="primary" onClick={() => void handleSaveAndLeave()}>
                Save and leave
              </Button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
