// The page Corillo uses for export, in a hidden window of its own. It shows a
// document the way the editor does (nothing to edit, always the light look)
// so it can be printed to PDF, and it draws diagrams as pictures for Word.
import { EditorState, Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { parseMarkdown } from "../core/markdown";
import { setImageResolver } from "../core/schema";
import { withResolution } from "../core/png";
import { fitPicture, type Size } from "../core/picture-size";
import { footnotePlugin } from "./footnotes";
import { obsidianPlugin } from "./obsidian";
import { blankLinesPlugin } from "./blank-lines";
import { ImageView, type PictureStore } from "./images";
import { DiagramView, drawAllDiagrams, isDiagram, loadEngine } from "./diagrams";

interface ExportPageBridge {
  onRequest(handler: (kind: string, payload: unknown) => Promise<unknown>): void;
}

export interface DrawnDiagram {
  png?: Uint8Array;
  /** The diagram's size on screen, in CSS pixels. */
  width?: number;
  height?: number;
  error?: string;
}

/**
 * Settings for the diagram engine, read when it loads (each export has a page
 * of its own, so it loads once per export): always the light look, as on
 * paper; for pictures, plain text labels, because a browser won't make a
 * picture of a drawing with HTML in it.
 */
function diagramOptions(forPictures: boolean): void {
  (window as unknown as { corilloDiagramOptions: object }).corilloDiagramOptions = forPictures
    ? { theme: "neutral", htmlLabels: false, flowchart: { htmlLabels: false } }
    : { theme: "neutral" };
}

const bridge = (window as unknown as { corilloExportPage: ExportPageBridge }).corilloExportPage;
const pageEl = document.getElementById("page") as HTMLElement;

// Print resolution: three times the screen's 96 dots per inch.
const SCALE = 3;
const MAX_SIDE = 12000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function svgSize(svg: Element): { width: number; height: number } {
  const box = (svg.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  if (box.length === 4 && box[2] > 0 && box[3] > 0) return { width: box[2], height: box[3] };
  const width = parseFloat(svg.getAttribute("width") ?? "");
  const height = parseFloat(svg.getAttribute("height") ?? "");
  if (width > 0 && height > 0) return { width, height };
  throw new Error("The diagram has no size.");
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * A few kinds of diagram use HTML labels even when asked not to. Swap each
 * for plain text in the middle of its box, so the diagram can still become a
 * picture (the text may sit a little differently).
 */
function flattenHtmlLabels(svg: Element): void {
  for (const fo of [...svg.getElementsByTagNameNS(SVG_NS, "foreignObject")]) {
    const num = (name: string) => parseFloat(fo.getAttribute(name) ?? "0") || 0;
    const text = svg.ownerDocument.createElementNS(SVG_NS, "text");
    text.setAttribute("x", String(num("x") + num("width") / 2));
    text.setAttribute("y", String(num("y") + num("height") / 2));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    text.setAttribute("font-size", "14");
    text.setAttribute("fill", "#333333");
    text.textContent = (fo.textContent ?? "").replace(/\s+/g, " ").trim();
    fo.replaceWith(text);
  }
}

/** Draw one diagram and turn it into a PNG at print resolution, on white. */
async function drawDiagram(code: string): Promise<DrawnDiagram> {
  const engine = await loadEngine();
  const svg = new DOMParser().parseFromString(await engine.render(code), "image/svg+xml").documentElement;
  const { width, height } = svgSize(svg);
  flattenHtmlLabels(svg);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  (svg as unknown as SVGElement).style?.removeProperty("max-width");
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(SCALE, MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("There wasn't enough memory to draw the diagram.");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The diagram couldn't be turned into a picture.");
    const png = withResolution(new Uint8Array(await blob.arrayBuffer()), 96 * scale);
    return { png, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function drawDiagrams(codes: string[]): Promise<DrawnDiagram[]> {
  const drawn: DrawnDiagram[] = [];
  for (const code of codes) {
    try {
      drawn.push(await drawDiagram(code));
    } catch (err) {
      drawn.push({ error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
    }
  }
  return drawn;
}

/**
 * Draw a picture as a PNG for Word: an SVG drawing at three times the size
 * Word will show it (its own size, made smaller to fit the page's text area
 * as in picture-size.ts), so it stays sharp without being needlessly big; a
 * WebP, AVIF or BMP picture (not every Word app shows those) pixel for pixel.
 * Stamped so it's as big in Word as on the page. As a picture (not part of
 * the page) it can't run anything or fetch anything.
 */
async function drawPicture(mime: string, bytes: Uint8Array, area: Size): Promise<Uint8Array> {
  const drawing = mime === "image/svg+xml";
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let width = img.naturalWidth;
    let height = img.naturalHeight;
    if (!(width > 0 && height > 0) && drawing) {
      const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), "image/svg+xml").documentElement;
      ({ width, height } = svgSize(doc));
    }
    if (!(width > 0 && height > 0)) throw new Error("The picture has no size.");
    const shown = fitPicture({ width, height }, area);
    const scale = Math.min(drawing ? (SCALE * shown.width) / width : 1, MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("There wasn't enough memory to draw the picture.");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The picture couldn't be drawn.");
    // A point to each of its own pixels, as the page shows it (picture-size.ts).
    return withResolution(new Uint8Array(await blob.arrayBuffer()), 72 * (canvas.width / width));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function drawPictures({ area, pictures }: { area: Size; pictures: { mime: string; bytes: Uint8Array }[] }): Promise<{ png?: Uint8Array }[]> {
  const drawn: { png?: Uint8Array }[] = [];
  for (const { mime, bytes } of pictures) {
    try {
      drawn.push({ png: await drawPicture(mime, bytes, area) });
    } catch {
      drawn.push({});
    }
  }
  return drawn;
}

const withSlash = (url: string) => (url.endsWith("/") ? url : url + "/");

// A block of HTML, on paper: its words and simple formatting, as Word shows
// it, never its tags. Only plain text elements are copied over, without their
// attributes; anything that could run or fetch (scripts, frames, forms) is
// left out, and elements not on the list give just their contents.
const KEPT = new Set(
  "p br b strong i em u s del ins sup sub mark code kbd pre blockquote ul ol li table thead tbody tfoot tr th td h1 h2 h3 h4 h5 h6 hr div span center small big".split(" "),
);
const DROPPED = new Set("script style iframe object embed template noscript form input button select textarea link meta head title svg math img video audio canvas".split(" "));

function plainHtml(from: Node, into: Node): void {
  for (const child of from.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) into.appendChild(document.createTextNode(child.textContent ?? ""));
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const name = (child as Element).localName;
    if (DROPPED.has(name)) continue;
    const copy = KEPT.has(name) ? document.createElement(name) : document.createDocumentFragment();
    plainHtml(child, copy);
    into.appendChild(copy);
  }
}

class HtmlBlockView {
  dom: HTMLElement;
  constructor(text: string) {
    this.dom = document.createElement("div");
    this.dom.className = "html-block";
    plainHtml(new DOMParser().parseFromString(text, "text/html").body, this.dom);
  }
  ignoreMutation() {
    return true;
  }
}

/** Wait until every picture has loaded (or failed) and every diagram is drawn. */
async function settled(timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const busy = pageEl.querySelector(".diagram.drawing") || [...pageEl.querySelectorAll("img")].some((i) => !i.complete);
    if (!busy) break;
    if (Date.now() > until) throw new Error("The document took too long to lay out.");
    await wait(50);
  }
  await document.fonts.ready;
  await wait(100);
}

let view: EditorView | null = null;

// Tables on paper ------------------------------------------------------------------

/** The cells whose long words may break anywhere, as decorations (the page's own DOM is ProseMirror's to draw). */
const breakable = new PluginKey<DecorationSet>("break-anywhere");

function breakablePlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: breakable,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, set) => tr.getMeta(breakable) ?? set.map(tr.mapping, tr.doc),
    },
    props: { decorations: (state) => breakable.getState(state) },
  });
}

/**
 * Keep each table within the paper's text (`width` CSS pixels across) while
 * breaking as few words as it can. A table's words stay whole wherever they
 * fit; only in a table too wide for the paper does a column get to break its
 * long words (an address, say), the column with the longest first, then the
 * next, until the table fits. So a column of names beside a column of prose
 * keeps "Engineering" on one line.
 */
function fitTables(v: EditorView, width: number): void {
  if (!(width > 0)) return;
  const tables: { pos: number; node: import("prosemirror-model").Node }[] = [];
  v.state.doc.descendants((node, pos) => {
    if (node.type.name !== "table") return true;
    tables.push({ pos, node });
    return false;
  });
  if (!tables.length) return;
  pageEl.style.width = `${width}px`;
  try {
    const decorations: Decoration[] = [];
    const right = () => pageEl.getBoundingClientRect().right + 0.5;
    // Asked afresh each time: drawing the decorations can draw the table anew.
    const tableAt = (pos: number) => {
      const dom = v.nodeDOM(pos);
      const table = dom instanceof HTMLTableElement ? dom : (dom as HTMLElement | null)?.querySelector("table");
      return table?.rows.length ? table : null;
    };
    for (const { pos, node } of tables) {
      if (!tableAt(pos)) continue;
      // Each cell's place in the document, by column.
      const columns: { from: number; to: number }[][] = [];
      node.forEach((row, rowOffset) => {
        let at = pos + 1 + rowOffset + 1;
        row.forEach((cell, _o, c) => {
          (columns[c] ??= []).push({ from: at, to: at + cell.nodeSize });
          at += cell.nodeSize;
        });
      });
      const broken = new Set<number>();
      for (let table = tableAt(pos); table && table.getBoundingClientRect().right > right() && broken.size < columns.length; table = tableAt(pos)) {
        // A table too wide for the paper has each column at its narrowest, its longest word: let the widest break.
        const cells = [...table.rows[0].cells];
        let widest = -1;
        cells.forEach((cell, c) => {
          if (!broken.has(c) && columns[c] && (widest < 0 || cell.getBoundingClientRect().width > cells[widest].getBoundingClientRect().width)) widest = c;
        });
        if (widest < 0) break;
        broken.add(widest);
        for (const cell of columns[widest]) decorations.push(Decoration.node(cell.from, cell.to, { class: "break-anywhere" }));
        // (A copy: DecorationSet.create takes apart the list it's given.)
        v.dispatch(v.state.tr.setMeta(breakable, DecorationSet.create(v.state.doc, [...decorations])));
      }
    }
  } finally {
    pageEl.style.width = "";
  }
}

interface DocumentRequest {
  text: string;
  dirUrl: string;
  title: string;
  /** How wide the paper's text is, in CSS pixels: tables are kept within it. */
  textWidth?: number;
  /**
   * The pictures Corillo checked (export-pictures.ts), by where each points,
   * and the file to show it from. The page shows no other picture, so
   * nothing is fetched from the web or read from the Mac while it prints.
   */
  pictures: Record<string, string>;
}

async function showDocument(payload: DocumentRequest): Promise<{ brokenDiagrams: number }> {
  document.title = payload.title;
  const resolve = (src: string) => {
    if (!src) return "";
    try {
      return payload.pictures[new URL(src, withSlash(payload.dirUrl)).href] ?? "";
    } catch {
      return "";
    }
  };
  setImageResolver(resolve);
  const store: PictureStore = {
    choose: async () => null,
    importFile: async () => null,
    saveData: async () => null,
    pathForFile: () => "",
    resolve,
    // None waits here: this page shows only the pictures main prepared for it, a waiting one left out
    // (export-pictures.ts), and its session loads nothing from the web (export.ts).
    waits: () => false,
  };
  const { doc, source } = parseMarkdown(payload.text);
  const state = EditorState.create({
    doc,
    plugins: [footnotePlugin(), blankLinesPlugin(() => source, false), obsidianPlugin({ reading: true }), breakablePlugin()],
  });
  view?.destroy();
  view = new EditorView(pageEl, {
    state,
    editable: () => false,
    nodeViews: {
      image: (node, v, getPos) => new ImageView(node, v, getPos, store),
      code_block: (node, v, getPos) => (isDiagram(node) ? new DiagramView(node, v, getPos, store) : (null as never)),
      raw_block: (node) => (node.attrs.kind === "html" ? new HtmlBlockView(node.textContent) : (null as never)),
    },
  });
  // The editor draws diagrams only as they come near the screen; a printout needs them all.
  await drawAllDiagrams();
  await settled();
  fitTables(view, payload.textWidth ?? 0);
  const diagrams = [...pageEl.querySelectorAll(".diagram")];
  const missing = diagrams.filter((d) => !d.classList.contains("has-error") && !d.querySelector(".diagram-picture svg"));
  return { brokenDiagrams: pageEl.querySelectorAll(".diagram.has-error").length + missing.length };
}

bridge.onRequest(async (kind, payload) => {
  if (kind === "pictures") return drawPictures(payload as { area: Size; pictures: { mime: string; bytes: Uint8Array }[] });
  diagramOptions(kind === "diagrams");
  if (kind === "diagrams") return drawDiagrams(payload as string[]);
  if (kind === "document") return showDocument(payload as DocumentRequest);
  throw new Error(`Unknown request: ${kind}`);
});
