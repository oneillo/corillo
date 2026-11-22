// The window is where anything unexpected would have to start, so the app
// takes from it only what it should: no save over an agent's edit, no file it
// didn't hand out or the person didn't choose, nothing from a window that
// isn't the one a message is for, and no camera, microphone or the like.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openText, cursorAtEnd, clickMenu, clipboardHoldsHtml, tabState, EDITOR, type Running } from "./helpers";
import { makePng } from "../fixtures/make-png";
import { AgentSession } from "./agent-session";

const frontId = (page: Page) => page.locator(".doc:not([hidden])").getAttribute("data-doc-id");

test("while an agent holds a document, a save from the window is refused; the take still saves the person's last typing first (AG-12)", async () => {
  const run = await openText("# Plan\n\nWe should hire two people.\n", { name: "plan.md" });
  const { session } = await AgentSession.start(run.dataDir);
  await cursorAtEnd(run.page, "two people.");
  await run.page.keyboard.type(" Soon.");
  // Taken at once: what the person typed is saved before the agent starts.
  await session.ok("take_document", { path: run.file });
  expect(run.text()).toBe("# Plan\n\nWe should hire two people. Soon.\n");
  await session.ok("edit_document", { path: run.file, edits: [{ find: "two people", replace: "three people" }] });
  const agents = "# Plan\n\nWe should hire three people. Soon.\n";
  expect(run.text()).toBe(agents);

  // A tab that wrongly thinks the document is free can't write over the agent's edit, forced or not.
  const id = await frontId(run.page);
  const stale = "# Plan\n\nAn old copy.\n";
  expect(await run.page.evaluate(([docId, text]) => window.corillo.save(docId!, text), [id, stale] as const)).toEqual({
    ok: false,
    problem: "Claude is editing it",
  });
  expect(await run.page.evaluate(([docId, text]) => window.corillo.forceSave(docId!, text), [id, stale] as const)).toEqual({
    ok: false,
    problem: "Claude is editing it",
  });
  expect(run.text()).toBe(agents);

  // Back with the person, saving works as ever.
  await session.ok("finish_editing", { path: run.file });
  const mine = "# Plan\n\nWe should hire three people. Soon. Mine.\n";
  expect(await run.page.evaluate(([docId, text]) => window.corillo.save(docId!, text), [id, mine] as const)).toEqual({ ok: true });
  expect(run.text()).toBe(mine);
  await run.app.close();
  await session.stop();
});

test("the window opens by path only a document on the recent list or one the person dropped on it (MP-10)", async () => {
  const run = await openText("Start.\n");
  const secret = join(run.folder, "never offered.md");
  writeFileSync(secret, "Not for the window to open.\n");
  await run.page.evaluate((p) => window.corillo.openPath(p), secret);
  await run.page.waitForTimeout(400);
  await expect(run.page.locator(".doc")).toHaveCount(1);

  // Dropped on the window by the person: it opens.
  const dropped = join(run.folder, "dropped.md");
  writeFileSync(dropped, "# Dropped\n");
  await run.page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "pick-for-drop";
    input.hidden = true;
    document.body.append(input);
  });
  await run.page.setInputFiles("#pick-for-drop", dropped);
  await run.page.evaluate(() => {
    const input = document.getElementById("pick-for-drop") as HTMLInputElement;
    const transfer = new DataTransfer();
    transfer.items.add(input.files![0]);
    document.body.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    input.remove();
  });
  await expect(run.page.locator(".doc")).toHaveCount(2);
  await expect(run.page.locator(`${EDITOR} h1`)).toHaveText("Dropped");

  // On the recent list (a start-screen card): it opens.
  await clickMenu(run.app, "close-tab");
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator(".recent-card").first()).toBeVisible();
  await run.page.evaluate((p) => window.corillo.openPath(p), run.file);
  await expect(run.page.locator(EDITOR)).toContainText("Start.");
  // Still not the one never offered.
  await run.page.evaluate((p) => window.corillo.openPath(p), secret);
  await run.page.waitForTimeout(400);
  await expect(run.page.locator(".doc")).toHaveCount(1);
  await run.app.close();
});

test("a link opens a document only when it's in the document; a link or note the page makes up is refused (MP-10)", async () => {
  const run = await openText("# Plan\n\nSee [the budget](budget.md) and [[appendix]].\n", {
    name: "plan.md",
    prepare: (folder) => {
      for (const name of ["budget.md", "appendix.md", "secret.md", "later.md"]) writeFileSync(join(folder, name), `# ${name}\n`);
    },
  });
  const id = await frontId(run.page);
  const tabs = async () => (await tabState(run.page)).names.sort();
  // Not in the document: as a path beside it, as a file address, or as a note's name.
  const secret = join(run.folder, "secret.md");
  await run.page.evaluate(
    ([docId, address]) => Promise.all([window.corillo.openLink("secret.md", docId!), window.corillo.openLink(address, docId!), window.corillo.openNote(docId!, "secret")]),
    [id, pathToFileURL(secret).href] as const,
  );
  expect(await tabs()).toEqual(["plan.md"]);
  // In the document: they open, as a click on them does.
  await run.page.evaluate((docId) => window.corillo.openLink("budget.md", docId!), id);
  await run.page.evaluate((docId) => window.corillo.openNote(docId!, "appendix"), id);
  await expect.poll(tabs).toEqual(["appendix.md", "budget.md", "plan.md"]);
  // A link just typed, clicked before it's saved: it opens once the typing is saved.
  await run.page.locator('.tab[title$="/plan.md"]').click();
  await run.page.evaluate(async (docId) => {
    const opening = window.corillo.openLink("later.md", docId!);
    await new Promise((r) => setTimeout(r, 300));
    await window.corillo.save(docId!, "# Plan\n\nSee [the budget](budget.md) and [[appendix]]. And [later](later.md).\n");
    await opening;
  }, id);
  await expect.poll(tabs).toEqual(["appendix.md", "budget.md", "later.md", "plan.md"]);
  await run.app.close();
});

// The window holds a link made this session as it was typed; the saved text has it percent-encoded (R-SH-2).
test("a link to a name with a space or an accent opens at once, however it's written; one that isn't in the document says so in the corner", async () => {
  const run = await openText("# Plan\n\nSee [Q3](Q3%20plan.md), [the café](Caf%C3%A9.md) and [[Plan B]].\n\nUp 50%% this year, and 10%% more.\n", {
    name: "plan.md",
    prepare: (folder) => {
      for (const name of ["Q3 plan.md", "Café.md", "Plan B.md", "secret.md"]) writeFileSync(join(folder, name), `# ${name}\n`);
    },
  });
  const id = await frontId(run.page);
  const tabs = async () => (await tabState(run.page)).names.sort();
  const started = Date.now();
  await run.page.evaluate((docId) => window.corillo.openLink("Q3 plan.md", docId!), id);
  await run.page.evaluate((docId) => window.corillo.openLink("Café.md", docId!), id);
  await expect.poll(tabs).toEqual(["Café.md", "Q3 plan.md", "plan.md"]);
  expect(Date.now() - started).toBeLessThan(2500); // not after waiting for a save that would never bring it
  // A note link between two %% in other paragraphs is a link, as the window shows it.
  await run.page.evaluate((docId) => window.corillo.openNote(docId!, "Plan B"), id);
  await expect.poll(tabs).toEqual(["Café.md", "Plan B.md", "Q3 plan.md", "plan.md"]);
  // Not in the document: refused, and the person is told.
  await run.page.locator('.tab[title$="/plan.md"]').click();
  await run.page.evaluate((docId) => window.corillo.openLink("secret.md", docId!), id);
  await expect(run.page.locator(".file-notice")).toContainText("Corillo can't open this link.");
  expect(await tabs()).toEqual(["Café.md", "Plan B.md", "Q3 plan.md", "plan.md"]);
  await run.app.close();
});

test("the window learns about pictures only: those beside its document or named in it, and copies in only pictures the person dropped or pasted (MP-10)", async () => {
  const elsewhere = mkdtempSync(join(tmpdir(), "corillo-elsewhere-"));
  const named = join(elsewhere, "Named Chart.png");
  writeFileSync(named, makePng(40, 30, 144));
  writeFileSync(join(elsewhere, "unnamed.png"), makePng(40, 30, 144));
  writeFileSync(join(elsewhere, "secret.txt"), "Not a picture.\n");
  writeFileSync(join(elsewhere, "copied.png"), makePng(10, 10));
  writeFileSync(join(elsewhere, "fake.png"), "Not a picture, whatever its name says.\n");
  const text = `# Plan\n\n![Outside](<${named}>)\n`; // an absolute path, as the person wrote it
  const run = await openText(text, {
    name: "plan.md",
    prepare: (folder) => {
      writeFileSync(join(folder, "beside.png"), makePng(20, 20));
      writeFileSync(join(folder, "notes.txt"), "Not a picture.\n");
    },
  });
  // A picture named in the document, outside its folder, shows sized as it says (144 dots per inch: half its pixels).
  const img = run.page.locator(`${EDITOR} .picture img`);
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(40);
  await expect.poll(() => run.page.locator(`${EDITOR} .picture`).getAttribute("data-points")).toMatch(/^20\.\dx15\.\d$/);

  const ask = (files: string[]) =>
    run.page.evaluate(async (urls) => ({ stamps: await window.corillo.pictureStamps(urls), dpi: await Promise.all(urls.map((u) => window.corillo.pictureDpi(u))) }), files.map((f) => pathToFileURL(f).href));
  const asked = await ask([named, join(elsewhere, "unnamed.png"), join(elsewhere, "secret.txt"), join(run.folder, "beside.png"), join(run.folder, "nothing.png")]);
  expect(asked.stamps.map((s) => s !== null)).toEqual([true, false, false, true, false]);
  expect(asked.dpi.map((d) => d !== null)).toEqual([true, false, false, false, false]); // beside.png says no dots per inch
  // An Obsidian embed's picture is looked for by name: only a picture, never another kind of file.
  const id = await frontId(run.page);
  const found = await run.page.evaluate((docId) => Promise.all([window.corillo.findPicture(docId!, "beside.png"), window.corillo.findPicture(docId!, "notes.txt")]), id);
  expect(found).toEqual([pathToFileURL(join(run.folder, "beside.png")).href, null]);

  // Copying a picture in: only one the person dropped or pasted, or named in what they pasted, never a path the page makes up.
  const copyIn = (file: string) => run.page.evaluate(([docId, p]) => window.corillo.importImage(docId!, p), [id, file] as const);
  const copied = (name: string) => `<p>Copied.</p><img src="${pathToFileURL(join(elsewhere, name)).href}">`;
  await clipboardHoldsHtml(run.app, copied("fake.png"));
  expect(await copyIn(join(elsewhere, "unnamed.png"))).toBeNull();
  expect(await copyIn(join(elsewhere, "secret.txt"))).toBeNull();
  expect(await copyIn(join(elsewhere, "fake.png"))).toBeNull(); // on the clipboard, but not a picture
  expect(existsSync(join(run.folder, "plan images"))).toBe(false);
  // Named in what the person copied (from Word, or another document): it comes in.
  await clipboardHoldsHtml(run.app, copied("copied.png"));
  expect(await copyIn(join(elsewhere, "copied.png"))).toBe("plan%20images/copied.png");
  await run.page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "pick-for-drop";
    input.hidden = true;
    document.body.append(input);
  });
  await run.page.setInputFiles("#pick-for-drop", join(elsewhere, "unnamed.png"));
  await cursorAtEnd(run.page, "Plan", "h1");
  await run.page.evaluate(() => {
    const input = document.getElementById("pick-for-drop") as HTMLInputElement;
    const transfer = new DataTransfer();
    transfer.items.add(input.files![0]);
    input.remove();
    document.querySelector(".doc:not([hidden]) .ProseMirror")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await expect.poll(run.text).toContain("![unnamed](plan%20images/unnamed.png)");
  expect(readFileSync(join(run.folder, "plan images", "unnamed.png")).equals(readFileSync(join(elsewhere, "unnamed.png")))).toBe(true);
  await run.app.close();
});

/**
 * A second window showing one of Corillo's pages with the document window's bridge, as Help used to have.
 * Help's script then finds no bridge of its own and throws: expected here, and only here, so a test that
 * opens this window takes that error out (`forgiveHelpsMissingBridge`) before it closes the app.
 */
async function windowWithFullBridge(app: ElectronApplication): Promise<Page> {
  const [page] = await Promise.all([
    app.waitForEvent("window"),
    app.evaluate(({ app: a, BrowserWindow }) => {
      const dist = `${a.getAppPath()}/dist`;
      const w = new BrowserWindow({ show: false, webPreferences: { preload: `${dist}/preload.cjs`, contextIsolation: true, sandbox: true } });
      void w.loadFile(`${dist}/help.html`);
    }),
  ]);
  await page.waitForLoadState("domcontentloaded");
  return page;
}

/** Take Help's error in `windowWithFullBridge` out of what the window threw: from that page's script, nowhere else. */
function forgiveHelpsMissingBridge(run: Running): void {
  const expected = /^TypeError: Cannot read properties of undefined \(reading 'help'\)\n[\s\S]*\/dist\/help\.js:/;
  const kept = run.thrown!.filter((e) => !expected.test(e));
  run.thrown!.splice(0, run.thrown!.length, ...kept);
}

test("each of the app's channels answers only the window it's for, and Help has only what Help needs (MP-10)", async () => {
  const run = await openText("Plan.\n", { name: "plan.md" });
  const id = await frontId(run.page);
  const other = await windowWithFullBridge(run.app);
  const tried = await other.evaluate(async (docId) => {
    try {
      return await window.corillo.save(docId!, "Written from another window.\n");
    } catch (err) {
      return `refused: ${(err as Error).message}`;
    }
  }, id);
  expect(String(tried)).toMatch(/^refused/);
  expect(run.text()).toBe("Plan.\n");
  // The pictures' channels too (S21-52): nothing is written beside the document.
  const png = join(run.folder, "dot.png");
  writeFileSync(png, makePng(2, 2));
  const pictures = await other.evaluate(
    async ([docId, file]) => {
      const tries = [
        () => window.corillo.saveImageData(docId!, new Uint8Array([137, 80, 78, 71]), "image/png"),
        () => window.corillo.importImage(docId!, file),
      ];
      const out: string[] = [];
      for (const t of tries) {
        try {
          out.push(String(await t()));
        } catch (err) {
          out.push(`refused: ${(err as Error).message}`);
        }
      }
      return out;
    },
    [id, png] as const,
  );
  expect(pictures).toEqual([expect.stringMatching(/^refused/), expect.stringMatching(/^refused/)]);
  expect(existsSync(join(run.folder, "plan images"))).toBe(false);
  // Messages sent one way, and one that waits for its answer, are dropped too (R-MAIN-16).
  const answered = await other.evaluate((docId) => {
    window.corillo.closed(docId!); // as if the tab had closed
    return window.corillo.menus.clicked({ table: true, editable: true, comment: false }); // waits for main's answer
  }, id);
  expect(answered).toBeUndefined();
  await other.close();
  // The document is still open in Corillo: it still saves, and an agent still finds it open.
  await cursorAtEnd(run.page, "Plan.");
  await run.page.keyboard.type(" Still open.");
  await expect.poll(run.text).toBe("Plan. Still open.\n");
  const { session } = await AgentSession.start(run.dataDir);
  try {
    expect(await session.ok("list_documents")).toContain("plan.md");
  } finally {
    await session.stop();
  }

  // The Help window's bridge: its pages, and connecting agents.
  const [help] = await Promise.all([run.app.waitForEvent("window"), clickMenu(run.app, "corillo-help")]);
  await help.waitForSelector("#start:not([hidden])");
  expect(await help.evaluate(() => typeof (window as unknown as { corillo?: unknown }).corillo)).toBe("undefined");
  expect(
    await help.evaluate(() => {
      const api = (window as unknown as { corilloHelp: Record<string, Record<string, unknown>> }).corilloHelp;
      return Object.fromEntries(Object.entries(api).map(([k, v]) => [k, Object.keys(v).sort()]));
    }),
  ).toEqual({ agents: ["copy", "manual", "showConnect"], help: ["onPage"] });
  forgiveHelpsMissingBridge(run);
  await run.app.close();
});

test("the window is refused every permission: camera, microphone, location, notifications and the rest (MP-10)", async () => {
  const run = await openText("Hello.\n");
  const asked = await run.page.evaluate(async () => {
    const out: Record<string, string> = {};
    for (const name of ["geolocation", "camera", "microphone", "notifications", "midi", "persistent-storage", "clipboard-read"]) {
      out[name] = (await navigator.permissions.query({ name: name as PermissionName })).state;
    }
    out.persist = String(await navigator.storage.persist());
    const attempt = async (f: () => Promise<unknown>) => f().then(() => "allowed", (e: Error) => `refused (${e.name})`);
    out.screens = await attempt(() => (window as unknown as { getScreenDetails(): Promise<unknown> }).getScreenDetails());
    out.midiAccess = await attempt(() => (navigator as unknown as { requestMIDIAccess(): Promise<unknown> }).requestMIDIAccess());
    return out;
  });
  expect(asked).toEqual({
    geolocation: "denied",
    camera: "denied",
    microphone: "denied",
    notifications: "denied",
    midi: "denied",
    "persistent-storage": "denied",
    "clipboard-read": "denied",
    persist: "false",
    screens: "refused (NotAllowedError)",
    midiAccess: "refused (NotAllowedError)",
  });
  await run.app.close();
});

/** In a page: add a script tag for this file, and say whether it was let in and whether it ran. */
function tryScript(page: Page, url: string): Promise<{ how: string; ran: boolean }> {
  return page.evaluate(async (src) => {
    const g = window as unknown as { strangerRan?: boolean };
    const tag = document.createElement("script");
    tag.src = src;
    const how = await new Promise<string>((resolve) => {
      tag.onload = () => resolve("loaded");
      tag.onerror = () => resolve("blocked");
      document.head.append(tag);
    });
    tag.remove();
    return { how, ran: g.strangerRan === true };
  }, url);
}

test("only Corillo's own scripts run in its pages: a script file elsewhere on the disk doesn't (MP-10)", async () => {
  const run = await openText("Hello.\n");
  const stranger = join(run.folder, "x.js");
  writeFileSync(stranger, "window.strangerRan = true;\n");
  expect(await tryScript(run.page, pathToFileURL(stranger).href)).toEqual({ how: "blocked", ran: false });
  // Not even one of Corillo's own files that isn't one of the page's scripts.
  const appPath = await run.app.evaluate(({ app }) => app.getAppPath());
  expect(await tryScript(run.page, pathToFileURL(join(appPath, "dist", "help.js")).href)).toMatchObject({ how: "blocked" });

  const [help] = await Promise.all([run.app.waitForEvent("window"), clickMenu(run.app, "corillo-help")]);
  await help.waitForSelector("#start:not([hidden])");
  expect(await tryScript(help, pathToFileURL(stranger).href)).toEqual({ how: "blocked", ran: false });
  // Each page's rule names only its own scripts, by their contents.
  for (const page of ["index.html", "help.html", "about.html", "export.html"]) {
    const html = readFileSync(join(appPath, "dist", page), "utf8");
    const rule = /script-src ([^;"]+)/.exec(html)![1].trim().split(/\s+/);
    expect(rule.length, page).toBeGreaterThan(0);
    for (const source of rule) expect(source, page).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
  }
  await run.app.close();
});

/** In a page: try to read a file as the page's own scripts could: by fetch, by XMLHttpRequest, and in a frame. */
function tryRead(page: Page, url: string): Promise<{ fetch: string; xhr: string; frame: string }> {
  return page.evaluate(async (u) => {
    const fetched = await fetch(u).then(
      (r) => r.text(),
      () => "refused",
    );
    const xhr = await new Promise<string>((resolve) => {
      const request = new XMLHttpRequest();
      request.onload = () => resolve(request.responseText);
      request.onerror = () => resolve("refused");
      try {
        request.open("GET", u);
        request.send();
      } catch {
        resolve("refused");
      }
    });
    const frame = await new Promise<string>((resolve) => {
      const f = document.createElement("iframe");
      f.hidden = true;
      const done = (what: string) => {
        f.remove();
        resolve(what);
      };
      f.onload = () => {
        try {
          done(f.contentDocument?.body?.textContent || "refused");
        } catch {
          done("refused");
        }
      };
      setTimeout(() => done("refused"), 1500);
      f.src = u;
      document.body.append(f);
    });
    return { fetch: fetched, xhr, frame };
  }, url);
}

test("a page can't read files on the Mac: what the window learns about files comes only through what the app answers (MP-10)", async () => {
  const run = await openText("Hello.\n");
  const secret = join(run.folder, "secret.txt");
  writeFileSync(secret, "secret words\n");
  expect(await tryRead(run.page, pathToFileURL(secret).href)).toEqual({ fetch: "refused", xhr: "refused", frame: "refused" });
  expect(await tryRead(run.page, pathToFileURL(run.file).href)).toEqual({ fetch: "refused", xhr: "refused", frame: "refused" });
  const [help] = await Promise.all([run.app.waitForEvent("window"), clickMenu(run.app, "corillo-help")]);
  await help.waitForSelector("#start:not([hidden])");
  expect(await tryRead(help, pathToFileURL(secret).href)).toEqual({ fetch: "refused", xhr: "refused", frame: "refused" });
  await run.app.close();
});
