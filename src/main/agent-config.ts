// Changing other apps' settings files without disturbing anything else in
// them. Corillo adds, replaces or removes only its own entry, by editing the
// file's text in place, so everything else stays exactly as it was (spacing
// and comments included). Before anything is saved, the new text is read back
// and checked: Corillo's entry must be there (or gone) and nothing else may
// have changed. If a file can't be read, it's left alone.
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";

export type ConfigProblem = "unreadable" | "unexpected" | "changing" | "unsaved";

export class ConfigError extends Error {
  constructor(readonly problem: ConfigProblem, message: string = problem) {
    super(message);
  }
}

const unreadable = (): never => {
  throw new ConfigError("unreadable");
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// JSON ------------------------------------------------------------------------
// Some tools (VS Code among them) allow comments and trailing commas in their
// JSON files, so the reader accepts both.

interface Member {
  key: string;
  /** Where the key's opening quote is. */
  start: number;
  valueStart: number;
  valueEnd: number;
  /** Where the comma after this member is, or -1. */
  comma: number;
}

interface ObjectSpan {
  open: number;
  close: number;
  members: Member[];
}

const STRING = /"(?:[^"\\\u0000-\u001f]|\\.)*"/y;
const LITERAL = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\w.])/y;

class JsonScanner {
  i = 0;
  /** Comments and trailing commas, blanked out before the value is read. */
  readonly blanks: [number, number][] = [];

  constructor(readonly text: string) {
    if (text.startsWith("\uFEFF")) {
      this.blanks.push([0, 1]);
      this.i = 1;
    }
  }

  space(): void {
    const t = this.text;
    for (;;) {
      const c = t[this.i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.i++;
      else if (c === "/" && t[this.i + 1] === "/") {
        const end = t.indexOf("\n", this.i);
        const stop = end < 0 ? t.length : end;
        this.blanks.push([this.i, stop]);
        this.i = stop;
      } else if (c === "/" && t[this.i + 1] === "*") {
        const end = t.indexOf("*/", this.i + 2);
        if (end < 0) unreadable();
        this.blanks.push([this.i, end + 2]);
        this.i = end + 2;
      } else return;
    }
  }

  private match(re: RegExp): string {
    re.lastIndex = this.i;
    const m = re.exec(this.text);
    if (!m) unreadable();
    this.i += m![0].length;
    return m![0];
  }

  value(): void {
    this.space();
    const c = this.text[this.i];
    if (c === "{") this.object();
    else if (c === "[") this.array();
    else if (c === '"') this.match(STRING);
    else this.match(LITERAL);
  }

  object(): ObjectSpan {
    const open = this.i++;
    const members: Member[] = [];
    this.space();
    if (this.text[this.i] === "}") return { open, close: this.i++, members };
    for (;;) {
      this.space();
      if (this.text[this.i] !== '"') unreadable();
      const start = this.i;
      const key = JSON.parse(this.match(STRING)) as string;
      this.space();
      if (this.text[this.i] !== ":") unreadable();
      this.i++;
      this.space();
      const valueStart = this.i;
      this.value();
      const member: Member = { key, start, valueStart, valueEnd: this.i, comma: -1 };
      members.push(member);
      this.space();
      const c = this.text[this.i];
      if (c === ",") {
        member.comma = this.i++;
        this.space();
        if (this.text[this.i] === "}") {
          this.blanks.push([member.comma, member.comma + 1]);
          return { open, close: this.i++, members };
        }
      } else if (c === "}") {
        return { open, close: this.i++, members };
      } else unreadable();
    }
  }

  array(): void {
    this.i++;
    this.space();
    if (this.text[this.i] === "]") {
      this.i++;
      return;
    }
    for (;;) {
      this.value();
      this.space();
      const c = this.text[this.i];
      if (c === ",") {
        const comma = this.i++;
        this.space();
        if (this.text[this.i] === "]") {
          this.blanks.push([comma, comma + 1]);
          this.i++;
          return;
        }
      } else if (c === "]") {
        this.i++;
        return;
      } else unreadable();
    }
  }
}

interface ScannedJson {
  /** The top-level object, or null for an empty file. */
  root: ObjectSpan | null;
  value: unknown;
}

function scanJson(text: string): ScannedJson {
  const s = new JsonScanner(text);
  s.space();
  if (s.i >= text.length) return { root: null, value: undefined };
  let root: ObjectSpan | null = null;
  if (text[s.i] === "{") root = s.object();
  else s.value();
  s.space();
  if (s.i !== text.length) unreadable();
  let clean = "";
  let at = 0;
  for (const [from, to] of s.blanks.sort((a, b) => a[0] - b[0])) {
    clean += text.slice(at, from) + " ".repeat(to - from);
    at = to;
  }
  clean += text.slice(at);
  try {
    return { root, value: JSON.parse(clean) };
  } catch {
    return unreadable();
  }
}

function objectAt(text: string, at: number): ObjectSpan {
  const s = new JsonScanner(text);
  s.i = at;
  return s.object();
}

/** How the file is laid out, so new text matches it. */
interface Layout {
  /** One level of indentation, or null for a file written on one line. */
  unit: string | null;
  eol: string;
}

function layoutOf(text: string): Layout {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (!text.trim().includes("\n")) return { unit: null, eol };
  const m = /\n([ \t]+)["}\]]/.exec(text);
  return { unit: m ? m[1] : "  ", eol };
}

/** The spaces before a position, if nothing else comes before it on its line. */
function indentBefore(text: string, at: number): string | null {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const before = text.slice(lineStart, at);
  return /^[ \t]*$/.test(before) ? before : null;
}

/** The spaces at the start of the line that holds this position. */
function lineIndent(text: string, at: number): string {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

function render(value: unknown, indent: string, layout: Layout): string {
  if (layout.unit === null) return JSON.stringify(value);
  return JSON.stringify(value, null, layout.unit).split("\n").join(layout.eol + indent);
}

function memberText(key: string, value: unknown, indent: string, layout: Layout): string {
  return `${JSON.stringify(key)}:${layout.unit === null ? "" : " "}${render(value, indent, layout)}`;
}

/** Add a member at the end of an object. */
function insertMember(text: string, obj: ObjectSpan, key: string, value: unknown, layout: Layout): string {
  const multiline = layout.unit !== null && (text.slice(obj.open, obj.close).includes("\n") || obj.members.length === 0);
  const last = obj.members[obj.members.length - 1];
  if (!last) {
    // An empty object may still hold comments (a server commented out, say): they stay, and ours goes after them.
    const end = obj.open + 1 + text.slice(obj.open + 1, obj.close).trimEnd().length;
    const comments = end > obj.open + 1;
    if (!multiline) {
      return text.slice(0, end) + (comments ? " " : "") + memberText(key, value, "", layout) + text.slice(comments ? end : obj.close);
    }
    const outer = lineIndent(text, obj.open);
    const inner = outer + layout.unit;
    const tail = text.slice(end, obj.close);
    const closing = comments && tail.includes("\n") ? tail : layout.eol + outer;
    return text.slice(0, end) + layout.eol + inner + memberText(key, value, inner, layout) + closing + text.slice(obj.close);
  }
  if (!multiline) {
    const spaced = text[obj.open + 1] === " " ? " " : "";
    const compact: Layout = { unit: null, eol: layout.eol };
    const at = last.comma >= 0 ? last.comma + 1 : last.valueEnd;
    const lead = last.comma >= 0 ? spaced : `,${spaced}`;
    return text.slice(0, at) + lead + memberText(key, value, "", compact) + text.slice(at);
  }
  const indent = indentBefore(text, last.start) ?? lineIndent(text, obj.open) + layout.unit;
  // A file that puts a comma after its last member gets one after ours too.
  const trailing = last.comma >= 0;
  const anchor = trailing ? last.comma + 1 : last.valueEnd;
  const member = memberText(key, value, indent, layout) + (trailing ? "," : "");
  const comma = trailing ? "" : ",";
  let lineEnd = text.indexOf("\n", anchor);
  if (lineEnd < 0) lineEnd = text.length;
  if (lineEnd > anchor && text[lineEnd - 1] === "\r") lineEnd--;
  if (/^[ \t]*(\/\/.*)?$/.test(text.slice(anchor, lineEnd))) {
    // Ours goes on the next line, after anything (a comment) at the end of this one.
    return (
      text.slice(0, last.valueEnd) + comma + text.slice(last.valueEnd, lineEnd) + layout.eol + indent + member + text.slice(lineEnd)
    );
  }
  return text.slice(0, anchor) + comma + layout.eol + indent + member + text.slice(anchor);
}

function replaceValue(text: string, m: Member, value: unknown, layout: Layout): string {
  const indent = indentBefore(text, m.start) ?? lineIndent(text, m.start);
  return text.slice(0, m.valueStart) + render(value, indent, layout) + text.slice(m.valueEnd);
}

function removeMember(text: string, obj: ObjectSpan, index: number): string {
  const m = obj.members[index];
  if (obj.members.length === 1) {
    const end = m.comma >= 0 ? m.comma + 1 : m.valueEnd;
    const comments = (text.slice(obj.open + 1, m.start) + text.slice(end, obj.close)).trim() !== "";
    // The only member: leave an empty object, written the way it would be by hand.
    if (!comments) return text.slice(0, obj.open + 1) + text.slice(obj.close);
    // Comments stay as they were. A member on its own line goes with its line, below.
    if (indentBefore(text, m.start) === null) {
      const from = obj.open + 1 + text.slice(obj.open + 1, m.start).trimEnd().length;
      return text.slice(0, from) + text.slice(end);
    }
  }
  let from = m.start;
  let to = m.comma >= 0 ? m.comma + 1 : m.valueEnd;
  const lineStart = text.lastIndexOf("\n", from - 1) + 1;
  if (/^[ \t]*$/.test(text.slice(lineStart, from))) {
    const nl = text.indexOf("\n", to);
    const rest = nl < 0 ? text.slice(to) : text.slice(to, nl);
    if (/^[ \t]*\r?$/.test(rest)) {
      from = lineStart;
      to = nl < 0 ? text.length : nl + 1;
    }
  } else if (m.comma >= 0) {
    to = m.comma + 1;
    while (text[to] === " ") to++;
  }
  let next = text.slice(0, from) + text.slice(to);
  // Removing the last member leaves a comma after the one before it.
  const prev = obj.members[index - 1];
  if (m.comma < 0 && prev && prev.comma >= 0) next = next.slice(0, prev.comma) + next.slice(prev.comma + 1);
  return next;
}

/** The last member with this key (JSON readers keep the last of duplicates). */
function lastMember(obj: ObjectSpan, key: string): number {
  for (let i = obj.members.length - 1; i >= 0; i--) if (obj.members[i].key === key) return i;
  return -1;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

function checked(next: string, expected: unknown): string {
  let value: unknown;
  try {
    value = scanJson(next).value;
  } catch {
    throw new ConfigError("unexpected", "the edited file didn't read back");
  }
  if (!isDeepStrictEqual(value, expected)) throw new ConfigError("unexpected", "the edited file didn't match");
  return next;
}

function readRoot(text: string | null): { scanned: ScannedJson; value: Record<string, unknown> } {
  const scanned = scanJson(text ?? "");
  if (scanned.root === null && scanned.value !== undefined) throw new ConfigError("unexpected", "not an object");
  return { scanned, value: (scanned.value as Record<string, unknown>) ?? {} };
}

/** Our entry in a JSON settings file: value[group][name], or undefined. */
export function readJsonEntry(text: string | null, group: string, name: string): unknown {
  const { value } = readRoot(text);
  const servers = value[group];
  return isPlainObject(servers) ? servers[name] : undefined;
}

/** Add or replace value[group][name], keeping the rest of the text as it was. */
export function setJsonEntry(text: string | null, group: string, name: string, entry: unknown): string {
  const { scanned, value } = readRoot(text);
  const expected = clone(value);
  if (expected[group] !== undefined && !isPlainObject(expected[group])) throw new ConfigError("unexpected", `${group} isn't an object`);
  expected[group] = { ...((expected[group] as Record<string, unknown>) ?? {}), [name]: entry };

  if (!scanned.root) {
    const fresh = JSON.stringify({ [group]: { [name]: entry } }, null, 2) + "\n";
    return checked(fresh, expected);
  }
  const src = text!;
  const layout = layoutOf(src);
  const groupMember = scanned.root.members[lastMember(scanned.root, group)];
  if (!groupMember) return checked(insertMember(src, scanned.root, group, { [name]: entry }, layout), expected);
  const servers = objectAt(src, groupMember.valueStart);
  const existing = servers.members[lastMember(servers, name)];
  const next = existing ? replaceValue(src, existing, entry, layout) : insertMember(src, servers, name, entry, layout);
  return checked(next, expected);
}

/**
 * Remove value[group][name] if it's there, keeping the rest of the text as it
 * was. `before` is the file as it was before Corillo first changed it, if known.
 */
export function removeJsonEntry(text: string | null, group: string, name: string, before: string | null = null): string | null {
  const { scanned, value } = readRoot(text);
  if (!scanned.root || !isPlainObject(value[group]) || !(name in (value[group] as object))) return text;
  const src = text!;
  const expected = clone(value);
  delete (expected[group] as Record<string, unknown>)[name];
  const groupMember = scanned.root.members[lastMember(scanned.root, group)];
  let next = src;
  // Remove from the end so earlier positions stay right (a name can appear twice).
  for (;;) {
    const servers = objectAt(next, groupMember.valueStart);
    const index = lastMember(servers, name);
    if (index < 0) break;
    next = removeMember(next, servers, index);
  }
  // A servers section left empty goes too, so a file Corillo added it to reads
  // as it did before. One that was there before Corillo came stays.
  const sections = scanned.root.members.filter((m) => m.key === group).length;
  if (sections === 1 && Object.keys(expected[group] as object).length === 0 && !hadGroup(before, group)) {
    const root = objectAt(next, scanned.root.open);
    next = removeMember(next, root, lastMember(root, group));
    delete expected[group];
  }
  return checked(next, expected);
}

function hadGroup(before: string | null, group: string): boolean {
  if (before === null) return false;
  try {
    return group in readRoot(before).value;
  } catch {
    return false; // can't tell: as if Corillo had added it
  }
}

// TOML ------------------------------------------------------------------------
// Codex keeps its servers as [mcp_servers.<name>] tables. Corillo replaces or
// appends only its own table (and any of its sub-tables), line by line.

export interface TomlServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

const tomlString = (s: string) => JSON.stringify(s); // JSON's escapes are all valid in a TOML basic string
const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k));

export function renderTomlTable(name: string, server: TomlServer): string {
  const env = Object.entries(server.env)
    .map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`)
    .join(", ");
  return [
    `[mcp_servers.${tomlKey(name)}]`,
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map(tomlString).join(", ")}]`,
    `env = { ${env} }`,
    "",
  ].join("\n");
}

interface TableRange {
  path: string[];
  /** The header line's start. */
  start: number;
  /** The end of the table's last line with content (comments and blank lines after it belong to what follows). */
  end: number;
}

function parseKeyPath(key: string): string[] | null {
  const parts: string[] = [];
  const re = /\s*(?:([A-Za-z0-9_-]+)|"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(\.|$)/y;
  let at = 0;
  while (at < key.length) {
    re.lastIndex = at;
    const m = re.exec(key);
    if (!m) return null;
    parts.push(m[1] ?? (m[2] !== undefined ? (JSON.parse(`"${m[2]}"`) as string) : m[3]));
    at = re.lastIndex;
    if (!m[4]) break;
  }
  return parts;
}

/** Every table header in the file, with the lines it covers. */
function tableRanges(text: string): TableRange[] {
  const ranges: TableRange[] = [];
  let depth = 0; // inside a value's [ ] or { } that spans lines
  let i = 0;
  let current: TableRange | null = null;
  const n = text.length;
  while (i < n) {
    const lineStart = i;
    const lineEnd = text.indexOf("\n", i) < 0 ? n : text.indexOf("\n", i) + 1;
    const line = text.slice(lineStart, lineEnd);
    const trimmed = line.trim();
    if (depth === 0 && trimmed.startsWith("[")) {
      const m = /^\[\[?\s*(.*?)\s*\]\]?\s*(?:#.*)?$/.exec(trimmed);
      const path = m ? parseKeyPath(m[1]) : null;
      if (current) ranges.push(current);
      current = { path: path ?? [], start: lineStart, end: lineEnd };
      i = lineEnd;
      continue;
    }
    // Walk the line for strings, comments and brackets; multi-line strings can run on.
    let j = lineStart;
    let content = false;
    while (j < n) {
      const c = text[j];
      if (c === "\n") {
        j++;
        break;
      }
      if (c === "#") {
        const nl = text.indexOf("\n", j);
        j = nl < 0 ? n : nl;
        continue;
      }
      if (c !== " " && c !== "\t" && c !== "\r") content = true;
      if (text.startsWith('"""', j) || text.startsWith("'''", j)) {
        const quote = text.slice(j, j + 3);
        let k = j + 3;
        for (;;) {
          const end = text.indexOf(quote, k);
          if (end < 0) {
            k = n;
            break;
          }
          if (quote === '"""') {
            let slashes = 0;
            for (let b = end - 1; text[b] === "\\"; b--) slashes++;
            if (slashes % 2) {
              k = end + 1;
              continue;
            }
          }
          k = end + 3;
          while (text[k] === quote[0]) k++; // up to two quotes may close the string
          break;
        }
        j = k;
        continue;
      }
      if (c === '"') {
        let k = j + 1;
        while (k < n && text[k] !== '"' && text[k] !== "\n") k += text[k] === "\\" ? 2 : 1;
        j = k + 1;
        continue;
      }
      if (c === "'") {
        const end = text.indexOf("'", j + 1);
        j = end < 0 ? n : end + 1;
        continue;
      }
      if (c === "[" || c === "{") depth++;
      else if ((c === "]" || c === "}") && depth > 0) depth--;
      j++;
    }
    if (current && content) current.end = j;
    i = j;
  }
  if (current) ranges.push(current);
  return ranges;
}

function ownRanges(text: string, name: string): TableRange[] {
  return tableRanges(text).filter((r) => r.path[0] === "mcp_servers" && r.path[1] === name);
}

function parseTomlText(text: string | null): Record<string, unknown> {
  try {
    return clone(parseToml(text ?? "")) as Record<string, unknown>;
  } catch {
    return unreadable();
  }
}

/** The document without our server, for comparing everything else. */
function withoutServer(doc: Record<string, unknown>, name: string): Record<string, unknown> {
  const copy = clone(doc);
  const servers = copy.mcp_servers;
  if (isPlainObject(servers)) {
    delete servers[name];
    if (Object.keys(servers).length === 0) delete copy.mcp_servers;
  }
  return copy;
}

function checkedToml(next: string, before: Record<string, unknown>, name: string, server: TomlServer | null): string {
  let after: Record<string, unknown>;
  try {
    after = parseTomlText(next);
  } catch {
    throw new ConfigError("unexpected", "the edited file didn't read back");
  }
  const servers = after.mcp_servers;
  const ours = isPlainObject(servers) ? servers[name] : undefined;
  const entryOk = server ? isDeepStrictEqual(ours, clone(server)) : ours === undefined;
  if (!entryOk || !isDeepStrictEqual(withoutServer(after, name), withoutServer(before, name))) {
    throw new ConfigError("unexpected", "the edited file didn't match");
  }
  return next;
}

/** The file's line ending: Windows' where it has them, so what Corillo adds matches. */
const lineEnding = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");

/** Take out a range of lines, without leaving a double gap behind. */
function cut(text: string, from: number, to: number): string {
  const eol = lineEnding(text);
  let before = text.slice(0, from);
  let after = text.slice(to);
  const gapBefore = before === "" || before.endsWith(eol + eol);
  if (gapBefore && (after === "" || after.startsWith(eol))) {
    if (after.startsWith(eol)) after = after.slice(eol.length);
    else if (before.endsWith(eol + eol)) before = before.slice(0, -eol.length);
  }
  return before + after;
}

export function readTomlEntry(text: string | null, name: string): unknown {
  const doc = parseTomlText(text);
  const servers = doc.mcp_servers;
  return isPlainObject(servers) ? servers[name] : undefined;
}

export function setTomlEntry(text: string | null, name: string, server: TomlServer): string {
  const src = text ?? "";
  const before = parseTomlText(src);
  if (before.mcp_servers !== undefined && !isPlainObject(before.mcp_servers)) {
    throw new ConfigError("unexpected", "mcp_servers isn't a table");
  }
  const eol = lineEnding(src);
  const block = renderTomlTable(name, server).replace(/\n/g, eol); // its values never hold a line break
  const ranges = ownRanges(src, name);
  let next: string;
  if (ranges.length) {
    // Replace our table where it is; drop any sub-tables of ours.
    next = src;
    for (const r of [...ranges].reverse().slice(0, -1)) next = cut(next, r.start, r.end);
    const first = ranges[0];
    next = next.slice(0, first.start) + block + next.slice(first.end);
  } else if (src.trim() === "") {
    next = block;
  } else {
    const gap = src.endsWith(eol + eol) ? "" : src.endsWith(eol) ? eol : eol + eol;
    next = src + gap + block;
  }
  return checkedToml(next, before, name, server);
}

export function removeTomlEntry(text: string | null, name: string): string | null {
  if (text === null) return null;
  const before = parseTomlText(text);
  const ranges = ownRanges(text, name);
  if (!ranges.length) {
    if (readTomlEntry(text, name) !== undefined) throw new ConfigError("unexpected", "written in a form Corillo doesn't change");
    return text;
  }
  let next = text;
  for (const r of [...ranges].reverse()) next = cut(next, r.start, r.end);
  return checkedToml(next, before, name, null);
}
