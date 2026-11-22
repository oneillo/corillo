// Zoom: View > Zoom In, Zoom Out and Actual Size scale the page (not the
// toolbar), as in Word. The level is remembered between launches, in the data
// folder's view.json (see view-settings.ts).
import { BrowserWindow, ipcMain, type MenuItemConstructorOptions } from "electron";
import { readView, writeView } from "./view-settings";

const LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export type ZoomChange = "in" | "out" | "reset";

let level: number | null = null;

function current(): number {
  if (level === null) {
    // Read lazily: the data folder is only known once main.ts has set it.
    const saved = readView().zoom;
    level = typeof saved === "number" && LEVELS.includes(saved) ? saved : 1;
  }
  return level;
}

export function zoom(change: ZoomChange): number {
  const i = LEVELS.indexOf(current());
  level = change === "reset" ? 1 : LEVELS[Math.max(0, Math.min(LEVELS.length - 1, i + (change === "in" ? 1 : -1)))];
  writeView({ zoom: level });
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("view:zoom", level);
  return level;
}

ipcMain.handle("view:zoom", (_e, change: unknown) =>
  change === "in" || change === "out" || change === "reset" ? zoom(change) : current(),
);

export function zoomMenuItems(): MenuItemConstructorOptions[] {
  return [
    { id: "zoom-reset", label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => zoom("reset") },
    { id: "zoom-in", label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => zoom("in") },
    // Cmd++ (with Shift) zooms in too, as in other Mac apps.
    { id: "zoom-in-plus", label: "Zoom In", accelerator: "CmdOrCtrl+Plus", visible: false, click: () => zoom("in") },
    { id: "zoom-out", label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => zoom("out") },
  ];
}
