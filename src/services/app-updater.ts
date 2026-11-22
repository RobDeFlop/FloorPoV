import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type AppUpdateResult = "up-to-date" | "installed";

export async function installAvailableAppUpdate(
  onStatus: (message: string) => void,
): Promise<AppUpdateResult> {
  const update = await check();
  if (!update) {
    return "up-to-date";
  }

  onStatus("Update found. Downloading and installing...");
  let downloadedBytes = 0;
  let contentLength: number | null = null;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started": {
        contentLength = event.data.contentLength ?? null;
        if (!contentLength || contentLength <= 0) {
          onStatus("Update found. Downloading and installing...");
          return;
        }

        onStatus("Update found. Downloading update (0%)...");
        return;
      }
      case "Progress": {
        downloadedBytes += event.data.chunkLength;
        if (contentLength && contentLength > 0) {
          const progressPercent = Math.min(99, Math.floor((downloadedBytes / contentLength) * 100));
          onStatus(`Update found. Downloading update (${progressPercent}%)...`);
          return;
        }

        const downloadedMiB = downloadedBytes / (1024 * 1024);
        onStatus(`Update found. Downloaded ${downloadedMiB.toFixed(1)} MiB...`);
        return;
      }
      case "Finished": {
        onStatus("Download complete. Installing update...");
      }
    }
  });

  onStatus("Update installed. Restarting app...");
  await relaunch();
  return "installed";
}
