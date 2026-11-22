// View > Show Outline, in the window (roadmap Batch 4, item 1): the document's
// headings to three levels, in a pane at the left of the page, the one in
// sight marked. Beside each, how many open comments its section has, and a
// dot when others changed it since the person handed the document over (the
// same places Show changes marks). The status bar names the section in sight.
// The toolbar's Outline button, at its left end over where the pane opens,
// shows and hides it as the menu item does (roadmap Batch 9, item 10). See
// src/core/sections.ts for what a section is, and src/main/outline.ts for the
// setting. (A Done tick beside each heading went in roadmap Batch 9, item 9.)
//
// Off, it costs nothing: no pane, no listeners on the page, no work on any
// change. On, the pane follows the document in front only: a change is looked
// at once typing pauses, the mark follows scrolling once a frame, and the dots
// are worked out again a moment after a version is saved. It shows in the
// formatted view; while a version or Show changes is shown, it stays in its
// place, dimmed, and can't be used. It gives way when the page beside it would
// be narrower than the page's least width; the status bar still names the
// section then. Turned on where it can't show (that narrow window, or the
// Markdown view), it says so for a moment, with what to do (roadmap Batch 11,
// F-19).
import { TextSelection } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { PAGE_MIN } from "../core/columns";
import { changedSince, countIn, sectionsOf, type Section } from "../core/sections";
import type { CorilloApi } from "../preload/preload";
import { commentRanges, DRAFT, type CommentRanges } from "./comments";
import type { DocTab } from "./doc-tab";
import type { HistoryUi } from "./history";
import { ICONS } from "./icons";
import { movable } from "./more";
import { parseCached } from "./parse-cache";

export interface OutlineHost {
  api: CorilloApi;
  active(): DocTab | null;
  /** The open document with this id, if it's still open. */
  tab(id: string): DocTab | undefined;
  history: HistoryUi;
  /** Where the status bar names the section in sight. */
  status: HTMLElement;
  /** The toolbar, whose left end gets the Outline button (before its fitting is set up: more.ts). */
  toolbar: HTMLElement;
}

/** The pane's width, as style.css sets it. */
const PANE = 208;
/** A change is looked at once typing pauses this long. */
const PAUSE_MS = 300;
/** The dots are worked out again this long after a version is saved. */
const DOTS_MS = 500;
/** A heading gone to rests this far below the top of the page's area, in pixels. */
const TOP_GAP = 24;
/** How long the note saying why the outline can't show stays. */
const TOLD_MS = 8000;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function setUpOutline(host: OutlineHost): { update(): void } {
  const { api, status } = host;
  let on = false;

  // Per document, kept while it's open (the tab let go of, they go too).
  let changedOf = new WeakMap<DocTab, Set<string>>();
  /** Documents whose history changed while another was in front: their dots are worked out again when they come to the front. */
  let stale = new WeakSet<DocTab>();

  // The pane, made when the outline first shows, and moved to the document in front.
  let pane: HTMLElement | null = null;
  let list: HTMLOListElement | null = null;
  let empty: HTMLElement | null = null;
  let rows: HTMLLIElement[] = [];

  // The document the pane follows now, and what it last saw of it.
  let tab: DocTab | null = null;
  let sections: Section[] = [];
  let seenDoc: Node | null = null;
  let seenRanges: CommentRanges | null = null;
  let drawn = "";
  let inSight = -1;
  /** A heading just gone to stays marked until the page is scrolled from there. */
  let pinned: { index: number; top: number } | null = null;
  let narrow = false;
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;
  let dotsTimer: ReturnType<typeof setTimeout> | null = null;
  let frame = 0;
  let fitFrame = 0;
  let sizes: ResizeObserver | null = null;
  /** Why the outline, just turned on, can't show, for a moment (made when first needed). */
  let told: HTMLElement | null = null;
  let toldTimer: ReturnType<typeof setTimeout> | null = null;
  /** While the note shows: follows the page's area, so a bar opening above it (Find, Read Aloud) never goes under it. */
  let toldSizes: ResizeObserver | null = null;

  const onScroll = (event: Event) => {
    if (tab && event.target === scrollerOf(tab)) inSightLater();
  };

  // The toolbar's Outline button: pressed while the outline is on. A click asks Corillo, which tells every window
  // (and the menu item), so the button and View > Show Outline never disagree; it shows the change at once.
  const group = document.createElement("div");
  group.className = "tool-group outline-tools";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tool outline-tool";
  button.innerHTML = ICONS.outline;
  button.setAttribute("aria-label", "Outline");
  button.addEventListener("mousedown", (e) => e.preventDefault()); // keep the cursor in the document
  button.addEventListener("click", () => {
    const next = !on;
    show(next, true);
    void api.setOutline(next).catch(() => undefined);
  });
  group.append(button);
  host.toolbar.prepend(group);
  // In a narrow window it goes into More, where the outline can't show beside the page anyway.
  movable("outline", button);
  pressed();

  function pressed(): void {
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", String(on));
    button.title = on ? "Hide outline" : "Show outline";
  }

  /** `chosen`: the person turned it on or off just now (not the setting read at launch). */
  function show(next: boolean, chosen = false): void {
    if (next === on) return;
    on = next;
    pressed();
    if (!on) letGo();
    else {
      update();
      if (chosen) tellWhyNot();
    }
  }
  void api.outline().then((next) => show(next));
  api.onOutline((next) => show(next, true));
  api.onHistoryChanged((id) => {
    if (!on) return;
    if (tab?.id === id) dotsLater(tab, DOTS_MS);
    else {
      const behind = host.tab(id);
      if (behind) stale.add(behind);
    }
  });

  /** Off: the pane goes, and everything it kept. */
  function letGo(): void {
    // Turned off with the keyboard in it: back to the page, nothing selected (Batch 24, K-6; review, R24-1).
    const wasIn = tab && pane?.contains(document.activeElement) ? tab : null;
    detach();
    pane?.remove();
    wasIn?.cursorToPage();
    pane = list = empty = null;
    rows = [];
    changedOf = new WeakMap();
    stale = new WeakSet();
    setStatus(-1);
  }

  function detach(): void {
    unsay();
    if (tab) tab.el.removeEventListener("scroll", onScroll, { capture: true });
    sizes?.disconnect();
    sizes = null;
    if (pauseTimer) clearTimeout(pauseTimer);
    if (dotsTimer) clearTimeout(dotsTimer);
    pauseTimer = dotsTimer = null;
    cancelAnimationFrame(frame);
    cancelAnimationFrame(fitFrame);
    frame = fitFrame = 0;
    tab = null;
    sections = [];
    seenDoc = null;
    seenRanges = null;
    drawn = "";
    inSight = -1;
    pinned = null;
  }

  function attach(next: DocTab | null): void {
    detach();
    if (!next) {
      pane?.remove();
      setStatus(-1);
      return;
    }
    tab = next;
    pane ??= makePane();
    next.main.before(pane);
    next.el.addEventListener("scroll", onScroll, { capture: true, passive: true });
    sizes = new ResizeObserver(() => fitLater());
    sizes.observe(next.main);
    if (!changedOf.has(next) || stale.delete(next)) dotsLater(next, 0);
    refresh();
  }

  /** Called whenever the document in front, or what's shown of it, may have changed: cheap unless something did. */
  function update(): void {
    if (!on) return;
    const front = host.active();
    if (front !== tab) attach(front);
    if (!tab || !pane) return;
    const viewing = host.history.isViewing(tab);
    if (pane.inert !== viewing) pane.inert = viewing;
    if (told && !whyNot(tab)) unsay();
    const state = tab.view.state;
    if (state.doc !== seenDoc || commentRanges(state) !== seenRanges) {
      if (pauseTimer) clearTimeout(pauseTimer);
      pauseTimer = setTimeout(() => {
        pauseTimer = null;
        refresh();
      }, PAUSE_MS);
    }
    setStatus(inSight);
  }

  /** Read the headings and the comments' places again, and draw what changed. */
  function refresh(): void {
    if (!tab || tab.view.isDestroyed) return;
    const state = tab.view.state;
    seenDoc = state.doc;
    seenRanges = commentRanges(state);
    sections = sectionsOf(state.doc);
    draw();
    inSightLater();
  }

  function draw(): void {
    if (!tab || !list || !empty) return;
    const ranges = seenRanges;
    const places: number[] = [];
    if (ranges) {
      for (const id of ranges.shown) {
        const range = id === DRAFT ? undefined : ranges.ranges.get(id);
        if (range) places.push(range.from);
      }
    }
    const counts = countIn(sections, places);
    const changed = changedOf.get(tab) ?? new Set<string>();
    const shape = sections.map((s, i) => `${s.level} ${s.key}\t${counts[i]}${changed.has(s.key) ? "c" : ""}`).join("\n");
    if (shape === drawn) return;
    drawn = shape;
    const focused = focusedPlace();
    rows = sections.map((s, i) => row(s, i, counts[i], changed.has(s.key)));
    list.replaceChildren(...rows);
    empty.hidden = sections.length > 0;
    if (focused !== null) focusPlace(Math.min(focused, rows.length - 1));
    else roveTo(Math.max(inSight, 0));
    // The new rows are marked as the old ones were, until the next look says otherwise.
    const was = Math.min(inSight, rows.length - 1);
    inSight = -1;
    mark(was);
  }

  function row(s: Section, i: number, count: number, changed: boolean): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "outline-row";
    li.dataset.level = String(s.level);
    const go = document.createElement("button");
    go.type = "button";
    go.className = "outline-go";
    go.dataset.i = String(i);
    go.tabIndex = -1;
    const said = [s.text, changed ? "changed since you handed it over" : "", count ? plural(count, "open comment", "open comments") : ""];
    go.title = said.filter(Boolean).join(", ");
    go.setAttribute("aria-label", go.title);
    const words = document.createElement("span");
    words.className = "outline-words";
    words.textContent = s.text;
    const dot = document.createElement("span");
    dot.className = "outline-dot";
    dot.hidden = !changed;
    // Each says what it means where the pointer rests on it; the row's name says both (Batch 24, W-15).
    dot.title = "Changed since you handed it over";
    const n = document.createElement("span");
    n.className = "outline-count";
    n.textContent = count ? String(count) : "";
    if (count) n.title = plural(count, "open comment", "open comments");
    go.append(words, dot, n);
    li.append(go);
    return li;
  }

  function makePane(): HTMLElement {
    const nav = document.createElement("nav");
    nav.className = "outline-pane";
    nav.setAttribute("aria-label", "Outline");
    const title = document.createElement("h2");
    title.className = "outline-title";
    title.textContent = "Outline";
    list = document.createElement("ol");
    list.className = "outline-list";
    empty = document.createElement("p");
    empty.className = "outline-empty";
    empty.textContent = "Headings you add show here.";
    empty.hidden = true;
    nav.append(title, list, empty);
    list.addEventListener("click", (e) => {
      const heading = (e.target as Element).closest<HTMLButtonElement>("button[data-i]");
      if (heading) goTo(Number(heading.dataset.i));
    });
    list.addEventListener("keydown", keys);
    return nav;
  }

  // Going to a heading ------------------------------------------------------------

  function scrollerOf(t: DocTab): HTMLElement | null {
    return t.view.dom.closest<HTMLElement>(".canvas");
  }

  /** The heading at the top of the page, with the cursor at its start. */
  function goTo(i: number): void {
    if (!tab || host.history.isViewing(tab)) return;
    if (tab.view.state.doc !== seenDoc) refresh();
    const s = sections[i];
    const view = tab.view;
    const heading = s && (view.nodeDOM(s.from) as HTMLElement | null);
    const scroller = scrollerOf(tab);
    if (!heading || !scroller) return;
    scroller.scrollTop += heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top - TOP_GAP;
    pinned = { index: i, top: scroller.scrollTop };
    mark(i);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, s.from + 1)));
    view.focus();
  }

  // The heading in sight ----------------------------------------------------------

  function inSightLater(): void {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      mark(findInSight());
    });
  }

  /**
   * The section at the top of the page: the last heading at or above a line a
   * third of the way down (at most 160 pixels). At the end of the document,
   * the last heading in sight, since the ones below can't scroll up further.
   */
  function findInSight(): number {
    if (!tab || !sections.length || tab.view.state.doc !== seenDoc) return inSight;
    // While a version or Show changes is on screen, the page underneath isn't laid out: the mark stays
    // on the section the person was reading, ready for when they go back.
    if (host.history.isViewing(tab)) return inSight;
    const scroller = scrollerOf(tab);
    if (!scroller || !scroller.checkVisibility()) return inSight;
    if (pinned && Math.abs(scroller.scrollTop - pinned.top) <= 2) return pinned.index;
    pinned = null;
    const box = scroller.getBoundingClientRect();
    const view = tab.view;
    const topOf = (i: number) => (view.nodeDOM(sections[i].from) as HTMLElement | null)?.getBoundingClientRect().top ?? Infinity;
    const line = box.top + Math.min(160, box.height / 3);
    let lo = 0;
    let hi = sections.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (topOf(mid) <= line) lo = mid + 1;
      else hi = mid;
    }
    let at = lo - 1;
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
      while (at + 1 < sections.length && topOf(at + 1) < box.bottom) at++;
    }
    return at;
  }

  function mark(at: number): void {
    if (at !== inSight) {
      rows[inSight]?.querySelector(".outline-go")?.removeAttribute("aria-current");
      rows[inSight]?.classList.remove("in-sight");
      inSight = at;
      const r = rows[at];
      if (r) {
        r.classList.add("in-sight");
        r.querySelector(".outline-go")?.setAttribute("aria-current", "location");
        if (pane && !pane.hidden) keepInView(r);
        if (!list?.contains(document.activeElement)) roveTo(at);
      }
    }
    setStatus(inSight);
  }

  /** The row in the pane's sight, scrolling only the pane. */
  function keepInView(r: HTMLElement): void {
    if (!pane) return;
    const box = pane.getBoundingClientRect();
    const at = r.getBoundingClientRect();
    if (at.top < box.top) pane.scrollTop -= box.top - at.top + 8;
    else if (at.bottom > box.bottom) pane.scrollTop += at.bottom - box.bottom + 8;
  }

  /** The status bar's words: the section in sight, in the formatted view, while nothing else is shown. */
  function setStatus(at: number): void {
    const s = on && tab && tab.mode !== "markdown" && !host.history.isViewing(tab) ? sections[at] : undefined;
    const text = s?.text ?? "";
    if (status.textContent !== text) {
      status.textContent = text;
      status.title = s ? `In sight: ${s.text}` : "";
    }
    status.hidden = !s;
  }

  // Room for it ---------------------------------------------------------------------

  /** A frame later (a change of size inside the size observer's own call would be one more to report). */
  function fitLater(): void {
    fitFrame ||= requestAnimationFrame(() => {
      fitFrame = 0;
      fit();
    });
  }

  /** The pane gives way while the page beside it would be narrower than its least width. */
  function fit(): void {
    if (!tab || !pane) return;
    const page = tab.main.getBoundingClientRect().width;
    if (!narrow && pane.checkVisibility() && page < PAGE_MIN) narrow = true;
    else if (narrow && page - PANE >= PAGE_MIN) narrow = false;
    if (pane.hidden !== narrow) pane.hidden = narrow;
    if (told) {
      if (whyNot(tab)) place(tab, told);
      else unsay();
    }
  }

  // Why it can't show ------------------------------------------------------------------
  // The button and the menu's tick show the setting, so the outline can be on
  // with nothing to see. Turned on then, it says why, and what to do, at the
  // top left of the page where it would be. It goes once the outline shows,
  // or after a moment.

  /** Why the outline can't show in this document now, or "" when it can. */
  function whyNot(t: DocTab): string {
    if (t.mode === "markdown") return "The outline is on. It shows in the Formatted view.";
    if (!narrow) return "";
    const lead = "The outline is on, but there isn't room for it beside the page.";
    // A side panel beside the page (not one lying over it) that leaves room for the outline once it's closed.
    const side = [...t.el.querySelectorAll<HTMLElement>(":scope > .doc-body > :is(.comments-panel, .history-panel)")].find(
      (p) => p.checkVisibility() && getComputedStyle(p).position !== "absolute",
    );
    const row = t.main.parentElement?.getBoundingClientRect().width ?? 0;
    if (!side || row - PANE < PAGE_MIN) return `${lead} Make the window wider.`;
    return `${lead} ${side.classList.contains("history-panel") ? "Close History" : "Hide the comments"} or make the window wider.`;
  }

  function tellWhyNot(): void {
    if (!tab || !pane) return;
    fit();
    const why = whyNot(tab);
    if (!why) return;
    if (!told) {
      told = document.createElement("p");
      told.className = "outline-told";
      told.setAttribute("role", "status");
    }
    told.textContent = why;
    tab.main.append(told);
    place(tab, told);
    const views = tab.main.querySelector(":scope > .views");
    toldSizes?.disconnect();
    toldSizes = null;
    if (views) {
      const t = tab;
      const note = told;
      toldSizes = new ResizeObserver(() => place(t, note));
      toldSizes.observe(views);
    }
    if (toldTimer) clearTimeout(toldTimer);
    toldTimer = setTimeout(unsay, TOLD_MS);
  }

  /**
   * At the top left of the page, under the lines over it: where the outline would be. Only over the page's area,
   * never over the Comments panel beside it (Batch 24, W-1).
   */
  function place(t: DocTab, note: HTMLElement): void {
    const views = t.main.querySelector(":scope > .views")?.getBoundingClientRect();
    if (!views) return;
    note.style.left = `${views.left + 16}px`;
    note.style.top = `${views.top + 8}px`;
    note.style.maxWidth = `${Math.max(120, Math.min(320, views.width - 32))}px`;
  }

  function unsay(): void {
    if (toldTimer) clearTimeout(toldTimer);
    toldTimer = null;
    toldSizes?.disconnect();
    toldSizes = null;
    told?.remove();
  }

  // Changed since the hand-over ------------------------------------------------------

  function dotsLater(t: DocTab, wait: number): void {
    if (dotsTimer) clearTimeout(dotsTimer);
    dotsTimer = setTimeout(() => {
      dotsTimer = null;
      void loadDots(t);
    }, wait);
  }

  async function loadDots(t: DocTab): Promise<void> {
    let changed = new Set<string>();
    try {
      changed = changedSince(await api.historySince(t.id), parseCached);
    } catch {
      // No dots is never wrong: Show changes says what happened.
    }
    if (!on || t.view.isDestroyed) return;
    changedOf.set(t, changed);
    if (t === tab) draw();
  }

  // The keyboard ---------------------------------------------------------------------
  // One stop for the pane: Up and Down go from heading to heading, Home and End
  // to the first and last; Return or Space does what a click does.

  function focusedPlace(): number | null {
    const b = document.activeElement;
    if (!(b instanceof HTMLButtonElement) || !list?.contains(b)) return null;
    return Number(b.dataset.i);
  }

  function roveTo(i: number): HTMLButtonElement | null {
    const b = rows[i]?.querySelector<HTMLButtonElement>(".outline-go") ?? null;
    if (!b || !list) return null;
    for (const other of list.querySelectorAll<HTMLButtonElement>("button[tabindex='0']")) other.tabIndex = -1;
    b.tabIndex = 0;
    return b;
  }

  function focusPlace(i: number): void {
    roveTo(i)?.focus();
  }

  function keys(e: KeyboardEvent): void {
    const at = focusedPlace();
    if (at === null || e.metaKey || e.ctrlKey || e.altKey) return;
    const last = rows.length - 1;
    const to: Record<string, number> = { ArrowDown: Math.min(at + 1, last), ArrowUp: Math.max(at - 1, 0), Home: 0, End: last };
    if (!(e.key in to)) return;
    e.preventDefault();
    focusPlace(to[e.key]);
  }

  return { update };
}
