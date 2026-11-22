// Tables, thoroughly: keys, rows and columns, pasting, formatting, big and
// odd tables, comments that stay put whether a table shows as a grid or as
// Markdown text, the highlight that shows where you are in a table written as
// text, switching views, history, export, and an agent editing a table.
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  openText,
  expectFile,
  cursorInCell,
  cursorAtEnd,
  selectText,
  settle,
  tableCells,
  chooseFromMenu,
  paste,
  EDITOR,
} from "./helpers";
import { AgentSession } from "./agent-session";

const DOC = "Intro.\n\n| Option | Cost |\n|--------|------|\n| Tool A | Free |\n| Tool B | $5 |\n\nAfter.\n";

/** A table as agents write them: line breaks as <br>, bold names, emoji, alignment. */
const AGENT_TABLE = `# Vendor review

| Tool | Strengths | Weaknesses | Cost | Verdict |
|---|---|---|---:|:---:|
| **Atlas** | Fast search<br>Good audit trail<br>SSO included | Clunky export<br>No offline mode | $12 | ✅ |
| **Beacon** | Clean interface<br>Strong API | Weak permissions<br>Slow support (3 days) | $9 | ⚠️ |
| **Cove** | Cheapest option<br>Open source | Needs hosting<br>No mobile app | $4 | ❌ |

The recommendation is Atlas.
`;

/** A table Corillo keeps as Markdown text: a cell holds HTML it doesn't edit as a grid. */
const RAW_TABLE = `# Q3 budget

| Line | Owner | Amount | Note |
|---|---|---:|---|
| Hiring | Ana | $120,000 | Two roles<sup>1</sup> |
| Tools | Ben | $18,000 | Renewals in <span style="color:red">September</span> |
| Travel | Cleo | $9,500 | Team offsite |

After the table.
`;

const PANEL = ".doc:not([hidden]) aside.comments-panel";
const card = (page: Page, text: string) => page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: text });
const highlights = (page: Page) => page.locator(`${EDITOR} .comment-range`).allTextContents();
const markdownBox = (page: Page) => page.getByRole("textbox", { name: "Markdown text" });
const raw = (page: Page) => page.locator(`${EDITOR} pre.raw-block`);
const litCell = (page: Page) => page.locator(`${EDITOR} .md-table-cell`).allTextContents();
const litRow = (page: Page) => page.locator(`${EDITOR} .md-table-row`).allTextContents();
const textLitCell = (page: Page) => page.locator(".doc:not([hidden]) .cell-marks:not([hidden]) .md-table-cell").allTextContents();

/** Select text, choose Comment, write the comment and post it. */
async function comment(page: Page, text: string, body: string): Promise<void> {
  await selectText(page, text);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill(body);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(card(page, body)).toBeVisible();
}

/** Put the cursor in the formatted view's text, just before some text (in a table shown as Markdown text, say). */
async function cursorBefore(page: Page, text: string, after = 0): Promise<void> {
  await page.evaluate(
    ([editor, wanted, extra]) => {
      const root = document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!;
      root.focus();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent!.indexOf(wanted);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at + extra);
        range.collapse(true);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        return;
      }
      throw new Error(`"${wanted}" isn't in the document`);
    },
    [EDITOR, text, after] as const,
  );
  await settle(page);
}

/** Put the cursor in the Markdown view's text, just before some text. */
async function caretInMarkdown(page: Page, text: string, after = 0): Promise<void> {
  await markdownBox(page).evaluate(
    (ta: HTMLTextAreaElement, [wanted, extra]) => {
      const at = ta.value.indexOf(wanted);
      if (at < 0) throw new Error(`"${wanted}" isn't in the Markdown text`);
      ta.focus();
      ta.setSelectionRange(at + extra, at + extra);
    },
    [text, after] as const,
  );
  await settle(page);
}

/** Every table line in the file has the same number of cells as the first. */
function tableLinesAgree(text: string): void {
  const lines = text.split(/\r?\n/).filter((l) => l.startsWith("|"));
  expect(lines.length).toBeGreaterThan(1);
  const count = (l: string) => l.replace(/\\\|/g, "").split("|").length;
  for (const l of lines) expect(count(l), l).toBe(count(lines[0]));
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// Keys ------------------------------------------------------------------------------

test("arrow keys move between cells and rows, and Shift-Tab goes back a cell, selecting its text", async () => {
  const run = await openText(DOC);
  const typeAfter = async (key: string, text: string) => {
    await run.page.keyboard.press(key);
    await run.page.keyboard.type(text);
  };
  // Right and left follow the text, never into the gap between cells.
  await cursorInCell(run.page, "Tool A");
  await typeAfter("ArrowRight", "X");
  expect((await tableCells(run.page))[1]).toEqual(["Tool A", "XFree"]);
  await cursorInCell(run.page, "XFree");
  await typeAfter("ArrowRight", "Y");
  expect((await tableCells(run.page))[2]).toEqual(["YTool B", "$5"]);
  await cursorInCell(run.page, "$5", "start");
  await typeAfter("ArrowLeft", "Z");
  expect((await tableCells(run.page))[2]).toEqual(["YTool BZ", "$5"]);
  // Down and up go to the cell below and above, in the same column.
  await cursorInCell(run.page, "Option");
  await typeAfter("ArrowDown", "1");
  expect((await tableCells(run.page))[1][0]).toBe("Tool A1");
  await typeAfter("ArrowUp", "2");
  expect((await tableCells(run.page))[0][0]).toBe("Option2");
  // Past the first or last row, out of the table.
  await typeAfter("ArrowUp", "3");
  await cursorInCell(run.page, "$5");
  await typeAfter("ArrowDown", "4");
  await expect.poll(run.text).toMatch(/^Intro\.3\n\n/);
  await expect.poll(run.text).toMatch(/\n4After\.\n$/);
  expect(await tableCells(run.page)).toEqual([["Option2", "Cost"], ["Tool A1", "XFree"], ["YTool BZ", "$5"]]);
  // Shift-Tab: the cell before, its text selected.
  await cursorInCell(run.page, "$5");
  await typeAfter("Shift+Tab", "Tool Z");
  expect((await tableCells(run.page))[2]).toEqual(["Tool Z", "$5"]);
  await expect.poll(run.text).toContain("| Tool Z ");
  tableLinesAgree(run.text());
  await run.app.close();
});

test("Shift-Return starts a new line in a cell, saved as <br>; Return still goes to the cell below", async () => {
  const run = await openText(DOC);
  await cursorInCell(run.page, "Tool A");
  await run.page.keyboard.press("Shift+Enter");
  await run.page.keyboard.type("second line");
  expect((await tableCells(run.page))[1]).toEqual(["Tool A\nsecond line", "Free"]);
  await run.page.keyboard.press("Enter");
  await run.page.keyboard.type("x");
  expect((await tableCells(run.page))[2]).toEqual(["Tool Bx", "$5"]);
  await expect.poll(run.text).toContain("| Tool A<br>second line | Free |");
  await expect(run.page.locator(`${EDITOR} table`)).toHaveCount(1);
  tableLinesAgree(run.text());
  // Outside a table, Shift-Return does what it always did.
  await cursorAtEnd(run.page, "After.");
  await run.page.keyboard.press("Shift+Enter");
  await run.page.keyboard.type("Next");
  await expect.poll(run.text).toMatch(/After\.\\\nNext\n$/);
  await run.app.close();
});

test("a new line in a cell is written the way the file already writes them (<br/>, <br />)", async () => {
  const run = await openText("| A | B |\n|---|---|\n| one<br/>two | three |\n");
  expect((await tableCells(run.page))[1]).toEqual(["one\ntwo", "three"]);
  await cursorInCell(run.page, "three");
  await run.page.keyboard.press("Shift+Enter");
  await run.page.keyboard.type("four");
  await expect.poll(run.text).toContain("| one<br/>two | three<br/>four |");
  await run.app.close();
});

test("Undo and Redo take back typing, line breaks and new rows in a table, one step at a time", async () => {
  const run = await openText(DOC);
  await cursorInCell(run.page, "Tool A");
  await run.page.keyboard.type(" plus");
  await run.page.waitForTimeout(600); // a pause, so the typing is its own step
  await run.page.keyboard.press("Shift+Enter");
  await run.page.keyboard.type("more");
  await run.page.waitForTimeout(600);
  await chooseFromMenu(run.page, "Table", "Add row below");
  expect(await tableCells(run.page)).toHaveLength(4);
  await run.page.keyboard.press("Meta+z");
  expect(await tableCells(run.page)).toHaveLength(3);
  await run.page.keyboard.press("Meta+z");
  expect((await tableCells(run.page))[1][0]).toBe("Tool A plus");
  await run.page.keyboard.press("Meta+z");
  expect((await tableCells(run.page))[1][0]).toBe("Tool A");
  await expectFile(run, DOC);
  await run.page.keyboard.press("Meta+Shift+z");
  await run.page.keyboard.press("Meta+Shift+z");
  expect((await tableCells(run.page))[1][0]).toBe("Tool A plus\nmore");
  await expect.poll(run.text).toContain("| Tool A plus<br>more | Free |");
  await run.app.close();
});

// Rows and columns ------------------------------------------------------------------

test("the Table menu adds and deletes rows and columns, aligns a column and deletes the table", async () => {
  const run = await openText(DOC);
  // The cursor stays where it was, as in Google Docs; the new cells are next to it.
  const typeIn = async (row: number, column: number, text: string) => {
    await run.page.locator(`${EDITOR} tr`).nth(row).locator("th, td").nth(column).click();
    await settle(run.page);
    await run.page.keyboard.type(text);
  };
  await cursorInCell(run.page, "Tool A");
  await chooseFromMenu(run.page, "Table", "Add row above");
  await typeIn(1, 0, "First");
  await cursorInCell(run.page, "Tool B");
  await chooseFromMenu(run.page, "Table", "Add row below");
  await typeIn(4, 0, "Last");
  await cursorInCell(run.page, "Option");
  await chooseFromMenu(run.page, "Table", "Add column left");
  await typeIn(0, 0, "#");
  expect(await tableCells(run.page)).toEqual([
    ["#", "Option", "Cost"],
    ["", "First", ""],
    ["", "Tool A", "Free"],
    ["", "Tool B", "$5"],
    ["", "Last", ""],
  ]);
  await cursorInCell(run.page, "Tool A");
  await chooseFromMenu(run.page, "Table", "Delete row");
  await cursorInCell(run.page, "#");
  await chooseFromMenu(run.page, "Table", "Delete column");
  await cursorInCell(run.page, "Cost");
  await chooseFromMenu(run.page, "Table", "Align column center");
  await expectFile(
    run,
    "Intro.\n\n| Option | Cost |\n| ------ | :--: |\n| First  |      |\n| Tool B | $5   |\n| Last   |      |\n\nAfter.\n",
  );
  await cursorInCell(run.page, "Last");
  await chooseFromMenu(run.page, "Table", "Delete table");
  await expect(run.page.locator(`${EDITOR} table`)).toHaveCount(0);
  await expect.poll(run.text).not.toContain("|");
  await expect.poll(run.text).toContain("Intro.");
  await expect.poll(run.text).toContain("After.");
  await run.app.close();
});

test("with the keyboard: Tab after the last cell adds a row, and Shift with the arrows selects a row or a column to delete", async () => {
  const run = await openText(DOC);
  await cursorInCell(run.page, "$5");
  await run.page.keyboard.press("Tab");
  await run.page.keyboard.type("Tool C");
  expect(await tableCells(run.page)).toHaveLength(4);
  // A whole column: from the header down.
  await cursorInCell(run.page, "Cost");
  for (let i = 0; i < 3; i++) await run.page.keyboard.press("Shift+ArrowDown");
  await expect(run.page.locator(`${EDITOR} .selectedCell`)).toHaveCount(4);
  await chooseFromMenu(run.page, "Table", "Delete column");
  expect(await tableCells(run.page)).toEqual([["Option"], ["Tool A"], ["Tool B"], ["Tool C"]]);
  // A whole row.
  await cursorInCell(run.page, "Tool B");
  await run.page.keyboard.press("Shift+ArrowDown");
  await chooseFromMenu(run.page, "Table", "Delete row");
  expect(await tableCells(run.page)).toEqual([["Option"], ["Tool A"]]);
  await expect.poll(run.text).toBe("Intro.\n\n| Option |\n| ------ |\n| Tool A |\n\nAfter.\n");
  await run.app.close();
});

test("Backspace on selected cells empties them and keeps the table's shape", async () => {
  const run = await openText(DOC);
  await cursorInCell(run.page, "Tool A");
  await run.page.keyboard.press("Shift+ArrowRight");
  await run.page.keyboard.press("Shift+ArrowDown");
  await expect(run.page.locator(`${EDITOR} .selectedCell`)).toHaveCount(4);
  await run.page.keyboard.press("Backspace");
  expect(await tableCells(run.page)).toEqual([["Option", "Cost"], ["", ""], ["", ""]]);
  await expect.poll(run.text).toContain("| Option | Cost |");
  tableLinesAgree(run.text());
  await run.app.close();
});

test("deleting a selection that runs from a paragraph into a table keeps the table whole", async () => {
  const run = await openText(DOC);
  await run.page.evaluate((editor) => {
    const root = document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!;
    root.focus();
    const start = root.querySelector("p")!.firstChild!;
    const end = [...root.querySelectorAll("td")].find((td) => td.textContent === "Tool A")!.firstChild!;
    const range = document.createRange();
    range.setStart(start, 2);
    range.setEnd(end, 4);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  }, EDITOR);
  await settle(run.page);
  await run.page.keyboard.press("Backspace");
  await settle(run.page);
  await expect(run.page.locator(`${EDITOR} table`)).toHaveCount(1);
  const cells = await tableCells(run.page);
  for (const row of cells) expect(row).toHaveLength(2);
  await expect.poll(run.text).toContain("| Tool B | $5");
  tableLinesAgree(run.text());
  await run.app.close();
});

// Pasting ---------------------------------------------------------------------------

const WORD_TABLE = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><body>
<table class=MsoTableGrid border=1 cellspacing=0 cellpadding=0 style='border-collapse:collapse;border:none'>
 <tr style='mso-yfti-irow:0;mso-yfti-firstrow:yes'>
  <td width=312 valign=top style='width:233.75pt;border:solid windowtext 1.0pt'><p class=MsoNormal><b><span lang=EN-US>Step<o:p></o:p></span></b></p></td>
  <td width=312 valign=top style='width:233.75pt;border:solid windowtext 1.0pt'><p class=MsoNormal><b><span lang=EN-US>Notes<o:p></o:p></span></b></p></td>
 </tr>
 <tr style='mso-yfti-irow:1;mso-yfti-lastrow:yes'>
  <td width=312 valign=top style='width:233.75pt;border:solid windowtext 1.0pt'><p class=MsoNormal><span lang=EN-US>Plan<o:p></o:p></span></p></td>
  <td width=312 valign=top style='width:233.75pt;border:solid windowtext 1.0pt'><p class=MsoNormal><span lang=EN-US>First line<o:p></o:p></span></p><p class=MsoNormal><span lang=EN-US>Second <b>line</b><o:p></o:p></span></p></td>
 </tr>
</table>
</body></html>`;

const DOCS_TABLE = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><div dir="ltr" align="left"><table style="border:none;border-collapse:collapse;"><tbody><tr><td><p dir="ltr"><span style="font-weight:700;">Week</span></p></td><td><p dir="ltr"><span style="font-weight:700;">Goal</span></p></td></tr><tr><td><p dir="ltr"><span style="font-weight:400;">1</span></p></td><td><p dir="ltr"><span style="font-weight:400;">Sign-ups</span><span style="font-weight:400;"><br /></span><span style="font-weight:400;">Then a survey</span></p></td></tr></tbody></table></div></b>`;

const WEB_TABLE = `<table><thead><tr><th>City</th><th>Notes</th></tr></thead><tbody><tr><td>Lima</td><td><b>Warm</b><br>Dry season</td></tr><tr><td>Oslo</td><td>Cold | windy</td></tr></tbody></table>`;

test("tables pasted from Word, Google Docs and a web page arrive as tables, lines in a cell kept", async () => {
  const run = await openText("");
  await paste(run.page, { "text/html": WORD_TABLE, "text/plain": "Step\tNotes" });
  await expectFile(run, "| Step | Notes                         |\n| ---- | ----------------------------- |\n| Plan | First line<br>Second **line** |\n");
  await run.app.close();

  const docs = await openText("");
  await paste(docs.page, { "text/html": DOCS_TABLE, "text/plain": "Week\tGoal" });
  await expect.poll(docs.text).toContain("| 1    | Sign-ups<br>Then a survey |");
  expect(await tableCells(docs.page)).toEqual([["Week", "Goal"], ["1", "Sign-ups\nThen a survey"]]);
  await docs.app.close();

  const web = await openText("");
  await paste(web.page, { "text/html": WEB_TABLE, "text/plain": "City\tNotes" });
  expect(await tableCells(web.page)).toEqual([["City", "Notes"], ["Lima", "Warm\nDry season"], ["Oslo", "Cold | windy"]]);
  await expect.poll(web.text).toContain("| Lima | **Warm**<br>Dry season |");
  await expect.poll(web.text).toContain("| Oslo | Cold \\| windy");
  tableLinesAgree(web.text());
  await web.app.close();
});

test("a Markdown table pasted as text becomes a table", async () => {
  const run = await openText("Intro.\n");
  await cursorAtEnd(run.page, "Intro.");
  await run.page.keyboard.press("Enter");
  await paste(run.page, { "text/plain": "| Name | Role |\n|---|---|\n| Ana | Lead<br>Design |\n" });
  expect(await tableCells(run.page)).toEqual([["Name", "Role"], ["Ana", "Lead\nDesign"]]);
  await expect.poll(run.text).toContain("| Ana  | Lead<br>Design |");
  await run.app.close();
});

test("pasting into a cell: paragraphs become lines in the cell, a table fills the cells from there, and text fills each selected cell", async () => {
  const run = await openText(DOC);
  await cursorInCell(run.page, "Free");
  await paste(run.page, { "text/html": "<p>From Word</p><p>two lines</p>", "text/plain": "From Word\n\ntwo lines" });
  expect((await tableCells(run.page))[1]).toEqual(["Tool A", "FreeFrom Word\ntwo lines"]);
  await expect(run.page.locator(`${EDITOR} table`)).toHaveCount(1);

  // A table pasted into a cell fills the cells from that one on.
  await cursorInCell(run.page, "Tool B", "start");
  await paste(run.page, { "text/html": "<table><tr><td>B1</td><td>B2</td></tr></table>", "text/plain": "B1\tB2" });
  expect((await tableCells(run.page))[2]).toEqual(["B1", "B2"]);

  // Plain text pasted on selected cells goes in each of them.
  await cursorInCell(run.page, "Option");
  await run.page.keyboard.press("Shift+ArrowRight");
  await expect(run.page.locator(`${EDITOR} .selectedCell`)).toHaveCount(2);
  await paste(run.page, { "text/plain": "Same" });
  expect((await tableCells(run.page))[0]).toEqual(["Same", "Same"]);
  await expect(run.page.locator(`${EDITOR} table`)).toHaveCount(1);
  await expect.poll(run.text).toContain("| Same   | Same");
  tableLinesAgree(run.text());
  await run.app.close();
});

// Content -----------------------------------------------------------------------------

test("bold, italic, code, links, escaped pipes and empty cells show as such, are left alone, and can be formatted in place", async () => {
  const text =
    "| What | Example | Empty |\n|:--|:-:|--:|\n| **Bold** and *italic* | `a \\| b` | |\n| [Link](https://example.com) | yes \\| no | |\n";
  const run = await openText(text);
  expect(await tableCells(run.page)).toEqual([
    ["What", "Example", "Empty"],
    ["Bold and italic", "a | b", ""],
    ["Link", "yes | no", ""],
  ]);
  await expect(run.page.locator(`${EDITOR} td strong`)).toHaveText("Bold");
  await expect(run.page.locator(`${EDITOR} td em`)).toHaveText("italic");
  await expect(run.page.locator(`${EDITOR} td code`)).toHaveText("a | b");
  await expect(run.page.locator(`${EDITOR} td a`)).toHaveText("Link");
  const aligns = await run.page.locator(`${EDITOR} th`).evaluateAll((ths) => ths.map((th) => getComputedStyle(th).textAlign));
  expect(aligns).toEqual(["left", "center", "right"]);
  await run.page.waitForTimeout(700);
  expect(run.text()).toBe(text);
  // Bold on a word in a cell, then typing in the empty cell.
  await selectText(run.page, "yes");
  await run.page.keyboard.press("Meta+b");
  await run.page.locator(`${EDITOR} td`).nth(5).click();
  await settle(run.page);
  await run.page.keyboard.type("filled");
  await expect.poll(run.text).toContain("| **yes** \\| no");
  const saved = run.text();
  expect(saved).toContain("`a \\| b`");
  expect(saved).toContain("[Link](https://example.com)");
  expect(saved).toMatch(/\| +filled \|\n$/);
  tableLinesAgree(saved);
  await run.app.close();
});

test("a table of one cell can be typed in and grown", async () => {
  const run = await openText("| Only |\n|---|\n");
  expect(await tableCells(run.page)).toEqual([["Only"]]);
  await cursorInCell(run.page, "Only");
  await run.page.keyboard.type(" one");
  await run.page.keyboard.press("Tab");
  await run.page.keyboard.type("Below");
  await expectFile(run, "| Only one |\n| -------- |\n| Below    |\n");
  await run.app.close();
});

test("a very wide table scrolls sideways inside the page, and a comment far to the right is brought into sight", async () => {
  const columns = Array.from({ length: 16 }, (_, i) => `Column number ${i + 1}`);
  const text = `Intro.\n\n| ${columns.join(" | ")} |\n|${columns.map(() => "---").join("|")}|\n| ${columns.map((_, i) => `Value ${i + 1}`).join(" | ")} |\n`;
  const run = await openText(text);
  const table = run.page.locator(`${EDITOR} table`);
  const sizes = await table.evaluate((t) => ({ scroll: t.scrollWidth, width: t.clientWidth }));
  expect(sizes.scroll).toBeGreaterThan(sizes.width);
  // The page itself doesn't scroll sideways.
  const canvas = await run.page.locator(".doc:not([hidden]) .canvas").evaluate((c) => ({ scroll: c.scrollWidth, width: c.clientWidth }));
  expect(canvas.scroll).toBeLessThanOrEqual(canvas.width);
  await comment(run.page, "Value 16", "The last one.");
  await table.evaluate((t) => (t.scrollLeft = 0));
  await run.page.locator(`${EDITOR} p`, { hasText: "Intro." }).click();
  await card(run.page, "The last one.").click();
  await expect(run.page.locator(`${EDITOR} .comment-range.active`)).toHaveText("Value 16");
  await expect(run.page.locator(`${EDITOR} .comment-range.active`)).toBeInViewport();
  expect(await table.evaluate((t) => t.scrollLeft)).toBeGreaterThan(0);
  await run.app.close();
});

test("tables as agents write them show as grids, and are left byte for byte as they were until edited", async () => {
  const run = await openText(AGENT_TABLE);
  expect(await tableCells(run.page)).toEqual([
    ["Tool", "Strengths", "Weaknesses", "Cost", "Verdict"],
    ["Atlas", "Fast search\nGood audit trail\nSSO included", "Clunky export\nNo offline mode", "$12", "✅"],
    ["Beacon", "Clean interface\nStrong API", "Weak permissions\nSlow support (3 days)", "$9", "⚠️"],
    ["Cove", "Cheapest option\nOpen source", "Needs hosting\nNo mobile app", "$4", "❌"],
  ]);
  await expect(raw(run.page)).toHaveCount(0);
  await comment(run.page, "Strong API", "Which one?");
  await run.page.waitForTimeout(700);
  expect(run.text()).toBe(AGENT_TABLE);
  // An edit rewrites the table, keeping its <br>s, its bold and its alignment.
  await cursorInCell(run.page, "$4");
  await run.page.keyboard.type("0");
  await expect.poll(run.text).toContain("$40");
  const saved = run.text();
  expect(saved).toContain("Fast search<br>Good audit trail<br>SSO included");
  expect(saved).toContain("**Beacon**");
  expect(saved).toMatch(/\| -+: \| :-+: \|/);
  tableLinesAgree(saved);
  await run.app.close();
});

test("a file with Windows line endings keeps them when a table in it is edited", async () => {
  const text = DOC.replace(/\n/g, "\r\n");
  const run = await openText(text);
  await cursorInCell(run.page, "Free");
  await run.page.keyboard.press("Shift+Enter");
  await run.page.keyboard.type("for now");
  await expect.poll(run.text).toContain("Free<br>for now");
  const saved = run.text();
  expect(saved.replace(/\r\n/g, "")).not.toContain("\n");
  expect(saved.startsWith("Intro.\r\n\r\n|")).toBe(true);
  expect(saved.endsWith("\r\n\r\nAfter.\r\n")).toBe(true);
  await run.app.close();
});

// A big table ----------------------------------------------------------------------------

function bigTable(rows: number, odd = ""): string {
  const lines = ["# Inventory", "", "| # | Item | Owner | Notes |", "|---|---|---|---|"];
  for (let i = 1; i <= rows; i++) lines.push(`| ${i} | Item ${i} | Person ${i % 17} | Note for row ${i}<br>second line${i === rows ? odd : ""} |`);
  return lines.join("\n") + "\n\nEnd.\n";
}

test("a 500-row table stays quick: typing in a cell, as a grid, as Markdown text, and in the Markdown view", async () => {
  test.setTimeout(120_000);
  const keys = async (page: Page, n = 20): Promise<number> => {
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      const start = performance.now();
      await page.keyboard.press(i % 2 ? "Backspace" : "x");
      times.push(performance.now() - start);
    }
    return median(times);
  };
  const moves = async (page: Page, n = 20): Promise<number> => {
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      const start = performance.now();
      await page.keyboard.press(i % 2 ? "ArrowUp" : "ArrowDown");
      times.push(performance.now() - start);
    }
    return median(times);
  };

  // As a grid.
  const text = bigTable(500);
  const run = await openText(text, { name: "big table.md" });
  await expect(run.page.locator(`${EDITOR} tr`)).toHaveCount(501, { timeout: 10_000 });
  await cursorInCell(run.page, "Item 250");
  expect(await keys(run.page)).toBeLessThan(50);
  expect(await moves(run.page)).toBeLessThan(50);
  // In the Markdown view: typing, and the cell highlight following the cursor.
  await run.page.getByRole("button", { name: "Markdown" }).click();
  await caretInMarkdown(run.page, "Item 300 ", 8);
  await expect.poll(() => textLitCell(run.page)).toEqual([" Item 300 "]);
  expect(await keys(run.page)).toBeLessThan(50);
  expect(await moves(run.page)).toBeLessThan(50);
  await expect.poll(() => textLitCell(run.page)).toEqual([" Item 300 "]);
  await run.app.close();

  // As Markdown text: one cell Corillo can't show in a grid keeps the whole table as text.
  const asText = await openText(bigTable(500, " <u>!</u>"), { name: "big text table.md" });
  await expect(raw(asText.page)).toHaveCount(1);
  await cursorBefore(asText.page, "Item 250 ", 6);
  await expect.poll(() => litCell(asText.page)).toEqual([" Item 250 "]);
  expect(await keys(asText.page)).toBeLessThan(50);
  expect(await moves(asText.page)).toBeLessThan(50);
  await asText.app.close();
});

// Comments -------------------------------------------------------------------------------

test("comments in cells: added, replied to, kept through edits to other cells and deleted rows, and resolved", async () => {
  const run = await openText(DOC.replace("| Tool B | $5 |", "| Tool B | $5 |\n| Tool C | $9 |"));
  await comment(run.page, "Free", "Free for how long?");
  await comment(run.page, "$9", "Too much.");
  // Edits elsewhere in the table, and a row deleted above the comment.
  await cursorInCell(run.page, "$5");
  await run.page.keyboard.type("0");
  await cursorInCell(run.page, "Tool B");
  await chooseFromMenu(run.page, "Table", "Delete row");
  await cursorInCell(run.page, "Option");
  await chooseFromMenu(run.page, "Table", "Add row below");
  await run.page.keyboard.type("Tool 0");
  await expect.poll(() => highlights(run.page)).toEqual(["Free", "$9"]);
  // Reply, then resolve.
  const c = card(run.page, "Free for how long?");
  await c.locator(".comment-body").click();
  await c.getByRole("textbox", { name: "Reply" }).click();
  await run.page.keyboard.type("A year.");
  await c.getByRole("button", { name: "Reply" }).click();
  await expect(c.locator(".comment-message")).toHaveCount(2);
  await c.getByRole("button", { name: "Resolve" }).click();
  await expect.poll(() => highlights(run.page)).toEqual(["$9"]);
  // The comment on a deleted row's words goes with them.
  await cursorInCell(run.page, "Tool C");
  await chooseFromMenu(run.page, "Table", "Delete row");
  await expect.poll(() => highlights(run.page)).toEqual([]);
  await run.app.close();
});

test("a comment on a table stays on its words when the table turns into Markdown text and back", async () => {
  const run = await openText(AGENT_TABLE);
  await comment(run.page, "Weak permissions", "Which permissions?");
  await comment(run.page, "Open source", "Which licence?");
  // In the Markdown view, something only Markdown text can hold goes in a cell.
  await run.page.getByRole("button", { name: "Markdown" }).click();
  await caretInMarkdown(run.page, "| $4 |", 4);
  await run.page.keyboard.type(" <u>est.</u>");
  await run.page.getByRole("button", { name: "Formatted" }).click();
  await expect(raw(run.page)).toHaveCount(1);
  await expect(raw(run.page)).toContainText("$4 <u>est.</u>");
  await expect.poll(() => highlights(run.page)).toEqual(["Weak permissions", "Open source"]);
  // Choosing the comment highlights its words in the text.
  await card(run.page, "Which permissions?").click();
  await expect(run.page.locator(`${EDITOR} .comment-range.active`)).toHaveText("Weak permissions");
  await expect(run.page.locator(`${EDITOR} .comment-range.active`)).toBeInViewport();
  // Taken out again, the table is a grid, and the comments are still on their words.
  await run.page.getByRole("button", { name: "Markdown" }).click();
  await markdownBox(run.page).evaluate((ta: HTMLTextAreaElement) => {
    ta.focus();
    const at = ta.value.indexOf(" <u>est.</u>");
    ta.setSelectionRange(at, at + " <u>est.</u>".length);
  });
  await run.page.keyboard.press("Backspace");
  await run.page.getByRole("button", { name: "Formatted" }).click();
  await expect(raw(run.page)).toHaveCount(0);
  await expect(run.page.locator(`${EDITOR} table`)).toHaveCount(1);
  await expect.poll(() => highlights(run.page)).toEqual(["Weak permissions", "Open source"]);
  await card(run.page, "Which licence?").click();
  await expect(run.page.locator(`${EDITOR} .comment-range.active`)).toHaveText("Open source");
  await expectFile(run, AGENT_TABLE);
  await run.app.close();
});

test("in a table shown as Markdown text, words can be commented on, and choosing the comment scrolls to them", async () => {
  const before = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} before the table.`).join("\n\n");
  const run = await openText(`${before}\n\n${RAW_TABLE}`);
  await expect(raw(run.page)).toHaveCount(1);
  await raw(run.page).scrollIntoViewIfNeeded();
  await comment(run.page, "Team offsite", "Is this confirmed?");
  await expect.poll(() => highlights(run.page)).toEqual(["Team offsite"]);
  // Away to the top, then the comment brings the words back into sight, highlighted.
  await run.page.locator(".doc:not([hidden]) .canvas").evaluate((c) => (c.scrollTop = 0));
  await expect(run.page.locator(`${EDITOR} .comment-range`)).not.toBeInViewport();
  await card(run.page, "Is this confirmed?").click();
  await expect(run.page.locator(`${EDITOR} .comment-range.active`)).toHaveText("Team offsite");
  await expect(run.page.locator(`${EDITOR} .comment-range.active`)).toBeInViewport();
  // Clicking the words shows their comment.
  await run.page.locator(`${EDITOR} p`, { hasText: "Paragraph 60" }).click();
  await expect(run.page.locator(`${EDITOR} .comment-range.active`)).toHaveCount(0);
  await run.page.locator(`${EDITOR} .comment-range`).click();
  await expect(run.page.locator(`${EDITOR} .comment-range.active`)).toHaveText("Team offsite");
  await expect(card(run.page, "Is this confirmed?")).toHaveClass(/active/);
  await run.page.waitForTimeout(700);
  expect(run.text()).toBe(`${before}\n\n${RAW_TABLE}`);
  await run.app.close();
});

// Where you are in a table written as text ---------------------------------------------------

test("in a table shown as Markdown text, the cell with the cursor is highlighted and its row more faintly, without moving anything", async () => {
  const run = await openText(RAW_TABLE);
  const box = await raw(run.page).boundingBox();
  await cursorBefore(run.page, "$18,000", 2);
  await expect.poll(() => litCell(run.page)).toEqual([" $18,000 "]);
  expect((await litRow(run.page)).join("")).toBe('| Tools | Ben | $18,000 | Renewals in <span style="color:red">September</span> |');
  expect(await raw(run.page).boundingBox()).toEqual(box);
  // The highlight follows the cursor from cell to cell.
  for (let i = 0; i < 9; i++) await run.page.keyboard.press("ArrowRight");
  await expect.poll(() => litCell(run.page)).toEqual([' Renewals in <span style="color:red">September</span> ']);
  await run.page.keyboard.press("ArrowUp");
  await expect.poll(async () => (await litRow(run.page)).join("")).toBe("| Hiring | Ana | $120,000 | Two roles<sup>1</sup> |");
  // In the header and the row of dashes, too: they show which column you're in.
  await cursorBefore(run.page, "Owner", 1);
  await expect.poll(() => litCell(run.page)).toEqual([" Owner "]);
  await cursorBefore(run.page, "|---|", 1);
  await expect.poll(() => litCell(run.page)).toEqual(["---"]);
  await expect.poll(async () => (await litRow(run.page)).join("")).toBe("|---|---|---:|---|");
  // Outside the table, nothing.
  await cursorAtEnd(run.page, "After the table.");
  await expect.poll(() => litRow(run.page)).toEqual([]);
  await run.page.waitForTimeout(700);
  expect(run.text()).toBe(RAW_TABLE);
  await run.app.close();
});

test("in the Markdown view, the cell with the cursor is highlighted behind the text, and follows typing and scrolling", async () => {
  const run = await openText(AGENT_TABLE);
  await run.page.getByRole("button", { name: "Markdown" }).click();
  await caretInMarkdown(run.page, "Clean interface", 3);
  await expect.poll(() => textLitCell(run.page)).toEqual([" Clean interface<br>Strong API "]);
  await run.page.keyboard.type("XY");
  await expect.poll(() => textLitCell(run.page)).toEqual([" CleXYan interface<br>Strong API "]);
  await run.page.keyboard.press("Backspace");
  await run.page.keyboard.press("Backspace");
  // The layer sits exactly behind the text area, set in the same type.
  const fit = await run.page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>(".doc:not([hidden]) textarea.source")!;
    const layer = document.querySelector<HTMLElement>(".doc:not([hidden]) .cell-marks")!;
    const text = layer.firstElementChild as HTMLElement;
    const a = ta.getBoundingClientRect();
    const b = layer.getBoundingClientRect();
    return {
      box: [a.left - b.left, a.top - b.top, a.width - b.width, a.height - b.height].map(Math.round),
      font: getComputedStyle(text).font === getComputedStyle(ta).font,
    };
  });
  expect(fit).toEqual({ box: [0, 0, 0, 0], font: true });
  // Off the table, nothing.
  await caretInMarkdown(run.page, "The recommendation");
  await expect.poll(() => textLitCell(run.page)).toEqual([]);
  // The file was never touched by any of it.
  await run.page.waitForTimeout(700);
  expect(run.text()).toBe(AGENT_TABLE);
  await run.app.close();
});

test("switching views keeps your place in a table: the same cell, highlighted, both ways", async () => {
  const run = await openText(AGENT_TABLE);
  await cursorBefore(run.page, "Slow support", 4);
  await run.page.getByRole("button", { name: "Markdown" }).click();
  await expect.poll(() => textLitCell(run.page)).toEqual([" Weak permissions<br>Slow support (3 days) "]);
  const caret = await markdownBox(run.page).evaluate((ta: HTMLTextAreaElement) => ta.value.slice(ta.selectionStart - 4, ta.selectionStart + 4));
  expect(caret).toBe("Slow sup");
  // Somewhere else in the text, then back to the grid: the cursor is there.
  await caretInMarkdown(run.page, "| $12 |", 5);
  await run.page.getByRole("button", { name: "Formatted" }).click();
  await run.page.keyboard.type("0");
  expect((await tableCells(run.page))[1][3]).toBe("$120");
  await run.page.keyboard.press("Backspace");

  // A table shown as Markdown text: the same characters, highlighted in both views.
  const rawRun = await openText(RAW_TABLE);
  await cursorBefore(rawRun.page, "Cleo", 2);
  await expect.poll(() => litCell(rawRun.page)).toEqual([" Cleo "]);
  await rawRun.page.getByRole("button", { name: "Markdown" }).click();
  await expect.poll(() => textLitCell(rawRun.page)).toEqual([" Cleo "]);
  await caretInMarkdown(rawRun.page, "$9,500", 3);
  await rawRun.page.getByRole("button", { name: "Formatted" }).click();
  await expect.poll(() => litCell(rawRun.page)).toEqual([" $9,500 "]);
  await rawRun.page.keyboard.type("!");
  await expect.poll(rawRun.text).toContain("| $9,!500 |");
  await rawRun.app.close();
  await run.app.close();
});

// History and export ------------------------------------------------------------------------

test("History lists the table edit, and its version marks a changed cell and a new line in a cell", async () => {
  const run = await openText(AGENT_TABLE);
  await cursorInCell(run.page, "$9");
  await run.page.keyboard.press("Shift+Enter");
  await run.page.keyboard.type("per seat");
  await expect.poll(run.text).toContain("| $9<br>per seat |");
  await run.page.getByRole("button", { name: "History", exact: true }).click();
  await expect.poll(() => run.page.locator(".doc:not([hidden]) .history-panel .history-who").allTextContents()).toEqual([
    "You",
    "First version",
  ]);
  await run.page.locator(".doc:not([hidden]) .history-panel .history-item").first().click();
  const version = ".doc:not([hidden]) .version-view .ProseMirror";
  // The new line and the words after it, marked as added in the cell.
  await expect(run.page.locator(`${version} td ins.diff-added`, { hasText: "per seat" })).toBeVisible();
  await expect(run.page.locator(`${version} td ins.diff-added br`)).toHaveCount(1);
  await expect(run.page.locator(`${version} table`)).toHaveCount(1);
  await run.app.close();
});

test("Word and PDF exports keep the lines in a cell", async () => {
  test.setTimeout(120_000);
  const run = await openText(AGENT_TABLE);
  const save = async (name: string, format: "Export to Word" | "PDF") => {
    const out = join(run.folder, name);
    await run.app.evaluate(({ dialog }, chosen) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
    }, out);
    await chooseFromMenu(run.page, "Export", format);
    await expect(run.page.locator(".export-notice")).toContainText(`Exported to ${name}`, { timeout: 45_000 });
    return out;
  };
  const docx = await save("review.docx", "Export to Word");
  const xml = execFileSync("unzip", ["-p", docx, "word/document.xml"], { encoding: "utf8" });
  const cell = [...xml.matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((m) => m[1]).find((tc) => tc.includes("Fast search"))!;
  expect(cell).toContain("<w:br />");
  expect(cell).toContain("Good audit trail");
  expect(xml).not.toContain("&lt;br");
  // The PDF is printed from the formatted document: note its text as printed.
  await run.app.evaluate(({ webContents }) => {
    const g = globalThis as unknown as { printed: string[] };
    g.printed = [];
    const proto = Object.getPrototypeOf(webContents.getAllWebContents()[0]);
    const original = proto.printToPDF;
    proto.printToPDF = async function (this: Electron.WebContents, ...args: unknown[]) {
      g.printed.push(await this.executeJavaScript("document.body.innerText"));
      return original.apply(this, args);
    };
  });
  const pdf = await save("review.pdf", "PDF");
  expect(readFileSync(pdf).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  const printed = (await run.app.evaluate(() => (globalThis as unknown as { printed: string[] }).printed)).join("\n");
  expect(printed).toContain("Fast search\nGood audit trail\nSSO included");
  expect(printed).not.toContain("<br>");
  await run.app.close();
});

// An agent ----------------------------------------------------------------------------------

test("an agent edits a table through its tools: the grid follows, and the person's comments stay on their words", async () => {
  test.setTimeout(90_000);
  const run = await openText(AGENT_TABLE, { name: "review.md" });
  await comment(run.page, "Weak permissions", "Which permissions?");
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await claude.ok("take_document", { path: run.file });
    // A cell changed, and a line added in another.
    await claude.ok("edit_document", {
      path: run.file,
      edits: [
        { find: "| $9 |", replace: "| $10 |" },
        { find: "Clean interface<br>Strong API", replace: "Clean interface<br>Strong API<br>Good docs" },
      ],
    });
    await expect.poll(async () => (await tableCells(run.page))[2]).toEqual([
      "Beacon",
      "Clean interface\nStrong API\nGood docs",
      "Weak permissions\nSlow support (3 days)",
      "$10",
      "⚠️",
    ]);
    await expect.poll(() => highlights(run.page)).toEqual(["Weak permissions"]);
    // Something only Markdown text can hold: the table shows as text, the comment still on its words.
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "| $4 |", replace: "| $4<sup>*</sup> |" }] });
    await expect(raw(run.page)).toHaveCount(1);
    await expect.poll(() => highlights(run.page)).toEqual(["Weak permissions"]);
    // And back to a grid.
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "<sup>*</sup>", replace: "" }] });
    await expect(raw(run.page)).toHaveCount(0);
    await expect.poll(() => highlights(run.page)).toEqual(["Weak permissions"]);
    // The comment is still the person's, waiting for the agent: finishing asks once, then lets go.
    const first = await claude.call("finish_editing", { path: run.file });
    if (!/back with the person/.test(first.text)) await claude.ok("finish_editing", { path: run.file });
    expect(readFileSync(run.file, "utf8")).toBe(
      AGENT_TABLE.replace("| $9 |", "| $10 |").replace("Clean interface<br>Strong API", "Clean interface<br>Strong API<br>Good docs"),
    );
  } finally {
    await claude.stop();
    await run.app.close();
  }
});

// The file left alone ---------------------------------------------------------------------

test("tables only looked at, clicked in and moved through are never rewritten", async () => {
  const text = `${AGENT_TABLE}\n${RAW_TABLE.replace("# Q3 budget\n\n", "")}`;
  const run = await openText(text);
  await cursorInCell(run.page, "Fast search");
  await run.page.keyboard.press("Shift+Tab");
  await run.page.keyboard.press("Tab");
  await run.page.keyboard.press("ArrowDown");
  await cursorBefore(run.page, "$18,000", 1);
  await run.page.keyboard.press("ArrowDown");
  await run.page.getByRole("button", { name: "Markdown" }).click();
  await caretInMarkdown(run.page, "Needs hosting");
  await run.page.getByRole("button", { name: "Formatted" }).click();
  await run.page.waitForTimeout(800);
  expect(run.text()).toBe(text);
  await run.app.close();
});

test("in the Markdown view, typing in a table at the end of a long document is as quick as in a paragraph, and the cell's highlight sits on its text", async () => {
  test.setTimeout(120_000);
  const { bigDocument } = await import("../fixtures/big-document");
  const table = "| Item | Owner | Due |\n| --- | --- | --- |\n" + Array.from({ length: 20 }, (_, i) => `| Task ${i} | Ana | May |`).join("\n") + "\n";
  const run = await openText(`${bigDocument()}\n\nClosing paragraph here.\n\n${table}`);
  await run.page.addStyleTag({ content: "::-webkit-scrollbar { width: 15px; height: 15px; }" });
  await run.page.getByRole("button", { name: "Markdown" }).click();
  await run.page.waitForTimeout(1000);
  /** The median time from a key to the next frame, over 30 keys typed after these characters. */
  const typing = async (after: string) => {
    await run.page.evaluate((wanted) => {
      const area = document.querySelector<HTMLTextAreaElement>(".doc:not([hidden]) textarea.source")!;
      const at = area.value.indexOf(wanted) + wanted.length;
      area.focus();
      area.setSelectionRange(at, at);
      const lat: number[] = [];
      const w = window as unknown as { lat: number[]; stopTiming?: () => void };
      w.stopTiming?.();
      w.lat = lat;
      const onKey = (e: KeyboardEvent) => {
        const t0 = e.timeStamp;
        requestAnimationFrame(() => {
          const c = new MessageChannel();
          c.port1.onmessage = () => lat.push(performance.now() - t0);
          c.port2.postMessage(null);
        });
      };
      addEventListener("keydown", onKey, true);
      w.stopTiming = () => removeEventListener("keydown", onKey, true);
    }, after);
    await run.page.waitForTimeout(400);
    for (const ch of "abcdefghijklmnopqrstuvwxyzabcd") {
      await run.page.keyboard.press(ch);
      await run.page.waitForTimeout(45);
    }
    await run.page.waitForTimeout(300);
    const lat = await run.page.evaluate(() => (window as unknown as { lat: number[] }).lat.slice().sort((a, b) => a - b));
    return lat[Math.floor(lat.length / 2)];
  };
  const paragraph = await typing("Closing paragraph");
  const cell = await typing("| Task 18 ");
  console.log(`Markdown view, end of a long document: ${paragraph.toFixed(1)} ms a key in a paragraph, ${cell.toFixed(1)} ms in a table cell`);
  // Before, each key in the table laid out the whole document above it again (about 30 ms more).
  expect(cell).toBeLessThan(paragraph + 10);
  // The highlight sits where the cell's text is: the same place as the whole text up to the row, set in one piece, would put it.
  await expect.poll(() => textLitCell(run.page)).toEqual([" Task 18 abcdefghijklmnopqrstuvwxyzabcd"]);
  const gap = await run.page.evaluate(() => {
    const text = document.querySelector<HTMLElement>(".doc:not([hidden]) .cell-marks-text")!;
    const area = document.querySelector<HTMLTextAreaElement>(".doc:not([hidden]) textarea.source")!;
    const mark = text.querySelector(".md-table-cell")!;
    const lineFrom = area.value.lastIndexOf("\n", area.value.indexOf("| Task 18")) + 1;
    const whole = text.cloneNode(false) as HTMLElement;
    const row = text.querySelector(".md-table-row")!.cloneNode(true);
    whole.append(area.value.slice(0, lineFrom), row);
    whole.style.position = "absolute";
    whole.style.top = "0";
    text.parentElement!.append(whole);
    const offset = (el: Element, box: Element) => {
      const [a, b] = [el.getBoundingClientRect(), box.getBoundingClientRect()];
      return [Math.round(a.top - b.top), Math.round(a.left - b.left)];
    };
    const wanted = offset(whole.querySelector(".md-table-cell")!, whole);
    const got = offset(mark, text);
    whole.remove();
    return [got[0] - wanted[0], got[1] - wanted[1]];
  });
  expect(gap).toEqual([0, 0]);
  await run.app.close();
});
