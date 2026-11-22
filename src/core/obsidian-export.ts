// Obsidian's syntax on its way to Word or PDF. A shared document should read
// the way Obsidian and Corillo show it, not as the marks behind it: a link
// becomes the words it shows, a comment is left out (it's a note to self), a
// block id goes, an embedded picture becomes a picture, and a note written
// in the text (^[like this]) becomes an ordinary footnote. For Word, a
// callout becomes a quote with its title in bold, marked for Corillo's Lua
// filter to make it the same coloured box as on the page, and a highlight
// becomes Word's own highlight; the PDF page draws those two itself, as the
// editor does.
//
// The change is made to the Markdown text, line by line, only where Corillo
// reads text: never inside code, and never in the document itself.
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import { calloutColour, calloutOf, findObsidian, isPicture, linkText, parseLink, obsidianSyntax, type Link } from "./obsidian";
import { PICTURE_STAND_IN } from "./doc-diff";

/** Markdown read as the page reads it (its notes, and Obsidian's links, math and comments): shared by every step of an export. */
export const exportReader = new MarkdownIt("default", { html: true, linkify: false, typographer: false })
  .use(footnote as unknown as (md: MarkdownIt) => void)
  .use(obsidianSyntax);
const md = exportReader;

export interface ExportChoices {
  /** Word: callouts become quotes with a bold title, marked for their colour, and highlights become <mark> (see wordFilter in export-prep.ts). */
  word: boolean;
  /** Where an embedded picture is, as an address from the document's folder; null when it can't be found. */
  picture(name: string): string | null;
}

interface Rewrite {
  from: number;
  to: number;
  text: string;
}

/** Any ASCII punctuation gets a backslash, so a link's words stay plain words. */
export const plainWords = (s: string) => s.replace(/[!-/:-@[-`{-~]/g, "\\$&");

// Pandoc is told not to read math (so its dollar signs stay), which would
// leave what's between them to be read as Markdown: stars as emphasis, a
// backslash taken off, a line that starts with "+" made a bullet. With a
// backslash before each mark, Word gets the characters the page shows.
const mathForWord = plainWords;

/**
 * The line's text with code spans and backslash-escaped characters hidden,
 * so nothing in them is taken for Obsidian's syntax. Same length as the line.
 */
function maskCode(s: string): string {
  const out = s.split("");
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length && /[!-/:-@[-`{-~]/.test(s[i + 1])) {
      out[i + 1] = PICTURE_STAND_IN;
      i++;
      continue;
    }
    if (s[i] !== "`") continue;
    let n = 1;
    while (s[i + n] === "`") n++;
    let close = -1;
    for (let j = s.indexOf("`".repeat(n), i + n); j >= 0; j = s.indexOf("`".repeat(n), j + 1)) {
      let m = n;
      while (s[j + m] === "`") m++;
      if (m === n && s[j - 1] !== "`") {
        close = j;
        break;
      }
      j += m - 1;
    }
    if (close < 0) {
      i += n - 1;
      continue;
    }
    for (let k = i; k < close + n; k++) if (s[k] !== "\n") out[k] = PICTURE_STAND_IN;
    i = close + n - 1;
  }
  return out.join("");
}

function pictureMarkdown(link: Link, choices: ExportChoices): string {
  const alt = plainWords(link.alias ?? link.path.split("/").pop()!.replace(/\.[^.]+$/, ""));
  const where = choices.picture(link.path) ?? link.path;
  // Both numbers when both are given, as the page sizes it (Batch 21, E21-8).
  const size = choices.word && link.size ? `{width=${link.size.width}px${link.size.height ? ` height=${link.size.height}px` : ""}}` : "";
  return `![${alt}](<${where.replace(/[<>]/g, (c) => encodeURIComponent(c))}>)${size}`;
}

/** The whole line goes when a comment or block id was all it held (besides quote marks). */
function wholeLine(text: string, from: number, to: number): [number, number] {
  const start = text.lastIndexOf("\n", from - 1) + 1;
  let end = text.indexOf("\n", to);
  if (end < 0) end = text.length;
  // With its line break, or, on the last line of a file with none, to the end.
  if (/^[ \t>]*$/.test(text.slice(start, from)) && /^[ \t]*$/.test(text.slice(to, end))) return [start, Math.min(end + 1, text.length)];
  return [from, to];
}

/**
 * Lines left out from `from` to `to`, with a blank line before them (or the
 * start of the file) and one after: that one goes too, so the space left is
 * the one blank line the page shows there, not two.
 */
function withBlankAfter(text: string, from: number, to: number): number {
  const wholeLines = (from === 0 || text[from - 1] === "\n") && to > from && text[to - 1] === "\n";
  if (!wholeLines) return to;
  const before = from === 0 ? "" : text.slice(text.lastIndexOf("\n", from - 2) + 1, from - 1);
  const end = text.indexOf("\n", to);
  if (end < 0 || !/^[ \t>]*$/.test(before) || !/^[ \t>]*$/.test(text.slice(to, end))) return to;
  return end + 1;
}

/**
 * Where each note written in the text (^[like this]) is in this stretch of
 * text with its code hidden: from the ^ to just after the closing bracket.
 */
function inlineNotes(masked: string): { from: number; to: number }[] {
  const found: { from: number; to: number }[] = [];
  for (let i = masked.indexOf("^["); i >= 0; i = masked.indexOf("^[", i + 1)) {
    let depth = 0;
    for (let j = i + 1; j < masked.length; j++) {
      if (masked[j] === "[") depth++;
      else if (masked[j] === "]" && --depth === 0) {
        found.push({ from: i, to: j + 1 });
        i = j;
        break;
      }
    }
  }
  return found;
}

// Pandoc reads {#id}, {.class} and {key=value} as hidden settings, and a line
// of ::: as a box around what follows; the page shows them as written. So,
// for Word, they get a backslash and stay words. A size right after a picture
// (![chart](chart.png){width=50%}) is the exception: Word uses it.
const ATTRIBUTES = /^\{[ \t]*(?:(?:#[^\s{}]+|\.[^\s{}]+|[A-Za-z_][\w.:-]*=(?:"[^"\n]*"|'[^'\n]*'|[^\s{}"']+)|-|=[A-Za-z]\w*)[ \t]*)+\}/;
const FENCE_LINE = /(^|\n)([ \t>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?)(?=:::)/g;

/** Whether the ")" just before `at` closes a picture's ![...](...). */
function afterPicture(s: string, at: number): boolean {
  if (s[at - 1] !== ")") return false;
  let j = at - 2;
  for (let depth = 1; j >= 0 && depth > 0; j--) {
    if (s[j] === ")") depth++;
    else if (s[j] === "(") depth--;
  }
  if (s[j] !== "]") return false;
  for (let depth = 1, k = j - 1; k >= 0; k--) {
    if (s[k] === "]") depth++;
    else if (s[k] === "[" && --depth === 0) return s[k - 1] === "!";
  }
  return false;
}

/**
 * Where a backslash keeps Pandoc from taking these words (with code hidden)
 * for its settings: before each brace that would hide them, and each line
 * that starts with :::. Not inside HTML tags or <addresses>.
 */
function pandocMarks(masked: string, skip: (at: number) => boolean = () => false): number[] {
  const tags = new Set<number>();
  for (const m of masked.matchAll(/<[^<>\n]*>/g)) for (let k = m.index; k < m.index + m[0].length; k++) tags.add(k);
  const at: number[] = [];
  for (let i = masked.indexOf("{"); i >= 0; i = masked.indexOf("{", i + 1)) {
    if (tags.has(i) || skip(i) || afterPicture(masked, i) || !ATTRIBUTES.test(masked.slice(i))) continue;
    at.push(i);
  }
  for (const m of masked.matchAll(FENCE_LINE)) {
    const i = m.index + m[1].length + m[2].length;
    if (!skip(i)) at.push(i);
  }
  return at;
}

/** Words for Word, with Pandoc's settings syntax kept as words (see pandocMarks). */
const asWords = (s: string) => {
  const at = new Set(pandocMarks(maskCode(s)));
  return s
    .split("")
    .map((c, i) => (at.has(i) ? `\\${c}` : c))
    .join("");
};

/**
 * Callouts get their colour in Word from Corillo's Lua filter, which looks
 * for this hidden note after the title (see wordFilter in export-prep.ts). Word never shows it.
 */
const calloutMark = (type: string) => `<!--corillo callout ${calloutColour(type)}-->`;

/**
 * The document's Markdown, ready for Word (word: true) or the PDF page. Notes
 * written in the text (^[like this], as Obsidian allows) become ordinary
 * footnotes for both, since Pandoc and the page number only those.
 */
export function obsidianForExport(markdown: string, choices: ExportChoices): string {
  const text = markdown.replace(/\r\n?/g, "\n");
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const at = (line: number) => (line < lineStarts.length ? lineStarts[line] : text.length);
  const changes: Rewrite[] = [];
  const seen = new Set<string>();
  const tokens = md.parse(text, {});
  const notes: string[] = [];
  let row: [number, number] | null = null; // a table cell's words have no lines of their own: they're on its row's

  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.type === "tr_open") row = tok.map as [number, number] | null;
    // A math block, for Word: each mark on its lines gets a backslash (see mathForWord), not a quote's or a list's before them.
    if (choices.word && tok.type === "math_block" && tok.map) {
      // Each line from its first non-space: markdown-it turns a tab that a list's indent only partly uses into spaces.
      const own = tok.content.replace(/\n$/, "").split("\n").map((l) => l.trimStart());
      for (let line = tok.map[0], j = 0; line < tok.map[1] && j < own.length; line++, j++) {
        const end = Math.max(at(line), text[at(line + 1) - 1] === "\n" ? at(line + 1) - 1 : at(line + 1));
        const whole = text.slice(at(line), end);
        if (own[j] && whole.endsWith(own[j])) changes.push({ from: end - own[j].length, to: end, text: mathForWord(own[j]) });
      }
      continue;
    }
    if (tok.type === "obsidian_comment" && tok.map) {
      changes.push({ from: at(tok.map[0]), to: withBlankAfter(text, at(tok.map[0]), at(tok.map[1])), text: "" });
      continue;
    }
    // A callout, for Word: "> [!tip]- Title" becomes "> **Title**", on a line of its own.
    if (choices.word && tok.type === "blockquote_open" && tokens[t + 1]?.type === "paragraph_open") {
      const inline = tokens[t + 2];
      const callout = inline?.map ? calloutOf(inline.content.split("\n")[0]) : null;
      if (callout && inline.map) {
        const lineStart = at(inline.map[0]);
        const lineEnd = text.indexOf("\n", lineStart) < 0 ? text.length : text.indexOf("\n", lineStart);
        const marker = text.indexOf("[!", lineStart);
        const prefix = text.slice(lineStart, marker);
        const rest = prefix.replace(/(\d{1,9}[.)]|[-+*])(?=\s)/g, (m) => " ".repeat(m.length)).trimEnd();
        // Anything after the title line: more lines, or more blocks before the quote ends.
        const body = inline.map[1] - inline.map[0] > 1 || tokens[t + 4]?.type !== "blockquote_close";
        const mark = calloutMark(callout.type);
        if (callout.title) {
          let titleEnd = lineEnd;
          while (titleEnd > marker && /[ \t]/.test(text[titleEnd - 1])) titleEnd--;
          changes.push({ from: marker, to: marker + callout.markerEnd, text: "**" });
          changes.push({ from: titleEnd, to: lineEnd, text: `**${mark}${body ? `\n${rest}` : ""}` });
        } else {
          changes.push({ from: marker, to: lineEnd, text: `**${plainWords(callout.shownTitle)}**${mark}${body ? `\n${rest}` : ""}` });
        }
      }
    }
    const map = tok.type === "inline" ? (tok.map ?? row) : null;
    if (!map) continue;
    const key = map.join("-");
    if (seen.has(key)) continue; // a table row's cells share their line
    seen.add(key);
    const from = at(map[0]);
    // Up to the block's last line break; the last line of a file may have none.
    const next = at(map[1]);
    const to = Math.max(from, text[next - 1] === "\n" ? next - 1 : next);
    const lines = text.slice(from, to);
    const masked = maskCode(lines);
    if (tok.children?.some((c) => c.type === "footnote_ref" && !c.meta?.label) || !tok.map) {
      for (const note of inlineNotes(masked)) {
        const words = text.slice(from + note.from + 2, from + note.to - 1).replace(/[ \t]*\n[ \t>]*/g, " ").trim();
        notes.push(choices.word ? asWords(words) : words);
        changes.push({ from: from + note.from, to: from + note.to, text: `[^corillo-note-${notes.length}]` });
      }
    }
    if (choices.word) for (const i of pandocMarks(masked)) changes.push({ from: from + i, to: from + i, text: "\\" });
    for (const found of findObsidian(masked)) {
      const start = from + found.from;
      const end = from + found.to;
      // Found in the masked text, read from the text itself: in a table, \| separates the shown words.
      const f = found.link ? { ...found, link: parseLink(text.slice(start, end)) } : found;
      if (f.kind === "comment" || f.kind === "blockid") {
        const [a, b] = wholeLine(text, f.kind === "blockid" && /[ \t]/.test(text[start - 1] ?? "") ? start - 1 : start, end);
        changes.push({ from: a, to: withBlankAfter(text, a, b), text: "" });
      } else if (f.kind === "link" && f.link) {
        changes.push({ from: start, to: end, text: plainWords(linkText(f.link)) });
      } else if (f.kind === "embed" && f.link) {
        changes.push({ from: start, to: end, text: isPicture(f.link.path) ? pictureMarkdown(f.link, choices) : plainWords(linkText(f.link)) });
      } else if (f.kind === "math" && choices.word) {
        changes.push({ from: start, to: end, text: mathForWord(text.slice(start, end)) });
      } else if (f.kind === "highlight" && choices.word) {
        changes.push({ from: start, to: start + 2, text: "<mark>" });
        changes.push({ from: end - 2, to: end, text: "</mark>" });
      }
    }
  }

  // Apply from the end, skipping any that overlap one already made (a link inside a comment, say),
  // and any backslash inside words another change replaces (a comment, a link, a note moved to the end).
  const replaced = changes.filter((c) => c.to > c.from);
  const kept = changes.filter((c) => c.to > c.from || !replaced.some((r) => r.from <= c.from && c.from < r.to));
  kept.sort((a, b) => b.from - a.from || b.to - a.to);
  let out = text;
  let limit = Infinity;
  for (const c of kept) {
    if (c.to > limit) continue;
    out = out.slice(0, c.from) + c.text + out.slice(c.to);
    limit = c.from;
  }
  // The notes written in the text, as ordinary footnotes at the end.
  if (notes.length) out = out.replace(/\n*$/, "\n\n") + notes.map((words, i) => `[^corillo-note-${i + 1}]: ${words}\n`).join("\n");
  return out;
}

/** The pictures the document embeds (![[chart.png]]), by the names written, for finding them first. */
export function picturesEmbedded(markdown: string): string[] {
  const names: string[] = [];
  obsidianForExport(markdown, {
    word: false,
    picture: (name) => {
      names.push(name);
      return null;
    },
  });
  return names;
}

