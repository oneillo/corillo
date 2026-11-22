// The agent tools Corillo knows how to connect, where each keeps its list of
// MCP servers, and connecting or disconnecting one by changing that file.
// Nothing here uses Electron, so the tests run it against throwaway folders.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ConfigError,
  readJsonEntry,
  readTomlEntry,
  removeJsonEntry,
  removeTomlEntry,
  renderTomlTable,
  setJsonEntry,
  setTomlEntry,
  type ConfigProblem,
} from "./agent-config";

/** How an agent tool starts Corillo's MCP server. */
export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The server's name in every tool's settings. */
export const SERVER_NAME = "corillo";

/** Where Corillo looks for other apps' files. */
export interface Places {
  home: string;
  /** Folders apps are installed in. */
  applications: string[];
}

/**
 * The home folder every other tool's settings are found from. Tests and trial
 * runs set CORILLO_HOME to a throwaway folder, so they never touch real settings.
 */
export function homeDir(): string {
  return process.env.CORILLO_HOME || os.homedir();
}

export function defaultPlaces(): Places {
  const home = homeDir();
  const own = path.join(home, "Applications");
  // With a stand-in home, look for apps only inside it.
  return { home, applications: process.env.CORILLO_HOME ? [own] : ["/Applications", own] };
}

export interface AgentTool {
  id: string;
  name: string;
  /** A short line under the name, when the name alone could confuse. */
  detail?: string;
  format: "json" | "toml";
  /** JSON: the key that holds the servers. */
  group: string;
  file: (home: string) => string;
  entry: (launch: McpLaunch) => Record<string, unknown>;
  /** Any of these existing means the tool is on this Mac. */
  signs: (places: Places) => string[];
  /** What to do so the tool sees Corillo, once it's connected. */
  restart: string;
  /** Extra advice for adding Corillo by hand. */
  byHand?: string;
}

const stdio = (l: McpLaunch) => ({ type: "stdio", command: l.command, args: l.args, env: l.env });
const plain = (l: McpLaunch) => ({ command: l.command, args: l.args, env: l.env });
const appsNamed = (p: Places, ...names: string[]) => p.applications.flatMap((dir) => names.map((n) => path.join(dir, n)));
const support = (home: string, ...parts: string[]) => path.join(home, "Library", "Application Support", ...parts);

export const TOOLS: AgentTool[] = [
  {
    // User-scope servers sit at the top level of ~/.claude.json under "mcpServers",
    // as { "type": "stdio", "command", "args", "env" }. https://code.claude.com/docs/en/mcp
    id: "claude-code",
    name: "Claude Code",
    format: "json",
    group: "mcpServers",
    file: (home) => path.join(home, ".claude.json"),
    entry: stdio,
    signs: (p) => [path.join(p.home, ".claude"), path.join(p.home, ".claude.json")],
    restart: "Start a new Claude Code session to see Corillo.",
    byHand: "Quit Claude Code first: it rewrites this file while it runs.",
  },
  {
    // ~/Library/Application Support/Claude/claude_desktop_config.json, "mcpServers",
    // { "command", "args", "env" }; Claude Desktop must be fully quit and reopened.
    // https://modelcontextprotocol.io/docs/develop/connect-local-servers
    id: "claude-desktop",
    name: "Claude Desktop",
    format: "json",
    group: "mcpServers",
    file: (home) => support(home, "Claude", "claude_desktop_config.json"),
    entry: plain,
    signs: (p) => [...appsNamed(p, "Claude.app"), support(p.home, "Claude")],
    restart: "Quit and reopen Claude Desktop to see Corillo.",
  },
  {
    // ~/.codex/config.toml, a [mcp_servers.<name>] table with command, args and env.
    // The ChatGPT desktop app, the Codex CLI and the IDE extension share this file.
    // https://developers.openai.com/codex/mcp (now https://learn.chatgpt.com/docs/extend/mcp)
    id: "codex",
    name: "Codex",
    detail: "Also Codex in the ChatGPT app",
    format: "toml",
    group: "mcp_servers",
    file: (home) => path.join(home, ".codex", "config.toml"),
    entry: plain,
    signs: (p) => [...appsNamed(p, "Codex.app", "ChatGPT.app"), path.join(p.home, ".codex")],
    restart: "Quit and reopen Codex or the ChatGPT app, or start a new Codex session, to see Corillo.",
  },
  {
    // Global servers for every project: ~/.cursor/mcp.json, "mcpServers",
    // { "type": "stdio", "command", "args", "env" }. https://cursor.com/docs/context/mcp
    id: "cursor",
    name: "Cursor",
    format: "json",
    group: "mcpServers",
    file: (home) => path.join(home, ".cursor", "mcp.json"),
    entry: stdio,
    signs: (p) => [...appsNamed(p, "Cursor.app"), path.join(p.home, ".cursor")],
    restart: "Quit and reopen Cursor to see Corillo.",
  },
  {
    // The mcp.json in VS Code's user profile folder, "servers",
    // { "type": "stdio", "command", "args", "env" }.
    // https://code.visualstudio.com/docs/agents/reference/mcp-configuration
    // The profile folder on a Mac is ~/Library/Application Support/Code/User:
    // https://code.visualstudio.com/docs/configure/settings
    id: "vscode",
    name: "VS Code",
    detail: "For GitHub Copilot in VS Code",
    format: "json",
    group: "servers",
    file: (home) => support(home, "Code", "User", "mcp.json"),
    entry: stdio,
    signs: (p) => [...appsNamed(p, "Visual Studio Code.app"), support(p.home, "Code", "User")],
    restart: "Quit and reopen VS Code to see Corillo.",
  },
  {
    // ~/.gemini/settings.json, "mcpServers", { "command", "args", "env" }.
    // https://geminicli.com/docs/tools/mcp-server/
    id: "gemini",
    name: "Gemini CLI",
    format: "json",
    group: "mcpServers",
    file: (home) => path.join(home, ".gemini", "settings.json"),
    entry: plain,
    signs: (p) => [path.join(p.home, ".gemini")],
    restart: "Start a new Gemini CLI session to see Corillo.",
  },
  {
    // ~/.copilot/mcp-config.json, "mcpServers",
    // { "type": "local", "command", "args", "env", "tools": ["*"] }.
    // https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
    id: "copilot-cli",
    name: "GitHub Copilot CLI",
    format: "json",
    group: "mcpServers",
    file: (home) => path.join(home, ".copilot", "mcp-config.json"),
    entry: (l) => ({ type: "local", command: l.command, args: l.args, env: l.env, tools: ["*"] }),
    signs: (p) => [path.join(p.home, ".copilot")],
    restart: "Start a new Copilot session to see Corillo.",
  },
];

export function toolById(id: string): AgentTool | undefined {
  return TOOLS.find((t) => t.id === id);
}

// Reading a tool's state -----------------------------------------------------------

export type ConnectionState = "connected" | "outdated" | "not-connected" | "unreadable";

export interface ToolStatus {
  id: string;
  name: string;
  detail?: string;
  installed: boolean;
  state: ConnectionState;
  restart: string;
}

function readIfThere(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError("unreadable");
  }
}

function readEntry(tool: AgentTool, text: string | null): unknown {
  return tool.format === "toml" ? readTomlEntry(text, SERVER_NAME) : readJsonEntry(text, tool.group, SERVER_NAME);
}

/** Whether a saved entry starts this copy of Corillo (it won't if Corillo has moved). */
function startsThisCorillo(entry: unknown, launch: McpLaunch): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  const env = (e.env ?? {}) as Record<string, unknown>;
  return (
    e.command === launch.command &&
    isDeepStrictEqual(e.args, launch.args) &&
    Object.entries(launch.env).every(([k, v]) => env[k] === v)
  );
}

export function isInstalled(tool: AgentTool, places: Places): boolean {
  return tool.signs(places).some((p) => fs.existsSync(p));
}

export function statusOf(tool: AgentTool, places: Places, launch: McpLaunch): ToolStatus {
  let state: ConnectionState;
  try {
    const entry = readEntry(tool, readIfThere(tool.file(places.home)));
    state = entry === undefined ? "not-connected" : startsThisCorillo(entry, launch) ? "connected" : "outdated";
  } catch {
    state = "unreadable";
  }
  return {
    id: tool.id,
    name: tool.name,
    detail: tool.detail,
    installed: isInstalled(tool, places),
    state,
    restart: tool.restart,
  };
}

// Changing a tool's settings ---------------------------------------------------------

export interface EditHooks {
  /** Tests use this to play another app saving the file at the same moment. */
  afterRead?: () => void;
}

interface FileStamp {
  mtimeMs: number;
  size: number;
  ino: number;
  mode: number;
}

function stampOf(file: string): FileStamp | null {
  try {
    const s = fs.statSync(file);
    return { mtimeMs: s.mtimeMs, size: s.size, ino: s.ino, mode: s.mode };
  } catch {
    return null;
  }
}

const sameStamp = (a: FileStamp | null, b: FileStamp | null) =>
  a === b || (!!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino);

/** Where the original is kept, the first time Corillo changes a file. */
export const backupOf = (file: string) => `${file}.before-corillo`;

/**
 * Change a settings file. The file is read again just before writing, and the
 * new version goes in with a rename, so the file is never half-written. If the
 * other app saved it in between, Corillo starts over with what it saved.
 */
export function editSettingsFile(file: string, edit: (text: string | null) => string | null, hooks: EditHooks = {}): void {
  let target = file;
  try {
    target = fs.realpathSync(file); // a linked file is changed where it really lives
  } catch {
    // not there yet
  }
  const backup = backupOf(target);
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = stampOf(target);
    const text = before ? readIfThere(target) : null;
    hooks.afterRead?.();
    const next = edit(text);
    if (next === null || next === text) return;
    // A file Corillo creates is the person's alone: such files often hold sign-in tokens later.
    const mode = before ? before.mode & 0o777 : 0o600;
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.corillo-${process.pid}.tmp`);
    try {
      if (text !== null && !fs.existsSync(backup)) {
        fs.writeFileSync(backup, text, { flag: "wx", mode });
        continue; // read again, so the time between reading and writing stays tiny
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const fd = fs.openSync(tmp, "w", mode);
      try {
        fs.writeFileSync(fd, next);
        fs.fsyncSync(fd); // on the disk before it takes the old file's place
      } finally {
        fs.closeSync(fd);
      }
      if (!sameStamp(before, stampOf(target))) {
        fs.rmSync(tmp, { force: true });
        continue;
      }
      fs.renameSync(tmp, target);
      return;
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true }); // never leave a copy of the settings lying in the folder
      } catch {
        // nothing more to do
      }
      if (err instanceof ConfigError) throw err;
      throw new ConfigError("unsaved");
    }
  }
  throw new ConfigError("changing");
}

export type ChangeResult = { ok: true } | { ok: false; message: string };

function messageFor(tool: AgentTool, problem: ConfigProblem): string {
  switch (problem) {
    case "changing":
      return `${tool.name} was changing its settings at the same moment. Try again.`;
    case "unsaved":
      return `Corillo couldn't save ${tool.name}'s settings. You can connect it by hand instead: see Help > Corillo Help.`;
    default:
      return `Corillo couldn't read ${tool.name}'s settings, so it left them as they were. You can connect it by hand instead: see Help > Corillo Help.`;
  }
}

function change(tool: AgentTool, places: Places, edit: (text: string | null) => string | null, hooks?: EditHooks): ChangeResult {
  try {
    editSettingsFile(tool.file(places.home), edit, hooks);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: messageFor(tool, err instanceof ConfigError ? err.problem : "unsaved") };
  }
}

export function connect(tool: AgentTool, places: Places, launch: McpLaunch, hooks?: EditHooks): ChangeResult {
  return change(
    tool,
    places,
    (text) =>
      tool.format === "toml"
        ? setTomlEntry(text, SERVER_NAME, plain(launch))
        : setJsonEntry(text, tool.group, SERVER_NAME, tool.entry(launch)),
    hooks,
  );
}

export function disconnect(tool: AgentTool, places: Places, hooks?: EditHooks): ChangeResult {
  return change(
    tool,
    places,
    (text) =>
      tool.format === "toml"
        ? removeTomlEntry(text, SERVER_NAME)
        : removeJsonEntry(text, tool.group, SERVER_NAME, originalOf(tool.file(places.home))),
    hooks,
  );
}

/** The settings file as it was before Corillo first changed it, if that copy is there. */
function originalOf(file: string): string | null {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {
    // not there
  }
  try {
    return fs.readFileSync(backupOf(target), "utf8");
  } catch {
    return null;
  }
}

// After Corillo has moved -------------------------------------------------------------
// A person who opens Corillo from its disk image (or from Downloads, where
// macOS runs an app from a hidden temporary copy) and connects their agents
// there leaves the tools pointing at a place that later disappears.

/** Where Corillo is only passing through: its disk image, the Mac's hidden copy of an app not yet moved, Downloads, a temporary folder. */
export function temporaryPlace(program: string, home = os.homedir()): boolean {
  const inside = (folder: string) => program.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
  return (
    inside("/Volumes") ||
    program.includes("/AppTranslocation/") ||
    inside(path.join(home, "Downloads")) ||
    ["/private/var/folders", "/private/tmp", "/tmp", "/var/folders"].some(inside)
  );
}

/**
 * Whether to show the Connect screen by itself as Corillo opens: the first
 * time only, noted in `setupFile`. Opened from somewhere it's only passing
 * through, the screen shows (it asks to move Corillo first) but isn't noted,
 * so it comes again once Corillo is opened from where it'll stay.
 */
export function firstRunOffer(setupFile: string, program: string, home = os.homedir()): boolean {
  if (fs.existsSync(setupFile)) return false;
  if (temporaryPlace(program, home)) return true;
  try {
    fs.mkdirSync(path.dirname(setupFile), { recursive: true });
    fs.writeFileSync(setupFile, JSON.stringify({ connectAgentsOffered: true }, null, 2));
  } catch {
    // If the note can't be saved, the offer simply comes again next time.
  }
  return true;
}

/** An entry Corillo wrote (its own program run as Node) for a copy of Corillo that's no longer there. */
function leftByGoneCorillo(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  const env = e.env as Record<string, unknown> | undefined;
  const script = Array.isArray(e.args) ? e.args[0] : undefined;
  if (typeof e.command !== "string" || !path.isAbsolute(e.command) || env?.ELECTRON_RUN_AS_NODE !== "1") return false;
  return !fs.existsSync(e.command) || (typeof script === "string" && path.isAbsolute(script) && !fs.existsSync(script));
}

/**
 * At launch: every tool whose Corillo entry points at a copy of Corillo
 * that's gone is pointed at this one, with the same checked change and
 * backup as Connect. An entry for another copy that's still there is left
 * (the screen shows it as Needs updating). Returns the tools put right.
 */
export function repairMoved(places: Places, launch: McpLaunch): string[] {
  const fixed: string[] = [];
  for (const tool of TOOLS) {
    let entry: unknown;
    try {
      entry = readEntry(tool, readIfThere(tool.file(places.home)));
    } catch {
      continue; // a file Corillo can't read is left alone
    }
    if (entry === undefined || startsThisCorillo(entry, launch) || !leftByGoneCorillo(entry)) continue;
    if (connect(tool, places, launch).ok) fixed.push(tool.name);
  }
  return fixed;
}

// Connecting by hand -------------------------------------------------------------------

export interface ManualEntry {
  id: string;
  name: string;
  /** The settings file, written with ~ for the home folder. */
  where: string;
  /** What to add to it. */
  snippet: string;
  restart: string;
  byHand?: string;
}

/** The text to paste into a tool's settings file. */
export function snippetFor(tool: AgentTool, launch: McpLaunch): string {
  if (tool.format === "toml") return renderTomlTable(SERVER_NAME, plain(launch)).trimEnd();
  return JSON.stringify({ [tool.group]: { [SERVER_NAME]: tool.entry(launch) } }, null, 2);
}

/** For any other tool: the details its "add a server" form asks for. */
export function genericSnippet(launch: McpLaunch): string {
  return [
    `Name: ${SERVER_NAME}`,
    `Command: ${launch.command}`,
    `Arguments: ${launch.args.join(" ")}`,
    `Environment: ${Object.entries(launch.env)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`,
  ].join("\n");
}

export function tildePath(file: string, home: string): string {
  return file === home || file.startsWith(home + path.sep) ? "~" + file.slice(home.length) : file;
}

export function manualEntries(places: Places, launch: McpLaunch): ManualEntry[] {
  return TOOLS.map((tool) => ({
    id: tool.id,
    name: tool.name,
    where: tildePath(tool.file(places.home), places.home),
    snippet: snippetFor(tool, launch),
    restart: tool.restart,
    byHand: tool.byHand,
  }));
}
