// The person's place when the text changes under them: an agent's edit
// arriving, another app saving the file. The page doesn't jump, the cursor
// and selection stay on the same words (or as near as the new text allows,
// never at the top), and the comment card in focus stays in focus. Each test
// runs the real app, hidden, on throwaway documents and a throwaway data
// folder, with a pretend agent tool speaking MCP to it.
import { test, expect, type Page } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chooseInContextMenu, clickMenu, openText, settle, tabState, EDITOR, FIXTURES, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const PANEL = ".doc:not([hidden]) aside.comments-panel";
const CANVAS = ".doc:not([hidden]) .canvas";
const SOURCE = ".doc:not([hidden]) textarea.source";
const PREVIEW_PANE = ".doc:not([hidden]) .preview-pane";

/** Sixty paragraphs, each long enough to wrap, each with words of its own (as in a real document). */
const WORDS = (
  "budget hiring plan quarter team review draft customer launch market risk goal office travel season " +
  "volunteer event inbox report schedule partner contract design survey pricing training window supplier " +
  "meeting deadline summary policy grant donor website newsletter ticket venue catering permit insurance"
).split(" ");
const label = (i: number) => `Point ${i}:`;
function para(i: number): string {
  let seed = i * 7919 + 17;
  const words = [label(i)];
  for (let k = 0; k < 26; k++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    words.push(WORDS[Math.floor(seed / 65536) % WORDS.length]);
  }
  return `${words.join(" ")}.`;
}
const PARAS = Array.from({ length: 60 }, (_, i) => para(i + 1));
const LONG = `# Long plan\n\n${PARAS.join("\n\n")}\n`;
const ABOVE = "A new first point.\n\nA new second point.\n\nA new third point.";

const sessions: AgentSession[] = [];
let run: Running | null = null;

async function start(text = LONG): Promise<Running> {
  run = await openText(text, { name: "plan.md" });
  return run;
}

async function agent(): Promise<AgentSession> {
  const { session } = await AgentSession.start(run!.dataDir);
  sessions.push(session);
  return session;
}

test.afterEach(async () => {
  const r = run;
  run = null;
  const home = await r?.app.evaluate(() => process.env.CORILLO_HOME).catch(() => undefined);
  await r?.app.close().catch(() => undefined);
  await Promise.all(sessions.splice(0).map((s) => s.stop()));
  for (const dir of [r?.folder, r?.dataDir, home]) if (dir) rmSync(dir, { recursive: true, force: true });
});

const notice = (page: Page) => page.locator(".doc:not([hidden]) .agent-notice");
const paragraph = (page: Page, i: number) => page.locator(`${EDITOR} p`, { hasText: label(i) });

/** Where a paragraph's top is, from the top of the page's scrolling area. */
function topInPage(page: Page, i: number): Promise<number> {
  return page.evaluate(
    ([canvas, editor, n]) => {
      const scroller = document.querySelector(canvas)!;
      const p = [...document.querySelectorAll(`${editor} p`)].find((e) => e.textContent!.startsWith(`Point ${n}:`))!;
      return p.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    },
    [CANVAS, EDITOR, i] as const,
  );
}

/** Scroll the page so a paragraph sits a little below the top of the window. */
async function readAt(page: Page, i: number): Promise<number> {
  await page.evaluate(
    ([canvas, editor, n]) => {
      const scroller = document.querySelector(canvas)!;
      const p = [...document.querySelectorAll(`${editor} p`)].find((e) => e.textContent!.startsWith(`Point ${n}:`))!;
      scroller.scrollTop += p.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40;
    },
    [CANVAS, EDITOR, i] as const,
  );
  await settle(page);
  return topInPage(page, i);
}

const scrollOf = (page: Page, selector: string) => page.locator(selector).evaluate((e) => e.scrollTop);

/** Where the paragraph holding some words is on screen. */
const onScreen = (page: Page, words: string) =>
  page.locator(`${EDITOR} p`, { hasText: words }).evaluate((p) => p.getBoundingClientRect().top);

/** Put the cursor in the middle of a paragraph, as a click there would (the end of its first line). */
async function cursorIn(page: Page, i: number): Promise<void> {
  await paragraph(page, i).click({ position: { x: 20, y: 5 } });
  await settle(page);
  await page.keyboard.press("Meta+ArrowRight");
  await settle(page);
}

// The cursor, when its words are rewritten (SH-1) -------------------------------------------

test("when an agent rewrites the paragraph the cursor is in, typing afterwards goes there, not at the top, and the page doesn't move", async () => {
  const { page, file } = await start();
  const claude = await agent();
  await cursorIn(page, 40);
  expect(await scrollOf(page, CANVAS)).toBeGreaterThan(500);
  await claude.ok("take_document", { path: file });
  const rewritten = "Everything about this point was said again in other words by the agent.";
  await claude.ok("edit_document", { path: file, edits: [{ find: para(40), replace: rewritten }] });
  await expect(page.locator(EDITOR)).toContainText(rewritten);
  await claude.ok("finish_editing", { path: file });
  await expect(notice(page)).toBeHidden();
  const top = await onScreen(page, rewritten);
  await page.keyboard.type("Q");
  await expect.poll(() => readFileSync(file, "utf8")).toContain("Q");
  const text = readFileSync(file, "utf8");
  const at = text.indexOf("Q");
  const from = text.indexOf(rewritten.slice(0, 20));
  expect(at).toBeGreaterThanOrEqual(from);
  expect(at).toBeLessThanOrEqual(from + rewritten.length + 1);
  expect(text.startsWith("# Long plan\n")).toBe(true);
  expect(Math.abs((await onScreen(page, rewritten.slice(0, 20))) - top)).toBeLessThan(2);
});

test("when another app rewrites the paragraph the cursor is in, typing afterwards goes there, not at the top", async () => {
  const { page, file } = await start();
  await cursorIn(page, 40);
  const rewritten = "Someone else rewrote this point in another app, with none of the old words.";
  writeFileSync(file, LONG.replace(para(40), rewritten));
  await expect(page.locator(EDITOR)).toContainText(rewritten);
  const top = await onScreen(page, rewritten);
  await page.keyboard.type("Q");
  await expect.poll(() => readFileSync(file, "utf8")).toContain("Q");
  const text = readFileSync(file, "utf8");
  const at = text.indexOf("Q");
  const from = text.indexOf(rewritten.slice(0, 20));
  expect(at).toBeGreaterThanOrEqual(from);
  expect(at).toBeLessThanOrEqual(from + rewritten.length + 1);
  expect(Math.abs((await onScreen(page, rewritten.slice(0, 20))) - top)).toBeLessThan(2);
});

// The cursor, when its paragraph is rewritten and another added beside it (R-SH-4) ------------

const ADDED = "A new paragraph the agent added, explaining why it is there and what follows from it, at some length.";
/** The paragraph rewritten: other words, one of its own kept (as a rewrite usually keeps a few). */
const rewrite = (i: number) => `Shorter now, about the ${para(i).split(" ").find((w) => w.length > 5)!.replace(/\.$/, "")} only.`;

/** The line of the file the person's "X" went into. */
async function lineTyped(file: string): Promise<string> {
  await expect.poll(() => readFileSync(file, "utf8")).toContain("X");
  return readFileSync(file, "utf8").split("\n").find((l) => l.includes("X"))!;
}

for (const where of ["above", "below"] as const) {
  test(`when an agent rewrites the paragraph the cursor is in and adds one ${where} it, typing afterwards goes into the rewritten paragraph`, async () => {
    const { page, file } = await start();
    const claude = await agent();
    await cursorIn(page, 40);
    await claude.ok("take_document", { path: file });
    const replace = where === "above" ? `${ADDED}\n\n${rewrite(40)}` : `${rewrite(40)}\n\n${ADDED}`;
    await claude.ok("edit_document", { path: file, edits: [{ find: para(40), replace }] });
    await expect(page.locator(EDITOR)).toContainText(rewrite(40));
    await claude.ok("finish_editing", { path: file });
    await expect(notice(page)).toBeHidden();
    await page.keyboard.type("X");
    expect((await lineTyped(file)).replace("X", "")).toBe(rewrite(40));
  });
}

test("in the Markdown view, when an agent rewrites the paragraph the cursor is in and adds one above it, typing afterwards goes into the rewritten paragraph", async () => {
  const { page, file } = await start();
  const claude = await agent();
  await page.getByRole("button", { name: "Markdown" }).click();
  const area = page.locator(SOURCE);
  await area.evaluate((a, p) => {
    const at = (a as HTMLTextAreaElement).value.indexOf(p) + Math.floor(p.length / 2);
    (a as HTMLTextAreaElement).setSelectionRange(at, at);
  }, para(40));
  await claude.ok("take_document", { path: file });
  await claude.ok("edit_document", { path: file, edits: [{ find: para(40), replace: `${ADDED}\n\n${rewrite(40)}` }] });
  await expect(area).toHaveValue(new RegExp(rewrite(40)));
  await claude.ok("finish_editing", { path: file });
  await expect(notice(page)).toBeHidden();
  await expect(area).toBeFocused();
  await page.keyboard.type("X");
  expect((await lineTyped(file)).replace("X", "")).toBe(rewrite(40));
});

// The cursor on an empty line (R-EL-9) ----------------------------------------------------------

/** The page's blocks, in order, as their words ("" for an empty line). */
const blocks = (page: Page) =>
  page.locator(`${EDITOR} .ProseMirror`).evaluate((root) => [...root.children].map((b) => (b as HTMLElement).innerText.trim()));

test("a cursor on an empty line stays on that empty line when another app or an agent changes the file", async () => {
  const letter = "# Letter\n\nHi Ana,\n\n\n\nThanks for the notes.\n\nMore here.\n";
  const { page, file } = await start(letter);
  await expect.poll(() => blocks(page)).toEqual(["Letter", "Hi Ana,", "", "", "Thanks for the notes.", "More here."]);
  await page.locator(`${EDITOR} p.empty-line`).nth(1).click();
  await settle(page);
  // Another app changes a paragraph below, then one above (the lines move down).
  writeFileSync(file, letter.replace("More here.", "More here, and more."));
  await expect(page.locator(EDITOR)).toContainText("and more.");
  writeFileSync(file, letter.replace("More here.", "More here, and more.").replace("# Letter", "# Letter\n\nA new first line."));
  await expect(page.locator(EDITOR)).toContainText("A new first line.");
  // An agent changes the paragraph just after the empty lines.
  const claude = await agent();
  await claude.ok("take_document", { path: file });
  await claude.ok("edit_document", { path: file, edits: [{ find: "Thanks for the notes.", replace: "Thank you for the notes." }] });
  await expect(page.locator(EDITOR)).toContainText("Thank you");
  await claude.ok("finish_editing", { path: file });
  await expect(notice(page)).toBeHidden();
  await page.keyboard.type("X");
  await expect.poll(() => blocks(page)).toEqual(["Letter", "A new first line.", "Hi Ana,", "", "X", "Thank you for the notes.", "More here, and more."]);
});

// Its neighbours: the first or second of two empty lines, at the top of the document or just above its last
// paragraph, with the change above, below, or in the paragraph right next to the empty lines, from another
// app and from an agent, and in the Markdown view.

/** The view showing (the page, or the Markdown view's text) has these words. */
const showing = (page: Page, words: string) =>
  expect
    .poll(() =>
      page.evaluate(
        ([source, editor, w]) => {
          const area = document.querySelector<HTMLTextAreaElement>(source);
          return (area?.checkVisibility() ? area.value : document.querySelector<HTMLElement>(editor)!.innerText).includes(w);
        },
        [SOURCE, EDITOR, words] as const,
      ),
    )
    .toBe(true);

/** Another app saves the file with one change, and the window shows it. */
async function appChanges(page: Page, file: string, from: string, to: string, shows = to): Promise<void> {
  const before = readFileSync(file, "utf8");
  expect(before).toContain(from);
  writeFileSync(file, before.replace(from, to));
  await showing(page, shows);
}

/** An agent makes one change through Corillo and gives the document back. */
async function agentChanges(page: Page, claude: AgentSession, file: string, from: string, to: string, shows = to): Promise<void> {
  await claude.ok("take_document", { path: file });
  await claude.ok("edit_document", { path: file, edits: [{ find: from, replace: to }] });
  await showing(page, shows);
  await claude.ok("finish_editing", { path: file });
  await expect(notice(page)).toBeHidden();
}

const LETTER = "# Letter\n\nHi Ana,\n\n\n\nThanks for the notes.\n\nMore here.\n";

test("a cursor on the first of two empty lines stays on it when the paragraph just above is rewritten, and through changes above and below", async () => {
  const { page, file } = await start(LETTER);
  const claude = await agent();
  await expect.poll(() => blocks(page)).toEqual(["Letter", "Hi Ana,", "", "", "Thanks for the notes.", "More here."]);
  await page.locator(`${EDITOR} p.empty-line`).nth(0).click();
  await settle(page);
  await appChanges(page, file, "Hi Ana,", "Hello Ana and the whole team,");
  await agentChanges(page, claude, file, "# Letter", "# Letter\n\nA new first line.", "A new first line.");
  await appChanges(page, file, "More here.", "More here, and more.");
  await agentChanges(page, claude, file, "Hello Ana and the whole team,", "Dear Ana,");
  await page.keyboard.type("X");
  await expect.poll(() => blocks(page)).toEqual(["Letter", "A new first line.", "Dear Ana,", "X", "", "Thanks for the notes.", "More here, and more."]);
});

test("a cursor on the second of two empty lines stays on it when the paragraphs just above and just below are rewritten, and through a change above", async () => {
  const { page, file } = await start(LETTER);
  const claude = await agent();
  await expect.poll(() => blocks(page)).toEqual(["Letter", "Hi Ana,", "", "", "Thanks for the notes.", "More here."]);
  await page.locator(`${EDITOR} p.empty-line`).nth(1).click();
  await settle(page);
  await agentChanges(page, claude, file, "Hi Ana,", "Dear Ana and team,");
  await appChanges(page, file, "Thanks for the notes.", "Thanks again for all the notes.");
  await appChanges(page, file, "# Letter", "# Letter\n\nA new first line.", "A new first line.");
  await agentChanges(page, claude, file, "Thanks again for all the notes.", "Many thanks.");
  await page.keyboard.type("X");
  await expect.poll(() => blocks(page)).toEqual(["Letter", "A new first line.", "Dear Ana and team,", "", "X", "Many thanks.", "More here."]);
});

test("a cursor on an empty line at the very top of the document stays on it when the paragraph below is rewritten and when a title is put above it", async () => {
  const top = "\n\nHi Ana,\n\nThanks for the notes.\n";
  const { page, file } = await start(top);
  const claude = await agent();
  await expect.poll(() => blocks(page)).toEqual(["", "", "Hi Ana,", "Thanks for the notes."]);
  await page.locator(`${EDITOR} p.empty-line`).nth(1).click();
  await settle(page);
  await agentChanges(page, claude, file, "Hi Ana,", "Dear Ana,");
  await appChanges(page, file, "Thanks for the notes.", "Thank you for the notes.");
  // Another app puts a title above the empty lines: they're no longer at the top, and the cursor stays on its own.
  await appChanges(page, file, "\n\nDear Ana,", "# Letter\n\n\n\nDear Ana,", "Letter");
  await expect.poll(() => blocks(page)).toEqual(["Letter", "", "", "Dear Ana,", "Thank you for the notes."]);
  await page.keyboard.type("X");
  await expect.poll(() => blocks(page)).toEqual(["Letter", "", "X", "Dear Ana,", "Thank you for the notes."]);
});

test("a cursor on an empty line just above the last paragraph stays on it when that paragraph is rewritten and when one is added above", async () => {
  const end = "Intro.\n\nSome words.\n\n\nThe last line.\n";
  const { page, file } = await start(end);
  const claude = await agent();
  await expect.poll(() => blocks(page)).toEqual(["Intro.", "Some words.", "", "The last line."]);
  await page.locator(`${EDITOR} p.empty-line`).click();
  await settle(page);
  await agentChanges(page, claude, file, "The last line.", "The very last line, rewritten.");
  await appChanges(page, file, "Intro.", "Intro.\n\nA new paragraph above.", "A new paragraph above.");
  await agentChanges(page, claude, file, "Some words.", "Some other words.");
  await page.keyboard.type("X");
  await expect.poll(() => blocks(page)).toEqual(["Intro.", "A new paragraph above.", "Some other words.", "X", "The very last line, rewritten."]);
});

test("in the Markdown view, a cursor on a blank line stays on it when the paragraphs either side are rewritten and through changes above and below", async () => {
  const { page, file } = await start(LETTER);
  const claude = await agent();
  await page.getByRole("button", { name: "Markdown" }).click();
  const area = page.locator(SOURCE);
  // The middle one of the three blank lines between "Hi Ana," and "Thanks for the notes.".
  await area.evaluate((a) => {
    const at = (a as HTMLTextAreaElement).value.indexOf("Hi Ana,\n\n") + "Hi Ana,\n\n".length;
    (a as HTMLTextAreaElement).focus();
    (a as HTMLTextAreaElement).setSelectionRange(at, at);
  });
  await agentChanges(page, claude, file, "Hi Ana,", "Dear Ana and team,");
  await appChanges(page, file, "Thanks for the notes.", "Thanks again for all the notes.");
  await agentChanges(page, claude, file, "# Letter", "# Letter\n\nA new first line.", "A new first line.");
  await appChanges(page, file, "More here.", "More here, and more.");
  await agentChanges(page, claude, file, "Thanks again for all the notes.", "Many thanks.");
  await expect(area).toBeFocused();
  await page.keyboard.type("X");
  await expect.poll(() => readFileSync(file, "utf8")).toBe("# Letter\n\nA new first line.\n\nDear Ana and team,\n\nX\n\nMany thanks.\n\nMore here, and more.\n");
});

// The reader's place, when text is added or taken out above it (editor-shell.md, bigger opportunities 1) --

test("an agent adding paragraphs above what the person is reading leaves what they're reading where it was", async () => {
  const { page, file } = await start();
  const claude = await agent();
  // (Its editing line is up first: what it does to the page has a test of its own, in whose-turn.spec.ts.)
  await claude.ok("take_document", { path: file });
  const before = await readAt(page, 30);
  await claude.ok("edit_document", { path: file, edits: [{ find: para(2), replace: `${para(2)}\n\n${ABOVE}` }] });
  await expect(page.locator(EDITOR)).toContainText("A new third point.");
  expect(Math.abs((await topInPage(page, 30)) - before)).toBeLessThan(2);
  // Taking text out above does the same.
  await claude.ok("edit_document", { path: file, edits: [{ find: `${para(5)}\n\n${para(6)}\n\n`, replace: "" }] });
  await expect(paragraph(page, 6)).toHaveCount(0);
  expect(Math.abs((await topInPage(page, 30)) - before)).toBeLessThan(2);
  // And rewriting the paragraph partly in sight at the top keeps the next one where it was.
  const partly = await page.evaluate(
    ([canvas, editor]) => {
      const scroller = document.querySelector(canvas)!.getBoundingClientRect();
      const p = [...document.querySelectorAll(`${editor} p`)].find((e) => e.textContent!.startsWith("Point 29:"))!.getBoundingClientRect();
      return p.top < scroller.top && p.bottom > scroller.top;
    },
    [CANVAS, EDITOR] as const,
  );
  expect(partly).toBe(true);
  await claude.ok("edit_document", { path: file, edits: [{ find: para(29), replace: `${ABOVE}\n\nShort now.` }] });
  await expect(page.locator(EDITOR)).toContainText("Short now.");
  expect(Math.abs((await topInPage(page, 30)) - before)).toBeLessThan(2);
});

test("another app adding paragraphs above what the person is reading leaves what they're reading where it was", async () => {
  const { page, file } = await start();
  const before = await readAt(page, 30);
  writeFileSync(file, LONG.replace(para(2), `${para(2)}\n\n${ABOVE}`));
  await expect(page.locator(EDITOR)).toContainText("A new third point.");
  expect(Math.abs((await topInPage(page, 30)) - before)).toBeLessThan(2);
});

test("in the Markdown view, an agent adding paragraphs above what the person is reading keeps the text's place, and the preview stays beside it", async () => {
  const { page, file } = await start();
  const claude = await agent();
  await page.getByRole("button", { name: "Markdown" }).click();
  // (Its editing line is up first: what it does to the page has a test of its own, in whose-turn.spec.ts.)
  await claude.ok("take_document", { path: file });
  const area = page.locator(SOURCE);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  // The person scrolls the text to a line well down, and the preview follows it (2026-11-10: the halves move together).
  await area.evaluate((a) => (a.scrollTop = 1200));
  await frames();
  const scroll = await scrollOf(page, SOURCE);
  expect(await scrollOf(page, PREVIEW_PANE)).toBeGreaterThan(0);
  // The first paragraph whose top is in sight in the preview, and how far down it is.
  const reading = () =>
    page.evaluate((pane) => {
      const scroller = document.querySelector(pane)!;
      const top = scroller.getBoundingClientRect().top;
      const p = [...scroller.querySelectorAll("p")].find((e) => e.getBoundingClientRect().top >= top)!;
      return { words: p.textContent!.slice(0, 12), top: p.getBoundingClientRect().top - top };
    }, PREVIEW_PANE);
  const before = await reading();
  expect(before.words).toMatch(/^Point \d+:/);
  const line = await area.evaluate((a) => parseFloat(getComputedStyle(a).lineHeight));
  await claude.ok("edit_document", { path: file, edits: [{ find: para(2), replace: `${para(2)}\n\n${ABOVE}` }] });
  await expect(area).toHaveValue(/A new third point/);
  await frames();
  // Six lines more above: three short paragraphs and the empty lines after them.
  expect(Math.abs((await scrollOf(page, SOURCE)) - (scroll + 6 * line))).toBeLessThan(2);
  // The preview follows the text: the paragraph that was in sight there is where it was, give or take a
  // few pixels (the banner the agent's turn shows makes both halves a little shorter, and the preview
  // lines up with the text's middle again).
  await expect(page.locator(".page.preview p", { hasText: "A new third point." })).toBeAttached();
  const after = await page.evaluate(([pane, words]) => {
    const scroller = document.querySelector(pane)!;
    const p = [...scroller.querySelectorAll("p")].find((e) => e.textContent!.startsWith(words))!;
    return p.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, [PREVIEW_PANE, before.words] as const);
  expect(Math.abs(after - before.top)).toBeLessThan(12);
});

// The selection in the Markdown view (SH-8) ---------------------------------------------------

test("in the Markdown view, an agent's change above keeps the selection on the same words", async () => {
  const { page, file } = await start();
  const claude = await agent();
  await page.getByRole("button", { name: "Markdown" }).click();
  const area = page.locator(SOURCE);
  const words = para(40).slice(10, 40);
  await area.evaluate((a, w) => {
    const at = (a as HTMLTextAreaElement).value.indexOf(w);
    (a as HTMLTextAreaElement).setSelectionRange(at, at + w.length);
  }, words);
  await claude.ok("take_document", { path: file });
  await claude.ok("edit_document", { path: file, edits: [{ find: para(2), replace: `${para(2)}\n\n${ABOVE}` }] });
  await expect(area).toHaveValue(/A new third point/);
  const selected = () => area.evaluate((a) => (a as HTMLTextAreaElement).value.slice((a as HTMLTextAreaElement).selectionStart, (a as HTMLTextAreaElement).selectionEnd));
  expect(await selected()).toBe(words);
  // Another app's change too, once the agent is done.
  await claude.ok("finish_editing", { path: file });
  await expect(notice(page)).toBeHidden();
  writeFileSync(file, readFileSync(file, "utf8").replace(para(1), `${para(1)}\n\nOne more from another app.`));
  await expect(area).toHaveValue(/One more from another app/);
  expect(await selected()).toBe(words);
});

// The card in focus (CM-2) ----------------------------------------------------------------------

const LONG_MESSAGE = Array.from({ length: 8 }, (_, i) => `Line ${i + 1} of a long note about the plan that needs reading in full.`).join("\n");

async function addComments(page: Page): Promise<void> {
  const id = await page.locator(".doc:not([hidden])").getAttribute("data-doc-id");
  await page.evaluate(
    async ({ id, body }) => {
      const r = await window.corillo.addComment(id!, body, null, null);
      if (!r.ok) throw new Error(r.error);
    },
    { id, body: `About everything. ${LONG_MESSAGE}` },
  );
  // Two comments on words, with long messages, far from where the cursor is.
  for (const [n, body] of [
    [3, `On three. ${LONG_MESSAGE}`],
    [4, `On four. ${LONG_MESSAGE}`],
  ] as const) {
    await page.evaluate(
      ([editor, wanted]) => {
        const root = document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!;
        root.focus();
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.textContent!.indexOf(wanted);
          if (at < 0) continue;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + wanted.length);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(range);
          return;
        }
      },
      [EDITOR, para(n).slice(10, 32)] as const,
    );
    await settle(page);
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.getByRole("textbox", { name: "New comment" }).fill(body);
    await page.getByRole("button", { name: "Post" }).click();
    await expect(page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: body.slice(0, 12) })).toBeVisible();
  }
}

const cardTop = (page: Page, text: string) =>
  page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: text }).evaluate((c) => c.getBoundingClientRect().top);
const cardHeight = (page: Page, text: string) =>
  page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: text }).evaluate((c) => c.getBoundingClientRect().height);

for (const view of ["Formatted", "Markdown"] as const) {
  test(`in the ${view} view, an agent's edit leaves the card in focus in focus, its words in full and the cards below where they were`, async () => {
    const { page, file } = await start();
    await addComments(page);
    if (view === "Formatted") await cursorIn(page, 45); // the cursor far from every comment
    else await page.getByRole("button", { name: "Markdown" }).click();
    const claude = await agent();
    await claude.ok("take_document", { path: file });
    const shown = async (n: number) => {
      if (view === "Formatted") await expect(page.locator(EDITOR)).toContainText(`Edit ${n}.`);
      else await expect(page.locator(SOURCE)).toHaveValue(new RegExp(`Edit ${n}\\.`));
      await settle(page);
    };
    // A first change, for the ones below to build on. (Until roadmap Batch 9, item 5, it also gave the
    // changes no comment asked for a card, a third kind to click below; the panel holds comments only now.)
    await claude.ok("edit_document", { path: file, edits: [{ find: para(50), replace: `${para(50)} Edit 0.` }] });
    await shown(0);
    let edits = 0;
    for (const [clicked, below] of [
      ["About everything.", "On three."], // a whole-document comment
      ["On three.", "On four."], // a comment on words far from the cursor
    ] as const) {
      const card = page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: clicked }).first();
      await card.locator(".comment-body").first().click();
      await expect(card).toHaveClass(/active/);
      await settle(page);
      const height = await cardHeight(page, clicked);
      const top = await cardTop(page, below);
      edits++;
      await claude.ok("edit_document", { path: file, edits: [{ find: `Edit ${edits - 1}.`, replace: `Edit ${edits}.` }] });
      await shown(edits);
      await expect(card).toHaveClass(/active/);
      expect(Math.abs((await cardHeight(page, clicked)) - height)).toBeLessThan(1);
      expect(Math.abs((await cardTop(page, below)) - top)).toBeLessThan(1);
    }
  });
}

test("another app's change leaves the card in focus in focus", async () => {
  const { page, file } = await start();
  await addComments(page);
  const card = page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: "On four." });
  await card.locator(".comment-body").first().click();
  await expect(card).toHaveClass(/active/);
  await cursorIn(page, 45); // the cursor elsewhere; the card stays in focus only by being chosen
  await card.locator(".comment-body").first().click();
  await expect(card).toHaveClass(/active/);
  writeFileSync(file, readFileSync(file, "utf8").replace(para(50), `${para(50)} Changed elsewhere.`));
  await expect(page.locator(EDITOR)).toContainText("Changed elsewhere.");
  await settle(page);
  await expect(card).toHaveClass(/active/);
});

test("switching between the Formatted and Markdown views leaves the card in focus in focus", async () => {
  const { page } = await start();
  await addComments(page);
  await cursorIn(page, 45);
  for (const clicked of ["About everything.", "On four."]) {
    const card = page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: clicked }).first();
    await card.locator(".comment-body").first().click();
    await expect(card).toHaveClass(/active/);
    await page.getByRole("button", { name: "Markdown" }).click();
    await settle(page);
    await expect(card).toHaveClass(/active/);
    await page.getByRole("button", { name: "Formatted" }).click();
    await settle(page);
    await expect(card).toHaveClass(/active/);
  }
});

// Typing just before an agent takes the document (SH-7) -----------------------------------------

const PLAN = "# Plan\n\nWe should hire two people this quarter.\n\n## Budget\n\nThe budget is tight.\n";

test("typing in the Markdown view just before an agent takes the document reaches the preview and the comment on those words, though the agent only replies", async () => {
  const { page, file } = await start(PLAN);
  await page.evaluate((editor) => {
    const root = document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!;
    root.focus();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf("budget is tight");
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + "budget is tight".length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    }
  }, EDITOR);
  await settle(page);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill("By how much?");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: "By how much?" })).toBeVisible();
  await page.getByRole("button", { name: "Markdown" }).click();
  const claude = await agent();
  await page.locator(SOURCE).evaluate((a: HTMLTextAreaElement) => {
    const at = a.value.indexOf("budget is") + "budget".length;
    a.focus();
    a.setSelectionRange(at, at);
  });
  // The preview catches up after a pause in typing (200 ms): held here, so the take comes first however slow it is.
  const { watchTimers } = await import("./helpers");
  const preview = await watchTimers(page, 200, true);
  await page.keyboard.type(" really");
  // Before the preview catches up. The agent reads the comment on the words as they are now.
  const taken = await claude.ok("take_document", { path: file });
  expect(taken).toContain("The budget really is tight.");
  expect(taken).toContain('on "budget really is tight"');
  await preview.release();
  const id = /\[([0-9a-f]{8,})\]/.exec(taken)![1];
  await claude.ok("reply_to_comment", { path: file, comment_id: id, text: "About ten percent." });
  await claude.ok("finish_editing", { path: file });
  await expect(notice(page)).toBeHidden();
  await expect(page.locator(".page.preview p", { hasText: "budget really is tight" })).toBeVisible();
  expect(await page.locator(".doc:not([hidden]) .source-marks mark").allTextContents()).toEqual(["budget really is tight"]);
});

// An agent reading while the person types (SH-6) ------------------------------------------------

test("an agent reading while the person types during a save is never told Corillo can't save the document", async () => {
  const { page, file, app } = await start(PLAN);
  const claude = await agent();
  // Saves are held here until let go, so a key lands while one is under way, however busy the Mac.
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { savesHeld: (() => void)[]; holdSaves: boolean };
    g.savesHeld = [];
    g.holdSaves = true;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
    const save = handlers.get("doc:save");
    if (!save) throw new Error("no save handler to slow down");
    ipcMain.removeHandler("doc:save");
    ipcMain.handle("doc:save", async (...args: unknown[]) => {
      if (g.holdSaves) await new Promise<void>((resolve) => g.savesHeld.push(resolve));
      return save(...args);
    });
  });
  const held = () => app.evaluate(() => (globalThis as unknown as { savesHeld: unknown[] }).savesHeld.length);
  // And the window's own save after a pause in typing (400 ms) waits too, so the save under way is the reading's.
  const { watchTimers } = await import("./helpers");
  const autosave = await watchTimers(page, 400, true);
  await page.locator(`${EDITOR} p`, { hasText: "The budget is tight." }).click();
  await page.keyboard.press("Meta+ArrowRight");
  await settle(page);
  await page.keyboard.type(" A");
  const reading = claude.call("read_document", { path: file }); // saves the typing first
  await expect.poll(held).toBe(1);
  await page.keyboard.type("B"); // while that save is under way
  await app.evaluate(() => {
    const g = globalThis as unknown as { savesHeld: (() => void)[]; holdSaves: boolean };
    g.holdSaves = false;
    for (const go of g.savesHeld.splice(0)) go();
  });
  const read = await reading;
  expect(read.isError).toBe(false);
  expect(read.text).toContain("The budget is tight. A");
  expect(read.text).not.toContain("can't save");
  await autosave.release();
  await expect.poll(() => readFileSync(file, "utf8")).toContain("The budget is tight. AB");
});

// Pictures after Rename or Move, or a move outside Corillo (SH-10, SH-11) -----------------------

const PICTURED = "Results.\n\n![chart](proposal%20images/chart.png)\n";

async function startWithPicture(): Promise<Running> {
  run = await openText(PICTURED, {
    name: "proposal.md",
    prepare: (folder) => {
      mkdirSync(join(folder, "proposal images"));
      copyFileSync(join(FIXTURES, "chart.png"), join(folder, "proposal images", "chart.png"));
    },
  });
  return run;
}

test("Rename or Move's fix to the pictures' addresses isn't a step for Undo: Undo takes back the last typing, and the pictures stay found", async () => {
  const { page, app, folder } = await startWithPicture();
  await expect(page.locator(`${EDITOR} .picture img`)).toBeVisible();
  await page.locator(`${EDITOR} p`, { hasText: "Results." }).click();
  await page.keyboard.press("Meta+ArrowRight");
  await page.keyboard.type(" More.");
  await expect.poll(() => readFileSync(run!.file, "utf8")).toBe(PICTURED.replace("Results.", "Results. More."));
  const target = join(folder, "plan.md");
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
  }, target);
  await clickMenu(app, "rename");
  await expect.poll(async () => (await tabState(page)).names).toEqual(["plan.md"]);
  await expect.poll(() => readFileSync(target, "utf8")).toBe("Results. More.\n\n![chart](plan%20images/chart.png)\n");
  await page.locator(`${EDITOR} p`, { hasText: "Results." }).click();
  await page.keyboard.press("Meta+z");
  await expect.poll(() => readFileSync(target, "utf8")).toBe("Results.\n\n![chart](plan%20images/chart.png)\n");
  await page.waitForTimeout(700);
  expect(readFileSync(target, "utf8")).toBe("Results.\n\n![chart](plan%20images/chart.png)\n");
  await expect(page.locator(`${EDITOR} .picture img`)).toBeVisible();
  await expect(page.locator(`${EDITOR} .picture.missing`)).toHaveCount(0);
});

test("Rename or Move from the Markdown view keeps Undo too: back in the Formatted view, Undo takes back the last typing (S21-3)", async () => {
  const { page, app, folder } = await startWithPicture();
  await expect(page.locator(`${EDITOR} .picture img`)).toBeVisible();
  await page.locator(`${EDITOR} p`, { hasText: "Results." }).click();
  await page.keyboard.press("Meta+ArrowRight");
  await page.keyboard.type(" More.");
  await expect.poll(() => readFileSync(run!.file, "utf8")).toBe(PICTURED.replace("Results.", "Results. More."));
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.locator(SOURCE)).toBeVisible();
  const target = join(folder, "plan.md");
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
  }, target);
  await clickMenu(app, "rename");
  await expect.poll(async () => (await tabState(page)).names).toEqual(["plan.md"]);
  const moved = "Results. More.\n\n![chart](plan%20images/chart.png)\n";
  await expect.poll(() => readFileSync(target, "utf8")).toBe(moved);
  // The Markdown text follows the move.
  await expect(page.locator(SOURCE)).toHaveValue(moved);
  await page.getByRole("button", { name: "Formatted", exact: true }).click();
  await expect(page.locator(`${EDITOR} p`, { hasText: "Results. More." })).toBeVisible();
  await page.locator(`${EDITOR} p`, { hasText: "Results." }).click();
  await settle(page);
  await page.keyboard.press("Meta+z");
  await expect.poll(() => readFileSync(target, "utf8"), { timeout: 4000 }).toBe("Results.\n\n![chart](plan%20images/chart.png)\n");
  await expect(page.locator(`${EDITOR} .picture img`)).toBeVisible();
});

test("a document moved to another folder outside Corillo, without its pictures folder: its pictures are looked for in the new place, and the missing-picture notice shows", async () => {
  const { page, app, folder, file } = await startWithPicture();
  await expect(page.locator(`${EDITOR} .picture img`)).toBeVisible();
  mkdirSync(join(folder, "Archive"));
  const moved = join(folder, "Archive", "proposal.md");
  renameSync(file, moved);
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getRepresentedFilename())).toBe(moved);
  await expect(page.locator(`${EDITOR} .picture.missing`)).toContainText("Picture not found: proposal images/chart.png");
  // Moved back beside its pictures, they show again.
  renameSync(moved, file);
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getRepresentedFilename())).toBe(file);
  await expect(page.locator(`${EDITOR} .picture img`)).toBeVisible();
  await expect(page.locator(`${EDITOR} .picture.missing`)).toHaveCount(0);
  expect(readFileSync(file, "utf8")).toBe(PICTURED); // the text is as the file has it
});

test("a document moved to another folder outside Corillo: its Obsidian embeds (![[chart.png]]) are looked for from the new place too, like its other pictures", async () => {
  const { makePng } = await import("../fixtures/make-png");
  run = await openText("Results.\n\n![[chart.png]]\n", {
    name: "proposal.md",
    prepare: (folder) => {
      writeFileSync(join(folder, "chart.png"), makePng(40, 30));
      mkdirSync(join(folder, "Archive"));
      writeFileSync(join(folder, "Archive", "chart.png"), makePng(64, 20));
      mkdirSync(join(folder, "Empty"));
    },
  });
  const { page, app, folder, file } = run;
  const widths = () =>
    page.locator(`${EDITOR} img.ob-embed-picture`).evaluateAll((imgs: HTMLImageElement[]) => imgs.map((i) => (i.complete ? i.naturalWidth : 0)));
  const followed = (to: string) =>
    expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getRepresentedFilename())).toBe(to);
  await expect.poll(widths).toEqual([40]);
  // Moved where another chart.png sits beside it: that one shows.
  const archived = join(folder, "Archive", "proposal.md");
  renameSync(file, archived);
  await followed(archived);
  await expect.poll(widths).toEqual([64]);
  // Moved where there's none: it says it can't find it, as a missing picture does.
  const empty = join(folder, "Empty", "proposal.md");
  renameSync(archived, empty);
  await followed(empty);
  await expect(page.locator(`${EDITOR} .ob-missing`).first()).toBeVisible();
  await expect.poll(widths).toEqual([]);
  // Back beside its own, in the Markdown view's preview too.
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const preview = page.locator(".doc:not([hidden]) .page.preview");
  await expect(preview.locator(".ob-missing:not(.ob-syntax)")).toBeVisible();
  renameSync(empty, file);
  await followed(file);
  await expect.poll(() => preview.locator("img.ob-embed-picture").evaluateAll((imgs: HTMLImageElement[]) => imgs.map((i) => (i.complete ? i.naturalWidth : 0)))).toEqual([40]);
  expect(readFileSync(file, "utf8")).toBe("Results.\n\n![[chart.png]]\n");
});

test("Rename or Move takes a document's pictures folder along, and its Obsidian embeds from there still show", async () => {
  const { makePng } = await import("../fixtures/make-png");
  run = await openText("Results.\n\n![[chart.png]]\n", {
    name: "proposal.md",
    prepare: (folder) => {
      mkdirSync(join(folder, "proposal images"));
      writeFileSync(join(folder, "proposal images", "chart.png"), makePng(40, 30));
    },
  });
  const { page, app, folder } = run;
  const widths = () =>
    page.locator(`${EDITOR} img.ob-embed-picture`).evaluateAll((imgs: HTMLImageElement[]) => imgs.map((i) => (i.complete ? i.naturalWidth : 0)));
  await expect.poll(widths).toEqual([40]);
  const target = join(folder, "plan.md");
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
  }, target);
  await clickMenu(app, "rename");
  await expect.poll(async () => (await tabState(page)).names).toEqual(["plan.md"]);
  expect(existsSync(join(folder, "plan images", "chart.png"))).toBe(true);
  await expect.poll(widths).toEqual([40]);
  expect(await page.locator(`${EDITOR} img.ob-embed-picture`).getAttribute("src")).toContain("plan%20images/chart.png");
});

// Links to other documents and to headings (MP-11) ----------------------------------------------

const LINKS = [
  "# Plan",
  "See [the budget](budget.md), [the appendix](notes/appendix%20one.md#risks), [the script](run.sh), [a missing one](missing.md) and [nowhere](#nowhere).",
  "Jump to [Risks](#risks).",
  ...PARAS.slice(0, 30),
  "## Risks",
  "Things that could go wrong.",
  "",
].join("\n\n");

async function startWithLinks(text = LINKS): Promise<Running> {
  run = await openText(text, {
    name: "plan.md",
    prepare: (folder) => {
      writeFileSync(join(folder, "budget.md"), "# Budget\n\nTight.\n");
      mkdirSync(join(folder, "notes"));
      writeFileSync(join(folder, "notes", "appendix one.md"), "# Appendix\n\n## Risks\n\nMany.\n");
      // Run, it would leave a mark beside it: it never may be.
      writeFileSync(join(folder, "run.sh"), `#!/bin/sh\ntouch "${join(folder, "it-ran")}"\n`, { mode: 0o755 });
    },
  });
  // Finder, the browser and message boxes, as far as Corillo goes: noted, never opened.
  await run.app.evaluate(({ dialog, shell }) => {
    const g = globalThis as unknown as { told: string[]; shown: string[]; opened: string[] };
    g.told = [];
    g.shown = [];
    g.opened = [];
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args[args.length - 1] as { message: string };
      g.told.push(options.message);
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    shell.showItemInFolder = (p: string) => void g.shown.push(p);
    shell.openPath = async (p: string) => {
      g.opened.push(p);
      return "";
    };
    shell.openExternal = async (url: string) => void g.opened.push(url);
  });
  return run;
}

const noted = (key: "told" | "shown" | "opened") =>
  run!.app.evaluate((_e, k) => (globalThis as unknown as Record<string, string[]>)[k], key);

test("Command-click on a link to another document opens it in a tab; to a heading here, goes to it; to another kind of file, shows it in Finder and never runs it; one that can't be found says so", async () => {
  const { page, folder } = await startWithLinks();
  const link = (words: string) => page.locator(`${EDITOR} a`, { hasText: words }).first();

  await link("the budget").click({ modifiers: ["Meta"] });
  await expect.poll(async () => (await tabState(page)).active).toBe("budget.md");
  await page.locator('.tab[title$="/plan.md"]').click();

  // A link to a heading in another document opens that document.
  await link("the appendix").click({ modifiers: ["Meta"] });
  await expect.poll(async () => (await tabState(page)).active).toBe("appendix one.md");
  await page.locator('.tab[title$="/plan.md"]').click();

  await link("the script").click({ modifiers: ["Meta"] });
  await expect.poll(() => noted("shown")).toEqual([join(folder, "run.sh")]);

  await link("a missing one").click({ modifiers: ["Meta"] });
  await expect.poll(() => noted("told")).toEqual(['Corillo can\'t find "missing.md".']);
  await link("nowhere").click({ modifiers: ["Meta"] });
  await expect.poll(() => noted("told")).toEqual(['Corillo can\'t find "missing.md".', 'Corillo can\'t find the heading "nowhere".']);

  // A table of contents' link: the heading comes into sight, with the cursor in it.
  const heading = page.locator(`${EDITOR} h2`, { hasText: "Risks" });
  await expect(heading).not.toBeInViewport();
  await link("Risks").click({ modifiers: ["Meta"] });
  await expect(heading).toBeInViewport();
  await page.keyboard.type("Top ");
  await expect.poll(() => readFileSync(run!.file, "utf8")).toContain("## Top Risks");

  // Nothing was opened, the script least of all: opening anything goes through shell.openPath, kept here
  // instead of done (so the script, which would write "it-ran", can't run either way).
  expect(await noted("opened")).toEqual([]);
  expect((await tabState(page)).names).toEqual(["plan.md", "budget.md", "appendix one.md"]);
});

test("in the Markdown view's preview, Command-click opens a link as on the page: the web, another document, a heading here", async () => {
  const { page, folder } = await startWithLinks(LINKS.replace("Jump to [Risks](#risks).", "Jump to [Risks](#risks). Or [the site](https://example.com/plan)."));
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const preview = page.locator(".doc:not([hidden]) .page.preview");
  await expect(preview).toBeVisible();
  const link = (words: string) => preview.locator("a", { hasText: words }).first();
  await expect(link("the site")).toBeVisible();

  // A plain click doesn't open anything.
  await link("the site").click();
  await page.waitForTimeout(200);
  expect(await noted("opened")).toEqual([]);
  await link("the site").click({ modifiers: ["Meta"] });
  await expect.poll(() => noted("opened")).toEqual(["https://example.com/plan"]);

  await link("the script").click({ modifiers: ["Meta"] });
  await expect.poll(() => noted("shown")).toEqual([join(folder, "run.sh")]);

  // A heading here comes into sight.
  const heading = preview.locator("h2", { hasText: "Risks" });
  await expect(heading).not.toBeInViewport();
  await link("Risks").click({ modifiers: ["Meta"] });
  await expect(heading).toBeInViewport();

  await link("the budget").click({ modifiers: ["Meta"] });
  await expect.poll(async () => (await tabState(page)).active).toBe("budget.md");
});

test("a document's name typed into the link editor (budget.md) links to that document, not a website: Command-click opens it in a tab", async () => {
  const { page } = await startWithLinks();
  await page.locator(`${EDITOR} p`, { hasText: "Things that could go wrong." }).click();
  await settle(page);
  await page.keyboard.press("Meta+ArrowRight");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Our numbers");
  await page.keyboard.press("Shift+Alt+ArrowLeft");
  await settle(page);
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".link-editor")).toBeVisible();
  await page.keyboard.type("budget.md");
  await page.keyboard.press("Enter");
  await expect.poll(() => readFileSync(run!.file, "utf8")).toContain("Our [numbers](budget.md)\n");
  await page.locator(`${EDITOR} a`, { hasText: "numbers" }).click({ modifiers: ["Meta"] });
  await expect.poll(async () => (await tabState(page)).active).toBe("budget.md");
  expect(await noted("opened")).toEqual([]);
});

test("Open Link in the right-click menu does what Command-click does for links to documents and headings", async () => {
  const { page, app } = await startWithLinks();
  // Right-click for real: the menu is kept instead of shown.
  const rightClickLink = async (words: string) => {
    await app.evaluate(({ Menu }) => {
      const g = globalThis as unknown as { shownMenu: Electron.Menu | null };
      g.shownMenu = null;
      Menu.prototype.popup = function (this: Electron.Menu) {
        g.shownMenu = this;
      };
    });
    await page.locator(`${EDITOR} a`, { hasText: words }).first().click({ button: "right" });
    await expect.poll(() => app.evaluate(() => !!(globalThis as unknown as { shownMenu: unknown }).shownMenu)).toBe(true);
    return app.evaluate(() => {
      const menu = (globalThis as unknown as { shownMenu: Electron.Menu }).shownMenu;
      return menu.items.find((i) => i.label === "Open Link")?.enabled;
    });
  };
  expect(await rightClickLink("the budget")).toBe(true);
  await chooseInContextMenu(app, "Open Link");
  await expect.poll(async () => (await tabState(page)).active).toBe("budget.md");
  await page.locator('.tab[title$="/plan.md"]').click();

  const heading = page.locator(`${EDITOR} h2`, { hasText: "Risks" });
  await expect(heading).not.toBeInViewport();
  expect(await rightClickLink("Risks")).toBe(true);
  await chooseInContextMenu(app, "Open Link");
  await expect(heading).toBeInViewport();
  expect(await noted("opened")).toEqual([]);
});
