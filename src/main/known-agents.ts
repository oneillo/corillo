// The agents Corillo knows, for the @ list in a comment: those connected to it
// right now, and those it has met on any document, remembered between
// launches in the data folder's agents.json (most recently seen first, for a
// while: see remember in core/mentions.ts). The list is sent to the windows
// whenever it changes, as an agent connects, leaves or is seen on a document,
// so nothing has to ask again and again.
import { app, BrowserWindow, ipcMain } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { knownAgents as listOf, remember, type KnownAgent, type Seen } from "../core/mentions";
import { writeAtomic } from "./store";

// Read lazily: the data folder is only known once main.ts has set it.
const file = () => path.join(app.getPath("userData"), "agents.json");
let seen: Seen[] | null = null;
/** The names of the agents connected now, newest connection first. */
let connected: string[] = [];
let told = "";

function remembered(): Seen[] {
  if (seen) return seen;
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file(), "utf8"));
    const list = data && typeof data === "object" ? (data as { seen?: unknown }).seen : null;
    seen = Array.isArray(list) ? remember(list as Seen[], [], Date.now()) : [];
  } catch {
    seen = [];
  }
  return seen;
}

export function knownAgents(): KnownAgent[] {
  return listOf(remembered(), connected);
}

/** Tell the windows, if the list they show has changed. */
function tell(): void {
  const list = knownAgents();
  const key = JSON.stringify(list);
  if (key === told) return;
  told = key;
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("agents:known", list);
}

/** These agents are on a document now, or have just left: remember them as seen now. */
export function rememberAgents(names: string[]): void {
  const before = remembered();
  const after = remember(before, names, Date.now());
  seen = after;
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      writeAtomic(file(), JSON.stringify({ seen: after }, null, 2));
    } catch {
      // Remembering them is a convenience; the list still has them until Corillo quits.
    }
  }
  tell();
}

/** The agents connected now changed; an agent that has just left is remembered as seen now. */
export function agentsConnected(names: string[], left?: string): void {
  connected = names;
  if (left) rememberAgents([left]);
  else tell();
}

ipcMain.handle("agents:known", () => knownAgents());
