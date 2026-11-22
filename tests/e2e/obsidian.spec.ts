// Notes written for Obsidian: shown the way Obsidian shows them, edited
// without disturbing its syntax, links to other notes that open, and exports
// that read as the note does.
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openText, expectFile, settle, tabState, chooseFromMenu, EDITOR, FIXTURES } from "./helpers";
import { AgentSession } from "./agent-session";

const NOTE = readFileSync(join(FIXTURES, "obsidian-note.md"), "utf8");
const PNG = join(FIXTURES, "chart.png");

/** A little vault: Obsidian's settings folder, an attachments folder with the chart, and another note. */
const vault = (folder: string) => {
  mkdirSync(join(folder, ".obsidian"));
  mkdirSync(join(folder, "attachments"));
  copyFileSync(PNG, join(folder, "attachments", "chart.png"));
  writeFileSync(join(folder, "Q2 review.md"), "# Q2 review\n\nLessons learned.\n");
};

const open = () => openText(NOTE, { name: "Q3 planning.md", prepare: vault });

/** Put the cursor at the very end of the paragraph holding this text (its last line). */
async function endOf(page: Page, text: string): Promise<void> {
  const para = page.locator(`${EDITOR} p`, { hasText: text }).last();
  const box = (await para.boundingBox())!;
  await para.click({ position: { x: box.width - 2, y: box.height - 6 } });
  await settle(page);
  await page.keyboard.press("Meta+ArrowRight");
  await settle(page);
}

test("an Obsidian note looks as it does in Obsidian: links, highlights, tags, comments, callouts and pictures", async () => {
  const run = await open();
  const page = run.page;
  const editor = page.locator(EDITOR);
  await expect(editor.locator(".ob-link", { hasText: "Ana López" }).first()).toBeVisible();
  await expect(editor.locator(".ob-highlight:not(.ob-syntax)").first()).toContainText("tight this quarter");
  await expect(editor.locator(".ob-tag", { hasText: "#planning" }).first()).toBeVisible();
  await expect(editor.locator(".ob-comment")).toContainText("Ask finance");
  await expect(editor.locator("pre.raw-block[data-kind='comment']")).toContainText("A block comment.");
  // Five callouts, each a coloured box: the warning amber, the nested one inside its parent.
  await expect(editor.locator("blockquote.ob-callout")).toHaveCount(5);
  await expect(editor.locator("blockquote.ob-callout-ochre[data-callout='warning']")).toHaveCount(1);
  await expect(editor.locator("blockquote.ob-callout[data-callout='question'] blockquote.ob-callout[data-callout='todo']")).toHaveCount(1);
  await expect(editor.locator(".ob-callout-title", { hasText: "Why this matters" })).toBeVisible();
  // A plain quote stays a plain quote.
  await expect(editor.locator("blockquote:not(.ob-callout)", { hasText: "A plain quote" })).toHaveCount(1);
  // The embedded chart is found in the vault's attachments folder and shown. Where 300 pixels are asked
  // for, it takes the share of the page's width it has in Word: 225 of the 468 points across.
  // (Changed 2026-11-09: it was 300 screen pixels, whatever the page's width; pictures now show as in Word.)
  const pictures = editor.locator("img.ob-embed-picture");
  await expect.poll(() => pictures.count()).toBeGreaterThanOrEqual(3);
  await expect.poll(() => pictures.first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(60);
  await expect(pictures.nth(1)).toHaveAttribute("data-points", "225.0x112.5");
  const share = await pictures.nth(1).evaluate((img) => img.getBoundingClientRect().width / img.parentElement!.getBoundingClientRect().width);
  expect(share).toBeCloseTo(225 / 468, 2);
  // Single line breaks show as line breaks, as in Obsidian.
  const para = editor.locator("p", { hasText: "This line follows" });
  expect(await para.evaluate((p) => p.getBoundingClientRect().height)).toBeGreaterThan(40);
  // Nothing was saved: opening changes nothing.
  await settle(page);
  expect(run.text()).toBe(NOTE);
  await run.app.close();
});

test("editing inside a callout keeps it a callout, and the rest of the file as it was", async () => {
  const run = await open();
  await endOf(run.page, "We want one date we keep.");
  await run.page.keyboard.type(" Really.");
  await expectFile(run, NOTE.replace("We want one date we keep.", "We want one date we keep. Really."));
  await run.app.close();
});

test("editing a paragraph with Obsidian's syntax keeps every bit of it, and its line breaks", async () => {
  const run = await open();
  await endOf(run.page, "This line follows");
  await run.page.keyboard.type(" Typed [[New note]] and ==more==.");
  await expectFile(
    run,
    NOTE.replace("as Obsidian shows it.\n", "as Obsidian shows it. Typed [[New note]] and ==more==.\n"),
  );
  await run.app.close();
});

test("Cmd-click on a link to a note opens it; one that can't be found says so", async () => {
  const run = await open();
  const page = run.page;
  await page.locator(`${EDITOR} .ob-link`, { hasText: "Q2 review" }).first().click({ modifiers: ["Meta"] });
  await expect.poll(async () => (await tabState(page)).active).toBe("Q2 review.md");
  await page.locator('.tab[title$="/Q3 planning.md"]').click();
  await run.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { told: string[] };
    g.told = [];
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args[args.length - 1] as { message: string };
      g.told.push(options.message);
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  await page.locator(`${EDITOR} .ob-link`, { hasText: "Ana López" }).first().click({ modifiers: ["Meta"] });
  await expect
    .poll(() => run.app.evaluate(() => (globalThis as unknown as { told: string[] }).told))
    .toEqual(['Corillo can\'t find the note "Ana López".']);
  // A plain click just places the cursor.
  await page.locator(`${EDITOR} .ob-link`, { hasText: "Marcus" }).first().click();
  expect((await tabState(page)).names).toEqual(["Q3 planning.md", "Q2 review.md"]);
  await run.app.close();
});

test("the Markdown view's preview hides the marks, as Obsidian's reading view does", async () => {
  const run = await open();
  await run.page.getByRole("button", { name: "Markdown" }).click();
  const preview = run.page.locator(".doc:not([hidden]) .page.preview .ProseMirror");
  await expect(preview).toHaveClass(/ob-reading/);
  await expect(preview.locator(".ob-callout-title", { hasText: "Warning" })).toBeVisible();
  // (Task lists are shown as Markdown, as they are everywhere in Corillo, so they are left out here.)
  const shown = await preview.evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("pre.raw-block").forEach((raw) => raw.remove());
    document.body.append(copy);
    const text = copy.innerText;
    copy.remove();
    return text;
  });
  expect(shown).toContain("Notes from the kickoff with Ana López and Marcus.");
  expect(shown).toContain("Budget is tight this quarter");
  for (const hidden of ["[[", "]]", "==", "%%", "Ask finance", "A block comment", "[!note]", "^idea-one"]) expect(shown, hidden).not.toContain(hidden);
  await run.app.close();
});

test("Word and PDF exports read as the note does", async () => {
  test.setTimeout(120_000);
  execFileSync(process.execPath, [join(import.meta.dirname, "..", "..", "scripts", "fetch-pandoc.mjs"), `--arch=${process.arch}`], { stdio: "inherit" });
  const run = await open();
  const exportTo = async (format: "Export to Word" | "PDF", name: string) => {
    const out = join(run.folder, name);
    await run.app.evaluate(({ dialog }, chosen) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
    }, out);
    await chooseFromMenu(run.page, "Export", format);
    await expect(run.page.locator(".export-notice")).toContainText(`Exported to ${name}`, { timeout: 45_000 });
    // The embedded charts are found in the vault; only the note's one Markdown picture, which isn't there, is missing.
    await expect(run.page.locator(".export-notice")).toContainText(
      "A picture couldn't be found and was left out: Q3 planning images/chart.png",
    );
    return out;
  };
  const docx = await exportTo("Export to Word", "Q3 planning.docx");
  const xml = execFileSync("unzip", ["-p", docx, "word/document.xml"], { encoding: "utf8" });
  expect(xml).toContain("Ana López");
  expect(xml).not.toContain("[[");
  expect(xml).not.toContain("Ask finance");
  expect(xml).toContain('<w:highlight w:val="yellow" />');
  expect(execFileSync("unzip", ["-Z1", docx], { encoding: "utf8" })).toMatch(/word\/media\//); // the embedded chart

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
  const pdf = await exportTo("PDF", "Q3 planning.pdf");
  expect(readFileSync(pdf).toString("latin1")).toMatch(/\/Subtype\s*\/Image/);
  const printed = (await run.app.evaluate(() => (globalThis as unknown as { printed: string[] }).printed)).join("\n");
  expect(printed).toContain("Notes from the kickoff with Ana López and Marcus.");
  expect(printed).toContain("Why this matters");
  for (const hidden of ["[[", "%%", "Ask finance", "[!note]", "^last-block"]) expect(printed, hidden).not.toContain(hidden);
  // The note itself is untouched.
  expect(run.text()).toBe(NOTE);
  await run.app.close();
});

test("an agent's edits to an Obsidian note keep its syntax, as the person's do", async () => {
  const run = await open();
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    const note = run.file;
    const read = await claude.ok("take_document", { path: note });
    // The agent reads the note's syntax as it's written.
    for (const kept of ["[[Team/Marcus|Marcus]]", "==tight this quarter==", "> [!note] Why this matters", "%%Ask finance"]) expect(read).toContain(kept);
    await claude.ok("edit_document", {
      path: note,
      edits: [
        { find: "We want one date we keep.", replace: "We want one date we keep, see [[Launch plan]]." },
        { find: "Keep the deck under ten slides.", replace: "Keep the deck under ==eight== slides." },
      ],
    });
    const expected = NOTE.replace("We want one date we keep.", "We want one date we keep, see [[Launch plan]].").replace(
      "Keep the deck under ten slides.",
      "Keep the deck under ==eight== slides.",
    );
    await expectFile(run, expected);
    await expect(run.page.locator(`${EDITOR} .ob-link`, { hasText: "Launch plan" })).toBeVisible();
    await expect(run.page.locator(`${EDITOR} .ob-highlight:not(.ob-syntax)`, { hasText: "eight" })).toBeVisible();
    expect(await claude.ok("finish_editing", { path: note })).toContain("back with the person");
    // The person edits after the agent: still nothing else moves.
    await endOf(run.page, "This line follows");
    await run.page.keyboard.type(" Done.");
    await expectFile(run, expected.replace("as Obsidian shows it.\n", "as Obsidian shows it. Done.\n"));
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("an embedded picture follows the disk: one written again shows anew, one that appears shows, when Corillo comes back to the front", async () => {
  const { makePng } = await import("../fixtures/make-png");
  const run = await openText("Chart:\n\n![[chart.png]]\n\nLater:\n\n![[later.png]]\n", {
    prepare: (folder) => {
      mkdirSync(join(folder, ".obsidian"));
      writeFileSync(join(folder, "chart.png"), makePng(40, 30));
    },
  });
  const widths = () =>
    run.page.locator(`${EDITOR} img.ob-embed-picture`).evaluateAll((imgs: HTMLImageElement[]) => imgs.map((i) => (i.complete ? i.naturalWidth : 0)));
  await expect.poll(widths).toEqual([40]);
  await expect(run.page.locator(`${EDITOR} .ob-missing`).first()).toBeVisible();
  writeFileSync(join(run.folder, "chart.png"), makePng(64, 20));
  writeFileSync(join(run.folder, "later.png"), makePng(24, 24));
  await run.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(widths).toEqual([64, 24]);
  await expect(run.page.locator(`${EDITOR} .ob-missing`)).toHaveCount(0);
  await run.app.close();
});

test("missing embedded pictures don't set off a search of the whole vault at every agent edit or return to the window: only the likely places are looked at", async () => {
  const missing = ["one.png", "two.png", "three.png", "four.png", "five.png"];
  const run = await openText(`# Pictures\n\n${missing.map((m) => `![[${m}]]`).join("\n\n")}\n\nThe end.\n`, {
    name: "Pictures.md",
    prepare: (folder) => {
      mkdirSync(join(folder, ".obsidian"));
      // A vault of a few hundred folders.
      for (let i = 0; i < 20; i++) for (let j = 0; j < 15; j++) mkdirSync(join(folder, `Area ${i}`, `Notes ${j}`), { recursive: true });
    },
  });
  const { page } = run;
  await expect(page.locator(`${EDITOR} p:has(.ob-missing)`)).toHaveCount(5);
  // Each search of the vault for a picture, from now on.
  await run.app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { searches: string[] };
    g.searches = [];
    const real = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers.get("obsidian:find-picture")!;
    ipcMain.removeHandler("obsidian:find-picture");
    ipcMain.handle("obsidian:find-picture", (...args) => {
      g.searches.push(String(args[2]));
      return real(...args);
    });
  });
  const searches = () => run.app.evaluate(() => (globalThis as unknown as { searches: string[] }).searches);
  const { session } = await AgentSession.start(run.dataDir);
  try {
    await session.ok("take_document", { path: run.file });
    for (let i = 1; i <= 10; i++) {
      await session.ok("edit_document", { path: run.file, edits: [{ find: i === 1 ? "The end." : `The end ${i - 1}.`, replace: `The end ${i}.` }] });
      await expect(page.locator(EDITOR)).toContainText(`The end ${i}.`);
    }
    await session.ok("finish_editing", { path: run.file });
    await expect(page.locator(".doc:not([hidden]) .agent-notice")).toBeHidden();
    for (let i = 0; i < 3; i++) await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(500);
    await expect(page.locator(`${EDITOR} p:has(.ob-missing)`)).toHaveCount(5);
    expect(await searches()).toEqual([]);
    // One that appears beside the document is still found at the next look.
    copyFileSync(PNG, join(run.folder, "two.png"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator(`${EDITOR} img.ob-embed-picture`)).toHaveCount(1);
    await expect(page.locator(`${EDITOR} p:has(.ob-missing)`)).toHaveCount(4);
    expect(await searches()).toEqual([]);
  } finally {
    await session.stop();
    await run.app.close();
  }
});

test("an embedded picture whose lookup fails says it can't be found, and is looked for again when Corillo comes back to the front", async () => {
  const { makePng } = await import("../fixtures/make-png");
  const run = await openText("Start.\n", {
    prepare: (folder) => {
      mkdirSync(join(folder, ".obsidian"));
      writeFileSync(join(folder, "chart.png"), makePng(40, 30));
    },
  });
  // The lookup fails once (as when the Mac can't read the folder), then works again.
  await run.app.evaluate(({ ipcMain }) => {
    const real = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers.get("obsidian:find-picture")!;
    ipcMain.removeHandler("obsidian:find-picture");
    let failed = false;
    ipcMain.handle("obsidian:find-picture", (...args) => {
      if (failed) return real(...args);
      failed = true;
      throw new Error("Can't read the folder.");
    });
  });
  await run.page.locator(EDITOR).click();
  await run.page.keyboard.press("Meta+ArrowDown");
  await run.page.keyboard.press("Enter");
  await run.page.keyboard.type("![[chart.png]] ");
  await expect(run.page.locator(`${EDITOR} .ob-missing`).first()).toBeVisible();
  await run.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(run.page.locator(`${EDITOR} img.ob-embed-picture`)).toBeVisible();
  await expect(run.page.locator(`${EDITOR} .ob-missing`)).toHaveCount(0);
  await run.app.close();
});
