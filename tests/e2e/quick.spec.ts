// Corillo stays quick: it shows the person what changed first and does its
// bookkeeping (the version history, the recent list) after, and it lets go of
// documents once they're closed. (npm run bench times all of this in detail.)
import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bigDocument } from "../fixtures/big-document";
import { longSession, numbers, sentenceFrom } from "../fixtures/long-history";
import { VersionHistory } from "../../src/main/version-store";
import { CommentService } from "../../src/main/comment-service";
import { anchorIn } from "../../src/core/anchors";
import { AgentSession } from "./agent-session";
import { openText, openAlso, selectText, captureClipboardWrites, clickMenu, cursorAtEnd, EDITOR } from "./helpers";

/** Note, in the window, the order things happen in: a tab appears, the editor shows some words, the history changes. */
async function noteOrder(page: import("@playwright/test").Page, words: string): Promise<void> {
  await page.evaluate((words) => {
    const w = window as unknown as { order: string[] };
    w.order = [];
    const tabs = document.querySelectorAll(".tab").length;
    new MutationObserver(() => {
      if (document.querySelectorAll(".tab").length > tabs && !w.order.includes("tab")) w.order.push("tab");
      if ((document.querySelector(".doc:not([hidden]) .page.editor")?.textContent ?? "").includes(words) && !w.order.includes("words")) {
        w.order.push("words");
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    window.corillo.onHistoryChanged(() => w.order.push("history"));
  }, words);
}

const order = (page: import("@playwright/test").Page) => page.evaluate(() => (window as unknown as { order: string[] }).order);

test("a document opened shows before its history is brought up to date", async () => {
  const run = await openText("Start.\n");
  await noteOrder(run.page, "A new one");
  await openAlso(run, "new.md", "# A new one\n\nNever opened before.\n");
  await expect(run.page.locator(EDITOR)).toContainText("Never opened before.");
  await expect.poll(() => order(run.page)).toContain("history");
  const seen = await order(run.page);
  expect(seen.indexOf("tab")).toBeGreaterThanOrEqual(0);
  expect(seen.indexOf("tab")).toBeLessThan(seen.indexOf("history"));
  await run.app.close();
});

test("an agent's edit shows in the document before Corillo records it as a version", async () => {
  const run = await openText(bigDocument(3), { name: "long.md" });
  const { session } = await AgentSession.start(run.dataDir);
  try {
    await session.ok("take_document", { path: run.file });
    await session.ok("read_document", { path: run.file });
    await noteOrder(run.page, "Rewritten by the agent");
    await session.ok("edit_document", { path: run.file, edits: [{ find: "### 2.2 ", replace: "### 2.2 Rewritten by the agent " }] });
    await expect(run.page.locator(EDITOR)).toContainText("Rewritten by the agent");
    await expect.poll(() => order(run.page)).toContain("history");
    expect(await order(run.page)).toEqual(["words", "history"]);
    await session.ok("finish_editing", { path: run.file });
  } finally {
    await session.stop();
    await run.app.close();
  }
});

test("the window reads an agent's change while Corillo ties it to its comments, and a comment whose words it deletes never shows as lost, even for a moment", async () => {
  const text = bigDocument(3).replace("\n\n", "\n\nThis paragraph is about to go.\n\n");
  const run = await openText(text, { name: "long.md" });
  const { page } = run;
  await selectText(page, "about to go");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill("Cut this.");
  await page.getByRole("button", { name: "Post" }).click();
  const card = page.locator(".doc:not([hidden]) .comments-panel .comment-card").filter({ hasText: "Cut this." });
  await expect(card).toBeVisible();
  // Everything the window hears about the change, in order, and whether the card ever says its words are gone.
  await page.evaluate(() => {
    const w = window as unknown as { heard: string[]; lostShown: boolean };
    w.heard = [];
    w.lostShown = false;
    window.corillo.onAgentTextComing((_id, t) => w.heard.push(`coming ${t.length}`));
    window.corillo.onAgentText((_id, t) => w.heard.push(`text ${t.length}`));
    const panel = document.querySelector(".doc:not([hidden]) .comments-panel")!;
    new MutationObserver(() => {
      if (panel.querySelector(".comment-card.detached") || panel.textContent!.includes("The text this comment was on has changed.")) w.lostShown = true;
    }).observe(panel, { childList: true, subtree: true, characterData: true, attributes: true });
  });
  const { session } = await AgentSession.start(run.dataDir);
  try {
    const taken = await session.ok("take_document", { path: run.file });
    const id = /\[([^\]]+)\] on "about to go"/.exec(taken)![1];
    await session.ok("edit_document", { path: run.file, edits: [{ find: "This paragraph is about to go.\n\n", replace: "" }], comment_ids: [id] });
    await expect(page.locator(`${EDITOR} .comment-gap.line`)).toHaveCount(1);
    const after = text.replace("This paragraph is about to go.\n\n", "");
    expect(await page.evaluate(() => (window as unknown as { heard: string[] }).heard)).toEqual([`coming ${after.length}`, `text ${after.length}`]);
    expect(await page.evaluate(() => (window as unknown as { lostShown: boolean }).lostShown)).toBe(false);
    await expect(card).not.toContainText("has changed");
  } finally {
    await session.stop();
    await run.app.close();
  }
});

test("closing documents lets go of them, even after typing, switching views and looking at their history", async () => {
  const run = await openText("Start.\n");
  const cdp = await run.page.context().newCDPSession(run.page);
  await cdp.send("Performance.enable");
  const pageElements = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    return metrics.find((m) => m.name === "Nodes")!.value;
  };
  const before = await pageElements();
  for (let i = 0; i < 3; i++) {
    await openAlso(run, `doc ${i}.md`, bigDocument(3));
    await expect(run.page.locator(".tab")).toHaveCount(2);
    await run.page.locator(`${EDITOR} h3`).first().click();
    await run.page.keyboard.press("Meta+ArrowRight");
    await run.page.keyboard.type(" edited");
    await run.page.getByRole("button", { name: "Markdown", exact: true }).click();
    await run.page.getByRole("button", { name: "Formatted", exact: true }).click();
    await run.page.getByRole("button", { name: "History", exact: true }).click();
    await expect(run.page.locator(".doc:not([hidden]).history-open")).toBeVisible();
    await run.page.locator(".tab[aria-selected='true'] .tab-close").click();
    await expect(run.page.locator(".tab")).toHaveCount(1);
  }
  // The person carries on in the document still open. (The editor library holds
  // on to the last document typed or moved around in until the next time,
  // wherever it is.)
  await run.page.locator(`${EDITOR} p`).first().click();
  await run.page.keyboard.press("Meta+ArrowRight");
  await run.page.keyboard.type("x");
  await run.page.waitForTimeout(300);
  // Each of those documents had about 1,700 elements on the page.
  expect(await pageElements()).toBeLessThan(before + 300);
  await run.app.close();
});

/** Switch views with the button; how long until the view is on screen, in ms. */
function switchTo(page: import("@playwright/test").Page, view: "Markdown" | "Formatted"): Promise<number> {
  return page.evaluate(async (view) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(".mode-switch button")].find((b) => b.textContent === view)!;
    const start = performance.now();
    button.click();
    // On screen: the frame after the click has been drawn.
    await new Promise<void>((drawn) =>
      requestAnimationFrame(() => {
        const after = new MessageChannel();
        after.port1.onmessage = () => drawn();
        after.port2.postMessage(null);
      }),
    );
    return performance.now() - start;
  }, view);
}

test("a long document switches between the formatted and Markdown views quickly, both ways, as the view out of sight stays laid out, even with a mouse's scroll bars that take room", async () => {
  const run = await openText(bigDocument(), { name: "long.md" });
  const { page } = run;
  // Scroll bars like the ones the Mac shows when a mouse is connected, whatever
  // this Mac's own setting: without room kept for them, the Markdown view came
  // back narrower than it was laid out and took about 80 ms.
  await page.addStyleTag({ content: "::-webkit-scrollbar { width: 15px; height: 15px; } ::-webkit-scrollbar-thumb { background: #888; }" });
  await expect(page.locator(`${EDITOR} .footnote-def`)).toHaveCount(150, { timeout: 10_000 });
  // The first look at the Markdown view lays it out.
  await switchTo(page, "Markdown");
  await page.waitForTimeout(300);
  await switchTo(page, "Formatted");
  const toMarkdown: number[] = [];
  const toFormatted: number[] = [];
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(300);
    toMarkdown.push(await switchTo(page, "Markdown"));
    await page.waitForTimeout(300);
    toFormatted.push(await switchTo(page, "Formatted"));
  }
  const quickest = (times: number[]) => Math.min(...times);
  console.log(`Switching views in a long document, quickest of five: ${quickest(toMarkdown).toFixed(0)} ms to Markdown, ${quickest(toFormatted).toFixed(0)} ms back`);
  // About 15 to 35 ms each way on an M4 Mac mini, against 55 to 110 when the
  // view has to be laid out again.
  expect(quickest(toMarkdown)).toBeLessThan(40);
  expect(quickest(toFormatted)).toBeLessThan(40);
  await run.app.close();
});

/** Type, at a quick typist's pace, timing each key from the press to the frame that shows it (ms). */
async function typeTimed(page: import("@playwright/test").Page, typed: string): Promise<number[]> {
  await page.evaluate(() => {
    const w = window as unknown as { keyTimes: number[]; stopTiming: () => void };
    w.keyTimes = [];
    const onKey = (e: KeyboardEvent) => {
      const pressed = e.timeStamp;
      requestAnimationFrame(() => {
        const after = new MessageChannel();
        after.port1.onmessage = () => w.keyTimes.push(performance.now() - pressed);
        after.port2.postMessage(null);
      });
    };
    addEventListener("keydown", onKey, true);
    w.stopTiming = () => removeEventListener("keydown", onKey, true);
  });
  for (const ch of typed) {
    await page.keyboard.press(ch === " " ? "Space" : ch);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(200);
  return page.evaluate(() => {
    const w = window as unknown as { keyTimes: number[]; stopTiming: () => void };
    w.stopTiming();
    return w.keyTimes;
  });
}

test("typing with History open on a long history (200 passes, about 200 comments) is as quick as with it closed, and the list only updates its newest row", async () => {
  test.setTimeout(120_000);
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  const made: { session?: ReturnType<typeof longSession> } = {};
  const run = await openText("", { name: "plan.md", dataDir, prepare: (folder) => (made.session = longSession({ data: dataDir, file: join(folder, "plan.md") })) });
  const { page } = run;
  const session = made.session!;
  const versions = session.texts.length;
  // The Mac's scroll bars for a mouse, which take room, whatever this Mac's own setting.
  await page.addStyleTag({ content: "::-webkit-scrollbar { width: 15px; height: 15px; } ::-webkit-scrollbar-thumb { background: #888; }" });
  const lastParagraph = session.text().trimEnd().split("\n\n").pop()!.slice(0, 40);
  const cursorAtEnd = async () => {
    await page.locator(`${EDITOR} p`, { hasText: lastParagraph }).click();
    await page.waitForTimeout(60);
    await page.keyboard.press("Meta+ArrowDown");
    await page.waitForTimeout(300);
  };
  const typed = " and a few more words typed here, then some more after them";
  await cursorAtEnd();
  const closed = await typeTimed(page, typed);

  await page.getByRole("button", { name: "History", exact: true }).click();
  const rows = page.locator(".doc:not([hidden]) .history-panel .history-entry");
  await expect(rows).toHaveCount(versions);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const w = window as unknown as { rows: Element[]; changes: number };
    w.rows = [...document.querySelectorAll(".doc:not([hidden]) .history-panel .history-entry")];
    w.changes = 0;
    window.corillo.onHistoryChanged(() => w.changes++);
  });
  await cursorAtEnd();
  const open = await typeTimed(page, typed);
  await expect.poll(() => run.text()).toContain(`${typed}${typed}`);
  await page.waitForTimeout(500);
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(
    `Typing on a long history: median ${median(closed).toFixed(1)} ms with History closed, ${median(open).toFixed(1)} ms open; slowest ${Math.max(...closed).toFixed(1)} and ${Math.max(...open).toFixed(1)} ms`,
  );
  // Saves while typing changed the history (at least one every 1.6 seconds of typing)...
  expect(await page.evaluate(() => (window as unknown as { changes: number }).changes)).toBeGreaterThanOrEqual(2);
  // ...and the list kept every row: only the newest version's time moved.
  await expect(rows).toHaveCount(versions);
  expect(await page.evaluate(() => (window as unknown as { rows: Element[] }).rows.every((row) => row.isConnected))).toBe(true);
  await expect(rows.first().locator(".history-when")).toHaveText("Just now");
  // The typing budget: as for typing in a long document, 9 keys in 10 under 100 ms (one pause on a busy Mac
  // doesn't decide), and about as quick as with History closed.
  const ninetieth = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)];
  expect(ninetieth(open)).toBeLessThan(100);
  expect(median(open)).toBeLessThan(Math.max(2 * median(closed), median(closed) + 10));
  await run.app.close();
});

/** The window's layout work so far (laying out the page: lines, sizes, places), in ms. */
async function layoutSoFar(cdp: import("@playwright/test").CDPSession): Promise<number> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return metrics.find((m) => m.name === "LayoutDuration")!.value * 1000;
}

test("going back to a long document from a version in History, or restoring one, doesn't lay the whole document out again", async () => {
  const run = await openText(bigDocument(), { name: "long.md" });
  const { page } = run;
  // The Mac's scroll bars for a mouse, which take room, whatever this Mac's own setting.
  await page.addStyleTag({ content: "::-webkit-scrollbar { width: 15px; height: 15px; } ::-webkit-scrollbar-thumb { background: #888; }" });
  await expect(page.locator(`${EDITOR} .footnote-def`)).toHaveCount(150, { timeout: 10_000 });
  // An agent's pass: a version to look back from.
  const { session } = await AgentSession.start(run.dataDir);
  try {
    await session.ok("take_document", { path: run.file });
    await session.ok("edit_document", { path: run.file, edits: [{ find: "### 2.2 ", replace: "### 2.2 Revised " }] });
    await session.ok("finish_editing", { path: run.file });
  } finally {
    await session.stop();
  }
  await expect(page.locator(EDITOR)).toContainText("2.2 Revised");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const banner = page.locator(".doc:not([hidden]) .version-banner");
  const press = (selector: string) => page.evaluate((s) => document.querySelector<HTMLElement>(s)!.click(), selector);
  /** The layout work an action takes, until what it shows is on screen. */
  const layoutFor = async (act: () => Promise<void>) => {
    const before = await layoutSoFar(cdp);
    await act();
    await page.evaluate(() => new Promise<void>((drawn) => requestAnimationFrame(() => setTimeout(drawn, 0))));
    return (await layoutSoFar(cdp)) - before;
  };

  // Showing a version lays out its whole page: the yardstick.
  const shown: number[] = [];
  const back: number[] = [];
  for (let i = 0; i < 3; i++) {
    shown.push(
      await layoutFor(async () => {
        await press(".history-tools button[aria-label='Show changes']");
        await expect(page.locator(".doc:not([hidden]) .version-view .footnote-def")).toHaveCount(150);
      }),
    );
    back.push(
      await layoutFor(async () => {
        await press(".doc:not([hidden]) .version-banner .back-to-current");
        await expect(banner).toBeHidden();
        await expect(page.locator(EDITOR)).toBeVisible();
      }),
    );
  }
  // Looking at the first version, then restoring it.
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator(".doc:not([hidden]) .history-item").filter({ hasText: "First version" }).click();
  await expect(banner).toContainText("Version from");
  const restore = await layoutFor(async () => {
    await press(".doc:not([hidden]) .version-banner .restore-version");
    await expect(banner).toBeHidden();
    await expect(page.locator(`${EDITOR} h3`, { hasText: /^2\.2 / })).not.toContainText("Revised");
  });
  const full = Math.max(...shown);
  console.log(`Layout work, long document: ${full.toFixed(1)} ms to show a version; back ${Math.min(...back).toFixed(1)} ms, restore ${restore.toFixed(1)} ms`);
  // Both were about as much as laying the version out (25 to 30 ms on the Mac
  // mini) when the document was taken apart while a version showed; now 1 to 3.
  expect(Math.min(...back)).toBeLessThan(full / 4);
  expect(restore).toBeLessThan(full / 4);
  await run.app.close();
});

test("copying all of a long document, or Copy for Email, is quick", async () => {
  const run = await openText(bigDocument(), { name: "long.md" });
  const { app, page } = run;
  const written = await captureClipboardWrites(app);
  await expect(page.locator(`${EDITOR} .footnote-def`)).toHaveCount(150, { timeout: 10_000 });
  await page.locator(`${EDITOR} h1`).first().click();
  await page.keyboard.press("Meta+A");
  /** How long the window takes to write the copy, in ms. */
  const copyAll = () =>
    page.evaluate((editor) => {
      const start = performance.now();
      document.querySelector(`${editor} .ProseMirror`)!.dispatchEvent(
        new ClipboardEvent("copy", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }),
      );
      return performance.now() - start;
    }, EDITOR);
  const copyForEmail = async () => {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const item = page.getByRole("menu", { name: "Export" }).getByRole("menuitem", { name: "Copy for email" });
    return item.evaluate((b: HTMLElement) => {
      const start = performance.now();
      b.click();
      return performance.now() - start;
    });
  };
  const all: number[] = [];
  const forEmail: number[] = [];
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(200);
    all.push(await copyAll());
    await page.waitForTimeout(200);
    forEmail.push(await copyForEmail());
  }
  // Every word was copied: the last footnote is the last thing in the email.
  await expect.poll(async () => (await written())?.["text/plain"]).toMatch(/\[\^[^\]]+\]: [^\n]+$/);
  const quickest = (times: number[]) => Math.min(...times);
  console.log(`Copying a long document, quickest of five: ${quickest(all).toFixed(0)} ms all of it, ${quickest(forEmail).toFixed(0)} ms for email`);
  // About 7 to 16 ms and 5 ms on an M4 Mac mini; a tenth of a second still feels instant.
  expect(quickest(all)).toBeLessThan(100);
  expect(quickest(forEmail)).toBeLessThan(100);
  await run.app.close();
});

/**
 * A history of `rounds` rounds, each an agent's pass and then the person's
 * edit, each rewriting a long paragraph, so the record of older versions is
 * long (over a megabyte at 250 rounds). Then the same last round whatever
 * `rounds`: Claude's pass, and the person's edit after it, which Show changes
 * walks back past. The text it leaves is the same too.
 */
function roundsBefore(data: string, file: string, rounds: number): string {
  const rand = numbers(5);
  let time = Date.parse("2026-11-09T09:00:00Z");
  const h = new VersionHistory(data, () => new Date((time += 60_000)));
  const paragraph = () => Array.from({ length: 30 }, () => sentenceFrom(rand)).join(" ");
  const [one, two, other] = [paragraph(), paragraph(), paragraph()];
  const doc = (middle: string, end: string) => `# Plan\n\n${one}\n\n${middle}\n\n${end}\n`;
  let text = doc(two, "The budget is tight.");
  writeFileSync(file, text);
  const id = h.idFor(file);
  h.seen(id, text);
  const pass = (next: string) => {
    h.beginPass(id, "Claude");
    h.edited(id, next);
    h.endPass(id, { addressed: [] });
  };
  for (let i = 0; i < rounds; i++) {
    pass(doc(other, "The budget is tight."));
    h.edited(id, doc(two, "The budget is tight."));
  }
  pass(doc(two, "The budget is very tight."));
  text = doc(two, "The budget is very tight. Mine.");
  h.edited(id, text);
  writeFileSync(file, text);
  return text;
}

test("Show changes after the person's edit is as quick on a long history as on a short one: it reads only the versions it walks back through (B3-R08)", async () => {
  test.setTimeout(120_000);
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  let longText = "";
  const run = await openText("", {
    name: "short.md",
    dataDir,
    prepare: (folder) => {
      roundsBefore(dataDir, join(folder, "short.md"), 5);
      longText = roundsBefore(dataDir, join(folder, "long.md"), 250);
    },
  });
  const { page } = run;
  await openAlso(run, "long.md", longText);
  await expect(page.locator(".tab")).toHaveCount(2);
  const idOf = (name: string) =>
    page.evaluate((n) => [...document.querySelectorAll<HTMLElement>(".tabs .tab")].find((t) => t.title.endsWith(`/${n}`))!.dataset.docId!, name);
  const ids = { short: await idOf("short.md"), long: await idOf("long.md") };
  /** How long Corillo takes to work out what Show changes shows ten times over, in ms (a single time is too short for the clock), and what it found. */
  const since = (id: string) =>
    page.evaluate(async (docId) => {
      const start = performance.now();
      let facts = await window.corillo.historySince(docId);
      for (let i = 1; i < 10; i++) facts = await window.corillo.historySince(docId);
      return { ms: performance.now() - start, agents: facts.agents, steps: facts.steps.length, base: facts.base };
    }, id);
  const short: number[] = [];
  const long: number[] = [];
  for (let i = 0; i < 5; i++) {
    const a = await since(ids.short);
    const b = await since(ids.long);
    // Both show the same: Claude's last pass, then the person's edit.
    expect(b.agents).toEqual(["Claude"]);
    expect(b.steps).toBe(2);
    expect(b.base).toBe(a.base);
    short.push(a.ms);
    long.push(b.ms);
  }
  const quickest = (times: number[]) => Math.min(...times);
  console.log(`Show changes ten times, quickest of five: ${quickest(short).toFixed(1)} ms after 5 rounds, ${quickest(long).toFixed(1)} ms after 250`);
  // Reading the whole record of older versions made it about 17 times slower on the long history (3.5 ms
  // a time against 0.2 on an M4 Mac mini); now only the list of versions, a few bytes each, is longer.
  expect(quickest(long)).toBeLessThan(4 * quickest(short));
  await run.app.close();
});

test("an agent's edit arriving in a 9,000-word document under review shows as an edit, far quicker than reading the page again", async () => {
  test.setTimeout(120_000);
  const run = await openText(bigDocument(9), { name: "long.md" });
  const { page, app } = run;
  // The Mac's scroll bars for a mouse, which take room, whatever this Mac's own setting.
  await page.addStyleTag({ content: "::-webkit-scrollbar { width: 15px; height: 15px; } ::-webkit-scrollbar-thumb { background: #888; }" });
  await expect(page.locator(`${EDITOR} .footnote-def`)).toHaveCount(45, { timeout: 10_000 });
  // Under review: comments on three headings far down, line numbers, the outline, Find open on a word.
  await clickMenu(app, "line-numbers");
  await clickMenu(app, "view-outline");
  for (const heading of [/^8\.2 /, /^8\.6 /, /^9\.1 /]) {
    await page.locator(`${EDITOR} h3`, { hasText: heading }).click();
    await page.keyboard.press("Shift+End");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.getByRole("textbox", { name: "New comment" }).fill(`About ${heading.source.slice(1, 4)}.`);
    await page.getByRole("button", { name: "Post" }).click();
  }
  await expect(page.locator(".doc:not([hidden]) aside.comments-panel .comment-card:not(.draft)")).toHaveCount(3);
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("budget");
  // Reading near the end.
  await page.locator(".doc:not([hidden]) .canvas").evaluate((c) => (c.scrollTop = c.scrollHeight - 2 * c.clientHeight));
  await page.waitForTimeout(500);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const busy = async () => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration")!.value * 1000;
  const { session } = await AgentSession.start(run.dataDir);
  try {
    await session.ok("take_document", { path: run.file });
    await session.ok("read_document", { path: run.file });
    const times = { edit: [] as number[], reload: [] as number[] };
    const work = { edit: [] as number[], reload: [] as number[] };
    let current = "### 3.2 ";
    for (let i = 0; i < 12; i++) {
      // Taking turns (edit, read again, read again, edit, ...), so a busy moment on the Mac falls on both.
      const way = i % 4 === 0 || i % 4 === 3 ? "edit" : "reload";
      const next = `### 3.2 Agent ${i} `;
      await page.evaluate(
        ([editor, marker, again]) => {
          const w = window as unknown as { corilloTests: { readAgain: boolean }; arrived: Promise<number>; title: unknown };
          w.corilloTests.readAgain = again;
          const root = document.querySelector(`${editor} .ProseMirror`)!;
          // The title in the document the editor shows (its own record of it): kept by an edit, made anew when read again.
          w.title = (root as unknown as { pmViewDesc: { node: { firstChild: unknown } } }).pmViewDesc.node.firstChild;
          w.arrived = new Promise<number>((resolve) => {
            const observer = new MutationObserver(() => {
              if (!(root.textContent ?? "").includes(marker)) return;
              observer.disconnect();
              // On screen: the frame after the change has been drawn.
              requestAnimationFrame(() => {
                const after = new MessageChannel();
                after.port1.onmessage = () => resolve(performance.timeOrigin + performance.now());
                after.port2.postMessage(null);
              });
            });
            observer.observe(root, { childList: true, subtree: true, characterData: true });
          });
        },
        [EDITOR, `Agent ${i} `, way === "reload"] as const,
      );
      await page.waitForTimeout(300);
      const before = await busy();
      const sent = Date.now();
      await session.ok("edit_document", { path: run.file, edits: [{ find: current, replace: next }] });
      const arrived = await page.evaluate(() => (window as unknown as { arrived: Promise<number> }).arrived);
      await page.waitForTimeout(400); // what follows the change on the page (comments, line numbers, the outline) has caught up
      const kept = await page.evaluate(
        (editor) =>
          (document.querySelector(`${editor} .ProseMirror`) as unknown as { pmViewDesc: { node: { firstChild: unknown } } }).pmViewDesc.node.firstChild ===
          (window as unknown as { title: unknown }).title,
        EDITOR,
      );
      expect(kept, `change ${i} shown ${way === "edit" ? "as an edit" : "by reading the page again"}`).toBe(way === "edit");
      times[way].push(arrived - sent);
      work[way].push((await busy()) - before);
      current = next;
    }
    await page.evaluate(() => ((window as unknown as { corilloTests: { readAgain: boolean } }).corilloTests.readAgain = false));
    if ((await session.call("finish_editing", { path: run.file })).isError) await session.ok("finish_editing", { path: run.file });
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    console.log(
      `An agent's edit in a 9,000-word document under review, median of six: on screen in ${median(times.edit).toFixed(0)} ms as an edit, ${median(times.reload).toFixed(0)} ms read again; the window busy ${median(work.edit).toFixed(0)} ms against ${median(work.reload).toFixed(0)} ms`,
    );
    // On an M4 Mac mini, 40 to 45 ms against about 70 on screen, the window busy 32 to 34 ms against about 70.
    // With nothing riding on the page the two take about as long (45 ms on screen): the editor library redraws only
    // what changed either way, and the text was read ahead. So does the Markdown view (55 ms): the text area lays
    // its whole text out again whichever way it changes.
    expect(median(work.edit)).toBeLessThan(0.7 * median(work.reload));
    expect(median(times.edit)).toBeLessThan(median(times.reload));
  } finally {
    await session.stop();
    await run.app.close();
  }
});

// Code review of Batch 16, W16-4 (and B16R-5): after each Undo the window looked through the whole document
// for every comment that had lost its words. Now it looks only at what the Undo put back.
test("an Undo in a long document is as quick with 30 comments that lost their words (each on the common word \"the\") as typing", async () => {
  test.setTimeout(120_000);
  const N = 30;
  const parts = bigDocument(9).split("\n\n");
  parts.splice(Math.floor(parts.length / 2), 0, "Typing goes here.");
  const without = parts.join("\n\n");
  // The same document with an aside after every few blocks, each with a comment on its "the"; another app then took the asides out.
  const step = Math.floor(parts.length / (N + 1));
  for (let i = 0; i < N; i++) parts.splice((i + 1) * step + i, 0, `Aside ${i + 1} holds the note for part ${i + 1}.`);
  const withAsides = parts.join("\n\n");
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  const run = await openText(without, {
    name: "long.md",
    dataDir,
    prepare: (folder) => {
      const h = new VersionHistory(dataDir);
      const comments = new CommentService(h, () => {});
      const file = join(folder, "long.md");
      const id = h.idFor(file);
      h.seen(id, withAsides);
      for (let i = 0; i < N; i++) {
        const at = withAsides.indexOf(` the note for part ${i + 1}.`) + 1;
        comments.add(id, { kind: "person" }, `Note ${i + 1}`, anchorIn(withAsides, at, at + 3), null);
      }
      writeFileSync(file, without);
    },
  });
  const { page } = run;
  await expect(page.locator(".doc:not([hidden]) aside.comments-panel .comment-card[data-thread-id]")).toHaveCount(N);
  await expect(page.locator(`${EDITOR} .comment-range`)).toHaveCount(0);
  await cursorAtEnd(page, "Typing goes here.");
  await page.waitForTimeout(1000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const busy = async () => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration")!.value * 1000;
  /** The window's work for a letter and then this key, in turn, five times. */
  const cost = async (second: string) => {
    const before = await busy();
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("x");
      await page.waitForTimeout(40);
      await page.keyboard.press(second);
      await page.waitForTimeout(40);
    }
    const work = (await busy()) - before;
    await page.waitForTimeout(1200); // the save, outside the count
    return work / 10;
  };
  // Taking turns, so a busy moment on the Mac falls on both.
  const typed: number[] = [];
  const undone: number[] = [];
  for (let r = 0; r < 4; r++) {
    typed.push(await cost("Backspace"));
    undone.push(await cost("Meta+z"));
  }
  await expect(page.locator(`${EDITOR} p`, { hasText: "Typing goes here" })).toHaveText("Typing goes here.");
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(
    `With ${N} comments that lost their words, a key in a long document: ${median(typed).toFixed(1)} ms for a letter and Delete, ${median(undone).toFixed(1)} ms for a letter and Undo`,
  );
  // On an M4 Mac mini, about 10 ms either way; looking through the whole document for each comment made the Undo 41.
  expect(median(undone)).toBeLessThan(2 * median(typed) + 3);
  await run.app.close();
});
