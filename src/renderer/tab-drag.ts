// Moving a tab by dragging it along the tab bar (roadmap Batch 10, item 1).
// Orlando, 2026-11-13: "Can we also ensure that in Corillo you can move tabs
// around? To change how they're ordered."
//
// The tab lifts and follows the pointer sideways; the others slide aside to
// make room (at once with Reduce Motion); where it's let go it stays, and
// comes to the front. A press that moves less than a few pixels is still a
// click. Escape puts it back. Let go above or below the bar, or outside the
// window, it lands where it is along the bar: one window holds every tab.
// Near an end of a bar with more tabs than it shows, the bar scrolls, with
// the tab kept in sight. Only the tab moves: no picture of it is dragged, and
// nothing is dropped into a document.
//
// Nothing runs between drags: one listener on the bar waits for a press, and
// what a press needs (the pointer's moves, Escape, a frame to scroll the bar)
// goes when the button comes up.

export interface TabDragHost {
  bar: HTMLElement;
  /** Put the tab with this id at this place among the tabs, and bring it to the front. */
  drop(id: string, to: number): void;
}

export interface TabDrag {
  /** Whether a tab is being dragged now (the bar then doesn't scroll to the tab in front). */
  dragging(): boolean;
  /** The bar was drawn again: the tab being dragged and the others keep their places. */
  redrawn(): void;
}

/** How far a press moves before it's a drag, not a click. */
const CLICK_SLOP = 4;
/** How near an end of the bar the pointer scrolls it, and the fastest it scrolls, in pixels a frame. */
const EDGE = 40;
const FASTEST = 14;
/** The tab let go sliding into its place. */
const SETTLE_MS = 120;

interface Press {
  id: string;
  pointer: number;
  /** Where it was pressed, on screen. */
  startX: number;
  startY: number;
  /** The pointer's last place across the screen. */
  x: number;
  /** Where in the tab it was taken hold of, from its left edge. */
  hold: number;
  state: "pressed" | "dragging" | "put back";
  /** The tabs' ids in order, and where each is laid out along the bar (its whole row, not just the part in sight). */
  ids: string[];
  lefts: number[];
  widths: number[];
  gap: number;
  from: number;
  /** Where it would go if let go now. */
  to: number;
  /** A frame asked for to scroll the bar, or 0. */
  frame: number;
  /** Everything the press listens to, let go together. */
  done: AbortController;
}

export function setUpTabDrag(host: TabDragHost): TabDrag {
  const { bar } = host;
  const lessMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let press: Press | null = null;

  const items = () => [...bar.querySelectorAll<HTMLElement>(".tab")];
  const itemOf = (id: string) => items().find((el) => el.dataset.docId === id) ?? null;
  /** A place across the screen, as a place along the bar's row of tabs. */
  const along = (x: number) => x - bar.getBoundingClientRect().left + bar.scrollLeft;

  bar.addEventListener("pointerdown", (e) => {
    // The main button only: Control-click is the Mac's right-click, and the middle button closes the tab.
    if (press || e.button !== 0 || e.ctrlKey || !e.isPrimary) return;
    const item = (e.target as Element).closest<HTMLElement>(".tab");
    if (!item?.dataset.docId) return;
    const done = new AbortController();
    press = {
      id: item.dataset.docId,
      pointer: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      hold: 0,
      state: "pressed",
      ids: [],
      lefts: [],
      widths: [],
      gap: 0,
      from: 0,
      to: 0,
      frame: 0,
      done,
    };
    const signal = done.signal;
    window.addEventListener("pointermove", moved, { signal });
    window.addEventListener("pointerup", up, { signal });
    window.addEventListener("pointercancel", lost, { signal });
    window.addEventListener("blur", lost, { signal });
    window.addEventListener("keydown", key, { signal, capture: true });
  });

  /** Where each tab is laid out (transforms don't count), and where the one being dragged was taken hold of. */
  function measure(p: Press): boolean {
    const tabs = items();
    const ids = tabs.map((el) => el.dataset.docId ?? "");
    const from = ids.indexOf(p.id);
    if (from < 0) return false;
    // offsetLeft is from the bar's own edge, whatever its scroll and whatever a tab's transform.
    p.lefts = tabs.map((el) => el.offsetLeft);
    p.widths = tabs.map((el) => el.offsetWidth);
    if (p.state === "pressed") p.hold = along(p.startX) - p.lefts[from];
    p.ids = ids;
    p.from = from;
    p.gap = parseFloat(getComputedStyle(bar).columnGap) || 0;
    return true;
  }

  function moved(e: PointerEvent): void {
    const p = press;
    if (!p || e.pointerId !== p.pointer) return;
    p.x = e.clientX;
    if (p.state === "pressed") {
      if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) < CLICK_SLOP) return; // still a click
      if (!measure(p)) return finish(false);
      p.state = "dragging";
      bar.classList.add("dragging");
      itemOf(p.id)?.classList.add("lifted");
      try {
        // The moves keep coming outside the window, the button coming up anywhere ends it, and the
        // click that follows goes to the bar, not to a tab or its close button.
        bar.setPointerCapture(p.pointer);
      } catch {
        // the window's own listeners still hear the pointer
      }
    }
    if (p.state === "dragging") follow(p);
  }

  /** The tab under the pointer, the others aside to make room, and the bar scrolling near an end. */
  function follow(p: Press): void {
    const { lefts, widths, from } = p;
    const last = lefts.length - 1;
    const width = widths[from];
    let left = along(p.x) - p.hold;
    // In sight, and within the row of tabs.
    left = Math.min(Math.max(left, bar.scrollLeft), bar.scrollLeft + bar.clientWidth - width);
    left = Math.min(Math.max(left, lefts[0]), lefts[last] + widths[last] - width);
    // Its place: its leading edge past the middle of a tab, it takes that tab's place.
    let to = from;
    for (let i = 0; i <= last; i++) {
      const middle = lefts[i] + widths[i] / 2;
      if (i > from && left + width > middle) to++;
      else if (i < from && left < middle) to--;
    }
    p.to = to;
    const room = width + p.gap;
    items().forEach((el, i) => {
      const shift = i === from ? left - lefts[from] : from < i && i <= to ? -room : to <= i && i < from ? room : 0;
      el.style.transform = shift ? `translateX(${shift}px)` : "";
    });
    if (!p.frame && scrollSpeed(p.x)) {
      p.frame = requestAnimationFrame(() => {
        p.frame = 0;
        if (press !== p || p.state !== "dragging") return;
        const speed = scrollSpeed(p.x);
        if (!speed) return;
        bar.scrollLeft += speed;
        follow(p);
      });
    }
  }

  /** How many pixels a frame the bar scrolls with the pointer here: faster nearer the end, 0 where it can't go further. */
  function scrollSpeed(x: number): number {
    const shown = bar.getBoundingClientRect();
    const into = x < shown.left + EDGE ? x - (shown.left + EDGE) : x > shown.right - EDGE ? x - (shown.right - EDGE) : 0;
    if (!into) return 0;
    const most = bar.scrollWidth - bar.clientWidth;
    if (into < 0 ? bar.scrollLeft <= 0 : bar.scrollLeft >= most - 0.5) return 0;
    return Math.sign(into) * Math.max(1, Math.round(Math.min(1, Math.abs(into) / EDGE) * FASTEST));
  }

  function up(e: PointerEvent): void {
    if (press && e.pointerId === press.pointer) finish(press.state === "dragging");
  }

  /** The press ended without the button coming up here (another app came in front, say): the tab goes back. */
  function lost(): void {
    finish(false);
  }

  function key(e: KeyboardEvent): void {
    if (e.key !== "Escape" || press?.state !== "dragging") return;
    // Escape puts it back; the press goes on until the button comes up, and then moves nothing.
    e.preventDefault();
    e.stopImmediatePropagation();
    putBack(press);
  }

  function putBack(p: Press): void {
    p.state = "put back";
    if (p.frame) cancelAnimationFrame(p.frame);
    p.frame = 0;
    bar.classList.remove("dragging");
    // Without "lifted", the tab slides home with the others (style.css).
    for (const el of items()) {
      el.classList.remove("lifted");
      el.style.transform = "";
    }
  }

  /** The press is over: dropped where it is, or not. */
  function finish(dropped: boolean): void {
    const p = press;
    if (!p) return;
    press = null;
    p.done.abort();
    if (p.frame) cancelAnimationFrame(p.frame);
    p.frame = 0;
    if (p.state === "pressed") return; // a click: the tab's own click handler takes it
    if (bar.hasPointerCapture(p.pointer)) bar.releasePointerCapture(p.pointer);
    if (!dropped || p.state !== "dragging") {
      if (p.state === "dragging") putBack(p);
      return;
    }
    const was = itemOf(p.id)?.getBoundingClientRect().left;
    bar.classList.remove("dragging");
    host.drop(p.id, p.to); // the bar is drawn again in the new order, with no tab moved aside
    // From where it was let go into its place.
    const now = itemOf(p.id);
    if (!now || was === undefined || lessMotion.matches) return;
    const from = was - now.getBoundingClientRect().left;
    if (Math.abs(from) > 0.5) now.animate([{ transform: `translateX(${from}px)` }, { transform: "none" }], { duration: SETTLE_MS, easing: "ease-out" });
  }

  return {
    dragging: () => press?.state === "dragging",
    redrawn() {
      const p = press;
      if (p?.state !== "dragging") return;
      // A tab opened or closed meanwhile (an agent opening one, the Trash): the drag can't say where it goes, so it goes back.
      const ids = items().map((el) => el.dataset.docId ?? "");
      if (ids.join("\n") !== p.ids.join("\n") || !measure(p)) return putBack(p);
      itemOf(p.id)?.classList.add("lifted");
      follow(p);
    },
  };
}
