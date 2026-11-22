// The toolbar's menus: Insert, Table and Export, and More, which holds the
// buttons there's no room for; and a comment card's More actions (Edit and
// Delete). One way to open, move through and close them, in the app's popover
// style.
//
// Opened with the keyboard (Return or Space on its button), a menu's first
// item takes the keyboard: Up and Down move (round from the end), Home and End
// go to the ends, Right opens a menu inside it (More's Insert, say) and Left
// closes that again, Escape closes with the keyboard back on the menu's button, Tab leaves. Opened with the mouse, the
// keyboard stays in the document. After a choice the keyboard goes back to the
// document, unless the choice took it somewhere (the link editor, a dialog).
import { ICONS } from "./icons";

export interface MenuEntry {
  label: string;
  /** Drawn before the words, as on the item's toolbar button. */
  icon?: string;
  /** The keys that do the same, as the button's tooltip names them ("⌘B"). */
  shortcut?: string;
  /** The first of a new group: a line goes before it. */
  separatorBefore?: boolean;
  /** Greyed out when false. */
  enabled?: boolean;
  /** For an item that can be ticked: whether it is. */
  checked?: boolean;
  /** One of several choices, like the two views, rather than on or off. */
  radio?: boolean;
  /** Chosen: `keyboard` says whether by keys (Return or Space) or the mouse. */
  run?: (keyboard: boolean) => void;
  /** A menu of its own, opened beside this one. */
  submenu?: PopupMenu;
}

/** The menus open now, outermost first: a menu, and any opened from it. */
const chain: PopupMenu[] = [];

function closeAll(): void {
  chain[0]?.close();
}

export class PopupMenu {
  readonly el: HTMLDivElement;
  private items: { entry: MenuEntry; button: HTMLButtonElement }[] = [];
  private opener: HTMLElement | null = null;
  private parent: PopupMenu | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    label: string,
    private readonly entries: () => MenuEntry[],
    /** Put the keyboard back in the document. */
    private readonly home: () => void,
  ) {
    this.el = document.createElement("div");
    this.el.className = "menu";
    this.el.setAttribute("role", "menu");
    this.el.setAttribute("aria-label", label);
    this.el.hidden = true;
    this.el.addEventListener("keydown", (e) => this.key(e));
    // A greyed-out item leaves the keyboard where it is, as the toolbar's greyed-out buttons do.
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target instanceof Element && e.target.closest(":disabled")) e.preventDefault();
    });
    // On the way from an item to the menu it opened, the pointer may cross another item.
    this.el.addEventListener("pointerenter", () => this.parent?.stopTimer());
    document.body.append(this.el);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  openerContains(node: Node): boolean {
    return !!this.opener?.contains(node);
  }

  goHome(): void {
    this.home();
  }

  /**
   * Open under its button, or, from another menu, beside the item it was
   * chosen from. With the keyboard, its first item takes the keyboard.
   */
  open(opener: HTMLElement, options: { keyboard?: boolean; from?: PopupMenu } = {}): void {
    const from = options.from ?? null;
    if (from) chain[chain.indexOf(from) + 1]?.close();
    else closeAll();
    this.opener = opener;
    this.parent = from;
    this.render();
    document.body.append(this.el); // last, so it's above the menu it was opened from where they meet
    this.el.hidden = false;
    chain.push(this);
    opener.setAttribute("aria-expanded", "true");
    this.place();
    if (options.keyboard) this.enabledButtons()[0]?.focus();
  }

  /** Close this menu and any opened from it. */
  close(): void {
    if (!this.isOpen) return;
    const at = chain.indexOf(this);
    for (const menu of at >= 0 ? chain.splice(at).reverse() : [this]) {
      menu.stopTimer();
      menu.el.hidden = true;
      menu.opener?.setAttribute("aria-expanded", "false");
    }
  }

  /** What an item shows may have changed (an agent took the document, say): show it as it is now. */
  refresh(): void {
    if (this.isOpen) this.render();
  }

  private render(): void {
    const entries = this.entries();
    // The same items as before (only their state changed): update them in place, keeping the keyboard where it is.
    if (entries.length === this.items.length && entries.every((e, i) => e.label === this.items[i].entry.label)) {
      entries.forEach((entry, i) => this.update(this.items[i].button, entry));
      this.items = entries.map((entry, i) => ({ entry, button: this.items[i].button }));
      return;
    }
    const rich = entries.some((e) => e.icon || e.checked !== undefined || e.shortcut || e.submenu);
    const ticks = entries.some((e) => e.checked !== undefined);
    this.el.classList.toggle("menu-rich", rich);
    this.el.replaceChildren();
    this.items = entries.map((entry) => {
      if (entry.separatorBefore && this.el.childElementCount) {
        const line = document.createElement("div");
        line.className = "menu-separator";
        this.el.append(line);
      }
      const b = document.createElement("button");
      b.type = "button";
      if (rich) {
        // Words, then the keys; a tick before, as in the Mac's menus.
        b.setAttribute("aria-label", entry.label);
        const part = (className: string, html = "") => {
          const span = document.createElement("span");
          span.className = className;
          span.innerHTML = html;
          span.setAttribute("aria-hidden", "true");
          b.append(span);
          return span;
        };
        if (ticks) part("menu-tick");
        part("menu-icon", entry.icon ?? "");
        part("menu-label").textContent = entry.label;
        part("menu-key").textContent = entry.shortcut ?? "";
        if (entry.submenu) part("menu-sub", ICONS.chevronRight);
      } else {
        b.textContent = entry.label;
      }
      if (entry.submenu) b.setAttribute("aria-haspopup", "menu");
      b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the cursor in the document
      b.addEventListener("click", (e) => this.choose(b, e.detail === 0));
      b.addEventListener("pointerenter", () => this.hover(b));
      this.update(b, entry);
      this.el.append(b);
      return { entry, button: b };
    });
  }

  private update(b: HTMLButtonElement, entry: MenuEntry): void {
    b.setAttribute("role", entry.checked === undefined ? "menuitem" : entry.radio ? "menuitemradio" : "menuitemcheckbox");
    if (entry.checked === undefined) b.removeAttribute("aria-checked");
    else b.setAttribute("aria-checked", String(entry.checked));
    const tick = b.querySelector(".menu-tick");
    if (tick) tick.innerHTML = entry.checked ? ICONS.check : "";
    const key = b.querySelector(".menu-key");
    if (key) key.textContent = entry.shortcut ?? "";
    b.disabled = entry.enabled === false;
    if (entry.submenu) b.setAttribute("aria-expanded", String(entry.submenu.isOpen && entry.submenu.opener === b));
  }

  private entryOf(b: HTMLButtonElement): MenuEntry | null {
    return this.items.find((i) => i.button === b)?.entry ?? null;
  }

  private choose(b: HTMLButtonElement, keyboard: boolean): void {
    const entry = this.entryOf(b);
    if (!entry || b.disabled) return;
    if (entry.submenu) {
      this.stopTimer();
      entry.submenu.open(b, { from: this, keyboard });
      return;
    }
    const home = chain[0]?.home ?? this.home;
    closeAll();
    entry.run?.(keyboard);
    const now = document.activeElement;
    if (!now || now === document.body || now.closest(".menu, .toolbar")) home();
  }

  // The pointer resting on an item opens its menu, or closes another item's.
  private hover(b: HTMLButtonElement): void {
    const entry = this.entryOf(b);
    if (!entry) return;
    this.stopTimer();
    const child = chain[chain.indexOf(this) + 1];
    if (entry.submenu && !b.disabled) {
      if (child === entry.submenu) return;
      const sub = entry.submenu;
      this.timer = setTimeout(() => sub.open(b, { from: this }), 150);
    } else if (child) {
      this.timer = setTimeout(() => child.close(), 300);
    }
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private enabledButtons(): HTMLButtonElement[] {
    return this.items.map((i) => i.button).filter((b) => !b.disabled);
  }

  private key(e: KeyboardEvent): void {
    const buttons = this.enabledButtons();
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const focused = at >= 0 ? buttons[at] : null;
    const go = (b: HTMLButtonElement | undefined) => b?.focus();
    switch (e.key) {
      case "ArrowDown":
        go(buttons[(at + 1) % buttons.length]);
        break;
      case "ArrowUp":
        go(buttons[at <= 0 ? buttons.length - 1 : at - 1]);
        break;
      case "Home":
        go(buttons[0]);
        break;
      case "End":
        go(buttons[buttons.length - 1]);
        break;
      case "ArrowRight": {
        const sub = focused ? this.entryOf(focused)?.submenu : null;
        if (sub && focused) sub.open(focused, { from: this, keyboard: true });
        break;
      }
      case "ArrowLeft":
      case "Escape":
        if (this.parent) {
          const item = this.opener;
          this.close();
          item?.focus();
        } else if (e.key === "Escape") {
          // Back on the button that opened it, as Mac menus leave it (roadmap Batch 12, G-9), so Space or Return opens
          // it again; the document only if that button has gone meanwhile.
          const opener = this.opener;
          this.close();
          if (opener?.isConnected && opener.checkVisibility()) opener.focus();
          else this.home();
        }
        break;
      case "Tab":
        // Leaving the menu: the keyboard moves on from its button, as from any other.
        chain[0]?.opener?.focus();
        closeAll();
        return;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  /**
   * Under its button (above it, if it doesn't fit below: a card's "⋯" near
   * the bottom of the window), or beside the item it came from; always inside
   * the window.
   */
  private place(): void {
    const menu = this.el;
    menu.style.maxHeight = "";
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const opener = this.opener!.getBoundingClientRect();
    let left: number;
    let top: number;
    if (this.parent) {
      const beside = this.parent.el.getBoundingClientRect();
      left = beside.right - 4 + width <= innerWidth - 8 ? beside.right - 4 : beside.left - width + 4;
      top = Math.min(opener.top - 5, innerHeight - 8 - height);
    } else {
      const below = opener.bottom + 4;
      const above = opener.top - 4 - height;
      left = Math.min(opener.left, innerWidth - width - 8);
      top = below + height > innerHeight - 8 && above >= 8 ? above : below;
    }
    top = Math.max(8, top);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${top}px`;
    // A window too short for the whole menu: it scrolls inside.
    menu.style.maxHeight = `${innerHeight - top - 8}px`;
  }
}

// Clicking anywhere else closes the menus; so does Escape while the keyboard is
// still where it was (a menu opened with the mouse). That Escape is the menu's
// alone: a comment box or a reply with the keyboard doesn't also act on it,
// and the keyboard stays there.
document.addEventListener("mousedown", (e) => {
  const target = e.target as Node;
  if (!chain.length || chain.some((m) => m.el.contains(target)) || chain[0].openerContains(target)) return;
  closeAll();
});
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Escape" || !chain.length || chain.some((m) => m.el.contains(e.target as Node))) return;
    e.preventDefault();
    e.stopPropagation();
    const root = chain[0];
    closeAll();
    // On a toolbar button (brought there by F6 or Tab while the menu was open), the keyboard stays: sent to the page,
    // the next Space would type there (review of Batch 12, B12-10).
    const now = document.activeElement;
    if (!now || now === document.body || now.closest(".menu")) root.goHome();
  },
  true,
);

/** Show every open menu as things are now. */
export function refreshOpenMenus(): void {
  for (const menu of chain) menu.refresh();
}

/** Close every open menu (the toolbar changed under them). */
export function closeMenus(): void {
  closeAll();
}
