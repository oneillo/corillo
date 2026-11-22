// Comments' words in the Markdown view's text, worked out without the window:
// what one round of typing changed in the text, where a mark goes through it,
// and how a line is cut into marked and unmarked pieces. The window draws the
// marks (src/renderer/source-marks.ts); the document says exactly where each
// one is a moment after typing stops, and these keep them on their words until then.

/** How a mark is drawn: a comment's words, the comment in focus (or being written), or an agent's change for it. */
export type MarkKind = "comment" | "active" | "change";

export interface SourceMark {
  /** The comment (or owner of the change) it belongs to. */
  id: string;
  from: number;
  to: number;
  kind: MarkKind;
}

/** One stretch of the text replaced by another: [from, oldTo) became [from, newTo). */
export interface TextEdit {
  from: number;
  oldTo: number;
  newTo: number;
}

/** What changed between two versions of a text, as one replaced stretch; null if nothing did. */
export function textEdit(before: string, after: string): TextEdit | null {
  if (before === after) return null;
  const shortest = Math.min(before.length, after.length);
  let from = 0;
  while (from < shortest && before.charCodeAt(from) === after.charCodeAt(from)) from++;
  let a = before.length;
  let b = after.length;
  while (a > from && b > from && before.charCodeAt(a - 1) === after.charCodeAt(b - 1)) {
    a--;
    b--;
  }
  return { from, oldTo: a, newTo: b };
}

/**
 * Where a place in the text goes through an edit. `side` -1 keeps a place
 * at the edge of the edit before what was typed there, 1 after it.
 */
export function mapPlace(at: number, edit: TextEdit, side: -1 | 1): number {
  if (at < edit.from || (at === edit.from && side < 0)) return at;
  if (at > edit.oldTo || (at === edit.oldTo && side > 0)) return at + edit.newTo - edit.oldTo;
  return side < 0 ? edit.from : edit.newTo;
}

/**
 * Where a mark goes through an edit, as a comment's words do in the formatted
 * view: typing just before or just after them stays outside, typing among
 * them joins them, and a mark whose words were all deleted goes (null).
 */
export function mapMark(mark: SourceMark, edit: TextEdit): SourceMark | null {
  const from = mapPlace(mark.from, edit, 1);
  const to = mapPlace(mark.to, edit, -1);
  if (to <= from) return null;
  return from === mark.from && to === mark.to ? mark : { ...mark, from, to };
}

const STRENGTH: Record<MarkKind, number> = { comment: 1, active: 2, change: 3 };

export interface MarkedPiece {
  from: number;
  to: number;
  /** The strongest mark over it, or null for unmarked text. */
  kind: MarkKind | null;
  id: string | null;
}

/**
 * A stretch of the text (a line, say) cut where marks start and end. Each
 * piece takes the strongest mark over it: an agent's change, then the comment
 * in focus, then any other comment.
 */
export function pieces(from: number, to: number, marks: readonly SourceMark[]): MarkedPiece[] {
  const over = marks.filter((m) => m.from < to && m.to > from);
  if (!over.length) return [{ from, to, kind: null, id: null }];
  const cuts = new Set<number>([from, to]);
  for (const m of over) {
    if (m.from > from) cuts.add(m.from);
    if (m.to < to) cuts.add(m.to);
  }
  const at = [...cuts].sort((a, b) => a - b);
  const out: MarkedPiece[] = [];
  for (let i = 0; i + 1 < at.length; i++) {
    const a = at[i];
    const b = at[i + 1];
    let best: SourceMark | null = null;
    for (const m of over) {
      if (m.from <= a && m.to >= b && (!best || STRENGTH[m.kind] > STRENGTH[best.kind] || (STRENGTH[m.kind] === STRENGTH[best.kind] && m.to - m.from < best.to - best.from))) {
        best = m;
      }
    }
    const last = out[out.length - 1];
    if (last && last.kind === (best?.kind ?? null) && last.id === (best?.id ?? null)) last.to = b;
    else out.push({ from: a, to: b, kind: best?.kind ?? null, id: best?.id ?? null });
  }
  return out;
}

/** The comment whose words are at this place (the smallest, if several are), not counting agents' changes. */
export function markAt(marks: readonly SourceMark[], at: number): string | null {
  let best: SourceMark | null = null;
  for (const m of marks) {
    if (m.kind === "change" || m.from > at || m.to < at) continue;
    if (!best || m.to - m.from < best.to - best.from) best = m;
  }
  return best?.id ?? null;
}
