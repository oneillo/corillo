// A link or picture written by label ("[the site][s]") takes its address from
// the document's "[s]: https://..." line. The page reads that address when the
// document is read; when the line is then edited on the page, the window looks
// the address up again where it's used (Command-click, the link box, Copy), so
// it's the one the file now gives, with nothing in the document changed
// (code review of Batch 16, W16-3).
import MarkdownIt from "markdown-it";
import { Fragment, Slice, type Mark, type Node } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { schema } from "../core/schema";

const md = new MarkdownIt("default", { html: true, linkify: false, typographer: false });

/** The addresses one block of the document's lines defines, by label (read once per block). */
const readIn = new WeakMap<Node, Map<string, string>>();

function addressesIn(block: Node): Map<string, string> {
  let found = readIn.get(block);
  if (!found) {
    found = new Map();
    const env: { references?: Record<string, { href: string }> } = {};
    if (block.textContent.includes("]:")) md.parse(block.textContent, env);
    for (const [label, ref] of Object.entries(env.references ?? {})) found.set(label, ref.href);
    readIn.set(block, found);
  }
  return found;
}

/** The addresses a document now gives its labels: each from the first of its lines that defines it (read once per document). */
const definedIn = new WeakMap<Node, Map<string, string>>();

function addressesOf(doc: Node): Map<string, string> {
  let all = definedIn.get(doc);
  if (!all) {
    all = new Map();
    for (let k = 0; k < doc.childCount; k++) {
      const child = doc.child(k);
      if (child.type !== schema.nodes.raw_block) continue;
      for (const [label, href] of addressesIn(child)) if (!all.has(label)) all.set(label, href);
    }
    definedIn.set(doc, all);
  }
  return all;
}

/** A link's address as the document gives it now: by its label while that's defined, else as it was read. */
export function linkAddress(doc: Node, attrs: { href: string; ref?: string | null }): string {
  if (!attrs.ref) return attrs.href;
  return addressesOf(doc).get(md.utils.normalizeReference(attrs.ref)) ?? attrs.href;
}

/** The address of a link on a page (`link`, an `a` the view drew), as the document gives it now. */
export function addressOfLinkIn(view: EditorView, link: Element): string {
  const written = link.getAttribute("href") ?? "";
  let pos: number;
  try {
    pos = view.posAtDOM(link, 0);
  } catch {
    return written;
  }
  const node = view.state.doc.nodeAt(pos);
  const mark = node && schema.marks.link.isInSet(node.marks);
  return mark ? linkAddress(view.state.doc, mark.attrs as { href: string; ref: string | null }) : written;
}

/** Copied content with each link by label given the address the document gives it now. */
export function withAddresses(slice: Slice, doc: Node): Slice {
  const type = schema.marks.link;
  const fix = (content: Fragment): Fragment => {
    let changed = false;
    const nodes: Node[] = [];
    content.forEach((node) => {
      let next = node;
      if (node.isText) {
        const mark = type.isInSet(node.marks);
        const href = mark?.attrs.ref ? linkAddress(doc, mark.attrs as { href: string; ref: string }) : null;
        if (mark && href !== null && href !== mark.attrs.href) next = node.mark(type.create({ ...mark.attrs, href }).addToSet(node.marks.filter((m: Mark) => m !== mark)));
      } else if (node.content.size) {
        const inner = fix(node.content);
        if (inner !== node.content) next = node.copy(inner);
      }
      if (next !== node) changed = true;
      nodes.push(next);
    });
    return changed ? Fragment.fromArray(nodes) : content;
  };
  const content = fix(slice.content);
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
}
