// The file Save Somewhere Else leaves where it was (the review of Batch 19,
// R19-4; roadmap Batch 20, item 1). A web picture an agent added waits in the
// document; he saves it somewhere else and the old file stays. Opened again,
// the old file is a document of its own, and the agent's picture still waits
// in it as a box, as it does in the new file.
//
// Nothing leaves this Mac: the picture is served over HTTPS from 127.0.0.1,
// by a server the test starts with a certificate made for the run, which the
// app is told to accept for 127.0.0.1 only. The server counts every
// connection, so a picture asked for at all is seen.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clickMenu, cursorAtEnd, openAlso, openFromFinder, openText, tabState, EDITOR } from "./helpers";
import { AgentSession } from "./agent-session";
import { pictureServer, trustLocalServer } from "./picture-server";

const PLAN = "# Plan\n\nThe offer to Acme is 41,500 dollars.\n\nNext steps follow.\n";
const WAITING = ".doc:not([hidden]) .picture.waiting";

/** Pretend the person answers the next questions with their first button (Save Somewhere Else…) and picks this place in the save panel. */
function saveSomewhereElse(app: ElectronApplication, picked: string): Promise<void> {
  return app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox;
  }, picked);
}

test("an agent's web picture still waits in the file Save Somewhere Else leaves behind, and in the new file", async () => {
  test.setTimeout(90_000);
  const web = await pictureServer();
  const run = await openText(PLAN, { name: "plan.md" });
  await trustLocalServer(run.app);
  await openAlso(run, "notes.md", "# Notes\n\nNothing here.\n");
  await expect(run.page.locator(EDITOR)).toContainText("Nothing here.");
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  const kept = join(run.folder, "kept.md");
  try {
    await session.ok("take_document", { path: run.file });
    await session.ok("edit_document", { path: run.file, edits: [{ find: "Next steps follow.", replace: `Next steps follow.\n\n![chart](${web.origin}/chart.png?q=offer)` }] });
    await session.ok("finish_editing", { path: run.file, request: "A chart." });
    await openFromFinder(run.app, run.file);
    await expect(run.page.locator(EDITOR)).toContainText("Next steps follow.");
    await expect(run.page.locator(WAITING)).toHaveCount(1, { timeout: 15_000 });

    // The file can't be saved (locked in Finder, say): closing it offers Save Somewhere Else, and the old file stays.
    chmodSync(run.file, 0o444);
    await cursorAtEnd(run.page, "The offer to Acme is 41,500 dollars.");
    await run.page.keyboard.type(" Firm.");
    await expect(run.page.locator("#save-status")).toContainText("Not saved");
    await saveSomewhereElse(run.app, kept);
    await clickMenu(run.app, "close-tab");
    await expect.poll(() => existsSync(kept)).toBe(true);
    await expect(run.page.locator(EDITOR)).toContainText("Nothing here.");
    expect(readFileSync(run.file, "utf8")).toContain(`${web.origin}/chart.png?q=offer`);
    chmodSync(run.file, 0o644);

    // The old file, opened again: the agent's picture is a box, and nothing asks the server for it.
    await openFromFinder(run.app, run.file);
    await expect(run.page.locator(EDITOR)).toContainText("41,500 dollars.");
    await expect(run.page.locator(EDITOR)).not.toContainText("Firm.");
    await expect(run.page.locator(WAITING)).toHaveCount(1);
    await run.page.waitForTimeout(1500);
    expect(web.connections()).toBe(0);

    // The new file keeps its list too.
    await openFromFinder(run.app, kept);
    await expect(run.page.locator(EDITOR)).toContainText("Firm.");
    await expect(run.page.locator(WAITING)).toHaveCount(1);
    await run.page.waitForTimeout(1000);
    expect(web.connections()).toBe(0);
  } finally {
    chmodSync(run.file, 0o644);
    await run.app.close();
    await session.stop();
    await web.close();
  }
});

// The review of Batch 20, R20-2: Rename or Move to another drive that copies the file but can't remove the original leaves it behind too.
test("an agent's web picture still waits in the original Rename or Move couldn't remove", async () => {
  test.setTimeout(90_000);
  const web = await pictureServer();
  const run = await openText(PLAN, { name: "plan.md" });
  await trustLocalServer(run.app);
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  const target = join(run.folder, "Other drive", "plan.md");
  mkdirSync(join(run.folder, "Other drive"));
  try {
    await session.ok("take_document", { path: run.file });
    await session.ok("edit_document", { path: run.file, edits: [{ find: "Next steps follow.", replace: `Next steps follow.\n\n![chart](${web.origin}/chart.png?q=offer)` }] });
    await session.ok("finish_editing", { path: run.file, request: "A chart." });
    await expect(run.page.locator(WAITING)).toHaveCount(1, { timeout: 15_000 });

    // As on another drive: no plain rename, so Corillo copies; and the original can't be removed (locked, say).
    await run.app.evaluate((_electron, original) => {
      const fs = (process as unknown as { mainModule: { require(id: string): typeof import("node:fs") } }).mainModule.require("fs");
      const g = globalThis as unknown as { putBack: () => void };
      const { renameSync, rmSync } = fs;
      fs.renameSync = ((from: string, to: string) => {
        if (from === original) throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
        return renameSync(from, to);
      }) as typeof fs.renameSync;
      fs.rmSync = ((p: string, options?: object) => {
        if (p === original) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
        return rmSync(p, options);
      }) as typeof fs.rmSync;
      g.putBack = () => Object.assign(fs, { renameSync, rmSync });
    }, run.file);
    await run.app.evaluate(({ dialog }, chosen) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox;
    }, target);
    await clickMenu(run.app, "rename");
    await expect.poll(() => run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getRepresentedFilename())).toBe(target);
    await run.app.evaluate(() => (globalThis as unknown as { putBack: () => void }).putBack());
    expect(readFileSync(run.file, "utf8")).toContain(`${web.origin}/chart.png?q=offer`);

    // The original, opened: a document of its own, and the agent's picture is a box; nothing asks the server for it.
    await openFromFinder(run.app, run.file);
    await expect.poll(async () => (await tabState(run.page)).names).toEqual(["plan.md", "plan.md"]);
    await expect(run.page.locator(EDITOR)).toContainText("Next steps follow.");
    await expect(run.page.locator(WAITING)).toHaveCount(1);
    await run.page.waitForTimeout(1500);
    expect(web.connections()).toBe(0);
  } finally {
    await run.app.evaluate(() => (globalThis as unknown as { putBack?: () => void }).putBack?.()).catch(() => {});
    await run.app.close();
    await session.stop();
    await web.close();
  }
});
