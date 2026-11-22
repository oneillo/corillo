// Which links a document has, for the check that the window opens only links
// that are in its document (see app:open-link and obsidian:open-note in
// main.ts). The document's text is read here the way the window reads it, so
// both sides agree on what's a link.
import MarkdownIt from "markdown-it";
import type { Node } from "prosemirror-model";
import { parseMarkdown } from "../core/markdown";
import { findObsidian } from "../core/obsidian";
import { PICTURE_STAND_IN } from "../core/doc-diff";

// Only its way of writing an address is used: the reader spells a saved link
// this way (`Q3 plan.md` as `Q3%20plan.md`, `Café` as `Caf%C3%A9`), while a
// link made a moment ago in the window is still as it was typed.
const reader = new MarkdownIt();

/** A link's address in one form, however it's written: spaces, accents and %20 alike. */
export function linkKey(href: string): string {
  return reader.normalizeLink(href.trim());
}

/** The addresses of the links in a document's text, each as linkKey gives it. */
export function linksIn(text: string): Set<string> {
  const links = new Set<string>();
  parseMarkdown(text).doc.descendants((node) => {
    for (const mark of node.marks) if (mark.type.name === "link" && typeof mark.attrs.href === "string") links.add(linkKey(mark.attrs.href));
  });
  return links;
}

/** A paragraph's or heading's text as the window looks for note links in it: code, and anything that isn't text, hidden. */
function blockText(block: Node): string {
  let text = "";
  block.forEach((child) => {
    if (child.isText) text += child.marks.some((m) => m.type.name === "code") ? PICTURE_STAND_IN.repeat(child.text!.length) : child.text;
    else text += child.type.name === "hard_break" ? "\n" : PICTURE_STAND_IN.repeat(child.nodeSize);
  });
  return text;
}

/**
 * The notes a document links to or embeds ([[Plan]], ![[Plan]]), found one
 * block at a time as the window finds them: a stray %% in one paragraph
 * doesn't hide a link in the next.
 */
export function notesIn(text: string): Set<string> {
  const notes = new Set<string>();
  parseMarkdown(text).doc.descendants((node) => {
    if (!node.isTextblock) return true;
    if (!node.type.spec.code) {
      for (const f of findObsidian(blockText(node))) if ((f.kind === "link" || f.kind === "embed") && f.link?.path) notes.add(f.link.path);
    }
    return false;
  });
  return notes;
}
