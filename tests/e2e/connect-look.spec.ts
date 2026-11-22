// The Connect box's main button and its states (roadmap Batch 24, row 20 of
// review/batch-24/findings.md: N-8). While a tool is left to connect, Connect
// is the filled main button and Done an edged one; once nothing is left,
// Done is the main button again. A tool connected but not yet used says
// "Ready", a state, not a verb that reads like a button. The keyboard still
// starts on Done (roadmap Batch 11, F-20).
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ONE_SCALE, launch } from "./helpers";

const box = (page: Page) => page.getByRole("dialog", { name: "Connect your agents" });

/** Whether a button is filled with the main button's colour (measured against a main button put in the box for a moment). */
const filled = (page: Page, name: string) =>
  box(page)
    .getByRole("button", { name, exact: true })
    .evaluate((b) => {
      const probe = document.createElement("button");
      probe.className = "primary";
      b.closest("dialog")!.append(probe);
      const main = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return getComputedStyle(b).backgroundColor === main;
    });

test("Connect is the main button while a tool is left to connect, Done once none is; a connected tool says Ready", async () => {
  const home = mkdtempSync(join(tmpdir(), "corillo-home-"));
  writeFileSync(join(home, ".claude.json"), "{}\n");
  mkdirSync(join(home, "Library", "Application Support", "Claude"), { recursive: true });
  writeFileSync(join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), "{}\n");
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  const { app } = await launch({
    args: [ONE_SCALE, "."],
    env: { ...process.env, CORILLO_USER_DATA: dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: home },
  });
  try {
    const page = await app.firstWindow();
    await expect(box(page)).toBeVisible();
    await expect(box(page).locator(".agent-row")).toHaveCount(2);
    await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).toBe("Done");
    expect(await filled(page, "Connect Claude Code")).toBe(true);
    // One main button: with two tools left, only the first one's Connect is filled (review of Batch 24, R24-3).
    expect(await filled(page, "Connect Claude Desktop")).toBe(false);
    expect(await filled(page, "Done")).toBe(false);

    await box(page).getByRole("button", { name: "Connect Claude Code" }).click();
    const code = box(page).locator('.agent-row[data-tool="claude-code"]');
    await expect(code.locator(".agent-set-up")).toHaveText("Ready");
    expect(await filled(page, "Disconnect Claude Code")).toBe(false);
    expect(await filled(page, "Done")).toBe(false); // Claude Desktop is still left
    await expect.poll(() => filled(page, "Connect Claude Desktop")).toBe(true); // the one left takes the fill

    await box(page).getByRole("button", { name: "Connect Claude Desktop" }).click();
    await expect(box(page).locator('.agent-row[data-tool="claude-desktop"] .agent-set-up')).toHaveText("Ready");
    await expect.poll(() => filled(page, "Done")).toBe(true);
  } finally {
    await app.close();
  }
});
