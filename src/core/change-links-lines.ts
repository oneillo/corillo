// Matching the lines of two texts, and comparing them word by word within the lines matched.
import { diffSequence, diffText, type Piece as DiffPiece } from "./diff";

export type LineStep = { kind: "same" | "pair"; a: number; b: number } | { kind: "removed"; a: number } | { kind: "added"; b: number };

/** Past this many pairs of lines to weigh, lines are matched the quick way (diffSequence), without the preference for their own place. */
const WEIGH_MOST = 90_000;

/**
 * The lines of a and b, matched: as many kept as can be, and where two ways
 * keep as many, the one that leaves lines nearest their own place (a status
 * set to "Done" on the row above a "Done" leaves that one in its row). Lines
 * that changed are paired with the line in their place when as many came as
 * went between two kept ones; otherwise they went and came.
 */
export function pairLines(a: readonly string[], b: readonly string[]): LineStep[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  const out: LineStep[] = [];
  for (let k = 0; k < head; k++) out.push({ kind: "same", a: k, b: k });
  let i = 0;
  let j = 0;
  const changed = (toI: number, toJ: number) => {
    if (toI - i === toJ - j) for (; i < toI; i++, j++) out.push({ kind: "pair", a: head + i, b: head + j });
    for (; i < toI; i++) out.push({ kind: "removed", a: head + i });
    for (; j < toJ; j++) out.push({ kind: "added", b: head + j });
  };
  for (const [x, y] of kept(a.slice(head, head + n), b.slice(head, head + m))) {
    changed(x, y);
    out.push({ kind: "same", a: head + x, b: head + y });
    i = x + 1;
    j = y + 1;
  }
  changed(n, m);
  for (let k = 0; k < tail; k++) out.push({ kind: "same", a: a.length - tail + k, b: b.length - tail + k });
  return out;
}

/** A line with words counts for more than one without (a blank line, a table's dashes): a paragraph moved isn't a blank line kept. */
const weightOf = (line: string) => (/[\p{L}\p{N}]/u.test(line) ? 1000 : 1);

/** Which lines of a and b are the same lines kept: the most there can be (by weightOf), and of those, the nearest their own place. */
function kept(a: readonly string[], b: readonly string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const out: [number, number][] = [];
  if (!n || !m) return out;
  if (n * m > WEIGH_MOST) {
    let i = 0;
    let j = 0;
    for (const op of diffSequence(a, b)) {
      if (op.type === "same") out.push([i++, j++]);
      else if (op.type === "removed") i++;
      else j++;
    }
    return out;
  }
  // From the end: how many lines can be kept from (x, y) on, and how far from their place they are in all.
  const weight = a.map(weightOf);
  const w = m + 1;
  const most = new Int32Array((n + 1) * w);
  const far = new Int32Array((n + 1) * w);
  for (let x = n - 1; x >= 0; x--) {
    for (let y = m - 1; y >= 0; y--) {
      const at = x * w + y;
      let keep = most[at + w];
      let off = far[at + w];
      if (most[at + 1] > keep || (most[at + 1] === keep && far[at + 1] < off)) {
        keep = most[at + 1];
        off = far[at + 1];
      }
      if (a[x] === b[y]) {
        const k = most[at + w + 1] + weight[x];
        const f = far[at + w + 1] + Math.abs(x - y);
        if (k > keep || (k === keep && f <= off)) {
          keep = k;
          off = f;
        }
      }
      most[at] = keep;
      far[at] = off;
    }
  }
  let x = 0;
  let y = 0;
  while (x < n && y < m) {
    const at = x * w + y;
    if (a[x] === b[y] && most[at] === most[at + w + 1] + weight[x] && far[at] === far[at + w + 1] + Math.abs(x - y)) out.push([x++, y++]);
    else if (most[at] === most[at + w] && far[at] === far[at + w]) x++;
    else y++;
  }
  return out;
}

/** A text's lines, each with its line break (the last may have none). */
const linesOf = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const bare = (line: string) => (line.endsWith("\n") ? line.slice(0, -1) : line);

/**
 * The changes from a to b, for following words through them: diffText's,
 * but with lines matched as pairLines does, and a run of changed lines with
 * as many after as before never compared so that a word is paired with the
 * same word on another line ("29 June" rewritten as "Done" beside a cell that
 * became "15 June"): line by line, unless the run compared whole keeps every
 * line break. The last line matches itself with or without a line break
 * after it.
 */
export function compared(a: string, b: string): DiffPiece[] {
  const la = linesOf(a);
  const lb = linesOf(b);
  if (la.length <= 1 && lb.length <= 1) return diffText(a, b);
  const out: DiffPiece[] = [];
  const push = (type: DiffPiece["type"], text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  const words = (x: string, y: string) => {
    for (const p of diffText(x, y)) push(p.type, p.text);
  };
  let went = "";
  let came = "";
  let paired: [string, string][] = [];
  const flush = () => {
    words(went, came);
    went = came = "";
    if (!paired.length) return;
    const whole = diffText(paired.map((p) => p[0]).join(""), paired.map((p) => p[1]).join(""));
    if (whole.every((p) => p.type === "same" || !p.text.includes("\n"))) for (const p of whole) push(p.type, p.text);
    else for (const [x, y] of paired) words(x, y);
    paired = [];
  };
  for (const s of pairLines(la.map(bare), lb.map(bare))) {
    if (s.kind === "removed") went += la[s.a];
    else if (s.kind === "added") came += lb[s.b];
    else if (s.kind === "pair") paired.push([la[s.a], lb[s.b]]);
    else {
      flush();
      const x = la[s.a];
      const y = lb[s.b];
      push("same", bare(x));
      if (x.length > y.length) push("removed", "\n");
      else if (y.length > x.length) push("added", "\n");
      else if (x.endsWith("\n")) push("same", "\n");
    }
  }
  flush();
  return out;
}
