// Parity: agents can do what the person can. Through Corillo's connector, an
// agent looks back through a document's versions (who, when, the feedback each
// pass addressed), reads an old version, sees what a version changed, and
// exports to Word or PDF.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openText, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const ROOT = join(import.meta.dirname, "..", "..");
const PLAN = "# Plan\n\nWe should hire two people this quarter.\n\n## Budget\n\nThe budget is tight.\n";

async function setUp(): Promise<{ run: Running; plan: string; claude: AgentSession }> {
  const run = await openText("My own notes.\n", { name: "notes.md" });
  const plan = join(run.folder, "plan.md");
  writeFileSync(plan, PLAN);
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  return { run, plan, claude: session };
}

async function tearDown(run: Running, claude: AgentSession): Promise<void> {
  await run.app.close();
  await claude.stop();
}

async function personComments(page: Page, docName: string, body: string): Promise<void> {
  const id = await page.locator(`.tab[title$="/${docName}"]`).getAttribute("data-doc-id");
  await page.evaluate(
    async ({ id, body }) => {
      const r = await window.corillo.addComment(id!, body, null, null);
      if (!r.ok) throw new Error(r.error);
    },
    { id, body },
  );
}

test("an agent lists a document's versions with who made each and the feedback each pass addressed, reads an old one and sees what changed", async () => {
  const { run, plan, claude } = await setUp();
  await claude.ok("open_document", { path: plan });
  await personComments(run.page, "plan.md", "Three people, not two.");
  const taken = await claude.ok("take_document", { path: plan });
  const commentId = /\[([0-9a-f]{8,})\]/.exec(taken)![1];
  await claude.ok("edit_document", { path: plan, edits: [{ find: "hire two people", replace: "hire three people" }] });
  await claude.ok("reply_to_comment", { path: plan, comment_id: commentId, text: "Changed to three." });
  await claude.ok("finish_editing", { path: plan });

  const versions = await claude.ok("list_versions", { path: plan });
  expect(versions).toContain("plan.md has 2 versions, newest first:");
  expect(versions).toMatch(/Version 2 \(current\): Claude, .*\. Addressed 1 comment:\n {2}- on the whole document\n {4}Person: Three people, not two\.\n {4}Claude: Changed to three\./);
  expect(versions).toMatch(/Version 1: First version, /);

  const old = await claude.ok("read_version", { path: plan, version: 1 });
  expect(old).toContain(PLAN);
  expect(readFileSync(plan, "utf8")).toContain("hire three people"); // reading an old version changes nothing

  expect(await claude.ok("show_changes", { path: plan })).toContain("We should hire [-two-]{+three+} people this quarter.");
  await tearDown(run, claude);
});

test("an agent exports to Word and PDF next to the document, never replaces a file unless it says so, and the person sees where it went", async () => {
  test.setTimeout(120_000);
  execFileSync(process.execPath, [join(ROOT, "scripts", "fetch-pandoc.mjs"), `--arch=${process.arch}`], { stdio: "inherit" });
  const { run, plan, claude } = await setUp();

  const word = await claude.ok("export_document", { path: plan, format: "word" });
  const docx = join(run.folder, "plan.docx");
  expect(word).toContain(`Exported plan.md as a Word document: ${docx}`);
  const xml = execFileSync("unzip", ["-p", docx, "word/document.xml"], { encoding: "utf8" });
  expect(xml).toContain("We should hire two people this quarter.");
  // The person sees the same notice as after their own export, with who made it, on the document's tab (roadmap Batch 4, item 3).
  const notice = run.page.locator(".doc:not([hidden]) .export-notice");
  await expect(run.page.locator(".export-notice:visible")).toHaveCount(0); // not over notes.md, in front
  await run.page.locator('.tab[title$="/plan.md"]').click();
  await expect(notice).toContainText("Claude exported plan.docx");
  await expect(notice.getByRole("button", { name: "Open" })).toBeVisible();
  await expect(notice.getByRole("button", { name: "Show in Finder" })).toBeVisible();

  // The same name again: refused, and the file is untouched.
  const before = statSync(docx).mtimeMs;
  const refused = await claude.call("export_document", { path: plan, format: "word" });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("There's already a file at");
  expect(statSync(docx).mtimeMs).toBe(before);
  expect(await claude.ok("export_document", { path: plan, format: "word", replace: true })).toContain(docx);

  // A name without its ending gets one.
  const pdfPath = join(run.folder, "For Ana.pdf");
  const pdf = await claude.ok("export_document", { path: plan, format: "pdf", output_path: join(run.folder, "For Ana") });
  expect(pdf).toContain(`Exported plan.md as a PDF: ${pdfPath}`);
  expect(readFileSync(pdfPath).subarray(0, 5).toString()).toBe("%PDF-");
  await expect(notice).toContainText("Claude exported For Ana.pdf");
  await tearDown(run, claude);
});

/** Every window the app has now, by the page each shows ("index.html" is the document window). */
const windowPages = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed())
      .map((w) => w.webContents.getURL().replace(/^.*\//, "") || "(loading)"),
  );

test("an agent's export that ends after the person closed the window doesn't bring the window back (S21-7)", async () => {
  test.setTimeout(120_000);
  // Long enough that the export is still going when the window has closed.
  const text = "# Plan\n\n" + Array.from({ length: 1500 }, (_, i) => `Paragraph ${i + 1}: we should hire two people this quarter.`).join("\n\n") + "\n";
  const run = await openText(text, { name: "plan.md" });
  const { session } = await AgentSession.start(run.dataDir);
  try {
    const exporting = session.begin("export_document", { path: run.file, format: "pdf" });
    let answered = false;
    void exporting.answer.then(() => (answered = true));
    // Once the export's hidden page is there, the person closes the window.
    await expect.poll(async () => (await windowPages(run.app)).length, { timeout: 30_000 }).toBeGreaterThan(1);
    await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/index.html"))?.close());
    await expect.poll(async () => (await windowPages(run.app)).filter((p) => p === "index.html").length, { timeout: 15_000 }).toBe(0);
    expect(answered, "the export ended before the window had closed: make the document longer").toBe(false);
    const answer = await exporting.answer;
    expect(JSON.stringify(answer.result ?? answer.error)).toContain("Exported plan.md as a PDF");
    // A moment for whatever the export's end sets off: still no document window.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(await windowPages(run.app)).not.toContain("index.html");
  } finally {
    await tearDown(run, session);
  }
});
