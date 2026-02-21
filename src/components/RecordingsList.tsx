import { useCallback, useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { RefreshCw, Video } from 'lucide-react';
import { useSettings } from '../contexts/SettingsContext';
import { useVideo } from '../contexts/VideoContext';
import { useRecording } from '../contexts/RecordingContext';
import { panelVariants, smoothTransition } from '../lib/motion';

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
  const { loadVideo } = useVideo();
  const { isRecording, isPreviewing, stopPreview } = useRecording();
  const reduceMotion = useReducedMotion();
  const [recordings, setRecordings] = useState<RecordingInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingRecordingPath, setLoadingRecordingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    if (isRecording || loadingRecordingPath) {
      return;
    }

    setLoadingRecordingPath(recording.file_path);
    setError(null);

    try {
      if (isPreviewing) {
        await stopPreview();
      }

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
  }, [isPreviewing, isRecording, loadVideo, loadingRecordingPath, stopPreview]);

  useEffect(() => {
    const unlistenRecordingStopped = listen('recording-stopped', () => {
      loadRecordings();
    });

    return () => {
      unlistenRecordingStopped.then((fn) => fn());
    };
  }, [loadRecordings]);

  return (
    <motion.section
      className="bg-neutral-900 border-t border-neutral-800/80 px-4 py-3 min-h-0"
      variants={panelVariants}
      initial={reduceMotion ? false : 'initial'}
      animate="animate"
      transition={smoothTransition}
    >
      <div className="mb-2.5 flex items-center justify-between pr-2">
        <h2 className="text-sm font-medium text-neutral-200">Recordings</h2>
        <motion.button
          onClick={loadRecordings}
          disabled={isLoading}
          className="inline-flex h-7 items-center gap-1.5 px-2.5 text-xs rounded bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-400/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          whileHover={reduceMotion ? undefined : { y: -1 }}
          whileTap={reduceMotion ? undefined : { scale: 0.98 }}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </motion.button>
      </div>

      {error && <p className="text-xs text-red-400 mb-2">{error}</p>}

      <div className="max-h-36 space-y-1 overflow-y-auto [scrollbar-gutter:stable]">
        {recordings.length === 0 && !isLoading ? (
          <p className="text-xs text-neutral-500">No recordings found in {settings.outputFolder}</p>
        ) : (
          recordings.map((recording) => (
            <motion.button
              key={`${recording.filename}-${recording.created_at}`}
              type="button"
              onClick={() => handleLoadRecording(recording)}
              disabled={isRecording || Boolean(loadingRecordingPath)}
              className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded bg-neutral-800/60 px-2.5 py-1.5 text-left transition-colors hover:bg-neutral-700/70 disabled:cursor-not-allowed disabled:opacity-60"
              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={smoothTransition}
            >
              <div className="min-w-0 flex items-center gap-2">
                <Video className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                <span className="text-xs text-neutral-200 truncate" title={recording.filename}>
                  {recording.filename}
                </span>
              </div>
              <div className="text-[11px] text-neutral-400 shrink-0">
                {loadingRecordingPath === recording.file_path
                  ? 'Loading...'
                  : `${formatBytes(recording.size_bytes)} · ${formatDate(recording.created_at)}`}
              </div>
            </motion.button>
          ))
        )}
      </div>
    </motion.section>
  );
}
