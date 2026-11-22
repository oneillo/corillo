// Pasting from other apps, Paste and Match Style, and copying out.
// The clipboard contents here are written by hand to look like what each app
// puts on the clipboard; the real clipboard is never touched.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  openText,
  expectFile,
  cursorAtEnd,
  settle,
  paste,
  copySelection,
  captureClipboardWrites,
  clipboardHoldsText,
  clipboardHoldsHtml,
  clickMenu,
  chooseFromMenu,
  pickInNextDialog,
  openAlso,
  openFromFinder,
  selectText,
  cursorInCell,
  EDITOR,
  FIXTURES,
} from "./helpers";

const PNG = join(FIXTURES, "chart.png");
const fixture = (name: string) => readFileSync(join(FIXTURES, "paste", name), "utf8");

/** A web server on this computer that serves the test picture, as a website would. */
function pictureServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/survey.png") {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(readFileSync(PNG));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/survey.png` });
    });
  });
}

test("pasting from Word keeps the structure and drops Word's clutter", async () => {
  // Word puts its pictures in a temporary folder and points at them from the HTML.
  const clipFolder = mkdtempSync(join(tmpdir(), "corillo-clip-"));
  copyFileSync(PNG, join(clipFolder, "clip_image001.png"));
  const html = fixture("word.html").replaceAll("{{PICTURE}}", pathToFileURL(join(clipFolder, "clip_image001.png")).href);
  const run = await openText("");
  await clipboardHoldsHtml(run.app, html); // what the person copied in Word, as they paste it
  await paste(run.page, { "text/html": html, "text/plain": "Quarterly plan\nWe will grow the pilot and drop the old tool." });
  await expectFile(
    run,
    [
      "# Quarterly plan",
      "",
      "We will **grow** the *pilot* and ~~drop~~ the old tool. See [the plan](https://example.com/plan).",
      "",
      "## Steps",
      "",
      "- Talk to the team",
      "- Pick a **date**",
      "  - Tell finance",
      "- Send the invite",
      "",
      "1. Draft",
      "2. Review",
      "",
      "| Owner | Due |",
      "| ----- | --- |",
      "| Ana   | May |",
      "",
      "![Sales chart](proposal%20images/clip_image001.png)",
      "",
    ].join("\n"),
  );
  expect(readdirSync(join(run.folder, "proposal images"))).toEqual(["clip_image001.png"]);
  await run.app.close();
});

test("pasting from Google Docs keeps the formatting that matters", async () => {
  const run = await openText("");
  await paste(run.page, { "text/html": fixture("google-docs.html"), "text/plain": "Launch notes" });
  await expectFile(
    run,
    [
      "# Launch notes",
      "",
      "The **beta** starts *next week*. Old dates are ~~cancelled~~. Details in [the brief](https://docs.example.com/launch).",
      "",
      "- Invite testers",
      "  - Internal first",
      "- Collect feedback",
      "",
      "| Week | Goal     |",
      "| ---- | -------- |",
      "| 1    | Sign-ups |",
      "",
    ].join("\n"),
  );
  await run.app.close();
});

test("pasting from Pages turns its big text into headings", async () => {
  const run = await openText("");
  await paste(run.page, { "text/html": fixture("pages.html"), "text/plain": "Trip budget" });
  await expectFile(
    run,
    [
      "# Trip budget",
      "",
      "Flights are **booked** and the hotel is *pending*. The old plan is ~~off~~.",
      "",
      "## Costs",
      "",
      "- Flights",
      "- Hotel",
      "",
      "Total to follow.",
      "",
    ].join("\n"),
  );
  await run.app.close();
});

test("pasting from an Outlook email drops the empty lines and the tracking picture", async () => {
  const run = await openText("");
  await paste(run.page, { "text/html": fixture("outlook.html"), "text/plain": "Hi all," });
  await expectFile(
    run,
    [
      "Hi all,",
      "",
      "Here is the **agenda** for Friday:",
      "",
      "- Budget review",
      "- Hiring plan, see [the tracker](https://intranet.example.com/hiring)",
      "",
      "Thanks,",
      "",
      "Ana",
      "",
    ].join("\n"),
  );
  await run.app.close();
});

test("pasting from a web page keeps the content and saves its pictures with the document", async () => {
  const { server, url } = await pictureServer();
  const dataUrl = `data:image/png;base64,${readFileSync(PNG).toString("base64")}`;
  const html = fixture("web-page.html").replaceAll("{{IMAGE_URL}}", url).replaceAll("{{DATA_URL}}", dataUrl);
  const run = await openText("");
  await paste(run.page, { "text/html": html, "text/plain": "Why it matters" });
  await expectFile(
    run,
    [
      "## Why it matters",
      "",
      "Teams that **write first** make *better* decisions. New Read the [full study](https://blog.example.com/study) or see `notes.md`.",
      "",
      "> Writing is thinking.",
      "",
      "```bash",
      "npm install corillo",
      "```",
      "",
      // The picture written into the paste is saved first (it never waits on the web), so it's "Picture".
      "![Survey results](proposal%20images/Picture%202.png)",
      "",
      "Survey results, 2026",
      "",
      "3. Third step",
      "4. Fourth step, with a ![tiny chart](proposal%20images/Picture.png)",
      "",
    ].join("\n"),
  );
  server.close();
  await run.app.close();
});

test("Markdown text pastes formatted", async () => {
  const run = await openText("Intro.\n");
  await cursorAtEnd(run.page, "Intro.");
  await run.page.keyboard.press("Enter");
  await paste(run.page, { "text/plain": "## Next steps\n\n- Ship the **beta**\n- Write [the notes](https://example.com)\n" });
  await expectFile(run, "Intro.\n\n## Next steps\n\n- Ship the **beta**\n- Write [the notes](https://example.com)\n");
  await run.app.close();
});

test("Markdown copied from a code editor pastes formatted, not as styled code", async () => {
  const run = await openText("");
  const text = "# Notes\n\nSome *emphasis* here.";
  const html =
    '<meta charset="utf-8"><div style="color: #d4d4d4; background-color: #1e1e1e; font-family: Menlo, monospace; white-space: pre;">' +
    '<div><span style="color: #569cd6;font-weight: bold;"># Notes</span></div><br>' +
    '<div><span>Some </span><span style="font-style: italic;">*emphasis*</span><span> here.</span></div></div>';
  await paste(run.page, { "text/html": html, "text/plain": text });
  await expectFile(run, "# Notes\n\nSome *emphasis* here.\n");
  await run.app.close();
});

test("plain text that isn't Markdown pastes as it is", async () => {
  const run = await openText("Intro.\n");
  await cursorAtEnd(run.page, "Intro.");
  await paste(run.page, { "text/plain": " Just a sentence, 3 * 4 = 12." });
  await expectFile(run, "Intro. Just a sentence, 3 \\* 4 = 12.\n");
  await run.app.close();
});

test("Paste and Match Style pastes plain text, with no formatting", async () => {
  const run = await openText("Intro.\n");
  await clipboardHoldsText(run.app, "Plain **words** here");
  await cursorAtEnd(run.page, "Intro.");
  await run.page.keyboard.press("Enter");
  await clickMenu(run.app, "paste-plain");
  await expectFile(run, "Intro.\n\nPlain \\*\\*words\\*\\* here\n");
  await run.app.close();
});

test("Cmd+Shift+V, and Cmd+Option+Shift+V as many Mac apps have it, are Paste and Match Style", async () => {
  const run = await openText("Intro.\n");
  await clipboardHoldsText(run.app, "# Not a heading");
  await cursorAtEnd(run.page, "Intro.");
  await run.page.keyboard.press("Enter");
  await run.page.keyboard.press("Meta+Shift+V");
  await expectFile(run, "Intro.\n\n\\# Not a heading\n");
  await run.page.keyboard.press("Meta+Alt+Shift+V");
  await expectFile(run, "Intro.\n\n\\# Not a heading# Not a heading\n");
  await run.app.close();
});

test("Paste and Match Style does nothing while a version or Show changes is on screen, as every writing command", async () => {
  const run = await openText("Intro.\n");
  await cursorAtEnd(run.page, "Intro.");
  await run.page.keyboard.type(" More.");
  await expectFile(run, "Intro. More.\n");
  await clipboardHoldsText(run.app, "Stray words");
  const showChanges = run.page.locator("#toolbar").getByRole("button", { name: "Show changes" });
  await showChanges.click();
  await expect(run.page.locator(".doc:not([hidden]) .version-banner")).toBeVisible();
  await run.page.keyboard.press("Meta+Shift+V");
  await clickMenu(run.app, "paste-plain");
  await run.page.waitForTimeout(1000);
  expect(run.text()).toBe("Intro. More.\n");
  // Back to the current text, it pastes again.
  await showChanges.click();
  await cursorAtEnd(run.page, "Intro.");
  await run.page.keyboard.press("Meta+Shift+V");
  await expectFile(run, "Intro. More.Stray words\n");
  await run.app.close();
});

test("Paste and Match Style does nothing while an agent has the document, in either view", async () => {
  const { AgentSession } = await import("./agent-session");
  const run = await openText("Intro.\n");
  await cursorAtEnd(run.page, "Intro.");
  await clipboardHoldsText(run.app, "Stray words");
  const { session } = await AgentSession.start(run.dataDir);
  try {
    await session.ok("take_document", { path: run.file });
    await expect(run.page.locator(".doc:not([hidden]) .agent-notice")).toBeVisible();
    await run.page.locator(EDITOR).locator(".ProseMirror").focus();
    await run.page.keyboard.press("Meta+Shift+V");
    await run.page.getByRole("button", { name: "Markdown", exact: true }).click();
    await expect(run.page.locator(".doc:not([hidden]) textarea.source")).toBeFocused();
    await run.page.keyboard.press("Meta+Shift+V");
    await clickMenu(run.app, "paste-plain");
    await run.page.waitForTimeout(1000);
    expect(run.text()).toBe("Intro.\n");
    await expect(run.page.locator(".doc:not([hidden]) textarea.source")).toHaveValue("Intro.\n");
  } finally {
    await session.stop();
    await run.app.close();
  }
});

test("copying puts formatted text and Markdown on the clipboard", async () => {
  const run = await openText("Intro with **bold** and a [link](https://example.com).\n\n- one\n- two\n");
  const written = await captureClipboardWrites(run.app);
  await cursorAtEnd(run.page, "Intro");
  await run.page.keyboard.press("Meta+A");
  await settle(run.page);
  await copySelection(run.page);
  await expect.poll(written).not.toBeNull();
  const copied = (await written())!;
  expect(copied["text/plain"]).toBe("Intro with **bold** and a [link](https://example.com).\n\n- one\n- two");
  expect(copied["text/html"]).toContain("<strong>bold</strong>");
  expect(copied["text/html"]).toContain('<a href="https://example.com"');
  // A tight list's items hold their words with no paragraph, which mail apps would space out.
  expect(copied["text/html"]).toMatch(/<ul[^>]*><li>one<\/li><li>two<\/li><\/ul>/);
  await run.app.close();
});

const EMAIL = "Hi Ana,\n\nThanks for the chat on Tuesday.\n\n\nTwo times work for me:\n- Thursday afternoon\n- Friday morning\n\nBest,\nAlex\n";

/** How many lines the page shows from the block holding `first` to the one holding `last`, both included. */
function pageLines(page: Page, first: string, last: string): Promise<number> {
  return page.evaluate(
    ([editor, a, b]) => {
      const blocks = [...document.querySelector(`${editor} .ProseMirror`)!.children] as HTMLElement[];
      const from = blocks.find((e) => e.textContent!.includes(a))!;
      const to = blocks.filter((e) => e.textContent!.includes(b)).pop()!;
      const line = parseFloat(getComputedStyle(from).lineHeight);
      return Math.round((to.getBoundingClientRect().bottom - from.getBoundingClientRect().top) / line);
    },
    [EDITOR, first, last] as const,
  );
}

/**
 * The copied HTML shown in a window of its own with only the browser's
 * styles, as a mail app built on a browser shows a pasted email (the window
 * is never shown). How many lines it takes, where each of these words
 * starts, from the top, and how each table cell looks.
 */
async function asMailShowsIt(
  app: ElectronApplication,
  html: string,
  words: string[],
): Promise<{ lines: number; tops: number[]; cells: { header: boolean; align: string; bold: boolean; sideLine: boolean }[] }> {
  const [shown] = await Promise.all([
    app.waitForEvent("window"),
    app.evaluate(({ BrowserWindow }, content) => {
      const w = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { sandbox: true } });
      void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(content)}`);
    }, html),
  ]);
  await shown.waitForLoadState("domcontentloaded");
  const measured = await shown.evaluate((wanted) => {
    const blocks = [...document.body.children] as HTMLElement[];
    // One line of the body text, as a paragraph with no space of its own.
    const one = document.createElement("p");
    one.style.margin = "0";
    one.textContent = "Line";
    document.body.append(one);
    const line = one.getBoundingClientRect().height;
    one.remove();
    const height = blocks[blocks.length - 1].getBoundingClientRect().bottom - blocks[0].getBoundingClientRect().top;
    const topOf = (word: string) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent!.indexOf(word);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + word.length);
        return Math.round(range.getBoundingClientRect().top / line);
      }
      throw new Error(`"${word}" isn't in the copy`);
    };
    const cells = [...document.querySelectorAll("th, td")].map((cell) => {
      const look = getComputedStyle(cell);
      return {
        header: cell.tagName === "TH",
        align: look.textAlign,
        bold: Number(look.fontWeight) >= 600,
        sideLine: look.borderLeftStyle !== "none" || look.borderRightStyle !== "none",
      };
    });
    return { lines: height / line, tops: wanted.map(topOf), cells };
  }, words);
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().startsWith("data:")) w.destroy();
  });
  return measured;
}

test("copied text arrives in an email as the page shows it: the same lines, empty ones included, and a sign-off on two lines", async () => {
  const run = await openText(EMAIL, { name: "email.md" });
  const written = await captureClipboardWrites(run.app);
  await cursorAtEnd(run.page, "Hi Ana");
  await run.page.keyboard.press("Meta+A");
  await settle(run.page);
  await copySelection(run.page);
  await expect.poll(written).not.toBeNull();
  const shown = await pageLines(run.page, "Hi Ana", "Alex");
  // Hi Ana, / line / Thanks / line / empty line / Two times / two items / line / Best, / Alex
  expect(shown).toBe(11);
  const mail = await asMailShowsIt(run.app, (await written())!["text/html"], ["Hi Ana", "Thanks", "Two times", "Thursday", "Friday", "Best,", "Alex"]);
  expect(mail.lines).toBeCloseTo(shown, 1);
  expect(mail.tops.map((t) => t - mail.tops[0])).toEqual([0, 2, 5, 6, 7, 9, 10]);
  await run.app.close();
});

test("Edit > Copy for Email copies the whole document, without its details or Subject line, and the notice copies the subject", async () => {
  const run = await openText(`---\ntitle: Follow-up\n---\n\nSubject: Following up: Chief of Staff\n\n${EMAIL}`, { name: "email.md" });
  const { app, page } = run;
  const written = await captureClipboardWrites(app);
  // Nothing selected: the cursor is just somewhere in the document.
  await cursorAtEnd(page, "Thanks for the chat");
  await clickMenu(app, "copy-email");
  await expect.poll(written).not.toBeNull();
  const copied = (await written())!;
  expect(copied["text/plain"]).toMatch(/^Hi Ana,\n\nThanks for the chat on Tuesday\./);
  expect(copied["text/plain"]).toMatch(/\n\nBest,\nAlex$/);
  for (const flavour of ["text/plain", "text/html"]) expect(copied[flavour]).not.toMatch(/Subject|Following up|title/);
  const mail = await asMailShowsIt(app, copied["text/html"], ["Best,", "Alex"]);
  expect(mail.lines).toBeCloseTo(await pageLines(page, "Hi Ana", "Alex"), 1);
  expect(mail.tops[1] - mail.tops[0]).toBe(1);

  const notice = page.locator(".export-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Copied for email.");
  await expect(notice).toContainText("Subject: Following up: Chief of Staff");
  await notice.getByRole("button", { name: "Copy subject" }).click();
  await expect.poll(async () => (await written())?.["text/plain"]).toBe("Following up: Chief of Staff");
  await expect(notice).toContainText("Copied the subject.");
  // The document itself is as it was.
  expect(run.text()).toContain("Subject: Following up: Chief of Staff\n\nHi Ana,");

  // Also in the toolbar's Export menu; in the Markdown view, with what was just typed there.
  await app.evaluate(() => ((globalThis as unknown as { written: unknown }).written = null));
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const area = page.locator(".doc:not([hidden]) textarea.source");
  await expect(area).toBeVisible();
  await area.evaluate((a: HTMLTextAreaElement) => {
    a.focus();
    a.setSelectionRange(a.value.length, a.value.length);
  });
  await page.keyboard.type("\nP.S. See you soon.");
  await chooseFromMenu(page, "Export", "Copy for email");
  await expect.poll(async () => (await written())?.["text/plain"]).toMatch(/Best,\nAlex\n\nP\.S\. See you soon\.$/);
  await expect(notice).toContainText("Copied for email.");
  await run.app.close();
});

test("Copy for Email leaves out the comments and link list the page hides, shows [[links]] as their words, and task boxes can be seen (B1-01)", async () => {
  const TEXT =
    "Hi Ana,\n\n%% check the date %%\n\nSee the [[Q3 plan|plan]] and the [brief][b].<!-- ask Sam -->\n\n" +
    "- [x] Book the room\n- [ ] Send the agenda\n\nBest,\nAlex\n\n<!-- private note -->\n\n[b]: https://example.com/brief\n";
  const run = await openText(TEXT, { name: "email.md" });
  const written = await captureClipboardWrites(run.app);
  await clickMenu(run.app, "copy-email");
  await expect.poll(written).not.toBeNull();
  const copied = (await written())!;
  for (const flavour of ["text/plain", "text/html"]) {
    expect(copied[flavour]).not.toMatch(/check the date|ask Sam|private note|\[\[|Q3 plan|\[b\]|%%|<!--/);
  }
  expect(copied["text/plain"]).toBe("Hi Ana,\n\nSee the plan and the [brief](https://example.com/brief).\n\n- [x] Book the room\n- [ ] Send the agenda\n\nBest,\nAlex");
  const mail = await asMailShowsIt(run.app, copied["text/html"], ["Hi Ana", "See the plan", "Book the room", "Send the agenda", "Best,"]);
  // No empty line is left where a comment was: one empty line between paragraphs, as on the page.
  expect(mail.tops.map((t) => t - mail.tops[0])).toEqual([0, 2, 4, 5, 7]);
  expect(copied["text/html"]).toMatch(/☒ <\/span>Book the room/);
  expect(copied["text/html"]).toMatch(/☐ <\/span>Send the agenda/);
  await run.app.close();
});

test("a task list copied and pasted back into Corillo is the same list, with no extra boxes (B1-01)", async () => {
  const TEXT = "Plan:\n\n- [x] Book the room\n- [ ] Send the agenda\n\nEnd.\n";
  const run = await openText(TEXT);
  const { page } = run;
  const written = await captureClipboardWrites(run.app);
  await cursorAtEnd(page, "Plan:");
  await page.keyboard.press("Meta+A");
  await settle(page);
  await copySelection(page);
  await expect.poll(written).not.toBeNull();
  const copied = (await written())!;
  expect(copied["text/html"]).toContain("☒");
  await page.keyboard.press("Backspace");
  await expect.poll(() => run.text().trim()).toBe("");
  await paste(page, copied);
  await expectFile(run, TEXT);
  await run.app.close();
});

test("Copy for Email says so when there's nothing to copy, and has no subject to copy when there's no Subject line", async () => {
  const run = await openText("---\ntitle: Empty\n---\n", { name: "empty.md" });
  const notice = run.page.locator(".doc:not([hidden]) .export-notice"); // each document's own
  await clickMenu(run.app, "copy-email");
  await expect(notice).toContainText("There's nothing to copy yet.");
  await notice.getByRole("button", { name: "Close" }).click();
  const written = await captureClipboardWrites(run.app);
  await openAlso(run, "short.md", "Hi Ana,\n\nSee you Thursday.\n");
  await expect(run.page.locator(EDITOR)).toContainText("See you Thursday.");
  await clickMenu(run.app, "copy-email");
  await expect.poll(async () => (await written())?.["text/plain"]).toBe("Hi Ana,\n\nSee you Thursday.");
  await expect(notice).toContainText("Copied for email.");
  await expect(notice.getByRole("button", { name: "Copy subject" })).toBeHidden();
  await run.app.close();
});

test("a whole document copied and pasted back into Corillo is the same document: empty lines, a paragraph's own line breaks, lists, a quote, a table and a footnote", async () => {
  const TEXT =
    "# Plan\n\nHi Ana,\n\n\nThanks for Tuesday.\nTwo lines here.\n\n1. Post the role\n2. Interview\n\n- Spaced one\n\n- Spaced two\n\n  - Inner\n\n" +
    "> Quoted\n> on two lines\n\n| Week | Goal        |\n| ---- | :---------: |\n| 1    | Hire<br>now |\n| 2    | **Train**   |\n\nBest,\nAlex[^1]\n\n[^1]: A note.\n";
  const run = await openText(TEXT);
  const { page } = run;
  const written = await captureClipboardWrites(run.app);
  await cursorAtEnd(page, "Hi Ana");
  await page.keyboard.press("Meta+A");
  await settle(page);
  await copySelection(page);
  await expect.poll(written).not.toBeNull();
  const copied = (await written())!;
  // In an email the table keeps the page's look: the header row bold and to the left (a centred column
  // stays centred), and no lines down the sides.
  const mail = await asMailShowsIt(run.app, copied["text/html"], ["Week"]);
  expect(mail.cells.map((c) => [c.header, c.align, c.bold, c.sideLine])).toEqual([
    [true, "left", true, false],
    [true, "center", true, false],
    [false, "left", false, false],
    [false, "center", false, false],
    [false, "left", false, false],
    [false, "center", false, false],
  ]);
  await page.keyboard.press("Backspace");
  await expect.poll(() => run.text().trim()).toBe("");
  await paste(page, copied);
  await expectFile(run, TEXT);

  // One cell's words, copied and pasted into another cell, are just those words.
  await run.app.evaluate(() => ((globalThis as unknown as { written: unknown }).written = null));
  await selectText(page, "Hire");
  await copySelection(page);
  await expect.poll(written).not.toBeNull();
  await cursorInCell(page, "Train");
  await paste(page, (await written())!);
  await expectFile(
    run,
    TEXT.replace(
      "| Week | Goal        |\n| ---- | :---------: |\n| 1    | Hire<br>now |\n| 2    | **Train**   |",
      "| Week | Goal          |\n| ---- | :-----------: |\n| 1    | Hire<br>now   |\n| 2    | **Train**Hire |",
    ),
  );
  await run.app.close();
});

test("words dragged out of the page carry the same formatted text and Markdown as copying them (B1-10)", async () => {
  const TEXT = "Hi Ana,\n\n\nSee the plan.[^1]\n\n| Week | Goal |\n| ---- | ---- |\n| 1    | Hire |\n\nBest,\nAlex\n\n[^1]: A note.\n";
  const run = await openText(TEXT);
  const { page } = run;
  const written = await captureClipboardWrites(run.app);
  await cursorAtEnd(page, "Hi Ana");
  await page.keyboard.press("Meta+A");
  await settle(page);
  await copySelection(page);
  await expect.poll(written).not.toBeNull();
  const copied = (await written())!;
  const dragged = await page.evaluate((editor) => {
    const root = document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!;
    const words = [...root.querySelectorAll("p")].find((p) => p.textContent!.startsWith("See the plan"))!;
    const r = words.getBoundingClientRect();
    const data = new DataTransfer();
    root.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: data, clientX: r.left + 5, clientY: r.top + r.height / 2 }));
    root.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: data }));
    return { html: data.getData("text/html"), text: data.getData("text/plain") };
  }, EDITOR);
  expect(dragged.html).toBe(copied["text/html"]);
  expect(dragged.text).toBe(copied["text/plain"]);
  await run.app.close();
});

test("copying a few words gives just those words in Markdown", async () => {
  const run = await openText("Intro with **bold words** here.\n");
  const written = await captureClipboardWrites(run.app);
  await cursorAtEnd(run.page, "Intro");
  for (let i = 0; i < 4; i++) await run.page.keyboard.press("Alt+Shift+ArrowLeft"); // "bold words here."
  await settle(run.page);
  await copySelection(run.page);
  await expect.poll(written).not.toBeNull();
  expect((await written())!["text/plain"]).toBe("**bold words** here.");
  await run.app.close();
});

test("what Corillo copies pastes back in exactly", async () => {
  const run = await openText("A [link](https://example.com) and `code`.\n\nEnd.\n");
  const written = await captureClipboardWrites(run.app);
  await cursorAtEnd(run.page, "A link");
  await run.page.keyboard.press("Meta+Shift+ArrowLeft");
  await settle(run.page);
  await copySelection(run.page);
  await expect.poll(written).not.toBeNull();
  const copied = (await written())!;
  await cursorAtEnd(run.page, "End.");
  await run.page.keyboard.press("Enter");
  await paste(run.page, copied);
  await expectFile(run, "A [link](https://example.com) and `code`.\n\nEnd.\n\nA [link](https://example.com) and `code`.\n");
  await run.app.close();
});

test("what Corillo copies from an earlier version's page or the Markdown view's preview pastes back exactly, diagrams and footnotes included", async () => {
  const TEXT = "Intro.\n\n```mermaid\ngraph LR\n  Ask --> Draft\n```\n\nA claim.[^1]\n\nEnd.\n\n[^1]: The source.\n";
  const run = await openText(TEXT.replace("End.", "End"));
  const { page } = run;
  const written = await captureClipboardWrites(run.app);
  await cursorAtEnd(page, "End");
  await page.keyboard.type(".");
  await expectFile(run, TEXT);
  /** Everything on a page selected and copied, as the person would with the mouse and Cmd+C. */
  const copyAll = async (selector: string) => {
    await run.app.evaluate(() => ((globalThis as unknown as { written: unknown }).written = null));
    const own = await page.evaluate((sel) => {
      const root = document.querySelector<HTMLElement>(sel)!;
      const range = document.createRange();
      range.selectNodeContents(root);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      return new Promise<{ "text/html": string; "text/plain": string }>((resolve) =>
        setTimeout(() => {
          const data = new DataTransfer();
          root.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }));
          resolve({ "text/html": data.getData("text/html"), "text/plain": data.getData("text/plain") });
        }, 100),
      );
    }, selector);
    await settle(page);
    return (await written()) ?? own;
  };
  /** The whole document emptied, then what was copied pasted in. */
  const pasteOverAll = async (copied: Record<string, string>) => {
    expect(copied["text/plain"]).toContain("A claim.");
    await page.locator(`${EDITOR} .ProseMirror`).focus();
    await page.keyboard.press("Meta+A");
    await page.keyboard.press("Backspace");
    await expect.poll(() => run.text().trim()).toBe("");
    await paste(page, copied);
    await settle(page);
  };

  // From the latest version's page, with Show changes.
  await page.locator("#toolbar").getByRole("button", { name: "Show changes" }).click();
  await expect(page.locator(".doc:not([hidden]) .version-view .ProseMirror")).toBeVisible();
  const fromVersion = await copyAll(".doc:not([hidden]) .version-view .ProseMirror");
  await page.keyboard.press("Escape");
  await expect(page.locator(".doc:not([hidden]) .version-view")).toBeHidden();
  await pasteOverAll(fromVersion);
  await expectFile(run, TEXT);

  // From the Markdown view's preview.
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.locator(".doc:not([hidden]) .page.preview .ProseMirror")).toBeVisible();
  const fromPreview = await copyAll(".doc:not([hidden]) .page.preview .ProseMirror");
  await page.getByRole("button", { name: "Formatted", exact: true }).click();
  await pasteOverAll(fromPreview);
  await expectFile(run, TEXT);
  await run.app.close();
});

/** Paste each clipboard into the empty document in turn, checking the file after each, then empty it again. */
async function pasteEach(cases: { html: string; text: string; file: string }[]): Promise<void> {
  const run = await openText("");
  for (const c of cases) {
    await paste(run.page, { "text/html": c.html, "text/plain": c.text });
    await expectFile(run, c.file);
    await run.page.locator(`.doc:not([hidden]) .page.editor .ProseMirror`).focus();
    await run.page.keyboard.press("Meta+A");
    await run.page.keyboard.press("Backspace");
    await expectFile(run, "");
  }
  await run.app.close();
}

test("a pasted line break followed by text stays a line break", async () => {
  await pasteEach([
    // An address from a web page or an email.
    { html: '<meta charset="utf-8"><p>123 Main St<br>Springfield</p>', text: "123 Main St\nSpringfield", file: "123 Main St\\\nSpringfield\n" },
    // Two breaks in a row separate paragraphs; one is a line break.
    { html: "<div>one<br>two<br><br>three</div>", text: "one\ntwo\n\nthree", file: "one\\\ntwo\n\nthree\n" },
    // With only spacing between them, two breaks are still two.
    { html: "<div>one<br>\n<br>two</div>", text: "one\n\ntwo", file: "one\n\ntwo\n" },
    // A break at the end of a paragraph is only spacing.
    { html: "<p>one<br></p>", text: "one", file: "one\n" },
    { html: "<p>one<br> </p><p>two</p>", text: "one\ntwo", file: "one\n\ntwo\n" },
    { html: "<div>one<br><p>two</p></div>", text: "one\ntwo", file: "one\n\ntwo\n" },
    // Spacing in the HTML after a break isn't part of the next line.
    { html: "<div>one<br>\n  two</div>", text: "one\ntwo", file: "one\\\ntwo\n" },
    // Apple Mail and Gmail: a signature, a line per div, a break in front of the text.
    { html: "<div>Ana Ortiz<br>Head of Sales<br>ana@example.com</div>", text: "Ana Ortiz\nHead of Sales\nana@example.com", file: "Ana Ortiz\\\nHead of Sales\\\nana@example.com\n" },
  ]);
});

test("pasting rich text keeps joined emoji and joiners in words", async () => {
  const zwj = "‍";
  const team = `\u{1F469}${zwj}\u{1F4BB}`; // woman technologist
  const flag = `\u{1F3F3}\u{FE0F}${zwj}\u{1F308}`; // rainbow flag
  const persian = `می‌خواهم`; // with a zero-width non-joiner
  await pasteEach([
    { html: `<p>Team ${team} and ${flag}</p>`, text: `Team ${team} and ${flag}`, file: `Team ${team} and ${flag}\n` },
    { html: `<p><b>${persian}</b> here</p>`, text: `${persian} here`, file: `**${persian}** here\n` },
    // Zero-width spaces and byte-order marks pasted from web pages still go.
    { html: "<p>one​two﻿ three</p>", text: "onetwo three", file: "onetwo three\n" },
  ]);
});

test("text copied from another app built like Corillo (a chat's message box, say) is cleaned as any other app's", async () => {
  // ChatGPT, Claude, Confluence and Linear mark their copies the way Corillo's editor does.
  const html =
    '<meta charset="utf-8"><p data-pm-slice="1 1 []">Plan for <strong>Q3</strong></p><p></p>' +
    '<p><span style="display:none">hidden</span>Visible <span style="font-weight:700">words</span></p>';
  await pasteEach([{ html, text: "Plan for Q3\n\nVisible words", file: "Plan for **Q3**\n\nVisible **words**\n" }]);
});

test("a picture copied from a Corillo document into one in another folder comes along", async () => {
  const run = await openText("Intro.\n\nChart: ![Chart](proposal%20images/chart.png) done.\n", {
    prepare: (folder) => {
      mkdirSync(join(folder, "proposal images"));
      copyFileSync(PNG, join(folder, "proposal images", "chart.png"));
    },
  });
  const written = await captureClipboardWrites(run.app);
  await expect(run.page.locator(".ProseMirror .picture img")).toBeVisible();
  await cursorAtEnd(run.page, "Chart:");
  await run.page.keyboard.press("Meta+Shift+ArrowLeft");
  await settle(run.page);
  await copySelection(run.page);
  await expect.poll(written).not.toBeNull();
  const copied = (await written())!;

  // Into the same document: the same address, no new copy.
  await cursorAtEnd(run.page, "Intro.");
  await run.page.keyboard.press("Enter");
  await paste(run.page, copied);
  await expectFile(run, "Intro.\n\nChart: ![Chart](proposal%20images/chart.png) done.\n\nChart: ![Chart](proposal%20images/chart.png) done.\n");
  expect(readdirSync(join(run.folder, "proposal images"))).toEqual(["chart.png"]);

  // Into a document in another folder: the picture is copied into its pictures folder.
  const other = mkdtempSync(join(tmpdir(), "corillo-other-"));
  const board = join(other, "board.md");
  writeFileSync(board, "Board.\n");
  await openFromFinder(run.app, board);
  await expect(run.page.locator(EDITOR)).toContainText("Board.");
  await cursorAtEnd(run.page, "Board.");
  await run.page.keyboard.press("Enter");
  await paste(run.page, copied);
  await expect.poll(() => readFileSync(board, "utf8")).toBe("Board.\n\nChart: ![Chart](board%20images/chart.png) done.\n");
  expect(readdirSync(join(other, "board images"))).toEqual(["chart.png"]);
  await expect(run.page.locator(`${EDITOR} .picture.missing`)).toHaveCount(0);
  await run.app.close();
});

/** How many pictures are in the document's pictures folder. */
const saved = (folder: string) => (existsSync(join(folder, "proposal images")) ? readdirSync(join(folder, "proposal images")).length : 0);

/** A web server for pasted pictures that notes each request, and can hold answers back until told. */
function holdingServer(): Promise<{ server: Server; base: string; asked: string[]; most: () => number; release: () => void; streamed: () => number }> {
  return new Promise((resolve) => {
    const asked: string[] = [];
    let inFlight = 0;
    let most = 0;
    let sent = 0;
    let released = false;
    const waiting: (() => void)[] = [];
    const server = createServer((req, res) => {
      asked.push(req.url ?? "");
      inFlight++;
      most = Math.max(most, inFlight);
      res.on("close", () => inFlight--);
      if (req.url === "/endless.png") {
        // A "picture" that never ends: Corillo should stop reading it at its size limit.
        res.writeHead(200, { "Content-Type": "image/png" });
        const chunk = Buffer.alloc(1024 * 1024);
        const more = () => {
          while (!res.destroyed && sent < 200 * 1024 * 1024) {
            sent += chunk.length;
            if (!res.write(chunk)) return void res.once("drain", more);
          }
          res.end();
        };
        more();
        return;
      }
      const answer = () => {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(readFileSync(PNG));
      };
      if (released) answer();
      else waiting.push(answer);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        asked,
        most: () => most,
        streamed: () => sent,
        release: () => {
          released = true;
          for (const answer of waiting.splice(0)) answer();
        },
      });
    });
  });
}

/** A 2 by 2 picture in BMP, a kind the window can show but Corillo doesn't save as it is. */
function bmp(): string {
  const pixels = Buffer.from([0, 0, 255, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]); // two rows, padded to 8 bytes each
  const header = Buffer.alloc(54);
  header.write("BM", 0);
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(2, 18);
  header.writeInt32LE(2, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  return `data:image/bmp;base64,${Buffer.concat([header, pixels]).toString("base64")}`;
}

test("a pasted picture never stays in the document as data: a kind Corillo doesn't save is saved as PNG, one it can't read is left out and it says so", async () => {
  const run = await openText("");
  await paste(run.page, { "text/html": `<p>Logo <img src="${bmp()}" alt="Logo"> here</p>`, "text/plain": "Logo here" });
  await expectFile(run, "Logo ![Logo](proposal%20images/Picture.png) here\n");
  expect(readdirSync(join(run.folder, "proposal images"))).toEqual(["Picture.png"]);
  await run.page.locator(`${EDITOR} .ProseMirror`).focus();
  await run.page.keyboard.press("Meta+A");
  await run.page.keyboard.press("Backspace");
  await expectFile(run, "");
  await paste(run.page, { "text/html": '<p>Scan <img src="data:image/tiff;base64,SUkqAAgAAAA=" alt="Scan"> here</p>', "text/plain": "Scan here" });
  await expectFile(run, "Scan  here\n");
  await expect(run.page.locator(".file-notice:not([hidden])")).toContainText("A pasted picture couldn't be kept");
  await run.app.close();
});

test("a picture written into a paste is saved at once, never waiting behind a web picture still on its way", async () => {
  const web = await holdingServer();
  const run = await openText("");
  const png = readFileSync(PNG).toString("base64");
  await paste(run.page, {
    "text/html": `<p>Web <img src="${web.base}/chart.png" width="300" height="200" alt="Web"> and <img src="data:image/png;base64,${png}" alt="Inline"></p>`,
    "text/plain": "Web and",
  });
  await expect.poll(run.text).toContain("![Inline](proposal%20images/Picture.png)");
  // While the web picture is held, the file never holds the picture's letters.
  for (let i = 0; i < 5; i++) {
    expect(run.text()).not.toContain("data:");
    await run.page.waitForTimeout(200);
  }
  web.release();
  await expectFile(run, "Web ![Web](proposal%20images/Picture%202.png) and ![Inline](proposal%20images/Picture.png)\n");
  web.server.close();
  await run.app.close();
});

test("a JPEG written into a paste as image/jpg is kept as JPEG, byte for byte", async () => {
  const run = await openText("");
  const jpeg = await run.page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 40;
    c.height = 30;
    const g = c.getContext("2d")!;
    g.fillStyle = "#c63";
    g.fillRect(0, 0, 40, 30);
    return c.toDataURL("image/jpeg").split(",")[1];
  });
  await paste(run.page, { "text/html": `<p>Photo <img src="data:image/jpg;base64,${jpeg}" alt="Photo"></p>`, "text/plain": "Photo" });
  await expectFile(run, "Photo ![Photo](proposal%20images/Picture.jpg)\n");
  expect(readFileSync(join(run.folder, "proposal images", "Picture.jpg")).equals(Buffer.from(jpeg, "base64"))).toBe(true);
  // The same as a file on the clipboard.
  await run.page.evaluate((data) => {
    const transfer = new DataTransfer();
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    transfer.items.add(new File([bytes], "photo.jpg", { type: "image/jpg" }));
    document.querySelector(".doc:not([hidden]) .ProseMirror")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, jpeg);
  await expectFile(run, "Photo ![Photo](proposal%20images/Picture.jpg)![Picture 2](proposal%20images/Picture%202.jpg)\n");
  expect(readFileSync(join(run.folder, "proposal images", "Picture 2.jpg")).equals(Buffer.from(jpeg, "base64"))).toBe(true);
  await run.app.close();
});

test("a pasted picture that can't be saved in the pictures folder says so, not that it can't be read", async () => {
  const run = await openText("", { prepare: (folder) => mkdirSync(join(folder, "proposal images"), { mode: 0o555 }) });
  try {
    const png = readFileSync(PNG).toString("base64");
    await paste(run.page, { "text/html": `<p>Chart <img src="data:image/png;base64,${png}" alt="Chart"> here</p>`, "text/plain": "Chart here" });
    await expectFile(run, "Chart  here\n");
    const notice = run.page.locator(".file-notice:not([hidden])");
    await expect(notice).toContainText("A pasted picture couldn't be kept");
    await expect(notice).toContainText("pictures folder");
    await expect(notice).not.toContainText("can't read");
  } finally {
    chmodSync(join(run.folder, "proposal images"), 0o755);
    await run.app.close();
  }
});

// The review of Batch 21, G21-19: a picture pasted as a file, dropped, or
// inserted, that can't be saved in the pictures folder is left out with a
// notice that says so, as one inside pasted text is.
const LOCKED = "proposal images";
const notice = (r: { page: Page }) => r.page.locator(".file-notice:not([hidden])").first();

/** Hand the page a picture file as the clipboard (a screenshot) or a drop would, with no path on this Mac. */
async function pictureEvent(page: Page, kind: "paste" | "drop"): Promise<void> {
  await page.locator(`${EDITOR} .ProseMirror`).focus();
  await page.evaluate(
    ({ data, kind }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(data)], "image.png", { type: "image/png" }));
      const target = document.querySelector(".doc:not([hidden]) .page.editor .ProseMirror")!;
      const box = target.querySelector("p")!.getBoundingClientRect();
      const event =
        kind === "paste"
          ? new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true })
          : new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: box.right - 2, clientY: box.top + box.height / 2 });
      target.dispatchEvent(event);
    },
    { data: [...readFileSync(PNG)], kind },
  );
}

for (const kind of ["paste", "drop"] as const) {
  test(`a picture ${kind === "paste" ? "pasted as a file (a screenshot)" : "dropped"} that can't be saved in the pictures folder is left out with a notice that says so`, async () => {
    const run = await openText("Pasted below.\n", { prepare: (folder) => mkdirSync(join(folder, LOCKED), { mode: 0o555 }) });
    try {
      await pictureEvent(run.page, kind);
      await expect(notice(run)).toContainText(kind === "paste" ? "A pasted picture couldn't be kept." : "A dropped picture couldn't be kept.");
      await expect(notice(run)).toContainText("pictures folder");
      expect(run.thrown?.splice(0) ?? []).toEqual([]);
      await expect(run.page.locator(`${EDITOR} .picture`)).toHaveCount(0);
      // Once the folder can be changed, the same picture goes in.
      chmodSync(join(run.folder, LOCKED), 0o755);
      await pictureEvent(run.page, kind);
      await expect.poll(run.text).toMatch(/!\[[^\]]*\]\(proposal%20images\/Picture\.png\)/);
    } finally {
      chmodSync(join(run.folder, LOCKED), 0o755);
      await run.app.close();
    }
  });
}

test("Insert > Picture that can't be saved in the pictures folder says so", async () => {
  const run = await openText("Pasted below.\n", { prepare: (folder) => mkdirSync(join(folder, LOCKED), { mode: 0o555 }) });
  try {
    await cursorAtEnd(run.page, "Pasted below.");
    await pickInNextDialog(run.app, PNG);
    await clickMenu(run.app, "insert-picture");
    await expect(notice(run)).toContainText("The picture couldn't be kept.");
    await expect(notice(run)).toContainText("pictures folder");
    expect(run.thrown?.splice(0) ?? []).toEqual([]);
    await expect(run.page.locator(`${EDITOR} .picture`)).toHaveCount(0);
  } finally {
    chmodSync(join(run.folder, LOCKED), 0o755);
    await run.app.close();
  }
});

test("an AVIF picture in pasted content, from the web or written into it, is kept as AVIF", async () => {
  const avif = readFileSync(join(FIXTURES, "chart.avif"));
  const server = createServer((_req, res) => res.writeHead(200, { "Content-Type": "image/avif" }).end(avif));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/survey.avif`;
  const run = await openText("");
  const html = `<p>Web <img src="${url}" alt="Web"> and data <img src="data:image/avif;base64,${avif.toString("base64")}" alt="Data"> here</p>`;
  await paste(run.page, { "text/html": html, "text/plain": "Web and data here" });
  await expect.poll(run.text).toMatch(/^Web !\[Web\]\(proposal%20images\/Picture(%202)?\.avif\) and data !\[Data\]\(proposal%20images\/Picture(%202)?\.avif\) here\n$/);
  expect(readdirSync(join(run.folder, "proposal images")).sort()).toEqual(["Picture 2.avif", "Picture.avif"]);
  await run.app.close();
  server.close();
});

test("tracking pictures are left out of a paste, however they're made tiny, and never fetched", async () => {
  const web = await holdingServer();
  web.release();
  const run = await openText("");
  const html =
    `<p>Hello<img src="${web.base}/a.png" width="0" height="0"><img src="${web.base}/b.png" style="width:1px;height:1px">` +
    `<img src="${web.base}/c.png" width="2" height="1"><img src="${web.base}/d.png" style="display:block; width: 1px; height: 2px"></p>` +
    `<p>Chart <img src="${web.base}/chart.png" width="300" height="200" alt="Chart"></p>`;
  await paste(run.page, { "text/html": html, "text/plain": "Hello\nChart" });
  await expectFile(run, "Hello\n\nChart ![Chart](proposal%20images/Picture.png)\n");
  expect(web.asked).toEqual(["/chart.png"]);
  web.server.close();
  await run.app.close();
});

test("a web page's copy marked as if it were Corillo's own is cleaned as any other app's: no tracker fetched, no script link, no raw HTML", async () => {
  const web = await holdingServer();
  web.release();
  const run = await openText("");
  const html =
    `<meta charset="utf-8"><p data-pm-slice="1 1 []" data-corillo="">Hello <img src="${web.base}/t.png" width="1" height="1">` +
    `<a href="javascript:alert(1)">click</a></p><pre class="raw-block" data-corillo>&lt;script&gt;alert(1)&lt;/script&gt;</pre>`;
  await paste(run.page, { "text/html": html, "text/plain": "Hello click" });
  await expect.poll(run.text).toContain("Hello click");
  await settle(run.page);
  await run.page.waitForTimeout(300);
  const forged = run.text();
  expect(forged).not.toContain("javascript:");
  expect(forged).not.toContain("t.png");
  // The same as that HTML without the mark gives.
  await run.page.locator(`${EDITOR} .ProseMirror`).focus();
  await run.page.keyboard.press("Meta+A");
  await run.page.keyboard.press("Backspace");
  await expect.poll(() => run.text().trim()).toBe("");
  await paste(run.page, { "text/html": html.replaceAll(/ data-corillo(="")?/g, ""), "text/plain": "Hello click" });
  await expectFile(run, forged);
  expect(web.asked).toEqual([]);
  web.server.close();
  await run.app.close();
});

test("pasted web pictures are fetched a few at a time, and one past the size limit is stopped as it comes", async () => {
  test.setTimeout(60_000);
  const web = await holdingServer();
  const run = await openText("");
  const pictures = Array.from({ length: 6 }, (_, i) => `<img src="${web.base}/p${i}.png" alt="P${i}">`).join(" ");
  await paste(run.page, { "text/html": `<p>${pictures} <img src="${web.base}/endless.png" alt="Huge"></p>`, "text/plain": "" });
  // The server holds every answer until released, so with no limit all seven would be asked for at once.
  await expect.poll(() => web.most()).toBeGreaterThanOrEqual(4);
  await run.page.waitForTimeout(300); // time for any more to be asked for
  expect(web.asked).toHaveLength(4);
  web.release();
  await expect.poll(() => saved(run.folder), { timeout: 30_000 }).toBe(6);
  expect(web.most()).toBeLessThanOrEqual(4);
  // The endless one was given up at the limit (25 MB), not read to its end.
  await expect.poll(() => run.text(), { timeout: 30_000 }).toContain(`![Huge](${web.base}/endless.png)`);
  expect(web.streamed()).toBeLessThan(120 * 1024 * 1024);
  web.server.close();
  await run.app.close();
});

test("a pasted web picture that arrives while an agent holds the document is put in once the agent is done", async () => {
  const { AgentSession } = await import("./agent-session");
  const web = await holdingServer();
  const run = await openText("Intro.\n");
  await cursorAtEnd(run.page, "Intro.");
  await run.page.keyboard.press("Enter");
  await paste(run.page, { "text/html": `<p>Chart <img src="${web.base}/chart.png" alt="Chart"></p>`, "text/plain": "Chart" });
  await expectFile(run, `Intro.\n\nChart ![Chart](${web.base}/chart.png)\n`);
  const { session } = await AgentSession.start(run.dataDir);
  try {
    await session.ok("take_document", { path: run.file });
    web.release();
    await expect.poll(() => saved(run.folder)).toBe(1);
    await run.page.waitForTimeout(800);
    // Still as the agent was given it: nothing changes under an agent's feet.
    expect(run.text()).toBe(`Intro.\n\nChart ![Chart](${web.base}/chart.png)\n`);
    await session.ok("edit_document", { path: run.file, edits: [{ find: "Intro.", replace: "Introduction." }] });
    await session.ok("finish_editing", { path: run.file });
    await expectFile(run, "Introduction.\n\nChart ![Chart](proposal%20images/Picture.png)\n");
  } finally {
    await session.stop();
    web.server.close();
    await run.app.close();
  }
});

test("a pasted web picture held while an agent has the document goes into the file when it's done, with the Markdown view showing too", async () => {
  const { AgentSession } = await import("./agent-session");
  const web = await holdingServer();
  const run = await openText("Intro.\n");
  await cursorAtEnd(run.page, "Intro.");
  await run.page.keyboard.press("Enter");
  await paste(run.page, { "text/html": `<p>Chart <img src="${web.base}/chart.png" alt="Chart"></p>`, "text/plain": "Chart" });
  await expectFile(run, `Intro.\n\nChart ![Chart](${web.base}/chart.png)\n`);
  const { session } = await AgentSession.start(run.dataDir);
  try {
    await session.ok("take_document", { path: run.file });
    await run.page.getByRole("button", { name: "Markdown", exact: true }).click();
    const area = run.page.locator(".doc:not([hidden]) textarea.source");
    await expect(area).toBeVisible();
    web.release();
    await expect.poll(() => saved(run.folder)).toBe(1);
    await session.ok("edit_document", { path: run.file, edits: [{ find: "Intro.", replace: "Introduction." }] });
    await session.ok("finish_editing", { path: run.file });
    await expectFile(run, "Introduction.\n\nChart ![Chart](proposal%20images/Picture.png)\n");
    await expect(area).toHaveValue("Introduction.\n\nChart ![Chart](proposal%20images/Picture.png)\n");
    // Typing in the text afterwards keeps it, and the formatted view shows the copy.
    await area.evaluate((a: HTMLTextAreaElement) => {
      a.focus();
      a.setSelectionRange("Introduction.".length, "Introduction.".length);
    });
    await run.page.keyboard.type(" Yes.");
    await expectFile(run, "Introduction. Yes.\n\nChart ![Chart](proposal%20images/Picture.png)\n");
    await run.page.getByRole("button", { name: "Formatted", exact: true }).click();
    await expect(run.page.locator(`${EDITOR} .picture img`)).toHaveAttribute("data-src", "proposal%20images/Picture.png");
    await run.page.waitForTimeout(600);
    expect(run.text()).toBe("Introduction. Yes.\n\nChart ![Chart](proposal%20images/Picture.png)\n");
  } finally {
    await session.stop();
    web.server.close();
    await run.app.close();
  }
});

test("links in pasted Markdown text follow the same rule: an app's own link or a file elsewhere on the Mac is left as words", async () => {
  const run = await openText("Start.\n");
  await cursorAtEnd(run.page, "Start.");
  await run.page.keyboard.press("Enter");
  const text = "See [app](x-unknown-app:open), [elsewhere](/Applications/Foo.app), [nearby](notes/plan.md), [above](#start) and [web](https://example.com/a).";
  await paste(run.page, { "text/plain": text });
  await expectFile(run, "Start.\n\nSee app, elsewhere, [nearby](notes/plan.md), [above](#start) and [web](https://example.com/a).\n");
  await run.app.close();
});

test("pasted links are kept only to web pages, mail, phone numbers and other files nearby; any other kind is left as words", async () => {
  const run = await openText("Start.\n");
  await cursorAtEnd(run.page, "Start.");
  await run.page.keyboard.press("Enter");
  const links: [string, string][] = [
    ["web", "https://example.com/a"],
    ["plain", "http://example.com/b"],
    ["mail", "mailto:ana@example.com"],
    ["call", "tel:+15551234"],
    ["nearby", "notes/plan.md"],
    ["script", "javascript:alert(1)"],
    ["tabbed", "java&#x09;script:alert(1)"],
    ["vb", "vbscript:msgbox(1)"],
    ["inline", "data:text/html,hi"],
    ["local", "file:///etc/hosts"],
    ["blob", "blob:https://example.com/x"],
    ["redirected", "https://www.google.com/url?q=javascript:alert(1)"],
    ["unknown", "x-unknown-app:open"],
  ];
  await paste(run.page, { "text/html": `<p>${links.map(([words, href]) => `<a href="${href}">${words}</a>`).join(" ")}</p>`, "text/plain": "links" });
  await expectFile(
    run,
    "Start.\n\n[web](https://example.com/a) [plain](http://example.com/b) [mail](mailto:ana@example.com) [call](tel:+15551234) [nearby](notes/plan.md) script tabbed vb inline local blob redirected unknown\n",
  );
  await run.app.close();
});
