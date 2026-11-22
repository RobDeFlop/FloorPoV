export interface VideoFrameSource {
  readyState: number;
  videoWidth: number;
  videoHeight: number;
}

const HAVE_CURRENT_DATA = 2;

export function screenshotFileStemFromPath(filePath: string | null | undefined): string {
  if (!filePath) {
    return "screenshot";
  }

  const normalizedPath = filePath.replace(/\\/g, "/");
  const fileName = normalizedPath.split("/").pop() ?? "";
  const separatorIndex = fileName.lastIndexOf(".");
  const fileStem = separatorIndex > 0 ? fileName.slice(0, separatorIndex) : fileName;
  return fileStem.trim() || "screenshot";
}

export function getVideoFrameCaptureError(video: VideoFrameSource): string | null {
  if (video.readyState < HAVE_CURRENT_DATA) {
    return "The video frame is not ready yet.";
  }

  if (video.videoWidth <= 0 || video.videoHeight <= 0) {
    return "The video has no visible frame to capture.";
  }

  return null;
}

export function captureVideoFrameDataUrl(video: HTMLVideoElement): string {
  const captureError = getVideoFrameCaptureError(video);
  if (captureError) {
    throw new Error(captureError);
  }

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  const canvasContext = canvas.getContext("2d");
  if (!canvasContext) {
    throw new Error("Could not create a drawing surface for the screenshot.");
  }

  canvasContext.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);

  try {
    return canvas.toDataURL("image/png");
  } catch {
    throw new Error("Could not read the current video frame.");
  }
}

export function screenshotFileNameFromPath(savedPath: string): string {
  const normalizedPath = savedPath.replace(/\\/g, "/");
  return normalizedPath.split("/").pop() || savedPath;
}
