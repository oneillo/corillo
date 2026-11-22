// A web picture an agent added waits for the person (roadmap Batch 18, item
// 1). Copied from where it waits and pasted into another document, it waits
// there too, and goes on waiting after that document is closed and opened
// again (roadmap Batch 19, item 1, the review of Batch 18's R18-7).
//
// Nothing leaves this Mac: the picture is served over HTTPS from 127.0.0.1,
// by a server the test starts with a certificate made for the run, which the
// app is told to accept for 127.0.0.1 only. The server counts every
// connection, so a picture asked for at all is seen.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { captureClipboardWrites, clickMenu, clipboardHoldsText, copySelection, cursorAtEnd, openAlso, openFromFinder, openText, paste, settle, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";
import { pictureServer, trustLocalServer } from "./picture-server";

const PLAN = "# Plan\n\nThe offer to Acme is 41,500 dollars.\n\nNext steps follow.\n";
const NOTES = () => "# Notes\n\nPaste below.\n";
const chart = (path: string) => (origin: string) => `![chart](${origin}${path})`;
const WAITING = ".doc:not([hidden]) .picture.waiting";

/**
 * plan.md, with what an agent adds through Corillo after its last line
 * (`added`, given the server's address): its web pictures wait. Notes.md
 * (`notesText`) opened beside it, in front.
 */
async function planWithWaiting(
  added: (origin: string) => string,
  waiting: number,
  notesText: (origin: string) => string = NOTES,
): Promise<{ run: Running; web: Awaited<ReturnType<typeof pictureServer>>; origin: string; notes: string; stop: () => Promise<void> }> {
  const web = await pictureServer();
  const run = await openText(PLAN, { name: "plan.md" });
  await trustLocalServer(run.app);
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  await session.ok("take_document", { path: run.file });
  await session.ok("edit_document", { path: run.file, edits: [{ find: "Next steps follow.", replace: `Next steps follow.\n\n${added(web.origin)}` }] });
  await session.ok("finish_editing", { path: run.file, request: "A chart." });
  await expect(run.page.locator(WAITING)).toHaveCount(waiting, { timeout: 15_000 });
  const notes = await openAlso(run, "notes.md", notesText(web.origin));
  await expect(run.page.locator(EDITOR)).toContainText("Paste below.");
  return {
    run,
    web,
    origin: web.origin,
    notes,
    stop: async () => {
      await session.stop();
      await web.close();
    },
  };
}

/** Bring a document's tab to the front, as clicking it would. */
async function inFront(run: Running, file: string, words: string): Promise<void> {
  await openFromFinder(run.app, file);
  await expect(run.page.locator(EDITOR)).toContainText(words);
}

/** Close the document in front, and open it again, as after quitting. */
async function closeAndReopen(run: Running, file: string, words: string): Promise<void> {
  const tabs = await run.page.locator(".tab").count();
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator(".tab")).toHaveCount(tabs - 1);
  await inFront(run, file, words);
}

/** Copy the whole of the document in front, as Command-A and Command-C would; what the clipboard got, by type. */
async function copyAll(run: Running, words: string): Promise<Record<string, string>> {
  const written = await captureClipboardWrites(run.app);
  await cursorAtEnd(run.page, words);
  await run.page.keyboard.press("Meta+A");
  await settle(run.page);
  await copySelection(run.page);
  await expect.poll(written).not.toBeNull();
  return (await written())!;
}

/** Paste what was copied at the end of the document in front, on a line of its own. */
async function pasteAtEnd(run: Running, words: string, copied: Record<string, string>): Promise<void> {
  await cursorAtEnd(run.page, words);
  await run.page.keyboard.press("Enter");
  await paste(run.page, copied);
  await settle(run.page);
}

test("a waiting picture copied into another document waits there, after reopening too, until Show picture there", async () => {
  test.setTimeout(60_000);
  const { run, web, origin, notes, stop } = await planWithWaiting(chart("/chart.png?q=offer"), 1);
  const address = `${origin}/chart.png?q=offer`;
  await inFront(run, run.file, "Next steps follow.");
  const copied = await copyAll(run, "Next steps follow.");
  // The copy carries the picture's address and that it waits, never anything to load.
  expect(copied["text/html"]).toMatch(/<img [^>]*src=""[^>]*data-waiting="true"|<img [^>]*data-waiting="true"[^>]*src=""/);

  // Plan.md closed, so no other open document holds it waiting: only the copy can say it waits.
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator(EDITOR)).toContainText("Paste below.");
  await pasteAtEnd(run, "Paste below.", copied);
  await expect(run.page.locator(WAITING)).toHaveCount(1);
  await expect(run.page.locator(WAITING)).toContainText(`Picture from the web, not shown: ${address}`);
  await expect.poll(() => readFileSync(notes, "utf8")).toContain(`![chart](${address})`);
  // The same copy pasted into notes.md's Markdown view: its text goes in, and the picture waits there too.
  await pasteInMarkdownView(run, copied);
  await expect(run.page.locator(".doc:not([hidden]) .preview .picture.waiting")).toHaveCount(2);
  await clickMenu(run.app, "view-formatted");
  await expect(run.page.locator(`${EDITOR} .picture.waiting`)).toHaveCount(2);
  await run.page.waitForTimeout(1500);
  expect(web.connections()).toBe(0);

  // Notes.md closed and opened again: it still waits, kept with its records.
  await closeAndReopen(run, notes, "Paste below.");
  await expect(run.page.locator(`${EDITOR} .picture.waiting`)).toHaveCount(2);
  await run.page.waitForTimeout(1000);
  expect(web.connections()).toBe(0);

  // His click in notes.md: then it's asked for, and shows (both, the same address).
  await run.page.locator(`${EDITOR} .picture.waiting`).first().getByRole("button", { name: "Show picture" }).click();
  await expect(run.page.locator(`${EDITOR} .picture img`)).toHaveCount(2);
  await expect(run.page.locator(`${EDITOR} .picture img`).first()).toHaveJSProperty("naturalWidth", 40);
  expect(new Set(web.asked)).toEqual(new Set(["/chart.png?q=offer"]));
  await run.app.close();
  await stop();
});

test("an address written without its slashes (https:host/...) waits in the other document too, after reopening (the review of Batch 19, R19-1)", async () => {
  test.setTimeout(60_000);
  const { run, web, origin, notes, stop } = await planWithWaiting((o) => `![c](${o.replace("https://", "https:")}/p.png?q=secret)`, 1);
  await inFront(run, run.file, "Next steps follow.");
  const copied = await copyAll(run, "Next steps follow.");
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator(EDITOR)).toContainText("Paste below.");
  await pasteAtEnd(run, "Paste below.", copied);
  await expect(run.page.locator(WAITING)).toHaveCount(1);
  await expect.poll(() => readFileSync(notes, "utf8")).toContain(`![c](${origin.replace("https://", "https:")}/p.png?q=secret)`);

  // Plan.md isn't open: only notes.md's own list can keep it waiting.
  await closeAndReopen(run, notes, "Paste below.");
  await expect(run.page.locator(WAITING)).toHaveCount(1);
  await run.page.waitForTimeout(1500);
  expect(web.connections()).toBe(0);
  await run.app.close();
  await stop();
});

test("a page copy from before Corillo restarted, or the window opened again, still waits where it's pasted (the review of Batch 19, R19-2)", async () => {
  test.setTimeout(60_000);
  const { run, web, origin, notes, stop } = await planWithWaiting(chart("/before.png?q=offer"), 1);
  const address = `${origin}/before.png?q=offer`;
  await inFront(run, run.file, "Next steps follow.");
  // A paragraph and the picture after it, with no heading: what's pasted is plain paragraphs.
  const written = await captureClipboardWrites(run.app);
  await cursorAtEnd(run.page, "Next steps follow.");
  await run.page.keyboard.press("Meta+ArrowLeft");
  await run.page.keyboard.press("Shift+Meta+ArrowDown");
  await settle(run.page);
  await copySelection(run.page);
  await expect.poll(written).not.toBeNull();
  const copied = (await written())!;
  expect(copied["text/html"]).toContain("data-waiting");
  expect(copied["text/html"]).not.toContain("<h1");
  // A new launch, or the window opened again, marks its copies with a new value: this copy's no longer matches.
  const before = { ...copied, "text/html": copied["text/html"].replace(/data-corillo="[^"]*"/g, 'data-corillo="0123456789abcdef0123456789abcdef"') };

  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator(EDITOR)).toContainText("Paste below.");
  await pasteAtEnd(run, "Paste below.", before);
  await expect(run.page.locator(WAITING)).toHaveCount(1);
  await expect(run.page.locator(WAITING)).toContainText(`Picture from the web, not shown: ${address}`);
  await expect.poll(() => readFileSync(notes, "utf8")).toContain(`![chart](${address})`);
  await closeAndReopen(run, notes, "Paste below.");
  await expect(run.page.locator(WAITING)).toHaveCount(1);
  await run.page.waitForTimeout(1500);
  expect(web.connections()).toBe(0);
  expect(existsSync(join(run.folder, "notes images"))).toBe(false);
  await run.app.close();
  await stop();
});

test("a paste that says more web pictures wait than a document's list holds isn't pasted, on the page or in the Markdown view (the review of Batch 19, R19-5)", async () => {
  test.setTimeout(60_000);
  const web = await pictureServer();
  const run = await openText(NOTES(), { name: "notes.md" });
  await trustLocalServer(run.app);
  const listed = Array.from({ length: 1_001 }, (_, i) => `${web.origin}/${i}.png`);
  const copied = { "text/plain": listed.map((a) => `![p](${a})`).join("\n\n"), "application/x-corillo-waiting": JSON.stringify(listed) };
  await pasteAtEnd(run, "Paste below.", copied);
  await expect(run.page.locator(".file-notice")).toContainText("Corillo didn't paste this.");
  await pasteInMarkdownView(run, copied);
  await clickMenu(run.app, "view-formatted");
  await run.page.waitForTimeout(1000);
  expect(run.text()).not.toContain("![p]"); // only the empty lines typed before each paste
  await expect(run.page.locator(`${EDITOR} .picture`)).toHaveCount(0);
  expect(web.connections()).toBe(0);
  await run.app.close();
  await web.close();
});

const SOURCE = ".doc:not([hidden]) textarea.source";

/**
 * Copy all of the Markdown view's text in the document in front, as Command-A
 * and Command-C would: what Corillo puts on the clipboard, or, if it leaves
 * the copy to the text box, the text selected, as the text box would copy it.
 */
async function copyMarkdownView(run: Running): Promise<Record<string, string>> {
  await clickMenu(run.app, "view-markdown");
  await run.page.locator(SOURCE).click();
  await run.page.keyboard.press("Meta+A");
  return run.page.evaluate((selector) => {
    const area = document.querySelector<HTMLTextAreaElement>(selector)!;
    const transfer = new DataTransfer();
    const event = new ClipboardEvent("copy", { clipboardData: transfer, bubbles: true, cancelable: true });
    area.dispatchEvent(event);
    if (!event.defaultPrevented) return { "text/plain": area.value.slice(area.selectionStart, area.selectionEnd) };
    return Object.fromEntries(transfer.types.map((type) => [type, transfer.getData(type)]));
  }, SOURCE);
}

/** Paste at the end of the Markdown view's text, on lines of its own, as Command-V would there (the text box puts the text in if Corillo doesn't). */
async function pasteInMarkdownView(run: Running, copied: Record<string, string>): Promise<void> {
  await clickMenu(run.app, "view-markdown");
  await run.page.locator(SOURCE).click();
  await run.page.keyboard.press("Meta+ArrowDown");
  await run.page.keyboard.press("Enter");
  await run.page.keyboard.press("Enter");
  await run.page.evaluate(
    ([selector, data]) => {
      const area = document.querySelector<HTMLTextAreaElement>(selector)!;
      const transfer = new DataTransfer();
      for (const [type, value] of Object.entries(data)) transfer.setData(type, value);
      const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
      area.dispatchEvent(event);
      if (!event.defaultPrevented) document.execCommand("insertText", false, data["text/plain"]);
    },
    [SOURCE, copied] as const,
  );
  await settle(run.page);
}

test("copied from the Markdown view, it waits pasted into another document's page or Markdown view, with the first open or closed, and after reopening", async () => {
  test.setTimeout(120_000);
  const { run, web, origin, notes, stop } = await planWithWaiting(chart("/md.png?q=offer"), 1);
  const address = `${origin}/md.png?q=offer`;
  await inFront(run, run.file, "Next steps follow.");
  const copied = await copyMarkdownView(run);
  expect(copied["text/plain"]).toContain(`![chart](${address})`);
  await clickMenu(run.app, "view-formatted");

  /** Paste into the page, then into the Markdown view, of the document in front: two markers, nothing asked for. */
  const pasteBoth = async (file: string, words: string) => {
    await inFront(run, file, words);
    await pasteAtEnd(run, words, { "text/plain": copied["text/plain"], ...(copied["application/x-corillo-waiting"] ? { "application/x-corillo-waiting": copied["application/x-corillo-waiting"] } : {}) });
    await expect(run.page.locator(`${EDITOR} .picture.waiting`)).toHaveCount(1);
    await pasteInMarkdownView(run, copied);
    await expect(run.page.locator(".doc:not([hidden]) .preview .picture.waiting")).toHaveCount(2);
    await clickMenu(run.app, "view-formatted");
    await expect(run.page.locator(`${EDITOR} .picture.waiting`)).toHaveCount(2);
    await expect.poll(() => readFileSync(file, "utf8").split(`![chart](${address})`).length - 1).toBe(2);
    await run.page.waitForTimeout(1500);
    expect(web.connections()).toBe(0);
  };

  // Plan.md still open.
  await pasteBoth(notes, "Paste below.");
  // Plan.md closed: only the copy can say it waits.
  await inFront(run, run.file, "Next steps follow.");
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator(".tab")).toHaveCount(1);
  const later = await openAlso(run, "later.md", "# Later\n\nPaste here.\n");
  await pasteBoth(later, "Paste here.");

  // Each closed and opened again, without plan.md: still markers.
  await closeAndReopen(run, later, "Paste here.");
  await expect(run.page.locator(`${EDITOR} .picture.waiting`)).toHaveCount(2);
  await inFront(run, notes, "Paste below.");
  await closeAndReopen(run, notes, "Paste below.");
  await expect(run.page.locator(`${EDITOR} .picture.waiting`)).toHaveCount(2);
  await run.page.waitForTimeout(1500);
  expect(web.connections()).toBe(0);
  await run.app.close();
  await stop();
});

/** A diagram with a picture shape and a label holding a picture, both on the test's server. */
const diagram = (origin: string) =>
  [
    "```mermaid",
    "flowchart LR",
    `  A@{ img: "${origin}/shape.png?q=offer%20to%20Acme", label: "Chart", w: 40, h: 30 }`,
    `  B["<img src='${origin}/label.png?q=41500'>"]`,
    "  A --> B",
    "```",
  ].join("\n");

test("a diagram whose pictures wait, copied into another document, waits there too, after reopening too", async () => {
  test.setTimeout(90_000);
  const { run, web, notes, stop } = await planWithWaiting(diagram, 2);
  await inFront(run, run.file, "Next steps follow.");
  const copied = await copyAll(run, "Next steps follow.");
  expect(copied["text/html"]).toContain("data-waiting=");
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator(EDITOR)).toContainText("Paste below.");
  await pasteAtEnd(run, "Paste below.", copied);
  const drawn = run.page.locator(`${EDITOR} .diagram`);
  await expect(drawn.locator(".diagram-picture svg")).toBeVisible({ timeout: 15_000 });
  await expect(drawn.locator(".picture.waiting")).toHaveCount(2);
  await expect.poll(() => readFileSync(notes, "utf8")).toContain("```mermaid");
  await run.page.waitForTimeout(1500);
  expect(web.connections()).toBe(0);

  await closeAndReopen(run, notes, "Paste below.");
  await expect(drawn.locator(".diagram-picture svg")).toBeVisible({ timeout: 15_000 });
  await expect(drawn.locator(".picture.waiting")).toHaveCount(2);
  await run.page.waitForTimeout(1000);
  expect(web.connections()).toBe(0);
  await run.app.close();
  await stop();
});

/** Pretend the person chose this name and folder in the next save dialog (File > New Document asks for one). */
function chooseInSaveDialog(app: ElectronApplication, filePath: string): Promise<void> {
  return app.evaluate(({ dialog }, picked) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: picked })) as typeof dialog.showSaveDialog;
  }, filePath);
}

test("pasted into a new document, or back where it came from, it waits; Paste and Match Style brings only its words", async () => {
  test.setTimeout(90_000);
  const { run, web, origin, stop } = await planWithWaiting(chart("/new.png"), 1);
  const address = `${origin}/new.png`;
  await inFront(run, run.file, "Next steps follow.");
  const copied = await copyAll(run, "Next steps follow.");

  // Back into the same document (it already waits there): two markers. A second tab of it isn't possible: it opens in its one tab.
  await pasteAtEnd(run, "Next steps follow.", copied);
  await expect(run.page.locator(WAITING)).toHaveCount(2);
  await openFromFinder(run.app, run.file);
  await expect(run.page.locator(".tab")).toHaveCount(2);
  await clickMenu(run.app, "close-tab");

  // A new document.
  const fresh = join(run.folder, "Ideas.md");
  await chooseInSaveDialog(run.app, fresh);
  await clickMenu(run.app, "new-document");
  await expect.poll(() => existsSync(fresh)).toBe(true);
  await expect(run.page.locator(".tab")).toHaveCount(2);
  await run.page.locator(`${EDITOR} .ProseMirror`).click();
  await run.page.keyboard.type("Ideas.");
  await pasteAtEnd(run, "Ideas.", copied);
  await expect(run.page.locator(WAITING)).toHaveCount(1);
  await expect.poll(() => readFileSync(fresh, "utf8")).toContain(`![chart](${address})`);

  // Paste and Match Style: the copy's Markdown as words, never a picture, in the file too.
  await clipboardHoldsText(run.app, copied["text/plain"]);
  await cursorAtEnd(run.page, "Ideas.");
  await clickMenu(run.app, "paste-plain");
  await expect.poll(() => readFileSync(fresh, "utf8")).toContain(`!\\[chart\\](${address})`);
  await expect(run.page.locator(WAITING)).toHaveCount(1);

  // The new document closed and opened again: still a marker.
  await closeAndReopen(run, fresh, "Ideas.");
  await expect(run.page.locator(WAITING)).toHaveCount(1);
  await run.page.waitForTimeout(1500);
  expect(web.connections()).toBe(0);
  await run.app.close();
  await stop();
});

test("pictures from elsewhere, and a document's own, load as before: a page's own mark makes nothing wait", async () => {
  test.setTimeout(60_000);
  const { run, web, origin, notes, stop } = await planWithWaiting(chart("/waits.png"), 1, (o) => `# Notes\n\n![own](${o}/own.png)\n\nPaste below.\n`);
  // Notes.md's own picture from the web loads as it opens.
  await expect(run.page.locator(`${EDITOR} .picture img`)).toHaveJSProperty("naturalWidth", 40);
  expect(web.asked).toEqual(["/own.png"]);

  // A web page's HTML with the mark on its picture: cleaned like any page, and its picture copied in as before.
  await pasteAtEnd(run, "Paste below.", { "text/html": `<p>From a site.</p><p><img src="${origin}/site.png" data-src="${origin}/site.png" data-waiting="true" alt="site"></p>` });
  await expect.poll(() => web.asked.includes("/site.png")).toBe(true);
  await expect.poll(() => readFileSync(notes, "utf8")).toContain("![site](notes%20images/");
  await expect(run.page.locator(WAITING)).toHaveCount(0);
  await run.app.close();
  await stop();
});

/** Select, in the Markdown view of the document in front, the whole line holding `words` (its line break too), and copy it as Command-C would: what Corillo puts on the clipboard, or what the text box would. */
async function copyMarkdownLine(run: Running, words: string): Promise<Record<string, string>> {
  await clickMenu(run.app, "view-markdown");
  await run.page.locator(SOURCE).click();
  return run.page.evaluate(
    ([selector, find]) => {
      const area = document.querySelector<HTMLTextAreaElement>(selector)!;
      const at = area.value.indexOf(find);
      const start = area.value.lastIndexOf("\n", at) + 1;
      area.setSelectionRange(start, area.value.indexOf("\n", at) + 1);
      const transfer = new DataTransfer();
      const event = new ClipboardEvent("copy", { clipboardData: transfer, bubbles: true, cancelable: true });
      area.dispatchEvent(event);
      if (!event.defaultPrevented) return { "text/plain": area.value.slice(area.selectionStart, area.selectionEnd) };
      return Object.fromEntries(transfer.types.map((type) => [type, transfer.getData(type)]));
    },
    [SOURCE, words] as const,
  );
}

/** Put the cursor in the Markdown view of the document in front, at the start of the line holding `words`. */
async function markdownCursorAt(run: Running, words: string): Promise<void> {
  await clickMenu(run.app, "view-markdown");
  await run.page.locator(SOURCE).click();
  await run.page.evaluate(
    ([selector, find]) => {
      const area = document.querySelector<HTMLTextAreaElement>(selector)!;
      const start = area.value.lastIndexOf("\n", area.value.indexOf(find)) + 1;
      area.focus();
      area.setSelectionRange(start, start);
    },
    [SOURCE, words] as const,
  );
}

test("part of a waiting diagram's code, copied without its fence, and Paste and Match Style into the Markdown view: they wait there too (the review of Batch 19, R19-3)", async () => {
  test.setTimeout(90_000);
  const { run, web, notes, stop } = await planWithWaiting(diagram, 2, () => "# Notes\n\nPaste below.\n\n```mermaid\nflowchart LR\n  X --> Y\n```\n");
  await inFront(run, run.file, "Next steps follow.");
  const shape = await copyMarkdownLine(run, "img:");
  expect(shape["text/plain"]).toContain("shape.png");
  expect(shape["application/x-corillo-waiting"]).toContain("shape.png");

  // Pasted into notes.md's diagram code, in its Markdown view.
  await inFront(run, notes, "Paste below.");
  await markdownCursorAt(run, "X --> Y");
  await run.page.evaluate(
    ([selector, data]) => {
      const area = document.querySelector<HTMLTextAreaElement>(selector)!;
      const transfer = new DataTransfer();
      for (const [type, value] of Object.entries(data)) transfer.setData(type, value);
      const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
      area.dispatchEvent(event);
      if (!event.defaultPrevented) document.execCommand("insertText", false, data["text/plain"]);
    },
    [SOURCE, shape] as const,
  );
  await expect.poll(() => readFileSync(notes, "utf8")).toContain("shape.png");

  // The label's line, copied the same way, then Edit > Paste and Match Style there: the app gives only its text.
  await inFront(run, run.file, "Next steps follow.");
  const label = await copyMarkdownLine(run, "label.png");
  expect(label["application/x-corillo-waiting"]).toContain("label.png");
  await inFront(run, notes, "Paste below.");
  await markdownCursorAt(run, "X --> Y");
  await clipboardHoldsText(run.app, label["text/plain"]);
  await clickMenu(run.app, "paste-plain");
  await expect.poll(() => readFileSync(notes, "utf8")).toContain("label.png");
  await clickMenu(run.app, "view-formatted");

  // Plan.md closed, and notes.md opened again: both of the diagram's pictures wait, and nothing was asked for.
  await inFront(run, run.file, "Next steps follow.");
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator(".tab")).toHaveCount(1);
  await closeAndReopen(run, notes, "Paste below.");
  const drawn = run.page.locator(`${EDITOR} .diagram`);
  await expect(drawn.locator(".diagram-picture svg")).toBeVisible({ timeout: 15_000 });
  await expect(drawn.locator(".picture.waiting")).toHaveCount(2);
  await run.page.waitForTimeout(1500);
  expect(web.connections()).toBe(0);
  await run.app.close();
  await stop();
});

test("Paste and Match Style into a diagram's code on the page: its waiting picture waits there too (the review of Batch 19, R19-3)", async () => {
  test.setTimeout(90_000);
  const { run, web, notes, stop } = await planWithWaiting(diagram, 2, () => "# Notes\n\nPaste below.\n\n```mermaid\nflowchart LR\n  X --> Y\n```\n");
  await inFront(run, run.file, "Next steps follow.");
  const label = await copyMarkdownLine(run, "label.png");
  expect(label["application/x-corillo-waiting"]).toContain("label.png");
  await clickMenu(run.app, "view-formatted");

  await inFront(run, notes, "Paste below.");
  const drawn = run.page.locator(`${EDITOR} .diagram`);
  await expect(drawn.locator(".diagram-picture svg")).toBeVisible({ timeout: 15_000 });
  await drawn.hover();
  await run.page.getByRole("button", { name: "Edit diagram code" }).click();
  await settle(run.page);
  await run.page.keyboard.press("Enter");
  await clipboardHoldsText(run.app, label["text/plain"]);
  await clickMenu(run.app, "paste-plain");
  await expect.poll(() => readFileSync(notes, "utf8")).toContain("  X --> Y\n  B[");

  // Plan.md closed, and notes.md opened again: the picture waits, and nothing was asked for.
  await inFront(run, run.file, "Next steps follow.");
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator(".tab")).toHaveCount(1);
  await closeAndReopen(run, notes, "Paste below.");
  await expect(drawn.locator(".diagram-picture svg")).toBeVisible({ timeout: 15_000 });
  await expect(drawn.locator(".picture.waiting")).toHaveCount(1);
  await run.page.waitForTimeout(1500);
  expect(web.connections()).toBe(0);
  await run.app.close();
  await stop();
});
