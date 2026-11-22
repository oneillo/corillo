// "Corillo couldn't update what it keeps beside it" comes back with the trouble (his call, roadmap Batch 22,
// item 2, the review of Batch 21's G21-18). Before, it was said once per document for as long as Corillo ran.
import { test, expect } from "@playwright/test";
import { chmodSync } from "node:fs";
import { cursorAtEnd, expectFile, openText } from "./helpers";

const STATUS = "#save-status";
const NOTICE = ".file-notice";
const SAID = "proposal is saved, but Corillo couldn't update what it keeps beside it.";

test("the line about Corillo's records is said again when the trouble comes back after it cleared", async () => {
  const run = await openText("Plan.\n");
  const notice = run.page.locator(NOTICE);
  try {
    // The data folder stops taking changes (full, or no permission) while the document's own disk is fine.
    chmodSync(run.dataDir, 0o555);
    await cursorAtEnd(run.page, "Plan.");
    await run.page.keyboard.type(" One.");
    await expectFile(run, "Plan. One.\n");
    await expect(notice).toContainText(SAID);
    await notice.locator(".export-notice-close").click();
    await expect(notice).toBeHidden();
    // Still the same spell: not said again.
    await cursorAtEnd(run.page, "Plan. One.");
    await run.page.keyboard.type(" Two.");
    await expectFile(run, "Plan. One. Two.\n");
    // The notice is sent before the save's answer, so once "Saved" shows, one that was coming is there (R22-12).
    await expect(run.page.locator(STATUS)).toHaveText("Saved");
    await expect(notice).toBeHidden();
    // He makes room: the next save keeps the records.
    chmodSync(run.dataDir, 0o755);
    await cursorAtEnd(run.page, "Plan. One. Two.");
    await run.page.keyboard.type(" Three.");
    await expectFile(run, "Plan. One. Two. Three.\n");
    await expect(run.page.locator(STATUS)).toHaveText("Saved");
    await expect(notice).toBeHidden();
    // Later the trouble comes back: said again.
    chmodSync(run.dataDir, 0o555);
    await cursorAtEnd(run.page, "Plan. One. Two. Three.");
    await run.page.keyboard.type(" Four.");
    await expectFile(run, "Plan. One. Two. Three. Four.\n");
    await expect(run.page.locator(STATUS)).toHaveText("Saved");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(SAID);
  } finally {
    chmodSync(run.dataDir, 0o755);
  }
  await run.app.close();
});
