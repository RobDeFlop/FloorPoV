import { useEffect, useRef } from "react";

interface UsePreviewOptions {
  previewFrameUrl: string | null;
  width: number;
  height: number;
  enabled: boolean;
}

export function usePreview({ previewFrameUrl, width, height, enabled }: UsePreviewOptions) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!enabled || !previewFrameUrl || !canvasRef.current) {
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      return;
    }

    const img = new Image();
    img.onload = () => {
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);
    };

    img.onerror = (error) => {
      console.error("Failed to load preview frame:", error);
    };

    img.src = previewFrameUrl;
  }, [previewFrameUrl, width, height, enabled]);

  return canvasRef;
}
