// Long documents, a part at a time: a text too long for one answer is given as its outline and start, by lines, and as the paragraphs comments are on.
import { blockStarts } from "../../core/line-numbers";
import { parseMarkdown } from "../../core/markdown";
import type { Catchup } from "../../core/text-changes";
import { AgentError } from "./shapes";

/** Longer than this, a document is read as its outline and its start, and in parts of up to this long. */
export const LONG = 40_000;
const START = 12_000;
const OUTLINE = 10_000;

export const count = (n: number) => n.toLocaleString("en-US");

/** Whether a read gives what changed since the last one, rather than the text: a diff short enough for one answer. */
export const sendsChanges = (c: Catchup): c is { kind: "changes"; diff: string } => c.kind === "changes" && c.diff.length <= LONG;

/** The lines as agents count them: from 1, at each "\n", none after a final line break, no byte-order mark. */
export function linesOf(text: string): string[] {
  const lines = text.replace(/^\uFEFF/, "").split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

/** From line from, as many as fit in size characters (always at least one), up to line to. */
function upTo(lines: string[], from: number, to: number, size: number): number {
  let last = from;
  let used = lines[from - 1].length;
  while (last < to && used + 1 + lines[last].length <= size) used += 1 + lines[last++].length;
  return last;
}

/** How much of a line fits in size characters: all of it, or up to a space in the second half (between words), else size. */
function fitOf(line: string, size: number): number {
  if (line.length <= size) return line.length;
  const space = line.lastIndexOf(" ", size - 1);
  if (space >= size / 2) return space + 1;
  // Never half of a character written with two (an emoji, say).
  return /[\uD800-\uDBFF]/.test(line[size - 1]) ? size - 1 : size;
}

export function lineArg(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new AgentError(`${name} must be a line number: a whole number, 1 or more.`);
  return value;
}

/** Where to start in from_line, for a line too long to read at once. */
export function characterArg(args: Record<string, unknown>): number | undefined {
  const value = args.from_character;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new AgentError("from_character must be a whole number, 1 or more.");
  if (args.from_line === undefined || args.from_line === null) throw new AgentError("Give from_line with from_character: the line to start in.");
  return value;
}

/** A plural count of lines: "1 line", "2,300 lines". */
const linesCount = (n: number) => `${count(n)} ${n === 1 ? "line" : "lines"}`;

/**
 * Lines from to to (or as far as one answer allows), exactly as they are in
 * the file, the first from character `at`. A line too long for one answer
 * comes a part at a time, cut between words. `Label` starts a sentence.
 */
export function someLines(label: string, text: string, from: number, to: number | undefined, Label = label, at = 1): string {
  const lines = linesOf(text);
  if (from > lines.length) throw new AgentError(`${Label} has ${linesCount(lines.length)}, so there's no line ${from}.`);
  if (to !== undefined && to < from) throw new AgentError(`to_line is before from_line. Give a to_line of ${from} or more.`);
  const line = lines[from - 1];
  if (at > 1 && at > line.length) throw new AgentError(`Line ${from} of ${label} has ${count(line.length)} characters, so there's no character ${at}.`);
  const end = Math.min(to ?? lines.length, lines.length);
  const rest = line.slice(at - 1);
  const fit = fitOf(rest, LONG);
  const total = `(it has ${linesCount(lines.length)})`;
  if (fit < rest.length) {
    const upto = at - 1 + fit;
    return `Line ${from} of ${label}, characters ${count(at)} to ${count(upto)} of its ${count(line.length)} ${total}:\n\n${rest.slice(0, fit)}\n\nLine ${from} is too long to read at once: read on with from_line ${from} and from_character ${upto + 1}.`;
  }
  const parts = [...lines];
  parts[from - 1] = rest;
  const last = upTo(parts, from, end, LONG);
  const which =
    at > 1
      ? `Line ${from} of ${label}, characters ${count(at)} to ${count(line.length)} of its ${count(line.length)}${last > from ? `, then lines ${from + 1} to ${last}` : ""}`
      : `Lines ${from} to ${last} of ${label}`;
  const shown = `${which} ${total}:\n\n${parts.slice(from - 1, last).join("\n")}`;
  return last < end ? `${shown}\n\nStopped at line ${last} to keep this answer short: read on from line ${last + 1}.` : shown;
}

/**
 * A long document's headings with their lines, and its first part; `tool`
 * reads the rest, `note` follows the first line, and `more` adds a part
 * after, told how many lines the start shows and the room left. In `room`
 * characters (a take's, after its comments), the outline and start are
 * smaller to fit.
 */
export function outlineAndStart(
  label: string,
  text: string,
  tool = "read_document",
  note = "",
  more?: (shown: number, room: number) => string,
  room = Infinity,
): string {
  const outlineRoom = Math.min(OUTLINE, Math.floor(room / 4));
  const startRoom = Math.min(START, Math.floor(room * 0.3));
  const lines = linesOf(text);
  const headings: { level: number; entry: string }[] = [];
  try {
    const { doc, source } = parseMarkdown(text);
    const starts = blockStarts(doc, source).line;
    doc.forEach((node, _offset, k) => {
      const line = starts[k];
      if (node.type.name === "heading" && line !== null && line <= lines.length) {
        headings.push({ level: node.attrs.level as number, entry: `${line}: ${lines[line - 1].replace(/\r$/, "")}` });
      }
    });
  } catch {
    // No outline then; the agent still has the start, and reads on by lines.
  }
  // Fewer levels of heading until it fits.
  let deepest = 6;
  const within = (level: number) => headings.filter((h) => h.level <= level).map((h) => h.entry);
  while (deepest > 1 && within(deepest).join("\n").length > outlineRoom) deepest--;
  let entries = within(deepest);
  while (entries.join("\n").length > outlineRoom) entries = entries.slice(0, -1);
  const cut = entries.length < within(deepest).length ? "\n(The outline stops here to keep this answer short.)" : "";
  const which = deepest < 6 && headings.some((h) => h.level > deepest) ? `; levels 1 to ${deepest} only` : "";
  const outline = entries.length
    ? `Outline (line: heading${which}):\n${entries.join("\n")}${cut}`
    : headings.length
      ? "Its outline is left out to keep this answer short."
      : "It has no headings.";
  const after = (parts: string[], shown: number) => {
    const used = parts.reduce((n, p) => n + p.length + 2, 0);
    return [...parts, more?.(shown, room - used) ?? ""].filter(Boolean).join("\n\n");
  };
  const fit = fitOf(lines[0], startRoom);
  if (fit < lines[0].length) {
    // A first line too long for the start (a document written on one line): its first part.
    return after(
      [
        `${label} is long (${linesCount(lines.length)}), so this is its outline and the first ${count(fit)} characters of line 1, which is too long to read at once. Read on with ${tool}'s from_line 1 and from_character ${fit + 1}, and any other part with from_line and to_line.${note}`,
        outline,
        `Line 1, characters 1 to ${count(fit)}:\n\n${lines[0].slice(0, fit)}`,
      ],
      0,
    );
  }
  const shown = upTo(lines, 1, lines.length, startRoom);
  return after(
    [
      `${label} is long (${linesCount(lines.length)}), so this is its outline and its first ${shown === 1 ? "line" : `${shown} lines`}. Read any part with ${tool}'s from_line and to_line.${note}`,
      outline,
      `Lines 1 to ${shown}:\n\n${lines.slice(0, shown).join("\n")}`,
    ],
    shown,
  );
}

/** The most of the comments' paragraphs a take gives, and the most of any one, in characters. */
const PARAGRAPHS = 12_000;
const PARAGRAPH = 4_000;

/**
 * For a long document given as its outline and start: the paragraphs (lines
 * between empty lines) that comments' words start on, at lines `at`, with
 * their line numbers, so the agent needn't read the document to find them.
 * What the start already shows (lines 1 to `shown`) isn't given again. A
 * paragraph too long is narrowed to the comment's line, and capped in all;
 * what doesn't fit is named by line, to read with from_line and to_line.
 */
export function paragraphsAt(text: string, at: number[], shown: number, room = Infinity): string {
  // Room is kept for the lines that bring them in and name what's left out.
  const cap = Math.min(PARAGRAPHS, room - 400);
  if (cap <= 0) return "";
  const lines = linesOf(text);
  const size = (from: number, to: number) => lines.slice(from - 1, to).reduce((n, l) => n + l.length + 1, 0);
  const header = (from: number, to: number) => (from === to ? `Line ${from}:` : `Lines ${from} to ${to}:`);
  const given: { from: number; to: number }[] = [];
  const left: number[] = [];
  let used = 0;
  for (const line of [...new Set(at)].filter((n) => n > shown && n <= lines.length).sort((a, b) => a - b)) {
    if (given.some((p) => line >= p.from && line <= p.to)) continue;
    let from = line;
    while (from > shown + 1 && lines[from - 2].trim() !== "") from--;
    let to = line;
    while (to < lines.length && lines[to].trim() !== "") to++;
    if (size(from, to) > PARAGRAPH) [from, to] = [line, line];
    const cost = size(from, to) + header(from, to).length + 2;
    if (size(from, to) > PARAGRAPH || used + cost > cap) {
      left.push(line);
      continue;
    }
    used += cost;
    given.push({ from, to });
  }
  if (!given.length && !left.length) return "";
  const parts = given.map(({ from, to }) => `${header(from, to)}\n${lines.slice(from - 1, to).join("\n")}`);
  const out = given.length ? [`The paragraphs the comments are on, so you needn't read the document to find them:`, ...parts] : [];
  if (left.length) {
    const named = left.slice(0, 10).join(", ") + (left.length > 10 ? ` and ${left.length - 10} more` : "");
    out.push(`Not shown here, to keep this answer short: the paragraphs at lines ${named}. Read them with read_document's from_line and to_line.`);
  }
  return out.join("\n\n");
}
