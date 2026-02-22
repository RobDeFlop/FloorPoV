import { Circle, LoaderCircle, Square } from "lucide-react";
import { motion, useReducedMotion } from 'motion/react';
import { useState } from "react";
import { useRecording } from "../../contexts/RecordingContext";
import { useSettings } from "../../contexts/SettingsContext";
import { panelVariants, smoothTransition } from '../../lib/motion';

export function RecordingControls() {
  const reduceMotion = useReducedMotion();
  const [isRecordingBusy, setIsRecordingBusy] = useState(false);
  const [recordingAction, setRecordingAction] = useState<'starting' | 'stopping' | null>(null);
  const {
    isRecording,
    lastError,
    startRecording,
    stopRecording,
  } = useRecording();
  const { settings } = useSettings();

  const handleRecordingToggle = async () => {
    if (isRecordingBusy) {
      return;
    }

    setIsRecordingBusy(true);
    const shouldStopRecording = isRecording;
    setRecordingAction(shouldStopRecording ? 'stopping' : 'starting');
    try {
      if (shouldStopRecording) {
        await stopRecording();
      } else {
        await startRecording();
      }
    } catch (error) {
      console.error("Recording toggle failed:", error);
    } finally {
      setIsRecordingBusy(false);
      setRecordingAction(null);
    }
  };

  return (
    <motion.div
      className="flex flex-wrap items-center gap-2 border-t border-emerald-300/10 bg-[var(--surface-2)] px-3 py-2.5 sm:gap-3 sm:px-4"
      variants={panelVariants}
      initial={reduceMotion ? false : 'initial'}
      animate="animate"
      transition={smoothTransition}
    >
      <motion.button
        type="button"
        onClick={handleRecordingToggle}
        disabled={isRecordingBusy}
        className={`flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60 ${
          isRecording
            ? "border-rose-300/40 bg-rose-500/25 hover:bg-rose-500/30 text-rose-50"
            : "border-emerald-300/35 bg-emerald-500/20 hover:bg-emerald-500/28 text-emerald-100"
        } disabled:opacity-50 disabled:cursor-not-allowed`}
        whileHover={reduceMotion ? undefined : { y: -1 }}
        whileTap={reduceMotion ? undefined : { scale: 0.98 }}
      >
        {recordingAction ? (
          <>
            <LoaderCircle className="w-4 h-4 animate-spin" />
            {recordingAction === 'stopping' ? 'Stopping...' : 'Starting...'}
          </>
        ) : isRecording ? (
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

      {isRecording && settings.markerHotkey !== 'none' && (
          <span className="text-xs text-neutral-400 md:ml-auto">
            Press <kbd className="px-1.5 py-0.5 bg-emerald-500/15 border border-emerald-400/30 rounded text-emerald-200 font-mono">{settings.markerHotkey}</kbd> to add marker
          </span>
        )}

      {lastError && (
        <span className="text-xs text-rose-300" role="status">{lastError}</span>
      )}
    </motion.div>
  );
}
