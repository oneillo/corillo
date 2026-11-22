// Corillo's main process: one window with a tab for each open document. It
// opens the files and keeps the list of recent documents; the files' saves
// and watching are in doc-on-disk.ts, and the menus in menus.ts.
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  screen,
  shell,
  type WebContents,
} from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
// First: every channel the app sets up answers only the window it's for.
import { plainWebRequests, refusePermissions, windowIs } from "./window-boundary";
import type { Anchor } from "../core/anchors";
import type { AnchorUpdate, Author, PassNote, Thread } from "../core/comments";
import { cleanSpans, cleanUndo } from "../core/options";
import { CommentService, attempt, type ChangeAnchorReport } from "./comment-service";
import { repairConnections, sessionsConnected, setUpAgentConnections } from "./connect-agents";
import { registerExport } from "./export";
import { historyHooks, registerHistory, versionHistory } from "./history";
import { forgetDoneTicks } from "./outline";
import { setUpAgents } from "./agents/host";
import { agentsConnected, rememberAgents } from "./known-agents";
import { socketPathFor } from "../mcp/socket-path";
import { buildMenu, setUpMenus, windowClosed } from "./menus";
import { rememberWordCopy } from "./export";
import { pandocPath, run, wordWorksHere } from "./pandoc";
import { WORD_NEEDS_NEWER_MAC } from "./export-prep";
import {
  canWriteIn, clearCopyWork, copyNotice, copyPlace, copyQuestion, isOldWordDocument, isWordDocument, lookInWord, makeWordCopy, OLD_WORD_FORMAT, WordCopyProblem,
  type CopyMade,
  type WordContents,
} from "./word-copy";
import { FileProblem, imagesFolder, LONG_DOCUMENT_BYTES, MAX_DOCUMENT_BYTES, megabytes, problemText, readDisk, readText, removeLeftover, sameFile, writeDocument, writeSeams } from "./files";
import { setUpPictures } from "./doc-pictures";
import { picturesOf } from "./editing";
import { acceptDisk, follow, forAgents, keepRecords, letGo, nowAt, recheckOpen, noteIdentity, saveDoc, setUpDisk, watchFile, type DocInfo, type OpenDoc, type RenameResult, type SaveOutcome } from "./doc-on-disk";
import { RecoveryStore } from "./recovery";
import type { SetAsideKind } from "./store";
import { readRecentCards, shortFolder, START_SCREEN_CARDS } from "./recent-cards";
import { draftRequest, MARKDOWN_NAMED, newDocumentName, OPENS_AS_MARKDOWN, shownName } from "../core/doc-names";
import { recentFile, RecentList } from "./recent-list";
import { isPicture } from "../core/obsidian";
import { forgetReadTexts, webPicturesOfText } from "../core/web-pictures";
import { copiedToWait, picturesOfOptions, WaitingPictures } from "./waiting-pictures";
import { linkKey, linksIn, notesIn } from "./doc-links";
import { homeDir } from "./agent-tools";
import { findLinked } from "./vault";
import { keepQuiet } from "./quiet";
import { inTrash, putAway } from "./whereabouts";
import { readView, writeView } from "./view-settings";
import { applyAppearance } from "./appearance";
import { placeOnScreens } from "./window-place";
import { setUpYourTurn, turnFront, turnsGone, turnsQuit } from "./your-turn";
import { bringBackTabs, forgetTab, setUpOpenTabs, tabsInOrder, tabsQuit, tabsToBringBack, tabsWindowClosed, untilTabsBack, within } from "./open-tabs";
import { readStandings, type Standing } from "./doc-standing";
import { movedTo } from "./whereabouts";
import { lookAtMemory } from "./memory-note";
import type { RecentCard } from "./recent-cards";

// An error nobody caught is logged, and the person told in plain words at most once a minute (never a stack trace).
let lastTrouble = 0;
process.on("uncaughtException", (err) => {
  console.error("Something went wrong in Corillo.", err);
  if (Date.now() - lastTrouble < 60_000 || !app.isReady()) return;
  lastTrouble = Date.now();
  void dialog
    .showMessageBox({
      type: "warning",
      message: "Something went wrong in Corillo.",
      detail: "If something doesn't work as it should, quit Corillo and open it again.",
    })
    .catch(() => undefined);
});

// The data folder Electron itself chose, before a test's throwaway folder replaces it: only when hidden, read by
// the rehearsal of an app ID change to show the folder doesn't follow the ID (review B17R-2). Used for nothing else.
if (process.env.CORILLO_HIDDEN === "1") Object.defineProperty(globalThis, "corilloOwnDataFolder", { value: app.getPath("userData") });
// Tests and trial runs use a throwaway data folder, never the real one.
if (process.env.CORILLO_USER_DATA) app.setPath("userData", process.env.CORILLO_USER_DATA);
app.setName("Corillo");
const hidden = process.env.CORILLO_HIDDEN === "1";
if (hidden) keepQuiet(); // test and trial runs never take the Mac's focus
// Where tests plant a fault between a save's writing and its reading back (roadmap Batch 14, item 1): only when hidden.
if (hidden) Object.assign(globalThis, { corilloWriteSeams: writeSeams });
// A test reached the window's real speech (read-aloud.ts refused it): a mark in the run's own temporary
// folder, which tests/run-folder.ts looks for as the run ends, fails the whole run (B14-09).
if (hidden) ipcMain.on("tests:real-speech", () => fs.writeFileSync(path.join(tmpdir(), "corillo-real-speech-reached"), ""));
/** Told to the window when Corillo runs for tests (hidden). */
const FOR_TESTS = "--corillo-for-tests";
// Started by an agent's connector: come up without taking the person's focus.
const startedByAgent = process.argv.includes("--background");
/**
 * Whether the window being made shows without taking the person's focus.
 * Decided per window, by who asked: quiet when it's made for an agent (an
 * open in the background, a start for one); the person's own request (the
 * Dock icon, Finder, File > Open) shows it in front, and wins over a quiet
 * one that hasn't shown yet.
 */
let windowQuiet = false;

const docs = new Map<string, OpenDoc>();
let win: BrowserWindow | null = null;
let rendererReady = false;
let queued: [string, unknown[]][] = [];
let quitting = false;
let closeApproved = false;
let flushing = false;
const pendingOpens: string[] = [];

// One record per document in the data folder: comments, history and export settings share it.
const store = versionHistory();
// One of a document's files there was damaged: it was set aside (never deleted), and the person is told once.
const SET_ASIDE: Record<SetAsideKind, (name: string) => string> = {
  comments: (name) => `Corillo couldn't read the comments it keeps for ${name}.`,
  history: (name) => `Corillo couldn't read the history it keeps for ${name}, so it started a new one.`,
  settings: (name) => `Corillo couldn't read the settings it keeps for ${name}, so it went back to the usual ones.`,
  notes: (name) => `Corillo couldn't read the agents' notes it keeps for ${name}.`,
};
store.onSetAside = (storeId, what) => {
  const open = [...docs.values()].find((d) => d.storeId === storeId);
  let where = open?.filePath;
  try {
    where ??= store.lastKnown(storeId)?.path;
  } catch {
    // the list can't be read right now: the notice names no document
  }
  const name = shownName(path.basename(where ?? "")) || "a document";
  console.error(`A damaged file (${what}) kept for ${name} was set aside.`);
  notice(SET_ASIDE[what](name), "The document itself is fine, and the damaged copy was kept.", open?.id);
};

/**
 * A short notice in the window's corner; only if the window is there (it's
 * never opened just for this). One about an open document (`docId`) goes on
 * that document's tab, as its export notice does (roadmap Batch 6, item 2).
 */
function notice(text: string, detail: string, docId?: string): void {
  tell("app:notice", text, detail, docId);
}
const comments = new CommentService(
  store,
  (storeId, threads) => {
    for (const doc of docs.values()) if (doc.storeId === storeId) send("comments:changed", doc.id, threads);
    agents.service.commentsChanged(storeId); // a Send kept for comments now resolved is let go
  },
  (storeId, notes) => {
    for (const doc of docs.values()) if (doc.storeId === storeId) send("notes:changed", doc.id, notes);
  },
);

const recovery = new RecoveryStore(app.getPath("userData"));

// The document on disk (doc-on-disk.ts): watched, followed when it moves, saved, and outside changes taken in.
setUpDisk({ docs, send: tell, notice, store, recovery, historyHooks, replaceRecent, picturesWait, keepWaiting: (storeId, wait) => waiting.change(storeId, { wait }) });

function infoOf(doc: OpenDoc): DocInfo {
  return {
    id: doc.id,
    name: path.basename(doc.filePath),
    filePath: doc.filePath,
    dirUrl: pathToFileURL(path.dirname(doc.filePath)).href,
    text: doc.diskText,
    threads: comments.threads(doc.storeId),
    notes: comments.notes(doc.storeId),
    waitingPictures: waitingPictures(doc.storeId, doc.diskText),
    everyWebPictureWaits: waiting.everyAtOpen(doc.storeId),
  };
}

// Web pictures an agent adds wait for the person -------------------------------------
// (roadmap Batch 18, item 1) A picture with a web address that arrives in an
// agent's change, or in a document an agent made, isn't asked for until the
// person shows it, so a misled agent can't send words to a site by writing
// them into a picture's address. Only the addresses are kept, with the
// document's records (store.ts); never the pictures.

// Fails closed: records that can't be read make every web picture in the document wait (the review's R18-9).
const waiting = new WaitingPictures(store, () => [...docs.values()].map((d) => d.storeId), drawable);

/**
 * The web pictures Corillo could still draw for an open document: in its
 * text, every version in History, words kept for recovery, its comments and
 * what each pass left (reply options among them). Null for a document not
 * open, or a history that can't be read through: then none is let go
 * (roadmap Batch 19, item 2).
 */
function drawable(storeId: string): Set<string> | null {
  const doc = [...docs.values()].find((d) => d.storeId === storeId);
  if (!doc) return null;
  const found = new Set<string>();
  const add = (text: string) => {
    for (const a of webPicturesOfText(text)) found.add(a);
  };
  const addAll = (value: unknown): void => {
    if (typeof value === "string") add(value);
    else if (Array.isArray(value)) value.forEach(addAll);
    else if (value && typeof value === "object") Object.values(value).forEach(addAll);
  };
  add(doc.diskText);
  if (!store.everyText(storeId, add)) return null;
  for (const { id, entry } of recovery.all()) if (id === storeId) add(entry.text);
  addAll(comments.threads(storeId));
  for (const a of picturesOfOptions(doc.diskText, comments.threads(storeId))) found.add(a); // as applied to the text (R19-10)
  addAll(comments.notes(storeId));
  addAll(store.list(storeId));
  return found;
}

function waitingPictures(storeId: string, text: string): string[] {
  return waiting.of(storeId, text);
}

/** Kept, and told to every tab of the document: before the change itself is sent, so no picture is asked for meanwhile. */
function picturesWait(storeId: string, change: { wait?: string[]; shown?: string[] }): void {
  waiting.change(storeId, change); // what can't be kept is held while the app runs; the tabs open now hold it too
  const every = waiting.everyBut(storeId); // undefined if it can't be read now: the tabs keep what they have (R19-7)
  for (const d of docs.values()) if (d.storeId === storeId) send("pictures:waiting", d.id, { wait: change.wait ?? [], shown: change.shown ?? [], ...(every === undefined ? {} : { every }) });
}

/** The web pictures that wait in the document at this path, for an export (export.ts leaves them out). */
function waitingAt(filePath: string, text: string): string[] {
  const doc = [...docs.values()].find((d) => d.filePath === filePath);
  try {
    return waitingPictures(doc?.storeId ?? store.idFor(filePath), text);
  } catch (err) {
    console.error("Couldn't find the records of a document being exported, so every web picture in it waits.", err);
    return [...webPicturesOfText(text)];
  }
}

// The person showed a waiting picture, by clicking its marker (only there: images.ts).
ipcMain.handle("pictures:show", (_e, id: string, address: string) => {
  const doc = docs.get(String(id));
  if (!doc || typeof address !== "string") return;
  picturesWait(doc.storeId, { shown: [address] });
});

// A copy pasted into a document held web pictures that waited where they were
// copied from: they wait here too (roadmap Batch 19, item 1, from paste.ts).
// The window can only add addresses, checked here, to a document it has open.
ipcMain.handle("pictures:wait", (e, id: unknown, addresses: unknown) => {
  const doc = docs.get(String(id));
  const wait = copiedToWait(addresses);
  if (!win || e.sender !== win.webContents || !doc || !wait.length) return;
  picturesWait(doc.storeId, { wait });
});

// The window -------------------------------------------------------------------

const background = () => (nativeTheme.shouldUseDarkColors ? "#1B2023" : "#EAEDEC");

function ensureWindow(quiet = false): BrowserWindow {
  if (win && !win.isDestroyed()) {
    if (!quiet) windowQuiet = false;
    return win;
  }
  windowQuiet = quiet;
  // Where the person left it, if that's still on a screen here; otherwise the usual size, in the middle.
  const place = placeOnScreens(
    readView().window,
    screen.getAllDisplays().map((d) => d.workArea),
  ) ?? { width: 1100, height: 860 };
  const w = new BrowserWindow({
    ...place,
    minWidth: 560,
    minHeight: 420,
    title: "Corillo",
    show: false,
    backgroundColor: background(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      // Running for tests: the window gets the switches only tests use (see src/renderer/for-tests.ts).
      additionalArguments: hidden ? [FOR_TESTS] : [],
    },
  });
  win = w;
  windowIs(w.webContents, "document");
  rendererReady = false;
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.once("ready-to-show", () => {
    startAfterLaunch(AFTER_LAUNCH_MS);
    const focused = !windowQuiet;
    app.emit("corillo-window-shown", { focused }); // said for tests, whose windows stay hidden
    if (!hidden && !w.isVisible()) {
      if (focused) w.show();
      else w.showInactive();
    }
  });
  w.loadFile(path.join(__dirname, "index.html"));

  // Before the window closes, every tab saves what it hasn't yet. A tab whose
  // file changed outside Corillo asks first; the person can cancel.
  w.on("close", (e) => {
    writeView({ window: w.getNormalBounds() }); // its place and size when not full screen
    if (closeApproved) return;
    e.preventDefault();
    if (flushing) return;
    flushing = true;
    if (!rendererReady) {
      closeApproved = true;
      w.destroy();
      return;
    }
    w.webContents.send("app:flush");
    watchFlush(w);
  });
  w.on("closed", () => {
    stopWatchingFlush();
    // Electron counts the window destroyed by now: nothing below may reach it (B5-03).
    win = null;
    const closing = [...docs.values()];
    docs.clear();
    for (const doc of closing) {
      // One document's trouble never stops the rest of the closing (the next window's saves depend on it).
      try {
        tabClosed(doc, !quitting); // as if each tab were closed
      } catch (err) {
        console.error(`Couldn't let go of ${doc.filePath} as its window closed.`, err);
      }
    }
    closeApproved = false;
    flushing = false;
    queued = [];
    agents.windowGone(); // a window that's gone answers nothing
    turnsGone(); // nothing waits for the person in a window that's gone: the Dock's count goes
    // Closed by the person, no tab is open: the next launch shows the start screen. Reopened with its documents after its
    // page stopped working: the list stays as it is.
    tabsWindowClosed(quitting, afterCrash?.times === 1);
    if (quitting) app.quit();
    else {
      windowClosed(); // nothing in the menus acts on a window that's gone
      const reopen = afterCrash;
      afterCrash = null;
      if (reopen) reopenAfterCrash(reopen);
    }
  });
  w.webContents.on("render-process-gone", (_e, details) => {
    // Not while quitting, or while the person is closing the window (its last saves): it was going anyway.
    if (details.reason !== "clean-exit" && !quitting && !flushing && !closeApproved) {
      // What was open, to open again in a fresh window once this one has gone, in the tab bar's order (B10-1).
      const now = Date.now();
      crashes = crashes.filter((t) => now - t < CRASH_AGAIN_MS);
      crashes.push(now);
      const open = [...docs.values()].filter((d) => !d.missing).map((d) => d.filePath);
      const inOrder = tabsInOrder().filter((p) => open.includes(p));
      afterCrash = {
        paths: [...inOrder, ...open.filter((p) => !inOrder.includes(p))],
        front: (activeDoc && docs.get(activeDoc)?.filePath) || null,
        focused: !hidden && w.isFocused(),
        times: crashes.length,
      };
    }
    closeApproved = true;
    if (!w.isDestroyed()) w.destroy();
  });
  // A page that stops answering (stuck on something huge): the person can wait
  // for it or reopen the window. The question goes by itself if it answers again.
  let asking: AbortController | null = null;
  w.webContents.on("unresponsive", () => {
    if (flushing || quitting) return closeUnanswered(w); // closing never waits on it
    if (asking) return;
    const question = (asking = new AbortController());
    void dialog
      .showMessageBox(w, {
        type: "warning",
        message: "Corillo's window isn't responding.",
        detail: "Wait to give it more time, or reopen the window with your documents as they were last saved.",
        buttons: ["Wait", "Reopen"],
        defaultId: 0,
        cancelId: 0,
        signal: question.signal,
      })
      .then(({ response }) => {
        if (asking === question) asking = null;
        // Reopening is the same as when the page stops working (see render-process-gone).
        if (response === 1 && !question.signal.aborted && !w.isDestroyed()) w.webContents.forcefullyCrashRenderer();
      });
  });
  w.webContents.on("responsive", () => {
    asking?.abort();
    asking = null;
  });
  return w;
}

// Closing waits for the page to save its tabs' last typing, which takes
// moments. If it hasn't said it's done after a short while, it's asked whether
// it's still there (it may be asking the person something); one that doesn't
// answer has stopped, so the window closes without it rather than hang, and
// so does Quit.
const FLUSH_WAIT_MS = 2000;
const ANSWER_WAIT_MS = 5000;
let flushWatch: NodeJS.Timeout | null = null;
let lastAnswer = 0;

ipcMain.on("app:pong", (e) => {
  if (win && e.sender === win.webContents) lastAnswer = Date.now();
});

function watchFlush(w: BrowserWindow): void {
  stopWatchingFlush();
  const ask = () => {
    const asked = Date.now();
    if (!w.isDestroyed()) w.webContents.send("app:ping");
    flushWatch = setTimeout(() => {
      if (lastAnswer >= asked) flushWatch = setTimeout(ask, FLUSH_WAIT_MS);
      else closeUnanswered(w);
    }, ANSWER_WAIT_MS);
  };
  flushWatch = setTimeout(ask, FLUSH_WAIT_MS);
}

function stopWatchingFlush(): void {
  if (flushWatch) clearTimeout(flushWatch);
  flushWatch = null;
}

/** The page stopped answering while its window closes: close it without its last saves. */
function closeUnanswered(w: BrowserWindow): void {
  stopWatchingFlush();
  if (w.isDestroyed()) return;
  console.error("Corillo's window stopped answering, so it closed without waiting for it.");
  closeApproved = true;
  w.destroy();
}

// When the window's page stops working (out of memory on a huge document, a
// fault in the browser engine), it's reopened with the same documents, as
// they were last saved, and a word in the corner. If it stops again within
// moments, it comes back with the start screen only; a third time, not at all
// (the Dock icon opens it), so nothing goes round in circles.
const CRASH_AGAIN_MS = 30_000;
let crashes: number[] = [];
let afterCrash: { paths: string[]; front: string | null; focused: boolean; times: number } | null = null;
/** The tab in front, as the window last said. */
let activeDoc: string | null = null;

function reopenAfterCrash({ paths, front, focused, times }: NonNullable<typeof afterCrash>): void {
  if (times > 2) return;
  ensureWindow(!focused);
  if (times === 2) {
    send("app:notice", "Corillo's window stopped working again, so it opened without your documents.", "They're as they were last saved. Open them again from the list when you're ready.");
    return;
  }
  let inFront: OpenDoc | null = null;
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const doc = openDocument(p, { background: true });
    if (doc && p === front) inFront = doc;
  }
  if (inFront) send("tabs:activate", inFront.id);
  offerRecovered(); // edits that couldn't be saved yet come back in their tabs, as after a crash of Corillo
  send("app:notice", "Corillo's window stopped working and was reopened.", "Your documents are as they were last saved.");
}

/** The window's title, and the file the Mac's title bar shows, once its document has moved to `target`. */
function titleAfterMove(target: string): void {
  if (!win) return;
  win.setTitle(shownName(path.basename(target)));
  if (process.platform === "darwin") win.setRepresentedFilename(target);
}

/** Send to the window, holding messages until its page is ready. A window made for this alone doesn't take focus. */
function send(channel: string, ...args: unknown[]): void {
  const w = ensureWindow(true);
  if (rendererReady) w.webContents.send(channel, ...args);
  else queued.push([channel, args]);
}

/**
 * Send to the window only if it's there: never opens one. What the document
 * on disk, History and the agents tell the window is about what it shows (an
 * agent's export that ends after the person closed the window, say, brought
 * it back empty: the review of Batch 21, S21-7). An agent's document gets its
 * window from openDocument.
 */
function tell(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) send(channel, ...args);
}

ipcMain.on("app:ready", (e) => {
  if (!win || e.sender !== win.webContents) return;
  rendererReady = true;
  for (const [channel, args] of queued) win.webContents.send(channel, ...args);
  queued = [];
});

ipcMain.on("app:flushed", (_e, ok: boolean) => {
  stopWatchingFlush();
  flushing = false;
  if (!ok) {
    quitting = false; // the person cancelled
    return;
  }
  closeApproved = true;
  win?.close();
});

// Opening documents ------------------------------------------------------------

/**
 * Open a document in a tab. A background open (an agent opening a document)
 * adds the tab without switching to it or bringing Corillo forward.
 */
function openDocument(filePath: string, options: { background?: boolean; long?: "asked" } = {}): OpenDoc | null {
  const abs = path.resolve(filePath);
  // A Word document opens as a Markdown copy beside it, once the person says so (see openWordDocument).
  if (isWordDocument(abs) || isOldWordDocument(abs)) {
    if (options.background) cantOpen(abs, isOldWordDocument(abs) ? OLD_WORD_FORMAT : "Open it with File > Open to work on a copy of it.", true);
    else openWordDocument(abs);
    return null;
  }
  // The same file is one tab, also when reached by a symlink or another case.
  for (const doc of docs.values()) {
    if (sameFile(doc.filePath, abs)) {
      if (!options.background) {
        send("tabs:activate", doc.id);
        bringForward();
      }
      return doc;
    }
  }
  if (!options.background && options.long !== "asked" && isLong(abs)) {
    void askToOpenLong(abs);
    return null;
  }
  let text: string;
  try {
    text = readText(abs);
  } catch (err) {
    const reason = err instanceof FileProblem ? err.message : "The file couldn't be read.";
    cantOpen(abs, reason, options.background);
    return null;
  }
  removeLeftover(abs);
  let storeId: string;
  try {
    storeId = store.idFor(abs, text);
  } catch (err) {
    return cantReadRecords(abs, err, options.background);
  }
  // The document of a tab whose file went (moved to another drive, say), opened from where it is now: the tab follows it.
  const lost = [...docs.values()].find((d) => d.storeId === storeId && (d.missing || !fs.existsSync(d.filePath)));
  if (lost) {
    follow(lost, abs);
    if (!options.background) {
      send("tabs:activate", lost.id);
      bringForward();
    }
    return lost;
  }
  const doc: OpenDoc = { id: randomUUID(), storeId, filePath: abs, diskText: text };
  let info: DocInfo;
  try {
    info = infoOf(doc);
  } catch (err) {
    return cantReadRecords(abs, err, options.background);
  }
  noteIdentity(doc);
  docs.set(doc.id, doc);
  forgetDoneTicks(doc.storeId); // kept by Corillo before roadmap Batch 9, item 9: nothing reads them now
  // The window starts showing the document while the history and the recent
  // list are brought up to date here (all before it can ask anything back).
  send("tabs:open", info, { background: !!options.background });
  // An agent has worked on it before: the status bar says whose turn it is.
  if (historyHooks.opened(abs, text)) send("agent:worked", doc.id);
  watchFile(doc);
  addRecent(abs);
  agents.service.opened(doc.storeId);
  if (!options.background) bringForward();
  sweepNow();
  lookAtMemory(docs); // a note in Corillo's log if this took it past 1 GB (memory-note.ts)
  return doc;
}

/** A document long enough to slow the window down, though not too big to open. */
function isLong(filePath: string): boolean {
  try {
    const { size } = fs.statSync(filePath);
    return size > LONG_DOCUMENT_BYTES && size <= MAX_DOCUMENT_BYTES;
  } catch {
    return false; // opening says what's wrong
  }
}

/** The person opens a very long document: say what it costs, and open it if they still want to. */
async function askToOpenLong(filePath: string): Promise<void> {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    // gone meanwhile: opening says so
  }
  const { response } = await dialog.showMessageBox(ensureWindow(), {
    type: "warning",
    message: `${named(filePath)} is a very long document (${megabytes(size)}).`,
    detail: "Corillo can open it, but it takes a few seconds, typing in it may lag, and it uses a lot of memory while it's open.",
    buttons: ["Open", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) openDocument(filePath, { long: "asked" });
}

// Word documents (roadmap Batch 5, item 1; see word-copy.ts) ----------------------------

/** The Word documents opened and not yet answered for, one after another: several dropped at once are asked about in turn. */
let wordDocuments: Promise<void> = Promise.resolve();

/** The person opened a Word document (File > Open, a drop on the window or the Dock icon, Finder's Open With). */
function openWordDocument(word: string): void {
  wordDocuments = wordDocuments.then(() => copyWordDocument(word)).catch((err) => console.error("Couldn't make a copy of a Word document.", err));
}

// Quitting while a copy is made: Pandoc is stopped with the export's programs (export.ts), and its work goes.
app.on("will-quit", clearCopyWork);

/**
 * Ask once, then make the Markdown copy beside the Word document and open it.
 * Its first version in History says what it was made from, its export
 * settings name the Word file for styles, and a notice on its tab says what
 * the copy left out. Cancel leaves everything as it was.
 */
async function copyWordDocument(word: string): Promise<void> {
  const name = path.basename(word);
  if (isOldWordDocument(word)) return cantOpen(word, OLD_WORD_FORMAT);
  if (!wordWorksHere()) return cantOpen(word, WORD_NEEDS_NEWER_MAC);
  let contents: WordContents;
  try {
    contents = lookInWord(word);
  } catch (err) {
    return cantOpen(word, err instanceof WordCopyProblem ? err.message : "The file couldn't be read.");
  }
  const place = copyPlace(word);
  const question = copyQuestion(word, place, canWriteIn(path.dirname(word)));
  const { response } = await dialog.showMessageBox(ensureWindow(), {
    type: "question",
    message: question.message,
    detail: question.detail,
    buttons: question.buttons,
    defaultId: 0,
    cancelId: question.buttons.length - 1,
  });
  const choice = question.choices[response] ?? "cancel";
  if (choice === "cancel") return;
  if (choice === "open" && place.existing) {
    openDocument(place.existing);
    return;
  }
  const target = choice === "elsewhere" ? await chooseCopyPlace(word) : place;
  if (!target) return;
  let made: CopyMade;
  try {
    made = await makeWordCopy(word, target, { pandoc: pandocPath, run });
  } catch (err) {
    console.error(`Couldn't make a copy of ${word}.`, err);
    return cantOpen(word, err instanceof WordCopyProblem ? err.message : "Something went wrong making its copy.");
  }
  let styles = false;
  try {
    store.created(target.markdown); // a new document, even if one by that name was here before
    store.seen(store.idFor(target.markdown, made.text), made.text, name);
    styles = rememberWordCopy(target.markdown, word); // its look kept for export, and never exported over
  } catch (err) {
    console.error("Couldn't note what a copy of a Word document was made from.", err); // opening says so if the records can't be read
  }
  const doc = openDocument(target.markdown);
  if (doc) {
    const told = copyNotice(word, contents, made, styles);
    notice(told.text, told.detail, doc.id);
  }
}

/** The Word document's folder can't be written to: the person chooses where its copy goes. Never over a file or folder already there. */
async function chooseCopyPlace(word: string): Promise<{ markdown: string; pictures: string } | null> {
  const result = await dialog.showSaveDialog(ensureWindow(), {
    title: "Save the copy",
    defaultPath: path.join(app.getPath("documents"), path.basename(word).replace(/\.[^.]+$/, "") + ".md"),
    buttonLabel: "Save",
    properties: ["createDirectory"],
  });
  if (result.canceled || !result.filePath) return null;
  let markdown = path.resolve(result.filePath);
  if (path.extname(markdown).toLowerCase() !== ".md") markdown += ".md";
  const pictures = imagesFolder(markdown);
  const taken = [markdown, pictures].find((p) => fs.existsSync(p));
  if (taken) {
    await dialog.showMessageBox(ensureWindow(), {
      type: "info",
      message: `There's already ${taken === markdown ? "a file" : "a folder"} called ${path.basename(taken)} there.`,
      detail: "Open the Word document again and choose another name.",
    });
    return null;
  }
  return { markdown, pictures };
}

/** A document isn't opened without its comments and history: they can't be read right now, so say so. */
function cantReadRecords(filePath: string, err: unknown, background = false): null {
  console.error(`Couldn't read Corillo's records of ${filePath}.`, err);
  cantOpen(filePath, "Corillo can't read the comments and history it keeps for it right now. Try again in a moment.", background);
  return null;
}

/**
 * A document as Corillo's questions name it: as its tab does, without ".md" (roadmap Batch 11, F-24). Where
 * files are told apart ("There's already a file called plan.md there"), the full name stays.
 */
const named = (filePath: string) => shownName(path.basename(filePath));

/**
 * A document that can't be opened. Asked for by the person, a box says so;
 * opened in the background (an agent's open, reopening after a crash), a line
 * in the corner, so nothing stops what the person is doing.
 */
function cantOpen(filePath: string, reason: string, background = false): void {
  if (background) notice(`Can't open ${named(filePath)}.`, reason);
  else dialog.showErrorBox(`Can't open ${named(filePath)}`, reason);
}

function bringForward(): void {
  const w = ensureWindow();
  if (hidden) return;
  if (w.isMinimized()) w.restore();
  if (w.webContents.isLoading()) return; // shown when ready
  w.show();
  w.focus();
}

function docFor(id: string): OpenDoc {
  const doc = docs.get(id);
  if (!doc) throw new Error("That document isn't open.");
  return doc;
}

// Saving -----------------------------------------------------------------------
// A save in place is written and checked in doc-on-disk.ts; Save somewhere else below.

/**
 * The person's save, from the window. While an agent holds the document its
 * tab takes no typing, but a tab that wrongly thinks it's free must still
 * never write over the agent's edits: refused, with who's editing. The
 * exceptions: the take itself, which saves the person's last edits first;
 * and putting back a file that was deleted ("Save it where it was"), which
 * the agent can't do and which writes over nobody's edits.
 */
function personSaves(doc: OpenDoc, text: string, force: boolean): SaveOutcome {
  const agent = agents.service.editingAgent(doc.storeId);
  const puttingBack = force && doc.missing && !fs.existsSync(doc.filePath);
  if (agent && !puttingBack && !agents.flushing(doc.id)) return { ok: false, problem: `${agent} is editing it` };
  return saveDoc(doc, text, force);
}

ipcMain.handle("doc:save", (_e, id: string, text: string) => personSaves(docFor(id), text, false));
ipcMain.handle("doc:force-save", (_e, id: string, text: string) => personSaves(docFor(id), text, true));

ipcMain.handle("doc:accept-disk", (_e, id: string, text: string) => acceptDisk(docFor(id), text));

// Edits that can't be saved right now are kept in the data folder until they can.
ipcMain.handle("doc:keep-recovery", (_e, id: string, text: string) => {
  const doc = docFor(id);
  return recovery.keep(doc.storeId, { filePath: doc.filePath, base: doc.diskText, text });
});
ipcMain.handle("doc:discard-recovery", (_e, id: string) => recovery.clear(docFor(id).storeId));

/**
 * The original file, still where it was once the document's records went to
 * its new place (Save Somewhere Else, or Rename or Move that couldn't remove
 * it), is a document of its own now: an agent's web pictures in it still wait
 * (the reviews of Batch 19, R19-4, and Batch 20, R20-2).
 */
function leftOriginal(doc: OpenDoc, oldPath: string, oldText: string): void {
  try {
    waiting.leftBehind(doc.storeId, store.idFor(oldPath, oldText), doc.diskText);
  } catch (err) {
    console.error("Couldn't note which web pictures wait in the original file left where it was.", err);
  }
}

/** Save the document somewhere new, chosen by the person; it lives there from then on. */
ipcMain.handle("doc:save-as", async (_e, id: string, text: string): Promise<RenameResult | { problem: string } | null> => {
  const doc = docFor(id);
  const folder = path.dirname(doc.filePath);
  const result = await dialog.showSaveDialog(ensureWindow(), {
    title: "Save somewhere else",
    defaultPath: fs.existsSync(folder) ? doc.filePath : path.join(app.getPath("documents"), path.basename(doc.filePath)),
    buttonLabel: "Save",
    properties: ["createDirectory"],
  });
  if (result.canceled || !result.filePath) return null;
  const picked = path.resolve(result.filePath);
  let target = picked;
  if (!path.extname(target)) target += path.extname(doc.filePath) || ".md";
  for (const other of docs.values()) {
    if (other !== doc && sameFile(other.filePath, target)) {
      return { problem: `${path.basename(target)} is open in another tab` };
    }
  }
  // The Mac's panel asks before replacing only the name it was given: with the
  // extension added, this is another file it never asked about. Never write over it.
  if (target !== picked && fs.existsSync(target) && !sameFile(target, doc.filePath)) {
    await alreadyThere(target);
    return null;
  }
  let changedAfter: string | null;
  try {
    changedAfter = writeDocument(target, text);
  } catch (err) {
    return { problem: problemText(err) };
  }
  const oldPath = doc.filePath;
  const oldText = doc.diskText;
  const leftBehind = fs.existsSync(oldPath) && !sameFile(oldPath, target);
  // It lives here now. Its former path is noted only when the old place is empty: an original left there is a document of its own.
  const kept = nowAt(doc, target, { former: !fs.existsSync(oldPath), found: true, text });
  if (leftBehind) leftOriginal(doc, oldPath, oldText);
  historyHooks.saved(doc.storeId, text);
  keepRecords(doc, () => recovery.clear(doc.storeId), "save", kept);
  titleAfterMove(target);
  return { info: infoOf(doc), oldDirUrl: pathToFileURL(path.dirname(oldPath)).href, movedImages: null, ...(changedAfter === null ? {} : { changedAfter }) };
});

/** A tab that can't simply be saved is closing: what does the person want? */
ipcMain.handle("doc:ask-unposted", async (_e, id: string) => {
  const name = named(docFor(id).filePath);
  const { response } = await dialog.showMessageBox(ensureWindow(), {
    type: "warning",
    message: `You haven't posted your comment on ${name}.`,
    detail: "If you close it now, what you typed will be lost.",
    buttons: ["Go Back to It", "Close Anyway"],
    defaultId: 0,
    cancelId: 0,
  });
  return response === 1 ? "discard" : "cancel";
});

ipcMain.handle("doc:ask-before-close", async (_e, id: string, kind: "missing" | "trashed" | "problem" | "held-back" | "recovered", problem: string) => {
  const doc = docFor(id);
  const name = named(doc.filePath);
  const choices: Record<typeof kind, { message: string; detail: string; buttons: [string, string][] }> = {
    missing: {
      message: `${name} was moved or deleted outside Corillo.`,
      detail: "Save it before closing, or its text will be lost.",
      buttons: [["here", "Save Where It Was"], ["save-as", "Save Somewhere Else…"], ["discard", "Don't Save"], ["cancel", "Cancel"]],
    },
    trashed: {
      message: `${name} is in the Trash.`,
      detail: "Your latest changes aren't in it. If you close it now, they'll be lost unless you save them somewhere else.",
      buttons: [["save-as", "Save Somewhere Else…"], ["discard", "Don't Save"], ["cancel", "Cancel"]],
    },
    problem: {
      message: `${name} couldn't be saved: ${problem}.`,
      detail: "If you close it now, your latest changes will be lost unless you save them somewhere else.",
      buttons: [["save-as", "Save Somewhere Else…"], ["discard", "Don't Save"], ["cancel", "Cancel"]],
    },
    // The safety net held the save back (B14-03): no way of saving can work, so the default keeps the tab and the words.
    "held-back": {
      message: `${name} couldn't be saved: ${problem}.`,
      detail: "If you close it now, your latest changes will be lost. To keep them, choose Cancel, then copy everything on the page into another document.",
      buttons: [["cancel", "Cancel"], ["discard", "Don't Save"]],
    },
    recovered: {
      message: `Keep the changes to ${name} that Corillo brought back?`,
      detail: "They weren't saved when Corillo last closed.",
      buttons: [["mine", "Keep Them"], ["theirs", "Use the Saved Version"], ["cancel", "Cancel"]],
    },
  };
  const { message, detail, buttons } = choices[kind];
  const { response } = await dialog.showMessageBox(ensureWindow(), {
    type: "warning",
    message,
    detail,
    buttons: buttons.map(([, label]) => label),
    defaultId: 0,
    cancelId: buttons.findIndex(([choice]) => choice === "cancel"),
  });
  return buttons[response]?.[0] ?? "cancel";
});

/** The document's last tab closed: an agent editing it stops, and Corillo lets go of what it held for it. */
function lastTabClosed(doc: OpenDoc): void {
  sweepNow();
  store.forget(doc.storeId);
  // An agent editing it stops: a closed tab never comes back by itself.
  void agents.service.closed(doc.storeId, doc.filePath).then(() => {
    if (![...docs.values()].some((d) => d.storeId === doc.storeId)) comments.forget(doc.storeId);
  });
}

/**
 * A tab closed, by itself or with its window: Corillo stops watching its file, takes away a new document never typed
 * in, and, when it was the document's last tab and `last` allows, lets go of the document (`lastTabClosed`).
 */
function tabClosed(doc: OpenDoc, last = true): void {
  letGo(doc);
  takeAwayIfUntouched(doc); // a new document never typed in, also when quitting
  docs.delete(doc.id);
  if (last && ![...docs.values()].some((d) => d.storeId === doc.storeId)) lastTabClosed(doc);
}

ipcMain.on("doc:closed", (_e, id: string) => {
  const doc = docs.get(id);
  if (doc) tabClosed(doc);
});

ipcMain.on("doc:active", (_e, id: string | null) => {
  activeDoc = id;
  turnFront(id); // ticked in the Window menu
  const doc = id ? docs.get(id) : undefined;
  if (!win) return;
  // Named as on its tab, without ".md" (roadmap Batch 5, item 2), as Word's title bar names a document.
  win.setTitle(doc ? shownName(path.basename(doc.filePath)) : "Corillo");
  if (process.platform === "darwin") win.setRepresentedFilename(doc ? doc.filePath : "");
});

/** A tab is closing, or the app quitting, while its file changed outside Corillo. */
ipcMain.handle("doc:ask-conflict", async (_e, id: string) => {
  const doc = docFor(id);
  const { response } = await dialog.showMessageBox(ensureWindow(), {
    type: "warning",
    message: `${named(doc.filePath)} was changed outside Corillo while you had edits that weren't saved.`,
    detail: "Choose which version to keep.",
    buttons: ["Keep my version", "Use the other version", "Cancel"],
    defaultId: 0,
    cancelId: 2,
  });
  return (["mine", "theirs", "cancel"] as const)[response];
});

registerHistory(() => docs.values(), (tabId) => tell("history:changed", tabId));

ipcMain.handle("doc:copy-path", (_e, id: string) => {
  const doc = docFor(id);
  clipboard.writeText(doc.filePath);
  return doc.filePath;
});

// Comments -----------------------------------------------------------------------
// Kept in Corillo's data folder, never in the document. The window acts for the person.

const person: Author = { kind: "person" };
const storeOf = (id: string) => docFor(id).storeId;

// `mention` is the agent the person named with @ (or null): the comment is for it.
const mentionOf = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
ipcMain.handle("comments:add", (_e, id: string, body: string, anchor: Anchor | null, mention: unknown) =>
  attempt(() => comments.add(storeOf(id), person, body, anchor, mentionOf(mention), mentionOf(mention))),
);
ipcMain.handle("comments:reply", (_e, id: string, threadId: string, body: string, mention: unknown) =>
  attempt(() => comments.reply(storeOf(id), threadId, person, body, mentionOf(mention))),
);
ipcMain.handle("comments:edit", (_e, id: string, threadId: string, messageId: string, body: string, mention: unknown) =>
  attempt(() => comments.edit(storeOf(id), threadId, messageId, person, body, mention === undefined ? undefined : mentionOf(mention))),
);
ipcMain.handle("comments:delete", (_e, id: string, threadId: string, messageId: string) =>
  attempt(() => comments.remove(storeOf(id), threadId, messageId, person)),
);
// Undo straight after a delete (roadmap Batch 9, item 4): only the very message just deleted comes back.
ipcMain.handle("comments:restore", (_e, id: string, threadId: string, messageId: string) =>
  attempt(() => comments.restore(storeOf(id), String(threadId), String(messageId), person)),
);
ipcMain.handle("comments:resolve", (_e, id: string, threadId: string, resolved: boolean) =>
  attempt(() => comments.resolve(storeOf(id), threadId, person, resolved)),
);
// The person applied an option on an agent's reply (roadmap Batch 3, item 2).
ipcMain.handle("comments:choose", (_e, id: string, threadId: string, messageId: string, option: number, spans: unknown, undo: unknown) =>
  attempt(() => comments.choose(storeOf(id), String(threadId), String(messageId), person, Number(option), cleanSpans(spans), cleanUndo(undo))),
);
ipcMain.on("comments:anchors", (_e, id: string, anchors: Record<string, AnchorUpdate>) => {
  const doc = docs.get(id);
  try {
    if (doc) comments.setAnchors(doc.storeId, anchors);
  } catch (err) {
    console.error("Couldn't keep where the comments are now.", err); // found again next time
  }
});
// Agents' changes for comments (see core/change-links.ts): where the person's edits moved them.
ipcMain.on("changes:anchors", (_e, id: string, report: ChangeAnchorReport) => {
  const doc = docs.get(id);
  try {
    if (doc && report && typeof report === "object") comments.setChangeAnchors(doc.storeId, report);
  } catch (err) {
    console.error("Couldn't keep where the agents' changes are now.", err);
  }
});
// The person marked an agent's note done (roadmap Batch 2, item 3).
ipcMain.handle("notes:done", (_e, id: string, note: string) => attempt(() => comments.doneNote(storeOf(id), String(note))));

// Agents -------------------------------------------------------------------------
// Agent tools connect through Corillo's connector (src/mcp/server.ts) over a
// local socket. Version history hooks in through the last argument.

const agents = setUpAgents(
  {
    docs,
    openDocument,
    front: () => (activeDoc ? (docs.get(activeDoc) ?? null) : null),
    readText,
    ...forAgents, // an agent's writes reach the document on disk (doc-on-disk.ts)
    picturesWait: (storeId, addresses) => picturesWait(storeId, { wait: addresses }),
    send: tell,
    seen: rememberAgents,
    connected: (names, left, clients) => {
      agentsConnected(names, left);
      sessionsConnected(clients ?? []); // the Connect screen's rows (roadmap Batch 5, item 2)
    },
  },
  comments,
  // One agent pass is one version in the history, with the comments it answered.
  // Agents can look back through the versions too.
  {
    beginPass: (storeId, agentName) => store.beginPass(storeId, agentName),
    endPass: (storeId, { addressed, other, request, note }) => {
      forgetReadTexts(); // no document's text is held after a pass (the review of Batch 18, R18-6)
      return store.endPass(storeId, { addressed, other, request, note });
    },
    versions: (storeId) => store.list(storeId),
    versionText: (storeId, n) => store.text(storeId, n),
  },
);

// Renaming and moving ------------------------------------------------------------
// A document's pictures folder goes with it, and its picture addresses are
// updated by the tab (see the renderer).

/** A move to another drive copied the file there, then couldn't remove the original. */
class CopiedNotRemoved extends Error {
  constructor(readonly cause: unknown) {
    super("copied, but the original couldn't be removed");
  }
}

function moveOnDisk(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    try {
      fs.rmSync(from, { recursive: true });
    } catch (removing) {
      throw new CopiedNotRemoved(removing);
    }
  }
}

/** A problem in words for the status bar, as a sentence for a message's detail. */
const sentence = (problem: string) => `${problem[0].toUpperCase()}${problem.slice(1)}.`;

async function alreadyThere(target: string): Promise<void> {
  await dialog.showMessageBox(ensureWindow(), {
    type: "info",
    message: `There's already a file called ${path.basename(target)} there.`,
    detail: "Choose another name or folder.",
  });
}

ipcMain.handle("doc:rename", async (_e, id: string): Promise<RenameResult | null> => {
  const doc = docFor(id);
  const editing = agents.service.editingAgent(doc.storeId);
  if (editing) {
    await dialog.showMessageBox(ensureWindow(), {
      type: "info",
      message: `${editing} is editing ${named(doc.filePath)}.`,
      detail: "You can rename or move it once it's done, or after you press Take over.",
    });
    return null;
  }
  const result = await dialog.showSaveDialog(ensureWindow(), {
    title: "Rename or move",
    defaultPath: doc.filePath,
    buttonLabel: "Move",
    properties: ["createDirectory"],
  });
  if (result.canceled || !result.filePath) return null;
  let target = path.resolve(result.filePath);
  if (!path.extname(target)) target += path.extname(doc.filePath) || ".md";
  if (target === doc.filePath) return null;
  // Only other capitals (plan.md to Plan.md) is the same file on a Mac's disk: free to rename.
  if (fs.existsSync(target) && !sameFile(target, doc.filePath)) {
    await alreadyThere(target);
    return null;
  }
  const oldPath = doc.filePath;
  const oldImages = imagesFolder(oldPath);
  const newImages = imagesFolder(target);
  let copiedOnly = false;
  try {
    moveOnDisk(oldPath, target);
  } catch (err) {
    const name = named(oldPath);
    const halfDone = err instanceof CopiedNotRemoved;
    copiedOnly = halfDone;
    await dialog.showMessageBox(ensureWindow(), {
      type: "warning",
      message: halfDone ? `${name} was copied to its new place, but Corillo couldn't remove the original.` : `Corillo couldn't move ${name}.`,
      detail: halfDone
        ? "The original is still where it was. Corillo works on the copy in the new place from now on."
        : sentence(problemText(err)),
    });
    if (!halfDone) return null;
  }
  // From here the document is at its new place, whatever happens to its pictures.
  let movedImages: { from: string; to: string } | null = null;
  if (fs.existsSync(oldImages) && !fs.existsSync(newImages)) {
    try {
      moveOnDisk(oldImages, newImages);
      movedImages = { from: pathToFileURL(oldImages).href, to: pathToFileURL(newImages).href };
    } catch {
      // The pictures stay where they were; the document still points at them.
    }
  }
  // Its comments and history go with it. (Rename or Move leaves `missing` as it was.)
  nowAt(doc, target, { former: !fs.existsSync(oldPath) || !sameFile(oldPath, target), found: false });
  if (copiedOnly) leftOriginal(doc, oldPath, doc.diskText);
  titleAfterMove(target);
  return { info: infoOf(doc), oldDirUrl: pathToFileURL(path.dirname(oldPath)).href, movedImages };
});

// Pictures (doc-pictures.ts) -----------------------------------------------------

setUpPictures({ docs, docFor, ensureWindow });
// The window asks about pictures only its open documents can show (see editing.ts).
picturesOf(() => docs.values());

// Recent documents ---------------------------------------------------------------

// Kept in memory (see recent-list.ts), so building the menus never waits on the disk.
const recent = new RecentList(recentFile(() => path.join(app.getPath("userData"), "recent.json")));
/** While Corillo starts, the menus are built once, after the documents it opens with. */
let launching = true;

/** The recent list changed: the menus and the start screen show it again. */
function recentChanged(): void {
  if (!launching) buildMenu();
  if (win && !win.isDestroyed() && rendererReady) win.webContents.send("app:recent-changed");
}

// Each document opened also goes on the Mac's own list of recent documents, which the Dock icon's menu and
// Apple menu > Recent Items show, named by the Mac (with ".md"). Corillo never empties that list: not at
// launch, nor when a document leaves Open Recent, nor with Clear Menu, so they keep his documents (review of
// Batch 11, B11R-7, which undid F-24's Dock menu of Corillo's own and its emptying of the Mac's list).

function addRecent(filePath: string): void {
  recent.add(filePath);
  if (process.platform === "darwin") app.addRecentDocument(filePath);
  recentChanged();
}

/** An open document renamed or moved: the Mac's list gets it where it is now too. */
function replaceRecent(oldPath: string, newPath: string): void {
  recent.replace(oldPath, newPath);
  if (process.platform === "darwin") app.addRecentDocument(newPath);
  recentChanged();
}

let recheckingRecent: Promise<void> | null = null;
/** Look again, without holding anything up, which recent documents are there (coming back to Corillo). */
function recheckRecent(): Promise<void> {
  recheckingRecent ??= recent
    .recheck()
    .then((changed) => {
      if (changed) buildMenu();
    })
    .catch((err) => console.error("Couldn't look again at the recent documents.", err))
    .finally(() => (recheckingRecent = null));
  return recheckingRecent;
}

// The start screen's cards show missing documents too, so they can be taken off the list;
// one found missing there leaves File > Open Recent at the same time.
ipcMain.handle("app:recent-cards", async () => {
  let cards = await cardsWithStandings(recent.all().slice(0, START_SCREEN_CARDS));
  // Moved or renamed since: looked for by identity on disk, and shown where it is now.
  const missing = cards.filter((c) => c.state === "missing").map((c) => c.path);
  if (missing.length) {
    const finding = followMoved(missing);
    const found = await within(finding, FOLLOW_WAIT_MS);
    if (found?.size) cards = await cardsWithStandings(recent.all().slice(0, START_SCREEN_CARDS));
    else if (found === null) void finding.then((late) => late.size && recentChanged());
  }
  let changed = false;
  for (const card of cards) if (card.state === "missing") changed = recent.missing(card.path) || changed;
  if (changed) buildMenu();
  return cards;
});
ipcMain.handle("app:forget-recent", (_e, filePath: unknown) => {
  if (typeof filePath !== "string") return;
  recent.forget(filePath);
  recentChanged();
});
ipcMain.handle("app:clear-recent", () => clearRecent());

function clearRecent(): void {
  recent.clear();
  recentChanged();
}

// Tests set the recent list by writing its file, as it is before Corillo
// starts; this reads it again. Only the app itself can say it, not a page.
(app as NodeJS.EventEmitter).on("corillo-recent-from-disk", () => {
  recent.reload();
  recentChanged();
});

// Where each recent document stands, and recent documents moved while closed (roadmap Batch 4, item 3).

/** How long the cards, once read, wait for where their documents stand; after that they show without it, and it follows. */
const STANDING_GRACE_MS = 50;
/** How long the start screen waits to find documents moved while closed before calling them can't be found (they follow if found later). */
const FOLLOW_WAIT_MS = 1500;
/** Standings read too late for the cards they were for: the next look uses them, once. */
let lateStandings: Map<string, Standing | null> | null = null;

/** The cards for these documents, each with where it stands: read alongside them, and never holding them up for long. */
async function cardsWithStandings(paths: string[]): Promise<RecentCard[]> {
  const late = lateStandings;
  lateStandings = null;
  const asking = paths.filter((p) => !late?.has(p));
  const standings = readStandings(asking, store, (id) => agents.service.agentsOn(id)).catch(() => asking.map(() => null));
  const cards = await readRecentCards(paths, homeDir());
  const inTime = await within(standings, STANDING_GRACE_MS);
  if (!inTime) {
    void standings.then((s) => {
      lateStandings = new Map(asking.map((p, i) => [p, s[i]]));
      if (win && rendererReady) win.webContents.send("app:recent-changed");
    });
  }
  const by = new Map(late ?? []);
  inTime?.forEach((s, i) => by.set(asking[i], s));
  return cards.map((c) => (c.state === "ok" ? { ...c, standing: by.get(c.path) ?? null } : c));
}

/**
 * Recent documents not at their paths, looked for by their identity on disk
 * (all in one helper run). One moved or renamed while closed has what Corillo
 * keeps for it and its place on the list follow it, and Open Recent with
 * them. One in a Trash, or put away in a hidden or temporary
 * folder, isn't followed: it's gone, as if deleted. Says where each found went.
 */
async function followMoved(paths: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  try {
    const known = store.knownAt(paths);
    const open = new Set([...docs.values()].map((d) => d.storeId));
    const items = paths.flatMap((was, i) => {
      const k = known[i];
      return k && !open.has(k.id) ? [{ was, k }] : [];
    });
    if (!items.length) return found;
    const went = await movedTo(items.map(({ was, k }) => ({ was, id: { ino: k.ino, dev: k.dev } })));
    items.forEach(({ was, k }, i) => {
      const to = went[i];
      if (!to || !recent.all().includes(was)) return;
      store.moved(k.id, to);
      recent.moved(was, to);
      found.set(was, to);
    });
  } catch (err) {
    console.error("Couldn't look for recent documents that moved.", err);
  }
  if (found.size && !launching) buildMenu();
  return found;
}

// Found moved by the look after launch (or opened where it went): the recent list follows it, unless it's gone to a Trash or put away.
store.onFoundMoved = (from, to) => {
  if (inTrash(to) || putAway(to, from) || !recent.moved(from, to)) return;
  recentChanged();
};

/**
 * Find it… on a card that can't be found: the person shows Corillo where the
 * document is now. The file chosen is checked to be that document (the same
 * file on disk, or the text Corillo last saved) before its comments and
 * history join it. Another file opens as itself, if the person still wants
 * it, and the card stays.
 */
ipcMain.handle("app:find-recent", async (_e, filePath: unknown) => {
  if (typeof filePath !== "string" || !recent.all().includes(filePath)) return;
  const name = named(filePath);
  const { canceled, filePaths } = await dialog.showOpenDialog({
    message: `Choose ${name} where it is now.`,
    defaultPath: path.dirname(filePath),
    properties: ["openFile"],
    filters: [
      { name: "Markdown", extensions: ["md", "markdown", "mdown", "txt"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  const picked = !canceled && filePaths[0] ? path.resolve(filePaths[0]) : null;
  if (!picked) return;
  if (picked === filePath) return openRecent(filePath); // back in its place
  let text: string;
  try {
    text = readText(picked);
  } catch {
    openDocument(picked); // says why it can't be opened
    return;
  }
  const was = store.knownAt([filePath])[0];
  let same: boolean;
  try {
    same = !was || store.isDocument(was.id, picked, text);
    if (same && was) store.moved(was.id, picked);
  } catch (err) {
    cantReadRecords(picked, err);
    return;
  }
  if (same) {
    recent.moved(filePath, picked);
    openDocument(picked);
    return;
  }
  const { response } = await dialog.showMessageBox(ensureWindow(), {
    type: "question",
    message: `That isn't ${name} as Corillo knew it.`,
    detail: "It's another file, so it opens as a document of its own, without the comments and history of the one that can't be found.",
    buttons: ["Open It Anyway", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) openDocument(picked);
});

// Asking from the window -------------------------------------------------------------

ipcMain.handle("app:open-dialog", () => showOpenDialog());
ipcMain.handle("app:new-document", () => newDocument());
/**
 * The window opens a document by path only when the person chose it: a card
 * of the recent list, or a file dropped on the window (the bridge says so,
 * having found it from the dropped file itself). Anything else is refused, so
 * a script that somehow ran in the window can't open, then save over, a file
 * nobody chose.
 */
ipcMain.handle("app:open-path", (_e, filePath: unknown, dropped: unknown) => {
  if (typeof filePath !== "string") return;
  if (dropped === true) {
    openDocument(filePath);
    return;
  }
  if (recent.all().includes(path.resolve(filePath))) return openRecent(filePath);
  console.error("The window asked to open a file that wasn't offered to it, so Corillo didn't.");
});

/**
 * Open a document from the recent list (the start screen, File > Open
 * Recent). One that was moved or deleted since says so, and leaves the Open
 * Recent menu; its start-screen card says it can't be found.
 */
async function openRecent(filePath: string): Promise<void> {
  if (fs.existsSync(filePath)) {
    openDocument(filePath);
    return;
  }
  const now = (await followMoved([filePath])).get(filePath);
  if (now) {
    openDocument(now);
    return;
  }
  recent.missing(filePath); // shown again without it (it stays remembered, in case it comes back)
  recentChanged();
  await dialog.showMessageBox(ensureWindow(), {
    type: "info",
    message: `Corillo can't find ${named(filePath)}.`,
    detail: "It may have been moved, renamed or deleted.",
  });
}
// The window opens a link only if it's in the document: the document's text
// as last saved is read the same way the window reads it (see doc-links.ts).
// A link typed a moment ago and clicked at once is waited for until that
// typing is saved (within two seconds, see the tab's saving).
const LINK_SAVE_WAIT_MS = 3000;

/** A link the window asked to open isn't in its document as saved: refused, and the person is told. */
function linkRefused(doc: OpenDoc, what: "link" | "note link"): void {
  notice(
    `Corillo can't open this ${what}.`,
    "It opens only links saved in the document, and this one isn't saved there. If the document can't be saved right now, the status bar says why.",
    doc.id,
  );
}

/** Whether the document's text, as last saved, passes this test, waiting a moment for typing not saved yet. */
async function inDocument(doc: OpenDoc, has: (text: string) => boolean): Promise<boolean> {
  const until = Date.now() + LINK_SAVE_WAIT_MS;
  let looked: string | null = null;
  for (;;) {
    if (doc.diskText !== looked) {
      looked = doc.diskText;
      if (has(looked)) return true;
    }
    if (Date.now() >= until || !docs.has(doc.id)) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// A link in a document (Cmd-click, or Open Link): a web or email address
// opens in the browser. A link to a file follows the Obsidian links' rules
// below: a document opens in a tab, another kind of file is shown in Finder,
// never run, and one that can't be found says so. A heading the window
// couldn't find in the document (#risks) says so too.
ipcMain.handle("app:open-link", async (_e, href: unknown, id: unknown) => {
  if (typeof href !== "string" || typeof id !== "string") return;
  const doc = docs.get(id);
  if (!doc) return;
  // Only a link that's in the document, which the person clicked: one the window made up is refused.
  if (!href.startsWith("#") && !(await inDocument(doc, (text) => linksIn(text).has(linkKey(href))))) {
    linkRefused(doc, "link");
    return;
  }
  if (/^(https?|mailto):/i.test(href)) return shell.openExternal(linkKey(href)); // written as browsers expect: Café as Caf%C3%A9
  const say = (message: string, detail: string) => dialog.showMessageBox(ensureWindow(), { type: "info", message, detail });
  const decoded = (part: string) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  if (href.startsWith("#")) {
    const heading = decoded(href.slice(1)).trim();
    if (heading) await say(`Corillo can't find the heading "${heading}".`, "It isn't in this document. It may have been renamed or taken out.");
    return;
  }
  // Any other kind of address isn't Corillo's to open. (A file: address isn't a link in a document: Markdown readers leave it as text.)
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return;
  const written = decoded(href.replace(/[?#].*$/, ""));
  if (!written) return;
  let file: string | null = path.resolve(path.dirname(doc.filePath), written);
  if (!fs.existsSync(file)) file = path.isAbsolute(written) ? null : await findLinked(doc.filePath, written);
  if (file && OPENS_AS_MARKDOWN.test(file) && fs.statSync(file).isFile()) openDocument(file);
  else if (file) shell.showItemInFolder(file); // another kind of file is shown in Finder, never run
  else await say(`Corillo can't find "${written}".`, "It isn't where the link points. It may not have been written yet, or it may have been moved or renamed.");
});

// Obsidian links (see vault.ts for where Corillo looks).
ipcMain.handle("obsidian:find-picture", async (_e, id: string, name: string) => {
  const doc = docs.get(id);
  if (!doc || typeof name !== "string" || !isPicture(name)) return null; // a picture, never another kind of file
  const file = await findLinked(doc.filePath, name);
  return file ? pathToFileURL(file).href : null;
});
ipcMain.handle("obsidian:open-note", async (_e, id: string, target: string) => {
  const doc = docs.get(id);
  if (!doc || typeof target !== "string") return;
  if (!(await inDocument(doc, (text) => notesIn(text).has(target)))) {
    linkRefused(doc, "note link");
    return;
  }
  const file = await findLinked(doc.filePath, target);
  if (file && MARKDOWN_NAMED.test(file)) openDocument(file);
  else if (file) shell.showItemInFolder(file); // another kind of file is shown in Finder, never run
  else
    await dialog.showMessageBox(ensureWindow(), {
      type: "info",
      message: `Corillo can't find the note "${target}".`,
      detail: "It isn't next to this document or anywhere in its Obsidian vault. It may not have been written yet, or it may have been renamed.",
    });
});

// Word and PDF export (see export.ts).
registerExport({ docPath: (id) => docFor(id).filePath, window: () => ensureWindow(), waitingPictures: waitingAt });

/** A new, empty document: the person picks its name and folder, and it opens in a tab. */
async function newDocument(): Promise<void> {
  const last = recent.entries()[0]?.path;
  const folder = last && fs.existsSync(path.dirname(last)) ? path.dirname(last) : app.getPath("documents");
  const result = await dialog.showSaveDialog(ensureWindow(), {
    title: "New document",
    defaultPath: path.join(folder, "Untitled.md"),
    buttonLabel: "Create",
    properties: ["createDirectory"],
  });
  if (result.canceled || !result.filePath) return;
  // Always a Markdown file, whatever ending was typed ("Plan.docx" is made as "Plan.md").
  const typed = path.resolve(result.filePath);
  const target = path.join(path.dirname(typed), newDocumentName(path.basename(typed)));
  if (fs.existsSync(target)) {
    // Never empty out a file that's already there, even if the Mac asked to replace it.
    await dialog.showMessageBox(ensureWindow(), {
      type: "info",
      message: `There's already a file called ${path.basename(target)} there.`,
      detail: "Choose another name, or open that file with File > Open.",
    });
    return;
  }
  try {
    writeDocument(target, "");
  } catch (err) {
    await dialog.showMessageBox(ensureWindow(), {
      type: "warning",
      message: `Corillo couldn't create ${path.basename(target)}.`,
      detail: problemText(err),
    });
    return;
  }
  try {
    store.created(target); // a new document, even if one by that name was here before
  } catch (err) {
    console.error("Couldn't note a new document.", err); // opening it says so if the records can't be read
  }
  const doc = openDocument(target);
  const stamp = doc && stampOf(target);
  if (doc && stamp) madeEmpty.set(doc.id, { filePath: target, ...stamp });
}

/**
 * An empty document's Copy a request (P-8): what to paste in an agent's chat,
 * naming the document and its folder as the person knows them, for a new
 * chat to find it ("Q4 brief", "Documents › Work").
 */
ipcMain.handle("doc:copy-draft-request", (_e, id: string) => {
  const doc = docs.get(id);
  if (!doc) return false;
  clipboard.writeText(draftRequest(path.basename(doc.filePath), shortFolder(path.dirname(doc.filePath), homeDir())));
  madeEmpty.delete(id); // an agent may be about to write it: closing its tab leaves it (B5-07)
  return true;
});

/**
 * The new documents Corillo made, by tab, as it made them: an empty file, its
 * identity on disk and when it was written. One whose tab closes (or that is
 * still open when Corillo quits) still just so is taken away again, with its
 * place on the recent list, so a New Document closed with nothing typed
 * leaves no empty "Untitled.md" behind (roadmap Batch 5, item 2), as Word
 * leaves no file for a new document never saved. Anything written to it (the
 * person's typing, an agent, another app) changes when it was written, and a
 * rename or a move changes its path: then it stays. So does any file Corillo
 * didn't make this way.
 */
const madeEmpty = new Map<string, { filePath: string; ino: number; dev: number; mtimeMs: number }>();

/** A file's identity on disk and when it was written; null if it can't be looked at (then it's never taken away). */
function stampOf(filePath: string): { ino: number; dev: number; mtimeMs: number } | null {
  try {
    const { ino, dev, mtimeMs } = fs.statSync(filePath);
    return { ino, dev, mtimeMs };
  } catch {
    return null;
  }
}

/** A tab closing, or Corillo quitting: a new document still as Corillo made it goes (see madeEmpty). */
function takeAwayIfUntouched(doc: OpenDoc): void {
  const made = madeEmpty.get(doc.id);
  if (!made) return;
  madeEmpty.delete(doc.id);
  if (made.filePath !== doc.filePath || doc.missing) return;
  try {
    const now = fs.statSync(doc.filePath);
    if (now.size !== 0 || now.ino !== made.ino || now.dev !== made.dev || now.mtimeMs !== made.mtimeMs) return;
    if (comments.threads(doc.storeId).length) return; // a comment on the whole of it is something
    fs.unlinkSync(doc.filePath);
  } catch {
    return; // can't tell, or can't take it away: it stays, as any file would
  }
  recent.forget(doc.filePath);
  forgetTab(doc.filePath); // not brought back at the next launch either
  recentChanged();
}

async function showOpenDialog(): Promise<void> {
  const result = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [
      // A Word document opens as a Markdown copy (see openWordDocument); one in Word's older format says what to do.
      { name: "Markdown and Word documents", extensions: ["md", "markdown", "mdown", "txt", "docx", "doc"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  for (const f of result.filePaths) openDocument(f);
}

// Menus (see menus.ts) ------------------------------------------------------------------

/** Whether a message came from the document window's page. */
const isMainWindow = (contents: WebContents) => !!win && !win.isDestroyed() && contents === win.webContents;

setUpMenus({
  window: () => (win && !win.isDestroyed() && rendererReady ? win : null),
  isMainWindow,
  recent: () => recent.entries(),
  newDocument: () => void newDocument(),
  open: () => void showOpenDialog(),
  openRecent: (filePath) => void openRecent(filePath),
  clearRecent: () => clearRecent(),
  closeTab: () => {
    if (docs.size && win && rendererReady) win.webContents.send("menu", "close-tab");
    else win?.close();
  },
  closeWindow: () => win?.close(),
});

// It's your turn: the Dock's count of documents waiting for the person, the
// Window menu's list of documents, and the coquí call (your-turn.ts).
setUpYourTurn({
  page: () => (win && !win.isDestroyed() && rendererReady ? win.webContents : null),
  isMainWindow,
  show: (id) => {
    if (!docs.has(id)) return;
    send("tabs:activate", id);
    bringForward();
  },
  menusChanged: () => {
    if (!launching) buildMenu();
  },
  listWindow: (listed) => {
    if (process.platform === "darwin" && win && !win.isDestroyed()) win.excludedFromShownWindowsMenu = !listed;
  },
  offline: hidden,
});

// The tabs open when Corillo quits come back when it opens again (open-tabs.ts): the window says their order.
setUpOpenTabs({
  pathOf: (id) => docs.get(id)?.filePath ?? null,
  isMainWindow,
});

// Starting up -------------------------------------------------------------------------

/** The documents named on a command line, found from the folder it was typed in. */
function filesFromArgs(argv: string[], folder = process.cwd()): string[] {
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((a) => !a.startsWith("-"))
    .map((a) => path.resolve(folder, a))
    .filter((a) => {
      try {
        return fs.statSync(a).isFile();
      } catch {
        return false;
      }
    });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv, workingDirectory) => {
    const files = filesFromArgs(argv, workingDirectory);
    for (const f of files) openDocument(f);
    if (!files.length && !argv.includes("--background")) bringForward();
  });

  // Finder "Open With" and dropping files on the Dock icon.
  app.on("open-file", (e, filePath) => {
    e.preventDefault();
    if (app.isReady()) openDocument(filePath);
    else pendingOpens.push(filePath);
  });

  app.on("before-quit", () => {
    quitting = true;
  });

  app.on("will-quit", () => {
    tabsQuit(); // a clean quit: the tabs come back next time, as they are
    turnsQuit(); // no count left on the Dock icon
    agents.service.endAllPasses(); // the history keeps each agent's pass, with the comments it answered
    agents.close();
  });

  app.on("window-all-closed", () => {
    if (quitting || process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    // No window, or one an agent asked for that hasn't shown yet: either way, it's the person's now.
    if (!win || win.isDestroyed() || !win.isVisible()) bringForward();
  });

  app.whenReady().then(() => {
    refusePermissions();
    plainWebRequests((url) => waiting.blocks(url)); // the windows ask the web for pictures without cookies or a name that says who asks, and never for one that waits
    applyAppearance(); // before the first window, so it opens in the colours chosen
    // An agent's call waits for the tabs Corillo is bringing back, if it is, so it finds them open (open-tabs.ts).
    agents.listen(socketPathFor(app.getPath("userData")), untilTabsBack);
    ensureWindow(startedByAgent);
    // What can wait does, until a moment after a window first shows (see ensureWindow), so it never holds up the first
    // document; or, if no window has shown by then (closed at once, or its page crashed), a while after launch.
    afterLaunchFallback = setTimeout(() => startAfterLaunch(0), AFTER_LAUNCH_FALLBACK_MS);
    setUpAgentConnections({ send, notice, bringForward, agentsProblem: agents.problem });
    // The tabs open when Corillo last quit (roadmap Batch 10, item 2), unless the last launch that brought them back ended unexpectedly.
    const back = tabsToBringBack(
      (text, detail) => notice(text, detail),
      recovery.all().map(({ entry }) => path.resolve(entry.filePath)),
    );
    // What Corillo knows each listed document as, read before the launch's own documents open: one of those may be a listed one
    // where it went (renamed in Finder, then opened from there), found by its records (B10-2).
    const records = back ? store.knownAt(back.tabs) : [];
    const opening = [...pendingOpens, ...filesFromArgs(process.argv)];
    try {
      for (const f of opening) openDocument(f); // in front, as always: Finder, the Dock, a Word document, a command line
      if (!back) offerRecovered();
    } finally {
      if (!back) launching = false;
      buildMenu(); // once, with the documents Corillo opened with on the recent list (and once more when the tabs are back)
    }
    if (!back) return;
    // They come back in the background: nobody's, never taking focus, the one in front first. Never into a
    // window opened for them: if the person closed the window meanwhile, or quit, the rest stay closed.
    const up = () => !!win && !win.isDestroyed() && !quitting;
    void bringBackTabs(
      back,
      {
        open: (filePath) => (up() ? (openDocument(filePath, { background: true })?.id ?? null) : null),
        openAlready: (listed) => {
          const record = records[back.tabs.indexOf(listed)]?.id;
          return [...docs.values()].find((d) => (record && d.storeId === record) || d.filePath === listed)?.id ?? null;
        },
        findMoved: followMoved,
        keptAfterCrash: () => recovery.all().map(({ entry }) => entry.filePath),
        place: (ids) => up() && send("tabs:place", ids),
        activate: (id) => up() && send("tabs:activate", id),
        say: (text, detail) => notice(text, detail),
      },
      { frontTaken: opening.length > 0 },
    ).finally(() => {
      try {
        offerRecovered(); // edits kept after a crash come back once: in the tab brought back, if their document's is
      } finally {
        launching = false;
        buildMenu();
      }
    });
  });
  app.on("browser-window-focus", () => {
    recheckOpen();
    void recheckRecent();
  });
}

const AFTER_LAUNCH_MS = 2000;
const AFTER_LAUNCH_FALLBACK_MS = 8000;

let launchDone = false;
let afterLaunchStarted = false;
let afterLaunchFallback: NodeJS.Timeout | undefined;

/** The work after launch, once a session, `delay` ms from now. */
function startAfterLaunch(delay: number): void {
  if (afterLaunchStarted) return;
  afterLaunchStarted = true;
  clearTimeout(afterLaunchFallback);
  setTimeout(() => void afterLaunch(), delay);
}

/**
 * Settings an older Corillo kept that this one no longer has, let go of:
 * Review > Waiting for You First (roadmap Batch 9, item 8). Never an error.
 */
function dropRetiredSettings(): void {
  // writeView keeps every other setting, and a setting given as undefined is left out of the file.
  if ("waitingFirst" in readView()) writeView({ waitingFirst: undefined });
}

/** Once Corillo is up and its window showing. */
async function afterLaunch(): Promise<void> {
  try {
    dropRetiredSettings();
    repairConnections(); // agent tools left pointing at a copy of Corillo that's gone
    // Recent documents gone since last time leave File > Open Recent; documents gone for 30 days are cleared.
    await Promise.all([recheckRecent(), sweepNow(true)]);
  } finally {
    launchDone = true;
    app.emit("corillo-launch-done");
  }
}
// Tests that measure Corillo's use of memory, files and timers start from a
// settled app: they ask for the work after launch to be done, and wait if not.
const said = app as NodeJS.EventEmitter;
said.on("corillo-when-launched", (done: () => void) => (launchDone ? done() : said.once("corillo-launch-done", done)));

// Documents gone for 30 days -------------------------------------------------------------
// What Corillo keeps for a document whose file has been gone 30 days is
// cleared (see DocumentStore.sweep). Looked at when Corillo starts, and then
// at most once a day, when a document is opened or closed: never on a timer.

const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;
let lastSweep = Date.now(); // the first look is just after launch (see afterLaunch), not at the first document opened
let sweeping = false;

function sweepNow(atLaunch = false): Promise<void> {
  if (sweeping || (!atLaunch && Date.now() - lastSweep < SWEEP_EVERY_MS)) return Promise.resolve();
  sweeping = true;
  lastSweep = Date.now();
  const open = new Set([...docs.values()].map((d) => d.storeId));
  for (const { id } of recovery.all()) open.add(id); // edits waiting to be saved keep theirs
  return store
    .sweep(open)
    .then(() => undefined, (err) => console.error("Couldn't look for documents gone 30 days.", err))
    .finally(() => (sweeping = false));
}

/**
 * Edits that weren't saved when Corillo last closed (it crashed, or was
 * forced to quit, while a document couldn't be saved) come back in their
 * tabs, for the person to keep or not.
 */
function offerRecovered(): void {
  for (const { id, entry } of recovery.all()) {
    let doc = [...docs.values()].find((d) => d.storeId === id || sameFile(d.filePath, entry.filePath)) ?? null;
    const disk = readDisk(entry.filePath);
    if (!doc && disk.kind === "text") doc = openDocument(entry.filePath, { background: true });
    if (!doc) {
      // Gone (or unreadable) since: a tab with the edits, ready to save somewhere.
      const missing = disk.kind === "missing";
      doc = { id: randomUUID(), storeId: id, filePath: path.resolve(entry.filePath), diskText: entry.base, missing };
      docs.set(doc.id, doc);
      watchFile(doc);
      send("tabs:open", infoOf(doc), { background: true });
    }
    send("doc:recovered", doc.id, entry.text);
    if (doc.missing) send("doc:missing", doc.id);
  }
}
