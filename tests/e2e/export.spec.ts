// Word and PDF export: Word documents made by the bundled Pandoc, with
// pictures and diagrams embedded; PDFs printed from Corillo's own view;
// optional styling from a Word document, a Lua filter or a script.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openAlso, openText, chooseFromMenu, clickMenu, cursorAtEnd, pickInNextDialog, EDITOR, FIXTURES, type Running } from "./helpers";
import { captureClipboardWrites, tabState } from "./helpers";
import { makeZip } from "../../src/main/zip";
import { pngInfo } from "../../src/core/png";
import { wordFileProblems } from "../word-check";

const PNG = join(FIXTURES, "chart.png");
const ROOT = join(import.meta.dirname, "..", "..");

// The tests need Pandoc; fetch it the first time (just for this Mac's processor).
test.beforeAll(() => {
  test.setTimeout(600_000);
  execFileSync(process.execPath, [join(ROOT, "scripts", "fetch-pandoc.mjs"), `--arch=${process.arch}`], { stdio: "inherit" });
});

const DOC = `# Q3 proposal

Volunteers would answer people faster.[^1]

| Option | Cost |
|--------|------|
| Tool A | Free |

![chart](<proposal images/chart.png>)

\`\`\`mermaid
graph LR
  Ask --> Draft --> Review
\`\`\`

See [the plan](https://example.com/plan).

\`\`\`
let answer = 42;
\`\`\`

[^1]: Measured over August.
`;

const withPicture = (folder: string) => {
  mkdirSync(join(folder, "proposal images"));
  copyFileSync(PNG, join(folder, "proposal images", "chart.png"));
};

/** Pretend the person chose this file in the next save dialog; returns what the dialog was asked to suggest. */
async function saveInNextDialog(app: ElectronApplication, filePath: string): Promise<() => Promise<string>> {
  await app.evaluate(({ dialog }, chosen) => {
    const g = globalThis as unknown as { suggested: string };
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      const options = args[args.length - 1] as { defaultPath?: string };
      g.suggested = options.defaultPath ?? "";
      return { canceled: false, filePath: chosen };
    }) as typeof dialog.showSaveDialog;
  }, filePath);
  return () => app.evaluate(() => (globalThis as unknown as { suggested: string }).suggested);
}

/** Keep the Finder and other apps out of it: Open and Show in Finder are recorded instead. */
async function recordShell(app: ElectronApplication): Promise<() => Promise<{ opened: string[]; shown: string[] }>> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { shellCalls: { opened: string[]; shown: string[] } };
    g.shellCalls = { opened: [], shown: [] };
    shell.openPath = (async (p: string) => {
      g.shellCalls.opened.push(p);
      return "";
    }) as typeof shell.openPath;
    shell.showItemInFolder = ((p: string) => {
      g.shellCalls.shown.push(p);
    }) as typeof shell.showItemInFolder;
  });
  return () => app.evaluate(() => (globalThis as unknown as { shellCalls: { opened: string[]; shown: string[] } }).shellCalls);
}

const zipEntries = (file: string) => execFileSync("unzip", ["-Z1", file], { encoding: "utf8" }).trim().split("\n");
const zipRead = (file: string, entry: string) => execFileSync("unzip", ["-p", file, entry], { maxBuffer: 64 * 1024 * 1024 });
const notice = (page: Page) => page.locator(".export-notice");

/** How far the notice's dot and its buttons sit from the middle of its first line of words, in pixels. */
function offLine(page: Page) {
  return notice(page).evaluate((box) => {
    const middle = (el: Element | null) => {
      const r = el!.getBoundingClientRect();
      return r.top + r.height / 2;
    };
    const line = middle(box.querySelector(".export-notice-text"));
    const buttons = [...box.querySelectorAll("button")].filter((b) => !b.hidden);
    return [middle(box.querySelector(".export-notice-dot")), ...buttons.map(middle)].map((m) => Math.round(Math.abs(m - line)));
  });
}

async function exportTo(run: Running, format: "Export to Word" | "PDF", name: string): Promise<string> {
  const out = join(run.folder, name);
  await saveInNextDialog(run.app, out);
  await chooseFromMenu(run.page, "Export", format);
  await expect(notice(run.page)).toContainText(`Exported to ${name}`, { timeout: 45_000 });
  // Every Word file the tests make gets the same look inside (tests/word-check.ts).
  if (format === "Export to Word") expect(wordFileProblems(out)).toEqual([]);
  return out;
}

test("Export, Word document makes a Word file with the text, table, footnote, link, code, picture and diagram", async () => {
  test.setTimeout(90_000);
  const run = await openText(DOC, { prepare: withPicture });
  const out = join(run.folder, "proposal.docx");
  const suggested = await saveInNextDialog(run.app, out);
  await chooseFromMenu(run.page, "Export", "Export to Word");
  await expect(notice(run.page)).toContainText("Exported to proposal.docx", { timeout: 45_000 });
  expect(await suggested()).toBe(join(run.folder, "proposal.docx"));

  const xml = zipRead(out, "word/document.xml").toString("utf8");
  expect(xml).toContain("Q3 proposal");
  expect(xml).toContain('w:val="Heading1"');
  expect(xml).toContain("Volunteers would answer people faster.");
  expect(xml).toContain("<w:tbl>");
  expect(xml).toContain("Tool A");
  expect(xml).toContain("<w:footnoteReference");
  expect(xml).toContain("<w:hyperlink");
  expect(xml).toContain('w:val="SourceCode"');
  expect(xml).toContain("let answer = 42;");
  expect(xml).toContain('w:val="Diagram"');
  expect(xml).not.toContain("graph LR"); // the diagram is a picture, not its code
  expect(zipRead(out, "word/footnotes.xml").toString("utf8")).toContain("Measured over August.");
  const rels = zipRead(out, "word/_rels/document.xml.rels").toString("utf8");
  expect(rels).toContain("https://example.com/plan");

  const media = zipEntries(out).filter((e) => e.startsWith("word/media/"));
  expect(media).toHaveLength(2);
  const pictures = media.map((m) => zipRead(out, m));
  const original = readFileSync(PNG);
  expect(pictures.some((p) => p.equals(original))).toBe(true);
  const diagram = pictures.find((p) => !p.equals(original))!;
  const info = pngInfo(new Uint8Array(diagram));
  expect(info.dpi).toBe(288); // drawn at print resolution
  expect(info.width).toBeGreaterThan(300);

  // The document itself is left alone.
  expect(run.text()).toBe(DOC);
  await run.app.close();
});

test("every diagram becomes a picture in Word, even kinds drawn with HTML labels; one with a mistake stays as code", async () => {
  test.setTimeout(90_000);
  const journey = "```mermaid\njourney\n  title Launch day\n  section Morning\n    Write notes: 5: Me\n```\n";
  const broken = "```mermaid\ngraph LR\n  A -->\n```\n";
  const run = await openText(`${journey}\nThen:\n\n${broken}`);
  const out = await exportTo(run, "Export to Word", "proposal.docx");
  await expect(notice(run.page)).toContainText("A diagram couldn't be drawn, so its code is shown instead.");
  const xml = zipRead(out, "word/document.xml").toString("utf8");
  expect(xml).toContain('w:val="Diagram"');
  expect(xml).not.toContain("Launch day"); // drawn, not shown as code
  expect(xml).toContain("A --&gt;"); // the one with a mistake is shown as code
  expect(zipEntries(out).filter((e) => e.startsWith("word/media/"))).toHaveLength(1);
  await run.app.close();
});

test("the Word document uses Corillo's clean style by default", async () => {
  test.setTimeout(60_000);
  const run = await openText("# Title\n\nText.\n");
  const out = await exportTo(run, "Export to Word", "proposal.docx");
  const styles = zipRead(out, "word/styles.xml").toString("utf8");
  expect(styles).toContain('w:ascii="Aptos"');
  expect(styles).toContain('w:styleId="Table"');
  expect(zipEntries(out)).toContain("word/footer1.xml"); // page numbers
  await run.app.close();
});

test("File, Export to Word… exports too, saving the latest edits first", async () => {
  test.setTimeout(60_000);
  const run = await openText("Draft.\n");
  await cursorAtEnd(run.page, "Draft.");
  await run.page.keyboard.type(" Fresh words");
  const out = join(run.folder, "draft.docx");
  await saveInNextDialog(run.app, out);
  await clickMenu(run.app, "export-word");
  await expect(notice(run.page)).toContainText("Exported to draft.docx", { timeout: 45_000 });
  expect(zipRead(out, "word/document.xml").toString("utf8")).toContain("Fresh words");
  expect(run.text()).toContain("Fresh words");
  await run.app.close();
});

test("line numbers showing in the window don't get into an export", async () => {
  test.setTimeout(90_000);
  const run = await openText(DOC, { prepare: withPicture });
  const plain = await exportTo(run, "Export to Word", "plain.docx");
  await clickMenu(run.app, "line-numbers");
  await expect(run.page.locator(".doc:not([hidden]) .page.editor .ln").first()).toBeVisible();
  const numbered = await exportTo(run, "Export to Word", "numbered.docx");
  // The same, but for the name of the folder a diagram's picture was made in.
  const body = (file: string) => zipRead(file, "word/document.xml").toString("utf8").replace(/corillo-export-\w+/g, "");
  expect(body(numbered)).toBe(body(plain));
  await run.app.close();
});

test("Export, PDF prints the formatted document, pictures and diagrams included", async () => {
  test.setTimeout(90_000);
  const run = await openText(DOC, { prepare: withPicture });
  const out = join(run.folder, "proposal.pdf");
  const suggested = await saveInNextDialog(run.app, out);
  await chooseFromMenu(run.page, "Export", "PDF");
  await expect(notice(run.page)).toContainText("Exported to proposal.pdf", { timeout: 45_000 });
  expect(await suggested()).toBe(join(run.folder, "proposal.pdf"));
  const pdf = readFileSync(out);
  expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(pdf.toString("latin1")).toMatch(/\/Subtype\s*\/Image/); // the picture is in it
  await run.app.close();
});

test("a PDF of a long document includes diagrams far down the page", async () => {
  test.setTimeout(90_000);
  const filler = Array.from({ length: 300 }, (_, i) => `Paragraph ${i + 1} of the background section.`).join("\n\n");
  const run = await openText(`# Long report\n\n${filler}\n\n\`\`\`mermaid\ngraph LR\n  A[Plan] --> B[Ship]\n\`\`\`\n`);
  await exportTo(run, "PDF", "proposal.pdf");
  await expect(notice(run.page)).not.toContainText("couldn't be drawn");
  await run.app.close();
});

test("front matter at the top of the document is left out of Word and PDF exports", async () => {
  test.setTimeout(120_000);
  const text = "---\ntitle: Secret plan\nstatus: draft\n---\n\n# Plan\n\nBody text.\n";
  const run = await openText(text);
  const docx = await exportTo(run, "Export to Word", "proposal.docx");
  const xml = zipRead(docx, "word/document.xml").toString("utf8");
  expect(xml).toContain("Body text.");
  expect(xml).not.toContain("Secret plan");
  expect(xml).not.toContain("draft");
  // Note the text of the page Corillo prints to PDF.
  await run.app.evaluate(({ webContents }) => {
    const g = globalThis as unknown as { printed: string[] };
    g.printed = [];
    const proto = Object.getPrototypeOf(webContents.getAllWebContents()[0]);
    const original = proto.printToPDF;
    proto.printToPDF = async function (this: Electron.WebContents, ...args: unknown[]) {
      g.printed.push(await this.executeJavaScript("document.body.innerText"));
      return original.apply(this, args);
    };
  });
  await exportTo(run, "PDF", "proposal.pdf");
  const printed = (await run.app.evaluate(() => (globalThis as unknown as { printed: string[] }).printed)).join("\n");
  expect(printed).toContain("Body text.");
  expect(printed).not.toContain("Secret plan");
  // The document itself keeps it.
  expect(run.text()).toBe(text);
  await run.app.close();
});

test("Open and Show in Finder open the exported file and its folder", async () => {
  test.setTimeout(60_000);
  const run = await openText("Short note.\n");
  const calls = await recordShell(run.app);
  const out = await exportTo(run, "Export to Word", "note.docx");
  // The dot, Open, Show in Finder and the close button all sit level with "Exported to note.docx".
  expect(await offLine(run.page)).toEqual([0, 0, 0, 0]);
  await notice(run.page).getByRole("button", { name: "Open" }).click();
  await notice(run.page).getByRole("button", { name: "Show in Finder" }).click();
  await expect.poll(calls).toEqual({ opened: [out], shown: [out] });
  await run.app.close();
});

/** A Word template whose headings use a font nobody would pick by accident. */
function makeTemplate(file: string): void {
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  writeFileSync(
    file,
    makeZip([
      {
        name: "[Content_Types].xml",
        data:
          '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml"/>' +
          '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
      },
      {
        name: "_rels/.rels",
        data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
      },
      { name: "word/document.xml", data: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body><w:p/></w:body></w:document>` },
      {
        name: "word/_rels/document.xml.rels",
        data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/></Relationships>`,
      },
      {
        name: "word/styles.xml",
        data:
          `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
          '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:rFonts w:ascii="Marker Felt" w:hAnsi="Marker Felt"/></w:rPr></w:style></w:styles>',
      },
    ]),
  );
}

async function openSettings(page: Page): Promise<void> {
  await chooseFromMenu(page, "Export", "Export settings…");
  await expect(page.getByRole("dialog", { name: "Export settings" })).toBeVisible();
}

test("Export settings can use a Word template's styles, and the choice is remembered for the document", async () => {
  test.setTimeout(60_000);
  const run = await openText("# Big heading\n\nBody.\n");
  const template = join(run.folder, "Company.dotx");
  makeTemplate(template);
  await openSettings(run.page);
  const sheet = run.page.getByRole("dialog", { name: "Export settings" });
  await expect(sheet.getByRole("radio", { name: "Corillo (clean)" })).toBeChecked();
  await pickInNextDialog(run.app, template);
  await sheet.getByRole("button", { name: "Choose a Word document" }).click();
  await expect(sheet).toContainText("Company.dotx");
  await expect(sheet.getByRole("radio", { name: "Use the styles of a Word document" })).toBeChecked();
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();

  const out = await exportTo(run, "Export to Word", "proposal.docx");
  expect(zipRead(out, "word/styles.xml").toString("utf8")).toContain("Marker Felt");
  expect(zipRead(out, "\\[Content_Types\\].xml").toString("utf8")).toContain("wordprocessingml.document.main+xml");

  // Remembered in Corillo's data folder, not in the document.
  const dataDir = await run.app.evaluate(({ app }) => app.getPath("userData"));
  const index = JSON.parse(readFileSync(join(dataDir, "documents.json"), "utf8")) as Record<string, { path: string }>;
  const id = Object.keys(index).find((k) => index[k].path === run.file)!;
  const settings = JSON.parse(readFileSync(join(dataDir, "documents", id, "settings.json"), "utf8"));
  expect(settings.export).toEqual({ style: "word", referenceDoc: template });
  expect(run.text()).toBe("# Big heading\n\nBody.\n");
  await openSettings(run.page);
  await expect(sheet).toContainText("Company.dotx");
  await expect(sheet.getByRole("radio", { name: "Use the styles of a Word document" })).toBeChecked();
  await run.app.close();
});

test("a Lua filter and a script, set under Advanced, change the Word document", async () => {
  test.setTimeout(60_000);
  const run = await openText("Volunteers answer faster.\n");
  const filter = join(run.folder, "shout.lua");
  writeFileSync(filter, 'function Str(el)\n  if el.text == "Volunteers" then return pandoc.Str("VOLUNTEERS") end\nend\n');
  const script = join(run.folder, "touch-up.sh");
  writeFileSync(script, 'printf "%s" "$1" > "$1.touched"\n'); // not executable: run by its kind
  await openSettings(run.page);
  const sheet = run.page.getByRole("dialog", { name: "Export settings" });
  await sheet.getByText("Advanced").click();
  await pickInNextDialog(run.app, filter);
  await sheet.getByRole("button", { name: "Choose a Lua filter" }).click();
  await pickInNextDialog(run.app, script);
  await sheet.getByRole("button", { name: "Choose a script" }).click();
  await expect(sheet).toContainText("shout.lua");
  await expect(sheet).toContainText("touch-up.sh");
  await sheet.getByRole("button", { name: "Save" }).click();

  const out = await exportTo(run, "Export to Word", "proposal.docx");
  expect(zipRead(out, "word/document.xml").toString("utf8")).toContain("VOLUNTEERS");
  expect(readFileSync(`${out}.touched`, "utf8")).toBe(out);
  await run.app.close();
});

test("a script that fails is reported, and the Word document is still there", async () => {
  test.setTimeout(60_000);
  const run = await openText("Text.\n");
  const script = join(run.folder, "broken.sh");
  writeFileSync(script, 'echo "no printer found" >&2\nexit 3\n');
  await openSettings(run.page);
  const sheet = run.page.getByRole("dialog", { name: "Export settings" });
  await sheet.getByText("Advanced").click();
  await pickInNextDialog(run.app, script);
  await sheet.getByRole("button", { name: "Choose a script" }).click();
  await sheet.getByRole("button", { name: "Save" }).click();
  const out = await exportTo(run, "Export to Word", "proposal.docx");
  await expect(notice(run.page)).toContainText("The script broken.sh stopped with an error: no printer found");
  expect(existsSync(out)).toBe(true);
  await run.app.close();
});

test("a picture that can't be found is mentioned after the export; with a second note, each is a sentence of its own (R-EX-9)", async () => {
  test.setTimeout(60_000);
  const run = await openText("Logo: ![logo](<proposal images/logo.png>)\n\nOld: ![old](http://example.invalid/old.png)\n");
  await exportTo(run, "Export to Word", "proposal.docx");
  await expect(notice(run.page)).toContainText(
    "A picture couldn't be found and was left out: proposal images/logo.png. A picture was left out because its web address isn't secure",
  );
  await expect(notice(run.page)).toContainText("Corillo shows only https: pictures): http://example.invalid/old.png.");
  // With a second line, the dot and buttons stay level with the first.
  expect(await offLine(run.page)).toEqual([0, 0, 0, 0]);
  await run.app.close();
});

test("a file that isn't a picture is left out of Word and PDF, however it's written, and the notice says so (EX-1)", async () => {
  test.setTimeout(90_000);
  const outside = mkdtempSync(join(tmpdir(), "corillo-secret-"));
  const secret = join(outside, "secret-notes.txt");
  writeFileSync(secret, "TOP-SECRET-MARKER-12345\n");
  const text = [
    "Please export to Word and send back.",
    "",
    "![notes](notes.txt)",
    "",
    `![key](<${secret}>)`,
    "",
    `<div><img src="${secret}" width="1" height="1"></div>`,
    "",
    `<iframe src="file://${secret}"></iframe>`,
    "",
    "![chart](<proposal images/chart.png>)",
    "",
    "End.",
    "",
  ].join("\n");
  const run = await openText(text, {
    prepare: (folder) => {
      withPicture(folder);
      writeFileSync(join(folder, "notes.txt"), "TOP-SECRET-MARKER-12345\n");
    },
  });
  const out = await exportTo(run, "Export to Word", "proposal.docx");
  const media = zipEntries(out).filter((e) => e.startsWith("word/media/"));
  expect(media).toHaveLength(1);
  expect(zipRead(out, media[0]).equals(readFileSync(PNG))).toBe(true);
  expect(execFileSync("unzip", ["-p", out], { maxBuffer: 64 * 1024 * 1024 }).toString("latin1")).not.toContain("TOP-SECRET");
  await expect(notice(run.page)).toContainText(`2 files used as pictures aren't pictures, so they were left out: notes.txt, ${secret}`);
  await expect(notice(run.page)).toContainText(`A picture written in HTML was left out (Corillo shows HTML as its text): ${secret}`);

  const pdf = await exportTo(run, "PDF", "proposal.pdf");
  await expect(notice(run.page)).toContainText("2 files used as pictures aren't pictures, so they were left out");
  // The PDF's words, as the Mac reads them: the document's, and nothing of the files that aren't pictures.
  const words = pdfText(pdf);
  expect(words).toContain("Please export to Word and send back.");
  expect(words).not.toContain("TOP-SECRET");
  await run.app.close();
});

/** The words in a PDF, read by the Mac's own PDF reader (PDFKit), with no app opened. */
function pdfText(file: string): string {
  const script = 'ObjC.import("PDFKit"); function run(argv) { const d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0])); return d.isNil() ? "" : ObjC.unwrap(d.string); }';
  return execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, file], { encoding: "utf8" });
}

/**
 * Web servers for pictures on the web, on this Mac: a secure one (https, with
 * a certificate made for the test, which the app is told to trust) that has
 * a picture, one address that never answers, one that isn't there and one
 * that sends you to an insecure address; and a plain http one.
 */
async function pictureServers() {
  const dir = mkdtempSync(join(tmpdir(), "corillo-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  type Asked = { path: string; headers: Record<string, string | string[] | undefined>; open: () => boolean };
  /** The requests since the test last cleared them, and every request (never cleared). */
  const requests: Asked[] = [];
  const asked: Asked[] = [];
  const png = readFileSync(PNG);
  const secure = https.createServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req, res) => {
    const socket = req.socket;
    // Open until it's answered, or the connection it came on is closed.
    const request = { path: req.url ?? "", headers: req.headers, open: () => !res.writableFinished && !socket.destroyed && !socket.readableEnded };
    requests.push(request);
    asked.push(request);
    if (req.url === "/good.png") res.writeHead(200, { "Content-Type": "image/png", "Set-Cookie": "tracker=1" }).end(png);
    else if (req.url?.startsWith("/from-")) res.writeHead(200, { "Content-Type": "image/png" }).end(png); // pictures in diagrams
    else if (req.url === "/stall.png") return; // never answers
    else if (req.url === "/away.png") res.writeHead(302, { Location: `http://127.0.0.1:${plainPort}/good.png` }).end();
    else res.writeHead(404).end("Not here");
  });
  const plainRequests: string[] = [];
  const plain = http.createServer((req, res) => {
    plainRequests.push(req.url ?? "");
    res.writeHead(200, { "Content-Type": "image/png" }).end(png);
  });
  await new Promise<void>((resolve) => secure.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => plain.listen(0, "127.0.0.1", resolve));
  const securePort = (secure.address() as import("node:net").AddressInfo).port;
  const plainPort = (plain.address() as import("node:net").AddressInfo).port;
  return {
    secure: `https://127.0.0.1:${securePort}`,
    plain: `http://127.0.0.1:${plainPort}`,
    requests,
    plainRequests,
    /** The requests not yet answered whose connection is still open: left hanging. */
    stillOpen: () => asked.filter((r) => r.open()).map((r) => r.path),
    /**
     * The requests that weren't Corillo's own fetch, which gives the window's plain name ("Mozilla/5.0", the
     * review of Batch 18, R18-5), asks for any picture ("image/*") and isn't a page's picture (a window's says
     * its request is for an image).
     */
    notCorillos: () =>
      asked
        .filter((r) => r.headers["user-agent"] !== "Mozilla/5.0" || r.headers.accept !== "image/*" || r.headers["sec-fetch-dest"] === "image")
        .map((r) => `${r.path} from ${r.headers["user-agent"]}`),
    /**
     * Open a document with pictures on this server, trusted in every session
     * the app has or makes, so any request an export makes (not just
     * Corillo's own fetch) reaches the server and is counted; the window's
     * own requests (the editor shows the same pictures) are kept from it, so
     * what reaches it is only the export's. The window gets the document's
     * text only once that's so: given it at launch, it asks for the pictures
     * straight away, and a request already on its way when the trust comes
     * in (waiting for its certificate to be checked, more likely on a busy
     * Mac) isn't kept from the server, having started before the rule that
     * keeps it away. The slow picture's is then the window's, which waits
     * for it as long as it shows the picture, and was taken for the export's.
     */
    open: async (text: string): Promise<Running> => {
      const run = await openText("The pictures come in a moment.\n");
      await run.app.evaluate(({ app, BrowserWindow, session }) => {
        const trust = (s: Electron.Session) => s.setCertificateVerifyProc((_r, ok) => ok(0));
        trust(session.defaultSession);
        trust(session.fromPartition("corillo-export-pictures", { cache: false }));
        app.on("session-created", trust);
        const editor = BrowserWindow.getAllWindows()[0].webContents.id;
        session.defaultSession.webRequest.onBeforeRequest((d, callback) => callback({ cancel: d.webContentsId === editor && /^https:/.test(d.url) }));
      });
      writeFileSync(run.file, text);
      await expect(run.page.locator(EDITOR)).toContainText(text.split("\n")[0]);
      return run;
    },
    close: () => {
      secure.closeAllConnections();
      plain.closeAllConnections();
      secure.close();
      plain.close();
    },
  };
}

test("pictures on the web are fetched by Corillo within 10 seconds; the rest are left out and named, in Word and PDF (EX-3)", async () => {
  test.setTimeout(120_000);
  const web = await pictureServers();
  try {
    const text = [
      "Pictures from the web:",
      "",
      `![good](${web.secure}/good.png)`,
      "",
      `![slow](${web.secure}/stall.png)`,
      "",
      `![gone](${web.secure}/gone.png)`,
      "",
      `![away](${web.secure}/away.png)`,
      "",
      `![plain](${web.plain}/plain.png)`,
      "",
      "End.",
      "",
    ].join("\n");
    // Trusted everywhere, so the export page's own fetch, if it made one, would be counted too.
    const run = await web.open(text);
    const started = Date.now();
    const out = await exportTo(run, "Export to Word", "proposal.docx");
    // The 10 second budget, and the export itself, which takes several seconds on a busy Mac. A fetch never
    // stopped would wait out the notice's 45 seconds.
    expect(Date.now() - started).toBeLessThan(30_000);
    const media = zipEntries(out).filter((e) => e.startsWith("word/media/"));
    expect(media).toHaveLength(1);
    expect(zipRead(out, media[0]).equals(readFileSync(PNG))).toBe(true);
    const shown = notice(run.page);
    await expect(shown).toContainText(
      `3 pictures on the web couldn't be loaded and were left out: ${web.secure}/stall.png, ${web.secure}/gone.png, ${web.secure}/away.png`,
    );
    await expect(shown).toContainText(
      `A picture was left out because its web address isn't secure (it starts with http:, and Corillo shows only https: pictures): ${web.plain}/plain.png`,
    );
    // The page shows only https pictures, so the export doesn't fetch the http one, even when sent there.
    expect(web.plainRequests).toEqual([]);
    // Every request the export made was answered or stopped, the slow one included: none left hanging. (A wait
    // for it to be so, not a limit on how fast: on a busy Mac the server can take a while to hear that the other
    // end has gone.) And each was Corillo's own fetch.
    const noneHanging = async () => {
      await expect.poll(web.stillOpen, { timeout: 20_000 }).toEqual([]);
      expect(web.notCorillos()).toEqual([]);
    };
    expect(web.requests.map((r) => r.path)).toContain("/stall.png");
    await noneHanging();
    // The request carries the address and nothing about the person or the document.
    const asked = web.requests.find((r) => r.path === "/good.png")!;
    expect(asked.headers["user-agent"]).toBe("Mozilla/5.0"); // the window's plain name: nothing about Corillo (R18-5)
    expect(JSON.stringify(asked.headers)).not.toMatch(/corillo|electron|chrome/i);
    for (const header of ["cookie", "referer", "origin", "accept-language", "authorization"]) expect(asked.headers[header], header).toBeUndefined();
    expect(Object.keys(asked.headers).filter((h) => h.startsWith("sec-ch-"))).toEqual([]);

    // The PDF follows the same rule, and the page fetches nothing itself.
    web.requests.length = 0;
    await exportTo(run, "PDF", "proposal.pdf");
    await expect(shown).toContainText("3 pictures on the web couldn't be loaded and were left out");
    await expect(shown).toContainText("A picture was left out because its web address isn't secure");
    expect(readFileSync(join(run.folder, "proposal.pdf")).toString("latin1")).toMatch(/\/Subtype\s*\/Image/);
    expect(web.requests.filter((r) => r.path === "/good.png")).toHaveLength(1); // Corillo's fetch, not the page's
    expect(web.requests.map((r) => r.path)).toContain("/stall.png");
    await noneHanging();
    // A second time, with a cookie the server tried to set: still none sent.
    await exportTo(run, "Export to Word", "again.docx");
    expect(web.requests.filter((r) => r.path === "/good.png").every((r) => r.headers.cookie === undefined)).toBe(true);
    await noneHanging();
    await run.app.close();
  } finally {
    web.close();
  }
});

test("the PDF page loads only the pictures Corillo prepared: a diagram's pictures on the web or elsewhere on the Mac aren't fetched (R-EX-5)", async () => {
  test.setTimeout(90_000);
  const web = await pictureServers();
  const outside = mkdtempSync(join(tmpdir(), "corillo-outside-"));
  const elsewhere = join(outside, "elsewhere.png");
  copyFileSync(PNG, elsewhere);
  try {
    const text = [
      "A diagram with pictures in it:",
      "",
      "```mermaid",
      "flowchart LR",
      `  A@{ img: "${web.secure}/from-diagram.png", label: "Web", pos: "t", w: 40, h: 40, constraint: "off" }`,
      `  B@{ img: "file://${elsewhere}", label: "Disk", pos: "t", w: 40, h: 40, constraint: "off" }`,
      `  C["<img src='${web.secure}/from-label.png' width='20'> Label"]`,
      "  A --> B --> C",
      "```",
      "",
      "End.",
      "",
    ].join("\n");
    const run = await web.open(text);
    const pdf = await exportTo(run, "PDF", "diagram.pdf");
    // The diagram is drawn, without its pictures (each was given a blank one instead, the one on the Mac too), and the notice names them.
    await expect(notice(run.page)).not.toContainText("couldn't be drawn");
    await expect(notice(run.page)).toContainText(
      `3 pictures inside diagrams were left out (exports take only the document's own pictures): ${elsewhere}, ${web.secure}/from-diagram.png, ${web.secure}/from-label.png`,
    );
    expect(web.requests.map((r) => r.path)).toEqual([]);
    expect(readFileSync(pdf).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // Word draws its diagrams on the same page, under the same rule.
    await exportTo(run, "Export to Word", "diagram.docx");
    expect(web.requests.map((r) => r.path)).toEqual([]);
    // (Word's diagram labels are plain text, so the label's picture isn't asked for at all.)
    await expect(notice(run.page)).toContainText(`2 pictures inside diagrams were left out (exports take only the document's own pictures): ${elsewhere}, ${web.secure}/from-diagram.png`);
    await run.app.close();
  } finally {
    web.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("an SVG picture goes into Word as a sharp PNG at its own size, which every app can show (EX-6)", async () => {
  test.setTimeout(60_000);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="#8aa"/></svg>';
  const run = await openText("Our logo:\n\n![logo](logo.svg)\n\nAnd a broken one: ![bad](bad.svg)\n", {
    prepare: (folder) => {
      writeFileSync(join(folder, "logo.svg"), svg);
      writeFileSync(join(folder, "bad.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect');
    },
  });
  const out = await exportTo(run, "Export to Word", "proposal.docx");
  const media = zipEntries(out).filter((e) => e.startsWith("word/media/"));
  expect(media).toHaveLength(1);
  expect(media[0]).toMatch(/\.png$/);
  const info = pngInfo(new Uint8Array(zipRead(out, media[0])));
  expect(info).toEqual({ width: 600, height: 300, dpi: 216 }); // three times over, so 200 by 100 points in Word, as on the page
  const xml = zipRead(out, "word/document.xml").toString("utf8");
  const wide = Number(/<wp:extent cx="(\d+)"/.exec(xml)![1]) / 12700; // points
  expect(Math.abs(wide - 200)).toBeLessThan(2); // 200 points wide, as on the page
  await expect(notice(run.page)).toContainText("A picture couldn't be drawn and was left out: bad.svg");
  await run.app.close();
});

test("a big SVG picture is drawn at three times the size Word shows it, not three times its own (R-EX-11)", async () => {
  test.setTimeout(60_000);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="3000" viewBox="0 0 4000 3000"><rect width="4000" height="3000" fill="#8aa"/></svg>';
  const run = await openText("![plan](plan.svg)\n", { prepare: (folder) => writeFileSync(join(folder, "plan.svg"), svg) });
  const out = await exportTo(run, "Export to Word", "plan.docx");
  const media = zipEntries(out).filter((e) => e.startsWith("word/media/"));
  expect(media).toHaveLength(1);
  // Corillo's style on Letter paper: text 468 points wide, a picture at most half the text's 648 points tall,
  // so this one is shown 432 by 324 points: drawn three times over, 1296 by 972.
  const info = pngInfo(new Uint8Array(zipRead(out, media[0])));
  expect(info.width).toBeLessThanOrEqual(3 * 468);
  expect([info.width, info.height]).toEqual([1296, 972]);
  const xml = zipRead(out, "word/document.xml").toString("utf8");
  const [, cx, cy] = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(xml)!.map(Number);
  expect(Math.abs(cx / 12700 - 432)).toBeLessThan(2);
  expect(Math.abs(cy / 12700 - 324)).toBeLessThan(2);
  await run.app.close();
});

test("BMP, AVIF and WebP pictures reach Word as PNGs of their own shape and size; HEIC and TIFF, which Corillo can't show, are named as left out (R-EX-3)", async () => {
  test.setTimeout(90_000);
  const text = "![bitmap](x.bmp)\n\n![avif](chart.avif)\n\n![webp](w.webp)\n\n![phone photo](x.heic)\n\n![scan](x.tiff)\n\nEnd.\n";
  const run = await openText(text, {
    prepare: (folder) => {
      // Made by macOS from the test chart, at 200 by 100 pixels.
      const base = join(folder, "base.png");
      execFileSync("sips", ["-z", "100", "200", PNG, "--out", base], { stdio: "ignore" });
      for (const kind of ["bmp", "tiff", "heic"]) execFileSync("sips", ["-s", "format", kind, base, "--out", join(folder, `x.${kind}`)], { stdio: "ignore" });
      rmSync(base);
      copyFileSync(join(FIXTURES, "chart.avif"), join(folder, "chart.avif")); // 60 by 30
    },
  });
  // A WebP picture, 120 by 40, made by the browser (macOS can't write one).
  const webp = await run.page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 40;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#88aaaa";
    ctx.fillRect(0, 0, 120, 40);
    return canvas.toDataURL("image/webp").split(",")[1];
  });
  writeFileSync(join(run.folder, "w.webp"), Buffer.from(webp, "base64"));
  expect(readFileSync(join(run.folder, "w.webp")).subarray(8, 12).toString("latin1")).toBe("WEBP");

  const out = await exportTo(run, "Export to Word", "kinds.docx");
  const media = zipEntries(out).filter((e) => e.startsWith("word/media/"));
  expect(media).toHaveLength(3);
  const sizes = media.map((m) => {
    expect(m).toMatch(/\.png$/);
    const info = pngInfo(new Uint8Array(zipRead(out, m)));
    // As many points as pixels, as the page shows them.
    return { width: Math.round((info.width * 72) / info.dpi!), height: Math.round((info.height * 72) / info.dpi!) };
  });
  expect(sizes).toEqual([{ width: 200, height: 100 }, { width: 60, height: 30 }, { width: 120, height: 40 }]);
  const xml = zipRead(out, "word/document.xml").toString("utf8");
  const extents = [...xml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)].map((m) => [Math.round(Number(m[1]) / 12700), Math.round(Number(m[2]) / 12700)]);
  expect(extents).toEqual([[200, 100], [60, 30], [120, 40]]);
  const said = "2 pictures were left out because Corillo can't show their kind of file (HEIC or TIFF; save them as JPEG or PNG): x.heic, x.tiff";
  await expect(notice(run.page)).toContainText(said);

  // The PDF is the page, which can't show them either: the notice says so there too.
  await exportTo(run, "PDF", "kinds.pdf");
  await expect(notice(run.page)).toContainText(said);
  await run.app.close();
});

test("with a Word template that has none of Corillo's styles, callouts, quotes in quotes and diagrams use the template's own (EX-4)", async () => {
  test.setTimeout(60_000);
  const text = "Intro.\n\n> A quote.\n>\n> > A quote inside it.\n\n> [!warning] Careful\n> The body of the callout.\n\n```mermaid\ngraph LR\n  A --> B\n```\n\nEnd.\n";
  const run = await openText(text);
  const template = join(run.folder, "Company.dotx");
  makeTemplate(template);
  await openSettings(run.page);
  const sheet = run.page.getByRole("dialog", { name: "Export settings" });
  await pickInNextDialog(run.app, template);
  await sheet.getByRole("button", { name: "Choose a Word document" }).click();
  await sheet.getByRole("button", { name: "Save" }).click();
  const out = await exportTo(run, "Export to Word", "proposal.docx"); // checks no style is used that the file defines empty
  const xml = zipRead(out, "word/document.xml").toString("utf8");
  expect(xml).toContain("Careful");
  expect(xml).toContain("A quote inside it.");
  expect(xml).toContain("<w:drawing>"); // the diagram is there, as a picture
  expect(xml).not.toMatch(/w:val="(Callout\w+|BlockText[23]|Diagram)"/);
  await run.app.close();
});

test("the window can't set a script or a place to save that the person didn't choose (EX-5)", async () => {
  test.setTimeout(60_000);
  const run = await openText("Text.\n");
  const id = await run.page.locator(".tab").first().getAttribute("data-doc-id");
  const sneaky = join(run.folder, "sneaky.sh");
  writeFileSync(sneaky, `touch "${join(run.folder, "ran")}"\n`);
  // As code tricked into running in the window would: no dialog.
  await run.page.evaluate(({ id, sneaky }) => window.corillo.saveExportSettings(id!, { style: "corillo", script: sneaky }), { id, sneaky });
  expect(await run.page.evaluate((id) => window.corillo.exportSettings(id!), id)).toEqual({ style: "corillo" });
  const elsewhere = join(run.folder, "elsewhere.docx");
  const outcome = await run.page.evaluate(({ id, elsewhere }) => window.corillo.exportDocument(id!, "docx", elsewhere), { id, elsewhere });
  expect(outcome.status).toBe("failed");
  expect(existsSync(elsewhere)).toBe(false);
  // Chosen in the dialogs, the same things are fine.
  await openSettings(run.page);
  const sheet = run.page.getByRole("dialog", { name: "Export settings" });
  await sheet.getByText("Advanced").click();
  await pickInNextDialog(run.app, sneaky);
  await sheet.getByRole("button", { name: "Choose a script" }).click();
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  expect(await run.page.evaluate((id) => window.corillo.exportSettings(id!), id)).toEqual({ style: "corillo", script: sneaky });
  await exportTo(run, "Export to Word", "chosen.docx");
  expect(existsSync(join(run.folder, "ran"))).toBe(true);
  await run.app.close();
});

// Should stopping an export's programs break, a failing test still leaves none running (an hour's sleep, say).
const exportMarkers: string[] = [];
test.afterEach(() => {
  for (const marker of exportMarkers.splice(0)) {
    try {
      execFileSync("/usr/bin/pkill", ["-9", "-f", marker]);
    } catch {
      // none left: as it should be
    }
  }
});

test("a file chosen in Export Settings counts only for its own document and setting, and an export only in the format its save dialog offered (R-EX-7)", async () => {
  test.setTimeout(60_000);
  const run = await openText("First.\n");
  const first = await run.page.locator(".tab").first().getAttribute("data-doc-id");
  const script = join(run.folder, "touch-up.sh");
  writeFileSync(script, `touch "${join(run.folder, "ran")}"\n`);
  const filter = join(run.folder, "shout.lua");
  writeFileSync(filter, "return {}\n");
  // Chosen in the first document's dialogs: the script as its script, the filter as its filter.
  for (const [file, kind] of [[script, "script"], [filter, "lua"]] as const) {
    await pickInNextDialog(run.app, file);
    expect(await run.page.evaluate(({ id, kind }) => window.corillo.chooseExportFile(id!, kind), { id: first, kind })).toBe(file);
  }
  // Not as each other's setting, even for the same document.
  const save = (id: string | null, settings: object) =>
    run.page.evaluate(({ id, settings }) => window.corillo.saveExportSettings(id!, settings as never), { id, settings });
  expect(await save(first, { style: "corillo", script: filter })).toBe(false);
  expect(await save(first, { style: "corillo", luaFilter: script })).toBe(false);
  // Nor for another document.
  await openAlso(run, "second.md", "Second.\n");
  await expect(run.page.locator(".tab")).toHaveCount(2);
  const second = await run.page.locator(".tab").nth(1).getAttribute("data-doc-id");
  expect(second).not.toBe(first);
  expect(await save(second, { style: "corillo", script })).toBe(false);
  expect(await run.page.evaluate((id) => window.corillo.exportSettings(id!), second)).toEqual({ style: "corillo" });
  // Where they were chosen, they're fine.
  expect(await save(first, { style: "corillo", script, luaFilter: filter })).toBe(true);

  // The save dialog for Word gave x.docx: that can't be exported as a PDF (x.docx.pdf, never offered or checked).
  const out = join(run.folder, "x.docx");
  await saveInNextDialog(run.app, out);
  expect(await run.page.evaluate((id) => window.corillo.chooseExportPath(id!, "docx"), first)).toBe(out);
  const asPdf = await run.page.evaluate(({ id, out }) => window.corillo.exportDocument(id!, "pdf", out), { id: first, out });
  expect(asPdf.status).toBe("failed");
  const odd = await run.page.evaluate(({ id, out }) => window.corillo.exportDocument(id!, "exe" as never, out), { id: first, out });
  expect(odd.status).toBe("failed");
  expect(readdirSync(run.folder).filter((f) => f.startsWith("x."))).toEqual([]);
  // A save dialog can't be asked for a format Corillo doesn't make.
  expect(await run.page.evaluate((id) => window.corillo.chooseExportPath(id!, "exe" as never), first)).toBeNull();
  await run.app.close();
});

test("quitting during an export stops its programs and clears its work, and old work left by a crash is cleared at launch (EX-8, R-EX-10)", async () => {
  test.setTimeout(60_000);
  // Work left behind two days ago (a crash, say), and some from just now (another export running).
  const old = mkdtempSync(join(tmpdir(), "corillo-export-"));
  writeFileSync(join(old, "document.md"), "An old copy of someone's text.\n");
  const twoDaysAgo = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
  utimesSync(join(old, "document.md"), twoDaysAgo, twoDaysAgo);
  utimesSync(old, twoDaysAgo, twoDaysAgo);
  const fresh = mkdtempSync(join(tmpdir(), "corillo-export-"));
  // Work from today whose name says which Corillo made it: one that has ended (a crash just now), and one still running (this test's own process).
  const crashed = join(tmpdir(), "corillo-export-999999-x");
  mkdirSync(crashed);
  writeFileSync(join(crashed, "document.md"), "Today's copy of someone's text.\n");
  const running = mkdtempSync(join(tmpdir(), `corillo-export-${process.pid}-`));
  const run = await openText("Text.\n");
  await expect.poll(() => existsSync(old), { timeout: 15_000 }).toBe(false);
  await expect.poll(() => existsSync(crashed), { timeout: 15_000 }).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(running)).toBe(true);
  rmSync(running, { recursive: true, force: true });

  const marker = `sleep 3${Math.floor(Math.random() * 900 + 100)}`;
  exportMarkers.push(marker);
  const script = join(run.folder, "slow.sh");
  writeFileSync(script, `${marker.replace("sleep", "/bin/sleep")}\n`);
  await openSettings(run.page);
  const sheet = run.page.getByRole("dialog", { name: "Export settings" });
  await sheet.getByText("Advanced").click();
  await pickInNextDialog(run.app, script);
  await sheet.getByRole("button", { name: "Choose a script" }).click();
  await sheet.getByRole("button", { name: "Save" }).click();
  const pid = await run.app.evaluate(() => process.pid);
  await saveInNextDialog(run.app, join(run.folder, "proposal.docx"));
  await chooseFromMenu(run.page, "Export", "Export to Word");
  const runningNow = () => {
    try {
      return execFileSync("pgrep", ["-f", marker], { encoding: "utf8" }).trim() !== "";
    } catch {
      return false;
    }
  };
  await expect.poll(runningNow, { timeout: 20_000 }).toBe(true);
  const ours = () => readdirSync(tmpdir()).filter((f) => f.startsWith(`corillo-export-${pid}-`));
  expect(ours()).toHaveLength(1);
  await run.app.close();
  await expect.poll(runningNow, { timeout: 5_000 }).toBe(false);
  expect(ours()).toEqual([]);
  rmSync(fresh, { recursive: true, force: true });
});

/** In a page: try to read an address as the page's own scripts could, by fetch, by XMLHttpRequest and in a frame. */
function tryToRead(page: Page, url: string): Promise<{ fetch: string; xhr: string; frame: string }> {
  return page.evaluate(async (address) => {
    const fetched = await fetch(address).then(
      (r) => r.text(),
      () => "refused",
    );
    const xhr = await new Promise<string>((resolve) => {
      const request = new XMLHttpRequest();
      request.onload = () => resolve(request.responseText);
      request.onerror = () => resolve("refused");
      try {
        request.open("GET", address);
        request.send();
      } catch {
        resolve("refused");
      }
    });
    const frame = await new Promise<string>((resolve) => {
      const f = document.createElement("iframe");
      const done = (what: string) => {
        f.remove();
        resolve(what);
      };
      f.onload = () => {
        try {
          done(f.contentDocument?.body?.textContent?.trim() || "refused");
        } catch {
          done("refused");
        }
      };
      setTimeout(() => done("refused"), 1500);
      f.src = address;
      document.body.append(f);
    });
    return { fetch: fetched, xhr, frame };
  }, url);
}

test("the export page can't read files on the Mac: only the pictures Corillo prepared and its own files (R-EX-5)", async () => {
  test.setTimeout(60_000);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="#8aa"/></svg>';
  const run = await openText("![logo](logo.svg)\n", { prepare: (folder) => writeFileSync(join(folder, "logo.svg"), svg) });
  const secret = join(run.folder, "secret.txt");
  writeFileSync(secret, "secret words\n");
  // A slow script after the export keeps the export page open (it closes when the export is done).
  const marker = `sleep 4${Math.floor(Math.random() * 900 + 100)}`;
  const script = join(run.folder, "slow.sh");
  writeFileSync(script, `${marker.replace("sleep", "/bin/sleep")}\n`);
  await openSettings(run.page);
  const sheet = run.page.getByRole("dialog", { name: "Export settings" });
  await sheet.getByText("Advanced").click();
  await pickInNextDialog(run.app, script);
  await sheet.getByRole("button", { name: "Choose a script" }).click();
  await sheet.getByRole("button", { name: "Save" }).click();
  const opened = run.app.waitForEvent("window");
  await saveInNextDialog(run.app, join(run.folder, "logo.docx"));
  await chooseFromMenu(run.page, "Export", "Export to Word");
  const exportPage = await opened;
  expect(exportPage.url()).toMatch(/\/export\.html$/);
  const runningNow = () => {
    try {
      return execFileSync("pgrep", ["-f", marker], { encoding: "utf8" }).trim() !== "";
    } catch {
      return false;
    }
  };
  await expect.poll(runningNow, { timeout: 20_000 }).toBe(true);
  const refused = { fetch: "refused", xhr: "refused", frame: "refused" };
  expect(await tryToRead(exportPage, pathToFileURL(secret).href)).toEqual(refused);
  expect(await tryToRead(exportPage, pathToFileURL(run.file).href)).toEqual(refused);
  // Not even one of Corillo's own pages in a frame, or a page on the web.
  const appPath = await run.app.evaluate(({ app }) => app.getAppPath());
  expect((await tryToRead(exportPage, pathToFileURL(join(appPath, "dist", "about.html")).href)).frame).toBe("refused");
  expect(await tryToRead(exportPage, "https://example.com/")).toEqual(refused);
  // The page's rule says so too: nothing framed, no plugins, connections to files only (the session lets through just the prepared ones).
  const rule = /Content-Security-Policy" content="([^"]+)"/.exec(readFileSync(join(appPath, "dist", "export.html"), "utf8"))![1];
  expect(rule).toContain("frame-src 'none'");
  expect(rule).toContain("object-src 'none'");
  expect(rule).toContain("connect-src file:;");
  await run.app.close();
});

/** How many pages a PDF has. */
const pageCount = (pdf: Buffer) => pdf.toString("latin1").match(/\/Type\s*\/Page\b(?!s)/g)?.length ?? 0;

test("in a PDF, a long quote or code block follows on from the text before it, leaving no gap (EX-11)", async () => {
  test.setTimeout(90_000);
  // (Twelve paragraphs: each blank line between them is a line of the page, as in Word.)
  const before = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} before the quote.`).join("\n\n");
  const quote = Array.from({ length: 50 }, (_, i) => `> Line ${i + 1} of a long quote.`).join("\n");
  const code = Array.from({ length: 52 }, (_, i) => `line ${i + 1} of a long listing`).join("\n");
  const run = await openText(`${before}\n\n${quote}\n\nEND\n`);
  const out = await exportTo(run, "PDF", "quote.pdf");
  // Half a page of text and a page and a quarter of quote fit on two pages, unless the quote is pushed to the next.
  expect(pageCount(readFileSync(out))).toBe(2);
  writeFileSync(run.file, `${before}\n\n\`\`\`\n${code}\n\`\`\`\n\nEND\n`);
  await expect(run.page.locator(".ProseMirror pre")).toBeVisible();
  const code2 = await exportTo(run, "PDF", "code.pdf");
  expect(pageCount(readFileSync(code2))).toBe(2);
  await run.app.close();
});

test("in a PDF, a table too wide for the paper is kept within it (EX-11)", async () => {
  test.setTimeout(60_000);
  const header = `| ${Array.from({ length: 12 }, (_, i) => `Column${i + 1}`).join(" | ")} |`;
  const rule = `|${" --- |".repeat(12)}`;
  const row = `| ${Array.from({ length: 12 }, (_, i) => `https://example.com/a-very-long-unbroken-address-${i}`).join(" | ")} |`;
  const run = await openText(`${header}\n${rule}\n${row}\n`);
  // Lay the page Corillo prints out at the width of the paper's text (US Letter, 6.7 inches), and measure it.
  await run.app.evaluate(({ webContents, BrowserWindow }) => {
    const g = globalThis as unknown as { overflow: number[] };
    g.overflow = [];
    const proto = Object.getPrototypeOf(webContents.getAllWebContents()[0]);
    const original = proto.printToPDF;
    proto.printToPDF = async function (this: Electron.WebContents, ...args: unknown[]) {
      BrowserWindow.fromWebContents(this)!.setContentSize(643, 1000);
      await new Promise((r) => setTimeout(r, 300));
      g.overflow.push(await this.executeJavaScript(`(() => { const t = document.querySelector("table").getBoundingClientRect(); return Math.round(t.right - document.getElementById("page").getBoundingClientRect().right); })()`));
      return original.apply(this, args);
    };
  });
  await exportTo(run, "PDF", "wide.pdf");
  const [overflow] = await run.app.evaluate(() => (globalThis as unknown as { overflow: number[] }).overflow);
  expect(overflow).toBeLessThanOrEqual(0);
  await run.app.close();
});

test("in a PDF, an ordinary table keeps its words whole; a table too wide for the paper breaks only its long addresses (R-EX-1)", async () => {
  test.setTimeout(60_000);
  const prose = Array.from({ length: 80 }, (_, i) => ["the", "quarterly", "plan", "covers", "hiring", "and", "budget", "reviews"][i % 8]).join(" ");
  const address = `https://example.com/${"a-very-long-unbroken-address-".repeat(5)}end`;
  const run = await openText(
    `| Owner | Notes |\n| --- | --- |\n| Engineering | ${prose} |\n| Responsibility | ${prose} |\n\n| Team | Where |\n| --- | --- |\n| Marketing | ${address} |\n`,
  );
  // Lay the page Corillo prints out at the width of the paper's text (US Letter, 6.7 inches), and count the lines each word takes.
  await run.app.evaluate(({ webContents, BrowserWindow }) => {
    const g = globalThis as unknown as { laid: { lines: Record<string, number>; overflow: number }[] };
    g.laid = [];
    const proto = Object.getPrototypeOf(webContents.getAllWebContents()[0]);
    const original = proto.printToPDF;
    proto.printToPDF = async function (this: Electron.WebContents, ...args: unknown[]) {
      BrowserWindow.fromWebContents(this)!.setContentSize(643, 1000);
      await new Promise((r) => setTimeout(r, 300));
      g.laid.push(
        await this.executeJavaScript(`(() => {
          const lines = {};
          for (const word of ["Owner", "Engineering", "Responsibility", "Marketing", "https://example.com"]) {
            const cell = [...document.querySelectorAll("th, td")].find((c) => c.textContent.trim().startsWith(word));
            const node = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT).nextNode();
            const range = document.createRange();
            range.setStart(node, 0);
            range.setEnd(node, word.startsWith("https") ? node.textContent.length : word.length);
            lines[word] = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
          }
          const page = document.getElementById("page").getBoundingClientRect().right;
          const overflow = Math.max(...[...document.querySelectorAll("table")].map((t) => Math.round(t.getBoundingClientRect().right - page)));
          return { lines, overflow };
        })()`),
      );
      return original.apply(this, args);
    };
  });
  await exportTo(run, "PDF", "owners.pdf");
  const [{ lines, overflow }] = await run.app.evaluate(() => (globalThis as unknown as { laid: { lines: Record<string, number>; overflow: number }[] }).laid);
  expect(overflow).toBeLessThanOrEqual(0);
  expect({ ...lines, "https://example.com": undefined }).toEqual({ Owner: 1, Engineering: 1, Responsibility: 1, Marketing: 1, "https://example.com": undefined });
  expect(lines["https://example.com"]).toBeGreaterThan(1); // the address too long for the paper wraps
  await run.app.close();
});

test("exporting while an earlier version is on screen says it's the current version that was exported (EX-12)", async () => {
  test.setTimeout(60_000);
  const run = await openText("# Plan\n\nFirst point.\n");
  await cursorAtEnd(run.page, "First point.");
  await run.page.keyboard.type(" Second thoughts.");
  await expect.poll(run.text).toBe("# Plan\n\nFirst point. Second thoughts.\n");
  await run.page.getByRole("button", { name: "History", exact: true }).click();
  await run.page.locator(".history-item", { hasText: "First version" }).click();
  await expect(run.page.locator(".doc.viewing-version")).toHaveCount(1);
  const out = join(run.folder, "proposal.docx");
  await saveInNextDialog(run.app, out);
  await chooseFromMenu(run.page, "Export", "Export to Word");
  await expect(notice(run.page)).toContainText("Exported the current version to proposal.docx", { timeout: 45_000 });
  expect(zipRead(out, "word/document.xml").toString("utf8")).toContain("Second thoughts.");
  await run.app.close();
});

test("choosing Word styles with no Word document chosen asks for one; cancelling goes back to Corillo's (EX-12)", async () => {
  const run = await openText("Text.\n");
  const template = join(run.folder, "Company.dotx");
  makeTemplate(template);
  await openSettings(run.page);
  const sheet = run.page.getByRole("dialog", { name: "Export settings" });
  await run.app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
  });
  await sheet.getByRole("radio", { name: "Use the styles of a Word document" }).click();
  await expect(sheet.getByRole("radio", { name: "Corillo (clean)" })).toBeChecked();
  await pickInNextDialog(run.app, template);
  await sheet.getByRole("radio", { name: "Use the styles of a Word document" }).check();
  await expect(sheet).toContainText("Company.dotx");
  await expect(sheet.getByRole("radio", { name: "Use the styles of a Word document" })).toBeChecked();
  await run.app.close();
});

test("when an exported file can't be opened, the notice says why in plain words (EX-12)", async () => {
  test.setTimeout(60_000);
  const run = await openText("Short note.\n");
  await recordShell(run.app);
  const out = await exportTo(run, "Export to Word", "note.docx");
  rmSync(out);
  await notice(run.page).getByRole("button", { name: "Open" }).click();
  await expect(notice(run.page)).toContainText("note.docx couldn't be opened. It may have been moved, renamed or deleted.");
  await expect(notice(run.page)).not.toContainText("Failed");
  await run.app.close();
});

test("when the chosen Word document has gone, the export says so in plain words", async () => {
  test.setTimeout(60_000);
  const run = await openText("Text.\n");
  const template = join(run.folder, "Gone.docx");
  makeTemplate(template);
  await openSettings(run.page);
  const sheet = run.page.getByRole("dialog", { name: "Export settings" });
  await pickInNextDialog(run.app, template);
  await sheet.getByRole("button", { name: "Choose a Word document" }).click();
  await sheet.getByRole("button", { name: "Save" }).click();
  renameSync(template, join(run.folder, "Moved.docx"));
  await saveInNextDialog(run.app, join(run.folder, "proposal.docx"));
  await chooseFromMenu(run.page, "Export", "Export to Word");
  await expect(notice(run.page)).toContainText("Couldn't export", { timeout: 30_000 });
  await expect(notice(run.page)).toContainText("(Gone.docx) can't be found. Choose it again in Export Settings.");
  await expect(notice(run.page).getByRole("button", { name: "Open" })).toBeHidden();
  expect(existsSync(join(run.folder, "proposal.docx"))).toBe(false);
  await run.app.close();
});

test("cancelling the save dialog exports nothing", async () => {
  const run = await openText("Text.\n");
  await run.app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = (async () => ({ canceled: true, filePath: "" })) as typeof dialog.showSaveDialog;
  });
  await chooseFromMenu(run.page, "Export", "Export to Word");
  await run.page.waitForTimeout(500);
  await expect(notice(run.page)).toBeHidden();
  await run.app.close();
});

test("headings are blue-grey on screen as a reading aid, but print plain in the PDF, as in Word", async () => {
  const run = await openText("# Plan\n\n## Costs\n\nBody text.\n");
  const onScreen = await run.page.evaluate(() => {
    const h = document.querySelector(".doc:not([hidden]) .page.editor h2")!;
    const p = document.querySelector(".doc:not([hidden]) .page.editor p")!;
    return getComputedStyle(h).color !== getComputedStyle(p).color;
  });
  expect(onScreen).toBe(true);
  // Note the colours of the page Corillo prints to PDF.
  await run.app.evaluate(({ webContents }) => {
    const g = globalThis as unknown as { colours: string[] };
    g.colours = [];
    const proto = Object.getPrototypeOf(webContents.getAllWebContents()[0]);
    const original = proto.printToPDF;
    proto.printToPDF = async function (this: Electron.WebContents, ...args: unknown[]) {
      g.colours.push(
        await this.executeJavaScript(
          `[...document.querySelectorAll(".ProseMirror h1, .ProseMirror h2, .ProseMirror p")].map((e) => getComputedStyle(e).color).join("|")`,
        ),
      );
      return original.apply(this, args);
    };
  });
  await exportTo(run, "PDF", "proposal.pdf");
  const [h1, h2, p] = (await run.app.evaluate(() => (globalThis as unknown as { colours: string[] }).colours))[0].split("|");
  expect([h1, h2]).toEqual([p, p]);
  await run.app.close();
});

test("the export notice belongs to its document: it goes with its tab, is there again on coming back, and goes when the tab closes (roadmap Batch 4, item 3)", async () => {
  const run = await openText("Subject: The plan\n\nHi Ana,\n\nHere it is.\n", { name: "plan.md" });
  const { app, page } = run;
  await captureClipboardWrites(app);
  const shown = page.locator(".export-notice:visible");
  const inFront = page.locator(".doc:not([hidden]) .export-notice");
  const tab = (name: string) => page.locator(`.tab[title$="/${name}"]`);
  await clickMenu(app, "copy-email");
  await expect(inFront).toContainText("Subject: The plan");
  // In the page's corner, above the status bar, as before.
  const box = (await inFront.boundingBox())!;
  const size = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  expect(box.y + box.height).toBeGreaterThan(size.height - 100);
  expect(box.x + box.width).toBeGreaterThan(size.width / 2);

  // Another document in front: plan.md's notice stays with plan.md.
  await openAlso(run, "notes.md", "# Notes\n\nA short note.\n");
  await expect.poll(async () => (await tabState(page)).active).toBe("notes.md");
  await expect(shown).toHaveCount(0);
  // An agent's export of plan.md, while notes.md is in front: it goes to plan.md's notice.
  const planId = await page.locator(".doc", { has: page.locator("h1, p", { hasText: "Hi Ana" }) }).getAttribute("data-doc-id");
  await app.evaluate(({ BrowserWindow }, docId) => {
    BrowserWindow.getAllWindows()[0].webContents.send("export:by-agent", { outputPath: "/nowhere/plan.pdf", name: "plan.pdf", notes: [], agent: "Claude", docId });
  }, planId);
  await page.waitForTimeout(200);
  await expect(shown).toHaveCount(0);
  await clickMenu(app, "copy-email");
  await expect(inFront).toHaveText(/Copied for email\./);
  await expect(inFront).not.toContainText("Subject");

  // Back to plan.md: its notice is there again, with the agent's export.
  await tab("plan.md").click();
  await expect(shown).toHaveCount(1);
  await expect(inFront).toContainText("Claude exported plan.pdf");
  // Closing plan.md takes its notice with it; notes.md's own is there on going back to it.
  await clickMenu(app, "close-tab");
  await expect.poll(async () => (await tabState(page)).names).toEqual(["notes.md"]);
  await expect(page.locator(".export-notice")).toHaveCount(1);
  await expect(inFront).toHaveText(/Copied for email\./);
  await app.close();
});
