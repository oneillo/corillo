// The comment cards in the panel: each card built and filled in, its messages, an agent's options and choosing one, the "⋯" menu, and the edit form.
import type { Node as DocNode } from "prosemirror-model";
import { redo, undo } from "prosemirror-history";
import { anchorIn, textIndex } from "../core/anchors";
import { waitingForPerson, type Message, type PassNote, type Thread } from "../core/comments";
import { commentRanges, withRanges, type Range } from "./comments";
import type { AgentColour } from "../core/agents";
import { changedPieces, plainText, type ChangeSpan } from "../core/change-links";
import { choicesOf, optionsOf, placesAfterChoice, planChoice, type Choice } from "../core/options";
import type { NotNow } from "./editable";
import { changeMarks, present, type MarkedSpan } from "./change-marks";
import { ICONS } from "./icons";
import { PopupMenu } from "./popup-menu";
import { justDone, undoWhereKeyboardIs } from "./undo-resolve";
import { agentFor, authorName, cardName, fullTime, recipientLabel, relativeTime, turnLabel, type AgentInfo } from "./comment-format";
import { mentionField, messageBody, type MentionSource } from "./mentions";
import type { CommentsHost } from "./comments-panel";
import { PICTURE_STAND_IN } from "../core/doc-diff";

export interface Card {
  el: HTMLElement;
  main: HTMLElement;
  reply: HTMLFormElement;
  replyInput: HTMLTextAreaElement;
  error: HTMLElement;
  key: string;
  editing: { messageId: string; text: string } | null;
  /** Its reply box was opened from the card with the keyboard: posting it, or Escape, puts the keyboard back on the card. */
  fromCard: boolean;
}

/** The dot on a card with something new for the person, in the colour of the agent it's from. Hidden until needed. */
function newDot(): HTMLElement {
  const dot = el("span", "card-new");
  dot.setAttribute("aria-hidden", "true");
  dot.hidden = true;
  return dot;
}

/** A click on a card's "Show what it said before". */
const onBeforeToggle = (e: Event) => e.target instanceof Element && !!e.target.closest(".comment-before-toggle");

/**
 * A card's first row: its label (the quoted words, "Whole document", "Note
 * from Claude"), then in the top right corner the first comment's "⋯" and
 * Resolve (Done, Reopen) as a small square tick. Orlando (2026-11-12, roadmap
 * Batch 9, item 2): "a small square button with just a check alongside the
 * ellipses menu in the top right of the comment card. That way, the content
 * has more space." The tick is always in the very corner, so it's in the same
 * place on every card, with or without a "⋯".
 */
function headRow(label: HTMLElement, ...corner: (HTMLElement | null)[]): HTMLElement {
  const head = el("div", "comment-head");
  const buttons = el("div", "comment-corner");
  for (const b of corner) if (b) buttons.append(b);
  head.append(label, buttons);
  return head;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

/** Quoted words on one run of lines: the line breaks and runs of spaces in them as single spaces. */
function flatQuote(quote: string): string {
  return quote.replace(/\s+/g, " ").trim();
}

/**
 * Which of a comment's messages its change goes under (roadmap Batch 11, F-8): an
 * option the person chose, under the agent's reply that offered it; an agent's
 * change, under the last message before the first one the person wrote after it,
 * so a reply written since doesn't read as already acted on. -1 for none.
 */
function changeGoesAfter(thread: Thread, change: { round: number; at?: string }, chosenOn: string | undefined): number {
  if (change.round < 0) return thread.messages.findIndex((m) => m.id === chosenOn);
  const made = change.at ? Date.parse(change.at) : NaN;
  if (Number.isNaN(made)) return thread.messages.length - 1;
  const since = thread.messages.findIndex((m) => m.author.kind === "person" && Date.parse(m.created) > made);
  return (since < 0 ? thread.messages.length : since) - 1;
}

export function textButton(label: string, className: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = el("button", className, label);
  b.type = "button";
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick(e);
  });
  return b;
}

const PERSON_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><circle cx="8" cy="5.2" r="2.9"/><path d="M2.6 14.2c.5-3 2.7-4.7 5.4-4.7s4.9 1.7 5.4 4.7z"/></svg>';
const CHECK_ICON = ICONS.check;

/** Why a document can't be changed now by a click in its panel (editable.ts's answer, from app.ts). */
let notNow: (docId: string) => NotNow = () => null;

/** How the panels ask whether a document can be changed now (an agent's option, roadmap Batch 3 item 2). */
export function setChangeCheck(check: (docId: string) => NotNow): void {
  notNow = check;
}

/** The cards of a document's Comments panel. DocComments (comments-panel.ts) builds on this class and gives it what is declared abstract here. */
export abstract class CommentCards {
  protected cards = new Map<string, Card>();
  /**
   * Words typed in a card's reply or edit box and not sent, kept by comment
   * while its card is away (resolved and hidden), so Undo or Reopen brings
   * them back. Only the words: never the card.
   */
  protected unsent = new Map<string, { reply: string; editing: Card["editing"] }>();
  /** Edit and Delete for one of the person's messages, from its More actions button. Made when first needed. */
  protected messageMenu: PopupMenu | null = null;
  /** The message the menu is open for, its button, and where the panel was scrolled when it opened. */
  protected menuFor: { threadId: string; messageId: string; opener: HTMLButtonElement; keyboard: boolean; scrollTop: number } | null = null;
  protected noteCards = new Map<string, HTMLElement>();
  /** The Resolve tick was pressed from the keyboard (see resolve in comments-panel.ts). */
  protected tickByKeys = false;

  // What the panel (DocComments, comments-panel.ts) gives the cards -------------------
  protected abstract host: CommentsHost;
  abstract readonly el: HTMLElement;
  protected abstract threads: Thread[];
  protected abstract notes: PassNote[];
  protected abstract agents: AgentInfo[];
  protected abstract readonly mentions: MentionSource;
  protected abstract standingChoices: Map<string, { messageId: string; choice: Choice }>;
  protected abstract choicePlaces: { doc: DocNode; ranges: ReadonlyMap<string, Range> }[];
  protected abstract act(card: Card | null, action: () => Promise<{ ok: true } | { ok: false; error: string }>): Promise<boolean>;
  protected abstract acted(): void;
  protected abstract render(): void;
  protected abstract say(text: string): void;
  protected abstract setActive(id: string | null): void;
  protected abstract colourOf(name: string): AgentColour;
  protected abstract changeSpans(owner: string): MarkedSpan[];
  protected abstract shownChange(t: Thread): { round: number; agent: string; at?: string; spans: ChangeSpan[] } | undefined;
  protected abstract holdCard(card: HTMLElement | undefined, change: () => void): void;
  protected abstract revealCard(id: string): void;
  protected abstract revealText(id: string): void;
  protected abstract resolve(card: Card | null, id: string): Promise<boolean>;
  protected abstract leaveReply(card: Card): void;
  protected abstract cursorToDocument(): void;
  abstract get keyboardOnCard(): boolean;
  abstract keyboardTo(id: string): void;
  abstract focusItem(id: string): void;
  abstract resolveItem(id: string): Promise<boolean>;
  abstract read(id: string): void;
  abstract toggleBefore(on?: boolean): void;
  abstract saveAnchorsNow(): void;
  abstract cardOrder(): string[];
  abstract cardAfter(id: string): string | null;

  /** A card's line about its change: found or not, and the toggle for what it said before. */
  protected updateChangeRow(card: HTMLElement, owner: string, before: boolean): void {
    const row = card.querySelector<HTMLElement>(":scope .comment-change");
    if (!row) return;
    const gap = changeMarks(this.host.view().state).gaps.get(owner);
    // Where the comment's words were deleted, the empty line stands for them.
    const found = present(this.changeSpans(owner)).filter((s) => !(gap && s.point));
    const toggle = row.querySelector<HTMLButtonElement>(".comment-before-toggle")!;
    const note = row.querySelector<HTMLElement>(".comment-change-note")!;
    const anyBefore = !!gap?.text.trim() || found.some((s) => s.removed.replaceAll(PICTURE_STAND_IN, "").trim());
    toggle.hidden = !(found.length || gap) || !anyBefore;
    toggle.textContent = before ? "Hide what it said before" : "Show what it said before";
    toggle.setAttribute("aria-pressed", String(before));
    // An option the person chose and still has in the text: what they did, not "You changed" (roadmap Batch 11, F-15).
    const chosen = row.dataset.chosen === "true";
    const agent = chosen ? "" : row.dataset.agent || "";
    note.textContent =
      chosen && found.length
        ? "What you chose is highlighted."
        : gap
          ? found.length
            ? `${agent || "The agent"} deleted its text and changed the highlighted text.`
            : agent
              ? `${agent} deleted the text it was on.`
              : "The text it was on was deleted."
          : !found.length
            ? "The text it changed is no longer in the document."
            : found.length === 1
              ? `${agent || "The agent"} changed the highlighted text.`
              : `${agent || "The agent"} changed the ${found.length} highlighted places.`;
  }

  /** The change row for a card: filled in by updateChangeRow. `chosen`: the change is an option the person chose. */
  private changeRow(owner: string, agent: string, chosen = false): HTMLElement {
    const row = el("div", "comment-change");
    row.dataset.agent = agent;
    if (chosen) row.dataset.chosen = "true";
    const swatch = el("span", "comment-change-swatch");
    swatch.setAttribute("aria-hidden", "true");
    const note = el("span", "comment-change-note");
    const toggle = textButton("Show what it said before", "link-button comment-before-toggle", () => {
      const marks = changeMarks(this.host.view().state);
      if (marks.selected !== owner) this.setActive(owner);
      this.toggleBefore();
    });
    toggle.setAttribute("aria-pressed", "false");
    row.append(swatch, note, toggle);
    return row;
  }

  /** A card for each agent's note, newest first. */
  protected noteCardsFor(): HTMLElement[] {
    const keep = new Set(this.notes.map((n) => n.id));
    for (const id of [...this.noteCards.keys()]) if (!keep.has(id)) this.noteCards.delete(id);
    return [...this.notes].reverse().map((n) => this.noteCard(n));
  }

  /** "Note from Claude", the note, and Done: the person has read it, and the card goes (History keeps it). */
  private noteCard(n: PassNote): HTMLElement {
    const made = this.noteCards.get(n.id);
    if (made) return made;
    const card = el("article", "comment-card pass-note");
    card.dataset.threadId = n.id;
    card.setAttribute("aria-label", `Note from ${n.agent}`);
    const id = n.id;
    card.addEventListener("click", () => this.focusItem(id));
    const done = this.closeButton("Done", "pass-note-done", "Mark this note as done: the card goes, and History keeps it", () => void this.resolveItem(id));
    const text = el("p", "pass-note-text", n.text);
    text.title = n.text;
    card.append(headRow(el("div", "comment-whole", `Note from ${n.agent}`), done), text, newDot());
    this.noteCards.set(n.id, card);
    return card;
  }

  protected refreshTimes(): void {
    for (const t of this.el.querySelectorAll<HTMLTimeElement>("time.comment-time")) {
      const label = relativeTime(t.dateTime);
      if (t.textContent !== label) t.textContent = label; // nothing to lay out again when it reads the same
    }
  }

  protected cardFor(thread: Thread, found: boolean, gapped = false): Card {
    let card = this.cards.get(thread.id);
    if (!card) {
      card = this.buildCard(thread.id);
      this.cards.set(thread.id, card);
      this.restoreUnsent(card, thread);
    }
    const colours = thread.messages.map((m) => (m.author.kind === "agent" ? this.colourOf(m.author.name) : ""));
    const yours = waitingForPerson(thread);
    const key = JSON.stringify([
      this.awayFor(thread),
      yours,
      turnLabel(thread, this.agents, yours), // whom it waits for follows agents coming and going
      thread.change ? [thread.change.round, thread.change.agent, thread.change.spans.length] : null,
      this.standingChoices.get(thread.id) ?? null,
      thread.status,
      thread.to,
      thread.anchor?.quote ?? null,
      found,
      gapped,
      thread.messages,
      colours,
      card.editing?.messageId ?? null,
    ]);
    if (key !== card.key) {
      card.key = key;
      this.fillCard(card, thread, found, gapped);
    }
    return card;
  }

  /** A card goes while its comment stays (resolved and hidden): keep what was typed in it and not sent. */
  protected keepUnsent(id: string, card: Card): void {
    const reply = card.replyInput.value;
    if (!this.threads.some((t) => t.id === id) || (!reply.trim() && !card.editing)) return;
    this.unsent.set(id, { reply: reply.trim() ? reply : "", editing: card.editing });
  }

  /** A comment's card is back (Undo after Resolve, Reopen): so are the words typed in it and not sent. */
  private restoreUnsent(card: Card, thread: Thread): void {
    const kept = this.unsent.get(thread.id);
    if (!kept) return;
    this.unsent.delete(thread.id);
    const editing = kept.editing;
    if (editing && thread.messages.some((m) => m.id === editing.messageId)) card.editing = editing;
    if (!kept.reply) return;
    card.replyInput.value = kept.reply;
    card.reply.classList.add("writing");
    card.replyInput.dispatchEvent(new Event("input")); // Reply can be pressed, and its tags are drawn
  }

  private buildCard(threadId: string): Card {
    const root = el("article", "comment-card");
    root.dataset.threadId = threadId;
    root.setAttribute("aria-label", "Comment");
    const main = el("div", "comment-main");
    const error = el("p", "comment-error");
    error.hidden = true;
    const reply = el("form", "comment-reply");
    const replyInput = el("textarea", "comment-input");
    replyInput.rows = 1;
    replyInput.placeholder = "Reply";
    replyInput.setAttribute("aria-label", "Reply");
    const replyActions = el("div", "comment-actions-row comment-reply-actions");
    const cancel = textButton("Cancel", "comment-button", () => {
      replyInput.value = "";
      reply.classList.remove("writing");
      this.leaveReply(card);
    });
    const send = el("button", "comment-button primary-small", "Reply");
    send.type = "submit";
    send.title = "Reply (⌘↩)";
    send.disabled = true;
    replyActions.append(el("span", "comment-spacer"), cancel, send);
    // Naming an agent with @ in a reply hands the comment to it.
    const replyField = mentionField(replyInput, this.mentions, {
      kind: "reply",
      current: () => {
        const t = this.threads.find((x) => x.id === threadId);
        return t ? agentFor(t, this.agents) : null;
      },
    });
    reply.append(replyField.el, replyActions);
    root.append(main, error, reply, newDot());
    const card: Card = { el: root, main, reply, replyInput, error, key: "", editing: null, fromCard: false };

    let sending = false; // a second ⌘↩ before Corillo answers doesn't send it again
    const submit = async () => {
      const body = replyInput.value.trim();
      if (!body || sending) return;
      sending = true;
      send.disabled = true;
      let ok = false;
      try {
        ok = await this.act(card, () => this.host.api.replyToComment(this.host.id, threadId, body, replyField.mention()));
      } finally {
        sending = false;
      }
      if (ok) {
        replyInput.value = "";
        reply.classList.remove("writing");
        this.leaveReply(card);
      } else send.disabled = false;
    };
    reply.addEventListener("submit", (e) => {
      e.preventDefault();
      void submit();
    });
    // Clicked into: done with, it goes back to the document, as it always has. Reached
    // with the keyboard from elsewhere in the panel (Tab from the card): back to the card.
    let clicked = false;
    replyInput.addEventListener("mousedown", () => {
      clicked = true;
      card.fromCard = false;
    });
    replyInput.addEventListener("focus", (e) => {
      reply.classList.add("writing");
      if (!clicked && e.relatedTarget instanceof Node && this.el.contains(e.relatedTarget)) card.fromCard = true;
      clicked = false;
    });
    // Its Cancel and Reply stay while the keyboard is on them (Tab from an empty box goes to Cancel, which used to
    // hide under it: roadmap Batch 12, G-8); they go once the keyboard leaves the box and its buttons.
    reply.addEventListener("focusout", (e) => {
      if (e.target === replyInput) clicked = false;
      if (e.relatedTarget instanceof Node && reply.contains(e.relatedTarget)) return;
      reply.classList.toggle("writing", !!replyInput.value.trim());
    });
    replyInput.addEventListener("input", () => {
      send.disabled = !replyInput.value.trim();
    });
    replyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.leaveReply(card);
      }
    });
    // Clicking anywhere on a comment puts it in focus and brings its words
    // into sight (the top of the document, for one with no words in it). The
    // keyboard stays where the click put it: a box, a button.
    root.addEventListener("click", (e) => {
      this.host.settle();
      this.read(threadId); // read, even if it was already in focus
      // The card clicked stays under the pointer as the one that was in focus goes compact,
      // then comes into sight as it opens up (its reply box), as Next Comment shows it.
      this.holdCard(root, () => this.setActive(threadId));
      this.revealCard(threadId);
      // What it said before brings its own place into sight (revealBefore), not the comment's words.
      if (!onBeforeToggle(e)) this.revealText(threadId);
    });
    return card;
  }

  /** A comment's label: its quoted text, or "Whole document". */
  protected placeLabel(quote: string | null): HTMLElement {
    if (quote === null) return el("div", "comment-whole", "Whole document");
    // All of it: cut to two lines unless the card is in focus or being written in (style.css).
    const q = el("blockquote", "comment-quote", flatQuote(quote));
    q.title = quote;
    return q;
  }

  /**
   * Resolve on a comment, Done on a note, Reopen on a
   * resolved comment: a small square with only a tick, in the top right
   * corner of every card (headRow), in the same place and look. Its tooltip
   * and its name for a screen reader say what it does. Reopen's tick is
   * filled in: the comment is done, and pressing it opens it again.
   */
  private closeButton(label: string, className: string, title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
    const b = textButton("", `comment-close ${className}`, onClick);
    b.innerHTML = CHECK_ICON;
    b.setAttribute("aria-label", label);
    b.title = title;
    return b;
  }

  /**
   * The agent an open comment waits for, when that agent isn't on the
   * document: a comment for a particular agent waits for it, like one for a
   * colleague who's away. A screen reader hears it's waiting for it; the card
   * shows no status line (roadmap Batch 9, item 3).
   */
  private awayFor(thread: Thread): string | null {
    if (thread.status === "resolved" || !thread.to || thread.to === "person") return null;
    if (thread.messages[thread.messages.length - 1]?.author.kind !== "person") return null;
    const to = thread.to;
    return this.agents.some((a) => a.name === to) ? null : to;
  }

  private fillCard(card: Card, thread: Thread, found: boolean, gapped = false): void {
    const resolved = thread.status === "resolved";
    const detached = !!thread.anchor && !found && !gapped;
    card.el.classList.toggle("resolved", resolved);
    card.el.classList.toggle("detached", detached);
    card.el.classList.toggle("gapped", gapped);
    let close: HTMLButtonElement;
    if (resolved) {
      close = this.closeButton("Reopen", "comment-reopen", "Open this comment again", () =>
        void this.act(card, () => this.host.api.resolveComment(this.host.id, thread.id, false)),
      );
    } else {
      // Orlando (2026-11-09): "Each comment needs an option to resolve it." On every open card.
      close = this.closeButton("Resolve", "comment-resolve", "Resolve this comment: it's done, and its card is hidden (⌥⌘↩)", (e) => {
        this.tickByKeys = e.detail === 0; // Return or Space on it, not a click
        void this.resolve(card, thread.id);
      });
    }
    // The first comment's "⋯" sits in the corner beside it; each reply keeps its own on its name line.
    const first = thread.messages[0];
    const firstMore = first && this.canEdit(thread, first) && card.editing?.messageId !== first.id ? this.moreButton(thread.id, first.id) : null;
    const parts: HTMLElement[] = [headRow(this.placeLabel(thread.anchor ? thread.anchor.quote : null), firstMore, close)];
    // No status line (Orlando, 2026-11-12, roadmap Batch 9, item 3: "I'd rather just have the
    // comments"): whose turn it is, and whom it waits for, are said only to a screen reader.
    // What went wrong is still said: its words can't be found.
    if (detached) parts.push(el("p", "comment-note", "The text this comment was on has changed."));
    const shown = this.shownChange(thread);
    if (gapped && !shown?.spans.length) parts.push(this.changeRow(thread.id, ""));
    const messages = el("ol", "comment-messages");
    const items = thread.messages.map((m, i) => this.messageItem(card, thread, m, i));
    messages.append(...items);
    parts.push(messages);
    const away = this.awayFor(thread);
    const turn = away ? `Waiting for ${away}` : turnLabel(thread, this.agents, waitingForPerson(thread));
    card.el.setAttribute("aria-label", cardName(thread, turn));
    if (shown?.spans.length && !resolved) {
      // With the reply it belongs to, not under the person's newer one (roadmap Batch 11, F-8).
      const row = this.changeRow(thread.id, shown.agent, shown.round < 0);
      const at = changeGoesAfter(thread, shown, this.standingChoices.get(thread.id)?.messageId);
      if (items[at]) items[at].append(row);
      else parts.push(row);
    }

    // Keep the cursor in a box being typed in when the card is redrawn, and
    // the keyboard on a button it was on (a message's "⋯", Resolve), if the
    // card still has that button.
    const focused = document.activeElement;
    const editing = focused instanceof HTMLTextAreaElement && card.main.contains(focused);
    const selection = editing ? [focused.selectionStart, focused.selectionEnd] : null;
    const buttonKey = (b: HTMLButtonElement) => `${b.dataset.for ?? b.closest("[data-message-id]")?.getAttribute("data-message-id") ?? ""} ${b.className}`;
    const onButton = focused instanceof HTMLButtonElement && card.main.contains(focused) ? buttonKey(focused) : null;
    card.main.replaceChildren(...parts);
    card.reply.hidden = resolved;
    if (card.editing) {
      const box = card.main.querySelector<HTMLTextAreaElement>("textarea");
      if (box && editing && selection) {
        box.focus({ preventScroll: true });
        box.setSelectionRange(selection[0], selection[1]);
      }
    }
    if (onButton) [...card.main.querySelectorAll("button")].find((b) => buttonKey(b) === onButton)?.focus({ preventScroll: true });
  }

  private messageItem(card: Card, thread: Thread, m: Message, index: number): HTMLElement {
    const li = el("li", "comment-message");
    li.dataset.messageId = m.id;
    const byline = el("div", "comment-byline");
    const avatar = el("span", "comment-avatar");
    if (m.author.kind === "person") {
      avatar.classList.add("person");
      avatar.innerHTML = PERSON_ICON;
    } else {
      const colour = this.colourOf(m.author.name);
      avatar.dataset.colour = colour;
      avatar.style.background = `var(--agent-${colour})`;
      avatar.textContent = (m.author.name || "A").slice(0, 1).toUpperCase();
    }
    avatar.setAttribute("aria-hidden", "true");
    const author = el("span", "comment-author", authorName(m.author));
    if (m.author.kind === "agent") author.title = authorName(m.author); // a long name is cut short
    byline.append(avatar, author);
    const to = recipientLabel(thread, index);
    if (to) {
      const recipient = el("span", "comment-recipient", to);
      recipient.title = to;
      byline.append(recipient);
    }
    const time = el("time", "comment-time", relativeTime(m.created));
    time.dateTime = m.created;
    time.title = fullTime(m.created);
    byline.append(time);
    li.append(byline);

    // A resolved comment can't be edited: words typed in its edit box are kept for Reopen or Undo, as a reply's are.
    if (card.editing?.messageId === m.id && this.canEdit(thread, m)) {
      li.append(this.editForm(card, thread, m));
      return li;
    }
    li.append(messageBody(m, (name) => this.colourOf(name)));
    if (m.edited) li.append(el("span", "comment-edited", "Edited"));
    const options = this.optionsRow(thread, m);
    if (options) li.append(options);
    // Edit and Delete are in a short menu, from a "⋯" at the end of a reply's name line (Orlando,
    // 2026-11-09: as words under each message they were easy to miss and added to the text).
    // The first comment's is in the card's corner, beside Resolve (fillCard).
    if (index > 0 && this.canEdit(thread, m)) byline.append(this.moreButton(thread.id, m.id));
    return li;
  }

  /** Only the person's own messages, on an open comment, can be edited or deleted. */
  private canEdit(thread: Thread, m: Message): boolean {
    return m.author.kind === "person" && thread.status !== "resolved";
  }

  /**
   * The options an agent offered with its reply (roadmap Batch 3, item 2):
   * what the person chose, and while the comment is open a button for each
   * other option, which puts it in the text as the person's own edit.
   */
  private optionsRow(thread: Thread, m: Message): HTMLElement | null {
    const options = optionsOf(m);
    if (!options.length) return null;
    // Said only while it's in the text: after Undo, every option is offered again (B3-R04).
    const now = this.standingChoices.get(thread.id);
    const chosen = now?.messageId === m.id && options[now.choice.option] ? now.choice.option : null;
    const row = el("div", "comment-options");
    if (chosen !== null) row.append(el("p", "comment-option-chosen", `You chose: ${options[chosen].label}`));
    const open = options.map((o, i) => ({ o, i })).filter(({ i }) => i !== chosen);
    if (thread.status === "open" && open.length) {
      const buttons = el("div", "comment-option-buttons");
      buttons.setAttribute("role", "group");
      buttons.setAttribute("aria-label", chosen === null ? `${authorName(m.author)}'s options` : "The other options");
      const why = el("p", "comment-option-why");
      why.hidden = true;
      why.setAttribute("aria-live", "polite");
      for (const { o, i } of open) {
        const b = textButton(o.label, "comment-option", (e) => void this.choose(thread.id, m.id, i, b, why, e.detail === 0));
        b.title = "Put this version in the text. Undo takes it back.";
        buttons.append(b);
      }
      row.append(buttons, why);
    }
    return row.childElementCount ? row : null;
  }

  /**
   * The person clicked an option: it goes in the text as they'd type it, if
   * the document can be changed now and the option still fits the text as it
   * is; the comment records the choice and lights up the text it changed.
   * Otherwise nothing changes, and the card says why.
   */
  private async choose(threadId: string, messageId: string, index: number, button: HTMLButtonElement, why: HTMLElement, keyboard = false): Promise<void> {
    const thread = this.threads.find((t) => t.id === threadId);
    const message = thread?.messages.find((x) => x.id === messageId);
    const options = message ? optionsOf(message) : [];
    const option = options[index];
    if (!thread || !message || !option || thread.status !== "open") return;
    // A click on the card's option is a click on the card: what's on it has been read (B3-R06).
    this.read(threadId);
    const say = (text: string) => {
      why.textContent = text;
      why.hidden = false;
    };
    const blocked = notNow(this.host.id);
    if (blocked) {
      const editing = this.agents.find((a) => a.editing)?.name ?? "An agent";
      return say(
        blocked === "agent"
          ? `${editing} is editing this document. Choose once it's back with you. Nothing was changed.`
          : "Go back to the current version first: an earlier one is showing. Nothing was changed.",
      );
    }
    this.host.settle();
    // Another option chosen here that's still in the text is taken out first (B3-R03).
    const plan = planChoice(this.host.text(), options, choicesOf(message), index);
    if (!plan.ok) {
      if (plan.why === "in the text") return;
      button.textContent = `${option.label}: no longer fits`;
      button.classList.add("stale");
      return say(`“${option.label}” no longer fits: the words it changes have been edited since. Nothing was changed.`);
    }
    const view = this.host.view();
    const was = { doc: view.state.doc, index: textIndex(view.state.doc), ...commentRanges(view.state) };
    if (!this.host.applyText(plan.texts)) return say("Corillo couldn't put this version in the text as it is. Nothing was changed.");
    // Where the text changed first: brought into sight once chosen, since the card says it's highlighted (Batch 24, W-9).
    const changedAt = was.doc.content.findDiffStart(view.state.doc.content);
    // Comments on words it rewrote end on the words that took their place, as after an agent's edit (roadmap Batch 6).
    const moved = [...placesAfterChoice(was.index, textIndex(view.state.doc), was.ranges, commentRanges(view.state).ranges)];
    if (moved.length) view.dispatch(withRanges(view.state.tr, ...moved.map(([id, range]) => ({ type: "add" as const, id, range, shown: was.shown.has(id) }))));
    // Undo and Redo of it put them back where they were before and after.
    this.choicePlaces = [...this.choicePlaces, { doc: was.doc, ranges: was.ranges }, { doc: view.state.doc, ranges: commentRanges(view.state).ranges }].slice(-6);
    // The text it changed, as the person reads it, lit up on the comment as theirs.
    const before = plainText(plan.before, this.host.id);
    const after = plainText(plan.after, this.host.id);
    const spans = changedPieces(before, after).map((p) => ({ anchor: anchorIn(after, p.start, p.end), removed: p.removed }));
    if (await this.act(this.cards.get(threadId) ?? null, () => this.host.api.chooseOption(this.host.id, threadId, messageId, index, spans, plan.undo))) {
      this.setActive(threadId);
      if (changedAt !== null && changedAt <= view.state.doc.content.size) this.host.reveal(changedAt);
      if (keyboard) this.restAfterChoice(threadId);
    }
  }

  /**
   * An option chosen with the keyboard (Return or Space on it): the keyboard
   * rests on its card, not on the option left beside it, so Escape goes to
   * the page and Undo straight after takes the choice back, as it would in
   * the page (roadmap Batch 12, G-7). The choice is the person's own edit:
   * the page's Undo is what takes it back, and the keyboard stays on the card.
   */
  private restAfterChoice(threadId: string): void {
    this.keyboardTo(threadId);
    justDone({
      owner: this,
      undo: () => {
        this.host.focusDocument();
        undoWhereKeyboardIs(true, this, (back) => {
          const view = this.host.view();
          if (!view.hasFocus()) return false;
          (back ? undo : redo)(view.state, view.dispatch);
          return true;
        });
        this.keyboardTo(threadId);
      },
      changed: () => this.host.changed(),
    });
  }

  /** The "⋯" for one of the person's messages, in the card's corner or at the end of a reply's name line: Edit and Delete. */
  private moreButton(threadId: string, messageId: string): HTMLButtonElement {
    const b = el("button", "comment-more");
    b.type = "button";
    b.dataset.for = messageId;
    b.innerHTML = ICONS.more;
    b.setAttribute("aria-label", "More actions");
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-expanded", "false");
    b.title = "Edit or delete";
    b.addEventListener("mousedown", (e) => e.preventDefault()); // the keyboard stays where it is
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.messageMenu?.isOpen && this.menuFor?.opener === b) this.messageMenu.close();
      else this.openMessageMenu(threadId, messageId, b, { keyboard: e.detail === 0 });
    });
    return b;
  }

  /**
   * Open Edit and Delete for a message. Its card comes into focus first, as a
   * click anywhere on it does, so the menu opens where the button ends up.
   */
  private openMessageMenu(threadId: string, messageId: string, opener: HTMLButtonElement, options: { keyboard: boolean }): void {
    this.host.settle();
    this.setActive(threadId);
    this.revealText(threadId);
    if (!opener.isConnected) return;
    if (!this.messageMenu) {
      this.messageMenu = new PopupMenu(
        "More actions",
        () => {
          const target = this.menuTarget();
          const at = this.menuFor;
          if (!target || !at) return [];
          return [
            { label: "Edit", run: () => this.startEdit(target.card, target.message) },
            { label: "Delete", run: () => void this.deleteMessage(at.threadId, target.message.id, at.keyboard) },
          ];
        },
        () => {
          // Escape: back to the button, if the menu was opened from the keyboard; otherwise the keyboard stays where it was.
          const opened = this.menuFor;
          if (opened?.keyboard && opened.opener.isConnected) opened.opener.focus();
          else if (!document.activeElement || document.activeElement === document.body) this.host.focusDocument();
        },
      );
      this.messageMenu.el.classList.add("menu-small");
    }
    this.menuFor = { threadId, messageId, opener, keyboard: options.keyboard, scrollTop: this.el.scrollTop };
    this.messageMenu.open(opener, options);
  }

  /** The card and message the menu is open for, if they're still there. */
  private menuTarget(): { card: Card; message: Message } | null {
    const at = this.menuFor;
    if (!at) return null;
    const card = this.cards.get(at.threadId);
    const thread = this.threads.find((t) => t.id === at.threadId);
    const message = thread?.status === "open" ? thread.messages.find((m) => m.id === at.messageId) : undefined;
    return card && message?.author.kind === "person" ? { card, message } : null;
  }

  /** Edit one of the person's messages in place, with the cursor at its end. */
  private startEdit(card: Card, m: Message): void {
    card.editing = { messageId: m.id, text: m.body };
    this.render();
    const box = card.main.querySelector<HTMLTextAreaElement>(".comment-edit textarea");
    if (box) {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }
  }

  /**
   * Delete one of the person's messages at once, with no question (Orlando,
   * 2026-11-12, roadmap Batch 9, item 4: "Deleting a comment requires enough
   * intentionality given the friction that we don't need to put a gate on
   * it"). The first takes its comment and the replies with it. Undo straight
   * after brings it back (undo-resolve.ts). From the keyboard (`keyboard`),
   * the keyboard rests on the card when a reply goes, and on the next card
   * when the whole comment does, as after Resolve (roadmap Batch 12, G-2; it
   * went to the document, where words selected earlier came back); with no
   * card left, into the document with nothing selected.
   */
  protected async deleteMessage(threadId: string, messageId: string, keyboard: boolean): Promise<void> {
    const thread = this.threads.find((t) => t.id === threadId);
    const message = thread?.messages.find((m) => m.id === messageId);
    if (!thread || !message || !this.canEdit(thread, message)) return;
    const card = this.cards.get(threadId) ?? null;
    const whole = thread.messages[0].id === messageId;
    // Where the keyboard goes when the whole comment does, as after Resolve (review.ts).
    const after = this.cardAfter(threadId);
    this.saveAnchorsNow(); // where its words are now, so Undo finds them again
    if (!(await this.act(card, () => this.host.api.deleteComment(this.host.id, threadId, messageId)))) return;
    justDone({ owner: this, undo: () => void this.undelete(threadId, messageId), changed: () => this.host.changed() });
    // With the mouse, the keyboard was on the "⋯" that went with the message: back to the document, where it
    // was, so Edit > Undo reaches it as well as Command-Z.
    if (!keyboard) {
      if (!document.activeElement || document.activeElement === document.body) this.host.focusDocument();
      return;
    }
    if (!whole && card?.el.isConnected) this.keyboardTo(threadId);
    else if (after && this.cardOrder().includes(after)) {
      this.focusItem(after);
      this.keyboardTo(after);
    } else this.cursorToDocument();
  }

  /** Undo straight after a delete: the message is back, and its comment in focus and in sight, as after Undo of Resolve. */
  private async undelete(threadId: string, messageId: string): Promise<void> {
    const onCard = this.keyboardOnCard;
    const result = await this.host.api.restoreComment(this.host.id, threadId, messageId);
    if (!result.ok) return this.say(result.error);
    this.acted();
    if (!this.threads.some((t) => t.id === threadId && t.status === "open")) return;
    this.focusItem(threadId);
    if (onCard) this.keyboardTo(threadId);
  }

  /** Put the keyboard on a message's "⋯" (after Cancel or Escape from the keyboard). */
  private focusMore(card: Card, messageId: string): void {
    card.main.querySelector<HTMLButtonElement>(`.comment-more[data-for="${CSS.escape(messageId)}"]`)?.focus();
  }

  private editForm(card: Card, thread: Thread, m: Message): HTMLElement {
    const form = el("div", "comment-edit");
    const box = el("textarea", "comment-input");
    box.value = card.editing?.text ?? m.body;
    box.setAttribute("aria-label", "Edit comment");
    const field = mentionField(box, this.mentions, { kind: "edit" });
    const save = textButton("Save", "comment-button primary-small", () => void finish());
    // Stop editing; from the keyboard, back to the message's "⋯".
    const stop = (keyboard: boolean) => {
      card.editing = null;
      this.render();
      if (keyboard) this.focusMore(card, m.id);
    };
    const cancel = el("button", "comment-button", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", (e) => {
      e.stopPropagation();
      stop(e.detail === 0);
    });
    let saving = false; // a second ⌘↩ before Corillo answers doesn't save it again
    const finish = async () => {
      const body = box.value.trim();
      if (!body || saving) return;
      if (body === m.body) {
        card.editing = null;
        this.render();
        return;
      }
      saving = true;
      save.disabled = true;
      let ok = false;
      try {
        ok = await this.act(card, () => this.host.api.editComment(this.host.id, thread.id, m.id, body, field.mention()));
      } finally {
        saving = false;
      }
      if (ok) {
        card.editing = null;
        this.render();
      } else save.disabled = false;
    };
    box.addEventListener("input", () => {
      if (card.editing) card.editing.text = box.value;
      save.disabled = !box.value.trim();
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void finish();
      } else if (e.key === "Escape") {
        e.preventDefault();
        stop(true);
      }
    });
    const actions = el("div", "comment-actions-row");
    actions.append(el("span", "comment-spacer"), cancel, save);
    form.append(field.el, actions);
    return form;
  }
}
