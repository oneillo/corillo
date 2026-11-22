// A short notice from Corillo itself. One about an open document (its
// records set aside, a link it won't open, a pasted picture it couldn't
// keep, Show changes that couldn't work out the marks) belongs to that
// document's tab, as its export notice does (roadmap Batch 6, item 2): it
// goes when another tab comes to the front, is there again on coming back,
// and goes with the tab when it closes. The rest are the window's: a document
// closed because it went to the Trash, the window reopened, agents' tools
// updated. Each looks like the export notice; it stays until closed, or the
// next one in its place replaces it.
//
// They lie in a band above the status bar, the width of the window, never
// over the page or a panel (roadmap Batch 11, F-17): the page and its panel
// end above it, so no words are ever under one.
import { ICONS } from "./icons";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

/**
 * Where a place's notices stack, above the status bar: a tab's (the foot of
 * its element, under its page and panel), or the window's (just above the
 * status bar, under the tab's). A tab's export notice and this kind share
 * it, so two never sit on top of each other.
 */
export function cornerOf(place: HTMLElement): HTMLElement {
  let corner = place.querySelector<HTMLElement>(":scope > .corner-notices");
  if (!corner) {
    const windows = place === document.body;
    corner = el("div", windows ? "corner-notices window-notices" : "corner-notices");
    if (windows) place.insertBefore(corner, place.querySelector(":scope > .status-bar"));
    else place.append(corner);
  }
  return corner;
}

export class FileNotice {
  private el = el("div", "file-notice");
  private text = el("span", "export-notice-text");
  private detail = el("span", "export-notice-detail");

  constructor(place: HTMLElement) {
    this.el.hidden = true;
    this.el.setAttribute("role", "status");
    this.el.dataset.state = "done";
    const words = el("div", "export-notice-words");
    words.append(this.text, this.detail);
    const close = el("button", "export-notice-close");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = ICONS.close;
    close.addEventListener("click", () => (this.el.hidden = true));
    this.el.append(el("span", "export-notice-dot"), words, close);
    cornerOf(place).append(this.el);
  }

  show(text: string, detail: string): void {
    this.text.textContent = text;
    this.detail.textContent = detail;
    this.el.hidden = false;
  }

  /** Take the notice away if it's still the one that starts with these words (a later one in its place stays). */
  hideIf(start: string): void {
    if (this.text.textContent?.startsWith(start)) this.el.hidden = true;
  }
}

/** Each place's notice, made the first time it has something to say (a tab's goes with its element). */
const notices = new WeakMap<HTMLElement, FileNotice>();

/** The notice of this tab (its element), or of the window (document.body). */
export function noticeOn(place: HTMLElement): FileNotice {
  let n = notices.get(place);
  if (!n) notices.set(place, (n = new FileNotice(place)));
  return n;
}
