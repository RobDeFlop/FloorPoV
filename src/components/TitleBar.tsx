import { getCurrentWindow } from '@tauri-apps/api/window';
import { motion, useReducedMotion } from 'motion/react';
import { useRecording } from '../contexts/RecordingContext';

export function TitleBar() {
  const appWindow = getCurrentWindow();
  const { isRecording, recordingDuration } = useRecording();
  const reduceMotion = useReducedMotion();

  const handleMinimize = () => {
    appWindow.minimize();
  };

  const handleMaximize = async () => {
    try {
      const isMaximized = await appWindow.isMaximized();
      if (isMaximized) {
        await appWindow.unmaximize();
      } else {
        await appWindow.maximize();
      }
    } catch (e) {
      console.error('Maximize error:', e);
    }
  };

  const handleClose = () => {
    appWindow.close();
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div
      data-tauri-drag-region
      className="h-8 bg-neutral-900 flex items-center justify-between border-b border-neutral-800/80 select-none"
    >
      <div className="flex items-center gap-3 px-3" data-tauri-drag-region>
        <span className="text-sm font-medium text-neutral-200">Floorpov</span>
        
        {isRecording && (
          <motion.div
            className="flex items-center gap-2 text-sm"
            animate={
              reduceMotion
                ? undefined
                : {
                    opacity: [0.85, 1, 0.85],
                  }
            }
            transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
          >
            <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
            <span className="font-mono text-rose-400">
              REC {formatDuration(recordingDuration)}
            </span>
          </motion.div>
        )}
      </div>
      <div className="flex h-full">
        <button
          onClick={handleMinimize}
          className="w-12 h-full flex items-center justify-center hover:bg-neutral-800 transition-colors"
          title="Minimize"
        >
          <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor" className="text-neutral-400">
            <rect width="10" height="1" />
          </svg>
        </button>
        <button
          onClick={handleMaximize}
          className="w-12 h-full flex items-center justify-center hover:bg-neutral-800 transition-colors"
          title="Maximize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" className="text-neutral-400">
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
        </button>
        <button
          onClick={handleClose}
          className="w-12 h-full flex items-center justify-center hover:bg-red-600 transition-colors"
          title="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" className="text-neutral-400 hover:text-white">
            <path d="M1 1L9 9M9 1L1 9" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
