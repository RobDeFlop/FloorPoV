interface PlaybackRecordingItem {
  file_path: string;
}

export function isPlaybackRecordingMissing(
  loadedFilePath: string | null,
  recordings: PlaybackRecordingItem[],
): boolean {
  if (!loadedFilePath) {
    return false;
  }

  return !recordings.some((recording) => recording.file_path === loadedFilePath);
}

export function shouldClearStalePlayback(
  loadedFilePath: string | null,
  hasVideoSrc: boolean,
  recordings: PlaybackRecordingItem[],
): boolean {
  if (loadedFilePath) {
    return isPlaybackRecordingMissing(loadedFilePath, recordings);
  }

  return hasVideoSrc && recordings.length === 0;
}
