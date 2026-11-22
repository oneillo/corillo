// Word and PDF export. exportDocument() does the work, for the window's
// Export menu and for agents (exportForAgent). Word documents are made by Pandoc,
// run as a separate program, from a temporary copy of the Markdown in which
// diagrams are pictures. PDFs are Corillo's own formatted view, printed.
// Both use a hidden page (export.html) that shows the document the way the
// editor does and draws its diagrams.
import { app, BrowserWindow, dialog, ipcMain, net, session, shell, webContents, type IpcMainEvent } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { versionHistory } from "./history";
import { buildReferenceDocx, type Paper } from "./reference-docx";
import {
  DEFAULT_SETTINGS,
  ExportError,
  exportSettingsFrom,
  findDiagrams,
  firstProblem,
  warningNotes,
  pandocJsonArgs,
  pandocProblem,
  textArea,
  withoutFrontMatter,
  paperFor,
  replaceDiagrams,
  scriptCommand,
  settingsAllowed,
  type ExportSettings,
  type FileSetting,
  wordFiles,
  wordMaking,
  wordText,
} from "./export-prep";
import { pandocPath, run, stopAllPrograms, type RunFailure } from "./pandoc";
import {
  drawForWord,
  fetchPictures,
  htmlPictures,
  leaveOutWaiting,
  imageSources,
  pageImageSources,
  endSentence,
  pageKey,
  pictureNotes,
  planPictures,
  refusedNotes,
  WEB_BUDGET_MS,
  type Fetcher,
  type PicturePlan,
} from "./export-pictures";
import { obsidianForExport, picturesEmbedded } from "../core/obsidian-export";
import { addressFrom, findLinked } from "./vault";
import { COPY_WORK, copyWorking, wordStyles } from "./word-copy";
import { sameFile } from "./files";
import { lookAtMemory } from "./memory-note";
import { asRequested, PLAIN_NAME, webPicturesIn } from "../core/web-pictures";

export type ExportFormat = "docx" | "pdf";

export interface ExportOptions {
  /** Where to save; by default next to the document, with the same name. */
  outputPath?: string;
  /** Word styling; by default what's remembered for the document. */
  settings?: ExportSettings;
  /** Paper size for PDF and for Corillo's Word style; by default the one for the Mac's region. */
  paper?: Paper;
}

export interface ExportResult {
  outputPath: string;
  /** Things the person should know, in plain words (a missing picture, say). */
  notes: string[];
}

const PANDOC_TIMEOUT_MS = 120_000;
const SCRIPT_TIMEOUT_MS = 120_000;
const PAGE_TIMEOUT_MS = 90_000;

const nameOf = (file: string) => path.basename(file);
const extensionFor = (format: ExportFormat) => (format === "docx" ? ".docx" : ".pdf");

export function defaultOutputPath(docPath: string, format: ExportFormat): string {
  return path.join(path.dirname(docPath), path.basename(docPath).replace(/\.[^.]+$/, "") + extensionFor(format));
}

/**
 * Where an export is suggested (the person's Export dialog) or goes by
 * default (an agent's): next to the document, with its name, but never the
 * Word documents named in `avoid` (the one whose styles the export uses, the
 * one a copy was made from). A copy made from a Word document (word-copy.ts)
 * has that file's name and folder, so its export is suggested as "Offsite
 * notes 2.docx", as Word and Finder number a name that's taken.
 */
export function suggestedOutputPath(docPath: string, format: ExportFormat, avoid: string | (string | undefined)[] = []): string {
  const plain = defaultOutputPath(docPath, format);
  const files = (Array.isArray(avoid) ? avoid : [avoid]).filter((f): f is string => !!f);
  if (format !== "docx" || !files.some((f) => sameFile(path.resolve(f), plain))) return plain;
  const stem = plain.slice(0, -extensionFor(format).length);
  for (let n = 2; ; n++) {
    const next = `${stem} ${n}${extensionFor(format)}`;
    if (!fs.existsSync(next)) return next;
  }
}

// What's remembered for each document ---------------------------------------------

const documents = () => versionHistory();

export function settingsFor(docPath: string): ExportSettings {
  const all = documents().readSettings(documents().idFor(docPath));
  return exportSettingsFrom(all.export ?? DEFAULT_SETTINGS);
}

export function saveSettingsFor(docPath: string, settings: ExportSettings): void {
  const id = documents().idFor(docPath);
  const all = documents().readSettings(id);
  documents().writeSettings(id, { ...all, export: exportSettingsFrom(settings) });
}

// A copy made from a Word document (word-copy.ts; B5-01, B5-02, B5-04) ---------------

/** The Word document a copy was made from: where it was, and its identity on disk then (to know it after a move). */
interface MadeFrom {
  path: string;
  ino: number;
  dev: number;
}

/** The Word document this document was made from, if it's a copy of one. */
function madeFromOf(docPath: string): MadeFrom | null {
  const m = documents().readSettings(documents().idFor(docPath)).madeFrom as Partial<MadeFrom> | undefined;
  return m && typeof m.path === "string" && path.isAbsolute(m.path) && Number.isInteger(m.ino) && Number.isInteger(m.dev) ? (m as MadeFrom) : null;
}

/**
 * Whether `file` is the Word document this document was made from: where it
 * was, or the same file on disk moved elsewhere. An export never writes over
 * it, whoever asks: it holds what the copy left out (Word's comments, its
 * tracked changes).
 */
export function isMadeFrom(docPath: string, file: string): boolean {
  const from = madeFromOf(docPath);
  if (!from) return false;
  const target = path.resolve(file);
  if (sameFile(target, from.path)) return true;
  try {
    const now = fs.statSync(target);
    return from.ino >= 0 && now.ino === from.ino && now.dev === from.dev;
  } catch {
    return false;
  }
}

/** Where an export of the document goes when no place is chosen: see suggestedOutputPath. */
export function exportSuggestion(docPath: string, format: ExportFormat): string {
  return suggestedOutputPath(docPath, format, [settingsFor(docPath).referenceDoc, madeFromOf(docPath)?.path]);
}

/**
 * A copy was just made from a Word document: note where it came from, and
 * keep that document's look in the copy's records (see wordStyles), so its
 * export to Word looks like the original, carries nothing else of it, and
 * works after the original is moved or deleted. The records go with the
 * copy's (30 days after it's gone). Says whether the look was kept; when it
 * can't be (no styles in it), the copy exports in Corillo's own style.
 */
export function rememberWordCopy(docPath: string, word: string): boolean {
  const id = documents().idFor(docPath);
  const { ino, dev } = fs.statSync(word);
  const styles = wordStyles(word);
  if (styles) documents().writeWordStyles(id, styles);
  const all = documents().readSettings(id);
  documents().writeSettings(id, {
    ...all,
    madeFrom: { path: path.resolve(word), ino, dev },
    ...(styles ? { export: exportSettingsFrom({ style: "word", referenceDoc: path.resolve(word) }) } : {}),
  });
  return !!styles;
}

/**
 * The Word document Pandoc takes styles from for an export with "the styles
 * of a Word document": the look kept for a copy when that document is the
 * one the copy was made from, chosen or not since; otherwise the document
 * itself, which must still be there.
 */
function stylesFile(docPath: string, chosen: string): string {
  const from = madeFromOf(docPath);
  if (from && path.resolve(chosen) === from.path) {
    const kept = documents().wordStylesFile(documents().idFor(docPath));
    if (fs.existsSync(kept)) return kept;
  }
  return needFile(chosen, "The Word document whose styles you chose");
}

// The hidden page -------------------------------------------------------------------

/**
 * What an export page may load besides Corillo's own files: the pictures the
 * pictures step prepared for it (export-pictures.ts). And what it tried to
 * load that it may not (a picture a diagram links to, say), for the notes.
 * Kept with the page's own WebContents, so it goes when the page does.
 */
interface PageLoads {
  allowed: Set<string>;
  refused: string[];
}

const pageLoads = new WeakMap<Electron.WebContents, PageLoads>();
let pageSession: Electron.Session | null = null;

/** Where a picture the page may not load is sent instead (an address that can't exist, answered below). */
const BLANK_ADDRESS = "https://blank.invalid/";
/** A picture with nothing in it (1 by 1, see-through): what the page gets instead. */
const BLANK_PICTURE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

/**
 * The export pages' own session, in memory only. It lets a page load
 * Corillo's own files and the pictures prepared for it, and nothing else:
 * nothing from the web and no other file on the Mac, however a diagram or
 * the document asks for it. So an export fetches nothing the pictures step
 * didn't, for PDF and Word alike. A picture it may not load gets a blank
 * one rather than an error, so a diagram that shows a picture from the web
 * or the Mac is still drawn, without it; the notes name what was left out.
 */
function exportPageSession(): Electron.Session {
  if (pageSession) return pageSession;
  const ses = session.fromPartition("corillo-export-page", { cache: false });
  const own = pathToFileURL(__dirname + path.sep).href;
  // Nothing in this session reaches the web: every web address answers with the blank picture.
  for (const scheme of ["https", "http"]) {
    ses.protocol.handle(scheme, () => new Response(new Uint8Array(BLANK_PICTURE), { status: 200, headers: { "Content-Type": "image/png" } }));
  }
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    if (url === BLANK_ADDRESS || !/^(https?|wss?|ftp|file):/i.test(url) || url.startsWith(own)) return callback({});
    const contents = details.webContentsId === undefined ? undefined : webContents.fromId(details.webContentsId);
    const loads = contents && pageLoads.get(contents);
    // (A file's address is the same file whatever follows a ? or #.)
    if (loads?.allowed.has(/^file:/i.test(url) ? url.replace(/[?#].*$/, "") : url)) return callback({});
    if (loads && !loads.refused.includes(url)) loads.refused.push(url);
    callback(details.resourceType === "image" ? { redirectURL: BLANK_ADDRESS } : { cancel: true });
  });
  pageSession = ses;
  return ses;
}

class ExportPage {
  private constructor(
    readonly window: BrowserWindow,
    private readonly loads: PageLoads,
  ) {}

  static async open(): Promise<ExportPage> {
    const w = new BrowserWindow({
      show: false,
      width: 816,
      height: 1056,
      webPreferences: {
        preload: path.join(__dirname, "export-preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        session: exportPageSession(),
      },
    });
    const loads: PageLoads = { allowed: new Set(), refused: [] };
    pageLoads.set(w.webContents, loads);
    w.webContents.on("will-navigate", (e) => e.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    try {
      await w.loadFile(path.join(__dirname, "export.html"));
    } catch (err) {
      // A page that didn't load is closed here: nothing else holds it to close it later (Batch 18, App S2).
      w.destroy();
      throw err;
    }
    return new ExportPage(w, loads);
  }

  /** Let the page show these pictures (file: URLs the pictures step prepared). */
  allow(urls: Iterable<string>): void {
    for (const url of urls) this.loads.allowed.add(url);
  }

  /** What the page tried to load and wasn't allowed to. */
  refused(): string[] {
    return [...this.loads.refused];
  }

  ask<T>(kind: string, payload: unknown): Promise<T> {
    const contents = this.window.webContents;
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        ipcMain.removeListener("export-page:reply", onReply);
        contents.removeListener("render-process-gone", onGone);
      };
      const onReply = (e: IpcMainEvent, replyId: string, reply: { value?: T; error?: string }) => {
        if (e.sender !== contents || replyId !== id) return;
        done();
        if (reply.error !== undefined) reject(new ExportError(reply.error));
        else resolve(reply.value as T);
      };
      const onGone = () => {
        done();
        reject(new ExportError("Corillo's export page stopped unexpectedly. Try again."));
      };
      const timer = setTimeout(() => {
        done();
        reject(new ExportError("The export took too long and was stopped. Try again."));
      }, PAGE_TIMEOUT_MS);
      ipcMain.on("export-page:reply", onReply);
      contents.on("render-process-gone", onGone);
      contents.send("export-page:request", id, kind, payload);
    });
  }

  close(): void {
    if (!this.window.isDestroyed()) this.window.destroy();
  }
}

interface DrawnDiagram {
  png?: Uint8Array;
  error?: string;
}

// Exporting ---------------------------------------------------------------------------

/**
 * Export a Markdown document to Word or PDF. Exports the file as it is on
 * disk, so whoever asks should save first. Returns where the export went and
 * anything the person should know; fails with an ExportError in plain words.
 */
export async function exportDocument(target: string, format: ExportFormat, options: ExportOptions = {}): Promise<ExportResult> {
  const docPath = path.resolve(target);
  let text: string;
  try {
    text = withoutFrontMatter(fs.readFileSync(docPath, "utf8"));
  } catch {
    throw new ExportError(`${nameOf(docPath)} can't be read. It may have been moved or deleted.`);
  }
  let outputPath = path.resolve(options.outputPath ?? defaultOutputPath(docPath, format));
  if (path.extname(outputPath).toLowerCase() !== extensionFor(format)) outputPath += extensionFor(format);
  if (isMadeFrom(docPath, outputPath)) {
    throw new ExportError(`${nameOf(outputPath)} is the Word document this copy was made from, so Corillo doesn't write over it. Export again and choose another name.`);
  }
  const paper = options.paper ?? paperFor(app.getSystemLocale() || app.getLocale());

  // Obsidian's links, comments, embeds and the rest, as Obsidian shows them (see obsidian-export.ts).
  const found = new Map<string, string | null>();
  for (const name of picturesEmbedded(text)) {
    if (found.has(name)) continue;
    const file = await findLinked(docPath, name);
    found.set(name, file && addressFrom(docPath, file));
  }
  // For Word, each blank line the page shows as a line of space is marked to be an empty paragraph, as Corillo reads the file.
  const picture = (name: string) => found.get(name) ?? null;
  text = format === "docx" ? wordText(text, picture) : obsidianForExport(text, { word: false, picture });

  // The web pictures an agent added that wait for the person are left out, for his export and an agent's alike.
  const waitList = new Set(waitingFor(docPath, text).flatMap((a) => asRequested(a) ?? []));
  const waits = (url: string) => waitList.has(asRequested(url) ?? url);
  const notes: string[] = [];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `corillo-export-${process.pid}-`));
  workFolders.add(work);
  const page = new PageWhenNeeded();
  try {
    let broken: number;
    if (format === "pdf") broken = await toPdf(text, docPath, outputPath, paper, work, page, notes, waits);
    else {
      const settings = options.settings ? exportSettingsFrom(options.settings) : settingsFor(docPath);
      broken = await toWord(text, docPath, outputPath, settings, paper, work, page, notes, waits);
    }
    if (broken === 1) notes.unshift("A diagram couldn't be drawn, so its code is shown instead.");
    else if (broken > 1) notes.unshift(`${broken} diagrams couldn't be drawn, so their code is shown instead.`);
    notes.push(...refusedNotes(page.refused()));
    return { outputPath, notes };
  } finally {
    lookAtMemory(); // while the export's page is still open (memory-note.ts)
    page.close();
    fs.rmSync(work, { recursive: true, force: true });
    workFolders.delete(work);
  }
}

/** The work folders of exports running now: each holds a copy of a document's text. */
const workFolders = new Set<string>();

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Clear work folders an export, or a copy of a Word document (word-copy.ts),
 * left behind (Corillo stopped mid-export, say): at once when the Corillo its
 * name says made it has ended, and any more than a day old. Never this
 * Corillo's own, or another's still running.
 */
function clearOldWork(): void {
  const temp = os.tmpdir();
  const work = /^corillo-(?:export|word-copy)-(\d+)-/;
  let names: string[];
  try {
    names = fs.readdirSync(temp).filter((n) => n.startsWith("corillo-export-") || n.startsWith(COPY_WORK));
  } catch {
    return;
  }
  for (const name of names) {
    const dir = path.join(temp, name);
    if (workFolders.has(dir) || copyWorking(dir)) continue;
    const pid = Number(work.exec(name)?.[1] ?? NaN);
    const ended = Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && !isRunning(pid);
    try {
      if (ended || Date.now() - fs.statSync(dir).mtimeMs > DAY_MS) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // gone already, or not ours to clear
    }
  }
}

/** Whether a process is running (one of another user's counts: it's there, though not ours to signal). */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The hidden export page, opened the first time it's needed (diagrams, SVG pictures, a PDF). */
class PageWhenNeeded {
  private opening: Promise<ExportPage> | null = null;
  private page: ExportPage | null = null;
  private closed = false;

  async get(): Promise<ExportPage> {
    this.opening ??= ExportPage.open().then((p) => {
      this.page = p;
      if (this.closed) p.close();
      return p;
    });
    return this.opening;
  }

  /** What the page, if it was opened, tried to load and wasn't allowed to. */
  refused(): string[] {
    return this.page?.refused() ?? [];
  }

  close(): void {
    this.closed = true;
    this.page?.close();
  }
}

// Pictures on the web ---------------------------------------------------------------

/**
 * Pictures on the web are fetched in a session of their own, kept in memory
 * only: no cookies, no sign-ins, no address of the page or document that
 * asks, and the plainest name a browser gives, nothing about Corillo. The request carries the picture's
 * address and nothing else about the person or the document.
 */
const PICTURE_SESSION = "corillo-export-pictures";
const BIGGEST_WEB_PICTURE = 50 * 1024 * 1024;

let picturesOnline: Electron.Session | null = null;

function pictureSession(): Electron.Session {
  if (!picturesOnline) {
    picturesOnline = session.fromPartition(PICTURE_SESSION, { cache: false });
    picturesOnline.setUserAgent(PLAIN_NAME, ""); // the same plain name as the window's (the review of Batch 18, R18-5)
  }
  return picturesOnline;
}

export const webPicture: Fetcher = (url, signal) =>
  new Promise<Uint8Array>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Stopped."));
    const request = net.request({
      url,
      session: pictureSession(),
      credentials: "omit",
      useSessionCookies: false,
      redirect: "manual",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
    const settle = (fn: () => void) => {
      signal.removeEventListener("abort", stop);
      fn();
    };
    const fail = (why: string) => {
      request.abort();
      settle(() => reject(new Error(why)));
    };
    const stop = () => fail("Stopped.");
    signal.addEventListener("abort", stop, { once: true });
    let hops = 0;
    request.setHeader("Accept", "image/*");
    request.on("redirect", (_status, _method, to) => {
      // The page follows only secure addresses, and so does the export.
      if (!/^https:/i.test(to) || ++hops > 5) return fail("Redirected away.");
      request.followRedirect();
    });
    request.on("response", (response) => {
      if (response.statusCode < 200 || response.statusCode > 299) return fail(`The server said ${response.statusCode}.`);
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > BIGGEST_WEB_PICTURE) fail("Too big.");
        else chunks.push(chunk);
      });
      response.on("end", () => settle(() => resolve(new Uint8Array(Buffer.concat(chunks)))));
      response.on("error", () => fail("Broken off."));
    });
    request.on("error", (err) => settle(() => reject(err)));
    request.end();
  });


/** Write the finished file into place; the person's folder only ever sees a whole file. */
function deliver(data: Buffer | string, outputPath: string, isFile = false): void {
  const tmp = path.join(path.dirname(outputPath), `.${nameOf(outputPath)}.corillo-exporting`);
  let ours = false;
  try {
    // A file left by an export that was cut off goes; anything else under that name (a link, a folder)
    // isn't Corillo's, and is never written through: the exclusive opens below refuse it (Batch 21, E21-12).
    try {
      if (fs.lstatSync(tmp).isFile()) fs.unlinkSync(tmp);
    } catch {
      // nothing there
    }
    if (isFile) {
      fs.copyFileSync(data as string, tmp, fs.constants.COPYFILE_EXCL);
      ours = true;
    }
    const fd = fs.openSync(tmp, isFile ? fs.constants.O_RDWR | fs.constants.O_NOFOLLOW : "wx");
    ours = true;
    try {
      if (!isFile) fs.writeFileSync(fd, data);
      // On the disk before it takes its name, so a power cut never leaves a short file there (Batch 18, App S4).
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, outputPath);
  } catch (err) {
    if (ours) fs.rmSync(tmp, { force: true });
    const code = (err as NodeJS.ErrnoException).code;
    const why =
      code === "ENOENT"
        ? "that folder doesn't exist"
        : code === "EACCES" || code === "EPERM"
          ? "Corillo isn't allowed to save there"
          : code === "ENOSPC" || code === "EDQUOT"
            ? "the disk is full"
            : "the file couldn't be written";
    throw new ExportError(`Corillo couldn't save ${nameOf(outputPath)}: ${why}.`);
  }
}

function needFile(file: string, what: string): string {
  if (!fs.existsSync(file)) throw new ExportError(`${what} (${nameOf(file)}) can't be found. Choose it again in Export Settings.`);
  return file;
}

async function toWord(
  text: string,
  docPath: string,
  outputPath: string,
  settings: ExportSettings,
  paper: Paper,
  work: string,
  page: PageWhenNeeded,
  notes: string[],
  waits: (url: string) => boolean,
): Promise<number> {
  const pandoc = pandocPath();
  // Diagrams become pictures, drawn by the export page.
  const diagrams = findDiagrams(text);
  const drawnDiagrams: (string | null)[] = [];
  let broken = 0;
  if (diagrams.length) {
    const drawn = await (await page.get()).ask<DrawnDiagram[]>("diagrams", diagrams.map((d) => d.code));
    drawn.forEach((d, i) => {
      if (!d.png) {
        broken++;
        drawnDiagrams.push(null);
        return;
      }
      const file = path.join(work, `diagram-${i + 1}.png`);
      fs.writeFileSync(file, d.png);
      drawnDiagrams.push(file);
    });
  }
  const files = wordFiles(work);
  fs.writeFileSync(files.input, replaceDiagrams(text, drawnDiagrams));

  let referenceDoc: string;
  if (settings.style === "word" && settings.referenceDoc) {
    referenceDoc = stylesFile(docPath, settings.referenceDoc);
  } else {
    referenceDoc = path.join(work, "corillo-style.docx");
    fs.writeFileSync(referenceDoc, buildReferenceDocx(paper));
  }
  const luaFilter = settings.luaFilter ? needFile(settings.luaFilter, "The Lua filter") : undefined;
  const cwd = path.dirname(docPath);
  let stderr: string;
  try {
    // Pandoc reads the document once to measure its tables and find its pictures...
    await run(pandoc, pandocJsonArgs(files.input, files.reading), { cwd, timeoutMs: PANDOC_TIMEOUT_MS });
    const ast = JSON.parse(fs.readFileSync(files.reading, "utf8"));
    // ...Corillo checks and fetches the pictures...
    const plan = await readyForExport(imageSources(ast), text, path.dirname(docPath), work, waits);
    const style = fs.readFileSync(referenceDoc);
    const area = textArea(style);
    // (drawn three times as big as Word will show them, fitted to the page's text area)
    await drawForWord(plan, work, async (pictures) =>
      (await (await page.get()).ask<{ png?: Uint8Array }[]>("pictures", { area, pictures })).map((d) => d.png ?? null),
    );
    notes.push(...pictureNotes(plan.left));
    // ...and Pandoc makes the Word document.
    const { args } = wordMaking({ ast, plan, style, area, files, referenceDoc, luaFilter });
    ({ stderr } = await run(pandoc, args, { cwd, timeoutMs: PANDOC_TIMEOUT_MS }));
  } catch (err) {
    if (err instanceof ExportError) throw err;
    throw pandocProblem(err as RunFailure & { path?: string; syscall?: string }, settings);
  }
  notes.push(...warningNotes(stderr));
  deliver(files.output, outputPath, true);
  if (settings.script) {
    const problem = await runScript(settings.script, outputPath, docPath);
    if (problem) notes.push(problem);
  }
  return broken;
}

/** The pictures step (export-pictures.ts), for either format: checked, fetched from the web, and noted. */
async function readyForExport(srcs: string[], text: string, docDir: string, work: string, waits: (url: string) => boolean): Promise<PicturePlan> {
  const plan = planPictures(srcs, docDir, work);
  leaveOutWaiting(plan, waits);
  await fetchPictures(plan, work, webPicture, WEB_BUDGET_MS);
  for (const src of htmlPictures(text)) plan.left.push({ name: src, why: "html" });
  return plan;
}


// Scripts run on the finished Word document --------------------------------------------

/**
 * Run the person's script on the finished Word document: it gets the Word
 * document's path as its argument (and CORILLO_DOCUMENT, the Markdown file's).
 * Returns a plain explanation if it failed; the Word document is there either way.
 */
async function runScript(script: string, docxPath: string, docPath: string): Promise<string | null> {
  const name = nameOf(script);
  if (!fs.existsSync(script)) return `The script ${name} can't be found, so it wasn't run. Choose it again in Export Settings.`;
  const command = scriptCommand(script, docxPath);
  if ("problem" in command) return command.problem;
  // Apps opened from the Finder don't see the tools people install with Homebrew; add those places.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter(Boolean).join(":"),
    CORILLO_DOCUMENT: docPath,
    CORILLO_EXPORT: docxPath,
  };
  if (command.node) env.ELECTRON_RUN_AS_NODE = "1";
  try {
    await run(command.file, command.args, { cwd: path.dirname(docxPath), timeoutMs: SCRIPT_TIMEOUT_MS, env });
    return null;
  } catch (err) {
    const e = err as RunFailure;
    if (e.code === "ENOENT") return `The script ${name} needs ${nameOf(command.file)}, which isn't installed on this Mac, so it wasn't run.`;
    if (e.killed) return `The script ${name} took too long and was stopped.`;
    return endSentence(`The script ${name} stopped with an error: ${firstProblem(e.stderr) || e.message}`);
  }
}

// PDF --------------------------------------------------------------------------------------

/** A PDF's margins, in inches, and each paper's width. */
const PDF_MARGIN = 0.9;
const PAPER_WIDTH: Record<Paper, number> = { Letter: 8.5, A4: 210 / 25.4 };

// A small page number at the foot of each page.
const PDF_FOOTER =
  '<div style="width:100%;text-align:center;font:8pt -apple-system,Helvetica,sans-serif;color:#A9B2B8"><span class="pageNumber"></span></div>';

async function toPdf(
  text: string,
  docPath: string,
  outputPath: string,
  paper: Paper,
  work: string,
  pageWhenNeeded: PageWhenNeeded,
  notes: string[],
  waits: (url: string) => boolean,
): Promise<number> {
  const docDir = path.dirname(docPath);
  // The page shows only the pictures Corillo checked, from this Mac (pictures from the web were fetched first).
  const srcs = pageImageSources(text);
  const plan = await readyForExport(srcs, text, docDir, work, waits);
  notes.push(...pictureNotes(plan.left));
  const pictures: Record<string, string> = {};
  for (const src of srcs) {
    const key = pageKey(src, docDir);
    const ready = plan.ready.get(src);
    if (key && ready) pictures[key] = pathToFileURL(ready.file).href;
  }
  const page = await pageWhenNeeded.get();
  page.allow(Object.values(pictures));
  const { brokenDiagrams } = await page.ask<{ brokenDiagrams: number }>("document", {
    text,
    dirUrl: pathToFileURL(docDir).href,
    title: nameOf(docPath).replace(/\.[^.]+$/, ""),
    pictures,
    // The paper's text, in CSS pixels (96 to the inch), for keeping tables within it.
    textWidth: (PAPER_WIDTH[paper] - 2 * PDF_MARGIN) * 96,
  });
  const pdf = await page.window.webContents.printToPDF({
    pageSize: paper,
    margins: { top: PDF_MARGIN, bottom: PDF_MARGIN, left: PDF_MARGIN, right: PDF_MARGIN },
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: "<span></span>",
    footerTemplate: PDF_FOOTER,
    generateTaggedPDF: true,
    generateDocumentOutline: true,
  });
  deliver(pdf, outputPath);
  return brokenDiagrams;
}

// The window's side -----------------------------------------------------------------------

export type ExportOutcome =
  | { status: "done"; outputPath: string; name: string; notes: string[] }
  | { status: "failed"; message: string };

export interface ExportHost {
  /** The file of an open document, by its tab's id. */
  docPath(id: string): string;
  window(): BrowserWindow;
  /** The web pictures that wait for the person in the document at this path (main.ts): exports leave them out. */
  waitingPictures(docPath: string, text: string): string[];
}

/** The web pictures that wait in a document; until the app says, every web picture in it (fails closed). */
let waitingFor: (docPath: string, text: string) => string[] = (_docPath, text) => [...webPicturesIn(text)];

/** Files exported in this session: the only ones the window may ask to open or show. */
const exported = new Set<string>();
/**
 * Files the person chose in Export Settings' dialogs this session, for each
 * document (by its id in Corillo's records) and setting: the only new ones
 * the window may store, and only there.
 */
const chosenFiles = new Map<string, Record<FileSetting, Set<string>>>();
/** Where the save dialog said to put each tab's next export, and in which format: the only export the window may run. */
const chosenOutputs = new Map<string, { outputPath: string; format: ExportFormat }>();

const isFormat = (format: unknown): format is ExportFormat => format === "docx" || format === "pdf";

/** An agent's export: the same step as the Export menu's, and the window may then open or show the file. */
export async function exportForAgent(docPath: string, format: ExportFormat, outputPath: string): Promise<ExportResult> {
  const result = await exportDocument(docPath, format, { outputPath });
  exported.add(result.outputPath);
  return result;
}

const FILE_KINDS: Record<string, { setting: FileSetting; title: string; filters: Electron.FileFilter[] }> = {
  word: { setting: "referenceDoc", title: "Use the styles of a Word document", filters: [{ name: "Word documents and templates", extensions: ["docx", "dotx"] }] },
  lua: { setting: "luaFilter", title: "Choose a Lua filter", filters: [{ name: "Lua filters", extensions: ["lua"] }] },
  script: { setting: "script", title: "Choose an app or script", filters: [] },
};

export function registerExport(host: ExportHost): void {
  waitingFor = (docPath, text) => host.waitingPictures(docPath, text);
  // Old work is cleared once Corillo is up (main.ts's afterLaunch says when),
  // so it never holds up the first document, and only by the Corillo that
  // goes on running (a second one opened just hands its documents over).
  (app as NodeJS.EventEmitter).once("corillo-launch-done", clearOldWork);
  // Quitting mid-export: stop its programs (Pandoc, a script) and clear its work.
  app.on("will-quit", () => {
    stopAllPrograms();
    for (const work of workFolders) fs.rmSync(work, { recursive: true, force: true });
    workFolders.clear();
  });

  ipcMain.handle("export:choose-path", async (_e, id: string, format: ExportFormat) => {
    if (!isFormat(format)) return null;
    const docPath = host.docPath(id);
    const result = await dialog.showSaveDialog(host.window(), {
      title: format === "docx" ? "Export to Word" : "Export to PDF",
      defaultPath: exportSuggestion(docPath, format),
      buttonLabel: "Export",
      filters: [format === "docx" ? { name: "Word document", extensions: ["docx"] } : { name: "PDF", extensions: ["pdf"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (result.canceled || !result.filePath) return null;
    chosenOutputs.set(id, { outputPath: result.filePath, format });
    return result.filePath;
  });

  ipcMain.handle("export:run", async (_e, id: string, format: ExportFormat, outputPath: string): Promise<ExportOutcome> => {
    // Only the export the save dialog was opened for: that place, in that format (a .docx can't become x.docx.pdf).
    const chosen = chosenOutputs.get(id);
    if (!isFormat(format) || typeof outputPath !== "string" || chosen?.outputPath !== outputPath || chosen.format !== format) {
      return { status: "failed", message: "Choose where to save the export, then try again." };
    }
    chosenOutputs.delete(id);
    try {
      const result = await exportDocument(host.docPath(id), format, { outputPath });
      exported.add(result.outputPath);
      return { status: "done", outputPath: result.outputPath, name: nameOf(result.outputPath), notes: result.notes };
    } catch (err) {
      const message =
        err instanceof ExportError ? err.message : `Something went wrong while exporting: ${err instanceof Error ? err.message : String(err)}`;
      return { status: "failed", message };
    }
  });

  ipcMain.handle("export:get-settings", (_e, id: string) => settingsFor(host.docPath(id)));
  ipcMain.handle("export:set-settings", (_e, id: string, settings: ExportSettings) => {
    const docPath = host.docPath(id);
    const next = exportSettingsFrom(settings);
    if (!settingsAllowed(next, settingsFor(docPath), chosenFiles.get(documents().idFor(docPath)) ?? {})) return false;
    saveSettingsFor(docPath, next);
    return true;
  });

  ipcMain.handle("export:choose-file", async (_e, id: string, kind: string) => {
    const spec = Object.hasOwn(FILE_KINDS, kind) ? FILE_KINDS[kind] : null;
    if (!spec) return null;
    const docId = documents().idFor(host.docPath(id));
    const result = await dialog.showOpenDialog(host.window(), { title: spec.title, properties: ["openFile"], filters: spec.filters });
    if (result.canceled || !result.filePaths[0]) return null;
    const forDocument = chosenFiles.get(docId) ?? { referenceDoc: new Set<string>(), luaFilter: new Set<string>(), script: new Set<string>() };
    forDocument[spec.setting].add(result.filePaths[0]);
    chosenFiles.set(docId, forDocument);
    return result.filePaths[0];
  });

  ipcMain.handle("export:open", async (_e, file: string) => {
    if (!exported.has(file)) return;
    if (!fs.existsSync(file)) return `${nameOf(file)} couldn't be opened. It may have been moved, renamed or deleted.`;
    const problem = await shell.openPath(file);
    if (!problem) return null;
    const kind = path.extname(file).toLowerCase() === ".pdf" ? "PDFs" : "Word documents";
    return `${nameOf(file)} couldn't be opened. This Mac may have no app that opens ${kind}; try Show in Finder.`;
  });
  ipcMain.handle("export:reveal", (_e, file: string) => {
    if (exported.has(file)) shell.showItemInFolder(file);
  });
}
