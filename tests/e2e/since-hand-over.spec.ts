// Show changes, everything since the person handed the document over
// (roadmap Batch 3, item 1): two agents pass in turn, and both agents' words
// are marked, the banner's count equals the marks, stepping visits each
// change once, and the Comments panel stays open. The person's own edits
// aren't marked, and a version picked in History still shows only what it
// changed. A pretend agent tool speaks MCP to the real app, on throwaway
// documents and a throwaway data folder.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openText, cursorAtEnd, selectText, clickMenu, settle, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const DOC = ".doc:not([hidden])";
const VERSION = `${DOC} .version-view .ProseMirror`;
const CANVAS = `${DOC} .version-view`;
const BANNER = `${DOC} .version-banner`;
const PANEL = `${DOC} aside.comments-panel`;
const PLACE = `${BANNER} .version-step-place`;

/** A document long enough that its changes are screens apart. */
const LONG =
  Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} says something about topic ${i + 1}, at some length so that it fills a line or two of the page.`).join("\n\n") + "\n";

const sessions: AgentSession[] = [];
let run: Running | null = null;

async function agent(name?: string): Promise<AgentSession> {
  const { session } = await AgentSession.start(run!.dataDir, name ? `${name.toLowerCase()}-tool` : "claude-code");
  sessions.push(session);
  if (name) await session.ok("introduce", { name });
  return session;
}

/** One agent's pass: take the document, make these edits, hand it back. `answering`: the edits for its comments, as their own call. */
async function pass(who: AgentSession, edits: { find: string; replace: string }[], answering: { find: string; replace: string }[] = []): Promise<void> {
  const taken = await who.ok("take_document", { path: run!.file });
  const ids = [...taken.matchAll(/\[([0-9a-f]{8})\]/g)].map((m) => m[1]);
  await who.ok("edit_document", { path: run!.file, edits });
  if (answering.length) await who.ok("edit_document", { path: run!.file, edits: answering, comment_ids: ids });
  for (const id of ids) await who.ok("reply_to_comment", { path: run!.file, comment_id: id, text: "Done." });
  await who.ok("finish_editing", { path: run!.file });
}

test.afterEach(async () => {
  await run?.app.close().catch(() => undefined);
  for (const s of sessions) {
    const pid = Number(/process (\d+)/.exec(s.stderr)?.[1]);
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
  await Promise.all(sessions.splice(0).map((s) => s.stop()));
  run = null;
});

/** The changes on the page shown, by number, each once. */
const changesShown = (page: Page) =>
  page.evaluate((sel) => [...new Set([...document.querySelectorAll<HTMLElement>(`${sel} [data-change]`)].map((m) => m.dataset.change))], VERSION);

/** The change ringed now, and whether its first mark is in sight. */
const current = (page: Page) =>
  page.evaluate(
    ([sel, canvas]) => {
      const ringed = [...document.querySelectorAll<HTMLElement>(`${sel} .diff-current`)];
      if (!ringed.length) return null;
      const box = document.querySelector(canvas)!.getBoundingClientRect();
      const r = ringed[0].getBoundingClientRect();
      return { change: [...new Set(ringed.map((m) => m.dataset.change))].join(","), inSight: r.bottom > box.top && r.top < box.bottom };
    },
    [VERSION, CANVAS] as const,
  );

test("two agents pass in turn: both agents' words are marked, the count equals the marks, stepping visits each change once, and the Comments panel stays", async () => {
  run = await openText(LONG, { name: "long.md" });
  const { page, file } = run;
  // The person's own edit and comment, before handing it over: not marked.
  await cursorAtEnd(page, "a line or two of the page.");
  await page.keyboard.type(" Mine.");
  await expect.poll(() => readFileSync(file, "utf8")).toContain("of the page. Mine.");
  await selectText(page, "topic 28");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill("Spell the number out?");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(PANEL)).toBeVisible();

  const writer = await agent("Writer");
  await pass(writer, [{ find: "Paragraph 2 says something", replace: "Paragraph 2 says a great deal" }], [{ find: "topic 28", replace: "topic twenty-eight" }]);
  const claude = await agent();
  await pass(claude, [
    { find: "about topic 15,", replace: "about topic fifteen," },
    { find: "Paragraph 30 says", replace: "Paragraph 30, the last, says" },
  ]);
  await expect.poll(() => readFileSync(file, "utf8")).toContain("the last, says");
  // The person's edit after the round: not marked either.
  await expect(page.locator(EDITOR)).toContainText("the last, says");
  await cursorAtEnd(page, "topic 10, at some length so that it fills a line or two of the page.");
  await page.keyboard.type(" Read so far.");
  await expect.poll(() => readFileSync(file, "utf8")).toContain("page. Read so far.");

  const left = await page.locator(`${DOC} .page.editor`).evaluate((p) => p.getBoundingClientRect().left);
  await page.locator("#toolbar").getByRole("button", { name: "Show changes" }).click();
  await expect(page.locator(BANNER)).toContainText(/^4 changes by Writer and Claude since you handed it over at /);
  // Both agents' words are marked, and none of the person's.
  const added = page.locator(`${VERSION} ins.diff-added`);
  await expect(added).toHaveText(["a great deal", "fifteen", "twenty-eight", ", the last,"]);
  expect(await page.locator(`${VERSION} ins`).filter({ hasText: /Mine|Read so far/ }).count()).toBe(0);
  // The banner's count equals the marks.
  expect((await changesShown(page)).length).toBe(4);
  // The Comments panel stays, and the page doesn't move sideways.
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(page.locator(`${PANEL} .comment-card`, { hasText: "Spell the number out?" })).toBeVisible();
  expect(await page.locator(VERSION).evaluate((p) => p.closest(".page")!.getBoundingClientRect().left)).toBe(left);
  await clickMenu(run.app, "view-comments");
  await expect(page.locator(PANEL)).toBeHidden(); // Hide Comments still hides it
  await clickMenu(run.app, "view-comments");
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(page.locator(BANNER)).toBeVisible(); // and the changes stay on

  // Stepping, from the top: the arrow visits each change once, each in sight, then comes round to the first.
  // (From further down, the first it goes to is the first in sight.)
  // At the top once the page has settled from the Comments panel coming back (it keeps its place a frame or two
  // later, and a scroll before that was sometimes undone, so the first change in sight was the second).
  await expect
    .poll(() =>
      page.locator(CANVAS).evaluate(async (c) => {
        c.scrollTop = 0;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return c.scrollTop;
      }),
    )
    .toBe(0);
  const next = page.locator(BANNER).getByRole("button", { name: "Next change" });
  const seen: string[] = [];
  for (let k = 1; k <= 4; k++) {
    await next.click();
    await expect(page.locator(PLACE)).toHaveText(`${k} of 4`);
    await expect.poll(async () => (await current(page))?.inSight).toBe(true);
    seen.push((await current(page))!.change);
  }
  expect(new Set(seen).size).toBe(4);
  expect([...seen].sort()).toEqual(((await changesShown(page)) as string[]).sort());
  await next.click();
  await expect(page.locator(PLACE)).toHaveText("1 of 4");
  expect((await current(page))!.change).toBe(seen[0]);
  // Option-Command-Down and Up do the same, and the menu says so.
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(page.locator(PLACE)).toHaveText("2 of 4");
  await page.keyboard.press("Meta+Alt+ArrowUp");
  await page.keyboard.press("Meta+Alt+ArrowUp");
  await expect(page.locator(PLACE)).toHaveText("4 of 4");
  await expect.poll(async () => (await current(page))?.inSight).toBe(true);
  expect(await run.app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("review-next")!.label)).toBe("Next Change");

  // Clicking the card goes to its change.
  await page.locator(CANVAS).evaluate((c) => (c.scrollTop = 0));
  await page.locator(`${PANEL} .comment-card`, { hasText: "Spell the number out?" }).click();
  await expect(page.locator(`${VERSION} .diff-current`)).toHaveText(["28", "twenty-eight"]);
  await expect(page.locator(PLACE)).toHaveText("3 of 4");
  await expect.poll(async () => (await current(page))?.inSight).toBe(true);

  // Hide changes: back to editing, the menu back to comments.
  await page.locator(BANNER).getByRole("button", { name: "Hide changes" }).click();
  await expect(page.locator(EDITOR)).toBeVisible();
  await expect.poll(() => run!.app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("review-next")!.label)).toBe("Next Comment");

  // A version picked in History still shows only what it changed: Writer's pass, not Claude's.
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator(`${DOC} .history-panel .history-item`).filter({ has: page.locator(".history-who", { hasText: /^Writer$/ }) }).click();
  await expect(page.locator(BANNER)).toContainText("Version from");
  await expect(page.locator(`${VERSION} ins.diff-added`)).toHaveText(["a great deal", "twenty-eight"]);
  await expect(page.locator(`${BANNER} .version-steps`)).toBeHidden();
});

test("with no agent yet, or nothing changed since the hand-over, the banner says so and nothing is marked", async () => {
  run = await openText("# Plan\n\nThe budget is tight.\n");
  const { page, file } = run;
  await cursorAtEnd(page, "The budget is tight.");
  await page.keyboard.type(" Mine.");
  await expect.poll(() => readFileSync(file, "utf8")).toContain("tight. Mine.");
  await page.locator("#toolbar").getByRole("button", { name: "Show changes" }).click();
  await expect(page.locator(BANNER)).toContainText("You haven't handed this document to an agent yet, so there are no changes to show.");
  await expect(page.locator(`${VERSION} [data-change]`)).toHaveCount(0);
  await expect(page.locator(`${BANNER} .version-steps`)).toBeHidden();
  expect(await run.app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("review-next")!.enabled)).toBe(false);
  await page.locator(BANNER).getByRole("button", { name: "Hide changes" }).click();

  // An agent takes it and hasn't changed anything yet.
  const claude = await agent();
  await claude.ok("take_document", { path: file });
  await page.locator("#toolbar").getByRole("button", { name: "Show changes" }).click();
  await expect(page.locator(BANNER)).toContainText(/^No one else has changed the text since you handed it over at /);
  await expect(page.locator(`${VERSION} [data-change]`)).toHaveCount(0);
  // It follows the agent's edits as they come.
  await claude.ok("edit_document", { path: file, edits: [{ find: "is tight", replace: "is very tight" }] });
  await expect(page.locator(BANNER)).toContainText(/^1 change by Claude since you handed it over at /);
  await expect(page.locator(`${VERSION} ins.diff-added`)).toHaveText("very ");
  // The mark, and the ring the arrows put on it, take in the new word, not the space after it (review of Batch 11, F-16).
  expect(await page.locator(`${VERSION} ins.diff-added`).evaluate((e) => e.textContent)).toBe("very");
  await page.locator(BANNER).getByRole("button", { name: "Next change" }).click();
  await expect(page.locator(`${VERSION} .diff-current`)).toHaveCount(1);
  expect(await page.locator(`${VERSION} .diff-current`).evaluate((e) => e.textContent)).toBe("very");
  await claude.ok("finish_editing", { path: file });
  await settle(page);
  await expect(page.locator(BANNER)).toContainText(/^1 change by Claude since/);
});

test("a draft an agent created and nobody has handed over yet: the banner says so truly, not that no agent worked on it (B3-R07)", async () => {
  run = await openText("My notes.\n", { name: "notes.md" });
  const { page } = run;
  const claude = await agent();
  await claude.ok("create_document", { path: join(run.folder, "proposal.md"), text: "# Proposal\n\nWe should hire two people.\n" });
  await page.locator('.tab[title$="/proposal.md"]').click();
  await expect(page.locator(`${DOC} .ProseMirror`).first()).toContainText("We should hire two people.");
  await page.locator("#toolbar").getByRole("button", { name: "Show changes" }).click();
  await expect(page.locator(BANNER)).toContainText("You haven't handed this document to an agent yet, so there are no changes to show. History has every version.");
  await expect(page.locator(BANNER)).not.toContainText("No agent has worked");
  await expect(page.locator(`${VERSION} [data-change]`)).toHaveCount(0);
});

test("the person's edits between two passes hand it over again: only the later pass is marked, and none of their words", async () => {
  run = await openText("# Plan\n\nWe should hire two people.\n\nThe budget is tight.\n\nWe start in March.\n");
  const { page, file } = run;
  const writer = await agent("Writer");
  await pass(writer, [{ find: "two people", replace: "three people" }]);
  await expect(page.locator(EDITOR)).toContainText("three people");
  // The person edits a passage Writer changed, and one nobody did.
  await cursorAtEnd(page, "We should hire three people.");
  await page.keyboard.type(" At least.");
  await cursorAtEnd(page, "We start in March.");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(", or April.");
  await expect.poll(() => readFileSync(file, "utf8")).toContain("March, or April.");
  const claude = await agent();
  await pass(claude, [
    { find: "# Plan", replace: "# Hiring plan" },
    { find: "is tight", replace: "is very tight" },
  ]);
  await expect(page.locator(EDITOR)).toContainText("very tight");
  // The person deletes a word in Claude's sentence after the round, too.
  await selectText(page, "very ");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("so ");
  await expect.poll(() => readFileSync(file, "utf8")).toContain("is so tight");

  await page.locator("#toolbar").getByRole("button", { name: "Show changes" }).click();
  // Only Claude's heading is marked: not Writer's word, from before the person handed it over again, nor the person's own.
  await expect(page.locator(BANNER)).toContainText(/^1 change by Claude since you handed it over at /);
  await expect(page.locator(`${VERSION} ins.diff-added`)).toHaveText(["Hiring plan"]);
  expect(await changesShown(page)).toEqual(["0"]);
  await page.locator(BANNER).getByRole("button", { name: "Hide changes" }).click();

  // Once the person has replaced every word Claude put in, nothing is left to mark, and the banner says why.
  await selectText(page, "Hiring plan");
  await page.keyboard.type("Plan for hiring");
  await expect.poll(() => readFileSync(file, "utf8")).toContain("# Plan for hiring");
  await page.locator("#toolbar").getByRole("button", { name: "Show changes" }).click();
  await expect(page.locator(BANNER)).toContainText(/^None of the changes Claude made since you handed it over at .* are left to mark: you've edited those places since\./);
  await expect(page.locator(`${VERSION} [data-change]`)).toHaveCount(0);
});

// Review of Batch 4, B4-R02: Find steps into the comment cards beside Show
// changes as a click on the card does, bringing its words into sight on the
// page shown (not the page being edited, which is hidden). With History open
// too, the Comments column is hidden: History gives it its place back.
test("with Show changes on, Find going into a card brings its words into sight on the page shown; with History open too, History gives the cards their place back", async () => {
  run = await openText(LONG, { name: "long.md" });
  const { page, file } = run;
  const findField = page.getByRole("textbox", { name: "Find", exact: true });
  const count = page.locator(".find-count");
  const card = page.locator(`${PANEL} .comment-card`, { hasText: "Spell the number out?" });
  const history = page.locator(`${DOC} .history-panel`);
  /** Whether paragraph 28, the comment's, is in sight on the page shown. */
  const wordsInSight = () =>
    page.evaluate(
      ([sel, canvas]) => {
        const p = [...document.querySelectorAll<HTMLElement>(`${sel} p`)].find((e) => e.textContent!.startsWith("Paragraph 28 says"));
        const box = document.querySelector(canvas)!.getBoundingClientRect();
        const r = p!.getBoundingClientRect();
        return r.bottom > box.top && r.top < box.bottom;
      },
      [VERSION, CANVAS] as const,
    );
  await selectText(page, "topic 28");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill("Spell the number out?");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(card).toBeVisible();
  await pass(await agent(), [{ find: "Paragraph 2 says something", replace: "Paragraph 2 says a great deal" }]);
  await expect.poll(() => readFileSync(file, "utf8")).toContain("a great deal");
  await expect(page.locator(EDITOR)).toContainText("a great deal");

  await page.locator("#toolbar").getByRole("button", { name: "Show changes" }).click();
  await expect(page.locator(BANNER)).toBeVisible();
  await page.locator(CANVAS).evaluate((c) => (c.scrollTop = 0));
  expect(await wordsInSight()).toBe(false);
  await page.keyboard.press("Meta+F");
  await findField.fill("Spell the number");
  await expect(count).toHaveText("No matches in the text · 1 in comments");
  await findField.press("Enter");
  await expect(count).toHaveText("No matches in the text · 1 of 1 in comments");
  await expect(card).toHaveClass(/active/);
  await expect.poll(wordsInSight).toBe(true);
  await findField.press("Escape");

  // With History open beside Show changes, the cards are hidden: going to one brings them back, Show changes staying on.
  await page.locator(CANVAS).evaluate((c) => (c.scrollTop = 0));
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(history).toBeVisible();
  await expect(page.locator(PANEL)).toBeHidden();
  await page.keyboard.press("Meta+F");
  await findField.fill("Spell the number");
  await expect(count).toHaveText("No matches in the text · 1 in comments");
  await findField.press("Enter");
  await expect(history).toBeHidden();
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/active/);
  await expect(page.locator(BANNER)).toBeVisible();
  await expect.poll(wordsInSight).toBe(true);
});
