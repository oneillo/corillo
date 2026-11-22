// The toolbar keeps to one row at any width (Orlando, 2026-11-09). As the
// window narrows, first the named buttons show just their icons; then the
// least used items move, one step at a time, into More (three dots right
// after the writing buttons, beside most of what moves into it, Orlando
// 2026-11-09), which lists them in toolbar order with their icons,
// shortcuts and ticks. Each does there exactly what its button does: More
// presses the button itself, so its state, greying out and action can't drift
// apart. The bar is measured only when the window changes width (and once its
// fonts are in), never while typing: nothing in it changes width of itself
// (the open comments' count is a badge on its button).
import { PopupMenu, closeMenus, type MenuEntry } from "./popup-menu";
import { ICONS } from "./icons";

/**
 * The order items move into More, least used first. Items on one line move
 * together, so a group isn't split where that would read oddly. After the
 * lists, the bar's spacing tightens; what's left (Undo, the style menu, Bold
 * and Italic, Comment, Comments and the two views) stays to the end. It moves
 * only if even that can't fit, which the window's minimum width never needs.
 */
export const ORDER: readonly (readonly string[])[] = [
  ["export"], // once a document is finished; also File > Export
  ["quote", "code-block"], // rare in the documents Corillo is for
  ["outline"], // turned on once and remembered; it can show beside the page and the comments only in a wider window; also View > Show Outline
  ["table"], // does something only inside a table; also the Table menu and right-click
  ["strikethrough"],
  ["redo"], // Shift-Command-Z
  ["insert"],
  ["show-changes", "history"],
  ["link"], // Command-K
  ["bullets", "numbers"],
  // The last resort, narrower than the window can be made.
  ["views"],
  ["comments"],
  ["style"],
  ["comment"],
  ["bold", "italic"],
];
/** The steps before the bar's spacing tightens. */
const BEFORE_TIGHT = ORDER.findIndex((names) => names.includes("views"));

interface Movable {
  name: string;
  el: HTMLElement;
  entries: () => MenuEntry[];
}

const movables = new Map<string, Movable>();

/**
 * A toolbar item that can move into More, by its name in ORDER. How it shows
 * there: as its button does, unless it says otherwise (a menu of its own, the
 * two views).
 */
export function movable(name: string, el: HTMLElement, entries?: () => MenuEntry[]): void {
  if (!ORDER.some((names) => names.includes(name))) throw new Error(`${name} isn't in the toolbar's order`);
  movables.set(name, { name, el, entries: entries ?? (() => [fromButton(el as HTMLButtonElement)]) });
}

/** A toolbar button as an item in More: its name, icon, shortcut, tick and greying out, and pressing it. */
export function fromButton(b: HTMLButtonElement, submenu?: PopupMenu): MenuEntry {
  const svg = b.querySelector("svg");
  const pressed = b.getAttribute("aria-pressed");
  return {
    label: b.getAttribute("aria-label") ?? b.textContent ?? "",
    icon: svg ? svg.outerHTML : b.innerHTML,
    shortcut: /\(([^()]+)\)$/.exec(b.title)?.[1],
    enabled: !b.disabled,
    checked: pressed === null ? undefined : pressed === "true",
    // Pressed as it was chosen: a mouse choice reads as a click, not as the keyboard (review of Batch 12, B12-7).
    run: (keyboard) => (keyboard ? b.click() : b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }))),
    submenu,
  };
}

let moreButton: HTMLButtonElement | null = null;

/** Where something that belongs to this toolbar item opens (the link editor): the item, or More while it's in there. */
export function anchorFor(el: HTMLElement): HTMLElement {
  return el.closest(".moved") && moreButton ? moreButton : el;
}

export interface MoreHost {
  /** Put the keyboard back in the document. */
  focusDocument(): void;
  /**
   * Items More lists at its end, after the buttons moved into it, whenever it's on the bar (Read aloud). They
   * don't keep More on the bar of themselves: at 1100 pixels, a new window's width, that would push Export into it.
   */
  always?: () => MenuEntry[];
}

export function setUpMore(root: HTMLElement, host: MoreHost): void {
  const group = document.createElement("div");
  group.className = "tool-group more-group";
  group.hidden = true;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tool more-tool";
  button.innerHTML = ICONS.more;
  button.setAttribute("aria-label", "More");
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.title = "More: the buttons there's no room for";
  group.append(button);
  // At the end of the writing buttons, before the gap: most of what moves
  // into More comes from there.
  const spacer = root.querySelector(":scope > .tool-spacer");
  if (spacer) root.insertBefore(group, spacer);
  else root.append(group);
  moreButton = button;

  // In the order they sit in the bar, which is the order More lists them.
  const items = [...movables.values()].sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const steps = ORDER.map((names) => items.filter((m) => names.includes(m.name)));
  const groups = [...root.querySelectorAll<HTMLElement>(":scope > .tool-group:not(.more-group)")];

  const menu = new PopupMenu("More", () => {
    const entries: MenuEntry[] = [];
    let last: Element | null = null;
    for (const item of items) {
      if (!item.el.classList.contains("moved")) continue;
      const list = item.entries();
      const place = item.el.closest(".tool-group, .mode-switch");
      if (list.length && entries.length && place !== last) list[0] = { ...list[0], separatorBefore: true };
      entries.push(...list);
      last = place;
    }
    const always = host.always?.() ?? [];
    if (always.length && entries.length) always[0] = { ...always[0], separatorBefore: true };
    return [...entries, ...always];
  }, () => host.focusDocument());

  button.addEventListener("mousedown", (e) => e.preventDefault()); // keep the cursor in the document
  button.addEventListener("click", (e) => {
    if (menu.isOpen) menu.close();
    else menu.open(button, { keyboard: e.detail === 0 });
  });

  /** Everything in the bar lies within its padding. */
  const fits = (): boolean => {
    const bar = root.getBoundingClientRect();
    const end = bar.right - parseFloat(getComputedStyle(root).paddingRight);
    let right = 0;
    for (const child of root.children) {
      const r = child.getBoundingClientRect();
      if (r.width > 0) right = Math.max(right, r.right);
    }
    return right <= end + 0.5;
  };

  // The bar's states, widest first: everything with its name; 1. the named
  // buttons as icons; 2. then one more step of items in More each time; and,
  // once the lists have gone, 3. the spacing tightened before the essentials.
  const levels: { icons: boolean; tight: boolean; steps: number }[] = [{ icons: false, tight: false, steps: 0 }];
  for (let k = 0; k <= steps.length; k++) {
    if (k === BEFORE_TIGHT + 1) levels.push({ icons: true, tight: true, steps: k - 1 });
    levels.push({ icons: true, tight: k > BEFORE_TIGHT, steps: k });
  }
  let level = 0;
  function show(n: number): void {
    const { icons, tight, steps: moved } = levels[n];
    root.classList.toggle("icons-only", icons);
    root.classList.toggle("tight", tight);
    steps.forEach((step, i) => {
      for (const item of step) item.el.classList.toggle("moved", i < moved);
    });
    // A group with everything in it moved goes too, and its dividing line with it.
    for (const g of groups) g.classList.toggle("moved", [...g.children].every((c) => c.classList.contains("moved")));
    group.hidden = moved === 0;
    level = n;
  }

  // From where the bar is now, a step at a time, so a small change measures
  // once or twice. Each state is narrower than the one before.
  function fit(): void {
    if (!root.clientWidth) return; // the start screen: no toolbar
    const before = level;
    if (fits()) {
      while (level > 0) {
        show(level - 1);
        if (!fits()) {
          show(level + 1);
          break;
        }
      }
    } else {
      while (level < levels.length - 1 && !fits()) show(level + 1);
    }
    // Menus opened from what moved would point at nothing.
    if (level !== before) closeMenus();
  }

  // When the window's width changes (and when the bar first shows). The bar's
  // own height never changes, so measuring here can't set off another round.
  let width = -1;
  new ResizeObserver((records) => {
    const w = Math.round(records[records.length - 1].contentRect.width);
    if (w === width) return;
    width = w;
    fit();
  }).observe(root);
  void document.fonts.ready.then(() => fit());
}
