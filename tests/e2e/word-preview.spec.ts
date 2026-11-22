// The page is a preview of the Word document (Orlando, 2026-11-09): how the
// sample document (tests/fixtures/word-preview.md) looks on the page, and what
// the real Export menu makes of it. What Word gets, element by element, is
// checked in tests/unit/word-preview.test.ts.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openText, chooseFromMenu, cursorAtEnd, EDITOR, FIXTURES, type Running } from "./helpers";
import { readZipEntry } from "../../src/main/zip";
import { makePng } from "../fixtures/make-png";

const ROOT = join(import.meta.dirname, "..", "..");
const SAMPLE = readFileSync(join(FIXTURES, "word-preview.md"), "utf8");
const withChart = (folder: string) => copyFileSync(join(FIXTURES, "chart.png"), join(folder, "chart.png"));

test.beforeAll(() => {
  test.setTimeout(600_000);
  execFileSync(process.execPath, [join(ROOT, "scripts", "fetch-pandoc.mjs"), `--arch=${process.arch}`], { stdio: "inherit" });
});

async function exportTo(run: Running, format: "Export to Word" | "PDF", name: string): Promise<string> {
  const out = join(run.folder, name);
  await run.app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
  }, out);
  await chooseFromMenu(run.page, "Export", format);
  await expect(run.page.locator(".export-notice")).toContainText(`Exported to ${name}`, { timeout: 60_000 });
  return out;
}

/** Note the text of each page Corillo prints to PDF. */
async function notePrinted(app: ElectronApplication): Promise<() => Promise<string>> {
  await app.evaluate(({ webContents }) => {
    const g = globalThis as unknown as { printed: string[] };
    g.printed = [];
    const proto = Object.getPrototypeOf(webContents.getAllWebContents()[0]);
    const original = proto.printToPDF;
    proto.printToPDF = async function (this: Electron.WebContents, ...args: unknown[]) {
      g.printed.push(await this.executeJavaScript("document.body.innerText"));
      return original.apply(this, args);
    };
  });
  return async () => (await app.evaluate(() => (globalThis as unknown as { printed: string[] }).printed)).join("\n");
}

test("the sample document reads on the page as it will in Word", async () => {
  test.setTimeout(60_000);
  const run = await openText(SAMPLE, { name: "sample.md", prepare: withChart });
  const { page } = run;
  const look = await page.evaluate((editor) => {
    const root = document.querySelector(`${editor} .ProseMirror`)!;
    const css = (el: Element | null) => (el ? getComputedStyle(el) : null);
    const body = root.querySelector("p")!;
    const size = (el: Element) => parseFloat(getComputedStyle(el).fontSize) / parseFloat(getComputedStyle(body).fontSize);
    const headings = [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")];
    const brs = [...root.querySelectorAll("p")].find((p) => p.textContent!.startsWith("A single line break"));
    const tasks = [...root.querySelectorAll("li.task")];
    const loose = [...root.querySelectorAll("ul")].find((ul) => ul.textContent!.startsWith("Loose"))!;
    const th = root.querySelector("th")!;
    const secondCell = root.querySelector("td + td")!;
    return {
      headingSizes: ["H1", "H2", "H3", "H4", "H5", "H6"].map((tag) => Math.round(size(headings.find((h) => h.tagName === tag)!) * 100) / 100),
      headingColours: [...new Set(headings.map((h) => css(h)!.color))],
      bodyColour: css(body)!.color,
      quoteColour: css(root.querySelector("blockquote"))!.color,
      lines: brs ? (brs as HTMLElement).innerText.split("\n") : [],
      tasks: tasks.map((li) => [li.getAttribute("data-checked"), css(li)!.listStyleType]),
      // The space between its first two items: the blank line between them in the file.
      looseGap: loose.children[1].getBoundingClientRect().top - loose.children[0].getBoundingClientRect().bottom,
      line: parseFloat(css(root)!.getPropertyValue("--line")),
      nestedGap: parseFloat(css(root.querySelector("ul[data-tight] > li > ul"))!.marginBottom),
      headerShade: css(th)!.backgroundColor,
      headerRule: css(th)!.borderBottomStyle,
      cellLine: css(secondCell)!.borderLeftStyle,
      tag: css(root.querySelector(".ob-tag"))!.backgroundColor,
      kinds: [...root.querySelectorAll("pre.raw-block")].map((el) => el.getAttribute("data-kind")),
    };
  }, EDITOR);
  // Headings keep Word's sizes against the body text (18, 14, 12, 11, 11 and 10 points against 11), all in one colour, unlike the text.
  expect(look.headingSizes).toEqual([1.64, 1.27, 1.09, 1, 1, 0.91]);
  expect(look.headingColours).toHaveLength(1);
  expect(look.headingColours[0]).not.toBe(look.bodyColour);
  // A quote's words are the text's own colour, as in Word.
  expect(look.quoteColour).toBe(look.bodyColour);
  // All four kinds of line break, <br> included, are line breaks in the paragraph.
  expect(look.lines).toEqual([
    "A single line break here",
    "then the next line.",
    "A backslash next",
    "then its line.",
    "Two spaces next",
    "then their line.",
    "A br tag next",
    "then its line.",
  ]);
  // Task boxes, as Word draws them.
  expect(look.tasks).toEqual([
    ["false", '"☐ "'],
    ["true", '"☒ "'],
    ["false", '"☐ "'],
  ]);
  // A loose list is spaced like paragraphs; in a tight one, a list inside an item leaves no gap after it.
  expect(look.looseGap).toBeGreaterThan(8);
  expect(look.looseGap).toBeCloseTo(look.line, 0);
  expect(look.nestedGap).toBe(0);
  // Tables: an unshaded header with a rule under it; only dotted editing lines between cells.
  expect(look.headerShade).toBe("rgba(0, 0, 0, 0)");
  expect(look.headerRule).toBe("solid");
  expect(look.cellLine).toBe("dotted");
  // Tags are plain words.
  expect(look.tag).toBe("rgba(0, 0, 0, 0)");
  // Front matter, link definitions and the HTML comment show as editing marks of their own kinds.
  expect(look.kinds).toEqual(expect.arrayContaining(["front-matter", "links", "comment", "html"]));
  const labels = await page.evaluate((editor) => {
    const label = (kind: string) => getComputedStyle(document.querySelector(`${editor} pre.raw-block[data-kind="${kind}"]`)!, "::before").content;
    return { links: label("links"), comment: label("comment") };
  }, EDITOR);
  expect(labels.links).toContain("left out of Word");
  expect(labels.comment).toContain("hidden in Word");
  // The headings' colour is readable (WCAG AA, 4.5 to 1) on the page, light and dark.
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const ratio = await page.evaluate((editor) => {
      const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const heading = document.querySelector(`${editor} h2`)!;
      const [a, b] = [lum(rgb(getComputedStyle(heading).color)), lum(rgb(getComputedStyle(document.querySelector(editor)!).backgroundColor))].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    }, EDITOR);
    expect(ratio, scheme).toBeGreaterThanOrEqual(4.5);
  }
  await run.app.close();
});

test("clicking a task's box ticks it, and Enter after a task starts an unticked one", async () => {
  test.setTimeout(30_000);
  const run = await openText("- [ ] Call Ana\n- [x] Send notes\n");
  const { page } = run;
  const box = await page.evaluate((editor) => {
    const first = document.querySelector(`${editor} li.task > p`)!.getBoundingClientRect();
    return { x: first.left - 12, y: first.top + first.height / 2 };
  }, EDITOR);
  await page.mouse.click(box.x, box.y);
  await expect.poll(run.text).toBe("- [x] Call Ana\n- [x] Send notes\n");
  await page.mouse.click(box.x, box.y);
  await expect.poll(run.text).toBe("- [ ] Call Ana\n- [x] Send notes\n");
  await cursorAtEnd(page, "Send notes");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Book the room");
  await expect.poll(run.text).toBe("- [ ] Call Ana\n- [x] Send notes\n- [ ] Book the room\n");
  await run.app.close();
});

test("pictures take the share of the page's width they will in Word, a Retina screenshot at half its pixels", async () => {
  test.setTimeout(30_000);
  const pictures: Record<string, Uint8Array> = {
    "plain.png": makePng(200, 100),
    "screenshot.png": makePng(500, 300, 144),
    "wide.png": makePng(1600, 1000, 144),
    "tall.png": makePng(400, 2000),
  };
  const text = Object.keys(pictures).map((name) => `![${name}](${name})`).join("\n\n") + "\n";
  const run = await openText(text, { prepare: (folder) => Object.entries(pictures).forEach(([name, bytes]) => writeFileSync(join(folder, name), bytes)) });
  const shares = async () =>
    run.page.evaluate((editor) => {
      const boxes = [...document.querySelectorAll<HTMLElement>(`${editor} .picture`)];
      return boxes.map((box) => ({ points: box.dataset.points, share: box.getBoundingClientRect().width / box.parentElement!.getBoundingClientRect().width }));
    }, EDITOR);
  await expect.poll(async () => (await shares()).every((s) => s.points)).toBe(true);
  const [plain, screenshot, wide, tall] = await shares();
  // Word's page has 468 points of text across (US Letter, 1 inch margins).
  expect(plain.points).toBe("200.0x100.0");
  expect(plain.share).toBeCloseTo(200 / 468, 2);
  // A Retina screenshot (144 dots per inch, read as 143 like Pandoc) is half its pixel size.
  expect(screenshot.points).toBe("251.7x151.0");
  expect(screenshot.share).toBeCloseTo(251.7 / 468, 2);
  // A big one fills the width; a tall one is kept to half the page's height (324 points).
  expect(wide.share).toBeCloseTo(1, 2);
  expect(tall.points).toBe("64.8x324.0");
  // Nothing changed in the file.
  expect(run.text()).toBe(text);
  await run.app.close();
});

test("the Word and PDF exports of the sample keep what the page shows, and leave out what it marks as left out", async () => {
  test.setTimeout(150_000);
  const run = await openText(SAMPLE, { name: "sample.md", prepare: withChart });
  const docx = readFileSync(await exportTo(run, "Export to Word", "sample.docx"));
  const xml = readZipEntry(docx, "word/document.xml")!.toString("utf8");
  const notes = readZipEntry(docx, "word/footnotes.xml")!.toString("utf8");
  const styles = readZipEntry(docx, "word/styles.xml")!.toString("utf8");
  // The <br> paragraph has its line break; the nested quote is set further in; callouts are coloured boxes.
  expect(xml).toMatch(/A br tag next<\/w:t>\s*<\/w:r>\s*<w:r>\s*<w:br \/>/);
  expect(xml).toContain('<w:pStyle w:val="BlockText2" />');
  expect(xml).toContain('<w:pStyle w:val="CalloutSky" />');
  expect(xml).toContain('<w:pStyle w:val="CalloutOchre" />');
  // The note written in the text is a footnote; the diagram is a picture.
  expect(notes).toContain("Written right here.");
  expect(xml).not.toContain("graph LR");
  // The wide table has column widths of its own; no text has a colour.
  expect(xml).toContain('<w:tblLayout w:type="fixed" />');
  expect(styles).not.toContain("<w:color ");
  // Left out, as the page marks them.
  expect(xml).not.toContain("How the page matches Word");
  expect(xml).not.toContain("[ref]:");
  expect(xml).not.toContain("an HTML comment");

  const printed = await notePrinted(run.app);
  await exportTo(run, "PDF", "sample.pdf");
  const pdf = await printed();
  expect(pdf).toContain("An HTML block.");
  expect(pdf).toContain("Written right here.");
  expect(pdf).not.toContain("[ref]:");
  expect(pdf).not.toContain("an HTML comment");
  expect(pdf).not.toContain("How the page matches Word");
  expect(run.text()).toBe(SAMPLE);
  await run.app.close();
});
