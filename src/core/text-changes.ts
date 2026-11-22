// Changes to a document's Markdown, as agents see and make them: what changed
// since an agent last read the text (a compact line diff, so it doesn't pay
// for the whole document again), and exact find-and-replace edits.
import { diffWithin } from "./diff";

// What changed since the last read ------------------------------------------------

export interface Hunk {
  /** 1-based line numbers, as in a unified diff. */
  oldStart: number;
  newStart: number;
  removed: string[];
  added: string[];
}

/** The most line changes worth describing; beyond that, sending the whole text is simpler. */
const MAX_LINES_DESCRIBED = 1500;

/**
 * Lines removed and added to turn one text into the other (Myers' algorithm),
 * grouped into hunks. Null when there are too many changes to be worth listing.
 */
export function diffLines(before: string, after: string, maxChanges = MAX_LINES_DESCRIBED): Hunk[] | null {
  const ops = diffWithin(before.split("\n"), after.split("\n"), (x, y) => x === y, maxChanges);
  if (!ops) return null;
  const hunks: Hunk[] = [];
  let i = 0; // lines of before so far
  let j = 0; // lines of after so far
  let current: Hunk | null = null;
  for (const op of ops) {
    if (op.type === "same") {
      current = null;
      i++;
      j++;
      continue;
    }
    if (!current) {
      current = { oldStart: i + 1, newStart: j + 1, removed: [], added: [] };
      hunks.push(current);
    }
    if (op.type === "removed") {
      current.removed.push(op.a);
      i++;
    } else {
      current.added.push(op.b);
      j++;
    }
  }
  return hunks;
}

/** Hunks as a unified diff with no context lines. */
export function formatHunks(hunks: Hunk[]): string {
  const range = (start: number, count: number) => `${count === 0 ? start - 1 : start},${count}`;
  return hunks
    .map((h) =>
      [
        `@@ -${range(h.oldStart, h.removed.length)} +${range(h.newStart, h.added.length)} @@`,
        ...h.removed.map((l) => `-${l}`),
        ...h.added.map((l) => `+${l}`),
      ].join("\n"),
    )
    .join("\n");
}

export type Catchup = { kind: "same" } | { kind: "changes"; diff: string } | { kind: "whole" };

/** How to bring a reader up to date: nothing changed, just the changes, or the whole text. */
export function catchUp(lastRead: string, latest: string): Catchup {
  if (lastRead === latest) return { kind: "same" };
  const hunks = diffLines(lastRead, latest);
  if (!hunks) return { kind: "whole" };
  const diff = formatHunks(hunks);
  // When most of it changed, the whole text is clearer and hardly longer.
  if (diff.length > latest.length * 0.6) return { kind: "whole" };
  return { kind: "changes", diff };
}

// Exact edits ------------------------------------------------------------------------

export interface Edit {
  find: string;
  replace: string;
  /** Change every match, not just a single one. */
  all?: boolean;
}

/** Where a replacement landed in the new text, and which edit (1-based) made it; from and to: the text it replaced, in the text before. */
export interface Landed {
  edit: number;
  start: number;
  end: number;
  from: number;
  to: number;
}

export type EditResult = { ok: true; text: string; placed: Landed[] } | { ok: false; error: string };

/** Where an edit's text is found in the document, and what goes there. */
export interface Match {
  at: number;
  end: number;
  replace: string;
}

const toWindows = (s: string) => s.replace(/\r?\n/g, "\r\n");
const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where an edit's text to find is: with all, every match, none overlapping;
 * otherwise every place it starts, to tell whether it's there more than once.
 * In a document with Windows line ends (CRLF), a line break in it matches
 * either kind of line end, since some files mix them, and the replacement's
 * line breaks follow what it matched (Windows ones where no line break was
 * matched). An empty text to find matches nowhere.
 */
export function matchesOf(text: string, edit: Edit): Match[] {
  const out: Match[] = [];
  if (!edit.find) return out;
  const windows = text.includes("\r\n");
  if (!windows || !edit.find.includes("\n")) {
    const replace = windows ? toWindows(edit.replace) : edit.replace;
    const step = edit.all === true ? edit.find.length : 1;
    for (let i = text.indexOf(edit.find); i >= 0; i = text.indexOf(edit.find, i + step)) out.push({ at: i, end: i + edit.find.length, replace });
    return out;
  }
  const lines = edit.find.replace(/\r\n/g, "\n").split("\n");
  const pattern = new RegExp(lines.map(escaped).join("\r?\n"), "g");
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    out.push({ at: m.index, end: m.index + m[0].length, replace: m[0].includes("\r\n") ? toWindows(edit.replace) : edit.replace });
    if (edit.all !== true) pattern.lastIndex = m.index + 1;
  }
  return out;
}

export const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** Text with spacing, line breaks, curly quotes and capitals evened out, and where each character came from. */
function loosen(text: string): { text: string; from: number[] } {
  let out = "";
  const from: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; i++) {
    let ch = text[i];
    if (/\s/.test(ch)) {
      if (space) continue;
      space = true;
      ch = " ";
    } else {
      space = false;
      ch = ch.replace(/[‘’]/, "'").replace(/[“”]/, '"').toLowerCase();
    }
    out += ch;
    from.push(i);
  }
  return { text: out, from };
}

function nearMatchLine(text: string, find: string): number | null {
  const loose = loosen(text);
  const target = loosen(find).text.trim();
  if (!target) return null;
  const at = loose.text.indexOf(target);
  return at < 0 ? null : lineAt(text, loose.from[at]);
}

/**
 * Apply exact find-and-replace edits to the text. Every find must match the
 * text exactly once (or, with all, at least once: every match changes), and
 * the edits must not overlap. They all apply to the text as it was before,
 * together, or none do.
 */
export function applyEdits(text: string, edits: Edit[]): EditResult {
  if (!edits.length) return { ok: false, error: "No edits given. Nothing was changed." };
  const placed: { at: number; end: number; replace: string; n: number }[] = [];
  for (const [index, edit] of edits.entries()) {
    const n = index + 1;
    const label = edits.length > 1 ? `Edit ${n}: the text to find` : "The text to find";
    const find = edit.find;
    if (!find) {
      return {
        ok: false,
        error: `${label} is empty. To add text, find the words next to where it goes and repeat them in the replacement. Nothing was changed.`,
      };
    }
    const hits = matchesOf(text, edit);
    if (hits.length === 0) {
      const near = nearMatchLine(text, find);
      const hint = near
        ? ` It nearly matches at line ${near}, but the spacing, line breaks, quotes or capitals differ.`
        : "";
      return {
        ok: false,
        error: `${label} isn't in the document.${hint} Copy it exactly from the latest text, Markdown marks included (read_document gives it). Nothing was changed.`,
      };
    }
    if (hits.length > 1 && edit.all !== true) {
      const lines = [...new Set(hits.map((h) => lineAt(text, h.at)))].slice(0, 5).join(", ");
      return {
        ok: false,
        error: `${label} appears ${hits.length} times (lines ${lines}). Include more of the words around it so it matches only once, or set all to true to change every one. Nothing was changed.`,
      };
    }
    for (const h of hits) placed.push({ ...h, n });
  }
  placed.sort((x, y) => x.at - y.at);
  for (let i = 1; i < placed.length; i++) {
    if (placed[i].at < placed[i - 1].end) {
      const [a, b] = [placed[i - 1].n, placed[i].n].sort((x, y) => x - y);
      return { ok: false, error: `Edits ${a} and ${b} overlap. Combine them into one edit. Nothing was changed.` };
    }
  }
  let out = "";
  let last = 0;
  const landed: Landed[] = [];
  for (const p of placed) {
    out += text.slice(last, p.at);
    landed.push({ edit: p.n, start: out.length, end: out.length + p.replace.length, from: p.at, to: p.end });
    out += p.replace;
    last = p.end;
  }
  return { ok: true, text: out + text.slice(last), placed: landed };
}

/**
 * Each change as it now reads, for the agent to check: its line, the new
 * words with a little of what's around them, at most two per edit, in the
 * order they come in the document.
 */
export function asItReads(text: string, placed: Landed[]): string {
  const lines: string[] = [];
  const byEdit = new Map<number, Landed[]>();
  for (const p of placed) byEdit.set(p.edit, [...(byEdit.get(p.edit) ?? []), p]);
  for (const [, list] of [...byEdit].sort(([, a], [, b]) => a[0].start - b[0].start)) {
    for (const p of list.slice(0, 2)) lines.push(`line ${lineAt(text, p.start)}: ${JSON.stringify(around(text, p))}`);
    if (list.length > 2) lines.push(`(and ${list.length - 2} more like it)`);
  }
  return lines.join("\n");
}

const SHOWN_AROUND = 50;
const LONGEST = 160;

function around(text: string, p: Landed): string {
  const lineStart = text.lastIndexOf("\n", p.start - 1) + 1;
  const lineEnd = text.indexOf("\n", p.end) < 0 ? text.length : text.indexOf("\n", p.end);
  const from = Math.max(lineStart, p.start - SHOWN_AROUND);
  const to = Math.min(lineEnd, p.end + SHOWN_AROUND);
  let middle = text.slice(p.start, p.end);
  if (middle.length > LONGEST) middle = `${middle.slice(0, LONGEST / 2)} [...] ${middle.slice(-LONGEST / 2)}`;
  return `${from > lineStart ? "…" : ""}${text.slice(from, p.start)}${middle}${text.slice(p.end, to)}${to < lineEnd ? "…" : ""}`;
}

// Exact edits, placed ----------------------------------------------------------------

export interface Placed {
  at: number;
  end: number;
  replace: string;
  /** Which edit it was, in the order given. */
  index: number;
}

/**
 * Where each of an agent's exact edits applies in the text: once, or at every
 * match with all. Call it only for edits applyEdits accepted.
 */
export function placeEdits(text: string, edits: { find: string; replace: string; all?: boolean }[]): Placed[] {
  const placed: Placed[] = [];
  edits.forEach((e, index) => {
    const hits = matchesOf(text, e);
    for (const h of e.all ? hits : hits.slice(0, 1)) placed.push({ ...h, index });
  });
  return placed.sort((x, y) => x.at - y.at);
}

/** The text with only these edits made. */
export function applyPlaced(text: string, placed: Placed[]): string {
  let out = "";
  let last = 0;
  for (const p of [...placed].sort((x, y) => x.at - y.at)) {
    out += text.slice(last, p.at) + p.replace;
    last = p.end;
  }
  return out + text.slice(last);
}
