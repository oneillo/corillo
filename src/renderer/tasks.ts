// Task list items ("- [ ] Call Ana"): the box before the words is drawn by
// the page's style, as Word draws it. Clicking the box ticks it or clears it;
// Enter after a task item starts a new, unticked one. Typing "[ ] " or "[x] "
// at the start of a bulleted item makes it a task, as "- " makes a list.
import { Plugin, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { InputRule } from "prosemirror-inputrules";
import { splitListItem } from "prosemirror-schema-list";
import { schema } from "../core/schema";

const item = schema.nodes.list_item;

/** The list item the cursor is in, if any. */
function itemAt(state: EditorState) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === item) return $from.node(d);
  return null;
}

/** Enter in a list: a new item, unticked if this one is a task. */
export const splitItem: Command = (state, dispatch) =>
  splitListItem(item, itemAt(state)?.attrs.checked != null ? { checked: false } : undefined)(state, dispatch);

/**
 * "[ ] " or "[x] " typed at the start of a bulleted item's first line: a task,
 * unticked or ticked. (In a numbered list it stays as typed, as Word shows it.)
 */
export const taskInputRule = new InputRule(/^\[([ xX])\]\s$/, (state, match, start, end) => {
  const $start = state.doc.resolve(start);
  const d = $start.depth - 1;
  if (d < 2 || $start.node(d).type !== item || $start.node(d - 1).type !== schema.nodes.bullet_list) return null;
  if ($start.index(d) !== 0 || $start.node(d).attrs.checked != null) return null;
  const pos = $start.before(d);
  return state.tr.delete(start, end).setNodeMarkup(pos, undefined, { ...$start.node(d).attrs, checked: match[1] !== " " });
});

/**
 * A task whose first line is no longer a plain line (made a heading, code or
 * a quote, by the style menu, typed Markdown, a paste or a drop) loses its
 * box and stays in its list as an ordinary item: Markdown has a task's box
 * only at the start of a plain line, so "- [ ] # Title" would read back as the
 * words "# Title" (roadmap Batch 18, R16-3 case 2, and its review's R18-4).
 * Only the places the change touched are looked at, so typing costs nothing;
 * appended to the change, so one Undo brings the box back with the line.
 */
function tasksStayPlain(trs: readonly Transaction[], _old: EditorState, state: EditorState): Transaction | null {
  if (!trs.some((tr) => tr.docChanged)) return null;
  // Where the changes landed in the new document: one span around them all, carried step by step (a Replace
  // All of many matches costs one look over that span, not one per step).
  let span: [number, number] | null = null;
  for (const tr of trs) {
    for (const step of tr.steps) {
      const map = step.getMap();
      if (span) span = [map.map(span[0], -1), map.map(span[1], 1)];
      map.forEach((_from, _to, start, end) => {
        span = span ? [Math.min(span[0], start), Math.max(span[1], end)] : [start, end];
      });
    }
  }
  const ranges: [number, number][] = span ? [span] : [];
  let tr: Transaction | null = null;
  const size = state.doc.content.size;
  for (const [from, to] of ranges) {
    state.doc.nodesBetween(Math.max(0, Math.min(from, size)), Math.max(0, Math.min(to, size)), (node, pos) => {
      if (node.type === item && node.attrs.checked !== null && node.firstChild && node.firstChild.type !== schema.nodes.paragraph) {
        tr ??= state.tr;
        if (tr.doc.nodeAt(pos)?.attrs.checked !== null) tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: null });
      }
      return !node.isTextblock;
    });
  }
  return tr;
}

export function tasksPlugin(): Plugin {
  return new Plugin({
    appendTransaction: tasksStayPlain,
    props: {
      handleDOMEvents: {
        mousedown(view, event) {
          if (!view.editable || event.button !== 0 || !(event.target instanceof HTMLElement)) return false;
          const li = event.target.closest("li.task");
          const first = li?.firstElementChild;
          // The box sits before the item's first line, outside its words.
          if (!li || !first || event.clientX >= first.getBoundingClientRect().left) return false;
          const pos = view.posAtDOM(li, 0) - 1;
          const node = view.state.doc.nodeAt(pos);
          if (node?.type !== item || node.attrs.checked === null) return false;
          view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked }));
          event.preventDefault();
          return true;
        },
      },
    },
  });
}
