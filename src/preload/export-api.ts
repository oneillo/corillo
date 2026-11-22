// The window's side of Word and PDF export (part of the bridge in preload.ts).
import { ipcRenderer } from "electron";
import type { ExportFormat, ExportOutcome } from "../main/export";
import type { ExportSettings } from "../main/export-prep";

export type { ExportFormat, ExportOutcome, ExportSettings };
export type ExportFileKind = "word" | "lua" | "script";

export const exportApi = {
  /** Ask where to save the export; null if the person cancelled. */
  chooseExportPath: (id: string, format: ExportFormat): Promise<string | null> =>
    ipcRenderer.invoke("export:choose-path", id, format),
  exportDocument: (id: string, format: ExportFormat, outputPath: string): Promise<ExportOutcome> =>
    ipcRenderer.invoke("export:run", id, format, outputPath),
  exportSettings: (id: string): Promise<ExportSettings> => ipcRenderer.invoke("export:get-settings", id),
  /** Store a document's export settings; false if refused (a file in them the person didn't choose). */
  saveExportSettings: (id: string, settings: ExportSettings): Promise<boolean> =>
    ipcRenderer.invoke("export:set-settings", id, settings),
  /** Ask for a file for one of a document's export settings; it may then be stored for that document and setting only. */
  chooseExportFile: (id: string, kind: ExportFileKind): Promise<string | null> => ipcRenderer.invoke("export:choose-file", id, kind),
  /** Open an exported file in its app; resolves to a problem, if there was one. */
  openExported: (filePath: string): Promise<string | null> => ipcRenderer.invoke("export:open", filePath),
  showExported: (filePath: string): Promise<void> => ipcRenderer.invoke("export:reveal", filePath),
  /** An agent exported a document. */
  onAgentExported: (cb: (done: AgentExport) => void) => {
    ipcRenderer.on("export:by-agent", (_e, done: AgentExport) => cb(done));
  },
};

export interface AgentExport {
  outputPath: string;
  name: string;
  notes: string[];
  agent: string;
  /** The tab of the document exported, for its notice. */
  docId?: string;
}
