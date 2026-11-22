// One answer to "can the person change the document now?", asked by the
// toolbar, More (which presses the toolbar's buttons), the menu bar and its
// shortcuts, so they never disagree. The document can be changed when it's
// in the formatted view, no agent holds it and no old version is shown; its
// writing items apply only while the keyboard isn't in another box (a
// comment, a reply, an edit of one, the link editor) or resting on a
// comment's card (Next Comment).
//
// The find bar is the one difference (decided 2026-11-09 night): the
// toolbar stays live there, since "find a word, then click Bold" is a
// natural thing to do, while the menu bar's items stay greyed out, as the
// spec has them, so a shortcut pressed while typing in the find box (Command-B)
// leaves the document alone.
import type { EditorState } from "prosemirror-state";
import type { DocTab } from "./doc-tab";
import type { HistoryUi } from "./history";

const TEXT_INPUTS = new Set(["text", "search", "url", "email", "password", "number", ""]);

/** The keyboard is in a box other than the document; the find bar counts only with `findBar`. */
export function typingElsewhere(findBar: boolean): boolean {
  const focused = document.activeElement as HTMLElement | null;
  if (!focused || focused === document.body || focused.closest(".ProseMirror")) return false;
  if (focused.parentElement?.classList.contains("comments-list")) return true; // resting on a card
  if (!findBar && focused.closest(".find-bar")) return false;
  if (focused instanceof HTMLTextAreaElement) return true;
  if (focused instanceof HTMLInputElement) return TEXT_INPUTS.has(focused.type);
  return focused.isContentEditable;
}

/** The tab, when its document can be changed now: formatted, nobody else holding it, no old version shown. */
export function editable(tab: DocTab | null, history: HistoryUi): DocTab | null {
  return tab && tab.mode === "formatted" && !tab.readOnly && !history.isViewing(tab) ? tab : null;
}

/** Why the document can't be changed now by a click beside it: an agent holds it, or a version picked in History is shown. */
export type NotNow = "agent" | "version" | null;

/**
 * Whether a click outside the page may change the document now (an agent's
 * option, roadmap Batch 3 item 2): as `editable`, except either view will do,
 * since the click changes whichever is under it. Show changes keeps the
 * Comments panel beside the page, and a click there changes the document as
 * it is now, the changes shown following it (review of Batch 3, B3-R02); a
 * version picked in History doesn't. Null when it may.
 */
export function whyNotChangeable(tab: DocTab, history: HistoryUi): NotNow {
  if (tab.readOnly) return "agent";
  const { viewing, changes } = history.status(tab);
  return viewing && !changes ? "version" : null;
}

/**
 * The document's state, when its writing items (Bold, a list, the style, Undo, Insert...) apply right
 * now: from the toolbar and More, or from the menu bar and its shortcuts. Null: they're greyed out.
 */
export function writingState(tab: DocTab | null, history: HistoryUi, from: "toolbar" | "menus"): EditorState | null {
  const doc = editable(tab, history);
  return doc && !typingElsewhere(from === "menus") ? doc.view.state : null;
}
