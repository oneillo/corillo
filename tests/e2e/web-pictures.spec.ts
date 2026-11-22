// Pictures from the web in the document window (roadmap Batch 18, item 1;
// the code review's A16-17). The window asks for them as the export does:
// no cookies kept or sent, and a plain name that says nothing about Corillo,
// Electron, Chrome or the Mac's language.
//
// Nothing leaves this Mac: each picture is served over HTTPS from 127.0.0.1,
// by a server the test starts with a certificate made for the run, which the
// app is told to accept for 127.0.0.1 only. The server notes every request
// and the headers that came with it.
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clickMenu, cursorAtEnd, openAlso, openText, EDITOR, ONE_SCALE, type Running, launch } from "./helpers";
import { AgentSession } from "./agent-session";
import { measure, namesAndRoles } from "./contrast";
import { pictureServer, trustLocalServer, type Heard } from "./picture-server";

test("a web picture is asked for with no cookie, no language and nothing that names Corillo, Electron or Chrome; no cookie is kept", async () => {
  const web = await pictureServer();
  const run = await openText("# Plan\n\nStart.\n", { name: "plan.md" });
  await trustLocalServer(run.app);
  // A cookie for the site, as an older Corillo might have kept: it isn't sent.
  await run.app.evaluate(({ session }, url) => session.defaultSession.cookies.set({ url, name: "old", value: "kept", secure: true, sameSite: "no_restriction" }), web.origin);
  await openAlso(run, "pictures.md", `# Pictures\n\n![one](${web.origin}/one.png)\n`);
  await expect.poll(() => web.asked.length, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(run.page.locator(`${EDITOR} .picture img`)).toHaveJSProperty("naturalWidth", 40);
  // A second picture after the site answered with a cookie: none goes back.
  await openAlso(run, "more.md", `# More\n\n![two](${web.origin}/two.png)\n`);
  await expect.poll(() => web.asked.includes("/two.png"), { timeout: 10_000 }).toBe(true);
  const cookies = await run.app.evaluate(({ session }) => session.defaultSession.cookies.get({ name: "seen" }));
  await run.app.close();
  await web.close();

  expect(cookies).toEqual([]);
  expectPlain(web.heard);
});

/** Each request carried the address and nothing about the person, the Mac or the app. */
function expectPlain(asked: Heard[]): void {
  for (const a of asked) {
    const names = Object.keys(a.headers).map((n) => n.toLowerCase());
    expect(names).not.toContain("cookie");
    expect(names).not.toContain("accept-language");
    expect(names).not.toContain("referer");
    expect(names.filter((n) => n.startsWith("sec-ch-"))).toEqual([]);
    expect(String(a.headers["user-agent"] ?? "")).not.toMatch(/corillo|electron|chrome|chromium|mac|safari|applewebkit/i);
    expect(JSON.stringify(a.headers)).not.toMatch(/corillo|electron|en-US/i);
  }
}

test("Help and About ask the web the same way: they share the window's session", async () => {
  const run = await openText("Start.\n");
  await clickMenu(run.app, "corillo-help");
  await clickMenu(run.app, "about");
  await expect.poll(() => run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBeGreaterThanOrEqual(3);
  const allShared = await run.app.evaluate(({ session, BrowserWindow }) =>
    BrowserWindow.getAllWindows().every((w) => w.webContents.session === session.defaultSession),
  );
  await run.app.close();
  expect(allShared).toBe(true);
});

// A web picture an agent adds waits for the person ------------------------------------

const PLAN = "# Plan\n\nThe offer to Acme is 41,500 dollars, not yet public.\n\nNext steps follow.\n";
const WAITING = ".doc:not([hidden]) .picture.waiting";

/** Start the app again on the same document and data folder, as after quitting. */
async function relaunch(run: Running): Promise<Running> {
  await run.app.close();
  const { app, thrown } = await launch({
    args: [ONE_SCALE, ".", run.file],
    env: { ...process.env, CORILLO_USER_DATA: run.dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: mkdtempSync(join(tmpdir(), "corillo-home-")) },
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".ProseMirror");
  await trustLocalServer(app);
  return { ...run, app, page, thrown };
}

test("a web picture an agent writes into the document isn't asked for until the person shows it, and still waits after reopening", async () => {
  const web = await pictureServer();
  let run = await openText(PLAN, { name: "plan.md" });
  await trustLocalServer(run.app);
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  await session.ok("take_document", { path: run.file });
  // What an agent led astray by something it read could write: a picture whose address carries words from the document.
  const address = `${web.origin}/pixel.png?q=${encodeURIComponent("offer to Acme is 41,500 dollars")}`;
  await session.ok("edit_document", { path: run.file, edits: [{ find: "Next steps follow.", replace: `Next steps follow.\n\n![chart](${address})` }] });
  await session.ok("finish_editing", { path: run.file, request: "A chart." });
  // The person does nothing. Give the window a moment.
  await expect(run.page.locator(WAITING)).toHaveCount(1);
  await expect(run.page.locator(WAITING)).toContainText(`Picture from the web, not shown: ${web.origin}/pixel.png?q=offer to Acme is 41%2C500 dollars`);
  await run.page.waitForTimeout(1500);
  expect(web.connections()).toBe(0);

  // Closed and opened again: it still waits.
  run = await relaunch(run);
  await expect(run.page.locator(WAITING)).toHaveCount(1);
  await run.page.waitForTimeout(1000);
  expect(web.connections()).toBe(0);

  // His click: then it's asked for, plainly, and shows.
  await run.page.locator(WAITING).getByRole("button", { name: "Show picture" }).click();
  await expect(run.page.locator(`${EDITOR} .picture img`)).toHaveJSProperty("naturalWidth", 40);
  expect(web.asked).toEqual([`/pixel.png?q=${encodeURIComponent("offer to Acme is 41,500 dollars")}`]);
  expectPlain(web.heard);

  // Shown for that document from now on, after reopening too: asked for as the document opens, as its own pictures are.
  // (Before the test's certificate is trusted, so the asking is what's seen here, not the picture.)
  const before = web.connections();
  run = await relaunch(run);
  await expect(run.page.locator(WAITING)).toHaveCount(0);
  await expect.poll(() => web.connections()).toBeGreaterThan(before);
  await run.app.close();
  await session.stop();
  await web.close();
});

test("History, Show changes and the Markdown view's preview hold a waiting picture the same way, a removed one too", async () => {
  test.setTimeout(60_000);
  const web = await pictureServer();
  const run = await openText(PLAN, { name: "plan.md" });
  await trustLocalServer(run.app);
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  await session.ok("take_document", { path: run.file });
  await session.ok("edit_document", { path: run.file, edits: [{ find: "Next steps follow.", replace: `Next steps follow.\n\n![chart](${web.origin}/chart.png)` }] });
  await session.ok("finish_editing", { path: run.file, request: "A chart." });
  await expect(run.page.locator(WAITING)).toHaveCount(1);

  // Show changes: the new picture is a marker there too.
  const showChanges = run.page.locator("#toolbar").getByRole("button", { name: "Show changes" });
  await showChanges.click();
  await expect(run.page.locator(".doc:not([hidden]) .version-view .picture.waiting")).toHaveCount(1);
  await showChanges.click();
  await expect(run.page.locator(".doc:not([hidden]) .version-view")).toBeHidden();

  // A second pass takes it out.
  await session.ok("take_document", { path: run.file });
  await session.ok("edit_document", { path: run.file, edits: [{ find: `\n\n![chart](${web.origin}/chart.png)`, replace: "" }] });
  await session.ok("finish_editing", { path: run.file, request: "No chart." });
  await expect(run.page.locator(WAITING)).toHaveCount(0);

  // History: each pass's version, the picture in the first, struck through in the second; a marker in both.
  await run.page.getByRole("button", { name: "History", exact: true }).click();
  const passes = run.page.locator(".doc:not([hidden]) .history-panel .history-item").filter({ hasText: "Claude" });
  await expect(passes).toHaveCount(2);
  await passes.last().click();
  await expect(run.page.locator(".doc:not([hidden]) .version-view .picture.waiting")).toHaveCount(1);
  await passes.first().click();
  await expect(run.page.locator(".doc:not([hidden]) .version-view :is(del, .diff-removed-block) .picture.waiting")).toHaveCount(1);
  await expect(run.page.locator(".doc:not([hidden]) .version-view img[src^='https:']")).toHaveCount(0);
  await clickMenu(run.app, "view-changes"); // Back to Current Version, or Hide Changes
  await expect(run.page.locator(".doc:not([hidden]) .version-view")).toBeHidden();

  // The Markdown view's preview, with the picture back by his own typing of the same address.
  await clickMenu(run.app, "view-markdown");
  const area = run.page.locator(".doc:not([hidden]) textarea.source");
  await area.focus();
  await run.page.keyboard.press("Meta+ArrowDown");
  await run.page.keyboard.insertText(`\n![chart](${web.origin}/chart.png)\n`);
  await expect(run.page.locator(".doc:not([hidden]) .preview .picture.waiting")).toHaveCount(1);

  await run.page.waitForTimeout(1000);
  expect(web.connections()).toBe(0);
  await run.app.close();
  await session.stop();
  await web.close();
});

test("the marker is reached by the keyboard, and a screen reader reads its address; Return shows the picture", async () => {
  const web = await pictureServer();
  const run = await openText(PLAN, { name: "plan.md" });
  await trustLocalServer(run.app);
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  await session.ok("take_document", { path: run.file });
  await session.ok("edit_document", { path: run.file, edits: [{ find: "Next steps follow.", replace: `Next steps follow. ![chart](${web.origin}/chart.png)` }] });
  await session.ok("finish_editing", { path: run.file });
  await expect(run.page.locator(WAITING)).toHaveCount(1);

  const named = await namesAndRoles(run.page);
  expect(named.checked.filter((n) => n.role === "button" && n.name === `Show picture from ${web.origin}/chart.png`)).toHaveLength(1);
  expect(named.noName.filter((n) => n.part === "page")).toEqual([]);
  // Its words and its button's edge are as easy to see as the standing contrast test asks, in light and dark.
  for (const scheme of ["light", "dark"] as const) {
    await run.page.emulateMedia({ colorScheme: scheme });
    const marker = (await measure(run.page)).pairs.filter((p) => /picture|Show picture|not shown/i.test(`${p.what} ${p.words}`));
    expect(marker.length, scheme).toBeGreaterThan(0);
    expect(marker.filter((p) => p.ratio < p.need).map((p) => `${scheme}: ${p.what} ${p.how} ${p.ratio} < ${p.need}`)).toEqual([]);
  }
  await run.page.emulateMedia({ colorScheme: "light" });

  // The cursor after the picture, at the end of its line, then the arrow key onto it, as onto any picture.
  await cursorAtEnd(run.page, "Next steps follow.");
  await run.page.keyboard.press("ArrowLeft");
  await expect(run.page.locator(`${WAITING}.selected`)).toHaveCount(1);
  expect(web.connections()).toBe(0);
  await run.page.keyboard.press("Enter");
  await expect(run.page.locator(`${EDITOR} .picture img`)).toHaveJSProperty("naturalWidth", 40);
  // Return showed it, and put nothing in its place.
  expect(run.text()).toContain(`Next steps follow. ![chart](${web.origin}/chart.png)`);
  expect(web.asked).toEqual(["/chart.png"]);
  await run.app.close();
  await session.stop();
  await web.close();
});

test("a document an agent made waits the same; a picture only a script clicks stays waiting; an http picture is never asked for", async () => {
  const web = await pictureServer();
  const run = await openText("Start.\n", { name: "start.md" });
  await trustLocalServer(run.app);
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  const made = join(run.folder, "made.md");
  await session.ok("create_document", { path: made, text: `# Made\n\n![one](${web.origin}/one.png)\n\n![plain](http://127.0.0.1:${web.port}/plain.png)\n` });
  await session.ok("open_document", { path: made });
  await run.page.locator(".tab", { hasText: "made" }).click();
  await expect(run.page.locator(WAITING)).toHaveCount(2);
  // Code in the window clicking the marker (as an agent's text never could, but if it did) shows nothing.
  await run.page.evaluate(() => document.querySelectorAll<HTMLButtonElement>(".doc:not([hidden]) .picture.waiting button").forEach((b) => b.click()));
  await run.page.waitForTimeout(1000);
  await expect(run.page.locator(WAITING)).toHaveCount(2);
  expect(web.connections()).toBe(0);
  // His click on the http one: the page's own rule still never asks for it.
  await run.page.getByRole("button", { name: `Show picture from http://127.0.0.1:${web.port}/plain.png` }).click();
  await expect(run.page.locator(WAITING)).toHaveCount(1);
  await run.page.waitForTimeout(1000);
  expect(web.connections()).toBe(0);
  await run.app.close();
  await session.stop();
  await web.close();
});

// The review of Batch 18: the other ways a waiting picture could still be asked for -------------

/** An agent adds this text after "Next steps follow." in one pass. */
async function agentAdds(run: Running, session: AgentSession, added: string): Promise<void> {
  await session.ok("take_document", { path: run.file });
  await session.ok("edit_document", { path: run.file, edits: [{ find: "Next steps follow.", replace: `Next steps follow.\n\n${added}` }] });
  await session.ok("finish_editing", { path: run.file });
}

const LEFT_OUT = "A picture from the web was left out because it is waiting for you to show it:";

test("R18-1: an agent's export and his own leave a waiting picture out, and say so; once shown, the export takes it", async () => {
  test.setTimeout(120_000);
  const web = await pictureServer();
  const run = await openText(PLAN, { name: "plan.md" });
  await trustLocalServer(run.app);
  // The export's own fetch has a session of its own: it trusts the test's server too, so what it asks for is seen.
  await run.app.evaluate(({ session }) =>
    session.fromPartition("corillo-export-pictures", { cache: false }).setCertificateVerifyProc((request, callback) => callback(request.hostname === "127.0.0.1" ? 0 : -3)),
  );
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  const address = `${web.origin}/pixel.png?q=${encodeURIComponent("offer to Acme")}`;
  await agentAdds(run, session, `![chart](${address})`);
  await expect(run.page.locator(WAITING)).toHaveCount(1);

  // The agent asks for a PDF and a Word document.
  for (const format of ["pdf", "word"]) {
    const said = await session.ok("export_document", { path: run.file, format, replace: true });
    expect(said).toContain(`${LEFT_OUT} ${web.origin}/pixel.png?q=offer to Acme`);
  }
  expect(web.connections()).toBe(0);

  // His own Export, from the toolbar.
  const out = join(run.folder, "mine.docx");
  await run.app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
  }, out);
  await run.page.getByRole("button", { name: "Export", exact: true }).click();
  await run.page.getByRole("menu", { name: "Export" }).getByRole("menuitem", { name: "Export to Word" }).click();
  await expect(run.page.locator(".export-notice")).toContainText("Exported to mine.docx", { timeout: 45_000 });
  await expect(run.page.locator(".export-notice")).toContainText(LEFT_OUT);
  expect(web.connections()).toBe(0);

  // Shown: from then on the export asks for it too.
  await run.page.locator(WAITING).getByRole("button", { name: "Show picture" }).click();
  await expect(run.page.locator(`${EDITOR} .picture img`)).toHaveJSProperty("naturalWidth", 40);
  const before = web.asked.length;
  const said = await session.ok("export_document", { path: run.file, format: "pdf", replace: true });
  expect(said).not.toContain(LEFT_OUT);
  expect(web.asked.length).toBe(before + 1);
  expectPlain(web.heard);
  await run.app.close();
  await session.stop();
  await web.close();
});

/** A diagram with a picture shape and a label holding a picture, both on the test's server. */
const diagramWith = (origin: string) =>
  [
    "```mermaid",
    "flowchart LR",
    `  A@{ img: "${origin}/shape.png?q=offer%20to%20Acme", label: "Chart", w: 40, h: 30 }`,
    `  B["<img src='${origin}/label.png?q=41500'>"]`,
    "  A --> B",
    "```",
  ].join("\n");

test("R18-2: a diagram's pictures from the web an agent adds wait, drawn blank with a marker for each, shown by a click or by keyboard", async () => {
  test.setTimeout(90_000);
  const web = await pictureServer();
  const run = await openText(PLAN, { name: "plan.md" });
  await trustLocalServer(run.app);
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  await agentAdds(run, session, diagramWith(web.origin));
  const diagram = run.page.locator(".doc:not([hidden]) .page.editor .diagram");
  await expect(diagram.locator(".diagram-picture svg")).toBeVisible({ timeout: 15_000 });
  await diagram.scrollIntoViewIfNeeded();
  await expect(diagram.locator(".picture.waiting")).toHaveCount(2);
  await expect(diagram.locator(".picture.waiting").first()).toContainText(`Picture from the web, not shown: ${web.origin}/shape.png?q=offer to Acme`);
  // The Markdown view's preview draws it the same way.
  await clickMenu(run.app, "view-markdown");
  await expect(run.page.locator(".doc:not([hidden]) .preview .diagram svg")).toBeVisible({ timeout: 15_000 });
  await expect(run.page.locator(".doc:not([hidden]) .preview .diagram .picture.waiting")).toHaveCount(2);
  await clickMenu(run.app, "view-formatted");
  // Show changes and History too.
  const showChanges = run.page.locator("#toolbar").getByRole("button", { name: "Show changes" });
  await showChanges.click();
  await expect(run.page.locator(".doc:not([hidden]) .version-view .diagram svg")).toBeVisible({ timeout: 15_000 });
  await expect(run.page.locator(".doc:not([hidden]) .version-view .diagram .picture.waiting")).toHaveCount(2);
  await showChanges.click();
  await run.page.waitForTimeout(1500);
  expect(web.connections()).toBe(0);

  // A screen reader hears each marker's button by its address.
  const named = await namesAndRoles(run.page);
  expect(named.checked.filter((n) => n.role === "button" && n.name === `Show picture from ${web.origin}/shape.png?q=offer%20to%20Acme`)).toHaveLength(1);

  // His click on the first: that one is asked for, the other still waits.
  await diagram.getByRole("button", { name: `Show picture from ${web.origin}/shape.png?q=offer%20to%20Acme` }).click();
  await expect.poll(() => web.asked).toEqual(["/shape.png?q=offer%20to%20Acme"]);
  await expect(diagram.locator(".picture.waiting")).toHaveCount(1);
  // By keyboard: the arrow key from the line before stops on the diagram, as on a picture, and Return shows what still waits.
  await cursorAtEnd(run.page, "Next steps follow.");
  await run.page.keyboard.press("ArrowDown");
  await expect(diagram).toHaveClass(/ProseMirror-selectednode/);
  await run.page.keyboard.press("Enter");
  await expect(diagram.locator(".picture.waiting")).toHaveCount(0);
  await expect.poll(() => web.asked.sort()).toEqual(["/label.png?q=41500", "/shape.png?q=offer%20to%20Acme"]);
  expect(run.text()).toContain(diagramWith(web.origin)); // Return put nothing in the diagram
  expectPlain(web.heard);
  await run.app.close();
  await session.stop();
  await web.close();
});

test("R18-2 backstop: whatever in the window asks for an address that waits, the request doesn't go; Show picture's own does", async () => {
  const web = await pictureServer();
  const run = await openText(PLAN, { name: "plan.md" });
  await trustLocalServer(run.app);
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  const address = `${web.origin}/chart.png?q=41500`;
  await agentAdds(run, session, `![chart](${address})`);
  await expect(run.page.locator(WAITING)).toHaveCount(1);
  // A way to the web nobody thought of: a picture made by code in the window.
  await run.page.evaluate((src) => {
    const img = new Image();
    img.src = src;
    document.body.append(img);
  }, address);
  await run.page.waitForTimeout(1500);
  expect(web.connections()).toBe(0);
  await run.page.locator(WAITING).getByRole("button", { name: "Show picture" }).click();
  await expect(run.page.locator(`${EDITOR} .picture img`)).toHaveJSProperty("naturalWidth", 40);
  await run.app.close();
  await session.stop();
  await web.close();
});

test("R18-3: a web picture in an agent's reply option waits once he picks the option", async () => {
  const web = await pictureServer();
  const run = await openText(PLAN, { name: "plan.md" });
  await trustLocalServer(run.app);
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  const added = await session.ok("add_comment", { path: run.file, quote: "Next steps follow.", text: "Shall I add the chart?" });
  const id = /\[([^\]]+)\]/.exec(added)![1];
  await session.ok("reply_to_comment", {
    path: run.file,
    comment_id: id,
    text: "Here it is, if you want it.",
    options: [{ label: "Add the chart", edits: [{ find: "Next steps follow.", replace: `Next steps follow.\n\n![chart](${web.origin}/chart.png?q=41500)` }] }],
  });
  await run.page.getByRole("button", { name: "Add the chart" }).click();
  await expect(run.page.locator(WAITING)).toHaveCount(1);
  await run.page.waitForTimeout(1500);
  expect(web.connections()).toBe(0);
  await run.app.close();
  await session.stop();
  await web.close();
});
