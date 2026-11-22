// Comments' words in the Markdown view's text. A text area can't colour parts
// of its text, so the marks are drawn on a layer behind it holding a copy of
// the text, invisible and set exactly the same way, one line per line, which
// the style sheet scrolls with the text (as it does the line numbers). The
// marks never change the text or how it's laid out.
//
// Typing moves each mark along with its words straight away, and only the
// lines typed in are drawn again, so typing stays quick however many
// comments there are. A moment after typing stops, the document says
// exactly where each comment is again (doc-tab-markdown.ts, placeMarks).
import { mapMark, markAt, pieces, textEdit, type SourceMark } from "../core/source-marks";
import { roundLikeTheText } from "./line-numbers";

export class SourceMarks {
  private readonly layer: HTMLElement;
  private readonly lines: HTMLElement;
  private marks: SourceMark[] = [];
  /** The text the marks are placed in. */
  private value = "";
  /** The text of each line in the copy, and how its marks were drawn. */
  private text: string[] = [];
  private keys: string[] = [];
  private readonly sizes: ResizeObserver;
  private readonly unround: () => void;

  constructor(private readonly area: HTMLTextAreaElement) {
    this.layer = document.createElement("div");
    this.layer.className = "source-marks";
    this.layer.setAttribute("aria-hidden", "true");
    this.layer.hidden = true;
    this.lines = document.createElement("div");
    this.lines.className = "source-marks-lines";
    this.layer.append(this.lines);
    area.before(this.layer);
    area.addEventListener("input", () => this.typed());
    // A scroll bar takes room from the text, so the copy leaves the same room.
    this.sizes = new ResizeObserver(() => this.fitScrollbar());
    this.sizes.observe(area);
    this.unround = roundLikeTheText(this.lines);
  }

  /** Where each comment's words are in the text now (from the document). */
  set(marks: SourceMark[]): void {
    this.marks = marks;
    this.value = this.area.value;
    this.draw();
  }

  /** Another comment came into focus while the person was typing: draw it so, until the document places them all again. */
  restyle(inFocus: (id: string) => boolean): void {
    let changed = false;
    this.marks = this.marks.map((m) => {
      if (m.kind === "change") return m;
      const kind = inFocus(m.id) ? "active" : "comment";
      if (kind === m.kind) return m;
      changed = true;
      return { ...m, kind };
    });
    if (changed) this.draw();
  }

  /** The comment whose words are at this place in the text, if any. */
  at(offset: number): string | null {
    return markAt(this.marks, offset);
  }

  /** The person typed: each mark moves with its words, and the lines typed in are drawn again. */
  private typed(): void {
    const next = this.area.value;
    if (!this.marks.length) {
      this.value = next;
      return;
    }
    const edit = textEdit(this.value, next);
    this.value = next;
    if (!edit) return;
    const moved: SourceMark[] = [];
    for (const m of this.marks) {
      const kept = mapMark(m, edit);
      if (kept) moved.push(kept);
    }
    this.marks = moved;
    this.draw();
  }

  /** Bring the copy up to date: only lines whose text or marks changed are written again. */
  private draw(): void {
    const show = this.marks.length > 0;
    this.layer.hidden = !show;
    this.area.classList.toggle("marked", show);
    if (!show) {
      if (this.text.length) this.lines.replaceChildren();
      this.text = [];
      this.keys = [];
      return;
    }
    const lines = this.value.split("\n");
    const { keys, starts } = this.lineKeys(lines);
    const old = this.text;
    const oldKeys = this.keys;
    const rows = this.lines.children;
    const same = (a: number, b: number) => old[a] === lines[b] && oldKeys[a] === keys[b];
    let start = 0;
    const shortest = Math.min(old.length, lines.length);
    while (start < shortest && same(start, start)) start++;
    let oldEnd = old.length;
    let newEnd = lines.length;
    while (oldEnd > start && newEnd > start && same(oldEnd - 1, newEnd - 1)) {
      oldEnd--;
      newEnd--;
    }
    const rewritten = Math.min(oldEnd, newEnd);
    for (let i = start; i < rewritten; i++) this.fill(rows[i] as HTMLElement, lines[i], starts[i], keys[i]);
    for (let i = oldEnd - 1; i >= rewritten; i--) rows[i].remove();
    if (newEnd > rewritten) {
      const added = document.createDocumentFragment();
      for (let i = rewritten; i < newEnd; i++) {
        const row = document.createElement("div");
        this.fill(row, lines[i], starts[i], keys[i]);
        added.append(row);
      }
      this.lines.insertBefore(added, rows[rewritten] ?? null);
    }
    this.text = lines;
    this.keys = keys;
  }

  /** Each line's start, and a short description of its marks ("" for none), in one pass. */
  private lineKeys(lines: string[]): { keys: string[]; starts: number[] } {
    const sorted = [...this.marks].sort((a, b) => a.from - b.from);
    const keys: string[] = new Array(lines.length);
    const starts: number[] = new Array(lines.length);
    let open: SourceMark[] = [];
    let next = 0;
    let at = 0;
    for (let i = 0; i < lines.length; i++) {
      const from = at;
      const to = at + lines[i].length;
      starts[i] = from;
      while (next < sorted.length && sorted[next].from < to) open.push(sorted[next++]);
      if (open.length) open = open.filter((m) => m.to > from);
      let key = "";
      for (const m of open) {
        if (m.from >= to) continue;
        key += `${Math.max(0, m.from - from)}-${Math.min(to, m.to) - from}${m.kind[0]}${m.id};`;
      }
      keys[i] = key;
      at = to + 1;
    }
    return { keys, starts };
  }

  private fill(row: HTMLElement, line: string, start: number, key: string): void {
    if (!key) {
      row.textContent = line;
      return;
    }
    const over = this.marks.filter((m) => m.from < start + line.length && m.to > start);
    const parts: (string | HTMLElement)[] = [];
    for (const p of pieces(start, start + line.length, over)) {
      const words = line.slice(p.from - start, p.to - start);
      if (!p.kind) {
        parts.push(words);
        continue;
      }
      const mark = document.createElement("mark");
      mark.className = p.kind;
      mark.dataset.comment = p.id ?? "";
      mark.textContent = words;
      parts.push(mark);
    }
    row.replaceChildren(...parts);
  }

  private fitScrollbar(): void {
    const scrollbar = this.area.offsetWidth - this.area.clientWidth - 1; // less the right border
    this.lines.style.paddingRight = scrollbar > 0 ? `${parseFloat(getComputedStyle(this.area).paddingRight) + scrollbar}px` : "";
  }

  /**
   * Scroll the text so a place in it is in sight, a third of the way down if
   * it has to move. The copy, laid out like the text, says where it is.
   */
  reveal(offset: number): void {
    const area = this.area;
    if (!area.checkVisibility({ visibilityProperty: true })) return; // out of sight
    if (this.value !== area.value) this.typed(); // the text was set without typing
    const borrowed = this.layer.hidden;
    if (borrowed) {
      // No marks drawn: lay out a copy just to measure, then put it away.
      this.value = area.value;
      this.text = [];
      this.keys = [];
      this.lines.replaceChildren(...this.value.split("\n").map((line) => {
        const row = document.createElement("div");
        row.textContent = line;
        return row;
      }));
      this.layer.hidden = false;
    }
    this.fitScrollbar();
    const before = this.value.slice(0, Math.max(0, Math.min(offset, this.value.length)));
    const index = before.split("\n").length - 1;
    const row = this.lines.children[index] as HTMLElement | undefined;
    if (row) {
      const column = before.length - (before.lastIndexOf("\n") + 1);
      const line = row.textContent ?? "";
      const marker = document.createElement("span");
      marker.textContent = "\u200B";
      const kept = [...row.childNodes];
      row.replaceChildren(line.slice(0, column), marker, line.slice(column));
      const scale = area.offsetHeight ? area.getBoundingClientRect().height / area.offsetHeight : 1;
      const y = (marker.getBoundingClientRect().top - this.lines.getBoundingClientRect().top) / (scale || 1);
      row.replaceChildren(...kept);
      const lineHeight = parseFloat(getComputedStyle(area).lineHeight) || 22;
      if (y < area.scrollTop + 8 || y + lineHeight > area.scrollTop + area.clientHeight - 8) {
        area.scrollTop = Math.max(0, y - area.clientHeight / 3);
      }
    }
    if (borrowed) {
      this.layer.hidden = true;
      this.lines.replaceChildren();
    }
  }

  destroy(): void {
    this.sizes.disconnect();
    this.unround();
    this.layer.remove();
  }
}
