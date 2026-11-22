// Corillo opens from macOS 13, but the Pandoc inside it, which opens Word
// documents and makes them, needs macOS 15. On macOS 13 or 14 the person is
// told so plainly where they try it, and nothing is made (review B13R-7). The
// app is told it runs on macOS 14 (CORILLO_DARWIN_RELEASE, Darwin's number for it).
import { test, expect } from "@playwright/test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clickMenu, openFromFinder, openText } from "./helpers";
import { makeDocx } from "../fixtures/make-docx";

const MACOS_14 = { CORILLO_DARWIN_RELEASE: "23.6.0" };
const NEEDS_15 = "Opening Word documents and exporting to Word need macOS 15 or later. Everything else in Corillo works on this Mac.";

test("on macOS 14, Export to Word says it needs macOS 15 and makes nothing; PDF export still works", async () => {
  test.setTimeout(60_000);
  const run = await openText("# Plan\n\nThe first step.\n", { name: "plan.md", env: MACOS_14 });
  for (const [item, name] of [["export-word", "plan.docx"], ["export-pdf", "plan.pdf"]] as const) {
    await run.app.evaluate(({ dialog }, chosen) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
    }, join(run.folder, name));
    await clickMenu(run.app, item);
    if (item === "export-word") await expect(run.page.locator(".export-notice")).toContainText(NEEDS_15, { timeout: 30_000 });
    else await expect(run.page.locator(".export-notice")).toContainText("Exported to plan.pdf", { timeout: 45_000 });
  }
  expect(existsSync(join(run.folder, "plan.docx"))).toBe(false);
  expect(readFileSync(join(run.folder, "plan.pdf")).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  await run.app.close();
});

test("on macOS 14, opening a Word document says it needs macOS 15, asks nothing and makes no copy", async () => {
  const run = await openText("# Start\n", { name: "start.md", env: MACOS_14 });
  const word = join(run.folder, "Offsite notes.docx");
  writeFileSync(word, makeDocx());
  await run.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { asked: string[]; errors: string[] };
    g.asked = [];
    g.errors = [];
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const o = args.find((a) => typeof a === "object" && a !== null && "message" in a) as { message: string };
      g.asked.push(o.message);
      return { response: 0, checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;
    dialog.showErrorBox = (title: string, content: string) => void g.errors.push(`${title}: ${content}`);
  });
  await openFromFinder(run.app, word);
  const told = () =>
    run.app.evaluate(() => {
      const g = globalThis as unknown as { asked: string[]; errors: string[] };
      return { asked: g.asked, errors: g.errors };
    });
  await expect.poll(async () => (await told()).errors).toEqual([`Can't open Offsite notes.docx: ${NEEDS_15}`]);
  expect((await told()).asked).toEqual([]);
  expect(readdirSync(run.folder).sort()).toEqual(["Offsite notes.docx", "start.md"]);
  await run.app.close();
});
