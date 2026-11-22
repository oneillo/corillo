// Editing settings files in place: only Corillo's own entry changes, whatever
// the file's layout, and anything Corillo can't change safely is refused.
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  readJsonEntry,
  readTomlEntry,
  removeJsonEntry,
  removeTomlEntry,
  setJsonEntry,
  setTomlEntry,
} from "../../src/main/agent-config";

const entry = { command: "/Apps/Corillo", args: ["/Apps/mcp.cjs"], env: { ELECTRON_RUN_AS_NODE: "1" } };

describe("JSON settings files", () => {
  it("keeps comments and trailing commas in files that allow them", () => {
    const original = [
      "{",
      "  // Servers for Copilot",
      '  "servers": {',
      '    "notes": { "type": "stdio", "command": "notes" }, // mine',
      "  },",
      '  "inputs": [],',
      "}",
      "",
    ].join("\n");
    const added = setJsonEntry(original, "servers", "corillo", entry);
    expect(added).toContain("  // Servers for Copilot\n");
    expect(added).toContain('"notes": { "type": "stdio", "command": "notes" },');
    expect(readJsonEntry(added, "servers", "corillo")).toEqual(entry);
    expect(removeJsonEntry(added, "servers", "corillo")).toBe(original);
  });

  it("matches the file's indentation, tabs included", () => {
    const original = '{\n\t"mcpServers": {\n\t\t"notes": {\n\t\t\t"command": "notes"\n\t\t}\n\t}\n}\n';
    const added = setJsonEntry(original, "mcpServers", "corillo", entry);
    expect(added).toContain('\n\t\t"corillo": {\n\t\t\t"command": "/Apps/Corillo",\n');
    expect(removeJsonEntry(added, "mcpServers", "corillo")).toBe(original);
  });

  it("uses four spaces in a file indented with four spaces", () => {
    const original = '{\n    "theme": "dark"\n}\n';
    const added = setJsonEntry(original, "mcpServers", "corillo", entry);
    expect(added).toContain('\n    "mcpServers": {\n        "corillo": {\n            "command"');
  });

  it("a file written on one line stays on one line", () => {
    const original = '{"theme":"dark","mcpServers":{"notes":{"command":"notes"}}}';
    const added = setJsonEntry(original, "mcpServers", "corillo", entry);
    expect(added).not.toContain("\n");
    expect(added.startsWith('{"theme":"dark","mcpServers":{"notes":{"command":"notes"},"corillo":{')).toBe(true);
    expect(removeJsonEntry(added, "mcpServers", "corillo")).toBe(original);
  });

  it("a servers section Corillo added goes again when Corillo is removed", () => {
    const original = '{"theme":"dark"}';
    expect(removeJsonEntry(setJsonEntry(original, "mcpServers", "corillo", entry), "mcpServers", "corillo")).toBe(original);
    const withEmpty = '{\n  "mcpServers": {\n    "corillo": {}\n  },\n  "theme": "dark"\n}\n';
    expect(removeJsonEntry(withEmpty, "mcpServers", "corillo")).toBe('{\n  "theme": "dark"\n}\n');
  });

  it("a servers section that was there before Corillo, empty, stays when Corillo is removed", () => {
    const before = '{\n  "theme": "dark",\n  "mcpServers": {}\n}\n';
    const added = setJsonEntry(before, "mcpServers", "corillo", entry);
    expect(removeJsonEntry(added, "mcpServers", "corillo", before)).toBe(before);
    const without = '{"theme":"dark"}';
    expect(removeJsonEntry(setJsonEntry(without, "mcpServers", "corillo", entry), "mcpServers", "corillo", without)).toBe(without);
  });

  it("fills an empty servers section", () => {
    const added = setJsonEntry('{\n  "mcpServers": {}\n}\n', "mcpServers", "corillo", entry);
    expect(added.startsWith('{\n  "mcpServers": {\n    "corillo": {\n      "command": "/Apps/Corillo",')).toBe(true);
    expect(added.endsWith("    }\n  }\n}\n")).toBe(true);
  });

  it("keeps a comment inside an empty servers section, a server commented out say, and Disconnect puts the file back as it was", () => {
    const cases = [
      '{\n  "servers": {\n    // "notes": { "command": "notes" }\n  }\n}\n',
      '{\n  "servers": { // none yet\n  }\n}\n',
      '{\r\n  "servers": {\r\n    /* none yet */\r\n  }\r\n}\r\n',
      "{\n  // My settings\n}\n",
      '{"servers":{/* none yet */}}',
      '{"servers":{ /* none yet */ }}',
    ];
    for (const original of cases) {
      const comment = /\/\/[^\n\r]*|\/\*.*?\*\//.exec(original)![0];
      const added = setJsonEntry(original, "servers", "corillo", entry);
      expect(added, original).toContain(comment);
      expect(readJsonEntry(added, "servers", "corillo"), original).toEqual(entry);
      expect(removeJsonEntry(added, "servers", "corillo", original), original).toBe(original);
    }
    // A comment on the brace's line, with the closing brace on it too: kept, though the layout changes.
    const inline = '{\n  "servers": { /* none yet */ }\n}\n';
    const added = setJsonEntry(inline, "servers", "corillo", entry);
    expect(added).toContain("/* none yet */");
    expect(readJsonEntry(added, "servers", "corillo")).toEqual(entry);
    expect(removeJsonEntry(added, "servers", "corillo", inline)).toContain("/* none yet */");
  });

  it("replaces an old Corillo entry where it is", () => {
    const original = '{\n  "mcpServers": {\n    "corillo": { "command": "/old/Corillo" },\n    "notes": { "command": "notes" }\n  }\n}\n';
    const updated = setJsonEntry(original, "mcpServers", "corillo", entry);
    expect(Object.keys(JSON.parse(updated).mcpServers)).toEqual(["corillo", "notes"]);
    expect(updated).toContain('    "notes": { "command": "notes" }\n');
    expect(readJsonEntry(updated, "mcpServers", "corillo")).toEqual(entry);
  });

  it("removes Corillo from the middle of the list without disturbing its neighbours", () => {
    const original = '{\n  "mcpServers": {\n    "a": 1,\n    "corillo": {},\n    "b": 2\n  }\n}\n';
    expect(removeJsonEntry(original, "mcpServers", "corillo")).toBe('{\n  "mcpServers": {\n    "a": 1,\n    "b": 2\n  }\n}\n');
  });

  it("keeps Windows line endings", () => {
    const original = '{\r\n  "theme": "dark"\r\n}\r\n';
    const added = setJsonEntry(original, "mcpServers", "corillo", entry);
    expect(added.replace(/\r\n/g, "")).not.toContain("\n");
    expect(removeJsonEntry(added, "mcpServers", "corillo")).toContain('"theme": "dark"');
  });

  it("refuses a file that isn't valid, or whose servers section isn't a list of servers", () => {
    expect(() => setJsonEntry('{ "mcpServers": ', "mcpServers", "corillo", entry)).toThrow(ConfigError);
    expect(() => setJsonEntry('{ "mcpServers": [] }', "mcpServers", "corillo", entry)).toThrow(ConfigError);
    expect(() => setJsonEntry("[1, 2]", "mcpServers", "corillo", entry)).toThrow(ConfigError);
    expect(() => setJsonEntry('{ "a": 1 } extra', "mcpServers", "corillo", entry)).toThrow(ConfigError);
  });

  it("leaves a file without Corillo exactly as it is when disconnecting", () => {
    const original = '{ "mcpServers": { "notes": {} } }';
    expect(removeJsonEntry(original, "mcpServers", "corillo")).toBe(original);
    expect(removeJsonEntry(null, "mcpServers", "corillo")).toBe(null);
  });
});

describe("TOML settings files (Codex)", () => {
  it("replaces Corillo's table where it is, keeping the tables around it", () => {
    const original = [
      "[mcp_servers.first]",
      'command = "first"',
      "",
      "[mcp_servers.corillo]",
      'command = "/old/Corillo"',
      "startup_timeout_sec = 20",
      "",
      "# The last one",
      "[mcp_servers.last]",
      'command = "last"',
      "",
    ].join("\n");
    const updated = setTomlEntry(original, "corillo", entry);
    expect(updated.startsWith('[mcp_servers.first]\ncommand = "first"\n\n[mcp_servers.corillo]\ncommand = "/Apps/Corillo"\n')).toBe(true);
    expect(updated.endsWith('\n\n# The last one\n[mcp_servers.last]\ncommand = "last"\n')).toBe(true);
    expect(readTomlEntry(updated, "corillo")).toEqual(entry);
  });

  it("removes Corillo's sub-tables along with its table", () => {
    const original = '[mcp_servers.corillo]\ncommand = "x"\n\n[mcp_servers.corillo.env]\nA = "1"\n\n[other]\nb = 2\n';
    expect(removeTomlEntry(original, "corillo")).toBe("[other]\nb = 2\n");
    const updated = setTomlEntry(original, "corillo", entry);
    expect(updated).not.toContain("[mcp_servers.corillo.env]");
    expect(updated.endsWith("\n\n[other]\nb = 2\n")).toBe(true);
  });

  it("doesn't mistake a line inside a long text or a list for a table", () => {
    const original = [
      'notes = """',
      "[mcp_servers.corillo]",
      '"""',
      "matrix = [",
      "  [1, 2],",
      "]",
      "",
    ].join("\n");
    const added = setTomlEntry(original, "corillo", entry);
    expect(added.startsWith(original)).toBe(true);
    expect(removeTomlEntry(added, "corillo")).toBe(original);
  });

  it("refuses a file that isn't valid TOML", () => {
    expect(() => setTomlEntry('[mcp_servers.notes\ncommand = "x"\n', "corillo", entry)).toThrow(ConfigError);
  });

  it("refuses a Corillo entry written in a form it doesn't change, rather than breaking the file", () => {
    const dotted = '[mcp_servers]\ncorillo.command = "/old/Corillo"\n';
    expect(() => setTomlEntry(dotted, "corillo", entry)).toThrow(ConfigError);
    expect(() => removeTomlEntry(dotted, "corillo")).toThrow(ConfigError);
  });

  it("quotes paths with spaces and quote marks correctly", () => {
    const odd = { ...entry, command: '/Users/me/My "Apps"/Corillo' };
    expect(readTomlEntry(setTomlEntry("", "corillo", odd), "corillo")).toEqual(odd);
  });

  it("keeps Windows line endings, adding Corillo's table or replacing it", () => {
    const original = '[other]\r\nb = 2\r\n';
    const added = setTomlEntry(original, "corillo", entry);
    expect(added.startsWith(original)).toBe(true);
    expect(added.replace(/\r\n/g, "")).not.toContain("\n");
    expect(readTomlEntry(added, "corillo")).toEqual(entry);
    const replaced = setTomlEntry(added.replace("/Apps/Corillo", "/Old/Corillo"), "corillo", entry);
    expect(replaced).toBe(added);
    expect(removeTomlEntry(added, "corillo")).toBe(original);
    // Without an ending newline, and with one table in the file only.
    const bare = setTomlEntry('[other]\r\nb = 2', "corillo", entry);
    expect(bare.replace(/\r\n/g, "")).not.toContain("\n");
    // A file with Unix line endings stays so.
    expect(setTomlEntry("[other]\nb = 2\n", "corillo", entry)).not.toContain("\r");
  });
});
