// After an agent's pass, and the Review menu.
//
// When a pass ends, a short status line at the top of the page says the agent
// is done, the document is back with the person, and what waits in the
// Comments panel ("Claude is done. Back to you. 3 comments to read.";
// Orlando, 2026-11-09). It takes the place the "Claude is editing" line had,
// at the same height, so the page doesn't move. There's no Review mode:
// going through what an agent did is going through the cards, clicking each
// to see its words and the changes made for it. The panel holds comments
// only (roadmap Batch 9, item 5): when a pass changed text no comment asked
// for (for a request made in the chat, or nothing), the line ends with "See
// what changed", which turns on Show changes.
//
// The line has no close button (Orlando: "would you ever bother closing it?").
// It clears itself once the person starts working: typing in the document
// (either view), or posting, replying to, resolving, reopening, editing or
// deleting a comment. Reading (clicking cards, scrolling) leaves it. It fades
// out, and the room it took is given back only when that moves nothing the
// person is looking at: at once if the page is scrolled down far enough to
// take it up, otherwise once it is, or when the tab is put away, or when the
// next agent's line takes the same place.
//
// The Review menu works at any time. Next and Previous Comment move from card
// to card in the panel's order (each in focus, its words and changes in
// sight), round from the last to the first; Resolve Comment resolves the one
// in focus and moves to the next. Cards with something new from an agent come
// first: Next goes to the first of them wherever focus was, takes them in
// turn, then goes back to the top saying so ("That's everything new."), and
// Resolve moves on to the next of them (roadmap Batch 1, item 2). After Next
// or Previous the keyboard rests on the card, so typing starts a reply and
// never lands in the document (comments-panel-keyboard.ts, keyboardTo).
import type { AgentInfo, CorilloApi, PassSummary } from "../preload/preload";
import type { DocTab } from "./doc-tab";
import { changedBeyondComments, doneWords } from "./comment-format";

/** How long the line takes to fade out once the person starts working (as in style.css). */
const FADE_MS = 200;

export interface ReviewHost {
  api: CorilloApi;
  tabs(): DocTab[];
  active(): DocTab | null;
  /** What the Review menu offers may have changed. */
  changed?(): void;
  /** Bring the Comments panel on screen, where History has its place, so the card acted on is seen. */
  showComments?(tab: DocTab): void;
  /** With Show changes on, Next and Previous step through its changes: true when they did. */
  stepChanges?(tab: DocTab, forward: boolean): boolean;
  /** Turn on Show changes: everything since the person handed the document over. */
  showChanges?(tab: DocTab): void;
}

/** The Review items that act on a card, which needs to be seen. */
const ON_A_CARD = new Set(["next", "previous", "resolve", "reply", "delete"]);

/** Where the person is among the cards, for the Review menu. */
export interface ReviewStatus {
  /** The card in focus: a comment, or an agent's note. */
  current: string | null;
  hasNext: boolean;
  hasPrevious: boolean;
}

interface StatusLine {
  el: HTMLElement;
  swatches: HTMLElement;
  lead: HTMLElement;
  detail: HTMLElement;
  /** "Show changes", when a pass changed text no comment asked for. */
  see: HTMLButtonElement;
  /**
   * What a screen reader is told: a status region that's always on the page,
   * out of sight, so words arriving in it are read out (a region that appears
   * with its words already in it often isn't).
   */
  said: HTMLElement;
  /** The passes it tells of, oldest first: one per agent. Empty when it's not up. */
  passes: PassSummary[];
  /** An agent is editing the document: the line waits for the next pass to end. */
  editing: boolean;
  /**
   * The person started working: the line faded out, and keeps its room,
   * empty, until giving it back moves nothing (see `giveBack`).
   */
  spent: boolean;
  /** While spent: scrolling the page may let the room go. */
  onScroll: () => void;
}

export function setUpReview(host: ReviewHost) {
  const { api } = host;
  const lines = new WeakMap<DocTab, StatusLine>();
  const agents = new WeakMap<DocTab, AgentInfo[]>(); // let go of with its tab

  const lineOf = (tab: DocTab): StatusLine => {
    let line = lines.get(tab);
    if (line) return line;
    const el = document.createElement("div");
    el.className = "pass-notice";
    el.hidden = true;
    const said = document.createElement("div");
    said.className = "pass-notice-said";
    said.setAttribute("role", "status");
    const swatches = document.createElement("span");
    swatches.className = "pass-notice-swatches";
    const lead = document.createElement("span");
    lead.className = "pass-notice-lead";
    const detail = document.createElement("span");
    detail.className = "pass-notice-detail";
    // Reading, not working: the line stays. The view's one name, as on the toolbar (review of Batch 11, F-9),
    // and a button like every bar's action, right after the words (F-10).
    const see = document.createElement("button");
    see.type = "button";
    see.className = "pass-notice-see";
    see.textContent = "Show changes";
    see.title = "Show changes since you handed the document over (⌃⌘C)";
    see.hidden = true;
    see.addEventListener("click", () => host.showChanges?.(tab));
    el.append(swatches, lead, detail, see);
    // Escape on its button steps out to the page (roadmap Batch 12, G-10).
    see.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      tab.focus();
    });
    tab.main.prepend(el);
    el.after(said);
    line = { el, swatches, lead, detail, see, said, passes: [], editing: false, spent: false, onScroll: () => giveBack(tab) };
    lines.set(tab, line);
    return line;
  };

  /** Say who is done and what waits in the panel; and, while it's up, listen for the person starting work. */
  const draw = (tab: DocTab) => {
    const line = lineOf(tab);
    const up = line.passes.length > 0 && !line.editing;
    if (!up) {
      if (!line.spent) line.el.hidden = true;
      line.said.textContent = "";
      return;
    }
    const arriving = line.el.hidden || line.spent;
    if (line.spent) unspend(tab, line);
    const words = doneWords(line.passes, tab.comments.waitingKinds());
    const anotherDone = line.lead.textContent !== words.lead;
    if (anotherDone) {
      // "Back to you." on its own, so the narrowest page can let it go before who is done (review of Batch 11, F-23).
      const back = " Back to you.";
      if (words.lead.endsWith(back)) {
        const rest = document.createElement("span");
        rest.className = "pass-notice-back";
        rest.textContent = back;
        line.lead.replaceChildren(words.lead.slice(0, -back.length), rest);
      } else line.lead.textContent = words.lead;
    }
    if (line.detail.textContent !== words.detail) line.detail.textContent = words.detail;
    const changed = changedBeyondComments(line.passes);
    line.see.hidden = !changed;
    const title = [words.lead, words.detail, changed ? "Show changes." : ""].filter(Boolean).join(" ");
    if (line.el.title !== title) line.el.title = title;
    // Read out when it comes up, or another agent is done; not as each card is read.
    if (arriving || anotherDone) line.said.textContent = title;
    const names = line.passes.map((p) => p.agent).join("\n");
    if (line.swatches.dataset.names !== names) {
      line.swatches.dataset.names = names;
      line.swatches.replaceChildren(
        ...line.passes.map((p) => {
          const swatch = document.createElement("span");
          swatch.className = "agent-swatch";
          const colour = agents.get(tab)?.find((a) => a.name === p.agent)?.colour;
          if (colour) {
            swatch.dataset.colour = colour;
            swatch.style.background = `var(--agent-${colour})`;
          }
          return swatch;
        }),
      );
    }
    line.el.hidden = false;
    // The first keystroke or comment action clears it; nothing is listening after that.
    const working = () => startedWork(tab);
    tab.onPersonEdit = working;
    tab.comments.onPersonActed = working;
  };

  /** A pass ended: the line says so, with any other agent's pass it was already telling of. */
  const passEnded = (tab: DocTab, summary: PassSummary) => {
    const line = lineOf(tab);
    line.passes = [...line.passes.filter((p) => p.agent !== summary.agent), summary];
    line.editing = false;
    draw(tab);
  };

  /**
   * The person started working on the document: the line has done its job.
   * It fades out, keeping its room for now, so nothing moves; the status bar
   * still says the document is with them.
   */
  const startedWork = (tab: DocTab) => {
    const line = lines.get(tab);
    if (!line?.passes.length) return;
    line.passes = [];
    if (line.editing || line.el.hidden) return; // not on screen: the next line starts afresh
    spend(tab, line);
  };

  /** The line fades out (or, with nothing in it, just stays empty) and keeps its room until that can go. */
  const spend = (tab: DocTab, line: StatusLine) => {
    line.spent = true;
    line.said.textContent = ""; // so the next line's words are read out, even the same words
    line.el.classList.add("spent");
    line.el.setAttribute("aria-hidden", "true");
    line.el.hidden = false;
    tab.main.addEventListener("scroll", line.onScroll, { capture: true, passive: true });
    setTimeout(() => giveBack(tab), FADE_MS + 20);
  };

  /** The page's scrolling areas under the line, as shown now: the page, or the Markdown text and its preview, or a version. */
  const scrollAreas = (tab: DocTab): HTMLElement[] =>
    [...tab.main.querySelectorAll<HTMLElement>(".views > .canvas, .views > .split > .source, .views > .split > .preview-pane")].filter(
      // The view out of sight is kept laid out, but hidden (style.css).
      (area) => !area.closest("[hidden]") && area.getClientRects().length > 0,
    );

  /**
   * A spent line's room goes once that moves nothing on screen: each area
   * under it is scrolled down at least that far, so it scrolls up by the same
   * amount as the room goes, and the words stay exactly where they were. With
   * `anyway`, it goes now (the tab is being put away).
   */
  const giveBack = (tab: DocTab, anyway = false) => {
    const line = lines.get(tab);
    if (!line?.spent) return;
    // Out of sight while Show changes or a version is shown: kept for coming back.
    if (!anyway && tab.el.classList.contains("viewing-version")) return;
    const room = line.el.offsetHeight;
    const areas = room > 0 ? scrollAreas(tab) : [];
    if (!anyway && areas.some((area) => area.scrollTop < room)) return; // later, once scrolled
    const scrolls = areas.map((area) => area.scrollTop);
    unspend(tab, line);
    line.el.hidden = true;
    scrollEach(tab, areas, scrolls, -room);
    tab.scrolledForLine = Math.max(0, tab.scrolledForLine - room); // the headings keep still with the page (B11R-8)
  };

  /**
   * Each area under the line scrolled by `by` pixels on screen from where it was (`from`). The Markdown
   * text and its preview go in one step, which the tie between them knows is Corillo's own, so the text
   * never follows the preview's scroll as if the person had made it (review of Batch 11, B11R-4).
   */
  const scrollEach = (tab: DocTab, areas: HTMLElement[], from: number[], by: number) => {
    const text = areas.findIndex((area) => area.classList.contains("source"));
    const pane = areas.findIndex((area) => area.classList.contains("preview-pane"));
    areas.forEach((area, i) => {
      if (i !== text && i !== pane) area.scrollTop = Math.max(0, from[i] + by);
    });
    if (text >= 0) tab.shiftHalves(by, { text: from[text], pane: pane >= 0 ? from[pane] : null });
  };

  /** The line is no longer spent: shown again with new words, hidden, or its room given back. */
  const unspend = (tab: DocTab, line: StatusLine) => {
    line.spent = false;
    line.el.classList.remove("spent");
    line.el.removeAttribute("aria-hidden");
    tab.main.removeEventListener("scroll", line.onScroll, { capture: true });
  };

  const attach = (tab: DocTab) => {
    lineOf(tab);
    // As the person goes through the cards, the line keeps up with what's left to read.
    tab.comments.onRender = () => {
      const line = lines.get(tab);
      if (line?.passes.length && !line.editing) draw(tab);
    };
  };

  api.onPassEnded((id, summary) => {
    const tab = host.tabs().find((t) => t.id === id);
    if (tab) passEnded(tab, summary);
  });
  api.onAgentsChanged((id, list) => {
    const tab = host.tabs().find((t) => t.id === id);
    if (!tab) return;
    agents.set(tab, list);
    const line = lineOf(tab);
    const editing = list.some((a) => a.editing);
    // The editing line comes up above the page (turns.ts shows or hides it
    // just after this, from the same message): if that moves the page, each
    // area under it scrolls by the same amount, so the words being read stay
    // where they are on screen.
    const views = tab.main.querySelector<HTMLElement>(":scope > .views");
    const areas = views ? scrollAreas(tab) : [];
    if (views && areas.length) {
      const before = views.getBoundingClientRect().top;
      const from = areas.map((area) => area.scrollTop);
      queueMicrotask(() => {
        const moved = views.getBoundingClientRect().top - before;
        if (!moved) return;
        scrollEach(tab, areas, from, moved);
        // As far as the page could scroll: that far the side panels' headings stay still with it (B11R-8).
        const zoom = parseFloat(getComputedStyle(areas[0]).zoom) || 1;
        if (moved > 0) tab.scrolledForLine += (areas[0].scrollTop - from[0]) * zoom;
      });
    }
    if (editing && !line.editing) {
      // A new pass: its editing line takes this line's place, at the same
      // height. What the last pass did is kept for the next line, unless the
      // person has started working since (two agents finishing one after the
      // other, with the person only reading between them, read as one line).
      line.editing = true;
      if (line.spent) {
        unspend(tab, line);
        line.el.hidden = true;
      }
    } else if (!editing && line.editing) {
      line.editing = false;
      // A pass that ends with nothing to tell (the agent changed and answered
      // nothing): the editing line goes, but its room stays, empty, until
      // giving it back moves nothing, as when the done line clears.
      if (!line.passes.length) spend(tab, line);
    }
    draw(tab);
  });

  // The Review menu ----------------------------------------------------------------

  /** The cards in the panel's order, the one in focus, and where it is among them. */
  const where = (tab: DocTab) => {
    const order = tab.comments.cardOrder();
    const current = tab.comments.selectedItem;
    const index = current ? order.indexOf(current) : -1;
    return { order, current, index };
  };

  /** The card Next last went to as one with something new: going on from it once none is left starts again at the top. */
  const landed = new WeakMap<DocTab, string>();

  /** Where Next goes: the first card with something new; after the last of them, the top; otherwise the card after, round to the first. */
  const next = (tab: DocTab): { id: string | null; note?: string } => {
    const unread = tab.comments.unreadItems();
    if (unread.length) {
      landed.set(tab, unread[0]);
      return { id: unread[0] };
    }
    const { order, current, index } = where(tab);
    const walking = current !== null && landed.get(tab) === current;
    landed.delete(tab);
    if (!order.length) return { id: null };
    if (walking) return { id: order[0] === current && order.length > 1 ? order[1] : order[0], note: "That's everything new." };
    return { id: index < 0 ? order[0] : order[(index + 1) % order.length] };
  };

  /** Where Previous goes: the card before, round to the last; with none in focus, the last. */
  const previous = (tab: DocTab): string | null => {
    landed.delete(tab);
    const { order, index } = where(tab);
    if (!order.length) return null;
    return index <= 0 ? order[order.length - 1] : order[index - 1];
  };

  /** Show the card, and rest the keyboard on it. */
  const go = (tab: DocTab, id: string | null, note?: string) => {
    if (!id) return;
    tab.comments.focusItem(id);
    tab.comments.keyboardTo(id);
    if (note) tab.comments.tell(note);
  };

  /**
   * Resolve the comment in focus (or mark a note done), then go to the
   * next card with something new, or else the card after it, round to the
   * first. Done from the panel, the keyboard rests on that card; from the
   * document, it stays there.
   */
  const resolveAndMove = async (tab: DocTab, id: string) => {
    const inPanel = tab.comments.el.contains(document.activeElement);
    const after = tab.comments.cardAfter(id);
    if (!(await tab.comments.resolveItem(id))) return;
    if (after && tab.comments.cardOrder().includes(after)) {
      tab.comments.focusItem(after);
      if (inPanel) tab.comments.keyboardTo(after);
    } else {
      tab.comments.clearSelection();
      if (inPanel) tab.focus();
    }
    host.changed?.();
  };

  return {
    attach,
    /** The tab was put away: a faded line's room goes now, while nobody is looking. */
    putAway: (tab: DocTab) => giveBack(tab, true),
    status(tab: DocTab): ReviewStatus {
      const { order, current } = where(tab);
      // Both go round, from the last card to the first and back.
      return { current, hasNext: order.length > 0, hasPrevious: order.length > 0 };
    },
    /** A Review menu item, for the tab in front. */
    menu(action: string) {
      const tab = host.active();
      if (!tab) return;
      if ((action === "next" || action === "previous") && host.stepChanges?.(tab, action === "next")) return host.changed?.();
      attach(tab);
      if (ON_A_CARD.has(action)) host.showComments?.(tab);
      const id = tab.comments.selectedItem;
      if (action === "next") {
        const to = next(tab);
        go(tab, to.id, to.note);
      } else if (action === "previous") go(tab, previous(tab));
      else if (action === "resolve") {
        if (!id) return;
        if (tab.comments.itemInfo(id).resolved) tab.comments.reopenItem(id);
        else void resolveAndMove(tab, id);
      } else if (action === "reply") {
        if (!id) return;
        if (!tab.comments.panelShown) tab.comments.focusItem(id); // shows the panel, with its card in sight
        tab.comments.focusReply(id);
      } else if (action === "delete") {
        if (id) tab.comments.deleteItem(id); // at once: Undo straight after brings it back
      } else if (action === "before") tab.comments.toggleBefore();
      else if (action === "send") void tab.comments.handBack(); // Send to Claude, or Copy for Claude
    },
  };
}
