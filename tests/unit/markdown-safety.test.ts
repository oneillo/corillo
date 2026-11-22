// Reading and writing Markdown safely: what a file says is what the page
// shows, and an edited block reads back as the page showed it. Each group
// below is a problem found in review (2026-11-09) and fixed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { schema } from "../../src/core/schema";
import { sliceMarkdown } from "../../src/core/clipboard-text";
import { applyLink } from "../../src/renderer/commands";
import { lineMarks } from "../../src/core/line-numbers";
import MarkdownIt from "markdown-it";
import { execFileSync } from "node:child_process";
import { PANDOC_FROM } from "../../src/main/export-prep";
import { PANDOC } from "./word";
import { checkSave } from "../../src/core/write-check";

const kinds = (doc: Node) => {
  const out: string[] = [];
  doc.forEach((n) => out.push(n.type.name === "raw_block" ? `raw:${n.attrs.kind}` : n.type.name));
  return out;
};

/** Type at the end of the first text in top-level block k; the file text after it. */
function typeInBlock(text: string, k: number, typed: string): string {
  const { doc, source } = parseMarkdown(text);
  const state = EditorState.create({ doc });
  let start = 0;
  for (let i = 0; i < k; i++) start += doc.child(i).nodeSize;
  let at = -1;
  doc.child(k).descendants((node, pos) => {
    if (at < 0 && node.isTextblock) at = start + 1 + pos + 1 + node.content.size;
    return at < 0;
  });
  if (at < 0) at = start + doc.child(k).nodeSize - 1;
  return serializeMarkdown(state.apply(state.tr.insertText(typed, at)).doc, source);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a heading over two lines joined by a line break", () => {
  // Two trailing spaces (or a backslash) end a line with a line break; with
  // "---" or "===" on the next line, the lines are one heading.
  const signOff = "Ana López  \nProduct lead\n---\n";

  it("opens with its words, not as an empty document", () => {
    const { doc, source } = parseMarkdown(signOff);
    expect(kinds(doc)).toEqual(["heading"]);
    expect(doc.textContent).toBe("Ana López Product lead");
    expect(serializeMarkdown(doc, source)).toBe(signOff);
  });

  it("keeps both lines' words when the heading is edited", () => {
    const out = typeInBlock(signOff, 0, "!");
    expect(parseMarkdown(out).doc.textContent).toBe("Ana López Product lead!");
  });

  it("leaves the rest of a longer document formatted", () => {
    const text = `# Plan\n\nSome text.\n\n${signOff}\nMore text.\n`;
    const { doc, source } = parseMarkdown(text);
    expect(kinds(doc)).toEqual(["heading", "paragraph", "heading", "paragraph"]);
    expect(serializeMarkdown(doc, source)).toBe(text);
  });

  it("works the same with a backslash line break and an === underline", () => {
    const text = "# Plan\n\nLine one\\\nline two\n===\n";
    const { doc } = parseMarkdown(text);
    expect(kinds(doc)).toEqual(["heading", "heading"]);
    expect(doc.child(1).textContent).toBe("Line one line two");
  });

  it("keeps a quoted heading's words too", () => {
    const { doc } = parseMarkdown("> Ana López  \n> Product lead\n> ---\n");
    expect(doc.textContent).toBe("Ana López Product lead");
  });
});

describe("a block the editor can't hold", () => {
  // Should never happen; if it does, that one block shows as Markdown text
  // and the rest of the document stays formatted.
  const refuse = (type: "blockquote" | "heading") => vi.spyOn(schema.nodes[type], "createAndFill").mockReturnValueOnce(null);

  it("becomes one block of Markdown text, and the others stay formatted", () => {
    refuse("blockquote");
    const text = "# Title\n\n> quoted words\n\nA paragraph.\n";
    const { doc, source } = parseMarkdown(text);
    expect(kinds(doc)).toEqual(["heading", "raw:markdown", "paragraph"]);
    expect(doc.child(1).textContent).toBe("> quoted words");
    expect(serializeMarkdown(doc, source)).toBe(text);
  });

  it("keeps its words when it is the file's only block", () => {
    refuse("heading");
    const text = "# Lone heading\n";
    const { doc, source } = parseMarkdown(text);
    expect(kinds(doc)).toEqual(["raw:markdown"]);
    expect(doc.textContent).toBe("# Lone heading");
    expect(serializeMarkdown(doc, source)).toBe(text);
  });

  it("is found inside a list or quote as well", () => {
    refuse("heading");
    const text = "Intro.\n\n> # Quoted heading\n> words\n\nEnd.\n";
    const { doc } = parseMarkdown(text);
    expect(kinds(doc)).toEqual(["paragraph", "raw:markdown", "paragraph"]);
    expect(doc.child(1).textContent).toBe("> # Quoted heading\n> words");
  });
});

describe("blocks written with no blank line between them", () => {
  // Built the way the editor builds them, each holding "Some words".
  const words = () => schema.text("Some words");
  const para = () => schema.node("paragraph", null, [words()]);
  const MADE: Record<string, () => Node> = {
    paragraph: para,
    heading: () => schema.node("heading", { level: 2 }, [words()]),
    quote: () => schema.node("blockquote", null, [para()]),
    bullets: () => schema.node("bullet_list", null, [schema.node("list_item", null, [para()])]),
    numbers: () => schema.node("ordered_list", null, [schema.node("list_item", null, [para()])]),
    code: () => schema.node("code_block", null, [words()]),
    rule: () => schema.node("horizontal_rule"),
    table: () =>
      schema.node("table", null, [
        schema.node("table_row", null, [schema.node("table_header", null, [schema.text("Some")]), schema.node("table_header", null, [schema.text("words")])]),
        schema.node("table_row", null, [schema.node("table_cell", null, [schema.text("a")]), schema.node("table_cell", null, [schema.text("b")])]),
      ]),
  };
  const WRITTEN: Record<string, string> = {
    paragraph: "Some words",
    heading: "## Some words",
    quote: "> Some words",
    bullets: "- Some words",
    numbers: "1. Some words",
    code: "```\nSome words\n```",
    rule: "***",
    table: "| Some | words |\n| --- | --- |\n| a | b |",
  };
  const replace = (doc: Node, k: number, node: Node) => doc.copy(doc.content.replaceChild(k, node));

  it("read back as the page shows them after either one changes what it is", () => {
    let checked = 0;
    for (const a of Object.keys(WRITTEN)) {
      for (const b of Object.keys(WRITTEN)) {
        const text = `${WRITTEN[a]}\n${WRITTEN[b]}\n`;
        const { doc, source } = parseMarkdown(text);
        if (doc.childCount !== 2) continue; // the file itself reads them as one block
        for (const k of [0, 1]) {
          for (const kind of Object.keys(MADE)) {
            if (kind === (k === 0 ? a : b)) continue;
            const edited = replace(doc, k, MADE[kind]());
            // (Two lists of the same kind side by side are one list in Markdown: see "lists side by side".)
            if (edited.child(0).type === edited.child(1).type && /_list$/.test(edited.child(0).type.name)) continue;
            const out = serializeMarkdown(edited, source);
            const again = parseMarkdown(out).doc;
            expect(again.eq(edited), `${JSON.stringify(text)} with block ${k} made ${kind}: wrote ${JSON.stringify(out)}`).toBe(true);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(400);
  });

  // A link definition can't break into a paragraph, and a line straight
  // after a note is more of the note (second review, R-MD-1).
  it("keep link definitions and notes apart from a block beside them that changes what it is", () => {
    let checked = 0;
    const cases: [string, number, string][] = [];
    for (const a of Object.keys(WRITTEN)) {
      // Above link definitions; below a note (and a note's continuation kept as Markdown text).
      cases.push([`${WRITTEN[a]}\n[1]: https://example.com\n[2]: https://example.org\n`, 0, a]);
      cases.push([`Text[^1] here.\n\n[^1]: The note.\n${WRITTEN[a]}\n`, 2, a]);
      cases.push([`[^1]: The note.\n${WRITTEN[a]}\n`, 1, a]);
      cases.push([`[1]: https://example.com\n${WRITTEN[a]}\n`, 1, a]);
    }
    for (const [text, k, was] of cases) {
      const { doc, source } = parseMarkdown(text);
      if (doc.childCount !== k + (k === 0 ? 2 : 1)) continue; // the file itself reads them as one block
      for (const kind of Object.keys(MADE)) {
        if (kind === was) continue;
        const edited = replace(doc, k, MADE[kind]());
        const out = serializeMarkdown(edited, source);
        const again = parseMarkdown(out).doc;
        expect(again.eq(edited), `${JSON.stringify(text)} with block ${k} made ${kind}: wrote ${JSON.stringify(out)}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(150);
  });

  it("keep the links of a document working when the heading above their definitions becomes normal text", () => {
    const text = "See [the site][1].\n\n## Sources\n[1]: https://example.com\n";
    const { doc, source } = parseMarkdown(text);
    const out = serializeMarkdown(replace(doc, 1, schema.node("paragraph", null, [schema.text("Sources")])), source);
    expect(out).toBe("See [the site][1].\n\nSources\n\n[1]: https://example.com\n");
  });

  it("keep their single line break when a block is edited without changing what it is", () => {
    expect(typeInBlock("## Title\nBody text here.\n", 0, "!")).toBe("## Title!\nBody text here.\n");
    expect(typeInBlock("Points:\n- one\n- two\n", 1, "!")).toBe("Points:\n- one!\n- two\n");
    expect(typeInBlock("Run this:\n```\nnpm test\n```\n", 0, "!")).toBe("Run this:!\n```\nnpm test\n```\n");
    expect(typeInBlock("## Sources\n[1]: https://example.com\n", 0, "!")).toBe("## Sources!\n[1]: https://example.com\n");
    expect(typeInBlock("A[^1].\n\n[^1]: The note.\n# After\n", 1, "!")).toBe("A[^1].\n\n[^1]: The note.!\n# After\n");
  });

  it("set a heading to normal text without joining it to the paragraph under it", () => {
    const { doc, source } = parseMarkdown("## Title\nBody text here.\n");
    const out = serializeMarkdown(replace(doc, 0, schema.node("paragraph", null, [schema.text("Title")])), source);
    expect(out).toBe("Title\n\nBody text here.\n");
  });

  it("keep a list whose first item was emptied a list, under a paragraph", () => {
    const { doc, source } = parseMarkdown("Points:\n- one\n- two\n");
    const list = doc.child(1);
    const emptied = list.copy(list.content.replaceChild(0, schema.node("list_item", null, [schema.node("paragraph")])));
    const edited = replace(doc, 1, emptied);
    const again = parseMarkdown(serializeMarkdown(edited, source)).doc;
    expect(again.eq(edited)).toBe(true);
  });

  it("keep an emptied first item of a list inside a list, and its parent's words", () => {
    const { doc, source } = parseMarkdown("- parent\n  - child one\n  - child two\n");
    const list = doc.child(0);
    const item = list.child(0);
    const inner = item.child(1);
    const emptiedInner = inner.copy(inner.content.replaceChild(0, schema.node("list_item", null, [schema.node("paragraph")])));
    const edited = replace(doc, 0, list.copy(list.content.replaceChild(0, item.copy(item.content.replaceChild(1, emptiedInner)))));
    const out = serializeMarkdown(edited, source);
    const again = parseMarkdown(out).doc;
    // (Markdown can only write it with a blank line, which spaces the outer list out: the same items, looser.)
    const shape = (n: Node) => JSON.stringify(n.toJSON()).replace(/"tight":(true|false)/g, "");
    expect(shape(again), out).toBe(shape(edited));
    expect(again.child(0).child(0).child(0).textContent).toBe("parent");
  });
});

describe("numbered headings", () => {
  it("keep their number as written when edited", () => {
    expect(typeInBlock("## 1. Introduction\n", 0, "!")).toBe("## 1. Introduction!\n");
    expect(typeInBlock("### 2) Scope\n", 0, "!")).toBe("### 2) Scope!\n");
    expect(typeInBlock("## - dash\n", 0, "!")).toBe("## - dash!\n");
    expect(typeInBlock("# + plus\n", 0, "!")).toBe("# + plus!\n");
  });

  it("read back as the same heading, whatever they start with", () => {
    const texts = ["1. Introduction", "- dash", "+ plus", "> quote", "# hash", "#", "###", "===", "| pipe", "---", "2) two", "a #", "* star", "[x]: y", "```", "<b>", "    code"];
    for (const t of texts) {
      const doc = schema.node("doc", null, [schema.node("heading", { level: 2 }, [schema.text(t)])]);
      const { source } = parseMarkdown("");
      const out = serializeMarkdown(doc, source);
      const back = parseMarkdown(out).doc;
      expect(kinds(back), `${JSON.stringify(t)} wrote ${JSON.stringify(out)}`).toEqual(["heading"]);
      expect(back.textContent, out).toBe(t.trim());
    }
  });
});

describe("link addresses", () => {
  const linkIn = (doc: Node) => {
    let href: string | null = null;
    doc.descendants((n) => {
      const link = n.marks.find((m) => m.type.name === "link");
      if (link && href === null) href = link.attrs.href;
      return href === null;
    });
    return href;
  };
  const addresses = [
    "https://x.com/a%2520b",
    "https://x.com/?url=https%3A%2F%2Fsite.com%2FQ3%2520plan",
    "https://x.com/?q=50%25",
    "https://x.com/caf%C3%A9",
    "https://x.com/caf%c3%a9",
    "https://x.com/a%20b",
    "https://x.com/%7Bid%7D",
    "https://x.com/a%7Cb",
    "https://x.com/%00%01",
    "https://x.com/%3Ctag%3E",
    "https://x.com/back%5Cslash",
    "https://x.com/a(b)c",
  ];

  it("point at the same place after their paragraph is edited", () => {
    for (const url of addresses) {
      const text = `See [the page](${url}) now.\n`;
      const before = linkIn(parseMarkdown(text).doc);
      const out = typeInBlock(text, 0, "!");
      expect(linkIn(parseMarkdown(out).doc), `${url} wrote ${JSON.stringify(out)}`).toBe(before);
    }
  });

  it("point at the same place in an edited table", () => {
    for (const url of addresses) {
      const text = `| a | b |\n| - | - |\n| [the page](${url}) | x |\n`;
      const before = linkIn(parseMarkdown(text).doc);
      const out = typeInBlock(text, 0, "!");
      expect(linkIn(parseMarkdown(out).doc), `${url} wrote ${JSON.stringify(out)}`).toBe(before);
    }
  });

  it("stay readable: letters such as é as themselves, spaces as %20", () => {
    expect(typeInBlock("[a](https://x.com/caf%C3%A9) b\n", 0, "!")).toBe("[a](https://x.com/café) b!\n");
    expect(typeInBlock("![chart](Q3%20plan%20images/chart.png) b\n", 0, "!")).toBe("![chart](Q3%20plan%20images/chart.png) b!\n");
    expect(typeInBlock("[a](https://x.com/{id}) b\n", 0, "!")).toBe("[a](https://x.com/{id}) b!\n");
  });
});

describe("line and paragraph separators inside formatted text", () => {
  const written = (text: string, marks = [schema.marks.strong.create()]) => {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("a"), schema.text(text, marks), schema.text("z")])]);
    return serializeMarkdown(doc, parseMarkdown("").source);
  };

  it("keep every word after the separator", () => {
    for (const sep of [" ", " "]) {
      for (const text of [` bold${sep}more words`, ` bold ${sep} more words`, `bold${sep}more `, `x${sep}y`]) {
        for (const marks of [[schema.marks.strong.create()], [schema.marks.em.create()], [schema.marks.strike.create()]]) {
          const out = written(text, marks);
          const back = parseMarkdown(out).doc.textContent;
          expect(back, JSON.stringify(out)).toContain(text.trim().split(/\s+/).pop()!);
          expect(back.replace(/\s+/g, ""), JSON.stringify(out)).toBe(`a${text}z`.replace(/\s+/g, ""));
        }
      }
    }
  });

  it("write a carriage return in formatted text as a line break, losing nothing", () => {
    const out = written(" bold\rmore words");
    expect(parseMarkdown(out).doc.textContent.replace(/\s+/g, " ")).toBe("a bold more wordsz");
  });

  it("leave a private-use character in the text as it is", () => {
    for (const ch of ["", "", "", "", ""]) {
      const out = written(`x${ch}y`);
      expect(parseMarkdown(out).doc.textContent, JSON.stringify(out)).toBe(`ax${ch}yz`);
      const plain = serializeMarkdown(schema.node("doc", null, [schema.node("paragraph", null, [schema.text(`plain ${ch} text`)])]), parseMarkdown("").source);
      expect(parseMarkdown(plain).doc.textContent).toBe(`plain ${ch} text`);
    }
  });
});

describe("a line break inside code in a paragraph", () => {
  it("is written as a space, as Markdown reads it, not as a hidden character", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("a "), schema.text("x\ny", [schema.marks.code.create()]), schema.text(" z")])]);
    const out = serializeMarkdown(doc, parseMarkdown("").source);
    expect(out).toBe("a `x y` z\n");
  });
});

// What a block says, formatting and all: "<strong:Note.>" for formatted text.
function formatted(node: Node): string {
  let out = "";
  node.descendants((n) => {
    if (n.isText) out += n.marks.length ? `<${n.marks.map((m) => m.type.name).join("+")}:${n.text}>` : n.text;
  });
  return out;
}

/** A paragraph (or heading) of runs, written afresh and read back. */
function writeRuns(runs: [string, string[]][], heading = false): { out: string; before: string; after: string; kind: string } {
  const kids = runs.map(([text, marks]) => schema.text(text, marks.map((m) => schema.marks[m].create())));
  const block = heading ? schema.node("heading", { level: 2 }, kids) : schema.node("paragraph", null, kids);
  const doc = schema.node("doc", null, [block]);
  const out = serializeMarkdown(doc, parseMarkdown("").source);
  const back = parseMarkdown(out).doc;
  return { out, before: formatted(doc), after: formatted(back), kind: back.child(0).type.name };
}

describe("bold, italic and struck text touching a letter and punctuation", () => {
  const cases: [string, [string, string[]][]][] = [
    ["bold starting with a bracket right after a word", [["Acme", []], ["(firm)", ["strong"]], [" signed.", []]]],
    ["bold ending in a full stop before a letter", [["See ", []], ["Note.", ["strong"]], ["Then go.", []]]],
    ["a bold quote in Chinese", [["这是", []], ["“重要”", ["strong"]], ["的", []]]],
    ["a struck quote in Chinese", [["这是", []], ["“重要”", ["strike"]], ["的", []]]],
    ["an italic quote in Chinese", [["这是", []], ["“重要”", ["em"]], ["的", []]]],
    ["italic then bold with no space", [["very", ["em"]], ["important", ["strong"]]]],
    ["bold and italic together", [["x ", []], ["both", ["em", "strong"]], [" y", []]]],
  ];
  for (const [name, runs] of cases) {
    it(`keeps ${name} in a paragraph and a heading`, () => {
      for (const heading of [false, true]) {
        const { out, before, after, kind } = writeRuns(runs, heading);
        expect(after, out).toBe(before);
        expect(kind, out).toBe(heading ? "heading" : "paragraph");
      }
    });
  }

  it("writes the usual signs where they work, and HTML only where they can't", () => {
    expect(writeRuns([["x ", []], ["both", ["em", "strong"]], [" y", []]]).out).toBe("x ***both*** y\n");
    expect(writeRuns([["Acme", []], ["(firm)", ["strong"]], [" signed.", []]]).out).toBe("Acme<strong>(firm)</strong> signed.\n");
  });
});

// (Formatting on a space can't be seen: only the other characters' counts.)
function visible(node: Node): string {
  let out = "";
  node.descendants((n) => {
    if (n.isText) for (const ch of n.text!) out += /\s/.test(ch) ? " " : `${ch}{${n.marks.map((m) => m.type.name).sort().join("+")}}`;
  });
  return out.replace(/ +/g, " ");
}

describe("formatting over formatting (second review, R-MD-2)", () => {
  const cases: [string, [string, string[]][]][] = [
    ['bold over "Acme Corp." with each word also italic', [["See ", []], ["Acme", ["em", "strong"]], [" ", ["strong"]], ["Corp.", ["em", "strong"]], ["ish", []]]],
    ["strikethrough ending inside italic, beside amounts", [["Pay $5 ", []], ["now ", ["strike"]], ["or", ["em", "strike"]], [" $", ["em"]], ["5 later", []]]],
    ["italic on part of some code", [["Run ", []], ["npm ", ["code"]], ["test", ["em", "code"]], ["s", []]]],
    ["bold code after code with more formatting", [["x ", []], ["hi=", ["em", "strike"]], ["= ", ["em", "strong", "strike"]], ["is x_y", ["em", "strong", "strike", "code"]], [" is", ["strong", "code"]], [" it's", []]]],
    ["struck code after a link with code", [["Q", []], ["3 ", ["link"]], ["t", ["strong", "link"]], ["st", ["strong", "strike", "link", "code"]], [" ", ["strong", "strike", "code"]], ["5", ["strike", "code"]], ["$", ["code"]]]],
  ];
  for (const [name, runs] of cases) {
    it(`reads back as written, with no signs showing: ${name}`, () => {
      for (const heading of [false, true]) {
        const kids = runs.map(([text, marks]) => schema.text(text, marks.map((m) => (m === "link" ? schema.marks.link.create({ href: "https://x.com/a" }) : schema.marks[m].create()))));
        const doc = schema.node("doc", null, [heading ? schema.node("heading", { level: 2 }, kids) : schema.node("paragraph", null, kids)]);
        const out = serializeMarkdown(doc, parseMarkdown("").source);
        const back = parseMarkdown(out).doc;
        expect(kinds(back), out).toEqual([heading ? "heading" : "paragraph"]);
        expect(visible(back), out).toBe(visible(doc));
      }
    });
  }

  it("reads back as written in a list item: italic over bold with spaces in it, before \"1中\" (the fuzz's seed 11121)", () => {
    const em = schema.marks.em.create();
    const strong = schema.marks.strong.create();
    const strike = schema.marks.strike.create();
    const para = schema.node("paragraph", null, [
      schema.text("b-", [em, strong]),
      schema.text("  ", [strong]),
      schema.text("/", [em, strong]),
      schema.text("1中 "),
      schema.text("1", [strong]),
      schema.text("a", [strike]),
    ]);
    const doc = schema.node("doc", null, [schema.node("bullet_list", null, [schema.node("list_item", null, [para])])]);
    const out = serializeMarkdown(doc, parseMarkdown("").source);
    const back = parseMarkdown(out).doc;
    expect(kinds(back), out).toEqual(["bullet_list"]);
    expect(visible(back), out).toBe(visible(doc));
  });
});

describe("a $ or %% beside formatting", () => {
  const cases: [string, [string, string[]][]][] = [
    ["a bold amount ending in $, with another $ later", [["Lunch is ", []], ["12$", ["strong"]], [" and dinner 20$.", []]]],
    ["a bold $ word after a plain one", [["Set $HOME and ", []], ["$PATH", ["strong"]], [" first.", []]]],
    ["italic %% with more %% after it", [["About ", []], ["50%%", ["em"]], [" of 100%% done", []]]],
    ["%% in the text and in code later on the line", [["a %% b ", []], ["c%%d", ["code"]], [" e", []]]],
  ];
  for (const [name, runs] of cases) {
    it(`keeps the formatting: ${name}`, () => {
      const { out, before, after } = writeRuns(runs);
      expect(after, out).toBe(before);
    });
  }

  it("leaves the usual amounts unescaped", () => {
    expect(writeRuns([["From ", []], ["$5", ["strong"]], [" to ", []], ["$10", ["strong"]], [".", []]]).out).toBe("From **$5** to **$10**.\n");
  });
});

describe("reference links", () => {
  const defs = "\n\n[site]: https://example.com \"The site\"\n[Acme]: https://acme.example\n[logo]: logo.png\n";
  const forms: [string, string][] = [
    ["a link with its own label", "See [the site][site] now."],
    ["a link named by its words", "Ask [Acme] now."],
    ["a link named by its words, with empty brackets", "Ask [Acme][] now."],
    ["a picture with a label", "Logo ![our logo][logo] now."],
    ["a picture named by its words", "Logo ![logo] now."],
    ["a label in different capitals", "Ask [ACME] or [them][acme] now."],
  ];
  for (const [name, line] of forms) {
    it(`stay as written when their paragraph is edited: ${name}`, () => {
      expect(typeInBlock(line + defs, 0, "!")).toBe(line + "!" + defs);
    });
  }

  it("keep their label when the linked words change", () => {
    const text = "Ask [Acme] now." + defs;
    const { doc, source } = parseMarkdown(text);
    const state = EditorState.create({ doc });
    const out = serializeMarkdown(state.apply(state.tr.insertText("X", 7)).doc, source);
    expect(out).toBe("Ask [AcXme][Acme] now." + defs);
  });

  it("are written with their address once the definition is gone", () => {
    const text = "See [the site][site] now.\n\n[site]: https://example.com\n";
    const { doc, source } = parseMarkdown(text);
    const state = EditorState.create({ doc });
    const tr = state.tr.insertText("!", doc.child(0).nodeSize - 1).delete(doc.child(0).nodeSize, doc.content.size);
    expect(serializeMarkdown(tr.doc, source)).toBe("See [the site](https://example.com) now.!\n");
  });

  it("become an ordinary link when the address is changed in the link box", () => {
    const text = "See [the site][site] now." + defs;
    const { doc, source } = parseMarkdown(text);
    let state = EditorState.create({ doc });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 8)));
    applyLink("https://other.example")(state, (tr) => (state = state.apply(tr)));
    expect(serializeMarkdown(state.doc, source)).toBe("See [the site](https://other.example) now." + defs);
  });

  it("copy as ordinary links, so the copy works on its own", () => {
    const { doc } = parseMarkdown("See [the site][site] and ![logo] now." + defs);
    const slice = doc.slice(1, doc.child(0).nodeSize - 1);
    expect(sliceMarkdown(slice)).toBe('See [the site](https://example.com "The site") and ![logo](logo.png) now.');
  });

  // (Second review, R-MD-7: each link joined everything written before it.)
  it("in a long list are written about as quickly as links with their address", () => {
    const quickest = (byReference: boolean) => {
      const n = 8000;
      const items = Array.from({ length: n }, (_, i) => (byReference ? `- see [site ${i}][s${i}] now` : `- see [site ${i}](https://e.com/${i}) now`));
      const defs = byReference ? "\n\n" + Array.from({ length: n }, (_, i) => `[s${i}]: https://e.com/${i}`).join("\n") : "";
      const { doc, source } = parseMarkdown(items.join("\n") + defs + "\n");
      let state = EditorState.create({ doc });
      let best = Infinity;
      for (let k = 0; k < 5; k++) {
        state = state.apply(state.tr.insertText("x", 5));
        const start = performance.now();
        serializeMarkdown(state.doc, source);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    const inline = quickest(false);
    expect(quickest(true)).toBeLessThan(3 * inline + 10);
  }, 30_000);

  it("aren't taken for a different link by what follows them", () => {
    const text = "Ask [Acme] now." + defs;
    const { doc, source } = parseMarkdown(text);
    const state = EditorState.create({ doc });
    const out = serializeMarkdown(state.apply(state.tr.delete(9, 14).insertText("(today)", 9)).doc, source);
    expect(parseMarkdown(out).doc.child(0).textContent).toBe("Ask Acme(today)");
    expect(out).toBe("Ask [Acme][](today)" + defs);
  });
});

describe("sources written [[1]](address), as AI tools write them", () => {
  const text = "Sales grew [[1]](https://example.com/report) and costs fell ![[chart]](chart.png).\n";

  it("are ordinary links and pictures whose words are in brackets, not links to notes", () => {
    const para = parseMarkdown(text).doc.child(0);
    const links: string[] = [];
    para.forEach((n) => {
      const link = n.marks.find((m) => m.type.name === "link");
      if (link) links.push(`${n.text} -> ${link.attrs.href}`);
      if (n.type.name === "image") links.push(`picture ${n.attrs.alt} -> ${n.attrs.src}`);
    });
    expect(links).toEqual(["[1] -> https://example.com/report", "picture [chart] -> chart.png"]);
  });

  it("read back the same after their paragraph is edited", () => {
    const out = typeInBlock(text, 0, "!");
    expect(formatted(parseMarkdown(out).doc)).toBe(formatted(parseMarkdown(text.replace(".\n", ".!\n")).doc));
  });

  it("leave a note link followed by a space and brackets a note link", () => {
    const para = parseMarkdown("See [[Plan]] (draft) and [[Plan]][1].\n").doc.child(0);
    expect(para.textContent).toBe("See [[Plan]] (draft) and [[Plan]][1].");
    expect(para.childCount).toBe(1); // no link marks
  });

  it("keep typed text that looks like one as text", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("See [[Plan]](draft) here")])]);
    const out = serializeMarkdown(doc, parseMarkdown("").source);
    expect(parseMarkdown(out).doc.child(0).textContent).toBe("See [[Plan]](draft) here");
    expect(parseMarkdown(out).doc.child(0).childCount).toBe(1);
  });

  // (Second review, R-MD-6: an edit wrote them [\[1\]](...), backslashes the person never typed.)
  it("are written as they were when their paragraph is edited", () => {
    const sources = "Growth was 4% [[1]](https://a.com/x) and costs fell [[2]](https://b.com/y).\n";
    expect(typeInBlock(sources, 0, "!")).toBe(sources.replace(".\n", ".!\n"));
    expect(typeInBlock("Meeting with [[Ana]](PM) today.\n", 0, "!")).toBe("Meeting with [[Ana]](PM) today.!\n");
  });

  it("keep their brackets escaped where the words would read as something else", () => {
    const linked = (words: string, defs = "") => {
      const doc = schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text("See "), schema.text(words, [schema.marks.link.create({ href: "https://a.com/x" })]), schema.text(" now.")]),
      ]);
      const text = `See [x](https://a.com/x) now.${defs}`;
      const out = serializeMarkdown(doc, parseMarkdown(text).source);
      return { out, back: formatted(parseMarkdown(out).doc.child(0)), was: formatted(doc.child(0)) };
    };
    // "[1]" defined as a link's label: written as it is, it would be a link of its own inside this one.
    for (const [words, defs] of [["[1]", "\n\n[1]: https://c.com\n"], ["[a *b* c]", ""], ["[`x]`]", ""], ["[^1]", ""]]) {
      const { out, back, was } = linked(words, defs);
      expect(back, out).toBe(was);
    }
  });
});

// A link over words that hold a note link, made with Command-K over "see
// [[Plan]]": Markdown has no link inside a link, so the note link's brackets
// are escaped; the words still read "[[Plan]]" (second review, R-MD-4).
describe("a link whose words hold a [[note link]]", () => {
  for (const words of ["see [[Plan]]", "[[Plan]]", "b[[+]]", "[[X]] and [[Y]]"]) {
    it(`reads back as the same link: ${words}`, () => {
      const doc = schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text("Go "), schema.text(words, [schema.marks.link.create({ href: "https://x.com/a" })]), schema.text(" now [[Plan]].")]),
      ]);
      const out = serializeMarkdown(doc, parseMarkdown("").source);
      expect(formatted(parseMarkdown(out).doc.child(0)), out).toBe(formatted(doc.child(0)));
      // (A note link outside the link is kept as written.)
      expect(out).toMatch(/ now \[\[Plan\]\]\.\n$/);
    });
  }
});

describe("an edited table with a long cell", () => {
  const long = "word ".repeat(60).trim();
  const rows = Array.from({ length: 30 }, (_, i) => `| ${i} | item ${i} | ${i === 7 ? long : "short"} |`);
  const text = ["| # | Item | Notes |", "|---|:--|--:|", ...rows].join("\n") + "\n";

  it("is written with one space either side of each cell, not padded to the long one", () => {
    const out = typeInBlock(text, 0, "!");
    expect(out).not.toMatch(/ {3}/);
    expect(out.length).toBeLessThan(text.length + 50);
    expect(out.split("\n")[1]).toBe("| --- | :-- | --: |");
  });

  it("reads back as the same table", () => {
    const out = typeInBlock(text, 0, "!");
    const before = parseMarkdown(text.replace("| # |", "| #! |")).doc;
    expect(parseMarkdown(out).doc.eq(before)).toBe(true);
  });

  it("leaves a narrow table lined up", () => {
    const small = "| a | b |\n|---|---|\n| one | two |\n";
    expect(typeInBlock(small, 0, "!")).toBe("| a!  | b   |\n| --- | --- |\n| one | two |\n");
  });
});

describe("typing in a big table", () => {
  const rows = Array.from({ length: 500 }, (_, i) => `| ${i} | name ${i} | kind | where | note ${i} |`);
  const text = "Intro.\n\n| # | Name | Kind | Where | Note |\n|---|---|---|---|---|\n" + rows.join("\n") + "\n\nAfter.\n";

  it("writes only the cell typed in again, and numbers the rows without reading the table back", () => {
    const { doc, source } = parseMarkdown(text);
    const state = EditorState.create({ doc });
    serializeMarkdown(doc, source);
    lineMarks(doc, source);
    let at = -1;
    doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === "table_cell" && node.textContent === "name 250") at = pos + node.nodeSize - 1;
      return at < 0;
    });
    // The first keystroke writes the table; the next ones write only their cell.
    const first = state.apply(state.tr.insertText("!", at));
    serializeMarkdown(first.doc, source);
    lineMarks(first.doc, source);
    const edited = first.apply(first.tr.insertText("!", at + 1)).doc;
    const nodes = vi.spyOn(schema, "node");
    const parses = vi.spyOn(MarkdownIt.prototype, "parse");
    const out = serializeMarkdown(edited, source);
    const marks = lineMarks(edited, source);
    expect(nodes.mock.calls.length).toBeLessThan(20);
    expect(parses).not.toHaveBeenCalled();
    expect(parseMarkdown(out).doc.eq(edited)).toBe(true);
    const row = marks.find((m) => m.kind === "block" && edited.nodeAt(m.from)?.firstChild?.textContent === "251");
    expect(row?.line).toBe(text.split("\n").findIndex((l) => l.startsWith("| 251 |")) + 1); // (lines count from 1)
  });
});

describe("a list without blank lines whose items hold code, a quote or a table", () => {
  const lists: [string, string, string][] = [
    ["code", "1. Install:\n   ```sh\n   npm i\n   ```\n2. Run it\n", "CodeBlock"],
    ["a quote", "- Ana said:\n  > ship it\n- Then we shipped\n", "BlockQuote"],
  ];
  /** What Pandoc reads for Word and PDF: the kinds of its blocks, nested. */
  const forWord = (markdown: string) => execFileSync(PANDOC, ["-f", PANDOC_FROM, "-t", "json"], { input: markdown, encoding: "utf8" });
  for (const [name, text, kind] of lists) {
    it(`stays without blank lines after an edit: ${name}`, () => {
      const { doc } = parseMarkdown(text);
      expect(doc.child(0).attrs.tight).toBe(true);
      const out = typeInBlock(text, 0, "!");
      expect(out).not.toMatch(/\n\s*\n/);
      expect(parseMarkdown(out).doc.child(0).attrs.tight).toBe(true);
      expect(forWord(out)).toContain(`"t":"${kind}"`);
    });
  }

  // Pandoc reads a table straight under words as more words: Word and PDF
  // showed its pipes (second review, R-MD-3). A blank line before it is the
  // only way both read a table, and it spaces the list out, as before. Since
  // Batch 24 (row 62) the list is written spaced out at once, a blank line
  // between its items too, so the next save adds nothing.
  it("writes a table under an item's words with a blank line, so Word and PDF get the table too", () => {
    const text = "- Compare the plans\n  | Plan | Cost |\n  | --- | --- |\n  | A | $5 |\n- Pick one\n";
    const out = typeInBlock(text, 0, "!");
    expect(out).toBe("- Compare the plans!\n\n  | Plan | Cost |\n  | ---- | ---- |\n  | A    | $5   |\n\n- Pick one\n");
    expect(forWord(out)).toContain('"t":"Table"');
    const again = parseMarkdown(out).doc;
    expect(again.child(0).child(0).child(1).type.name).toBe("table");
  });
});

describe("two lists of the same kind left next to each other", () => {
  /** Delete the paragraph that says "middle" and save. */
  function withoutMiddle(text: string): string {
    const { doc, source } = parseMarkdown(text);
    let range: [number, number] | null = null;
    doc.descendants((node, pos) => {
      if (!range && node.type.name === "paragraph" && node.textContent === "middle") range = [pos, pos + node.nodeSize];
      return !range;
    });
    const state = EditorState.create({ doc });
    return serializeMarkdown(state.apply(state.tr.delete(range![0], range![1])).doc, source);
  }
  const items = (text: string) => {
    const out: string[] = [];
    parseMarkdown(text).doc.forEach((n) => out.push(`${n.type.name}${n.attrs.tight ? " tight" : ""}: ${n.textContent}`));
    return out;
  };

  it("are joined into one list, as in Word, keeping it without blank lines", () => {
    const out = withoutMiddle("- a\n- b\n\nmiddle\n\n- c\n- d\n");
    expect(out).toBe("- a\n- b\n- c\n- d\n");
    expect(items(out)).toEqual(["bullet_list tight: abcd"]);
  });

  it("join numbered lists too, numbered on from the first", () => {
    const out = withoutMiddle("1. a\n2. b\n\nmiddle\n\n1. c\n2. d\n");
    expect(items(out)).toEqual(["ordered_list tight: abcd"]);
  });

  it("join inside a list item as well", () => {
    const out = withoutMiddle("- top\n  - a\n\n  middle\n\n  - b\n- end\n");
    const item = parseMarkdown(out).doc.child(0).child(0);
    expect(item.childCount).toBe(2); // "top" and one list
    expect(item.child(1).textContent).toBe("ab");
    expect(item.child(1).attrs.tight).toBe(true);
  });

  it("stay two lists when Markdown keeps them apart: other bullets", () => {
    const out = withoutMiddle("- a\n\nmiddle\n\n* c\n");
    expect(items(out)).toEqual(["bullet_list tight: a", "bullet_list tight: c"]);
  });
});

describe("a footnote with a [word]: line straight after it", () => {
  const text = "Text[^1] here.\n\n[^1]: See the annual report.\n[Note]: figures are unaudited.\n\nAfter.\n";

  it("shows that line once, as part of the note, as Markdown reads it", () => {
    const { doc } = parseMarkdown(text);
    expect(doc.textContent.split("unaudited").length - 1).toBe(1);
    expect(kinds(doc)).toEqual(["paragraph", "footnote_def", "paragraph"]);
  });

  it("writes it once after the note is edited", () => {
    const out = typeInBlock(text, 1, "!");
    expect(out.split("unaudited").length - 1).toBe(1);
    const back = parseMarkdown(out).doc;
    expect(kinds(back)).toEqual(["paragraph", "footnote_def", "paragraph"]);
    expect(back.child(1).textContent).toBe("See the annual report.\n[Note]: figures are unaudited.!");
  });

  it("does the same for a note with formatting over two lines, and one kept as Markdown text", () => {
    for (const note of ["[^1]: See **the** report.\n    More.", "[^1]: First part.\n\n    Second part."]) {
      const { doc } = parseMarkdown(`Text[^1] here.\n\n${note}\n[site]: https://example.com\n\nAfter.\n`);
      expect(doc.textContent.split("example.com").length - 1, note).toBe(1);
    }
  });
});

describe("text that looks like Markdown at the start of a line", () => {
  const para = (...kids: Node[]) => schema.node("paragraph", null, kids);
  const wraps: [string, (p: Node) => Node][] = [
    ["a paragraph", (p) => p],
    ["a quote", (p) => schema.node("blockquote", null, [p])],
    ["a list item", (p) => schema.node("bullet_list", null, [schema.node("list_item", null, [p])])],
  ];
  const cases: [string, () => Node][] = [
    ["a table's line of dashes under a line with a pipe", () => para(schema.text("Costs | Price\n:-- | --:"))],
    ["$$ starting a paragraph, with $$ on a later line", () => para(schema.text("$$1  X1\n1b/;  $$1"))],
    ["%% starting a paragraph, with %% on a later line", () => para(schema.text("%% draft\nnot hidden %% here"))],
    ["a footnote marker and a colon starting a line", () => para(schema.text("See\n"), schema.nodes.footnote_ref.create({ label: "1" }), schema.text(": the note"))],
    ["^ before a link to a note", () => para(schema.text("x ^[[Plan]] y"))],
    ["^ before a link", () => para(schema.text("x ^"), schema.text("site", [schema.marks.link.create({ href: "https://x.com" })]), schema.text(" y"))],
  ];
  for (const [name, make] of cases) {
    it(`keeps it text: ${name}`, () => {
      for (const [where, wrap] of wraps) {
        const block = wrap(make());
        const doc = schema.node("doc", null, [block, ...(name.includes("footnote") ? [schema.node("footnote_def", { label: "1" }, [schema.text("Note.")])] : [])]);
        const out = serializeMarkdown(doc, parseMarkdown("").source);
        const back = parseMarkdown(out).doc;
        expect(kinds(back)[0], `${where}: ${out}`).toBe(block.type.name);
        expect(back.child(0).textContent, `${where}: ${out}`).toBe(block.textContent);
      }
    });
  }
});

describe("square brackets escaped at the start of a list item", () => {
  it("make an ordinary item showing [ ], not a task box", () => {
    const text = "- \\[ \\] not a task\n- \\[x\\] nor this\n- [ ] a task\n";
    const list = parseMarkdown(text).doc.child(0);
    expect(list.type.name).toBe("bullet_list");
    expect([0, 1, 2].map((i) => list.child(i).attrs.checked)).toEqual([null, null, false]);
    expect(list.child(0).textContent).toBe("[ ] not a task");
    expect(parseMarkdown(typeInBlock(text, 0, "!")).doc.child(0).child(0).attrs.checked).toBe(null);
  });

  it("leave a numbered list formatted", () => {
    expect(kinds(parseMarkdown("1. \\[ \\] first step\n2. second\n").doc)).toEqual(["ordered_list"]);
  });
});

// Batch 14's leftovers (roadmap Batch 15, item 4): two slips the safety net
// found. Each now reads back as written, with nothing for the net to repair.
describe("a byte-order mark starting the file's first paragraph", () => {
  const para = (t: string) => schema.node("paragraph", null, [schema.text(t)]);
  const looksLike = ["\uFEFF> not a quote", "\uFEFF# not a heading", "\uFEFF- not a list"];

  it("is written so the paragraph reads back as itself, not as a quote, heading or list", () => {
    for (const words of looksLike) {
      const doc = schema.node("doc", null, [para(words), para("After.")]);
      const source = parseMarkdown("").source;
      const out = serializeMarkdown(doc, source);
      const back = parseMarkdown(out).doc;
      expect(kinds(back), JSON.stringify(out)).toEqual(["paragraph", "paragraph"]);
      expect(back.child(0).textContent, JSON.stringify(out)).toBe(words);
      expect(checkSave(doc, source), JSON.stringify(out)).toEqual({ ok: true, text: out, repaired: 0 });
      // Opened again and saved untouched: byte for byte.
      const again = parseMarkdown(out);
      expect(serializeMarkdown(again.doc, again.source)).toBe(out);
    }
  });

  it("reads back as itself when the paragraph above it is deleted and it starts the file", () => {
    const text = "Intro.\n\n\uFEFF> not a quote\n";
    const { doc, source } = parseMarkdown(text);
    expect(serializeMarkdown(doc, source)).toBe(text); // unedited: byte for byte
    const state = EditorState.create({ doc });
    const cut = state.apply(state.tr.delete(0, doc.child(0).nodeSize)).doc;
    const out = serializeMarkdown(cut, source);
    expect(parseMarkdown(out).doc.toJSON()).toEqual(cut.toJSON());
    expect(checkSave(cut, source)).toEqual({ ok: true, text: out, repaired: 0 });
  });

  it("is left as it is after the file's own byte-order mark, or further down", () => {
    for (const text of ["\uFEFF\uFEFF> not a quote\n", "Intro.\n\n\uFEFF> not a quote\n"]) {
      const { doc, source } = parseMarkdown(text);
      // Written afresh (no original blocks to keep), with the file's own mark if it has one.
      expect(serializeMarkdown(doc, { ...parseMarkdown("").source, bom: source.bom })).toBe(text);
      // Typed in: the net lets it through as written.
      const k = doc.childCount - 1;
      const out = typeInBlock(text, k, "!");
      expect(out).toBe(text.replace("quote\n", "quote!\n"));
      const typed = parseMarkdown(out);
      expect(typed.doc.child(k).textContent).toBe("\uFEFF> not a quote!");
      const state = EditorState.create({ doc });
      const edited = state.apply(state.tr.insertText("!", doc.content.size - 1)).doc;
      expect(checkSave(edited, source)).toEqual({ ok: true, text: out, repaired: 0 });
    }
  });
});

describe("a picture's description with a lone square bracket", () => {
  const withPicture = (alt: string) => schema.node("doc", null, [schema.node("paragraph", null, [schema.text("See "), schema.nodes.image.create({ src: "chart.png", alt })])]);
  const altOf = (text: string) => parseMarkdown(text).doc.child(0).child(1).attrs.alt;

  it("reads back as written, whatever brackets and backslashes it holds", () => {
    for (const alt of ["Q3 [draft", "Q3 draft]", "Q3 ]draft[", "a\\b", "[ok] [still", "a\\\\b ] c", "x `]` [y"]) {
      const doc = withPicture(alt);
      const source = parseMarkdown("").source;
      const out = serializeMarkdown(doc, source);
      expect(altOf(out), JSON.stringify(out)).toBe(alt);
      expect(checkSave(doc, source), JSON.stringify(out)).toEqual({ ok: true, text: out, repaired: 0 });
    }
  });

  it("keeps what a pasted description says when a backslash sits before a bracket or at the end", () => {
    // No file holds these as they are (in a file, "\[" is an escaped bracket,
    // review B15-01): they're written with every bracket and backslash
    // escaped, so the description still says exactly this.
    for (const alt of ["ends in \\", "\\[x", "a \\] b", "C:\\[docs]"]) {
      const doc = withPicture(alt);
      const source = parseMarkdown("").source;
      const out = serializeMarkdown(doc, source);
      expect(out).toBe(`See ![${alt.replace(/[\\[\]]/g, "\\$&")}](chart.png)\n`);
      const pic = new MarkdownIt().parseInline(out, {})[0].children!.find((t) => t.type === "image")!;
      expect(pic.children!.map((t) => t.content).join("")).toBe(alt);
      expect(checkSave(doc, source).ok).toBe(true);
    }
  });

  it("is written the shortest way that reads back: escaped only where a bracket would end it early", () => {
    expect(serializeMarkdown(withPicture("Q3 [draft"), parseMarkdown("").source)).toBe("See ![Q3 \\[draft](chart.png)\n");
    expect(serializeMarkdown(withPicture("Q3 [draft]"), parseMarkdown("").source)).toBe("See ![Q3 [draft]](chart.png)\n");
  });

  it("keeps a file's escaped description byte for byte, unedited and through edits", () => {
    for (const text of ["See ![Q3 \\[draft](chart.png)\n", "See ![a \\_b\\_ \\*c\\*](chart.png)\n", "See ![alt *x* [y]](chart.png)\n"]) {
      const { doc, source } = parseMarkdown(text);
      expect(serializeMarkdown(doc, source)).toBe(text);
      let out = text;
      for (let i = 0; i < 3; i++) out = typeInBlock(out, 0, "!");
      expect(out).toBe(text.replace("\n", "!!!\n"));
    }
    expect(altOf("See ![Q3 \\[draft](chart.png)\n")).toBe("Q3 [draft");
  });

  // Review B15-01: "\\*" (a backslash, then a star) and "\*" (a star) were
  // both held as "\*", so an edit of the paragraph wrote the first as the
  // second, and the net, comparing what was held, let it through.
  const described = (text: string) => {
    const pic = new MarkdownIt().parseInline(text, {})[0]?.children?.find((t) => t.type === "image");
    return pic?.children?.map((t) => `${t.type}:${t.content}`).join("|");
  };
  it("keeps each backslash's meaning through an edit of its paragraph (review B15-01)", () => {
    const texts = [
      "See ![x \\\\* y](c.png)\n",
      "See ![C:\\\\_temp\\\\*.md](c.png)\n",
      "See ![a \\\\# b](c.png)\n",
      "See ![x \\\\ y](c.png)\n",
      "See ![a `\\[` b](c.png)\n",
      "See ![a `x\\\\y` b](c.png)\n",
      "See ![a \\\\\\[ b](c.png)\n",
      "See ![a [b] \\[c\\]](c.png)\n",
      "See ![\\[x\\]](c.png)\n\n[x]: https://example.com\n",
      "See ![Q3 \\[draft\\]][]\n\n[Q3 \\[draft\\]]: c.png\n",
      "See ![Q3 \\[draft\\]]\n\n[Q3 \\[draft\\]]: c.png\n",
    ];
    for (const text of texts) {
      const { doc, source } = parseMarkdown(text);
      expect(serializeMarkdown(doc, source), JSON.stringify(text)).toBe(text);
      const out = typeInBlock(text, 0, "!");
      expect(out, JSON.stringify(text)).toBe(text.replace("\n", "!\n"));
      expect(described(out)).toBe(described(text));
      const state = EditorState.create({ doc });
      const edited = state.apply(state.tr.insertText("!", doc.child(0).nodeSize - 1)).doc;
      expect(checkSave(edited, source), JSON.stringify(text)).toEqual({ ok: true, text: out, repaired: 0 });
    }
  });
});

// Empty lines review, R-EL-13: a list kept apart from the one before it by
// its other bullet, and a rule typed at the very top, were written again at
// every keystroke.
describe("typing in a long document", () => {
  const p = (t: string) => schema.node("paragraph", null, t ? [schema.text(t)] : []);
  const items = (n: number) => schema.node("bullet_list", { bullet: "-" }, Array.from({ length: n }, (_, i) => schema.node("list_item", null, [p(`item ${i} with some words`)])));
  const paras = (n: number) => Array.from({ length: n }, (_, i) => p(`Paragraph ${i} with some words.`));
  const perKey = (kids: Node[]) => {
    let state = EditorState.create({ doc: schema.node("doc", null, kids) });
    const source = parseMarkdown("").source;
    serializeMarkdown(state.doc, source);
    let best = Infinity;
    for (let k = 0; k < 7; k++) {
      state = state.apply(state.tr.insertText("x", state.doc.content.size - 1));
      const start = performance.now();
      serializeMarkdown(state.doc, source);
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };

  it("is as quick after a list kept apart by its other bullet, and under a rule typed first, as in a plain one", () => {
    const plain = perKey([p("Intro."), items(4000), ...paras(4000), p("Typing here")]);
    const remarked = perKey([schema.node("bullet_list", { bullet: "-" }, [schema.node("list_item", null, [p("a")])]), p(""), items(4000), ...paras(4000), p("Typing here")]);
    const ruled = perKey([schema.node("horizontal_rule"), p("Intro."), items(4000), ...paras(4000), p("Typing here")]);
    expect(remarked).toBeLessThan(3 * plain + 2);
    expect(ruled).toBeLessThan(3 * plain + 2);
  }, 30_000);
});
