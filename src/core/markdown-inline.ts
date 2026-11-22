// Writing a paragraph's text and formatting so it reads back as the same: escapes, signs, line breaks.
import { MarkdownSerializer, MarkdownSerializerState } from "prosemirror-markdown";
import { Fragment, Mark, type Node } from "prosemirror-model";
import { schema } from "./schema";
import { keptRanges, matchComment, matchMath, type Kept } from "./obsidian";
import { PICTURE_STAND_IN } from "./doc-diff";

// Escaping text so it reads back as the same text. prosemirror-markdown's own
// escaping missed cases that changed what the person typed, so Corillo does
// its own:
// - Characters that mark up text anywhere. An underscore inside a word (as in
//   snake_case) is left alone; one next to another underscore is not ("__x__"
//   came back as italics).
const MARKUP = /[`*\\~[\]_]/g;
// (Between two letters or digits, in any alphabet, an underscore never marks
// up text, so "#café_noir" keeps its underscore as written.)
const WORD_CHAR = /[\p{L}\p{N}]/u;
// - Text at the start of a line that would turn into a list, rule, heading,
//   quote, heading underline or table, also on the line after a line break.
const LINE_START: [RegExp, string][] = [
  [/^-/, "\\-"],
  [/^\+(?=\s|$)/, "\\+"],
  [/^(\d{1,9})([.)])(?=\s|$)/, "$1\\$2"],
  [/^(#{1,6})(?=\s|$)/, "\\$1"],
  [/^>/, "\\>"],
  [/^(=+\s*)$/, "\\$1"],
  [/^\|/, "\\|"],
  // ":--" under a line with a pipe would make a table; "$$" or "%%" with the
  // same on a later line, maths or a hidden comment.
  [/^:(?=-)/, "\\:"],
  [/^([$%])(?=\1)/, "\\$1"],
];
// - "<" before a letter would turn into HTML, and "&copy;" into a symbol;
//   "<" before an email address and ">" ("<1@a>") into a link.
const EXTRA = /<(?=[A-Za-z/!?]|[\w.!#$%&'*+/=?^`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>)|&(?=#?[A-Za-z0-9]+;)/g;
// What may come before text on a line that is still the line's start: quote
// and list markers. (A heading's text is past its hashes: "## 1. Introduction"
// needs no backslash.)
const LINE_PREFIX = /(?:^|\n)(?:[ \t>]|[-+*][ \t]|\d{1,9}[.)][ \t])*$/;

type StateClass = new (nodes: unknown, marks: unknown, options: unknown) => MarkdownSerializerState;
const TAIL = 256;

/** Extra options while writing: inside a table cell, and how that table writes line breaks. */
interface SerializeOptions {
  inCell?: boolean;
  br?: string;
  /** Pipes in code are marked (see writeCell in markdown-blocks.ts). */
  codePipes?: boolean;
}
const optionsOf = (state: MarkdownSerializerState) => (state as unknown as { options: SerializeOptions }).options;
/**
 * Formatting written as HTML (<b>, <i>, <s>) is kept that way where Corillo
 * reads it (see readInlineHtml in markdown-read.ts); elsewhere (a picture's words, say) it is
 * written as Markdown, which reads back the same.
 */
const htmlMarkup = (state: MarkdownSerializerState, markup: string | null | undefined, parent?: Node) =>
  !!markup && markup.startsWith("<") && htmlReadable(state, parent);
const closingTag = (markup: string) => markup.replace(/^<([a-z]+).*$/is, "</$1>");

class FaithfulState extends (MarkdownSerializerState as unknown as StateClass) {
  // The library builds its output by adding to `out` and looking at its last
  // character, and on a long text each look made the engine copy all of it:
  // writing a long list took minutes. Here `out` holds only the last few
  // hundred characters (the library never looks further back); the rest is
  // kept in pieces and joined once at the end.
  private written: string[] = [];
  private writtenLength = 0;
  private tail = "";
  /** Where the last bold, italic or strikethrough sign written closed, and which sign it was. */
  closedSign = { at: -1, sign: "" };
  /** The sign each open bold, italic or strikethrough mark was written with. */
  openSigns: Record<string, string> = {};
  /** The link being written is an autolink, `<address>` (the link's writer says, as the library's own does). */
  declare inAutolink: boolean | undefined;
  /** Where the words of the link being written start: just after its bracket. */
  declare linkFrom: number | undefined;

  get out(): string {
    return this.tail;
  }

  set out(value: string) {
    this.tail = value;
    if (value.length > 2 * TAIL) {
      const piece = value.slice(0, value.length - TAIL);
      this.written.push(piece);
      this.writtenLength += piece.length;
      this.tail = value.slice(value.length - TAIL);
    }
  }

  /** How much has been written. */
  get size(): number {
    return this.writtenLength + this.tail.length;
  }

  result(): string {
    return this.written.join("") + this.tail;
  }

  /** What has been written since a point: only the pieces after it are joined (a link's words are short). */
  since(at: number): string {
    if (at >= this.writtenLength) return this.tail.slice(at - this.writtenLength);
    let i = this.written.length;
    let from = this.writtenLength;
    while (i > 0 && from > at) from -= this.written[--i].length;
    return (this.written.slice(i).join("") + this.tail).slice(at - from);
  }

  /** A heading's words, written from `from`, that end in hashes ("Issue #") would read as its closing marks: the last is escaped. */
  escapeClosingHashes(from: number): void {
    if (/[ \t]#+[ \t]*$/.test(this.since(from))) this.out = this.out.replace(/#([ \t]*)$/, "\\#$1");
  }

  /** Write a paragraph's text and formatting, in the order writtenOrder works out. */
  renderInline(parent: Node, fromBlockStart = true): void {
    const self = this as unknown as MarkdownSerializerState & { atBlockStart: boolean };
    self.atBlockStart = fromBlockStart;
    for (const step of writtenOrder(parent)) {
      if (step.t === "open" || step.t === "close") {
        self.text(self.markString(step.mark, step.t === "open", parent, step.at), false);
        // A link's words start after its bracket, once the block above is ended and the line begun.
        if (step.t === "open" && step.mark.type.name === "link") this.linkFrom = this.size;
        if (step.t === "open") self.atBlockStart = false;
        continue;
      }
      if (step.t === "space") {
        self.text(step.text);
        continue;
      }
      const node = parent.child(step.at);
      if (step.t === "text" && step.code) {
        const code = node.marks[node.marks.length - 1];
        // (In a table cell, each pipe in code is marked, for writeCell, in markdown-blocks.ts, to escape.)
        const text = optionsOf(self).codePipes ? step.text.replace(/\|/g, CODE_PIPE) : step.text;
        self.text(self.markString(code, true, parent, step.at) + text + self.markString(code, false, parent, step.at + 1), false);
      } else self.render(step.t === "text" && step.text !== node.text ? schema.text(step.text, node.marks) : node, parent, step.at);
      self.atBlockStart = false;
    }
    self.atBlockStart = false;
  }

  /** Whether the output is at the start of a line (after any quote or list markers). */
  atLineStart(): boolean {
    return LINE_PREFIX.test(this.tail) && (this.written.length === 0 || this.tail.includes("\n"));
  }

  esc(str: string, startOfLine = false): string {
    const lineStart = this.atLineStart();
    // Spaces or a tab at the start of a line would make it a code block, and
    // Markdown drops them anyway.
    if (lineStart) str = str.replace(/^[ \t]+/, "");
    let out = str.replace(MARKUP, (m, i: number) =>
      m === "_" && i > 0 && i + 1 < str.length && WORD_CHAR.test(str[i - 1]) && WORD_CHAR.test(str[i + 1])
        ? m
        : "\\" + m,
    );
    // A table cell is never at the start of a line ("- item" in a cell isn't a list).
    const inCell = !!(this as unknown as { options: SerializeOptions }).options.inCell;
    if ((lineStart || startOfLine) && !inCell) for (const [re, to] of LINE_START) out = out.replace(re, to);
    return out.replace(EXTRA, "\\$&");
  }
}

// Bold, italic and strikethrough marks only count when they sit against the
// right kinds of characters (CommonMark's "flanking" rule): "Acme**(firm)**"
// isn't bold, nor is "_cat_s" italic. Where Markdown's marks wouldn't read
// back, Corillo writes "*" for "_" or, failing that, the HTML form
// (<strong>, <em>, <s>), which it reads back as the same formatting and Word
// export turns into Word's own.
type Kind = "space" | "punct" | "other";
const SPACE = /^[\t\n\v\f\r \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]?$/;
const PUNCT = /[\p{P}\p{S}]/u;
const kindOf = (ch: string): Kind => (SPACE.test(ch) ? "space" : PUNCT.test(ch) ? "punct" : "other");
/** A character as it will be written: stand-ins for what they stand for. */
const shown = (ch: string) => (ch === LINE ? "\n" : ch === "\uE001" ? "\u2028" : ch === "\uE002" ? "\u2029" : ch);
const firstChar = (text: string) => shown(String.fromCodePoint(text.codePointAt(0) ?? 32));
const lastChar = (text: string) => shown(Array.from(text.slice(-2)).pop() ?? " ");
// What a picture, a note marker or a line break starts and ends with.
const LEAF_KIND: Kind = "punct";

/**
 * One step of writing a paragraph's text, in the order prosemirror-markdown
 * takes them: a mark's sign opening or closing, a node's text (after the
 * spaces it moves outside bold or italic), those spaces, or a picture, note
 * marker or line break.
 */
type Step =
  | { t: "open"; mark: Mark; at: number }
  | { t: "close"; mark: Mark; at: number }
  | { t: "text"; at: number; from: number; text: string; code: boolean }
  | { t: "space"; text: string }
  | { t: "leaf"; at: number };

const orders = new WeakMap<Node, Step[]>();

/**
 * The order a paragraph's signs and text are written in: prosemirror-markdown's
 * own (its renderInline, step for step, with one fix), worked out before
 * writing, so each sign can be chosen from what will really be next to it and
 * FaithfulState.renderInline writes exactly this. It follows the library, not
 * the document: a mark stays open over spaces that lack it ("Acme" and
 * "Corp." italic, all three bold, is one italic run), a mark opened outside
 * another that ends first is closed and opened again, and code is written
 * innermost, in backticks of its own for each piece of text.
 */
function writtenOrder(parent: Node): Step[] {
  const known = orders.get(parent);
  if (known) return known;
  const steps: Step[] = [];
  let active: Mark[] = [];
  let trailing = "";
  const mixable = (m: Mark) => m.type.name !== "code";
  // (As the library's isMarkAhead: a line break, and the node after it, are skipped.)
  const ahead = (index: number, marks: readonly Mark[]) => {
    for (; index < parent.childCount; index += 2) {
      const next = parent.child(index);
      if (next.type.name !== "hard_break") return next.marks.length >= marks.length && Mark.sameSet(next.marks.slice(0, marks.length), marks);
    }
    return false;
  };
  const progress = (node: Node | null, index: number) => {
    let marks: readonly Mark[] = node ? node.marks : [];
    if (node?.type.name === "hard_break") {
      marks = marks.filter((m) => {
        const next = parent.maybeChild(index + 1);
        return !!next && m.isInSet(next.marks) && (!next.isText || /\S/.test(next.text!));
      });
    }
    const inner = marks.length ? marks[marks.length - 1] : null;
    const code = inner?.type.name === "code";
    const len = marks.length - (code ? 1 : 0);
    outer: for (let i = 0; i < len; i++) {
      const mark = marks[i];
      if (!mixable(mark)) break;
      for (let j = 0; j < active.length; j++) {
        if (!mixable(active[j])) break;
        if (mark.eq(active[j])) {
          if (i > j) marks = marks.slice(0, j).concat(mark).concat(marks.slice(j, i)).concat(marks.slice(i + 1, len));
          // (The library takes marks.slice(i + 1, j), which past the node's
          // own marks takes in its code: then the code's backticks were
          // written as formatting and the bold lost. Only the node's own.)
          else if (j > i) marks = marks.slice(0, i).concat(marks.slice(i + 1, Math.min(j, len))).concat(mark).concat(marks.slice(j, len));
          continue outer;
        }
      }
    }
    let keep = 0;
    while (keep < Math.min(active.length, len) && marks[keep].eq(active[keep])) ++keep;
    const leading = trailing;
    let lead = "";
    trailing = "";
    let text = node?.isText ? node.text! : "";
    let shown = node;
    if (node?.isText && marks.some((m) => EXPELS.has(m.type.name) && !active.some((a, i) => i < keep && a.eq(m)))) {
      const [, before, rest] = /^(\s*)([\s\S]*)$/.exec(text)!;
      if (before) {
        lead = before;
        text = rest;
        if (!rest) {
          shown = null;
          marks = active;
        }
      }
    }
    if (shown?.isText && marks.some((m, i) => EXPELS.has(m.type.name) && !ahead(index + 1, marks.slice(0, i + 1)))) {
      const [, rest, after] = /^([\s\S]*?)(\s*)$/.exec(text)!;
      if (after) {
        trailing = after;
        text = rest;
        if (!rest) {
          shown = null;
          marks = active;
        }
      }
    }
    if (shown || index === parent.childCount) while (keep < active.length) steps.push({ t: "close", mark: active.pop()!, at: index });
    if (leading + lead) steps.push({ t: "space", text: leading + lead });
    if (!shown) return;
    while (active.length < len) {
      const add = marks[active.length];
      active.push(add);
      steps.push({ t: "open", mark: add, at: index });
    }
    steps.push(shown.isText ? { t: "text", at: index, from: lead.length, text, code } : { t: "leaf", at: index });
  };
  parent.forEach((node, _, i) => progress(node, i));
  progress(null, parent.childCount);
  orders.set(parent, steps);
  return steps;
}

/** What a step starts or ends with, as written: every sign and backtick is punctuation. */
function stepKind(step: Step | undefined, side: "start" | "end"): Kind {
  if (!step) return "space"; // the paragraph's start or end
  if (step.t === "space") return "space";
  if (step.t === "text") return step.code ? "punct" : kindOf(side === "start" ? firstChar(step.text) : lastChar(step.text));
  return step.t === "leaf" ? LEAF_KIND : "punct";
}

/** Where in a paragraph's written order each child's marks open, by the child's index: looked up once per paragraph, not searched for each mark (row 65). */
const opensAt = new WeakMap<Step[], Map<number, number[]>>();

function openSteps(steps: Step[], index: number): number[] {
  let found = opensAt.get(steps);
  if (!found) {
    found = new Map();
    steps.forEach((s, i) => {
      if (s.t !== "open") return;
      const list = found!.get(s.at);
      if (list) list.push(i);
      else found!.set(s.at, [i]);
    });
    opensAt.set(steps, found);
  }
  return found.get(index) ?? [];
}

/** The characters just outside and just inside a mark's opening and closing signs, as they will be written. */
function surroundings(state: MarkdownSerializerState, mark: Mark, parent: Node, index: number) {
  const steps = writtenOrder(parent);
  const open = openSteps(steps, index).find((i) => (steps[i] as { mark: Mark }).mark.eq(mark)) ?? -1;
  let close = open + 1;
  while (close < steps.length && !(steps[close].t === "close" && (steps[close] as { mark: Mark }).mark.eq(mark))) close++;
  return {
    // (A block above still to be ended means the sign starts a new line.)
    beforeOpen: (state as unknown as { closed: Node | null }).closed ? "space" : kindOf(lastChar((state as unknown as FaithfulState).out || " ")),
    afterOpen: stepKind(steps[open + 1], "start"),
    beforeClose: stepKind(steps[close - 1], "end"),
    afterClose: stepKind(steps[close + 1], "start"),
  };
}
const EXPELS = new Set(["em", "strong", "strike"]);

/** Whether marks written with this sign ("*", "_" or "~") read back as formatting here. */
function flanks(sign: string, at: ReturnType<typeof surroundings>): boolean {
  const left = (before: Kind, after: Kind) => after !== "space" && (after !== "punct" || before !== "other");
  const right = (before: Kind, after: Kind) => before !== "space" && (before !== "punct" || after !== "other");
  const canOpen = left(at.beforeOpen, at.afterOpen) && (sign !== "_" || !right(at.beforeOpen, at.afterOpen) || at.beforeOpen === "punct");
  const canClose = right(at.beforeClose, at.afterClose) && (sign !== "_" || !left(at.beforeClose, at.afterClose) || at.afterClose === "punct");
  return canOpen && canClose;
}

/** Whether the opening signs could also close ("a**b" is both): then they'd close an outer mark written with the same sign. */
function closesAtOpen(sign: string, at: ReturnType<typeof surroundings>): boolean {
  const { beforeOpen: b, afterOpen: a } = at;
  const left = a !== "space" && (a !== "punct" || b !== "other");
  const right = b !== "space" && (b !== "punct" || a !== "other");
  return right && (sign !== "_" || !left || a === "punct");
}

/** Where Corillo reads HTML formatting back (see readInlineHtml in markdown-read.ts). */
const htmlReadable = (state: MarkdownSerializerState, parent?: Node) =>
  !!optionsOf(state).inCell || HTML_PARENTS.has(parent?.type.name ?? "");
const HTML_PARENTS = new Set(["paragraph", "heading", "footnote_def"]);

function emphasis(fallback: string, tag: string) {
  const chosen = (state: MarkdownSerializerState) =>
    ((state as unknown as { emphasis?: Record<string, string> }).emphasis ??= {});
  return {
    open(state: MarkdownSerializerState, mark: Mark, parent: Node, index: number): string {
      let markup: string = mark.attrs.markup || fallback;
      if (markup[0] === "<" && !htmlMarkup(state, markup, parent)) markup = fallback;
      const s = state as unknown as FaithfulState;
      if (markup[0] !== "<") {
        const at = surroundings(state, mark, parent, index);
        // Signs right after the same signs closing other formatting join
        // them into one run ("**a***b*"); signs that could close an outer
        // mark written with the same sign close it. Either way, the other
        // sign, or HTML.
        const outer = (sign: string) => Object.entries(s.openSigns).some(([name, open]) => name !== mark.type.name && open === sign);
        const joins = (sign: string) => !(s as unknown as { closed: Node | null }).closed && s.closedSign.sign === sign && s.closedSign.at === s.size;
        const fits = (sign: string) => flanks(sign, at) && !joins(sign) && !(outer(sign) && closesAtOpen(sign, at));
        const other = markup[0] === "~" ? "" : markup.replace(/[*_]/g, (c) => (c === "*" ? "_" : "*"));
        if (!fits(markup[0])) {
          if (other && fits(other[0])) markup = other;
          else if (htmlReadable(state, parent)) markup = `<${tag}>`;
          else if (markup[0] === "_") markup = other;
        }
      }
      if (markup[0] !== "<") s.openSigns[mark.type.name] = markup[0];
      chosen(state)[mark.type.name] = markup;
      return markup;
    },
    close(state: MarkdownSerializerState, mark: Mark): string {
      const markup = chosen(state)[mark.type.name] ?? fallback;
      const s = state as unknown as FaithfulState;
      delete s.openSigns[mark.type.name];
      if (markup[0] === "<") return closingTag(markup);
      s.closedSign = { at: s.size + markup.length, sign: markup[0] };
      return markup;
    },
    mixable: true,
    expelEnclosingWhitespace: true,
  };
}

class FaithfulSerializer extends MarkdownSerializer {
  serialize(content: Node, options: Record<string, unknown> = {}): string {
    const state = new FaithfulState(this.nodes, this.marks, { ...this.options, ...options });
    state.renderContent(withLineMarks(content));
    return state.result();
  }
}

// Line breaks inside a paragraph ----------------------------------------------------

// While writing, a line break inside a paragraph's text is this character
// instead of "\n": the library trims spaces around formatted words with
// patterns that stop at a "\n" and would drop the lines after it.
const LINE = "\uE000";
// The same patterns also stop at the Unicode line and paragraph separators
// (U+2028, U+2029, which some apps paste), so those have stand-ins too, and
// a real character from this private-use range is kept as an escape (ESC
// and a character of its own) while writing.
const ESC = "\uE004";
const SPECIAL = /[\n\r\u2028\u2029\uE000-\uE004]/;
const standIns = (text: string) =>
  text
    .replace(/[\uE000-\uE004]/g, (c) => ESC + String.fromCharCode(0xf8f0 + c.charCodeAt(0) - 0xe000))
    .replace(/\u2028/g, "\uE001")
    .replace(/\u2029/g, "\uE002");
/** Text as written: the stand-ins back to what they stand for. */
const restore = (text: string) =>
  text.replace(/\uE004([\uF8F0-\uF8F4])|[\uE000-\uE002]/g, (m, kept: string | undefined) =>
    kept ? String.fromCharCode(0xe000 + kept.charCodeAt(0) - 0xf8f0) : m === LINE ? "\n" : m === "\uE001" ? "\u2028" : "\u2029",
  );

/**
 * The block with each line break in its paragraphs' text marked for writing:
 * spaces around it go (Markdown drops them anyway, and two would make it a
 * different kind of break), so do empty lines (one would split the
 * paragraph) and line breaks at a paragraph's start or end. A heading has
 * one line, so its line breaks become spaces; so does code, which Markdown
 * reads on one line. A carriage return is a line break.
 */
function withLineMarks(node: Node): Node {
  if (node.isText || node.isLeaf || node.type.spec.code) return node;
  if (!node.isTextblock) {
    let changed = false;
    const kids: Node[] = [];
    node.forEach((child) => {
      const next = withLineMarks(child);
      if (next !== child) changed = true;
      kids.push(next);
    });
    return changed ? node.copy(Fragment.fromArray(kids)) : node;
  }
  let any = false;
  node.forEach((child, _, i) => {
    if (child.isText && (SPECIAL.test(child.text!) || marksOfSpaces(node, i) !== child.marks)) any = true;
  });
  if (!any) return node;
  const heading = node.type.name === "heading";
  // 1. Each line break as LINE, outside any formatting (a line can't start
  //    or end inside bold: "*\nword*" isn't bold).
  const pieces: Node[] = [];
  node.forEach((child, _, i) => {
    if (!child.isText) {
      pieces.push(child);
      return;
    }
    const marks = marksOfSpaces(node, i);
    const lines = child.text!.replace(/\r\n?/g, "\n");
    // (Code is written as it is, by the library: only its line breaks change.)
    const text = marks.some((m) => m.type.name === "code")
      ? lines.replace(/[ \t]*\n[ \t\n]*/g, " ")
      : standIns(lines).replace(/[ \t]*\n[ \t\n]*/g, heading ? " " : LINE);
    if (heading || !marks.length || !text.includes(LINE)) {
      pieces.push(schema.text(text, marks));
      return;
    }
    const lead = text.length - text.replace(LINES_AT_START, "").length;
    const trail = text.length - text.replace(LINES_AT_END, "").length;
    if (lead) pieces.push(schema.text(LINE));
    if (lead < text.length - trail) pieces.push(schema.text(text.slice(lead, text.length - trail), marks));
    if (trail && lead < text.length) pieces.push(schema.text(LINE));
  });
  // 2. No spaces at the end of a line, one line break at a time, and none at
  //    the paragraph's start or end or next to a line break of the other kind.
  const kids: Node[] = [];
  // (A "<br>" the file wrote is followed by its own line break, if the file had one.)
  const endsLine = (n: Node | undefined) =>
    !n || (n.type.name === "hard_break" && !n.attrs.markup) || (n.isText && n.text!.endsWith(LINE));
  const trimLast = (pattern: RegExp) => {
    const last = kids[kids.length - 1];
    if (!last?.isText) return;
    const text = last.text!.replace(pattern, "");
    if (text) kids[kids.length - 1] = schema.text(text, last.marks);
    else kids.pop();
  };
  for (const piece of pieces) {
    if (!piece.isText) {
      if (piece.type.name === "hard_break" && !piece.attrs.markup) trimLast(LINES_AT_END);
      kids.push(piece);
      continue;
    }
    let text = piece.text!;
    if (endsLine(kids[kids.length - 1])) text = text.replace(LINES_AT_START, "");
    if (!text) continue;
    if (text.startsWith(LINE)) trimLast(/[ \t]+$/);
    const last = kids[kids.length - 1];
    if (last?.isText && Mark.sameSet(last.marks, piece.marks)) kids[kids.length - 1] = schema.text(last.text! + text, last.marks);
    else kids.push(schema.text(text, piece.marks));
  }
  trimLast(LINES_AT_END);
  return node.copy(Fragment.fromArray(kids));
}

/**
 * The marks of text node i that Markdown can hold. Bold, italic or struck
 * spaces at the edge of the formatting can't be written (the library would
 * leave them inside the formatting before them): they are plain spaces, as
 * they read back. Otherwise the node's own marks.
 */
function marksOfSpaces(parent: Node, i: number): readonly Mark[] {
  const child = parent.child(i);
  if (!child.marks.length || /\S/.test(child.text!)) return child.marks;
  const before = parent.maybeChild(i - 1)?.marks ?? [];
  const after = parent.maybeChild(i + 1)?.marks ?? [];
  const kept = child.marks.filter((m) => !EXPELS.has(m.type.name) || (m.isInSet(before) && m.isInSet(after)));
  return kept.length === child.marks.length ? child.marks : kept;
}

const LINES_AT_START = new RegExp(`^${LINE}+`);
const LINES_AT_END = new RegExp(`${LINE}+$`);

// Text kept as written ------------------------------------------------------------------

interface InlinePlan {
  /** Where each child starts in the paragraph's text. */
  starts: number[];
  kept: { from: number; to: number }[];
  escape: Set<number>;
}

const plans = new WeakMap<Node, InlinePlan>();

/** The paragraphs a table cell's text is written from (a cell is one line of its row). */
const CELL_TEXT = new WeakSet<Node>();

/**
 * Which of a paragraph's text is Obsidian's syntax, to be written as it is,
 * and which $ or % must be escaped because formatting splits what would
 * otherwise read as math or a comment.
 */
function planFor(parent: Node): InlinePlan {
  let plan = plans.get(parent);
  if (plan) return plan;
  const starts: number[] = [];
  const ends: number[] = [];
  const plain: boolean[] = [];
  const linked: boolean[] = [];
  let text = "";
  parent.forEach((child) => {
    starts.push(text.length);
    const code = child.isText && child.marks.some((m) => m.type.name === "code");
    if (child.isText && !code) text += child.text!.replace(/\uE000/g, "\n");
    else text += (child.type.name === "hard_break" ? "\n" : PICTURE_STAND_IN).repeat(child.isText ? child.text!.length : 1);
    ends.push(text.length);
    plain.push(child.isText && !code);
    linked.push(child.marks.some((m) => m.type.name === "link"));
  });
  // (A [[note link]] in a link's words is escaped: Markdown has no link
  // inside a link, and would read neither.)
  // (The child holding `from` is found by place, not by looking through every child: row 65.)
  const single = (from: number, to: number) => {
    const k = firstFrom(starts, from + 1, (start) => start) - 1;
    return k >= 0 && plain[k] && to <= ends[k] && !(linked[k] && text[from] === "[");
  };
  const found = keptRanges(text, single, parent.type.name === "paragraph");
  plan = { starts, kept: found.kept, escape: new Set(found.escape) };
  if (/[$%]|<[^\s<>]*@/.test(text)) for (const at of asRead(parent, starts, plan.kept, plan.escape)) plan.escape.add(at);
  // "^" straight before "[" (a kept [[link]] or a link) would start a note
  // written in the text, and a note's marker then ":" at the start of a line
  // the note itself.
  for (const k of plan.kept) if (text[k.from] === "[" && text[k.from - 1] === "^") plan.escape.add(k.from - 1);
  // "$" starting a line (after any spaces, which aren't written), then kept
  // math ("$w$"), would start math over several lines ("$$" at a line's
  // start), which the "$$" rule in LINE_START can't see: the kept math is
  // written apart.
  // (Only where the text can run over several lines: a heading or a table
  // cell is one line, where "$$" starts nothing.)
  const oneLine = parent.type.name === "heading" || CELL_TEXT.has(parent);
  for (const k of oneLine ? [] : plan.kept) {
    const at = k.from - 1;
    if (text[k.from] !== "$" || text[at] !== "$" || plan.kept.some((r) => r.from <= at && at < r.to)) continue;
    let b = at - 1;
    while (b >= 0 && (text[b] === " " || text[b] === "\t")) b--;
    if (b < 0 || text[b] === "\n") plan.escape.add(at);
  }
  parent.forEach((child, _, k) => {
    const before = parent.maybeChild(k - 1);
    if (!before) return;
    const link = child.marks.find((m) => m.type.name === "link");
    if (link && !link.isInSet(before.marks) && before.isText && before.text!.endsWith("^")) plan!.escape.add(starts[k] - 1);
    const lineStart = k === 1 || text[starts[k - 1] - 1] === "\n";
    if (before.type.name === "footnote_ref" && lineStart && child.isText && child.text!.startsWith(":")) plan!.escape.add(starts[k]);
  });
  plans.set(parent, plan);
  return plan;
}

/** A plan's kept ranges and escaped signs, each in order of place, made once per plan (row 65). */
const inOrder = new WeakMap<InlinePlan, { kept: InlinePlan["kept"]; escape: number[] }>();

/** The first entry at or after `at` in a list in order of place. */
function firstFrom<T>(list: T[], at: number, place: (x: T) => number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (place(list[mid]) < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The kept ranges wholly inside [at, end) of a paragraph's text, and the
 * escaped signs there, from its plan: found by place, so writing each piece
 * of text doesn't look through the whole paragraph's (row 65).
 */
function planWithin(plan: InlinePlan, at: number, end: number): { kept: InlinePlan["kept"]; escape: number[] } {
  let sorted = inOrder.get(plan);
  if (!sorted) {
    sorted = { kept: [...plan.kept].sort((a, b) => a.from - b.from), escape: [...plan.escape].sort((a, b) => a - b) };
    inOrder.set(plan, sorted);
  }
  const kept: InlinePlan["kept"] = [];
  for (let i = firstFrom(sorted.kept, at, (k) => k.from); i < sorted.kept.length && sorted.kept[i].from < end; i++) if (sorted.kept[i].to <= end) kept.push(sorted.kept[i]);
  const escape: number[] = [];
  for (let i = firstFrom(sorted.escape, at, (e) => e); i < sorted.escape.length && sorted.escape[i] < end; i++) escape.push(sorted.escape[i]);
  return { kept, escape };
}

/**
 * Which $ and % (by place in the paragraph's text) the reader would take as
 * the start of math or a comment in the text as it will be written, with
 * formatting signs between the words: "**12$** and 20$" reads "$** and 20$"
 * as math, where the words alone ("12$ and 20$") have none. Those are
 * escaped, so the formatting and the words read back as they were.
 *
 * Each escaped sign is looked at as written, a backslash before it: it
 * starts nothing, but it can free the "$" before it ("$5 or \$$" reads as
 * math), and with a "$" after it, it still ends "$$" math ("$$ a \$$"). So,
 * starting from the signs already to be escaped (`escaped`), each one found
 * is escaped and the text looked at again, until none is found.
 */
function asRead(parent: Node, starts: number[], kept: Kept[], escaped: ReadonlySet<number>): number[] {
  const escapes = new Set(escaped);
  const keptAt = new Map(kept.map((k) => [k.from, k.to]));
  const found: number[] = [];
  for (;;) {
    // The text as written, roughly: each formatting sign as "*" (a link's as
    // "[" and "](address)"), code in backticks, pictures and note markers as
    // written; and where each of the paragraph's own characters is in it.
    let written = "";
    const at: number[] = []; // written position of each character of the paragraph's text
    const put = (chars: string, from: number) => {
      for (let k = 0; k < chars.length; k++) {
        if (escapes.has(from + k)) written += "\\";
        at[from + k] = written.length;
        written += chars[k];
      }
    };
    // (In the order the library writes them: see writtenOrder.)
    for (const step of writtenOrder(parent)) {
      if (step.t === "open" || step.t === "close") {
        const m = step.mark;
        written += m.type.name === "link" ? (step.t === "open" ? "[" : `](${m.attrs.href})`) : "*";
      } else if (step.t === "space") written += step.text.replace(/\uE000/g, "\n");
      else if (step.t === "leaf") {
        const child = parent.child(step.at);
        written += child.type.name === "hard_break" ? "\n" : child.type.name === "image" ? `![${child.attrs.alt ?? ""}](${child.attrs.src})` : PICTURE_STAND_IN;
      } else if (step.code) written += "`" + step.text + "`";
      else put(step.text.replace(/\uE000/g, "\n"), starts[step.at] + step.from);
    }
    // Every sign that starts math or a comment in this text is found in one
    // look (whether a sign starts one depends only on what comes after it),
    // then all of them are escaped and the text looked at again.
    const byWritten = new Map<number, number>();
    at.forEach((w, i) => byWritten.set(w, i));
    const hits: number[] = [];
    for (let w = 0; w < written.length; w++) {
      const i = byWritten.get(w);
      if (i === undefined || escapes.has(i)) continue;
      const keptTo = keptAt.get(i);
      if (keptTo !== undefined) {
        w = at[keptTo - 1];
        continue;
      }
      const c = written[w];
      if ((c === "$" && matchMath(written, w) > 0) || (c === "%" && matchComment(written, w) > 0) || (c === "<" && emailAcross(written, w, byWritten, keptAt))) hits.push(i);
    }
    if (!hits.length) return found;
    for (const hit of hits) escapes.add(hit);
    found.push(...hits);
  }
}

/** An email link in Markdown: "<", an address, ">" (markdown-it's own address pattern). */
const EMAIL_LINK = /<[\w.!#$%&'*+/=?^`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>/y;

/**
 * Whether the "<" at `w` in the paragraph as written starts an email link
 * that runs across kept syntax or formatting signs ("<1$x$@a>", "<1**b**@a>"):
 * one inside plain text is escaped where the text is written (EXTRA).
 */
function emailAcross(written: string, w: number, byWritten: ReadonlyMap<number, number>, keptAt: ReadonlyMap<number, number>): boolean {
  EMAIL_LINK.lastIndex = w;
  if (!EMAIL_LINK.test(written)) return false;
  for (let x = w + 1; x < EMAIL_LINK.lastIndex; x++) {
    const i = byWritten.get(x);
    if (i === undefined || keptAt.has(i)) return true;
  }
  return false;
}

/** The backticks around code: one more than its longest run, and a space inside them when needed. */
function backticks(node: Node, side: "open" | "close"): string {
  const text = node.isText ? node.text! : "";
  const longest = (text.match(/`+/g) ?? []).reduce((m, run) => Math.max(m, run.length), 0);
  const pad = longest > 0 || (text.length > 1 && text.startsWith(" ") && text.endsWith(" ") && /[^ ]/.test(text)) ? " " : "";
  const fence = "`".repeat(longest + 1);
  return side === "open" ? fence + pad : pad + fence;
}

/** A title in quotes, with the characters that would end it early escaped. */
function quotedTitle(title: string | null): string {
  return title ? ` "${title.replace(/[\\"]/g, "\\$&")}"` : "";
}

// A pipe in code in a table cell, while the cell is written.
const CODE_PIPE = "\uE003";

export { CELL_TEXT, CODE_PIPE, FaithfulSerializer, FaithfulState, backticks, emphasis, optionsOf, planFor, planWithin, quotedTitle, restore, type SerializeOptions };
