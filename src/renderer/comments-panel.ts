// A document's comments in the window: the panel beside the page, the draft
// of a new comment, and keeping each comment on its text. Comments live in
// Corillo's data folder (the main process); this side shows them, sends the
// person's actions, and reports where each comment's text is now so it can be
// found again the next time the document opens.
//
// The panel is the same in both views: a column of its own to the right of
// the page (or of the Markdown view's preview), scrolling on its own. At its
// top, New comment and Send to Claude. Cards are listed from the top: agents'
// notes about their passes, whole-document comments and comments whose text
// can't be found; then the rest in the order their text comes in the
// document, always in that one order. The panel holds comments only (roadmap
// Batch 9, item 5): what an agent changed for a request made in its chat, or
// for no comment, is its pass in History. Clicking a card brings its
// words into sight (the top of the document, for one with no words); moving
// into a comment's words brings its card into sight. The formatted editor
// holds where each comment is in either view: the Markdown view keeps it up
// to date as the person types (doc-tab-markdown.ts, syncModel).
import type { Transaction } from "prosemirror-state";
import { isHistoryTransaction } from "prosemirror-history";
import type { Node as DocNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { anchorFor, textIndex, type Anchor, type TextIndex } from "../core/anchors";
import { waitingForPerson, type Message, type PassNote, type Thread } from "../core/comments";
import type { ChangeAnchorReport, CorilloApi } from "../preload/preload";
import { commentPlugin, commentRanges, commentsKey, withRanges, DRAFT, type CommentRanges, type Cut, type Range, type RangeAction } from "./comments";
import { el, textButton, type Card } from "./comments-panel-cards";
import { isBox } from "./comments-panel-keyboard";
import { CardFind, COMMENT_MARKS, COMMENTS_WANTED, MARGIN } from "./comments-panel-find";
import { carryThroughHistory, findEvery, findText, placeGaps, placesToTell, putBack, putInBy, refindLost, sameAnchor } from "./comments-panel-places";
import { agentColours, pickColour, type AgentColour } from "../core/agents";
import type { ChangeSpan } from "../core/change-links";
import { choicesOf, optionsOf, standing, type Choice } from "../core/options";
import { anchorsOf, changeMarks, changePlugin, placeSpans, present, withChanges, type ChangeAction, type MarkedSpan } from "./change-marks";
import { sideHandle } from "./columns";
import { forgetResolvedIn, justDone } from "./undo-resolve";
import { keptThrough } from "../core/undo-through";
import {
  agentNames,
  agentsNamedIn,
  countLabel,
  handBackFor,
  orderThreads,
  type AgentInfo,
  type HandBack,
  type Waiting,
} from "./comment-format";
import {
  listenForAgents,
  mentionField,
  refreshMentionFields,
  whenAgentsChange,
  type MentionField,
  type MentionSource,
} from "./mentions";
import { PICTURE_STAND_IN } from "../core/doc-diff";

/** How the panels ask whether a document can be changed now (app.ts): kept with the cards, where an option is chosen. */
export { setChangeCheck } from "./comments-panel-cards";
export { CARD_FOUND, COMMENT_MARKS, COMMENTS_WANTED } from "./comments-panel-find";

const ANCHOR_SAVE_DELAY_MS = 800;
const TIME_REFRESH_MS = 30_000;
/** How long a short message stays at the top of the panel. */
const NOTE_MS = 8000;

export interface CommentsHost {
  api: CorilloApi;
  id: string;
  /** The formatted document's editor. It holds where each comment is, in either view. */
  view(): EditorView;
  /** Bring the editor up to date with what was just typed (the Markdown view catches up a moment after typing stops). */
  settle(): void;
  /** Scroll the document so this place is in sight, in each pane showing it; null: to the top. */
  reveal(pos: number | null): void;
  /** Put the keyboard back in the document, in the view showing. */
  focusDocument(): void;
  /** The count or the panel's visibility changed. */
  changed(): void;
  /** The document's Markdown now, with typing the editor hasn't caught up with yet. */
  text(): string;
  /**
   * Change the document as the person's own edit, one step Undo takes back:
   * from the first of these Markdown texts (the text now) through each of the
   * others, one place at a time (see stagesOf). False: it couldn't be, and nothing changed.
   */
  applyText(texts: readonly string[]): boolean;
}

/** Copied from a comment box, to find the line its cursor is on. */
const COPIED = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "wordSpacing", "tabSize",
  "textTransform", "whiteSpace", "overflowWrap", "wordBreak",
] as const;

/** Where the line with the cursor is in a comment box, on screen. */
function caretLine(box: HTMLTextAreaElement): { top: number; bottom: number } {
  const style = getComputedStyle(box);
  const copy = document.createElement("div");
  for (const name of COPIED) copy.style[name] = style[name];
  const left = parseFloat(style.paddingLeft) || 0;
  const right = parseFloat(style.paddingRight) || 0;
  Object.assign(copy.style, {
    position: "absolute",
    top: "0",
    left: "-10000px",
    visibility: "hidden",
    boxSizing: "content-box",
    padding: "0",
    width: `${Math.max(0, box.clientWidth - left - right)}px`,
  });
  const head = box.selectionDirection === "backward" ? box.selectionStart : box.selectionEnd;
  const marker = document.createElement("span");
  marker.textContent = "\u200B";
  copy.append(box.value.slice(0, head), marker);
  document.body.append(copy);
  const offset = marker.offsetTop;
  copy.remove();
  const rect = box.getBoundingClientRect();
  const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 13) * 1.4;
  const top = rect.top + box.clientTop + (parseFloat(style.paddingTop) || 0) + offset - box.scrollTop;
  return { top, bottom: top + lineHeight };
}

/** Keys that move the cursor in a comment box without typing. */
const NAVIGATION = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);

export interface Draft {
  anchored: boolean;
  quote: string;
  /** Where it was last seen, in case its text is replaced while it's being written. */
  anchor: Anchor | null;
  el: HTMLElement;
  input: HTMLTextAreaElement;
  /** The box's @ list and tags: the first agent named is the one the comment is for. */
  field: MentionField;
  post: HTMLButtonElement;
  error: HTMLElement;
  posting: { body: string; anchor: Anchor | null } | null;
}

/** What reaches the document's selection even with the keyboard on a card (see onCardEdit). */
const CARD_EDITS = ["cut", "paste", "beforeinput"] as const;

/**
 * How far (in characters) an agent's change's place may drift before Corillo
 * is told, when nothing but its place moved: typing above it moves it without
 * changing its words or the words around them, and the place only breaks ties
 * between repeats of the same words in the same surroundings. A comment's
 * place is told at every pause instead (roadmap Batch 18, W-S2): there the
 * tie decides which copy of repeated words the comment is on if Corillo
 * stops without closing, and a stale place could last the whole session.
 */
const DRIFT = 300;

/** The same words in the same surroundings, moved by less than DRIFT. */
const movedALittle = (a: Anchor, b: Anchor | null | undefined) =>
  !!b && a.quote === b.quote && a.prefix === b.prefix && a.suffix === b.suffix && Math.abs(a.offset - b.offset) < DRIFT;

/** Why a Send didn't reach the agent, said beside Copy for it (B2-01, B2-04). */
function lostWords(lost: { agent: string; why: "stopped" | "failed" }, copyFor: string): string {
  const what =
    lost.why === "stopped" ? `${lost.agent} stopped listening before it got your comments.` : `${lost.agent} couldn't take the document to start on your comments.`;
  return `${what} Press Copy for ${copyFor}, then paste it in ${copyFor}'s chat.`;
}

/** "Send to Claude", "Sent to Claude", "Copy for Claude". */
function handBackLabel(hb: NonNullable<HandBack>): string {
  return hb.kind === "copy" ? `Copy for ${hb.agent}` : hb.kind === "sent" ? `Sent to ${hb.agent}` : `Send to ${hb.agent}`;
}

const openPanels = new Set<DocComments>();
// An agent connected or left: a comment waiting for it says where things stand.
whenAgentsChange(() => {
  for (const panel of openPanels) panel.agentsKnownChanged();
});

/** What the panel's New comment does: what Comment, Insert > New Comment and ⌥⌘M do (app.ts). */
let startComment: () => void = () => undefined;

/** Tell the panels how to start a comment (roadmap Batch 9, item 14). */
export function setNewComment(start: () => void): void {
  startComment = start;
}

/**
 * The person hid the Comments panel. One choice for every document,
 * remembered between launches (view-settings.ts). A comment they start, or
 * an agent's comment or reply arriving, still shows a document's panel.
 */
let hiddenByPerson = false;

/** Hide or show the Comments panel on every document (the remembered choice, read at launch). */
export function setCommentsHidden(hidden: boolean): void {
  if (hidden === hiddenByPerson) return;
  hiddenByPerson = hidden;
  for (const panel of openPanels) panel.followChoice();
}

/** Told when a panel was drawn again (find.ts: the matches it marks in the cards are drawn again, or searched for again). */
let afterDraw: ((panel: DocComments) => void) | null = null;

export function whenCommentsDrawn(listener: (panel: DocComments) => void): void {
  afterDraw = listener;
}

/**
 * Marks a change that is the Markdown text's own Undo or Redo of a choice (or
 * of Replace All), replayed place by place in the document (doc-tab-markdown.ts,
 * syncModel): comments go where they were, as after the editor's own Undo.
 */
export const TEXT_HISTORY = "corillo-text-history";

export class DocComments extends CardFind {
  /** The panel, to the right of the page. It scrolls on its own. */
  readonly el: HTMLElement;
  /** The panel's left edge, which can be dragged to make it wider or narrower. Goes just before the panel. */
  readonly handle: HTMLElement;
  protected readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly note: HTMLElement;
  private readonly helpLink: HTMLButtonElement;
  /** In the heading: how many are resolved, and a way to show or hide them. */
  private readonly resolvedRow: HTMLElement;
  private readonly resolvedLabel: HTMLElement;
  private readonly showResolvedButton: HTMLButtonElement;
  /**
   * Under the heading: the one button for handing the document back (roadmap
   * Batch 2, item 1): Send to Claude while Claude waits for the review, else
   * Copy for Claude, for its chat.
   */
  protected readonly handBackButton: HTMLButtonElement;
  /** New comment, at the row's left: greyed out where Comment is (review of Batch 9, B9-02). */
  protected readonly newCommentButton: HTMLButtonElement;
  /** A Send made with the keyboard in the page, until the agent takes the document (see DocTab.setReadOnly). */
  sentFromPage = false;
  /** The same, made by keys from Send's own button (review of Batch 12, B12-6). */
  sentFromButton = false;
  /** Its row, under the heading, always there: New comment, then the hand-back when there is one (roadmap Batch 9, item 14). */
  private readonly handBackRow: HTMLElement;
  private handBackNow: HandBack = null;
  /** Under it, why a Send didn't reach the agent (B2-01), until the person copies the message for its chat or an agent listens again. */
  private readonly handBackWhy: HTMLElement;
  private lost: { agent: string; why: "stopped" | "failed" } | null = null;
  /** Under it, why Send is greyed out while the agent waits, and what to do (roadmap Batch 11, F-7). */
  private readonly handBackHint: HTMLElement;
  /**
   * The panel's top: the heading, New comment and Send, and the panel's short
   * messages. It stays in sight while the cards scroll under it, so the button
   * that hands the document back is there when the last reply is written
   * (roadmap Batch 11, F-2).
   */
  private readonly top: HTMLElement;
  /** Room kept under the cards, so a card going away doesn't pull the ones above it down. */
  private readonly slack: HTMLElement;

  protected threads: Thread[];
  /** The document has nothing in it yet: the empty panel says comments come once there's something to comment on (P-8). */
  private blank = false;
  protected agents: AgentInfo[] = [];
  private colours = new Map<string, AgentColour>();
  protected draft: Draft | null = null;
  /** Shown on this document although the person hid the panel: they started a comment, or an agent wrote. */
  protected shownAnyway = false;
  /** How many messages each comment had, to notice an agent's new comment or reply. */
  private messageCounts = new Map<string, number>();
  protected showResolved = false;
  /** Comments looked for in this version of the text and not found. */
  private notFound = new Set<string>();
  private lastActive: string | null = null;
  /** The comments' places as the last change left them, with its document: what Undo and Redo start from. */
  private placesWere: { doc: DocNode; value: CommentRanges } | null = null;
  /** The comments' places just before and just after the last few choices, to put back when Undo or Redo brings that text back. */
  protected choicePlaces: { doc: DocNode; ranges: ReadonlyMap<string, Range> }[] = [];
  private anchorTimer: ReturnType<typeof setTimeout> | null = null;
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  private timeTimer: ReturnType<typeof setInterval>;
  /** The comment box the person was last writing in, until they go back to the document. */
  private lastBox: HTMLTextAreaElement | null = null;
  private readonly onDocMouseDown = (e: MouseEvent) => this.clickedSomewhere(e);
  private readonly onDocFocus = (e: FocusEvent) => {
    const target = e.target as Element | null;
    // The toolbar, History and a version shown are a look away: the box is still the one being written.
    if (!target || this.el.contains(target) || target.closest?.(".toolbar, .history-panel, .version-view, .version-banner")) return;
    this.lastBox = null;
  };
  /**
   * Cut, Paste and the browser's own editing (Undo, Edit > Delete) go to the
   * document's selection wherever the keyboard is. While it rests on a card
   * they leave the document alone, and a paste starts the card's reply with
   * the text.
   */
  private readonly onCardEdit = (e: Event) => {
    if (!this.keyboardOnCard) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === "paste") this.replyWith((e as ClipboardEvent).clipboardData?.getData("text/plain") ?? "");
  };
  /** What the comment boxes' @ lists offer (see mentions.ts). */
  protected readonly mentions: MentionSource;

  // Agents' changes for comments (see change-marks.ts and core/change-links.ts) ------------
  /** Agents' notes about their passes, waiting for the person, oldest first (roadmap Batch 2, item 3). */
  protected notes: PassNote[];
  /** What each owner's change was when it was last found in the text, so it's found again only when it changes. */
  private located = new Map<string, string>();
  /** Comments whose deleted words came back (Undo, say): their gap is cleared when anchors are next saved. */
  private regained = new Set<string>();
  /** For comments whose words were deleted while the document is open: what was taken with them, so putting it back brings the comment back. */
  private cuts = new Map<string, Cut>();
  /** The person's edits moved changes since Corillo was last told where they are. */
  private changesMoved = false;
  /**
   * Each comment with one of an agent's options chosen that's in the text
   * now: its reply and the choice (see `standing` in core/options.ts). Its
   * card says "You chose" and lights the text the choice changed; once Undo
   * takes it out, the agent's own change is lit again (review of Batch 3, B3-R04).
   */
  protected standingChoices = new Map<string, { messageId: string; choice: Choice }>();
  /** What the standing choices were worked out from: the document, and the choices kept on open comments. */
  private choicesSeen: { doc: DocNode | null; kept: string } = { doc: null, kept: "" };
  private lastChange: { selected: string | null; before: boolean } = { selected: null, before: false };
  /** The panel's note goes at the next edit or comment too, not only after a while (Copied, say). */
  private goesOnEdit = false;
  /**
   * What the person has seen on each card that has something for them (an
   * agent's reply or change, or a note): what
   * was new on it when it was last in focus. A card an agent has added to
   * since carries a dot until it comes into focus, and counts in the status
   * bar ("With you · 4 to read"; roadmap Batch 1, item 2). Kept while the
   * document is open, as the line saying an agent is done is: what is there
   * when it opens counts as seen.
   */
  private seen = new Map<string, string>();
  /** How many cards have something new, as of the last count. */
  private unread = 0;
  /** The card in focus when it was last marked seen: one that stays in focus while an agent adds to it isn't seen again until it comes back into focus. */
  private inFocus: string | null = null;
  /** The panel was drawn again (the end-of-pass line follows what's waiting). */
  onRender: (() => void) | null = null;
  /**
   * Called once, the next time the person acts on a comment (posts one,
   * replies, resolves, reopens, edits or deletes): they're working on the
   * document again. Set again to hear of the next time.
   */
  onPersonActed: (() => void) | null = null;

  constructor(
    protected host: CommentsHost,
    threads: Thread[],
    notes: PassNote[] = [],
  ) {
    super();
    this.threads = threads;
    this.notes = notes;
    for (const t of threads) this.messageCounts.set(t.id, t.messages.length);
    this.el = el("aside", "comments-panel");
    this.el.setAttribute("aria-label", "Comments");
    this.el.hidden = true;
    this.list = el("div", "comments-list");
    this.empty = el("p", "comments-empty");
    this.note = el("p", "comments-note");
    this.note.setAttribute("role", "status");
    this.note.hidden = true;
    // "3 resolved · Show": how many, and a way to see them (View > Show Resolved Comments does the same).
    this.showResolvedButton = textButton("", "link-button comments-show-resolved", () => this.setShowResolved(!this.showResolved));
    this.resolvedLabel = el("span", "comments-resolved-count");
    this.resolvedRow = el("div", "comments-resolved");
    this.resolvedRow.append(this.resolvedLabel, this.showResolvedButton);
    this.helpLink = textButton("How comments work", "link-button comments-help", () => void this.host.api.help.open("agents-comments"));
    // A heading row like the History panel's, lined up with the top of the page.
    const head = el("div", "panel-head");
    head.append(el("h2", "", "Comments"), this.resolvedRow);
    // New comment, always there (Orlando, 2026-11-12: "Commments are core to how the app works...so we want to make
    // that easy to do."): on the selected words, or on the whole document. A quiet button: Send is the main one.
    const newComment = (this.newCommentButton = el("button", "comment-button comments-new", "New comment"));
    newComment.type = "button";
    newComment.title = "New comment on the selected words, or on the whole document (⌥⌘M)";
    // The selection in the page (or the Markdown text) stays: it's what the comment is on.
    newComment.addEventListener("mousedown", (e) => e.preventDefault());
    newComment.addEventListener("click", () => startComment());
    this.handBackButton = textButton("Send to Claude", "comment-button primary-small comments-hand-back", () => void this.handBack());
    this.handBackRow = el("div", "comments-hand-back-row");
    this.handBackRow.append(newComment, this.handBackButton);
    this.handBackWhy = el("p", "comments-hand-back-why");
    this.handBackWhy.setAttribute("role", "status");
    this.handBackWhy.hidden = true;
    // Quiet words, not a status: read with the button by a screen reader, which can't reach a greyed-out one.
    this.handBackHint = el("p", "comments-hand-back-hint");
    this.handBackHint.id = `hand-back-hint-${host.id}`;
    this.handBackHint.hidden = true;
    this.handBackButton.setAttribute("aria-describedby", this.handBackHint.id);
    openPanels.add(this);
    this.slack = el("div", "comments-slack");
    this.slack.setAttribute("aria-hidden", "true");
    this.top = el("div", "comments-top");
    this.top.append(head, this.handBackRow, this.handBackHint, this.handBackWhy, this.note);
    this.el.append(this.top, this.list, this.empty, this.helpLink, this.slack);
    // The room kept under the cards goes as the person scrolls up into it.
    // A card's menu closes as the panel scrolls, since it stays where it opened.
    // With cards under the top, a line under it says so.
    this.el.addEventListener(
      "scroll",
      () => {
        this.trimSlack();
        if (this.menuFor && this.el.scrollTop !== this.menuFor.scrollTop) this.messageMenu?.close();
        const under = this.el.scrollTop > 0;
        if (this.top.classList.contains("over-cards") !== under) this.top.classList.toggle("over-cards", under);
      },
      { passive: true },
    );
    this.handle = sideHandle(() => undefined);
    this.handle.classList.add("comments-handle");
    this.handle.hidden = true;
    this.timeTimer = setInterval(() => this.refreshTimes(), TIME_REFRESH_MS);
    document.addEventListener("mousedown", this.onDocMouseDown, true);
    document.addEventListener("focusin", this.onDocFocus);
    for (const type of CARD_EDITS) document.addEventListener(type, this.onCardEdit, true);
    // The line being typed in a comment box stays in sight as the box grows,
    // and as the cursor moves past the panel's edge.
    this.el.addEventListener("focusin", (e) => {
      if (isBox(e.target)) this.lastBox = e.target;
    });
    this.el.addEventListener("input", (e) => {
      if (isBox(e.target)) this.keepCaretInSight(e.target);
    });
    this.el.addEventListener("keydown", (e) => {
      const box = e.target;
      if (isBox(box) && NAVIGATION.has(e.key)) requestAnimationFrame(() => this.keepCaretInSight(box));
      else if (!this.stepOut(e)) this.keyOnCard(e);
    });
    // The keyboard rested on a card (Next Comment) and has moved on: a click on the card goes back to doing what it did.
    this.el.addEventListener("focusout", (e) => {
      const card = e.target;
      if (card instanceof HTMLElement && card.classList.contains("comment-card")) card.removeAttribute("tabindex");
    });
    // A resolved comment's card Find closed on goes once the keyboard leaves it.
    this.el.addEventListener("focusout", () => queueMicrotask(() => !this.foundHeld && this.letGoFound()));
    this.mentions = {
      api: host.api,
      onDoc: () => this.agents,
      named: () => agentsNamedIn(this.threads),
      // An agent only in the list (met on another document) takes a colour nobody here has.
      colourOf: (name) => this.colours.get(name) ?? pickColour(name, this.colours.values()),
    };
    listenForAgents(host.api);
    this.updateColours();
    // What's there as the document opens counts as seen.
    for (const id of [...threads.map((t) => t.id), ...notes.map((n) => n.id)]) {
      const news = this.news(id);
      if (news) this.seen.set(id, news.mark);
    }
  }

  /** The editor plugin that tracks and highlights this document's comments. */
  plugin() {
    return commentPlugin({ clicked: (id) => this.clickedText(id) });
  }

  /** The editor plugin that tracks agents' changes and highlights the selected comment's. Goes after plugin(). */
  changePlugin() {
    return changePlugin({
      clickedGap: (id) => {
        this.setActive(id);
        this.clickedText(id);
      },
    });
  }

  // Whether the panel shows, and the counts the status bar shows --------------------------

  /** What the panel says with no comments to show. */
  private emptyWords(resolved: number): string {
    if (resolved > 0) return "No open comments.";
    if (this.blank) return "Comments go here once there's something to comment on.";
    return "Select some words, then choose New comment (⌥⌘M). With nothing selected, it's a comment on the whole document. Your comments go to the agents working on this document.";
  }

  /** The document is empty (or no longer is): only the empty panel's words change. */
  blankDocument(blank: boolean): void {
    if (blank === this.blank) return;
    this.blank = blank;
    this.empty.textContent = this.emptyWords(this.resolvedCount);
  }

  get openCount(): number {
    return this.threads.filter((t) => t.status === "open").length;
  }

  get resolvedCount(): number {
    return this.threads.filter((t) => t.status === "resolved").length;
  }

  /** "3 comments", "2 resolved", or "" when there are none. */
  get countLabel(): string {
    return countLabel(this.openCount, this.resolvedCount);
  }

  /** The panel is showing (unless History has its place). Open on every document unless the person hid it. */
  get panelShown(): boolean {
    return !hiddenByPerson || this.shownAnyway;
  }

  /** Show or hide the panel, on every document: the person's choice, remembered between launches. */
  togglePanel(): void {
    if (this.panelShown) {
      // A box being written in keeps the keyboard for when the panel shows again (see below): not that.
      const inPanel = this.el.contains(document.activeElement) && document.activeElement !== this.boxInUse();
      if (this.draft && !this.draft.input.value.trim()) this.discardDraft();
      this.shownAnyway = false;
      if (!hiddenByPerson) setCommentsHidden(true);
      else this.followChoice();
      // Hidden with the keyboard in it: back to the page, where the cursor was (Batch 24, K-6).
      if (inPanel && !this.panelShown) this.focusPage();
    } else {
      setCommentsHidden(false);
      // Back to the box the person was writing in, if they hid the panel while writing.
      const box = this.boxInUse();
      if (box) {
        box.focus({ preventScroll: true });
        this.keepCaretInSight(box);
      }
    }
    void this.host.api.commentsHidden(hiddenByPerson);
  }

  /** The person's choice to show or hide the panel changed. */
  followChoice(): void {
    if (!hiddenByPerson) this.shownAnyway = false;
    this.render();
  }

  /** Show the panel on this document, whatever the person's choice (they started a comment, or an agent wrote). */
  private showAnyway(): void {
    if (this.panelShown) return;
    this.shownAnyway = true;
    this.render();
  }

  /** The view switched between formatted and Markdown. */
  modeChanged(): void {
    this.render();
  }

  /**
   * The comment box the person is writing in: it has the keyboard, or had it
   * until they used the toolbar (to switch views, say) or hid the panel.
   */
  boxInUse(): HTMLTextAreaElement | null {
    const box = this.lastBox;
    if (!box || !box.isConnected || !this.el.contains(box)) return null;
    return box;
  }

  // Comments from the app ---------------------------------------------------------

  setThreads(threads: Thread[]): void {
    this.findStamp = {};
    const known = new Set(this.threads.map((t) => t.id));
    // An agent's new comment or reply shows the panel, even if the person hid it.
    const counts = new Map(threads.map((t) => [t.id, t.messages.length]));
    const agentWrote = threads.some((t) => {
      const before = this.messageCounts.get(t.id) ?? 0;
      return t.messages.slice(before).some((m) => m.author.kind === "agent");
    });
    this.messageCounts = counts;
    if (agentWrote) this.shownAnyway = !this.panelShown || this.shownAnyway;
    this.threads = threads;
    const view = this.host.view();
    const value = commentRanges(view.state);
    const actions: RangeAction[] = [];
    let adopted: string | null = null;

    // The comment the person just posted: its draft becomes the comment.
    const posting = this.draft?.posting;
    if (posting) {
      const match = threads.find(
        (t) =>
          !known.has(t.id) &&
          t.messages[0]?.author.kind === "person" &&
          t.messages[0].body === posting.body &&
          sameAnchor(t.anchor, posting.anchor),
      );
      if (match) {
        adopted = match.id;
        if (value.ranges.has(DRAFT)) actions.push({ type: "rename", from: DRAFT, to: match.id });
        this.removeDraftCard();
      }
    }

    const ids = new Set(threads.map((t) => t.id));
    for (const id of value.ranges.keys()) {
      if (id !== DRAFT && !ids.has(id)) actions.push({ type: "remove", id });
    }
    for (const id of this.notFound) if (!ids.has(id)) this.notFound.delete(id);
    for (const id of this.unsent.keys()) if (!ids.has(id)) this.unsent.delete(id);

    let index: TextIndex | null = null;
    let missing = false;
    for (const t of threads) {
      const open = t.status === "open";
      if (value.ranges.has(t.id) || t.id === adopted) {
        if (t.id !== adopted && open !== value.shown.has(t.id)) actions.push({ type: "shown", id: t.id, on: open });
        continue;
      }
      if (!t.anchor || this.notFound.has(t.id)) continue;
      index ??= textIndex(view.state.doc);
      const range = findText(view.state.doc, t, index);
      if (range && t.gap) this.regained.add(t.id);
      if (range) actions.push({ type: "add", id: t.id, range, shown: open });
      else {
        this.notFound.add(t.id);
        if (!t.detached) missing = true;
      }
    }
    if (actions.length) view.dispatch(withRanges(view.state.tr, ...actions));
    if (missing) this.scheduleAnchorSave();
    this.checkChoices();
    this.locateChanges(false);
    placeGaps(view, this.threads);
    this.render();
  }

  /** Agents' notes waiting for the person changed: one was left, or marked done. */
  setNotes(notes: PassNote[]): void {
    this.findStamp = {};
    this.notes = notes;
    // A note marked done is no longer in focus.
    const view = this.host.view();
    const selected = changeMarks(view.state).selected;
    if (selected?.startsWith("note-") && !notes.some((n) => n.id === selected)) view.dispatch(withChanges(view.state.tr, { type: "select", owner: null }));
    this.render();
  }

  setAgents(agents: AgentInfo[]): void {
    this.agents = agents;
    this.render();
    refreshMentionFields(); // an agent's name may now be a tag
  }

  /** An agent connected to Corillo, or left it. */
  agentsKnownChanged(): void {
    this.render();
  }

  /** Whether New comment can start one now: not while an earlier version is shown, as for Comment (app.ts). */
  setCanComment(can: boolean): void {
    this.newCommentButton.disabled = !can;
  }

  // Keeping comments on their text ---------------------------------------------------

  /** After every change in the editor. */
  afterTransaction(tr: Transaction): void {
    const view = this.host.view();
    const value = commentRanges(view.state);
    if (tr.docChanged) {
      if (this.goesOnEdit) this.hideNote();
      this.scheduleAnchorSave();
      if (changeMarks(view.state).spans.size) this.changesMoved = true;
    }
    let changed = value.lost.length > 0;
    for (const [id, cut] of value.cut) this.cuts.set(id, cut);
    // Undo can bring back the text of a comment that had lost it.
    if (tr.docChanged && isHistoryTransaction(tr)) {
      if (carryThroughHistory(view, tr, this.placesWere, this.choicePlaces)) changed = true;
      if (refindLost(view, this.threads, putInBy(tr, view.state.doc), this.regained, this.notFound)) changed = true;
      this.locateChanges(true); // and of an agent's change
    } else if (tr.docChanged) {
      // The Markdown text's own Undo or Redo of a choice, as the editor's are.
      if (tr.getMeta(TEXT_HISTORY) && carryThroughHistory(view, tr, this.placesWere, this.choicePlaces)) changed = true;
      // Its words were moved (cut and pasted, dragged): the comment goes with them.
      if (putBack(view, tr, this.threads, this.cuts, this.regained, this.notFound)) changed = true;
    }
    if (changed) this.render();
    // The comment being written, or the one in focus, may have moved: Show changes' page, if it's on, marks it again.
    if (value.active !== this.lastActive || tr.getMeta(commentsKey)) this.el.dispatchEvent(new Event(COMMENT_MARKS));
    // The card of the comment in focus comes into sight (the cursor moved into its words, say).
    if (value.active !== this.lastActive) {
      this.lastActive = value.active;
      this.updateActive();
      if (value.active) this.revealCard(value.active);
    }
    const marks = changeMarks(view.state);
    if (marks.selected !== this.lastChange.selected || marks.before !== this.lastChange.before) {
      const moved = marks.selected !== this.lastChange.selected;
      this.lastChange = { selected: marks.selected, before: marks.before };
      this.updateActive();
      if (moved && marks.selected) this.revealCard(marks.selected);
    }
    const state = this.host.view().state;
    this.placesWere = { doc: state.doc, value: commentRanges(state) };
  }

  /**
   * Someone else's change came in as an edit (`tr`; `changed`: what it
   * replaced, before it): the texts kept for Undo and Redo of a choice are
   * carried through it, as the person's Undo is (undo-through.ts). Called once
   * the comments are on their words after it.
   */
  carryChoicesThrough(tr: Transaction, changed: readonly { from: number; to: number }[]): void {
    if (!this.choicePlaces.length) return;
    this.choicePlaces = keptThrough(this.choicePlaces, tr, changed, commentRanges(this.host.view().state).ranges);
  }

  /** The person's edits in the Markdown view (`tr`) replaced text the editor couldn't follow word by word: find comments whose words are still there. */
  refind(tr: Transaction): void {
    if (refindLost(this.host.view(), this.threads, putInBy(tr, this.host.view().state.doc), this.regained, this.notFound)) this.render();
  }

  // Agents' changes --------------------------------------------------------------------

  /** Each comment with a change, by owner, as stored. */
  private changeOwners(): Map<string, { round: number; spans: ChangeSpan[] }> {
    const owners = new Map<string, { round: number; spans: ChangeSpan[] }>();
    for (const t of this.threads) {
      const shown = this.shownChange(t);
      if (shown?.spans.length) owners.set(t.id, shown);
    }
    return owners;
  }

  /**
   * The change a comment's card lights up: the text an option the person
   * chose changed, while that choice is in the text, else the agent's latest
   * round. A choice's round is -1, so it's never taken for the agent's.
   */
  protected shownChange(t: Thread): { round: number; agent: string; at?: string; spans: ChangeSpan[] } | undefined {
    const chosen = this.standingChoices.get(t.id)?.choice;
    if (chosen?.spans.length) return { round: -1, agent: "You", spans: chosen.spans };
    return t.change;
  }

  /** The choices kept on open comments, in short, to tell when they change. */
  private keptChoices(): string {
    let out = "";
    for (const t of this.threads) {
      if (t.status !== "open") continue;
      for (const m of t.messages) if (m.choices?.length) out += `${t.id}/${m.id}:${m.choices.map((c) => `${c.option}@${c.at}`).join(",")};`;
    }
    return out;
  }

  /**
   * Work out again which options chosen are in the text, if the document or
   * the choices kept changed since: when the comments come in, and after a
   * pause in typing (Undo, say), never on each keystroke. The text is read
   * only when an open comment has a choice. Whether what's standing changed.
   */
  private checkChoices(): boolean {
    const kept = this.keptChoices();
    const doc = this.host.view().state.doc;
    if (kept === this.choicesSeen.kept && (!kept || doc === this.choicesSeen.doc)) return false;
    this.choicesSeen = { doc, kept };
    const next = new Map<string, { messageId: string; choice: Choice }>();
    if (kept) {
      const text = this.host.text();
      for (const t of this.threads) {
        if (t.status !== "open") continue;
        for (const m of t.messages) {
          const choices = choicesOf(m);
          const now = choices.length ? standing(text, optionsOf(m), choices) : null;
          if (now) next.set(t.id, { messageId: m.id, choice: now.choice });
        }
      }
    }
    const said = (map: Map<string, { messageId: string; choice: Choice }>) =>
      [...map].map(([id, c]) => `${id}/${c.messageId}:${c.choice.option}@${c.choice.at}`).join(";");
    const changed = said(next) !== said(this.standingChoices);
    this.standingChoices = next;
    return changed;
  }

  /**
   * Find agents' changes in the text: all of them after the text was replaced,
   * otherwise only those that are new or changed since they were last found.
   */
  private locateChanges(all: boolean): void {
    const view = this.host.view();
    if (!view) return;
    const doc = view.state.doc;
    let index: TextIndex | null = null;
    const owners = this.changeOwners();
    const signature = (o: { round: number; spans: ChangeSpan[] }) => `${o.round}:${JSON.stringify(o.spans)}`;
    const actions: ChangeAction[] = [];
    if (all) {
      const spans: Record<string, MarkedSpan[]> = {};
      if (owners.size) index = textIndex(doc);
      for (const [owner, o] of owners) spans[owner] = placeSpans(doc, o.spans, index!);
      this.located = new Map([...owners].map(([owner, o]) => [owner, signature(o)]));
      actions.push({ type: "reset", spans });
    } else {
      for (const [owner, o] of owners) {
        const sig = signature(o);
        if (this.located.get(owner) === sig) continue;
        index ??= textIndex(doc);
        actions.push({ type: "set", owner, spans: placeSpans(doc, o.spans, index) });
        this.located.set(owner, sig);
      }
      for (const owner of [...this.located.keys()]) {
        if (owners.has(owner)) continue;
        actions.push({ type: "remove", owner });
        this.located.delete(owner);
      }
    }
    if (actions.length) view.dispatch(withChanges(view.state.tr, ...actions));
  }

  /**
   * Tell Corillo where the person's edits moved agents' changes, so they're
   * found next time: only the changes that moved, and after a pause in typing
   * (`lazy`) not those that only moved a little.
   */
  private saveChangeAnchors(lazy = false): void {
    if (!this.changesMoved) return;
    this.changesMoved = false;
    const view = this.host.view();
    const marks = changeMarks(view.state);
    const doc = view.state.doc;
    const index = textIndex(doc);
    const report: ChangeAnchorReport = { threads: {} };
    let later = false;
    const moved = (spans: ChangeSpan[], owner: string) => {
      const marked = marks.spans.get(owner);
      if (!marked) return null;
      const anchors = anchorsOf(doc, marked, spans.length, index);
      const same = (close: (a: Anchor, b: Anchor) => boolean) => anchors.every((a, i) => a === null || (a !== false && close(a, spans[i].anchor)));
      if (same(sameAnchor)) return null;
      if (lazy && same(movedALittle)) {
        later = true; // told exactly next time the text is replaced, or the tab closes
        return null;
      }
      // The stored list loses spans whose words the person deleted; the editor's keeps them, marked gone.
      const next: ChangeSpan[] = [];
      spans.forEach((s, i) => {
        const a = anchors[i];
        if (a !== false) next.push(a ? { ...s, anchor: a } : s);
      });
      return { anchors, next };
    };
    this.threads = this.threads.map((t) => {
      // A choice in the text is what's marked: the agent's change waits, as it was, for the choice to be taken out.
      if (!t.change?.spans.length || this.standingChoices.get(t.id)?.choice.spans.length) return t;
      const m = moved(t.change.spans, t.id);
      if (!m) return t;
      report.threads[t.id] = { round: t.change.round, anchors: m.anchors };
      const change = { ...t.change, spans: m.next };
      this.located.set(t.id, `${change.round}:${JSON.stringify(change.spans)}`);
      return { ...t, change };
    });
    if (later) this.changesMoved = true;
    if (Object.keys(report.threads).length) this.host.api.saveChangeAnchors(this.host.id, report);
    // Where spans were dropped, the stored list is shorter: find the rest again so their places line up.
    const shrank = [...marks.spans].filter(([, list]) => list.some((s) => s.gone)).map(([owner]) => owner);
    if (shrank.length) {
      for (const owner of shrank) this.located.delete(owner);
      this.locateChanges(false);
    }
  }

  /** Show or hide what the selected change's text said before. */
  toggleBefore(on?: boolean): void {
    const view = this.host.view();
    const marks = changeMarks(view.state);
    if (!marks.selected) return;
    const show = on ?? !marks.before;
    view.dispatch(withChanges(view.state.tr, { type: "before", on: show }));
    if (show) this.revealBefore(marks.selected);
  }

  /**
   * The old words just shown, in sight, unless some already are. They're drawn
   * where the agent changed the text, which can be far from what's on screen:
   * for a comment on the whole document, the page stayed at the top while they
   * showed further down (Orlando, 2026-11-11: "When I click on it, I don't see
   * anything happening.").
   */
  private revealBefore(owner: string): void {
    const view = this.host.view();
    const gap = changeMarks(view.state).gaps.get(owner);
    const places = present(this.changeSpans(owner))
      .filter((s) => s.removed.replaceAll(PICTURE_STAND_IN, "").trim() && !(gap && s.point))
      .map((s) => s.from);
    if (gap?.text.replaceAll(PICTURE_STAND_IN, "").trim()) places.push(gap.pos);
    if (!places.length) return;
    const pane = view.dom.closest<HTMLElement>(".canvas");
    if (pane?.checkVisibility()) {
      const seen = pane.getBoundingClientRect();
      const inSight = [...view.dom.querySelectorAll("del.change-before")].some((d) => {
        const r = d.getBoundingClientRect();
        return r.height > 0 && r.bottom > seen.top && r.top < seen.bottom;
      });
      if (inSight) return;
    }
    this.host.reveal(Math.min(...places));
  }

  /** Where an owner's change is in the text now (empty if it isn't). */
  protected changeSpans(owner: string): MarkedSpan[] {
    return changeMarks(this.host.view().state).spans.get(owner) ?? [];
  }

  /**
   * Find every comment in the text again. For when the document's text was
   * replaced: on opening, after a change made outside Corillo (or by an agent),
   * and on coming back from the Markdown view. `focus`: the card that was in
   * focus before, which stays so if it's still there.
   */
  reanchor(focus: { active: string | null; selected: string | null } | null = null): void {
    findEvery(this.host.view(), this.threads, this.draft, focus, this.regained, this.notFound);
    placeGaps(this.host.view(), this.threads, true);
    this.saveAnchorsNow();
    this.locateChanges(true);
    this.render();
  }

  private scheduleAnchorSave(): void {
    if (this.anchorTimer) clearTimeout(this.anchorTimer);
    this.anchorTimer = setTimeout(() => this.saveAnchors(true), ANCHOR_SAVE_DELAY_MS);
  }

  /** Tell the app exactly where each comment's text is now, so it's found next time (before the text is replaced, say). */
  saveAnchorsNow(): void {
    this.saveAnchors(false);
  }

  /**
   * Tell the app where each comment's text is now: after a pause in typing
   * (`lazy`), or at once. Every comment that moved is told, however little,
   * so the place kept matches the text saved (W-S2); an agent's change that
   * only moved a little waits until the next time it's told at once.
   */
  private saveAnchors(lazy: boolean): void {
    if (this.anchorTimer) clearTimeout(this.anchorTimer);
    this.anchorTimer = null;
    const view = this.host.view();
    if (!view) return;
    const told = placesToTell(view, this.threads, this.regained);
    this.threads = told.threads;
    const { value, doc, index, changes, any } = told;
    let requote = told.requote;
    const draftRange = value.ranges.get(DRAFT);
    if (this.draft && draftRange) {
      this.draft.anchor = anchorFor(doc, draftRange.from, draftRange.to, index ?? undefined);
      // Its words were typed over or rewritten (by an agent, say): it quotes them as they are now, as the posted cards do.
      if (this.draft.anchored && this.draft.anchor.quote !== this.draft.quote) {
        this.draft.quote = this.draft.anchor.quote;
        this.draft.el.querySelector(".comment-quote")?.replaceWith(this.placeLabel(this.draft.quote));
      }
    }
    if (any) this.host.api.saveCommentAnchors(this.host.id, changes);
    this.saveChangeAnchors(lazy);
    // An option chosen taken out with Undo, or put back with Redo: its card says so, and lights what's in the text.
    if (this.checkChoices()) {
      this.locateChanges(false);
      requote = true;
    }
    if (requote) this.render(); // each card quotes the words it's on now
  }

  // Adding a comment ----------------------------------------------------------------

  /**
   * Start a comment: on the selected words, or on the whole document when
   * nothing is selected. `picked` is a selection made in the Markdown view,
   * as places in the editor's document; `chosen` says the person selected
   * something there, which may turn out to be only Markdown's marks.
   */
  add(picked?: { from: number; to: number; chosen: boolean }): void {
    if (this.draft?.input.value.trim()) {
      this.say("Post or cancel this comment first.");
      this.focusDraft();
      return;
    }
    this.hideNote();
    const view = this.host.view();
    const { from, to } = picked ?? view.state.selection;
    const quote = from === to ? "" : view.state.doc.textBetween(from, to, "\n", PICTURE_STAND_IN);
    const anchored = quote.trim().length > 0;
    if (picked?.chosen && !anchored) {
      this.say("Select some words to comment on. Markdown's marks on their own can't hold a comment.");
      return;
    }
    if (this.draft) this.discardDraft(false);
    if (anchored) {
      view.dispatch(
        withRanges(view.state.tr, { type: "add", id: DRAFT, range: { from, to }, shown: true }, { type: "active", id: DRAFT }),
      );
    } else if (commentRanges(view.state).active) {
      view.dispatch(withRanges(view.state.tr, { type: "active", id: null }));
    }
    this.draft = this.buildDraft(anchored, quote, anchored ? anchorFor(view.state.doc, from, to) : null);
    this.shownAnyway = !this.panelShown || this.shownAnyway;
    this.render();
    this.focusDraft();
  }

  private focusDraft(): void {
    if (!this.draft) return;
    this.draft.input.focus({ preventScroll: true });
    this.revealCard(DRAFT);
  }

  /**
   * A short message at the top of the panel, for a few seconds. It shows at
   * the top of what's in sight (style.css), wherever the panel is scrolled,
   * and the cards stay where they are.
   */
  protected say(text: string): void {
    this.goesOnEdit = false;
    this.showAnyway();
    this.note.textContent = text;
    this.keepCardsStill(() => (this.note.hidden = false));
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => this.hideNote(), NOTE_MS);
  }

  private hideNote(): void {
    this.goesOnEdit = false;
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.noteTimer = null;
    if (!this.note.hidden) this.keepCardsStill(() => (this.note.hidden = true));
  }

  /** Something above the cards changes height (the lines over the page, columns.ts): the cards in sight don't move. */
  keepStill(change: () => void): void {
    this.keepCardsStill(change);
  }

  /** The message comes or goes above the cards: with the panel scrolled down, the cards in sight don't move. */
  private keepCardsStill(change: () => void): void {
    if (this.el.scrollTop > 0) this.holdCard(this.list, change);
    else change();
  }

  private buildDraft(anchored: boolean, quote: string, anchor: Anchor | null): Draft {
    const card = el("article", "comment-card draft active");
    card.setAttribute("aria-label", "New comment");
    const head = el("div", "comment-head");
    head.append(this.placeLabel(anchored ? quote : null));
    const input = el("textarea", "comment-input");
    input.rows = 2;
    input.placeholder = "Write a comment. Type @ to ask a particular agent.";
    input.setAttribute("aria-label", "New comment");
    const field = mentionField(input, this.mentions, { kind: "comment" });
    const error = el("p", "comment-error");
    error.hidden = true;
    const actions = el("div", "comment-actions-row");
    const cancel = textButton("Cancel", "comment-button", () => this.discardDraft());
    const post = textButton("Post", "comment-button primary-small", () => void this.postDraft());
    post.title = "Post (⌘↩)";
    post.disabled = true;
    actions.append(el("span", "comment-spacer"), cancel, post);
    card.append(head, field.el, error, actions);
    const draft: Draft = { anchored, quote, anchor, el: card, input, field, post, error, posting: null };
    input.addEventListener("input", () => {
      post.disabled = !input.value.trim();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void this.postDraft();
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (!input.value.trim()) this.discardDraft();
        else this.host.focusDocument();
      }
    });
    return draft;
  }

  private async postDraft(): Promise<void> {
    const draft = this.draft;
    if (!draft || draft.posting) return;
    const body = draft.input.value.trim();
    if (!body) return;
    const view = this.host.view();
    let anchor: Anchor | null = null;
    if (draft.anchored) {
      const range = commentRanges(view.state).ranges.get(DRAFT);
      anchor = range ? anchorFor(view.state.doc, range.from, range.to) : draft.anchor;
    }
    draft.posting = { body, anchor };
    draft.post.disabled = true;
    // The first agent named with @ is the one it's for; with none, the default agent.
    const result = await this.host.api.addComment(this.host.id, body, anchor, draft.field.mention());
    if (!result.ok) {
      draft.posting = null;
      draft.post.disabled = false;
      draft.error.textContent = result.error;
      draft.error.hidden = false;
      return;
    }
    if (this.draft === draft) {
      // The app hasn't announced the new comment yet: the draft becomes it now.
      const v = this.host.view();
      if (commentRanges(v.state).ranges.has(DRAFT)) {
        v.dispatch(withRanges(v.state.tr, { type: "rename", from: DRAFT, to: result.value.id }));
      }
      if (!this.threads.some((t) => t.id === result.value.id)) this.threads = [...this.threads, result.value];
      this.removeDraftCard();
      this.render();
    }
    this.acted();
    // The cursor at the end of the commented words, nothing selected, so the next key replaces nothing (Batch 24, K-1).
    this.cursorToDocument();
  }

  /** The draft's card goes. */
  private removeDraftCard(): void {
    this.draft?.el.remove();
    this.draft = null;
  }

  /** Throw away the comment being written. */
  protected discardDraft(refocus = true): void {
    if (!this.draft) return;
    this.removeDraftCard();
    const view = this.host.view();
    if (commentRanges(view.state).ranges.has(DRAFT)) view.dispatch(withRanges(view.state.tr, { type: "remove", id: DRAFT }));
    this.render();
    // Back to the page with nothing selected, so the next key replaces nothing (review of Batch 24, R24-1).
    if (refocus) this.focusPage();
  }

  /**
   * Clicking away from an empty draft discards it, as Word does. Switching
   * views doesn't: the draft stays, ready to type in.
   */
  private clickedSomewhere(e: MouseEvent): void {
    const draft = this.draft;
    if (!draft || draft.posting || draft.input.value.trim()) return;
    const target = e.target as Element | null;
    if (draft.el.contains(target) || target?.closest?.(".mode-switch")) return;
    this.discardDraft(false);
  }

  // Acting on a comment ---------------------------------------------------------------

  protected async act(card: Card | null, action: () => Promise<{ ok: true } | { ok: false; error: string }>): Promise<boolean> {
    const result = await action();
    if (card) {
      card.error.hidden = result.ok;
      card.error.textContent = result.ok ? "" : result.error;
    }
    if (result.ok) this.acted();
    return result.ok;
  }

  /** The person did something with a comment: tell whoever is listening, once. */
  protected acted(): void {
    const listener = this.onPersonActed;
    this.onPersonActed = null;
    listener?.();
  }

  protected setActive(id: string | null): void {
    const view = this.host.view();
    if (commentRanges(view.state).active !== id) view.dispatch(withRanges(view.state.tr, { type: "active", id }));
  }

  /** Highlighted text was clicked: show its comment's card. */
  private clickedText(id: string): void {
    this.showAnyway();
    this.revealCard(id);
  }

  /** A comment's words were clicked in the Markdown view (its text or its preview): put it in focus and show its card. */
  textClicked(id: string): void {
    const view = this.host.view();
    if (commentRanges(view.state).active !== id) view.dispatch(withRanges(view.state.tr, { type: "active", id, revealed: true }));
    this.clickedText(id);
  }

  /** The cursor moved in the Markdown view's text, into a comment's words or out of them. */
  cursorIn(id: string | null): void {
    this.setActive(id);
  }

  // Keeping cards and the caret in sight --------------------------------------------------

  /** Where the cards can be seen: the panel, under its top, which stays in sight (F-2). */
  protected sight(): { top: number; bottom: number; height: number } {
    const box = this.el.getBoundingClientRect();
    const top = box.height ? Math.max(box.top, this.top.getBoundingClientRect().bottom) : box.top;
    return { top, bottom: box.bottom, height: box.height };
  }

  /**
   * Scroll the panel so a card is in sight: all of it where it fits, and
   * never so far that its top goes out of sight.
   */
  protected revealCard(id: string): void {
    const card = id === DRAFT ? this.draft?.el : (this.cards.get(id)?.el ?? this.noteCards.get(id));
    if (!card || !this.panelShown || !card.isConnected) return;
    const seen = this.sight();
    const box = card.getBoundingClientRect();
    if (!box.height || !seen.height) return; // not on screen: another tab, or History has the panel's place
    let by = 0;
    if (box.top < seen.top + MARGIN) by = box.top - seen.top - MARGIN;
    else if (box.bottom > seen.bottom - MARGIN) by = Math.min(box.bottom - seen.bottom + MARGIN, box.top - seen.top - MARGIN);
    if (by) this.el.scrollTop += by;
  }

  /**
   * Keep a card's top where it is on screen through a change of focus: the
   * card that was in focus goes compact, and whatever is under it would slide
   * up. The panel scrolls back by as much, keeping room under the cards where
   * it can't scroll that far (it goes as the person scrolls up into it).
   */
  protected holdCard(card: HTMLElement | undefined, change: () => void): void {
    const before = card?.isConnected && !this.el.hidden ? card.getBoundingClientRect() : null;
    change();
    if (!card || !before?.height || !card.isConnected) return;
    const by = card.getBoundingClientRect().top - before.top;
    if (Math.abs(by) < 1) return;
    const want = Math.max(0, this.el.scrollTop + by);
    const short = want - (this.el.scrollHeight - this.el.clientHeight);
    if (short > 0) this.slack.style.height = `${(parseFloat(this.slack.style.height) || 0) + short}px`;
    this.el.scrollTop = want;
  }

  /**
   * Keep the line being typed in a comment box in sight, as the box grows or
   * the cursor moves: the panel scrolls just enough, bringing the box's
   * buttons into sight too where that doesn't take the line off the top.
   * The cursor's line is measured only when the box or its buttons are
   * partly out of sight, so typing stays quick.
   */
  protected keepCaretInSight(box: HTMLTextAreaElement): void {
    if (document.activeElement !== box || !this.el.contains(box)) return;
    const seen = this.sight();
    if (!seen.height) return;
    const top = seen.top + MARGIN;
    const bottom = seen.bottom - MARGIN;
    const rect = box.getBoundingClientRect();
    // The box's buttons sit just after it (and after its @ list's wrapper).
    let actions: HTMLElement | null = null;
    for (let up = box.parentElement; up && up !== this.el && !actions; up = up.parentElement) {
      actions = up.querySelector<HTMLElement>(":scope > .comment-actions-row");
    }
    const end = actions?.offsetParent ? Math.max(rect.bottom, actions.getBoundingClientRect().bottom) : rect.bottom;
    if (rect.top >= top && end <= bottom) return;
    const line = caretLine(box);
    let by = 0;
    if (line.top < top) by = line.top - top;
    else {
      by = Math.max(0, line.bottom - bottom);
      if (end > bottom) by = Math.max(by, Math.min(end - bottom, line.top - top));
    }
    if (by) this.el.scrollTop += by;
  }

  /**
   * Scroll the document to a comment's words (or where its deleted words
   * were), in each pane showing it; to the top for a comment with no words
   * in the text.
   */
  protected revealText(id: string): void {
    const state = this.host.view().state;
    const range = commentRanges(state).ranges.get(id);
    const gap = changeMarks(state).gaps.get(id);
    if (range) this.host.reveal(range.from);
    else if (gap) this.host.reveal(gap.pos);
    else this.host.reveal(null);
  }

  // Agents' colours -----------------------------------------------------------------------

  protected colourOf(name: string): AgentColour {
    return this.colours.get(name) ?? agentColours([name]).get(name)!;
  }

  private updateColours(): void {
    // Connected agents keep the colour the app gave them, which their editing notice shows too.
    // Agents the comments name with @ get theirs too, so a tag keeps its colour.
    this.colours = agentColours(
      [...agentNames(this.threads, this.agents), ...agentsNamedIn(this.threads)],
      this.agents.map((a) => [a.name, a.colour ?? ""]),
    );
  }

  // What waits for the person (the line when an agent is done) ----------------------------

  /** What waits for the person, by kind of card (for the line when an agent is done). */
  waitingKinds(): Waiting {
    return { comments: this.threads.filter(waitingForPerson).length, notes: this.notes.length };
  }

  // Handing the document back (Send to Claude, roadmap Batch 2 item 1) -------------------

  private drawHandBack(): void {
    const hb = handBackFor(this.threads, this.agents, waitingForPerson);
    // A Send kept for a busy agent and let go (what it was for was resolved): no take of the agent's is its own now.
    if (this.handBackNow?.kind === "sent" && hb?.kind !== "sent" && this.host.view().editable) this.sentFromPage = this.sentFromButton = false;
    this.handBackNow = hb;
    const b = this.handBackButton;
    // Sent from its own button by keys: as it goes (or greys out), the keyboard moves to New comment beside it (G-6).
    if (document.activeElement === b && (!hb || hb.kind === "listening" || hb.kind === "sent")) queueMicrotask(() => {
      if (!document.activeElement || document.activeElement === document.body || document.activeElement === b) this.keyboardWhileLocked();
    });
    b.hidden = !hb;
    // Why a Send didn't get there: said while the button offers to copy the message instead.
    if (hb?.kind !== "copy") this.lost = null;
    const why = this.lost && hb?.kind === "copy" ? lostWords(this.lost, hb.agent) : "";
    if (this.handBackWhy.textContent !== why) this.handBackWhy.textContent = why;
    if (this.handBackWhy.hidden !== !why) this.keepCardsStill(() => (this.handBackWhy.hidden = !why));
    // Greyed out while the agent waits with nothing new to send: why, and what to do (F-7).
    const hint = hb?.kind === "listening" ? "Nothing new to send. Reply or comment first." : "";
    if (this.handBackHint.textContent !== hint) this.handBackHint.textContent = hint;
    if (this.handBackHint.hidden !== !hint) this.keepCardsStill(() => (this.handBackHint.hidden = !hint));
    if (!hb) return;
    const label = handBackLabel(hb);
    if (b.textContent !== label) b.textContent = label;
    b.disabled = hb.kind === "listening" || hb.kind === "sent";
    b.title =
      hb.kind === "send"
        ? `${hb.agent} is waiting for your review. Send it your ${hb.comments === 1 ? "comment" : "comments"} (⇧⌘D).`
        : hb.kind === "listening"
          ? `${hb.agent} is waiting for your review. Comment, then send it your comments.`
          : hb.kind === "sent"
            ? `Sent. ${hb.agent} starts on it ${hb.after ? `when it has finished ${hb.after}` : "in a moment"}.`
            : `Copy a message saying there's feedback here, to paste in ${hb.agent}'s chat (⇧⌘D).`;
  }

  /** The agent the Send button names, while one waits for the review (for the status bar's tooltip). */
  sendsTo(): string | null {
    const hb = this.handBackNow;
    return hb && (hb.kind === "send" || hb.kind === "listening") ? hb.agent : null;
  }

  /** Review > Send to Claude: its words, and whether it can be chosen now. */
  handBackState(): { label: string; enabled: boolean } {
    const hb = this.handBackNow;
    if (!hb) return { label: "Send to Claude", enabled: false };
    return { label: handBackLabel(hb), enabled: hb.kind === "send" || hb.kind === "copy" };
  }

  /** Send the document to the agent waiting for the review, or copy the sentence for its chat. */
  async handBack(): Promise<void> {
    const hb = this.handBackNow;
    if (!hb || hb.kind === "listening" || hb.kind === "sent") return;
    // A comment typed and not posted would be left behind.
    const box = this.unposted();
    if (box) {
      this.say("Post or cancel your comment first, so it goes too.");
      this.showUnposted(box);
      return;
    }
    if (hb.kind === "send") {
      // Sent with the keyboard in the page: the page locks as the agent takes it, and the keyboard goes to New comment (G-6).
      this.sentFromPage = this.host.view().hasFocus();
      this.sentFromButton = document.activeElement === this.handBackButton;
      // A Send that fails in the app is a Send that didn't go: said, never silent. The agent may well
      // still be waiting (it would have said otherwise), so the words are Corillo's own (W-Q4).
      const result = await this.host.api.sendToAgent(this.host.id, hb.agent).catch(() => ({ sent: false, problem: undefined }));
      if (!result.sent) this.sentFromPage = this.sentFromButton = false; // otherwise until the agent takes the document
      if (!result.sent) this.say(result.problem ?? `Corillo couldn't send this to ${hb.agent}. Try again.`);
      return;
    }
    if (await this.host.api.copyForAgent(this.host.id, hb.comments)) {
      this.lost = null;
      this.drawHandBack();
      this.say(`Copied. Paste it in ${hb.agent}'s chat.`);
      this.goesOnEdit = true; // and it goes once he types or comments again (Batch 24, N-20)
    }
  }

  /** The person's Send didn't reach the agent: it stopped listening first, or couldn't take the document (B2-01, B2-04). */
  sendLost(agent: string, why: "stopped" | "failed"): void {
    this.lost = { agent, why };
    this.sentFromPage = this.sentFromButton = false; // no take is coming for it
    this.showAnyway();
    this.drawHandBack();
  }

  // Going through the cards (review.ts): order, focus, resolving, boxes not posted ---------

  /** The cards, top to bottom, as the panel lists them now (the one being written left out). */
  cardOrder(): string[] {
    const ids: string[] = [];
    for (const card of this.list.children) {
      const id = (card as HTMLElement).dataset.threadId;
      if (id) ids.push(id);
    }
    return ids;
  }

  /**
   * Where the keyboard goes when this card goes (Resolve, Delete): the next
   * card with something new, or else the card after, round to the first
   * (roadmap Batch 12, G-2).
   */
  cardAfter(id: string): string | null {
    const order = this.cardOrder();
    const i = order.indexOf(id);
    const unread = new Set(this.unreadItems());
    return [...order.slice(i + 1), ...order.slice(0, Math.max(i, 0))].find((x) => unread.has(x)) ?? order[i + 1] ?? order.find((x) => x !== id) ?? null;
  }

  /** An agent's note about its pass. */
  private noteOf(id: string): PassNote | undefined {
    return this.notes.find((n) => n.id === id);
  }

  /**
   * A box with a comment, reply or edit typed and not yet posted, if there is
   * one. A reply on a resolved comment doesn't count: its box can't be shown.
   */
  unposted(): HTMLTextAreaElement | null {
    if (this.draft && !this.draft.posting && this.draft.input.value.trim()) return this.draft.input;
    for (const [id, card] of this.cards) {
      if (!card.reply.hidden && card.replyInput.value.trim()) return card.replyInput;
      if (!card.editing) continue;
      const editing = card.editing;
      const was = this.threads.find((t) => t.id === id)?.messages.find((m) => m.id === editing.messageId)?.body;
      const box = card.main.querySelector<HTMLTextAreaElement>(".comment-edit textarea");
      if (box?.value.trim() && box.value.trim() !== was) return box;
    }
    return null;
  }

  /** Show the person a box they typed in and haven't posted, with the cursor in it. */
  showUnposted(box: HTMLTextAreaElement): void {
    this.showAnyway();
    if (!box.checkVisibility()) this.el.dispatchEvent(new Event(COMMENTS_WANTED, { bubbles: true }));
    box.focus({ preventScroll: true });
    const card = box.closest<HTMLElement>(".comment-card");
    const id = card === this.draft?.el ? DRAFT : card?.dataset.threadId;
    if (id) this.revealCard(id);
    this.keepCaretInSight(box);
  }

  /** Put the cursor in a comment's reply box. From the card the keyboard rests on, leaving the box goes back to the card. */
  focusReply(id: string): void {
    const card = this.cards.get(id);
    if (!card || card.reply.hidden) return;
    this.openReply(card, document.activeElement === card.el);
  }

  /** Select an item: its card in focus and in sight, and its text (or the change made for it) in sight. */
  focusItem(id: string): void {
    this.host.settle();
    this.shownAnyway = !this.panelShown || this.shownAnyway;
    const view = this.host.view();
    // A note is in focus the way an agent's change is, with no changes to show.
    const note = !!this.noteOf(id);
    // A card in sight stays where it is as the one that was in focus goes compact.
    this.holdCard(this.cards.get(id)?.el ?? this.noteCards.get(id), () => {
      if (note) {
        view.dispatch(withChanges(withRanges(view.state.tr, { type: "active", id: null }), { type: "select", owner: id }));
      } else this.setActive(id);
      this.render();
    });
    this.read(id);
    // The change first, where there is one; otherwise the comment's own text (or where it was).
    const first = present(this.changeSpans(id)).sort((a, b) => a.from - b.from)[0];
    if (first) this.host.reveal(first.from);
    else if (!note) this.revealText(id);
    this.revealCard(id);
  }

  /** Resolve a comment, or mark an agent's note done. */
  async resolveItem(id: string): Promise<boolean> {
    const api = this.host.api;
    if (this.noteOf(id)) {
      const result = await api.noteDone(this.host.id, id);
      if (result.ok) {
        this.setNotes(this.notes.filter((n) => n.id !== id));
        this.acted();
      }
      return result.ok;
    }
    return this.resolve(this.cards.get(id) ?? null, id);
  }

  /** Resolve a comment; Undo, as the very next thing, reopens it (undo-resolve.ts). */
  protected async resolve(card: Card | null, id: string): Promise<boolean> {
    // The keyboard on its tick (Return there): on to the next card, as the shortcut does, and said (Batch 24, K-2).
    // A click leaves the cards where they are, as before.
    const fromCard = !!card && this.tickByKeys;
    this.tickByKeys = false;
    const byKeys = fromCard || this.keyboardOnCard;
    const after = fromCard ? this.cardAfter(id) : null;
    const ok = await this.act(card, () => this.host.api.resolveComment(this.host.id, id, true));
    if (ok) {
      if (byKeys) this.say("Comment resolved");
      const lost = !document.activeElement || document.activeElement === document.body;
      if (fromCard && lost) {
        if (after && this.cardOrder().includes(after)) {
          this.focusItem(after);
          this.keyboardTo(after);
        } else this.host.focusDocument();
      }
      justDone({
        owner: this,
        // Back open, in focus, its words and its card in sight, as Next Comment would show it.
        // The keyboard resting on a card (Resolve from a card moved it on) goes back to this one.
        undo: () =>
          void this.act(this.cards.get(id) ?? null, () => this.host.api.resolveComment(this.host.id, id, false)).then((back) => {
            if (!back || !this.threads.some((t) => t.id === id && t.status === "open")) return;
            this.focusItem(id);
            if (this.keyboardOnCard) this.keyboardTo(id);
          }),
        changed: () => this.host.changed(),
      });
    }
    return ok;
  }

  /** The item whose change is shown, if any. */
  get selectedItem(): string | null {
    return changeMarks(this.host.view().state).selected ?? commentRanges(this.host.view().state).active;
  }

  // For the menus (Review and View), which act on the selected comment ------------

  /** What can be done with an item from the menus. */
  itemInfo(id: string): { note?: boolean; resolved: boolean; canReply: boolean; canDelete: boolean } {
    if (this.noteOf(id)) return { note: true, resolved: false, canReply: false, canDelete: false };
    const t = this.threads.find((x) => x.id === id);
    const resolved = t?.status === "resolved";
    // As on the card: the person can delete their own comment while it's open.
    const canDelete = !!t && !resolved && t.messages[0]?.author.kind === "person";
    return { resolved, canReply: !!t && !resolved, canDelete };
  }

  reopenItem(id: string): void {
    void this.act(this.cards.get(id) ?? null, () => this.host.api.resolveComment(this.host.id, id, false));
  }

  /** Review > Delete Comment: the comment in focus and its replies go at once; Undo straight after brings them back. */
  deleteItem(id: string): void {
    const t = this.threads.find((x) => x.id === id);
    if (!t || !this.itemInfo(id).canDelete) return;
    // By keys if the keyboard is on that card or a button in it, its tick or "⋯" (review of Batch 12, B12-8). Not from
    // its reply box: there the keyboard goes to the page, as before (menus.spec.ts holds it).
    const card = this.cards.get(id)?.el;
    const onButton = document.activeElement instanceof HTMLButtonElement && !!card?.contains(document.activeElement);
    void this.deleteMessage(id, t.messages[0].id, this.keyboardOnCard || onButton);
  }

  /** Whether the selected change can show what its text said before, and whether it does. */
  beforeInfo(): { available: boolean; on: boolean } {
    const marks = changeMarks(this.host.view().state);
    // A note changed nothing: there's nothing it said before.
    const changed = !!marks.selected && !this.noteOf(marks.selected);
    return { available: changed, on: changed && marks.before };
  }

  get showingResolved(): boolean {
    return this.showResolved;
  }

  /** List resolved comments too (View > Show Resolved Comments), showing the panel. */
  setShowResolved(on: boolean): void {
    this.showResolved = on;
    if (on) this.shownAnyway = !this.panelShown || this.shownAnyway;
    this.render();
  }

  /** Nothing selected: no comment in focus, no change drawn. */
  clearSelection(): void {
    const view = this.host.view();
    view.dispatch(withChanges(withRanges(view.state.tr, { type: "active", id: null }), { type: "select", owner: null }));
  }

  // Drawing the cards ---------------------------------------------------------------------

  protected render(): void {
    const view = this.host.view();
    if (!view) return;
    this.updateColours();
    const ranges = commentRanges(view.state).ranges;
    const gaps = changeMarks(view.state).gaps;
    const placeOf = (id: string) => ranges.get(id)?.from ?? gaps.get(id)?.pos ?? null;
    const visible = this.threads.filter((t) => t.status === "open" || this.showResolved || t.id === this.foundResolved);
    const ordered = orderThreads(visible, placeOf);

    // From the top: agents' notes, then the cards with no place in the text
    // (whole-document comments and one being written, comments whose text
    // can't be found), then the rest in the order their text comes. Always
    // this one order (roadmap Batch 9, item 8: no "Waiting for you first").
    const whole: HTMLElement[] = [];
    const lost: HTMLElement[] = [];
    const inText: { el: HTMLElement; pos: number }[] = [];
    const keep = new Set<string>();
    for (const t of ordered) {
      const pos = placeOf(t.id);
      const card = this.cardFor(t, ranges.has(t.id) || !t.anchor, gaps.has(t.id));
      keep.add(t.id);
      if (!t.anchor) whole.push(card.el);
      else if (pos === null) lost.push(card.el);
      else inText.push({ el: card.el, pos });
    }
    const notes = this.noteCardsFor();
    // Where the panel was, read before a card goes (only then: reading it
    // costs a layout, and typing shouldn't pay for it).
    let scrolled: number | null = null;
    for (const [id, card] of this.cards) {
      if (!keep.has(id)) {
        scrolled ??= this.el.scrollTop;
        this.keepUnsent(id, card);
        card.el.remove();
        this.cards.delete(id);
      }
    }
    // The comment being written goes where it will be once posted.
    if (this.draft && !this.draft.anchored) whole.push(this.draft.el);
    else if (this.draft) {
      const pos = ranges.get(DRAFT)?.from ?? Infinity;
      const at = inText.findIndex((b) => b.pos > pos);
      inText.splice(at < 0 ? inText.length : at, 0, { el: this.draft.el, pos });
    }
    // Agents' notes first, newest at the top: what the person should know before reading the rest.
    const wanted = [...notes, ...whole, ...lost, ...inText.map((e) => e.el)];
    // Moving a card takes the keyboard out of a box in it, or off the card it rests on: it goes back.
    const focused = document.activeElement;
    const typing = focused instanceof HTMLTextAreaElement && this.list.contains(focused) ? focused : null;
    const selection = typing ? [typing.selectionStart, typing.selectionEnd] : null;
    const restingOn = focused instanceof HTMLElement && focused.parentElement === this.list ? focused : null;
    if (scrolled === null && this.list.children.length > 0) {
      const staying = new Set(wanted);
      if ([...this.list.children].some((c) => !staying.has(c as HTMLElement))) scrolled = this.el.scrollTop;
    }
    wanted.forEach((node, i) => {
      if (this.list.children[i] !== node) this.list.insertBefore(node, this.list.children[i] ?? null);
    });
    while (this.list.children.length > wanted.length) this.list.lastElementChild!.remove();
    if (typing && selection && document.activeElement !== typing && typing.isConnected) {
      typing.focus({ preventScroll: true });
      typing.setSelectionRange(selection[0], selection[1]);
    }
    if (restingOn && document.activeElement !== restingOn && restingOn.isConnected) {
      restingOn.tabIndex = -1;
      restingOn.focus({ preventScroll: true });
    }

    const open = this.openCount;
    const resolved = this.resolvedCount;
    this.empty.hidden = open > 0 || !!this.draft || notes.length > 0 || (this.showResolved && resolved > 0);
    this.empty.textContent = this.emptyWords(resolved);
    this.helpLink.hidden = this.empty.hidden;
    this.resolvedRow.hidden = resolved === 0;
    this.resolvedLabel.textContent = `${resolved} resolved`;
    this.showResolvedButton.textContent = this.showResolved ? "Hide" : "Show";
    this.showResolvedButton.setAttribute("aria-label", this.showResolved ? "Hide resolved comments" : "Show resolved comments");
    this.showResolvedButton.setAttribute("aria-pressed", String(this.showResolved));
    this.drawHandBack();
    this.el.hidden = !this.panelShown;
    this.handle.hidden = this.el.hidden;
    // A card's menu goes with its button (the card was drawn again, or went).
    if (this.messageMenu?.isOpen && !this.menuFor?.opener.checkVisibility()) this.messageMenu.close();
    if (scrolled !== null) this.keepPlace(scrolled);
    this.updateActive(false);
    this.updateDots();
    this.host.changed();
    this.onRender?.();
    afterDraw?.(this);
  }

  /**
   * A card went away (resolved, say) near the end of the list: the panel
   * would scroll back by its height, pulling the cards above it down. Keep
   * room under the cards instead, so nothing above moves; it goes as the
   * person scrolls up into it.
   */
  private keepPlace(scrolled: number): void {
    if (this.el.hidden || scrolled <= 0 || this.el.scrollTop >= scrolled) return;
    const short = scrolled - (this.el.scrollHeight - this.el.clientHeight);
    if (short <= 0) return;
    this.slack.style.height = `${(parseFloat(this.slack.style.height) || 0) + short}px`;
    this.el.scrollTop = scrolled;
  }

  private trimSlack(): void {
    const kept = parseFloat(this.slack.style.height) || 0;
    if (!kept) return;
    // Only as much as keeps the bottom of what's in sight where it is.
    const needed = Math.max(0, Math.ceil(this.el.scrollTop + this.el.clientHeight - (this.el.scrollHeight - kept)));
    if (needed < kept) this.slack.style.height = needed ? `${needed}px` : "";
  }

  /** Which card is in focus. One coming into focus has been read; `redraw` draws its dot and the count again (render does that itself). */
  private updateActive(redraw = true): void {
    const state = this.host.view().state;
    const active = commentRanges(state).active;
    const marks = changeMarks(state);
    for (const [id, card] of this.cards) {
      card.el.classList.toggle("active", id === active);
      this.updateChangeRow(card.el, id, marks.selected === id && marks.before);
    }
    for (const [id, card] of this.noteCards) card.classList.toggle("active", marks.selected === id);
    const inFocus = marks.selected ?? active;
    if (inFocus === this.inFocus) return;
    this.inFocus = inFocus;
    if (inFocus && this.markSeen(inFocus) && redraw) {
      this.updateDots();
      this.host.changed();
    }
  }

  // What's new for the person (roadmap Batch 1, item 2) ---------------------------------

  /** What's on a comment's card for the person, if anything: a mark that changes as an agent adds to it, and that agent. */
  private threadNews(t: Thread): { mark: string; agent: string } | null {
    if (!waitingForPerson(t)) return null;
    let reply: Message | undefined;
    for (let i = t.messages.length - 1; i >= 0 && !reply; i--) if (t.messages[i].author.kind === "agent") reply = t.messages[i];
    const last = t.messages[t.messages.length - 1];
    const agent = last?.author.kind === "agent" ? last.author.name : (t.change?.agent ?? "");
    return { mark: `${reply?.id ?? ""} ${t.change?.at ?? ""}`, agent };
  }

  /** A note is news until it has been in focus. */
  private noteNews(n: PassNote): { mark: string; agent: string } {
    return { mark: n.id, agent: n.agent };
  }

  private news(id: string): { mark: string; agent: string } | null {
    const n = this.noteOf(id);
    if (n) return this.noteNews(n);
    const t = this.threads.find((x) => x.id === id);
    return t ? this.threadNews(t) : null;
  }

  /** The item's card has been in focus: what's on it now has been read. Whether that took a dot away. */
  private markSeen(id: string): boolean {
    const news = this.news(id);
    if (!news || this.seen.get(id) === news.mark) return false;
    this.seen.set(id, news.mark);
    return true;
  }

  /** The person read an item's card (clicked it, or Next Comment showed it), even one already in focus. */
  read(id: string): void {
    if (!this.markSeen(id)) return;
    this.updateDots();
    this.host.changed();
  }

  /** Each card's dot, in the colour of the agent its news is from, and how many there are. */
  private updateDots(): void {
    let count = 0;
    const live = new Set<string>();
    const draw = (card: HTMLElement | undefined, id: string, news: { mark: string; agent: string } | null) => {
      live.add(id);
      const fresh = !!news && this.seen.get(id) !== news.mark;
      if (fresh) count++;
      if (!card) return;
      const dot = card.querySelector<HTMLElement>(":scope > .card-new");
      if (dot) {
        dot.hidden = !fresh;
        if (fresh) {
          const colour = news.agent ? this.colourOf(news.agent) : "";
          dot.style.background = colour ? `var(--agent-${colour})` : "";
          if (colour) dot.dataset.colour = colour;
          else delete dot.dataset.colour;
        }
      }
      const label = card.getAttribute("aria-label") ?? "";
      const plain = label.endsWith(", new") ? label.slice(0, -5) : label;
      const wanted = fresh ? `${plain}, new` : plain;
      if (wanted !== label) card.setAttribute("aria-label", wanted);
    };
    for (const t of this.threads) {
      if (t.status === "open") draw(this.cards.get(t.id)?.el, t.id, this.threadNews(t));
      else live.add(t.id); // what was read on it stays read if it's reopened
    }
    for (const n of this.notes) draw(this.noteCards.get(n.id), n.id, this.noteNews(n));
    for (const id of this.seen.keys()) if (!live.has(id)) this.seen.delete(id);
    this.unread = count;
  }

  /** How many cards have something new (as of the panel's last drawing). */
  get unreadCount(): number {
    return this.unread;
  }

  /** The cards with something new, top to bottom as the panel lists them. */
  unreadItems(): string[] {
    return this.cardOrder().filter((id) => {
      const news = this.news(id);
      return !!news && this.seen.get(id) !== news.mark;
    });
  }

  // A message at the top, and letting go --------------------------------------------------

  /** A short message at the top of the panel, for a few seconds. */
  tell(text: string): void {
    this.say(text);
  }

  destroy(): void {
    openPanels.delete(this);
    forgetResolvedIn(this);
    this.saveAnchorsNow();
    if (this.anchorTimer) clearTimeout(this.anchorTimer);
    if (this.noteTimer) clearTimeout(this.noteTimer);
    clearInterval(this.timeTimer);
    this.cuts.clear();
    this.messageMenu?.close();
    this.messageMenu?.el.remove();
    document.removeEventListener("mousedown", this.onDocMouseDown, true);
    document.removeEventListener("focusin", this.onDocFocus);
    for (const type of CARD_EDITS) document.removeEventListener(type, this.onCardEdit, true);
  }
}
