// Find in the comments: what Find looks in on each card, and a card brought into focus and into sight while Find is on a match in it.
import { commentRanges, withRanges } from "./comments";
import { changeMarks, present, withChanges } from "./change-marks";
import { orderThreads } from "./comment-format";
import { CardKeyboard } from "./comments-panel-keyboard";

/** Sent up from the panel when a box in it is to have the keyboard but can't be seen: History gives it its place (history.ts). */
export const COMMENTS_WANTED = "corillo-comments-wanted";
/** Sent from the panel when Find goes into a card, with its id: with Show changes on, History brings its words into sight on the page shown (history.ts). */
export const CARD_FOUND = "corillo-card-found";
/** On the panel: the comment being written, or the one in focus, changed (Show changes' page marks them; roadmap Batch 25, item 1). */
export const COMMENT_MARKS = "corillo-comment-marks";
/** Room kept between what's brought into sight and the panel's edges. */
export const MARGIN = 12;

/** What Find looks in on a card (roadmap Batch 4, item 2): each message, or an agent's note, as the card shows it. */
export interface FindableCard {
  id: string;
  resolved: boolean;
  parts: { key: string; text: string }[];
}

/** Find in the cards of a document's Comments panel. DocComments (comments-panel.ts) builds on this class. */
export abstract class CardFind extends CardKeyboard {
  /** Replaced whenever the comments or notes change, so Find searches them again (roadmap Batch 4, item 2). */
  protected findStamp = {};
  /** A resolved comment's card shown while Find is on a match in it, or the keyboard rests on it after (see showFound). */
  protected foundResolved: string | null = null;
  /** Find is on a match in it now. */
  protected foundHeld = false;

  // What the panel (DocComments, comments-panel.ts) gives Find -----------------------
  protected abstract showResolved: boolean;
  protected abstract shownAnyway: boolean;
  abstract get panelShown(): boolean;
  protected abstract sight(): { top: number; bottom: number; height: number };

  /** Changes whenever what Find looks in does. */
  get searchStamp(): object {
    return this.findStamp;
  }

  /**
   * What Find looks in, card by card, in the order the panel lists them, with
   * resolved comments where they'd be if they were shown: each message, and
   * an agent's note. Not a comment's quoted words: those are the document's,
   * found there.
   */
  findable(): FindableCard[] {
    const state = this.host.view().state;
    const ranges = commentRanges(state).ranges;
    const gaps = changeMarks(state).gaps;
    const placeOf = (id: string) => ranges.get(id)?.from ?? gaps.get(id)?.pos ?? null;
    const cards = orderThreads(this.threads, placeOf).map((t) => ({ id: t.id, resolved: t.status === "resolved", parts: t.messages.map((m) => ({ key: m.id, text: m.body })) }));
    const notes = [...this.notes].reverse().map((n) => ({ id: n.id, resolved: false, parts: [{ key: "note", text: n.text }] }));
    return [...notes, ...cards];
  }

  /** Where a card shows one of the words Find looks in, if the card is drawn. */
  findablePart(id: string, key: string): HTMLElement | null {
    const card = this.cards.get(id)?.el ?? this.noteCards.get(id);
    if (!card?.isConnected) return null;
    if (key === "note" && this.noteCards.has(id)) return card.querySelector<HTMLElement>(".pass-note-text");
    return card.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(key)}"] > .comment-body`);
  }

  /**
   * Find is on a match in this card: it comes into focus and into sight, as
   * clicking it would, with its words in the document in sight where it has
   * some (never the top, for one on the whole document). A resolved comment's
   * card is shown by itself while Find is on it. The panel shows, and History
   * gives it its place back. The keyboard stays in the find bar.
   */
  showFound(id: string): void {
    this.host.settle();
    const t = this.threads.find((x) => x.id === id);
    const hidden = t?.status === "resolved" && !this.showResolved;
    this.foundResolved = hidden ? id : null;
    this.foundHeld = hidden;
    this.shownAnyway = !this.panelShown || this.shownAnyway;
    const view = this.host.view();
    this.holdCard(this.cards.get(id)?.el ?? this.noteCards.get(id), () => {
      if (!t) view.dispatch(withChanges(withRanges(view.state.tr, { type: "active", id: null }), { type: "select", owner: id }));
      else this.setActive(id);
      this.render();
    });
    if (!this.el.checkVisibility()) this.el.dispatchEvent(new Event(COMMENTS_WANTED, { bubbles: true }));
    this.read(id);
    const state = view.state;
    const first = t ? null : present(this.changeSpans(id)).sort((a, b) => a.from - b.from)[0];
    const at = first?.from ?? (t?.status === "open" ? (commentRanges(state).ranges.get(id)?.from ?? changeMarks(state).gaps.get(id)?.pos) : undefined);
    if (at !== undefined) this.host.reveal(at);
    this.el.dispatchEvent(new CustomEvent(CARD_FOUND, { detail: id }));
    this.revealCard(id);
  }

  /** Bring a match Find marks in a card into sight in the panel. */
  revealFound(box: DOMRect): void {
    const seen = this.sight();
    if (!seen.height || !box.height) return;
    if (box.top < seen.top + MARGIN) this.el.scrollTop += box.top - seen.top - MARGIN;
    else if (box.bottom > seen.bottom - MARGIN) this.el.scrollTop += Math.min(box.bottom - seen.bottom + MARGIN, box.top - seen.top - MARGIN);
  }

  /** Find closed on a match in this card: the keyboard rests on it, as Next Comment leaves it (a resolved one's card goes once it moves on). */
  restOnFound(id: string): void {
    this.foundHeld = false;
    this.keyboardTo(id);
    this.letGoFound();
  }

  /** Find moved off a resolved comment's card, or closed: it's hidden again, once the keyboard isn't on it. */
  letGoFound(): void {
    this.foundHeld = false;
    const id = this.foundResolved;
    if (!id) return;
    const card = this.cards.get(id)?.el;
    if (card?.isConnected && card.contains(document.activeElement)) return;
    this.foundResolved = null;
    this.render();
  }
}
