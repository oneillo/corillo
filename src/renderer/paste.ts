// Pasting. Rich text from Word, Google Docs, Pages, Outlook and web pages comes
// in clean (see clean-html.ts). Plain text written in Markdown (from an
// agent's chat, say) comes in formatted. Paste and Match Style (Cmd+Shift+V)
// pastes plain text. Pictures in pasted content are copied into the
// document's pictures folder, as an inserted picture would be.
import { Plugin } from "prosemirror-state";
import { DOMSerializer, type Slice } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { schema } from "../core/schema";
import { parseMarkdown } from "../core/markdown";
import { looksLikeMarkdown } from "../core/clipboard-text";
import { cleanPastedHTML, keptLink } from "./clean-html";
import { hasCopyMark, isCorilloCopy, waitingOfCopy } from "./copy";
import { noticeOn } from "./file-notice";
import { fileOf, kindOf, notKept, type PictureStore } from "./images";
import { IMAGE_TYPES, SAME_KIND } from "../core/picture-kinds";
import { diagramPictures, webPicturesOf, webPicturesOfText, WAIT_CALL } from "../core/web-pictures";
import type { DocTab } from "./doc-tab";
import { asStepOfItsOwn } from "./undo-resolve";

/** Markdown text as the HTML the editor reads, its links kept by the same rule as rich text's (clean-html.ts). */
export function markdownToHTML(text: string): string {
  const div = document.createElement("div");
  div.append(DOMSerializer.fromSchema(schema).serializeFragment(parseMarkdown(text).doc.content));
  for (const a of div.querySelectorAll("a[href]")) {
    const written = a.getAttribute("href")!;
    if (written.startsWith("#")) continue; // a heading in the document it's pasted into
    const href = keptLink(written);
    if (href) a.setAttribute("href", href);
    else a.replaceWith(...a.childNodes);
  }
  return div.innerHTML;
}

export type PasteChoice = { kind: "html"; html: string } | { kind: "text" } | { kind: "editor" };

const compact = (s: string) => s.replace(/\s+/g, "");

/**
 * What to paste, given what's on the clipboard. Text that is Markdown wins
 * over HTML that is only that same text, styled (a terminal or code editor
 * puts that on the clipboard too).
 */
export function choosePaste(html: string, text: string): PasteChoice {
  const markdown = !!text && looksLikeMarkdown(text);
  if (html && isCorilloCopy(html)) return { kind: "editor" }; // copied from Corillo
  if (html) {
    const cleaned = cleanPastedHTML(html);
    if (markdown && (!cleaned.rich || compact(cleaned.text) === compact(text))) {
      return { kind: "html", html: markdownToHTML(text) };
    }
    if (!cleaned.text.trim() && !/<img/i.test(cleaned.html)) return text ? { kind: "text" } : { kind: "editor" };
    return { kind: "html", html: cleaned.html };
  }
  return markdown ? { kind: "html", html: markdownToHTML(text) } : { kind: "editor" };
}

/** HTML copied from Corillo carries footnote numbers and task boxes for other apps; Corillo draws its own. */
function withoutCopyExtras(html: string): string {
  return html.replace(/<span class="(?:footnote-number|task-box)"[^>]*>[^<]*<\/span>/g, "");
}

const htmlHasText = (html: string) =>
  !!html && !!(new DOMParser().parseFromString(html, "text/html").body.textContent ?? "").trim();

// Pictures ------------------------------------------------------------------

/** Pictures fetched from the web at the same time, at most. */
const AT_ONCE = 4;
/** Bigger than this (in pixels) isn't drawn again as PNG. */
const MAX_PIXELS = 50_000_000;

function bytesOfDataUrl(src: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([^;,]+)((?:;[^;,]*)*),(.*)$/s.exec(src);
  if (!m) return null;
  const named = m[1].toLowerCase();
  const mime = SAME_KIND[named] ?? named;
  if (!IMAGE_TYPES.has(mime)) return null;
  if (/;base64/i.test(m[2])) {
    const raw = atob(m[3].replace(/\s/g, ""));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return { bytes, mime };
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(m[3])), mime };
}

/** A picture of another kind (BMP, ICO), drawn again as PNG, if the window can read it. */
async function asPng(src: string): Promise<Uint8Array | null> {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > MAX_PIXELS) return null;
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d")?.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** A pasted picture, ready to save: a file on this Mac, or its bytes. */
type Obtained = { file: string } | { bytes: Uint8Array; mime: string } | null;

/** Get a pasted picture's bytes (from the web, or written into the paste), or where it is on this Mac. */
async function obtain(src: string): Promise<Obtained> {
  if (/^file:/i.test(src)) return { file: decodeURIComponent(new URL(src).pathname) };
  if (/^data:/i.test(src)) {
    const data = bytesOfDataUrl(src);
    if (data) return data;
    const png = /^data:image\//i.test(src) ? await asPng(src) : null;
    return png ? { bytes: png, mime: "image/png" } : null;
  }
  return window.corillo.fetchImage(src);
}

/** Copy an obtained picture into the pictures folder; its address there. */
function save(got: Obtained, store: PictureStore): Promise<string | null> {
  if (!got) return Promise.resolve(null);
  return "file" in got ? store.importFile(got.file) : store.saveData(got.bytes, got.mime);
}

/** Pictures copied in while an agent held the document, put in once it's back (null: taken out). */
const heldPictures = new WeakMap<EditorView, Map<string, string | null>>();

/** Point the pictures pasted from `src` at their copy (null: take them out), now, or once the document can be edited. */
function swap(view: EditorView, src: string, address: string | null): void {
  if (view.isDestroyed) return;
  if (!view.editable) {
    // Nothing changes under an agent's feet: put in once it's done.
    const later = heldPictures.get(view) ?? new Map<string, string | null>();
    later.set(src, address);
    heldPictures.set(view, later);
    return;
  }
  const tr = view.state.tr;
  view.state.doc.descendants((node, pos) => {
    if (node.type !== schema.nodes.image || node.attrs.src !== src) return;
    const at = tr.mapping.map(pos);
    if (address) tr.setNodeMarkup(at, null, { ...node.attrs, src: address });
    else tr.delete(at, at + node.nodeSize);
  });
  if (tr.docChanged) view.dispatch(tr.setMeta("addToHistory", false));
}

/** The document can be edited again: put in the pictures that arrived meanwhile. */
function swapWaiting(view: EditorView): void {
  const later = heldPictures.get(view);
  if (!later || !view.editable) return;
  heldPictures.delete(view);
  for (const [src, address] of later) swap(view, src, address);
}

const fromTheWeb = (src: string) => /^https?:/i.test(src);

/**
 * Copy the pictures of pasted content into the pictures folder, then point
 * at the copies. One that can't be copied takes its address from
 * `otherwise`, if it has one there; a picture written into the paste itself
 * (a data: address) is never left in the document as it came, which would
 * put megabytes of letters in the file: it's taken out, with a notice saying
 * why (it couldn't be read, or couldn't be saved).
 *
 * Pictures written into the paste, or on this Mac, are saved at once, never
 * waiting behind a web picture still on its way. Web pictures are fetched a
 * few at a time and saved in reading order ("Picture", "Picture 2" go down
 * the page); the next starts as one is saved, so a slow one never has the
 * rest piling up in memory behind it.
 */
async function importPictures(view: EditorView, srcs: string[], store: PictureStore, otherwise = new Map<string, string>()): Promise<void> {
  let unread = 0;
  let unsaved = 0;
  const put = async (src: string, got: Promise<Obtained>) => {
    const obtained = await got;
    let address: string | null = null;
    let failed = false;
    try {
      address = await save(obtained, store);
    } catch {
      failed = true; // the pictures folder: full, or not allowed
    }
    address ??= otherwise.get(src) ?? null;
    if (address) swap(view, src, address);
    else if (/^data:/i.test(src)) {
      swap(view, src, null);
      if (obtained && failed) unsaved++;
      else unread++;
    }
  };
  const here = async () => {
    for (const src of srcs) if (!fromTheWeb(src)) await put(src, obtain(src).catch(() => null));
  };
  const web = async () => {
    const list = srcs.filter(fromTheWeb);
    const started: (Promise<Obtained> | undefined)[] = [];
    const start = (i: number) => {
      if (i < list.length) started[i] = obtain(list[i]).catch(() => null);
    };
    for (let i = 0; i < AT_ONCE; i++) start(i);
    for (let i = 0; i < list.length; i++) {
      const got = started[i]!;
      started[i] = undefined; // let go of each once it's saved
      await put(list[i], got);
      start(i + AT_ONCE);
    }
  };
  await Promise.all([here(), web()]);
  notKept(view, "pasted", unsaved, unread);
}

function picturesToImport(slice: Slice): string[] {
  const srcs = new Set<string>();
  slice.content.descendants((node) => {
    if (node.type === schema.nodes.image && /^(file|data|https?):/i.test(node.attrs.src ?? "")) srcs.add(node.attrs.src);
  });
  return [...srcs];
}

// Pictures copied from another Corillo document -------------------------------

/**
 * A copy from Corillo keeps each picture's address as the document wrote it
 * (relative to that document's folder) and where it is on this Mac. Pasted
 * into a document in another folder, the address would point nowhere: such
 * pictures come in by where they are, to be copied into this document's
 * pictures folder, as Word brings a picture along. Returns the HTML, and the
 * pictures to copy in, each with its address as written (kept if the copy fails).
 */
function picturesFromElsewhere(html: string, store: PictureStore): { html: string; moved: Map<string, string> } {
  const moved = new Map<string, string>();
  if (!/<img/i.test(html)) return { html, moved };
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const img of parsed.querySelectorAll("img[src][data-src]")) {
    const src = img.getAttribute("src")!;
    const written = img.getAttribute("data-src")!;
    if (!/^file:/i.test(src) || /^[a-z][a-z0-9+.-]*:/i.test(written) || written.startsWith("/")) continue;
    if (fileOf(store.resolve(written)) === fileOf(src)) continue; // the same picture from here: nothing to do
    img.removeAttribute("data-src");
    moved.set(src, written);
  }
  return moved.size ? { html: parsed.body.innerHTML, moved } : { html, moved };
}

// Web pictures copied from where they wait ------------------------------------
//
// (roadmap Batch 19, item 1) A web picture an agent added waits for the
// person (roadmap Batch 18, item 1). Corillo's copy of it says so beside its
// address (a diagram's, which of its addresses wait: schema.ts), and pasted
// into a document it waits there too, from before it's drawn. Only copies
// marked as Corillo's are read for it (a page from elsewhere is cleaned, its
// marks dropped), a copy from before Corillo started again included (the
// review of Batch 19, R19-2), and the mark can only make a picture wait, never
// show one. Only addresses that are pictures in what's pasted are added, at
// most a document's list's worth in one paste (R19-5).

/**
 * The clipboard type a copy of the Markdown view's text that holds waiting
 * web pictures carries beside the text: their addresses only, as a JSON list
 * (doc-tab-markdown.ts). Other apps don't read it.
 */
export const WAITING_TYPE = "application/x-corillo-waiting";

/** The waiting addresses a copy of the Markdown view's text carries (none if it carries none, or anything else). */
function waitingOfText(data: DataTransfer): string[] {
  const json = data.getData(WAITING_TYPE);
  if (!json) return [];
  try {
    const listed: unknown = JSON.parse(json);
    return Array.isArray(listed) ? listed.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The web pictures in Markdown text, as a paste of it could draw them: its
 * pictures, and every address a diagram's code would hold, the code's fence
 * copied or not (the review of Batch 19, R19-3).
 */
export function picturesInText(text: string): Set<string> {
  const found = webPicturesOfText(text);
  for (const p of diagramPictures(text)) found.add(p.address);
  return found;
}

/**
 * Before a paste into a document (its page or its Markdown view) puts
 * anything in, draws or fetches it: the web pictures Corillo's copy says
 * waited where it came from wait in this document too. Read from the
 * Markdown view's copy (its own type) and from the page's copy (its marks).
 * A listed address that isn't a picture in what's pasted isn't added: it
 * can't be drawn from this paste. False when the paste says more pictures
 * wait than a document's list holds: then it mustn't go in at all, so that
 * nothing it holds loads and the document isn't marked "every web picture
 * waits" by one paste (the review of Batch 19, R19-5).
 */
export function waitAsOnClipboard(data: DataTransfer, store: PictureStore): boolean {
  if (!store.wait) return true;
  const html = data.getData("text/html");
  const listed = waitingOfText(data);
  const pasted = listed.length ? picturesInText(data.getData("text/plain")) : new Set<string>();
  const wait = new Set(listed.filter((a) => pasted.has(a)));
  if (html && hasCopyMark(html)) for (const a of waitingInCopy(html)) wait.add(a);
  if (wait.size > WAIT_CALL.addresses) return false;
  if (wait.size) store.wait([...wait]);
  return true;
}

/** Said where a paste was refused because it says too many pictures wait. */
export function tooManyWaiting(place: HTMLElement): void {
  noticeOn(place.closest<HTMLElement>(".doc") ?? document.body).show(
    "Corillo didn't paste this.",
    `It holds more than ${WAIT_CALL.addresses.toLocaleString("en")} pictures from the web that wait for you to show them. Copy a smaller part, and paste that.`,
  );
}

/** The web addresses a copy from Corillo marks as waiting where it was copied: a picture's own, and a diagram's that are in its code. */
function waitingInCopy(html: string): Set<string> {
  const found = new Set<string>();
  if (!html.includes("data-waiting")) return found;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const img of parsed.querySelectorAll("img[data-waiting][data-src]")) found.add(img.getAttribute("data-src")!);
  for (const pre of parsed.querySelectorAll("pre[data-waiting]")) {
    try {
      const listed: unknown = JSON.parse(pre.getAttribute("data-waiting")!);
      const inCode = new Set(diagramPictures(pre.textContent ?? "").map((p) => p.address));
      if (Array.isArray(listed)) for (const a of listed) if (typeof a === "string" && inCode.has(a)) found.add(a);
    } catch {
      // not a list: nothing more waits
    }
  }
  return found;
}

/** The pasted pictures (and diagrams' pictures) marked as waiting wait in this document too. */
function waitAsCopied(slice: Slice, marked: Set<string>, store: PictureStore): void {
  if (!store.wait) return;
  const wait = [...webPicturesOf(schema.topNodeType.create(null, slice.content))].filter((src) => marked.has(src));
  if (wait.length) store.wait(wait);
}

// The plugin ----------------------------------------------------------------

/** Set while Corillo pastes HTML it has already cleaned. */
let pastingClean = false;
/** Pictures in a copy from another Corillo document, between reading its HTML and pasting it. */
let fromElsewhere = new Map<string, string>();
/** Web pictures a copy from Corillo marks as waiting, between reading its HTML and pasting it. */
let copiedWaiting = new Set<string>();

export function pastePlugin(store: PictureStore): Plugin {
  return new Plugin({
    // Pictures that arrived while an agent held the document go in once it's back.
    view(view) {
      swapWaiting(view);
      return { update: (v) => swapWaiting(v) };
    },
    props: {
      handleDOMEvents: {
        paste(view, event) {
          const data = (event as ClipboardEvent).clipboardData;
          if (!data) return false;
          // First, so nothing pasted is drawn or fetched before.
          if (!waitAsOnClipboard(data, store)) {
            event.preventDefault();
            tooManyWaiting(view.dom);
            return true;
          }
          if (!view.editable || view.state.selection.$from.parent.type.spec.code) return false;
          const html = data.getData("text/html");
          const text = data.getData("text/plain");
          const pictures = [...data.files].filter((f) => IMAGE_TYPES.has(kindOf(f)));
          if (pictures.length && !htmlHasText(html)) return false; // a picture on its own: see images.ts
          const choice = choosePaste(html, text);
          if (choice.kind === "editor") return false;
          event.preventDefault();
          if (choice.kind === "text") {
            view.pasteText(text);
            return true;
          }
          pastingClean = true;
          try {
            view.pasteHTML(choice.html);
          } finally {
            pastingClean = false;
          }
          return true;
        },
      },
      transformPastedHTML(html) {
        fromElsewhere = new Map();
        copiedWaiting = new Set();
        if (pastingClean) return html;
        if (!isCorilloCopy(html)) return cleanPastedHTML(html).html;
        copiedWaiting = waitingInCopy(html);
        const copied = picturesFromElsewhere(withoutCopyExtras(html), store);
        fromElsewhere = copied.moved;
        return copied.html;
      },
      transformPasted(slice, view) {
        const moved = fromElsewhere;
        fromElsewhere = new Map();
        const marked = copiedWaiting;
        copiedWaiting = new Set();
        if (marked.size) waitAsCopied(slice, marked, store);
        const srcs = (pastingClean ? picturesToImport(slice) : picturesToImport(slice).filter((src) => moved.has(src))).filter((src) => !store.waits(src)); // one that waits isn't fetched
        if (srcs.length) setTimeout(() => void importPictures(view, srcs, store, moved), 0);
        return slice;
      },
    },
  });
}

// Paste and Match Style -------------------------------------------------------

const TEXT_INPUTS = new Set(["text", "search", "url", "email", ""]);

/** Paste the clipboard's text with no formatting, where the cursor is (`active`: the tab in front if it can be changed; `inFront`: in either view). */
export async function pastePlain(active: () => DocTab | null, inFront: () => DocTab | null = active): Promise<void> {
  const focused = document.activeElement;
  const text = await window.corillo.readClipboardText();
  if (!text) return;
  // The keyboard resting on a comment's card: its reply starts with the text.
  if (active()?.comments.replyWith(text)) return;
  // Into the Markdown view's text, or a diagram's code, the text is Markdown or code that can draw pictures:
  // this window's last copy says which of them wait (the review of Batch 19, R19-3).
  const waitAsLastCopy = (tab: DocTab | null): boolean => {
    const waiting = waitingOfCopy(text);
    if (!waiting.length || !tab?.store.wait) return true;
    if (waiting.length > WAIT_CALL.addresses) return false;
    tab.store.wait(waiting);
    return true;
  };
  if (focused instanceof HTMLTextAreaElement) {
    if (focused.classList.contains("source") && !waitAsLastCopy(inFront())) return tooManyWaiting(focused);
    asStepOfItsOwn(focused, () => document.execCommand("insertText", false, text)); // in the Markdown text, an Undo step of its own
    return;
  }
  if (focused instanceof HTMLInputElement) {
    if (TEXT_INPUTS.has(focused.type)) document.execCommand("insertText", false, text.replace(/\r?\n/g, " "));
    return;
  }
  const tab = active();
  if (!tab || tab.mode !== "formatted" || !tab.view.editable) return;
  if (tab.view.state.selection.$from.parent.type.spec.code && !waitAsLastCopy(tab)) return tooManyWaiting(tab.view.dom);
  tab.view.pasteText(text);
  tab.view.focus();
}

export function setupPastePlain(active: () => DocTab | null, inFront: () => DocTab | null = active): void {
  // Cmd+Shift+V, and Cmd+Option+Shift+V as many Mac apps have it, come as the menu's, by the character the key types (menus.ts).
  window.corillo.onMenu((action) => {
    if (action === "paste:plain") void pastePlain(active, inFront);
  });
}
