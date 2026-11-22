import { useState } from "react";
import { Download, LoaderCircle } from "lucide-react";
import { getErrorMessage } from "../../services/tauri";
import { exportAnalysisReport } from "../../utils/export-analysis-report";

interface ExportAnalysisReportButtonProps {
  recordingPath: string | null;
  disabled?: boolean;
}

export function ExportAnalysisReportButton({
  recordingPath,
  disabled = false,
}: ExportAnalysisReportButtonProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [status, setStatus] = useState<{ tone: "success" | "error"; message: string } | null>(
    null,
  );

  const isDisabled = disabled || isExporting || !recordingPath;

  const handleExport = async () => {
    if (isDisabled || !recordingPath) {
      return;
    }

    setIsExporting(true);
    setStatus(null);

    try {
      const result = await exportAnalysisReport(recordingPath);
      if (result === "saved") {
        setStatus({ tone: "success", message: "Report saved." });
      }
    } catch (error) {
      console.error("Failed to export analysis report:", error);
      setStatus({
        tone: "error",
        message: getErrorMessage(error) || "Could not export the analysis report.",
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => {
          void handleExport();
        }}
        disabled={isDisabled}
        className="inline-flex h-7 items-center gap-1 rounded-sm border border-white/20 bg-black/20 px-2 text-xs text-neutral-200 transition-colors hover:bg-white/10 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isExporting ? (
          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : (
          <Download className="h-3.5 w-3.5 shrink-0" />
        )}
        {isExporting ? "Exporting..." : "Export report"}
      </button>
      {status && (
        <p
          className={`max-w-[18rem] text-right text-[11px] ${
            status.tone === "error" ? "text-rose-200" : "text-emerald-200"
          }`}
          role="status"
        >
          {status.message}
        </p>
      )}
    </div>
  );
}
