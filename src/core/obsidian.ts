// Obsidian's additions to Markdown, as its public help describes them: links
// between notes ([[Note]], [[Note#Heading|shown words]]), embeds
// (![[chart.png|300]]), highlights (==words==), tags (#tag, #area/topic),
// comments (%%hidden%%), block ids (^abc123), callouts (> [!note] Title) and
// math ($x^2$, $$...$$).
//
// Corillo keeps all of them exactly as written: the reader below makes links,
// math and comments plain text (so nothing inside them is read as Markdown),
// and the writer (markdown-inline.ts and markdown-blocks.ts) never puts a backslash into them. The finders
// here are shared by the reader, the writer, the editor's display and export,
// so all four agree on where each one starts and ends.
import type MarkdownIt from "markdown-it";

type StateInline = Parameters<MarkdownIt["inline"]["ruler"]["push"]>[1] extends (state: infer S, silent: boolean) => boolean
  ? S
  : never;
type StateBlock = Parameters<MarkdownIt["block"]["ruler"]["push"]>[1] extends (
  state: infer S,
  startLine: number,
  endLine: number,
  silent: boolean,
) => boolean
  ? S
  : never;

// Finding them in text -----------------------------------------------------------

/**
 * A link to a note or file, [[...]], or an embed, ![[...]], starting at i.
 * Returns where it ends, or -1. It stays on one line and holds no brackets.
 */
export function matchLink(s: string, i: number): number {
  let at = i;
  if (s[at] === "!") at++;
  if (s[at] !== "[" || s[at + 1] !== "[") return -1;
  const close = s.indexOf("]]", at + 2);
  if (close < 0) return -1;
  const inner = s.slice(at + 2, close);
  if (!inner.trim() || /[[\]\n]/.test(inner)) return -1;
  // "[[1]](https://...)" is an ordinary link whose words are "[1]", as AI tools write sources.
  if (s[close + 2] === "(") return -1;
  return close + 2;
}

/**
 * Math starting at i: $$...$$ or $...$, on one line. A single $ must have
 * something other than a space right after it, and its closing $ (the next
 * one) something other than a space right before it and no digit after, so
 * "$5 and $10" stays text. Math never runs into code or a link's address.
 */
export function matchMath(s: string, i: number): number {
  if (s[i] !== "$") return -1;
  const ok = (inner: string) => inner.trim() !== "" && !/[\n`]|\]\(/.test(inner);
  if (s[i + 1] === "$") {
    const close = s.indexOf("$$", i + 2);
    return close > i + 2 && ok(s.slice(i + 2, close)) ? close + 2 : -1;
  }
  const first = s[i + 1];
  if (first === undefined || /\s/.test(first)) return -1;
  let close = i + 1;
  do close = s.indexOf("$", close + 1);
  while (close > 0 && s[close - 1] === "\\");
  if (close < 0) return -1;
  if (/\s/.test(s[close - 1]) || /[0-9]/.test(s[close + 1] ?? "")) return -1;
  return ok(s.slice(i + 1, close)) ? close + 1 : -1;
}

/** A comment, %%...%%, starting at i; on one line unless lines is true. */
export function matchComment(s: string, i: number, lines = false): number {
  if (s[i] !== "%" || s[i + 1] !== "%") return -1;
  const close = s.indexOf("%%", i + 2);
  if (close <= i + 2) return -1;
  if (!lines && s.slice(i + 2, close).includes("\n")) return -1;
  return close + 2;
}

/** A highlight, ==...==, starting at i, on one line. */
export function matchHighlight(s: string, i: number): number {
  if (s[i] !== "=" || s[i + 1] !== "=" || s[i - 1] === "=") return -1;
  const first = s[i + 2];
  if (first === undefined || /[\s=]/.test(first)) return -1;
  for (let close = s.indexOf("==", i + 3); close > 0; close = s.indexOf("==", close + 1)) {
    if (s.slice(i + 2, close).includes("\n")) return -1;
    if (/\s/.test(s[close - 1]) || s[close + 2] === "=") continue;
    return close + 2;
  }
  return -1;
}

// Tags: letters, numbers, _ - / and other symbols such as emoji, with at least
// one character that isn't a number (#1984 isn't a tag).
const TAG = /^#((?:[\p{L}\p{N}\p{M}_\-/]|\p{Extended_Pictographic}|\u200D|\uFE0F)+)/u;

/** A tag starting at i (after a space or at the start of a line), or -1. */
export function matchTag(s: string, i: number): number {
  if (s[i] !== "#" || (i > 0 && !/\s/.test(s[i - 1]))) return -1;
  const m = TAG.exec(s.slice(i, i + 200));
  if (!m || !/[^\p{N}]/u.test(m[1])) return -1;
  return i + m[0].length;
}

/** A block id, " ^abc-123", at the end of a line. */
const BLOCK_ID = /(^|[ \t])(\^[A-Za-z0-9-]+)[ \t]*(?=\n|$)/g;

// Links ------------------------------------------------------------------------------

export interface Link {
  embed: boolean;
  /** The note or file, as written ("Projects/Plan", "chart.png"). */
  path: string;
  /** What follows a #: a heading ("Goals"), headings ("Goals#Q3") or a block ("^abc123"). */
  subpath: string;
  /** The words shown instead of the target, after a |. */
  alias: string | null;
  /** A picture's size, after a | in an embed: 300 or 640x480. */
  size: { width: number; height?: number } | null;
  /** Where the shown words start and end, within the link's own text. */
  shown: [number, number];
}

const PICTURE = /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i;

export const isPicture = (path: string) => PICTURE.test(path);

/** Take a link's text apart: "![[Plan.md#Goals|the goals]]". */
export function parseLink(raw: string): Link {
  const embed = raw.startsWith("!");
  const open = embed ? 3 : 2;
  const inner = raw.slice(open, raw.length - 2);
  // A | (written \| inside a table) separates the target from the words shown.
  const bar = inner.indexOf("|");
  const targetEnd = bar < 0 ? inner.length : inner[bar - 1] === "\\" ? bar - 1 : bar;
  const target = inner.slice(0, targetEnd);
  let alias = bar < 0 ? null : inner.slice(bar + 1);
  const hash = target.indexOf("#");
  const path = (hash < 0 ? target : target.slice(0, hash)).trim();
  const subpath = hash < 0 ? "" : target.slice(hash + 1).trim();
  let size: Link["size"] = null;
  const m = alias === null ? null : /^\s*(\d+)(?:x(\d+))?\s*$/.exec(alias);
  if (embed && m && isPicture(path)) {
    size = { width: Number(m[1]), ...(m[2] ? { height: Number(m[2]) } : {}) };
    alias = null;
  }
  const shown: [number, number] =
    alias !== null && alias.trim() ? [open + bar + 1, raw.length - 2] : [open, open + targetEnd];
  return { embed, path, subpath, alias: alias !== null && alias.trim() ? alias.trim() : null, size, shown };
}

/** The words a link shows: its own words, or the note's name and the heading it points to. */
export function linkText(link: Link): string {
  if (link.alias) return link.alias;
  const name = link.path.replace(/\.md$/i, "");
  const headings = link.subpath
    .split("#")
    .map((h) => h.trim())
    .filter((h) => h && !h.startsWith("^"));
  return [name.split("/").pop() || name, ...headings].filter(Boolean).join(" > ") || link.path || link.subpath;
}

// Callouts -------------------------------------------------------------------------

export interface Callout {
  /** The type as written, in lower case: "note", "tip", "faq". */
  type: string;
  /** "+" (open) or "-" (folded) for a foldable callout, otherwise "". */
  fold: string;
  /** The title as written, or "" for none. */
  title: string;
  /** The title shown: the one written, or the type in title case ("Note"). */
  shownTitle: string;
  /** Where "[!type]" and the spaces after it end, on the first line. */
  markerEnd: number;
}

const CALLOUT = /^\[!([\p{L}\p{N}_-]+)\]([+-]?)([ \t]*)(.*)$/u;

/** The callout a quote's first line makes, if it starts with [!type]. */
export function calloutOf(firstLine: string): Callout | null {
  const m = CALLOUT.exec(firstLine);
  if (!m) return null;
  const type = m[1].toLowerCase();
  const title = m[4].trim();
  return {
    type,
    fold: m[2],
    title,
    shownTitle: title || type.charAt(0).toUpperCase() + type.slice(1),
    markerEnd: 2 + m[1].length + 1 + m[2].length + m[3].length,
  };
}

/** How long "[!type]" plus a fold sign is at the start of this text, or 0. */
export function calloutMarkerLength(text: string): number {
  const m = MARKER.exec(text);
  // "[!note](x)", "[!note][x]" and "[!note]: x" would read as a link, so
  // those brackets are escaped like any others.
  if (!m || (!m[1] && /[([:]/.test(text[m[0].length] ?? ""))) return 0;
  return m[0].length;
}

const MARKER = /^\[![\p{L}\p{N}_-]+\]([+-]?)/u;

// Obsidian's types and their other names, grouped by the colour Corillo gives them.
const CALLOUT_COLOURS: Record<string, string[]> = {
  sky: ["note", "info", "todo", "abstract", "summary", "tldr"],
  mint: ["tip", "hint", "important", "success", "check", "done"],
  ochre: ["question", "help", "faq", "warning", "caution", "attention"],
  rose: ["failure", "fail", "missing", "danger", "error", "bug"],
  lilac: ["example"],
  stone: ["quote", "cite"],
};

/** The colour a callout type gets; a type Obsidian doesn't know looks like a note, as there. */
export function calloutColour(type: string): string {
  const t = type.toLowerCase();
  for (const [colour, types] of Object.entries(CALLOUT_COLOURS)) if (types.includes(t)) return colour;
  return "sky";
}

// Everything in a line of text, for showing it ------------------------------------------

export type Kind = "link" | "embed" | "highlight" | "tag" | "comment" | "blockid" | "math";

export interface Found {
  kind: Kind;
  from: number;
  to: number;
  /** For links and embeds. */
  link?: Link;
}

/**
 * Obsidian's marks in a paragraph's text, in order, for showing them. Text
 * that is code (or a picture, or a footnote marker) should be replaced by
 * U+FFFC first, so nothing is found in it.
 */
export function findObsidian(text: string): Found[] {
  const found: Found[] = [];
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    let end = -1;
    let kind: Kind | null = null;
    if (c === "[" || c === "!") {
      end = matchLink(text, i);
      kind = c === "!" ? "embed" : "link";
    } else if (c === "$") {
      end = matchMath(text, i);
      kind = "math";
    } else if (c === "%") {
      end = matchComment(text, i, true);
      kind = "comment";
    } else if (c === "=") {
      end = matchHighlight(text, i);
      kind = "highlight";
    } else if (c === "#") {
      end = matchTag(text, i);
      kind = "tag";
    }
    if (end < 0 || !kind) {
      i++;
      continue;
    }
    const item: Found = { kind, from: i, to: end };
    if (kind === "link" || kind === "embed") item.link = parseLink(text.slice(i, end));
    found.push(item);
    // A highlight's words can hold links, tags and the rest, so keep looking inside it.
    i = kind === "highlight" ? i + 2 : end;
  }
  for (const m of text.matchAll(BLOCK_ID)) {
    const from = m.index + m[1].length;
    if (!found.some((f) => f.from <= from && f.to > from)) found.push({ kind: "blockid", from, to: from + m[2].length });
  }
  return found.sort((a, b) => a.from - b.from);
}

// What the writer keeps as written ------------------------------------------------------

export interface Kept {
  from: number;
  to: number;
}

/**
 * Where text must be written exactly as it is (links, embeds, math, comments,
 * a callout's [!type]) as Markdown reads it from left to right. single(from,
 * to) says whether a stretch is one piece of plain text in the editor (not
 * split by formatting): only then is it kept as written. Otherwise its first
 * character (a $ or %) is listed in escape, so it isn't read as one on the
 * way back either.
 */
export function keptRanges(
  text: string,
  single: (from: number, to: number) => boolean,
  callout: boolean,
): { kept: Kept[]; escape: number[] } {
  const kept: Kept[] = [];
  const escape: number[] = [];
  if (callout) {
    const n = calloutMarkerLength(text);
    if (n && single(0, n)) kept.push({ from: 0, to: n });
  }
  for (let i = kept.length ? kept[0].to : 0; i < text.length; ) {
    const c = text[i];
    const end =
      c === "[" || c === "!" ? matchLink(text, i) : c === "$" ? matchMath(text, i) : c === "%" ? matchComment(text, i) : -1;
    if (end < 0) {
      i++;
      continue;
    }
    if (single(i, end)) {
      kept.push({ from: i, to: end });
      i = end;
    } else {
      if (c === "$" || c === "%") escape.push(i);
      i++;
    }
  }
  return { kept, escape };
}

// Reading -------------------------------------------------------------------------

function inlineRule(match: (s: string, i: number) => number) {
  return (state: StateInline, silent: boolean): boolean => {
    const end = match(state.src, state.pos);
    if (end < 0 || end > state.posMax) return false;
    if (!silent) state.push("text", "", 0).content = state.src.slice(state.pos, end);
    state.pos = end;
    return true;
  };
}

/**
 * Lines fenced by a marker at the start of a line: a %% comment over several
 * lines, or $$ math. The block ends at the first line after it holding the
 * marker again; with no such line, it isn't one. Math stops at a blank line.
 */
function fencedRule(marker: string, type: string, blankEnds: boolean) {
  return (state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const first = state.src.slice(start, state.eMarks[startLine]);
    if (!first.startsWith(marker) || first.indexOf(marker, marker.length) >= 0) return false;
    let line = startLine + 1;
    for (; line < endLine; line++) {
      const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
      if (state.sCount[line] < state.blkIndent && text) return false; // the quote or list ended first
      if (blankEnds && !text.trim()) return false;
      if (text.includes(marker)) break;
    }
    if (line >= endLine) return false;
    if (silent) return true;
    const token = state.push(type, "", 0);
    token.block = true;
    token.map = [startLine, line + 1];
    token.content = state.getLines(startLine, line + 1, state.blkIndent, false);
    state.line = line + 1;
    return true;
  };
}

/** Teach markdown-it Obsidian's links, math and comments, as plain text it doesn't look inside. */
export function obsidianSyntax(md: MarkdownIt): void {
  md.inline.ruler.before("link", "obsidian_link", inlineRule(matchLink));
  md.inline.ruler.before("link", "obsidian_math", inlineRule(matchMath));
  md.inline.ruler.before("link", "obsidian_comment", inlineRule(matchComment));
  md.block.ruler.before("table", "obsidian_comment_block", fencedRule("%%", "obsidian_comment", false));
  md.block.ruler.before("table", "obsidian_math_block", fencedRule("$$", "math_block", true));
}
