// Find and Replace, in a bar at the top of the document. Every match is
// highlighted and the current one more strongly; the bar says "3 of 12".
// Enter or Cmd+G goes to the next match, Shift+Enter or Cmd+Shift+G to the
// previous one, wrapping round. Escape closes the bar and leaves the match
// selected. Cmd+Option+F (Word's shortcut) shows Replace and Replace All;
// Replace All is a single undo step. Works in the formatted view and in the
// Markdown view. While the bar is open, edits are searched again a moment
// after typing stops, never on every keystroke. While an earlier version (or
// Show changes) is on screen, Find searches that page, read-only: Replace and
// Replace All are greyed out, so they never change text that isn't showing.
//
// Find reaches the comments too (roadmap Batch 4, item 2): every message on
// the cards, resolved comments' included, agents' notes and requests made in
// the chat. The bar counts them after the text's ("3 of 12 · 2 in comments"),
// and Return goes on from the last match in the text into the cards, in the
// order the panel lists them, then round to the text. A resolved comment's
// card shows while Find is on it. Replace never changes a comment. Not while
// an earlier version is shown on its own: the Comments column isn't beside it.
import { Plugin, PluginKey, Selection, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { closeHistory } from "prosemirror-history";
import { countWithComments, findInDoc, findInText, matchFrom, stepThrough, type Match } from "../core/search";
import { whenCommentsDrawn, type DocComments } from "./comments-panel";
import type { DocTab } from "./doc-tab";
import type { Mode } from "./toolbar";
import { ICONS } from "./icons";
import { replaceAllStep } from "./replace-all";

/** Beyond this many matches only the current one is highlighted, to keep the page quick. */
const MAX_HIGHLIGHTS = 2000;
const SEARCH_AGAIN_MS = 250;

const findKey = new PluginKey<DecorationSet>("find");
let onEditorChanged: ((view: EditorView) => void) | null = null;
let onSourceChanged: ((textarea: HTMLTextAreaElement) => void) | null = null;
let onSourceReplaced: ((textarea: HTMLTextAreaElement) => void) | null = null;

/**
 * The Markdown text was changed from outside the tab (an agent's change, or
 * another app's), not by typing: its matches are found again at once, so the
 * marks are on their words from the moment the new text shows.
 */
export function sourceReplaced(textarea: HTMLTextAreaElement): void {
  onSourceReplaced?.(textarea);
}

/** Holds the highlights in the formatted view and moves them along with edits. */
export function findPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: findKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const next = tr.getMeta(findKey) as DecorationSet | undefined;
        if (next) return next;
        return tr.docChanged && set !== DecorationSet.empty ? set.map(tr.mapping, tr.doc) : set;
      },
    },
    props: {
      decorations: (state) => findKey.getState(state),
    },
    view(view) {
      onEditorChanged?.(view);
      return {
        update(v, previous) {
          if (v.state.doc !== previous.doc) onEditorChanged?.(v);
        },
      };
    },
  });
}

// Where the search happens: the formatted document, or the Markdown text ------

/** What the bar searches: the formatted document, the Markdown text, or a version shown instead of them. */
type Kind = Mode | "version";

/** The page showing a version (or Show changes) in this tab, if one is on screen instead of the editor. */
function versionPage(tab: DocTab): HTMLElement | null {
  if (!tab.el.classList.contains("viewing-version")) return null;
  return tab.el.querySelector<HTMLElement>(".version-view:not([hidden]) .version-page");
}

const kindOf = (tab: DocTab): Kind => (versionPage(tab) ? "version" : tab.mode);

interface Target {
  readonly tab: DocTab;
  readonly mode: Kind;
  /** Changes whenever the text does, to tell whether matches are current. */
  version(): unknown;
  /** Whether the text can be changed (not while an agent is editing, say). */
  editable(): boolean;
  find(query: string, matchCase: boolean): Match[];
  selection(): Match;
  show(matches: Match[], current: number, select: boolean): void;
  replace(match: Match, text: string): void;
  replaceAll(matches: Match[], text: string): void;
  selectedText(): string;
  clear(): void;
  focus(): void;
}

const highlighted = (matches: Match[], current: number) =>
  matches.length <= MAX_HIGHLIGHTS ? matches : current >= 0 ? [matches[current]] : [];

class FormattedTarget implements Target {
  readonly mode = "formatted" as const;
  constructor(readonly tab: DocTab) {}

  private get view(): EditorView {
    return this.tab.view;
  }

  version() {
    return this.view.state.doc;
  }

  editable() {
    return this.view.editable;
  }

  find(query: string, matchCase: boolean) {
    return findInDoc(this.view.state.doc, query, matchCase);
  }

  selection() {
    const { from, to } = this.view.state.selection;
    return { from, to };
  }

  show(matches: Match[], current: number, select: boolean) {
    const { state } = this.view;
    const now = matches[current];
    const decos = highlighted(matches, current).map((m) =>
      Decoration.inline(m.from, m.to, { class: m === now ? "find-match current" : "find-match" }),
    );
    const tr = state.tr.setMeta(findKey, DecorationSet.create(state.doc, decos));
    if (select && now) tr.setSelection(TextSelection.create(state.doc, now.from, now.to)).scrollIntoView();
    this.view.dispatch(tr);
  }

  replace(m: Match, text: string) {
    const tr = this.view.state.tr;
    if (text) tr.insertText(text, m.from, m.to);
    else tr.delete(m.from, m.to);
    this.view.dispatch(closeHistory(tr).scrollIntoView());
  }

  replaceAll(matches: Match[], text: string) {
    const tr = this.view.state.tr;
    // One step for every match, so the time grows only as the matches do (see replace-all.ts).
    const step = replaceAllStep(tr.doc, matches, text);
    if (step && !tr.maybeStep(step).failed) {
      if (text && !tr.selection.empty) tr.setSelection(Selection.near(tr.selection.$to)); // as typing over it leaves it
    } else {
      for (let i = matches.length - 1; i >= 0; i--) {
        if (text) tr.insertText(text, matches[i].from, matches[i].to);
        else tr.delete(matches[i].from, matches[i].to);
      }
    }
    this.view.dispatch(closeHistory(tr)); // one undo step
  }

  selectedText() {
    const { from, to, $from, $to } = this.view.state.selection;
    if (from === to || $from.parent !== $to.parent) return "";
    const text = this.view.state.doc.textBetween(from, to);
    return text.length <= 200 ? text : "";
  }

  clear() {
    if (!this.view.isDestroyed) this.view.dispatch(this.view.state.tr.setMeta(findKey, DecorationSet.empty));
  }

  focus() {
    this.view.focus();
  }
}

// A textarea can't colour parts of its text, so matches are drawn on a layer
// behind it holding the same text, wrapped the same way.
const overlays = new WeakMap<HTMLTextAreaElement, HTMLElement>();

function overlayFor(textarea: HTMLTextAreaElement): HTMLElement {
  let overlay = overlays.get(textarea);
  if (overlay) return overlay;
  const layer = document.createElement("div");
  layer.className = "find-marks";
  layer.setAttribute("aria-hidden", "true");
  layer.hidden = true;
  textarea.before(layer);
  textarea.addEventListener("scroll", () => {
    layer.scrollTop = textarea.scrollTop;
  });
  textarea.addEventListener("input", () => onSourceChanged?.(textarea));
  overlays.set(textarea, layer);
  overlay = layer;
  return overlay;
}

function edit(text: string): void {
  if (text) document.execCommand("insertText", false, text);
  else document.execCommand("delete");
}

class SourceTarget implements Target {
  readonly mode = "markdown" as const;
  readonly textarea: HTMLTextAreaElement;
  private overlay: HTMLElement;

  constructor(readonly tab: DocTab) {
    this.textarea = tab.el.querySelector<HTMLTextAreaElement>("textarea.source")!;
    this.overlay = overlayFor(this.textarea);
  }

  version() {
    return this.textarea.value;
  }

  editable() {
    return !this.textarea.readOnly && !this.textarea.disabled;
  }

  find(query: string, matchCase: boolean) {
    return findInText(this.textarea.value, query, matchCase);
  }

  selection() {
    return { from: this.textarea.selectionStart, to: this.textarea.selectionEnd };
  }

  show(matches: Match[], current: number, select: boolean) {
    const { textarea, overlay } = this;
    const text = textarea.value;
    const now = matches[current];
    const parts = document.createDocumentFragment();
    let at = 0;
    for (const m of highlighted(matches, current)) {
      parts.append(text.slice(at, m.from));
      const mark = document.createElement("mark");
      mark.className = m === now ? "find-match current" : "find-match";
      mark.textContent = text.slice(m.from, m.to);
      parts.append(mark);
      at = m.to;
    }
    parts.append(text.slice(at) + " "); // keeps a last empty line, as the textarea does
    overlay.replaceChildren(parts);
    const scrollbar = textarea.offsetWidth - textarea.clientWidth - 1;
    overlay.style.paddingRight = scrollbar > 0 ? `${parseFloat(getComputedStyle(textarea).paddingRight) + scrollbar}px` : "";
    overlay.hidden = false;
    textarea.classList.add("finding");
    if (select && now) {
      textarea.setSelectionRange(now.from, now.to);
      const mark = overlay.querySelector<HTMLElement>("mark.current");
      if (mark) {
        const top = mark.offsetTop;
        const height = textarea.clientHeight;
        if (top < textarea.scrollTop + 20 || top > textarea.scrollTop + height - 40) {
          textarea.scrollTop = Math.max(0, top - height / 3);
        }
      }
    }
    overlay.scrollTop = textarea.scrollTop;
  }

  replace(m: Match, text: string) {
    this.textarea.focus();
    this.textarea.setSelectionRange(m.from, m.to);
    edit(text); // the textarea's own undo takes it back
  }

  replaceAll(matches: Match[], text: string) {
    const { textarea } = this;
    const value = textarea.value;
    let next = "";
    let at = 0;
    for (const m of matches) {
      next += value.slice(at, m.from) + text;
      at = m.to;
    }
    next += value.slice(at);
    this.tab.replacingAll(matches, text, next); // so comments keep their words, as in the formatted view
    const top = textarea.scrollTop;
    textarea.focus();
    // Only the stretch from the first match to the last is written again: the
    // window's Redo of a text box written again whole loses its first line.
    const from = matches[0].from;
    const to = matches[matches.length - 1].to;
    textarea.setSelectionRange(from, to);
    edit(next.slice(from, next.length - (value.length - to))); // one undo step
    textarea.setSelectionRange(matches[0].from, matches[0].from);
    textarea.scrollTop = top;
  }

  selectedText() {
    const { selectionStart, selectionEnd, value } = this.textarea;
    const text = value.slice(selectionStart, selectionEnd);
    return text.length <= 200 && !text.includes("\n") ? text : "";
  }

  clear() {
    this.overlay.hidden = true;
    this.overlay.replaceChildren();
    this.textarea.classList.remove("finding");
  }

  focus() {
    this.textarea.focus();
  }
}

// A version on screen: searched as shown, read-only. Its page can't take
// marks of Corillo's own, so matches are drawn with the browser's highlights.

/** The blocks a match can't cross on a version's page. */
const TEXT_BLOCK = "p, h1, h2, h3, h4, h5, h6, pre, li, td, th, dt, dd, figcaption";
/** Words on the page that aren't the document's: buttons, drawings. */
const NOT_TEXT = "button, svg, style, script, .diagram-picture, [aria-hidden='true']";

interface Block {
  /** Where the block starts among all the page's text (blocks one apart, so no match spans two). */
  offset: number;
  nodes: { node: Text; start: number }[];
  text: string;
}

class VersionTarget implements Target {
  readonly mode = "version" as const;
  private blocks: Block[] = [];
  private at: Match = { from: 0, to: 0 };
  /** Replaced whenever the page changes (another version shown, a diagram drawn). */
  private stamp = {};
  private readonly watcher: MutationObserver;

  constructor(
    readonly tab: DocTab,
    readonly page: HTMLElement,
    changed: () => void,
  ) {
    this.watcher = new MutationObserver(() => {
      this.stamp = {};
      changed();
    });
    this.watcher.observe(page, { childList: true, subtree: true, characterData: true });
  }

  version() {
    return this.stamp;
  }

  editable() {
    return false;
  }

  private readBlocks(): void {
    const groups = new Map<Element, Block>();
    this.blocks = [];
    let offset = 0;
    const walker = document.createTreeWalker(this.page, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const parent = node.parentElement;
      if (!parent || !node.data || parent.closest(NOT_TEXT) || !parent.checkVisibility()) continue;
      const blockEl = parent.closest(TEXT_BLOCK) ?? this.page;
      let block = groups.get(blockEl);
      if (!block) {
        if (this.blocks.length) offset += this.blocks[this.blocks.length - 1].text.length + 1;
        block = { offset, nodes: [], text: "" };
        groups.set(blockEl, block);
        this.blocks.push(block);
      }
      block.nodes.push({ node, start: block.text.length });
      block.text += node.data;
    }
  }

  find(query: string, matchCase: boolean) {
    this.readBlocks();
    const out: Match[] = [];
    for (const block of this.blocks) {
      for (const m of findInText(block.text, query, matchCase)) out.push({ from: block.offset + m.from, to: block.offset + m.to });
    }
    return out;
  }

  private range(m: Match): Range | null {
    const block = this.blocks.find((b) => m.from >= b.offset && m.to <= b.offset + b.text.length);
    if (!block) return null;
    const spot = (at: number, end: boolean) => {
      const i = at - block.offset;
      const part = block.nodes.find((p) => (end ? i > p.start && i <= p.start + p.node.length : i >= p.start && i < p.start + p.node.length));
      return part ? { node: part.node, offset: i - part.start } : null;
    };
    const start = spot(m.from, false);
    const end = spot(m.to, true);
    if (!start || !end) return null;
    const range = new Range();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  }

  selection() {
    return this.at;
  }

  show(matches: Match[], current: number, select: boolean) {
    const now = matches[current];
    const others = highlighted(matches, current).filter((m) => m !== now);
    CSS.highlights.set("find-match", new Highlight(...others.map((m) => this.range(m)).filter((r): r is Range => !!r)));
    const currentRange = now ? this.range(now) : null;
    CSS.highlights.set("find-current", currentRange ? new Highlight(currentRange) : new Highlight());
    if (select && now) {
      this.at = now;
      const canvas = this.page.closest<HTMLElement>(".canvas");
      if (currentRange && canvas) {
        const box = currentRange.getBoundingClientRect();
        const view = canvas.getBoundingClientRect();
        if (box.top < view.top + 20 || box.bottom > view.bottom - 40) canvas.scrollTop += box.top - view.top - canvas.clientHeight / 3;
      }
    }
  }

  replace() {
    // An earlier version is only looked at: Replace is greyed out.
  }

  replaceAll() {
    // As Replace.
  }

  selectedText() {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || !this.page.contains(selection.anchorNode)) return "";
    const text = selection.toString();
    return text.length <= 200 && !text.includes("\n") ? text : "";
  }

  clear() {
    this.watcher.disconnect();
    CSS.highlights.delete("find-match");
    CSS.highlights.delete("find-current");
    this.blocks = [];
  }

  focus() {
    this.page.focus({ preventScroll: true });
  }
}

// The comments: the words on each card ---------------------------------------

/** A match on a card: which card, which of its words (a message, a note, a request; see FindableCard), and where in them. */
interface CommentMatch extends Match {
  id: string;
  part: string;
}

class CommentsFinder {
  constructor(readonly tab: DocTab) {}

  get comments(): DocComments {
    return this.tab.comments;
  }

  /** The Comments column is beside what Find searches: not while an earlier version is shown on its own. */
  allowed(): boolean {
    const { classList } = this.tab.el;
    return !classList.contains("viewing-version") || classList.contains("viewing-changes");
  }

  /** Changes whenever the comments do, or whether they're searched. */
  version(): unknown {
    return this.allowed() ? this.comments.searchStamp : null;
  }

  find(query: string, matchCase: boolean): CommentMatch[] {
    if (!this.allowed()) return [];
    const out: CommentMatch[] = [];
    for (const card of this.comments.findable()) {
      for (const part of card.parts) for (const m of findInText(part.text, query, matchCase)) out.push({ id: card.id, part: part.key, from: m.from, to: m.to });
    }
    return out;
  }

  /** A match's words on its card, if the card is drawn (a resolved comment's isn't, until Find is on it). */
  private range(m: CommentMatch): Range | null {
    const el = this.comments.findablePart(m.id, m.part);
    if (!el) return null;
    const range = new Range();
    let at = 0;
    let started = false;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const end = at + node.length;
      if (!started && m.from < end) {
        range.setStart(node, m.from - at);
        started = true;
      }
      if (started && m.to <= end) {
        range.setEnd(node, m.to - at);
        return range;
      }
      at = end;
    }
    return null;
  }

  /** Mark the matches, the current one more strongly; `reveal`, bringing it into sight in the panel. */
  show(matches: CommentMatch[], current: number, reveal: boolean): void {
    const now = matches[current];
    const others = (highlighted(matches, current) as CommentMatch[]).filter((m) => m !== now);
    CSS.highlights.set("find-comment", new Highlight(...others.map((m) => this.range(m)).filter((r): r is Range => !!r)));
    const range = now ? this.range(now) : null;
    CSS.highlights.set("find-comment-current", range ? new Highlight(range) : new Highlight());
    if (reveal && range) this.comments.revealFound(range.getBoundingClientRect());
  }

  clear(): void {
    CSS.highlights.delete("find-comment");
    CSS.highlights.delete("find-comment-current");
  }
}

// The bar ----------------------------------------------------------------


export class FindBar {
  readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly replaceInput: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly matchCase: HTMLInputElement;
  private readonly replaceRow: HTMLElement;
  private readonly showReplace: HTMLButtonElement;
  private readonly replaceButtons: HTMLButtonElement[];
  /** While the bar is open: notices a version shown on the tab, or put away, to search what's on screen. */
  private readonly viewWatcher = new MutationObserver(() => this.sync());

  private target: Target | null = null;
  private matches: Match[] = [];
  private current = -1;
  private searched: unknown = null;
  /** The matches on the cards, after the text's; the one Find is on (-1: it's in the text); what they were found in. */
  private finder: CommentsFinder | null = null;
  private inComments: CommentMatch[] = [];
  private onComment = -1;
  private commentsSearched: unknown = null;
  /** Where the text's selection was when Find went into the cards: moved since, Find goes on from there. */
  private leftAt: Match | null = null;
  private redraw = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private notice: string | null = null;

  constructor(private readonly active: () => DocTab | null) {
    this.el = document.createElement("div");
    this.el.className = "find-bar";
    this.el.setAttribute("role", "search");
    this.el.setAttribute("aria-label", "Find in document");
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="find-row">
        <input class="find-field" name="find" type="text" aria-label="Find" placeholder="Find" spellcheck="false" autocomplete="off">
        <span class="find-count" aria-live="polite"></span>
        <div class="find-steps">
          <button type="button" class="find-step" data-step="-1" aria-label="Previous match" title="Previous match (⇧⌘G)">${ICONS.previous}</button>
          <button type="button" class="find-step" data-step="1" aria-label="Next match" title="Next match (⌘G)">${ICONS.next}</button>
        </div>
        <span class="find-more">
          <label class="find-option"><input type="checkbox" name="match-case"> Match case</label>
          <button type="button" class="find-show-replace" title="Replace (⌥⌘F)">Replace…</button>
          <button type="button" class="find-done">Done</button>
        </span>
      </div>
      <div class="find-row replace-row" hidden>
        <input class="find-field" name="replace" type="text" aria-label="Replace with" placeholder="Replace with" spellcheck="false" autocomplete="off">
        <button type="button" class="find-replace">Replace</button>
        <button type="button" class="find-replace-all">Replace all</button>
      </div>`;
    const $ = <T extends HTMLElement>(selector: string) => this.el.querySelector<T>(selector)!;
    this.input = $('input[name="find"]');
    this.replaceInput = $('input[name="replace"]');
    this.count = $(".find-count");
    this.matchCase = $('input[name="match-case"]');
    this.replaceRow = $(".replace-row");
    this.showReplace = $(".find-show-replace");
    this.replaceButtons = [$(".find-replace"), $(".find-replace-all")];

    this.input.addEventListener("input", () => {
      this.notice = null;
      this.search(true);
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
    this.replaceInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.replaceOne();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
    this.matchCase.addEventListener("change", () => {
      this.notice = null;
      this.search(true);
    });
    for (const b of this.el.querySelectorAll<HTMLButtonElement>(".find-step")) {
      // As Show changes' arrows: the keyboard stays in the find box, to type or press Return on (roadmap Batch 11, F-25).
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => this.step(Number(b.dataset.step) as 1 | -1));
    }
    this.showReplace.addEventListener("click", () => {
      this.setReplace(true);
      this.replaceInput.focus();
    });
    $(".find-done").addEventListener("click", () => this.close());
    $(".find-replace").addEventListener("click", () => this.replaceOne());
    $(".find-replace-all").addEventListener("click", () => this.replaceAll());

    onEditorChanged = (view) => {
      if (this.target instanceof FormattedTarget && this.target.tab.view === view) this.searchSoon();
    };
    onSourceChanged = (textarea) => {
      if (this.target instanceof SourceTarget && this.target.textarea === textarea) this.searchSoon();
    };
    onSourceReplaced = (textarea) => {
      if (this.isOpen && this.target instanceof SourceTarget && this.target.textarea === textarea) this.search(false);
    };
    // The cards were drawn again: their marks are drawn again, or, if the comments changed, searched for again.
    whenCommentsDrawn((panel) => {
      const finder = this.finder;
      if (!this.isOpen || finder?.comments !== panel) return;
      if (this.commentsSearched !== finder.version()) return this.searchSoon();
      if (!this.inComments.length || this.redraw) return;
      this.redraw = requestAnimationFrame(() => {
        this.redraw = 0;
        if (this.finder === finder) finder.show(this.inComments, this.onComment, false);
      });
    });

    // Cmd+F, Cmd+Option+F, Cmd+G and Cmd+Shift+G come as the menu's, by the character the key types (menus.ts).
    window.corillo.onMenu((action) => {
      if (action === "find:open") this.open(false);
      else if (action === "find:replace") this.open(true);
      else if (action === "find:next") this.step(1);
      else if (action === "find:previous") this.step(-1);
    });
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(withReplace: boolean): void {
    const tab = this.active();
    if (!tab) return;
    this.place(tab);
    this.el.hidden = false;
    this.setReplace(withReplace);
    this.bind();
    const picked = this.target?.selectedText();
    if (picked) this.input.value = picked;
    this.input.focus();
    this.input.select();
    this.notice = null;
    this.search(true);
  }

  /** Close the bar; the current match stays selected. */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.el.hidden = true;
    this.el.remove(); // out of the tab, so a tab closed later isn't kept by it
    this.viewWatcher.disconnect();
    const target = this.target;
    this.target = null;
    this.matches = [];
    this.current = -1;
    this.searched = null; // the document, or its whole text: not kept once the bar is closed
    const finder = this.finder;
    const onCard = target ? this.inComments[this.onComment] : undefined;
    this.letGoComments(!!onCard);
    if (target) {
      target.clear();
      // Closed on a match in a card: the keyboard rests on the card, as Next Comment leaves it.
      if (onCard && finder) finder.comments.restOnFound(onCard.id);
      else target.focus();
    }
  }

  /**
   * Nothing kept of the comments' matches: their marks go, and a resolved
   * comment's card shown for one (`onCard`: the keyboard goes to it, which
   * keeps it while it's there).
   */
  private letGoComments(onCard = false): void {
    if (this.redraw) cancelAnimationFrame(this.redraw);
    this.redraw = 0;
    this.finder?.clear();
    if (!onCard) this.finder?.comments.letGoFound();
    this.finder = null;
    this.inComments = [];
    this.onComment = -1;
    this.commentsSearched = null;
    this.leftAt = null;
  }

  /** The tab in front, or its view, changed: search there instead. */
  sync(): void {
    if (!this.isOpen) return;
    const tab = this.active();
    if (!tab) {
      this.el.hidden = true;
      this.el.remove();
      this.viewWatcher.disconnect();
      this.target?.clear();
      this.target = null;
      this.matches = [];
      this.current = -1;
      this.searched = null;
      this.letGoComments();
      return;
    }
    this.place(tab);
    if (this.target && this.target.tab === tab && this.target.mode === kindOf(tab)) {
      // An earlier version shown, or put away: the comments are searched, or not.
      if (this.finder && this.commentsSearched !== this.finder.version()) this.search(false);
      return;
    }
    this.bind();
    this.search(false);
  }

  /**
   * The bar sits at the top of the page's own column, as the lines about the
   * document do, so it spans the page only and the Comments or History column
   * starts right under the toolbar. One bar for every tab: it moves to the tab
   * in front, keeping the keyboard if it had it.
   */
  private place(tab: DocTab): void {
    if (this.el.parentElement === tab.main) return;
    this.viewWatcher.disconnect();
    this.viewWatcher.observe(tab.el, { attributes: true, attributeFilter: ["class"] });
    const focused = this.el.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    tab.main.prepend(this.el);
    focused?.focus();
  }

  private setReplace(on: boolean): void {
    this.replaceRow.hidden = !on;
    this.showReplace.hidden = on;
  }

  private bind(): void {
    const tab = this.active();
    if (!tab) return;
    const kind = kindOf(tab);
    if (this.target && this.target.tab === tab && this.target.mode === kind) return;
    // The new place is taken before the old one's marks are cleared: clearing the page's marks is a change
    // the window hears of, and asks the bar to move again (sync), which would clear them again without end.
    const old = this.target;
    if (this.finder?.tab !== tab) {
      this.letGoComments();
      this.finder = new CommentsFinder(tab);
    }
    const page = kind === "version" ? versionPage(tab) : null;
    this.target = page
      ? new VersionTarget(tab, page, () => this.searchSoon())
      : kind === "formatted"
        ? new FormattedTarget(tab)
        : new SourceTarget(tab);
    this.searched = null;
    old?.clear();
    const editable = !(this.target instanceof VersionTarget);
    for (const b of this.replaceButtons) {
      b.disabled = !editable;
      b.title = editable ? "Changes the document's text, never a comment" : "This version is only shown, so nothing in it can be replaced.";
    }
  }

  private searchSoon(): void {
    if (!this.isOpen) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.search(false);
    }, SEARCH_AGAIN_MS);
  }

  /**
   * Search now. With `select`, go to the first match from `from` (the start
   * of the selection, by default) and select it.
   */
  private search(select: boolean, from?: number): void {
    const target = this.target;
    if (!target) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const query = this.input.value;
    this.matches = query ? target.find(query, this.matchCase.checked) : [];
    this.searched = target.version();
    const selection = target.selection();
    const was = this.inComments[this.onComment];
    this.inComments = query && this.finder ? this.finder.find(query, this.matchCase.checked) : [];
    this.commentsSearched = this.finder?.version() ?? null;
    // Searched again while on a match in a card: still on it, if it's still there and the text's selection hasn't moved.
    this.onComment =
      !select && was && !this.movedOff(selection) ? this.inComments.findIndex((m) => m.id === was.id && m.part === was.part && m.from === was.from) : -1;
    this.current = select
      ? matchFrom(this.matches, from ?? selection.from)
      : this.onComment >= 0
        ? -1
        : this.matches.findIndex((m) => m.from === selection.from && m.to === selection.to);
    target.show(this.matches, this.current, select);
    this.finder?.show(this.inComments, this.onComment, false);
    if (this.onComment < 0) {
      this.leftAt = null;
      this.finder?.comments.letGoFound();
    }
    this.showCount();
  }

  /** The text's selection moved since Find went into the cards. */
  private movedOff(selection: Match): boolean {
    return !this.leftAt || selection.from !== this.leftAt.from || selection.to !== this.leftAt.to;
  }

  /** To match i in the text. */
  private goText(i: number): void {
    const target = this.target;
    if (!target) return;
    this.onComment = -1;
    this.leftAt = null;
    this.current = i;
    target.show(this.matches, i, true);
    this.finder?.comments.letGoFound();
    this.finder?.show(this.inComments, -1, false);
    this.showCount();
  }

  /** To match k in the cards: its card in focus and in sight; the keyboard stays in the bar. */
  private goComment(k: number): void {
    const target = this.target;
    const finder = this.finder;
    const m = this.inComments[k];
    if (!target || !finder || !m) return;
    if (this.onComment < 0) this.leftAt = target.selection();
    this.onComment = k;
    this.current = -1;
    target.show(this.matches, -1, false);
    finder.comments.showFound(m.id);
    finder.show(this.inComments, k, true);
    this.showCount();
  }

  /** Make sure the matches are for the text as it is now. */
  private fresh(): void {
    if (!this.target) return;
    if (this.searched !== this.target.version() || (this.finder && this.commentsSearched !== this.finder.version())) this.search(false);
  }

  step(direction: 1 | -1): void {
    if (!this.isOpen) {
      const tab = this.active();
      if (!tab || !this.input.value) return this.open(false);
      this.place(tab);
      this.el.hidden = false;
      this.bind();
      this.search(false);
    }
    const target = this.target;
    if (!target) return;
    this.fresh();
    const selection = target.selection();
    if (this.onComment >= 0 && this.movedOff(selection)) this.onComment = -1;
    const to = stepThrough(this.matches, this.inComments.length, this.onComment >= 0 ? this.leftAt! : selection, direction, this.onComment);
    if (!to) return;
    this.notice = null;
    if ("text" in to) this.goText(to.text);
    else this.goComment(to.comment);
  }

  /** As in Word: replace the selected match and go to the next; with none selected, find one first. */
  replaceOne(): void {
    const target = this.target;
    if (!target || !target.editable()) return;
    this.fresh();
    const match = this.matches[this.current];
    const selection = target.selection();
    if (!match || selection.from !== match.from || selection.to !== match.to) {
      // Find one in the text first: a comment is never replaced.
      const to = stepThrough(this.matches, 0, this.onComment >= 0 && this.leftAt ? this.leftAt : selection, 1, -1);
      if (to && "text" in to) this.goText(to.text);
      return;
    }
    const text = this.replaceInput.value;
    target.replace(match, text);
    this.notice = null;
    this.search(true, match.from + text.length);
    this.replaceInput.focus();
  }

  replaceAll(): void {
    const target = this.target;
    if (!target || !target.editable()) return;
    this.fresh();
    const count = this.matches.length;
    if (count) {
      target.replaceAll(this.matches, this.replaceInput.value);
      this.search(false);
    }
    this.notice = count ? `Replaced ${count.toLocaleString()}${this.inComments.length ? " (not in comments)" : ""}` : null;
    this.showCount();
    this.replaceInput.focus();
  }

  private showCount(): void {
    const query = this.input.value;
    this.count.textContent = this.notice ?? (query ? countWithComments(this.matches.length, this.current, this.inComments.length, this.onComment) : "");
    this.count.classList.toggle("none", !this.notice && !!query && !this.matches.length && !this.inComments.length);
  }
}
