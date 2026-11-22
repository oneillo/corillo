// The keyboard on the panel's cards: resting on a card, a letter or Return opening its reply, Escape stepping out, and where the keyboard goes after.
import { Selection } from "prosemirror-state";
import { DRAFT } from "./comments";
import { CommentCards, type Card } from "./comments-panel-cards";
import type { Draft } from "./comments-panel";

export const isBox = (target: EventTarget | null): target is HTMLTextAreaElement =>
  target instanceof HTMLTextAreaElement && target.classList.contains("comment-input");

/**
 * The keyboard to the page shown read-only in place of the document (Show
 * changes, a version), with nothing selected there, as on the document (Batch
 * 24, K-1; roadmap Batch 25, item 1). False when no such page is up.
 */
export function toShownPage(doc: Element | null): boolean {
  const shown = doc?.querySelector<HTMLElement>(".version-view:not([hidden]) .version-page");
  if (!shown?.checkVisibility()) return false;
  shown.focus({ preventScroll: true });
  const picked = document.getSelection();
  if (picked && !picked.isCollapsed && picked.anchorNode && shown.contains(picked.anchorNode)) picked.collapseToEnd();
  return true;
}

/** Keys that open a card's reply box when the keyboard rests on the card, with nothing typed. */
const OPENS_REPLY = new Set(["Enter", " "]);

/** The keyboard on the cards of a document's Comments panel. DocComments (comments-panel.ts) builds on this class. */
export abstract class CardKeyboard extends CommentCards {
  // What the panel (DocComments, comments-panel.ts) gives the keyboard ----------------
  protected abstract draft: Draft | null;
  protected abstract readonly list: HTMLElement;
  protected abstract readonly handBackButton: HTMLButtonElement;
  protected abstract readonly newCommentButton: HTMLButtonElement;
  protected abstract discardDraft(refocus?: boolean): void;
  protected abstract keepCaretInSight(box: HTMLTextAreaElement): void;

  /**
   * Rest the keyboard on an item's card (Next and Previous Comment): a letter
   * starts its reply, Return opens it, Escape goes back to the document, and
   * nothing typed reaches the page. An empty comment being written goes.
   */
  keyboardTo(id: string): void {
    const card = this.cards.get(id)?.el ?? this.noteCards.get(id);
    if (!card?.isConnected) return;
    if (this.draft && !this.draft.posting && !this.draft.input.value.trim()) this.discardDraft(false);
    card.tabIndex = -1;
    card.focus({ preventScroll: true });
  }

  /** A card the keyboard came to from elsewhere (F6): into sight in the panel (review of Batch 12, B12-5). */
  bringIntoSight(card: HTMLElement): void {
    const id = card === this.draft?.el ? DRAFT : card.dataset.threadId;
    if (id) this.revealCard(id);
  }

  /** Whether the keyboard rests on a card (not in a box or on a button in it). */
  get keyboardOnCard(): boolean {
    const a = document.activeElement;
    return a instanceof HTMLElement && a.parentElement === this.list;
  }

  /** The item whose card the keyboard rests on, if it does. */
  restingOn(): string | null {
    if (!this.keyboardOnCard) return null;
    const a = document.activeElement;
    for (const [id, card] of this.cards) if (card.el === a) return id;
    for (const [id, card] of this.noteCards) if (card === a) return id;
    return null;
  }

  /** A paste with the keyboard resting on a card: its reply opens with the text added. False when it isn't resting on one. */
  replyWith(text: string): boolean {
    if (!this.keyboardOnCard) return false;
    const target = document.activeElement as HTMLElement;
    const card = this.cards.get(target.dataset.threadId ?? "");
    if (!card || card.el !== target || card.reply.hidden || !text) return true;
    this.openReply(card, true);
    document.execCommand("insertText", false, text); // as typed, so Undo in the box takes it back
    return true;
  }

  /** A key with the keyboard resting on a card: see keyboardTo. */
  protected keyOnCard(e: KeyboardEvent): void {
    const target = e.target;
    if (!(target instanceof HTMLElement) || target.parentElement !== this.list || e.metaKey || e.ctrlKey || e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      this.focusPage();
      return;
    }
    // A note takes no reply: a letter or Return there says how to answer, rather than nothing (Batch 24, K-9).
    if ([...this.noteCards.values()].includes(target)) {
      if (OPENS_REPLY.has(e.key) || e.key.length === 1) {
        e.preventDefault();
        this.say("A note can't take a reply. To answer it, start a new comment (⌥⌘M).");
      }
      return;
    }
    const card = this.cards.get(target.dataset.threadId ?? "");
    if (!card || card.el !== target || card.reply.hidden) return;
    if (OPENS_REPLY.has(e.key)) {
      e.preventDefault();
      this.openReply(card, true);
    } else if (e.key.length === 1 || e.key === "Dead" || e.key === "Process") {
      // Not stopped: the letter goes on into the box, which has the keyboard now. A dead
      // key (´ for á) or an input method's key ("Process") starts a letter the same way.
      this.openReply(card, true);
    }
  }

  /** The keyboard into a comment's reply box, after what's in it. `fromCard`: leaving it puts the keyboard back on the card. */
  protected openReply(card: Card, fromCard: boolean): void {
    card.fromCard = fromCard;
    const box = card.replyInput;
    box.focus({ preventScroll: true });
    box.setSelectionRange(box.value.length, box.value.length);
    const id = card.el.dataset.threadId;
    if (id) this.revealCard(id);
    this.keepCaretInSight(box);
  }

  /** Done with a reply box (posted, Cancel, Escape): back to the card if it was opened from there, otherwise to the document. */
  protected leaveReply(card: Card): void {
    const toCard = card.fromCard && card.el.isConnected;
    card.fromCard = false;
    if (toCard) {
      card.el.tabIndex = -1;
      card.el.focus({ preventScroll: true });
    } else this.host.focusDocument();
  }

  /**
   * Escape on a button in the panel steps out, one level at a time (roadmap
   * Batch 12, G-10): from a button in a card to the card, from one on the
   * panel's top to the page. The boxes, the card itself and the "⋯" menu have
   * Escapes of their own. True when it was this.
   */
  protected stepOut(e: KeyboardEvent): boolean {
    const target = e.target;
    if (e.key !== "Escape" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !(target instanceof HTMLElement)) return false;
    if (isBox(target) || target.parentElement === this.list || target.isContentEditable) return false;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return false;
    e.preventDefault();
    const card = target.closest<HTMLElement>(".comment-card");
    if (card && card === this.draft?.el) this.draft.input.focus({ preventScroll: true });
    else if (card && card.parentElement === this.list) {
      card.tabIndex = -1;
      card.focus({ preventScroll: true });
    } else this.focusPage();
    return true;
  }

  /**
   * The keyboard to the page on screen: the document, or the page shown read-only (Show changes, a version) while it's up.
   * In the document, at the end of the words selected there, nothing selected (Batch 24, K-1).
   * The one way back to the page when a panel the keyboard was in goes (review of Batch 24, R24-1).
   */
  focusPage(): void {
    if (!toShownPage(this.el.closest(".doc"))) this.cursorToDocument();
  }

  /**
   * Into the page, with nothing selected there: where nothing else can take
   * the keyboard, words left selected from before would be replaced by the
   * next key (roadmap Batch 12, G-2). The cursor goes to the selection's end.
   */
  protected cursorToDocument(): void {
    this.host.focusDocument();
    const a = document.activeElement;
    if (a instanceof HTMLTextAreaElement && !a.classList.contains("comment-input")) {
      a.setSelectionRange(a.selectionEnd, a.selectionEnd);
      return;
    }
    const view = this.host.view();
    const sel = view.state.selection;
    if (!view.hasFocus() || sel.empty) return;
    view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(sel.to), -1)));
  }

  /** The keyboard is where a Send by its own button leaves it (the button, New comment beside it) or nowhere. */
  keyboardBySend(): boolean {
    const a = document.activeElement;
    return !a || a === document.body || a === this.handBackButton || a === this.newCommentButton;
  }

  /**
   * The page was locked under the keyboard (an agent took the document), or
   * Send went or greyed out with the keyboard on it: the keyboard goes to New
   * comment, since commenting is what he can do now (roadmap Batch 12, G-6).
   * The element it went to, or null when the panel isn't on screen.
   */
  keyboardWhileLocked(): HTMLElement | null {
    const b = this.newCommentButton;
    if (b.disabled || !b.checkVisibility()) return null;
    b.focus({ preventScroll: true });
    return b;
  }
}
