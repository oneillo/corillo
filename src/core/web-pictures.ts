// Which pictures in a document are on the web, and which an agent's change
// added (roadmap Batch 18, item 1). A web picture an agent adds waits for the
// person to show it, so a misled agent can't send words from the document to
// a site by writing them into a picture's address. Addresses are compared as
// Corillo reads the Markdown (a picture's src on the page), so a picture
// written as a reference ![a][r], or with its address spelled another way,
// is found the same as one written plainly.
import type { Node } from "prosemirror-model";
import { parseMarkdown } from "./markdown";
import { setDiagramAddresses } from "./schema";

/** The name Corillo gives a site it asks for a picture, the window and the export alike: a browser's plainest, nothing about Corillo, Electron, Chrome or the Mac. */
export const PLAIN_NAME = "Mozilla/5.0";

/** A picture's address that isn't on this Mac or in the document itself: the window would ask the web for it. */
export function isWebAddress(src: string): boolean {
  const s = src.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^(file|data|blob):/i.test(s);
}

/** A picture's address written in a diagram's code: where it is in the code, as written, and the address it reads as. */
export interface DiagramPicture {
  from: number;
  to: number;
  address: string;
}

/**
 * Code read as the diagram's library and the browser read it, with where each
 * character came from in the code as written (`from` and `to`, absent while
 * nothing was changed), so an address found here is blanked where it's written.
 */
interface Read {
  text: string;
  from?: number[];
  to?: number[];
}

/** One more way of reading: each match of `pattern` read as `as` gives (null leaves it as written). */
function readAgain(r: Read, pattern: RegExp, as: (m: RegExpMatchArray) => string | null): Read {
  let text = "";
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  const keep = (a: number, b: number) => {
    text += r.text.slice(a, b);
    for (let i = a; i < b; i++) {
      from.push(r.from ? r.from[i] : i);
      to.push(r.to ? r.to[i] : i + 1);
    }
  };
  let changed = false;
  for (const m of r.text.matchAll(pattern)) {
    const read = as(m);
    if (read === null) continue;
    const end = m.index + m[0].length;
    keep(at, m.index);
    const a = r.from ? r.from[m.index] : m.index;
    const b = r.to ? r.to[end - 1] : end;
    text += read;
    for (let i = 0; i < read.length; i++) {
      from.push(a);
      to.push(b);
    }
    at = end;
    changed = true;
  }
  if (!changed) return r;
  keep(at, r.text.length);
  return { text, from, to };
}

const character = (code: number) => (code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "\ufffd");

// The names HTML gives the characters an address is written with (and a few more), as a browser reads them.
const ENTITIES: Record<string, string> = {
  amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", colon: ":", sol: "/", period: ".", quest: "?", equals: "=", num: "#",
  percnt: "%", commat: "@", plus: "+", comma: ",", semi: ";", excl: "!", dollar: "$", lpar: "(", rpar: ")", ast: "*",
  midast: "*", lowbar: "_", underbar: "_", lsqb: "[", lbrack: "[", rsqb: "]", rbrack: "]", bsol: "\\", hat: "^",
  grave: "`", diacriticalgrave: "`", lcub: "{", lbrace: "{", rcub: "}", rbrace: "}", verbar: "|", vert: "|",
  verticalline: "|", tab: "\t", newline: "\n",
};

// The library's stand-ins for "&#", "&" and ";" while it reads (#58; becomes the first, 58 and the last), put back once drawn.
const STAND_INS: Record<string, string> = { "\uFB02\u00B0\u00B0": "&#", "\uFB02\u00B0": "&", "\u00B6\u00DF": ";" };

/**
 * A diagram's code as it's read before anything is drawn: escapes a backslash
 * writes in its settings (JSON) and picture shapes and front matter (YAML, its
 * escaped line break included), the library's way of writing a character by
 * number or name (#58;) and its own stand-ins for them, HTML's (&#58;,
 * &colon;) in labels, and CSS's (\3a ) in its styles. Read one after the
 * other, as each reaches the next, so an address spelled any of these ways is
 * found. Last, a tab, line feed or carriage return an escape wrote is dropped,
 * as the browser drops them from an address.
 */
function readDiagram(code: string): Read {
  let r: Read = { text: code };
  r = readAgain(r, /\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|U([0-9a-fA-F]{8})|([\\/])|(\r?\n[ \t]*))/g, (m) =>
    // (A JSON character outside the first 65,536 is two of these, each half of it.)
    m[5] !== undefined ? "" : (m[4] ?? (m[1] !== undefined ? String.fromCharCode(parseInt(m[1], 16)) : character(parseInt(m[2] ?? m[3], 16)))),
  );
  r = readAgain(r, /#(\w+);/g, (m) => (/^\d+$/.test(m[1]) ? `&#${m[1]};` : `&${m[1]};`));
  r = readAgain(r, /\uFB02\u00B0\u00B0|\uFB02\u00B0|\u00B6\u00DF/g, (m) => STAND_INS[m[0]]);
  r = readAgain(r, /&(?:#x([0-9a-f]+);?|#([0-9]+);?|([a-z][a-z0-9]*);)/gi, (m) =>
    m[3] !== undefined ? (ENTITIES[m[3].toLowerCase()] ?? null) : character(m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2], 10)),
  );
  r = readAgain(r, /\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|([^\n0-9a-f]))/gi, (m) => m[2] ?? character(parseInt(m[1], 16)));
  // Only those an escape wrote: one written as it is ends an unquoted address, or sits in a quoted one, found either way.
  const escaped = r;
  return readAgain(escaped, /[\t\n\r]/g, (m) => (escaped.from && escaped.to![m.index!] - escaped.from[m.index!] > 1 ? "" : null));
}

// A picture shape's address (img: "...", its unquoted value ends at a comma or
// a brace), a label's picture (<img src="...">, unquoted up to a space or ">"),
// or a style's url(...) (quoted to its closing quote, unquoted to its bracket).
const NAMED =
  /\b(?:img\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>,}]+))|src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))|url\(\s*(?:"([^"\n\r\f]*)"|'([^'\n\r\f]*)'|([^\s"'()]+)\s*\)))/dgi;
// Any other address on the web in the code (a style's url(...), say): a diagram's every way to the web counts.
// http: and https: count without their slashes too, as a browser reads them ("https:site/x.png").
const BARE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|https?:)[^\s"'<>()`|\\{}]+/gi;

/**
 * The web addresses written in a diagram's code (a ```mermaid block), each
 * where it is, so the window can draw the diagram without the ones that wait
 * (roadmap Batch 18, the review's R18-2): a picture shape's img:, a picture
 * in a label, and any other address on the web the code holds, however it's
 * spelled (see readDiagram).
 */
export function diagramPictures(code: string): DiagramPicture[] {
  const r = readDiagram(code);
  const found: { at: number; end: number; address: string }[] = [];
  for (const m of r.text.matchAll(NAMED)) {
    const group = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((g) => m[g] !== undefined)!;
    const [at, end] = m.indices![group]!;
    const address = m[group]!.trim();
    if (isWebAddress(address)) found.push({ at, end, address });
  }
  const taken = (at: number) => found.some((p) => at >= p.at && at < p.end);
  for (const m of r.text.matchAll(BARE)) {
    const written = m[0].replace(/[.,;:]+$/, "");
    if (!taken(m.index) && isWebAddress(written)) found.push({ at: m.index, end: m.index + written.length, address: written });
  }
  // Where each is in the code as written.
  return found
    .map(({ at, end, address }) => ({
      from: r.from ? r.from[at] : at,
      to: r.to ? r.to[end - 1] : end,
      address,
    }))
    .sort((a, b) => a.from - b.from);
}

/** A diagram: a code block whose language is mermaid, as the window draws it (renderer/diagrams.ts). */
export const isDiagramBlock = (node: Node) => node.type.name === "code_block" && /^mermaid\b/.test(String(node.attrs.params ?? "").trim());

// A copy of a diagram says which of its web addresses wait (schema.ts).
setDiagramAddresses((node) => (isDiagramBlock(node) ? diagramPictures(node.textContent).map((p) => p.address) : []));

/** The web addresses of the pictures in a document, a diagram's included. */
export function webPicturesOf(doc: Node): Set<string> {
  const found = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === "image" && typeof node.attrs.src === "string" && isWebAddress(node.attrs.src)) found.add(node.attrs.src);
    if (isDiagramBlock(node)) for (const p of diagramPictures(node.textContent)) found.add(p.address);
    return node.isBlock; // pictures sit in text; nothing inside a picture
  });
  return found;
}

/** A picture with nothing in it (1 by 1, see-through), drawn in a diagram in place of a picture that waits. */
export const BLANK_PICTURE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** A diagram's code with the addresses that wait put out of reach: a blank picture in their place, for drawing only. */
export function withoutWaiting(code: string, waits: (address: string) => boolean): { code: string; waiting: string[] } {
  const waiting: string[] = [];
  let out = "";
  let at = 0;
  for (const p of diagramPictures(code)) {
    if (!waits(p.address)) continue;
    if (!waiting.includes(p.address)) waiting.push(p.address);
    out += code.slice(at, p.from) + BLANK_PICTURE;
    at = p.to;
  }
  return { code: at ? out + code.slice(at) : code, waiting };
}

/**
 * An address as the network sees it, to tell whether a request is for one
 * that waits: read as a browser reads it (its spaces and other letters
 * escaped, capitals in its host made small), without a #part, which never
 * goes to the site. Null for one that isn't an address.
 */
export function asRequested(address: string): string | null {
  try {
    const url = new URL(address.trim());
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/**
 * How much the window may send in one call to say web pictures wait in a
 * document it has open (roadmap Batch 19, item 1): a copy pasted from where
 * they wait. More goes in more calls. The characters are the longest address
 * Chromium would ask for, so no address that could load is ever too long.
 */
export const WAIT_CALL = { addresses: 1_000, characters: 2 * 1024 * 1024 };

/** Addresses in calls within WAIT_CALL's limits (one longer than the limit alone is left out: nothing could ask for it). */
export function inCalls(addresses: string[]): string[][] {
  const calls: string[][] = [];
  let call: string[] = [];
  let size = 0;
  for (const a of addresses) {
    if (a.length > WAIT_CALL.characters) continue;
    if (call.length === WAIT_CALL.addresses || size + a.length > WAIT_CALL.characters) {
      calls.push(call);
      call = [];
      size = 0;
    }
    call.push(a);
    size += a.length;
  }
  if (call.length) calls.push(call);
  return calls;
}

// The last few texts read, as an agent's pass reads the text it just wrote
// again at its next edit. Let go when a pass ends (main.ts), so no document's
// text is held after it (the review of Batch 18, R18-6).
const read: { text: string; pictures: Set<string> }[] = [];
const KEEP = 2;

/** The web pictures in a Markdown text, not kept (for reading many texts once). */
export function webPicturesOfText(text: string): Set<string> {
  if (!text.includes("![") && !/mermaid/i.test(text)) return new Set();
  return webPicturesOf(parseMarkdown(text).doc);
}

/** The web pictures in a Markdown text (every picture is written with "![", or in a diagram, so a text with neither has none). */
export function webPicturesIn(text: string): Set<string> {
  if (!text.includes("![") && !/mermaid/i.test(text)) return new Set();
  const kept = read.find((r) => r.text === text);
  if (kept) return kept.pictures;
  const pictures = webPicturesOfText(text);
  read.unshift({ text, pictures });
  read.length = Math.min(read.length, KEEP);
  return pictures;
}

/** Let go of the texts read (an agent's pass ended). */
export function forgetReadTexts(): void {
  read.length = 0;
}

/** How many texts are held now (for the leak checks). */
export function readTextsHeld(): number {
  return read.length;
}

/** The web pictures in `after` that weren't in `before`, in the order they come. */
export function addedWebPictures(before: string, after: string): string[] {
  const now = webPicturesIn(after);
  if (!now.size) return [];
  const was = webPicturesIn(before);
  return [...now].filter((src) => !was.has(src));
}
