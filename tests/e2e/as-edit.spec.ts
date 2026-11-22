// An agent's change, or another app's, arrives on the open document as an
// edit (roadmap Batch 7, item 1): only what changed is drawn again, in the
// Formatted and the Markdown view, and the person's cursor, selection, what
// they're reading and where the keyboard rests (the page, a card, the find
// bar) go through it. Where the same words are written twice, the place is
// carried, not searched for, so it never lands on the other copy. Each test
// runs the real app, hidden, on throwaway documents and a throwaway data
// folder, with a pretend agent tool speaking MCP to it.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { clickMenu, openText, settle, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const CANVAS = ".doc:not([hidden]) .canvas";
const SOURCE = ".doc:not([hidden]) textarea.source";
const PREVIEW = ".doc:not([hidden]) .page.preview .ProseMirror";
const PANEL = ".doc:not([hidden]) aside.comments-panel";

const WORDS = (
  "budget hiring plan quarter team review draft customer launch market risk goal office travel season " +
  "volunteer event inbox report schedule partner contract design survey pricing training window supplier"
).split(" ");
/** A paragraph long enough to wrap, with words of its own. */
function para(i: number): string {
  let seed = i * 7919 + 17;
  const words = [`Point ${i}:`];
  for (let k = 0; k < 24; k++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    words.push(WORDS[Math.floor(seed / 65536) % WORDS.length]);
  }
  return `${words.join(" ")}.`;
}
/** Three paragraphs written twice in the document, word for word: searching for a place in them can't tell the copies apart. */
const SAME = [
  "The team agreed that the shared budget stays where it is for the whole of the coming year, unless the board asks otherwise in writing.",
  "Every request for more goes through the same review, with the same people, in the same order as before, and nobody skips that review.",
  "This paragraph says it all once more, so the words are the same in both places for well over a hundred letters, end to end.",
];
const BLOCKS = ["# Repeats", ...Array.from({ length: 15 }, (_, i) => para(i + 1)), ...SAME, ...Array.from({ length: 15 }, (_, i) => para(i + 16)), ...SAME, ...Array.from({ length: 15 }, (_, i) => para(i + 31))];
const DOC = BLOCKS.join("\n\n") + "\n";
/** Where the second copy of SAME[1] is among the page's blocks. */
const SECOND = 1 + 15 + 3 + 15 + 1;
/** Twenty paragraphs an agent puts in under the title: over three thousand letters, so the first copy is then nearer where the second was. */
const ADDED = Array.from({ length: 20 }, (_, i) => `Added ${i + 1}: a new paragraph put in at the top by the agent, long enough to move everything below it well down the page.`);
const withAdded = (text: string) => text.replace("# Repeats\n\n", `# Repeats\n\n${ADDED.join("\n\n")}\n\n`);

const sessions: AgentSession[] = [];
let run: Running | null = null;

async function start(text = DOC): Promise<Running> {
  run = await openText(text, { name: "repeats.md" });
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
  await r?.app.evaluate(({ app }) => setTimeout(() => app.exit(0), 10)).catch(() => undefined);
  await r?.app.close().catch(() => undefined);
  await Promise.all(sessions.splice(0).map((s) => s.stop()));
  for (const dir of [r?.folder, r?.dataDir, home]) if (dir) rmSync(dir, { recursive: true, force: true });
});

/** An agent makes these edits, as one pass: take, edit, finish. */
async function agentEdits(file: string, edits: { find: string; replace: string }[]): Promise<void> {
  const claude = await agent();
  await claude.ok("take_document", { path: file });
  await claude.ok("edit_document", { path: file, edits });
  // (A comment left for its next pass: finishing a second time leaves it.)
  if ((await claude.call("finish_editing", { path: file })).isError) await claude.ok("finish_editing", { path: file });
}

/** The change, made by an agent or by another app saving the file. */
async function change(by: "agent" | "app", file: string, edits: { find: string; replace: string }[]): Promise<void> {
  if (by === "agent") return agentEdits(file, edits);
  let text = readFileSync(file, "utf8");
  for (const e of edits) text = text.replace(e.find, e.replace);
  writeFileSync(file, text);
}

/** Put the cursor (or a selection) in the page's nth block, at these offsets into its words, as a click or a drag there would. */
async function placeIn(page: Page, n: number, from: number, to = from): Promise<void> {
  await page.evaluate(
    ([editor, n, from, to]) => {
      const root = document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!;
      // The text node an offset into the block's words falls in (a comment's highlight splits them).
      const at = (offset: number): [globalThis.Node, number] => {
        const walker = document.createTreeWalker(root.children[n], NodeFilter.SHOW_TEXT);
        let last: globalThis.Node | null = null;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const length = node.textContent!.length;
          if (offset < length) return [node, offset];
          offset -= length;
          last = node;
        }
        return [last!, last!.textContent!.length + offset];
      };
      root.focus();
      const range = document.createRange();
      range.setStart(...at(from));
      range.setEnd(...at(to));
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    },
    [EDITOR, n, from, to] as const,
  );
  await settle(page);
}

/** Which paragraph of the file the typed letter went into, counted from the top (blocks are a blank line apart). */
async function paragraphTyped(file: string, letter: string): Promise<number> {
  await expect.poll(() => readFileSync(file, "utf8")).toContain(letter);
  return readFileSync(file, "utf8").split("\n\n").findIndex((p) => p.includes(letter));
}

/** The blocks of a page: its children, less the line numbers drawn between them. */
const BLOCK = ":scope > :not(.ln-blank)";

/** Marks every block of the page (and of the preview) unseen, then records which blocks are touched from now on. */
async function watchBlocks(page: Page, root: string): Promise<void> {
  await page.evaluate(
    ([root, block]) => {
      const el = document.querySelector<HTMLElement>(root)!;
      const w = window as unknown as { watched: { blocks: Element[]; touched: Set<globalThis.Node>; observer: MutationObserver; see: (records: MutationRecord[]) => void } };
      const blocks = [...el.querySelectorAll(block)];
      const touched = new Set<globalThis.Node>();
      const see = (records: MutationRecord[]) => {
        for (const r of records) {
          let node: globalThis.Node | null = r.target;
          if (node === el) {
            // A block put in or taken out (or a line number between blocks).
            for (const added of r.addedNodes) touched.add(added);
            for (const removed of r.removedNodes) touched.add(removed);
            continue;
          }
          while (node && node.parentNode !== el) node = node.parentNode;
          if (node) touched.add(node);
        }
      };
      const observer = new MutationObserver(see);
      observer.observe(el, { childList: true, subtree: true, characterData: true, attributes: true });
      w.watched = { blocks, touched, observer, see };
    },
    [root, BLOCK] as const,
  );
}

/** Stops watching: how many of the blocks are still on the page, of how many, and how many blocks were touched. */
async function blocksAfter(page: Page, root: string): Promise<{ kept: number; of: number; touched: number }> {
  return page.evaluate(
    ([root, block]) => {
      const el = document.querySelector<HTMLElement>(root)!;
      const w = window as unknown as { watched: { blocks: Element[]; touched: Set<globalThis.Node>; observer: MutationObserver; see: (records: MutationRecord[]) => void } };
      w.watched.see(w.watched.observer.takeRecords());
      w.watched.observer.disconnect();
      const now = new Set(el.querySelectorAll(block));
      const blocks = [...w.watched.touched].filter((n) => !(n instanceof Element && n.classList.contains("ln-blank")));
      return { kept: w.watched.blocks.filter((b) => now.has(b)).length, of: w.watched.blocks.length, touched: blocks.length };
    },
    [root, BLOCK] as const,
  );
}

// Nothing else is drawn again ------------------------------------------------------------------

/** Post a comment on words of the page's nth block. */
async function commentOn(page: Page, n: number, body: string): Promise<void> {
  await placeIn(page, n, 10, 30);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill(body);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: body })).toBeVisible();
}

for (const by of ["agent", "app"] as const) {
  test(`${by === "agent" ? "an agent's" : "another app's"} change to one paragraph changes only that paragraph on the page: every other block is the same, untouched, with comments and line numbers showing`, async () => {
    const { page, app, file } = await start();
    await commentOn(page, 30, "A comment far from the change.");
    await commentOn(page, 45, "Another one, further down.");
    await clickMenu(app, "line-numbers");
    // Reading far down the page, the cursor there too.
    await placeIn(page, 44, 5);
    await page.evaluate(([canvas, editor]) => {
      const scroller = document.querySelector(canvas)!;
      const block = document.querySelector(`${editor} .ProseMirror`)!.children[42];
      scroller.scrollTop += block.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    }, [CANVAS, EDITOR] as const);
    await page.waitForTimeout(300); // the line numbers drawn for what's in sight
    await watchBlocks(page, `${EDITOR} .ProseMirror`);
    await change(by, file, [{ find: "Point 40:", replace: "Point forty:" }]);
    await expect(page.locator(EDITOR)).toContainText("Point forty:");
    await page.waitForTimeout(300);
    const after = await blocksAfter(page, `${EDITOR} .ProseMirror`);
    expect(after.of).toBe(BLOCKS.length);
    // All of them are still there, the changed one too (only its words changed), and only it was touched.
    expect(after.kept).toBe(BLOCKS.length);
    expect(after.touched).toBe(1);
    // Both comments still highlighted where they were.
    const highlighted = await page.$$eval(`${EDITOR} .comment-range`, (els) => new Set(els.map((el) => el.textContent)).size);
    expect(highlighted).toBe(2);
    expect(readFileSync(file, "utf8")).toBe(DOC.replace("Point 40:", "Point forty:"));
  });
}

test("in the Markdown view, an agent's change to one paragraph changes only that paragraph in the preview, and the text says it", async () => {
  const { page, file } = await start();
  await page.getByRole("button", { name: "Markdown" }).click();
  await expect(page.locator(PREVIEW)).toContainText("Point 20:");
  await settle(page);
  await watchBlocks(page, PREVIEW);
  await agentEdits(file, [{ find: "Point 20:", replace: "Point twenty:" }]);
  await expect(page.locator(SOURCE)).toHaveValue(DOC.replace("Point 20:", "Point twenty:"));
  await expect(page.locator(PREVIEW)).toContainText("Point twenty:");
  await settle(page);
  const after = await blocksAfter(page, PREVIEW);
  expect(after.kept).toBe(BLOCKS.length);
  expect(after.touched).toBe(1);
});

// The place is carried, not searched for ----------------------------------------------------------

for (const by of ["agent", "app"] as const) {
  test(`with the same words written twice, the cursor stays in the copy it was in when ${by === "agent" ? "an agent puts" : "another app puts"} paragraphs in above`, async () => {
    const { page, file } = await start();
    await placeIn(page, SECOND, 70);
    await change(by, file, [{ find: "# Repeats\n\n", replace: withAdded("# Repeats\n\n") }]);
    await expect(page.locator(EDITOR)).toContainText("Added 20:");
    await settle(page);
    if (by === "agent") await page.locator(`${EDITOR} .ProseMirror`).focus();
    await page.keyboard.type("Q");
    // The second copy, now twenty paragraphs further down.
    expect(await paragraphTyped(file, "Q")).toBe(SECOND + ADDED.length);
  });
}

test("with the same words written twice, selected words stay selected in the copy they were in when an agent puts paragraphs in above", async () => {
  const { page, file } = await start();
  await placeIn(page, SECOND, 30, 60);
  await agentEdits(file, [{ find: "# Repeats\n\n", replace: withAdded("# Repeats\n\n") }]);
  await expect(page.locator(EDITOR)).toContainText("Added 20:");
  await settle(page);
  await page.locator(`${EDITOR} .ProseMirror`).focus();
  await page.keyboard.type("Q");
  expect(await paragraphTyped(file, "Q")).toBe(SECOND + ADDED.length);
  expect(readFileSync(file, "utf8")).toContain(SAME[1].slice(0, 30) + "Q" + SAME[1].slice(60));
});

test("with the same words written twice, what the person is reading stays where it was on screen when an agent puts paragraphs in above", async () => {
  const { page, file } = await start();
  // The second copy's middle paragraph at the top of the window, its first line just out of sight.
  // On screen: the agent's editing line, coming up above the page, moves the page's top but not the words.
  const topOf = (n: number) =>
    page.evaluate(([editor, n]) => document.querySelector(`${editor} .ProseMirror`)!.children[n].getBoundingClientRect().top, [EDITOR, n] as const);
  await page.evaluate(
    ([canvas, editor, n]) => {
      const scroller = document.querySelector(canvas)!;
      const block = document.querySelector(`${editor} .ProseMirror`)!.children[n];
      scroller.scrollTop += block.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 10;
    },
    [CANVAS, EDITOR, SECOND] as const,
  );
  await settle(page);
  const before = await topOf(SECOND);
  await agentEdits(file, [{ find: "# Repeats\n\n", replace: withAdded("# Repeats\n\n") }]);
  await expect(page.locator(EDITOR)).toContainText("Added 20:");
  await settle(page);
  expect(Math.abs((await topOf(SECOND + ADDED.length)) - before)).toBeLessThan(2);
});

test("in the Markdown view, with the same words written twice, the cursor stays in the copy it was in when an agent puts paragraphs in above", async () => {
  const { page, file } = await start();
  await page.getByRole("button", { name: "Markdown" }).click();
  const area = page.locator(SOURCE);
  await area.evaluate((a, words) => {
    const t = a as HTMLTextAreaElement;
    const at = t.value.lastIndexOf(words) + 70;
    t.setSelectionRange(at, at);
  }, SAME[1]);
  await agentEdits(file, [{ find: "# Repeats\n\n", replace: withAdded("# Repeats\n\n") }]);
  await expect(area).toHaveValue(withAdded(DOC));
  await expect(area).toBeFocused();
  await page.keyboard.type("Q");
  expect(await paragraphTyped(file, "Q")).toBe(SECOND + ADDED.length);
});

test("in the Markdown view, an agent's edits above and below what the person is reading leave the line at the top where it was", async () => {
  const { page, file } = await start();
  await page.getByRole("button", { name: "Markdown" }).click();
  const area = page.locator(SOURCE);
  // Point 25 at the top of the text.
  const lineHeight = await area.evaluate((a, words) => {
    const t = a as HTMLTextAreaElement;
    const line = parseFloat(getComputedStyle(t).lineHeight);
    // Its line, found by laying the text before it out in a copy of the text area.
    const probe = t.cloneNode(false) as HTMLTextAreaElement;
    Object.assign(probe.style, { position: "absolute", visibility: "hidden", height: "0", minHeight: "0", width: getComputedStyle(t).width });
    t.parentElement!.append(probe);
    probe.value = t.value.slice(0, t.value.indexOf(words) - 1);
    const above = probe.scrollHeight;
    probe.remove();
    t.scrollTop = above - parseFloat(getComputedStyle(t).paddingBottom);
    return line;
  }, para(25));
  await settle(page);
  const scroll = await area.evaluate((a) => a.scrollTop);
  expect(scroll).toBeGreaterThan(200);
  const areaTop = () => area.evaluate((a) => a.getBoundingClientRect().top);
  const topBefore = await areaTop();
  // Six short lines put in far above, four far below.
  await agentEdits(file, [
    { find: para(5), replace: `${para(5)}\n\nOne.\n\nTwo.\n\nThree.` },
    { find: para(40), replace: `${para(40)}\n\nFour.\n\nFive.` },
  ]);
  await expect(area).toHaveValue(/Five\./);
  await settle(page);
  // (Plus the room the agent's line takes above the text: the words stay where they were on screen.)
  const moved = (await areaTop()) - topBefore;
  expect(Math.abs((await area.evaluate((a) => a.scrollTop)) - (scroll + 6 * lineHeight + moved))).toBeLessThan(2);
});

// Where the keyboard rests -------------------------------------------------------------------------

/** Where the keyboard is: the page, the Markdown text, a card (its first words), the find bar, or something else. */
const keyboard = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return "nowhere";
    if (a.closest(".ProseMirror")) return "page";
    if (a.matches("textarea.source")) return "text";
    if (a.classList.contains("comment-card")) return `card: ${(a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60)}`;
    if (a.matches(".find-field")) return "find";
    return a.tagName.toLowerCase();
  });

for (const view of ["Formatted", "Markdown"] as const) {
  for (const by of ["agent", "app"] as const) {
    test(`in the ${view} view, the keyboard stays where it rests (the find bar, a card) through ${by === "agent" ? "an agent's" : "another app's"} change`, async () => {
      const { page, file } = await start();
      // A comment, for a card the keyboard can rest on.
      await placeIn(page, 3, 10, 30);
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      await page.getByRole("textbox", { name: "New comment" }).fill("Look at this.");
      await page.getByRole("button", { name: "Post" }).click();
      await expect(page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: "Look at this." })).toBeVisible();
      if (view === "Markdown") await page.getByRole("button", { name: "Markdown" }).click();
      const shown = async (words: string) => {
        if (view === "Formatted") await expect(page.locator(EDITOR)).toContainText(words);
        else await expect(page.locator(SOURCE)).toHaveValue(new RegExp(words));
        await settle(page);
      };

      // The find bar, with words typed in it.
      await page.keyboard.press("Meta+f");
      await page.keyboard.type("budg");
      await expect.poll(() => keyboard(page)).toBe("find");
      await change(by, file, [{ find: "Point 30:", replace: "Point thirty:" }]);
      await shown("Point thirty:");
      expect(await keyboard(page)).toBe("find");
      await page.keyboard.type("et");
      await expect(page.getByRole("textbox", { name: "Find" })).toHaveValue("budget");
      await page.keyboard.press("Escape");

      // A card, after Next Comment (the comment's, or after an agent's pass, the card of its changes).
      await page.keyboard.press("Meta+Alt+ArrowDown");
      await expect.poll(() => keyboard(page)).toMatch(/^card: /);
      const resting = await keyboard(page);
      await change(by, file, [{ find: "Point 31:", replace: "Point thirty-one:" }]);
      await shown("Point thirty-one:");
      expect(await keyboard(page)).toBe(resting);
    });
  }
}

// The card in focus ---------------------------------------------------------------------------------

for (const view of ["Formatted", "Markdown"] as const) {
  for (const by of ["agent", "app"] as const) {
    test(`in the ${view} view, the card in focus stays so through ${by === "agent" ? "an agent's" : "another app's"} change, even with the cursor resting in a comment's words`, async () => {
      const { page, file } = await start();
      await commentOn(page, 3, "On three.");
      // An agent's change, and a comment it left on the whole document: a card on no words. (Until roadmap
      // Batch 9, item 5, the card here was the one for the agent's changes no comment asked for.)
      const claude = await agent();
      await claude.ok("take_document", { path: file });
      await claude.ok("edit_document", { path: file, edits: [{ find: "Point 45:", replace: "Point forty-five:" }] });
      await claude.ok("add_comment", { path: file, text: "About the whole list." });
      if ((await claude.call("finish_editing", { path: file })).isError) await claude.ok("finish_editing", { path: file });
      await expect(page.locator(EDITOR)).toContainText("Point forty-five:");
      const onThree = page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: "On three." });
      const other = page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: "About the whole list." });
      await expect(other).toBeVisible();
      // The cursor in the comment's words, then the whole-document card clicked: it's in focus, the cursor stays.
      await placeIn(page, 3, 15);
      await expect(onThree).toHaveClass(/active/);
      if (view === "Markdown") await page.getByRole("button", { name: "Markdown" }).click();
      await other.locator(".comment-body").first().click();
      await expect(other).toHaveClass(/active/);
      await expect(onThree).not.toHaveClass(/active/);
      await settle(page);
      await change(by, file, [{ find: "Point 40:", replace: "Point forty:" }]);
      if (view === "Formatted") await expect(page.locator(EDITOR)).toContainText("Point forty:");
      else await expect(page.locator(SOURCE)).toHaveValue(/Point forty:/);
      await settle(page);
      await expect(other).toHaveClass(/active/);
      await expect(onThree).not.toHaveClass(/active/);
    });
  }
}

// Undo ---------------------------------------------------------------------------------------------

for (const by of ["agent", "app"] as const) {
  test(`in the Markdown view, Undo after ${by === "agent" ? "an agent's" : "another app's"} change takes back neither it nor the person's typing from before it`, async () => {
    const { page, file } = await start();
    await page.getByRole("button", { name: "Markdown" }).click();
    const area = page.locator(SOURCE);
    // The person types at the end of a paragraph, and it's saved.
    await area.evaluate((a: HTMLTextAreaElement, words) => {
      const at = a.value.indexOf(words) + words.length;
      a.focus();
      a.setSelectionRange(at, at);
    }, para(10));
    await page.keyboard.type(" Mine.");
    await expect.poll(() => readFileSync(file, "utf8")).toContain(`${para(10)} Mine.`);
    await change(by, file, [{ find: "Point 40:", replace: "Point forty:" }]);
    await expect(area).toHaveValue(/Point forty:/);
    await settle(page);
    await area.focus();
    await page.keyboard.press("Meta+z");
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(700);
    const both = DOC.replace(para(10), `${para(10)} Mine.`).replace("Point 40:", "Point forty:");
    await expect(area).toHaveValue(both);
    expect(readFileSync(file, "utf8")).toBe(both);
  });
}

// The switch tests use to read the page again ------------------------------------------------------

// Review of Batch 7 (B7-R01): the switch that has a change read the page again instead (for tests comparing the two)
// was read from a name on the window, and the browser makes every element with an id such a name. A diagram's label
// can carry an element with any id, so a document could turn the switch on: every change in every tab was then read
// again, and the person's Undo emptied. It's now one only the test helpers reach, and only when Corillo runs for tests.
test("an element a document puts on the page with the test switch's name doesn't stop an agent's change arriving as an edit", async () => {
  const label = `<span id='corilloReadAgain'>Read</span> <span id='corilloTests'>again</span>`;
  const { page, file } = await start(`# Plan\n\n\`\`\`mermaid\nflowchart LR\n  A["${label}"] --> B[Done]\n\`\`\`\n\nThe budget is tight.\n`);
  await expect(page.locator(`${EDITOR} #corilloReadAgain`)).toBeAttached();
  await expect(page.locator(`${EDITOR} #corilloTests`)).toBeAttached();
  // The diagram's elements are names on the window, as the browser makes them.
  expect(await page.evaluate(() => (window as unknown as { corilloReadAgain?: unknown }).corilloReadAgain instanceof HTMLElement)).toBe(true);
  // The title in the document the editor shows (its own record of it): kept by an edit, made anew when read again.
  const keep = () =>
    page.evaluate((editor) => {
      const w = window as unknown as { title: unknown };
      w.title = (document.querySelector(`${editor} .ProseMirror`) as unknown as { pmViewDesc: { node: { firstChild: unknown } } }).pmViewDesc.node.firstChild;
    }, EDITOR);
  const kept = () =>
    page.evaluate(
      (editor) =>
        (document.querySelector(`${editor} .ProseMirror`) as unknown as { pmViewDesc: { node: { firstChild: unknown } } }).pmViewDesc.node.firstChild ===
        (window as unknown as { title: unknown }).title,
      EDITOR,
    );
  await keep();
  await agentEdits(file, [{ find: "is tight", replace: "is very tight" }]);
  await expect(page.locator(EDITOR)).toContainText("The budget is very tight.");
  expect(await kept(), "the agent's change shown as an edit").toBe(true);
  await keep();
  await change("app", file, [{ find: "very tight", replace: "tight again" }]);
  await expect(page.locator(EDITOR)).toContainText("The budget is tight again.");
  expect(await kept(), "another app's change shown as an edit").toBe(true);
});
