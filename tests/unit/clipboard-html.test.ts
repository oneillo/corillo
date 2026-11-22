// What copying from Corillo puts on the clipboard as formatted text, for
// Outlook, Gmail and Word: what the page shows, line for line (roadmap L-3).
// Each blank line the page shows is a line of its own, a paragraph's own line
// breaks are line breaks, tight lists stay tight and tables keep the page's
// look, written so every app sees it without Corillo's styles. And Copy for
// Email: the whole document without its details or Subject line.
import { describe, expect, it } from "vitest";
import { Fragment, Slice } from "prosemirror-model";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { clipboardHTML, emailBody, forEmail, linesFromClipboard, sliceMarkdown } from "../../src/core/clipboard-text";
import { schema } from "../../src/core/schema";
import { spacingOf } from "../../src/renderer/blank-lines";
import { footnoteNumbers } from "../../src/renderer/footnotes";
import { bigDocument } from "../fixtures/big-document";

/** The clipboard's HTML for the words between `start` and `end` (the whole document when not given), without ProseMirror's own note on it. */
function copied(markdown: string, start?: string, end?: string): string {
  const { doc, source } = parseMarkdown(markdown);
  const text = (s: string) => {
    let at = -1;
    doc.descendants((node, pos) => {
      if (at < 0 && node.isText && node.text!.includes(s)) at = pos + node.text!.indexOf(s);
      return at < 0;
    });
    if (at < 0) throw new Error(`"${s}" isn't in the document`);
    return at;
  };
  const from = start === undefined ? 0 : text(start);
  const to = end === undefined ? doc.content.size : text(end) + end.length;
  const numbers = footnoteNumbers(doc);
  return clipboardHTML(doc.slice(from, to, true), from, { spacing: spacingOf(doc, source), number: (l) => String(numbers.get(l) ?? "") }).replace(
    / data-pm-slice="[^"]*"/,
    "",
  );
}

const P = '<p style="margin:0">';
const GAP = '<div style="margin:0"><br></div>';
const EMPTY = `${P}<br></p>`;

const EMAIL = "Hi Ana,\n\nThanks for Tuesday.\n\n\nTwo times work for me:\n- Thursday afternoon\n- Friday morning\n\nBest,\nAlex\n";

describe("copied text for Outlook, Gmail and Word", () => {
  it("has a line for each line the page shows: the blank line between paragraphs, each empty line, and a paragraph's own line breaks", () => {
    expect(copied(EMAIL)).toBe(
      `${P}Hi Ana,</p>${GAP}${P}Thanks for Tuesday.</p>${GAP}${EMPTY}${P}Two times work for me:</p>` +
        '<ul data-tight="true" style="margin:0"><li>Thursday afternoon</li><li>Friday morning</li></ul>' +
        `${GAP}${P}Best,<br data-markup="&#10;">Alex</p>`,
    );
  });

  it("keeps blocks the file writes close together close: a list under its paragraph, text under its heading", () => {
    const html = copied("# Plan\nWe hire two people.\n\nSteps:\n1. Post the role\n2. Interview\n");
    expect(html).toBe(
      '<h1 style="margin:6pt 0 3pt">Plan</h1>' +
        `${P}We hire two people.</p>${GAP}${P}Steps:</p>` +
        '<ol data-tight="true" style="margin:0"><li>Post the role</li><li>Interview</li></ol>',
    );
  });

  it("keeps a line between the items of a list the file spaces out, inside the item above, as Word gets it", () => {
    expect(copied("- One\n\n- Two\n")).toBe(`<ul style="margin:0"><li>${P}One</p>${GAP}</li><li>${P}Two</p></li></ul>`);
    // A list inside an item, written straight under its words, stays close to them.
    expect(copied("- One\n  - Inner\n\n- Two\n")).toContain(`<li>${P}One</p><ul data-tight="true" style="margin:0"><li>Inner</li></ul>${GAP}</li>`);
  });

  it("draws a quote with a rule at its left, as the page does, and keeps its lines", () => {
    expect(copied("> Quoted\n> on two lines\n\nAfter.\n")).toBe(
      `<blockquote style="margin:0;padding-left:1em;border-left:3px solid #C3D3DA">${P}Quoted<br data-markup="&#10;">on two lines</p></blockquote>${GAP}${P}After.</p>`,
    );
  });

  it("gives a table the page's look (a rule under the header, hairlines between rows), with no grid", () => {
    const html = copied("| Week | Goal |\n|---|:--:|\n| 1 | Hire |\n| 2 | Train |\n");
    expect(html).not.toMatch(/border="|cellpadding/);
    // Header cells take the table's left alignment rather than centring, and are bold as header cells
    // always are. Neither is written on the cell, where Corillo would read it back as bold words and a
    // left-aligned column.
    expect(html).toMatch(/^<table style="border-collapse:collapse;margin:0;text-align:left"><tbody>/);
    expect(html).toContain('<th style="padding:5px 10px;vertical-align:top;border-bottom:1px solid #A9B2B8">Week</th>');
    // A centred column stays centred.
    expect(html).toMatch(/<th style="[^"]*;text-align: center;">Goal<\/th>/);
    expect(html).toContain('<td style="padding:5px 10px;vertical-align:top;border-bottom:1px solid #E3E7E6">1</td>');
    // The last row closes the table with a slightly darker line.
    expect(html).toContain('<td style="padding:5px 10px;vertical-align:top;border-bottom:1px solid #D2D8D7">2</td>');
  });

  it("spells out footnote numbers, keeps pictures, links, bold and code, and writes code as it is", () => {
    const html = copied("A **bold** [link](https://example.com) and `code`.[^1] ![Chart](chart.png)\n\n```\nlet a = 1;\n\nlet b = 2;\n```\n\n[^1]: The source.\n");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('<a href="https://example.com">link</a>');
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('<sup class="footnote-ref" data-label="1">1</sup>');
    expect(html).toContain('<img src="chart.png" data-src="chart.png" alt="Chart">');
    expect(html).toContain('<pre style="margin:0"><code>let a = 1;\n\nlet b = 2;</code></pre>');
    expect(html).toContain('<div class="footnote-def" data-label="1" style="margin:0"><span class="footnote-number">1. </span><span>The source.</span></div>');
  });

  it("writes characters that mean something in HTML as text", () => {
    expect(copied("1 < 2 & 3 > 2, \"quoted\"\n")).toBe(`${P}1 &lt; 2 &amp; 3 &gt; 2, "quoted"</p>`);
  });

  it("copies a few words as just those words, and a selection from the middle of one paragraph to another as those parts", () => {
    expect(copied("Hello there, Ana.\n", "there", "there")).toBe(`${P}there</p>`);
    expect(copied("First words here.\n\nSecond words here.\n", "here.", "Second")).toBe(`${P}here.</p>${GAP}${P}Second</p>`);
  });

  it("notes what ProseMirror needs to read the copy back as the same document", () => {
    const { doc, source } = parseMarkdown("| A | B |\n|---|---|\n| one | two |\n\nAfter.\n");
    const options = { spacing: spacingOf(doc, source), number: () => "" };
    expect(clipboardHTML(doc.slice(0, doc.content.size, true), 0, options)).toMatch(/^<table data-pm-slice="0 0 \[\]" /);
    // One cell's words: the cell, in the table and row it came from.
    let at = 0;
    doc.descendants((node, pos) => {
      if (node.isText && node.text === "one") at = pos;
      return !at;
    });
    expect(clipboardHTML(doc.slice(at, at + 3, true), at, options)).toBe(
      '<table data-pm-slice="1 1 -3 [&quot;table&quot;,null,&quot;table_row&quot;,null]"><tbody><tr><td style="padding:5px 10px;vertical-align:top;border-bottom:1px solid #E3E7E6">one</td></tr></tbody></table>',
    );
  });

  it("marks the first element when asked (Corillo's mark on its own copies)", () => {
    const { doc, source } = parseMarkdown("Words.\n");
    const html = clipboardHTML(doc.slice(0, doc.content.size, true), 0, { spacing: spacingOf(doc, source), number: () => "", mark: { "data-corillo": "abc" } });
    expect(html).toBe('<p data-corillo="abc" data-pm-slice="0 0 []" style="margin:0">Words.</p>');
  });
});

describe("reading Corillo's own copy back", () => {
  it("turns a paragraph's own line breaks back into the line breaks the file has", () => {
    const br = (markup: string | null) => schema.nodes.hard_break.create({ markup });
    const pasted = new Slice(Fragment.from(schema.nodes.paragraph.create(null, [schema.text("Best,"), br("\n"), schema.text("Alex"), br(null), schema.text("Ana")])), 1, 1);
    const back = linesFromClipboard(pasted);
    expect(back.content.firstChild!.childCount).toBe(3);
    expect(back.content.firstChild!.textContent).toBe("Best,\nAlexAna");
    expect(back.content.firstChild!.child(1).type.name).toBe("hard_break");
    expect(back.openStart).toBe(1);
  });

  it("leaves a copy with no such line breaks as it is", () => {
    const slice = parseMarkdown("Plain words.\n").doc.slice(0);
    expect(linesFromClipboard(slice)).toBe(slice);
  });
});

describe("Copy for Email", () => {
  const body = (markdown: string) => {
    const { doc } = parseMarkdown(markdown);
    const found = emailBody(doc);
    if (!found) return null;
    const slice = doc.slice(found.from, found.to, true);
    return { subject: found.subject, text: sliceMarkdown(slice) };
  };

  it("copies the whole document", () => {
    const { doc } = parseMarkdown(EMAIL);
    expect(emailBody(doc)).toEqual({ subject: null, from: 0, to: doc.content.size });
  });

  it("leaves out the document details at the top and a first line starting Subject:, and gives the subject back", () => {
    const text = "---\ntitle: Follow-up\n---\n\nSubject: Following up: Chief of Staff\n\nHi Ana,\n\nBest,\nAlex\n";
    expect(body(text)).toEqual({ subject: "Following up: Chief of Staff", text: "Hi Ana,\n\nBest,\nAlex" });
  });

  it("finds the subject however it's written: bold, in capitals, as a heading, or straight over the first line", () => {
    expect(body("**Subject:** Lunch on Friday?\n\nHi Ana,\n")).toEqual({ subject: "Lunch on Friday?", text: "Hi Ana," });
    expect(body("SUBJECT: Lunch\n\nHi Ana,\n")?.subject).toBe("Lunch");
    expect(body("# Subject: Lunch\n\nHi Ana,\n")).toEqual({ subject: "Lunch", text: "Hi Ana," });
    expect(body("Subject: Lunch\nHi Ana,\n\nSee you.\n")).toEqual({ subject: "Lunch", text: "Hi Ana,\n\nSee you." });
  });

  it("leaves out empty lines before and after the words, but keeps those between them", () => {
    expect(body("Subject: Lunch\n\n\n\nHi Ana,\n\n\nSee you.\n\n\n\n")).toEqual({ subject: "Lunch", text: "Hi Ana,\n\n\nSee you." });
  });

  it("keeps a Subject: that isn't the first line, and has nothing to copy in a document with no words", () => {
    expect(body("Hi Ana,\n\nSubject: lunch, as we said.\n")?.subject).toBeNull();
    expect(body("")).toBeNull();
    expect(body("---\ntitle: x\n---\n")).toBeNull();
    expect(body("Subject: Only a subject\n")).toEqual({ subject: "Only a subject", text: "" });
  });
});

describe("Copy for Email leaves out what the page hides and Word leaves out (B1-01)", () => {
  const LETTER = [
    "Subject: Budget %% check with Ana %%",
    "",
    "Hi Ana, %% don't mention the budget %% see [[Plan#Goals|the goals]] and [[Q3 plan]]. ^abc1",
    "",
    "<!-- TODO: check the date -->",
    "",
    "Read [the brief][b] and ![[Notes]] first. ![[chart.png]]",
    "",
    "- [ ] Call Ana",
    "- [x] Book the room",
    "",
    "%% a note to self %%",
    "",
    "Thanks <!-- the real reason --> for waiting.",
    "",
    "Best,",
    "Alex",
    "",
    "[b]: https://example.com/brief",
    "",
  ].join("\n");
  /** What Copy for Email puts on the clipboard, without ProseMirror's own note on it. */
  const email = (markdown: string) => {
    const parsed = parseMarkdown(markdown);
    const shown = forEmail(parsed.doc, spacingOf(parsed.doc, parsed.source));
    const found = emailBody(shown.doc)!;
    const slice = shown.doc.slice(found.from, found.to, true);
    const numbers = footnoteNumbers(shown.doc);
    const html = clipboardHTML(slice, found.from, { spacing: shown.spacing, number: (l) => String(numbers.get(l) ?? "") }).replace(/ data-pm-slice="[^"]*"/, "");
    return { subject: found.subject, html, text: sliceMarkdown(slice) };
  };

  it("leaves out both kinds of comment, a block id and the link definitions, from the formatted text, the plain text and the subject", () => {
    const { subject, html, text } = email(LETTER);
    expect(subject).toBe("Budget");
    for (const copied of [html, text]) {
      expect(copied).not.toMatch(/check with Ana|don't mention|TODO|note to self|the real reason|\^abc1|%%|<!--|\[b\]:/);
      expect(copied).toContain("Best,");
    }
  });

  it("shows a link to a note as the words it shows, and keeps a link written by reference working", () => {
    const { html, text } = email(LETTER);
    expect(html).toContain("see the goals and Q3 plan.");
    expect(html).toContain('Read <a href="https://example.com/brief">the brief</a> and Notes first.');
    expect(text).toContain("see the goals and Q3 plan.");
    expect(text).toContain("Read [the brief](https://example.com/brief) and Notes first.");
    expect(html + text).not.toMatch(/\[\[|chart\.png/);
  });

  it("does the same in a paragraph that also held a <!-- --> comment", () => {
    const { html, text } = email("See the [[Q3 plan|plan]] and **the [brief][b]**.<!-- ask Sam -->\n\nEnd.\n\n[b]: https://example.com/brief\n");
    expect(html).toBe(`${P}See the plan and <strong>the <a href="https://example.com/brief">brief</a></strong>.</p>${GAP}${P}End.</p>`);
    expect(text).toBe("See the plan and **the [brief](https://example.com/brief)**.\n\nEnd.");
  });

  it("writes task boxes the page shows, ticked or not", () => {
    const { html } = email(LETTER);
    expect(html).toContain('<li class="task" data-checked="false" style="list-style-type:none"><span class="task-box" style="line-height:1">☐ </span>Call Ana</li>');
    expect(html).toContain('<li class="task" data-checked="true" style="list-style-type:none"><span class="task-box" style="line-height:1">☒ </span>Book the room</li>');
  });

  it("leaves no empty line where something left out was: one line apart stays one", () => {
    const { html } = email("Hi Ana,\n\n<!-- private -->\n\n%% also private %%\n\nSee you.\n");
    expect(html).toBe(`${P}Hi Ana,</p>${GAP}${P}See you.</p>`);
  });
});

describe("task boxes in any copy (B1-01)", () => {
  it("are written so an email shows them, ticked or not, in a list spaced out too", () => {
    const html = copied("- [ ] Call Ana\n\n- [x] Book the room\n");
    expect(html).toContain(`<li class="task" data-checked="false" style="list-style-type:none">${P}<span class="task-box" style="line-height:1">☐ </span>Call Ana</p>${GAP}</li>`);
    expect(html).toContain(`<li class="task" data-checked="true" style="list-style-type:none">${P}<span class="task-box" style="line-height:1">☒ </span>Book the room</p></li>`);
    // An ordinary item has no box.
    expect(copied("- One\n")).toBe('<ul data-tight="true" style="margin:0"><li>One</li></ul>');
  });
});

describe("a long document", () => {
  const { doc, source } = parseMarkdown(bigDocument());
  const spacing = spacingOf(doc, source);
  const numbers = footnoteNumbers(doc);
  const all = doc.slice(0, doc.content.size, true);

  it("is copied as formatted text in a moment (about 6 ms on an M4 Mac mini; the best of three under 100)", () => {
    const times = [0, 1, 2].map(() => {
      const start = performance.now();
      clipboardHTML(all, 0, { spacing, number: (l) => String(numbers.get(l) ?? "") });
      return performance.now() - start;
    });
    console.log(`Copying a 30,000-word document as formatted text: ${Math.min(...times).toFixed(1)} ms`);
    expect(Math.min(...times)).toBeLessThan(100);
  });

  it("copies every word of it", () => {
    const html = clipboardHTML(all, 0, { spacing, number: (l) => String(numbers.get(l) ?? "") });
    const last = serializeMarkdown(doc, source).trimEnd().split("\n").pop()!;
    expect(last).toMatch(/^\[\^source-150\]: /);
    expect(html).toContain(last.replace(/^\[\^[^\]]+\]: /, ""));
  });
});
