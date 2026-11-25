import { invoke } from '@tauri-apps/api/core';
import { Clock3, Columns2, Film, HardDrive, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRecording } from '../../contexts/RecordingContext';
import { useSettings } from '../../contexts/SettingsContext';
import { useVideo } from '../../contexts/VideoContext';
import { useRecordingsList } from '../../hooks/useRecordingsList';
import { useClearStalePlayback } from '../../hooks/useClearStalePlayback';
import { panelVariants, pressFeedback, smoothTransition } from "../../lib/motion";
import { RecordingInfo } from '../../types/recording';
import { type GameMode } from '../../types/ui';
import { formatBytes, formatDate, formatEncounterCategory } from '../../utils/format';
import {
  getRecordingDisplayTitle,
  inferRecordingMode,
  isRecordingInGameMode,
} from '../../utils/recording-title';
import { canEnterCompareMode, isComparedRecordingPath } from '../../utils/compare-playback';
import { toPlaybackSource } from '../../utils/recording-playback';
import { filterRecordingsBySearchQuery } from '../../utils/recording-search';
import { DeleteConfirmDialog } from '../ui/DeleteConfirmDialog';
import { FormField } from '../ui/FormField';
import { Input } from '../ui/Input';
import { useRecordingSelection } from './useRecordingSelection';

interface RecordingsListProps {
  gameModeContext?: GameMode;
  title?: string;
  description?: string;
  activeRecordingPath?: string | null;
  autoLoadLatest?: boolean;
  emptyMessage?: string;
  onRecordingActivate?: (recording: RecordingInfo) => void;
  showManagementActions?: boolean;
}

export function RecordingsList({
  gameModeContext,
  title,
  description,
  activeRecordingPath,
  autoLoadLatest = false,
  emptyMessage,
  onRecordingActivate,
  showManagementActions = true,
}: RecordingsListProps) {
  const { settings } = useSettings();
  const { loadVideo, loadedFilePath, videoSrc, isVideoLoading, compareVideos, enterCompareMode } = useVideo();
  const { isRecording, loadPlaybackMetadata } = useRecording();
  const { recordings, isLoading, error: listError, loadRecordings, setRecordings } = useRecordingsList();
  useClearStalePlayback(recordings, !isLoading && !listError);
  const [searchQuery, setSearchQuery] = useState("");
  const [loadingRecordingPath, setLoadingRecordingPath] = useState<string | null>(null);
  const [deletingRecordingPaths, setDeletingRecordingPaths] = useState<string[]>([]);
  const [pendingDeleteRecordings, setPendingDeleteRecordings] = useState<RecordingInfo[]>([]);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const recordingsContainerRef = useRef<HTMLDivElement>(null);
  const hasAutoSelectedLatestRef = useRef(false);
  const displayError = deleteError ?? listError;
  const isDeletingRecordings = deletingRecordingPaths.length > 0;
  const hasPendingDeleteRecordings = pendingDeleteRecordings.length > 0;
  const deletingRecordingPathSet = useMemo(() => {
    return new Set(deletingRecordingPaths);
  }, [deletingRecordingPaths]);
  const isActionLocked =
    isRecording ||
    Boolean(loadingRecordingPath) ||
    isDeletingRecordings ||
    hasPendingDeleteRecordings ||
    isVideoLoading;
  const scopedRecordings = useMemo(() => {
    if (!gameModeContext) {
      return recordings;
    }

    return recordings.filter((recording) => isRecordingInGameMode(recording, gameModeContext));
  }, [gameModeContext, recordings]);
  const filteredRecordings = useMemo(() => {
    return filterRecordingsBySearchQuery(scopedRecordings, searchQuery, gameModeContext);
  }, [gameModeContext, scopedRecordings, searchQuery]);

  const handleLoadRecording = useCallback(async (recording: RecordingInfo) => {
    if (isRecording || loadingRecordingPath || isDeletingRecordings || isVideoLoading) {
      return;
    }

    setLoadingRecordingPath(recording.file_path);
    setDeleteError(null);

    try {
      await loadPlaybackMetadata(recording.file_path);

      const recordingSource = await toPlaybackSource(recording.file_path, settings.outputFolder);
      loadVideo(recordingSource, recording.file_path);
      onRecordingActivate?.(recording);
    } catch (loadError) {
      console.error('Failed to load recording:', loadError);
      setDeleteError('Could not load the selected recording.');
    } finally {
      setLoadingRecordingPath(null);
    }
  }, [
    isDeletingRecordings,
    isRecording,
    isVideoLoading,
    loadPlaybackMetadata,
    loadVideo,
    loadingRecordingPath,
    onRecordingActivate,
    settings.outputFolder,
  ]);

  useEffect(() => {
    if (
      !autoLoadLatest ||
      hasAutoSelectedLatestRef.current ||
      isLoading ||
      !settings.outputFolder
    ) {
      return;
    }

    if (compareVideos || videoSrc || filteredRecordings.length === 0) {
      hasAutoSelectedLatestRef.current = true;
      return;
    }

    if (isRecording || isActionLocked) {
      return;
    }

    hasAutoSelectedLatestRef.current = true;
    void handleLoadRecording(filteredRecordings[0]);
  }, [
    autoLoadLatest,
    compareVideos,
    filteredRecordings,
    handleLoadRecording,
    isActionLocked,
    isLoading,
    isRecording,
    settings.outputFolder,
    videoSrc,
  ]);

  const {
    selectedRecordingPathSet,
    selectedRecordingCount,
    selectedRecordings,
    selectAll,
    clearSelection,
    handleRecordingRowClick,
    handleRecordingRowMouseDown,
    handleSelectionControlClick,
    handleSelectionControlMouseDown,
    updateSelectionAfterDelete,
  } = useRecordingSelection<RecordingInfo>({
    recordings: scopedRecordings,
    visibleRecordings: filteredRecordings,
    isActionLocked,
    onPlainActivate: handleLoadRecording,
  });
  const visibleSelectedCount = useMemo(() => {
    return filteredRecordings.filter((recording) => selectedRecordingPathSet.has(recording.file_path)).length;
  }, [filteredRecordings, selectedRecordingPathSet]);

  const handleDeleteRecording = useCallback((recording: RecordingInfo) => {
    if (isActionLocked) {
      return;
    }

    setPendingDeleteRecordings([recording]);
  }, [isActionLocked]);

  const handleDeleteSelectedRecordings = useCallback(() => {
    if (isActionLocked || selectedRecordings.length === 0) {
      return;
    }

    setPendingDeleteRecordings(selectedRecordings);
  }, [isActionLocked, selectedRecordings]);

  const handleCompareSelectedRecordings = useCallback(async () => {
    if (isActionLocked || !canEnterCompareMode(selectedRecordingCount)) {
      return;
    }

    const leftRecording = selectedRecordings[0];
    const rightRecording = selectedRecordings[1];
    if (!leftRecording || !rightRecording) {
      return;
    }

    setLoadingRecordingPath(leftRecording.file_path);
    setDeleteError(null);

    try {
      const [leftSrc, rightSrc] = await Promise.all([
        toPlaybackSource(leftRecording.file_path, settings.outputFolder),
        toPlaybackSource(rightRecording.file_path, settings.outputFolder),
      ]);

      enterCompareMode(
        {
          src: leftSrc,
          filePath: leftRecording.file_path,
          title: getRecordingDisplayTitle(leftRecording, gameModeContext),
        },
        {
          src: rightSrc,
          filePath: rightRecording.file_path,
          title: getRecordingDisplayTitle(rightRecording, gameModeContext),
        },
      );
    } catch (compareError) {
      console.error('Failed to start compare mode:', compareError);
      setDeleteError('Could not load the selected recordings for compare.');
    } finally {
      setLoadingRecordingPath(null);
    }
  }, [
    enterCompareMode,
    gameModeContext,
    isActionLocked,
    selectedRecordingCount,
    selectedRecordings,
    settings.outputFolder,
  ]);

  const cancelDeleteRecording = useCallback(() => {
    if (isDeletingRecordings) {
      return;
    }

    setPendingDeleteRecordings([]);
  }, [isDeletingRecordings]);

  const confirmDeleteRecording = useCallback(async () => {
    if (
      pendingDeleteRecordings.length === 0 ||
      isRecording ||
      loadingRecordingPath ||
      isDeletingRecordings
    ) {
      return;
    }

    const recordingsToDelete = pendingDeleteRecordings;
    const pathsBeingDeleted = recordingsToDelete.map((recording) => recording.file_path);

    setDeletingRecordingPaths(pathsBeingDeleted);
    setDeleteError(null);

    try {
      const deletionResults = await Promise.allSettled(
        recordingsToDelete.map((recording) => invoke('delete_recording', { filePath: recording.file_path })),
      );

      const deletedPaths = new Set<string>();
      const failedDeletePaths: string[] = [];

      deletionResults.forEach((result, index) => {
        const recordingPath = recordingsToDelete[index]?.file_path;
        if (!recordingPath) {
          return;
        }

        if (result.status === 'fulfilled') {
          deletedPaths.add(recordingPath);
          return;
        }

        failedDeletePaths.push(recordingPath);
        console.error('Failed to delete recording:', result.reason);
      });

      if (deletedPaths.size > 0) {
        setRecordings((previousRecordings) => {
          return previousRecordings.filter((item) => !deletedPaths.has(item.file_path));
        });
      }

      updateSelectionAfterDelete(deletedPaths, failedDeletePaths);

      if (failedDeletePaths.length > 0) {
        const deletedCount = deletedPaths.size;
        setDeleteError(
          failedDeletePaths.length === recordingsToDelete.length
            ? 'Could not delete the selected recordings.'
            : `Deleted ${deletedCount} recording${deletedCount === 1 ? '' : 's'}, but ${failedDeletePaths.length} failed to delete.`,
        );
      }

      setPendingDeleteRecordings([]);
    } catch (err) {
      console.error('Failed to delete recordings:', err);
      setDeleteError('Could not delete the selected recordings.');
    } finally {
      setDeletingRecordingPaths([]);
    }
  }, [
    isDeletingRecordings,
    isRecording,
    loadingRecordingPath,
    pendingDeleteRecordings,
    setRecordings,
    updateSelectionAfterDelete,
  ]);

  const pendingDeleteCount = pendingDeleteRecordings.length;
  const isBulkDelete = pendingDeleteCount > 1;

  return (
    <motion.section
      className="flex flex-1 min-h-0 flex-col bg-(--surface-1) border-t border-white/10 px-4 py-3"
      variants={panelVariants}
      initial={'initial'}
      animate="animate"
      transition={smoothTransition}
    >
      <div className="mb-2 flex items-center justify-between gap-2 pr-2">
        <div>
          <h2 className="inline-flex items-center gap-2 text-sm font-medium text-neutral-100">
            <Film className="h-4 w-4 text-neutral-300" />
            {title ?? 'Recordings'}
          </h2>
          {description && (
            <p className="mt-1 text-xs text-neutral-400">{description}</p>
          )}
        </div>
        <motion.button
          type="button"
          onClick={loadRecordings}
          disabled={isLoading || !settings.outputFolder}
          className="inline-flex h-7 items-center gap-1 rounded-sm border border-white/20 bg-black/20 px-2 text-xs text-neutral-200 transition-colors hover:bg-white/10 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:opacity-50"
          {...pressFeedback}
        >
          <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </motion.button>
      </div>

      {settings.outputFolder && (
        <FormField id="library-recordings-search" label="Search" className="mb-2">
          <Input
            id="library-recordings-search"
            type="search"
            variant="filter"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search by title, zone, encounter, or file name"
          />
        </FormField>
      )}

      {displayError && <p className="mb-2 text-xs text-red-300" role="status">{displayError}</p>}

      <div
        ref={recordingsContainerRef}
        tabIndex={-1}
        className="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]"
        aria-busy={isLoading}
      >
        {!settings.outputFolder ? (
          <p className="px-1 py-6 text-sm text-neutral-400">
            Choose an output folder in Settings to see recordings here.
          </p>
        ) : scopedRecordings.length === 0 && !isLoading ? (
          <div className="px-1 py-6">
            <p className="text-sm text-neutral-300">{emptyMessage ?? "No recordings in this folder yet"}</p>
            <p className="mt-1 text-xs text-neutral-500">{settings.outputFolder}</p>
          </div>
        ) : filteredRecordings.length === 0 && !isLoading ? (
          <div className="px-1 py-6">
            <p className="text-sm text-neutral-300">No recordings match your search</p>
            <p className="mt-1 text-xs text-neutral-500">
              Try a different title, zone, encounter, or file name.
            </p>
          </div>
        ) : (
          <>
            {showManagementActions && (
              <div className="mb-1 flex items-center justify-between gap-2 border-b border-white/10 pb-1.5">
              <div className="flex items-center gap-1">
                <label className="ml-2 inline-flex h-6 w-6 items-center justify-center">
                  <input
                    type="checkbox"
                    checked={visibleSelectedCount > 0 && visibleSelectedCount === filteredRecordings.length}
                    ref={(el) => {
                      if (el) {
                        el.indeterminate = visibleSelectedCount > 0 && visibleSelectedCount < filteredRecordings.length;
                      }
                    }}
                    onChange={visibleSelectedCount === filteredRecordings.length ? clearSelection : selectAll}
                    disabled={isActionLocked || filteredRecordings.length === 0}
                     className="h-3.5 w-3.5 rounded-sm border-white/30 bg-black/30 accent-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60 disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={selectedRecordingCount === filteredRecordings.length ? "Deselect all recordings" : "Select all recordings"}
                  />
                </label>
                <span className="text-[11px] text-neutral-400">
                  {selectedRecordingCount > 0 ? `${selectedRecordingCount} selected` : ''}
                </span>
              </div>

              <div className="flex items-center gap-1">
                {selectedRecordingCount > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={clearSelection}
                      disabled={isActionLocked}
                      className="inline-flex h-6 items-center gap-1 rounded-sm border border-white/20 bg-black/20 px-2 text-xs text-neutral-200 transition-colors hover:bg-white/10 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <XCircle className="h-3.5 w-3.5 shrink-0" />
                      Clear
                    </button>
                    <button
                    type="button"
                    onClick={() => {
                      void handleCompareSelectedRecordings();
                    }}
                    disabled={isActionLocked || !canEnterCompareMode(selectedRecordingCount)}
                    title={
                      canEnterCompareMode(selectedRecordingCount)
                        ? "Compare the two selected recordings"
                        : "Select exactly two recordings to compare"
                    }
                    className="inline-flex h-6 items-center gap-1 rounded-sm border border-white/20 bg-black/20 px-2 text-xs text-neutral-200 transition-colors hover:bg-white/10 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Columns2 className="h-3.5 w-3.5 shrink-0" />
                    Compare
                  </button>
                    <button
                      type="button"
                      onClick={handleDeleteSelectedRecordings}
                      disabled={isActionLocked || selectedRecordings.length === 0}
                      className="inline-flex h-6 items-center gap-1 rounded-sm border border-rose-300/35 bg-rose-500/14 px-2 text-xs font-medium text-rose-100 transition-colors hover:bg-rose-500/22 hover:text-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/60 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5 shrink-0" />
                      Delete selected
                    </button>
                  </>
                )}
                <motion.button
                  type="button"
                  onClick={loadRecordings}
                  disabled={isLoading || !settings.outputFolder}
                  className="inline-flex h-6 items-center gap-1 rounded-sm border border-white/20 bg-black/20 px-2 text-xs text-neutral-200 transition-colors hover:bg-white/10 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:opacity-50"
                  {...pressFeedback}
                >
                  <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${isLoading ? 'animate-spin' : ''}`} />
                  Refresh
                </motion.button>
              </div>
              </div>
            )}

            <ul className="space-y-1" role="list">
            {filteredRecordings.map((recording) => {
              const isLoadedRecording = loadedFilePath === recording.file_path;
              const isSelectedRecording = selectedRecordingPathSet.has(recording.file_path);
              const isActiveRecording = activeRecordingPath === recording.file_path;
              const isComparedRecording = isComparedRecordingPath(recording.file_path, compareVideos);
              const displayTitle = getRecordingDisplayTitle(recording, gameModeContext);

              return (
                <motion.li
                  key={`${recording.filename}-${recording.created_at}`}
                  className={`grid w-full ${showManagementActions ? "grid-cols-[auto_minmax(0,1fr)_auto]" : "grid-cols-1"} items-center gap-1 rounded-sm border text-left transition-colors hover:bg-white/5 ${
                    isLoadedRecording || isActiveRecording || isComparedRecording
                      ? 'border-emerald-300/45 bg-emerald-500/16 hover:border-emerald-300/55'
                      : isSelectedRecording
                          ? 'border-emerald-300/35 bg-emerald-500/10 hover:border-emerald-300/45'
                      : 'border-white/10 bg-black/20 hover:border-white/25'
                  }`}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={smoothTransition}
                >
                  {showManagementActions && (
                    <label className="ml-2 inline-flex h-6 w-6 items-center justify-center">
                      <input
                        type="checkbox"
                        checked={isSelectedRecording}
                        readOnly
                        onMouseDown={(event) => handleSelectionControlMouseDown(event, recording.file_path)}
                        onClick={handleSelectionControlClick}
                        disabled={isActionLocked}
                        className="h-3.5 w-3.5 rounded-sm border-white/30 bg-black/30 accent-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60 disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label={`Select recording ${displayTitle}`}
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    onMouseDown={
                      showManagementActions
                        ? (event) => handleRecordingRowMouseDown(event, recording)
                        : undefined
                    }
                    onClick={(event) => {
                      if (showManagementActions) {
                        handleRecordingRowClick(event, recording);
                        return;
                      }

                      void handleLoadRecording(recording);
                    }}
                    disabled={isActionLocked}
                    aria-current={
                      isLoadedRecording || isActiveRecording || isComparedRecording
                        ? 'true'
                        : undefined
                    }
                    className="min-w-0 flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="min-w-0 flex items-center gap-2">
                      <HardDrive className="w-3.5 h-3.5 text-neutral-300/80 shrink-0" />
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="block truncate text-xs text-neutral-200" title={displayTitle}>
                            {displayTitle}
                          </span>
                          {!gameModeContext && inferRecordingMode(recording) && (
                            <span className="shrink-0 rounded-full border border-emerald-300/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-200">
                              {formatEncounterCategory(inferRecordingMode(recording) ?? undefined)}
                            </span>
                          )}
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
                  {showManagementActions && (
                    <button
                      type="button"
                      onClick={() => handleDeleteRecording(recording)}
                      disabled={isRecording || Boolean(loadingRecordingPath) || isDeletingRecordings}
                      className="mr-1 inline-flex h-6 w-6 items-center justify-center rounded-sm border border-rose-300/25 bg-rose-500/10 text-rose-200 transition-colors hover:bg-rose-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/60 disabled:cursor-not-allowed disabled:opacity-50"
                      title="Delete recording"
                      aria-label={`Delete recording ${recording.filename}`}
                    >
                      <Trash2 className={`h-3.5 w-3.5 ${deletingRecordingPathSet.has(recording.file_path) ? 'animate-pulse' : ''}`} />
                    </button>
                  )}
                </motion.li>
              );
            })}
            </ul>
          </>
        )}
      </div>

      {hasPendingDeleteRecordings && (
        <DeleteConfirmDialog
          titleId="delete-recording-title"
          descriptionId="delete-recording-description"
          fallbackFocusRef={recordingsContainerRef}
          title={isBulkDelete ? 'Delete recordings?' : 'Delete recording?'}
          description={
            isBulkDelete ? (
              <>
                This will permanently delete{" "}
                <span className="font-medium text-neutral-100">{pendingDeleteCount} recordings</span>.
                This action cannot be undone.
              </>
            ) : (
              <>
                This will permanently delete{" "}
                <span className="font-medium text-neutral-100">{pendingDeleteRecordings[0].filename}</span>.
                This action cannot be undone.
              </>
            )
          }
          isDeleting={isDeletingRecordings}
          confirmLabel={isBulkDelete ? 'Delete selected' : 'Delete'}
          onConfirm={confirmDeleteRecording}
          onCancel={cancelDeleteRecording}
        />
      )}
    </motion.section>
  );
}
