// Front matter (Obsidian's properties, Corillo's "Document details") versus a
// file that simply opens with a horizontal rule.
import { describe, it, expect } from "vitest";
import { frontMatterEnd } from "../../src/core/front-matter";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { withoutFrontMatter } from "../../src/main/export-prep";

const kinds = (text: string) => {
  const out: string[] = [];
  parseMarkdown(text).doc.forEach((n) => out.push(n.type.name === "raw_block" ? `raw:${n.attrs.kind}` : n.type.name));
  return out;
};
const roundTrip = (text: string) => {
  const { doc, source } = parseMarkdown(text);
  return serializeMarkdown(doc, source);
};

describe("front matter", () => {
  it("is YAML between --- lines at the very top", () => {
    const yes = [
      "---\ntitle: Q3 planning\ntags:\n  - planning\n---\n\n# Q3\n",
      "---\naliases: [Q3 plan]\n...\nBody.\n",
      "---\n---\nBody.\n",
      "---\n# a comment first\ntitle: x\n---\n",
      "---\ntags:\n- a list\n---\n",
      "---\ntitle: x\n\nnotes: |\n  a block of text\n  over lines\n# a comment\naliases:\n  - one\n  - two\n---\n\nBody.\n",
      '---\n{"title": "JSON works too"}\n---\n',
      "---   \ndate: 2026-11-09\n---\n",
      "---\r\ntitle: x\r\n---\r\n",
      "---\n'quoted key': x\n---\n",
    ];
    for (const text of yes) {
      expect(kinds(text)[0], text).toBe("raw:front-matter");
      expect(roundTrip(text), text).toBe(text);
    }
  });

  it("isn't a horizontal rule followed by a blank line: that's a rule, and what follows is the document", () => {
    const text = "---\n\nThe intro, after a rule.\n\nMore text.\n\n---\n\nThe end.\n";
    expect(kinds(text)).toEqual(["horizontal_rule", "paragraph", "paragraph", "horizontal_rule", "paragraph"]);
    expect(roundTrip(text)).toBe(text);
    expect(withoutFrontMatter(text)).toBe(text);
  });

  it("isn't a rule and a line of ordinary words either (a heading underlined with ---)", () => {
    const text = "---\nAn intro line\n---\n\nBody.\n";
    expect(kinds(text)).toEqual(["horizontal_rule", "heading", "paragraph"]);
    expect(roundTrip(text)).toBe(text);
    expect(withoutFrontMatter(text)).toBe(text);
  });

  it("needs its closing line, and must be at the very top", () => {
    expect(frontMatterEnd(["---", "title: x"])).toBe(-1);
    expect(frontMatterEnd(["", "---", "title: x", "---"])).toBe(-1);
    expect(frontMatterEnd([" ---", "title: x", "---"])).toBe(-1);
    expect(frontMatterEnd(["---"])).toBe(-1);
    expect(frontMatterEnd(["---", "title: x", "more: y", "---", "body"])).toBe(3);
  });

  // Changed 2026-11-09 night: the whole block must look like YAML, with at
  // least one "name:", not just its first line ("---\n- a list\n---" was
  // front matter before; Obsidian doesn't show a list alone as properties).
  it("isn't a rule, then ordinary text or a heading, then another rule", () => {
    const no = [
      "---\n# Title\nSome intro\n---\n## Section\n",
      "---\nNote: this matters\nmore words\n\n## Section\n\ntext\n\n---\n",
      "---\n- one\n- two\n---\n",
      "---\n# Title\n---\n",
    ];
    for (const text of no) {
      expect(frontMatterEnd(text.split("\n")), text).toBe(-1);
      expect(kinds(text)[0], text).not.toBe("raw:front-matter");
      expect(roundTrip(text), text).toBe(text);
      expect(withoutFrontMatter(text), text).toBe(text);
    }
    expect(kinds("---\n# Title\nSome intro\n---\n## Section\n")).toEqual(["horizontal_rule", "heading", "heading", "heading"]);
  });

  it("is the same block for the editor and for exports", () => {
    expect(withoutFrontMatter("---\ntitle: x\n---\n\nBody.\n")).toBe("Body.\n");
    expect(withoutFrontMatter("---\n\ntitle: x\n---\n\nBody.\n")).toBe("---\n\ntitle: x\n---\n\nBody.\n");
  });
});
