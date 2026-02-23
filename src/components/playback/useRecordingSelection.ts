import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';

interface RecordingSelectionItem {
  file_path: string;
}

interface UseRecordingSelectionOptions<T extends RecordingSelectionItem> {
  recordings: T[];
  isActionLocked: boolean;
  onPlainActivate: (recording: T) => void;
}

interface UseRecordingSelectionResult<T extends RecordingSelectionItem> {
  selectedRecordingPaths: string[];
  selectedRecordingPathSet: Set<string>;
  selectedRecordingCount: number;
  selectedRecordings: T[];
  selectAll: () => void;
  clearSelection: () => void;
  handleRecordingRowClick: (event: MouseEvent<HTMLButtonElement>, recording: T) => void;
  handleRecordingRowMouseDown: (event: MouseEvent<HTMLButtonElement>, recording: T) => void;
  handleSelectionControlClick: (event: MouseEvent<HTMLInputElement>) => void;
  handleSelectionControlMouseDown: (event: MouseEvent<HTMLInputElement>, recordingPath: string) => void;
  updateSelectionAfterDelete: (deletedPaths: Set<string>, failedDeletePaths: string[]) => void;
}

export function useRecordingSelection<T extends RecordingSelectionItem>({
  recordings,
  isActionLocked,
  onPlainActivate,
}: UseRecordingSelectionOptions<T>): UseRecordingSelectionResult<T> {
  const [selectedRecordingPaths, setSelectedRecordingPaths] = useState<string[]>([]);
  const [selectionAnchorPath, setSelectionAnchorPath] = useState<string | null>(null);
  const suppressRowClickPathRef = useRef<string | null>(null);

  const selectedRecordingPathSet = useMemo(() => {
    return new Set(selectedRecordingPaths);
  }, [selectedRecordingPaths]);

  const selectedRecordings = useMemo(() => {
    return recordings.filter((recording) => selectedRecordingPathSet.has(recording.file_path));
  }, [recordings, selectedRecordingPathSet]);

  const clearSelection = useCallback(() => {
    setSelectedRecordingPaths([]);
    setSelectionAnchorPath(null);
  }, []);

  const selectAll = useCallback(() => {
    const allPaths = recordings.map((recording) => recording.file_path);
    setSelectedRecordingPaths(allPaths);
  }, [recordings]);

  const toggleRecordingSelection = useCallback((recordingPath: string) => {
    setSelectedRecordingPaths((previousSelectedPaths) => {
      if (previousSelectedPaths.includes(recordingPath)) {
        return previousSelectedPaths.filter((path) => path !== recordingPath);
      }

      return [...previousSelectedPaths, recordingPath];
    });

    setSelectionAnchorPath(recordingPath);
  }, []);

  const selectRecordingRange = useCallback((recordingPath: string, appendToSelection: boolean) => {
    const targetIndex = recordings.findIndex((recording) => recording.file_path === recordingPath);
    if (targetIndex < 0) {
      return;
    }

    const anchorPath = selectionAnchorPath ?? recordingPath;
    const anchorIndex = recordings.findIndex((recording) => recording.file_path === anchorPath);
    const normalizedAnchorIndex = anchorIndex >= 0 ? anchorIndex : targetIndex;
    const startIndex = Math.min(normalizedAnchorIndex, targetIndex);
    const endIndex = Math.max(normalizedAnchorIndex, targetIndex);
    const rangePaths = recordings
      .slice(startIndex, endIndex + 1)
      .map((recording) => recording.file_path);
    const normalizedRangePaths = Array.from(new Set([...rangePaths, recordingPath]));

    setSelectedRecordingPaths((previousSelectedPaths) => {
      if (!appendToSelection) {
        return normalizedRangePaths;
      }

      const nextPathSet = new Set(previousSelectedPaths);
      normalizedRangePaths.forEach((path) => {
        nextPathSet.add(path);
      });
      return Array.from(nextPathSet);
    });

    setSelectionAnchorPath(recordingPath);
  }, [recordings, selectionAnchorPath]);

  const applySelectionShortcut = useCallback((event: MouseEvent<HTMLElement>, recordingPath: string) => {
    if (isActionLocked) {
      event.preventDefault();
      return true;
    }

    const shouldAppendToSelection = event.metaKey || event.ctrlKey;
    if (!event.shiftKey && !shouldAppendToSelection) {
      return false;
    }

    event.preventDefault();

    if (event.shiftKey) {
      selectRecordingRange(recordingPath, shouldAppendToSelection);
      return true;
    }

    toggleRecordingSelection(recordingPath);
    return true;
  }, [isActionLocked, selectRecordingRange, toggleRecordingSelection]);

  const handleRecordingRowClick = useCallback((event: MouseEvent<HTMLButtonElement>, recording: T) => {
    if (suppressRowClickPathRef.current === recording.file_path) {
      suppressRowClickPathRef.current = null;
      return;
    }

    if (applySelectionShortcut(event, recording.file_path)) {
      return;
    }

    onPlainActivate(recording);
  }, [applySelectionShortcut, onPlainActivate]);

  const handleRecordingRowMouseDown = useCallback((event: MouseEvent<HTMLButtonElement>, recording: T) => {
    if (applySelectionShortcut(event, recording.file_path)) {
      suppressRowClickPathRef.current = recording.file_path;
      return;
    }

    suppressRowClickPathRef.current = null;
  }, [applySelectionShortcut]);

  const handleSelectionControlMouseDown = useCallback((event: MouseEvent<HTMLInputElement>, recordingPath: string) => {
    event.stopPropagation();

    if (applySelectionShortcut(event, recordingPath)) {
      return;
    }

    event.preventDefault();
    toggleRecordingSelection(recordingPath);
  }, [applySelectionShortcut, toggleRecordingSelection]);

  const handleSelectionControlClick = useCallback((event: MouseEvent<HTMLInputElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const updateSelectionAfterDelete = useCallback((deletedPaths: Set<string>, failedDeletePaths: string[]) => {
    setSelectedRecordingPaths((previousSelectedPaths) => {
      const remainingSelectedPaths = previousSelectedPaths.filter((path) => !deletedPaths.has(path));

      if (failedDeletePaths.length === 0) {
        return remainingSelectedPaths;
      }

      const nextPathSet = new Set(remainingSelectedPaths);
      failedDeletePaths.forEach((path) => {
        nextPathSet.add(path);
      });

      return Array.from(nextPathSet);
    });

    if (failedDeletePaths.length > 0) {
      setSelectionAnchorPath(failedDeletePaths[failedDeletePaths.length - 1] ?? null);
      return;
    }

    setSelectionAnchorPath((previousAnchorPath) => {
      if (previousAnchorPath && deletedPaths.has(previousAnchorPath)) {
        return null;
      }

      return previousAnchorPath;
    });
  }, []);

  useEffect(() => {
    if (recordings.length === 0) {
      setSelectedRecordingPaths([]);
      setSelectionAnchorPath(null);
      return;
    }

    const availablePathSet = new Set(recordings.map((recording) => recording.file_path));

    setSelectedRecordingPaths((previousSelectedPaths) => {
      const nextSelectedPaths = previousSelectedPaths.filter((path) => availablePathSet.has(path));
      return nextSelectedPaths.length === previousSelectedPaths.length
        ? previousSelectedPaths
        : nextSelectedPaths;
    });

    setSelectionAnchorPath((previousAnchorPath) => {
      if (!previousAnchorPath || availablePathSet.has(previousAnchorPath)) {
        return previousAnchorPath;
      }

      return null;
    });
  }, [recordings]);

  return {
    selectedRecordingPaths,
    selectedRecordingPathSet,
    selectedRecordingCount: selectedRecordingPaths.length,
    selectedRecordings,
    selectAll,
    clearSelection,
    handleRecordingRowClick,
    handleRecordingRowMouseDown,
    handleSelectionControlClick,
    handleSelectionControlMouseDown,
    updateSelectionAfterDelete,
  };
}
