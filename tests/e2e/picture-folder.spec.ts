// A picture Show changes draws as removed comes from its own document's folder, even when it was
// drawn while another document was in front (code review of Batch 16, W16-16 and S-3).
import { test, expect } from "@playwright/test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "./agent-session";
import { clickMenu, launchSettled, openFromFinder, openText, FIXTURES } from "./helpers";
import { tidyRuns } from "./tidy";

const tidy = tidyRuns();
const FRONT = ".doc:not([hidden])";
const pics = (folder: string) => {
  mkdirSync(join(folder, "pics"), { recursive: true });
  copyFileSync(join(FIXTURES, "chart.png"), join(folder, "pics", "a.png"));
};

test("a picture an agent removes from a document behind another is struck through from its own folder", async () => {
  const run = tidy.keep(await openText("# A\n\nFirst words of A.\n\n![Chart A](pics/a.png)\n\nLast words of A.\n", { name: "a.md", prepare: pics }));
  const { app, page } = run;
  const other = mkdtempSync(join(tmpdir(), "corillo-doc-"));
  pics(other);
  const b = join(other, "b.md");
  writeFileSync(b, "# B\n\nWords of B.\n\n![Chart B](pics/a.png)\n");
  const { session } = await AgentSession.start(run.dataDir);
  try {
    await launchSettled(app);
    // A first pass, so Show changes has something to show in A.
    await session.ok("take_document", { path: run.file });
    await session.ok("edit_document", { path: run.file, edits: [{ find: "First words of A.", replace: "First words of A, changed." }] });
    await session.ok("finish_editing", { path: run.file });
    await clickMenu(app, "view-changes");
    await expect(page.locator(`${FRONT} .version-banner`)).toBeVisible();
    // B to the front, then the agent removes A's picture.
    await openFromFinder(app, b);
    await expect.poll(() => page.locator(".tab").count()).toBe(2);
    await expect(page.locator(`${FRONT} img[data-src]`).first()).toBeVisible();
    await session.ok("take_document", { path: run.file });
    await session.ok("edit_document", { path: run.file, edits: [{ find: "![Chart A](pics/a.png)\n\n", replace: "" }] });
    await session.ok("finish_editing", { path: run.file });
    await page.waitForTimeout(1000);
    // A to the front again: its removed picture is A's own.
    await page.locator(".tab").first().click();
    const removed = page.locator(`${FRONT} .diff-removed img, ${FRONT} .diff-removed-block img`);
    await expect(removed.first()).toBeAttached();
    const sources = await removed.evaluateAll((all) => all.map((i) => i.getAttribute("src") ?? ""));
    const name = (folder: string) => folder.split("/").pop()!;
    for (const src of sources) {
      expect(src, "not drawn from B's folder").not.toContain(name(other));
      expect(src, "drawn from A's folder").toContain(name(run.folder));
    }
  } finally {
    await session.stop();
    rmSync(other, { recursive: true, force: true });
  }
});
