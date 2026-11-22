// An agent's edit as it lands: its edits grouped by the comments they answer, each comment carried through to where its words are now, and the text in the file's own form.
import { anchorIn, locate, type Anchor } from "../../core/anchors";
import type { Thread } from "../../core/comments";
import { OffsetMap, applyPlaced, carry, placeEdits, type PassLinks, type Placed } from "../../core/change-links";
import { diffLines, type Edit } from "../../core/text-changes";
import { plural } from "./limits-and-words";

/** A copy of a pass's links (plain data: texts, places and maps), to go back to if the file refuses an edit. */
export function copyLinks(links: PassLinks): PassLinks {
  return Object.assign(Object.create(Object.getPrototypeOf(links)) as PassLinks, structuredClone({ ...links }));
}

/** Edits that answer the same comments: the Markdown after them and the groups before them are made, and where they went in the Markdown before the call. */
export type EditGroup = { markdown: string; owners: string[]; placed?: Placed[] };

/**
 * An agent's edits in groups that answer the same comments, each with the
 * Markdown after it and the groups before it are made, so what each group
 * changed can be told apart.
 */
export function groupEdits(before: string, edits: Edit[], owners: string[][]): EditGroup[] {
  const groups = new Map<string, { owners: string[]; placed: Placed[] }>();
  for (const p of placeEdits(before, edits)) {
    const ids = owners[p.index] ?? [];
    const key = ids.join(" ");
    if (!groups.has(key)) groups.set(key, { owners: ids, placed: [] });
    groups.get(key)!.placed.push(p);
  }
  const applied: Placed[] = [];
  return [...groups.values()].map((g) => {
    applied.push(...g.placed);
    return { markdown: applyPlaced(before, applied), owners: g.owners, placed: g.placed };
  });
}

/**
 * The comments after an agent's edit, each carried by where its words are.
 * Corillo knows exactly what the edit changed, so each comment's words are
 * found in the text before it and followed through it (see carry), rather
 * than searched for after it, where the same words elsewhere could pass for
 * them: the comment stays on its words as they are now ("customers" changed
 * to "clients" is on "clients"; a word in a sentence rewritten whole is on
 * the rewritten words). The window places comments from what's stored here.
 * Left as they were: comments whose words the edit deleted (they keep their
 * place, set just before) and comments already lost. Comments whose words
 * were rewritten along with other paragraphs, where a place would be a
 * guess, are marked as lost (the window says their text has changed).
 */
export function followEdit(threads: Thread[], before: string, after: string, through?: OffsetMap): Thread[] {
  if (before === after) return threads;
  let map = through;
  return threads.map((t) => {
    if (!t.anchor || t.gap || t.detached) return t;
    const at = wordsIn(before, t.anchor);
    if (!at) return t;
    map ??= new OffsetMap(before, after);
    const carried = carry(before, after, at.start, at.end, map, t.anchor);
    if (carried.kind === "deleted") return t;
    if (carried.kind === "lost") return { ...t, detached: true };
    const anchor = anchorIn(after, carried.start, carried.end);
    const old = t.anchor;
    if (anchor.quote === old.quote && anchor.prefix === old.prefix && anchor.suffix === old.suffix && anchor.offset === old.offset) return t;
    return { ...t, anchor };
  });
}

/** Where an anchor's words are in a text: where it says, when that's so (as it is after Corillo's own edits), else found. */
function wordsIn(text: string, a: Anchor): { start: number; end: number } | null {
  const end = a.offset + a.quote.length;
  const there =
    a.quote !== "" &&
    a.offset >= a.prefix.length &&
    text.startsWith(a.quote, a.offset) &&
    text.startsWith(a.prefix, a.offset - a.prefix.length) &&
    text.startsWith(a.suffix, end);
  return there ? { start: a.offset, end } : locate(text, a);
}

/**
 * An agent's whole text in the file's own form: the file's byte order mark,
 * and, when the agent wrote plain line breaks, the file's line ends. A line
 * left as it was keeps its own; a new or changed one takes the file's most
 * common. A text with carriage returns of its own is left as it came.
 */
export function inFileForm(file: string, text: string): string {
  const MARK = "\uFEFF";
  const body = file.startsWith(MARK) ? file.slice(1) : file;
  const own = text.startsWith(MARK) ? text.slice(1) : text;
  const mark = file.startsWith(MARK) || text.startsWith(MARK) ? MARK : "";
  if (!body.includes("\r\n") || own.includes("\r")) return mark + own;
  const ends = body.split("\n").slice(0, -1).map((l) => (l.endsWith("\r") ? "\r\n" : "\n"));
  const windows = ends.filter((e) => e === "\r\n").length;
  if (windows === ends.length) return mark + own.replace(/\n/g, "\r\n");
  const usual = windows * 2 >= ends.length ? "\r\n" : "\n";
  const was = body.replace(/\r\n/g, "\n");
  const lines = own.split("\n");
  // Which line of the file each of the agent's unchanged lines is.
  const same = new Map<number, number>();
  const hunks = diffLines(was, own);
  if (hunks) {
    let i = 0;
    let j = 0;
    for (const h of [...hunks, { newStart: lines.length + 1, removed: [], added: [] }]) {
      while (j < h.newStart - 1) same.set(j++, i++);
      i += h.removed.length;
      j += h.added.length;
    }
  }
  let out = lines[0];
  for (let j = 1; j < lines.length; j++) {
    const i = same.get(j - 1);
    out += (i !== undefined && i < ends.length ? ends[i] : usual) + lines[j];
  }
  return mark + out;
}

/** How much a whole-text replacement changed, so the agent can tell it did what it meant: "3 of 40 lines new or changed". */
export function linesChanged(before: string, after: string): string {
  const total = after.split("\n").length;
  const hunks = diffLines(before, after);
  if (!hunks) return "most lines changed";
  const added = hunks.reduce((n, h) => n + h.added.length, 0);
  const removed = hunks.reduce((n, h) => n + h.removed.length, 0);
  return added ? `${added} of ${total} lines new or changed` : `${plural(removed, "line")} removed`;
}
