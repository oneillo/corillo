// Obsidian's syntax, shown the way Obsidian shows it, without changing the
// text: links to notes look like links, highlights are highlighted, callouts
// are coloured boxes with a title, tags are small and quiet, comments and
// block ids are faint. In the editor the marks around them ([[ ]], ==, [!note])
// stay visible but faint, so the cursor never lands in hidden text; in the
// preview and in exports (reading: true) they're hidden, and comments with them.
//
// Embedded pictures (![[chart.png]]) are shown above their ![[...]] once Corillo
// finds them (see main/vault.ts for where it looks). Cmd-click on a link to a
// note opens the note.
//
// Like footnote numbers, the marks are worked out per top-level block and
// only redone for the blocks an edit touched, so typing stays quick; a picture
// found redoes only the blocks that embed it.
import { Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { Node } from "prosemirror-model";
import { calloutColour, calloutOf, findObsidian, isPicture, linkText, type Link } from "../core/obsidian";
import { changedRanges } from "./changed-ranges";
import { followPicture, onLookAgain, sizeAsInWord, unfollowPicture } from "./images";
import { PICTURE_STAND_IN } from "../core/doc-diff";

export interface ObsidianOptions {
  /** The preview and exports: the marks are hidden, and comments too. */
  reading: boolean;
  /** Where an embedded picture is, as an address to show it from, or null. */
  findPicture?(name: string): Promise<string | null>;
  /** Open the note a link points to (Cmd-click). */
  openNote?(target: string): void;
}

interface State {
  decorations: DecorationSet;
}

const key = new PluginKey<State>("obsidian");

/** The block's text as findObsidian reads it: code and anything that isn't text hidden. */
function textOf(block: Node): string {
  let text = "";
  block.forEach((child) => {
    if (child.isText) text += child.marks.some((m) => m.type.name === "code") ? PICTURE_STAND_IN.repeat(child.text!.length) : child.text;
    else text += child.type.name === "hard_break" ? "\n" : PICTURE_STAND_IN.repeat(child.nodeSize);
  });
  return text;
}

/** What the decorations need besides the document: the options, and the pictures found so far. */
interface Context {
  options: ObsidianOptions;
  pictures: Map<string, string | null | "looking">;
  /** Draw the blocks that embed this picture again, once it's found (or looked for again). */
  redraw(name: string): void;
}

// The pictures each top-level block embeds, by name. A block nobody edited is
// the same object as before, so its entry stays good.
const embedsIn = new WeakMap<Node, Set<string>>();

/** An embedded picture, drawn after its ![[...]]. */
function picture(url: string, link: Link): () => HTMLElement {
  return () => {
    const img = document.createElement("img");
    img.className = "ob-embed-picture";
    img.src = url;
    img.alt = link.alias ?? linkText(link);
    img.draggable = false;
    // Sized as in Word: a width in pixels is 3/4 of a point, as Pandoc reads it.
    const size = () =>
      sizeAsInWord(img, img, link.size ? { width: link.size.width * 0.75, height: link.size.height ? link.size.height * 0.75 : undefined } : {});
    size();
    // Shown afresh if it's written again on disk (see images.ts).
    followPicture(img, url, size);
    return img;
  };
}

/** The marks for one textblock that starts at pos. */
function textblockDecorations(block: Node, pos: number, cx: Context, out: Decoration[], embeds: Set<string>): void {
  const { options, pictures } = cx;
  if (block.type.spec.code) return;
  const text = textOf(block);
  if (!/[[=#%^$]/.test(text)) return;
  const at = (offset: number) => pos + 1 + offset;
  const faint = (from: number, to: number) => {
    if (to > from) out.push(Decoration.inline(at(from), at(to), { class: "ob-syntax" }));
  };
  for (const f of findObsidian(text)) {
    const { from, to } = f;
    if (f.kind === "link" || f.kind === "embed") {
      const link = f.link!;
      const isPic = f.kind === "embed" && isPicture(link.path);
      const shown = link.shown;
      const attrs: Record<string, string> = { class: isPic ? "ob-embed ob-picture" : f.kind === "embed" ? "ob-embed" : "ob-link" };
      if (isPic) attrs.title = link.path;
      else if (link.path) {
        attrs["data-note"] = link.path;
        attrs.title = `${linkText({ ...link, alias: null })} (Cmd-click to open)`;
      }
      out.push(Decoration.inline(at(from), at(to), attrs));
      faint(from, from + shown[0]);
      faint(from + shown[1], to);
      if (isPic) {
        embeds.add(link.path);
        const found = pictures.get(link.path);
        if (found === undefined && options.findPicture) {
          pictures.set(link.path, "looking");
          const settle = (url: string | null) => {
            pictures.set(link.path, url);
            cx.redraw(link.path);
          };
          // A lookup that fails is as good as not found: it's looked for again later.
          options.findPicture(link.path).then(settle, () => settle(null));
        }
        if (found && found !== "looking") {
          const size = `${link.size?.width ?? ""}x${link.size?.height ?? ""}`;
          // Above its ![[...]], which reads like a caption while editing (and nothing is left after it on the line).
          out.push(
            Decoration.widget(at(from), picture(found, link), {
              side: -1,
              key: `pic ${found} ${size}`,
              ignoreSelection: true,
              destroy: (node) => unfollowPicture(node as HTMLElement),
            }),
          );
          if (options.reading) out.push(Decoration.inline(at(from), at(to), { class: "ob-hide" }));
        } else if (found === null) {
          out.push(Decoration.inline(at(from), at(to), { class: "ob-missing", title: `Corillo can't find ${link.path}` }));
        }
      }
    } else if (f.kind === "highlight") {
      out.push(Decoration.inline(at(from), at(to), { class: "ob-highlight" }));
      faint(from, from + 2);
      faint(to - 2, to);
    } else if (f.kind === "tag") {
      out.push(Decoration.inline(at(from), at(to), { class: "ob-tag", spellcheck: "false" }));
    } else if (f.kind === "comment") {
      out.push(Decoration.inline(at(from), at(to), { class: "ob-comment" }));
    } else if (f.kind === "blockid") {
      out.push(Decoration.inline(at(from), at(to), { class: "ob-blockid", spellcheck: "false" }));
    } else if (f.kind === "math") {
      out.push(Decoration.inline(at(from), at(to), { spellcheck: "false" }));
    }
  }
}

/** A quote that starts with [!type] is a callout: a coloured box, its first line the title. */
function calloutDecorations(quote: Node, pos: number, options: ObsidianOptions, out: Decoration[]): void {
  const first = quote.firstChild;
  if (!first || first.type.name !== "paragraph") return;
  const text = textOf(first);
  const line = text.split("\n")[0];
  const callout = calloutOf(line);
  if (!callout) return;
  out.push(
    Decoration.node(pos, pos + quote.nodeSize, {
      class: `ob-callout ob-callout-${calloutColour(callout.type)}`,
      "data-callout": callout.type,
      ...(callout.fold ? { "data-fold": callout.fold } : {}),
    }),
  );
  const start = pos + 2; // inside the quote, inside its first paragraph
  const titled = line.length > callout.markerEnd;
  // Without a title of its own, the type is shown as the title, as in Obsidian: drawn
  // after the faint [!type] while editing (never part of the text), as words when reading.
  const marker = titled ? { class: "ob-syntax ob-callout-marker" } : { class: "ob-syntax ob-callout-marker ob-untitled", "data-title": callout.shownTitle };
  out.push(Decoration.inline(start, start + callout.markerEnd, marker));
  if (titled) {
    out.push(Decoration.inline(start + callout.markerEnd, start + line.length, { class: "ob-callout-title" }));
  } else if (options.reading) {
    out.push(
      Decoration.widget(
        start + callout.markerEnd,
        () => {
          const title = document.createElement("span");
          title.className = "ob-callout-title";
          title.textContent = callout.shownTitle;
          return title;
        },
        { side: 1, key: `title ${callout.shownTitle}` },
      ),
    );
  }
}

function blockDecorations(block: Node, start: number, cx: Context, out: Decoration[]): void {
  const embeds = new Set<string>();
  const visit = (node: Node, pos: number) => {
    if (node.type.name === "blockquote") calloutDecorations(node, pos, cx.options, out);
    if (node.isTextblock) textblockDecorations(node, pos, cx, out, embeds);
    else node.forEach((child, offset) => visit(child, pos + 1 + offset));
  };
  visit(block, start);
  if (embeds.size) embedsIn.set(block, embeds);
  else embedsIn.delete(block);
}

function build(doc: Node, cx: Context): State {
  const decos: Decoration[] = [];
  doc.forEach((block, offset) => blockDecorations(block, offset, cx, decos));
  return { decorations: DecorationSet.create(doc, decos) };
}

/** Redo the marks of the top-level blocks this says to. */
function redo(doc: Node, decorations: DecorationSet, cx: Context, which: (block: Node, start: number, end: number) => boolean): State {
  doc.forEach((block, start) => {
    const end = start + block.nodeSize;
    if (!which(block, start, end)) return;
    const stale = decorations.find(start, end).filter((d) => d.from >= start && d.to <= end);
    const fresh: Decoration[] = [];
    blockDecorations(block, start, cx, fresh);
    if (stale.length) decorations = decorations.remove(stale);
    if (fresh.length) decorations = decorations.add(doc, fresh);
  });
  return { decorations };
}

function update(tr: Transaction, old: State, cx: Context): State {
  const ranges = changedRanges(tr);
  if (!ranges) return build(tr.doc, cx);
  const decorations = old.decorations.map(tr.mapping, tr.doc);
  return redo(tr.doc, decorations, cx, (_b, start, end) => ranges.some(([from, to]) => from <= end && to >= start));
}

/** Pictures found (or to look for again): redo the blocks that embed them. */
function afterFinding(doc: Node, old: State, cx: Context, names: Set<string>): State {
  return redo(doc, old.decorations, cx, (block) => {
    const embeds = embedsIn.get(block);
    return !!embeds && [...names].some((name) => embeds.has(name));
  });
}

// Where a document's embedded pictures are ---------------------------------------

/** How long a picture not found is looked for only in its likely places before the vault is searched for it again. */
export const SEARCH_AGAIN_MS = 60_000;
/** Names remembered at most (the oldest go first): typing names in ![[...]] can't make the list grow without end. */
const MAX_NAMES = 500;

export interface PictureLookup {
  /** Look for a picture as Corillo does: its likely places, then the whole vault (main/vault.ts). */
  search(name: string): Promise<string | null>;
  /** The likely places only: the file addresses to ask about, in the order vault.ts looks there. */
  near(name: string): string[];
  /** Whether each file is there (null: it isn't), one question for all. */
  stamps(urls: string[]): Promise<(string | null)[]>;
  now?(): number;
}

interface Known {
  answer: Promise<string | null>;
  /** The address found, null for not found; undefined while being looked for. */
  found?: string | null;
  /** When the vault was last searched for it (0: the search failed, so it's searched again next time). */
  searched: number;
  /** The likely places being looked at, while they are. */
  nearby?: Promise<string | null> | null;
}

/**
 * Where a document's embedded pictures are, one answer per name for every
 * page that shows them (the editor, the preview, each time the text is shown
 * afresh). A picture found is kept. One not found is looked for again at the
 * moments Corillo looks at pictures again (an agent's change, a pass ending,
 * the window coming back to the front), in its likely places only (beside the
 * document, its pictures folder, an attachments folder beside it); the whole
 * vault is searched for it again at most once a minute, so a note with
 * pictures still to come, in a big vault, doesn't walk the vault each time.
 */
export class EmbeddedPictures {
  private readonly known = new Map<string, Known>();

  constructor(private readonly lookup: PictureLookup) {}

  find(name: string): Promise<string | null> {
    const known = this.known.get(name);
    if (known && known.found !== null) return known.answer; // found, or being looked for
    const now = this.lookup.now?.() ?? Date.now();
    if (known && now - known.searched < SEARCH_AGAIN_MS) {
      if (!known.nearby) {
        const nearby = this.lookNear(known, name);
        known.nearby = nearby;
        void nearby.then(() => {
          if (known.nearby === nearby) known.nearby = null;
        });
      }
      return known.nearby;
    }
    const entry: Known = { answer: Promise.resolve(null), searched: now };
    entry.answer = this.lookup.search(name).then(
      (url) => (entry.found = url),
      () => {
        entry.searched = 0;
        return (entry.found = null);
      },
    );
    this.known.delete(name);
    this.known.set(name, entry);
    if (this.known.size > MAX_NAMES) this.known.delete(this.known.keys().next().value!);
    return entry.answer;
  }

  /** Forget every answer (the document moved to another folder): each is looked for afresh. */
  clear(): void {
    this.known.clear();
  }

  /** How many names are remembered (for tests). */
  get size(): number {
    return this.known.size;
  }

  private async lookNear(known: Known, name: string): Promise<string | null> {
    try {
      const urls = this.lookup.near(name);
      const stamps = urls.length ? await this.lookup.stamps(urls) : [];
      const at = stamps.findIndex((s) => s !== null);
      if (at < 0) return null;
      known.found = urls[at];
      known.answer = Promise.resolve(urls[at]);
      return urls[at];
    } catch {
      return null; // as good as not there: looked at again next time
    }
  }
}

/** The document moved to another folder: every embedded picture is looked for again, from there. */
export function lookForEmbedsAgain(view: EditorView): void {
  if (!view.isDestroyed && key.getState(view.state)) view.dispatch(view.state.tr.setMeta(key, { again: true }));
}

export function obsidianPlugin(options: ObsidianOptions): Plugin<State> {
  let shown: EditorView | null = null;
  // Pictures found since the page was last drawn: drawn together, once.
  let pending: Set<string> | null = null;
  const cx: Context = {
    options,
    pictures: new Map(),
    redraw: (name) => {
      if (pending) return void pending.add(name);
      pending = new Set([name]);
      queueMicrotask(() => {
        const names = pending!;
        pending = null;
        if (shown && !shown.isDestroyed && key.getState(shown.state)) shown.dispatch(shown.state.tr.setMeta(key, { found: names }));
      });
    },
  };
  return new Plugin<State>({
    key,
    state: {
      init: (_c, state) => build(state.doc, cx),
      apply: (tr, old) => {
        const meta = tr.getMeta(key) as { found?: Set<string>; again?: true } | undefined;
        if (meta?.again) {
          cx.pictures.clear();
          return build(tr.doc, cx);
        }
        const state = tr.docChanged ? update(tr, old, cx) : old;
        return meta?.found ? afterFinding(tr.doc, state, cx, meta.found) : state;
      },
    },
    view(view) {
      shown = view;
      // When Corillo looks at pictures again (see images.ts), embedded pictures
      // not found before are looked for again: they may have appeared.
      const stop = onLookAgain(() => {
        for (const [name, found] of cx.pictures) {
          if (found !== null) continue;
          cx.pictures.delete(name);
          cx.redraw(name);
        }
      });
      return {
        destroy: () => {
          stop();
          if (shown === view) shown = null;
        },
      };
    },
    props: {
      decorations(state) {
        return key.getState(state)?.decorations;
      },
      attributes: { class: options.reading ? "ob-reading" : "ob-editing" },
      handleDOMEvents: {
        // Cmd-click on a link to a note opens it, as Cmd-click opens a web link.
        click: (_view, event) => {
          if (!options.openNote || !(event.metaKey || event.ctrlKey)) return false;
          const link = (event.target as HTMLElement).closest?.("[data-note]") as HTMLElement | null;
          if (!link?.dataset.note) return false;
          options.openNote(link.dataset.note);
          event.preventDefault();
          return true;
        },
      },
    },
  });
}
