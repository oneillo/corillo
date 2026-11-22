// Version history in the window: the Show changes and History buttons, the
// History panel beside the page, and a read-only view of a version marked with
// what it changed (added words highlighted, removed words struck through).
//
// Show changes marks everything since the person last handed the document
// over to an agent: every agent's pass and any change from another app, but
// not the person's own edits since (roadmap Batch 3, item 1; see
// since-hand-over.ts). Its banner counts the changes and steps through them,
// and the Comments column stays beside it. A version picked in History is
// shown with what it changed since the one before it.
//
// History reads as the story of the document (roadmap Batch 4, item 2): each
// row names the sections its version changed, and the person's own rows say
// what they changed, worked out as rows come into sight (see the version
// store's stories). Several of the person's versions in a row are one row:
// clicked, it shows what they changed together, and opens to each of them.
//
// Showing changes replaces the editor with a read-only copy while it's on.
// The marks always describe one pair of versions; if typing were allowed, each
// keystroke would start a new version and the marks would stop matching what
// the banner says, and struck-through words that can't be edited would sit in
// the middle of text that can. One click (or Escape) goes back to editing.
import { EditorState } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { DOMSerializer, type DOMOutputSpec, type Fragment, type Node } from "prosemirror-model";
import { schema } from "../core/schema";
import { parseCached } from "./parse-cache";
import { diffDocs, PICTURE_STAND_IN, type Change } from "../core/doc-diff";
import { formatDate, fullTime, handedOverAt, inSentence, relativeTime, versionLabel, type Brief, type Conversation, type RowStory, type SinceHandOver, type StoryAsk, type VersionRow, type VersionTexts } from "../core/versions";
import { extentOf, freshWords, marksSince, positionsOf, rebase, type Marks } from "../core/since-hand-over";
import { offsetAt, posAt, textIndex, type TextIndex } from "../core/anchors";
import { changeMarks, present } from "./change-marks";
import { commentRanges, DRAFT, markFor } from "./comments";
import { countText, summarizeChanges, type ChangeSummary } from "../core/change-summary";
import type { CorilloApi } from "../preload/preload";
import type { DocTab } from "./doc-tab";
import { whatsInSight, returnTo, type InSight } from "./doc-tab-place";
import { footnotePlugin } from "./footnotes";
import { copyPlugin } from "./copy";
import { obsidianPlugin } from "./obsidian";
import { blankLinesPlugin } from "./blank-lines";
import type { Source } from "../core/markdown";
import { ImageView, waitingMarker, type PictureStore } from "./images";
import { DiagramView, isDiagram } from "./diagrams";
import { ICONS } from "./icons";
import { movable } from "./more";
import { CARD_FOUND, COMMENT_MARKS, COMMENTS_WANTED } from "./comments-panel";
import { noticeOn } from "./file-notice";

export interface HistoryHost {
  api: CorilloApi;
  active(): DocTab | null;
  /** Something the toolbar shows has changed. */
  changed(): void;
}

export interface HistoryUi {
  update(): void;
  /** A version is showing instead of the editor (the toolbar's formatting buttons don't apply). */
  isViewing(tab: DocTab): boolean;
  /** The tab is closing: let go of its history view, so the document isn't kept in memory. */
  forget(tab: DocTab): void;
  // The same as the buttons, for the menus (View > Show Changes, View > Show History, File > Restore This Version).
  toggleChanges(tab: DocTab): void;
  /** Show changes on, never off: the done line's Show changes. A version shown in History gives way to it. */
  showChanges(tab: DocTab): void;
  /** Open or close History. Opened by its key or the menu (`keyboard`, the default), the keyboard goes to the newest version. */
  togglePanel(tab: DocTab, keyboard?: boolean): void;
  restore(tab: DocTab): void;
  status(tab: DocTab): HistoryStatus;
  /** Next or previous change, while Show changes is on: false when it isn't (the keys are Next and Previous Comment then). */
  step(tab: DocTab, forward: boolean): boolean;
  /**
   * With Show changes on, the words selected on its page, as places in the
   * document itself, for a comment (roadmap Batch 25, item 1): an empty
   * range with nothing selected, "removed" when only words shown as removed
   * are, and null while Show changes is off.
   */
  commentPick(tab: DocTab): { from: number; to: number } | "removed" | null;
}

export interface HistoryStatus {
  /** What's shown instead of the editor: the latest version's changes, an older version, or nothing. */
  viewing: "latest" | "older" | null;
  panelOpen: boolean;
  /** An older version is shown, and it can be made current now. */
  canRestore: boolean;
  /** Show changes is on: everything since the hand-over, with the Comments column beside it. */
  changes: boolean;
  /** How many changes it marks. */
  changeCount: number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(className: string, label: string): HTMLButtonElement {
  const b = el("button", className, label);
  b.type = "button";
  return b;
}

export function createHistory(toolbar: HTMLElement, host: HistoryHost): HistoryUi {
  const controllers = new Map<string, TabHistory>();
  const forTab = (tab: DocTab): TabHistory => {
    let c = controllers.get(tab.id);
    if (!c || c.tab !== tab) {
      c = new TabHistory(tab, host, () => update());
      controllers.set(tab.id, c);
    }
    return c;
  };

  const toolButton = (label: string, icon: string, title: string) => {
    const b = button("tool tool-text", "");
    b.innerHTML = `${icon}<span>${label}</span>`;
    b.setAttribute("aria-label", label);
    b.setAttribute("aria-pressed", "false");
    b.title = title;
    b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the cursor in the document
    return b;
  };
  const group = el("div", "tool-group history-tools");
  const changesButton = toolButton("Show changes", ICONS.changes, "Show what changed since you handed the document over (⌃⌘C)");
  const historyButton = toolButton("History", ICONS.history, "See this document's earlier versions (⌃⌘H)");
  group.append(changesButton, historyButton);
  // After Comment and Comments, before the two views (toolbar.ts); in a narrow window they go into More together.
  toolbar.insertBefore(group, toolbar.querySelector(".mode-switch"));
  movable("show-changes", changesButton);
  movable("history", historyButton);

  changesButton.addEventListener("click", () => {
    const tab = host.active();
    if (tab) void forTab(tab).toggleChanges();
  });
  // Pressed with the keyboard (Return or Space, no pointer), it opens with the keyboard in the list, as its key does.
  historyButton.addEventListener("click", (e) => {
    const tab = host.active();
    if (tab) void forTab(tab).togglePanel(e.detail === 0);
  });

  host.api.onHistoryChanged((tabId) => {
    const c = controllers.get(tabId);
    if (!c) return;
    if (!c.tab.el.isConnected) controllers.delete(tabId); // the tab was closed
    else void c.refresh();
  });

  function update(): void {
    const tab = host.active();
    const c = tab ? controllers.get(tab.id) : undefined;
    changesButton.disabled = historyButton.disabled = !tab;
    for (const [b, on] of [
      [changesButton, !!c?.changesMarked],
      [historyButton, !!c?.panelOpen],
    ] as const) {
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    }
  }

  function forget(tab: DocTab): void {
    const c = controllers.get(tab.id);
    if (!c || c.tab !== tab) return;
    controllers.delete(tab.id);
    c.destroy();
  }

  return {
    update,
    isViewing: (tab) => !!controllers.get(tab.id)?.viewing,
    forget,
    toggleChanges: (tab) => void forTab(tab).toggleChanges(),
    showChanges: (tab) => void forTab(tab).showChanges(),
    togglePanel: (tab, keyboard = true) => void forTab(tab).togglePanel(keyboard),
    restore: (tab) => void controllers.get(tab.id)?.restore(),
    status: (tab) => {
      const c = controllers.get(tab.id);
      const viewing = c?.viewing ? (c.viewing.latest ? "latest" : "older") : null;
      return { viewing, panelOpen: !!c?.panelOpen, canRestore: !!c?.canRestore, changes: !!c?.viewing?.since, changeCount: c?.changeCount ?? 0 };
    },
    step: (tab, forward) => controllers.get(tab.id)?.step(forward) ?? false,
    commentPick: (tab) => controllers.get(tab.id)?.commentPick() ?? null,
  };
}

/**
 * Where the person is reading on a page in sight (the editor, or the page
 * shown in its place), so the page that takes its place can show the same
 * words at the same place on screen (Batch 11, F-6).
 */
interface Place {
  /** The first blocks in sight; null at the very top, which stays the top. */
  reading: InSight | null;
  /** Where the scrolling area's top was on screen: the bars above it may change with the page. */
  top: number;
  scroll: number;
}

function placeIn(view: EditorView, scroller: HTMLElement): Place | null {
  if (!scroller.checkVisibility()) return null;
  return { reading: whatsInSight(view, scroller), top: scroller.getBoundingClientRect().top, scroll: scroller.scrollTop };
}

/** Put the words read on one page where they were on screen, on the page now in sight; `otherwise`, the scroll when that can't be worked out. */
function keepPlace(place: Place | null, view: EditorView | null, scroller: HTMLElement, otherwise: number): void {
  if (!place || !view || !scroller.checkVisibility()) {
    scroller.scrollTop = otherwise;
    return;
  }
  const shift = place.top - scroller.getBoundingClientRect().top;
  if (!place.reading) {
    // At the top: still the top, unless bars above went away, when the page
    // can't move down to stay put; if they grew, it moves up as far.
    scroller.scrollTop = Math.max(0, place.scroll - shift);
    return;
  }
  returnTo(view, scroller, { scroll: place.reading.scroll, blocks: place.reading.blocks.map((b) => ({ ...b, top: b.top + shift })) });
}

/** A row in the History list, kept while what it shows stays the same. */
interface Entry {
  li: HTMLLIElement;
  /** The row's button, named for a screen reader by who and when (nameRow). */
  item: HTMLElement;
  /** Who made it, as the row says. */
  who: string;
  when: HTMLElement;
  tag: HTMLElement | null;
  /** Who made the version, and whether it's open: when that changes, the row is made again. */
  key: string;
  brief: Brief | undefined;
  detail: Conversation | null;
  saved: string;
  /** Where it says what its versions changed. */
  slots: Slot[];
  /** Several versions shown as one, open: each one's time, kept true. */
  times: { el: HTMLElement; n: number; saved: string }[];
}

/** The rows' buttons, in the list's order: the versions, and the versions inside a row of several, open. */
const ROWS = ".history-item, .history-member";

/** A row's button, by what it stands for, so the list's one Tab stop stays on it as the list is drawn again. */
function stopKey(b: HTMLElement): string {
  if (b.classList.contains("history-member")) return `m${b.dataset.n}`;
  return b.dataset.fold ? `f${b.dataset.fold}` : `n${b.dataset.n}`;
}

/** Ids for what describes a row, unique in the window. */
let describedIds = 0;

/**
 * What a screen reader hears for a row (roadmap Batch 12, G-15, from N-3): a
 * short name, who and when and whether it's the current version, with what
 * it changed and the conversation's start as its description, read after a
 * pause. It used to read everything the row shows, every time.
 */
function nameRow(item: HTMLElement, who: string, when: string, current: boolean): void {
  const name = `${who}, ${when}${current ? ", current" : ""}`;
  if (item.getAttribute("aria-label") !== name) item.setAttribute("aria-label", name);
}

/** The row's description: these parts of it, read in order. */
function describeRow(item: HTMLElement, parts: HTMLElement[]): void {
  for (const part of parts) part.id ||= `history-said-${++describedIds}`;
  item.setAttribute("aria-describedby", parts.map((p) => p.id).join(" "));
}

/**
 * Where a row says what its version (or versions) changed: filled from what
 * the list brought, or asked for as the row comes into sight, a few rows at a
 * time, and kept while the panel is open.
 */
interface Slot {
  /** The row's button, watched for coming into sight. */
  button: HTMLElement;
  host: HTMLElement;
  ask: StoryAsk;
  /** What the main process gives it back under. */
  key: string;
  /** The newest version it's about, and when that was saved: what it says is for that. */
  last: number;
  saved: string;
  /** What it shows now. */
  source: RowStory | null;
}

/** One version, or several of the person's in a row shown as one (oldest first), with what the list keeps it under. */
interface Item {
  key: string;
  rows: VersionRow[];
}

/** How many rows' stories the window asks for at a time: about a panel's worth, so the main process is never busy for long. */
const STORIES_ASKED = 8;

/** The list's items, newest first: two or more of the person's versions in a row are one. */
function itemsOf(rows: VersionRow[]): Item[] {
  const items: Item[] = [];
  for (let i = rows.length - 1; i >= 0; ) {
    let j = i;
    if (rows[i].kind === "person") while (j > 0 && rows[j - 1].kind === "person") j--;
    const members = rows.slice(j, i + 1);
    items.push({ key: members.length > 1 ? `f${members[0].n}` : String(rows[i].n), rows: members });
    i = j - 1;
  }
  return items;
}

const rowKey = (v: VersionRow, open: boolean) =>
  [v.kind, v.agent ?? "", v.restoredFrom ? `${v.restoredFrom.n} ${v.restoredFrom.saved}` : "", open ? "open" : ""].join("|");

const sameBrief = (a: Brief | undefined, b: Brief | undefined) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** One tab's history: its panel, and the version shown instead of the editor, if any. */
class TabHistory {
  panelOpen = false;
  /**
   * The version shown; `since`: Show changes, everything since the hand-over,
   * rather than a version picked in History; `fold`: several of the person's
   * versions in a row, from this one to n, shown together.
   */
  viewing: { n: number; latest: boolean; saved: string; since?: boolean; fold?: number } | null = null;

  /**
   * Every version, oldest first, as the list shows it, and each agent's pass
   * in brief: kept while the panel is open or a version is shown, let go of
   * after. The whole conversation is fetched only for the version shown.
   */
  private rows: VersionRow[] = [];
  private briefs = new Map<number, Brief>();
  /** Given back to the main process, so it sends only what's new. */
  private stamp: string | null = null;
  private holder: string | null = null;
  private conversation: { n: number; brief: Brief; feedback: Conversation } | null = null;
  /** The rows on screen, by item (see itemsOf). */
  private entries = new Map<string, Entry>();
  /** The rows by version, as the list last showed them. */
  private byN = new Map<number, VersionRow>();
  /** What rows asked for said, under what it was asked for, and for which save of their newest version. */
  private told = new Map<string, { story: RowStory; saved: string }>();
  /** Rows' buttons in or near sight, with where each says what it changed. */
  private slotOf = new Map<Element, Slot>();
  private inSight = new Set<Element>();
  private watcher: IntersectionObserver | null = null;
  private askingStories = false;
  private loading: Promise<void> = Promise.resolve();
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  /** What the banner says about the version shown, besides who and when. */
  private shownFacts = { nothingEarlier: "", missing: false };

  /**
   * Whether changes are marked on the page shown: Show changes, or a version with what it changed. Not the first
   * version, with nothing earlier to compare it with (last look of Batch 12, L-8).
   */
  get changesMarked(): boolean {
    return !!this.viewing && (this.viewing.latest || !this.shownFacts.nothingEarlier);
  }
  /**
   * With Show changes on: what it marks and why, the change the arrows last
   * went to, and the document as shown with its words, to find a card's.
   */
  private since: { facts: SinceHandOver; marks: Marks; current: number | null; holder: string | null; doc: Node; words: TextIndex | null } | null = null;
  private readonly panel: HTMLElement;
  private readonly list: HTMLOListElement;
  private readonly banner: HTMLElement;
  private readonly bannerText: HTMLElement;
  private readonly restoreButton: HTMLButtonElement;
  private readonly backButton: HTMLButtonElement;
  /** Show changes' arrows, and which change of how many the arrows are on. */
  private readonly steps: HTMLElement;
  private readonly place: HTMLElement;
  /** What a step says to a screen reader: where it is, or that there are no more changes that way. */
  private readonly said: HTMLElement;
  private readonly canvas: HTMLElement;
  private readonly page: HTMLElement;
  private view: EditorView | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;
  private editorScroll = 0;
  private showing = 0;
  /** The ticket of a version the person asked for, while it's on its way: a new version arriving meanwhile doesn't replace it. */
  private asked: number | null = null;
  private destroyed = false;
  /** The row the list last showed open (see itemsOf). */
  private opened: string | null = null;
  /** The row the list's one Tab stop is on (stopKey), once the keyboard has been in the list. */
  private stopOn: string | null = null;
  /** While the page just shown settles: what puts the words back, and what stops it (see keepSettling). */
  private settling: AbortController | null = null;

  constructor(
    readonly tab: DocTab,
    private host: HistoryHost,
    private updateButtons: () => void,
  ) {
    // The banner, under any other banner at the top of the tab.
    this.banner = el("div", "banner version-banner");
    this.banner.hidden = true;
    // Its sentence is said when it changes; the place in the changes is said on its own, once (Batch 24, K-13).
    this.bannerText = el("span", "version-banner-text");
    this.bannerText.setAttribute("role", "status");
    // Looking is what a version is opened for most often: going back is the main button, restoring a plain one
    // chosen on purpose (review of Batch 11, F-21). With only Hide changes, it is plain like every bar's action.
    this.restoreButton = button("restore-version", "Restore this version");
    this.restoreButton.addEventListener("click", () => void this.restore());
    this.backButton = button("back-to-current", "Back to current");
    this.backButton.addEventListener("click", () => this.back());
    this.steps = el("div", "version-steps");
    this.steps.hidden = true;
    this.place = el("span", "version-step-place");
    this.said = el("span", "version-step-said");
    this.said.setAttribute("aria-live", "polite");
    const arrow = (forward: boolean) => {
      const b = button(`version-step ${forward ? "next" : "previous"}`, "");
      b.innerHTML = forward ? ICONS.next : ICONS.previous;
      b.setAttribute("aria-label", forward ? "Next change" : "Previous change");
      b.title = forward ? "Next change (⌥⌘↓)" : "Previous change (⌥⌘↑)";
      b.addEventListener("mousedown", (e) => e.preventDefault()); // the keyboard stays where it is
      b.addEventListener("click", () => this.step(forward));
      return b;
    };
    this.steps.append(arrow(false), this.place, arrow(true), this.said);
    this.banner.append(this.bannerText, this.steps, this.restoreButton, this.backButton);
    // Escape on the bar's buttons steps out to the page under it; Escape there goes back to writing (roadmap Batch 12, G-10).
    this.banner.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !this.viewing) return;
      e.preventDefault();
      this.page.focus({ preventScroll: true });
    });
    const banners = tab.main.querySelectorAll(":scope > .banner");
    if (banners.length) banners[banners.length - 1].after(this.banner);
    else tab.main.prepend(this.banner);

    // The read-only page, in place of the editor while a version is shown.
    this.canvas = el("main", "canvas version-view");
    this.canvas.hidden = true;
    this.page = el("article", "page version-page");
    this.page.setAttribute("aria-label", "Version");
    this.page.tabIndex = -1;
    this.page.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.back();
      // Tab goes on to the bar's buttons, which come before the page (Batch 24, K-3).
      else if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const first = [...this.banner.querySelectorAll<HTMLButtonElement>("button")].find((b) => !b.disabled && b.checkVisibility());
        if (!first) return;
        e.preventDefault();
        first.focus();
      }
    });
    this.canvas.append(this.page);
    const editorCanvas = this.editorCanvas();
    if (editorCanvas) editorCanvas.after(this.canvas);
    else tab.el.append(this.canvas);

    // The panel, to the right of the page.
    this.panel = el("aside", "history-panel");
    this.panel.setAttribute("aria-label", "History");
    this.panel.hidden = true;
    const header = el("div", "history-header panel-head");
    const title = el("h2", "", "History");
    const close = button("history-close", "");
    close.innerHTML = ICONS.close;
    close.setAttribute("aria-label", "Close history");
    close.title = "Close history";
    close.addEventListener("click", () => this.closePanel());
    header.append(title, close);
    const hint = el("p", "history-hint", "Click a version to see what it changed and the whole conversation behind it.");
    this.list = el("ol", "history-list");
    this.panel.append(header, hint, this.list);
    // The list is one Tab stop, as the outline is (roadmap Batch 12, G-3): Up and Down move through the versions,
    // Home and End go to the ends, Return or Space shows the one the keyboard is on.
    this.list.addEventListener("keydown", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement) || !target.matches(ROWS) || e.metaKey || e.ctrlKey || e.altKey) return;
      const rows = [...this.list.querySelectorAll<HTMLElement>(ROWS)];
      const at = rows.indexOf(target);
      const to = { ArrowDown: Math.min(at + 1, rows.length - 1), ArrowUp: Math.max(at - 1, 0), Home: 0, End: rows.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      rows[to].focus();
    });
    this.list.addEventListener("focusin", (e) => {
      if (e.target instanceof HTMLElement && e.target.matches(ROWS)) {
        this.stopOn = stopKey(e.target);
        this.oneStop();
      }
    });
    // Escape leaves the version shown from the list too, as from the page. With none shown, Escape on Close or a row
    // steps out to the page, as from the Comments panel's buttons (review of Batch 12, B12-4).
    this.panel.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      if (this.viewing) this.back();
      else this.tab.focus();
    });
    // Beside the page, in the same row as the comments panel.
    const body = tab.el.querySelector<HTMLElement>(":scope > .doc-body");
    (body ?? tab.el).append(this.panel);
    tab.el.addEventListener(COMMENTS_WANTED, this.giveWay);
    // With Show changes on, a card clicked, or gone to by Find, shows its words and change on the page shown.
    tab.comments.el.addEventListener("click", this.cardClicked);
    tab.comments.el.addEventListener(CARD_FOUND, this.cardFound);
    // The comment being written, or in focus, is marked on Show changes' page too (roadmap Batch 25, item 1).
    tab.comments.el.addEventListener(COMMENT_MARKS, this.commentMarksMoved);
  }

  /**
   * A comment being written is to have the keyboard back (Go Back to It, on
   * closing), or Find went into a card: the panel gives the comments their
   * place, unless a version is shown on its own (the comments aren't beside
   * it). With Show changes on they are, and the changes stay shown.
   */
  private readonly giveWay = () => {
    if (this.panelOpen && (!this.viewing || this.viewing.since)) this.closePanel();
  };

  private editorCanvas(): HTMLElement | null {
    return this.tab.el.querySelector<HTMLElement>(".canvas:not(.version-view)");
  }

  /** The editor's page while it's showing: in the Markdown view, it's kept out of sight with its own scroll. */
  private editorShowing(): HTMLElement | null {
    const canvas = this.editorCanvas();
    return canvas?.hidden ? null : canvas;
  }

  /** Where the person is reading in the editor, while it's in sight. */
  private editorPlace(): Place | null {
    const canvas = this.editorShowing();
    return canvas ? placeIn(this.tab.view, canvas) : null;
  }

  /** Bring the rows up to date: only what's new, once there are some. One at a time, so each builds on the last. */
  private load(): Promise<void> {
    const next = this.loading.then(async () => {
      if (this.destroyed) return;
      const known = this.stamp === null ? undefined : { stamp: this.stamp, count: this.rows.length };
      const kept = this.rows;
      const result = await this.host.api.historyList(this.tab.id, known);
      // Let go of meanwhile (the panel closed): what came is no longer wanted.
      if (this.destroyed || this.rows !== kept) return;
      this.rows = result.from ? [...this.rows.slice(0, result.from), ...result.versions] : result.versions;
      if (result.briefs) this.briefs = new Map(Object.entries(result.briefs).map(([n, b]) => [Number(n), b]));
      this.stamp = result.stamp;
      this.holder = result.holder;
    });
    this.loading = next.catch(() => {});
    return next;
  }

  /** Nothing is kept for a panel that's closed, beyond what the version still shown needs. */
  private letGo(): void {
    if (!this.panelOpen) {
      this.list.replaceChildren();
      this.entries.clear();
      this.opened = null;
      this.stopOn = null;
      this.watcher?.disconnect();
      this.watcher = null;
      this.slotOf.clear();
      this.inSight.clear();
      this.told.clear();
      this.byN.clear();
    }
    if (!this.panelOpen && !this.viewing) {
      this.rows = [];
      this.briefs = new Map();
      this.stamp = null;
      this.conversation = null;
    }
  }

  // The panel ------------------------------------------------------------------

  /**
   * Open or close History. Opened with the keyboard (its key, the menu, or
   * its button pressed with Return), the keyboard goes to the newest version
   * (roadmap Batch 12, G-3, a change to how the person works: it stayed in the page,
   * which Tab can't leave). Clicked with the mouse, it stays where it was.
   */
  async togglePanel(keyboard = false): Promise<void> {
    if (this.panelOpen) return this.closePanel();
    this.panelOpen = true;
    this.panel.hidden = false;
    this.tab.el.classList.add("history-open");
    this.changed();
    // A key pressed or a click while the list is on its way: the keyboard then stays where that put it (review of Batch 12, B12-7).
    let moved = false;
    const mark = () => (moved = true);
    document.addEventListener("keydown", mark, true);
    document.addEventListener("pointerdown", mark, true);
    try {
      await this.tab.saveNow(); // so the newest version includes the last few keystrokes
      await this.load();
    } finally {
      document.removeEventListener("keydown", mark, true);
      document.removeEventListener("pointerdown", mark, true);
    }
    // Closed again, or the tab closed, while the list was on its way: nothing to show or keep current.
    if (!this.panelOpen || this.destroyed) return this.letGo();
    this.opened = null; // the version shown, if any, is brought into sight
    this.syncList();
    // With its ring at once, where focus by a menu's key wouldn't draw it (last look, L-1).
    if (keyboard && !moved) this.list.querySelector<HTMLElement>(ROWS)?.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
    if (this.clock) clearInterval(this.clock);
    this.clock = setInterval(() => this.updateTimes(), 60_000);
  }

  closePanel(): void {
    // The keyboard in the list (or lost): it comes back to the page, not nowhere (roadmap Batch 12, G-3).
    const was = document.activeElement;
    const inList = !was || was === document.body || this.panel.contains(was);
    this.panelOpen = false;
    this.panel.hidden = true;
    this.tab.el.classList.remove("history-open");
    if (this.clock) clearInterval(this.clock);
    this.clock = null;
    if (this.viewing && !this.viewing.latest) this.back();
    else if (!this.viewing) this.keyboardBack(inList);
    else if (inList) this.page.focus({ preventScroll: true }); // Show changes stays: its page
    this.letGo();
    this.changed();
  }

  /**
   * Back from a version, or from History: the keyboard goes to the comment,
   * reply or edit being written, once it's on screen again, so typing never
   * lands on the words it's on. While History still hides it, nowhere. With
   * no comment being written, to the document (`toDocument`) or left as it is.
   */
  private keyboardBack(toDocument: boolean): void {
    const box = this.tab.comments.boxInUse();
    if (box) {
      if (box.checkVisibility()) this.tab.comments.showUnposted(box);
      return;
    }
    if (toDocument) this.tab.focus();
  }

  /**
   * The list, newest first. Each version is compact (who, when, and for an
   * agent's pass the start of each comment and reply); the version shown opens
   * in place to the whole conversation behind it. Only what changed is
   * redrawn: a save that moves the newest version's time changes that time, a
   * new version adds a row, and words selected in a conversation stay selected.
   */
  private syncList(): void {
    const viewing = this.viewing;
    const newest = this.rows[this.rows.length - 1]?.n;
    this.byN = new Map(this.rows.map((v) => [v.n, v]));
    let opened = null as HTMLElement | null; // set in the loop below
    let openKey: string | null = null;
    const entries = new Map<string, Entry>();
    const wanted: HTMLLIElement[] = [];
    for (const item of itemsOf(this.rows)) {
      const fold = item.rows.length > 1;
      const v = item.rows[item.rows.length - 1];
      let open: boolean;
      let key: string;
      let brief: Brief | undefined;
      let detail: Conversation | null = null;
      if (fold) {
        open = !!viewing && (viewing.fold === item.rows[0].n || (viewing.fold === undefined && item.rows.some((r) => r.n === viewing.n)));
        const current = !open ? "" : viewing!.fold !== undefined ? "all" : String(viewing!.n);
        key = `fold|${item.rows.map((r) => r.n).join(",")}|${current}`;
      } else {
        open = !!viewing && viewing.fold === undefined && viewing.n === v.n;
        brief = this.briefs.get(v.n);
        detail = open && brief && this.conversation?.n === v.n ? this.conversation.feedback : null;
        key = rowKey(v, open);
      }
      if (open) openKey = item.key;
      let e = this.entries.get(item.key);
      if (e && e.key === key && e.detail === detail && sameBrief(e.brief, brief)) e.brief = brief;
      else {
        if (e) this.unwatch(e);
        e = fold ? this.foldEntry(item.rows, open) : this.entry(v, open, brief, detail);
        e.key = key;
        if ((detail || (fold && open)) && this.opened !== item.key) opened = e.li;
      }
      if (e.saved !== v.saved) {
        e.saved = v.saved;
        e.when.textContent = relativeTime(v.saved);
        e.when.title = fullTime(v.saved);
        nameRow(e.item, e.who, e.when.textContent, !!e.tag);
      }
      for (const t of e.times) {
        const saved = this.byN.get(t.n)?.saved;
        if (saved && saved !== t.saved) {
          t.saved = saved;
          t.el.textContent = relativeTime(saved);
          t.el.title = fullTime(saved);
          nameRow(t.el.parentElement!, "You", t.el.textContent, false);
        }
      }
      if ((v.n === newest) !== !!e.tag) {
        if (e.tag) e.tag.remove();
        e.tag = v.n === newest ? el("span", "history-tag", "Current") : null;
        if (e.tag) e.when.after(e.tag);
        nameRow(e.item, e.who, e.when.textContent ?? "", !!e.tag);
      }
      for (const slot of e.slots) this.fillSlot(slot);
      entries.set(item.key, e);
      wanted.push(e.li);
    }
    for (const [k, e] of this.entries) {
      if (entries.get(k) !== e) {
        e.li.remove();
        this.unwatch(e);
      }
    }
    this.entries = entries;
    // In order, without moving a row that's already in its place.
    let at = this.list.firstElementChild;
    for (const li of wanted) {
      if (at === li) at = li.nextElementSibling;
      else this.list.insertBefore(li, at);
    }
    this.opened = openKey;
    this.oneStop();
    // A version just opened: bring its conversation into sight, keeping its top in view.
    if (opened) {
      const list = this.list.getBoundingClientRect();
      const entry = opened.getBoundingClientRect();
      if (entry.top < list.top) this.list.scrollTop += entry.top - list.top - 4;
      else if (entry.bottom > list.bottom) this.list.scrollTop += Math.min(entry.bottom - list.bottom + 8, entry.top - list.top - 4);
    }
    this.askStories();
  }

  /** A version's row: compact, or open to the whole conversation behind it. */
  private entry(v: VersionRow, open: boolean, brief: Brief | undefined, detail: Conversation | null): Entry {
    const li = el("li", open ? "history-entry open" : "history-entry");
    const item = button("history-item", "");
    item.dataset.n = String(v.n);
    item.setAttribute("aria-current", String(open));
    const who = el("span", "history-who", versionLabel(v));
    const when = el("span", "history-when", relativeTime(v.saved));
    when.title = fullTime(v.saved);
    item.append(who, when);
    const slots: Slot[] = [];
    if (v.kind !== "first") {
      const story = el("span", "history-story");
      item.append(story);
      slots.push(this.watch(item, story, v.n, String(v.n), v));
    }
    const said = [...item.querySelectorAll<HTMLElement>(".history-story")];
    if (brief && !open) said.push(item.appendChild(compact(brief)));
    nameRow(item, versionLabel(v), when.textContent ?? "", false);
    if (said.length) describeRow(item, said);
    item.addEventListener("click", () => void this.pick(v.n));
    li.append(item);
    if (detail) li.append(conversation(detail));
    return { li, item, who: versionLabel(v), when, tag: null, key: rowKey(v, open), brief, detail, saved: v.saved, slots, times: [] };
  }

  /**
   * Several of the person's versions in a row, as one row: what they changed
   * together. Open (they're shown together, or one of them is), it lists each
   * of them, newest first, to see on its own (and restore).
   */
  private foldEntry(rows: VersionRow[], open: boolean): Entry {
    const viewing = this.viewing;
    const from = rows[0];
    const last = rows[rows.length - 1];
    const together = open && viewing?.fold === from.n;
    const li = el("li", open ? "history-entry history-fold open" : "history-entry history-fold");
    const item = button("history-item", "");
    item.dataset.n = String(last.n);
    item.dataset.fold = String(from.n);
    item.setAttribute("aria-current", String(together));
    item.setAttribute("aria-expanded", String(open));
    const who = el("span", "history-who", `You · ${rows.length} versions`);
    const when = el("span", "history-when", relativeTime(last.saved));
    when.title = fullTime(last.saved);
    const story = el("span", "history-story");
    item.append(who, when, story);
    nameRow(item, `You, ${rows.length} versions`, when.textContent ?? "", false);
    describeRow(item, [story]);
    item.addEventListener("click", () => void this.pickFold(from.n));
    li.append(item);
    const slots = [this.watch(item, story, { from: from.n, to: last.n }, `${from.n}-${last.n}`, last)];
    const times: Entry["times"] = [];
    if (open) {
      const members = el("ol", "history-members");
      members.setAttribute("aria-label", "Each of these versions");
      for (const v of [...rows].reverse()) {
        const member = button("history-member", "");
        member.dataset.n = String(v.n);
        member.setAttribute("aria-current", String(!together && viewing?.n === v.n));
        const time = el("span", "history-member-when", relativeTime(v.saved));
        time.title = fullTime(v.saved);
        const its = el("span", "history-story");
        member.append(time, its);
        nameRow(member, "You", time.textContent ?? "", false);
        describeRow(member, [its]);
        member.addEventListener("click", () => void this.pick(v.n));
        const entry = el("li", "");
        entry.append(member);
        members.append(entry);
        slots.push(this.watch(member, its, v.n, String(v.n), v));
        times.push({ el: time, n: v.n, saved: v.saved });
      }
      li.append(members);
    }
    return { li, item, who: `You, ${rows.length} versions`, when, tag: null, key: "", brief: undefined, detail: null, saved: last.saved, slots, times }; // its key is set by syncList
  }

  /**
   * The list is one Tab stop: on the row the keyboard was last on, else the
   * version shown, else the newest. The others are reached with the arrows.
   */
  private oneStop(): void {
    const rows = [...this.list.querySelectorAll<HTMLElement>(ROWS)];
    const stop =
      rows.find((b) => b === document.activeElement) ??
      rows.find((b) => stopKey(b) === this.stopOn) ??
      rows.find((b) => b.getAttribute("aria-current") === "true") ??
      rows[0];
    for (const b of rows) {
      const index = b === stop ? "0" : "-1";
      if (b.getAttribute("tabindex") !== index) b.setAttribute("tabindex", index);
    }
  }

  // What each row says it changed ------------------------------------------------------

  /** A row's story place, watched for coming into sight. */
  private watch(button: HTMLElement, host: HTMLElement, ask: StoryAsk, key: string, last: VersionRow): Slot {
    this.watcher ??= new IntersectionObserver(
      (seen) => {
        for (const s of seen) {
          if (s.isIntersecting) this.inSight.add(s.target);
          else this.inSight.delete(s.target);
        }
        this.askStories();
      },
      { root: this.list, rootMargin: "240px 0px" },
    );
    const slot: Slot = { button, host, ask, key, last: last.n, saved: last.saved, source: null };
    this.slotOf.set(button, slot);
    this.watcher.observe(button);
    return slot;
  }

  private unwatch(e: Entry): void {
    for (const slot of e.slots) {
      this.watcher?.unobserve(slot.button);
      this.slotOf.delete(slot.button);
      this.inSight.delete(slot.button);
    }
  }

  /** What a row's versions changed, if it's known for the newest one's last save: as the list brought it, or as told. */
  private storyFor(slot: Slot): RowStory | undefined {
    const row = typeof slot.ask === "number" ? this.byN.get(slot.ask) : undefined;
    if (row && (row.sections || row.change)) return row;
    const told = this.told.get(slot.key);
    return told && told.saved === slot.saved ? told.story : undefined;
  }

  /** Show what the row's versions changed, if it's known and not shown yet; what it showed stays until then. */
  private fillSlot(slot: Slot): void {
    slot.saved = this.byN.get(slot.last)?.saved ?? slot.saved;
    const story = this.storyFor(slot);
    if (!story || story === slot.source) return;
    slot.source = story;
    slot.host.replaceChildren(...storyParts(story));
  }

  /** Ask for what the rows in sight changed, where it isn't known: a few at a time, one ask at a time. */
  private askStories(): void {
    if (this.askingStories || !this.panelOpen || this.destroyed) return;
    const asks: Slot[] = [];
    for (const button of this.inSight) {
      const slot = this.slotOf.get(button);
      if (slot && !this.storyFor(slot)) asks.push(slot);
      if (asks.length === STORIES_ASKED) break;
    }
    if (!asks.length) return;
    this.askingStories = true;
    const done = (told: Record<string, RowStory>) => {
      this.askingStories = false;
      if (this.destroyed || !this.panelOpen) return;
      // One that wasn't given (the version before it was damaged): nothing to say, and not asked again.
      for (const slot of asks) this.told.set(slot.key, { story: told[slot.key] ?? {}, saved: slot.saved });
      for (const slot of asks) if (this.slotOf.get(slot.button) === slot) this.fillSlot(slot);
      this.askStories();
    };
    this.host.api.historyStories(this.tab.id, asks.map((slot) => slot.ask)).then(done, () => done({}));
  }

  /** Keep "5 min ago" true, without redrawing the list (words selected in it stay selected). */
  private updateTimes(): void {
    if (!this.tab.el.isConnected && this.clock) {
      clearInterval(this.clock); // the tab was closed
      this.clock = null;
      return;
    }
    for (const e of this.entries.values()) {
      e.when.textContent = relativeTime(e.saved);
      nameRow(e.item, e.who, e.when.textContent, !!e.tag);
      for (const t of e.times) {
        t.el.textContent = relativeTime(t.saved);
        nameRow(t.el.parentElement!, "You", t.el.textContent, false);
      }
    }
  }

  // Showing a version ----------------------------------------------------------------

  async toggleChanges(): Promise<void> {
    if (this.viewing) return this.back();
    await this.tab.saveNow();
    await this.load();
    if (this.rows.length) await this.showSince();
  }

  /** Show changes on, from the document or from a version shown in History (review of Batch 9, B9-03). */
  async showChanges(): Promise<void> {
    if (this.viewing?.since) return;
    if (this.viewing) this.back(); // to the document as it is now, as Back to current does
    await this.toggleChanges();
  }

  private async pick(n: number): Promise<void> {
    if (!this.viewing) await this.tab.saveNow();
    await this.show(n);
  }

  private async pickFold(from: number): Promise<void> {
    if (!this.viewing) await this.tab.saveNow();
    await this.showFold(from);
  }

  /** The person's versions in a row from version `from`, oldest first, if there are several (see itemsOf). */
  private foldFrom(from: number): VersionRow[] | null {
    const i = this.rows.findIndex((v) => v.n === from);
    if (i < 1 || this.rows[i].kind !== "person" || this.rows[i - 1].kind === "person") return null;
    let j = i;
    while (j + 1 < this.rows.length && this.rows[j + 1].kind === "person") j++;
    return j > i ? this.rows.slice(i, j + 1) : null;
  }

  /** The whole conversation behind version n, if its pass left one: the one kept, or fetched. */
  private async conversationFor(n: number): Promise<{ n: number; brief: Brief; feedback: Conversation } | null> {
    const brief = this.briefs.get(n);
    if (!brief) return null;
    const kept = this.conversation;
    if (kept?.n === n && sameBrief(kept.brief, brief)) return { ...kept, brief };
    const feedback = await this.host.api.historyConversation(this.tab.id, n);
    return feedback ? { n, brief, feedback } : null;
  }

  /**
   * Show version n, read-only, marked with what it changed since the version
   * before it. `quietly`: the history changed under a version already shown;
   * the keyboard stays where it is.
   */
  private async show(n: number, quietly = false): Promise<void> {
    const ticket = ++this.showing;
    if (!quietly) this.asked = ticket;
    const [texts, conversation] = await Promise.all([this.host.api.historyVersion(this.tab.id, n), this.conversationFor(n)]);
    if (this.asked === ticket) this.asked = null;
    if (ticket !== this.showing || this.destroyed) return; // something newer was asked for meanwhile
    const index = this.rows.findIndex((v) => v.n === n);
    if (index < 0) return;
    const version = this.rows[index];
    const latest = index === this.rows.length - 1;
    this.display({ n, latest, saved: version.saved }, texts, conversation, quietly);
  }

  /**
   * Show several of the person's versions in a row together (see itemsOf):
   * the newest of them, marked with what they changed since the version
   * before them. Restore makes the newest of them current again.
   */
  private async showFold(from: number, quietly = false): Promise<void> {
    const ticket = ++this.showing;
    if (!quietly) this.asked = ticket;
    const rows = this.foldFrom(from);
    const before = rows && this.rows[this.rows.indexOf(rows[0]) - 1];
    const texts = rows && before ? await this.host.api.historyCompare(this.tab.id, rows[rows.length - 1].n, before.n) : null;
    if (this.asked === ticket) this.asked = null;
    if (ticket !== this.showing || this.destroyed || !texts) return; // something newer was asked for meanwhile
    const now = this.foldFrom(from);
    const last = now?.[now.length - 1];
    if (!last || last.n !== rows![rows!.length - 1].n) return; // changed meanwhile: the list's refresh shows it as it is
    this.display({ n: last.n, latest: last === this.rows[this.rows.length - 1], saved: last.saved, fold: from }, texts, null, quietly);
  }

  /** Show a version (or several together) in place of the editor, marked with what it changed. */
  private display(viewing: NonNullable<TabHistory["viewing"]>, texts: VersionTexts, conversation: TabHistory["conversation"], quietly: boolean): void {
    const firstShow = !this.viewing;
    const reading = firstShow ? this.editorPlace() : null;
    if (!this.viewing) this.editorScroll = this.editorShowing()?.scrollTop ?? 0;
    this.viewing = viewing;
    this.conversation = conversation;
    this.since = null;
    // What an agent's change said before goes off as another page takes the editor's place (Batch 24, W-3).
    if (this.tab.comments.beforeInfo().on) this.tab.comments.toggleBefore(false);
    this.tab.el.classList.add("viewing-version");
    this.tab.el.classList.remove("viewing-changes");
    this.canvas.hidden = false;

    if (texts.text === null) {
      this.view?.destroy();
      this.view = null;
      this.page.replaceChildren(el("p", "version-missing", "This version can't be shown: part of the history was damaged."));
    } else {
      const { doc, source } = parseCached(texts.text);
      const changes = texts.before === null ? [] : diffDocs(parseCached(texts.before).doc, doc);
      this.render(doc, changes, source);
    }

    this.shownFacts = {
      nothingEarlier: !texts.hasBefore
        ? " There's nothing earlier to compare it with."
        : texts.before === null
          ? ` The version before ${viewing.fold === undefined ? "it" : "them"} can't be shown, so nothing is marked.`
          : "",
      missing: texts.text === null,
    };
    this.setBanner();
    this.banner.hidden = false;
    if (this.panelOpen) this.syncList();
    if (!quietly) {
      if (document.activeElement instanceof HTMLElement && !this.page.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      this.page.focus({ preventScroll: true });
    }
    this.changed();
    // Once the banner and everything around the page are as they'll be, so the words stay where they were on screen.
    if (firstShow) this.keepSettling(reading);
  }

  /**
   * Show changes: the text now, read-only, marked with everything others
   * changed since the person last handed it over (see since-hand-over.ts),
   * the Comments column beside it. `quietly`: the history changed while it's
   * shown; the keyboard stays where it is.
   */
  private async showSince(quietly = false): Promise<void> {
    const ticket = ++this.showing;
    if (!quietly) this.asked = ticket;
    // Everything is worked out and drawn before anything on screen changes: if
    // that fails, the page is left as it was and the tab says so (B3-R09),
    // never an empty page with no word.
    let shown: { facts: SinceHandOver; conversation: TabHistory["conversation"]; doc: Node; marks: Marks; words: TextIndex | null };
    let drawing = false;
    try {
      const facts = await this.host.api.historySince(this.tab.id);
      const conversation = facts.n ? await this.conversationFor(facts.n) : null;
      if (this.asked === ticket) this.asked = null;
      if (ticket !== this.showing || this.destroyed) return; // something newer was asked for meanwhile
      const { doc, source } = parseCached(facts.text);
      let marks: Marks = { changes: [], groups: [], count: 0 };
      let words: TextIndex | null = null;
      if (facts.base !== null) {
        const wordsOf = (markdown: string) => (markdown === facts.text ? (words ??= textIndex(doc)).text : textIndex(parseCached(markdown).doc).text);
        const { before, yours } = rebase(facts.base, facts.steps, wordsOf);
        if (before !== facts.text) {
          const was = parseCached(before).doc;
          const changes = diffDocs(was, doc);
          const index = (words ??= textIndex(doc));
          if (changes.length) marks = marksSince(doc, changes, positionsOf(index, yours, doc.content.size), () => freshWords(index, textIndex(was).text));
        }
      }
      drawing = true;
      this.render(doc, marks.changes, source, marks.groups, null);
      shown = { facts, conversation, doc, marks, words };
    } catch (err) {
      if (this.asked === ticket) this.asked = null;
      if (ticket !== this.showing || this.destroyed) return;
      console.error("Show changes couldn't work out what changed.", err);
      this.cantShowChanges(drawing);
      return;
    }

    const { facts, conversation, doc, marks, words } = shown;
    const firstShow = !this.viewing;
    const reading = firstShow ? this.editorPlace() : null;
    if (!this.viewing) this.editorScroll = this.editorShowing()?.scrollTop ?? 0;
    this.viewing = { n: facts.n, latest: true, saved: facts.saved, since: true };
    this.conversation = conversation;
    // What an agent's change said before goes off as another page takes the editor's place (Batch 24, W-3).
    if (this.tab.comments.beforeInfo().on) this.tab.comments.toggleBefore(false);
    this.tab.el.classList.add("viewing-version", "viewing-changes");
    this.canvas.hidden = false;
    this.since = { facts, marks, current: null, holder: this.holder, doc, words };
    this.setBanner();
    this.banner.hidden = false;
    // Once the banner is up, so the words stay where they were on screen.
    if (firstShow) this.keepSettling(reading);
    if (this.panelOpen) this.syncList();
    if (!quietly) {
      if (document.activeElement instanceof HTMLElement && !this.page.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      this.page.focus({ preventScroll: true });
    }
    this.changed();
  }

  /**
   * Show changes couldn't work out the marks: the page stays as it was (back
   * to the document, if changes were already shown and can't be brought up to
   * date), and the tab says so, in its corner. `drawn`: it failed while
   * drawing, which may have left a version shown half drawn; that version is
   * shown again, whole (B6-R09).
   */
  private cantShowChanges(drawn = false): void {
    const viewing = this.viewing;
    if (viewing?.since) this.back();
    else if (!viewing || drawn) {
      try {
        this.view?.destroy();
      } catch {
        // half drawn: what's left of it goes with the page
      }
      this.view = null;
      this.page.replaceChildren();
      if (viewing) void (viewing.fold !== undefined ? this.showFold(viewing.fold, true) : this.show(viewing.n, true));
    }
    noticeOn(this.tab.el).show(
      "Corillo couldn't show the changes.",
      "Something went wrong working out what changed since you handed the document over. Your document is fine, and History has every version.",
    );
  }

  /** How many changes Show changes marks (0 while it's off). */
  get changeCount(): number {
    return this.viewing?.since ? (this.since?.marks.count ?? 0) : 0;
  }

  /** The banner over Show changes: how many changes, by whom, since when, and the arrows to step through them. */
  private setSinceBanner(): void {
    const s = this.since;
    if (!s) return;
    const { facts, marks } = s;
    const at = facts.at ? handedOverAt(facts.at) : "";
    const names = [...facts.agents, ...(facts.outside ? ["another app"] : [])];
    const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
    let words: string;
    // True of a draft an agent created, too: nobody has taken it from the person yet (B3-R07).
    if (!facts.at) words = "You haven't handed this document to an agent yet, so there are no changes to show. History has every version.";
    else if (facts.base === null) words = `The text you handed over ${at} can't be shown: part of the history was damaged, so nothing is marked.`;
    else if (!names.length) words = `No one else has changed the text since you handed it over ${at}.`;
    else if (!marks.count && facts.steps.some((step) => step.yours)) {
      words = `None of the changes ${who} made since you handed it over ${at} are left to mark: you've edited those places since.`;
    } else if (!marks.count) words = `${who} changed only spaces or empty lines since you handed it over ${at}, so there's nothing to mark.`;
    else words = `${marks.count === 1 ? "1 change" : `${marks.count} changes`} by ${who} since you handed it over ${at}.`;
    const sentence = `${words} Editing is paused while changes are shown.`;
    // Set again only when it changes, so a step doesn't say the whole sentence again.
    if (this.bannerText.textContent !== sentence) this.bannerText.textContent = sentence;
    this.page.setAttribute("aria-label", "Changes since you handed it over");
    this.bannerText.title = facts.at ? `Handed over ${fullTime(facts.at)}` : "";
    this.steps.hidden = !marks.count;
    this.place.textContent = s.current === null ? "" : `${s.current + 1} of ${marks.count}`;
    this.backButton.textContent = "Hide changes";
    this.restoreButton.hidden = true;
  }

  /** The banner over the version shown: which it is, and whether it can be restored now. */
  private setBanner(): void {
    this.setVersionBanner();
    this.backButton.classList.toggle("primary", !this.restoreButton.hidden);
  }

  private setVersionBanner(): void {
    const viewing = this.viewing;
    if (viewing?.since) return this.setSinceBanner();
    this.steps.hidden = true;
    this.bannerText.title = "";
    const version = viewing && this.rows.find((v) => v.n === viewing.n);
    if (!viewing || !version) return;
    const who = versionLabel(version);
    // The page shown is named for what it is (Batch 24, K-3).
    this.page.setAttribute("aria-label", viewing.latest ? "Changes in the latest version" : `Version from ${formatDate(version.saved)}`);
    const { nothingEarlier, missing } = this.shownFacts;
    const count = viewing.fold === undefined ? 0 : (this.foldFrom(viewing.fold)?.length ?? 0);
    if (count && viewing.latest) {
      this.bannerText.textContent = `Showing what you changed in your last ${count} versions (the latest ${inSentence(relativeTime(version.saved))}).${nothingEarlier} Editing is paused while changes are shown.`;
      this.backButton.textContent = "Hide changes";
      this.restoreButton.hidden = true;
    } else if (count) {
      const marked = nothingEarlier ? `.${nothingEarlier}` : ", marked with what they changed together.";
      this.bannerText.textContent = `Your ${count} versions in a row, up to ${formatDate(version.saved)}${marked} You can look at them but not edit them. Restore brings back the newest of them.`;
      this.backButton.textContent = "Back to current";
      this.restoreButton.hidden = false;
      this.restoreButton.disabled = !!this.holder || missing;
      this.restoreButton.title = this.holder ? `${this.holder} is editing. You can restore a version once it's done.` : "";
    } else if (viewing.latest) {
      this.bannerText.textContent = `Showing what changed in the latest version (${who}, ${inSentence(relativeTime(version.saved))}).${nothingEarlier} Editing is paused while changes are shown.`;
      this.backButton.textContent = "Hide changes";
      this.restoreButton.hidden = true;
    } else {
      // "With what it changed" only when something can be marked; the first version has nothing to compare.
      const marked = nothingEarlier ? `.${nothingEarlier}` : ", marked with what it changed.";
      this.bannerText.textContent = `Version from ${formatDate(version.saved)} (${who})${marked} You can look at it but not edit it.`;
      this.backButton.textContent = "Back to current";
      this.restoreButton.hidden = false;
      this.restoreButton.disabled = !!this.holder || missing;
      this.restoreButton.title = this.holder ? `${this.holder} is editing. You can restore a version once it's done.` : "";
    }
  }

  private render(doc: Node, changes: Change[], source: Source, groups?: number[], current?: number | null): void {
    this.stopSettling(); // another page: the place kept was for the one before
    // Show changes' page (its groups) carries the comment being written or in focus; a version from History, none.
    const decorations = this.withComments(doc, markChanges(doc, changes, this.tab.store, groups, current), !!groups);
    // Copied from here (to bring an old passage back, say), it pastes back as it was.
    const plugins = [footnotePlugin(), copyPlugin(), blankLinesPlugin(() => source, false), obsidianPlugin({ reading: false })];
    const state = EditorState.create({ doc, plugins });
    if (this.view) {
      this.view.setProps({ state, decorations: () => decorations });
      return;
    }
    this.page.replaceChildren();
    const store = this.tab.store;
    this.view = new EditorView(this.page, {
      state,
      editable: () => false,
      decorations: () => decorations,
      nodeViews: {
        image: (node, v, getPos) => new ImageView(node, v, getPos, store),
        code_block: (node, v, getPos) => (isDiagram(node) ? new DiagramView(node, v, getPos, store) : (null as never)),
      },
    });
  }

  /** Back to the document as it is now, ready to edit. */
  back(): void {
    if (!this.viewing) return;
    this.stopSettling();
    const reading = this.view ? placeIn(this.view, this.canvas) : null;
    this.showing++;
    this.viewing = null;
    this.since = null;
    this.tab.el.classList.remove("viewing-version", "viewing-changes");
    this.canvas.hidden = true;
    this.banner.hidden = true;
    // Not kept, hidden, as a second copy of a long document: shown afresh next time.
    this.view?.destroy();
    this.view = null;
    this.page.replaceChildren();
    const editorCanvas = this.editorShowing();
    if (editorCanvas) keepPlace(reading, this.tab.view, editorCanvas, this.editorScroll);
    this.conversation = null;
    if (this.panelOpen) this.syncList();
    this.letGo();
    this.keyboardBack(true);
    this.changed();
  }

  // Stepping through Show changes ----------------------------------------------------

  /**
   * The next or previous change, with Show changes on: the arrows in its
   * banner, and Option-Command-Down and Up. From none yet, the first change in
   * sight (or above it, going back); round from the last to the first.
   */
  step(forward: boolean): boolean {
    const s = this.since;
    if (!this.viewing?.since || !s) return false;
    if (!s.marks.count) return true;
    let to: number;
    const round = s.current !== null && s.current === (forward ? s.marks.count - 1 : 0);
    if (s.current !== null) to = (s.current + (forward ? 1 : -1) + s.marks.count) % s.marks.count;
    else {
      const top = this.canvas.getBoundingClientRect().top;
      const tops = this.firstMarks().map((m) => m?.getBoundingClientRect().top ?? Infinity);
      to = forward ? tops.findIndex((t) => t >= top - 1) : tops.filter((t) => t < top - 1).length - 1;
      if (to < 0) to = forward ? 0 : s.marks.count - 1;
    }
    this.goTo(to);
    // Said once; past the last (or before the first), that there are no more (Batch 24, K-13).
    const where = `${to + 1} of ${s.marks.count}`;
    const words = round ? `No more changes. Back to ${where}` : where;
    // The same words as last time get a no-break space, so a screen reader says them again (review of Batch 24, R24-7).
    this.said.textContent = this.said.textContent === words ? `${words}\u00a0` : words;
    return true;
  }

  /** The first mark of each change on the page, in order. */
  private firstMarks(): (HTMLElement | undefined)[] {
    const first: (HTMLElement | undefined)[] = new Array(this.since?.marks.count ?? 0);
    for (const m of this.page.querySelectorAll<HTMLElement>("[data-change]")) first[Number(m.dataset.change)] ??= m;
    return first;
  }

  /** Go to change k: it's ringed, and scrolled into sight if it isn't. */
  private goTo(k: number): void {
    const s = this.since;
    if (!s || !this.view) return;
    s.current = k;
    const decorations = this.withComments(s.doc, markChanges(s.doc, s.marks.changes, this.tab.store, s.marks.groups, k), true);
    this.view.setProps({ decorations: () => decorations });
    const mark = this.firstMarks()[k];
    if (mark) {
      const box = this.canvas.getBoundingClientRect();
      const r = mark.getBoundingClientRect();
      if (r.top < box.top + 24 || r.bottom > box.bottom - 24) this.canvas.scrollTop += r.top - box.top - Math.min(box.height / 3, 120);
    }
    this.setBanner();
    this.changed();
  }

  /**
   * A card clicked with Show changes on: the page shown goes to its change
   * (or its words; a comment on the whole document, the top), as the
   * document would, and the arrows go on from there.
   */
  private readonly cardClicked = (e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target?.closest(".comment-card") || target.closest("button, a, textarea, input, [contenteditable='true']")) return;
    const id = this.tab.comments.selectedItem;
    if (id) this.showCard(id, true);
  };

  /** Find went into a card with Show changes on: its words come into sight on the page shown, as for a click (never the top, for a comment on the whole document). */
  private readonly cardFound = (e: Event) => {
    const id = (e as CustomEvent<string>).detail;
    if (typeof id === "string") this.showCard(id, false);
  };

  /** With Show changes on, the page shown goes to a card's change, or its words; with neither, to the top if `top`. */
  private showCard(id: string, top: boolean): void {
    const s = this.since;
    if (!this.viewing?.since || !s || !this.view) return;
    const state = this.tab.view.state;
    const spans = present(changeMarks(state).spans.get(id)).sort((a, b) => a.from - b.from);
    const gap = changeMarks(state).gaps.get(id)?.pos;
    const range = spans.length
      ? { from: spans[0].from, to: spans[spans.length - 1].to }
      : (commentRanges(state).ranges.get(id) ?? (gap === undefined ? null : { from: gap, to: gap }));
    if (!range) {
      if (top) this.canvas.scrollTop = 0;
      return;
    }
    // The same words in the page shown: the text now, read the same way.
    let { from, to } = range;
    if (!state.doc.eq(s.doc)) {
      const index = textIndex(state.doc);
      const words = (s.words ??= textIndex(s.doc));
      from = posAt(words, offsetAt(index, from), "start");
      to = Math.max(from, posAt(words, offsetAt(index, to), "end"));
    }
    const k = s.marks.changes.findIndex((c) => {
      const { start, end } = extentOf(c);
      return start <= to && from <= end;
    });
    if (k >= 0) return this.goTo(s.marks.groups[k]);
    const box = this.canvas.getBoundingClientRect();
    const where = this.view.coordsAtPos(Math.min(from, s.doc.content.size));
    if (where.top < box.top + 24 || where.bottom > box.bottom - 24) this.canvas.scrollTop += where.top - box.top - Math.min(box.height / 3, 120);
  }

  // Commenting with Show changes on (roadmap Batch 25, item 1) ------------------------

  /**
   * The words selected on Show changes' page, as places in the document: the
   * comment is made in the document's own comment path, on the words found
   * there, and nothing is done to the page shown. The page is the text now,
   * so its words are the document's, read the same way (as showCard, the
   * other way round). Words shown as removed sit between them, in no place of
   * their own: selected alone, they are "removed".
   */
  commentPick(): { from: number; to: number } | "removed" | null {
    const s = this.since;
    if (!this.viewing?.since || !s || !this.view) return null;
    const none = { from: 0, to: 0 };
    const picked = document.getSelection();
    const dom = this.view.dom;
    if (!picked?.anchorNode || !picked.focusNode || picked.isCollapsed) return none;
    if (!dom.contains(picked.anchorNode) || !dom.contains(picked.focusNode)) return none;
    let a: number;
    let b: number;
    try {
      a = this.view.posAtDOM(picked.anchorNode, picked.anchorOffset);
      b = this.view.posAtDOM(picked.focusNode, picked.focusOffset);
    } catch {
      return none;
    }
    let from = Math.min(a, b);
    let to = Math.max(a, b);
    const words = from === to ? "" : s.doc.textBetween(from, to, "\n", PICTURE_STAND_IN);
    if (!words.trim()) return picked.toString().trim() ? "removed" : none;
    const now = this.tab.view.state.doc;
    if (!now.eq(s.doc)) {
      const shown = (s.words ??= textIndex(s.doc));
      const index = textIndex(now);
      from = posAt(index, offsetAt(shown, from), "start");
      to = Math.max(from, posAt(index, offsetAt(shown, to), "end"));
    }
    return { from, to };
  }

  /**
   * Show changes' page with the comment being written, and the one in focus,
   * marked on their words as on the document (`on`: it's Show changes' page).
   */
  private withComments(doc: Node, decorations: DecorationSet, on: boolean): DecorationSet {
    if (!on) return decorations;
    const state = this.tab.view.state;
    const { ranges, active } = commentRanges(state);
    const ids = [DRAFT, active].filter((id, i, all): id is string => !!id && all.indexOf(id) === i && ranges.has(id));
    if (!ids.length) return decorations;
    const same = state.doc.eq(doc);
    const index = same ? null : textIndex(state.doc);
    const words = same ? null : textIndex(doc);
    const marks = ids.flatMap((id) => {
      const range = ranges.get(id)!;
      let { from, to } = range;
      if (index && words) {
        from = posAt(words, offsetAt(index, from), "start");
        to = Math.max(from, posAt(words, offsetAt(index, to), "end"));
      }
      from = Math.min(from, doc.content.size);
      to = Math.min(to, doc.content.size);
      return from < to ? [markFor(id, { from, to }, active)] : [];
    });
    return decorations.add(doc, marks);
  }

  /** The comment being written, or the one in focus, changed: Show changes' page marks it again. */
  private readonly commentMarksMoved = () => {
    const s = this.since;
    if (!this.viewing?.since || !s || !this.view) return;
    const decorations = this.withComments(s.doc, markChanges(s.doc, s.marks.changes, this.tab.store, s.marks.groups, s.current), true);
    this.view.setProps({ decorations: () => decorations });
  };

  /** An older version is shown and its Restore button can be pressed. */
  get canRestore(): boolean {
    return !!this.viewing && !this.viewing.latest && !this.restoreButton.hidden && !this.restoreButton.disabled;
  }

  async restore(): Promise<void> {
    const viewing = this.viewing;
    if (!viewing || viewing.latest || !this.canRestore) return;
    await this.tab.saveNow();
    const result = await this.host.api.historyRestore(this.tab.id, viewing.n);
    if (!result.ok) {
      this.bannerText.textContent = result.reason;
      return;
    }
    this.back();
    if (!result.same) await this.tab.replaceText(result.text);
  }

  /**
   * The history changed (a save, an agent's pass, an outside change): bring
   * what's shown up to date. Changes that come in a burst are taken together:
   * one at a time, and one more after it for any that came meanwhile.
   */
  refresh(): Promise<void> {
    if (!this.panelOpen && !this.viewing) return Promise.resolve();
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    const run = async () => {
      try {
        do {
          this.refreshAgain = false;
          await this.refreshOnce();
        } while (this.refreshAgain && !this.destroyed);
      } finally {
        this.refreshing = null;
      }
    };
    return (this.refreshing = run());
  }

  private async refreshOnce(): Promise<void> {
    if (!this.panelOpen && !this.viewing) return;
    await this.load();
    if (this.destroyed) return;
    if (!this.panelOpen && !this.viewing) return this.letGo(); // closed meanwhile
    // A version the person asked for is on its way: it's shown as it arrives, and the list follows.
    const viewing = this.asked === this.showing ? null : this.viewing;
    if (viewing?.since) {
      // Show changes follows the document as agents change it, and as one takes it or hands it back.
      const newest = this.rows[this.rows.length - 1];
      if (newest && (newest.n !== viewing.n || newest.saved !== viewing.saved || this.holder !== this.since?.holder)) return this.showSince(true);
    } else if (viewing?.fold !== undefined) {
      // Several versions shown together: as one version shown, it follows the latest as it changes, and
      // is shown again when they change (the newest of them saved again, or no longer the newest).
      const newest = this.rows[this.rows.length - 1];
      const rows = this.foldFrom(viewing.fold);
      const last = rows?.[rows.length - 1];
      if (viewing.latest && newest && last?.n !== newest.n) return this.show(newest.n, true);
      if (!last) return this.back();
      if (last.n !== viewing.n || last.saved !== viewing.saved || viewing.latest !== (last === newest)) return this.showFold(viewing.fold, true);
      this.setBanner(); // Restore follows whether an agent holds the document
    } else if (viewing) {
      const newest = this.rows[this.rows.length - 1];
      // Show changes follows the latest version as it changes; an older version
      // that's become the latest (the versions after it undone) is shown as that.
      // Otherwise what's on screen is the same: it isn't drawn again.
      if (viewing.latest && newest && (newest.n !== viewing.n || newest.saved !== viewing.saved)) return this.show(newest.n, true);
      if (!this.rows.some((v) => v.n === viewing.n)) return this.back();
      if (!viewing.latest && newest.n === viewing.n) return this.show(viewing.n, true);
      // Its pass's feedback came in (the agent finished): its conversation opens.
      const brief = this.briefs.get(viewing.n);
      if (brief && !(this.conversation?.n === viewing.n && sameBrief(this.conversation.brief, brief))) {
        const ticket = this.showing;
        const conversation = await this.conversationFor(viewing.n);
        if (ticket !== this.showing || this.destroyed) return;
        this.conversation = conversation;
      }
      this.setBanner(); // Restore follows whether an agent holds the document
    }
    if (this.panelOpen) this.syncList();
  }

  /**
   * Put the words he was reading where they were on screen, and keep them
   * there while the page settles: pictures and diagrams above them are drawn a
   * moment later, and grow the page above what he reads (review of Batch 11,
   * F-6). Until he scrolls, clicks or types there, or two seconds pass.
   */
  private keepSettling(place: Place | null): void {
    this.stopSettling();
    keepPlace(place, this.view, this.canvas, this.editorScroll);
    const view = this.view;
    if (!place?.reading || !view) return;
    const stop = new AbortController();
    this.settling = stop;
    const observer = new ResizeObserver(() => {
      if (this.view === view && this.viewing) keepPlace(place, view, this.canvas, this.editorScroll);
    });
    observer.observe(this.page);
    const timer = setTimeout(() => this.stopSettling(), 2000);
    stop.signal.addEventListener("abort", () => {
      observer.disconnect();
      clearTimeout(timer);
    });
    for (const type of ["wheel", "pointerdown", "keydown", "touchstart"]) {
      this.canvas.addEventListener(type, () => this.stopSettling(), { signal: stop.signal, passive: true });
    }
  }

  private stopSettling(): void {
    this.settling?.abort();
    this.settling = null;
  }

  private changed(): void {
    this.updateButtons();
    this.host.changed();
  }

  /** The tab closed. */
  destroy(): void {
    this.destroyed = true;
    this.stopSettling();
    this.tab.el.removeEventListener(COMMENTS_WANTED, this.giveWay);
    this.tab.comments.el.removeEventListener("click", this.cardClicked);
    this.tab.comments.el.removeEventListener(CARD_FOUND, this.cardFound);
    this.tab.comments.el.removeEventListener(COMMENT_MARKS, this.commentMarksMoved);
    this.since = null;
    this.showing++; // a version still on its way isn't shown
    if (this.clock) clearInterval(this.clock);
    this.clock = null;
    this.view?.destroy();
    this.view = null;
    this.panelOpen = false;
    this.viewing = null;
    this.letGo();
  }
}

/** Whether removed content has something to see besides line breaks: a picture or a footnote marker. */
function hasVisible(content: Fragment): boolean {
  let found = false;
  content.forEach((node) => {
    if (node.type.name === "image" || node.type.name === "footnote_ref") found = true;
  });
  return found;
}

/**
 * Draws removed content for the page: a picture from its own document's
 * folder (the tab's `store`), not the folder of the document in front,
 * which it may not be when a tab behind is drawn (code review of Batch 16, W16-16).
 * A web picture an agent added that waits is its marker, never asked for (roadmap Batch 18, item 1).
 */
function removedSerializer(store: PictureStore): DOMSerializer {
  const base = DOMSerializer.fromSchema(schema);
  const image = (node: Node) => {
    if (store.waits(node.attrs.src)) return waitingMarker(node.attrs.src);
    const [tag, attrs] = schema.nodes.image.spec.toDOM!(node) as [string, Record<string, unknown>];
    return [tag, { ...attrs, src: store.resolve(node.attrs.src) }] as DOMOutputSpec;
  };
  return new DOMSerializer({ ...base.nodes, image }, base.marks);
}

/**
 * Marks on the page for what changed: highlighted where words came in, struck
 * through where they went. With Show changes, each mark says which change it's
 * part of (`groups`), and the change the arrows are on is ringed (`current`).
 */
function markChanges(doc: Node, changes: Change[], store: PictureStore, groups?: number[], current?: number | null): DecorationSet {
  const serializer = removedSerializer(store);
  const decorations: Decoration[] = [];
  changes.forEach((c, i) => {
    // Several marks at one place keep their order; all sit before the text that follows them.
    const side = i - changes.length;
    const group = groups?.[i];
    const on = group !== undefined && group === current;
    const attrs = (cls: string) => (group === undefined ? { class: cls } : { class: on ? `${cls} diff-current` : cls, "data-change": String(group) });
    const tagged = (dom: HTMLElement) => {
      if (group === undefined) return dom;
      dom.dataset.change = String(group);
      if (on) dom.classList.add("diff-current");
      return dom;
    };
    switch (c.kind) {
      case "added-text": {
        // The mark, and the ring on it, take in the words that came, not the space before or after them (review
        // of Batch 11, F-16): that space was already there, or is only what keeps the new words apart.
        let { from, to } = c;
        const $from = doc.resolve(from);
        if ($from.sameParent(doc.resolve(to))) {
          const text = doc.textBetween(from, to, undefined, PICTURE_STAND_IN); // one character a position, in one paragraph
          const start = text.length - text.trimStart().length;
          const end = text.length - text.trimEnd().length;
          if (start + end < text.length) {
            from += start;
            to -= end;
          }
        }
        decorations.push(Decoration.inline(from, to, { nodeName: "ins", ...attrs("diff-added") }));
        break;
      }
      case "removed-text": {
        // Words, pictures and footnote markers that went show struck through; a line break alone shows as nothing.
        if (!c.text.split(PICTURE_STAND_IN).join("") && !hasVisible(c.content)) break;
        decorations.push(
          Decoration.widget(
            c.at,
            () => {
              const del = el("del", "diff-removed");
              del.append(serializer.serializeFragment(c.content));
              // A footnote marker that went has no number any more: show its label.
              for (const ref of del.querySelectorAll<HTMLElement>(".footnote-ref")) ref.dataset.number = ref.dataset.label ?? "";
              del.contentEditable = "false";
              return tagged(del);
            },
            { side, ignoreSelection: true },
          ),
        );
        break;
      }
      case "added-block":
        decorations.push(Decoration.node(c.from, c.to, attrs("diff-added-block")));
        break;
      case "changed-block":
        decorations.push(Decoration.node(c.from, c.to, attrs("diff-changed-block")));
        break;
      case "removed-block":
        decorations.push(
          Decoration.widget(
            c.at,
            () => {
              const dom = serializer.serializeNode(c.node);
              const block = dom instanceof HTMLElement ? dom : el("div", "");
              if (!(dom instanceof HTMLElement)) block.append(dom);
              block.classList.add("diff-removed-block");
              block.contentEditable = "false";
              return tagged(block);
            },
            { side, ignoreSelection: true },
          ),
        );
        break;
    }
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * A version in the list, compactly: the start of each comment the agent
 * answered and of its reply (two lines each, an ellipsis where there's more),
 * and what it changed for each.
 */
function compact(brief: Brief): HTMLElement {
  const addressed = el("span", "history-addressed");
  for (const thread of brief.threads) {
    const t = el("span", "history-thread");
    t.append(el("span", "history-comment", thread.comment));
    if (thread.reply !== undefined) t.append(el("span", "history-reply", thread.reply));
    if (thread.change) t.append(changeLine(thread.change));
    addressed.append(t);
  }
  // What the person asked for in the agent's chat, or what the agent changed that nobody asked for.
  if (brief.loose) {
    const t = el("span", "history-thread history-loose");
    t.append(el("span", "history-asked", brief.loose.request ? `Asked in chat: ${brief.loose.request}` : "Other changes"));
    if (brief.loose.change) t.append(changeLine(brief.loose.change));
    addressed.append(t);
  }
  // The agent's note about its pass (roadmap Batch 2, item 3).
  if (brief.note) {
    const t = el("span", "history-thread history-loose");
    t.append(el("span", "history-note", `Note: ${brief.note}`));
    addressed.append(t);
  }
  return addressed;
}

/**
 * The whole conversation behind a version, for the one shown: each comment
 * the agent answered, on the words it was on, with every message in full, and
 * what it changed for it; then what was asked in the chat; then the agent's
 * note. It's the record as the pass ended, so a comment resolved or deleted
 * since still reads in full.
 */
function conversation(v: Conversation): HTMLElement {
  const box = el("div", "history-detail");
  for (const thread of v.addressed ?? []) {
    const section = el("section", "history-conversation");
    if (thread.anchor) section.append(el("blockquote", "history-quote", thread.anchor.quote.trim()));
    else section.append(el("span", "history-whole", "Whole document"));
    const messages = el("ol", "history-messages");
    for (const m of thread.messages) {
      const li = el("li", "history-message");
      const byline = el("div", "history-byline");
      byline.append(el("span", "history-author", m.author.kind === "person" ? "You" : m.author.name || "Agent"));
      if (m.author.kind === "person" && m.mention) byline.append(el("span", "history-to", `To ${m.mention}`));
      li.append(byline, el("p", "history-body", m.body));
      messages.append(li);
    }
    section.append(messages);
    const changed = summarizeChanges(thread.change?.spans ?? []);
    if (changed.total) section.append(changeLine(changed));
    box.append(section);
  }
  if (v.request || v.other?.length) {
    const section = el("section", "history-conversation history-loose");
    if (v.request) {
      section.append(el("span", "history-label", "Asked in chat"), el("p", "history-body history-request", v.request));
    } else section.append(el("span", "history-label", "Other changes"));
    const changed = summarizeChanges(v.other ?? []);
    if (changed.total) section.append(changeLine(changed));
    box.append(section);
  }
  if (v.note) {
    const section = el("section", "history-conversation history-loose");
    section.append(el("span", "history-label", "Note"), el("p", "history-body history-note-text", v.note));
    box.append(section);
  }
  return box;
}

/**
 * What a row's version (or versions) changed: the sections, by their
 * headings, and for the person's own (and another app's, and a restore) the
 * change line. An agent's change lines are under each comment it answered.
 */
function storyParts(story: RowStory): HTMLElement[] {
  const parts: HTMLElement[] = [];
  if (story.sections?.length) {
    const line = el("span", "history-sections");
    const more = story.moreSections ?? 0;
    line.title = more ? `The sections it changed: the first ${story.sections.length} of ${story.sections.length + more}` : "The sections it changed";
    story.sections.forEach((name, i) => {
      if (i > 0) line.append(el("span", "history-section-sep", " · "));
      const chip = el("span", "history-section", name);
      chip.title = `Changed in: ${name}`; // what the grey chip is (Batch 24, N-13)
      line.append(chip);
    });
    if (more) line.append(el("span", "history-section-sep", " · "), el("span", "history-sections-more", `and ${more} more`));
    parts.push(line);
  }
  if (story.change?.total) parts.push(changeLine(story.change));
  return parts;
}

/**
 * What a change did, in a line: the old words struck through and the new ones
 * marked, as whole words, for the few biggest places, with a count of every
 * place when not all are shown. A lone comma or "it" is counted, not shown.
 */
function changeLine(summary: ChangeSummary): HTMLElement {
  const line = el("span", "history-change");
  const count = countText(summary);
  if (count) line.append(el("span", "history-change-count", count));
  summary.shown.forEach((snippet, i) => {
    if (i > 0) line.append(el("span", "history-change-sep", " · "));
    else if (count) line.append(" ");
    const place = el("span", "history-change-place");
    if (snippet.removed) place.append(el("del", "", snippet.removed));
    if (snippet.removed && snippet.added) place.append(" ");
    if (snippet.added) place.append(el("ins", "", snippet.added));
    line.append(place);
  });
  return line;
}
