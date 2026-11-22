// History shows the whole conversation behind each change. Orlando
// (2026-11-09), looking at History: "If I'm looking at closed comments or
// changes historically, is there any way to see the full context of the
// request the agent was responding to? Right now I see it cuts off."
//
// Each version stays compact in the list; the version shown opens in place to
// every comment it answered (on the words it was on), every message in full,
// and what was asked in the chat. The change line shows real words, never a
// lone comma, and counts every place.
import { test, expect, type Page } from "@playwright/test";
import { openText, selectText, settle, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";
import { idsIn, finish, unreadable } from "../pictures/studio";

const COMMENTS = ".doc:not([hidden]) .comments-panel";
const HISTORY = ".doc:not([hidden]) .history-panel";
const OPEN = `${HISTORY} .history-entry.open`;

const LONG_SENTENCE =
  "We should hire two people this quarter to answer the help desk, because the queue grows every week and nobody can see who already answered a request.";
const DOC = `# The house on the hill

${LONG_SENTENCE}

The budget is tight.

The night falls over the quiet town and everyone sleeps soundly. A lamp burns in the window of the old house. Somewhere a dog barks twice.
`;
const GOTHIC =
  "The night falls over the quiet town, and the dark comes hungry. A lamp burns low in the window of the old, old house. Somewhere a dog howls twice.";

const LONG_COMMENT =
  "This is good, but can you make it sound more gothic? Like something Edgar Allan Poe would write, all ravens and candle smoke.\nKeep the numbers exactly as they are, though, and keep it to one sentence, because the steering group reads this on their phones.";
const LONG_REPLY =
  "Made it darker: the hiring line now reads like a confession by candlelight, with the same two people and the same quarter. I kept it to one sentence and left every number alone, as you asked, so the steering group sees the same facts in a gloomier coat.";

/** Leave a comment as the person: on these words, or on the whole document with none. */
async function comment(run: Running, words: string | null, body: string): Promise<void> {
  if (words) await selectText(run.page, words);
  else {
    await run.page.locator(`${EDITOR} h1`).click();
    await settle(run.page);
  }
  await run.page.getByRole("button", { name: "Comment", exact: true }).click();
  await run.page.getByRole("textbox", { name: "New comment" }).fill(body);
  await run.page.getByRole("button", { name: "Post" }).click();
  await expect(run.page.locator(`${COMMENTS} .comment-card`, { hasText: body.split("\n")[0] })).toBeVisible();
}

const card = (page: Page, body: string) => page.locator(`${COMMENTS} .comment-card`).filter({ hasText: body });

async function openHistory(page: Page): Promise<void> {
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(HISTORY)).toBeVisible();
}

/** Words cut short on screen: clamped to a few lines, or running past their box. */
function cut(page: Page, selector: string): Promise<boolean[]> {
  return page.locator(selector).evaluateAll((els) => els.map((e) => e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1));
}

test("an opened version shows the whole conversation: each comment's words, every message in full, several comments and the back-and-forth", async () => {
  const run = await openText(DOC, { name: "house.md" });
  const { page } = run;
  await comment(run, LONG_SENTENCE, LONG_COMMENT);
  await comment(run, "The budget is tight.", "Say by how much.");
  await comment(run, null, "Make the ending eerier, please.");
  const { session: claude } = await AgentSession.start(run.dataDir);
  try {
    const ids = idsIn(await claude.ok("take_document", { path: run.file }));
    const hire = [...ids.entries()].find(([quote]) => quote.startsWith("We should hire"))![1];
    const budget = ids.get("The budget is tight.")!;
    await claude.ok("edit_document", {
      path: run.file,
      edits: [{ find: LONG_SENTENCE, replace: "By candlelight we confess it: two more souls must join us this quarter, for the queue grows and no one knows who answered." }],
      comment_ids: [hire],
    });
    await claude.ok("reply_to_comment", { path: run.file, comment_id: hire, text: LONG_REPLY });
    await claude.ok("reply_to_comment", { path: run.file, comment_id: budget, text: "By how much would you like?" });
    // The person answers while the agent still holds the document; the agent answers that too, in the same pass.
    await card(page, "Say by how much.").click();
    await card(page, "Say by how much.").getByRole("textbox", { name: "Reply" }).fill("Ten percent. Say it plainly.");
    await card(page, "Say by how much.").getByRole("button", { name: "Reply" }).click();
    await expect(card(page, "Say by how much.")).toContainText("Ten percent. Say it plainly.");
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "is tight.", replace: "is ten percent tighter." }], comment_ids: [budget] });
    await claude.ok("reply_to_comment", { path: run.file, comment_id: budget, text: "Said ten percent, plainly." });
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "barks twice.", replace: "howls at nothing." }], comment_ids: [ids.get("")] });
    await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get(""), text: "The dog howls now." });
    await finish(claude, run.file);

    await openHistory(page);
    const entry = page.locator(`${HISTORY} .history-entry`).first();
    await expect(entry.locator(".history-who")).toHaveText("Claude");
    // In the list it's compact: the start of each comment and of its reply, with an ellipsis.
    await expect(entry.locator(".history-comment")).toHaveCount(3);
    expect(await cut(page, `${HISTORY} .history-entry:first-child .history-comment`)).toEqual([true, false, false]);
    expect(await cut(page, `${HISTORY} .history-entry:first-child .history-reply`)).toContain(true);
    await expect(entry.locator(".history-detail")).toHaveCount(0);

    // Opened, it shows everything.
    await entry.locator(".history-item").click();
    await expect(page.locator(".doc:not([hidden]) .version-banner")).toBeVisible();
    const open = page.locator(OPEN);
    await expect(open.locator(".history-detail")).toBeVisible();
    await expect(open.locator(".history-quote")).toHaveText([LONG_SENTENCE, "The budget is tight."]);
    await expect(open.locator(".history-whole")).toHaveText(["Whole document"]);
    const conversations = open.locator(".history-conversation");
    await expect(conversations).toHaveCount(3);
    const hiring = conversations.filter({ hasText: "Edgar Allan Poe" });
    await expect(hiring.locator(".history-author")).toHaveText(["You", "Claude"]);
    // innerText keeps the comment's line break as typed.
    expect(await hiring.locator(".history-body").evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText))).toEqual([LONG_COMMENT, LONG_REPLY]);
    const money = conversations.filter({ hasText: "Say by how much." });
    await expect(money.locator(".history-author")).toHaveText(["You", "Claude", "You", "Claude"]);
    await expect(money.locator(".history-body")).toHaveText([
      "Say by how much.",
      "By how much would you like?",
      "Ten percent. Say it plainly.",
      "Said ten percent, plainly.",
    ]);
    await expect(conversations.filter({ hasText: "eerier" }).locator(".history-body")).toHaveText(["Make the ending eerier, please.", "The dog howls now."]);
    // Long words wrap; nothing is clamped or cut off.
    expect(await cut(page, `${OPEN} :is(.history-quote, .history-body, .history-change)`)).not.toContain(true);
    // The compact lines give way to the full ones, not shown twice.
    await expect(open.locator(".history-comment")).toHaveCount(0);
    // The words can be selected to copy; clicking them leaves the version open.
    await hiring.locator(".history-body").nth(1).click({ clickCount: 3 });
    expect(await page.evaluate(() => getSelection()?.toString().trim())).toBe(LONG_REPLY);
    await expect(open.locator(".history-detail")).toBeVisible();
    await expect(page.locator(".doc:not([hidden]) .version-banner")).toBeVisible();

    // Back to the document (for the latest version the banner's button says Hide changes): compact again.
    await page.locator(".doc:not([hidden]) .version-banner").getByRole("button", { name: "Hide changes" }).click();
    await expect(page.locator(`${HISTORY} .history-detail`)).toHaveCount(0);
    await expect(entry.locator(".history-comment")).toHaveCount(3);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("a request made in the chat shows in full when its version is opened, and only its start in the list", async () => {
  const run = await openText(DOC, { name: "house.md" });
  const { page } = run;
  const request =
    "Make the whole thing read like a ghost story.\nEvery paragraph should feel like a door creaking open in an empty house, but keep the numbers and the names exactly as they are, because the steering group will check them against last quarter's report.";
  const { session: claude } = await AgentSession.start(run.dataDir);
  try {
    await claude.ok("take_document", { path: run.file, request });
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "The budget is tight.", replace: "The budget is a cold and narrow room." }] });
    await finish(claude, run.file);
    await openHistory(page);
    const entry = page.locator(`${HISTORY} .history-entry`).first();
    await expect(entry.locator(".history-asked")).toContainText("Asked in chat: Make the whole thing read like a ghost story.");
    expect(await cut(page, `${HISTORY} .history-entry:first-child .history-asked`)).toEqual([true]);
    await entry.locator(".history-item").click();
    await expect(page.locator(`${OPEN} .history-label`)).toHaveText("Asked in chat");
    expect(await page.locator(`${OPEN} .history-request`).evaluate((e) => (e as HTMLElement).innerText)).toBe(request);
    expect(await cut(page, `${OPEN} .history-request`)).toEqual([false]);
    await expect(page.locator(`${OPEN} .history-change`)).toContainText("cold and narrow room");
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("a comment resolved since, whose words the agent took out, still reads in full in History", async () => {
  const run = await openText(DOC, { name: "house.md" });
  const { page } = run;
  await comment(run, LONG_SENTENCE, "Cut this sentence, it repeats the summary. We say the same thing in the opening.");
  const { session: claude } = await AgentSession.start(run.dataDir);
  try {
    const ids = idsIn(await claude.ok("take_document", { path: run.file }));
    const id = [...ids.values()][0];
    await claude.ok("edit_document", { path: run.file, edits: [{ find: `${LONG_SENTENCE}\n\n`, replace: "" }], comment_ids: [id] });
    await claude.ok("reply_to_comment", { path: run.file, comment_id: id, text: "Cut it; the opening already says it." });
    await finish(claude, run.file);
    expect(run.text()).not.toContain("We should hire");
    // The person is happy and resolves it: it leaves the Comments panel.
    await card(page, "Cut this sentence").click();
    await card(page, "Cut this sentence").getByRole("button", { name: "Resolve" }).click();
    await expect(page.locator(`${COMMENTS} .comment-card:not(.resolved)`, { hasText: "Cut this sentence" })).toHaveCount(0);

    await openHistory(page);
    await page.locator(`${HISTORY} .history-entry`).first().locator(".history-item").click();
    await expect(page.locator(`${OPEN} .history-quote`)).toHaveText(LONG_SENTENCE);
    await expect(page.locator(`${OPEN} .history-body`)).toHaveText([
      "Cut this sentence, it repeats the summary. We say the same thing in the opening.",
      "Cut it; the opening already says it.",
    ]);
    await expect(page.locator(`${OPEN} .history-change del`)).toContainText("We should hire two people");
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("the change line never shows a lone comma or a short word, and counts every place it changed", async () => {
  const run = await openText(DOC, { name: "house.md" });
  const { page } = run;
  await comment(run, null, "This is good, but can you make it sound more gothic. Like something Edgar Allan Poe would write.");
  const { session: claude } = await AgentSession.start(run.dataDir);
  try {
    const ids = idsIn(await claude.ok("take_document", { path: run.file }));
    // One rewrite of the paragraph changes five places: a comma, "low" and ", old" put in, and two real changes.
    await claude.ok("edit_document", {
      path: run.file,
      edits: [{ find: DOC.split("\n\n")[3].trim(), replace: GOTHIC }],
      comment_ids: [ids.get("")],
    });
    await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get(""), text: "Darkened the last paragraph." });
    await finish(claude, run.file);

    await openHistory(page);
    const entry = page.locator(`${HISTORY} .history-entry`).first();
    const line = entry.locator(".history-change");
    await expect(line.locator(".history-change-count")).toHaveText("Changed 5 places, including");
    await expect(line.locator(".history-change-place")).toHaveText(["everyone sleeps soundly the dark comes hungry", "barks howls"]);
    for (const place of await line.locator(".history-change-place :is(del, ins)").allTextContents()) {
      expect(place, "a whole word of four letters or more, or more than one word").toMatch(/[\p{L}\p{N}]{4,}|\S+ \S+/u);
    }
    // The same when the version is opened, and for agents.
    await entry.locator(".history-item").click();
    await expect(page.locator(`${OPEN} .history-change-count`)).toHaveText("Changed 5 places, including");
    expect(await claude.ok("list_versions", { path: run.file })).toContain(
      "Changed: 5 places, including [-everyone sleeps soundly-]{+the dark comes hungry+}; [-barks-]{+howls+}",
    );
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("an opened version's conversation is readable in light and dark", async () => {
  const run = await openText(DOC, { name: "house.md" });
  const { page } = run;
  await comment(run, "The budget is tight.", "Say by how much.");
  const { session: claude } = await AgentSession.start(run.dataDir);
  try {
    const ids = idsIn(await claude.ok("take_document", { path: run.file, request: "Make the title spookier." }));
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "is tight.", replace: "is ten percent tighter." }], comment_ids: [ids.get("The budget is tight.")] });
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "The house on the hill", replace: "The haunted house on the hill" }] });
    await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get("The budget is tight."), text: "Ten percent." });
    await finish(claude, run.file);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHistory(page);
    await page.locator(`${HISTORY} .history-entry`).first().locator(".history-item").click();
    await expect(page.locator(`${OPEN} .history-detail`)).toBeVisible();
    await expect(page.locator(`${OPEN} .history-conversation`)).toHaveCount(2);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await settle(page);
      expect(await unreadable(page), scheme).toEqual([]);
    }
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("while History is open, a change draws only what changed: words selected in the open conversation stay selected, and the version shown isn't drawn again or given the keyboard", async () => {
  const run = await openText(DOC, { name: "house.md" });
  const { page } = run;
  await comment(run, "The budget is tight.", "Say by how much.");
  const { session: claude } = await AgentSession.start(run.dataDir);
  try {
    const ids = idsIn(await claude.ok("take_document", { path: run.file }));
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "is tight.", replace: "is ten percent tighter." }], comment_ids: [ids.get("The budget is tight.")] });
    await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get("The budget is tight."), text: LONG_REPLY });
    await finish(claude, run.file);
    // The person's own edits after it: a version of theirs.
    await page.locator(`${EDITOR} p`, { hasText: "Somewhere a dog" }).click();
    await settle(page);
    await page.keyboard.press("Meta+ArrowDown"); // the end of the document: this paragraph's end
    await page.keyboard.type(" Mine.");
    await expect.poll(() => run.text()).toContain("twice. Mine.");

    await openHistory(page);
    await expect(page.locator(`${HISTORY} .history-who`)).toHaveText(["You", "Claude", "First version"]);
    await page.locator(`${HISTORY} .history-item`).filter({ hasText: "Claude" }).click();
    await expect(page.locator(`${OPEN} .history-detail`)).toBeVisible();
    await expect(page.locator(".doc:not([hidden]) .version-banner")).toContainText("Version from");
    // Note each row, and every change to the version's page from here on.
    await page.evaluate(() => {
      const w = window as unknown as { rows: Element[]; pageChanges: number };
      w.rows = [...document.querySelectorAll(".doc:not([hidden]) .history-panel .history-entry")];
      w.pageChanges = 0;
      new MutationObserver((records) => (w.pageChanges += records.length)).observe(document.querySelector(".doc:not([hidden]) .version-view")!, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    const sameRows = () =>
      page.evaluate(() => {
        const w = window as unknown as { rows: Element[] };
        return w.rows.map((row) => row.isConnected);
      });
    await page.locator(`${OPEN} .history-body`).nth(1).click({ clickCount: 3 });
    expect(await page.evaluate(() => getSelection()?.toString().trim())).toBe(LONG_REPLY);

    // Claude takes the document again and edits it: a new version, then its time moves with each edit.
    await claude.ok("take_document", { path: run.file });
    await expect(page.locator(".doc:not([hidden]) .restore-version")).toBeDisabled(); // nothing restored while Claude holds it
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "The night falls", replace: "Night falls" }] });
    await expect(page.locator(`${HISTORY} .history-who`)).toHaveText(["Claude", "You", "Claude", "First version"]);
    await expect(page.locator(`${HISTORY} .history-entry:first-child .history-tag`)).toHaveText("Current");
    await expect(page.locator(`${HISTORY} .history-tag`)).toHaveCount(1);
    expect(await page.evaluate(() => getSelection()?.toString().trim())).toBe(LONG_REPLY);
    expect(await sameRows()).toEqual([true, true, true]);

    // With the keyboard on the panel's Close button, another edit: it stays there.
    await page.getByRole("button", { name: "Close history" }).focus();
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "A lamp burns", replace: "A candle burns" }] });
    await expect.poll(() => run.text()).toContain("A candle burns");
    await finish(claude, run.file);
    await expect(page.locator(".doc:not([hidden]) .restore-version")).toBeEnabled();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Close history");
    expect(await sameRows()).toEqual([true, true, true]);
    expect(await page.evaluate(() => (window as unknown as { pageChanges: number }).pageChanges)).toBe(0);
    // The newest row still shows Claude's latest pass, and the version shown is still the one picked.
    await expect(page.locator(`${HISTORY} .history-who`)).toHaveText(["Claude", "You", "Claude", "First version"]);
    await expect(page.locator(`${OPEN} .history-who`)).toHaveText("Claude");
    await expect(page.locator(`${OPEN} .history-body`)).toHaveText(["Say by how much.", LONG_REPLY]);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("the History list stays quick and compact with many versions, each carrying a long conversation", async () => {
  test.setTimeout(90_000);
  const run = await openText(DOC, { name: "house.md" });
  const { page } = run;
  await comment(run, null, LONG_COMMENT);
  const { session: claude } = await AgentSession.start(run.dataDir);
  const passes = 40;
  try {
    const id = idsIn(await claude.ok("list_comments", { path: run.file })).get("")!;
    // Forty passes over the same comment: by the last, its thread has forty replies.
    for (let i = 1; i <= passes; i++) {
      await claude.ok("take_document", { path: run.file });
      await claude.ok("edit_document", { path: run.file, edits: [{ find: i === 1 ? "is tight." : `tight (round ${i - 1}).`, replace: `tight (round ${i}).` }], comment_ids: [id] });
      await claude.ok("reply_to_comment", { path: run.file, comment_id: id, text: `Round ${i}. ${LONG_REPLY}` });
      await claude.ok("finish_editing", { path: run.file });
    }
    const timed = (click: string, ready: string) =>
      page.evaluate(
        ([click, ready]) =>
          new Promise<number>((resolve) => {
            const start = performance.now();
            document.querySelector<HTMLElement>(click)!.click();
            const check = () => (document.querySelector(ready) ? resolve(performance.now() - start) : setTimeout(check, 1));
            check();
          }),
        [click, ready] as const,
      );
    const opened = await timed('.history-tools button[aria-label="History"]', `${HISTORY} .history-list > li:nth-child(${passes + 1})`);
    // Each version stays a few lines high in the list, however long its conversation.
    const heights = await page.locator(`${HISTORY} .history-entry`).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(Math.max(...heights)).toBeLessThan(200);
    const picked = await timed(`${HISTORY} .history-item[data-n="${passes}"]`, `${OPEN} .history-detail`);
    await expect(page.locator(`${OPEN} .history-body`)).toHaveCount(passes);
    const picked2 = await timed(`${HISTORY} .history-item[data-n="${passes + 1}"]`, `${OPEN} .history-item[data-n="${passes + 1}"]`);
    await expect(page.locator(`${OPEN} .history-body`)).toHaveCount(passes + 1);
    // Generous limits, for a busy Mac: in the benchmark these take tens of milliseconds.
    expect(opened, "History panel opens").toBeLessThan(500);
    expect(Math.max(picked, picked2), "a version opens").toBeLessThan(800);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});
