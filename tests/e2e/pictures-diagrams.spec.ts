// Pictures (kept in a "<document name> images" folder next to the document)
// and diagrams (written as text, drawn by Corillo).
import { test, expect } from "@playwright/test";
import { copyFileSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openText, expectFile, cursorAtEnd, chooseFromMenu, pickInNextDialog, paste, FIXTURES } from "./helpers";
import { AgentSession } from "./agent-session";
import { makePng } from "../fixtures/make-png";

const PNG = join(FIXTURES, "chart.png");

test("Insert, Picture copies the picture into the document's images folder", async () => {
  const run = await openText("Results.\n");
  await cursorAtEnd(run.page, "Results.");
  await pickInNextDialog(run.app, PNG);
  await chooseFromMenu(run.page, "Insert", "Picture…");
  await expectFile(run, "Results.![chart](proposal%20images/chart.png)\n");
  const copied = join(run.folder, "proposal images", "chart.png");
  expect(readFileSync(copied).equals(readFileSync(PNG))).toBe(true);
  const img = run.page.locator(".ProseMirror .picture img");
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(60);
  await run.app.close();
});

test("an AVIF picture can be inserted too, like any picture the window can show", async () => {
  const run = await openText("Results.\n");
  await cursorAtEnd(run.page, "Results.");
  const avif = join(FIXTURES, "chart.avif");
  await pickInNextDialog(run.app, avif);
  await chooseFromMenu(run.page, "Insert", "Picture…");
  await expectFile(run, "Results.![chart](proposal%20images/chart.avif)\n");
  expect(readFileSync(join(run.folder, "proposal images", "chart.avif")).equals(readFileSync(avif))).toBe(true);
  const img = run.page.locator(".ProseMirror .picture img");
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(60);
  // A picture handed over as data (with no file behind it) is kept as AVIF too.
  const saved = await run.page.evaluate(async (data) => {
    const id = document.querySelector(".doc:not([hidden])")!.getAttribute("data-doc-id")!;
    return window.corillo.saveImageData(id, new Uint8Array(data), "image/avif");
  }, [...readFileSync(avif)]);
  expect(saved).toBe("proposal%20images/Picture.avif");
  await run.app.close();
});

test("an AVIF picture can be pasted or dragged in too, as Insert, Picture takes it", async () => {
  const run = await openText("Pasted here.\n\nDropped here.\n");
  await cursorAtEnd(run.page, "Pasted here.");
  const bytes = [...readFileSync(join(FIXTURES, "chart.avif"))];
  await run.page.evaluate((data) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(data)], "image.avif", { type: "image/avif" }));
    document.querySelector(".ProseMirror")!.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, bytes);
  await expectFile(run, "Pasted here.![Picture](proposal%20images/Picture.avif)\n\nDropped here.\n");
  await run.page.evaluate((data) => {
    const editor = document.querySelector<HTMLElement>(".doc:not([hidden]) .ProseMirror")!;
    const text = [...editor.querySelectorAll("p")].find((p) => p.textContent === "Dropped here.")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, "Dropped here".length);
    const spot = range.getBoundingClientRect();
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(data)], "image.avif", { type: "image/avif" }));
    editor.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, clientX: spot.left, clientY: spot.top + spot.height / 2, bubbles: true, cancelable: true }));
  }, bytes);
  await expectFile(run, "Pasted here.![Picture](proposal%20images/Picture.avif)\n\nDropped here![Picture 2](proposal%20images/Picture%202.avif).\n");
  expect(readdirSync(join(run.folder, "proposal images")).sort()).toEqual(["Picture 2.avif", "Picture.avif"]);
  await run.app.close();
});

test("inserting the same picture twice reuses the copy; a different one with the same name gets a number", async () => {
  const run = await openText("A.\n");
  await cursorAtEnd(run.page, "A.");
  await pickInNextDialog(run.app, PNG);
  await chooseFromMenu(run.page, "Insert", "Picture…");
  await pickInNextDialog(run.app, PNG);
  await chooseFromMenu(run.page, "Insert", "Picture…");
  // A different picture that happens to have the same name.
  const other = join(run.folder, "elsewhere");
  mkdirSync(other);
  copyFileSync(join(FIXTURES, "proposal.md"), join(other, "chart.png"));
  await pickInNextDialog(run.app, join(other, "chart.png"));
  await chooseFromMenu(run.page, "Insert", "Picture…");
  await expect.poll(run.text).toContain("chart%202.png");
  expect(readdirSync(join(run.folder, "proposal images")).sort()).toEqual(["chart 2.png", "chart.png"]);
  await run.app.close();
});

test("pasting a picture saves it in the images folder", async () => {
  const run = await openText("Pasted below.\n");
  await cursorAtEnd(run.page, "Pasted below.");
  const bytes = [...readFileSync(PNG)];
  await run.page.evaluate((data) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(data)], "image.png", { type: "image/png" }));
    document.querySelector(".ProseMirror")!.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, bytes);
  await expectFile(run, "Pasted below.![Picture](proposal%20images/Picture.png)\n");
  expect(existsSync(join(run.folder, "proposal images", "Picture.png"))).toBe(true);
  await run.app.close();
});

test("a picture dropped on the page goes where it was dropped, even if the text moves while it's copied", async () => {
  const run = await openText("First point here.\n\nSecond point here.\n");
  const bytes = [...readFileSync(PNG)];
  await run.page.evaluate((data) => {
    const editor = document.querySelector<HTMLElement>(".doc:not([hidden]) .ProseMirror")!;
    const second = [...editor.querySelectorAll("p")].find((p) => p.textContent === "Second point here.")!;
    const range = document.createRange();
    range.setStart(second.firstChild!, "Second point".length);
    const spot = range.getBoundingClientRect();
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(data)], "image.png", { type: "image/png" }));
    editor.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, clientX: spot.left, clientY: spot.top + spot.height / 2, bubbles: true, cancelable: true }));
    // While the picture is being copied, words are typed at the start of the document.
    const first = editor.querySelector("p")!;
    getSelection()!.collapse(first.firstChild!, 0);
    document.execCommand("insertText", false, "Typed meanwhile. ");
  }, bytes);
  await expectFile(run, "Typed meanwhile. First point here.\n\nSecond point![Picture](proposal%20images/Picture.png) here.\n");
  await run.app.close();
});

test("a picture dropped or pasted as a file while an agent takes the document goes in once the agent is done", async () => {
  const run = await openText("Dropped here.\n\nPasted here.\n");
  // Saving the pictures is slow, until let go: the agent takes the document meanwhile.
  await run.app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const real = handlers.get("image:save-data")!;
    const g = globalThis as unknown as { letGo: () => void };
    const held = new Promise<void>((resolve) => (g.letGo = resolve));
    handlers.set("image:save-data", async (...args: unknown[]) => {
      await held;
      return real(...args);
    });
  });
  const bytes = [...readFileSync(PNG)];
  await run.page.evaluate((data) => {
    const editor = document.querySelector<HTMLElement>(".doc:not([hidden]) .ProseMirror")!;
    const text = [...editor.querySelectorAll("p")].find((p) => p.textContent === "Dropped here.")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, "Dropped here".length);
    const spot = range.getBoundingClientRect();
    const dropped = new DataTransfer();
    dropped.items.add(new File([new Uint8Array(data)], "image.png", { type: "image/png" }));
    editor.dispatchEvent(new DragEvent("drop", { dataTransfer: dropped, clientX: spot.left, clientY: spot.top + spot.height / 2, bubbles: true, cancelable: true }));
    const pasted = [...editor.querySelectorAll("p")].find((p) => p.textContent === "Pasted here.")!.firstChild!;
    getSelection()!.collapse(pasted, "Pasted here.".length);
  }, bytes);
  await run.page.waitForTimeout(100);
  await run.page.evaluate((data) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(data)], "image.png", { type: "image/png" }));
    document.querySelector(".doc:not([hidden]) .ProseMirror")!.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, bytes);
  const { session } = await AgentSession.start(run.dataDir);
  try {
    await session.ok("take_document", { path: run.file });
    await run.app.evaluate(() => (globalThis as unknown as { letGo: () => void }).letGo());
    await expect.poll(() => (existsSync(join(run.folder, "proposal images")) ? readdirSync(join(run.folder, "proposal images")).length : 0)).toBe(2);
    await run.page.waitForTimeout(500);
    // Nothing changes under the agent's feet.
    expect(run.text()).toBe("Dropped here.\n\nPasted here.\n");
    await session.ok("finish_editing", { path: run.file });
    await expectFile(run, "Dropped here![Picture](proposal%20images/Picture.png).\n\nPasted here.![Picture 2](proposal%20images/Picture%202.png)\n");
  } finally {
    await session.stop();
    await run.app.close();
  }
});

// Last look of Batch 12, L-12: in a narrow window the name broke mid-word ("chart.p", then "ng").
test("in a narrow window, a picture that can't be found breaks its name between words, at a slash or a hyphen, never inside a word", async () => {
  const run = await openText("![Chart](Launch%20images/quarterly-chart.png)\n");
  try {
    const box = run.page.locator(".ProseMirror .picture.missing .picture-missing-text");
    await expect(box).toContainText("Picture not found: Launch images/quarterly-chart.png");
    for (const width of [560, 700]) {
      await run.page.setViewportSize({ width, height: 700 });
      await run.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      // Each word (and each part between slashes, or after a hyphen) on one line: its letters' tops all the same.
      const split = await box.evaluate((label) => {
        const nodes: Text[] = [];
        const walk = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
        while (walk.nextNode()) nodes.push(walk.currentNode as Text);
        const out: string[] = [];
        const tops: { ch: string; top: number }[] = [];
        for (const n of nodes) {
          for (let i = 0; i < n.length; i++) {
            const r = document.createRange();
            r.setStart(n, i);
            r.setEnd(n, i + 1);
            const rect = r.getClientRects()[0];
            if (rect) tops.push({ ch: n.data[i], top: Math.round(rect.top) });
          }
        }
        let word = "";
        let top: number | null = null;
        for (const { ch, top: t } of tops) {
          if (ch === " " || ch === "/" || ch === "-") {
            word = "";
            top = null;
            continue;
          }
          if (top !== null && t !== top) out.push(`${word}|${ch}`);
          word += ch;
          top = t;
        }
        return out;
      });
      expect(split, `at ${width}`).toEqual([]);
    }
  } finally {
    await run.app.close();
  }
});

test("a picture that can't be found says so, and Find it… fixes it", async () => {
  const run = await openText("![Logo](logo.png)\n");
  await expect(run.page.locator(".ProseMirror .picture.missing")).toContainText("Picture not found: logo.png");
  await pickInNextDialog(run.app, PNG);
  await run.page.getByRole("button", { name: "Find it…" }).click();
  await expectFile(run, "![Logo](proposal%20images/chart.png)\n");
  await expect(run.page.locator(".ProseMirror .picture.missing")).toHaveCount(0);
  await run.app.close();
});

test("pictures already in the document show, including names with spaces", async () => {
  const text = "![a](<my pics/chart one.png>)\n";
  const run = await openText(text, {
    prepare: (folder) => {
      mkdirSync(join(folder, "my pics"));
      copyFileSync(PNG, join(folder, "my pics", "chart one.png"));
    },
  });
  const img = run.page.locator(".ProseMirror .picture img");
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(60);
  await run.page.waitForTimeout(600);
  expect(run.text()).toBe(text);
  await run.app.close();
});

const DIAGRAM = "Flow:\n\n```mermaid\ngraph LR\n  Ask --> Draft --> Review\n```\n\nEnd.\n";

test("a diagram written as text is drawn, and the file is left alone", async () => {
  const run = await openText(DIAGRAM);
  await expect(run.page.locator(".ProseMirror .diagram-picture svg")).toBeVisible({ timeout: 15000 });
  await expect(run.page.locator(".ProseMirror .diagram-picture")).toContainText("Draft");
  await expect(run.page.locator(".ProseMirror .diagram > pre")).toBeHidden();
  await run.page.waitForTimeout(600);
  expect(run.text()).toBe(DIAGRAM);
  await run.app.close();
});

test("the diagram's code can be shown and edited, and the drawing follows", async () => {
  const run = await openText(DIAGRAM);
  await expect(run.page.locator(".ProseMirror .diagram-picture svg")).toBeVisible({ timeout: 15000 });
  await run.page.locator(".ProseMirror .diagram").hover();
  await run.page.getByRole("button", { name: "Edit diagram code" }).click();
  await expect(run.page.locator(".ProseMirror .diagram > pre")).toBeVisible();
  await run.page.keyboard.type(" --> Send");
  await expect(run.page.locator(".ProseMirror .diagram-picture")).toContainText("Send", { timeout: 15000 });
  await expect.poll(run.text).toBe(DIAGRAM.replace("Review\n", "Review --> Send\n"));
  await run.app.close();
});

test("a diagram with a mistake says so and shows its code", async () => {
  const run = await openText("```mermaid\ngraph LR\n  A -->\n```\n");
  await expect(run.page.locator(".ProseMirror .diagram-error")).toContainText("can't be drawn", { timeout: 15000 });
  await expect(run.page.locator(".ProseMirror .diagram > pre")).toBeVisible();
  // Only Corillo's own note: nothing of the engine's under the status bar.
  const bottom = await run.page.evaluate(() => [document.querySelector(".status-bar")!.getBoundingClientRect().bottom, window.innerHeight]);
  expect(bottom[0]).toBe(bottom[1]);
  await expect(run.page.getByText("Syntax error in text")).toHaveCount(0);
  await run.app.close();
});

test("a diagram open while the Mac switches between light and dark takes the new colours, and so does one drawn after", async () => {
  const run = await openText(DIAGRAM);
  await run.page.emulateMedia({ colorScheme: "light" });
  const fills = () => run.page.locator(".ProseMirror .diagram-picture svg .node rect").evaluateAll((rects) => rects.map((r) => getComputedStyle(r).fill));
  await expect(run.page.locator(".ProseMirror .diagram-picture svg")).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => (await fills()).length).toBeGreaterThan(0);
  const shapes = (await fills()).length;
  const light = (await fills())[0];
  await run.page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(async () => (await fills())[0], { timeout: 15000 }).not.toBe(light);
  const dark = (await fills())[0];
  // The same diagram drawn again in another place (from what was drawn before) is in the dark colours too.
  await cursorAtEnd(run.page, "End.");
  await run.page.keyboard.press("Enter");
  await paste(run.page, { "text/plain": "```mermaid\ngraph LR\n  Ask --> Draft --> Review\n```" });
  await expect.poll(async () => (await fills()).length, { timeout: 15000 }).toBe(2 * shapes);
  expect([...new Set(await fills())]).toEqual([dark]);
  await run.page.emulateMedia({ colorScheme: "light" });
  await expect.poll(async () => [...new Set(await fills())], { timeout: 15000 }).toEqual([light]);
  await run.app.close();
});

test("when the diagram engine doesn't load, the diagram says so (not that it has a mistake), and it's tried again", async () => {
  const run = await openText("Start.\n");
  // The engine's file fails to load the first time it's asked for.
  await run.page.evaluate(() => {
    const head = document.head;
    const append = head.append.bind(head);
    let failed = false;
    head.append = (...nodes: (Node | string)[]) => {
      const script = nodes[0];
      if (!failed && script instanceof HTMLScriptElement && script.src.endsWith("/diagrams.js")) {
        failed = true;
        script.src = script.src.replace(/diagrams\.js$/, "no-such-file.js");
      }
      append(...nodes);
    };
  });
  await cursorAtEnd(run.page, "Start.");
  await run.page.keyboard.press("Enter");
  await paste(run.page, { "text/plain": "```mermaid\ngraph LR\n  Ask --> Draft --> Review\n```" });
  const note = run.page.locator(".ProseMirror .diagram-error");
  await expect(note).toContainText("diagram engine didn't load", { timeout: 15000 });
  await expect(note).not.toContainText("mistake");
  // Coming back to the window tries again, and the diagram is drawn.
  await run.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(run.page.locator(".ProseMirror .diagram-picture svg")).toBeVisible({ timeout: 15000 });
  await expect(note).toHaveCount(0);
  await expect(run.page.locator(".ProseMirror .diagram-picture")).toContainText("Draft");
  await run.app.close();
});

// Pictures follow the disk: one that appears, or is written again under the
// same name (an agent redrawing a chart), shows once Corillo looks again: when
// an agent's change arrives, when its pass ends, or when the window comes back
// to the front. (The window is never really brought to the front in a test:
// it's told it was, as the Mac would tell it.)
const backToFront = (page: import("@playwright/test").Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));
const shownWidth = (page: import("@playwright/test").Page) =>
  page.locator(".ProseMirror .picture img").evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0));

test("a picture that appears on disk after the document opened shows when Corillo comes back to the front", async () => {
  const run = await openText("Chart:\n\n![Chart](proposal%20images/chart.png)\n");
  await expect(run.page.locator(".ProseMirror .picture.missing")).toContainText("Picture not found");
  mkdirSync(join(run.folder, "proposal images"));
  writeFileSync(join(run.folder, "proposal images", "chart.png"), makePng(40, 30));
  await backToFront(run.page);
  await expect(run.page.locator(".ProseMirror .picture.missing")).toHaveCount(0);
  await expect.poll(() => shownWidth(run.page)).toBe(40);
  await run.app.close();
});

test("a picture written again under the same name shows its new self when Corillo comes back to the front", async () => {
  const run = await openText("Chart:\n\n![Chart](proposal%20images/chart.png)\n", {
    prepare: (folder) => {
      mkdirSync(join(folder, "proposal images"));
      writeFileSync(join(folder, "proposal images", "chart.png"), makePng(40, 30));
    },
  });
  await expect.poll(() => shownWidth(run.page)).toBe(40);
  writeFileSync(join(run.folder, "proposal images", "chart.png"), makePng(64, 20));
  await backToFront(run.page);
  await expect.poll(() => shownWidth(run.page)).toBe(64);
  await run.app.close();
});

test("an agent that redraws a picture under the same name: the page shows the new one when its change arrives", async () => {
  const run = await openText("Chart:\n\n![Chart](proposal%20images/chart.png)\n\nThe bars are grey.\n", {
    prepare: (folder) => {
      mkdirSync(join(folder, "proposal images"));
      writeFileSync(join(folder, "proposal images", "chart.png"), makePng(40, 30));
    },
  });
  await expect.poll(() => shownWidth(run.page)).toBe(40);
  const { session } = await AgentSession.start(run.dataDir);
  try {
    await session.ok("take_document", { path: run.file });
    writeFileSync(join(run.folder, "proposal images", "chart.png"), makePng(64, 20));
    await session.ok("edit_document", { path: run.file, edits: [{ find: "The bars are grey.", replace: "The bars are blue." }] });
    await expect(run.page.locator(".ProseMirror")).toContainText("The bars are blue.");
    await expect.poll(() => shownWidth(run.page)).toBe(64);
    // Written again after its last edit: shown once the pass ends.
    writeFileSync(join(run.folder, "proposal images", "chart.png"), makePng(80, 20));
    await session.ok("finish_editing", { path: run.file });
    await expect.poll(() => shownWidth(run.page)).toBe(80);
  } finally {
    await session.stop();
    await run.app.close();
  }
});
