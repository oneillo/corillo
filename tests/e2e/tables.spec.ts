// Tables: edited as tables, never dropping into Markdown, and never broken by
// spaces, Enter, Tab, Backspace or pasting.
import { test, expect } from "@playwright/test";
import { openText, expectFile, cursorInCell, cursorAtEnd, settle, tableCells, chooseFromMenu, paste } from "./helpers";

const DOC = "Intro.\n\n| Option | Cost |\n|--------|------|\n| Tool A | Free |\n| Tool B | $5 |\n\nAfter.\n";


test("a table shows as a table, and the file isn't touched by just looking", async () => {
  const run = await openText(DOC);
  await expect(run.page.locator(".ProseMirror table")).toBeVisible();
  expect(await tableCells(run.page)).toEqual([["Option", "Cost"], ["Tool A", "Free"], ["Tool B", "$5"]]);
  await expect(run.page.locator(".ProseMirror pre.raw-block")).toHaveCount(0);
  await run.page.waitForTimeout(700);
  expect(run.text()).toBe(DOC);
  await run.app.close();
});

test("words typed in a cell, with spaces between them, stay in that cell", async () => {
  const run = await openText(DOC);
  await cursorInCell(run.page, "Tool A");
  await run.page.keyboard.type(" plus extras");
  expect((await tableCells(run.page))[1]).toEqual(["Tool A plus extras", "Free"]);
  await expect.poll(run.text).toContain("| Tool A plus extras | Free |");
  expect(run.text()).not.toContain(" ");
  await expect(run.page.locator(".ProseMirror table")).toHaveCount(1);
  await run.app.close();
});

test("a space typed at the end of a cell moves the cursor, and the next word follows it", async () => {
  const run = await openText(DOC);
  await cursorInCell(run.page, "Tool A");
  const caretX = () =>
    run.page.evaluate(() => {
      const range = window.getSelection()!.getRangeAt(0);
      const rects = range.getClientRects();
      return (rects[0] ?? range.getBoundingClientRect()).left;
    });
  const before = await caretX();
  await run.page.keyboard.type(" ");
  const after = await caretX();
  expect(after).toBeGreaterThan(before);
  expect((await tableCells(run.page))[1][0]).toBe("Tool A ");
  await run.page.keyboard.type("x");
  expect((await tableCells(run.page))[1]).toEqual(["Tool A x", "Free"]);
  await expect.poll(run.text).toContain("| Tool A x | Free |");
  await run.app.close();
});

test("a space at the start of a cell, or two in a row, never breaks the table", async () => {
  const run = await openText(DOC);
  await cursorInCell(run.page, "$5", "start");
  await run.page.keyboard.type("  ");
  await cursorInCell(run.page, "Free");
  await run.page.keyboard.type("  for  all");
  expect(await tableCells(run.page)).toEqual([["Option", "Cost"], ["Tool A", "Free  for  all"], ["Tool B", "  $5"]]);
  await expect.poll(run.text).toContain("| Tool A | Free  for  all |");
  const lines = run.text().split("\n").filter((l) => l.startsWith("|"));
  expect(lines).toHaveLength(4);
  for (const l of lines) expect(l.split("|").length).toBe(4); // two columns on every line
  await run.app.close();
});

test("selecting across cells highlights them and keeps the table formatted", async () => {
  const run = await openText(DOC);
  const from = run.page.locator(".ProseMirror td", { hasText: "Tool A" });
  const to = run.page.locator(".ProseMirror td", { hasText: "$5" });
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await run.page.mouse.move(a.x + 10, a.y + a.height / 2);
  await run.page.mouse.down();
  await run.page.mouse.move(b.x + 10, b.y + b.height / 2, { steps: 8 });
  await run.page.mouse.up();
  await expect(run.page.locator(".ProseMirror .selectedCell")).toHaveCount(4);
  await expect(run.page.locator(".ProseMirror table")).toBeVisible();
  await expect(run.page.locator(".ProseMirror pre.raw-block")).toHaveCount(0);
  // Shift and the arrow keys select cells too.
  await cursorInCell(run.page, "Option");
  await run.page.keyboard.press("Shift+ArrowDown");
  await run.page.keyboard.press("Shift+ArrowDown");
  await settle(run.page);
  await expect(run.page.locator(".ProseMirror .selectedCell").first()).toBeVisible();
  await expect(run.page.locator(".ProseMirror table")).toBeVisible();
  expect(run.text()).toBe(DOC);
  await run.app.close();
});

test("Tab goes to the next cell and selects its text, as in Word, and adds a row after the last one", async () => {
  const run = await openText(DOC);
  await cursorInCell(run.page, "Tool A");
  await run.page.keyboard.press("Tab");
  await run.page.keyboard.type("Paid");
  expect((await tableCells(run.page))[1]).toEqual(["Tool A", "Paid"]);
  await cursorInCell(run.page, "$5");
  await run.page.keyboard.press("Tab");
  await run.page.keyboard.type("Tool C");
  await run.page.keyboard.press("Tab");
  await run.page.keyboard.type("$9");
  expect(await tableCells(run.page)).toHaveLength(4);
  await expect.poll(run.text).toContain("| Tool C | $9   |");
  await run.app.close();
});

test("Enter in a cell goes to the cell below instead of splitting the table", async () => {
  const run = await openText(DOC);
  await cursorInCell(run.page, "Option");
  await run.page.keyboard.press("Enter");
  await run.page.keyboard.type("1");
  expect((await tableCells(run.page))[1][0]).toBe("Tool A1");
  await cursorInCell(run.page, "$5");
  await run.page.keyboard.press("Enter");
  await run.page.keyboard.type("new");
  expect(await tableCells(run.page)).toEqual([
    ["Option", "Cost"],
    ["Tool A1", "Free"],
    ["Tool B", "$5"],
    ["", "new"],
  ]);
  await expect(run.page.locator(".ProseMirror table")).toHaveCount(1);
  await run.app.close();
});

test("Backspace at the start of a cell and Delete at its end never merge cells", async () => {
  const run = await openText(DOC);
  await cursorInCell(run.page, "Free", "start");
  await run.page.keyboard.press("Backspace");
  await run.page.keyboard.press("Backspace");
  await cursorInCell(run.page, "Tool A");
  await run.page.keyboard.press("Delete");
  await run.page.keyboard.press("Delete");
  expect(await tableCells(run.page)).toEqual([["Option", "Cost"], ["Tool A", "Free"], ["Tool B", "$5"]]);
  await run.app.close();
});

test("code pasted into a cell keeps its lines, on screen and in the file", async () => {
  const run = await openText(DOC);
  await cursorInCell(run.page, "Tool A");
  await paste(run.page, { "text/html": "<pre><code>let a = 1;\nlet b = 2;</code></pre>", "text/plain": "let a = 1;\nlet b = 2;" });
  expect(await tableCells(run.page)).toEqual([["Option", "Cost"], ["Tool Alet a = 1;\nlet b = 2;", "Free"], ["Tool B", "$5"]]);
  await expect.poll(run.text).toContain("| Tool Alet a = 1;<br>let b = 2; | Free |");
  await run.app.close();
});

test("pasting several paragraphs into a cell keeps them in that cell", async () => {
  const run = await openText(DOC);
  await cursorInCell(run.page, "Tool A");
  await run.page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/html", "<p>one</p><p>two</p>");
    data.setData("text/plain", "one\n\ntwo");
    document.querySelector(".ProseMirror")!.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  // Each pasted paragraph on a line of its own, as in Word.
  expect(await tableCells(run.page)).toEqual([["Option", "Cost"], ["Tool Aone\ntwo", "Free"], ["Tool B", "$5"]]);
  await expect.poll(run.text).toContain("| Tool Aone<br>two | Free |");
  await run.app.close();
});

test("Insert, Table adds a table to type in", async () => {
  const run = await openText("Intro.\n");
  await cursorAtEnd(run.page, "Intro.");
  await chooseFromMenu(run.page, "Insert", "Table");
  await run.page.keyboard.type("Name");
  await run.page.keyboard.press("Tab");
  await run.page.keyboard.type("Role");
  await run.page.keyboard.press("Tab");
  await run.page.keyboard.type("Notes");
  await run.page.keyboard.press("Tab");
  await run.page.keyboard.type("Ana");
  await expectFile(
    run,
    "Intro.\n\n| Name | Role | Notes |\n| ---- | ---- | ----- |\n| Ana  |      |       |\n|      |      |       |\n",
  );
  await run.app.close();
});

test("the Table menu adds columns and aligns them", async () => {
  const run = await openText(DOC);
  await expect(run.page.getByRole("button", { name: "Table", exact: true })).toBeDisabled();
  await cursorInCell(run.page, "Cost");
  await chooseFromMenu(run.page, "Table", "Add column right");
  await run.page.keyboard.press("Tab");
  await run.page.keyboard.type("Notes");
  await cursorInCell(run.page, "Cost");
  await chooseFromMenu(run.page, "Table", "Align column right");
  await expectFile(
    run,
    "Intro.\n\n| Option | Cost | Notes |\n| ------ | ---: | ----- |\n| Tool A | Free |       |\n| Tool B | $5   |       |\n\nAfter.\n",
  );
  await run.app.close();
});

const ENDS_WITH_TABLE = "Intro.\n\n| Option | Cost |\n|--------|------|\n| Tool A | Free |\n| Tool B | $5 |\n";
const STARTS_WITH_TABLE = "| Option | Cost |\n|--------|------|\n| Tool A | Free |\n\nAfter.\n";

test("a table at the end of the document: Arrow Down from its last row leaves it, to carry on writing below", async () => {
  const run = await openText(ENDS_WITH_TABLE);
  await cursorInCell(run.page, "Tool B");
  await run.page.keyboard.press("ArrowDown");
  await run.page.keyboard.type("After");
  await expectFile(run, `${ENDS_WITH_TABLE}\nAfter\n`);
  expect(await tableCells(run.page)).toEqual([["Option", "Cost"], ["Tool A", "Free"], ["Tool B", "$5"]]);
  await run.app.close();
});

test("a table at the end of the document: Arrow Right at the end of its last cell leaves it too", async () => {
  const run = await openText(ENDS_WITH_TABLE);
  await cursorInCell(run.page, "$5");
  await run.page.keyboard.press("ArrowRight");
  await run.page.keyboard.type("After");
  await expectFile(run, `${ENDS_WITH_TABLE}\nAfter\n`);
  await run.app.close();
});

test("a table at the start of the document: Arrow Up from its header row, or Left from its first cell, leaves it, to write above", async () => {
  const run = await openText(STARTS_WITH_TABLE);
  await cursorInCell(run.page, "Cost");
  await run.page.keyboard.press("ArrowUp");
  await run.page.keyboard.type("Before");
  await expectFile(run, `Before\n\n${STARTS_WITH_TABLE}`);
  // Now there's a paragraph above, Left from the first cell goes to its end.
  await cursorInCell(run.page, "Option", "start");
  await run.page.keyboard.press("ArrowLeft");
  await run.page.keyboard.type(" and more");
  await expectFile(run, `Before and more\n\n${STARTS_WITH_TABLE}`);
  await run.app.close();
});

test("a table that is the whole document: Arrow Left from its first cell leaves it, to write above", async () => {
  const table = "| Option | Cost |\n|--------|------|\n| Tool A | Free |\n";
  const run = await openText(table);
  await cursorInCell(run.page, "Option", "start");
  await run.page.keyboard.press("ArrowLeft");
  await run.page.keyboard.type("Before");
  await expectFile(run, `Before\n\n${table}`);
  await run.app.close();
});

test("a table at the end of the document: a click below it is a place to carry on writing", async () => {
  const run = await openText(ENDS_WITH_TABLE);
  const table = await run.page.locator(".ProseMirror table").boundingBox();
  const page = await run.page.locator(".doc:not([hidden]) .page.editor").boundingBox();
  const y = table!.y + table!.height + 40;
  expect(y).toBeLessThan(page!.y + page!.height);
  await run.page.mouse.click(table!.x + table!.width / 2, y);
  await settle(run.page);
  await run.page.keyboard.type("After");
  await expectFile(run, `${ENDS_WITH_TABLE}\nAfter\n`);
  await run.app.close();
});

// Review of Batch 6: typing in the Markdown view of the speed test's document cost about 2 ms a keystroke more once
// the preview followed the cursor into its tables. A table wider than the page scrolls sideways, and each of its
// cells (placed for its own highlights) was then drawn as a piece of its own, which every frame had to sort out
// again. The table is drawn in one piece now, in the preview and in the formatted view.
test("a table wider than the page is drawn in one piece, not a piece per cell, in the preview and the formatted view", async () => {
  const rows = Array.from({ length: 40 }, (_, i) => `| Row ${i + 1} | ${i * 3} | ${"wide".repeat(30)} | more |`).join("\n");
  const text = `# Plan\n\n${"Words before the table. ".repeat(20)}\n\n| Name | Count | Wide | More |\n| --- | --- | --- | --- |\n${rows}\n\n${"After the table. ".repeat(30)}\n`;
  const run = await openText(text, { name: "plan.md" });
  const { page } = run;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("LayerTree.enable");
  /** The cells drawn as pieces of their own, once the next keystroke has been drawn. */
  const cellLayers = async (type: () => Promise<void>): Promise<number> => {
    const drawn = new Promise<{ backendNodeId?: number }[]>((resolve) =>
      cdp.on("LayerTree.layerTreeDidChange", (e: { layers?: { backendNodeId?: number }[] }) => e.layers && resolve(e.layers)),
    );
    await type();
    let cells = 0;
    for (const layer of await drawn) {
      if (!layer.backendNodeId) continue;
      const { node } = await cdp.send("DOM.describeNode", { backendNodeId: layer.backendNodeId });
      if (node.nodeName === "TD" || node.nodeName === "TH") cells++;
    }
    return cells;
  };
  // The Markdown view, typing in the table's rows, with the preview beside them.
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const source = page.getByRole("textbox", { name: "Markdown text" });
  await source.click();
  await source.evaluate((a: HTMLTextAreaElement) => a.setSelectionRange(a.value.indexOf("Row 20 "), a.value.indexOf("Row 20 ")));
  await page.keyboard.type("x");
  await expect(page.locator(".doc:not([hidden]) .page.preview")).toContainText("xRow 20");
  expect(await cellLayers(() => page.keyboard.type("y"))).toBe(0);
  // The formatted view, typing in a cell.
  await page.getByRole("button", { name: "Formatted", exact: true }).click();
  await cursorInCell(run.page, "xyRow 20");
  expect(await cellLayers(() => page.keyboard.type("z"))).toBe(0);
  await run.app.close();
});
