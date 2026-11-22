// Pictures. They live in a "<document name> images" folder next to the
// document, which Corillo creates when the first picture is added. Pictures
// can be inserted from the toolbar, pasted, or dragged in. A picture that
// can't be found shows a notice with a way to find it. Each picture takes the
// same share of the text's width as it will in Word (picture-size.ts).
import { NodeSelection, Plugin, PluginKey, type EditorState } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import type { Node } from "prosemirror-model";
import { schema } from "../core/schema";
import { fitPicture, LETTER_TEXT, ownSize, pictureDpi, type Size } from "../core/picture-size";
import { withResolution } from "../core/png";
import { diagramPictures, isDiagramBlock } from "../core/web-pictures";
import { noticeOn } from "./file-notice";
import { IMAGE_TYPES, SAME_KIND } from "../core/picture-kinds";

/** Where a document's pictures are kept: its "<name> images" folder. */
export interface PictureStore {
  /** Ask the person for a picture; returns its address, or null. */
  choose(): Promise<string | null>;
  importFile(filePath: string): Promise<string | null>;
  saveData(bytes: Uint8Array, mimeType: string): Promise<string | null>;
  pathForFile(file: File): string;
  /** The URL to display a picture at the given address ("" for one that waits: nothing to load). */
  resolve(src: string): string;
  /** A web picture an agent added, waiting for the person to show it (roadmap Batch 18, item 1). Required, so no place that draws a picture can leave the guard out (G21-10). */
  waits(src: string): boolean;
  /** The person showed a waiting picture: by their own click or key on its marker, nowhere else. */
  show?(src: string): void;
  /** Web pictures pasted from where they waited wait here too, at once (paste.ts; roadmap Batch 19, item 1). Adds only. */
  wait?(srcs: string[]): void;
}

/** A picture file's kind, by its usual name. */
export const kindOf = (file: File) => SAME_KIND[file.type] ?? file.type;

// Sizing pictures as Word will -------------------------------------------------

/** The app, in the main window (the export page has none: it reads pictures itself). */
const app = (): Window["corillo"] | undefined => (typeof window === "undefined" ? undefined : (window as Partial<Window>).corillo);

/** A picture's file address without the stamp added to load it afresh. */
export const fileOf = (url: string) => url.replace(/[?#].*$/, "");

/**
 * The dots per inch a picture on this Mac says it was made at (null for one
 * on the web, or one that doesn't say). The app reads only the start of the
 * file, where pictures say it, not the whole picture again.
 */
function densityOf(url: string): Promise<{ x: number; y: number } | null> {
  if (!/^file:/i.test(url)) return Promise.resolve(null);
  const corillo = app();
  if (corillo) return corillo.pictureDpi(fileOf(url)).catch(() => null);
  // The export page, which closes once it's done.
  return fetch(url)
    .then((r) => r.arrayBuffer())
    .then((bytes) => pictureDpi(new Uint8Array(bytes)))
    .catch(() => null);
}

/**
 * Show a picture at the share of the text's width it will have in Word: its
 * own size, never enlarged, made smaller to fit the page (picture-size.ts).
 * `box` takes the width (the picture fills it); `asked` is a size written on
 * the picture, in points. The size it gets, in points, is noted on the box.
 */
export function sizeAsInWord(img: HTMLImageElement, box: HTMLElement = img, asked: Partial<Size> = {}): void {
  const apply = async () => {
    if (!img.naturalWidth || !img.naturalHeight) return;
    let size = ownSize({ width: img.naturalWidth, height: img.naturalHeight }, await densityOf(img.src));
    if (asked.width && asked.height) size = { width: asked.width, height: asked.height };
    else if (asked.width) size = { width: asked.width, height: (size.height * asked.width) / size.width };
    else if (asked.height) size = { width: (size.width * asked.height) / size.height, height: asked.height };
    const fitted = fitPicture(size);
    box.style.width = `${((fitted.width / LETTER_TEXT.width) * 100).toFixed(2)}%`;
    if (asked.width && asked.height) img.style.aspectRatio = `${fitted.width} / ${fitted.height}`;
    box.dataset.points = `${fitted.width.toFixed(1)}x${fitted.height.toFixed(1)}`;
  };
  if (img.complete) void apply();
  else img.addEventListener("load", () => void apply(), { once: true });
}

/**
 * A picture pasted from the clipboard on a Retina screen is almost always a
 * screenshot with two pixels to each point; if it doesn't say so itself, it
 * is saved saying so, so it shows (here and in Word) at its size on screen.
 */
export function withScreenDensity(bytes: Uint8Array, mimeType: string, pixelRatio: number): Uint8Array {
  if (mimeType !== "image/png" || pixelRatio < 2 || pictureDpi(bytes)) return bytes;
  try {
    return withResolution(bytes, 72 * Math.round(pixelRatio));
  } catch {
    return bytes;
  }
}

// Pictures that follow the disk ---------------------------------------------------
//
// A picture can appear after the document names it (an agent writes the text
// first, or a cloud folder brings the file down later), or be written again
// under the same name (an agent redrawing a chart). Corillo looks again at the
// moments that can happen: when an agent's change (or another app's) arrives,
// when an agent's pass ends, and when the window comes back to the front. One
// question to the app for every picture showing, never a timer or a watch on
// each file. A picture that changed is loaded afresh, its address carrying
// when it changed so the window doesn't reuse what it loaded before.

interface Followed {
  /** The picture's file address, without a stamp; "" for one not on this Mac. */
  readonly file: string;
  /** When it last changed, as the app said last time: null if it wasn't there, undefined before the first look. */
  stamp: string | null | undefined;
  /** Shown as not found. */
  missing(): boolean;
  /** Load it again from the disk: it appeared, or changed. */
  reload(): void;
}

const followed = new Set<Followed>();
/** Told each time Corillo looks again, for what isn't followed here (Obsidian's embedded pictures not yet found). */
const lookers = new Set<() => void>();
let looking = false;
let lookAgain = false;
let firstLook: ReturnType<typeof setTimeout> | null = null;

/** The address to load a picture from: with its stamp, once known, so a changed picture isn't the one loaded before. */
function stamped(url: string, stamp: string | null | undefined): string {
  if (!stamp || !/^file:/i.test(url)) return url;
  return `${fileOf(url)}?v=${encodeURIComponent(stamp)}`;
}

async function look(): Promise<void> {
  const corillo = app();
  if (!corillo) return;
  if (looking) {
    lookAgain = true; // once this look is done
    return;
  }
  looking = true;
  try {
    do {
      lookAgain = false;
      const items = [...followed].filter((f) => f.file);
      const files = [...new Set(items.map((f) => f.file))];
      if (!files.length) break;
      const stamps = await corillo.pictureStamps(files).catch(() => null);
      if (!stamps) break;
      const now = new Map(files.map((file, i) => [file, stamps[i] ?? null]));
      for (const f of items) {
        if (!followed.has(f) || !now.has(f.file)) continue;
        const stamp = now.get(f.file)!;
        if (stamp === f.stamp) continue;
        const first = f.stamp === undefined;
        f.stamp = stamp;
        // The first look only notes the picture as loaded, unless it wasn't there to load.
        if (!first || (stamp !== null && f.missing())) f.reload();
      }
    } while (lookAgain);
  } finally {
    looking = false;
  }
}

/**
 * Look at every picture showing again, and show afresh any that appeared or
 * changed on disk. Called when an agent's change or pass end arrives, and when
 * the window comes back to the front.
 */
export function lookAtPicturesAgain(): void {
  for (const tell of lookers) tell();
  void look();
}

/** Note when a picture just shown last changed, soon (one question for all the pictures shown together). */
function lookSoon(): void {
  firstLook ??= setTimeout(() => {
    firstLook = null;
    void look();
  }, 0);
}

/** Hear each time Corillo looks at pictures again; returns how to stop. */
export function onLookAgain(tell: () => void): () => void {
  lookers.add(tell);
  return () => lookers.delete(tell);
}

const followedImages = new WeakMap<HTMLElement, Followed>();

/**
 * Follow a picture drawn outside a picture node (an embedded one): it's loaded
 * afresh when it changes on disk. `size` sizes it again once it has loaded.
 * Call unfollowPicture when it's taken off the page.
 */
export function followPicture(img: HTMLImageElement, url: string, size: () => void): void {
  const item: Followed = {
    file: /^file:/i.test(url) ? fileOf(url) : "",
    stamp: undefined,
    missing: () => false,
    reload: () => {
      img.src = stamped(url, item.stamp);
      size();
    },
  };
  followed.add(item);
  followedImages.set(img, item);
  if (item.file) lookSoon();
}

export function unfollowPicture(img: HTMLElement): void {
  const item = followedImages.get(img);
  if (item) followed.delete(item);
  followedImages.delete(img);
}

// The window coming back to the front: a picture may have been added or redrawn meanwhile.
if (app()) window.addEventListener("focus", () => lookAtPicturesAgain());

// Web pictures an agent added wait ------------------------------------------------
//
// (roadmap Batch 18, item 1) A picture with a web address that arrived in an
// agent's change (or a document an agent made) shows as a marker with its
// address, never asking the web, until the person shows it with a click on
// the marker, or Return with the marker selected. Then it loads, for that
// document. The app keeps which addresses wait (main.ts); the window draws
// them so everywhere it draws a document's pictures: the page, the Markdown
// view's preview, History and Show changes.

/** An address as it reads, a narrow window breaking it after a slash rather than mid-word. */
function addressIn(label: HTMLElement, words: string, src: string): void {
  let address = src;
  try {
    address = decodeURI(src);
  } catch {
    // keep it as written
  }
  `${words}${address}`.split("/").forEach((part, i) => {
    if (i) label.append("/", document.createElement("wbr"));
    label.append(part);
  });
}

/**
 * A waiting picture's marker: its address, and (where the person can show it)
 * a Show picture button, which shows it only for the person's own click or
 * key, never for a click made by code.
 */
export function waitingMarker(src: string, show?: (src: string) => void): HTMLElement {
  const box = document.createElement("span");
  box.className = "picture waiting";
  const label = document.createElement("span");
  label.className = "picture-waiting-text";
  addressIn(label, "Picture from the web, not shown: ", src);
  box.append(label);
  if (show) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Show picture";
    button.setAttribute("aria-label", `Show picture from ${src}`);
    button.addEventListener("click", (e) => {
      e.preventDefault();
      if (e.isTrusted) show(src);
    });
    box.append(button);
  }
  return box;
}

/**
 * From the keyboard: with a waiting picture's marker selected (the arrow keys
 * select it, as any picture), Return shows it, the same as a click. A
 * diagram whose pictures from the web wait is the same (the review of Batch
 * 18, R18-2): the arrow keys stop on it from the line before or after, and
 * Return shows its pictures. First among the page's keys, so Return doesn't
 * put a new line in its place.
 */
export function waitingPictureKeys(store: PictureStore): Plugin {
  /** The web addresses that wait in a picture or a diagram. */
  const waitingIn = (node: Node | null | undefined): string[] => {
    if (!node) return [];
    const srcs = node.type === schema.nodes.image ? [node.attrs.src as string] : isDiagramBlock(node) ? diagramPictures(node.textContent).map((p) => p.address) : [];
    return [...new Set(srcs.filter((src) => store.waits(src)))];
  };
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || !event.isTrusted || !store.show) return false;
        const { selection } = view.state;
        if (event.key === "Enter") {
          if (!(selection instanceof NodeSelection)) return false;
          const waiting = waitingIn(selection.node);
          if (!waiting.length) return false;
          for (const src of waiting) store.show(src);
          return true;
        }
        // Onto a waiting diagram from the end of the line before it, or the start of the line after it.
        const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
        if (!forward && event.key !== "ArrowUp" && event.key !== "ArrowLeft") return false;
        const { $head, empty } = selection;
        if (!empty || !$head.parent.isTextblock || isDiagramBlock($head.parent)) return false;
        const at = forward ? $head.after() : $head.before();
        const next = forward ? view.state.doc.resolve(at).nodeAfter : view.state.doc.resolve(at).nodeBefore;
        if (!next || !isDiagramBlock(next) || !waitingIn(next).length) return false;
        const atEdge =
          event.key === "ArrowRight" ? $head.parentOffset === $head.parent.content.size : event.key === "ArrowLeft" ? $head.parentOffset === 0 : view.endOfTextblock(forward ? "down" : "up");
        if (!atEdge) return false;
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, forward ? at : at - next.nodeSize)).scrollIntoView());
        return true;
      },
    },
  });
}

/** Which web pictures wait changed: each picture drawn shows as a picture or a marker afresh, where that changed. */
export function picturesWaitingChanged(): void {
  for (const f of followed) if (f instanceof ImageView) f.recheck();
}

function altFromSrc(src: string): string {
  const name = decodeURIComponent(src.split("/").pop() ?? "");
  return name.replace(/\.[a-z0-9]+$/i, "");
}

export class ImageView implements NodeView, Followed {
  dom: HTMLElement;
  file = "";
  stamp: string | null | undefined = undefined;
  private node: Node;
  /** Drawn as a marker, waiting for the person to show it. */
  private waiting = false;

  constructor(
    node: Node,
    private view: EditorView,
    private getPos: () => number | undefined,
    private store: PictureStore,
  ) {
    this.node = node;
    this.dom = document.createElement("span");
    this.dom.className = "picture";
    this.render();
    followed.add(this);
    if (this.file) lookSoon();
  }

  private render(): void {
    const { src, alt, title } = this.node.attrs;
    this.dom.replaceChildren();
    this.dom.classList.remove("missing", "waiting");
    this.waiting = this.store.waits(src);
    if (this.waiting) {
      this.file = "";
      this.dom.style.width = "";
      const marker = waitingMarker(src, this.store.show && ((s) => this.store.show!(s)));
      this.dom.classList.add("waiting");
      this.dom.replaceChildren(...marker.childNodes);
      return;
    }
    const img = document.createElement("img");
    const url = this.store.resolve(src);
    this.file = /^file:/i.test(url) ? fileOf(url) : "";
    img.src = stamped(url, this.stamp);
    img.dataset.src = src;
    if (alt) img.alt = alt;
    if (title) img.title = title;
    img.draggable = false;
    img.addEventListener("error", () => this.showMissing(), { once: true });
    this.dom.style.width = "";
    this.dom.append(img);
    sizeAsInWord(img, this.dom);
  }

  private showMissing(): void {
    const src: string = this.node.attrs.src;
    let name = src;
    try {
      name = decodeURI(src);
    } catch {
      // keep it as written
    }
    this.dom.classList.add("missing");
    this.dom.style.width = "";
    const label = document.createElement("span");
    label.className = "picture-missing-text";
    // A narrow window may break the name after a slash (a line may also break between words), not mid-word (last look of Batch 12, L-12).
    const parts = `Picture not found: ${name}`.split("/");
    parts.forEach((part, i) => {
      if (i) label.append("/", document.createElement("wbr"));
      label.append(part);
    });
    const find = document.createElement("button");
    find.type = "button";
    find.textContent = "Find it…";
    find.addEventListener("click", async (e) => {
      e.preventDefault();
      const newSrc = await this.store.choose().catch(() => notKept(this.view, "inserted", 1));
      const pos = this.getPos();
      if (!newSrc || pos === undefined) return;
      this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, null, { ...this.node.attrs, src: newSrc }));
    });
    this.dom.replaceChildren(label, find);
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    const changed = node.attrs.src !== this.node.attrs.src;
    this.node = node;
    if (changed) {
      this.stamp = undefined;
      this.render();
      if (this.file) lookSoon();
    }
    return true;
  }

  missing(): boolean {
    return this.dom.classList.contains("missing");
  }

  /** Drawn again if it now waits, or no longer does. */
  recheck(): void {
    if (this.waiting === this.store.waits(this.node.attrs.src)) return;
    this.stamp = undefined;
    this.render();
    if (this.file) lookSoon();
  }

  reload(): void {
    this.render();
  }

  destroy(): void {
    followed.delete(this);
  }

  stopEvent(e: Event): boolean {
    return (e.target as HTMLElement).tagName === "BUTTON";
  }

  ignoreMutation(): boolean {
    return true;
  }

  selectNode(): void {
    this.dom.classList.add("selected");
  }

  deselectNode(): void {
    this.dom.classList.remove("selected");
  }
}

/** Pictures copied in while an agent held the document, put in once it's back (nothing changes under an agent's feet). */
const heldPictures = new WeakMap<EditorView, (() => void)[]>();

/** Put pictures in now, or once the document can be edited again. */
function whenEditable(view: EditorView, put: () => void): void {
  if (view.isDestroyed) return;
  if (view.editable) return put();
  const later = heldPictures.get(view) ?? [];
  later.push(put);
  heldPictures.set(view, later);
}

function putWaiting(view: EditorView): void {
  const later = heldPictures.get(view);
  if (!later || !view.editable) return;
  heldPictures.delete(view);
  for (const put of later) put();
}

function insertPictures(view: EditorView, srcs: string[], at?: number, dropped?: number): void {
  const nodes = srcs.map((src) => schema.nodes.image.create({ src, alt: altFromSrc(src) }));
  let tr = view.state.tr;
  if (dropped !== undefined) tr = tr.setMeta(drops, { done: dropped });
  if (!nodes.length) {
    if (dropped !== undefined) view.dispatch(tr);
    return;
  }
  if (at === undefined) {
    for (const node of nodes) tr = tr.replaceSelectionWith(node);
  } else {
    for (const node of nodes.reverse()) tr = tr.insert(at, node);
  }
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** Copy each picture into the document's images folder; returns their addresses, and how many couldn't be saved there. */
async function importFiles(files: File[], store: PictureStore): Promise<{ srcs: string[]; unsaved: number }> {
  const srcs: string[] = [];
  let unsaved = 0;
  for (const file of files) {
    try {
      const path = store.pathForFile(file);
      const src = path
        ? await store.importFile(path)
        : await store.saveData(withScreenDensity(new Uint8Array(await file.arrayBuffer()), kindOf(file), window.devicePixelRatio), kindOf(file));
      if (src) srcs.push(src);
    } catch {
      unsaved++; // the pictures folder: full, or not allowed
    }
  }
  return { srcs, unsaved };
}

/**
 * Pictures left out because they couldn't be saved in the document's
 * pictures folder (`unsaved`), or read (`unread`, a paste's): the corner of
 * the document's tab says so, and why (paste.ts; the review of Batch 21,
 * G21-19). Returns null, for a picture that wasn't put in.
 */
export function notKept(view: EditorView, how: "pasted" | "dropped" | "inserted", unsaved: number, unread = 0): null {
  const dropped = unsaved + unread;
  if (!dropped || view.isDestroyed) return null;
  const why = [
    unsaved
      ? `Corillo couldn't save ${unsaved === 1 ? "it in the document's pictures folder, so it was" : "them in the document's pictures folder, so they were"} left out. Check that the disk isn't full and the folder can be changed, then ${how === "pasted" ? "paste" : "try"} again.`
      : "",
    unread ? "Corillo can't read that kind of picture, so it was left out. Save it as PNG or JPEG and insert it instead." : "",
  ];
  // On the tab of the document, which may not be in front by now.
  noticeOn(view.dom.closest<HTMLElement>(".doc") ?? document.body).show(
    dropped === 1 ? `${how === "inserted" ? "The" : `A ${how}`} picture couldn't be kept.` : `${dropped} ${how} pictures couldn't be kept.`,
    why.filter(Boolean).join(" "),
  );
  return null;
}

const imageFiles = (list: FileList | undefined | null) => [...(list ?? [])].filter((f) => IMAGE_TYPES.has(kindOf(f)));

export function canInsertPicture(state: EditorState): boolean {
  const { $from } = state.selection;
  return $from.parent.inlineContent && !$from.parent.type.spec.code;
}

export async function insertPictureFromDialog(view: EditorView, store: PictureStore): Promise<void> {
  const src = await store.choose().catch(() => notKept(view, "inserted", 1));
  if (src) whenEditable(view, () => insertPictures(view, [src]));
}

// Where pictures dropped on the page go, by drop, while they're copied: kept
// in step with edits made meanwhile, so each lands where it was dropped.
type Drops = Map<number, number>;
const drops = new PluginKey<Drops>("picture-drops");
let dropCount = 0;

export function picturePlugin(store: PictureStore): Plugin<Drops> {
  return new Plugin<Drops>({
    key: drops,
    state: {
      init: () => new Map(),
      apply(tr, places) {
        const meta = tr.getMeta(drops) as { add?: [number, number]; done?: number } | undefined;
        if (!meta && (!tr.docChanged || !places.size)) return places;
        const next: Drops = new Map();
        for (const [id, pos] of places) if (id !== meta?.done) next.set(id, tr.mapping.map(pos));
        if (meta?.add) next.set(...meta.add);
        return next;
      },
    },
    // A new state is set when the text is shown afresh (an agent's change, or
    // another app's, arriving): look at the pictures again then, and when the
    // document comes back from an agent (it can be edited again).
    view(view) {
      lookAtPicturesAgain();
      putWaiting(view);
      let editable = view.editable;
      return {
        update(v) {
          if (v.editable && !editable) lookAtPicturesAgain();
          editable = v.editable;
          putWaiting(v);
        },
      };
    },
    props: {
      handlePaste(view, event) {
        const files = imageFiles(event.clipboardData?.files);
        if (!files.length || !canInsertPicture(view.state)) return false;
        event.preventDefault();
        void importFiles(files, store).then(({ srcs, unsaved }) => {
          notKept(view, "pasted", unsaved);
          whenEditable(view, () => insertPictures(view, srcs));
        });
        return true;
      },
      handleDrop(view, event, _slice, moved) {
        if (moved) return false;
        const files = imageFiles((event as DragEvent).dataTransfer?.files);
        if (!files.length) return false;
        event.preventDefault();
        const drop = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY });
        const id = ++dropCount;
        if (drop) view.dispatch(view.state.tr.setMeta(drops, { add: [id, drop.pos] }));
        void importFiles(files, store).then(({ srcs, unsaved }) => {
          notKept(view, "dropped", unsaved);
          whenEditable(view, () => {
            const pos = drops.getState(view.state)?.get(id);
            const $pos = pos === undefined ? null : view.state.doc.resolve(pos);
            const at = $pos && $pos.parent.inlineContent && !$pos.parent.type.spec.code ? pos : undefined;
            insertPictures(view, srcs, at, id);
          });
        });
        return true;
      },
    },
  });
}

// Renaming or moving a document ------------------------------------------------

const withSlash = (url: string) => (url.endsWith("/") ? url : url + "/");

/** A relative address from one folder (a file URL) to a file (a file URL). */
function relativeAddress(fromDirUrl: string, toUrl: string): string {
  const from = new URL(withSlash(fromDirUrl)).pathname.split("/").filter(Boolean);
  const to = new URL(toUrl).pathname.split("/").filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return [...Array<string>(from.length - common).fill(".."), ...to.slice(common)].join("/");
}

/**
 * Where a picture's address should point after its document moved from one
 * folder to another, and its pictures folder perhaps with it. Null if the
 * address doesn't need to change (or isn't a local, relative one).
 */
export function movedAddress(
  src: string,
  oldDirUrl: string,
  newDirUrl: string,
  movedImages: { from: string; to: string } | null,
): string | null {
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("/") || src.startsWith("#")) return null;
  let target: string;
  try {
    target = new URL(src, withSlash(oldDirUrl)).href;
  } catch {
    return null;
  }
  if (movedImages && target.startsWith(withSlash(movedImages.from))) {
    target = withSlash(movedImages.to) + target.slice(withSlash(movedImages.from).length);
  }
  const address = relativeAddress(newDirUrl, target);
  return address === src ? null : address;
}
