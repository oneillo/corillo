// Finding your place in a table written as Markdown text. A big table as text
// is a wall of pipes, so the cell the cursor is in gets a light highlight and
// its row a fainter one, following the cursor. Shown in the formatted view for
// a table kept as Markdown text, and in the Markdown view's text. Only the
// cursor's row is ever marked, so a 500-row table stays quick, and the marks
// never change the text or how it's laid out.
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { tableSpotAt, type TableSpot } from "../core/place";

const ROW = "md-table-row";
const CELL = "md-table-cell";

// The formatted view ----------------------------------------------------------------

const key = new PluginKey<DecorationSet>("table-text-cell");

function decorate(state: EditorState): DecorationSet {
  const { $head } = state.selection;
  const block = $head.parent;
  if (block.type.name !== "raw_block") return DecorationSet.empty;
  const spot = tableSpotAt(block.textContent, $head.parentOffset);
  if (!spot) return DecorationSet.empty;
  const start = $head.start();
  const marks = [Decoration.inline(start + spot.lineFrom, start + spot.lineTo, { class: ROW })];
  if (spot.cellTo > spot.cellFrom) marks.push(Decoration.inline(start + spot.cellFrom, start + spot.cellTo, { class: CELL }));
  return DecorationSet.create(state.doc, marks);
}

/** Highlights the cell and row the cursor is in, in a table kept as Markdown text. */
export function tableTextPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_config, state) => decorate(state),
      apply: (tr, old, _before, state) => (tr.docChanged || tr.selectionSet ? decorate(state) : old),
    },
    props: {
      decorations: (state) => key.getState(state),
    },
  });
}

// The Markdown view ------------------------------------------------------------------

// A text area can't colour parts of its text, so the marks are drawn on a layer
// behind it holding the same text, set the same way (as Find does). The layer
// holds the text only up to the end of the cursor's row: what comes after
// can't move it. The text above the row is a block of its own, set again only
// when it changes, so typing in a row near the end of a long document doesn't
// lay out everything above it on every key.
const COPIED = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "wordSpacing", "tabSize",
  "textIndent", "textTransform", "paddingTop", "paddingLeft", "paddingRight", "whiteSpace", "overflowWrap", "wordBreak",
] as const;

/** Ends the text above the row, so its last line counts even when it's empty. */
const LAST_LINE = String.fromCharCode(0x200b);

export class TextCellHighlight {
  private readonly layer: HTMLElement;
  private readonly text: HTMLElement;
  /** The text above the cursor's row, and the row itself. */
  private readonly above: HTMLElement;
  private readonly rowLine: HTMLElement;
  /** What `above` holds, or null when it must be set again. */
  private aboveText: string | null = null;
  private frame = 0;
  private shown: { value: string; spot: TableSpot } | null = null;
  private readonly resize = new ResizeObserver(() => {
    this.shown = null;
    this.schedule();
  });

  constructor(private readonly textarea: HTMLTextAreaElement) {
    this.layer = document.createElement("div");
    this.layer.className = "cell-marks";
    this.layer.setAttribute("aria-hidden", "true");
    this.layer.hidden = true;
    this.text = document.createElement("div");
    this.text.className = "cell-marks-text";
    this.above = document.createElement("div");
    this.rowLine = document.createElement("div");
    this.rowLine.style.textIndent = "0"; // the text area's first line only
    this.layer.append(this.text);
    textarea.before(this.layer);
    const later = () => this.schedule();
    for (const event of ["selectionchange", "select", "input", "keyup", "mouseup", "focus"]) textarea.addEventListener(event, later);
    textarea.addEventListener("scroll", () => this.follow());
    this.resize.observe(textarea);
  }

  /** Check where the cursor is again, after the text or the cursor changed. */
  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  }

  /** The cell and row being marked, if any (for tests and the status bar). */
  get spot(): TableSpot | null {
    return this.layer.hidden ? null : (this.shown?.spot ?? null);
  }

  update(): void {
    const ta = this.textarea;
    if (!ta.checkVisibility({ visibilityProperty: true })) return this.clear(); // out of sight
    const value = ta.value;
    const head = ta.selectionDirection === "backward" ? ta.selectionStart : ta.selectionEnd;
    const spot = tableSpotAt(value, head);
    if (!spot) return this.clear();
    const same =
      this.shown &&
      this.shown.value === value &&
      this.shown.spot.lineFrom === spot.lineFrom &&
      this.shown.spot.cellFrom === spot.cellFrom &&
      this.shown.spot.cellTo === spot.cellTo;
    const sameRow = !!this.shown && this.shown.spot.lineFrom === spot.lineFrom;
    if (!same) this.draw(value, spot);
    this.shown = { value, spot };
    this.layer.hidden = false;
    this.place(!sameRow);
    ta.classList.add("cell-lit");
    this.follow();
  }

  private draw(value: string, spot: TableSpot): void {
    if (this.above.parentNode !== this.text) {
      this.text.replaceChildren(this.above, this.rowLine);
      this.aboveText = null;
    }
    // The row starts a line, so the text above it ends with a line break: the
    // block above holds the text up to that break, and the row starts below it.
    const above = spot.lineFrom ? value.slice(0, spot.lineFrom - 1) + LAST_LINE : "";
    if (above !== this.aboveText) {
      this.above.textContent = above;
      this.aboveText = above;
    }
    const row = document.createElement("span");
    row.className = ROW;
    const cell = document.createElement("span");
    cell.className = CELL;
    cell.textContent = value.slice(spot.cellFrom, spot.cellTo);
    row.append(value.slice(spot.lineFrom, spot.cellFrom), cell, value.slice(spot.cellTo, spot.lineTo));
    this.rowLine.replaceChildren(row);
  }

  /**
   * Lay the layer over the text area, its text set exactly like the text
   * area's. The type is copied when the row changes (typing in a row keeps it).
   */
  private place(copyType = true): void {
    const ta = this.textarea;
    const parent = this.layer.offsetParent as HTMLElement | null;
    if (!parent) return;
    const box = ta.getBoundingClientRect();
    const around = parent.getBoundingClientRect();
    Object.assign(this.layer.style, {
      left: `${box.left - around.left + parent.scrollLeft}px`,
      top: `${box.top - around.top + parent.scrollTop}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
    const style = getComputedStyle(ta);
    if (copyType) for (const name of COPIED) this.text.style[name] = style[name];
    const left = parseFloat(style.paddingLeft);
    const right = parseFloat(style.paddingRight);
    this.text.style.paddingLeft = "0";
    this.text.style.paddingRight = "0";
    this.text.style.marginLeft = `${ta.clientLeft + left}px`;
    this.text.style.marginTop = `${ta.clientTop}px`;
    this.text.style.width = `${ta.clientWidth - left - right}px`;
  }

  private follow(): void {
    if (!this.layer.hidden) this.text.style.transform = `translateY(${-this.textarea.scrollTop}px)`;
  }

  private clear(): void {
    if (this.layer.hidden) return;
    this.layer.hidden = true;
    this.text.replaceChildren();
    this.aboveText = null;
    this.shown = null;
    this.textarea.classList.remove("cell-lit");
  }

  /**
   * Scroll the text area so the cursor is in sight, a third of the way down
   * if it has to move (setting the cursor doesn't scroll a text area).
   */
  revealCursor(): void {
    const ta = this.textarea;
    if (!ta.checkVisibility({ visibilityProperty: true })) return;
    const value = ta.value;
    const at = ta.selectionDirection === "backward" ? ta.selectionStart : ta.selectionEnd;
    const marker = document.createElement("span");
    marker.textContent = "\u200B";
    this.text.replaceChildren(value.slice(0, at), marker);
    this.aboveText = null;
    const wasHidden = this.layer.hidden;
    this.layer.hidden = false;
    this.place();
    this.text.style.transform = "";
    const scale = ta.offsetHeight ? ta.getBoundingClientRect().height / ta.offsetHeight : 1;
    const y = (marker.getBoundingClientRect().top - this.text.getBoundingClientRect().top) / (scale || 1);
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    const top = y + parseFloat(getComputedStyle(ta).paddingTop);
    if (top < ta.scrollTop || top + lineHeight > ta.scrollTop + ta.clientHeight) {
      ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
    }
    this.layer.hidden = wasHidden;
    this.shown = null;
    this.update();
  }

  destroy(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.layer.remove();
  }
}
