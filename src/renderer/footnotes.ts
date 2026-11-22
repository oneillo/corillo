// Footnotes: numbered in reading order, like Word, whatever their labels are
// in the file. Inserting one adds the marker at the cursor and the note after
// the other notes, and puts the cursor in the note.
//
// In a long document the numbers are kept up to date without re-reading
// everything on each keystroke: each top-level block's markers are
// remembered, and only the blocks an edit touched get their numbers redone,
// unless the edit changed the numbering itself.
//
// Deleting a note's last marker takes the note away too, as in Word (one Undo
// brings both back). A marker cut keeps its note, so pasting it brings it back.
import { Plugin, PluginKey, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { isHistoryTransaction } from "prosemirror-history";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node, Slice } from "prosemirror-model";
import { schema } from "../core/schema";
import { changedRanges } from "./changed-ranges";
import { fromTheText } from "./doc-tab-edits";
import { PICTURE_STAND_IN } from "../core/doc-diff";

const n = schema.nodes;

const isFootnote = (node: Node) => node.type === n.footnote_ref || node.type === n.footnote_def;

interface BlockNotes {
  /** Labels of the markers in the block, in order. */
  refs: string[];
  /** Whether the block holds any marker or note. */
  any: boolean;
}

// What each top-level block holds. A block nobody edited is the same object
// as before, so its entry is reused.
const notesIn = new WeakMap<Node, BlockNotes>();

function blockNotes(block: Node): BlockNotes {
  let found = notesIn.get(block);
  if (!found) {
    const refs: string[] = [];
    let any = isFootnote(block);
    block.descendants((node) => {
      if (node.type === n.footnote_ref) refs.push(node.attrs.label);
      if (isFootnote(node)) any = true;
    });
    found = { refs, any };
    notesIn.set(block, found);
  }
  return found;
}

/** Number each footnote label by where its first marker appears. */
export function footnoteNumbers(doc: Node): Map<string, number> {
  const numbers = new Map<string, number>();
  doc.forEach((block) => {
    for (const label of blockNotes(block).refs) if (!numbers.has(label)) numbers.set(label, numbers.size + 1);
  });
  return numbers;
}

/** The number shown on each marker and note in one top-level block. */
function blockDecorations(block: Node, start: number, numbers: Map<string, number>, out: Decoration[]): void {
  if (!blockNotes(block).any) return;
  const add = (node: Node, pos: number) => {
    const shown = String(numbers.get(node.attrs.label) ?? "?");
    out.push(Decoration.node(pos, pos + node.nodeSize, { "data-number": shown }, { number: shown }));
  };
  if (isFootnote(block)) add(block, start);
  block.descendants((node, pos) => {
    if (isFootnote(node)) add(node, start + 1 + pos);
  });
}

interface NotesState {
  /** The number shown on each marker and note. */
  decorations: DecorationSet;
  /** The labels in numbering order: when this changes, every number is redone. */
  order: string;
}

export const footnoteNumbering = new PluginKey<NotesState>("footnote numbers");

function build(doc: Node): NotesState {
  const numbers = footnoteNumbers(doc);
  const decos: Decoration[] = [];
  doc.forEach((block, offset) => blockDecorations(block, offset, numbers, decos));
  return { decorations: DecorationSet.create(doc, decos), order: [...numbers.keys()].join("\n") };
}

function update(tr: Transaction, old: NotesState): NotesState {
  const doc = tr.doc;
  const numbers = footnoteNumbers(doc);
  const order = [...numbers.keys()].join("\n");
  const ranges = changedRanges(tr);
  if (order !== old.order || !ranges) return build(doc);
  // Same numbering: move the existing numbers along, and redo the blocks the edit touched.
  let decorations = old.decorations.map(tr.mapping, doc);
  doc.forEach((block, start) => {
    const end = start + block.nodeSize;
    if (!ranges.some(([from, to]) => from <= end && to >= start)) return;
    const stale = decorations.find(start, end).filter((d) => d.from >= start && d.to <= end);
    const fresh: Decoration[] = [];
    blockDecorations(block, start, numbers, fresh);
    if (stale.length) decorations = decorations.remove(stale);
    if (fresh.length) decorations = decorations.add(doc, fresh);
  });
  return { decorations, order };
}

function findNote(doc: Node, label: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.type === n.footnote_def && node.attrs.label === label) found = pos;
    return !node.isTextblock;
  });
  return found;
}

/**
 * Whether these edits are the person deleting in the formatted view: not a
 * cut (the marker may be pasted back), not Undo or Redo (which bring back or
 * take away a marker and its note together, as they were done), and not the
 * Markdown view catching up with what was typed there (the note is still in
 * that text).
 */
const deletesNotes = (tr: Transaction) =>
  tr.getMeta("uiEvent") !== "cut" && !isHistoryTransaction(tr) && !fromTheText(tr);

/**
 * Whether these edits put a marker's Markdown text in where they took the
 * marker out (Code block writes a paragraph's markers as "[^1]"): the
 * marker was rewritten, not deleted, and its note stays.
 */
function rewritten(trs: readonly Transaction[], label: string): boolean {
  const written = `[^${label}]`;
  return trs.some((t) =>
    t.steps.some((step) => {
      const slice = (step as unknown as { slice?: Slice }).slice;
      return !!slice && slice.size >= written.length && slice.content.textBetween(0, slice.size, "\n", PICTURE_STAND_IN).includes(written);
    }),
  );
}

/** Take away the notes whose last marker these edits deleted. */
function dropOrphanNotes(trs: readonly Transaction[], before: EditorState, after: EditorState): Transaction | null {
  const was = footnoteNumbering.getState(before)?.order;
  const is = footnoteNumbering.getState(after)?.order;
  if (!was || was === is || !trs.some((t) => t.docChanged) || !trs.every(deletesNotes)) return null;
  const left = new Set(is ? is.split("\n") : []);
  const notes: [number, number][] = [];
  for (const label of was.split("\n")) {
    if (left.has(label) || rewritten(trs, label)) continue;
    const at = findNote(after.doc, label);
    if (at >= 0) notes.push([at, at + after.doc.nodeAt(at)!.nodeSize]);
  }
  if (!notes.length) return null;
  const tr = after.tr;
  for (const [from, to] of notes.sort((a, b) => b[0] - a[0])) tr.delete(from, to);
  return tr;
}

export function footnotePlugin(): Plugin<NotesState> {
  return new Plugin<NotesState>({
    key: footnoteNumbering,
    state: {
      init: (_c, state) => build(state.doc),
      apply: (tr, old) => (tr.docChanged ? update(tr, old) : old),
    },
    appendTransaction: dropOrphanNotes,
    props: {
      decorations(state) {
        return this.getState(state)?.decorations;
      },
      // Clicking a footnote number jumps to its note.
      handleClickOn(view, _pos, node) {
        if (node.type !== n.footnote_ref) return false;
        const at = findNote(view.state.doc, node.attrs.label);
        if (at < 0) return false;
        const end = at + view.state.doc.nodeAt(at)!.nodeSize - 1;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)).scrollIntoView());
        return true;
      },
    },
  });
}

export const insertFootnote: Command = (state: EditorState, dispatch) => {
  const { $from } = state.selection;
  if (!$from.parent.inlineContent || $from.parent.type.spec.code || $from.parent.type === n.footnote_def) return false;
  if (!$from.parent.canReplaceWith($from.index(), $from.indexAfter(), n.footnote_ref)) return false;
  if (!dispatch) return true;
  const used = new Set<string>();
  let lastNoteEnd = -1;
  state.doc.descendants((node, pos) => {
    if (node.type === n.footnote_ref || node.type === n.footnote_def) used.add(node.attrs.label);
    if (node.type === n.footnote_def) lastNoteEnd = pos + node.nodeSize;
    return !node.isTextblock;
  });
  let i = 1;
  while (used.has(String(i))) i++;
  const label = String(i);
  const tr = state.tr.replaceSelectionWith(n.footnote_ref.create({ label }), false);
  const notePos = lastNoteEnd >= 0 ? tr.mapping.map(lastNoteEnd) : tr.doc.content.size;
  tr.insert(notePos, n.footnote_def.create({ label }));
  tr.setSelection(TextSelection.create(tr.doc, notePos + 1));
  dispatch(tr.scrollIntoView());
  return true;
};
