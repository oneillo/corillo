// Corillo leans on a few parts of ProseMirror that aren't in its documented
// interface (W16-15). An upgrade may change them without a word, so each has a
// small test here that fails, naming the part, if it does (roadmap Batch 20,
// item 2). Nothing is upgraded: these say what to look at when something is.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GapCursor } from "prosemirror-gapcursor";
import MarkdownIt from "markdown-it";
import { defaultMarkdownParser, defaultMarkdownSerializer, MarkdownParser, MarkdownSerializerState } from "prosemirror-markdown";
import { parseMarkdown } from "../../src/core/markdown";
import { gapAllowed } from "../../src/renderer/tables";

const ROOT = join(import.meta.dirname, "..", "..");

describe("prosemirror-gapcursor's GapCursor.valid, which tables.ts asks whether the cursor may stand beside a table", () => {
  const { doc } = parseMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |\n\n| c | d |\n| --- | --- |\n| 3 | 4 |\n");

  it("is still there", () => {
    expect(typeof (GapCursor as unknown as { valid?: unknown }).valid).toBe("function");
  });

  it("says yes beside a table, where no text can go", () => {
    expect(doc.child(0).type.name).toBe("table");
    expect(doc.child(1).type.name).toBe("table");
    expect(gapAllowed(doc.resolve(doc.child(0).nodeSize))).toBe(true); // between the two tables
    expect(gapAllowed(doc.resolve(doc.content.size))).toBe(true); // after the last
  });

  it("says no inside a cell's text", () => {
    let inText = -1;
    doc.descendants((node, pos) => {
      if (inText < 0 && node.isTextblock) inText = pos + 1;
    });
    expect(gapAllowed(doc.resolve(inText))).toBe(false);
  });
});

/**
 * scroll-together.ts lines the Markdown view's preview up with its text by
 * reading prosemirror-view's own drawing of each block: the element's
 * `pmViewDesc`, and on it `node`, `parent`, `descAt` and `domFromPos`. Those
 * live in classes the package doesn't export, so they're read from its code,
 * the build esbuild bundles (the "module" file).
 */
describe("prosemirror-view's drawing of a block, which scroll-together.ts reads", () => {
  const code = readFileSync(join(ROOT, "node_modules", "prosemirror-view", "dist", "index.js"), "utf8");
  const classBody = (name: string): string => {
    const start = code.indexOf(`\nclass ${name} `);
    expect(start, `class ${name}`).toBeGreaterThan(-1);
    const end = code.indexOf("\nclass ", start + 1);
    return code.slice(start, end < 0 ? undefined : end);
  };
  const viewDesc = classBody("ViewDesc");
  const method = (name: string): string => {
    const start = viewDesc.search(new RegExp(`\\n    ${name}\\(`));
    expect(start, `ViewDesc.${name}`).toBeGreaterThan(-1);
    const end = viewDesc.slice(start + 1).search(/\n    [A-Za-z_$][\w$]*\(.*\) \{/);
    return viewDesc.slice(start, end < 0 ? undefined : start + 1 + end);
  };

  it("pmViewDesc: each drawn element points back at its drawing", () => {
    expect(viewDesc).toMatch(/\bdom\.pmViewDesc = this;/);
  });

  it("parent and dom: a drawing knows the drawing it's inside and its own element", () => {
    expect(viewDesc).toMatch(/constructor\(parent, children, dom,/);
    expect(viewDesc).toMatch(/this\.parent = parent;/);
    expect(viewDesc).toMatch(/this\.dom = dom;/);
  });

  it("node: a block's drawing holds the document's own node", () => {
    expect(classBody("NodeViewDesc")).toMatch(/this\.node = node;/);
  });

  it("descAt(pos): finds the drawing of what's at a place inside the block", () => {
    expect(method("descAt")).toMatch(/^\n {4}descAt\(pos\) \{/);
  });

  it("domFromPos(pos, side): gives the element and offset for a place inside the block", () => {
    const body = method("domFromPos");
    expect(body).toMatch(/^\n {4}domFromPos\(pos, side\) \{/);
    expect(body).toMatch(/return \{ node: [^,]+, offset: /);
  });
});

/**
 * The Markdown family (src/core/markdown-*.ts) leans on more of the libraries
 * than their typed interface gives (the review of Batch 21, S21-19). Each part
 * is named here, with the file that uses it.
 */
describe("prosemirror-markdown's serializer state, which markdown-inline.ts and markdown-blocks.ts read and set", () => {
  // (Its constructor isn't in the typed interface either.)
  const State = MarkdownSerializerState as unknown as new (nodes: unknown, marks: unknown, options: unknown) => Record<string, unknown>;
  const state = new State(defaultMarkdownSerializer.nodes, defaultMarkdownSerializer.marks, {});

  it("out, closed, inTightList, inAutolink and atBlockStart are the state's own, set as it starts", () => {
    expect(state.out).toBe("");
    expect(state.closed).toBe(null);
    expect(state.inTightList).toBe(false);
    expect("inAutolink" in state).toBe(true);
    expect(state.atBlockStart).toBe(false);
  });

  it("flushClose(size): ends the block above with that many line breaks", () => {
    expect(typeof state.flushClose).toBe("function");
  });

  // markdown-inline.ts keeps only the last 256 characters of `out` (TAIL): the
  // rest is joined once at the end. That holds while the library looks no
  // further back than that. In 1.13.9 it reads the last character, the last
  // two, or whether there is anything at all; any other use shows here.
  it("reads out no further back than its last two characters", () => {
    const code = readFileSync(join(ROOT, "node_modules", "prosemirror-markdown", "dist", "index.js"), "utf8");
    const reads = code
      .split("\n")
      .filter((line) => /\.out\b/.test(line))
      .map((line) => line.trim())
      .filter((line) => !/^this\.out (\+= |= "";)/.test(line)); // adding to it, or starting it empty: kept whole by markdown-inline.ts
    expect(reads).toEqual([
      "return state.out;", // the whole text, as serialize ends: markdown-inline.ts's FaithfulSerializer gives result() instead
      'return !this.out || this.out[this.out.length - 1] == "\\n";',
      'if (!escape && lines[i][0] == "[" && /(^|[^\\\\])\\!$/.test(this.out.slice(-2)))',
      "this.out = this.out.slice(0, this.out.length - 1) + \"\\\\!\";", // its last character replaced
    ]);
  });
});

describe("prosemirror-markdown's parser, which markdown-read.ts reads and wraps", () => {
  it("tokenHandlers: each kind of token's handler, by the token's name", () => {
    const handlers = (defaultMarkdownParser as unknown as { tokenHandlers: Record<string, unknown> }).tokenHandlers;
    expect(typeof handlers.paragraph_open).toBe("function");
    expect(typeof handlers.softbreak).toBe("function");
  });

  it("its state while parsing: stack, top(), addText() and addNode()", () => {
    let seen: Record<string, unknown> | null = null;
    const parser = new MarkdownParser(defaultMarkdownParser.schema, defaultMarkdownParser.tokenizer, defaultMarkdownParser.tokens);
    const handlers = (parser as unknown as { tokenHandlers: Record<string, (state: Record<string, unknown>, ...rest: unknown[]) => void> }).tokenHandlers;
    const text = handlers.text;
    handlers.text = (state, ...rest) => {
      seen = state;
      text(state, ...rest);
    };
    parser.parse("Words.");
    expect(seen).not.toBe(null);
    const state = seen as unknown as Record<string, unknown>;
    expect(Array.isArray(state.stack)).toBe(true);
    for (const name of ["top", "addText", "addNode"]) expect(typeof state[name], name).toBe("function");
  });
});

describe("markdown-it's inline rules, which markdown-tokens.ts reads in order", () => {
  it("__rules__: the inline ruler's rules, each with its name and function", () => {
    const rules = (new MarkdownIt().inline.ruler as unknown as { __rules__: { name: string; fn: unknown }[] }).__rules__;
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.map((r) => r.name)).toContain("text");
    expect(rules.every((r) => typeof r.fn === "function")).toBe(true);
  });
});
