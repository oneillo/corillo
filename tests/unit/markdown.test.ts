import { describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { undo, history } from "prosemirror-history";
import { dropPoint } from "prosemirror-transform";
import { wrapInList } from "prosemirror-schema-list";
import type { Node } from "prosemirror-model";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import { isEmptyLine, parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { footnoteTail } from "../../src/core/markdown-tokens";
import { schema } from "../../src/core/schema";
import { bigDocument } from "../fixtures/big-document";

// Documents that must come back byte for byte when nothing is edited.
const corpus: Record<string, string> = {
  "plain paragraphs": "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n",
  "no final newline": "# Title\n\nText without a final newline",
  "extra blank lines": "\n\n# Title\n\n\n\nText\n\n\n",
  "windows line endings": "# Title\r\n\r\nLine one\r\nline two\r\n\r\n- a\r\n- b\r\n",
  "byte order mark": "﻿# Title\n\nText\n",
  "front matter": "---\nname: x\ndescription: y\n---\n\n## Current State\n- one\n- two\n",
  "front matter only": "---\ntitle: z\n---\n",
  "setext headings": "Title\n=====\n\nSub\n---\n\nText\n",
  "mixed bullets": "* star\n* star two\n\n+ plus\n\n- dash\n  - nested\n    - deeper\n",
  "ordered lists": "1. one\n2. two\n\n3) three\n4) four\n\n7. seven\n",
  "loose list": "- a\n\n- b\n\n- c\n",
  "emphasis styles": "_under_ and *star*, __bold__ and **bold**, ~~gone~~, `code`.\n",
  "escapes and entities": "Not \\*emphasis\\*, a \\_b\\_, &amp; &copy; &#35; 5 < 6.\n",
  "links and images": "A [link](http://x.com \"t\"), <https://auto.link>, ![alt](img/a.png).\n\n[ref]: http://ref.example\n\nSee [ref].\n",
  "hard breaks": "Two spaces  \nthen backslash\\\nend\n",
  "trailing spaces on blank lines": "Para\n   \nNext\n \t\n",
  "code blocks": "```js\nconst a = 1;\n```\n\n~~~\ntilde\n~~~\n\n    indented\n    code\n\nafter\n",
  // (A list whose words sit five columns in: code indented four, blank lines between, is a block of its own.)
  "indented code after a wide list": "Intro.\n\n100. item\n\n\n    code line\n",
  "indented code after a wide list, three blank lines": "Intro.\n\n100. item\n\n\n\n    code line\n",
  "indented code after a spaced-out list": "Intro.\n\n10.  item\n\n\n    code line\n",
  tables: "| a | b |\n|:--|--:|\n| 1 | 2 |\n|  spaced  |   x |\n\nAfter table.\n",
  footnotes: "Text with a note[^1] and another[^long].\n\n[^1]: The note.\n[^long]: A longer note\n    with a second line.\n\nMore text.\n",
  html: "<!-- a comment -->\n\n<div align=\"center\">\n  <b>hi</b>\n</div>\n\nText with <br> inline html.\n",
  "task lists": "- [ ] todo\n- [x] done\n",
  blockquotes: "> quoted\nlazy line\n\n> > nested\n",
  "horizontal rules": "a\n\n***\n\nb\n\n___\n\nc\n",
  tabs: "-\ttab bullet\n\n\tindented with tab\n",
  "empty file": "",
  "whitespace only": "\n\n  \n",
  unicode: "Café, naïve, 日本語 🐸\n\n- coquí\n",
};

function roundTrip(text: string): string {
  const { doc, source } = parseMarkdown(text);
  return serializeMarkdown(doc, source);
}

/** Apply an edit to the document the way the editor would, return the new Markdown. */
function edit(text: string, change: (state: EditorState) => EditorState): string {
  const { doc, source } = parseMarkdown(text);
  const state = EditorState.create({ doc, plugins: [history()] });
  return serializeMarkdown(change(state).doc, source);
}

/** Position just inside the end of the k-th top-level block. */
function endOfBlock(doc: Node, k: number): number {
  let pos = 0;
  for (let i = 0; i < k; i++) pos += doc.child(i).nodeSize;
  return pos + doc.child(k).nodeSize - 1;
}

function typeAtEndOf(k: number, text: string) {
  return (state: EditorState) => state.apply(state.tr.insertText(text, endOfBlock(state.doc, k)));
}

describe("reading and writing back unchanged documents", () => {
  for (const [name, text] of Object.entries(corpus)) {
    it(`keeps "${name}" byte for byte`, () => {
      expect(roundTrip(text)).toBe(text);
    });
  }
});

describe("editing one block changes only that block", () => {
  it("rewrites just the paragraph that was typed in", () => {
    const text = "# Title\n\n* star bullet\n* second\n\nFirst para.\n\nSecond para.\n\n| a |\n|---|\n| 1 |\n";
    const out = edit(text, typeAtEndOf(2, " Added"));
    expect(out).toBe(text.replace("First para.", "First para. Added"));
  });

  it("keeps the spacing around an edited block", () => {
    const text = "# Title\nDirectly under the title.\n\n\n\nAfter three blank lines.\n";
    const out = edit(text, typeAtEndOf(1, "!"));
    expect(out).toBe("# Title\nDirectly under the title.!\n\n\n\nAfter three blank lines.\n");
  });

  it("keeps the bullet character of an edited list", () => {
    const text = "* one\n* two\n";
    // end of the first item's paragraph: list(1) > item(1) > paragraph(1) + "one"
    const out = edit(text, (s) => s.apply(s.tr.insertText("!", 1 + 1 + 1 + 3)));
    expect(out).toBe("* one!\n* two\n");
  });

  it("keeps the emphasis markers of an edited paragraph", () => {
    const text = "_under_ and __bold__ here\n";
    const out = edit(text, typeAtEndOf(0, "."));
    expect(out).toBe("_under_ and __bold__ here.\n");
  });

  it("keeps the delimiter of an edited ordered list", () => {
    const text = "1) one\n2) two\n";
    const out = edit(text, (s) => s.apply(s.tr.insertText("!", 1 + 1 + 1 + 3)));
    expect(out).toBe("1) one!\n2) two\n");
  });

  it("writes Windows line endings throughout after an edit", () => {
    const text = "# Title\r\n\r\n- a\r\n- b\r\n\r\nPara\r\n";
    // after the heading, into list > item > paragraph, then past "a"
    const out = edit(text, (s) => s.apply(s.tr.insertText("x", s.doc.child(0).nodeSize + 1 + 1 + 1 + 1)));
    expect(out).toBe("# Title\r\n\r\n- ax\r\n- b\r\n\r\nPara\r\n");
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("keeps a table untouched when a paragraph next to it is edited (tables)", () => {
    const text = "Before.\n\n|  a  | b |\n|-----|---|\n|  1  | 2 |\n\nAfter.\n";
    const out = edit(text, typeAtEndOf(0, " More"));
    expect(out).toBe(text.replace("Before.", "Before. More"));
  });

  it("writes an edited raw block exactly as typed", () => {
    const text = "<div>\nhtml\n</div>\n";
    const out = edit(text, (s) => s.apply(s.tr.insertText(" ", endOfBlock(s.doc, 0))));
    expect(out).toBe("<div>\nhtml\n</div> \n");
  });

  it("keeps footnote definitions when the text around them changes", () => {
    const text = corpus.footnotes;
    const out = edit(text, typeAtEndOf(3, " Edited."));
    expect(out).toBe(text.replace("More text.", "More text. Edited."));
  });

  it("keeps front matter when the body changes", () => {
    const text = corpus["front matter"];
    const out = edit(text, typeAtEndOf(1, " now"));
    expect(out).toBe(text.replace("## Current State", "## Current State now"));
  });
});

describe("adding, removing and undoing", () => {
  // Changed 2026-11-09 (empty lines): the second blank line is an empty line
  // of its own, so it stays, under the new paragraph.
  it("separates a new paragraph with one blank line and leaves the rest alone", () => {
    const text = "One.\n\n\nTwo.\n";
    const out = edit(text, (s) => {
      const pos = s.doc.child(0).nodeSize;
      return s.apply(s.tr.insert(pos, schema.node("paragraph", null, [schema.text("New.")])));
    });
    expect(out).toBe("One.\n\nNew.\n\n\nTwo.\n");
  });

  it("removing a block keeps its neighbours' text", () => {
    const text = "* a\n\nMiddle.\n\n_c_\n";
    const out = edit(text, (s) => {
      const from = s.doc.child(0).nodeSize;
      return s.apply(s.tr.delete(from, from + s.doc.child(1).nodeSize));
    });
    expect(out).toBe("* a\n\n_c_\n");
  });

  it("undoing an edit gives back the original text exactly", () => {
    const text = "Para *one*.\n\n\nPara two.\n";
    const out = edit(text, (s) => {
      const typed = s.apply(s.tr.insertText("xyz", endOfBlock(s.doc, 0)));
      let undone = typed;
      undo(typed, (tr) => (undone = typed.apply(tr)));
      return undone;
    });
    expect(out).toBe(text);
  });

  // Changed 2026-11-09 (Orlando: "An empty line in markdown doc should show up
  // as an empty line in word"): an empty line pressed with Return is a blank
  // line in the file, one per press.
  it("an empty line from pressing Return is one more blank line in the file", () => {
    const text = "One.\n\nTwo.\n";
    const out = edit(text, (s) => {
      const pos = s.doc.child(0).nodeSize;
      return s.apply(s.tr.insert(pos, schema.node("paragraph")));
    });
    expect(out).toBe("One.\n\n\nTwo.\n");
    const twice = edit(text, (s) => {
      const pos = s.doc.child(0).nodeSize;
      return s.apply(s.tr.insert(pos, [schema.node("paragraph"), schema.node("paragraph")]));
    });
    expect(twice).toBe("One.\n\n\n\nTwo.\n");
    expect(parseMarkdown(twice).doc.childCount).toBe(4);
  });

  it("paragraphs dragged up the page leave the blocks they pass as the file had them", () => {
    const table = "| Item | Cost |\n|---|---|\n| Venue | 1,200 |\n| Catering | 800 |";
    const text = `Status report\n=============\n\nFirst, with an R&amp;D note.\n\n${table}\n\n* * *\n\nFifth.\n\nSixth.\n\nSeventh.\n\nThe end.\n`;
    const startOf = (doc: Node, words: string) => {
      let at = -1;
      doc.forEach((node, pos) => {
        if (at < 0 && node.textContent.startsWith(words)) at = pos;
      });
      return at;
    };
    // Fifth to Seventh selected and dropped above the first paragraph, or at the start of its words, as a drop moves them.
    for (const into of [0, 1]) {
      const out = edit(text, (s) => {
        const from = startOf(s.doc, "Fifth") + 1;
        const to = startOf(s.doc, "The end") - 1;
        const selected = s.apply(s.tr.setSelection(TextSelection.create(s.doc, from, to)));
        const slice = selected.selection.content();
        const mouse = startOf(s.doc, "First") + into;
        const tr = selected.tr.deleteSelection();
        const at = tr.mapping.map(dropPoint(selected.doc, mouse, slice) ?? mouse);
        return selected.apply(tr.replaceRange(at, at, slice));
      });
      expect(out.indexOf("Sixth.")).toBeLessThan(out.indexOf("Item"));
      expect(out).toContain("Status report\n=============\n");
      expect(out).toContain(`\n${table}\n\n* * *\n`);
      // (Dropped at the start of its words, the paragraph has the dragged words in it: edited.)
      if (!into) expect(out).toContain("\n\nFirst, with an R&amp;D note.\n\n");
    }
  });

  it("an indented code block left under a list is written with a fence, so it stays a block of its own", () => {
    const text = "- item one\n- item two\n\nSome text.\n\n    # not a heading\n    total = a + b\n\nEnd.\n";
    const shape = (doc: Node) => {
      const out: string[] = [];
      doc.forEach((n) => out.push(`${n.type.name}: ${n.textContent}`));
      return out;
    };
    const paragraph = (s: EditorState) => s.doc.child(0).nodeSize;
    // The paragraph between them deleted, or made a list item.
    const deleted = edit(text, (s) => s.apply(s.tr.delete(paragraph(s), paragraph(s) + s.doc.child(1).nodeSize)));
    expect(shape(parseMarkdown(deleted).doc)).toEqual(["bullet_list: item oneitem two", "code_block: # not a heading\ntotal = a + b", "paragraph: End."]);
    const listed = edit(text, (s) => {
      const inside = s.apply(s.tr.setSelection(TextSelection.create(s.doc, paragraph(s) + 1)));
      let next = inside;
      wrapInList(schema.nodes.bullet_list)(inside, (tr) => (next = inside.apply(tr)));
      return next;
    });
    expect(shape(parseMarkdown(listed).doc).filter((b) => b.startsWith("code_block"))).toEqual(["code_block: # not a heading\ntotal = a + b"]);
    // An empty line left between them doesn't keep them apart: Markdown reads on past blank lines.
    const spaced = text.replace("Some text.\n\n", "Some text.\n\n\n");
    const gone = edit(spaced, (s) => s.apply(s.tr.delete(paragraph(s), paragraph(s) + s.doc.child(1).nodeSize)));
    expect(shape(parseMarkdown(gone).doc).filter((b) => b.startsWith("code_block"))).toEqual(["code_block: # not a heading\ntotal = a + b"]);
    // Anywhere else it's kept as the file had it.
    expect(edit(text, typeAtEndOf(3, "!"))).toBe(text.replace("End.", "End.!"));
  });

  it("typing into an empty file gives a normal Markdown file", () => {
    const out = edit("", (s) => {
      const sel = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 1)));
      return sel.apply(sel.tr.insertText("Hello"));
    });
    expect(out).toBe("Hello\n");
  });
});

// Orlando, 2026-11-09: "An empty line in markdown doc should show up as an
// empty line in word." The blank line between two blocks is the space between
// them; each one beyond it is an empty line in the editor.
describe("empty lines", () => {
  const kinds = (t: string) => {
    const out: string[] = [];
    parseMarkdown(t).doc.forEach((n) => out.push(isEmptyLine(n) ? "empty" : n.type.name));
    return out;
  };
  const deleteBlock = (k: number) => (s: EditorState) => {
    let from = 0;
    for (let i = 0; i < k; i++) from += s.doc.child(i).nodeSize;
    return s.apply(s.tr.delete(from, from + s.doc.child(k).nodeSize));
  };
  const insertAt = (k: number, nodes: Node[]) => (s: EditorState) => {
    let at = 0;
    for (let i = 0; i < k; i++) at += s.doc.child(i).nodeSize;
    return s.apply(s.tr.insert(at, nodes));
  };
  const empty = () => schema.node("paragraph");

  it("reads each blank line beyond the one between two blocks as an empty line", () => {
    expect(kinds("A\n\nB\n")).toEqual(["paragraph", "paragraph"]);
    expect(kinds("A\n\n\nB\n")).toEqual(["paragraph", "empty", "paragraph"]);
    expect(kinds("A\n\n\n\n\nB\n")).toEqual(["paragraph", "empty", "empty", "empty", "paragraph"]);
    expect(kinds("# H\nA\n")).toEqual(["heading", "paragraph"]);
    expect(kinds("\n\nA\n")).toEqual(["empty", "empty", "paragraph"]);
    expect(kinds("```\ncode\n```\n\n\n> q\n")).toEqual(["code_block", "empty", "blockquote"]);
    // Blank lines at the end are the file's ending, not empty lines.
    expect(kinds("A\n\n\n\n")).toEqual(["paragraph"]);
  });

  it("keeps blank lines with spaces, tabs and Windows line endings byte for byte", () => {
    for (const t of ["A\r\n\r\n \t\r\n\r\nB\r\n", "\t\n  \nA\n", "A\n\n   \n\t\n- b\n", "A\r\rB\r\r\r", "﻿\n\nA"]) {
      expect(roundTrip(t)).toBe(t);
    }
  });

  it("adds a blank line for each Return on an empty line, and Backspace takes one away", () => {
    const text = "One.\n\n\nTwo.\n";
    expect(edit(text, insertAt(1, [empty()]))).toBe("One.\n\n\n\nTwo.\n");
    expect(edit(text, insertAt(2, [empty()]))).toBe("One.\n\n\n\nTwo.\n");
    expect(edit(text, deleteBlock(1))).toBe("One.\n\nTwo.\n");
    expect(edit("\nOne.\n", deleteBlock(0))).toBe("One.\n");
    expect(edit("One.\n", insertAt(0, [empty(), empty()]))).toBe("\n\nOne.\n");
  });

  it("writes nothing for empty lines after the last words, or before front matter", () => {
    expect(edit("One.\n", insertAt(1, [empty(), empty()]))).toBe("One.\n");
    expect(edit("One.\n\n\nTwo.", insertAt(3, [empty()]))).toBe("One.\n\n\nTwo.");
    const front = "---\ntitle: x\n---\n\nText\n";
    expect(edit(front, insertAt(0, [empty()]))).toBe(front);
  });

  it("doesn't let a rule become front matter when the empty line above it goes", () => {
    const text = "\n---\ntitle: x\n---\n";
    expect(kinds(text)).toEqual(["empty", "horizontal_rule", "heading"]);
    const out = edit(text, deleteBlock(0));
    expect(out).toBe("***\ntitle: x\n---\n");
    expect(kinds(out)).toEqual(["horizontal_rule", "heading"]);
  });

  it("gives words typed on an empty line the blank line Markdown needs under them", () => {
    const text = "One.\n\n\nTwo.\n";
    const out = edit(text, (s) => s.apply(s.tr.insertText("x", s.doc.child(0).nodeSize + 1)));
    expect(out).toBe("One.\n\nx\n\nTwo.\n");
    // Under it is a link definition, which would otherwise read as more of the paragraph.
    const links = "One.\n\n\n[a]: /b\n";
    const typed = edit(links, (s) => s.apply(s.tr.insertText("x", s.doc.child(0).nodeSize + 1)));
    expect(typed).toBe("One.\n\nx\n\n[a]: /b\n");
  });

  it("makes a paragraph emptied of its words an empty line", () => {
    const text = "One.\n\nMiddle.\n\nTwo.\n";
    const out = edit(text, (s) => {
      const from = s.doc.child(0).nodeSize + 1;
      return s.apply(s.tr.delete(from, from + "Middle.".length));
    });
    expect(out).toBe("One.\n\n\nTwo.\n");
    expect(kinds(out)).toEqual(["paragraph", "empty", "paragraph"]);
  });

  it("keeps two lists of the same kind apart across empty lines, with the other bullet", () => {
    const bullets = edit("- a\n\nMiddle.\n\n\n- b\n", deleteBlock(1));
    expect(bullets).toBe("- a\n\n\n* b\n");
    expect(kinds(bullets)).toEqual(["bullet_list", "empty", "bullet_list"]);
    const numbers = edit("1. a\n\nMiddle.\n\n\n1. b\n", deleteBlock(1));
    expect(numbers).toBe("1. a\n\n\n1) b\n");
    expect(kinds(numbers)).toEqual(["ordered_list", "empty", "ordered_list"]);
    // Without the empty line they're one list, as before.
    expect(edit("- a\n\nMiddle.\n\n- b\n", deleteBlock(1))).toBe("- a\n- b\n");
  });

  it("writes a new document's empty lines as blank lines", () => {
    const p = (t: string) => schema.node("paragraph", null, [schema.text(t)]);
    const doc = schema.node("doc", null, [empty(), p("A"), empty(), empty(), p("B"), empty()]);
    const fresh = { bom: false, eol: "\n" as const, prefix: "", trailing: "", blocks: [], gaps: [], original: "" };
    const out = serializeMarkdown(doc, fresh);
    expect(out).toBe("\nA\n\n\n\nB\n");
    expect(kinds(out)).toEqual(["empty", "paragraph", "empty", "empty", "paragraph"]);
  });
});

// Review W-4: the footnote plugin's last step copied every token once for
// each note; Corillo's own builds the same tokens in one pass.
describe("footnotes, read in one pass", () => {
  const reader = (own: boolean) => {
    const it = new MarkdownIt("default", { html: true }).use(footnote as unknown as (md: MarkdownIt) => void);
    if (own) it.core.ruler.at("footnote_tail", footnoteTail);
    return it;
  };
  const fixture = (name: string) => readFileSync(join(import.meta.dirname, "..", "fixtures", name), "utf8");

  it("give the same tokens as the footnote plugin's own last step", () => {
    const plugin = reader(false);
    const own = reader(true);
    const texts = [
      ...Object.values(corpus),
      fixture("obsidian-note.md"),
      fixture("word-preview.md"),
      fixture("proposal.md"),
      bigDocument(),
      "One[^a], two[^a] and an inline one.^[Right *here*.]\n\n[^a]: Said twice.\n",
      "A note[^n].\n\n[^n]: First paragraph.\n\n    Second paragraph.\n\n    - and a list\n",
      "[^unused]: Never referred to.\n\nText.\n",
      "No notes at all.\n",
    ];
    for (const text of texts) expect(own.parse(text, {})).toStrictEqual(plugin.parse(text, {}));
  });

  it("a long document with many notes is read without copying all of it once for every note", () => {
    const text = bigDocument();
    expect((text.match(/^\[\^[^\]]+\]:/gm) ?? []).length).toBe(150);
    const concat = Array.prototype.concat;
    let copied = 0;
    Array.prototype.concat = function (this: unknown[], ...rest: unknown[]) {
      const made = concat.apply(this, rest as never[]) as unknown[];
      copied += made.length;
      return made;
    } as typeof concat;
    try {
      parseMarkdown(text);
    } finally {
      Array.prototype.concat = concat;
    }
    // A few times the document's length: copied once for every note, it was about 150 times.
    expect(copied).toBeLessThan(text.split("\n").length * 20);
  });
});

describe("text that looks like Markdown", () => {
  it("escapes characters that would change meaning", () => {
    const out = edit("x\n", typeAtEndOf(0, " *not em* <div> [link]"));
    const again = parseMarkdown(out).doc;
    expect(again.textContent).toBe("x *not em* <div> [link]");
    expect(again.child(0).type.name).toBe("paragraph");
  });

  it("keeps a typed line starting with # as text, not a heading", () => {
    const out = edit("x\n", (s) => s.apply(s.tr.insertText("# not a heading", 1, endOfBlock(s.doc, 0))));
    expect(parseMarkdown(out).doc.child(0).type.name).toBe("paragraph");
  });
});

describe("what the editor shows", () => {
  const kinds = (t: string) => {
    const { doc } = parseMarkdown(t);
    const out: string[] = [];
    doc.forEach((n) => out.push(n.type.name === "raw_block" ? `raw:${n.attrs.kind}` : n.type.name));
    return out;
  };

  // Changed 2026-11-09 (the page previews Word): task lists and a paragraph
  // with <br> are shown formatted, as in Word; an HTML comment is a comment and
  // link definitions are their own kind, both left out of Word.
  it("shows Markdown it can't render yet as raw blocks", () => {
    expect(kinds(corpus["front matter"])).toEqual(["raw:front-matter", "heading", "bullet_list"]);
    expect(kinds(corpus["task lists"])).toEqual(["bullet_list"]);
    expect(kinds("1. [ ] numbered\n")).toEqual(["raw:markdown"]);
    expect(kinds(corpus.html)).toEqual(["raw:comment", "raw:html", "paragraph"]);
    expect(kinds("Text with <span>other</span> HTML.\n")).toEqual(["raw:markdown"]);
    expect(kinds("[ref]: http://x\n\nSee [ref].\n")).toEqual(["raw:links", "paragraph"]);
    expect(kinds("Inline note^[here].\n")).toEqual(["raw:markdown"]);
  });

  it("shows supported Markdown richly", () => {
    const { doc } = parseMarkdown(
      "# H\n\n- a\n\n1. b\n\n> q\n\n```\nc\n```\n\n---\n\n*e* **s** ~~x~~ `c` [l](u) ![i](p)\n",
    );
    expect(kinds("# H\n\n- a\n\n1. b\n\n> q\n\n```\nc\n```\n\n---\n\npara\n")).toEqual([
      "heading", "bullet_list", "ordered_list", "blockquote", "code_block", "horizontal_rule", "paragraph",
    ]);
    expect(kinds(corpus.tables)).toEqual(["table", "paragraph"]);
    expect(kinds(corpus.footnotes)).toEqual(["paragraph", "footnote_def", "footnote_def", "paragraph"]);
    const marks = new Set<string>();
    doc.lastChild!.descendants((n) => {
      n.marks.forEach((m) => marks.add(m.type.name));
    });
    expect([...marks].sort()).toEqual(["code", "em", "link", "strike", "strong"]);
  });
});
