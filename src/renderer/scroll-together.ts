// In the Markdown view, the text and its preview move together (roadmap
// Batch 6, item 4; Orlando, 2026-11-10: "If I move the markdown pane around,
// the preview should follow it." and "the text on the two sides should match
// as much as possible so that as you make markdown changes you can see the
// changes in the preview pane").
//
// The halves are tied by the file's lines. Each block of the preview, and
// each part of a long one (a table's rows, a list's items, a code block's
// lines, a paragraph's lines), knows the line of the file it starts on
// (core/line-numbers.ts, which also numbers the lines); a copy of the text,
// set exactly like it and never seen, says where each line of the text is.
// Between two such places the halves are matched in proportion, so moving
// stays smooth inside a long paragraph, table or code block.
//
// Whichever half the person moves leads, and the other follows: what's in
// the middle of the one is in the middle of the other (nearer the start, the
// top of each; nearer the end, the bottom), so at the top of one the other is
// at its top, and at the end, at its end. When the person types or moves the
// cursor, the preview is set so the cursor's line has its result beside it,
// at the same height and in sight; the difference that makes fades as the
// person scrolls on, and is gone at either end. A scroll Corillo makes never
// comes back as a new one, and the follower never moves against the way the
// leader moved, so nothing trembles. When sizes change (a picture comes in,
// the window or a column is resized, the zoom), the text stays and the
// preview lines up with it again.
//
// Quick on a long document: a scroll waits for the next frame, and then
// finds its place by halving (the blocks, then a block's parts), reading a
// few positions the window has already laid out. What's worked out for a
// version of the document is kept until the next version.
import type { EditorView } from "prosemirror-view";
import type { Node } from "prosemirror-model";
import { blockMarks, blockStarts, lineBreaks, textAreaLineNumbers } from "../core/line-numbers";
import type { Source } from "../core/markdown";

/** What the tie needs from its tab. */
export interface TogetherHost {
  /** The preview, and what its document was read from; null while there's none, or it shows another document than the editor's. */
  preview(): { view: EditorView; source: Source } | null;
  /** Typing is still to come in: the preview shows the text as it was a moment ago. */
  stale(): boolean;
  /** Bring the preview up to date with the text now. */
  settle(): void;
  /** The file's text when it has an old Mac line ending (the text area shows each as a line of its own), else null. */
  oldMacText(): string | null;
}

/** A scroll this soon after a key typed came with the typing: the preview catches up once it has the typing. */
const TYPING_MS = 120;

/** Where the halves are, in the screen's pixels (the text's own are zoomed). */
interface Geometry {
  /** The text's zoom: screen pixels to one of its own. */
  z: number;
  /** The text: scrolled, its window's height, its whole height, how far it scrolls. */
  s: number;
  h: number;
  textH: number;
  sMax: number;
  /** The preview: the same. */
  p: number;
  hp: number;
  previewH: number;
  pMax: number;
  /** The tops of the two on screen. */
  textTop: number;
  paneTop: number;
}

/**
 * A place both halves show: a line of the file, and what in the preview
 * shows it. "top" and "bottom": a block's own edges; "block": a part of it
 * (a row, an item's paragraph); "line": a line of its text (code).
 */
interface Tie {
  line: number;
  pos: number;
  kind: "top" | "bottom" | "block" | "line";
}

/** The preview's document, read for the tie: its written blocks, in order. */
interface Placed {
  doc: Node;
  source: Source;
  /** For each written block: its index among the document's blocks, where it starts, the file line it starts on, the line after its last, and its text. */
  k: number[];
  pos: number[];
  line: number[];
  end: number[];
  text: string[];
  /** Each block's element in the preview. */
  els: (HTMLElement | null)[];
  /** Each block's places, worked out when first needed. */
  ties: Map<number, Tie[]>;
}

type Want = { text: boolean; preview: boolean; cursor: boolean; layout: boolean };
const none = (): Want => ({ text: false, preview: false, cursor: false, layout: false });

/** The last of a rising list that is at most `value`, by halving; -1 if none is. */
function lastAtMost(count: number, valueAt: (i: number) => number, value: number): number {
  let lo = 0;
  let hi = count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (valueAt(mid) <= value) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Where x falls between a and b, carried across to between c and d. */
function across(x: number, a: number, b: number, c: number, d: number): number {
  if (b <= a) return c;
  return c + ((clamp(x, a, b) - a) * (Math.max(d, c) - c)) / (b - a);
}

/**
 * How far down its window the place lined up with the other half is, as a
 * share of the window: the middle, sliding to the top over the first
 * window's worth of scrolling and to the bottom over the last. (Scrolled `at`
 * of `end`, with a window `window` tall.)
 */
export function share(at: number, end: number, window: number): number {
  if (end <= 0) return 0;
  if (end <= 2 * window) return clamp(at / end, 0, 1);
  if (at < window) return Math.max(0, at / (2 * window));
  if (end - at < window) return Math.min(1, 1 - (end - at) / (2 * window));
  return 0.5;
}

/**
 * The difference the person's cursor made, as the leader moves from `from`
 * to `to`: it shrinks with the way left to the end it's moving towards (so
 * it's gone at either end) and fades over two windows' worth of scrolling.
 */
export function fade(offset: number, from: number, to: number, end: number, window: number): number {
  if (to === from || !offset) return offset;
  const left = to < from ? (from > 0 ? to / from : 0) : end - from > 0 ? (end - to) / (end - from) : 0;
  return offset * clamp(left, 0, 1) * Math.max(0, 1 - Math.abs(to - from) / (2 * Math.max(1, window)));
}

/**
 * A copy of the Markdown text, set exactly like it and never seen, one line
 * per line: where each line of the text is, however it wraps. Brought up to
 * date only when a place is wanted, and only the lines that changed.
 */
class TextRows {
  readonly layer: HTMLElement;
  private readonly box: HTMLElement;
  private rows: HTMLElement[] = [];
  private lines: string[] = [];
  /** Where each line starts in the text. */
  private starts: number[] = [];
  /** The file line of each row, and the first row of each file line, when they differ (an old Mac line ending). */
  private fileLines: number[] | null = null;
  private firstRows: number[] | null = null;
  private synced = -1;
  /** The text the copy was last made from. */
  private text = "";
  dirty = true;

  constructor(private readonly area: HTMLTextAreaElement) {
    this.layer = document.createElement("div");
    this.layer.className = "together-rows";
    this.layer.setAttribute("aria-hidden", "true");
    this.box = document.createElement("div");
    this.box.className = "together-rows-text";
    this.layer.append(this.box);
    area.before(this.layer);
  }

  /** Up to date with the text area: only the lines that changed are written again. */
  sync(oldMac: () => string | null): void {
    if (!this.dirty && this.area.textLength === this.synced) return;
    const value = this.area.value;
    this.dirty = false;
    if (this.synced >= 0 && value === this.text) return; // set again, as it was (the view shown again)
    this.synced = value.length;
    this.text = value;
    const lines = value.split("\n");
    const old = this.lines;
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
    for (let i = start; i < rewritten; i++) this.rows[i].textContent = lines[i];
    for (let i = oldEnd - 1; i >= rewritten; i--) this.rows[i].remove();
    const added: HTMLElement[] = [];
    for (let i = rewritten; i < newEnd; i++) {
      const row = document.createElement("div");
      row.textContent = lines[i];
      added.push(row);
    }
    if (added.length) {
      const fragment = document.createDocumentFragment();
      fragment.append(...added);
      this.box.insertBefore(fragment, this.rows[oldEnd] ?? null);
    }
    this.rows.splice(rewritten, oldEnd - rewritten, ...added);
    this.lines = lines;
    this.starts = new Array(lines.length);
    for (let i = 0, at = 0; i < lines.length; i++) {
      this.starts[i] = at;
      at += lines[i].length + 1;
    }
    this.numberRows(oldMac());
  }

  private numberRows(oldMac: string | null): void {
    const numbers = oldMac === null ? null : textAreaLineNumbers(oldMac);
    if (!numbers || numbers.length !== this.rows.length) {
      this.fileLines = this.firstRows = null;
      return;
    }
    const fileLines: number[] = [];
    const firstRows: number[] = [];
    let line = 1;
    numbers.forEach((n, row) => {
      if (n !== null) {
        line = n;
        firstRows[n] ??= row;
      }
      fileLines.push(line);
    });
    this.fileLines = fileLines;
    this.firstRows = firstRows;
  }

  get count(): number {
    return this.rows.length;
  }

  /** The copy has been made (it's then only brought up to date). */
  get made(): boolean {
    return this.synced >= 0;
  }

  /** The top of a row (the text's own pixels, from the top of its scrolling area); past the last, the end of the text. */
  top(row: number): number {
    if (row <= 0) return this.rows.length ? this.rows[0].offsetTop : 0;
    if (row >= this.rows.length) {
      const last = this.rows[this.rows.length - 1];
      return last ? last.offsetTop + last.offsetHeight : 0;
    }
    return this.rows[row].offsetTop;
  }

  /** The row at this height (the text's own pixels). */
  rowAt(y: number): number {
    return Math.max(0, lastAtMost(this.rows.length, (i) => this.rows[i].offsetTop, y));
  }

  /** A file line (from 1) for a row, and the first row of a file line. */
  lineOf(row: number): number {
    return this.fileLines ? (this.fileLines[row] ?? row + 1) : row + 1;
  }

  rowOf(line: number): number {
    if (!this.firstRows) return line - 1;
    return this.firstRows[line] ?? (line > this.firstRows.length ? this.rows.length : line - 1);
  }

  /** The top of the line of the text a place in it is on, wrapped lines and all (the text's own pixels). */
  caretTop(offset: number): number {
    const row = Math.max(0, lastAtMost(this.starts.length, (i) => this.starts[i], offset));
    const el = this.rows[row];
    if (!el) return 0;
    const line = this.lines[row];
    const column = clamp(offset - this.starts[row], 0, line.length);
    if (column === 0) return el.offsetTop;
    const marker = document.createElement("span");
    marker.textContent = "\u200B";
    el.replaceChildren(line.slice(0, column), marker, line.slice(column));
    const top = marker.offsetTop;
    el.textContent = line;
    return top;
  }

  /** A scroll bar takes room from the text, so the copy leaves the same room. */
  fitScrollbar(): void {
    const scrollbar = this.area.offsetWidth - this.area.clientWidth - 1; // less the right border
    this.box.style.paddingRight = scrollbar > 0 ? `${parseFloat(getComputedStyle(this.area).paddingRight) + scrollbar}px` : "";
  }

  clear(): void {
    this.box.replaceChildren();
    this.rows = [];
    this.lines = [];
    this.starts = [];
    this.fileLines = this.firstRows = null;
    this.synced = -1;
    this.text = "";
    this.dirty = true;
  }
}

/** The text and the preview of one tab's Markdown view, moving together. */
export class ScrollTogether {
  private readonly rows: TextRows;
  private frame = 0;
  private idle = 0;
  /** The view just came into sight: it's lined up when the window has a moment, not in the frame that shows it. */
  private fresh = false;
  private want = none();
  /** The half the person moved last; the other follows. */
  private leader: "text" | "preview" = "text";
  /** How far the follower is from where the tie alone puts it: preview pixels while the text leads, the text's (on screen) while the preview does. */
  private offset = 0;
  /** While the preview leads: the same, as the text leading would have it (so sizes changing can keep the text still). */
  private textOffset = 0;
  /** Where each half was last seen or put, in its own pixels. */
  private textAt = 0;
  private paneAt = 0;
  private selection: [number, number] = [-1, -1];
  /** Keys typed, and when the last was. */
  private inputs = 0;
  private inputsSeen = 0;
  private lastInput = -Infinity;
  /** The person typed: once the preview has it, it's put beside the cursor. */
  private typed = false;
  /** The mouse is down in the text (the selection then): the cursor is followed once it's let go. */
  private pressed: [number, number] | null = null;
  /** The width the text is wrapped to, and the line at its top, to keep that line there when it wraps anew. */
  private textWidth = -1;
  private top: { row: number; into: number } | null = null;
  /** What the preview was last put beside, while the person hasn't scrolled since: when sizes change, it's put beside it again. */
  private aligned: "cursor" | { at: number; pos: number; doc: Node } | null = null;
  private placed: Placed | null = null;
  private view: EditorView | null = null;
  /** The preview's elements were found again in this piece of work (so it's done once). */
  private refound = false;
  private readonly sizes: ResizeObserver;
  private destroyed = false;

  constructor(
    private readonly area: HTMLTextAreaElement,
    private readonly pane: HTMLElement,
    page: HTMLElement,
    private readonly host: TogetherHost,
  ) {
    this.rows = new TextRows(area);
    area.addEventListener("scroll", this.onTextScroll, { passive: true });
    pane.addEventListener("scroll", this.onPaneScroll, { passive: true });
    area.addEventListener("input", this.onInput);
    area.addEventListener("selectionchange", this.onSelection);
    area.addEventListener("mousedown", this.onMouseDown);
    this.sizes = new ResizeObserver(this.onSizes);
    for (const el of [area, pane, page]) this.sizes.observe(el);
  }

  // What the tab tells it --------------------------------------------------------

  /** The Markdown view came into sight, its text placed: the preview goes beside the cursor. */
  shown(): void {
    this.fresh = true;
    this.leader = "text";
    this.offset = 0;
    this.top = null;
    this.aligned = null;
    // A width from before it was out of sight isn't a rewrap: the cursor still decides (B6-R05).
    this.textWidth = -1;
    this.note();
    this.want.cursor = true;
    this.later();
  }

  /** The text area's text was set other than by typing. */
  textChanged(): void {
    this.rows.dirty = true;
  }

  /** The preview was brought up to date with the text. */
  previewUpdated(): void {
    if (this.typed) this.want.cursor = true;
    else this.want.layout = true;
    this.later();
  }

  /** The text is about to be put back where it was after a change from outside (an agent's): from then on, it leads. */
  holdText(): void {
    if (this.leader === "preview") {
      const g = this.visible() && this.host.preview() && !this.host.stale() ? this.measure() : null;
      this.offset = g ? g.p - this.fromText(g.s, g) : this.textOffset;
      this.leader = "text";
    }
  }

  /** The text was put back where it was after a change: the preview follows it there, now. */
  kept(): void {
    this.note();
    this.top = null;
    this.leader = "text";
    this.want.layout = true;
    this.run();
  }

  /** Both halves at their top. */
  toTop(): void {
    this.area.scrollTop = 0;
    this.pane.scrollTop = 0;
    this.leader = "text";
    this.offset = 0;
    this.aligned = null;
    this.note();
  }

  /**
   * Bring a place into sight in both halves (a comment's words, a heading):
   * the text already shows it at `at`; the preview shows the document's
   * `pos` beside it, at the same height, in sight.
   */
  place(at: number, pos: number): void {
    this.leader = "text";
    this.note();
    this.run(none(), { at, pos });
  }

  /**
   * Corillo scrolls both halves by the same distance on screen (`by`, down is more), from where each was
   * (`from`, each half's own scroll, read before a line above them came or went), so the words being read
   * stay where they are. Both new places are Corillo's own from this moment: whichever frame the window
   * reports each half's scroll in, neither is taken for the person's, so neither pulls the other after it
   * (review of Batch 11, B11R-4: the preview's scroll came a frame before the text's, and the text followed
   * the preview 30 to 40 pixels further).
   */
  shift(by: number, from: { text: number; pane: number | null }): void {
    const z = parseFloat(getComputedStyle(this.area).zoom) || 1; // the text's own pixels are zoomed
    this.area.scrollTop = Math.max(0, from.text + by / z);
    if (from.pane !== null) this.pane.scrollTop = Math.max(0, from.pane + by); // null: the preview gave way
    this.textAt = this.area.scrollTop;
    this.paneAt = this.pane.scrollTop;
  }

  /** The Markdown view kept out of sight is let go of: so is the copy of its text. */
  letGo(): void {
    cancelAnimationFrame(this.frame);
    cancelIdleCallback(this.idle);
    this.frame = this.idle = 0;
    this.want = none();
    this.rows.clear();
    this.placed = null;
    this.view = null;
    // Nor is anything worked out for the document as it was then kept (B6-R05).
    this.textWidth = -1;
    this.aligned = null;
    this.top = null;
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    cancelIdleCallback(this.idle);
    this.area.removeEventListener("scroll", this.onTextScroll);
    this.pane.removeEventListener("scroll", this.onPaneScroll);
    this.area.removeEventListener("input", this.onInput);
    this.area.removeEventListener("selectionchange", this.onSelection);
    this.area.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    this.sizes.disconnect();
    this.rows.layer.remove();
    this.placed = null;
    this.view = null;
  }

  // What the person does ----------------------------------------------------------

  private readonly onTextScroll = () => {
    if (Math.abs(this.area.scrollTop - this.textAt) < 0.5) return; // where Corillo put it
    this.want.text = true;
    this.later();
  };

  private readonly onPaneScroll = () => {
    if (Math.abs(this.pane.scrollTop - this.paneAt) < 0.5) return;
    this.want.preview = true;
    this.later();
  };

  private readonly onInput = () => {
    this.inputs++;
    this.lastInput = performance.now();
    this.typed = true;
    this.rows.dirty = true;
  };

  private readonly onSelection = () => {
    const { selectionStart, selectionEnd } = this.area;
    if (selectionStart === this.selection[0] && selectionEnd === this.selection[1]) return;
    this.selection = [selectionStart, selectionEnd];
    if (this.inputs !== this.inputsSeen) {
      // Moved by typing: the preview goes beside it once it has the typing.
      this.inputsSeen = this.inputs;
      return;
    }
    if (this.pressed) return;
    this.want.cursor = true;
    this.later();
  };

  private readonly onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    this.pressed = [...this.selection];
    window.addEventListener("mouseup", this.onMouseUp, { once: true });
  };

  private readonly onMouseUp = () => {
    const pressed = this.pressed;
    this.pressed = null;
    const { selectionStart, selectionEnd } = this.area;
    // Only if the cursor moved (not after dragging the scroll bar).
    if (pressed && pressed[0] === selectionStart && pressed[1] === selectionEnd) return;
    this.selection = [selectionStart, selectionEnd];
    this.want.cursor = true;
    this.later();
  };

  private readonly onSizes = (entries: ResizeObserverEntry[]) => {
    if (entries.some((entry) => entry.target === this.area)) this.rows.fitScrollbar();
    // Now, in the frame that shows the new sizes, so the halves never show apart.
    this.want.layout = true;
    this.run();
  };

  // The work ------------------------------------------------------------------------

  private later(): void {
    if (this.destroyed) return;
    this.frame ||= requestAnimationFrame(() => {
      this.frame = 0;
      this.run();
    });
  }

  /** Where each half is now, as what Corillo has seen. */
  private note(): void {
    this.textAt = this.area.scrollTop;
    this.paneAt = this.pane.scrollTop;
    this.selection = [this.area.selectionStart, this.area.selectionEnd];
    this.inputsSeen = this.inputs;
  }

  private visible(): boolean {
    return this.area.checkVisibility({ visibilityProperty: true }) && this.pane.clientHeight > 0;
  }

  /** Do what's wanted, once: follow whichever half moved, or put the preview beside the cursor or a place. */
  private run(extra: Want = none(), place?: { at: number; pos: number }): void {
    if (this.destroyed) return;
    const want = this.take(extra);
    if (!this.visible() || !this.host.preview()) return; // nothing laid out to measure; the view says when it's back
    if ((this.fresh || !this.rows.made) && !place && !want.text && !want.preview) {
      // Just shown, or the copy of the text still to make: when the window has a moment, not in the
      // frame that shows the view (on a long document that's a few milliseconds).
      for (const key of Object.keys(want) as (keyof Want)[]) this.want[key] ||= want[key];
      this.idle ||= requestIdleCallback(
        () => {
          this.idle = 0;
          if (this.destroyed || !this.visible()) return;
          this.fresh = false;
          this.rows.sync(() => this.host.oldMacText());
          this.run();
        },
        { timeout: 150 },
      );
      return;
    }
    this.fresh = false;
    if (this.host.stale()) {
      // Typing is still to come into the preview. Only the person scrolling a half, or a place to bring
      // into sight, brings it in now; otherwise the preview is lined up once it has the typing
      // (previewUpdated), and sizes changing meanwhile (as some do while typing) cost nothing.
      const now = place || want.preview || (want.text && performance.now() - this.lastInput >= TYPING_MS);
      if (!now) {
        if (want.text) this.textAt = this.area.scrollTop; // moved with the typing
        return;
      }
      this.host.settle();
      const more = this.take(none());
      for (const key of Object.keys(want) as (keyof Want)[]) want[key] ||= more[key];
    }
    if ((want.text || want.preview) && this.typed) {
      // The person scrolling beats lining the preview up beside what was typed: the half he's
      // scrolling is never pulled back (review of Batch 6, B6-R04).
      want.cursor = false;
      this.typed = false;
    }
    const g = this.measure();
    if (!g) return;
    this.refound = false;
    // The text wrapped anew since last time (a column's width or the zoom changed; the window may
    // have moved it to keep something in sight as it did): its top line goes back to the top first.
    const style = getComputedStyle(this.area);
    const width = this.area.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const rewrapped = width > 0 && this.textWidth > 0 && Math.abs(width - this.textWidth) > 0.5;
    if (width > 0) this.textWidth = width;
    if (rewrapped && !place) this.relayout(g, true);
    else if (place) this.beside(g, place.at, place.pos);
    else if (want.cursor) this.beside(g, this.head(), null);
    else if (want.text && !(want.preview && this.leader === "preview")) this.textMoved(g);
    else if (want.preview) this.previewMoved(g);
    else if (want.layout) this.relayout(g, false);
    this.keepTop();
  }

  /** What's wanted, and nothing more waiting for a frame. */
  private take(extra: Want): Want {
    const want = this.want;
    this.want = none();
    for (const key of Object.keys(want) as (keyof Want)[]) want[key] ||= extra[key];
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    return want;
  }

  private head(): number {
    return this.area.selectionDirection === "backward" ? this.area.selectionStart : this.area.selectionEnd;
  }

  private measure(): Geometry | null {
    const preview = this.host.preview();
    if (!preview) return null;
    this.rows.sync(() => this.host.oldMacText());
    this.placedFor(preview.view, preview.source);
    const area = this.area;
    const box = area.getBoundingClientRect();
    if (!area.offsetHeight || !box.height) return null;
    const z = box.height / area.offsetHeight;
    const paneBox = this.pane.getBoundingClientRect();
    const h = area.clientHeight * z;
    const textH = area.scrollHeight * z;
    const hp = this.pane.clientHeight;
    const previewH = this.pane.scrollHeight;
    return {
      z,
      s: area.scrollTop * z,
      h,
      textH,
      sMax: Math.max(0, textH - h),
      p: this.pane.scrollTop,
      hp,
      previewH,
      pMax: Math.max(0, previewH - hp),
      textTop: box.top + area.clientTop * z,
      paneTop: paneBox.top + this.pane.clientTop,
    };
  }

  /** The text moved: the preview follows. */
  private textMoved(g: Geometry): void {
    this.aligned = null;
    const from = this.textAt * g.z;
    if (this.leader !== "text") {
      this.offset = this.textOffset;
      this.leader = "text";
    }
    this.offset = fade(this.offset, from, g.s, g.sMax, g.h);
    const base = this.fromText(g.s, g);
    let p = clamp(base + this.offset, 0, g.pMax);
    // Never against the way the text moved.
    if ((g.s > from && p < g.p) || (g.s < from && p > g.p)) p = clamp(g.p, 0, g.pMax);
    this.offset = p - base;
    this.textAt = this.area.scrollTop;
    this.setPane(p);
  }

  /** The preview moved: the text follows. */
  private previewMoved(g: Geometry): void {
    this.aligned = null;
    const from = this.paneAt;
    if (this.leader !== "preview") {
      this.offset = g.s - this.fromPreview(from, g);
      this.leader = "preview";
    }
    this.offset = fade(this.offset, from, g.p, g.pMax, g.hp);
    const base = this.fromPreview(g.p, g);
    let s = clamp(base + this.offset, 0, g.sMax);
    if ((g.p > from && s < g.s) || (g.p < from && s > g.s)) s = clamp(g.s, 0, g.sMax);
    this.offset = s - base;
    this.paneAt = this.pane.scrollTop;
    this.setText(s, g);
    // How the text leading would have it, for when sizes change.
    this.textOffset = g.p - this.fromText(this.area.scrollTop * g.z, g);
  }

  /**
   * Sizes changed (a picture or diagram came in, the window or a column was
   * resized, the zoom, a new version): the text stays, and the preview lines
   * up with it again, so what the person was reading in it stays put too.
   */
  private relayout(g: Geometry, rewrapped: boolean): void {
    if (this.leader === "preview") {
      this.offset = this.textOffset;
      this.leader = "text";
    }
    if (rewrapped && this.top && g.s > 0) {
      // The text wrapped anew: the line that was at its top stays there.
      const { row, into } = this.top;
      const top = this.rows.top(row);
      this.setText(clamp((top + into * (this.rows.top(row + 1) - top)) * g.z, 0, g.sMax), g);
      g.s = this.area.scrollTop * g.z;
    }
    const aligned = this.aligned;
    if (aligned === "cursor") return this.beside(g, this.head(), null);
    if (aligned && aligned.doc === this.placed?.doc) return this.beside(g, aligned.at, aligned.pos);
    this.aligned = null;
    this.setPane(clamp(this.fromText(g.s, g) + this.offset, 0, g.pMax));
    this.textAt = this.area.scrollTop;
  }

  /**
   * The preview beside a place in the text that's in sight: the cursor, or a
   * place Corillo brought into sight (`pos`, that place in the document).
   * Its result at the same height, as far as the ends allow, and in sight.
   */
  private beside(g: Geometry, at: number, pos: number | null): void {
    this.typed = false;
    this.leader = "text";
    const y = this.rows.caretTop(at) * g.z;
    const lineHeight = (parseFloat(getComputedStyle(this.area).lineHeight) || 22) * g.z;
    const v = y - g.s;
    const base = this.fromText(g.s, g);
    if (v + lineHeight <= 0 || v >= g.h) {
      // Not in sight: the preview just follows the text.
      this.aligned = null;
      this.setPane(clamp(base + this.offset, 0, g.pMax));
      this.textAt = this.area.scrollTop;
      return;
    }
    let shown = this.toPreview(y, g);
    let shownEnd = Math.max(shown, this.toPreview(y + lineHeight, g));
    if (pos !== null) {
      const exact = this.previewTopOf(pos, g);
      if (exact !== null) [shown, shownEnd] = [exact, exact + lineHeight];
    }
    // At the same height; near either end, no further from where the tie puts it than the text is from that end.
    const same = shown - (g.textTop - g.paneTop) - v;
    const room = Math.min(g.s, g.sMax - g.s);
    let p = base + clamp(same - base, -room, room);
    const margin = Math.min(48, g.hp / 6);
    if (shownEnd + margin > p + g.hp) p = shownEnd + margin - g.hp;
    if (shown - margin < p) p = shown - margin;
    p = clamp(p, 0, g.pMax);
    this.offset = p - base;
    this.aligned = pos === null ? "cursor" : { at, pos, doc: this.placed!.doc };
    this.textAt = this.area.scrollTop;
    this.setPane(p);
  }

  private setPane(p: number): void {
    if (Math.abs(this.pane.scrollTop - p) >= 0.5) this.pane.scrollTop = p;
    this.paneAt = this.pane.scrollTop;
  }

  private setText(s: number, g: Geometry): void {
    if (Math.abs(this.area.scrollTop * g.z - s) >= 0.5) this.area.scrollTop = s / g.z;
    this.textAt = this.area.scrollTop;
  }

  /** The line at the top of the text, to keep it there if the text wraps anew. */
  private keepTop(): void {
    const y = this.area.scrollTop;
    const row = this.rows.rowAt(y);
    const top = this.rows.top(row);
    const height = this.rows.top(row + 1) - top;
    this.top = { row, into: height > 0 ? clamp((y - top) / height, 0, 1) : 0 };
  }

  // From one half to the other ----------------------------------------------------

  /** Where the preview goes for the text at `s`: what's at the same share of each window down is the same place. */
  private fromText(s: number, g: Geometry): number {
    const r = share(s, g.sMax, g.h);
    return this.toPreview(s + r * g.h, g) - r * g.hp;
  }

  private fromPreview(p: number, g: Geometry): number {
    const r = share(p, g.pMax, g.hp);
    return this.toText(p + r * g.hp, g) - r * g.h;
  }

  /** The top of a file line in the text (its scrolling area, on screen). */
  private textY(line: number, g: Geometry): number {
    return this.rows.top(this.rows.rowOf(line)) * g.z;
  }

  /** A height in the text (its scrolling area, on screen) to the same place in the preview. */
  private toPreview(ty: number, g: Geometry): number {
    const placed = this.placed!;
    const count = placed.line.length;
    if (!count || !this.rows.count) return g.textH > 0 ? (ty / g.textH) * g.previewH : 0;
    const first = this.textY(placed.line[0], g);
    if (ty <= first) return across(ty, 0, first, 0, this.edge(0, "top", g));
    const line = this.rows.lineOf(this.rows.rowAt(ty / g.z));
    const j = Math.max(0, lastAtMost(count, (i) => placed.line[i], line));
    const ties = this.tiesOf(j);
    const t = Math.max(0, lastAtMost(ties.length, (i) => ties[i].line, line));
    const a = ties[t];
    const aY = this.textY(a.line, g);
    const aP = this.tieY(a, j, g);
    if (t + 1 < ties.length) return across(ty, aY, this.textY(ties[t + 1].line, g), aP, this.tieY(ties[t + 1], j, g));
    if (j + 1 < count) return across(ty, aY, this.textY(placed.line[j + 1], g), aP, this.edge(j + 1, "top", g));
    return across(ty, aY, g.textH, aP, g.previewH);
  }

  /** A height in the preview (its scrolling area) to the same place in the text, on screen. */
  private toText(py: number, g: Geometry): number {
    const placed = this.placed!;
    const count = placed.line.length;
    if (!count || !this.rows.count) return g.previewH > 0 ? (py / g.previewH) * g.textH : 0;
    const first = this.edge(0, "top", g);
    if (py <= first) return across(py, 0, first, 0, this.textY(placed.line[0], g));
    const j = Math.max(0, lastAtMost(count, (i) => this.edge(i, "top", g), py));
    const ties = this.tiesOf(j);
    const t = Math.max(0, lastAtMost(ties.length, (i) => this.tieY(ties[i], j, g), py));
    const a = ties[t];
    const aY = this.textY(a.line, g);
    const aP = this.tieY(a, j, g);
    if (t + 1 < ties.length) return across(py, aP, this.tieY(ties[t + 1], j, g), aY, this.textY(ties[t + 1].line, g));
    if (j + 1 < count) return across(py, aP, this.edge(j + 1, "top", g), aY, this.textY(placed.line[j + 1], g));
    return across(py, aP, g.previewH, aY, g.textH);
  }

  // The preview's document, read for the tie ---------------------------------------

  private placedFor(view: EditorView, source: Source): void {
    const doc = view.state.doc;
    this.view = view;
    if (this.placed?.doc === doc && this.placed.source === source) return;
    const starts = blockStarts(doc, source);
    const placed: Placed = { doc, source, k: [], pos: [], line: [], end: [], text: [], els: [], ties: new Map() };
    doc.forEach((_node, pos, k) => {
      const line = starts.line[k];
      const text = starts.text[k];
      if (line === null || text === null) return;
      placed.k.push(k);
      placed.pos.push(pos);
      placed.line.push(line);
      placed.end.push(line + lineBreaks(text) + 1);
      placed.text.push(text);
    });
    this.placed = placed;
    this.findElements();
  }

  /** Each written block's element in the preview, in one pass over the preview's own. */
  private findElements(): void {
    const placed = this.placed!;
    const view = this.view!;
    const doc = placed.doc;
    const byIndex: (HTMLElement | null)[] = new Array(doc.childCount).fill(null);
    const docDesc = (view.dom as unknown as { pmViewDesc?: unknown }).pmViewDesc;
    let k = 0;
    for (const child of view.dom.children) {
      const desc = (child as unknown as { pmViewDesc?: { node?: Node; parent?: unknown } }).pmViewDesc;
      if (!desc?.node || desc.parent !== docDesc) continue;
      while (k < doc.childCount && doc.child(k) !== desc.node) k++;
      if (k >= doc.childCount) break;
      byIndex[k++] = child as HTMLElement;
    }
    placed.els = placed.k.map((i, j) => byIndex[i] ?? (view.nodeDOM(placed.pos[j]) as HTMLElement | null));
  }

  /** Block j's element; found again if the preview drew it anew (once in a piece of work). */
  private elementOf(j: number): HTMLElement | null {
    const placed = this.placed!;
    let el = placed.els[j];
    if (el && !el.isConnected && !this.refound) {
      this.refound = true;
      this.findElements();
      el = placed.els[j];
    }
    return el?.isConnected ? el : null;
  }

  /**
   * A written block's top or bottom in the preview: its top where its words
   * start (below a heading's own space above them), its bottom at its edge. A
   * block not shown takes the place where the next shown one starts.
   */
  private edge(j: number, which: "top" | "bottom", g: Geometry): number {
    const placed = this.placed!;
    for (let i = j; i < placed.line.length; i++) {
      const el = this.elementOf(i);
      if (!el) continue;
      const box = el.getBoundingClientRect();
      if (!box.height && !box.width) continue;
      if (i === j && which === "bottom") return box.bottom - g.paneTop + g.p;
      const style = getComputedStyle(el);
      const above = ((parseFloat(style.paddingTop) || 0) + (parseFloat(style.borderTopWidth) || 0)) * el.currentCSSZoom;
      return box.top + Math.min(above, box.height) - g.paneTop + g.p;
    }
    return g.previewH;
  }

  /** Each written block's places: its top, its parts and lines, and its bottom when blank lines follow it. */
  private tiesOf(j: number): Tie[] {
    const placed = this.placed!;
    const known = placed.ties.get(j);
    if (known) return known;
    const node = placed.doc.child(placed.k[j]);
    const ties: Tie[] = [{ line: placed.line[j], pos: placed.pos[j], kind: "top" }];
    // A diagram shows a picture, not its lines.
    if (!this.elementOf(j)?.classList.contains("diagram")) {
      for (const m of blockMarks(node, placed.text[j])) {
        if (m.kind !== "block" && m.kind !== "line") continue;
        if (m.kind === "block" && m.from === 0) continue;
        const line = placed.line[j] + m.line;
        if (line <= ties[ties.length - 1].line || line >= placed.end[j]) continue;
        ties.push({ line, pos: placed.pos[j] + m.from, kind: m.kind });
      }
    }
    const next = j + 1 < placed.line.length ? placed.line[j + 1] : Infinity;
    if (placed.end[j] < next) ties.push({ line: placed.end[j], pos: placed.pos[j], kind: "bottom" });
    placed.ties.set(j, ties);
    return ties;
  }

  /** Where a place of block j is in the preview (its scrolling area). */
  private tieY(tie: Tie, j: number, g: Geometry): number {
    if (tie.kind === "top") return this.edge(j, "top", g);
    if (tie.kind === "bottom") return Math.max(this.edge(j, "top", g), this.edge(j, "bottom", g));
    return this.innerTop(tie, j, g) ?? this.edge(j, "top", g);
  }

  /** A part or line inside block j, found from the block's own drawing (not from the document's start, which takes longer on a long one). */
  private innerTop(tie: Tie, j: number, g: Geometry): number | null {
    const el = this.elementOf(j);
    const desc = (el as unknown as { pmViewDesc?: InnerDesc } | null)?.pmViewDesc;
    const rel = tie.pos - this.placed!.pos[j] - 1;
    try {
      if (tie.kind === "block") {
        const dom = desc?.descAt?.(rel)?.dom ?? this.view?.nodeDOM(tie.pos);
        if (!(dom instanceof Element)) return null;
        return dom.getBoundingClientRect().top - g.paneTop + g.p;
      }
      const at = desc?.domFromPos?.(rel, 1);
      if (at) {
        const range = document.createRange();
        if (at.node.nodeType === 3) {
          range.setStart(at.node, at.offset);
          range.setEnd(at.node, Math.min(at.offset + 1, (at.node as Text).length));
        } else range.selectNode(at.node.childNodes[at.offset] ?? at.node);
        const box = range.getClientRects()[0] ?? range.getBoundingClientRect();
        if (box.height || box.width) return box.top - g.paneTop + g.p;
      }
      const coords = this.view?.coordsAtPos(tie.pos);
      return coords ? coords.top - g.paneTop + g.p : null;
    } catch {
      return null;
    }
  }

  /** The top of the document's place `pos` in the preview (its scrolling area). */
  private previewTopOf(pos: number, g: Geometry): number | null {
    try {
      const coords = this.view?.coordsAtPos(pos);
      return coords ? coords.top - g.paneTop + g.p : null;
    } catch {
      return null;
    }
  }
}

/** What the tie reads from the preview's drawing of a block (prosemirror-view's own, looked up from the block's element). */
interface InnerDesc {
  descAt?(pos: number): { dom?: globalThis.Node } | undefined;
  domFromPos?(pos: number, side: number): { node: globalThis.Node; offset: number };
}
