// The start screen's recent documents, as cards: a small, live preview of the
// top of each document as it reads in Corillo, its name, its folder and when
// it last changed. Click or Enter opens one; the arrow keys move between them.
// Each says where it stands ("3 comments waiting for you"), and those waiting
// for the person come first. A document that can't be found (moved where
// Corillo can't follow it, or deleted) gets a plain card that says so, with
// Find it… to show where it is now.
//
// Previews come from the files as they are now, read by the main process each
// time the start screen shows (and when the window comes back to the front).
// They're drawn with the editor's own reading of the Markdown, as plain
// elements: nothing in them runs, and nothing is fetched from the web.
import { DOMSerializer, type DOMOutputSpec, type Node } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { parseMarkdown } from "../core/markdown";
import { calloutColour, calloutOf } from "../core/obsidian";
import { schema } from "../core/schema";
import { footnoteNumbers } from "./footnotes";
import { namesList, notSentWords, waitingParts } from "./comment-format";
import type { CorilloApi, RecentCard } from "../preload/preload";
import { shownName } from "../core/doc-names";
import { PICTURE_STAND_IN } from "../core/doc-diff";

type Standing = NonNullable<RecentCard["standing"]>;

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Where a closed document stands, under its card (roadmap Batch 4, item 3),
 * in the words its comment cards use once it's open: what waits for the
 * person ("3 comments waiting for you", counted as the done line counts it),
 * else the comments not sent ("2 comments for Claude, not sent yet"). The
 * tooltip has both. Null with nothing to say. `waiting`: something waits for
 * the person, so the card goes first.
 */
export function standingWords(s: Standing): { text: string; title: string; waiting: boolean } | null {
  const lines: string[] = [];
  const waiting = waitingParts(s.waiting);
  if (waiting) lines.push(upperFirst(`${waiting} waiting for you`));
  const named = Object.keys(s.notSent).filter(Boolean);
  const unnamed = s.notSent[""] ?? 0;
  const count = Object.values(s.notSent).reduce((a, b) => a + b, 0);
  if (count) {
    const comments = `${count} ${count === 1 ? "comment" : "comments"}`;
    // The card's own words ("For Claude, not sent yet"); with some for an agent and some for none, just "not sent yet".
    lines.push(named.length && unnamed ? `${comments} not sent yet` : `${comments} ${lowerFirst(notSentWords(named.length ? namesList(named) : null))}`);
  }
  if (!lines.length) return null;
  return { text: lines[0], title: lines.join(" · "), waiting: !!waiting };
}

/** The cards in the order the start screen shows them: documents waiting for the person first, each group in the list's order (most recent first). */
export function waitingFirst<T extends { standing: Standing | null }>(cards: T[]): T[] {
  const waits = (c: T) => !!c.standing && !!waitingParts(c.standing.waiting);
  return [...cards.filter(waits), ...cards.filter((c) => !waits(c))];
}

/** "Today", "Yesterday", "3 Nov", or "3 Nov 2025" for another year. */
export function whenLabel(time: number, now: number = Date.now(), locale?: string): string {
  if (!time) return "";
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfYesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime();
  if (time >= startOfToday) return "Today";
  if (time >= startOfYesterday) return "Yesterday";
  const then = new Date(time);
  const sameYear = then.getFullYear() === today.getFullYear();
  return new Intl.DateTimeFormat(locale, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }).format(then);
}

const base = DOMSerializer.fromSchema(schema);

/** A diagram's code block, by the same rule as diagrams.ts (not imported, so nothing of the diagram engine loads here). */
const isDiagram = (node: Node) => /^mermaid\b/.test(String(node.attrs.params ?? "").trim());

/**
 * A picture's address, if the preview may show it: a file on this Mac
 * (usually beside the document) or one written into the document itself.
 * Pictures on the web are left out, so the start screen never goes online.
 */
function localPicture(src: string, dirUrl: string): string | null {
  if (!src.trim()) return null;
  try {
    const url = new URL(src, dirUrl);
    return url.protocol === "file:" || url.protocol === "data:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Obsidian's callouts as the page shows them: the quote a tinted box, its
 * first line the title in bold, without the [!type] before it (and the type
 * as the title when it has none). Returns each callout's colour.
 */
function withCallouts(doc: Node): { doc: Node; colours: WeakMap<Node, string> } {
  const found: { pos: number; line: string }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "blockquote") return !node.isTextblock;
    const first = node.firstChild;
    if (first?.type.name === "paragraph") {
      // As obsidian.ts reads it: a line break ends the line, anything else not text is one character.
      const text = first.textBetween(0, first.content.size, "\n", (leaf) => (leaf.type.name === "hard_break" ? "\n" : PICTURE_STAND_IN));
      found.push({ pos, line: text.split("\n")[0] });
    }
    return true;
  });
  const colours = new WeakMap<Node, string>();
  const callouts = found.flatMap(({ pos, line }) => {
    const callout = calloutOf(line);
    return callout ? [{ pos, line, callout }] : [];
  });
  if (!callouts.length) return { doc, colours };
  const tr = EditorState.create({ doc }).tr;
  for (const { pos, line, callout } of callouts.reverse()) {
    const start = pos + 2; // inside the quote, inside its first paragraph
    const bold = [schema.marks.strong.create()];
    if (line.length > callout.markerEnd) tr.addMark(start + callout.markerEnd, start + line.length, bold[0]);
    else tr.insert(start + line.length, schema.text(callout.shownTitle, bold));
    tr.delete(start, start + callout.markerEnd);
  }
  for (const { pos, callout } of callouts) colours.set(tr.doc.nodeAt(tr.mapping.map(pos))!, calloutColour(callout.type));
  return { doc: tr.doc, colours };
}

/** The top of a document, drawn as the page draws it (diagrams and web pictures as plain boxes). */
export function renderPreview(markdown: string, dirUrl: string): DocumentFragment | HTMLElement {
  const { doc, colours } = withCallouts(parseMarkdown(markdown).doc);
  const numbers = footnoteNumbers(doc);
  const serializer = new DOMSerializer(
    {
      ...base.nodes,
      image: (node): DOMOutputSpec => {
        const src = localPicture(String(node.attrs.src ?? ""), dirUrl);
        return src ? ["img", { src, alt: "", loading: "lazy", decoding: "async" }] : ["span", { class: "preview-box" }];
      },
      code_block: (node): DOMOutputSpec => (isDiagram(node) ? ["div", { class: "preview-box diagram" }] : ["pre", ["code", 0]]),
      footnote_ref: (node): DOMOutputSpec => ["sup", { class: "footnote-ref" }, String(numbers.get(node.attrs.label) ?? "")],
      blockquote: (node): DOMOutputSpec =>
        colours.has(node) ? ["blockquote", { class: `ob-callout ob-callout-${colours.get(node)}` }, 0] : base.nodes.blockquote(node),
    },
    { ...base.marks, link: (): DOMOutputSpec => ["span", { class: "preview-link" }, 0] },
  );
  const drawn = serializer.serializeFragment(doc.content);
  // Bullets as small dots of Corillo's own: a list's own marks don't get smaller with the preview.
  for (const item of drawn.querySelectorAll("ul > li:not(.task)")) {
    const dot = document.createElement("span");
    dot.className = "preview-bullet";
    item.prepend(dot);
  }
  return drawn;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** What the start screen needs from the window around it. */
export interface StartScreenHost {
  api: CorilloApi;
  /** Where the recent documents go. */
  container: HTMLElement;
  /** Whether the start screen is showing (no document open). */
  showing: () => boolean;
}

/** The keyboard is on nothing (the tab it was in has closed, or the button it was on has gone). */
const keyboardFree = () => !document.activeElement || document.activeElement === document.body;

export function setUpStartScreen(host: StartScreenHost): { show: (keyboard?: boolean) => Promise<void> } {
  const { api, container } = host;
  let request = 0;
  /** What the cards drawn show (and the day, for "Today"), so they're drawn again only when it changes. */
  let drawn = "";
  /** Where the keyboard should be once the cards are drawn again. */
  let focusAfter: { path?: string; index?: number } | null = null;

  const focusables = () => [...container.querySelectorAll<HTMLElement>("[data-card]")];

  /**
   * Draw the cards. `keyboard`: the start screen has just come (or its list changed) with the keyboard on nothing, so
   * it goes to the first recent document, or to Open a document… when there is none (roadmap Batch 12, G-16).
   */
  async function show(keyboard = false): Promise<void> {
    const mine = ++request;
    const focused = focusables().find((e) => e === document.activeElement);
    if (focused && !focusAfter) focusAfter = { path: focused.dataset.card };
    const settleKeyboard = () => {
      if (keyboard && keyboardFree() && host.showing()) document.getElementById("open-document")?.focus();
    };
    let cards: RecentCard[];
    try {
      cards = await api.recentCards();
    } catch {
      return; // the list is a convenience: keep what's shown
    }
    if (mine !== request || !host.showing()) return;
    if (keyboard && keyboardFree() && !focusAfter) focusAfter = { index: 0 };
    const shows = JSON.stringify([new Date().toDateString(), cards]);
    if (shows === drawn && container.firstChild) {
      restoreFocus();
      return settleKeyboard();
    }
    drawn = shows;
    draw(cards);
    settleKeyboard();
  }

  function draw(cards: RecentCard[]): void {
    container.replaceChildren();
    container.style.setProperty("--count", String(cards.length));
    if (!cards.length) {
      focusAfter = null;
      return;
    }
    const head = el("div", "recent-head");
    const heading = el("h2", "", "Recent");
    heading.id = "recent-heading";
    const clear = el("button", "link-button", "Clear list");
    clear.type = "button";
    clear.addEventListener("click", () => void api.clearRecent());
    head.append(heading, clear);
    const list = el("ul", "recent-grid");
    list.setAttribute("aria-labelledby", "recent-heading");
    const now = Date.now();
    list.append(...waitingFirst(cards).map((card, index) => cardFor(card, index, now)));
    list.addEventListener("keydown", moveWithArrows);
    container.append(head, list);
    restoreFocus();
  }

  function cardFor(card: RecentCard, index: number, now: number): HTMLLIElement {
    const item = el("li", "recent-item");
    // Its name as the person knows it, without ".md" (roadmap Batch 5, item 2); the tooltip has the file's path.
    const shown = shownName(card.name);
    const name = el("span", "recent-name", shown);
    const folder = el("span", "recent-folder", card.folder);
    const meta = el("span", "recent-meta");
    meta.append(folder);
    const preview = el("span", "recent-preview");

    if (card.state === "ok") {
      const button = el("button", "recent-card");
      button.type = "button";
      button.dataset.card = card.path;
      button.title = card.path;
      const standing = card.standing && standingWords(card.standing);
      button.setAttribute("aria-label", `Open ${shown}, in ${card.folderName}${standing ? `, ${lowerFirst(standing.text)}` : ""}`);
      button.addEventListener("click", () => void api.openPath(card.path));
      // The preview is a picture of the page: not read out, not clickable.
      preview.inert = true;
      const page = el("span", "recent-page");
      if (card.head) page.append(renderPreview(card.head, card.dirUrl));
      preview.append(page);
      if (card.changed) {
        const when = el("span", "recent-when", whenLabel(card.changed, now));
        when.title = `Changed ${new Date(card.changed).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" })}`;
        meta.append(when);
      }
      button.append(preview, name);
      if (standing) {
        const state = el("span", standing.waiting ? "recent-state waiting" : "recent-state", standing.text);
        state.title = standing.title;
        button.append(state);
      }
      button.append(meta);
      item.append(button);
      return item;
    }

    // Moved, deleted or unreadable: say so, and offer to take it off the list.
    const box = el("div", "recent-card gone");
    box.title = card.path;
    preview.append(el("span", "recent-gone", card.state === "missing" ? "Can't be found" : "Can't be read"));
    preview.append(
      el(
        "span",
        "recent-gone-hint",
        card.state === "missing" ? "It may have been moved, renamed or deleted." : "Corillo can't open it right now.",
      ),
    );
    const actions = el("span", "recent-gone-actions");
    // One that can't be found: the person can show Corillo where it is now (checked to be that document before its comments follow).
    if (card.state === "missing") {
      const find = el("button", "link-button", "Find it…");
      find.type = "button";
      find.dataset.card = card.path;
      find.setAttribute("aria-label", `Find ${shown}`);
      find.addEventListener("click", () => void api.findRecent(card.path));
      actions.append(find);
    }
    const remove = el("button", "link-button", "Remove from list");
    remove.type = "button";
    if (card.state !== "missing") remove.dataset.card = card.path;
    remove.setAttribute("aria-label", `Remove ${shown} from the list`);
    remove.addEventListener("click", () => {
      focusAfter = { index };
      void api.forgetRecent(card.path);
    });
    actions.append(remove);
    preview.append(actions);
    box.append(preview, name, meta);
    item.append(box);
    return item;
  }

  function restoreFocus(): void {
    const wanted = focusAfter;
    focusAfter = null;
    if (!wanted) return;
    const items = focusables();
    const target =
      (wanted.path !== undefined ? items.find((e) => e.dataset.card === wanted.path) : undefined) ??
      (wanted.index !== undefined ? items[Math.min(wanted.index, items.length - 1)] : undefined);
    target?.focus();
  }

  // Left and right go to the card before or after; up and down a row; Home and End to the ends.
  function moveWithArrows(e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const items = focusables();
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const tops = items.map((i) => Math.round(i.closest("li")!.getBoundingClientRect().top));
    const perRow = tops.filter((t) => t === tops[0]).length || 1;
    let to: number;
    switch (e.key) {
      case "ArrowLeft":
        to = at - 1;
        break;
      case "ArrowRight":
        to = at + 1;
        break;
      case "ArrowUp":
        to = at - perRow;
        break;
      case "ArrowDown":
        to = at + perRow;
        break;
      case "Home":
        to = 0;
        break;
      case "End":
        to = items.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    items[to]?.focus();
  }

  // Back at the front: the documents may have changed meanwhile (an agent at work, say).
  window.addEventListener("focus", () => {
    if (host.showing()) void show();
  });

  return { show };
}
