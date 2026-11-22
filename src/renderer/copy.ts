// Copying out of Corillo. The clipboard gets the selection as formatted HTML
// that looks the way the page does (for Outlook, Gmail and Word: see
// clipboardHTML in clipboard-text.ts) and as Markdown text (which pastes
// cleanly into an agent's chat or a plain text app). It goes through the app,
// which writes both at once. Edit > Copy for Email copies the whole document
// that way, without its details or Subject line, and without what the page
// hides in Word: comments, link definitions (forEmail in clipboard-text.ts).
import { Plugin, type EditorState } from "prosemirror-state";
import type { Node, Slice } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { clipboardHTML, emailBody, forEmail, linesFromClipboard, sliceMarkdown, type SpacingMarks } from "../core/clipboard-text";
import { blankLinesKey, spacingOf } from "./blank-lines";
import { footnoteNumbers } from "./footnotes";
import { parseCached } from "./parse-cache";
import { withAddresses } from "./link-labels";
import { schema, waitsNow } from "../core/schema";
import { webPicturesOf } from "../core/web-pictures";
import type { DocTab } from "./doc-tab";

/**
 * Marks what Corillo copies, so pasting it back in is known for Corillo's own
 * (other editors built the same way mark their copies as Corillo's editor does).
 * The mark's value is new each time the window opens, so a web page can't
 * pass its own HTML off as Corillo's and skip the cleaning.
 */
const COPY_MARK = "data-corillo";
const COPY_VALUE = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
export const isCorilloCopy = (html: string) => html.includes(` ${COPY_MARK}="${COPY_VALUE}"`);
/**
 * Marked as Corillo's copy, by this window or one before it (Corillo started
 * again, or its window opened again, since). It can't skip the cleaning, but
 * it is read for the pictures it says wait, since that mark can only make a
 * picture wait (the review of Batch 19, R19-2).
 */
export const hasCopyMark = (html: string) => html.includes(` ${COPY_MARK}="`);

/** The page's spacing marks: what blank-lines.ts keeps for the page on screen. */
const spacingShown = (state: EditorState): SpacingMarks | undefined => blankLinesKey.getState(state)?.set;

/** Copied content, formatted the way the page shows it. */
function copiedHTML(slice: Slice, from: number, doc: Node, spacing: SpacingMarks | undefined): string {
  const noted = footnoteNumbers(doc);
  const html = clipboardHTML(withAddresses(slice, doc), from, {
    spacing,
    number: (label) => String(noted.get(label) ?? ""),
    mark: { [COPY_MARK]: COPY_VALUE },
  });
  return `<meta charset="utf-8">${html}`;
}

/** Put copied content on the clipboard: formatted, the way the page shows it, and as Markdown. */
function write(slice: Slice, from: number, doc: Node, spacing: SpacingMarks | undefined): void {
  const text = sliceMarkdown(withAddresses(slice, doc));
  copiedHere(text, [...webPicturesOf(schema.topNodeType.create(null, slice.content))].filter(waitsNow));
  window.corillo.writeClipboard(copiedHTML(slice, from, doc, spacing), text);
}

// The last copy made here, for Paste and Match Style (the review of Batch 19,
// R19-3): it reads only the clipboard's text, which says nothing of which
// pictures wait. So the window keeps, from its last copy, the web pictures
// that waited and a fingerprint of the text (never the text itself); pasted
// as plain text into the Markdown view or a diagram's code, text that matches
// makes them wait there too. A copy made before the window opened isn't known.
let lastCopy: { print: string; waiting: string[] } | null = null;

/** A short fingerprint of a text: its length and two 32-bit hashes. */
function fingerprint(text: string): string {
  let a = 0x9e3779b9;
  let b = 0x85ebca6b;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) + (b >>> 15);
  }
  return `${text.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}

/** This window just copied `text`, in which these web pictures wait. */
export function copiedHere(text: string, waiting: string[]): void {
  lastCopy = waiting.length ? { print: fingerprint(text), waiting } : null;
}

/** The web pictures that waited in this window's last copy, if `text` is that copy's text; none otherwise. */
export function waitingOfCopy(text: string): string[] {
  return lastCopy && lastCopy.print === fingerprint(text) ? lastCopy.waiting : [];
}

/**
 * Words dragged out of the page carry the same formatted text as Copy. The
 * editor's own dragstart has run by then (it was listening first) and decided
 * what is dragged; this only rewrites the formatted text it put with it.
 */
function dragOut(view: EditorView): { destroy(): void } {
  const started = (event: DragEvent) => {
    const what = view.dragging;
    if (!what || !event.dataTransfer) return;
    // A picture or diagram dragged on its own: the editor keeps it as `node`, which its types leave out.
    const from = (what as { node?: { from: number } }).node?.from ?? view.state.selection.from;
    event.dataTransfer.setData("text/html", copiedHTML(what.slice, from, view.state.doc, spacingShown(view.state)));
  };
  view.dom.addEventListener("dragstart", started);
  return { destroy: () => view.dom.removeEventListener("dragstart", started) };
}

function copyOut(view: EditorView, event: ClipboardEvent, cut: boolean): boolean {
  const { selection, doc } = view.state;
  if (selection.empty) return false;
  event.preventDefault();
  write(selection.content(), selection.from, doc, spacingShown(view.state));
  if (cut && view.editable) view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta("uiEvent", "cut"));
  return true;
}

export interface EmailCopy {
  /** The words after "Subject:" on the document's first line, if it has one. */
  subject: string | null;
  /** Whether there was more than a subject to copy. */
  copied: boolean;
}

/**
 * Edit > Copy for Email: the whole document as it is now, formatted the way
 * the page shows it, without the document details at the top, what the page
 * hides in Word, or a first line starting "Subject:" (given back, for the
 * notice). Null when the document has no words.
 */
export function copyForEmail(tab: DocTab): EmailCopy | null {
  let shown: { doc: Node; spacing?: SpacingMarks };
  let whole: Node;
  if (tab.mode === "markdown") {
    // The text as typed, which the editor may not have caught up with yet.
    const parsed = parseCached(tab.currentText());
    whole = parsed.doc;
    shown = forEmail(parsed.doc, spacingOf(parsed.doc, parsed.source));
  } else {
    whole = tab.view.state.doc;
    shown = forEmail(whole, spacingShown(tab.view.state));
  }
  const { doc, spacing } = shown;
  const body = emailBody(doc);
  if (!body) return null;
  if (body.from === body.to) return { subject: body.subject, copied: false };
  // (Links by label take their addresses from the document's lines, which the email leaves out.)
  write(withAddresses(doc.slice(body.from, body.to, true), whole), body.from, doc, spacing);
  return { subject: body.subject, copied: true };
}

export function copyPlugin(): Plugin {
  return new Plugin({
    view: dragOut,
    props: {
      clipboardTextSerializer: (slice) => sliceMarkdown(slice),
      // A paragraph's own line breaks, copied as line breaks for other apps, come back as they were.
      transformPasted: (slice) => linesFromClipboard(slice),
      handleDOMEvents: {
        copy: (view, event) => copyOut(view, event as ClipboardEvent, false),
        cut: (view, event) => copyOut(view, event as ClipboardEvent, true),
      },
    },
  });
}
