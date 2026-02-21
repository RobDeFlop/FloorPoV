import { Circle, LoaderCircle, Square } from "lucide-react";
import { motion, useReducedMotion } from 'motion/react';
import { useState } from "react";
import { useRecording } from "../contexts/RecordingContext";
import { useSettings } from "../contexts/SettingsContext";
import { panelVariants, smoothTransition } from '../lib/motion';

export function RecordingControls() {
  const reduceMotion = useReducedMotion();
  const [isPreviewBusy, setIsPreviewBusy] = useState(false);
  const [previewAction, setPreviewAction] = useState<'starting' | 'stopping' | null>(null);
  const {
    isRecording,
    isPreviewing,
    recordingDuration,
    startPreview,
    stopPreview,
    startRecording,
    stopRecording,
  } = useRecording();
  const { settings } = useSettings();

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const handlePreviewToggle = async () => {
    if (isPreviewBusy) {
      return;
    }

    setIsPreviewBusy(true);
    const shouldStopPreview = isPreviewing;
    setPreviewAction(shouldStopPreview ? 'stopping' : 'starting');
    try {
      if (shouldStopPreview) {
        await stopPreview();
      } else {
        await startPreview();
      }
    } catch (error) {
      console.error("Preview toggle failed:", error);
    } finally {
      setIsPreviewBusy(false);
      setPreviewAction(null);
    }
  };

  const handleRecordingToggle = async () => {
    try {
      if (isRecording) {
        await stopRecording();
      } else {
        await startRecording();
      }
    } catch (error) {
      console.error("Recording toggle failed:", error);
    }
  };

  return (
    <motion.div
      className="flex items-center gap-3 px-4 py-2 bg-neutral-900 border-t border-neutral-800/80"
      variants={panelVariants}
      initial={reduceMotion ? false : 'initial'}
      animate="animate"
      transition={smoothTransition}
    >
      <motion.button
        onClick={handlePreviewToggle}
        disabled={isRecording || isPreviewBusy}
        className={`flex items-center gap-2 px-4 py-2 rounded text-sm font-medium transition-colors ${
          isPreviewing
            ? "bg-emerald-600 hover:bg-emerald-500 text-white"
            : "bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700"
        } disabled:opacity-50 disabled:cursor-not-allowed`}
        whileHover={reduceMotion ? undefined : { y: -1 }}
        whileTap={reduceMotion ? undefined : { scale: 0.98 }}
      >
        {previewAction ? (
          <>
            <LoaderCircle className="w-4 h-4 animate-spin" />
            {previewAction === 'stopping' ? 'Stopping...' : 'Starting...'}
          </>
        ) : isPreviewing ? (
          'Stop Preview'
        ) : (
          'Start Preview'
        )}
      </motion.button>

      <motion.button
        onClick={handleRecordingToggle}
        className={`flex items-center gap-2 px-4 py-2 rounded text-sm font-medium transition-colors ${
          isRecording
            ? "bg-red-600 hover:bg-red-500 text-white"
            : "bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 border border-emerald-400/30"
        }`}
        whileHover={reduceMotion ? undefined : { y: -1 }}
        whileTap={reduceMotion ? undefined : { scale: 0.98 }}
      >
        {isRecording ? (
          <>
            <Square className="w-4 h-4" fill="currentColor" />
            Stop Recording
          </>
        ) : (
          <>
            <Circle className="w-4 h-4" fill="currentColor" />
            Start Recording
          </>
        )}
      </motion.button>

      {isRecording && (
        <div className="flex items-center gap-2 text-sm">
          <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
          <span className="font-mono text-neutral-300">{formatDuration(recordingDuration)}</span>
        </div>
      )}

      {isPreviewing && !isRecording && (
        <span className="text-xs text-neutral-500">Preview active</span>
      )}

      {!isRecording && settings.markerHotkey !== 'none' && (
          <span className="ml-auto mr-2 text-xs text-neutral-500">
            Press <kbd className="px-1.5 py-0.5 bg-emerald-500/15 border border-emerald-400/30 rounded text-emerald-200 font-mono">{settings.markerHotkey}</kbd> to add marker
          </span>
        )}
    </motion.div>
  );
}
