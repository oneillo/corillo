// The bridge for the Help window: going to a page, the settings to paste for
// each agent tool, and bringing up the Connect screen. Nothing else: Help
// never opens, saves or reads a document.
import { contextBridge, ipcRenderer } from "electron";
import type { ManualEntry } from "../main/agent-tools";

const api = {
  agents: {
    /** `moveFirst`: Corillo runs from its disk image or a place it's passing through, so the settings would break later. */
    manual: (): Promise<{ tools: ManualEntry[]; other: string; moveFirst: boolean }> => ipcRenderer.invoke("agents:manual"),
    /** Copy a tool's snippet, or where its settings file is ("where"). */
    copy: (id: string, what: "snippet" | "where" = "snippet"): Promise<boolean> => ipcRenderer.invoke("agents:copy", id, what),
    showConnect: (): Promise<void> => ipcRenderer.invoke("agents:show-connect"),
  },
  help: {
    onPage: (cb: (page: string) => void) => {
      ipcRenderer.on("help:page", (_e, page: string) => cb(page));
    },
  },
};

export type CorilloHelpApi = typeof api;
contextBridge.exposeInMainWorld("corilloHelp", api);
