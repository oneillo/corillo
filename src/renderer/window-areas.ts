// Moving the keyboard between the window's areas (roadmap Batch 12, G-1).
// Tab stays in the page, where it indents (spec, the bullet on Tab and Shift-Tab), so F6
// goes to the next area and Shift-F6 to the one before, as View > Go to Next
// Area and Go to Previous Area do. The areas, in the order they sit on screen:
// the tab bar, the toolbar, the outline, each line at the top of the page (the
// find bar, a banner, an agent's notice), the page, the side panel (Comments
// or History), the notices above the status bar, and the status bar. Only
// those showing with something to take the keyboard count, and the order goes
// round. Back in the page, the cursor is where it was.
import type { DocTab } from "./doc-tab";
import { closeMenus } from "./popup-menu";

export interface AreasHost {
  active(): DocTab | null;
}

interface Area {
  /** What it holds: the keyboard anywhere in these is "in" it. */
  el: Element[];
  /** Put the keyboard there; false if nothing in it can take it now. */
  enter(): boolean;
}

/** What Tab stops on, before checking it's showing and on. */
const STOPS = "button, a[href], input:not([type='hidden']), select, textarea, summary, [tabindex], [contenteditable='true']";

const shows = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLElement && el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && el.getClientRects().length > 0;

/** The first thing in an area Tab would stop on (in the tab bar or the outline, the one stop they keep). */
function firstStop(root: Element): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>(STOPS)) {
    if (el.tabIndex < 0 || el.matches(":disabled") || el.closest("[inert], .screen-reader-only")) continue;
    if (shows(el)) return el;
  }
  return null;
}

const enterFirst = (root: Element) => () => {
  const stop = firstStop(root);
  stop?.focus();
  return !!stop;
};

function areas(host: AreasHost): Area[] {
  const list: Area[] = [];
  const add = (el: Element | null, enter?: () => boolean, also: Element | null = null) => {
    if (shows(el)) list.push({ el: also ? [el, also] : [el], enter: enter ?? enterFirst(el) });
  };
  // The tab bar, with All tabs at its end while the tabs don't all fit.
  add(document.getElementById("tabs"), undefined, document.querySelector(".tabs-end"));
  add(document.getElementById("toolbar"));
  const tab = host.active();
  if (!tab) {
    add(document.getElementById("empty"));
  } else {
    const body = tab.el.querySelector(":scope > .doc-body");
    add(body?.querySelector(":scope > .outline-pane") ?? null);
    // Each line at the top of the page: the find bar, a version's banner, an agent's notice, a question.
    for (const line of tab.main.children) if (!line.classList.contains("views")) add(line);
    add(tab.main.querySelector(":scope > .views"), () => tab.focusPage());
    // The side panel: the card in focus, or else the panel's first control; History, its list's one stop (the row
    // last on, else the newest), not Close (review of Batch 12, B12-4).
    const panel = [...(body?.querySelectorAll(":scope > .comments-panel, :scope > .history-panel") ?? [])].find(shows) ?? null;
    add(panel, () => {
      const row = panel?.matches(".history-panel") ? panel.querySelector<HTMLElement>(".history-list [tabindex='0']") : null;
      if (shows(row ?? null)) {
        row!.focus({ preventScroll: true });
        row!.scrollIntoView({ block: "nearest" });
        if (document.activeElement === row) return true;
      }
      const card = panel?.querySelector<HTMLElement>(".comment-card.active");
      if (shows(card ?? null)) {
        // A comment being written: its box, where typing goes on (review of Batch 12, B12-5).
        const box = card!.matches(".draft") ? card!.querySelector<HTMLTextAreaElement>("textarea") : null;
        if (box && shows(box)) {
          tab.comments.showUnposted(box);
          if (document.activeElement === box) return true;
        }
        card!.tabIndex = -1;
        card!.focus({ preventScroll: true });
        tab.comments.bringIntoSight(card!); // scrolled away in the panel: back in sight (B12-5)
        if (document.activeElement === card) return true;
      }
      return enterFirst(panel!)();
    });
    add(tab.el.querySelector(":scope > .corner-notices"));
  }
  add(document.querySelector("body > .window-notices"));
  add(document.querySelector("body > .status-bar"));
  return list;
}

/** Move the keyboard to the next area (or the one before), going round. */
function move(host: AreasHost, step: 1 | -1): void {
  const focused = document.activeElement;
  // A dialog (Export settings, Link) keeps the keyboard until it's closed.
  if (focused?.closest("dialog, [role='dialog']")) return;
  const list = areas(host);
  if (!list.length) return;
  // In a menu, the keyboard counts as on the button that opened it, and the menu closes.
  const inMenu = !!focused?.closest("[role='menu']");
  const at = inMenu ? document.querySelector("[aria-expanded='true']:not([role='menu'] *)") : focused;
  if (inMenu) closeMenus();
  const here = at ? list.findIndex((a) => a.el.some((e) => e.contains(at))) : -1;
  // Nowhere yet: start from the page (or the start screen), as if the keyboard were there.
  const home = list.findIndex((a) => a.el[0].classList.contains("views") || a.el[0].id === "empty");
  const from = here >= 0 ? here : home >= 0 ? home - step : -step;
  for (let i = 1; i <= list.length; i++) {
    const area = list[(((from + step * i) % list.length) + list.length) % list.length];
    if (area.enter()) return;
  }
}

export function setUpAreas(host: AreasHost): { next(): void; previous(): void } {
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "F6" || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      move(host, e.shiftKey ? -1 : 1);
    },
    true,
  );
  return { next: () => move(host, 1), previous: () => move(host, -1) };
}
