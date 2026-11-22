// The lines people drag to change how wide things are: on the left edge of the
// side panel (comments and history take the same place, so they share one
// width, the same for every document), and between the Markdown text and its
// preview. Each line is a separator that the arrow keys move too, and
// double-clicking it goes back to the usual width. The limits are in
// src/core/columns.ts; the widths are remembered between launches
// (src/main/view-settings.ts).
import {
  SIDE_DEFAULT,
  SPLIT_DEFAULT,
  SPLIT_MIN,
  STEP,
  clampTo,
  sideLimits,
  sideWidth,
  splitLeft,
  splitLimits,
  type Limits,
} from "../core/columns";

/** The side panel's width, as the person chose it; the window may be too narrow for it right now. */
let side = SIDE_DEFAULT;
/** The Markdown text's share of the Markdown view. */
let split = SPLIT_DEFAULT;
/** Lays out each Markdown view again, for when the share changes. */
const splitViews = new Set<() => void>();

/** What a line between two columns moves. */
interface Column {
  /** How wide the column is now, and how wide it may be. */
  measure(): Limits & { now: number };
  /** Make it this wide, within its limits, and say so on its line. */
  set(width: number): void;
  /** Remember the width; the person has chosen it. */
  save(): void;
  /** Back to the usual width (and remember that). */
  reset(): void;
  /** The column is right of the line, so moving the line left widens it. */
  rightOfLine: boolean;
}

/** Read the remembered widths, and keep the side panel within its limits as the window changes size. */
export function setupColumns(): void {
  void window.corillo.columns().then((saved) => {
    side = saved.side;
    split = saved.split;
    showSide();
    for (const layOut of splitViews) layOut();
  });
  let frame = 0;
  window.addEventListener("resize", () => {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        showSide();
      });
    }
  });
  showSide();
}

// The side panel ------------------------------------------------------------------

const sideColumn: Column = {
  measure: () => ({ now: sideWidth(side, window.innerWidth), ...sideLimits(window.innerWidth) }),
  set(width) {
    side = clampTo(width, sideLimits(window.innerWidth));
    showSide();
  },
  save: () => void window.corillo.columns({ side }),
  reset() {
    side = SIDE_DEFAULT;
    showSide();
    void window.corillo.columns({ side });
  },
  rightOfLine: true,
};

function showSide(): void {
  const root = document.documentElement.style;
  root.setProperty("--side-width", `${sideColumn.measure().now}px`);
  root.setProperty("--side-width-markdown", `${sideWidth(side, window.innerWidth, 2 * SPLIT_MIN)}px`);
  for (const line of document.querySelectorAll<HTMLElement>(".side-handle")) describe(line, sideColumn);
}

/**
 * The line on the left edge of a tab's side panel: the comments panel and
 * the History panel each have one, just before the panel, shown only while
 * that panel is. `resized` runs once the person
 * has chosen a width, for anything that depends on it.
 */
export function sideHandle(resized: () => void): HTMLElement {
  const line = separator("side-handle", "Side panel width", {
    ...sideColumn,
    save() {
      sideColumn.save();
      resized();
    },
    reset() {
      sideColumn.reset();
      resized();
    },
  });
  describe(line, sideColumn);
  return line;
}

/**
 * The side panels (comments, History, the outline) start their heading level
 * with the top of the page, under the lines and banners at its top too (spec,
 * "Look and feel"; roadmap Batch 11, F-12): how tall those are is given to the
 * panels as --page-top, followed as lines come and go and the window changes.
 * `around` makes the change, keeping the cards in sight where they are.
 * `scrolled` is how far the page was scrolled to make room for a line that
 * came, so it didn't move: the headings don't either (review of Batch 11,
 * B11R-8). The result stops following, for a closed tab.
 */
export function lineUpPanels(body: HTMLElement, views: HTMLElement, around: (change: () => void) => void, scrolled: () => number): () => void {
  let was = -1;
  const observer = new ResizeObserver(() => {
    if (!views.getClientRects().length) return; // another tab is in front: kept as it was
    const top = views.getBoundingClientRect().top - body.getBoundingClientRect().top - scrolled();
    if (Math.abs(top - was) < 0.5) return;
    was = top;
    around(() => body.style.setProperty("--page-top", `${top}px`));
  });
  observer.observe(views);
  return () => observer.disconnect();
}

// The Markdown view ---------------------------------------------------------------

/**
 * The line between the Markdown text and its preview, in this Markdown view.
 * The view is laid out again whenever its own width changes (the window, the
 * side panel, or being shown again after another tab or view). Too narrow for
 * both halves at their least width, the preview gives way and the text takes
 * the whole view, until there's room again (roadmap Batch 11, F-18). `dispose`
 * stops that, for a closed tab.
 */
export function splitHandle(view: HTMLElement): { line: HTMLElement; dispose: () => void } {
  const total = () => view.clientWidth;
  const column: Column = {
    measure: () => ({ now: splitLeft(split, total()), ...splitLimits(total()) }),
    set(width) {
      const all = total();
      if (all > 0) split = clampTo(width, splitLimits(all)) / all;
      layOut();
    },
    save: () => void window.corillo.columns({ split }),
    reset() {
      split = SPLIT_DEFAULT;
      for (const other of splitViews) other();
      void window.corillo.columns({ split });
    },
    rightOfLine: false,
  };
  const line = separator("split-handle", "Markdown text width", column);
  const layOut = () => {
    const all = total();
    if (all === 0) return; // hidden; it's laid out when shown
    const textOnly = all < 2 * SPLIT_MIN;
    if (view.classList.contains("text-only") !== textOnly) view.classList.toggle("text-only", textOnly);
    view.style.gridTemplateColumns = textOnly ? "minmax(0, 1fr)" : `${column.measure().now}px minmax(0, 1fr)`;
    describe(line, column);
  };
  const observer = new ResizeObserver(layOut);
  observer.observe(view);
  splitViews.add(layOut);
  return {
    line,
    dispose() {
      observer.disconnect();
      splitViews.delete(layOut);
    },
  };
}

// The line itself -----------------------------------------------------------------

/** Tell assistive technology where the line is, and how far it can go. */
function describe(line: HTMLElement, column: Column): void {
  const { now, min, max } = column.measure();
  line.setAttribute("aria-valuenow", String(now));
  line.setAttribute("aria-valuemin", String(min));
  line.setAttribute("aria-valuemax", String(max));
}

function separator(className: string, label: string, column: Column): HTMLElement {
  const line = document.createElement("div");
  line.className = `column-handle ${className}`;
  line.tabIndex = 0;
  line.setAttribute("role", "separator");
  line.setAttribute("aria-orientation", "vertical");
  line.setAttribute("aria-label", label);
  // Moving the line right by this much changes the column's width by this times `toWidth`.
  const toWidth = column.rightOfLine ? -1 : 1;

  // Dragging: the column follows the pointer once per frame, and the width is
  // remembered when the person lets go.
  let drag: { startX: number; startWidth: number; x: number; frame: number } | null = null;
  const follow = () => {
    if (!drag) return;
    drag.frame = 0;
    column.set(drag.startWidth + (drag.x - drag.startX) * toWidth);
  };
  line.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection, and the cursor stays where it was
    line.setPointerCapture(e.pointerId);
    drag = { startX: e.clientX, startWidth: column.measure().now, x: e.clientX, frame: 0 };
    line.classList.add("dragging");
    document.body.classList.add("resizing-columns");
  });
  line.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.x = e.clientX;
    if (!drag.frame) drag.frame = requestAnimationFrame(follow);
  });
  const end = () => {
    if (!drag) return;
    const moved = drag.x !== drag.startX;
    if (drag.frame) cancelAnimationFrame(drag.frame);
    if (moved) follow();
    drag = null;
    line.classList.remove("dragging");
    document.body.classList.remove("resizing-columns");
    // A click without a move keeps the person's choice, even if the window is too narrow for it now.
    if (moved) column.save();
  };
  line.addEventListener("pointerup", end);
  line.addEventListener("pointercancel", end);
  line.addEventListener("lostpointercapture", end);

  line.addEventListener("dblclick", () => column.reset());
  line.addEventListener("keydown", (e) => {
    if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    column.set(column.measure().now + (e.key === "ArrowRight" ? STEP : -STEP) * toWidth);
    column.save();
  });
  return line;
}
