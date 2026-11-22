// Diagrams: a ```mermaid code block, written by an agent as text, shown as a
// drawing. The code is hidden unless the cursor is in it or the person asks
// to see it, or the diagram has a mistake.
//
// Drawing a diagram takes a while, so a long document doesn't draw them all
// at once: each is drawn when it comes near the screen, one at a time, with
// a pause between them for typing. A drawing is kept and reused (by the
// Markdown view's preview, say) for as long as its code stays the same, and
// drawn again when the Mac switches between light and dark.
import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView, type NodeView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { fitPicture, LETTER_TEXT } from "../core/picture-size";
import { isDiagramBlock, withoutWaiting } from "../core/web-pictures";
import { waitingMarker, type PictureStore } from "./images";

interface Engine {
  render(code: string): Promise<string>;
}

let engine: Promise<Engine> | null = null;

/** The diagram engine's hash, filled in by the build. */
declare const __DIAGRAMS_INTEGRITY__: string | undefined;

/** The engine failed to load: nothing is wrong with the diagram, and it's tried again later. */
class EngineNotLoaded extends Error {}

export function loadEngine(): Promise<Engine> {
  engine ??= new Promise<Engine>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "diagrams.js";
    // The page's rule lets in only scripts whose contents match their hash (see scripts/build.mjs).
    script.integrity = typeof __DIAGRAMS_INTEGRITY__ === "string" ? __DIAGRAMS_INTEGRITY__ : "";
    script.onload = () => resolve((window as unknown as { corilloDiagrams: Engine }).corilloDiagrams);
    script.onerror = () => {
      // Forgotten, so the next diagram drawn loads it again.
      script.remove();
      engine = null;
      reject(new EngineNotLoaded("The diagram engine didn't load."));
    };
    document.head.append(script);
  });
  return engine;
}

// Drawings by their code, the most recently used last.
const drawings = new Map<string, Promise<string>>();
const KEEP_DRAWINGS = 60;
let queue: Promise<unknown> = Promise.resolve();
const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The drawing for this code: made once, after the drawings asked for before it. */
function drawing(code: string): Promise<string> {
  let made = drawings.get(code);
  if (made) drawings.delete(code);
  else {
    const making = queue.then(nextTurn).then(loadEngine).then((e) => e.render(code));
    queue = making.catch((err: unknown) => {
      if (err instanceof EngineNotLoaded && drawings.get(code) === making) drawings.delete(code);
    });
    made = making;
  }
  drawings.set(code, made);
  if (drawings.size > KEEP_DRAWINGS) drawings.delete(drawings.keys().next().value as string);
  return made;
}

let copies = 0;
/**
 * A drawing's names (for its arrowheads and styles) must be unique on the
 * page, so each place that shows it gets its own copy.
 */
/**
 * Show a drawn diagram at the share of the text's width it will have in
 * Word, where it is a picture of its size on screen (a point for each 4/3 of
 * a pixel), made smaller to fit the page as any picture is (picture-size.ts).
 */
function sizeAsInWord(svg: SVGSVGElement | null): void {
  const box = (svg?.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  if (!svg || box.length !== 4 || !(box[2] > 0 && box[3] > 0)) return;
  const fitted = fitPicture({ width: box[2] * 0.75, height: box[3] * 0.75 });
  svg.style.maxWidth = "100%";
  svg.style.width = `${((fitted.width / LETTER_TEXT.width) * 100).toFixed(2)}%`;
  svg.style.height = "auto";
}

function freshCopy(svg: string): string {
  const copy = ++copies;
  return svg.replace(/corillo-diagram-\d+/g, (id) => `${id}-${copy}`);
}

// Diagrams start drawing when they come within this distance of the screen.
const NEAR = "1500px 0px";
const nearScreen = new WeakMap<Element, () => void>();
const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) if (e.isIntersecting) nearScreen.get(e.target)?.();
  },
  // scrollMargin: also near the visible part of the scrolling page, not just the window.
  { rootMargin: NEAR, scrollMargin: NEAR },
);

const live = new Set<DiagramView>();

// The Mac switched between light and dark: drawings are in the old colours,
// so each diagram is drawn again, when it's near the screen.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  drawings.clear();
  for (const v of live) v.drawAgain();
});
// Diagrams not drawn because the engine didn't load are tried again when the
// window comes back to the front.
window.addEventListener("focus", () => {
  for (const v of live) if (v.notLoaded) v.drawAgain();
});

/** Which web pictures wait changed: each diagram drawn shows its pictures, or their markers, afresh where that changed. */
export function diagramsWaitingChanged(): void {
  for (const v of live) v.recheck();
}

/** Draw every diagram now, even those far from the screen (before printing, say). */
export async function drawAllDiagrams(): Promise<void> {
  await Promise.all([...live].map((v) => v.drawNow()));
}

/** A diagram, as web-pictures.ts finds one to scan: what's drawn is what's scanned. */
export const isDiagram = isDiagramBlock;

export class DiagramView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private picture: HTMLElement;
  /** A marker for each picture from the web in the diagram that waits for the person (roadmap Batch 18, the review's R18-2). */
  private waiting: HTMLElement;
  private shownWaiting = "";
  private toggle: HTMLButtonElement;
  private drawn = "";
  private near = false;
  private done: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Not drawn because the engine didn't load. */
  notLoaded = false;

  constructor(
    private node: Node,
    private view: EditorView,
    private getPos: () => number | undefined,
    /** The document's pictures: which from the web wait, and showing one (on the export page, none waits). */
    private store: PictureStore,
  ) {
    this.dom = document.createElement("div");
    this.dom.className = "diagram";
    this.waiting = document.createElement("div");
    this.waiting.className = "diagram-waiting";
    this.waiting.contentEditable = "false";
    this.waiting.hidden = true;
    this.picture = document.createElement("div");
    this.picture.className = "diagram-picture";
    this.picture.contentEditable = "false";
    this.toggle = document.createElement("button");
    this.toggle.type = "button";
    this.toggle.className = "diagram-toggle";
    this.toggle.contentEditable = "false";
    this.toggle.textContent = "Edit diagram code";
    this.toggle.addEventListener("mousedown", (e) => e.preventDefault());
    this.toggle.addEventListener("click", () => this.toggleCode());
    const pre = document.createElement("pre");
    this.contentDOM = document.createElement("code");
    pre.append(this.contentDOM);
    this.dom.append(this.waiting, this.picture, this.toggle, pre);
    live.add(this);
    nearScreen.set(this.dom, () => this.cameNear());
    observer.observe(this.dom);
  }

  private cameNear(): void {
    this.near = true;
    observer.unobserve(this.dom);
    this.draw();
  }

  /** Draw again (in new colours, say) once it's near the screen. */
  drawAgain(): void {
    this.drawn = "";
    this.near = false;
    observer.observe(this.dom);
  }

  /** Draw now, wherever the diagram is; resolves once it's drawn. */
  drawNow(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.cameNear();
    return this.done;
  }

  private toggleCode(): void {
    const showing = this.dom.classList.toggle("show-code");
    this.toggle.textContent = showing ? "Hide diagram code" : "Edit diagram code";
    const pos = this.getPos();
    if (showing && pos !== undefined) {
      const end = pos + this.node.nodeSize - 1;
      this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, end)));
      this.view.focus();
    }
  }

  /** Drawn again if a picture in it now waits, or no longer does. */
  recheck(): void {
    this.draw();
  }

  /**
   * The code to draw: a picture from the web that waits is a blank one, so
   * the drawing asks the web for nothing he hasn't shown; each has a marker
   * with its address and Show picture above the drawing.
   */
  private drawable(): string {
    const { code, waiting } = withoutWaiting(this.node.textContent, (a) => this.store.waits(a));
    const key = waiting.join("\n");
    if (key !== this.shownWaiting) {
      this.shownWaiting = key;
      const show = this.store.show && ((src: string) => this.store.show!(src));
      this.waiting.replaceChildren(...waiting.map((src) => waitingMarker(src, show)));
      this.waiting.hidden = !waiting.length;
    }
    return code;
  }

  private draw(): void {
    if (!this.near) return; // drawn when it comes near the screen
    const code = this.drawable();
    if (code === this.drawn) return;
    this.drawn = code;
    if (!code.trim()) {
      this.picture.replaceChildren();
      this.dom.classList.add("show-code");
      return;
    }
    this.dom.classList.add("drawing");
    this.notLoaded = false;
    this.done = drawing(code)
      .then((svg) => {
        if (code !== this.drawn) return;
        this.dom.classList.remove("drawing", "has-error");
        this.picture.innerHTML = freshCopy(svg);
        sizeAsInWord(this.picture.querySelector("svg"));
      })
      .catch((err: unknown) => {
        if (code !== this.drawn) return;
        this.dom.classList.remove("drawing");
        this.dom.classList.add("has-error");
        const note = document.createElement("p");
        note.className = "diagram-error";
        this.notLoaded = err instanceof EngineNotLoaded;
        const detail = err instanceof Error ? err.message.split("\n")[0] : "";
        note.textContent = this.notLoaded
          ? "This diagram isn't drawn yet: Corillo's diagram engine didn't load. It's tried again when you come back to the window."
          : `This diagram has a mistake and can't be drawn. ${detail}`.trim();
        this.picture.replaceChildren(note);
      });
  }

  update(node: Node): boolean {
    if (!isDiagram(node)) return false;
    this.node = node;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.draw(), 300);
    return true;
  }

  stopEvent(e: Event): boolean {
    return !this.contentDOM.contains(e.target as globalThis.Node);
  }

  ignoreMutation(m: MutationRecord | { type: "selection"; target: globalThis.Node }): boolean {
    return !this.contentDOM.contains(m.target);
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer);
    observer.unobserve(this.dom);
    live.delete(this);
  }
}

/** Marks the diagram the cursor is in, so its code shows while editing. */
export function diagramCursorPlugin(): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const { $from } = state.selection;
        for (let d = $from.depth; d > 0; d--) {
          const node = $from.node(d);
          if (isDiagram(node)) {
            const pos = $from.before(d);
            return DecorationSet.create(state.doc, [Decoration.node(pos, pos + node.nodeSize, { class: "has-cursor" })]);
          }
        }
        return null;
      },
    },
  });
}
