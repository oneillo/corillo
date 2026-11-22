// The document model Corillo edits. Built on the CommonMark schema from
// prosemirror-markdown, with extra attributes that remember how the Markdown
// was written (which bullet, which emphasis marker), and a raw block for
// anything the editor can't show richly yet, so it is kept exactly as written.
import { Schema, type NodeSpec, type MarkSpec, type Node as PMNode } from "prosemirror-model";
import { schema as base } from "prosemirror-markdown";
import { tableNodes } from "prosemirror-tables";

// Resolves an image's src (often a path relative to the document) to a URL
// the editor can display. The renderer sets this when it opens a document.
let imageResolver: (src: string) => string = (src) => src;
export function setImageResolver(fn: (src: string) => string): void {
  imageResolver = fn;
}

// A web picture an agent added waits for the person (roadmap Batch 18, item
// 1): the resolver gives it nothing to load (""). A copy of it says it waits,
// beside its address, so pasted into another document it waits there too
// (roadmap Batch 19, item 1; read back in renderer/paste.ts). Only a copy
// from Corillo is read for it, and the mark can only make a picture wait.
export const waitsNow = (src: unknown): src is string => typeof src === "string" && src !== "" && imageResolver(src) === "";
// The web addresses in a diagram (web-pictures.ts gives them: it reads
// Markdown, which needs this module first, so it can't be imported here).
let diagramAddresses: (node: PMNode) => string[] = () => [];
export function setDiagramAddresses(fn: (node: PMNode) => string[]): void {
  diagramAddresses = fn;
}

const nodes: Record<string, NodeSpec> = {};
base.spec.nodes.forEach((name, spec) => {
  nodes[name] = spec;
});

// Headings can carry footnote markers, as in Word.
nodes.heading = { ...nodes.heading, content: "(text | image | footnote_ref)*" };
nodes.bullet_list = {
  ...nodes.bullet_list,
  attrs: { tight: { default: true }, bullet: { default: "-" } },
};
nodes.ordered_list = {
  ...nodes.ordered_list,
  attrs: { order: { default: 1 }, tight: { default: true }, delim: { default: "." } },
};
// A task list item has a box, ticked or not ("- [ ] Call Ana", "- [x] Book
// the room"), drawn as Word draws it; checked is null for an ordinary item.
nodes.list_item = {
  ...nodes.list_item,
  attrs: { checked: { default: null } },
  parseDOM: [
    {
      tag: "li",
      getAttrs: (dom) => {
        const checked = (dom as HTMLElement).dataset.checked;
        return { checked: checked === "true" ? true : checked === "false" ? false : null };
      },
    },
  ],
  toDOM(node) {
    return ["li", node.attrs.checked === null ? {} : { class: "task", "data-checked": String(node.attrs.checked) }, 0];
  },
};
nodes.horizontal_rule = {
  ...nodes.horizontal_rule,
  attrs: { markup: { default: "---" } },
};
nodes.code_block = {
  ...nodes.code_block,
  attrs: { params: { default: "" }, fence: { default: "```" } },
  toDOM(node) {
    const attrs: Record<string, string> = node.attrs.params ? { "data-params": node.attrs.params } : {};
    // A diagram whose pictures from the web wait: which wait, for a copy of it.
    const waiting = [...new Set(diagramAddresses(node).filter(waitsNow))];
    if (waiting.length) attrs["data-waiting"] = JSON.stringify(waiting);
    return ["pre", attrs, ["code", 0]];
  },
};
// A link or picture written by reference ("[words][label]", "[label]",
// "![alt][label]") remembers its label and form, so editing its paragraph
// writes it the same way. Neither is in the page's HTML: pasted, a link has
// its address written out.
const REF = { ref: { default: null }, refForm: { default: null } };
nodes.image = {
  ...nodes.image,
  attrs: { ...nodes.image.attrs, ...REF },
  // data-src keeps the address as written in the file, so copying a picture
  // and pasting it doesn't turn it into a full path.
  parseDOM: [
    {
      tag: "img[src]",
      getAttrs: (dom) => {
        const el = dom as HTMLElement;
        return { src: el.dataset.src ?? el.getAttribute("src"), alt: el.getAttribute("alt"), title: el.getAttribute("title") };
      },
    },
  ],
  toDOM(node) {
    return [
      "img",
      {
        src: imageResolver(node.attrs.src),
        "data-src": node.attrs.src,
        "data-waiting": waitsNow(node.attrs.src) ? "true" : null,
        alt: node.attrs.alt,
        title: node.attrs.title,
      },
    ];
  },
};
// Markdown the editor doesn't render richly (HTML, front matter, link
// definitions, task lists, complex footnotes). Shown and edited as plain
// source text, and written back exactly as it is.
nodes.raw_block = {
  content: "text*",
  group: "block",
  code: true,
  marks: "",
  defining: true,
  attrs: { kind: { default: "markdown" } },
  parseDOM: [{ tag: "pre.raw-block", preserveWhitespace: "full" }],
  toDOM(node) {
    return ["pre", { class: "raw-block", "data-kind": node.attrs.kind }, ["code", 0]];
  },
};

// Footnotes: a numbered marker in the text, and the note itself as a block
// (written where the Markdown has it, usually at the end).
nodes.footnote_ref = {
  inline: true,
  group: "inline",
  atom: true,
  attrs: { label: {} },
  parseDOM: [{ tag: "sup.footnote-ref", getAttrs: (dom) => ({ label: (dom as HTMLElement).dataset.label }) }],
  toDOM(node) {
    return ["sup", { class: "footnote-ref", "data-label": node.attrs.label }];
  },
};
nodes.footnote_def = {
  group: "block",
  content: "(text | image | footnote_ref)*",
  defining: true,
  attrs: { label: {} },
  parseDOM: [{ tag: "div.footnote-def", getAttrs: (dom) => ({ label: (dom as HTMLElement).dataset.label }) }],
  toDOM(node) {
    return ["div", { class: "footnote-def", "data-label": node.attrs.label }, 0];
  },
};

// A line break remembers how a table cell or paragraph wrote it ("<br>",
// "<br/>" or "<br />"), so an edited table or paragraph keeps the file's own
// form, also when typing nearby makes the editor read it back from the page.
nodes.hard_break = {
  ...nodes.hard_break,
  attrs: { markup: { default: null } },
  parseDOM: [{ tag: "br", getAttrs: (dom) => ({ markup: (dom as HTMLElement).dataset.markup ?? null }) }],
  toDOM: (node) => ["br", node.attrs.markup ? { "data-markup": node.attrs.markup } : {}],
};

// Tables, as Markdown has them: a header row, then rows of cells holding one
// line of text each. A line break in a cell is written as "<br>", the way
// agents and GitHub write it, since a Markdown table row is a single line.
Object.assign(
  nodes,
  tableNodes({
    tableGroup: "block",
    cellContent: "(text | image | footnote_ref | hard_break)*",
    cellAttributes: {
      align: {
        default: null,
        getFromDOM: (dom) => (dom as HTMLElement).style.textAlign || null,
        setDOMAttr: (value, attrs) => {
          if (value) attrs.style = `${attrs.style ?? ""}text-align: ${value};`;
        },
      },
    },
  }),
);
// A cell holds its text directly, so the place between two cells would pass
// for somewhere to type: no cursor there, or typing would make a new cell.
nodes.table_row = { ...nodes.table_row, allowGapCursor: false };

const baseMark = (name: string): MarkSpec => base.spec.marks.get(name) as MarkSpec;
// Order matters: inline code must stay last (innermost) for serializing.
const marks: Record<string, MarkSpec> = {
  em: { ...baseMark("em"), attrs: { markup: { default: "*" } } },
  strong: { ...baseMark("strong"), attrs: { markup: { default: "**" } } },
  strike: {
    attrs: { markup: { default: "~~" } },
    parseDOM: [{ tag: "s" }, { tag: "del" }, { style: "text-decoration=line-through" }],
    toDOM() {
      return ["s"];
    },
  },
  link: { ...baseMark("link"), attrs: { ...baseMark("link").attrs, ...REF } },
  code: baseMark("code"),
};

export const schema = new Schema({ nodes, marks });
