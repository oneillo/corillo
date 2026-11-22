// View > Line Numbers, in the window: beside the text, the line of the
// Markdown file each part starts on, counted the way an agent reading the file
// counts them (see core/line-numbers.ts), so "line 42" means the same to both.
//
// In the formatted view, a small number in the page's left margin beside each
// paragraph, heading, list item, table row and line of code, and beside each
// line with no words (Orlando, 2026-11-09: "it's weird to see missing line
// numbers"): an empty line, the blank line between two blocks, a code block's
// fences, a table's row of dashes. In the Markdown view, one beside each line
// of the file. The style sheet draws them, never
// the text itself, so they can't be selected, copied or exported, and they
// never move the text.
//
// Kept quick on long documents: the numbers are worked out again at most once
// a frame, from what's already known about each block, and the page only
// changes where a number did.
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { Node } from "prosemirror-model";
import { blockMarks, blockStarts, textAreaLineNumbers } from "../core/line-numbers";
import type { Source } from "../core/markdown";
import type { CorilloApi } from "../preload/preload";
import { isDiagram } from "./diagrams";
import { onlySpacing } from "./blank-lines";

let shown = false;
const editors = new Set<EditorNumbers>();
const gutters = new Set<SourceGutter>();

/** Follow View > Line Numbers: the same for every document, remembered between launches. */
export function setupLineNumbers(api: CorilloApi): void {
  void api.lineNumbers().then(show);
  api.onLineNumbers(show);
}

function show(on: boolean): void {
  if (on === shown) return;
  shown = on;
  document.body.classList.toggle("line-numbers", on);
  for (const editor of editors) editor.refresh();
  for (const gutter of gutters) gutter.refresh();
}

// The formatted view ---------------------------------------------------------------

const key = new PluginKey<DecorationSet>("line-numbers");

/** A document with up to this many blocks has every block numbered. */
const ALL = 200;
/** A longer one is numbered near where it is on screen; just opened, this many blocks from its start. */
const FIRST = 80;

/** The numbers in the formatted view. source gives what the document was read from. */
export function lineNumbersPlugin(source: () => Source): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key,
    state: {
      // A document just opened (or replaced) shows its numbers straight away.
      init: (_config, state) =>
        shown ? (numbersIn(state.doc, source(), DecorationSet.empty, 0, firstBlocks(state.doc)) ?? DecorationSet.empty) : DecorationSet.empty,
      apply: (tr, numbers) => (tr.getMeta(key) as DecorationSet | undefined) ?? numbers.map(tr.mapping, tr.doc),
    },
    props: { decorations: (state) => key.getState(state) },
    view: (view) => new EditorNumbers(view, source),
  });
}

/** A transaction that only brings new numbers, or the page's spacing (blank-lines.ts): nothing else about the document changed. */
export function onlyLineNumbers(tr: Transaction): boolean {
  return !tr.docChanged && !tr.selectionSet && (tr.getMeta(key) !== undefined || onlySpacing(tr));
}

/** The editor's page is back in sight (from the Markdown view): number what's on screen there now. */
export function lineNumbersShown(view: EditorView): void {
  for (const editor of editors) if (editor.isFor(view)) editor.later();
}

const firstBlocks = (doc: Node) => (doc.childCount <= ALL ? doc.childCount : FIRST);

/**
 * Keeps an editor's numbers up to date: after a change, at most once a frame,
 * and as the page scrolls. A long document is numbered only on screen and a
 * screen's worth above and below: the editor slows down with every number it
 * has, wherever it is, and nobody sees the ones far away.
 */
class EditorNumbers {
  private frame = 0;
  /** The document and the blocks (first to before last) numbered for it. */
  private drawn: { doc: Node; first: number; last: number } | null = null;
  private readonly scroller: HTMLElement | null;
  private readonly onScroll = () => this.later();
  private readonly sizes: ResizeObserver;

  constructor(
    private readonly view: EditorView,
    private readonly source: () => Source,
  ) {
    this.scroller = view.dom.closest<HTMLElement>(".canvas");
    this.scroller?.addEventListener("scroll", this.onScroll, { passive: true });
    // Also when the window is resized, or the tab comes to the front.
    this.sizes = new ResizeObserver(this.onScroll);
    if (this.scroller) this.sizes.observe(this.scroller);
    editors.add(this);
    if (shown) this.later();
  }

  isFor(view: EditorView): boolean {
    return this.view === view;
  }

  update(view: EditorView, prev: EditorState): void {
    if (shown && view.state.doc !== prev.doc) this.later();
  }

  /** Once the browser is about to draw: many edits in one frame are looked at together. */
  later(): void {
    if (!shown) return;
    this.frame ||= requestAnimationFrame(() => {
      this.frame = 0;
      this.refresh();
    });
  }

  refresh(): void {
    const view = this.view;
    if (view.isDestroyed) return;
    // Not in the middle of typing an accented letter or other composed text.
    if (view.composing) return this.later();
    const numbers = key.getState(view.state)!;
    if (!shown) {
      this.drawn = null;
      if (numbers !== DecorationSet.empty) view.dispatch(view.state.tr.setMeta(key, DecorationSet.empty));
      return;
    }
    const doc = view.state.doc;
    const seen = this.onScreen(doc);
    const drawn = this.drawn;
    if (drawn?.doc === doc && seen && seen[0] >= drawn.first && seen[1] <= drawn.last) return; // scrolled within what's numbered
    let first: number;
    let last: number;
    if (seen) {
      const margin = Math.max(seen[1] - seen[0], 20);
      first = Math.max(0, seen[0] - margin);
      last = Math.min(doc.childCount, seen[1] + margin);
    } else if (drawn) {
      // Not on screen (another tab is in front): keep to the same blocks.
      first = Math.min(drawn.first, doc.childCount);
      last = Math.min(drawn.last, doc.childCount);
    } else {
      first = 0;
      last = firstBlocks(doc);
    }
    this.drawn = { doc, first, last };
    const next = numbersIn(doc, this.source(), numbers, first, last);
    if (next) view.dispatch(view.state.tr.setMeta(key, next));
  }

  /** The blocks on screen, first to before last; null when the editor isn't on screen. */
  private onScreen(doc: Node): [number, number] | null {
    const count = doc.childCount;
    if (count <= ALL) return [0, count];
    // Out of sight (another tab is in front, or the Markdown view): measuring
    // the page then would lay it all out.
    if (!this.scroller?.checkVisibility({ visibilityProperty: true })) return null;
    const box = this.scroller.getBoundingClientRect();
    if (!box.height) return null;
    const at: number[] = [];
    doc.forEach((_node, pos) => at.push(pos));
    const place = (k: number) => (this.view.nodeDOM(at[k]) as Element | null)?.getBoundingClientRect();
    // Blocks go down the page in order, so halving finds the first one ending below the top, then the first starting below the bottom.
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((place(mid)?.bottom ?? Infinity) < box.top) lo = mid + 1;
      else hi = mid;
    }
    const first = lo;
    hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((place(mid)?.top ?? -Infinity) <= box.bottom) lo = mid + 1;
      else hi = mid;
    }
    return [first, Math.max(lo, first + 1)];
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.scroller?.removeEventListener("scroll", this.onScroll);
    this.sizes.disconnect();
    editors.delete(this);
  }
}

/** Numbers for the blocks first to before last (and the blank lines after them); null when the ones drawn are already those. */
function numbersIn(doc: Node, source: Source, drawn: DecorationSet, first: number, last: number): DecorationSet | null {
  const starts = blockStarts(doc, source);
  const want: Decoration[] = [];
  doc.forEach((node, pos, k) => {
    if (k < first || k >= last) return;
    want.push(...wanted(node, pos, starts.line[k], starts.text[k]));
    // The blank line after it: in the space before the next block.
    const blank = starts.blank[k];
    if (blank !== null) want.push(Decoration.widget(pos + node.nodeSize, numberAt(blank, "ln-blank"), { side: -1, ignoreSelection: true, key: `lb${blank}`, ln: blank, k: "blank" }));
  });
  if (same(drawn.find(), want)) return null;
  return want.length ? DecorationSet.create(doc, want) : DecorationSet.empty;
}

/** The numbers one top-level block should show, starting on file line first. */
function wanted(node: Node, pos: number, first: number | null, text: string | null): Decoration[] {
  if (first === null || text === null) return [];
  const out: Decoration[] = [];
  for (const mark of blockMarks(node, text)) {
    const line = first + mark.line;
    const at = { from: pos + mark.from, to: pos + mark.to };
    if (mark.kind === "line" || mark.kind === "blank") {
      // At a line's start in a block's text; or in the space between two parts of a list or quote.
      const kind = mark.kind === "line" ? "ln-line" : "ln-blank";
      out.push(Decoration.widget(at.from, numberAt(line, kind), { side: -1, ignoreSelection: true, key: `${kind}${line}`, ln: line, k: kind }));
      continue;
    }
    if (mark.kind === "dash") {
      // A table's row of dashes: shown with the number of the row under it, just above (style.css).
      out.push(Decoration.node(at.from, at.to, { class: "ln-dash", "data-dash": String(line) }, { ln: line, k: "dash" }));
      continue;
    }
    const block = mark.from === 0 ? node : node.nodeAt(mark.from - 1)!;
    const code = block.type.name === "code_block";
    if (mark.kind === "end") {
      // A code block's closing fence: in the space under its last line.
      if (!isDiagram(block)) out.push(Decoration.node(at.from, at.to, { class: "ln-end", "data-end": String(line) }, { ln: line, k: "end" }));
      continue;
    }
    // A code block's opening fence sits in the space above its first line; indented code's lines have their own numbers.
    if (code && !isDiagram(block) && !mark.fenced) continue;
    const kind =
      block.type.name === "table_row" ? " ln-row" : block.type.name === "horizontal_rule" ? " ln-rule" : code && !isDiagram(block) ? " ln-fence" : "";
    out.push(Decoration.node(at.from, at.to, { class: "ln" + kind, "data-ln": String(line) }, { ln: line, k: "ln" + kind }));
  }
  return out;
}

/**
 * A number at the start of a line inside a block's text (code, a footnote),
 * or (ln-blank) for a blank line, in the space between two blocks.
 */
function numberAt(line: number, kind = "ln-line") {
  return () => {
    const number = document.createElement("span");
    number.className = kind;
    number.dataset.ln = String(line);
    number.contentEditable = "false";
    number.setAttribute("aria-hidden", "true");
    return number;
  };
}

function same(have: readonly Decoration[], want: readonly Decoration[]): boolean {
  if (have.length !== want.length) return false;
  const order = (a: Decoration, b: Decoration) => a.from - b.from || a.to - b.to || a.spec.ln - b.spec.ln || String(a.spec.k).localeCompare(String(b.spec.k));
  const a = [...have].sort(order);
  const b = [...want].sort(order);
  return a.every((d, i) => d.from === b[i].from && d.to === b[i].to && d.spec.ln === b[i].spec.ln && d.spec.k === b[i].spec.k);
}

// The Markdown view -------------------------------------------------------------------

/** The text area's bottom padding, and its copies' (style.css). */
const FOOT = 32;
/** The Markdown view's text and the copies of it laid over it, all set alike. */
const SET_ALIKE = ":scope > .source, :scope > .find-marks, :scope > .source-marks > .source-marks-lines, :scope > .line-gutter > .line-mirror";

/**
 * Keep a copy of the Markdown view's text exactly level with the text all the
 * way down. The style sheet moves the copy in step with the text area's
 * scrolling, over the copy's height, and the text area scrolls through its
 * text's height rounded to whole pixels: of the screen or of the page,
 * depending on the screen. So the text and its copies get a sliver more
 * padding at their foot (under a pixel, the same for all), to make that height
 * a whole number of both and leave nothing to round. Watches the copy's size;
 * returns what to call to stop.
 */
export function roundLikeTheText(copy: HTMLElement): () => void {
  const fit = () => {
    const split = copy.closest<HTMLElement>(".split");
    const box = copy.getBoundingClientRect().height; // in the page's pixels, zoom included
    if (!split || !box) return; // hidden
    const zoom = copy.currentCSSZoom;
    const foot = parseFloat(getComputedStyle(copy).paddingBottom) || 0;
    const natural = box - (foot - FOOT) * zoom;
    const wanted = FOOT + (Math.ceil(natural - 1 / 256) - natural) / zoom;
    if (Math.abs(wanted - foot) * zoom <= 1 / 256) return;
    // On each of them, not on what holds them, so nothing else is styled again.
    for (const el of split.querySelectorAll<HTMLElement>(SET_ALIKE)) el.style.paddingBottom = `${wanted}px`;
  };
  // The size in screen pixels: it changes with the text, the zoom and the screen. The padding isn't part of it.
  // Fitted when the window has a moment, never in the frame that shows a key typed: laying out
  // every line again for a sliver costs a long document's Return a few milliseconds.
  let idle = 0;
  const sizes = new ResizeObserver(() => {
    idle ||= requestIdleCallback(() => {
      idle = 0;
      fit();
    }, { timeout: 250 });
  });
  sizes.observe(copy, { box: "device-pixel-content-box" });
  return () => {
    sizes.disconnect();
    cancelIdleCallback(idle);
  };
}

/**
 * The Markdown view's numbers: a layer over the text area's left margin
 * holding a copy of its text, invisible and wrapped the same way, so each
 * number sits beside the start of its line however the line wraps. The style
 * sheet numbers the copy's lines and scrolls it with the text area.
 */
export class SourceGutter {
  readonly el: HTMLElement;
  private readonly lines: HTMLElement;
  /** The text of each line in the copy. */
  private text: string[] = [];
  /** Some lines carry on the file line before them (an old Mac line ending). */
  private continued = false;
  private frame = 0;
  private readonly sizes: ResizeObserver;
  private readonly unround: () => void;

  /** fileText gives the file's text when it may hold an old Mac line ending, else null. */
  constructor(
    private readonly area: HTMLTextAreaElement,
    private readonly fileText: () => string | null,
  ) {
    this.el = document.createElement("div");
    this.el.className = "line-gutter";
    this.el.setAttribute("aria-hidden", "true");
    this.el.hidden = true;
    this.lines = document.createElement("div");
    this.lines.className = "line-mirror";
    this.el.append(this.lines);
    area.after(this.el);
    area.addEventListener("input", () => this.later());
    // A scroll bar takes room from the text, so the copy leaves the same room.
    this.sizes = new ResizeObserver(() => this.fitScrollbar());
    this.sizes.observe(area);
    this.unround = roundLikeTheText(this.lines);
    gutters.add(this);
    this.refresh();
  }

  private later(): void {
    if (!shown) return;
    this.frame ||= requestAnimationFrame(() => {
      this.frame = 0;
      this.refresh();
    });
  }

  /** Bring the numbers up to date with the text area now. */
  refresh(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.el.hidden = !shown;
    if (!shown) {
      if (this.text.length) this.lines.replaceChildren();
      this.text = [];
      this.continued = false;
      return;
    }
    this.sync(this.area.value.split("\n"));
    this.markContinued();
    // Five-digit numbers need a little more of the margin.
    this.el.classList.toggle("wide", this.text.length >= 10_000);
  }

  /** Change only the lines of the copy that changed. */
  private sync(lines: string[]): void {
    const old = this.text;
    const rows = this.lines.children;
    let start = 0;
    const shortest = Math.min(old.length, lines.length);
    while (start < shortest && old[start] === lines[start]) start++;
    let oldEnd = old.length;
    let newEnd = lines.length;
    while (oldEnd > start && newEnd > start && old[oldEnd - 1] === lines[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    const rewritten = Math.min(oldEnd, newEnd);
    for (let i = start; i < rewritten; i++) rows[i].textContent = lines[i];
    for (let i = oldEnd - 1; i >= rewritten; i--) rows[i].remove();
    if (newEnd > rewritten) {
      const added = document.createDocumentFragment();
      for (let i = rewritten; i < newEnd; i++) {
        const row = document.createElement("div");
        row.textContent = lines[i];
        added.append(row);
      }
      this.lines.insertBefore(added, rows[rewritten] ?? null);
    }
    this.text = lines;
  }

  /** A line that carries on the file line before it gets no number of its own. */
  private markContinued(): void {
    const file = this.fileText();
    let numbers = file === null ? null : textAreaLineNumbers(file);
    if (numbers && numbers.length !== this.text.length) numbers = null;
    if (!numbers && !this.continued) return;
    const rows = this.lines.children;
    this.continued = false;
    for (let i = 0; i < rows.length; i++) {
      const carriesOn = numbers !== null && numbers[i] === null;
      rows[i].classList.toggle("cont", carriesOn);
      this.continued ||= carriesOn;
    }
  }

  private fitScrollbar(): void {
    const scrollbar = this.area.offsetWidth - this.area.clientWidth - 1; // less the right border
    this.lines.style.paddingRight = scrollbar > 0 ? `${parseFloat(getComputedStyle(this.area).paddingRight) + scrollbar}px` : "";
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.sizes.disconnect();
    this.unround();
    gutters.delete(this);
    this.el.remove();
  }
}
