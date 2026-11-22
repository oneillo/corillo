// "Markdown at a glance" in Help (src/renderer/help.html), held to what
// Corillo really does. Each example's Markdown (.md-text) must read into
// exactly what the page shows for it (.md-look, marked up the way the editor
// marks up the page), save back byte for byte when nobody edits it, and mean
// the same when Corillo writes it out itself after an edit. The keys and
// buttons the page names must be Corillo's own.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DOMOutputSpec, Mark, Node } from "prosemirror-model";
import { parseMarkdown, serializeMarkdown, type Source } from "../../src/core/markdown";
import { schema } from "../../src/core/schema";
import { footnoteNumbers } from "../../src/renderer/footnotes";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const html = read("src/renderer/help.html");
const page = /<section id="markdown"[\s\S]*?<\/section>/.exec(html)![0];

// A code block Corillo draws as a diagram, by the same rule as src/renderer/diagrams.ts,
// which takes it from src/core/web-pictures.ts (checked against both below).
const DIAGRAM = /^mermaid\b/;
const isDiagram = (node: Node) => node.type.name === "code_block" && DIAGRAM.test(String(node.attrs.params ?? "").trim());

// Reading the page ----------------------------------------------------------------

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" };
const decode = (s: string) => s.replace(/&(lt|gt|quot|#39|amp);/g, (_, e: string) => ENTITIES[e]);
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");

/** The <div> that opens at `start`, up to its matching </div>. */
function divAt(text: string, start: number): string {
  const tags = /<\/?div\b[^>]*>/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let m; (m = tags.exec(text)); ) {
    depth += m[0][1] === "/" ? -1 : 1;
    if (depth === 0) return text.slice(start, m.index + m[0].length);
  }
  throw new Error("A <div> in the Markdown page isn't closed.");
}
const inside = (el: string) => el.slice(el.indexOf(">") + 1, el.lastIndexOf("</div>"));

interface Example {
  markdown: string;
  look: string;
}

const examples: Example[] = [...page.matchAll(/<div class="md-example[^"]*">/g)].map((m) => {
  const el = divAt(page, m.index);
  const text = /<pre class="md-text">([\s\S]*?)<\/pre>/.exec(el);
  const at = el.indexOf('<div class="md-look');
  if (!text || at < 0) throw new Error(`An example has no Markdown or no look:\n${el}`);
  return { markdown: decode(text[1]), look: inside(divAt(el, at)) };
});

// What Corillo shows, as HTML --------------------------------------------------------
// Built from the schema's own description of how each part is shown on the page.

const VOID = new Set(["br", "hr", "img"]);
const HOLE = "\u0000";

function fromSpec(spec: DOMOutputSpec, hole: string): string {
  if (typeof spec === "string") return escText(spec);
  const [tag, ...rest] = spec as unknown as [string, ...unknown[]];
  let attrs: Record<string, unknown> = {};
  if (rest[0] && typeof rest[0] === "object" && !Array.isArray(rest[0])) attrs = rest.shift() as Record<string, unknown>;
  const open = `<${tag}${Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => ` ${k}="${escAttr(String(v))}"`)
    .join("")}>`;
  if (VOID.has(tag)) return open;
  return `${open}${rest.map((c) => (c === 0 ? hole : fromSpec(c as DOMOutputSpec, hole))).join("")}</${tag}>`;
}

function markTags(mark: Mark): [string, string] {
  let out = fromSpec(mark.type.spec.toDOM!(mark, true), HOLE);
  if (!out.includes(HOLE)) out = out.replace(/(<\/[a-z0-9]+>)$/, `${HOLE}$1`); // no hole: the text goes inside
  return out.split(HOLE) as [string, string];
}

function inline(node: Node, numbers: Map<string, number>): string {
  let out = "";
  const open: Mark[] = [];
  node.forEach((child) => {
    let keep = 0;
    while (keep < open.length && keep < child.marks.length && open[keep].eq(child.marks[keep])) keep++;
    while (open.length > keep) out += markTags(open.pop()!)[1];
    for (const mark of child.marks.slice(keep)) {
      out += markTags(mark)[0];
      open.push(mark);
    }
    out += child.isText ? escText(child.text ?? "") : render(child, numbers);
  });
  while (open.length) out += markTags(open.pop()!)[1];
  return out;
}

function render(node: Node, numbers: Map<string, number>): string {
  const type = node.type.name;
  // A picture: what it describes, and where its file is, as written.
  if (type === "image") {
    const title = node.attrs.title ? ` title="${escAttr(node.attrs.title)}"` : "";
    return `<img alt="${escAttr(node.attrs.alt ?? "")}" data-src="${escAttr(decodeURI(node.attrs.src))}"${title}>`;
  }
  // A diagram: Corillo draws it from its code (the page shows the drawing).
  if (isDiagram(node)) return `<div class="diagram" data-params="${escAttr(node.attrs.params)}"></div>`;
  let spec = node.type.spec.toDOM!(node) as unknown as unknown[];
  // Footnotes show their number in reading order, whatever their labels.
  if (type === "footnote_ref" || type === "footnote_def") {
    spec = [spec[0], { ...(spec[1] as object), "data-number": numbers.get(node.attrs.label) }, ...spec.slice(2)];
  }
  let content = "";
  if (node.inlineContent) content = inline(node, numbers);
  else node.forEach((child) => (content += render(child, numbers)));
  return fromSpec(spec as unknown as DOMOutputSpec, content);
}

function shown(doc: Node): string {
  const numbers = footnoteNumbers(doc);
  let out = "";
  doc.forEach((block) => (out += render(block, numbers)));
  return out;
}

/**
 * HTML reduced to what matters for the comparison: the elements, the words,
 * and the attributes that change what the reader sees (a link's address, a
 * column's alignment, a footnote's number, the kind of box).
 */
const KEPT = new Set(["class", "href", "title", "start", "style", "data-params", "data-kind", "data-label", "data-number", "alt", "data-src", "data-checked"]);
function normal(markup: string): string {
  const out: string[] = [];
  for (const m of markup.matchAll(/<(\/?)([a-z][a-z0-9]*)([^>]*)>|([^<]+)/g)) {
    if (m[4] !== undefined) {
      if (/^\s*$/.test(m[4]) && m[4].includes("\n")) continue; // the page's own line breaks between tags
      out.push(escText(decode(m[4])));
    } else if (m[1]) {
      out.push(`</${m[2]}>`);
    } else {
      const attrs = [...m[3].matchAll(/([a-z-]+)="([^"]*)"/g)].map(([, k, v]) => [k, decode(v)] as const);
      // A picture with no Markdown address shows something Corillo draws (a diagram).
      if (m[2] === "img" && !attrs.some(([k]) => k === "data-src")) continue;
      const kept = attrs.filter(([k]) => KEPT.has(k)).sort(([a], [b]) => a.localeCompare(b));
      out.push(`<${m[2]}${kept.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("")}>`);
    }
  }
  return out.join("");
}

/** The source of a document Corillo has never read, so every block is written out from the editor. */
const NOTHING_READ: Source = { bom: false, eol: "\n", prefix: "", trailing: "", blocks: [], gaps: [], original: "" };

// The tests ----------------------------------------------------------------------------

describe("Markdown at a glance", () => {
  it("has its examples where the test can find them", () => {
    expect(examples.length).toBeGreaterThanOrEqual(18);
    expect((page.match(/class="md-example/g) ?? []).length).toBe(examples.length);
  });

  it("covers everything Corillo shows formatted, and each kind of Markdown it keeps as written", () => {
    const nodes = new Set<string>();
    const marks = new Set<string>();
    const kept = new Set<string>();
    let diagram = false;
    for (const { markdown } of examples) {
      parseMarkdown(markdown).doc.descendants((node) => {
        nodes.add(node.type.name);
        for (const mark of node.marks) marks.add(mark.type.name);
        if (node.type.name === "raw_block") kept.add(node.attrs.kind);
        if (isDiagram(node)) diagram = true;
      });
    }
    const everyNode = Object.keys(schema.nodes).filter((n) => n !== "doc");
    expect(everyNode.filter((n) => !nodes.has(n))).toEqual([]);
    expect(Object.keys(schema.marks).filter((m) => !marks.has(m))).toEqual([]);
    expect(diagram).toBe(true);
    expect(read("src/core/web-pictures.ts")).toContain(`${DIAGRAM}.test(`);
    expect(read("src/renderer/diagrams.ts")).toContain("export const isDiagram = isDiagramBlock;");
    expect([...kept].sort()).toEqual(expect.arrayContaining(["comment", "front-matter", "html", "links", "markdown"]));
  });

  it("shows each example the way Corillo shows it in the Formatted view", () => {
    for (const { markdown, look } of examples) {
      expect(normal(shown(parseMarkdown(markdown).doc)), markdown).toBe(normal(look));
    }
  });

  it("saves each example back exactly as written when nobody edits it", () => {
    for (const { markdown } of examples) {
      const { doc, source } = parseMarkdown(markdown);
      expect(serializeMarkdown(doc, source), markdown).toBe(markdown);
    }
  });

  it("means the same when Corillo writes an example out itself, as it does after an edit", () => {
    for (const { markdown, look } of examples) {
      const written = serializeMarkdown(parseMarkdown(markdown).doc, NOTHING_READ);
      expect(normal(shown(parseMarkdown(written).doc)), `${markdown}\n\nwritten as\n\n${written}`).toBe(normal(look));
    }
  });

  it("names only keys the editor has", () => {
    const keymap = read("src/renderer/doc-tab.ts");
    const MODS = ["Ctrl", "Alt", "Shift", "Mod"];
    const canonical = (mods: string[], key: string) => [...MODS.filter((m) => mods.includes(m)), key.toLowerCase()].join("-");
    const editorKeys = new Set(
      [...keymap.matchAll(/^\s*"?((?:(?:Shift|Mod|Alt|Ctrl)-)*(?:[A-Za-z0-9]|Enter|Tab|Backspace|Delete))"?:\s/gm)].map((m) => {
        const parts = m[1].split("-");
        return canonical(parts.slice(0, -1), parts[parts.length - 1]);
      }),
    );
    const WORDS: Record<string, string> = { Command: "Mod", Option: "Alt", Shift: "Shift", Control: "Ctrl" };
    const named = [...page.matchAll(/<p class="md-how">([\s\S]*?)<\/p>/g)].flatMap((m) => [...m[1].matchAll(/<kbd>([^<]+)<\/kbd>/g)].map((k) => k[1]));
    expect(named.length).toBeGreaterThan(10);
    for (const keys of named) {
      const parts = keys.split("-");
      const key = parts.pop()!;
      expect(parts.every((p) => WORDS[p]), keys).toBe(true);
      expect(editorKeys, keys).toContain(canonical(parts.map((p) => WORDS[p]), key === "Return" ? "Enter" : key));
    }
  });

  it("names only buttons and menu items that are in Corillo", () => {
    const ui = ["src/renderer/toolbar.ts", "src/renderer/diagrams.ts", "src/main/editing.ts", "src/main/main.ts", "src/main/menus.ts"].map(read).join("\n");
    const named = [...page.matchAll(/<p class="md-how">([\s\S]*?)<\/p>/g)].flatMap((m) =>
      [...m[1].matchAll(/<strong>([^<]+)<\/strong>/g)].flatMap((s) => decode(s[1]).split(" > ")),
    );
    expect(named.length).toBeGreaterThan(15);
    for (const name of named) expect(ui.includes(`"${name}"`), name).toBe(true);
  });

  it("is linked from the Editing page, the Help menu and the Markdown view", () => {
    const editing = /<section id="editing"[\s\S]*?<\/section>/.exec(html)![0];
    expect(editing).toContain('href="#markdown"');
    expect(read("src/main/connect-agents.ts")).toContain('label: "Markdown Help", click: () => openHelp("markdown")');
    expect(read("src/renderer/index.html")).toContain('id="markdown-help"');
    expect(read("src/renderer/app.ts")).toContain('help.open("markdown")');
  });
});
