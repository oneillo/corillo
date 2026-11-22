// Version history, wired into the app: main.ts and doc-on-disk.ts tell it when
// a document is opened, saved or changed outside Corillo, and the window asks it for
// versions. Agents reach it through the hooks in main.ts (beginPass, endPass,
// list and text); what they read is worded in agents/looking-back.ts.
import { app, ipcMain } from "electron";
import * as fs from "node:fs";
import { VersionHistory } from "./version-store";
import type { Conversation, HistoryKnown, HistoryList, RestoreResult, RowStory, SinceHandOver, StoryAsk, VersionTexts } from "../core/versions";

interface OpenTab {
  id: string;
  /** The document's record in the data folder. */
  storeId: string;
}

let instance: VersionHistory | null = null;
let openTabs: () => Iterable<OpenTab> = () => [];
/** Tells the document window (main.ts's own route to it, never Help's or another window). */
let tell: (tabId: string) => void = () => {};

/**
 * The version history, in Corillo's data folder. Made on first use, because
 * the data folder is only settled once main.ts has started (tests point it at
 * a throwaway folder).
 */
export function versionHistory(): VersionHistory {
  if (!instance) {
    instance = new VersionHistory(app.getPath("userData"));
    instance.onChange = tellWindow;
  }
  return instance;
}

function tellWindow(docId: string): void {
  for (const tab of openTabs()) {
    if (tab.storeId === docId) tell(tab.id);
  }
}

/** History is a record kept alongside; a problem with it never stops opening or saving a document. */
function quietly(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(`Version history: couldn't record ${what}.`, err);
  }
}

const h = () => versionHistory();

/** Called by main.ts and doc-on-disk.ts at the moments the history needs to know about. */
export const historyHooks = {
  /** A document was opened. True if an agent has a version in its history. */
  opened(filePath: string, text: string): boolean {
    let agentWorked = false;
    quietly("an opened document", () => {
      agentWorked = h().seen(h().idFor(filePath), text);
    });
    return agentWorked;
  },
  /** Corillo wrote the document's file (the caller has noted the file's identity in the list of documents). */
  saved(id: string, text: string): void {
    quietly("a save", () => h().edited(id, text));
  },
  /** About to write over a file that changed outside Corillo (the person chose to keep theirs): keep the other text as a version. */
  overwriting(filePath: string, lastKnown: string): void {
    quietly("an outside change", () => {
      let disk: string;
      try {
        disk = fs.readFileSync(filePath, "utf8");
      } catch {
        return;
      }
      if (disk !== lastKnown) h().outside(h().idFor(filePath), disk);
    });
  },
  /** The file changed outside Corillo and Corillo took the new text. */
  outside(filePath: string, text: string): void {
    quietly("an outside change", () => h().outside(h().idFor(filePath), text));
  },
};

/** Answer the window's questions about the history of the documents in its tabs; `changed` tells it a tab's history changed. */
export function registerHistory(tabs: () => Iterable<OpenTab>, changed: (tabId: string) => void): void {
  openTabs = tabs;
  tell = changed;
  const docId = (tabId: string): string => {
    for (const tab of openTabs()) if (tab.id === tabId) return tab.storeId;
    throw new Error("That document isn't open.");
  };

  // What the panel's rows show; given what the window has, only what's new (agents read the whole history through list()).
  ipcMain.handle("history:list", (_e, tabId: string, known?: HistoryKnown): HistoryList => {
    const id = docId(tabId);
    return { ...h().rows(id, known), holder: h().holder(id) };
  });

  ipcMain.handle("history:version", (_e, tabId: string, n: number): VersionTexts => h().versionTexts(docId(tabId), n));

  // History reads as the story (roadmap Batch 4, item 2): what the rows in sight changed, and
  // several of the person's versions in a row shown together, the newest compared with the one before them.
  ipcMain.handle("history:stories", (_e, tabId: string, asks: unknown): Promise<Record<string, RowStory>> =>
    h().stories(docId(tabId), Array.isArray(asks) ? asks.filter(isAsk) : []),
  );
  ipcMain.handle("history:compare", (_e, tabId: string, n: number, base: number): VersionTexts =>
    h().versionTexts(docId(tabId), n, Number.isInteger(base) ? base : undefined),
  );

  // Show changes: everything since the person last handed the document over (roadmap Batch 3, item 1).
  ipcMain.handle("history:since", (_e, tabId: string): SinceHandOver => h().sinceHandOver(docId(tabId)));

  // The whole conversation, for the one version open in the panel.
  ipcMain.handle("history:conversation", (_e, tabId: string, n: number): Conversation | null => h().conversation(docId(tabId), n));

  ipcMain.handle("history:restore", (_e, tabId: string, n: number): RestoreResult => h().prepareRestore(docId(tabId), n));
}

/** A row's story asked for by the window: a version's number, or the first and last of several shown as one. */
function isAsk(x: unknown): x is StoryAsk {
  if (Number.isInteger(x)) return true;
  const fold = x as { from?: unknown; to?: unknown } | null;
  return typeof fold === "object" && fold !== null && Number.isInteger(fold.from) && Number.isInteger(fold.to);
}
