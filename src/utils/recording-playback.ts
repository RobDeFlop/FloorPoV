import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export function recordingsFolderFromFilePath(filePath: string): string | null {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return null;
  }

  const withoutTrailingSlash = trimmed.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(
    withoutTrailingSlash.lastIndexOf("\\"),
    withoutTrailingSlash.lastIndexOf("/"),
  );
  if (separatorIndex < 0) {
    return null;
  }

  const folderPath = withoutTrailingSlash.slice(0, separatorIndex);
  if (!folderPath) {
    return null;
  }

  if (/^[A-Za-z]:$/.test(folderPath)) {
    return `${folderPath}\\`;
  }

  return folderPath;
}

export async function allowRecordingsFolderForPlayback(folderPath: string): Promise<void> {
  const trimmed = folderPath.trim();
  if (!trimmed) {
    return;
  }

  await invoke("allow_recordings_folder", { folderPath: trimmed });
}

export async function toPlaybackSource(filePath: string, folderPath?: string): Promise<string> {
  const folder = folderPath?.trim() || recordingsFolderFromFilePath(filePath);
  if (folder) {
    await allowRecordingsFolderForPlayback(folder);
  }

  return convertFileSrc(filePath);
}
