// Past the cap on a document's list of waiting web pictures, every web
// picture in it waits, until he shows it (roadmap Batch 19, item 2, the
// review of Batch 18's R18-6): the list never drops one to make room.
import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clickMenu, openFromFinder, openText, EDITOR } from "./helpers";
import { AgentSession } from "./agent-session";
import { pictureServer, trustLocalServer } from "./picture-server";

const WAITING = `${EDITOR} .picture.waiting`;
const MANY = 1_001;

test("an agent adds more web pictures than the list holds: every one waits, after reopening too, and the list stays at the cap", async () => {
  test.setTimeout(120_000);
  const web = await pictureServer();
  const run = await openText("# Plan\n\nNext steps follow.\n", { name: "plan.md" });
  await trustLocalServer(run.app);
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  await session.ok("take_document", { path: run.file });
  const pictures = Array.from({ length: MANY }, (_, i) => `![p${i}](${web.origin}/p${i}.png)`).join("\n\n");
  await session.ok("edit_document", { path: run.file, edits: [{ find: "Next steps follow.", replace: `Next steps follow.\n\n${pictures}` }] });
  await session.ok("finish_editing", { path: run.file, request: "Many charts." });
  await expect(run.page.locator(WAITING)).toHaveCount(MANY, { timeout: 20_000 });
  await run.page.waitForTimeout(1500);
  expect(web.connections()).toBe(0);

  // Kept with its records: at most the cap, and the mark that every web picture waits.
  const folders = join(run.dataDir, "documents");
  const settings = readdirSync(folders)
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(folders, f, "settings.json"), "utf8")) as { waitingPictures?: string[]; everyWebPictureWaits?: { shown: string[] } };
      } catch {
        return null;
      }
    })
    .find((x) => x?.everyWebPictureWaits);
  expect(settings?.everyWebPictureWaits).toEqual({ shown: [] });
  expect((settings?.waitingPictures ?? []).length).toBeLessThanOrEqual(1_000);

  // Closed and opened again: every one still waits.
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator(".tab")).toHaveCount(0);
  await openFromFinder(run.app, run.file);
  await expect(run.page.locator(WAITING)).toHaveCount(MANY, { timeout: 20_000 });
  await run.page.waitForTimeout(1500);
  expect(web.connections()).toBe(0);

  // His click shows the last one only.
  const last = run.page.locator(WAITING).last();
  await last.scrollIntoViewIfNeeded();
  await last.getByRole("button", { name: "Show picture" }).click();
  await expect(run.page.locator(WAITING)).toHaveCount(MANY - 1);
  await expect.poll(() => web.asked).toEqual([`/p${MANY - 1}.png`]);
  await run.app.close();
  await session.stop();
  await web.close();
});
