// The Markdown view of an open document: its text, the preview beside it, and the document kept up to date with the text as it's typed.
import { EditorState, Plugin, type Transaction } from "prosemirror-state";
import { DecorationSet, EditorView } from "prosemirror-view";
import type { Node } from "prosemirror-model";
import { closeHistory } from "prosemirror-history";
import { anchorIn, locate } from "../core/anchors";
import { serializeMarkdown, type Source } from "../core/markdown";
import type { TextChange } from "../core/smallest-edit";
import { forgetText, keepOwnUndo } from "./undo-resolve";
import { parseCached } from "./parse-cache";
import { forTextArea, fromTextArea } from "../core/text-area";
import { TextCellHighlight } from "./table-highlight";
import { docRange, markdownPlace, viewText, type Span } from "../core/place";
import { mapPlace, textEdit, type SourceMark } from "../core/source-marks";
import { SourceMarks } from "./source-marks";
import { commentRanges, rangeAt, withRanges, DRAFT } from "./comments";
import { changeMarks, present } from "./change-marks";
import { footnotePlugin } from "./footnotes";
import { copiedHere, copyPlugin } from "./copy";
import type { PictureStore } from "./images";
import { picturesInText, tooManyWaiting, WAITING_TYPE, waitAsOnClipboard } from "./paste";
import type { Mode } from "./toolbar";
import { TEXT_HISTORY, type DocComments } from "./comments-panel";
import { splitHandle } from "./columns";
import { SourceGutter } from "./line-numbers";
import { ScrollTogether } from "./scroll-together";
import { blankLinesPlugin } from "./blank-lines";
import { addressOfLinkIn } from "./link-labels";
import { markAsFromTheText, MATCHES_ONE_BY_ONE, readAs, replaceChanged, replaceMatches } from "./doc-tab-edits";
import { followText, mapOffset, sameFrom, shifted } from "./doc-tab-place";
import { elWith } from "./el-with";


const PREVIEW_DELAY_MS = 200;

/** What the Markdown view uses of the tab it's in. */
export interface MarkdownTab {
  readonly view: EditorView;
  source: Source;
  readonly mode: Mode;
  readonly comments: DocComments;
  readonly onPersonEdit: (() => void) | null;
  /** The document's pictures: which web pictures wait, and how more come to (images.ts). */
  readonly store: PictureStore;
  personEdited(): void;
  scheduleSave(): void;
  dispatch(tr: Transaction): void;
  nodeViews(): ConstructorParameters<typeof EditorView>[1]["nodeViews"];
  obsidian(forPreview: boolean): Plugin;
  openLink(href: string): void;
  countWords(): void;
  /** The tab's state, words or save status changed: the window hears of it. */
  changed(): void;
}

export class MarkdownView {
  preview: EditorView | null = null;
  previewTimer: ReturnType<typeof setTimeout> | null = null;
  /** The Markdown view kept out of sight is about to be let go of (unkeepMarkdown). */
  private unkeeping = false;
  /** The exact text put in the Markdown view's text area. */
  private sourceShown = "";
  /** In the Markdown view: the text the formatted editor's document was last brought up to date with. */
  modelText = "";
  /** Where each block of the editor's document is in the Markdown view's text, while they match. */
  placed: { doc: Node; text: string; spans: Span[] } | null = null;
  /** The Markdown view's typing, joined into one step for Undo in the formatted view. */
  typingGroup: number | null = null;
  private typingGroups = 0;
  /** The Markdown text as last typed, and the stretch of it typed since the document last caught up. */
  private typedValue = "";
  private typedRegion: { from: number; to: number } | null = null;
  /**
   * The document as it was on coming to the Markdown view, until the text is
   * first typed in: it may hold what the text doesn't say (see syncModel).
   */
  unread: Node | null = null;
  /**
   * A change to the Markdown text about to come in that the document should
   * follow place by place, not as one stretch: Replace All (see replacingAll),
   * or an agent's option the person chose (applyAsTyped). `build` adds its
   * steps to a transaction from `doc`, for the text `text`.
   */
  replacing: { doc: Node; text: string; build: (tr: Transaction) => Transaction | null } | null = null;
  /**
   * The last such change in the Markdown text (Replace All, an option) that
   * changed the document place by place: the text before and after, its steps
   * and theirs undone, and the document as it left it. The text's own Undo and
   * Redo of it then reach the document place by place too (see syncModel).
   * Kept until the next one, or until leaving the Markdown view.
   */
  replacedAll: { before: string; after: string; steps: Transaction["steps"]; undo: Transaction["steps"]; done: boolean; doc: Node } | null = null;
  /** In the Markdown view, where words were last selected: the text or the preview. */
  private pickedIn: "text" | "preview" = "text";
  readonly markdownEl: HTMLElement;
  readonly sourceEl: HTMLTextAreaElement;
  private readonly previewEl: HTMLElement;
  readonly previewPane: HTMLElement;
  /** In the Markdown view, comments' words in the text. */
  readonly sourceMarks: SourceMarks;
  /** In the Markdown view, the table cell the cursor is in. */
  readonly textCells: TextCellHighlight;
  /** Stops laying out the Markdown view's two halves, once the tab closes. */
  readonly stopSplit: () => void;
  /** The Markdown view's line numbers (View > Line Numbers). */
  readonly gutter: SourceGutter;
  /** In the Markdown view, the text and the preview move together. */
  readonly together: ScrollTogether;

  constructor(private readonly tab: MarkdownTab) {
    this.markdownEl = elWith("main", "split");
    this.markdownEl.hidden = true;
    this.sourceEl = elWith("textarea", "source", { "aria-label": "Markdown text", spellcheck: "false" });
    keepOwnUndo(this.sourceEl); // Undo in the text acts on the text, whatever else has typing (undo-resolve.ts)
    const pane = elWith("div", "preview-pane");
    this.previewPane = pane;
    this.previewEl = elWith("article", "page preview", { "aria-label": "Preview" });
    pane.append(this.previewEl);
    // The line between the two can be dragged to share the width differently.
    const split = splitHandle(this.markdownEl);
    this.stopSplit = split.dispose;
    this.markdownEl.append(this.sourceEl, pane, split.line);
    this.sourceMarks = new SourceMarks(this.sourceEl);
    this.textCells = new TextCellHighlight(this.sourceEl);
    // Words selected in the text or in the preview can be commented on: New
    // Comment uses the one the person last selected in. Clicking a comment's
    // words, or moving the cursor into them, puts it in focus.
    this.sourceEl.addEventListener("focus", () => (this.pickedIn = "text"));
    pane.addEventListener("mousedown", () => (this.pickedIn = "preview"));
    const markAtCursor = (): string | null | undefined => {
      const { selectionStart, selectionEnd } = this.sourceEl;
      return selectionStart === selectionEnd ? this.sourceMarks.at(selectionStart) : undefined;
    };
    this.sourceEl.addEventListener("click", () => {
      const id = markAtCursor();
      if (id) this.comments.textClicked(id);
      else if (id === null) this.comments.cursorIn(null);
    });
    this.sourceEl.addEventListener("keyup", () => {
      const id = markAtCursor();
      if (id !== undefined) this.comments.cursorIn(id);
    });
    // Tab types a tab here, as in any text editor, instead of sending the
    // keyboard out of the text (one Undo takes it back out).
    this.sourceEl.addEventListener("keydown", (e) => {
      if (e.key !== "Tab" || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      if (!e.shiftKey && !this.sourceEl.readOnly) document.execCommand("insertText", false, "\t");
    });
    // A web picture that waits keeps waiting when its Markdown is copied into
    // another document (roadmap Batch 19, item 1): the copy carries the
    // addresses that wait (worked out only on copy or cut), and a paste here
    // makes the ones it carries wait before the text goes in.
    const copyOut = (e: ClipboardEvent, cut: boolean) => {
      const { selectionStart, selectionEnd, value } = this.sourceEl;
      if (!e.clipboardData || selectionStart === selectionEnd) return;
      const text = value.slice(selectionStart, selectionEnd);
      // Its pictures, and any address a diagram's code holds, the code's fence selected or not (the review of Batch 19, R19-3); read once, not kept (R19-9).
      const waiting = [...picturesInText(text)].filter((src) => this.tab.store.waits(src));
      copiedHere(text, waiting);
      if (!waiting.length) return; // the text box copies as usual
      e.preventDefault();
      e.clipboardData.setData("text/plain", text);
      e.clipboardData.setData(WAITING_TYPE, JSON.stringify(waiting));
      if (cut && !this.sourceEl.readOnly) document.execCommand("delete");
    };
    this.sourceEl.addEventListener("copy", (e) => copyOut(e, false));
    this.sourceEl.addEventListener("cut", (e) => copyOut(e, true));
    this.sourceEl.addEventListener("paste", (e) => {
      if (!e.clipboardData || waitAsOnClipboard(e.clipboardData, this.tab.store)) return;
      e.preventDefault(); // it says more pictures wait than the document's list holds: nothing goes in
      tooManyWaiting(this.sourceEl);
    });
    // Only a file with an old Mac line ending needs its text to number the lines.
    const oldMacText = () => (/\r(?!\n)/.test(this.sourceShown) ? this.fromSourceArea() : null);
    this.gutter = new SourceGutter(this.sourceEl, oldMacText);
    // The text and the preview move together (scroll-together.ts).
    this.together = new ScrollTogether(this.sourceEl, pane, this.previewEl, {
      preview: () => (this.preview && this.preview.state.doc === this.view.state.doc ? { view: this.preview, source: this.source } : null),
      stale: () => this.previewTimer !== null,
      settle: () => this.settle(),
      oldMacText,
    });
    this.sourceEl.addEventListener("input", () => {
      if (this.onPersonEdit) this.personEdited();
      this.scheduleSave();
      this.typedElsewhere();
      if (this.previewTimer) clearTimeout(this.previewTimer);
      this.previewTimer = setTimeout(() => this.updatePreview(), PREVIEW_DELAY_MS);
    });
  }

  // The tab's own, by the names the Markdown view's code had in the tab.
  private get view(): EditorView {
    return this.tab.view;
  }
  private get source(): Source {
    return this.tab.source;
  }
  private set source(source: Source) {
    this.tab.source = source;
  }
  private get mode(): Mode {
    return this.tab.mode;
  }
  private get comments(): DocComments {
    return this.tab.comments;
  }
  private get onPersonEdit(): (() => void) | null {
    return this.tab.onPersonEdit;
  }
  private personEdited(): void {
    this.tab.personEdited();
  }
  private scheduleSave(): void {
    this.tab.scheduleSave();
  }
  private dispatch(tr: Transaction): void {
    this.tab.dispatch(tr);
  }
  private nodeViews(): ConstructorParameters<typeof EditorView>[1]["nodeViews"] {
    return this.tab.nodeViews();
  }
  private obsidian(forPreview: boolean): Plugin {
    return this.tab.obsidian(forPreview);
  }
  private openLink(href: string): void {
    this.tab.openLink(href);
  }
  private countWords(): void {
    this.tab.countWords();
  }

  /**
   * In the Markdown view, the editor's document changed other than from the
   * text: the text says so too, so it's what's saved and shown, and the next
   * catch-up with the text doesn't take it back. Typing not caught up yet is
   * kept, unless it was in the very place that changed (then the text wins).
   */
  textFollows(): void {
    const next = serializeMarkdown(this.view.state.doc, this.source);
    const area = this.sourceEl;
    const change = followText(forTextArea(this.modelText), forTextArea(next), area.value);
    if (change === "typed there") return;
    if (change) {
      area.setRangeText(change.insert, change.from, change.oldTo, "preserve");
      const region = this.typedRegion;
      if (region) this.typedRegion = { from: mapPlace(region.from, change, -1), to: mapPlace(region.to, change, 1) };
    }
    this.sourceShown = next;
    this.modelText = next;
    this.typedValue = area.value;
    this.textCells.schedule();
    this.gutter.refresh();
    this.together.textChanged();
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.updatePreview(), PREVIEW_DELAY_MS);
  }

  /** The Markdown view's text area brought to `text` by these changes (to what it shows now): the rest of it stays as it is. */
  editSourceArea(text: string, changes: readonly TextChange[]): void {
    const area = this.sourceEl;
    for (let i = changes.length - 1; i >= 0; i--) area.setRangeText(changes[i].insert, changes[i].from, changes[i].to);
    const shown = forTextArea(text);
    if (area.value !== shown) area.value = shown; // never left different from the text
    this.sourceShown = text;
    this.typedValue = area.value;
    this.typedRegion = null;
    this.textCells.schedule();
    this.gutter.refresh();
    this.together.textChanged();
  }

  /** In the Markdown view: the text's selection through changes to it, as it was where they didn't touch it; else on the same words, or where they were. */
  selectThroughText(was: { value: string; from: number; to: number; direction: "forward" | "backward" | "none" }, changes: readonly TextChange[]): void {
    if (changes.some((c) => c.from <= was.to && c.to >= was.from)) return this.selectAgainInText(was);
    this.sourceEl.setSelectionRange(shifted(changes, was.from), shifted(changes, was.to), was.direction);
  }

  /**
   * In the Markdown view, after the text changed by `changes` (places in the
   * text as it was): the line at the top of the text stays there. The text
   * scrolls by as much as the changes wholly above that line made it grow or
   * shrink; a change below it, or around it, leaves it where it was.
   */
  keepTopLine(was: { value: string; scroll: number; height: number }, changes: readonly TextChange[]): void {
    const area = this.sourceEl;
    const old = was.value;
    // Where the last line each change touched ends, in the text as it was.
    const ends = changes.map((c) => {
      const end = old.indexOf("\n", c.to);
      return end < 0 ? old.length : end;
    });
    const scroll = !changes.length
      ? was.scroll
      : this.measuring((heightOf, pads) => {
          // How far down the line after it starts (measured on the shorter side of it).
          const below = (end: number) => (end <= old.length / 2 ? pads.top + heightOf(old.slice(0, end)) : was.height - pads.bottom - heightOf(old.slice(end + 1)));
          // The changes wholly above the top line are the first few.
          let above = 0;
          for (let lo = 0, hi = changes.length - 1; lo <= hi; ) {
            const mid = (lo + hi) >> 1;
            if (below(ends[mid]) <= was.scroll + 1) lo = above = mid + 1;
            else hi = mid - 1;
          }
          if (!above) return was.scroll;
          if (above === changes.length) return was.scroll + area.scrollHeight - was.height;
          // Some above and some below: each above by its own lines, as they were and as they are.
          const now = area.value;
          let by = 0;
          let moved = 0;
          for (let i = 0; i < above; i++) {
            const c = changes[i];
            const start = old.lastIndexOf("\n", c.from - 1) + 1;
            const grew = c.insert.length - (c.to - c.from);
            by += heightOf(now.slice(start + moved, ends[i] + moved + grew)) - heightOf(old.slice(start, ends[i]));
            moved += grew;
          }
          return was.scroll + by;
        });
    area.scrollTop = scroll;
  }

  /** Heights of texts as the Markdown view's text area lays them out, measured on a copy of it out of sight. */
  private measuring<T>(measure: (heightOf: (text: string) => number, pads: { top: number; bottom: number }) => T): T {
    const area = this.sourceEl;
    const style = getComputedStyle(area);
    const pads = { top: parseFloat(style.paddingTop) || 0, bottom: parseFloat(style.paddingBottom) || 0 };
    const probe = area.cloneNode(false) as HTMLTextAreaElement;
    probe.removeAttribute("aria-label");
    probe.setAttribute("aria-hidden", "true");
    probe.tabIndex = -1;
    Object.assign(probe.style, {
      position: "absolute",
      left: "0",
      top: "0",
      visibility: "hidden",
      pointerEvents: "none",
      height: "0",
      minHeight: "0",
      width: style.width,
      scrollTimeline: "none",
    });
    this.markdownEl.append(probe);
    try {
      return measure((text) => {
        probe.value = text;
        return probe.scrollHeight - pads.top - pads.bottom;
      }, pads);
    } finally {
      probe.remove();
    }
  }

  /** In the Markdown view: the text's selection on the same words as before, or where they were. */
  selectAgainInText(was: { value: string; from: number; to: number }): void {
    const area = this.sourceEl;
    const now = area.value;
    if (now === was.value) return area.setSelectionRange(was.from, was.to);
    const cursor = was.from === was.to;
    const anchor = cursor ? (was.from > 0 ? anchorIn(was.value, Math.max(0, was.from - 24), was.from) : null) : anchorIn(was.value, was.from, was.to);
    const found = anchor && locate(now, anchor);
    if (found) area.setSelectionRange(cursor ? found.end : found.start, found.end);
    else {
      const at = mapOffset(was.value, now, was.from);
      area.setSelectionRange(at, at);
    }
  }

  /**
   * In the Markdown view: the line at the top of the text stays there. When
   * everything that changed is above it, the text scrolls by as much as the
   * change made it grow or shrink (measured on a copy of the text area, out
   * of sight); otherwise it stays as it was.
   */
  returnToLine(was: { value: string; scroll: number; height: number }): void {
    const area = this.sourceEl;
    const same = sameFrom(was.value, area.value);
    let scroll = was.scroll;
    if (same) {
      // Where the first line that's the same after the change was, measured on the shorter side of it.
      const top = this.measuring((heightOf, pads) =>
        same.before <= was.value.length / 2
          ? pads.top + heightOf(was.value.slice(0, same.before - 1))
          : was.height - pads.bottom - heightOf(was.value.slice(same.before)),
      );
      if (top <= was.scroll + 1) scroll = was.scroll + area.scrollHeight - was.height;
    }
    area.scrollTop = scroll;
  }

  setSourceArea(text: string): void {
    this.sourceShown = text;
    this.sourceEl.value = forTextArea(text);
    this.typedValue = this.sourceEl.value;
    this.typedRegion = null;
    this.textCells.schedule();
    this.gutter.refresh();
    this.together.textChanged();
  }

  /**
   * While the Markdown view is kept laid out out of sight (style.css), each
   * keystroke in the formatted view is a little slower, so after the first
   * change there (the person's, an agent's or another app's), or when the tab
   * goes behind, it's let go of: just after that shows on screen, so taking
   * it apart doesn't hold the keystroke up. Its preview, text and line
   * numbers go with it; setMode makes them afresh when it's next shown.
   */
  unkeepMarkdown(): void {
    if (this.unkeeping || !this.markdownEl.classList.contains("kept")) return;
    this.unkeeping = true;
    requestAnimationFrame(() =>
      setTimeout(() => {
        this.unkeeping = false;
        if (this.mode !== "formatted" || this.view.isDestroyed) return;
        this.markdownEl.classList.remove("kept");
        this.together.letGo();
        if (this.previewTimer) clearTimeout(this.previewTimer);
        this.previewTimer = null;
        this.preview?.destroy();
        this.preview = null;
        this.placed = null;
        this.setSourceArea("");
        this.sourceMarks.set([]); // the comments' copy of the text, one row a line, goes too
        void getComputedStyle(this.markdownEl).display; // taken apart now, not in the next keystroke's frame
      }),
    );
  }

  fromSourceArea(): string {
    return fromTextArea(this.sourceShown, this.sourceEl.value, this.source.eol);
  }

  /** The preview shows the editor's document, brought up to date with the Markdown text. */
  updatePreview(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.syncModel();
    const doc = this.view.state.doc;
    if (!this.preview) {
      const state = EditorState.create({ doc, plugins: this.previewPlugins() });
      this.preview = new EditorView(this.previewEl, { state, nodeViews: this.nodeViews(), editable: () => false });
    } else if (this.preview.state.doc !== doc) {
      this.preview.updateState(EditorState.create({ doc, plugins: this.preview.state.plugins }));
    }
    if (this.mode === "markdown") this.together.previewUpdated();
    this.countWords();
    this.tab.changed();
  }

  /**
   * The preview's own behaviour, and the comments' highlights from the
   * editor (the same document, so the same places). Clicking a comment's
   * words puts it in focus.
   */
  private previewPlugins(): Plugin[] {
    const same = (doc: Node) => !!this.view && this.view.state.doc === doc;
    return [
      footnotePlugin(),
      copyPlugin(), // copied from here, it pastes back as it was
      blankLinesPlugin(() => this.source, false),
      this.obsidian(true),
      new Plugin({
        props: {
          handleDOMEvents: {
            // Cmd-click opens a link, as on the page (see openLink). The preview isn't
            // a web page: a plain click on a link doesn't try to go there.
            click: (view, event) => {
              const link = (event.target as HTMLElement).closest?.("a[href]");
              if (!link) return false;
              event.preventDefault();
              if (!(event.metaKey || event.ctrlKey)) return false;
              this.openLink(addressOfLinkIn(view, link));
              return true;
            },
          },
        },
      }),
      new Plugin({
        props: {
          decorations: (state) => (same(state.doc) ? commentRanges(this.view.state).decorations : DecorationSet.empty),
          handleClick: (view, pos) => {
            if (!same(view.state.doc)) return false;
            const id = rangeAt(commentRanges(this.view.state), pos);
            if (id) this.comments.textClicked(id);
            return false;
          },
        },
      }),
      new Plugin({
        props: {
          decorations: (state) => (same(state.doc) ? changeMarks(this.view.state).decorations : DecorationSet.empty),
          // As in the editor: the comment in focus steps back to its underline only while its change is drawn.
          attributes: (state): Record<string, string> => {
            if (!same(state.doc)) return {};
            const { selected, decorations } = changeMarks(this.view.state);
            return selected && decorations !== DecorationSet.empty ? { class: "showing-change" } : {};
          },
        },
      }),
    ];
  }

  /**
   * In the Markdown view: bring the editor's document up to date with the
   * text, changing only what was typed, so each comment stays on its words.
   * Back in the formatted view, one Undo takes all of it back, as before.
   */
  syncModel(text = this.fromSourceArea()): void {
    if (this.mode !== "markdown") return;
    if (text === this.fromSourceArea()) this.typedRegion = null;
    if (text === this.modelText) return;
    const parsed = parseCached(text);
    const state = this.view.state;
    // Just after coming to this view, the document can hold what its text
    // doesn't say: a space typed at the end of a paragraph in the formatted
    // view, which Markdown drops. That's put right first, block by block;
    // otherwise the change would run from there to the typing, and a
    // comment's words in between would go with it.
    const unread = this.unread === state.doc ? parseCached(this.modelText).doc : null;
    this.unread = null;
    const start = () => (unread && !unread.eq(state.doc) ? readAs(state, unread) : state.tr);
    const replacing = this.replacing;
    this.replacing = null;
    const matched =
      replacing && replacing.doc === state.doc && replacing.text === text
        ? replacing.build(start())
        : null;
    const replayed = matched ? null : this.replayReplaceAll(state, text, parsed.doc);
    const { tr, exact } = matched || replayed ? { tr: (matched ?? replayed)!, exact: true } : replaceChanged(state, parsed.doc, start());
    const was = { modelText: this.modelText, source: this.source };
    this.modelText = text;
    this.source = parsed.source;
    if (!tr.docChanged) {
      this.placeMarks();
      return;
    }
    if (!this.typingGroup) {
      this.typingGroup = ++this.typingGroups;
      closeHistory(tr);
    }
    markAsFromTheText(tr, this.typingGroup);
    if (replayed) tr.setMeta(TEXT_HISTORY, true); // the text's own Undo or Redo of a choice: its comments go back where they were
    // The comment in focus stays so: the editor's cursor isn't where the person is typing.
    withRanges(tr, { type: "active", id: commentRanges(state).active });
    const had = commentRanges(state).ranges;
    this.dispatch(tr);
    if (this.view.state.doc !== tr.doc) {
      // Refused (an agent holds the document): it hasn't caught up with the text, and will next time.
      this.modelText = was.modelText;
      this.source = was.source;
      return;
    }
    if (matched) {
      const undo = matched.steps.map((step, i) => step.invert(matched.docs[i])).reverse();
      this.replacedAll = { before: was.modelText, after: text, steps: matched.steps, undo, done: true, doc: this.view.state.doc };
    } else if (replayed && this.replacedAll) {
      this.replacedAll.done = !this.replacedAll.done;
      this.replacedAll.doc = this.view.state.doc;
    }
    // A comment whose words were rewritten around it (a table that now has to
    // show as Markdown text, say) is found again, if its words are still there.
    let refind = !exact;
    const kept = commentRanges(this.view.state).ranges;
    for (const [id, r] of had) {
      if (refind) break;
      if (kept.has(id)) continue;
      const words = state.doc.textBetween(r.from, r.to, " ").trim();
      const around = tr.doc.textBetween(tr.mapping.map(r.from, -1), tr.mapping.map(r.to, 1), " ");
      refind = !!words && around.includes(words);
    }
    if (refind) this.comments.refind(tr);
  }

  /**
   * The person typed in the Markdown text. The document learns of typing as
   * one changed stretch, so when the typing moves somewhere else before it
   * has caught up, it catches up with the typing so far first: a comment's
   * words between the two places stay as they are, and keep their comment.
   */
  private typedElsewhere(): void {
    const before = this.typedValue;
    const edit = textEdit(before, this.sourceEl.value);
    this.typedValue = this.sourceEl.value;
    if (!edit) return;
    const region = this.typedRegion;
    if (region && (edit.from > region.to || edit.oldTo < region.from)) {
      this.syncModel(fromTextArea(this.sourceShown, before, this.source.eol));
      this.typedRegion = { from: edit.from, to: edit.newTo };
      return;
    }
    this.typedRegion = region
      ? { from: Math.min(mapPlace(region.from, edit, -1), edit.from), to: Math.max(mapPlace(region.to, edit, 1), edit.newTo) }
      : { from: edit.from, to: edit.newTo };
  }

  /**
   * The text's Undo of the last Replace All (or Redo of it), straight after it
   * or once what was typed since is undone too: its matches back as they
   * were, or replaced again, one by one, so a comment on words that hold one
   * keeps them. Null for any other change.
   */
  private replayReplaceAll(state: EditorState, text: string, after: Node): Transaction | null {
    const last = this.replacedAll;
    if (!last || text !== (last.done ? last.before : last.after) || !state.doc.eq(last.doc)) return null;
    const tr = state.tr;
    try {
      for (const step of last.done ? last.undo : last.steps) tr.step(step);
    } catch {
      return null;
    }
    return tr.doc.eq(after) ? tr : null;
  }

  /**
   * Replace All in the Markdown text is about to replace these matches with
   * `replacement`, making the text `next` (find.ts). Where each match is in
   * the document, so the document changes match by match, as in the
   * formatted view, and a comment on words that hold one keeps them.
   */
  replacingAll(matches: readonly { from: number; to: number }[], replacement: string, next: string): void {
    this.replacing = null;
    if (this.mode !== "markdown" || !matches.length || matches.length > MATCHES_ONE_BY_ONE) return;
    this.settle();
    const spans = this.spansNow();
    if (!spans) return;
    const doc = this.view.state.doc;
    const value = this.sourceEl.value;
    const places: { from: number; to: number }[] = [];
    for (const m of matches) {
      const place = docRange(doc, value, spans, m.from, m.to);
      // A match across Markdown's signs (part of "**Q3**") isn't the same words in the document.
      if (doc.textBetween(place.from, place.to) !== value.slice(m.from, m.to)) return;
      places.push(place);
    }
    const text = fromTextArea(this.sourceShown, next, this.source.eol);
    this.replacing = { doc, text, build: (tr) => replaceMatches(tr, places, replacement, parseCached(text).doc) };
  }

  /** Bring the Markdown view's preview and comments up to date with what was just typed, now. */
  settle(): void {
    if (this.mode === "markdown" && this.previewTimer) this.updatePreview();
  }

  /** The editor's comments or changes moved, came or went: the Markdown view shows them again. */
  marksMoved(before: EditorState): void {
    const after = this.view.state;
    if (
      commentRanges(before).decorations === commentRanges(after).decorations &&
      changeMarks(before).decorations === changeMarks(after).decorations
    ) {
      return;
    }
    if (this.preview && this.preview.state.doc === after.doc) this.preview.setProps({});
    this.placeMarks();
  }

  /** Where each block of the editor's document is in the Markdown text; null while the person's typing is still to come in. */
  spansNow(): Span[] | null {
    const doc = this.view.state.doc;
    if (this.placed?.doc === doc && this.placed.text === this.sourceEl.value) return this.placed.spans;
    if (this.fromSourceArea() !== this.modelText) return null;
    const { text, spans } = viewText(doc, this.source);
    if (text !== this.modelText) return null;
    this.placed = { doc, text: this.sourceEl.value, spans };
    return spans;
  }

  /** Mark each comment's words (and the change in focus) in the Markdown text, where the editor says they are. */
  placeMarks(): void {
    if (this.mode !== "markdown") return;
    const state = this.view.state;
    const { ranges, shown, active } = commentRanges(state);
    const inFocus = (id: string) => id === active || id === DRAFT;
    const changes = changeMarks(state);
    const changed = changes.selected ? present(changes.spans.get(changes.selected)).filter((s) => !s.point) : [];
    if (!shown.size && !changed.length) {
      this.sourceMarks.set([]);
      return;
    }
    const spans = this.spansNow();
    if (!spans) {
      // The marks moved with their words as the person typed; they're placed exactly again a moment after typing stops.
      this.sourceMarks.restyle(inFocus);
      return;
    }
    const doc = state.doc;
    const value = this.sourceEl.value;
    const place = (pos: number) => markdownPlace(doc, pos, value, spans);
    // A mark starts at its first word, not at the Markdown signs before it ("**").
    const start = (from: number) => {
      const at = place(from);
      const $from = doc.resolve(from);
      if (!$from.parent.isTextblock || $from.parentOffset >= $from.parent.content.size) return at;
      return Math.max(at, place(from + 1) - 1);
    };
    const marks: SourceMark[] = [];
    const add = (id: string, from: number, to: number, kind: SourceMark["kind"]) => {
      const a = start(from);
      const b = place(to);
      if (b > a) marks.push({ id, from: a, to: b, kind });
    };
    for (const id of shown) {
      const r = ranges.get(id);
      if (r) add(id, r.from, r.to, inFocus(id) ? "active" : "comment");
    }
    for (const s of changed) add(changes.selected!, s.from, s.to, "change");
    this.sourceMarks.set(marks);
  }

  /** The words selected in the Markdown view (its text or its preview), as places in the editor's document. */
  markdownSelection(): { from: number; to: number; chosen: boolean } {
    this.settle();
    const doc = this.view.state.doc;
    const none = { from: 0, to: 0, chosen: false };
    if (this.pickedIn === "preview") {
      const selection = window.getSelection();
      const preview = this.preview;
      if (!selection || selection.isCollapsed || !preview || preview.state.doc !== doc) return none;
      const { anchorNode, focusNode } = selection;
      if (!anchorNode || !focusNode || !this.previewEl.contains(anchorNode) || !this.previewEl.contains(focusNode)) return none;
      try {
        const a = preview.posAtDOM(anchorNode, selection.anchorOffset);
        const b = preview.posAtDOM(focusNode, selection.focusOffset);
        return { from: Math.min(a, b), to: Math.max(a, b), chosen: true };
      } catch {
        return none;
      }
    }
    const { selectionStart, selectionEnd, value } = this.sourceEl;
    if (selectionStart === selectionEnd) return none;
    const spans = this.spansNow();
    if (!spans) return { from: 0, to: 0, chosen: true };
    return { ...docRange(doc, value, spans, selectionStart, selectionEnd), chosen: true };
  }

  /** The tab is closing: its Markdown view lets go of everything it holds. */
  destroy(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.sourceMarks.destroy();
    this.textCells.destroy();
    this.stopSplit();
    this.gutter.destroy();
    this.together.destroy();
    this.preview?.destroy();
    forgetText(this.sourceEl); // the Markdown text's Undo keeps nothing of a closed tab
  }
}
