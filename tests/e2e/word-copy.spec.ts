// Opening a Word document (roadmap Batch 5, item 1): File > Open, a drop on
// the window, a drop on the Dock icon and Finder's Open With all take a .docx.
// Corillo asks once, makes a Markdown copy beside it with the Pandoc inside it
// (tracked changes accepted, Word's comments left out, pictures in "<name>
// images"), and opens the copy: History's first version says what it was made
// from, and exporting to Word uses the Word file's styles. The Word file is
// never changed, Cancel leaves nothing, and nothing is left in the temporary
// folder.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clickMenu, openFromFinder, openText, pickInNextDialog, tabState, tableCells, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";
import { LOGO, makeDocx } from "../fixtures/make-docx";
import { readZipFileEntries } from "../../src/main/zip";

const ROOT = join(import.meta.dirname, "..", "..");
const PANEL = ".doc:not([hidden]) .history-panel";
/** The notice on the tab in front. */
const NOTICE = ".doc:not([hidden]) .file-notice:not([hidden])";

test.beforeAll(() => {
  test.setTimeout(600_000);
  execFileSync(process.execPath, [join(ROOT, "scripts", "fetch-pandoc.mjs"), `--arch=${process.arch}`], { stdio: "inherit" });
});

interface Asked {
  message: string;
  detail: string;
  buttons: string[];
}

/**
 * Answer Corillo's next questions with these buttons, in turn (Cancel once
 * they run out); note every question, and every box saying a file can't be
 * opened. Returns what was asked and said so far.
 */
async function answer(app: ElectronApplication, ...buttons: string[]): Promise<() => Promise<{ asked: Asked[]; errors: string[] }>> {
  await app.evaluate(({ dialog }, answers) => {
    const g = globalThis as unknown as { asked: Asked[]; errors: string[]; answers: string[] };
    g.asked = [];
    g.errors = [];
    g.answers = [...answers];
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const o = args.find((a) => typeof a === "object" && a !== null && "message" in a) as { message: string; detail?: string; buttons?: string[]; cancelId?: number };
      g.asked.push({ message: o.message, detail: o.detail ?? "", buttons: o.buttons ?? [] });
      const at = (o.buttons ?? []).indexOf(g.answers.shift() ?? "");
      return { response: at >= 0 ? at : (o.cancelId ?? 0), checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;
    dialog.showErrorBox = (title: string, content: string) => void g.errors.push(`${title}: ${content}`);
  }, buttons);
  return () => app.evaluate(() => {
    const g = globalThis as unknown as { asked: Asked[]; errors: string[] };
    return { asked: g.asked, errors: g.errors };
  });
}

/** Drop files on the window, as the person does from Finder. */
async function drop(page: Page, ...files: string[]): Promise<void> {
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.id = "pick-for-drop";
    input.hidden = true;
    document.body.append(input);
  });
  await page.setInputFiles("#pick-for-drop", files);
  await page.evaluate(() => {
    const input = document.getElementById("pick-for-drop") as HTMLInputElement;
    const transfer = new DataTransfer();
    for (const file of input.files!) transfer.items.add(file);
    document.body.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    input.remove();
  });
}

/** Put a Word document in the test's folder. */
function wordIn(run: Running, name = "Offsite notes.docx", options: Parameters<typeof makeDocx>[0] = {}): string {
  const file = join(run.folder, name);
  writeFileSync(file, makeDocx(options));
  return file;
}

/** A tab's name, with or without ".md" (how the tabs name documents may change). */
const named = (stem: string) => new RegExp(`^${stem}(\\.md)?$`);

/** Work folders of copies, left in the temporary folder. */
const copyWork = () => readdirSync(tmpdir()).filter((f) => f.startsWith("corillo-word-copy-"));

test("a Word document dropped on the window opens as a Markdown copy beside it: asked once, its text, list, table and picture, a notice on its tab, History's first version, and Export with the Word file's look", async () => {
  test.setTimeout(120_000);
  const run = await openText("# Start\n", { name: "start.md" });
  const word = wordIn(run, "Offsite notes.docx", { comments: 2 });
  const before = readFileSync(word);
  const told = await answer(run.app, "Make a Copy");
  await drop(run.page, word);

  await expect(run.page.locator(`${EDITOR} h2`)).toHaveText("Who");
  expect((await told()).asked).toEqual([
    {
      message: "Corillo works on a copy of Offsite notes.docx, saved next to it as Offsite notes.md.",
      detail: "The Word file isn't changed.",
      buttons: ["Make a Copy", "Cancel"],
    },
  ]);
  expect((await tabState(run.page)).active).toMatch(named("Offsite notes"));
  // The copy: the title and headings, bold, the tracked change accepted and Word's comments left out, a list, a table and the picture.
  await expect(run.page.locator(`${EDITOR} h1`)).toHaveText(["Offsite notes", "Plan"]);
  await expect(run.page.locator(`${EDITOR} strong`)).toHaveText("March");
  const words = await run.page.locator(EDITOR).innerText();
  expect(words).toContain("at the lake house");
  expect(words).not.toContain("downtown");
  expect(words).not.toContain("final budget");
  await expect(run.page.locator(`${EDITOR} li`)).toHaveText(["Book the venue", "Send the agenda"]);
  expect(await tableCells(run.page)).toEqual([["Name", "Role"], ["Ana", "Host"], ["Ben", "Notes"]]);
  await expect.poll(() => run.page.locator(`${EDITOR} img[alt="Venue map"]`).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(100);
  // On disk: the copy and its pictures folder beside the Word document, which is unchanged.
  const copy = join(run.folder, "Offsite notes.md");
  expect(readFileSync(copy, "utf8")).toContain("The offsite is in **March**, at the lake house. Budget Budget 2 is set.\n\n- Book the venue\n- Send the agenda\n");
  expect(readFileSync(copy, "utf8")).toContain("![Venue map](Offsite%20notes%20images/image1.png)\n");
  expect(readdirSync(join(run.folder, "Offsite notes images"))).toEqual(["image1.png"]);
  expect(readdirSync(run.folder).sort()).toEqual(["Offsite notes images", "Offsite notes.docx", "Offsite notes.md", "start.md"]);
  expect(readFileSync(word).equals(before)).toBe(true);

  // The notice on its tab says what it was made from and what the copy left out, without naming the copy.
  await expect(run.page.locator(`${NOTICE} .export-notice-text`)).toHaveText("Made from Offsite notes.docx.");
  await expect(run.page.locator(`${NOTICE} .export-notice-detail`)).toHaveText(
    "Its tracked changes are accepted. Its 2 Word comments aren't in this copy; they're still in the Word file. Export to Word uses the Word file's styles.",
  );
  // History's first version.
  await run.page.getByRole("button", { name: "History", exact: true }).click();
  await expect.poll(() => run.page.locator(`${PANEL} .history-who`).allTextContents()).toEqual(["Made from Offsite notes.docx"]);

  // Export to Word: suggested under a new name, so the Word file stays as it was, with the Word file's styles.
  await run.app.evaluate(({ dialog }, chosen) => {
    const g = globalThis as unknown as { suggested: string };
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      g.suggested = (args[args.length - 1] as { defaultPath?: string }).defaultPath ?? "";
      return { canceled: false, filePath: chosen };
    }) as typeof dialog.showSaveDialog;
  }, join(run.folder, "Offsite notes 2.docx"));
  await clickMenu(run.app, "export-word");
  await expect(run.page.locator(".export-notice")).toContainText("Exported to Offsite notes 2.docx", { timeout: 45_000 });
  expect(await run.app.evaluate(() => (globalThis as unknown as { suggested: string }).suggested)).toBe(join(run.folder, "Offsite notes 2.docx"));
  const styles = execFileSync("unzip", ["-p", join(run.folder, "Offsite notes 2.docx"), "word/styles.xml"], { encoding: "utf8" });
  expect(styles).toContain('w:color w:val="8A2BE2"'); // the Word file's heading colour
  expect(styles).not.toContain('w:ascii="Aptos"'); // not Corillo's own style
  expect(readFileSync(word).equals(before)).toBe(true);
  expect(copyWork()).toEqual([]);
  await run.app.close();
});

/** Pretend the person chose this file in the next Export dialog. */
async function exportAs(app: ElectronApplication, file: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
  }, file);
  await clickMenu(app, "export-word");
}

/** Every file inside a Word document, by name. */
function filesIn(docx: string): Map<string, Buffer> {
  return readZipFileEntries(docx, () => true);
}

test("the copy's export to Word takes only the Word file's look: the copy's own pictures, the header's logo, no Track Changes or editing lock, and still once the Word file is gone (B5-02, B5-04)", async () => {
  test.setTimeout(150_000);
  const run = await openText("# Start\n", { name: "start.md" });
  const word = wordIn(run, "Offsite notes.docx", { morePictures: 2, comments: 1, locked: true, header: true });
  await answer(run.app, "Make a Copy");
  await drop(run.page, word);
  await expect(run.page.locator(`${EDITOR} h2`)).toHaveText("Who");
  const copy = join(run.folder, "Offsite notes.md");
  // The person takes a picture out of the copy (here as another app would; the page follows).
  const deleted = readFileSync(join(run.folder, "Offsite notes images", "image3.png"));
  writeFileSync(copy, readFileSync(copy, "utf8").replace(/!\[Photo 3\]\([^)]*\)\n\n/, ""));
  expect(readFileSync(copy, "utf8")).not.toContain("Photo 3");
  await expect(run.page.locator(`${EDITOR} img[alt="Photo 3"]`)).toHaveCount(0);
  await expect(run.page.locator(`${EDITOR} img[alt="Photo 2"]`)).not.toHaveCount(0);

  const check = (docx: string) => {
    const files = filesIn(docx);
    const media = [...files].filter(([name]) => name.startsWith("word/media/"));
    // The copy's two pictures and the header's logo; the picture taken out is nowhere in it, nor are the Word file's own.
    expect(media).toHaveLength(3);
    expect([...files.values()].some((data) => data.equals(deleted))).toBe(false);
    expect(media.some(([, data]) => data.equals(Buffer.from(LOGO)))).toBe(true);
    const settings = files.get("word/settings.xml")!.toString("utf8");
    expect(settings).not.toMatch(/trackRevisions|documentProtection|writeProtection|docVars/);
    // The Word file's look: its heading colour and its header.
    expect(files.get("word/styles.xml")!.toString("utf8")).toContain('w:color w:val="8A2BE2"');
    expect([...files.keys()].some((n) => /^word\/header\d*\.xml$/.test(n) && files.get(n)!.toString("utf8").includes("Offsite notes, draft"))).toBe(true);
    expect(files.get("word/document.xml")!.toString("utf8")).toContain("at the lake house");
  };

  const first = join(run.folder, "Offsite notes 2.docx");
  await exportAs(run.app, first);
  await expect(run.page.locator(".export-notice")).toContainText("Exported to Offsite notes 2.docx", { timeout: 45_000 });
  check(first);

  // The Word file moved away (to the Trash, say): the copy still exports with its look.
  const away = mkdtempSync(join(tmpdir(), "corillo-away-"));
  renameSync(word, join(away, "Offsite notes.docx"));
  const second = join(run.folder, "For Ana.docx");
  await exportAs(run.app, second);
  await expect(run.page.locator(".export-notice")).toContainText("Exported to For Ana.docx", { timeout: 45_000 });
  check(second);
  expect(copyWork()).toEqual([]);
  await run.app.close();
});

test("an export never writes over the Word file the copy was made from: the person's, even after saying Replace, nor an agent's, even with replace (B5-01)", async () => {
  test.setTimeout(150_000);
  const run = await openText("# Start\n", { name: "start.md" });
  const word = wordIn(run, "Offsite notes.docx", { comments: 2 });
  const before = readFileSync(word);
  await answer(run.app, "Make a Copy");
  await drop(run.page, word);
  await expect(run.page.locator(`${EDITOR} h2`)).toHaveText("Who");
  const copy = join(run.folder, "Offsite notes.md");

  // The person chooses the Word file's own name in the Export dialog, and says Replace.
  await exportAs(run.app, word);
  await expect(run.page.locator(".export-notice")).toContainText(
    "Offsite notes.docx is the Word document this copy was made from, so Corillo doesn't write over it. Export again and choose another name.",
    { timeout: 45_000 },
  );
  expect(readFileSync(word).equals(before)).toBe(true);

  // An agent: by default the export goes beside it under a new name, never over the Word file.
  const { session } = await AgentSession.start(run.dataDir);
  try {
    const done = await session.ok("export_document", { path: copy, format: "word" });
    expect(done).toContain(`Exported Offsite notes.md as a Word document: ${join(run.folder, "Offsite notes 2.docx")}`);
    expect(readFileSync(word).equals(before)).toBe(true);
    // Named, with replace: refused, and told how to go on.
    for (const output_path of [word, run.folder]) {
      const refused = await session.call("export_document", { path: copy, format: "word", output_path, replace: true });
      expect(refused.isError).toBe(true);
      expect(refused.text).toBe(
        "Offsite notes.docx is the Word document Offsite notes.md was made from, and Corillo never writes over it, even with replace. Leave out output_path to export to Offsite notes 3.docx beside it, or give another.",
      );
    }
    // Moved in Finder, it's still the Word file it was made from.
    mkdirSync(join(run.folder, "Archive"));
    const moved = join(run.folder, "Archive", "Old notes.docx");
    renameSync(word, moved);
    const refused = await session.call("export_document", { path: copy, format: "word", output_path: moved, replace: true });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Old notes.docx is the Word document Offsite notes.md was made from");
    expect(readFileSync(moved).equals(before)).toBe(true);
  } finally {
    await session.stop();
  }
  expect(existsSync(join(run.folder, "Offsite notes 3.docx"))).toBe(false);
  await run.app.close();
});

test("Cancel leaves everything as it was: no copy, no pictures folder, no tab", async () => {
  const run = await openText("# Start\n", { name: "start.md" });
  const word = wordIn(run);
  const told = await answer(run.app, "Cancel");
  await drop(run.page, word);
  await expect.poll(async () => (await told()).asked.length).toBe(1);
  await run.page.waitForTimeout(300);
  expect(readdirSync(run.folder).sort()).toEqual(["Offsite notes.docx", "start.md"]);
  await expect(run.page.locator(".doc")).toHaveCount(1);
  expect(copyWork()).toEqual([]);
  await run.app.close();
});

test("from Finder or File > Open, the same question; opened again, it opens the copy already there or makes a new one beside it, never over it", async () => {
  test.setTimeout(90_000);
  const run = await openText("# Start\n", { name: "start.md" });
  const word = wordIn(run);
  let told = await answer(run.app, "Make a Copy");
  await openFromFinder(run.app, word); // Finder's Open With, or a drop on the Dock icon
  await expect(run.page.locator(`${EDITOR} h2`)).toHaveText("Who");
  const copy = join(run.folder, "Offsite notes.md");
  const first = readFileSync(copy, "utf8");

  // File > Open on it again: the copy is there, so Corillo offers it.
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator(".doc")).toHaveCount(1);
  told = await answer(run.app, "Open Offsite notes.md");
  await pickInNextDialog(run.app, word);
  await clickMenu(run.app, "open");
  await expect(run.page.locator(`${EDITOR} h2`)).toHaveText("Who");
  expect((await told()).asked).toEqual([
    {
      message: "Offsite notes.md is already next to Offsite notes.docx.",
      detail: "Open it to carry on with it, or make a new copy of the Word file as it is now, saved as Offsite notes 2.md. The Word file isn't changed.",
      buttons: ["Open Offsite notes.md", "Make a New Copy", "Cancel"],
    },
  ]);
  expect(readdirSync(run.folder).sort()).toEqual(["Offsite notes images", "Offsite notes.docx", "Offsite notes.md", "start.md"]);
  expect(readFileSync(copy, "utf8")).toBe(first);

  // Or a new copy, numbered, with its own pictures folder.
  told = await answer(run.app, "Make a New Copy");
  await openFromFinder(run.app, word);
  await expect.poll(async () => (await tabState(run.page)).active).toMatch(named("Offsite notes 2"));
  expect(readdirSync(run.folder).sort()).toEqual([
    "Offsite notes 2 images",
    "Offsite notes 2.md",
    "Offsite notes images",
    "Offsite notes.docx",
    "Offsite notes.md",
    "start.md",
  ]);
  expect(readFileSync(join(run.folder, "Offsite notes 2.md"), "utf8")).toBe(first.replace("Offsite%20notes%20images", "Offsite%20notes%202%20images"));
  expect(readFileSync(copy, "utf8")).toBe(first);
  await run.app.close();
});

test("several Word documents dropped at once are each asked about in turn, and a Markdown file dropped with them just opens", async () => {
  test.setTimeout(90_000);
  const run = await openText("# Start\n", { name: "start.md" });
  const plan = wordIn(run, "Plan.docx");
  const budget = wordIn(run, "Budget.docx", { noPicture: true });
  const notes = join(run.folder, "notes.md");
  writeFileSync(notes, "# Notes\n");
  const told = await answer(run.app, "Make a Copy", "Make a Copy");
  await drop(run.page, plan, budget, notes);
  await expect.poll(async () => (await tabState(run.page)).names.length).toBe(4);
  expect((await told()).asked.map((a) => a.message)).toEqual([
    "Corillo works on a copy of Plan.docx, saved next to it as Plan.md.",
    "Corillo works on a copy of Budget.docx, saved next to it as Budget.md.",
  ]);
  expect(readdirSync(run.folder).sort()).toEqual(["Budget.docx", "Budget.md", "Plan images", "Plan.docx", "Plan.md", "notes.md", "start.md"]);
  await run.app.close();
});

test("a Word document in a folder Corillo can't save in: the person chooses where its copy goes", async () => {
  test.setTimeout(60_000);
  const run = await openText("# Start\n", { name: "start.md" });
  const shared = mkdtempSync(join(tmpdir(), "corillo-shared-"));
  const word = join(shared, "Offsite notes.docx");
  writeFileSync(word, makeDocx());
  chmodSync(shared, 0o555);
  try {
    const told = await answer(run.app, "Choose Where to Save…");
    await run.app.evaluate(({ dialog }, chosen) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
    }, join(run.folder, "My notes"));
    await openFromFinder(run.app, word);
    await expect(run.page.locator(`${EDITOR} h2`)).toHaveText("Who");
    expect((await told()).asked[0].message).toBe("Corillo works on a copy of Offsite notes.docx, but it isn't allowed to save one in that folder.");
    expect(readFileSync(join(run.folder, "My notes.md"), "utf8")).toContain("![Venue map](My%20notes%20images/image1.png)");
    expect(readdirSync(join(run.folder, "My notes images"))).toEqual(["image1.png"]);
    expect(readdirSync(shared)).toEqual(["Offsite notes.docx"]);
  } finally {
    chmodSync(shared, 0o755);
  }
  await run.app.close();
});

test("a Word document Corillo can't read says why in plain words, asks nothing and makes nothing", async () => {
  const run = await openText("# Start\n", { name: "start.md" });
  const older = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
  writeFileSync(join(run.folder, "Locked.docx"), Buffer.concat([older, Buffer.from("EncryptedPackage", "utf16le")]));
  writeFileSync(join(run.folder, "Old notes.doc"), older);
  writeFileSync(join(run.folder, "Damaged.docx"), "not a Word document");
  const told = await answer(run.app);
  await drop(run.page, ...["Locked.docx", "Old notes.doc", "Damaged.docx"].map((f) => join(run.folder, f)));
  await expect.poll(async () => (await told()).errors.length).toBe(3);
  expect((await told()).errors).toEqual([
    "Can't open Locked.docx: It's protected with a password, so Corillo can't read it. Open it in Word, save a copy without the password, then open that in Corillo.",
    "Can't open Old notes.doc: It's in Word's older format (.doc), which Corillo can't read. Open it in Word, save it as a Word document (.docx), then open that in Corillo.",
    "Can't open Damaged.docx: It may be damaged, or not really a Word document. If Word opens it, save it again from Word and try once more.",
  ]);
  expect((await told()).asked).toEqual([]);
  expect(readdirSync(run.folder).sort()).toEqual(["Damaged.docx", "Locked.docx", "Old notes.doc", "start.md"]);
  await run.app.close();
});

test("the window can't have a copy made of a Word document the person didn't give it, nor can an agent", async () => {
  const run = await openText("# Start\n", { name: "start.md" });
  const word = wordIn(run);
  const told = await answer(run.app, "Make a Copy");
  await run.page.evaluate((p) => window.corillo.openPath(p), word);
  await run.page.waitForTimeout(400);
  expect((await told()).asked).toEqual([]);
  expect(readdirSync(run.folder).sort()).toEqual(["Offsite notes.docx", "start.md"]);

  const { session } = await AgentSession.start(run.dataDir);
  const opened = await session.call("open_document", { path: word });
  expect(opened.isError).toBe(true);
  // Told how it opens: the person opens it, and Corillo makes the copy (review of Batch 11, B11R-6).
  expect(opened.text).toBe(
    "Offsite notes.docx is a Word document. Corillo works on a Markdown copy of it: ask the person to open it in Corillo (File > Open), which saves the copy next to it. Then you can open the copy.",
  );
  expect((await told()).asked).toEqual([]);
  expect(readdirSync(run.folder).sort()).toEqual(["Offsite notes.docx", "start.md"]);
  await session.stop();
  await run.app.close();
});

test("Word documents copied and closed many times over leave no temporary files, programs or open files behind", async () => {
  test.setTimeout(180_000);
  const temp = mkdtempSync(join(tmpdir(), "corillo-temp-"));
  const wasTemp = process.env.TMPDIR;
  process.env.TMPDIR = temp; // Corillo's temporary files go here, where they can be counted
  let run: Running | null = null;
  try {
    run = await openText("# Start\n", { name: "start.md" });
    const word = wordIn(run, "Offsite notes.docx", { morePictures: 3 });
    const before = readdirSync(temp);
    const copyAndClose = async (button: string) => {
      await answer(run!.app, button);
      await openFromFinder(run!.app, word);
      await expect.poll(async () => (await tabState(run!.page)).names.length).toBe(2);
      await clickMenu(run!.app, "close-tab");
      await expect(run!.page.locator(".doc")).toHaveCount(1);
    };
    await copyAndClose("Make a Copy");
    const start = await use(run.app);
    for (let i = 0; i < 6; i++) await copyAndClose("Make a New Copy");
    await run.page.waitForTimeout(500);
    const after = await use(run.app);
    console.log(`After 7 copies: ${start.openFiles} → ${after.openFiles} open files, temporary folder ${JSON.stringify(readdirSync(temp))}`);
    expect(readdirSync(temp)).toEqual(before);
    expect(after.openFiles).toBeLessThanOrEqual(start.openFiles + 1);
    expect(after.busy).toEqual(start.busy);
    expect(after.programs.filter((p) => /pandoc/i.test(p))).toEqual([]);
    expect(readdirSync(run.folder).filter((f) => f.endsWith(".md")).length).toBe(8); // start.md and seven copies
  } finally {
    if (wasTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = wasTemp;
    await run?.app.close();
  }
});

/** What the app has open and running: files, timers and the like by kind, and the programs it started. */
async function use(app: ElectronApplication): Promise<{ openFiles: number; busy: Record<string, number>; programs: string[] }> {
  const inside = await app.evaluate(() => {
    const load = (process as unknown as { mainModule: { require: NodeRequire } }).mainModule.require;
    const busy: Record<string, number> = {};
    for (const kind of (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo()) busy[kind] = (busy[kind] ?? 0) + 1;
    return { openFiles: (load("fs") as typeof import("node:fs")).readdirSync("/dev/fd").length, busy };
  });
  const pid = app.process().pid;
  const programs = execFileSync("ps", ["-A", "-o", "ppid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => Number(parts[0]) === pid)
    .map((parts) => parts.slice(1).join(" "));
  return { ...inside, programs };
}
