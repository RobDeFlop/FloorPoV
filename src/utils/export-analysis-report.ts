import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { RecordingMetadata } from "../types/events";
import {
  buildAnalysisReportContents,
  ensureAnalysisReportDestination,
  recordingFileStem,
  suggestedAnalysisReportFilename,
} from "./analysis-report";

export type ExportAnalysisReportResult = "saved" | "cancelled";

export async function exportAnalysisReport(
  recordingPath: string,
): Promise<ExportAnalysisReportResult> {
  const normalizedPath = recordingPath.trim();
  if (!normalizedPath) {
    throw new Error("Select a recording before exporting a report.");
  }

  const metadata = await invoke<RecordingMetadata | null>("get_recording_metadata", {
    filePath: normalizedPath,
  });
  const recordingFile = metadata?.recordingFile ?? `${recordingFileStem(normalizedPath)}.mp4`;

  const destination = await save({
    title: "Export analysis report",
    defaultPath: suggestedAnalysisReportFilename(recordingFile, "md"),
    filters: [
      { name: "Markdown", extensions: ["md"] },
      { name: "JSON", extensions: ["json"] },
    ],
  });

  if (!destination) {
    return "cancelled";
  }

  const exportPath = ensureAnalysisReportDestination(destination);
  const contents = buildAnalysisReportContents(exportPath, metadata, recordingFile);

  await invoke("write_export_file", {
    filePath: exportPath,
    contents,
  });

  return "saved";
}
