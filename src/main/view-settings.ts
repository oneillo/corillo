// What Corillo remembers about its window between launches, the same for
// every document: the zoom (zoom.ts), how wide the side panel and the
// Markdown view's two halves are, and whether the person hid the Comments
// panel. All in the data folder's view.json.
import { app, ipcMain } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { savedSide, savedSplit } from "../core/columns";
import { writeAtomic } from "./store";

// Read lazily: the data folder is only known once main.ts has set it.
const settingsFile = () => path.join(app.getPath("userData"), "view.json");

export function readView(): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Remember these settings, keeping the others. */
export function writeView(changes: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    writeAtomic(settingsFile(), JSON.stringify({ ...readView(), ...changes }, null, 2));
  } catch {
    // Remembering it is a convenience; the change still applies.
  }
}

export interface Columns {
  /** The side panel's width, as the person chose it. */
  side: number;
  /** The Markdown text's share of the Markdown view. */
  split: number;
}

function columns(): Columns {
  const saved = readView();
  return { side: savedSide(saved.sideWidth), split: savedSplit(saved.splitShare) };
}

// The column widths, after remembering any given.
ipcMain.handle("view:columns", (_e, changes: unknown): Columns => {
  if (changes && typeof changes === "object") {
    const { side, split } = changes as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    if (side !== undefined) next.sideWidth = savedSide(side);
    if (split !== undefined) next.splitShare = savedSplit(split);
    if (Object.keys(next).length > 0) writeView(next);
  }
  return columns();
});

// Whether the person hid the Comments panel, after remembering it if told.
ipcMain.handle("view:comments-hidden", (_e, hidden: unknown): boolean => {
  if (typeof hidden === "boolean") writeView({ commentsHidden: hidden });
  return readView().commentsHidden === true;
});
