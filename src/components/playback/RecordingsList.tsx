import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AlertTriangle, Clock3, Film, HardDrive, RefreshCw, Trash2 } from 'lucide-react';
import { useSettings } from '../../contexts/SettingsContext';
import { useVideo } from '../../contexts/VideoContext';
import { useRecording } from '../../contexts/RecordingContext';
import { panelVariants, smoothTransition } from '../../lib/motion';

interface RecordingInfo {
  filename: string;
  file_path: string;
  size_bytes: number;
  created_at: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toLocaleString();
}

export function RecordingsList() {
  const { settings } = useSettings();
  const { loadVideo, videoSrc, isVideoLoading } = useVideo();
  const { isRecording } = useRecording();
  const reduceMotion = useReducedMotion();
  const [recordings, setRecordings] = useState<RecordingInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingRecordingPath, setLoadingRecordingPath] = useState<string | null>(null);
  const [deletingRecordingPath, setDeletingRecordingPath] = useState<string | null>(null);
  const [pendingDeleteRecording, setPendingDeleteRecording] = useState<RecordingInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  const cancelDeleteButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const isActionLocked =
    isRecording ||
    Boolean(loadingRecordingPath) ||
    Boolean(deletingRecordingPath) ||
    Boolean(pendingDeleteRecording) ||
    isVideoLoading;

  const loadRecordings = useCallback(async () => {
    if (!settings.outputFolder) {
      setRecordings([]);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await invoke<RecordingInfo[]>('get_recordings_list', {
        folderPath: settings.outputFolder,
      });
      setRecordings([...result].reverse());
    } catch (loadError) {
      console.error('Failed to load recordings:', loadError);
      setError('Could not load recordings from the output folder.');
    } finally {
      setIsLoading(false);
    }
  }, [settings.outputFolder]);

  useEffect(() => {
    loadRecordings();
  }, [loadRecordings]);

  const handleLoadRecording = useCallback(async (recording: RecordingInfo) => {
    if (isRecording || loadingRecordingPath || deletingRecordingPath || isVideoLoading) {
      return;
    }

    setLoadingRecordingPath(recording.file_path);
    setError(null);

    try {
      const recordingSource = convertFileSrc(recording.file_path);
      console.log('[RecordingsList] Loading recording', {
        filename: recording.filename,
        originalPath: recording.file_path,
        convertedSource: recordingSource,
      });
      loadVideo(recordingSource);
    } catch (loadError) {
      console.error('Failed to load recording:', loadError);
      setError('Could not load the selected recording.');
    } finally {
      setLoadingRecordingPath(null);
    }
  }, [deletingRecordingPath, isRecording, isVideoLoading, loadVideo, loadingRecordingPath]);

  const handleDeleteRecording = useCallback((recording: RecordingInfo) => {
    if (isRecording || loadingRecordingPath || deletingRecordingPath) {
      return;
    }
    setPendingDeleteRecording(recording);
  }, [deletingRecordingPath, isRecording, loadingRecordingPath]);

  const cancelDeleteRecording = useCallback(() => {
    if (deletingRecordingPath) {
      return;
    }

    setPendingDeleteRecording(null);
  }, [deletingRecordingPath]);

  useEffect(() => {
    if (!pendingDeleteRecording) {
      previouslyFocusedElementRef.current?.focus();
      return;
    }

    previouslyFocusedElementRef.current = document.activeElement as HTMLElement | null;
    cancelDeleteButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelDeleteRecording();
        return;
      }

      if (event.key !== 'Tab' || !deleteDialogRef.current) {
        return;
      }

      const focusableElements = Array.from(
        deleteDialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );

      if (focusableElements.length === 0) {
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement as HTMLElement | null;

      if (event.shiftKey && activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [cancelDeleteRecording, pendingDeleteRecording]);

  const confirmDeleteRecording = useCallback(async () => {
    if (!pendingDeleteRecording || isRecording || loadingRecordingPath || deletingRecordingPath) {
      return;
    }

    setDeletingRecordingPath(pendingDeleteRecording.file_path);
    setError(null);

    try {
      await invoke('delete_recording', { filePath: pendingDeleteRecording.file_path });
      setRecordings((previousRecordings) => {
        return previousRecordings.filter((item) => item.file_path !== pendingDeleteRecording.file_path);
      });
      setPendingDeleteRecording(null);
    } catch (deleteError) {
      console.error('Failed to delete recording:', deleteError);
      setError('Could not delete the selected recording.');
    } finally {
      setDeletingRecordingPath(null);
    }
  }, [deletingRecordingPath, isRecording, loadingRecordingPath, pendingDeleteRecording]);

  useEffect(() => {
    const unlistenRecordingStopped = listen('recording-stopped', () => {
      loadRecordings();
    });

    const unlistenRecordingFinalized = listen('recording-finalized', () => {
      loadRecordings();
    });

    return () => {
      unlistenRecordingStopped.then((fn) => fn());
      unlistenRecordingFinalized.then((fn) => fn());
    };
  }, [loadRecordings]);

  return (
    <motion.section
      className="flex flex-1 min-h-0 flex-col bg-[var(--surface-1)] border-t border-white/10 px-4 py-3"
      variants={panelVariants}
      initial={reduceMotion ? false : 'initial'}
      animate="animate"
      transition={smoothTransition}
    >
      <div className="mb-2.5 flex items-center justify-between pr-2">
        <h2 className="inline-flex items-center gap-2 text-sm font-medium text-neutral-100">
          <Film className="h-4 w-4 text-neutral-300" />
          Recordings
        </h2>
        <motion.button
          type="button"
          onClick={loadRecordings}
          disabled={isLoading || !settings.outputFolder}
          className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-white/20 bg-white/5 px-2.5 text-xs text-neutral-200 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:opacity-50"
          whileHover={reduceMotion ? undefined : { y: -1 }}
          whileTap={reduceMotion ? undefined : { scale: 0.98 }}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </motion.button>
      </div>

      {error && <p className="mb-2 text-xs text-red-300" role="status">{error}</p>}

      <div
        className="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]"
        aria-busy={isLoading}
      >
        {!settings.outputFolder ? (
          <p className="text-xs text-neutral-400">Select an output folder to browse recordings.</p>
        ) : recordings.length === 0 && !isLoading ? (
          <p className="text-xs text-neutral-400">No recordings found in {settings.outputFolder}</p>
        ) : (
          <ul className="space-y-1" role="list">
            {recordings.map((recording) => {
              const recordingSource = convertFileSrc(recording.file_path);
              const isLoadedRecording = videoSrc === recordingSource;

              return (
                <motion.li
                  key={`${recording.filename}-${recording.created_at}`}
                  className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-1 rounded-sm border text-left transition-colors hover:bg-white/5 ${
                    isLoadedRecording
                      ? 'border-emerald-300/40 bg-emerald-500/12 hover:border-emerald-300/50'
                      : 'border-white/10 bg-black/20 hover:border-white/25'
                  }`}
                  initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={smoothTransition}
                >
                  <button
                    type="button"
                    onClick={() => handleLoadRecording(recording)}
                    disabled={isActionLocked}
                    aria-current={isLoadedRecording ? 'true' : undefined}
                    className="min-w-0 flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="min-w-0 flex items-center gap-2">
                      <HardDrive className="w-3.5 h-3.5 text-neutral-300/80 shrink-0" />
                      <span className="min-w-0">
                        <span className="block truncate text-xs text-neutral-200" title={recording.filename}>
                          {recording.filename}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-neutral-400 sm:hidden">
                          <Clock3 className="h-3 w-3" />
                          {`${formatBytes(recording.size_bytes)} · ${formatDate(recording.created_at)}`}
                        </span>
                      </span>
                    </span>
                    <span className="hidden shrink-0 items-center gap-1.5 text-[11px] text-neutral-400 sm:inline-flex">
                      <Clock3 className="h-3 w-3" />
                      {`${formatBytes(recording.size_bytes)} · ${formatDate(recording.created_at)}`}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteRecording(recording)}
                    disabled={isRecording || Boolean(loadingRecordingPath) || Boolean(deletingRecordingPath)}
                    className="mr-1 inline-flex h-6 w-6 items-center justify-center rounded-sm border border-rose-300/25 bg-rose-500/10 text-rose-200 transition-colors hover:bg-rose-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/60 disabled:cursor-not-allowed disabled:opacity-50"
                    title="Delete recording"
                    aria-label={`Delete recording ${recording.filename}`}
                  >
                    <Trash2 className={`h-3.5 w-3.5 ${deletingRecordingPath === recording.file_path ? 'animate-pulse' : ''}`} />
                  </button>
                </motion.li>
              );
            })}
          </ul>
        )}
      </div>

      {pendingDeleteRecording && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div
            ref={deleteDialogRef}
            className="w-full max-w-md rounded-sm border border-white/15 bg-[var(--surface-2)] p-4 shadow-[var(--surface-glow)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-recording-title"
            aria-describedby="delete-recording-description"
          >
            <div className="mb-3 inline-flex h-8 w-8 items-center justify-center rounded-sm border border-rose-300/25 bg-rose-500/12">
              <AlertTriangle className="h-4 w-4 text-rose-200" />
            </div>
            <h3 id="delete-recording-title" className="text-sm font-semibold uppercase tracking-[0.11em] text-neutral-100">Delete recording?</h3>
            <p id="delete-recording-description" className="mt-2 text-sm text-neutral-300">
              This will permanently delete{" "}
              <span className="font-medium text-neutral-100">{pendingDeleteRecording.filename}</span>.
              This action cannot be undone.
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  ref={cancelDeleteButtonRef}
                  type="button"
                  onClick={cancelDeleteRecording}
                  disabled={Boolean(deletingRecordingPath)}
                  className="inline-flex h-8 items-center rounded-sm border border-white/20 bg-black/20 px-3 text-xs text-neutral-200 transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
              <button
                  type="button"
                  onClick={confirmDeleteRecording}
                  disabled={Boolean(deletingRecordingPath)}
                  className="inline-flex h-8 items-center rounded-sm border border-rose-300/35 bg-rose-500/14 px-3 text-xs font-semibold text-rose-100 transition-colors hover:bg-rose-500/22 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/60 disabled:cursor-not-allowed disabled:opacity-50"
                >
                {deletingRecordingPath ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.section>
  );
}
