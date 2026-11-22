// Connecting agent tools to Corillo from inside the app: the "Connect your
// agents" screen (offered the first time Corillo opens), the Help window
// (src/renderer/help.html), and the Help menu items for both.
import { app, BrowserWindow, clipboard, ipcMain, nativeTheme, shell, type MenuItemConstructorOptions } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { isWindow, windowIs } from "./window-boundary";
import { toolForClient } from "../core/agents";
import {
  TOOLS,
  connect,
  defaultPlaces,
  disconnect,
  genericSnippet,
  manualEntries,
  repairMoved,
  statusOf,
  temporaryPlace,
  firstRunOffer,
  toolById,
  type ChangeResult,
  type McpLaunch,
  type ToolStatus,
} from "./agent-tools";

const hidden = process.env.CORILLO_HIDDEN === "1";

/**
 * How an agent tool starts Corillo's MCP server: Corillo's own program acting
 * as Node, so nobody needs Node installed. In development that's the Electron
 * in node_modules; in the finished app, Corillo.app/Contents/MacOS/Corillo.
 */
export function mcpLaunch(): McpLaunch {
  let script = path.join(app.getAppPath(), "dist", "mcp.cjs");
  // Files unpacked beside the app's archive are where a plain Node process can read them.
  const unpacked = script.replace(/\.asar([\\/])/, ".asar.unpacked$1");
  if (unpacked !== script && fs.existsSync(unpacked)) script = unpacked;
  return { command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

export interface ConnectScreenResult {
  result: ChangeResult;
  tools: ToolStatus[];
}

/** What the screen shows: the tools, and anything to sort out before connecting. */
export interface ConnectScreenState {
  tools: ToolStatus[];
  /** Corillo is running from its disk image or another place it's only passing through: connecting now would point the tools there. */
  moveFirst: boolean;
  /** Why agents can't reach Corillo right now, in words for the person, or null. */
  problem: string | null;
  /** The tools (by id) with a session connected to Corillo now: their rows say Connected. */
  live: string[];
  /** A first thing to ask an agent just connected, which the row offers to copy (P-5). */
  tryIt: string;
  /** How long a row waits for its tool's first session before saying what else to try. */
  stillMs: number;
}

/**
 * What a row offers to copy once its tool is connected (roadmap Batch 5,
 * item 2, P-5): the person's own first draft, made by their own agent, puts
 * the whole loop on screen within minutes, and it's this request that first
 * brings the agent to Corillo.
 */
export const TRY_IT = "Write a one-page plan for a team offsite, save it in my Documents folder and open it in Corillo.";

/** Two minutes, unless a test asks for less. */
const stillMs = () => {
  const asked = Number(process.env.CORILLO_CONNECT_STILL_MS);
  return Number.isFinite(asked) && asked > 0 ? asked : 2 * 60_000;
};

/** The tools with a session connected now, as last told to the window. */
let live: string[] = [];

/**
 * The agents' sessions connected now changed: `clients` is what each one's
 * tool calls itself. The window hears which tools have one, only when that
 * changes, so an open Connect screen turns a row to Connected the moment its
 * tool's first session reaches Corillo. Never a window made just for this.
 */
export function sessionsConnected(clients: string[]): void {
  const now = [...new Set(clients.map(toolForClient).filter((t): t is string => !!t))].sort();
  if (now.join("\n") === live.join("\n")) return;
  live = now;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && isWindow(w.webContents, "document")) w.webContents.send("agents:live", live);
  }
}

function statuses(): ToolStatus[] {
  const places = defaultPlaces();
  const launch = mcpLaunch();
  return TOOLS.map((t) => statusOf(t, places, launch));
}

const passingThrough = () => temporaryPlace(mcpLaunch().command);

function changeTool(id: unknown, action: "connect" | "disconnect"): ConnectScreenResult {
  const tool = typeof id === "string" ? toolById(id) : undefined;
  if (!tool) return { result: { ok: false, message: "Corillo doesn't know that tool." }, tools: statuses() };
  if (action === "connect" && passingThrough()) {
    return { result: { ok: false, message: "Move Corillo to your Applications folder first, and open it from there." }, tools: statuses() };
  }
  const result = action === "connect" ? connect(tool, defaultPlaces(), mcpLaunch()) : disconnect(tool, defaultPlaces());
  return { result, tools: statuses() };
}

/**
 * Tests and trial runs with a throwaway data folder but the real home folder
 * never change the real tools' settings by themselves.
 */
const mayChangeToolsUnasked = () => !(process.env.CORILLO_USER_DATA && !process.env.CORILLO_HOME);

/**
 * Once Corillo is up: tools still pointing at a copy of Corillo that's gone
 * (it was opened from the disk image, then moved) are pointed at this one,
 * and the corner says so, since a tool that's open needs a restart to see it.
 */
export function repairConnections(): void {
  if (!mayChangeToolsUnasked() || passingThrough()) return;
  let fixed: string[];
  try {
    fixed = repairMoved(defaultPlaces(), mcpLaunch());
  } catch (err) {
    console.error("Couldn't look at the agent tools' settings.", err);
    return;
  }
  if (!fixed.length) return;
  const names = fixed.length === 1 ? fixed[0] : `${fixed.slice(0, -1).join(", ")} and ${fixed[fixed.length - 1]}`;
  const restart = fixed.length === 1 ? TOOLS.find((t) => t.name === fixed[0])!.restart : "If they're open, quit and reopen them, or start a new session, to see Corillo.";
  noticeInMain(`Corillo has moved, so it updated its connection in ${names}.`, restart);
}

// The Help window --------------------------------------------------------------------

let helpWindow: BrowserWindow | null = null;

/**
 * Open Help at a page or a section of one ("agents", "agents-take-over"; the
 * Help window finds it, or shows the first page). With no place given, an open
 * Help window just comes forward, where the person left it.
 */
function openHelp(place?: unknown): void {
  const name = typeof place === "string" && /^[a-z][a-z0-9-]{0,60}$/.test(place) ? place : null;
  if (helpWindow && !helpWindow.isDestroyed()) {
    if (name) helpWindow.webContents.send("help:page", name);
    if (!hidden) {
      helpWindow.show();
      helpWindow.focus();
    }
    return;
  }
  const w = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 560,
    minHeight: 420,
    title: "Corillo Help",
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1B2023" : "#EAEDEC",
    webPreferences: {
      preload: path.join(__dirname, "help-preload.cjs"), // only what Help needs
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  helpWindow = w;
  windowIs(w.webContents, "help");
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  // Command-W closes Help, not the document tab (or window) behind it.
  w.webContents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && input.meta && !input.alt && !input.control && input.key.toLowerCase() === "w") {
      e.preventDefault();
      w.close();
    }
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  w.once("ready-to-show", () => {
    if (!hidden) w.show();
  });
  w.on("closed", () => {
    if (helpWindow === w) helpWindow = null;
  });
  void w.loadFile(path.join(__dirname, "help.html"), { hash: name ?? "start" });
}

// Setting up ---------------------------------------------------------------------------

let sendToMain: (channel: string, ...args: unknown[]) => void = () => {};
/** A line in the window's corner, if there's a window: never one made just for it. */
let noticeInMain: (text: string, detail: string) => void = () => {};
let showMain: () => void = () => {};

function showConnectScreen(): void {
  sendToMain("agents:show-connect");
  showMain();
}

export function helpMenuItems(): MenuItemConstructorOptions[] {
  return [
    { id: "corillo-help", label: "Corillo Help", click: () => openHelp() },
    { id: "markdown-help", label: "Markdown Help", click: () => openHelp("markdown") },
    { id: "keyboard-shortcuts", label: "Keyboard Shortcuts", click: () => openHelp("shortcuts") },
    { type: "separator" },
    { id: "connect-agents", label: "Connect Agents…", click: () => showConnectScreen() },
  ];
}

const setupFile = () => path.join(app.getPath("userData"), "setup.json");

/** The first time Corillo opens, offer to connect the agent tools on this Mac. */
function offerOnFirstRun(): void {
  if (!mayChangeToolsUnasked()) return;
  if (firstRunOffer(setupFile(), mcpLaunch().command)) sendToMain("agents:show-connect");
}

/**
 * Wire up the screen and Help. `send` reaches the main window (holding messages
 * until it's ready); `bringForward` shows it.
 */
export function setUpAgentConnections(options: {
  send: (channel: string, ...args: unknown[]) => void;
  notice: (text: string, detail: string) => void;
  bringForward: () => void;
  /** Why agents can't reach Corillo, or null. */
  agentsProblem: () => string | null;
}): void {
  sendToMain = options.send;
  noticeInMain = options.notice;
  showMain = options.bringForward;
  ipcMain.handle(
    "agents:list",
    (): ConnectScreenState => ({ tools: statuses(), moveFirst: passingThrough(), problem: options.agentsProblem(), live, tryIt: TRY_IT, stillMs: stillMs() }),
  );
  ipcMain.handle("agents:copy-try", () => clipboard.writeText(TRY_IT));
  ipcMain.handle("agents:connect", (_e, id: unknown) => changeTool(id, "connect"));
  ipcMain.handle("agents:disconnect", (_e, id: unknown) => changeTool(id, "disconnect"));
  // Run from the disk image (or another place it's only passing through), the
  // settings would point at a copy that won't be there later: Help asks to
  // move Corillo first instead, and nothing that would break is copied.
  ipcMain.handle("agents:manual", () => ({
    tools: manualEntries(defaultPlaces(), mcpLaunch()),
    other: genericSnippet(mcpLaunch()),
    moveFirst: passingThrough(),
  }));
  ipcMain.handle("agents:copy", (_e, id: unknown, what: unknown) => {
    const launch = mcpLaunch();
    let text: string | undefined;
    if (what !== "where" && passingThrough()) return false;
    if (id === "other") text = genericSnippet(launch);
    else {
      const entry = manualEntries(defaultPlaces(), launch).find((m) => m.id === id);
      const tool = typeof id === "string" ? toolById(id) : undefined;
      text = what === "where" && tool ? tool.file(defaultPlaces().home) : entry?.snippet;
    }
    if (text !== undefined) clipboard.writeText(text);
    return text !== undefined;
  });
  ipcMain.handle("agents:show-connect", () => showConnectScreen());
  ipcMain.handle("help:open", (_e, page: unknown) => openHelp(page));
  offerOnFirstRun();
}
