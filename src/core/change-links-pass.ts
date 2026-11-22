// One agent's pass: which comments its edits answer, and each comment's change brought up to date after an edit.
import { anchorIn, locate, type Anchor } from "./anchors";
import { carry } from "./change-links-carry";
import { changedPieces, passagesOf, type Passage, type Sync } from "./change-links-changed";
import { OffsetMap, lineStartsIn } from "./change-links-follow";
import { remapSpan, remapSpans, type ChangeSpan } from "./change-links-place";
import type { Thread } from "./comments";

/** The owner of changes tied to no comment. */
export const OTHER = "other";

/** The text a comment's latest round changed. */
export interface ThreadChange {
  /** 1 for the first round of changes for this comment, counting up. */
  round: number;
  agent: string;
  /** When the round's last change was made (ISO date). */
  at: string;
  spans: ChangeSpan[];
}

interface Region {
  start: number;
  end: number;
}

function touches(r: Region, p: Region): boolean {
  if (r.start === r.end || p.start === p.end) return r.start <= p.end && p.start <= r.end;
  return r.start < p.end && p.start < r.end;
}

/**
 * The links between an agent's edits and the comments they answer, during one
 * pass. It keeps the text as the pass began, and the places each comment's
 * edits touched since. A comment's change is then the passages of the whole
 * pass's change that its edits touched, with what they said when the pass
 * began, however many edits it took to get there. The whole pass's change is
 * compared line by line as the edits went (where each line of the text as the
 * pass began is now), so a paragraph put in for one comment above a paragraph
 * rewritten for another is never read as the rewrite of it.
 */
export class PassLinks {
  private readonly startText: string;
  private text: string;
  private regions = new Map<string, Region[]>();
  /** Where each line of the text as the pass began starts in the text now. */
  private lines: Int32Array;
  /** The round each comment's change is in this pass. */
  readonly rounds = new Map<string, number>();
  /** What the person asked for in the chat, if the agent said: edits tied to no comment are for it. */
  request: { id: string; text: string } | null = null;

  constructor(
    readonly agent: string,
    startText: string,
  ) {
    this.startText = startText;
    this.text = startText;
    this.lines = Int32Array.from(lineStartsIn(startText));
  }

  /** The comments this pass has changed text for. */
  get threads(): string[] {
    return [...this.regions.keys()].filter((k) => k !== OTHER && k !== this.request?.id);
  }

  /** This pass made changes tied to no comment. */
  get hasOther(): boolean {
    return this.regions.has(OTHER);
  }

  /** Where edits tied to no comment go: the request made in the chat, or OTHER. */
  get untied(): string {
    return this.request?.id ?? OTHER;
  }

  /** The agent said what the person asked for in the chat: this pass's edits tied to no comment are for it. */
  setRequest(id: string, text: string): void {
    if (this.request) {
      this.request.text = text;
      return;
    }
    this.request = { id, text };
    const untied = this.regions.get(OTHER);
    if (untied) {
      this.regions.delete(OTHER);
      this.regions.set(id, untied);
    }
  }

  /**
   * The agent changed the text from `before`. `steps` are the text after each
   * group of its edits, with the comments that group answers ([] for none).
   * `syncs`, places in `before` and the text after known to stay together (the
   * Markdown's lines), are used when there is one group.
   */
  edited(before: string, steps: { text: string; owners: string[] }[], syncs?: readonly Sync[]): void {
    const final = steps.length ? steps[steps.length - 1].text : before;
    if (before !== this.text) this.move(this.text, before); // something else changed it meanwhile
    const kept = steps.length === 1 ? syncs : undefined;
    let prev = before;
    for (const step of steps) {
      this.move(prev, step.text, kept);
      const owners = step.owners.length ? step.owners : [this.untied];
      for (const piece of kept ? passagesOf(prev, step.text, kept).joined : changedPieces(prev, step.text)) {
        for (const owner of owners) {
          let list = this.regions.get(owner);
          if (!list) this.regions.set(owner, (list = []));
          list.push({ start: piece.start, end: piece.end });
        }
      }
      prev = step.text;
    }
    this.text = final;
  }

  private move(from: string, to: string, syncs: readonly Sync[] = []): void {
    if (from === to) return;
    const map = new OffsetMap(from, to, false, syncs);
    this.lines = map.mapLines(this.lines);
    for (const list of this.regions.values()) {
      for (const r of list) {
        if (r.start === r.end) r.start = r.end = map.map(r.start, -1);
        else {
          r.start = map.map(r.start, 1);
          r.end = Math.max(r.start, map.map(r.end, -1));
        }
      }
    }
  }

  /**
   * Each owner's spans now, from the whole pass's change: each comment's, and
   * those tied to none (under the request made in the chat, or OTHER). Owners
   * whose edits came to nothing get none.
   */
  spans(): Map<string, ChangeSpan[]> {
    const out = new Map<string, ChangeSpan[]>();
    for (const owner of this.regions.keys()) out.set(owner, []);
    const syncs = lineStartsIn(this.startText).map((at, k): Sync => [at, this.lines[k]]);
    const { joined: pieces, apart } = passagesOf(this.startText, this.text, syncs);
    const add = (owner: string, start: number, end: number, removed: string) => {
      if (!out.has(owner)) out.set(owner, []);
      out.get(owner)!.push({ anchor: anchorIn(this.text, start, end), removed });
    };
    const owning = (piece: Passage) => [...this.regions].filter(([, rs]) => rs.some((r) => touches(r, piece))).length;
    // A passage joined across a short word is one change only if one owner has all of it. (Each part goes to one passage.)
    const used = new Set<Passage>();
    const each = pieces.flatMap((p) => {
      const parts = owning(p) > 1 ? apart.filter((f) => !used.has(f) && f.start >= p.start && f.end <= p.end) : [];
      for (const f of parts) used.add(f);
      return parts.length ? parts : [p];
    });
    for (const piece of each) {
      const touching = [...this.regions]
        .map(([owner, rs]) => [owner, rs.filter((r) => touches(r, piece))] as const)
        .filter(([, rs]) => rs.length > 0);
      if (touching.length <= 1) {
        add(touching[0]?.[0] ?? this.untied, piece.start, piece.end, piece.removed);
        continue;
      }
      // Changes for different comments that ended up side by side: each gets its own part.
      const parts = touching
        .map(([owner, rs]) => ({
          owner,
          start: Math.max(piece.start, Math.min(...rs.map((r) => r.start))),
          end: Math.min(piece.end, Math.max(...rs.map((r) => r.end))),
        }))
        .filter((p) => p.end > p.start || piece.start === piece.end)
        .sort((a, b) => a.start - b.start);
      if (!parts.length) {
        for (const [owner] of touching) add(owner, piece.start, piece.end, piece.removed);
        continue;
      }
      // What it said before goes with the first part, where the old words were. (Words only taken out are the first's alone.)
      parts.forEach((p, i) => (i === 0 || piece.start < piece.end) && add(p.owner, p.start, p.end, i === 0 ? piece.removed : ""));
    }
    return out;
  }
}

/**
 * Where a comment's deleted text was, after the text changed from `before`
 * to `after`: kept up to date once it has one, found when this change
 * deleted all of its words (see carry). Undefined while its words are still
 * there, or were rewritten rather than deleted.
 */
export function gapAfter(thread: Thread, before: string, after: string, map: OffsetMap): Anchor | undefined {
  if (!thread.anchor) return undefined;
  if (thread.gap) return remapSpan({ anchor: thread.gap, removed: "" }, before, after, map)?.anchor ?? thread.gap;
  if (thread.detached) return undefined;
  const at = locate(before, thread.anchor);
  if (!at || at.end <= at.start) return undefined;
  const carried = carry(before, after, at.start, at.end, map, thread.anchor);
  return carried.kind === "deleted" ? anchorIn(after, carried.at, carried.at) : undefined;
}

/**
 * After an agent's edit in a pass: each comment's change brought up to date.
 * Comments with a change from this pass get it; other comments' earlier
 * changes follow the text from `before` to `after`. A comment whose words the
 * edit deleted keeps their place. Changes tied to no comment aren't kept with
 * the comments: they're the pass's, in History (roadmap Batch 9, item 5).
 * `through`: the edit's map, when the caller has one that knows more (see syncsFor).
 */
export function updateChanges(threads: Thread[], links: PassLinks, before: string, after: string, now: string, through?: OffsetMap): Thread[] {
  const spans = links.spans();
  const map = before === after ? null : (through ?? new OffsetMap(before, after));
  return threads.map((t) => {
    let out = t;
    const gap = map ? gapAfter(t, before, after, map) : t.gap;
    if (gap && (!t.gap || !sameSpans([{ anchor: gap, removed: "" }], [{ anchor: t.gap, removed: "" }]))) {
      out = { ...out, gap, detached: true };
    }
    const mine = spans.get(t.id);
    if (mine) {
      if (!links.rounds.has(t.id)) links.rounds.set(t.id, (t.change?.round ?? 0) + 1);
      if (!mine.length) {
        // Its edits came to nothing (put back as they were).
        const { change: _gone, ...rest } = out;
        return rest as Thread;
      }
      return { ...out, change: { round: links.rounds.get(t.id)!, agent: links.agent, at: now, spans: mine } };
    }
    if (!t.change || !map) return out;
    const moved = remapSpans(t.change.spans, before, after, map);
    return sameSpans(moved, t.change.spans) ? out : { ...out, change: { ...t.change, spans: moved } };
  });
}

export function sameSpans(a: ChangeSpan[], b: ChangeSpan[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => {
    const t = b[i];
    return (
      s.removed === t.removed &&
      s.anchor.quote === t.anchor.quote &&
      s.anchor.prefix === t.anchor.prefix &&
      s.anchor.suffix === t.anchor.suffix &&
      s.anchor.offset === t.anchor.offset
    );
  });
}
