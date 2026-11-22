// Replace All as one step, however many matches there are. A step for each
// match rebuilds the document's list of blocks once per match, so the time
// grew with the matches times the document's length: 10,000 matches took a
// third of a second, 30,000 over three seconds, and their Undo as long. This
// step replaces every match in one pass over the document, and its Undo is
// one step too. Its map holds each match's own place, so comments, changes,
// the cursor and everything else that follows the words move exactly as they
// would match by match.
import { Fragment, type Node, type Schema } from "prosemirror-model";
import { Step, StepMap, StepResult, type Mappable } from "prosemirror-transform";

/** A stretch replaced: where it is in the document before the step, and what goes there. */
export interface Place {
  readonly from: number;
  readonly to: number;
  readonly content: Fragment;
}

type EachBlock = (block: Node, start: number, places: readonly Place[]) => Node | null;

/**
 * The document with each block of text that holds places handed to `each`
 * (with where its content starts, and its places) and swapped for what that
 * gives back. Null when a place isn't inside one block of text, or `each`
 * gives null. Every block is passed over once, whatever the number of places.
 */
function eachBlock(doc: Node, places: readonly Place[], each: EachBlock): Node | null {
  const visit = (node: Node, start: number, lo: number, hi: number): Node | null => {
    let children: Node[] | null = null;
    let i = lo;
    let pos = start;
    for (let c = 0; c < node.childCount && i < hi; c++) {
      const child = node.child(c);
      const childStart = pos;
      const end = (pos += child.nodeSize);
      if (places[i].from >= end) continue;
      if (places[i].from <= childStart || child.isLeaf) return null;
      let j = i;
      while (j < hi && places[j].to < end) j++;
      if (j === i) return null; // runs on past this block
      const next = child.isTextblock ? each(child, childStart + 1, places.slice(i, j)) : visit(child, childStart + 1, i, j);
      if (!next) return null;
      if (next !== child) {
        if (!children) {
          const all: Node[] = [];
          node.forEach((n) => all.push(n));
          children = all;
        }
        children[c] = next;
      }
      i = j;
    }
    if (i < hi) return null;
    return children ? node.copy(Fragment.fromArray(children)) : node;
  };
  return visit(doc, 0, 0, places.length);
}

/**
 * Reads a block of text's content once, from the start: each call goes on to
 * `to`, adding what it passes over to `out` (text cut to fit). False when
 * `to` is behind what was read, or inside something that isn't text.
 */
function reader(block: Node): (to: number, out: Node[] | null) => boolean {
  let index = 0; // the child being read
  let start = 0; // where it starts
  let at = 0;
  return (to, out) => {
    while (at < to) {
      if (index >= block.childCount) return false;
      const child = block.child(index);
      const end = start + child.nodeSize;
      const upTo = Math.min(to, end);
      const part = at > start || upTo < end;
      if (part && !child.isText) return false;
      out?.push(part ? child.cut(at - start, upTo - start) : child);
      at = upTo;
      if (at === end) {
        index++;
        start = end;
      }
    }
    return at === to;
  };
}

/** A block of text with its places replaced, or null if that isn't valid there. */
function replaced(block: Node, start: number, places: readonly Place[]): Node | null {
  const nodes: Node[] = [];
  const read = reader(block);
  for (const p of places) {
    if (p.to < p.from || !read(p.from - start, nodes) || !read(p.to - start, null)) return null;
    p.content.forEach((n) => nodes.push(n));
  }
  if (!read(block.content.size, nodes)) return null;
  const content = Fragment.fromArray(nodes); // joins text next to text formatted the same
  return block.type.validContent(content) ? block.copy(content) : null;
}

export class ReplaceAllStep extends Step {
  /** In order, none overlapping, each inside one block of text. */
  constructor(readonly places: readonly Place[]) {
    super();
  }

  apply(doc: Node): StepResult {
    const result = eachBlock(doc, this.places, replaced);
    return result ? StepResult.ok(result) : StepResult.fail("A place to replace isn't inside one block of text");
  }

  getMap(): StepMap {
    const ranges: number[] = [];
    for (const p of this.places) ranges.push(p.from, p.to - p.from, p.content.size);
    return new StepMap(ranges);
  }

  /** What each place held in `doc`, put back where its replacement went. */
  invert(doc: Node): ReplaceAllStep {
    const held: Fragment[] = [];
    const read = eachBlock(doc, this.places, (block, start, places) => {
      const next = reader(block);
      for (const p of places) {
        const nodes: Node[] = [];
        if (!next(p.from - start, null) || !next(p.to - start, nodes)) return null;
        held.push(Fragment.fromArray(nodes));
      }
      return block;
    });
    if (!read) throw new RangeError("Replace All can't be undone in a different document");
    let moved = 0;
    return new ReplaceAllStep(
      this.places.map((p, i) => {
        const from = p.from + moved;
        moved += p.content.size - (p.to - p.from);
        return { from, to: from + p.content.size, content: held[i] };
      }),
    );
  }

  map(mapping: Mappable): ReplaceAllStep | null {
    const places: Place[] = [];
    for (const p of this.places) {
      const from = mapping.mapResult(p.from, 1);
      const to = mapping.mapResult(p.to, -1);
      if (from.deletedAcross && to.deletedAcross) continue;
      places.push({ from: from.pos, to: Math.max(from.pos, to.pos), content: p.content });
    }
    return places.length ? new ReplaceAllStep(places) : null;
  }

  toJSON() {
    return { stepType: "replaceAll", places: this.places.map((p) => ({ from: p.from, to: p.to, content: p.content.toJSON() })) };
  }

  static fromJSON(schema: Schema, json: { places?: { from: number; to: number; content: unknown }[] }): ReplaceAllStep {
    if (!Array.isArray(json.places)) throw new RangeError("Invalid input for ReplaceAllStep.fromJSON");
    return new ReplaceAllStep(json.places.map((p) => ({ from: p.from, to: p.to, content: Fragment.fromJSON(schema, p.content) })));
  }
}

Step.jsonID("replaceAll", ReplaceAllStep);

/**
 * Replace All's step: every match replaced by `text`, formatted as the words
 * it replaces (as typing over them would be). Null when a match isn't words
 * inside one block of text; the caller then replaces them one by one.
 */
export function replaceAllStep(doc: Node, matches: readonly { from: number; to: number }[], text: string): ReplaceAllStep | null {
  const places: Place[] = [];
  const schema = doc.type.schema;
  const asked = matches.map((m) => ({ from: m.from, to: m.to, content: Fragment.empty }));
  const found = eachBlock(doc, asked, (block, start, inIt) => {
    for (const m of inIt) {
      if (m.to <= m.from) return null;
      const marks = text ? block.resolve(m.from - start).marksAcross(block.resolve(m.to - start)) : null;
      places.push(text ? { ...m, content: Fragment.from(schema.text(text, marks)) } : m);
    }
    return block;
  });
  return found && places.length ? new ReplaceAllStep(places) : null;
}
