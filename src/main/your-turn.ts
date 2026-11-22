// It's your turn (roadmap Batch 2, item 2; decision D5). The window says
// whose turn it is on each open document (turn:states, in tab order), and
// which are waiting for the person: back from an agent, or opened for them by
// one, and not looked at yet. From that, Corillo
// - puts the number of documents waiting on its Dock icon, down as they're
//   looked at, and none once the window closes or Corillo quits;
// - lists the open documents with their state in the Window menu, the one in
//   front ticked; choosing one brings its tab to the front;
// - plays the coquí call when a document starts waiting while Corillo isn't
//   the app in front, unless Corillo > Sound When It's Your Turn is off (on at
//   first, remembered in view.json). Documents coming back together get one
//   call, and a call covers what else comes back in the seconds after it.
//   Turning the sound on plays the call once, to hear it.
// Nothing here takes focus.
import { app, ipcMain, Menu, type MenuItemConstructorOptions, type WebContents } from "electron";
import { readView, writeView } from "./view-settings";

/** One open document, as the window reports it. */
export interface DocTurn {
  id: string;
  name: string;
  /** Whose turn, in words ("Back from Writer: 3 to read"); "" on a document no agent has worked on. */
  state: string;
  waiting: boolean;
}

export interface TurnHost {
  /** The document window's page, if it's there and ready (never a window made for this). */
  page(): WebContents | null;
  isMainWindow(contents: WebContents): boolean;
  /** Bring this document's tab, and the window, to the front (the person chose it in the Window menu). */
  show(id: string): void;
  /** The Window menu's list changed: build the menus again. */
  menusChanged(): void;
  /** Whether the document window is in the Mac's own list of windows: not while its documents are listed instead. */
  listWindow(listed: boolean): void;
  /** Test runs render the call without a sound. */
  offline: boolean;
}

/** A moment, so documents coming back together share one call. */
const SETTLE_MS = 700;
/** A call covers anything else that comes back this soon after it. */
const COVERS_MS = 3000;
const MAX_DOCS = 1000;
const MAX_WORDS = 1000;

let host: TurnHost | null = null;
let docs: DocTurn[] = [];
/** The document in front, as the window last said. */
let frontDoc: string | null = null;
/** Whether Corillo is the app in front. */
let front = false;
/** Documents that started waiting since the last call, while Corillo was behind. */
const news = new Set<string>();
let due: NodeJS.Timeout | null = null;
let lastCall = -Infinity;
let badge = "";
let soundOn: boolean | null = null;

function sound(): boolean {
  // Read lazily: the data folder is only known once main.ts has set it.
  soundOn ??= readView().turnSound !== false;
  return soundOn;
}

const isTurn = (d: unknown): d is DocTurn => {
  if (!d || typeof d !== "object") return false;
  const { id, name, state, waiting } = d as Record<string, unknown>;
  return typeof id === "string" && typeof name === "string" && typeof state === "string" && typeof waiting === "boolean" && name.length < MAX_WORDS && state.length < MAX_WORDS;
};

function setBadge(count: number): void {
  const text = count > 0 ? String(count) : "";
  if (text === badge) return;
  badge = text;
  app.dock?.setBadge(text);
}

function cancelCall(): void {
  if (due) clearTimeout(due);
  due = null;
  news.clear();
}

/** A document started waiting: call in a moment, if Corillo is still behind, it's still waiting, and no call just covered it. */
function callSoon(id: string): void {
  if (front || !sound()) return;
  news.add(id);
  due ??= setTimeout(() => {
    due = null;
    const stillWaiting = docs.some((d) => d.waiting && news.has(d.id));
    news.clear();
    if (front || !sound() || !stillWaiting || Date.now() - lastCall < COVERS_MS) return;
    lastCall = Date.now();
    host?.page()?.send("turn:call", host.offline);
  }, SETTLE_MS);
}

/** The window's report: the Dock's count, the Window menu, and a call for what's newly waiting. */
function received(list: DocTurn[]): void {
  const before = docs;
  const waitingBefore = new Set(before.filter((d) => d.waiting).map((d) => d.id));
  docs = list;
  setBadge(list.filter((d) => d.waiting).length);
  for (const d of list) if (d.waiting && !waitingBefore.has(d.id)) callSoon(d.id);
  // Nothing that was coming is waiting any more (looked at, or an agent took it straight away): no call, and no timer kept.
  if (due && !list.some((d) => d.waiting && news.has(d.id))) cancelCall();
  const shown = (l: DocTurn[]) => l.map((d) => `${d.id}\n${d.name}\n${d.state}`).join("\n\n");
  if (shown(list) !== shown(before)) {
    if (!list.length !== !before.length) host?.listWindow(!list.length);
    host?.menusChanged();
  }
}

function setFront(now: boolean): void {
  if (front === now) return;
  front = now;
  if (front) cancelCall(); // the person is here: nothing to call them for
  host?.page()?.send("app:in-front", front);
}

/** Set up once, as the app starts (before it's ready, so it hears it come to the front at launch). */
export function setUpYourTurn(h: TurnHost): void {
  host = h;
  if (process.platform === "darwin") {
    app.on("did-become-active", () => setFront(true));
    app.on("did-resign-active", () => setFront(false));
  }
  ipcMain.on("turn:states", (e, list: unknown) => {
    if (!h.isMainWindow(e.sender) || !Array.isArray(list) || list.length > MAX_DOCS || !list.every(isTurn)) return;
    received(list.map(({ id, name, state, waiting }) => ({ id, name, state, waiting })));
  });
  ipcMain.handle("app:in-front", () => front);
  // The window played a call: said for tests, which can't listen (in test runs it's rendered without a sound).
  ipcMain.on("turn:called", (e, heard: unknown) => {
    if (h.isMainWindow(e.sender)) app.emit("corillo-coqui", heard);
  });
}

/** The tab in front changed: its document is ticked in the Window menu. */
export function turnFront(id: string | null): void {
  frontDoc = id;
  const menu = Menu.getApplicationMenu();
  for (const d of docs) {
    const item = menu?.getMenuItemById(`window-doc-${d.id}`);
    if (item && item.checked !== (d.id === id)) item.checked = d.id === id;
  }
}

/** The window went away: no documents, nothing waiting. */
export function turnsGone(): void {
  cancelCall();
  docs = [];
  frontDoc = null;
  setBadge(0);
}

/** Corillo is quitting: the Dock icon keeps no count. */
export function turnsQuit(): void {
  cancelCall();
  setBadge(0);
}

/** The open documents, for the end of the Window menu, where the Mac lists windows. */
export function documentMenuItems(): MenuItemConstructorOptions[] {
  if (!docs.length) return [];
  return [
    { type: "separator" },
    ...docs.map(
      (d): MenuItemConstructorOptions => ({
        id: `window-doc-${d.id}`,
        label: d.name,
        ...(d.state ? { sublabel: d.state, toolTip: d.state } : {}),
        type: "checkbox",
        checked: d.id === frontDoc,
        click: (item) => {
          item.checked = d.id === frontDoc; // ticked by the window once it's in front
          host?.show(d.id);
        },
      }),
    ),
  ];
}

/**
 * Corillo > Sound When It's Your Turn. Ticked, it plays the call once, in
 * front or not, so the person hears what it sounds like, as the Mac plays an
 * alert sound when you pick it (roadmap Batch 6, item 5). Unticked, a call
 * that is coming or playing stops.
 */
export function soundMenuItem(): MenuItemConstructorOptions {
  return {
    id: "turn-sound",
    label: "Sound When It's Your Turn",
    type: "checkbox",
    checked: sound(),
    click: (item) => {
      soundOn = item.checked;
      writeView({ turnSound: item.checked });
      if (item.checked) host?.page()?.send("turn:call", host.offline);
      else {
        cancelCall();
        host?.page()?.send("turn:hush");
      }
    },
  };
}
