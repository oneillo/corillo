// The bridge for the hidden page Corillo exports documents with: the app
// asks it to show a document or draw diagrams, and it answers.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("corilloExportPage", {
  onRequest(handler: (kind: string, payload: unknown) => Promise<unknown>): void {
    ipcRenderer.on("export-page:request", async (_e, id: string, kind: string, payload: unknown) => {
      try {
        ipcRenderer.send("export-page:reply", id, { value: await handler(kind, payload) });
      } catch (err) {
        ipcRenderer.send("export-page:reply", id, { error: err instanceof Error ? err.message : String(err) });
      }
    });
  },
});
