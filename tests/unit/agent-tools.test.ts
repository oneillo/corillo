// Connecting each agent tool: Corillo adds itself to the tool's settings file,
// leaves everything else in it alone, and can take itself out again. Every
// test works in a throwaway home folder, never the real one.
import { describe, expect, it, beforeEach } from "vitest";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  TOOLS,
  backupOf,
  connect,
  disconnect,
  isInstalled,
  manualEntries,
  repairMoved,
  snippetFor,
  statusOf,
  temporaryPlace,
  firstRunOffer,
  toolById,
  type AgentTool,
  type McpLaunch,
  type Places,
} from "../../src/main/agent-tools";
import { countFlushes } from "./flushes";

const launch: McpLaunch = {
  command: "/Applications/Corillo.app/Contents/MacOS/Corillo",
  args: ["/Applications/Corillo.app/Contents/Resources/app.asar/dist/mcp.cjs"],
  env: { ELECTRON_RUN_AS_NODE: "1" },
};

let places: Places;
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "corillo-home-"));
  places = { home, applications: [join(home, "Applications")] };
});

const fileOf = (tool: AgentTool) => tool.file(places.home);
const read = (tool: AgentTool) => readFileSync(fileOf(tool), "utf8");
function write(tool: AgentTool, text: string): void {
  mkdirSync(dirname(fileOf(tool)), { recursive: true });
  writeFileSync(fileOf(tool), text);
}

/** A settings file that already has another server and other settings in it. */
function existingSettings(tool: AgentTool): string {
  if (tool.format === "toml") {
    return [
      'model = "gpt-5"',
      "",
      "# My notes server",
      "[mcp_servers.notes]",
      'command = "/usr/local/bin/notes-server"',
      'args = ["--quiet"]',
      "",
      "[mcp_servers.notes.env]",
      'NOTES_DIR = "/tmp/notes"',
      "",
    ].join("\n");
  }
  // "args" on one line: rewriting the file with standard formatting would spread it out.
  return [
    "{",
    '  "theme": "dark",',
    `  "${tool.group}": {`,
    '    "notes": {',
    '      "command": "/usr/local/bin/notes-server",',
    '      "args": ["--quiet"]',
    "    }",
    "  },",
    '  "numStartups": 12',
    "}",
    "",
  ].join("\n");
}

const brokenSettings = (tool: AgentTool) =>
  tool.format === "toml" ? '[mcp_servers.notes\ncommand = "x"\n' : `{ "${tool.group}": { "notes": `;

describe.each(TOOLS.map((t) => [t.name, t] as const))("%s", (_name, tool) => {
  it("adds Corillo to a settings file that doesn't exist yet", () => {
    expect(statusOf(tool, places, launch).state).toBe("not-connected");
    expect(connect(tool, places, launch)).toEqual({ ok: true });
    expect(existsSync(fileOf(tool))).toBe(true);
    expect(statusOf(tool, places, launch).state).toBe("connected");
  });

  it("adds Corillo to an empty settings file", () => {
    write(tool, "");
    expect(connect(tool, places, launch)).toEqual({ ok: true });
    expect(statusOf(tool, places, launch).state).toBe("connected");
  });

  it("writes the server the way the tool's documentation describes", () => {
    connect(tool, places, launch);
    const text = read(tool);
    if (tool.format === "toml") {
      expect(text).toBe(
        "[mcp_servers.corillo]\n" +
          `command = "${launch.command}"\n` +
          `args = ["${launch.args[0]}"]\n` +
          'env = { ELECTRON_RUN_AS_NODE = "1" }\n',
      );
    } else {
      expect(JSON.parse(text)).toEqual({ [tool.group]: { corillo: tool.entry(launch) } });
    }
  });

  it("adds Corillo beside other servers, leaving them and everything else exactly as they were", () => {
    const original = existingSettings(tool);
    write(tool, original);
    expect(connect(tool, places, launch)).toEqual({ ok: true });
    const after = read(tool);
    if (tool.format === "toml") {
      expect(after.startsWith(original)).toBe(true);
    } else {
      expect(after).toContain('    "notes": {\n      "command": "/usr/local/bin/notes-server",\n      "args": ["--quiet"]\n    }');
      expect(after.startsWith('{\n  "theme": "dark",\n')).toBe(true);
      expect(after.endsWith('  "numStartups": 12\n}\n')).toBe(true);
      const parsed = JSON.parse(after);
      expect(Object.keys(parsed[tool.group])).toEqual(["notes", "corillo"]);
    }
    expect(statusOf(tool, places, launch).state).toBe("connected");
  });

  it("disconnecting takes out only Corillo and puts the file back the way it was", () => {
    const original = existingSettings(tool);
    write(tool, original);
    connect(tool, places, launch);
    expect(disconnect(tool, places)).toEqual({ ok: true });
    expect(read(tool)).toBe(original);
    expect(statusOf(tool, places, launch).state).toBe("not-connected");
  });

  it("disconnecting from a file that had no servers before puts it back exactly", () => {
    const original = tool.format === "toml" ? 'model = "gpt-5"\n' : '{\n  "theme": "dark"\n}\n';
    write(tool, original);
    connect(tool, places, launch);
    disconnect(tool, places);
    expect(read(tool)).toBe(original);
  });

  it.skipIf(tool.format === "toml")("disconnecting leaves an empty servers section that was there before Corillo came", () => {
    const original = `{"a": 1, "${tool.group}": {}}`;
    write(tool, original);
    connect(tool, places, launch);
    disconnect(tool, places);
    expect(JSON.parse(read(tool))).toEqual({ a: 1, [tool.group]: {} });
  });

  it("shows when Corillo has moved since it was connected, and updating fixes it", () => {
    write(tool, existingSettings(tool));
    connect(tool, places, launch);
    const moved = { ...launch, command: "/Users/me/Downloads/Corillo.app/Contents/MacOS/Corillo" };
    expect(statusOf(tool, places, moved).state).toBe("outdated");
    connect(tool, places, moved);
    expect(statusOf(tool, places, moved).state).toBe("connected");
    expect(read(tool).match(/corillo/g)?.length).toBe(1); // replaced, not added twice
  });

  it("refuses a settings file it can't read, with a plain message, and leaves it untouched", () => {
    const broken = brokenSettings(tool);
    write(tool, broken);
    expect(statusOf(tool, places, launch).state).toBe("unreadable");
    const result = connect(tool, places, launch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(`Corillo couldn't read ${tool.name}'s settings`);
    expect(read(tool)).toBe(broken);
    expect(existsSync(backupOf(fileOf(tool)))).toBe(false);
  });

  it("keeps a copy of the original file, made the first time Corillo changes it", () => {
    const original = existingSettings(tool);
    write(tool, original);
    connect(tool, places, launch);
    expect(readFileSync(backupOf(fileOf(tool)), "utf8")).toBe(original);
    disconnect(tool, places);
    connect(tool, places, launch);
    expect(readFileSync(backupOf(fileOf(tool)), "utf8")).toBe(original); // still the first original
  });

  it("counts as on this Mac when its app or its settings folder is there", () => {
    expect(isInstalled(tool, places)).toBe(false);
    const sign = tool.signs(places)[0];
    mkdirSync(sign, { recursive: true });
    expect(isInstalled(tool, places)).toBe(true);
  });

  it("gives a snippet to paste by hand, with Corillo's real locations in it", () => {
    const snippet = snippetFor(tool, launch);
    expect(snippet).toContain(launch.command);
    expect(snippet).toContain(launch.args[0]);
    expect(snippet).toContain("ELECTRON_RUN_AS_NODE");
    // Pasting the snippet into an empty file is the same as connecting.
    write(tool, snippet);
    expect(statusOf(tool, places, launch).state).toBe("connected");
  });
});

describe("safety when changing another app's settings", () => {
  const claudeCode = toolById("claude-code")!;

  it("a change the other app saves at the same moment is kept, not overwritten", () => {
    write(claudeCode, '{\n  "numStartups": 1\n}\n');
    connect(claudeCode, places, launch); // makes the backup, so the next change goes straight through
    disconnect(claudeCode, places);
    let saved = false;
    const result = connect(claudeCode, places, launch, {
      afterRead: () => {
        if (saved) return;
        saved = true; // Claude Code saves its own change just after Corillo read the file
        writeFileSync(fileOf(claudeCode), '{\n  "numStartups": 2,\n  "tipsShown": true\n}\n');
      },
    });
    expect(result).toEqual({ ok: true });
    const after = JSON.parse(read(claudeCode));
    expect(after.numStartups).toBe(2);
    expect(after.tipsShown).toBe(true);
    expect(after.mcpServers.corillo.command).toBe(launch.command);
  });

  it("changes a linked settings file where it really lives, keeping the link", () => {
    const real = join(places.home, "dotfiles", "claude.json");
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, "{}\n");
    symlinkSync(real, fileOf(claudeCode));
    connect(claudeCode, places, launch);
    expect(JSON.parse(readFileSync(real, "utf8")).mcpServers.corillo).toBeTruthy();
    expect(statSync(fileOf(claudeCode), { throwIfNoEntry: false })).toBeTruthy();
    expect(readFileSync(fileOf(claudeCode), "utf8")).toBe(readFileSync(real, "utf8"));
  });

  it("keeps the file's permissions", () => {
    write(claudeCode, "{}\n");
    chmodSync(fileOf(claudeCode), 0o600);
    connect(claudeCode, places, launch);
    expect(statSync(fileOf(claudeCode)).mode & 0o777).toBe(0o600);
  });

  it("a settings file Corillo creates can be read only by the person (it may later hold sign-in tokens)", () => {
    expect(existsSync(fileOf(claudeCode))).toBe(false);
    connect(claudeCode, places, launch);
    expect(statSync(fileOf(claudeCode)).mode & 0o777).toBe(0o600);
  });

  it("the new settings are on the disk before they take the old file's place", () => {
    write(claudeCode, "{}\n");
    connect(claudeCode, places, launch); // makes the backup first
    disconnect(claudeCode, places);
    const file = fileOf(claudeCode);
    const flushes = countFlushes(join(realpathSync(dirname(file)), `.${basename(file)}.corillo-`));
    try {
      connect(claudeCode, places, launch);
    } finally {
      flushes.stop();
    }
    expect(flushes.count).toBe(1);
  });

  it("leaves no hidden copy of the settings behind when the last step fails", () => {
    write(claudeCode, '{\n  "numStartups": 1\n}\n');
    connect(claudeCode, places, launch);
    disconnect(claudeCode, places);
    const fsModule = fs as unknown as { renameSync: typeof fs.renameSync };
    const realRename = fsModule.renameSync;
    fsModule.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from).endsWith(".tmp")) throw Object.assign(new Error("not allowed"), { code: "EPERM" });
      realRename(from, to);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    let result;
    try {
      result = connect(claudeCode, places, launch);
    } finally {
      fsModule.renameSync = realRename;
      syncBuiltinESMExports();
    }
    expect(result.ok).toBe(false);
    expect(readdirSync(places.home).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(JSON.parse(read(claudeCode))).toEqual({ numStartups: 1 });
  });

  it("adds Corillo for all of Claude Code, not inside one project's settings", () => {
    const original = JSON.stringify(
      { projects: { "/Users/me/work": { mcpServers: { local: { command: "x" } } } }, userID: "abc" },
      null,
      2,
    );
    write(claudeCode, original);
    connect(claudeCode, places, launch);
    const after = JSON.parse(read(claudeCode));
    expect(after.mcpServers.corillo.type).toBe("stdio");
    expect(after.projects["/Users/me/work"].mcpServers).toEqual({ local: { command: "x" } });
  });

  it("the by-hand list covers every tool, with its settings file written from the home folder", () => {
    const entries = manualEntries(places, launch);
    expect(entries.map((e) => e.name)).toEqual(TOOLS.map((t) => t.name));
    expect(entries.find((e) => e.id === "claude-desktop")?.where).toBe(
      "~/Library/Application Support/Claude/claude_desktop_config.json",
    );
    expect(entries.find((e) => e.id === "codex")?.where).toBe("~/.codex/config.toml");
  });
});

describe("after Corillo has moved (MP-2)", () => {
  /** A copy of Corillo on disk, inside the throwaway home: its program and its connector. */
  function corilloAt(folder: string, make = true): McpLaunch {
    const app = join(places.home, folder, "Corillo.app", "Contents");
    const copy: McpLaunch = {
      command: join(app, "MacOS", "Corillo"),
      args: [join(app, "Resources", "app.asar.unpacked", "dist", "mcp.cjs")],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
    if (make) {
      for (const file of [copy.command, copy.args[0]]) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "");
      }
    }
    return copy;
  }

  it("at launch, a tool still pointing at a copy of Corillo that's gone (run from the disk image) is pointed at this one, keeping the original", () => {
    const here = corilloAt("Applications");
    const gone = corilloAt("Volumes/Corillo", false);
    const claudeCode = toolById("claude-code")!;
    const codex = toolById("codex")!;
    write(claudeCode, '{\n  "numStartups": 3\n}\n');
    write(codex, 'model = "gpt-5"\n');
    connect(claudeCode, places, gone);
    connect(codex, places, gone);
    expect(statusOf(claudeCode, places, here).state).toBe("outdated");
    expect(repairMoved(places, here)).toEqual(["Claude Code", "Codex"]);
    expect(statusOf(claudeCode, places, here).state).toBe("connected");
    expect(statusOf(codex, places, here).state).toBe("connected");
    expect(JSON.parse(read(claudeCode)).numStartups).toBe(3);
    expect(readFileSync(backupOf(fileOf(claudeCode)), "utf8")).toBe('{\n  "numStartups": 3\n}\n');
    expect(read(codex).startsWith('model = "gpt-5"\n')).toBe(true);
    // Nothing more to put right the next time.
    expect(repairMoved(places, here)).toEqual([]);
  });

  it("leaves a tool pointing at another copy of Corillo that's still there (it shows Needs updating)", () => {
    const here = corilloAt("Applications");
    const other = corilloAt("Other");
    const cursor = toolById("cursor")!;
    connect(cursor, places, other);
    const before = read(cursor);
    expect(repairMoved(places, here)).toEqual([]);
    expect(read(cursor)).toBe(before);
    expect(statusOf(cursor, places, here).state).toBe("outdated");
  });

  it("leaves an entry called corillo that Corillo didn't write, even if its program isn't there", () => {
    const here = corilloAt("Applications");
    const gemini = toolById("gemini")!;
    const theirs = '{\n  "mcpServers": {\n    "corillo": { "command": "/opt/missing/corillo-server", "args": [] }\n  }\n}\n';
    write(gemini, theirs);
    expect(repairMoved(places, here)).toEqual([]);
    expect(read(gemini)).toBe(theirs);
  });

  it("knows when Corillo is running from the disk image or another place it's only passing through", () => {
    const home = "/Users/me";
    expect(temporaryPlace("/Volumes/Corillo/Corillo.app/Contents/MacOS/Corillo", home)).toBe(true);
    expect(temporaryPlace("/private/var/folders/x7/abc/T/AppTranslocation/1234-5678/d/Corillo.app/Contents/MacOS/Corillo", home)).toBe(true);
    expect(temporaryPlace("/Users/me/Downloads/Corillo.app/Contents/MacOS/Corillo", home)).toBe(true);
    expect(temporaryPlace("/private/tmp/Corillo.app/Contents/MacOS/Corillo", home)).toBe(true);
    expect(temporaryPlace("/Applications/Corillo.app/Contents/MacOS/Corillo", home)).toBe(false);
    expect(temporaryPlace("/Users/me/Applications/Corillo.app/Contents/MacOS/Corillo", home)).toBe(false);
  });

  it("opened from the disk image, the first-run Connect screen still comes by itself once Corillo is opened from Applications (R-MAIN-2)", () => {
    const home = "/Users/me";
    const setup = join(mkdtempSync(join(tmpdir(), "corillo-data-")), "setup.json");
    // From the disk image: shown (it says to move Corillo first), but not counted as offered.
    expect(firstRunOffer(setup, "/Volumes/Corillo/Corillo.app/Contents/MacOS/Corillo", home)).toBe(true);
    expect(existsSync(setup)).toBe(false);
    expect(firstRunOffer(setup, "/Volumes/Corillo/Corillo.app/Contents/MacOS/Corillo", home)).toBe(true);
    // Moved, and opened from Applications with the same data folder: offered, once.
    expect(firstRunOffer(setup, "/Applications/Corillo.app/Contents/MacOS/Corillo", home)).toBe(true);
    expect(existsSync(setup)).toBe(true);
    expect(firstRunOffer(setup, "/Applications/Corillo.app/Contents/MacOS/Corillo", home)).toBe(false);
  });
});
