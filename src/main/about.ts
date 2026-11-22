// The About Corillo window: the coquí, the version and build, Corillo's own
// licence and the licences of the software it's built with (the packages
// inside it, Chromium inside Electron, and Pandoc when it's bundled).
import { app, BrowserWindow, ipcMain, shell, type MenuItemConstructorOptions } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { windowIs } from "./window-boundary";
import { soundMenuItem } from "./your-turn";

export interface PandocInfo {
  version: string;
  licence: string;
  sourceUrl: string;
}

export interface AboutInfo {
  version: string;
  /** Which build this is ("Build 1a2b3c4, made 9 November 2026 at 21:05", or "Build 1a2b3c4 with changes, made ..."), for a packaged app. */
  build: string | null;
  licence: string;
  notices: string;
  packageCount: number;
  hasChromiumNotices: boolean;
  pandoc: PandocInfo | null;
}

const hidden = process.env.CORILLO_HIDDEN === "1";
let aboutWin: BrowserWindow | null = null;
let creditsWin: BrowserWindow | null = null;

function readOr(file: string, fallback: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

/** Where bundled extras live: inside the app once packaged, in the project folder while developing. */
function resourceDir(packagedName: string, devPath: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, packagedName) : path.join(app.getAppPath(), devPath);
}

function chromiumNotices(): string {
  return resourceDir("LICENSES.chromium.html", "node_modules/electron/dist/LICENSES.chromium.html");
}

function pandocDir(): string {
  return process.env.CORILLO_PANDOC_DIR || resourceDir("pandoc", "vendor/pandoc");
}

/** Pandoc's version and licence, if Pandoc is bundled. */
export function pandocInfo(): PandocInfo | null {
  const dir = pandocDir();
  const version = readOr(path.join(dir, "VERSION"), "").trim();
  const licence = readOr(path.join(dir, "COPYING"), "");
  if (!version || !licence) return null;
  return { version, licence, sourceUrl: `https://github.com/jgm/pandoc/releases/tag/${encodeURIComponent(version)}` };
}

/** One value from an Info.plist, as plutil writes it. */
export function plistString(plist: string, key: string): string | null {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist);
  return m ? m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : null;
}

/** The stamp packaging puts in the app's Info.plist (scripts/package-mac.mjs), in words. */
export function buildLine(plist: string): string | null {
  const commit = plistString(plist, "CorilloBuildCommit");
  const date = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})$/.exec(plistString(plist, "CorilloBuildDate") ?? "");
  if (!commit || !date) return null;
  const day = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
  const words = day.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  // Built with changes not yet committed: the code isn't that commit's.
  const changed = commit.endsWith("+changes");
  return `Build ${changed ? `${commit.slice(0, -"+changes".length)} with changes` : commit}, made ${words} at ${date[4]}`;
}

function aboutInfo(): AboutInfo {
  const notices = readOr(path.join(__dirname, "third-party-notices.txt"), "");
  const count = /^(\d+) packages:/m.exec(notices);
  return {
    version: app.getVersion(),
    build: app.isPackaged ? buildLine(readOr(path.join(process.resourcesPath, "..", "Info.plist"), "")) : null,
    licence: readOr(path.join(app.getAppPath(), "LICENSE"), "MIT License"),
    notices,
    packageCount: count ? Number(count[1]) : 0,
    hasChromiumNotices: fs.existsSync(chromiumNotices()),
    pandoc: pandocInfo(),
  };
}

/** Cmd-W and Cmd-Shift-W close this window, not a document tab behind it. */
function closeWithCommandW(w: BrowserWindow): void {
  w.webContents.on("before-input-event", (e, input) => {
    const closeKey = input.type === "keyDown" && input.meta && input.key.toLowerCase() === "w";
    if (closeKey || (input.type === "keyDown" && input.key === "Escape")) {
      e.preventDefault();
      w.close();
    }
  });
}

function guard(w: BrowserWindow): void {
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  closeWithCommandW(w);
}

export function showAbout(): void {
  if (aboutWin && !aboutWin.isDestroyed()) {
    if (!hidden) {
      aboutWin.show();
      aboutWin.focus();
    }
    return;
  }
  const w = new BrowserWindow({
    width: 480,
    height: 620,
    minWidth: 400,
    minHeight: 420,
    title: "About Corillo",
    show: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "about-preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  aboutWin = w;
  windowIs(w.webContents, "about");
  guard(w);
  w.once("ready-to-show", () => {
    if (!hidden) w.show();
  });
  w.on("closed", () => {
    if (aboutWin === w) aboutWin = null;
  });
  w.loadFile(path.join(__dirname, "about.html"));
}

/** Chromium's own notices: a long page, shown in a window of its own. */
function showChromiumNotices(): void {
  if (creditsWin && !creditsWin.isDestroyed()) {
    if (!hidden) {
      creditsWin.show();
      creditsWin.focus();
    }
    return;
  }
  const w = new BrowserWindow({
    width: 760,
    height: 720,
    title: "Chromium and Electron notices",
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, javascript: false },
  });
  creditsWin = w;
  guard(w);
  w.once("ready-to-show", () => {
    if (!hidden) w.show();
  });
  w.on("page-title-updated", (e) => e.preventDefault());
  w.on("closed", () => {
    if (creditsWin === w) creditsWin = null;
  });
  w.loadFile(chromiumNotices());
}

ipcMain.handle("about:info", () => aboutInfo());
ipcMain.handle("about:open-chromium-notices", () => showChromiumNotices());
ipcMain.handle("about:open-pandoc-source", () => {
  const info = pandocInfo();
  if (info) return shell.openExternal(info.sourceUrl);
});

/** The Corillo menu, with About opening Corillo's own window. */
export function appMenu(): MenuItemConstructorOptions {
  return {
    id: "app-menu",
    label: app.name,
    submenu: [
      { id: "about", label: `About ${app.name}`, click: () => showAbout() },
      { type: "separator" },
      soundMenuItem(), // the coquí call when a document is back with you (your-turn.ts)
      { type: "separator" },
      { id: "services", role: "services" },
      { type: "separator" },
      { id: "hide", role: "hide" },
      { id: "hide-others", role: "hideOthers" },
      { id: "show-all", role: "unhide" },
      { type: "separator" },
      { id: "quit", role: "quit" },
    ],
  };
}
