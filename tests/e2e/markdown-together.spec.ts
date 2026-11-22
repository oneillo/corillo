// In the Markdown view the text and the preview move together (roadmap
// Batch 6, item 4): whichever half the person scrolls, the other follows, so
// the same part of the document is at about the same height in both; typing
// shows its result beside it; nothing trembles. Each test runs the real app,
// hidden, on throwaway documents and a throwaway data folder.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bigDocument } from "../fixtures/big-document";
import { makePng } from "../fixtures/make-png";
import { clickMenu, launchSettled, openAlso, openText, selectText, type Running } from "./helpers";

const SOURCE = ".doc:not([hidden]) textarea.source";
const PANE = ".doc:not([hidden]) .preview-pane";
const PREVIEW = ".doc:not([hidden]) .page.preview";

let run: Running | null = null;
test.afterEach(async () => {
  await run?.app.close();
  run = null;
});

// The documents ------------------------------------------------------------------------

const WORDS = (
  "budget hiring plan quarter team review draft customer launch market risk goal office travel season " +
  "volunteer event inbox report schedule partner contract design survey pricing training window supplier " +
  "meeting deadline summary policy grant donor website newsletter ticket venue catering permit insurance"
).split(" ");
/** Words of their own for each paragraph, the same every run. */
function words(seed: number, count: number): string {
  let s = seed * 7919 + 17;
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out.push(WORDS[Math.floor(s / 65536) % WORDS.length]);
  }
  return out.join(" ");
}
/** Parts of a document, each a heading and two paragraphs (one long enough to wrap a few times). */
const parts = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => {
    const n = from + i;
    return `## Part ${n}\n\nPart ${n}, first: ${words(n, 50)}.\n\nPart ${n}, second: ${words(n + 500, 14)}.`;
  }).join("\n\n");
const PARTS = `# Forty parts\n\n${parts(1, 40)}\n`;

/** A document with a run of headings, a long table, a picture, a diagram and a long code block, in the middle of plain parts. */
const MIXED = [
  "# Mixed",
  parts(1, 8),
  "## First of a run\n\n### Second of a run\n\n#### Third of a run",
  `Before the table: ${words(900, 20)}.`,
  ["| Row | What | Cost |", "|---|---|--:|", ...Array.from({ length: 20 }, (_, i) => `| Row ${i + 1} | ${words(i + 700, 3)} | ${(i + 1) * 125} |`)].join("\n"),
  "![A chart](pictures/chart.png)",
  `After the picture: ${words(901, 30)}.`,
  "```mermaid\ngraph LR\n  A[Ask] --> B[Draft]\n  B --> C{Review}\n  C --> D[Send]\n```",
  `After the diagram: ${words(902, 30)}.`,
  ["```js", ...Array.from({ length: 30 }, (_, i) => `const line${i + 1} = "code line ${i + 1}";`), "```"].join("\n"),
  `After the code: ${words(903, 30)}.`,
  parts(9, 16),
].join("\n\n") + "\n";
const withPicture = (folder: string) => {
  mkdirSync(join(folder, "pictures"));
  writeFileSync(join(folder, "pictures", "chart.png"), makePng(600, 300));
};

// Where things are --------------------------------------------------------------------

/**
 * A copy of the Markdown text box, the same kind of box set the same way and
 * never seen, holding the text up to a place: where the line that place is on
 * starts, from the top of the text (in the text's own pixels). Kept in the
 * window, for the measures below.
 */
type Probe = (area: HTMLTextAreaElement, upTo: number) => number;
function setUpProbe(page: Page): Promise<void> {
  return page.evaluate(() => {
    (window as unknown as { probe: Probe }).probe = (area, upTo) => {
      const style = getComputedStyle(area);
      const probe = area.cloneNode(false) as HTMLTextAreaElement;
      probe.removeAttribute("aria-label");
      Object.assign(probe.style, { position: "absolute", left: "0", top: "0", visibility: "hidden", height: "0", minHeight: "0", width: style.width, scrollTimeline: "none" });
      area.parentElement!.append(probe);
      probe.value = area.value.slice(0, upTo);
      const top = probe.scrollHeight - parseFloat(style.paddingBottom) - parseFloat(style.lineHeight);
      probe.remove();
      return top;
    };
  });
}

/** Where the line with these words starts in the Markdown text, on screen, worked out afresh on a copy of the text box. */
function inText(page: Page, wanted: string): Promise<number> {
  return page.locator(SOURCE).evaluate((area: HTMLTextAreaElement, wanted) => {
    const at = area.value.indexOf(wanted);
    if (at < 0) throw new Error(`Not in the text: ${wanted}`);
    const top = (window as unknown as { probe: Probe }).probe(area, at + wanted.length);
    const box = area.getBoundingClientRect();
    const zoom = box.height / area.offsetHeight;
    return box.top + (top - area.scrollTop) * zoom;
  }, wanted);
}

/** Where the line with these words starts in the preview, on screen. */
function inPreview(page: Page, wanted: string): Promise<number> {
  return page.evaluate(([preview, wanted]) => {
    const walk = document.createTreeWalker(document.querySelector(preview)!, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const at = node.textContent!.indexOf(wanted);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + wanted.length);
      const words = range.getClientRects()[0];
      const holder = node.parentElement!;
      const line = parseFloat(getComputedStyle(holder).lineHeight) * holder.currentCSSZoom;
      return words.top - (line > words.height ? (line - words.height) / 2 : 0);
    }
    throw new Error(`Not in the preview: ${wanted}`);
  }, [PREVIEW, wanted] as const);
}

/** Each half: how far it's scrolled, how far it can be, and its middle on screen. */
function halves(page: Page) {
  return page.evaluate(([source, pane]) => {
    const of = (el: HTMLElement) => {
      const box = el.getBoundingClientRect();
      return { at: el.scrollTop, end: el.scrollHeight - el.clientHeight, middle: box.top + box.height / 2, top: box.top, bottom: box.bottom };
    };
    return { text: of(document.querySelector<HTMLElement>(source)!), preview: of(document.querySelector<HTMLElement>(pane)!) };
  }, [SOURCE, PANE] as const);
}

/** Wait until neither half has moved for ten frames running. */
async function still(page: Page): Promise<void> {
  await page.evaluate(([source, pane]) => new Promise<void>((done) => {
    const a = document.querySelector(source)!;
    const b = document.querySelector(pane)!;
    let last = "";
    let same = 0;
    const look = () => {
      const now = `${a.scrollTop} ${b.scrollTop}`;
      same = now === last ? same + 1 : 0;
      last = now;
      if (same >= 10) done();
      else requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  }), [SOURCE, PANE] as const);
}

/** The person scrolls one half with the mouse wheel (or trackpad), by this much. */
async function wheel(page: Page, over: string, by: number): Promise<void> {
  const box = (await page.locator(over).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, by);
  await still(page);
}

/** Scroll the text until these words are in its middle, as the person would. */
async function textToMiddle(page: Page, wanted: string): Promise<void> {
  await wheel(page, SOURCE, Math.round((await inText(page, wanted)) - (await halves(page)).text.middle));
}

async function toMarkdown(page: Page): Promise<void> {
  await setUpProbe(page);
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.locator(`${PREVIEW} h1`)).toBeVisible();
  await still(page);
}

/** The line at the top of the text, and how far into it, worked out afresh on a copy of the text box. */
function lineAtTop(page: Page): Promise<{ line: number; into: number }> {
  return page.locator(SOURCE).evaluate((area: HTMLTextAreaElement) => {
    const topOf = (window as unknown as { probe: Probe }).probe;
    const starts = [0];
    for (let i = area.value.indexOf("\n"); i >= 0; i = area.value.indexOf("\n", i + 1)) starts.push(i + 1);
    // The first line of the text whose next line starts below the top.
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (topOf(area, starts[mid]) <= area.scrollTop) lo = mid;
      else hi = mid - 1;
    }
    const top = topOf(area, starts[lo]);
    const next = lo + 1 < starts.length ? topOf(area, starts[lo + 1]) : area.scrollHeight;
    return { line: lo + 1, into: Math.round(((area.scrollTop - top) / (next - top)) * 100) / 100 };
  });
}

// The tests --------------------------------------------------------------------------------

test("scrolling the text, the preview follows: a heading in the middle of the text is at the same height in the preview", async () => {
  run = await openText(PARTS);
  const { page } = run;
  await page.setViewportSize({ width: 1280, height: 800 });
  await toMarkdown(page);
  for (const part of [12, 20, 31, 17, 6]) {
    await textToMiddle(page, `## Part ${part}`);
    const text = await inText(page, `## Part ${part}`);
    expect(Math.abs(text - (await halves(page)).text.middle), "the wheel put it in the middle").toBeLessThan(12);
    expect(Math.abs((await inPreview(page, `Part ${part}`)) - text), `Part ${part}`).toBeLessThan(12);
  }
});

test("scrolling the preview, the text follows: a heading in the middle of the preview is at the same height in the text", async () => {
  run = await openText(PARTS);
  const { page } = run;
  await page.setViewportSize({ width: 1280, height: 800 });
  await toMarkdown(page);
  for (const part of [14, 27, 9, 22]) {
    await wheel(page, PANE, Math.round((await inPreview(page, `Part ${part}`)) - (await halves(page)).preview.middle));
    const preview = await inPreview(page, `Part ${part}`);
    expect(Math.abs(preview - (await halves(page)).preview.middle), "the wheel put it in the middle").toBeLessThan(12);
    expect(Math.abs((await inText(page, `## Part ${part}`)) - preview), `Part ${part}`).toBeLessThan(12);
  }
});

test("at the top of one half the other is at its top, and at the end of one, the other is at its end", async () => {
  run = await openText(PARTS);
  const { page } = run;
  await page.setViewportSize({ width: 1280, height: 800 });
  await toMarkdown(page);
  for (const over of [SOURCE, PANE, SOURCE]) {
    await wheel(page, over, 100_000);
    let { text, preview } = await halves(page);
    expect(text.at).toBeCloseTo(text.end, 0);
    expect(preview.at).toBeCloseTo(preview.end, 0);
    await wheel(page, over, -100_000);
    ({ text, preview } = await halves(page));
    expect(text.at).toBe(0);
    expect(preview.at).toBe(0);
  }
});

test("nothing trembles: after a scroll, each half moves only the way the person scrolled, then both stay still", async () => {
  run = await openText(PARTS);
  const { page } = run;
  await page.setViewportSize({ width: 1280, height: 800 });
  await toMarkdown(page);
  await wheel(page, SOURCE, 2000);
  for (const [over, by] of [[SOURCE, 900], [PANE, -700], [SOURCE, -500], [PANE, 1200]] as const) {
    const start = await halves(page);
    // Both halves, every frame, from the scroll until well after.
    await page.evaluate(([source, pane]) => {
      const a = document.querySelector(source)!;
      const b = document.querySelector(pane)!;
      const seen: [number, number][] = [];
      (window as unknown as { seen: typeof seen }).seen = seen;
      const look = () => {
        seen.push([a.scrollTop, b.scrollTop]);
        if (seen.length < 90) requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    }, [SOURCE, PANE] as const);
    const box = (await page.locator(over).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, by);
    await expect.poll(() => page.evaluate(() => (window as unknown as { seen: unknown[] }).seen.length), { timeout: 10_000 }).toBe(90);
    const seen = await page.evaluate(() => (window as unknown as { seen: [number, number][] }).seen);
    const way = Math.sign(by);
    for (let i = 1; i < seen.length; i++) {
      expect((seen[i][0] - seen[i - 1][0]) * way, `the text, frame ${i}`).toBeGreaterThanOrEqual(-0.5);
      expect((seen[i][1] - seen[i - 1][1]) * way, `the preview, frame ${i}`).toBeGreaterThanOrEqual(-0.5);
    }
    // Still over the last half second or so.
    for (const frame of seen.slice(-30)) expect(frame).toEqual(seen[seen.length - 1]);
    // The half the person scrolled went exactly as far as they scrolled it.
    const end = await halves(page);
    const moved = over === SOURCE ? end.text.at - start.text.at : end.preview.at - start.preview.at;
    expect(moved).toBeCloseTo(by, 0);
  }
});

test("typing far down a 9,000-word document shows the change in the preview, beside the line being typed, without scrolling", async () => {
  run = await openText(bigDocument(9), { name: "long.md" });
  const { page } = run;
  await page.setViewportSize({ width: 1280, height: 800 });
  await toMarkdown(page);
  const area = page.locator(SOURCE);
  // The cursor at the end of a paragraph well down, the text scrolled so it's in the middle.
  const end = await area.evaluate((a: HTMLTextAreaElement) => {
    const heading = a.value.indexOf("### 7.3 ");
    return a.value.indexOf("\n\n", a.value.indexOf("\n\n", heading) + 2);
  });
  const lastWords = await area.evaluate((a: HTMLTextAreaElement, end) => a.value.slice(end - 12, end), end);
  await textToMiddle(page, lastWords);
  await area.evaluate((a: HTMLTextAreaElement, end) => {
    a.focus({ preventScroll: true });
    a.setSelectionRange(end, end);
  }, end);
  await still(page);
  const before = await halves(page);
  await page.keyboard.type(" Zanzibar quokka");
  await expect(page.locator(PREVIEW)).toContainText("Zanzibar quokka");
  await still(page);
  const after = await halves(page);
  expect(after.text.at, "the text didn't move").toBe(before.text.at);
  const typed = await inText(page, "Zanzibar quokka");
  const shown = await inPreview(page, "Zanzibar quokka");
  expect(shown).toBeGreaterThan(after.preview.top);
  expect(shown).toBeLessThan(after.preview.bottom - 20);
  // The preview's lines are longer than the text's, so the words may be a line or two from level.
  expect(Math.abs(shown - typed)).toBeLessThan(60);
});

test("a document with a run of headings, a long table, a picture, a diagram and a code block: each part in the middle of the text is level in the preview", async () => {
  run = await openText(MIXED, { prepare: withPicture });
  const { page } = run;
  await page.setViewportSize({ width: 1280, height: 800 });
  await toMarkdown(page);
  await expect(page.locator(`${PREVIEW} img[alt="A chart"]`)).toHaveJSProperty("complete", true);
  const landmarks: [string, string][] = [
    ["### Second of a run", "Second of a run"],
    ["#### Third of a run", "Third of a run"],
    ["| Row 4 |", "Row 4"],
    ["| Row 15 |", "Row 15"],
    ["After the picture:", "After the picture:"],
    ["After the diagram:", "After the diagram:"],
    ['"code line 12"', '"code line 12"'],
    ['"code line 27"', '"code line 27"'],
    ["After the code:", "After the code:"],
  ];
  for (const [inTheText, inThePreview] of landmarks) {
    await textToMiddle(page, inTheText);
    // The diagram is drawn once it comes near the screen, a moment later: the preview lines up again.
    if (inTheText === "After the diagram:") {
      await expect(page.locator(`${PREVIEW} .diagram svg`)).toBeVisible();
      await still(page);
    }
    const text = await inText(page, inTheText);
    expect(Math.abs(text - (await halves(page)).text.middle), "the wheel put it in the middle").toBeLessThan(12);
    expect(Math.abs((await inPreview(page, inThePreview)) - text), inTheText).toBeLessThan(16);
  }
});

test("a picture growing in the preview (as one coming in late does) lines the preview up again, and the text doesn't move", async () => {
  run = await openText(MIXED, { prepare: withPicture });
  const { page } = run;
  await page.setViewportSize({ width: 1280, height: 800 });
  await toMarkdown(page);
  await expect(page.locator(`${PREVIEW} img[alt="A chart"]`)).toHaveJSProperty("complete", true);
  await textToMiddle(page, "After the code:");
  const before = await halves(page);
  await page.locator(`${PREVIEW} img[alt="A chart"]`).evaluate((img: HTMLImageElement) => (img.style.height = "700px"));
  await still(page);
  expect((await halves(page)).text.at).toBe(before.text.at);
  expect(Math.abs((await inPreview(page, "After the code:")) - (await inText(page, "After the code:")))).toBeLessThan(16);
});

test("in a narrow window, the halves still move together, end to end", async () => {
  run = await openText(PARTS);
  const { page, app } = run;
  await page.setViewportSize({ width: 720, height: 700 });
  // With the comments hidden, so there's room for both halves (with them, the preview gives way: roadmap Batch 11, F-18).
  await clickMenu(app, "view-comments");
  await toMarkdown(page);
  for (const part of [8, 25, 33]) {
    await textToMiddle(page, `## Part ${part}`);
    const text = await inText(page, `## Part ${part}`);
    expect(Math.abs(text - (await halves(page)).text.middle), "the wheel put it in the middle").toBeLessThan(12);
    expect(Math.abs((await inPreview(page, `Part ${part}`)) - text), `Part ${part}`).toBeLessThan(12);
  }
  await wheel(page, SOURCE, 100_000);
  let { text, preview } = await halves(page);
  expect(text.at).toBeCloseTo(text.end, 0);
  expect(preview.at).toBeCloseTo(preview.end, 0);
  await wheel(page, PANE, -100_000);
  ({ text, preview } = await halves(page));
  expect(text.at).toBe(0);
  expect(preview.at).toBe(0);
});

test("resizing the window, dragging the line between the halves, zooming, Page Width and the comments panel keep the text's place, and the preview lines up again", async () => {
  run = await openText(PARTS);
  const { page, app } = run;
  await page.setViewportSize({ width: 1280, height: 800 });
  await toMarkdown(page);
  // The cursor on a heading near the top of the text (so it stays in sight as the text wraps anew): its result is beside it.
  await wheel(page, SOURCE, Math.round((await inText(page, "## Part 20")) - (await halves(page)).text.top - 150));
  const at = await inText(page, "## Part 20");
  const box = (await page.locator(SOURCE).boundingBox())!;
  await page.mouse.click(box.x + 120, at + 8);
  await still(page);
  const level = async (what: string) => {
    const text = await inText(page, "## Part 20");
    const { text: half } = await halves(page);
    expect(text > half.top && text < half.bottom - 20, `${what}: the heading still in sight`).toBe(true);
    expect(Math.abs((await inPreview(page, "Part 20")) - text), what).toBeLessThan(12);
  };
  await level("clicked");
  const changes: [string, () => Promise<unknown>][] = [
    ["a narrower window", () => page.setViewportSize({ width: 1000, height: 800 })],
    ["a shorter window", () => page.setViewportSize({ width: 1000, height: 600 })],
    ["the line between the halves dragged", async () => {
      const line = page.getByRole("separator", { name: "Markdown text width" });
      const handle = (await line.boundingBox())!;
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2 - 120, handle.y + handle.height / 2, { steps: 6 });
      await page.mouse.up();
    }],
    ["zoomed in", () => clickMenu(app, "zoom-in")],
    ["Page Width: Wide", () => clickMenu(app, "page-width-fill")],
    ["the comments panel", () => clickMenu(app, "view-comments")],
  ];
  for (const [what, change] of changes) {
    const top = await lineAtTop(page);
    await change();
    await still(page);
    const now = await lineAtTop(page);
    expect(now.line, `${what}: the same line at the top of the text`).toBe(top.line);
    expect(Math.abs(now.into - top.into), what).toBeLessThan(0.2);
    await level(what);
  }
});

test("Find brings a match far down into sight in the text, with its result beside it in the preview", async () => {
  run = await openText(PARTS);
  const { page } = run;
  await page.setViewportSize({ width: 1280, height: 800 });
  await toMarkdown(page);
  await page.keyboard.press("Meta+F");
  await page.getByRole("textbox", { name: "Find", exact: true }).fill("Part 33, second");
  await still(page);
  const { text: textHalf, preview: previewHalf } = await halves(page);
  const text = await inText(page, "Part 33, second");
  const preview = await inPreview(page, "Part 33, second");
  expect(text > textHalf.top && text < textHalf.bottom - 20).toBe(true);
  expect(preview > previewHalf.top && preview < previewHalf.bottom - 20).toBe(true);
  expect(Math.abs(preview - text)).toBeLessThan(12);
});

// Review of Batch 6, B6-R04: "the half he's scrolling is never pulled back", straight after typing too. (Before,
// the first step of a scroll made within a moment of typing put the preview back beside the cursor.)
test("scrolling the preview straight after typing: it moves only the way the person scrolls it, and as far", async () => {
  run = await openText(PARTS);
  const { page } = run;
  await page.setViewportSize({ width: 1280, height: 800 });
  await toMarkdown(page);
  await textToMiddle(page, "## Part 20");
  await page.locator(SOURCE).evaluate((a: HTMLTextAreaElement) => {
    const at = a.value.indexOf("\n", a.value.indexOf("## Part 20"));
    a.focus({ preventScroll: true });
    a.setSelectionRange(at, at);
  });
  await still(page);
  // The preview a little away from beside the cursor, as after scrolling it.
  await wheel(page, PANE, 300);
  const box = (await page.locator(PANE).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const start = await halves(page);
  await page.evaluate((pane) => {
    const b = document.querySelector(pane)!;
    const seen: number[] = [];
    (window as unknown as { seen: number[] }).seen = seen;
    const look = () => {
      seen.push(b.scrollTop);
      if (seen.length < 90) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  }, PANE);
  await page.keyboard.type(" now");
  await page.mouse.wheel(0, 600);
  await expect.poll(() => page.evaluate(() => (window as unknown as { seen: unknown[] }).seen.length), { timeout: 10_000 }).toBe(90);
  const seen = await page.evaluate(() => (window as unknown as { seen: number[] }).seen);
  for (let i = 1; i < seen.length; i++) expect(seen[i] - seen[i - 1], `the preview, frame ${i}`).toBeGreaterThanOrEqual(-0.5);
  await still(page);
  expect((await halves(page)).preview.at - start.preview.at).toBeCloseTo(600, 0);
  await expect(page.locator(PREVIEW)).toContainText("Part 20 now");
});

// Review of Batch 6, B6-R05: coming to the Markdown view puts the preview beside the cursor, also after the window
// changed size while the formatted view was in front. (Before, that counted as the text wrapping anew, and the
// preview only followed the text's scroll.)
test("after the window is resized in the formatted view, switching to the Markdown view puts the cursor's line level with its result", async () => {
  run = await openText(PARTS);
  const { page } = run;
  await page.setViewportSize({ width: 1280, height: 800 });
  await toMarkdown(page);
  await page.getByRole("button", { name: "Formatted", exact: true }).click();
  await page.setViewportSize({ width: 1060, height: 800 });
  for (const part of [31, 9]) {
    await selectText(page, `Part ${part}, second`);
    await page.keyboard.press("ArrowRight");
    await page.getByRole("button", { name: "Markdown", exact: true }).click();
    await still(page);
    const text = await inText(page, `Part ${part}, second`);
    const { text: half } = await halves(page);
    expect(text > half.top && text < half.bottom - 20, "the cursor's line in sight").toBe(true);
    expect(Math.abs((await inPreview(page, `Part ${part}, second`)) - text), `Part ${part}`).toBeLessThan(12);
    await page.getByRole("button", { name: "Formatted", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 800 });
  }
});

test("closing documents scrolled and typed in, in the Markdown view, lets go of everything the halves moving together used", async () => {
  run = await openText("Start.\n");
  const { page } = run;
  await launchSettled(run.app);
  await page.setViewportSize({ width: 1280, height: 800 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const measure = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    await page.waitForTimeout(50);
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    const get = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
    return { nodes: get("Nodes"), listeners: get("JSEventListeners") };
  };
  const usedAndClosed = async (i: number) => {
    await openAlso(run!, `parts ${i}.md`, PARTS);
    await expect(page.locator(".tab")).toHaveCount(2);
    await toMarkdown(page);
    await wheel(page, SOURCE, 1500);
    await wheel(page, PANE, 800);
    await page.locator(SOURCE).click();
    await page.keyboard.type(" more");
    await expect(page.locator(PREVIEW)).toContainText(" more");
    await still(page);
    await page.locator(".tab[aria-selected='true'] .tab-close").click();
    await expect(page.locator(".tab")).toHaveCount(1);
  };
  await usedAndClosed(0);
  await page.waitForTimeout(300);
  const before = await measure();
  for (let i = 1; i <= 6; i++) await usedAndClosed(i);
  await page.waitForTimeout(300);
  const after = await measure();
  // And nothing is left waiting for a frame.
  await page.evaluate(() => {
    const w = window as unknown as { woke: number };
    w.woke = 0;
    const frame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => frame((t) => (w.woke++, cb(t)));
  });
  await page.waitForTimeout(500);
  const woke = await page.evaluate(() => (window as unknown as { woke: number }).woke);
  console.log(`Window after 6 documents closed: ${before.nodes} → ${after.nodes} elements, ${before.listeners} → ${after.listeners} listeners, ${woke} frames`);
  // Each document's copy of its text is a few hundred elements: none may stay.
  expect(after.nodes).toBeLessThan(before.nodes + 200);
  expect(after.listeners).toBeLessThan(before.listeners + 30);
  expect(woke).toBe(0);
});
