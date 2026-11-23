// A paragraph keeps the file's single line breaks as line breaks in its text,
// as Obsidian shows them (see keepLineBreaks in markdown-read.ts). As someone
// types, ProseMirror reads the changed text back from the page, and would
// turn those line breaks into spaces; this keeps them. The page's text is
// shown with its spacing as it is, so reading it back as it is is right.
// Pasting still tidies the spacing of what's pasted, as before.
import { DOMParser, type Node, type ParseOptions } from "prosemirror-model";
import { Plugin, TextSelection, type Command } from "prosemirror-state";
import { schema } from "../core/schema";

const asPasted = DOMParser.fromSchema(schema);

class AsTyped extends DOMParser {
  parse(dom: globalThis.Node, options: ParseOptions = {}) {
    return super.parse(dom, { ...options, preserveWhitespace: options.preserveWhitespace === true ? "full" : options.preserveWhitespace });
  }
}

const asTyped = new AsTyped(schema, asPasted.rules);

export function lineBreaksPlugin(): Plugin {
  return new Plugin({ props: { domParser: asTyped, clipboardParser: asPasted } });
}

// Backspace at the start of a line in a paragraph's text (Orlando, 2026-11-22:
// "I'm trying to delete the new line at the front of Line 4 to bring this up
// to the paragraph above, and it's not working"), and Delete at the end of the
// line above. The line break goes and the two lines become one, as in any
// editor. The browser did this itself, until line numbers were on: then each
// line starts with its number, which can't be edited, and the browser's
// Backspace stopped at it. So the editor takes the line break out itself:
// a line break in the text, or one the person typed (Shift-Return); in code,
// the same. A selection, or anything else before the cursor, is left to the
// commands after this one and the browser, as before.

/** Backspace right after a line break in a block's text: the line break goes. */
export const deleteLineBreakBackward: Command = (state, dispatch) => {
  const $cursor = (state.selection as TextSelection).$cursor;
  if (!$cursor || !isLineBreak($cursor.nodeBefore, -1)) return false;
  if (dispatch) dispatch(state.tr.delete($cursor.pos - 1, $cursor.pos).scrollIntoView());
  return true;
};

/** Delete right before a line break in a block's text: the line break goes, and the cursor stays put. */
export const deleteLineBreakForward: Command = (state, dispatch) => {
  const $cursor = (state.selection as TextSelection).$cursor;
  if (!$cursor || !isLineBreak($cursor.nodeAfter, 1)) return false;
  if (dispatch) dispatch(state.tr.delete($cursor.pos, $cursor.pos + 1).scrollIntoView());
  return true;
};

/**
 * Whether the node beside the cursor starts (side 1) or ends (side -1) with a
 * line break. ProseMirror gives only the part of a text node on that side of
 * the cursor, so its character next to the cursor is its first or its last.
 */
function isLineBreak(node: Node | null, side: -1 | 1): boolean {
  if (!node) return false;
  if (node.type.name === "hard_break") return true;
  const text = node.isText ? node.text! : "";
  return (side === -1 ? text.at(-1) : text[0]) === "\n";
}

/**
 * Left arrow at the start of a line in a block's text: to the end of the line
 * above. With line numbers on, the browser's Left stopped at the line's number
 * (as its Backspace did, above). With Shift (`extend`), the selection grows
 * over the line break the same way. A selection with Left alone, and Right,
 * are left to the browser, which does them right.
 */
export function leftOverLineBreak(extend: boolean): Command {
  return (state, dispatch) => {
    const { selection } = state;
    if (!(selection instanceof TextSelection) || (!extend && !selection.empty)) return false;
    if (!isLineBreak(selection.$head.nodeBefore, -1)) return false;
    const head = selection.head - 1;
    if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, extend ? selection.anchor : head, head)).scrollIntoView());
    return true;
  };
}
