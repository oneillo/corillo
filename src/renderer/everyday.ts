// The everyday basics people expect from Word: Find and Replace, the
// right-click menu's actions, clean pasting and copying, the selection's word
// count and page zoom. app.ts and doc-tab.ts hook these in.
import { TextSelection, type Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { wordCountLabel } from "../core/word-count";
import { wordsBetween } from "../core/words";
import type { DocTab } from "./doc-tab";
import type { PictureStore } from "./images";
import { FindBar, findPlugin } from "./find";
import { removeLink } from "./commands";
import { pastePlugin, setupPastePlain } from "./paste";
import { copyPlugin } from "./copy";
import { PICTURE_STAND_IN } from "../core/doc-diff";

export interface EverydayHost {
  active(): DocTab | null;
  /** The tab in front when its document can be changed now: the one answer of editable.ts. */
  editable(): DocTab | null;
  openLinkEditor(): void;
  /** Show the status bar again (the selection changed in the Markdown view). */
  refreshStatus(): void;
}

export interface Everyday {
  /** The tab in front or its view changed. */
  sync(): void;
  /** The status bar's word count for a tab. */
  wordLabel(tab: DocTab): string;
}

/** The editor plugins each tab gets. */
export function everydayPlugins(store: PictureStore): Plugin[] {
  return [findPlugin(), pastePlugin(store), copyPlugin()];
}

/**
 * Words in the selection, or null with nothing selected. Counted as the total
 * is, so a selection never has more words than the document. In the Markdown
 * view, the selected text is found in the editor's document rather than read
 * again; while typing there is still to come in, it's null (the total only).
 */
export function selectedWords(tab: DocTab): number | null {
  const doc = tab.view.state.doc;
  if (tab.mode === "formatted") {
    const { selection } = tab.view.state;
    if (selection.empty) return null;
    return selection.ranges.reduce((n, r) => n + wordsBetween(doc, r.$from.pos, r.$to.pos), 0);
  }
  const range = tab.textSelection();
  return range && wordsBetween(doc, range.from, range.to);
}

/** Put a spelling suggestion in place of the misspelled word at the selection. */
export function replaceWord(view: EditorView, word: string, replacement: string): boolean {
  const { state } = view;
  const { $from, from, to } = state.selection;
  const parent = $from.parent;
  if (!view.editable || !parent.inlineContent || !word) return false;
  let text = "";
  parent.forEach((child) => {
    text += child.isText ? child.text! : PICTURE_STAND_IN.repeat(child.nodeSize);
  });
  const start = $from.start();
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
    if (i <= from - start && i + word.length >= to - start) {
      view.dispatch(state.tr.insertText(replacement, start + i, start + i + word.length).scrollIntoView());
      return true;
    }
  }
  return false;
}

/** Edit Link… from the right-click menu: edit the whole link, not just the word clicked. */
function editLink(tab: DocTab | null, openLinkEditor: () => void): void {
  if (!tab || tab.mode !== "formatted") return;
  const { state } = tab.view;
  const { from, to, empty } = state.selection;
  if (!empty) tab.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, Math.min(from + 1, to))));
  openLinkEditor();
}

/** Remove Link from the right-click menu: the whole link goes, its words stay. */
function removeLinkAt(tab: DocTab | null): void {
  if (!tab || tab.mode !== "formatted" || tab.readOnly) return;
  const view = tab.view;
  const { from, to, empty } = view.state.selection;
  if (!empty) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, Math.min(from + 1, to))));
  removeLink(view.state, view.dispatch);
  view.focus();
}

function setupZoom(): void {
  // Shown only when the page isn't at 100%; clicking it goes back there.
  const label = document.createElement("button");
  label.type = "button";
  label.id = "zoom-level";
  label.className = "status-button";
  label.title = "Back to actual size (⌘0)";
  label.hidden = true;
  label.addEventListener("mousedown", (e) => e.preventDefault()); // keep the cursor in the document
  label.addEventListener("click", () => void window.corillo.zoom("reset").then(apply));
  document.querySelector(".status-bar .status-spacer")?.before(label);
  const apply = (level: number) => {
    document.documentElement.style.setProperty("--page-zoom", String(level));
    label.textContent = `${Math.round(level * 100)}%`;
    label.hidden = level === 1;
  };
  void window.corillo.zoom().then(apply);
  window.corillo.onZoom(apply);
  // Cmd+= (or Cmd++), Cmd+- and Cmd+0.
  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      const how = e.key === "=" || e.key === "+" ? "in" : e.key === "-" ? "out" : e.key === "0" ? "reset" : null;
      if (!how) return;
      e.preventDefault();
      e.stopPropagation();
      void window.corillo.zoom(how).then(apply);
    },
    true,
  );
}

export function setupEveryday(host: EverydayHost): Everyday {
  const find = new FindBar(() => host.active());
  // Into the document only where it can be changed (not while a version shows or an agent has it), as every writing command.
  setupPastePlain(() => host.editable(), () => host.active());
  setupZoom();

  window.corillo.onMenu((action) => {
    if (action === "link:edit") editLink(host.active(), () => host.openLinkEditor());
    else if (action === "link:remove") removeLinkAt(host.active());
    else if (action === "link:open") host.active()?.openRightClickedLink();
  });
  window.corillo.onReplaceMisspelling((word, replacement) => {
    const tab = host.active();
    if (tab?.mode === "formatted") replaceWord(tab.view, word, replacement);
  });

  // The Markdown view's selection doesn't go through the editor, so watch for it here.
  let queued = false;
  const selectionMoved = () => {
    if (queued || host.active()?.mode !== "markdown") return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      host.refreshStatus();
    });
  };
  document.addEventListener("selectionchange", selectionMoved, true);
  document.addEventListener("keyup", selectionMoved, true);
  document.addEventListener("mouseup", selectionMoved, true);

  return {
    sync: () => find.sync(),
    wordLabel: (tab) => wordCountLabel(tab.words, selectedWords(tab)),
  };
}
