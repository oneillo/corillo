// Your tabs come back as you left them (roadmap Batch 10, item 2). Orlando,
// 2026-11-13: "If we close it with open tabs, then it restores to that state
// the next time the app is opened."
//
// Corillo keeps the list of open tabs in its data folder (open-tabs.json):
// their documents' paths, in the tab bar's order, and the one in front. Paths
// only. It's written whole (writeAtomic) when the tabs change, as the window
// says: a tab opened, closed, moved or brought to the front, or its document
// renamed (src/renderer/tab-order.ts, and doc:active); never on a timer, but
// once, half a minute after tabs come back, to clear the mark (below).
// Closing the window empties it, so the next launch shows the start screen;
// quitting leaves it as it is.
//
// At launch the documents on it open again, the one in front first, without
// holding the window up: where each is is looked at off Corillo's main
// thread, with a short limit. One moved while closed opens where it went, if
// the start screen's own look (its identity on disk, one helper run) finds it
// in time. One gone, one Corillo can't read, one on a drive that isn't
// connected or a share that doesn't answer, or one over 10 MB (which asks
// before it opens) is left out, and one
// line in the window's corner names it: never a question at launch. A tab
// brought back is nobody's: it opens as any document does, so agents'
// passes and waits that quitting ended stay ended.
//
// While the tabs are being brought back the list carries a mark, cleared once
// they've been open half a minute, or at a clean quit. A launch that finds it
// still set (Corillo closed unexpectedly after bringing them back) opens on
// the start screen with a line saying why, rather than bring them back
// blindly again, as the window's own reopen stops after a second stop.
import { app, ipcMain, type WebContents } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { shownName } from "../core/doc-names";
import { LONG_DOCUMENT_BYTES } from "./files";
import { writeAtomic } from "./store";
import { changingPlaces, placeAvailable } from "./whereabouts";

/** The list, as kept in the data folder. */
export interface SavedTabs {
  /** The open documents' paths, in the tab bar's order. */
  tabs: string[];
  /** The one in front. */
  front: string | null;
  /** Set while the tabs are being brought back (see above). */
  restoring?: boolean;
}

/** More than anyone opens; a list that says more is cut short. */
const MAX_TABS = 1000;
/** How long the look at where the documents are may take, all together, before those not answering are left out as away. */
const LOOK_LIMIT_MS = 1500;
/** How long the look for documents moved while closed may take, as the start screen waits for it. */
const FOLLOW_LIMIT_MS = 1500;
/** How long an agent's call waits for the tabs to come back before going ahead anyway. */
const AGENT_WAIT_MS = 3000;
/** The window up this long with the tabs back: they didn't make Corillo close, so the mark goes. */
const SETTLED_MS = 30_000;

const hidden = process.env.CORILLO_HIDDEN === "1";
/** Tests only: how long the tabs must be back before the mark goes, so a test needn't wait half a minute. */
const settledMs = () => (hidden && Number(process.env.CORILLO_TABS_SETTLED_MS) > 0 ? Number(process.env.CORILLO_TABS_SETTLED_MS) : SETTLED_MS);

// Read lazily: the data folder is only known once main.ts has set it.
const listFile = () => path.join(app.getPath("userData"), "open-tabs.json");

/** The list's text as Corillo last wrote (or read) it, so the same list isn't written again. */
let written = "";

/** The list kept in the data folder; an unreadable or damaged one is no list (the start screen). */
export function readSaved(file = listFile()): SavedTabs {
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (file === listFile()) written = raw;
    const data = JSON.parse(raw) as Record<string, unknown>;
    const tabs = Array.isArray(data.tabs) ? data.tabs.filter((p): p is string => typeof p === "string" && path.isAbsolute(p)) : [];
    const unique = [...new Set(tabs)].slice(0, MAX_TABS);
    const front = typeof data.front === "string" && unique.includes(data.front) ? data.front : null;
    return { tabs: unique, front, ...(data.restoring === true ? { restoring: true } : {}) };
  } catch {
    return { tabs: [], front: null };
  }
}

/** Write the list whole, unless it says what the file already does. Never an error: the list is a convenience. */
function write(list: SavedTabs): void {
  const text = JSON.stringify(list.restoring ? list : { tabs: list.tabs, front: list.front }, null, 2);
  if (text === written) return;
  try {
    fs.mkdirSync(path.dirname(listFile()), { recursive: true });
    writeAtomic(listFile(), text);
    written = text;
  } catch (err) {
    console.error("Couldn't keep the list of open tabs.", err);
  }
}

export interface TabsHost {
  /** The path of the document open in this tab, or null. */
  pathOf(id: string): string | null;
  /** Whether a message came from the document window's page. */
  isMainWindow(contents: WebContents): boolean;
}

let host: TabsHost | null = null;
/** The tabs, by id, in the bar's order, as the window last said. */
let order: string[] = [];
/** The tab in front, as the window last said. */
let frontId: string | null = null;
/** The list as last written. */
let saved: SavedTabs = { tabs: [], front: null };
/** The tabs are being brought back, or were moments ago (see above). */
let marked = false;
let settling: NodeJS.Timeout | null = null;
/** The window's page stopped working and it's being reopened: the list stays as it was until the new page says its tabs' order. */
let awaitingOrder = false;
/** While the tabs come back: the list's documents not yet opened or left out, which stay on it meanwhile (B10-6). */
let coming = new Set<string>();
/** The list being brought back, in its order. */
let comingFrom: string[] = [];
/** Corillo is quitting: the list stays as it is now. */
let quitting = false;
/** While the tabs come back: the order the window last said, and the order the restore last asked it for (by id). */
let seen: string[] = [];
let asked: string[] | null = null;
/** The person moved a tab while the tabs were coming back: from then on the order is his, and the restore leaves it (B10-6). */
let movedMeanwhile = false;

/** The list as the window shows the tabs now: written if it changed. */
function note(): void {
  if (!host || awaitingOrder || quitting) return;
  const tabs: string[] = [];
  for (const id of order) {
    const p = host.pathOf(id);
    if (p && !tabs.includes(p)) tabs.push(p);
  }
  withComing(tabs);
  const front = frontId ? host.pathOf(frontId) : null;
  saved = { tabs, front: front && tabs.includes(front) ? front : null, ...(marked ? { restoring: true } : {}) };
  write(saved);
}

const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Whether a new order the window says, while the tabs come back, is only
 * tabs opened or closed, or the order the restore asked for; anything else is
 * the person moving a tab.
 */
function explained(ids: string[]): boolean {
  const now = new Set(ids);
  const before = seen.filter((id) => now.has(id)); // the tabs there before, in their order then
  const was = new Set(before);
  const after = ids.filter((id) => was.has(id)); // the same tabs, in their order now
  if (sameOrder(before, after)) return true;
  if (!asked) return false;
  const at = new Map(asked.map((id, i) => [id, i]));
  const last = asked.length;
  return sameOrder([...before].sort((a, b) => (at.get(a) ?? last) - (at.get(b) ?? last)), after);
}

/**
 * The documents still coming back go on the list too, each after the one
 * before it on the list, so Corillo quitting meanwhile leaves them on it in
 * their places (B10-6).
 */
function withComing(tabs: string[]): void {
  for (const p of comingFrom) {
    if (!coming.has(p) || tabs.includes(p)) continue;
    const before = comingFrom.slice(0, comingFrom.indexOf(p)).reverse().find((q) => tabs.includes(q));
    tabs.splice(before ? tabs.indexOf(before) + 1 : 0, 0, p);
  }
}

/** Set up once, as the app starts: the window says the tabs' order (tab-order.ts) and which is in front. */
export function setUpOpenTabs(h: TabsHost): void {
  host = h;
  ipcMain.on("tabs:order", (e, ids: unknown) => {
    if (!h.isMainWindow(e.sender) || !Array.isArray(ids) || ids.length > MAX_TABS || !ids.every((id) => typeof id === "string")) return;
    order = ids as string[];
    awaitingOrder = false;
    if (restoring && !explained(order)) movedMeanwhile = true;
    seen = order;
    note();
  });
  ipcMain.on("doc:active", (e, id: unknown) => {
    if (!h.isMainWindow(e.sender)) return;
    frontId = typeof id === "string" ? id : null;
    note();
  });
}

function stopSettling(): void {
  if (settling) clearTimeout(settling);
  settling = null;
}

/** The mark goes: the tabs that came back are just open tabs now. */
function unmark(): void {
  stopSettling();
  if (!marked) return;
  marked = false;
  saved = { tabs: saved.tabs, front: saved.front };
  write(saved);
}

/** The open documents in the tab bar's order, as the window last said: the order a window that stopped working reopens them in. */
export function tabsInOrder(): string[] {
  return [...saved.tabs];
}

/**
 * The window closed. Closed by the person (Close Window, its red button), no
 * tab is open: the next launch shows the start screen. Closed by quitting,
 * the list stays as the tabs were. Its page stopped working and it's being
 * reopened with its documents (`reopening`): the list stays as it was until
 * the new window says its order, so Corillo closing meanwhile loses nothing.
 */
export function tabsWindowClosed(quitting: boolean, reopening = false): void {
  if (quitting) {
    quitStarted();
    return;
  }
  order = [];
  frontId = null;
  if (reopening) {
    awaitingOrder = true;
    return;
  }
  awaitingOrder = false;
  coming = new Set();
  comingFrom = [];
  stopSettling();
  marked = false;
  saved = { tabs: [], front: null };
  write(saved);
}

/** Corillo has begun to quit: what the window says from now on (its tabs going) doesn't change the list. */
function quitStarted(): void {
  quitting = true;
}

/** A new document Corillo made was taken away again, untouched (main.ts, takeAwayIfUntouched): it isn't brought back. */
export function forgetTab(filePath: string): void {
  if (!saved.tabs.includes(filePath)) return;
  saved = { ...saved, tabs: saved.tabs.filter((p) => p !== filePath), front: saved.front === filePath ? null : saved.front };
  write(saved);
}

/** Corillo quits cleanly: the list stays, without the mark. */
export function tabsQuit(): void {
  quitStarted();
  unmark();
}

// Bringing them back ------------------------------------------------------------------------

/** Said in the window's corner when the last launch that brought tabs back ended unexpectedly. */
export const CLOSED_UNEXPECTEDLY = {
  text: "Your documents weren't opened again, since Corillo closed unexpectedly the last time it opened them.",
  detail: "Open them from the list when you're ready.",
};

/**
 * The line when the last launch that brought tabs back ended unexpectedly,
 * naming only the documents left closed: those with edits kept after the
 * crash (`kept`) come back by themselves. Null when none is left closed.
 */
export function closedUnexpectedlyLine(tabs: string[], kept: string[]): { text: string; detail: string } | null {
  const closed = tabs.filter((p) => !kept.includes(p));
  if (!closed.length) return null;
  if (closed.length === tabs.length) return CLOSED_UNEXPECTEDLY; // the start screen, with the list, is what shows
  const one = closed.length === 1;
  return {
    text: `${names(closed)} ${one ? "wasn't" : "weren't"} opened again, since Corillo closed unexpectedly the last time it opened ${one ? "it" : "them"}.`,
    detail: `Open ${one ? "it" : "them"} from File > Open Recent when you're ready.`,
  };
}

/**
 * What this launch brings back: the list kept when Corillo last quit, now
 * marked as being brought back. Null for nothing: no tabs were open, or the
 * last launch that brought them back ended unexpectedly (then the corner
 * says so, naming those not coming back with edits kept after the crash,
 * `kept`, and the list is emptied).
 */
export function tabsToBringBack(say: (text: string, detail: string) => void, kept: string[] = []): SavedTabs | null {
  const was = readSaved();
  saved = { tabs: was.tabs, front: was.front };
  if (was.restoring) {
    const line = closedUnexpectedlyLine(was.tabs, kept);
    if (line) say(line.text, line.detail);
    saved = { tabs: [], front: null };
    write(saved);
    return null;
  }
  if (!was.tabs.length) return null;
  marked = true;
  saved = { ...saved, restoring: true };
  write(saved);
  return was;
}

/**
 * Where a document on the list is: there (and how big), gone, out of reach (a
 * drive that isn't connected, a share that doesn't answer), or somewhere
 * Corillo can't read (permission refused, say).
 */
export type Look = { kind: "here"; size: number } | { kind: "gone" } | { kind: "away" } | { kind: "unreadable" };

/** A look's errors that mean a network share didn't answer, rather than that the document can't be read. */
const SHARE_DIDNT_ANSWER = new Set(["ETIMEDOUT", "EHOSTDOWN", "EHOSTUNREACH", "ENETDOWN", "ENETUNREACH", "ENOTCONN", "ECONNREFUSED", "ECONNRESET", "ESTALE"]);

/** Tests only: the look at this one path takes this long, as on a network share that's slow to answer. */
function slowLook(filePath: string): Promise<void> | null {
  const at = process.env.CORILLO_LOOK_DELAY_AT;
  const ms = Number(process.env.CORILLO_LOOK_DELAY_MS);
  if (!hidden || !at || path.resolve(at) !== filePath || !(ms > 0)) return null;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Where a document is, looked at without holding Corillo's main thread. */
export async function lookAt(filePath: string): Promise<Look> {
  await slowLook(filePath);
  try {
    const s = await fs.promises.stat(filePath);
    return s.isFile() ? { kind: "here", size: s.size } : { kind: "gone" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    // No such file on a drive that's there: moved or deleted; its drive not there, or a share not answering: out of reach.
    // Anything else (permission refused, say): Corillo can't read it (B10-8).
    if (code === "ENOENT" || code === "ENOTDIR") return placeAvailable(filePath, changingPlaces()) ? { kind: "gone" } : { kind: "away" };
    return code && SHARE_DIDNT_ANSWER.has(code) ? { kind: "away" } : { kind: "unreadable" };
  }
}

/** A promise's result, or null once `ms` have passed. */
export function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]).finally(() => clearTimeout(timer));
}

/** The documents left out, by why, in the list's order. */
export interface LeftOut {
  /** Moved or deleted, and not found where it went. */
  gone: string[];
  /** Somewhere Corillo can't read (permission refused, say). */
  unreadable: string[];
  /** On a drive that isn't connected, or a share that didn't answer (in time). */
  away: string[];
  /** Over 10 MB, which asks before it opens. */
  long: string[];
}

export interface RestoreParts {
  /** Open the document in a background tab; its tab's id, or null if it couldn't be opened (the corner says why). */
  open(filePath: string): string | null;
  /** The tab of a document on the list that's open already under another path (renamed, then opened from Finder where it went), or null. */
  openAlready(listed: string): string | null;
  /** Where documents moved while closed went, by their identity on disk (the start screen's look). */
  findMoved(paths: string[]): Promise<Map<string, string>>;
  /** Documents with edits kept after a crash: those come back with their tab anyway, so they're never named as left out. */
  keptAfterCrash(): string[];
  /** Put the window's tabs in this order (those not named stay after them). */
  place(ids: string[]): void;
  /** Bring this tab to the front, quietly. */
  activate(id: string): void;
  /** One line in the window's corner. */
  say(text: string, detail: string): void;
}

/** The restore going on now, if one is. */
let restoring: Promise<void> | null = null;

/**
 * Bring back the tabs on the list: the one in front first, unless the
 * launch opened a document to be in front (from Finder, say), then the rest,
 * each as soon as it's been found, put in the list's order. Settles once
 * they're open or left out, and never fails.
 */
export function bringBackTabs(list: SavedTabs, parts: RestoreParts, options: { frontTaken: boolean }): Promise<void> {
  const done = restore(list, parts, options)
    .catch((err) => {
      console.error("Couldn't bring back the tabs that were open.", err);
      return 0;
    })
    .then((count) => {
      restoring = null;
      if (!marked) return; // the window closed, or Corillo quit, meanwhile
      note(); // the list is what's open now, without the documents left out (the window may have nothing new to say)
      if (count) settling = setTimeout(unmark, settledMs());
      else unmark();
    });
  restoring = done;
  return done;
}

/** How many tabs came back. */
async function restore(list: SavedTabs, parts: RestoreParts, { frontTaken }: { frontTaken: boolean }): Promise<number> {
  comingFrom = list.tabs;
  coming = new Set(list.tabs);
  seen = order;
  asked = null;
  movedMeanwhile = false;
  try {
    return await bringBack(list, parts, frontTaken);
  } finally {
    coming = new Set();
    comingFrom = [];
    seen = [];
    asked = null;
  }
}

async function bringBack(list: SavedTabs, parts: RestoreParts, frontTaken: boolean): Promise<number> {
  const kept = new Set(parts.keptAfterCrash().map((p) => path.resolve(p)));
  const looks = new Map(list.tabs.map((p) => [p, within(lookAt(p), LOOK_LIMIT_MS)]));
  const opened = new Map<string, string>(); // a path on the list, to its tab's id
  const left: LeftOut = { gone: [], unreadable: [], away: [], long: [] };
  const gone: string[] = [];
  let firstOpened = null as string | null; // (set inside consider)
  /** The tabs brought back put in the list's order, unless he has moved one meanwhile: then they stay as he has them. */
  const place = () => {
    if (movedMeanwhile) return;
    asked = list.tabs.flatMap((p) => opened.get(p) ?? []);
    parts.place(asked);
  };
  /** Open it, or note why not. `at`: where it is now, for one found moved. */
  const consider = (listed: string, look: Look | null, at = listed): void => {
    if (look?.kind !== "gone") coming.delete(listed); // settled now (one gone may yet be found where it went)
    const already = look?.kind === "here" ? null : parts.openAlready(listed);
    if (already) {
      // Open already where it went: never named as left out, and put in its place (B10-2).
      opened.set(listed, already);
    } else if (!look || look.kind === "away") {
      if (!kept.has(listed)) left.away.push(listed);
    } else if (look.kind === "gone") {
      if (!kept.has(listed)) gone.push(listed);
    } else if (look.kind === "unreadable") {
      if (!kept.has(listed)) left.unreadable.push(listed);
    } else if (look.size > LONG_DOCUMENT_BYTES) {
      if (!kept.has(listed)) left.long.push(listed); // one with edits kept after a crash comes back in its tab anyway
    } else {
      const id = parts.open(at);
      if (id) {
        opened.set(listed, id);
        firstOpened ??= id;
      }
    }
  };
  // The one in front first, so the document seen first doesn't wait for the others.
  const first = !frontTaken && list.front ? list.front : null;
  if (first) consider(first, await looks.get(first)!);
  // Then the rest, each as soon as it's found, put in their places as they come.
  await Promise.all(
    list.tabs
      .filter((p) => p !== first)
      .map(async (p) => {
        consider(p, await looks.get(p)!);
        if (opened.has(p)) place();
      }),
  );
  // Moved while closed: found where it went by its identity on disk, if that's quick.
  if (gone.length) {
    const found = (await within(parts.findMoved(gone), FOLLOW_LIMIT_MS)) ?? new Map<string, string>();
    for (const p of [...gone]) {
      const to = found.get(p);
      const look = to ? await within(lookAt(to), LOOK_LIMIT_MS) : null;
      coming.delete(p);
      if (to && look?.kind === "here") consider(p, look, to);
      // Not found (or found too late): named as moved or deleted.
      if (!opened.has(p) && !left.long.includes(p)) left.gone.push(p);
    }
  }
  if (opened.size) {
    place();
    // The one that was in front is in front again, also when it was found late.
    const front = !frontTaken && list.front ? opened.get(list.front) : undefined;
    if (front && front !== firstOpened) parts.activate(front);
  }
  const line = leftOutLine(left);
  if (line) parts.say(line.text, line.detail);
  return opened.size;
}

/**
 * Whether an agent's call should wait for the tabs to come back first: a
 * promise while they're coming (settling within a few seconds at most, so
 * a share that doesn't answer can't hold an agent up), null otherwise. An
 * agent asking for "the open documents", or one by name, then finds them as
 * the person left them.
 */
export function untilTabsBack(): Promise<void> | null {
  if (!restoring) return null;
  const asked = Date.now();
  return within(restoring, AGENT_WAIT_MS).then(() => {
    app.emit("corillo-agent-waited-for-tabs", Date.now() - asked); // said for tests, which measure it
  });
}

// The corner line ----------------------------------------------------------------------------

const nameOf = (p: string) => shownName(path.basename(p));

/** "Plan", "Plan and Notes", "Plan, Notes and Budget"; past four, "Plan, Notes, Budget and 3 more". */
function names(paths: string[]): string {
  const all = paths.map(nameOf);
  const shown = all.length > 4 ? [...all.slice(0, 3), `${all.length - 3} more`] : all;
  return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/**
 * The one line in the window's corner for the documents left out, the
 * reasons in that order (moved or deleted, can't be read, a drive away, over
 * 10 MB); null when none were. Names are as the tabs show them, without ".md".
 * The tabs that came back cover the start screen's list, so a document is to
 * be opened from File > Open Recent (B10-8).
 */
export function leftOutLine(left: LeftOut): { text: string; detail: string } | null {
  const groups = [left.gone, left.unreadable, left.away, left.long].filter((g) => g.length);
  if (!groups.length) return null;
  if (groups.length === 1) {
    const one = groups[0].length === 1;
    const who = one ? names(groups[0]) : `${groups[0].length} documents`;
    if (left.gone.length) return one ? { text: `${who} couldn't be opened again.`, detail: "It was moved or deleted." } : { text: `${who} couldn't be opened again: ${names(left.gone)}.`, detail: "They were moved or deleted." };
    if (left.unreadable.length) return one ? { text: `${who} couldn't be opened again.`, detail: "Corillo can't read it." } : { text: `${who} couldn't be opened again: ${names(left.unreadable)}.`, detail: "Corillo can't read them." };
    if (left.away.length) return one ? { text: `${who} wasn't opened.`, detail: "It's on a drive or share that didn't answer." } : { text: `${who} weren't opened: ${names(left.away)}.`, detail: "They're on a drive or share that didn't answer." };
    return one
      ? { text: `${who} wasn't opened, since it's over 10 MB.`, detail: "Open it from File > Open Recent when you're ready." }
      : { text: `${who} weren't opened, since they're over 10 MB: ${names(left.long)}.`, detail: "Open them from File > Open Recent when you're ready." };
  }
  // Several reasons: who, then why, in that order.
  const all = [...left.gone, ...left.unreadable, ...left.away, ...left.long];
  const is = (g: string[]) => (g.length === 1 ? "is" : "are");
  const why = [
    left.gone.length ? `${names(left.gone)} ${left.gone.length === 1 ? "was" : "were"} moved or deleted.` : "",
    left.unreadable.length ? `Corillo can't read ${names(left.unreadable)}.` : "",
    left.away.length ? `${names(left.away)} ${is(left.away)} on a drive or share that didn't answer.` : "",
    left.long.length ? `${names(left.long)} ${is(left.long)} over 10 MB: open ${left.long.length === 1 ? "it" : "them"} from File > Open Recent when you're ready.` : "",
  ];
  return { text: `${all.length} documents weren't opened again: ${names(all)}.`, detail: why.filter(Boolean).join(" ") };
}
