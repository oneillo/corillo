// The bridge for the About Corillo window: it can read the licences and ask
// for two things to be opened, nothing else.
import { contextBridge, ipcRenderer } from "electron";
import type { AboutInfo } from "../main/about";

const api = {
  info: (): Promise<AboutInfo> => ipcRenderer.invoke("about:info"),
  openChromiumNotices: (): Promise<void> => ipcRenderer.invoke("about:open-chromium-notices"),
  openPandocSource: (): Promise<void> => ipcRenderer.invoke("about:open-pandoc-source"),
};

export type CorilloAboutApi = typeof api;
contextBridge.exposeInMainWorld("corilloAbout", api);
