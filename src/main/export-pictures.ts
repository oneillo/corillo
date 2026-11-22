// The pictures step of an export. Before Pandoc (Word) or the export page
// (PDF) sees a document, Corillo itself finds every picture it shows, checks
// that each really is a picture, fetches the ones on the web and, for Word,
// draws SVG, WebP, AVIF and BMP pictures as PNGs. Only what passes is exported, from known files;
// everything else is left out, and the person is told what and why. So a
// document can't slip some other file from this Mac into a Word document by
// calling it a picture, a slow web server can't hold an export up for long,
// and nothing is left out without a word.
//
// The export follows the page: the page shows pictures on this Mac and at
// secure (https:) web addresses, so an http: picture is left out of Word and
// PDF alike. A picture written in a block of HTML is shown as HTML source in
// the editor, and its words only on paper, so it's left out too.
import type MarkdownIt from "markdown-it";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exportReader } from "../core/obsidian-export";

export type PictureKind = "png" | "jpeg" | "gif" | "webp" | "bmp" | "tiff" | "heic" | "avif" | "svg";

const MIME: Record<PictureKind, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tiff: "image/tiff",
  heic: "image/heic",
  avif: "image/avif",
  svg: "image/svg+xml",
};

const EXTENSION: Record<PictureKind, string> = {
  png: "png",
  jpeg: "jpg",
  gif: "gif",
  webp: "webp",
  bmp: "bmp",
  tiff: "tiff",
  heic: "heic",
  avif: "avif",
  svg: "svg",
};

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);

/**
 * What kind of picture these bytes (the start of a file is enough) are, by
 * the marks each kind starts with; null when they aren't a picture.
 */
export function pictureKind(b: Uint8Array): PictureKind | null {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return "gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "webp";
  if (b.length >= 18 && ascii(b, 0, 2) === "BM") {
    const header = b[14] | (b[15] << 8) | (b[16] << 16) | (b[17] << 24);
    if ([12, 40, 52, 56, 64, 108, 124].includes(header)) return "bmp";
  }
  if (b.length >= 8 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a))) return "tiff";
  if (b.length >= 16 && ascii(b, 4, 8) === "ftyp") {
    const size = Math.min(b.length, ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0 || b.length);
    const brands = [ascii(b, 8, 12)];
    for (let at = 16; at + 4 <= size; at += 4) brands.push(ascii(b, at, at + 4));
    if (brands.some((x) => x === "avif" || x === "avis")) return "avif";
    if (brands.some((x) => HEIC_BRANDS.has(x))) return "heic";
    if (brands.includes("mif1") || brands.includes("msf1")) return "heic";
    return null;
  }
  // An SVG drawing is text: maybe an XML declaration, comments and a doctype, then <svg.
  const text = new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(0, 4096)).replace(/^\uFEFF/, "");
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[^\]]*\])?\s*>)\s*)*<svg[\s>/]/i.test(text)) return "svg";
  return null;
}

/** A picture that passed: the file to export it from, and what kind it is. */
export interface Picture {
  file: string;
  kind: PictureKind;
  mime: string;
  ext: string;
}

const picture = (file: string, kind: PictureKind): Picture => ({ file, kind, mime: MIME[kind], ext: EXTENSION[kind] });

/** Why a picture was left out. */
export type LeftOut = "missing" | "not-picture" | "kind" | "load" | "insecure" | "draw" | "html" | "text" | "diagram" | "waiting";

/** Kinds of picture the page can't show (its browser doesn't read them), so the export leaves them out too. */
const NOT_SHOWN = new Set<PictureKind>(["heic", "tiff"]);

/**
 * Kinds Word gets as PNG pictures, drawn by the export page: SVG drawings,
 * and WebP, AVIF and BMP pictures, which not every Word app shows, or not at
 * the size the page does.
 */
const DRAWN_FOR_WORD = new Set<PictureKind>(["svg", "webp", "avif", "bmp"]);

export interface PicturePlan {
  /** Each picture's address, as the document has it: what to export, or null (left out). */
  ready: Map<string, Picture | null>;
  /** Pictures on the web still to fetch: each address, and the ways the document writes it. */
  web: Map<string, string[]>;
  /** What was left out and why, for the notes. */
  left: { name: string; why: LeftOut }[];
}

/** An address as a person reads it: %20 as a space, and so on. */
function shown(src: string): string {
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
}

type Place =
  | { kind: "none" }
  | { kind: "local"; file: string }
  | { kind: "web"; url: string }
  | { kind: "insecure"; url: string }
  | { kind: "data"; bytes: Uint8Array }
  | { kind: "other" };

/**
 * Whether the page shows a picture at this address, by the check the page's
 * reading of Markdown (markdown-it) makes: a file: address, and a data:
 * address of a kind other than GIF, PNG, JPEG or WebP, it shows as text.
 */
export function pageShows(src: string): boolean {
  return md.validateLink(md.normalizeLink(src.trim()));
}

/** Where a picture's address points, from the document's folder. */
function placeOf(src: string, docDir: string): Place {
  const s = src.trim();
  if (!s || s.startsWith("#")) return { kind: "none" };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1]?.toLowerCase();
  if (scheme === "https") return { kind: "web", url: s };
  if (scheme === "http") return { kind: "insecure", url: s };
  if (scheme === "data") {
    const m = /^data:([^,]*),(.*)$/is.exec(s);
    if (!m) return { kind: "other" };
    try {
      const bytes = /;base64$/i.test(m[1]) ? Buffer.from(m[2], "base64") : Buffer.from(decodeURIComponent(m[2]), "utf8");
      return { kind: "data", bytes: new Uint8Array(bytes) };
    } catch {
      return { kind: "other" };
    }
  }
  if (scheme === "file") {
    try {
      return { kind: "local", file: fileURLToPath(s.split(/[?#]/)[0]) };
    } catch {
      return { kind: "other" };
    }
  }
  if (scheme) return { kind: "other" };
  return { kind: "local", file: path.resolve(docDir, shown(s.split(/[?#]/)[0])) };
}

/** The first bytes of a file, enough to tell a picture; null if it isn't a plain file that can be read. */
function head(file: string): Uint8Array | null {
  let fd: number | undefined;
  try {
    if (!fs.statSync(file).isFile()) return null;
    fd = fs.openSync(file, "r");
    const buf = new Uint8Array(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The first look at every picture: the ones on this Mac (and written into the
 * document) are checked now; the ones on the web are listed for fetchPictures.
 * Files Corillo writes go in `work`.
 */
export function planPictures(srcs: Iterable<string>, docDir: string, work: string): PicturePlan {
  const plan: PicturePlan = { ready: new Map(), web: new Map(), left: [] };
  const byFile = new Map<string, Picture | null>();
  let written = 0;
  for (const src of srcs) {
    if (plan.ready.has(src) || [...plan.web.values()].some((list) => list.includes(src))) continue;
    // The export follows the page: what it shows as text isn't a picture in Word either.
    if (!pageShows(src)) {
      plan.ready.set(src, null);
      plan.left.push({ name: /^\s*data:/i.test(src) ? `${src.trim().slice(0, 30)}…` : shown(src).slice(0, 200), why: "text" });
      continue;
    }
    const place = placeOf(src, docDir);
    if (place.kind === "none") {
      plan.ready.set(src, null);
    } else if (place.kind === "web") {
      const list = plan.web.get(place.url) ?? [];
      list.push(src);
      plan.web.set(place.url, list);
    } else if (place.kind === "insecure") {
      plan.ready.set(src, null);
      plan.left.push({ name: src, why: "insecure" });
    } else if (place.kind === "other") {
      plan.ready.set(src, null);
      plan.left.push({ name: shown(src).slice(0, 80), why: "load" });
    } else if (place.kind === "data") {
      const kind = pictureKind(place.bytes);
      if (!kind || NOT_SHOWN.has(kind)) {
        plan.ready.set(src, null);
        plan.left.push({ name: `${src.slice(0, 30)}…`, why: kind ? "kind" : "not-picture" });
        continue;
      }
      const file = path.join(work, `picture-${++written}.${EXTENSION[kind]}`);
      fs.writeFileSync(file, place.bytes);
      plan.ready.set(src, picture(file, kind));
    } else {
      if (byFile.has(place.file)) {
        plan.ready.set(src, byFile.get(place.file)!);
        continue;
      }
      const exists = fs.existsSync(place.file);
      const bytes = exists ? head(place.file) : null;
      const kind = bytes ? pictureKind(bytes) : null;
      const found = kind && !NOT_SHOWN.has(kind) ? picture(place.file, kind) : null;
      byFile.set(place.file, found);
      plan.ready.set(src, found);
      if (!found) plan.left.push({ name: shown(src), why: kind ? "kind" : exists ? "not-picture" : "missing" });
    }
  }
  return plan;
}

/** Fetches a picture on the web; rejects if it can't, or once `signal` says to stop. */
export type Fetcher = (url: string, signal: AbortSignal) => Promise<Uint8Array>;

/**
 * Leave out the pictures on the web that wait for the person to show them (an
 * agent added them: roadmap Batch 18, the review's R18-1), before anything is
 * fetched: `waits` says, for an address, whether it does.
 */
export function leaveOutWaiting(plan: PicturePlan, waits: (url: string) => boolean): void {
  for (const [url, srcs] of [...plan.web]) {
    if (!waits(url)) continue;
    plan.web.delete(url);
    for (const src of srcs) plan.ready.set(src, null);
    plan.left.push({ name: shown(url), why: "waiting" });
  }
}

/** How long the pictures on the web may take, all together. */
export const WEB_BUDGET_MS = 10_000;

/**
 * Fetch the pictures on the web, all at once, within the time budget. Each
 * that arrives and is a picture is saved in `work`; the rest are left out.
 */
export async function fetchPictures(plan: PicturePlan, work: string, fetcher: Fetcher | null, budgetMs = WEB_BUDGET_MS): Promise<void> {
  if (!plan.web.size) return;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), budgetMs);
  try {
    const results = await Promise.all(
      [...plan.web].map(async ([url], i): Promise<Picture | "kind" | null> => {
        try {
          if (!fetcher) return null;
          const bytes = await fetcher(url, stop.signal);
          const kind = pictureKind(bytes);
          if (!kind) return null;
          if (NOT_SHOWN.has(kind)) return "kind";
          const file = path.join(work, `web-${i + 1}.${EXTENSION[kind]}`);
          fs.writeFileSync(file, bytes);
          return picture(file, kind);
        } catch {
          return null;
        }
      }),
    );
    // In the document's order, whichever arrived first.
    [...plan.web].forEach(([url, srcs], i) => {
      const got = results[i];
      for (const src of srcs) plan.ready.set(src, typeof got === "object" ? got : null);
      if (typeof got !== "object" || !got) plan.left.push({ name: url, why: got === "kind" ? "kind" : "load" });
    });
  } finally {
    clearTimeout(timer);
    plan.web.clear();
  }
}

/** Draws pictures (each its kind and bytes) as PNG pictures, in the export page; null for one that can't be drawn. */
export type PictureDrawer = (pictures: { mime: string; bytes: Uint8Array }[]) => Promise<(Uint8Array | null)[]>;

/**
 * For Word: each SVG, WebP, AVIF or BMP picture becomes a PNG (Word and the
 * apps people send Word files to don't all show those, and Pandoc can't tell
 * the size of some), drawn at the size the page shows it.
 */
export async function drawForWord(plan: PicturePlan, work: string, draw: PictureDrawer | null): Promise<void> {
  const chosen = new Map<string, Picture>();
  for (const p of plan.ready.values()) if (p && DRAWN_FOR_WORD.has(p.kind)) chosen.set(p.file, p);
  const files = [...chosen.keys()];
  if (!files.length) return;
  let drawn: (Uint8Array | null)[] = [];
  try {
    if (draw) drawn = await draw(files.map((f) => ({ mime: chosen.get(f)!.mime, bytes: new Uint8Array(fs.readFileSync(f)) })));
  } catch {
    drawn = [];
  }
  const swap = new Map<string, Picture | null>();
  files.forEach((file, i) => {
    const png = drawn[i];
    if (!png) return swap.set(file, null);
    const out = path.join(work, `drawn-${i + 1}.png`);
    fs.writeFileSync(out, png);
    swap.set(file, picture(out, "png"));
  });
  for (const [src, p] of plan.ready) {
    if (!p || !swap.has(p.file)) continue;
    const now = swap.get(p.file)!;
    plan.ready.set(src, now);
    if (!now) plan.left.push({ name: shown(src), why: "draw" });
  }
}

const NOTES: Record<LeftOut, [one: string, many: (n: number) => string]> = {
  missing: ["A picture couldn't be found and was left out:", (n) => `${n} pictures couldn't be found and were left out:`],
  "not-picture": ["A file used as a picture isn't one, so it was left out:", (n) => `${n} files used as pictures aren't pictures, so they were left out:`],
  kind: [
    "A picture was left out because Corillo can't show its kind of file (HEIC or TIFF; save it as JPEG or PNG):",
    (n) => `${n} pictures were left out because Corillo can't show their kind of file (HEIC or TIFF; save them as JPEG or PNG):`,
  ],
  load: ["A picture on the web couldn't be loaded and was left out:", (n) => `${n} pictures on the web couldn't be loaded and were left out:`],
  insecure: [
    "A picture was left out because its web address isn't secure (it starts with http:, and Corillo shows only https: pictures):",
    (n) => `${n} pictures were left out because their web addresses aren't secure (they start with http:, and Corillo shows only https: pictures):`,
  ],
  draw: ["A picture couldn't be drawn and was left out:", (n) => `${n} pictures couldn't be drawn and were left out:`],
  html: ["A picture written in HTML was left out (Corillo shows HTML as its text):", (n) => `${n} pictures written in HTML were left out (Corillo shows HTML as its text):`],
  text: [
    "A picture was left out because Corillo shows its address as text rather than as a picture:",
    (n) => `${n} pictures were left out because Corillo shows their addresses as text rather than as pictures:`,
  ],
  waiting: [
    "A picture from the web was left out because it is waiting for you to show it:",
    (n) => `${n} pictures from the web were left out because they are waiting for you to show them:`,
  ],
  diagram: [
    "A picture inside a diagram was left out (exports take only the document's own pictures):",
    (n) => `${n} pictures inside diagrams were left out (exports take only the document's own pictures):`,
  ],
};

/**
 * A note ended as a sentence, so several in the notice don't run together:
 * a full stop unless it already ends as one would (a name cut short ends in "…").
 */
export function endSentence(note: string): string {
  return /[.!?…]["')\]]?$/.test(note.trimEnd()) ? note.trimEnd() : `${note.trimEnd()}.`;
}

/** What the person is told about the pictures left out, one sentence for each reason. */
export function pictureNotes(left: { name: string; why: LeftOut }[]): string[] {
  const notes: string[] = [];
  for (const why of Object.keys(NOTES) as LeftOut[]) {
    const names = [...new Set(left.filter((l) => l.why === why).map((l) => l.name))];
    if (!names.length) continue;
    const [one, many] = NOTES[why];
    notes.push(endSentence(`${names.length === 1 ? one : many(names.length)} ${names.join(", ")}`));
  }
  return notes;
}

/**
 * What the person is told about what the export page wasn't allowed to load
 * (a picture a diagram links to): addresses, a file as its path, in a set
 * order (the page asks for them in whatever order they come).
 */
export function refusedNotes(urls: string[]): string[] {
  const names = urls.map((url) => {
    try {
      if (/^file:/i.test(url)) return fileURLToPath(url);
    } catch {
      // keep the address
    }
    return url;
  });
  return pictureNotes(names.sort().map((name) => ({ name: name.slice(0, 200), why: "diagram" as const })));
}

/**
 * The pictures that passed, by their address as the document has it (what
 * Corillo's Lua filter gets), each with the name it has in the Word file:
 * one name for each file, however many ways the document writes it.
 */
export function readyPictures(plan: PicturePlan): Record<string, { file: string; mime: string; ext: string; name: string }> {
  const out: Record<string, { file: string; mime: string; ext: string; name: string }> = {};
  const names = new Map<string, string>();
  for (const [src, p] of plan.ready) {
    if (!p) continue;
    const name = names.get(p.file) ?? `corillo-picture-${names.size + 1}.${p.ext}`;
    names.set(p.file, name);
    out[src] = { file: p.file, mime: p.mime, ext: p.ext, name };
  }
  return out;
}

// Finding the pictures ---------------------------------------------------------

type PandocNode = { t?: string; c?: unknown };

/** Every picture's address in Pandoc's reading of a document (its JSON), as Pandoc's Word writer will see it. */
export function imageSources(ast: { blocks: unknown[] }): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    const el = node as PandocNode;
    if (!el || typeof el !== "object") return;
    if (el.t === "Image") {
      const [, , target] = el.c as [unknown, unknown, [string, string]];
      found.push(target[0]);
    }
    if (el.t) visit(el.c);
  };
  visit(ast.blocks);
  return found;
}

// Read the Markdown the way the page does.
const md = exportReader;
type Token = ReturnType<MarkdownIt["parse"]>[number];

/** Every picture's address the page shows, as the page reads the Markdown (markdown-it). */
export function pageImageSources(text: string): string[] {
  const found: string[] = [];
  const visit = (tokens: Token[]) => {
    for (const t of tokens) {
      if (t.type === "image") found.push(t.attrGet("src") ?? "");
      if (t.children) visit(t.children);
    }
  };
  visit(md.parse(text.replace(/\r\n?/g, "\n"), {}));
  return found;
}

/**
 * The pictures written in HTML (<img src="...">), in a block of its own or in
 * a paragraph, which exports leave out: the page shows HTML as its text. One
 * in an HTML comment (<!-- -->) isn't shown anywhere, so it isn't listed.
 */
export function htmlPictures(text: string): string[] {
  const found: string[] = [];
  const look = (html: string) => {
    const shownHtml = html.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
    for (const m of shownHtml.matchAll(/<(?:img|image|video|audio|source)\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      found.push(shown(m[1] ?? m[2] ?? m[3] ?? ""));
    }
  };
  for (const t of md.parse(text.replace(/\r\n?/g, "\n"), {})) {
    if (t.type === "html_block") look(t.content);
    for (const child of t.children ?? []) if (child.type === "html_inline") look(child.content);
  }
  return found;
}

/** The address the PDF page looks a picture up by: where it points, as a URL. */
export function pageKey(src: string, docDir: string): string | null {
  try {
    return new URL(src, pathToFileURL(docDir.endsWith("/") ? docDir : docDir + "/").href).href;
  } catch {
    return null;
  }
}
