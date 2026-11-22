// Corillo and Obsidian (people move notes between the two): Obsidian's
// syntax, as its public help describes it, comes back exactly as written,
// whether the note was edited in Corillo or not. Corillo never puts a
// backslash into a [[link]], an embed, a callout's [!type], math or a comment.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EditorState } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { schema } from "../../src/core/schema";
import { calloutColour, calloutOf, findObsidian, linkText, parseLink } from "../../src/core/obsidian";

const NOTE = readFileSync(join(import.meta.dirname, "..", "fixtures", "obsidian-note.md"), "utf8");

const roundTrip = (text: string) => {
  const { doc, source } = parseMarkdown(text);
  return serializeMarkdown(doc, source);
};

/** Where a piece of text is in the document: the position just after it. */
function after(doc: Node, wanted: string): number {
  let at = -1;
  doc.descendants((node, pos) => {
    if (at >= 0) return false;
    if (!node.isTextblock) return true;
    let text = "";
    node.forEach((child) => (text += child.isText ? child.text : "\uFFFC"));
    const i = text.indexOf(wanted);
    if (i >= 0) at = pos + 1 + i + wanted.length;
    return false;
  });
  if (at < 0) throw new Error(`"${wanted}" isn't in the document`);
  return at;
}

/** Type after some text in the editor and return the file as Corillo writes it. */
function typeAfter(text: string, wanted: string, typed: string): string {
  const { doc, source } = parseMarkdown(text);
  const state = EditorState.create({ doc });
  return serializeMarkdown(state.apply(state.tr.insertText(typed, after(doc, wanted))).doc, source);
}

describe("an Obsidian note opened and saved without edits", () => {
  it("comes back byte for byte", () => {
    expect(roundTrip(NOTE)).toBe(NOTE);
  });

  it("comes back byte for byte with Windows line endings", () => {
    const crlf = NOTE.replace(/\n/g, "\r\n");
    expect(roundTrip(crlf)).toBe(crlf);
  });
});

describe("editing next to Obsidian's syntax leaves it as written", () => {
  const cases: [string, string, string][] = [
    [
      "links to notes, headings and blocks",
      "See [[Ana López]], [[Team/Marcus|Marcus]], [[Q2 review#Lessons]] and [[Q2 review#^key-numbers|the numbers]].",
      ".",
    ],
    ["links to headings in the same note", "Back to [[#Tasks]] and [[#^idea-list]].", "."],
    ["embeds", "Here ![[chart.png]] and ![[chart.png|300]] and ![[chart.png|640x480]] and ![[Q2 review#Goals]].", "."],
    ["link names with underscores and stars", "Read [[my_notes_file]] and [[*draft* plan]].", "."],
    ["highlights", "Budget is ==tight this quarter== and **==not negotiable==**.", "."],
    ["tags", "Filed under #planning, #team/marketing, #café_noir and #snake_case_tag", " ok"],
    ["a comment", "This is an %%inline [x] *comment* with a [[link]]%% here.", "."],
    ["math", "Growth is $r = \\frac{a_1}{b_1}$ and $x * y < z_2$ and $\\{a\\}$.", "."],
    ["display math in a line", "Inline $$\\int_0^1 x\\,dx$$ here.", "."],
    ["dollar amounts", "Prices are $5 and $10, or $1,000.", "."],
    ["a block id", "The key paragraph. ^abc-123", ""],
  ];
  for (const [name, line, typed] of cases) {
    it(`keeps ${name}`, () => {
      const text = `${line}\n\nAfter.\n`;
      // Type at the very start of the paragraph's words, so the syntax itself isn't touched.
      const { doc, source } = parseMarkdown(text);
      const state = EditorState.create({ doc });
      const out = serializeMarkdown(state.apply(state.tr.insertText("Edited: ", 1)).doc, source);
      expect(out).toBe(`Edited: ${line}\n\nAfter.\n`);
      if (typed) {
        const end = doc.child(0).nodeSize - 1;
        const typedAtEnd = serializeMarkdown(state.apply(state.tr.insertText(typed, end)).doc, source);
        expect(typedAtEnd).toBe(`${line}${typed}\n\nAfter.\n`);
      }
    });
  }

  it("keeps a block id after an edit before it", () => {
    expect(typeAfter("The key paragraph. ^abc-123\n", "The key paragraph", ", edited")).toBe(
      "The key paragraph, edited. ^abc-123\n",
    );
  });

  it("keeps a heading's tag", () => {
    expect(typeAfter("# Q3 planning #planning\n", "Q3 planning", " notes")).toBe("# Q3 planning notes #planning\n");
  });

  it("keeps a link and an embed with a | inside a table cell, escaped as Obsidian asks", () => {
    const text = "| Owner | Link |\n| ----- | ---- |\n| Ana | [[Ana López\\|Ana]] |\n| Lee | ![[chart.png\\|100]] |\n";
    const out = typeAfter(text, "Lee", " Kim");
    expect(out).toContain("[[Ana López\\|Ana]]");
    expect(out).toContain("![[chart.png\\|100]]");
    expect(out).toContain("Lee Kim");
    expect(roundTrip(out)).toBe(out);
  });
});

describe("callouts edited in Corillo stay callouts", () => {
  const callout = "> [!note] Why this matters\n> Launch dates moved twice.\n> We want one date we keep.\n";

  it("keeps the title on its own line when the body is edited", () => {
    expect(typeAfter(callout, "we keep", ", always")).toBe(
      "> [!note] Why this matters\n> Launch dates moved twice.\n> We want one date we keep, always.\n",
    );
  });

  it("keeps the [!type] when the title is edited", () => {
    expect(typeAfter(callout, "Why this matters", " now")).toBe(callout.replace("matters", "matters now"));
  });

  it("keeps a folded callout's sign", () => {
    const text = "> [!tip]- Folded by default\n> Keep the deck short.\n";
    expect(typeAfter(text, "short", " and clear")).toBe("> [!tip]- Folded by default\n> Keep the deck short and clear.\n");
  });

  it("keeps a callout with no title", () => {
    const text = "> [!warning]\n> No title on this one.\n";
    expect(typeAfter(text, "this one", " either")).toBe("> [!warning]\n> No title on this one either.\n");
  });

  it("keeps nested callouts (with no quote line between them added: only the line typed on is written again)", () => {
    const text = "> [!question] Can callouts be nested?\n> > [!todo] Yes, they can.\n> > Like this.\n";
    const out = typeAfter(text, "Like this", " one");
    expect(out).toBe("> [!question] Can callouts be nested?\n> > [!todo] Yes, they can.\n> > Like this one.\n");
    const quote = parseMarkdown(out).doc.child(0);
    expect(quote.child(0).textContent).toBe("[!question] Can callouts be nested?");
    expect(quote.child(1).child(0).textContent).toBe("[!todo] Yes, they can.\nLike this one.");
  });

  it("keeps the lines of a quote that a line without > continues", () => {
    const text = "- loose a\n\n- loose b\n\n  second para\n| a | b |\n|:--|--:|\n| 1 | 2 |\n";
    const out = typeAfter(text, "| 1", "!");
    // (Only the paragraph typed in is written again, its lines after what they had before them.)
    expect(out).toBe("- loose a\n\n- loose b\n\n  second para\n\\| a | b |\n\\|:--|--:|\n\\| 1! | 2 |\n");
    expect(parseMarkdown(out).doc.child(0).lastChild!.lastChild!.textContent).toBe("second para\n| a | b |\n|:--|--:|\n| 1! | 2 |");
  });
});

describe("single line breaks inside a paragraph (Obsidian shows them as new lines)", () => {
  it("are kept when the paragraph is edited", () => {
    expect(typeAfter("Line one\nLine two\nLine three\n", "Line three", "!")).toBe("Line one\nLine two\nLine three!\n");
  });

  it("are kept in a list item and a footnote", () => {
    expect(typeAfter("- item one\n  continued\n- two\n", "continued", "!")).toBe("- item one\n  continued!\n- two\n");
    expect(typeAfter("Note[^1].\n\n[^1]: First line\n    second line.\n", "second line", "!")).toBe(
      "Note[^1].\n\n[^1]: First line\n    second line!.\n",
    );
  });

  it("show as line breaks in the editor's text", () => {
    expect(parseMarkdown("Line one\nLine two\n").doc.child(0).textContent).toBe("Line one\nLine two");
  });

  it("become spaces in a heading underlined over two lines", () => {
    const { doc } = parseMarkdown("Title on\ntwo lines\n=====\n");
    expect(doc.child(0).textContent).toBe("Title on two lines");
  });

  it("never leave an empty line that would split the paragraph", () => {
    const { doc, source } = parseMarkdown("One\nTwo\nThree\n");
    const state = EditorState.create({ doc });
    // Delete "Two", leaving two line breaks next to each other.
    const out = serializeMarkdown(state.apply(state.tr.delete(5, 8)).doc, source);
    expect(out).toBe("One\nThree\n");
  });
});

describe("what Corillo writes is what Obsidian expects", () => {
  it("doesn't escape a link typed in Corillo", () => {
    expect(typeAfter("See.\n", "See", " [[New note]]")).toBe("See [[New note]].\n");
  });

  it("still escapes brackets that aren't a link", () => {
    expect(typeAfter("See.\n", "See", " [x] and [[half")).toBe("See \\[x\\] and \\[\\[half.\n");
  });

  it("escapes a link split by formatting, so it reads back as shown", () => {
    const { doc, source } = parseMarkdown("x\n");
    const em = schema.marks.em.create();
    const para = schema.nodes.paragraph.create(null, [schema.text("[[a"), schema.text("b", [em]), schema.text("c]]")]);
    const out = serializeMarkdown(schema.node("doc", null, [para]), source);
    expect(out).toBe("\\[\\[a*b*c\\]\\]\n");
    expect(parseMarkdown(out).doc.child(0).eq(para)).toBe(true);
  });

  it("writes a picture's address with %20 for spaces, as Obsidian's help shows", () => {
    const { doc, source } = parseMarkdown("Chart:\n");
    const state = EditorState.create({ doc });
    const pic = schema.nodes.image.create({ src: "Q3%20plan%20images/chart%20one.png", alt: "chart one" });
    const out = serializeMarkdown(state.apply(state.tr.insert(7, pic)).doc, source);
    expect(out).toBe("Chart:![chart one](Q3%20plan%20images/chart%20one.png)\n");
    expect(parseMarkdown(out).doc.child(0).child(1).attrs.src).toBe("Q3%20plan%20images/chart%20one.png");
  });

  it("keeps letters readable in a picture's address", () => {
    const { doc, source } = parseMarkdown("x\n");
    const state = EditorState.create({ doc });
    const pic = schema.nodes.image.create({ src: "Caf%C3%A9%20images/a%20(1).png", alt: "a" });
    const out = serializeMarkdown(state.apply(state.tr.insert(1, pic)).doc, source);
    expect(out).toBe("![a](Café%20images/a%20\\(1\\).png)x\n");
    expect(parseMarkdown(out).doc.child(0).child(0).attrs.src).toBe("Caf%C3%A9%20images/a%20(1).png");
  });

  it("still reads pictures written with <angle brackets>", () => {
    const text = "![chart](<Q3 plan images/chart.png>)\n";
    expect(roundTrip(text)).toBe(text);
    expect(parseMarkdown(text).doc.child(0).child(0).attrs.src).toBe("Q3%20plan%20images/chart.png");
  });
});

describe("how the editor holds Obsidian's syntax", () => {
  const kinds = (t: string) => {
    const out: string[] = [];
    parseMarkdown(t).doc.forEach((n) => out.push(n.type.name === "raw_block" ? `raw:${n.attrs.kind}` : n.type.name));
    return out;
  };

  it("keeps a comment over several lines, and display math, as they are", () => {
    expect(kinds("%%\nA block comment.\n\nWith two paragraphs.\n%%\n\nAfter.\n")).toEqual(["raw:comment", "paragraph"]);
    expect(kinds("$$\n\\begin{x}a\\\\\nb\\end{x}\n$$\n\nAfter.\n")).toEqual(["raw:math", "paragraph"]);
  });

  it("shows a %% that never closes, and $$ followed by a blank line, as ordinary text", () => {
    expect(kinds("%%\nNever closed.\n")).toEqual(["paragraph"]);
    expect(kinds("$$\n\nNot math.\n")).toEqual(["paragraph", "paragraph"]);
  });

  it("keeps callouts, highlights, tags and links editable", () => {
    expect(kinds("> [!note] Title\n> Body\n\n==hi== #tag [[Note]]\n")).toEqual(["blockquote", "paragraph"]);
  });

  it("reads nothing inside a link, math or a comment as formatting", () => {
    const para = parseMarkdown("[[my_*file*]] $a*b*c$ %%x *y*%%\n").doc.child(0);
    expect(para.childCount).toBe(1);
    expect(para.textContent).toBe("[[my_*file*]] $a*b*c$ %%x *y*%%");
  });

  // Changed 2026-11-09 night: "[[1]](https://...)" is how AI tools write a source,
  // so "]]" right before "(" makes an ordinary link whose words are in brackets.
  it("reads [[Note]](address) as an ordinary link whose words are [Note]", () => {
    const para = parseMarkdown("[[Note]](https://x.org)\n").doc.child(0);
    expect(para.textContent).toBe("[Note]");
    expect(para.firstChild!.marks[0].attrs.href).toBe("https://x.org");
  });

  it("still reads a note link when something other than ( follows it", () => {
    expect(parseMarkdown("[[Note]] (https://x.org)\n").doc.child(0).textContent).toBe("[[Note]] (https://x.org)");
  });
});

describe("finding Obsidian's syntax in a line", () => {
  const found = (t: string) => findObsidian(t).map((f) => `${f.kind}:${t.slice(f.from, f.to)}`);

  it("finds links, embeds, highlights, tags, comments, math and block ids", () => {
    expect(found("[[A|b]] ![[c.png|300]] ==hi== #tag %%c%% $x$ end ^id-1")).toEqual([
      "link:[[A|b]]",
      "embed:![[c.png|300]]",
      "highlight:==hi==",
      "tag:#tag",
      "comment:%%c%%",
      "math:$x$",
      "blockid:^id-1",
    ]);
  });

  it("knows what isn't a tag", () => {
    expect(found("#1984 a#b # heading x #y1984 #a/b-c_d #🐸frog")).toEqual(["tag:#y1984", "tag:#a/b-c_d", "tag:#🐸frog"]);
  });

  it("knows what isn't a highlight", () => {
    expect(found("a == b and a === b and == x== and ==x ==")).toEqual([]);
  });

  it("finds a link inside a highlight", () => {
    expect(found("==see [[Note]]==")).toEqual(["highlight:==see [[Note]]==", "link:[[Note]]"]);
  });

  it("knows what isn't math", () => {
    expect(found("$5 and $10 and $ x$ and $x $ and `$x$`".replace("`$x$`", "\uFFFC".repeat(5)))).toEqual([]);
  });

  it("takes a link apart", () => {
    const link = parseLink("[[Q2 review#Lessons#Budget|the lessons]]");
    expect(link).toMatchObject({ embed: false, path: "Q2 review", subpath: "Lessons#Budget", alias: "the lessons", size: null });
    expect(linkText(link)).toBe("the lessons");
    expect(linkText(parseLink("[[Q2 review#Lessons#Budget]]"))).toBe("Q2 review > Lessons > Budget");
    expect(linkText(parseLink("[[Projects/Plan.md]]"))).toBe("Plan");
    expect(linkText(parseLink("[[#Tasks]]"))).toBe("Tasks");
    expect(linkText(parseLink("[[Note#^abc]]"))).toBe("Note");
    expect(parseLink("![[chart.png|640x480]]")).toMatchObject({ embed: true, path: "chart.png", size: { width: 640, height: 480 }, alias: null });
    expect(parseLink("[[Ana López\\|Ana]]")).toMatchObject({ path: "Ana López", alias: "Ana" });
    const raw = "[[Team/Marcus|Marcus]]";
    const shown = parseLink(raw).shown;
    expect(raw.slice(shown[0], shown[1])).toBe("Marcus");
    expect("[[Plan]]".slice(...parseLink("[[Plan]]").shown)).toBe("Plan");
  });

  it("reads a callout's first line", () => {
    expect(calloutOf("[!tip]- Folded by default")).toMatchObject({ type: "tip", fold: "-", title: "Folded by default", markerEnd: 8 });
    expect(calloutOf("[!WARNING]")).toMatchObject({ type: "warning", title: "", shownTitle: "Warning" });
    expect(calloutOf("[!note]Title")?.markerEnd).toBe(7);
    expect(calloutOf("Not [!note]")).toBeNull();
    expect(calloutColour("faq")).toBe("ochre");
    expect(calloutColour("my-own-type")).toBe("sky");
  });
});
