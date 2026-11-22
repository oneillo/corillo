// A comment never ends up on words it wasn't on. Random documents, written
// from a few words and phrases that come back again and again, and random
// edits made through an agent's real tools, with fixed seeds so a failure
// always comes back the same. After each edit, each comment is placed the way
// the window places it from what's stored, and must be on its words where
// they are now, on the words the edit put in where it touched them, on the
// empty line where its words were, or say its text has changed. A comment the
// edit didn't touch must be on its words exactly.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AgentService, noHooks, type AgentDoc, type AgentHost } from "../../src/main/agents/agent-service";
import { CommentService } from "../../src/main/comment-service";
import { DocumentStore } from "../../src/main/store";
import type { Thread } from "../../src/core/comments";
import { anchorFor, findAnchor, locate, offsetAt, posAt, textIndex } from "../../src/core/anchors";
import { parseMarkdown } from "../../src/core/markdown";

function random(seed: number) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
  const below = (n: number) => Math.floor(rnd() * n);
  return { rnd, pick, below };
}

const WORDS = ["the", "board", "team", "budget", "plan", "we", "will", "hire", "two", "people", "in", "may", "next", "quarter", "review", "it", "is", "tight", "goes", "to", "for", "and", "report", "this", "year", "meets", "sent", "directors", "week", "money", "short", "looks", "at", "spending", "every", "month"];
const PHRASES = ["the board", "hire two people", "the budget is tight", "next quarter", "in may", "the report goes to the board", "every month", "the team"];

/** Stands in for the window and the files: only what an agent's edits need. */
class Files implements AgentHost {
  files = new Map<string, string>();
  docs: AgentDoc[] = [];
  picturesWait(): void {}
  find(p: string) {
    return this.docs.find((d) => d.filePath === p) ?? null;
  }
  open(p: string) {
    const doc = { id: `tab-${this.docs.length + 1}`, storeId: path.basename(p, ".md"), filePath: p };
    this.docs.push(doc);
    return doc;
  }
  openDocs() {
    return this.docs;
  }
  byStoreId(storeId: string) {
    return this.docs.find((d) => d.storeId === storeId) ?? null;
  }
  read(doc: AgentDoc) {
    return this.files.get(doc.filePath)!;
  }
  write(doc: AgentDoc, text: string) {
    this.files.set(doc.filePath, text);
  }
  create(p: string, text: string) {
    this.files.set(p, text);
  }
  async flush() {
    return "saved" as const;
  }
  announce() {}
  backToYou() {}
  kindOf(p: string) {
    return this.files.has(p) ? ("file" as const) : null;
  }
  async exportDocument(): Promise<{ outputPath: string; notes: string[] }> {
    throw new Error("not here");
  }
}

type Place = { kind: "words"; start: number; end: number } | { kind: "gap"; at: number } | { kind: "detached" };

/**
 * Where the window shows a comment, from what's stored, in the plain text of
 * the document. A comment whose words were deleted is checked at its empty
 * line: whether the very same words found elsewhere bring it back is the
 * window's own rule (findText, in comments-panel-places.ts), outside what's tested here.
 */
function placed(markdown: string, t: Thread): Place {
  const doc = parseMarkdown(markdown).doc;
  const index = textIndex(doc);
  if (t.gap) {
    const at = locate(index.text, t.gap);
    return at ? { kind: "gap", at: at.start } : { kind: "detached" };
  }
  const range = t.anchor ? findAnchor(doc, t.anchor, index) : null;
  if (range) return { kind: "words", start: offsetAt(index, range.from), end: offsetAt(index, range.to) };
  return { kind: "detached" };
}

const isLetter = (c: string | undefined) => !!c && /[A-Za-z]/.test(c);

/** What one edit changed, as one stretch, and how far the stretch could slide (the same words written twice). */
function changedStretch(before: string, after: string) {
  const shortest = Math.min(before.length, after.length);
  let head = 0;
  while (head < shortest && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < shortest && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  // From as far left as it can start (all the tail kept) to as far right as it can end (all the head kept).
  let lo = Math.min(head, shortest - tail);
  let hiOld = before.length - Math.min(tail, shortest - head);
  // Whole words: the comparison is by word.
  while (lo > 0 && isLetter(before[lo - 1])) lo--;
  while (hiOld < before.length && isLetter(before[hiOld])) hiOld++;
  const shift = after.length - before.length;
  return { lo, hiOld, hiNew: hiOld + shift, shift };
}

function sentence(r: ReturnType<typeof random>): string {
  const parts = Array.from({ length: 3 + r.below(6) }, () => (r.rnd() < 0.35 ? r.pick(PHRASES) : r.pick(WORDS)));
  const s = parts.join(" ");
  return s[0].toUpperCase() + s.slice(1) + ".";
}
const paragraph = (r: ReturnType<typeof random>) => Array.from({ length: 1 + r.below(3) }, () => sentence(r)).join(" ");
const someWords = (r: ReturnType<typeof random>) => Array.from({ length: 1 + r.below(4) }, () => (r.rnd() < 0.3 ? r.pick(PHRASES) : r.pick(WORDS))).join(" ");
const wordsOf = (p: string) => [...p.matchAll(/[A-Za-z]+/g)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
const sentencesOf = (p: string) => [...p.matchAll(/\S[^.]*\./g)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }));

interface Edit {
  paras: string[];
  what: string;
  /** A paragraph moved from one place to another. */
  move?: { from: number; to: number };
}

/** One random edit, most often in the paragraph `near`. */
function edit(paras: string[], near: number, r: ReturnType<typeof random>): Edit {
  const out = [...paras];
  const k = r.rnd() < 0.6 && near < out.length ? near : r.below(out.length);
  const p = out[k];
  const words = wordsOf(p);
  if (!words.length) {
    out[k] = sentence(r);
    return { paras: out, what: `wrote paragraph ${k} again` };
  }
  const kind = r.below(11);
  const span = () => {
    const i = r.below(words.length);
    const j = Math.min(words.length - 1, i + r.below(4));
    return { start: words[i].start, end: words[j].end };
  };
  if (kind === 0 || kind === 1) {
    const { start, end } = span();
    out[k] = p.slice(0, start) + someWords(r) + p.slice(end);
    return { paras: out, what: `replaced words in paragraph ${k}` };
  }
  if (kind === 2) {
    let { start, end } = span();
    if (p[start - 1] === " ") start--;
    else if (p[end] === " ") end++;
    out[k] = p.slice(0, start) + p.slice(end);
    return { paras: out, what: `deleted words in paragraph ${k}` };
  }
  if (kind === 3) {
    const at = r.rnd() < 0.2 ? p.length - 1 : words[r.below(words.length)].start;
    out[k] = at === p.length - 1 ? p.slice(0, at) + " " + someWords(r) + p.slice(at) : p.slice(0, at) + someWords(r) + " " + p.slice(at);
    return { paras: out, what: `put words into paragraph ${k}` };
  }
  const sentences = sentencesOf(p);
  if (kind === 4) {
    const s = r.pick(sentences);
    out[k] = p.slice(0, s.start) + sentence(r) + p.slice(s.end);
    return { paras: out, what: `rewrote a sentence in paragraph ${k}` };
  }
  if (kind === 5 && sentences.length > 1) {
    let { start, end } = r.pick(sentences);
    if (p[start - 1] === " ") start--;
    else if (p[end] === " ") end++;
    out[k] = p.slice(0, start) + p.slice(end);
    return { paras: out, what: `deleted a sentence in paragraph ${k}` };
  }
  if (kind === 6) {
    out[k] = paragraph(r);
    return { paras: out, what: `rewrote paragraph ${k}` };
  }
  if (kind === 7 && out.length > 2) {
    out.splice(k, 1);
    return { paras: out, what: `deleted paragraph ${k}` };
  }
  if (kind === 8) {
    const at = r.below(out.length + 1);
    out.splice(at, 0, paragraph(r));
    return { paras: out, what: `put a new paragraph at ${at}` };
  }
  if (kind === 9 && out.length > 1) {
    const [moved] = out.splice(k, 1);
    let to = r.below(out.length + 1);
    if (to === k) to = (to + 1) % (out.length + 1);
    out.splice(to, 0, moved);
    return { paras: out, what: `moved paragraph ${k} to ${to}`, move: { from: k, to } };
  }
  if (kind === 10 && k + 1 < out.length) {
    out.splice(k, 2, `${out[k]} ${out[k + 1]}`);
    return { paras: out, what: `joined paragraphs ${k} and ${k + 1}` };
  }
  if (sentences.length > 1) {
    const s = sentences[r.below(sentences.length - 1)];
    out.splice(k, 1, p.slice(0, s.end), p.slice(s.end + 1));
    return { paras: out, what: `split paragraph ${k}` };
  }
  out[k] = p.slice(0, p.length - 1) + " " + someWords(r) + ".";
  return { paras: out, what: `added words at the end of paragraph ${k}` };
}

const starts = (paras: string[]) => {
  const at: number[] = [];
  let n = 0;
  for (const p of paras) {
    at.push(n);
    n += p.length + 1;
  }
  return at;
};

/** Why a comment's place after an edit is wrong, or null when it's right. */
function wrongPlace(was: { start: number; end: number }, now: Place, before: string, after: string, e: Edit, oldParas: string[]): string | null {
  const show = (p: Place) =>
    p.kind === "words" ? `on "${after.slice(p.start, p.end)}" at ${p.start}` : p.kind === "gap" ? `an empty line at ${p.at}` : "its text has changed";
  if (e.move) {
    // Which paragraphs it was in, and where they are now: from its first words to its last
    // (a paragraph moved in among them joins them, as words put in among them do).
    const old = starts(oldParas);
    const paragraphAt = (offset: number) => {
      let k = old.length - 1;
      while (old[k] > offset) k--;
      return k;
    };
    const first = paragraphAt(was.start);
    const last = paragraphAt(was.end);
    const order = oldParas.map((_, i) => i);
    const [moved] = order.splice(e.move.from, 1);
    order.splice(e.move.to, 0, moved);
    const [nowFirst, nowLast] = [order.indexOf(first), order.indexOf(last)];
    const at = starts(e.paras);
    const s = at[nowFirst] + was.start - old[first];
    const end = at[nowLast] + was.end - old[last];
    if (nowFirst <= nowLast && now.kind === "words" && now.start === s && now.end === end) return null;
    // A paragraph that moved, or one the moved one passed, may also say its text has changed: the comparison can't tell which moved.
    const shifted = nowFirst !== first || nowLast !== last;
    if (shifted && now.kind !== "words") return null;
    return `should be on "${after.slice(s, end)}" at ${s}, but is ${show(now)}`;
  }
  const { lo, hiOld, hiNew, shift } = changedStretch(before, after);
  const touched = was.start <= hiOld && was.end >= lo;
  if (!touched) {
    const s = was.start < lo ? was.start : was.start + shift;
    const end = was.start < lo ? was.end : was.end + shift;
    if (now.kind === "words" && now.start === s && now.end === end) return null;
    return `untouched, should be on "${after.slice(s, end)}" at ${s}, but is ${show(now)}`;
  }
  // On what's left of its words and what the edit put in, nothing further.
  const from = Math.min(was.start, lo);
  const to = Math.max(was.end >= hiOld ? was.end + shift : hiNew, hiNew);
  if (now.kind === "detached") return null;
  if (now.kind === "gap") return now.at >= from && now.at <= to ? null : `an empty line at ${now.at}, outside ${from}-${to}`;
  if (now.start >= from && now.end <= to && now.end > now.start) return null;
  return `${show(now)}, outside its words and the edit's (${from}-${to}: "${after.slice(from, to)}")`;
}

/**
 * Two or three paragraphs each reworded in place, the one at `near` and
 * often its neighbours, for one call with an exact edit each. Null when one
 * of them isn't written once in the document, so an edit couldn't name it.
 */
function reworded(paras: string[], near: number, r: ReturnType<typeof random>): (Edit & { changed: number[] }) | null {
  const out = [...paras];
  const picked = new Set([near]);
  for (let tries = 0; picked.size < Math.min(paras.length, 2 + r.below(2)) && tries < 10; tries++) {
    const k = r.rnd() < 0.6 ? near + (r.rnd() < 0.5 ? -1 : 1) : r.below(paras.length);
    if (k >= 0 && k < paras.length) picked.add(k);
  }
  const text = paras.join("\n");
  const changed = [...picked].sort((a, b) => a - b).filter((k) => {
    if (text.split(paras[k]).length !== 2) return false;
    for (let tries = 0; tries < 5 && out[k] === paras[k]; tries++) {
      const one = edit([paras[k]], 0, r).paras;
      if (one.length === 1) out[k] = one[0];
    }
    return out[k] !== paras[k];
  });
  if (changed.length < 2) return null;
  if (changed.some((k) => text.split(paras[k]).length !== 2)) return null;
  return { paras: out, what: `reworded paragraphs ${changed.join(", ")} in one call`, changed };
}

/**
 * Why a comment's place after paragraphs were each reworded in place is
 * wrong, or null when it's right: judged within the paragraphs it is in, as
 * for one edit; on its words exactly where none of them changed.
 */
function wrongInParagraphs(was: { start: number; end: number }, now: Place, oldParas: string[], newParas: string[]): string | null {
  const [old, at] = [starts(oldParas), starts(newParas)];
  const paragraphAt = (offset: number) => {
    let k = old.length - 1;
    while (old[k] > offset) k--;
    return k;
  };
  const [first, last] = [paragraphAt(was.start), paragraphAt(was.end)];
  const local = (ps: string[]) => ps.slice(first, last + 1).join("\n");
  const shift = at[first] - old[first];
  const here: Place = now.kind === "words" ? { kind: "words", start: now.start - at[first], end: now.end - at[first] } : now.kind === "gap" ? { kind: "gap", at: now.at - at[first] } : now;
  const wrong = wrongPlace({ start: was.start - old[first], end: was.end - old[first] }, here, local(oldParas), local(newParas), { paras: [], what: "" }, []);
  return wrong && `${wrong} (in paragraphs ${first} to ${last}, which moved by ${shift})`;
}

describe("a comment never ends up on words it wasn't on", () => {
  const data = mkdtempSync(path.join(tmpdir(), "corillo-follow-fuzz-"));
  afterAll(() => rmSync(data, { recursive: true, force: true }));

  it("through random agent edits of documents that repeat their words", async () => {
    const person = { kind: "person" } as const;
    const failures: string[] = [];
    let checked = 0;
    let touched = 0;
    /** Comments checked after a call that reworded several paragraphs. */
    let afterSeveral = 0;

    for (let seed = 1; seed <= 250; seed++) {
      // Each case on its own, as if Corillo had just started.
      const files = new Files();
      const comments = new CommentService(new DocumentStore(path.join(data, String(seed))), () => {});
      const service = new AgentService(files, comments, noHooks, { waitMs: 0 });
      const { sessionId } = service.connect({ name: "claude-code" });
      const call = async (tool: string, args: Record<string, unknown>) => {
        const result = await service.call(sessionId, tool, args);
        if (result.isError) throw new Error(`${tool}: ${result.text}`);
        return result.text;
      };
      const r = random(seed);
      const file = `/docs/case-${seed}.md`;
      const storeId = `case-${seed}`;
      let paras = Array.from({ length: 3 + r.below(4) }, () => paragraph(r));
      const markdownOf = (ps: string[]) => ps.join("\n\n") + "\n";
      files.files.set(file, markdownOf(paras));
      await call("open_document", { path: file });

      // Two comments: a few words, a sentence or a whole paragraph.
      const doc = parseMarkdown(markdownOf(paras)).doc;
      const index = textIndex(doc);
      expect(index.text).toBe(paras.join("\n"));
      const at = starts(paras);
      const watched = new Map<string, { start: number; end: number }>();
      let near = 0;
      for (let c = 0; c < 2; c++) {
        const k = r.below(paras.length);
        near = k;
        const p = paras[k];
        const choice = r.rnd();
        let range: { start: number; end: number };
        if (choice < 0.7) {
          const words = wordsOf(p);
          const i = r.below(words.length);
          const j = Math.min(words.length - 1, i + r.below(3));
          range = { start: words[i].start, end: words[j].end };
        } else if (choice < 0.85) range = r.pick(sentencesOf(p));
        else range = { start: 0, end: p.length };
        const start = at[k] + range.start;
        const end = at[k] + range.end;
        const anchor = anchorFor(doc, posAt(index, start, "start"), posAt(index, end, "end"), index);
        const t = comments.add(storeId, person, `Comment ${c}.`, anchor, null);
        watched.set(t.id, { start, end });
      }

      await call("take_document", { path: file });
      for (let step = 0, steps = 1 + r.below(3); step < steps && watched.size; step++) {
        // Most edits near a comment.
        const target = [...watched.values()][r.below(watched.size)].start;
        const at = starts(paras);
        for (near = at.length - 1; at[near] > target; ) near--;
        // Some calls change a few paragraphs at once, with an exact edit each; the rest send the whole text.
        const several = paras.length > 1 && r.rnd() < 0.35 ? reworded(paras, near, r) : null;
        const e = several ?? edit(paras, near, r);
        if (e.paras.join("\n") === paras.join("\n")) continue;
        const before = paras.join("\n");
        const after = e.paras.join("\n");
        const ids = r.rnd() < 0.5 ? [...watched.keys()].map((id) => id.slice(0, 8)) : undefined;
        if (several) {
          const edits = several.changed.map((k) => ({ find: paras[k], replace: e.paras[k], ...(ids ? { comment_ids: [r.pick(ids)] } : {}) }));
          await call("edit_document", { path: file, edits });
        } else await call("replace_document", { path: file, text: markdownOf(e.paras), ...(ids ? { comment_ids: ids } : {}) });
        const markdown = files.files.get(file)!;
        expect(markdown).toBe(markdownOf(e.paras));
        for (const [id, was] of watched) {
          const t = comments.threads(storeId).find((x) => x.id === id)!;
          const now = placed(markdown, t);
          checked++;
          if (several) afterSeveral++;
          const wrong = several ? wrongInParagraphs(was, now, paras, e.paras) : wrongPlace(was, now, before, after, e, paras);
          if (wrong) {
            const stored = `stored: ${t.detached ? "detached, " : ""}${t.gap ? `gap at ${t.gap.offset}, ` : ""}"${t.anchor!.quote}" at ${t.anchor!.offset}`;
            failures.push(`seed ${seed}, step ${step} (${e.what}): comment on "${before.slice(was.start, was.end)}" at ${was.start}: ${wrong} (${stored})\n  before: ${before}\n  after:  ${after}`);
            watched.delete(id);
          } else if (now.kind === "words") {
            if (now.start !== was.start || now.end !== was.end || before.slice(was.start, was.end) !== after.slice(now.start, now.end)) touched++;
            watched.set(id, { start: now.start, end: now.end });
          } else watched.delete(id); // Its words went: nothing more to follow.
        }
        paras = e.paras;
      }
      // (Twice: the comments aren't answered, so the first call asks about them.)
      if ((await service.call(sessionId, "finish_editing", { path: file })).isError) await call("finish_editing", { path: file });
      service.disconnect(sessionId);
    }
    expect(failures.slice(0, 5).join("\n\n")).toBe("");
    // The cases reach far enough: many comments checked, and many moved or changed with their words.
    expect(checked).toBeGreaterThan(800);
    expect(touched).toBeGreaterThan(100);
    expect(afterSeveral).toBeGreaterThan(250);
  }, 60_000);
});

// R-4: the documents above are long paragraphs, changed one edit at a time.
// Lists and tables hold short values that repeat, and an agent often changes
// several in one call. Through the whole text, each change puts other words
// on one line, so a comment belongs on its own line afterwards, whatever that
// line reads now; saying its text has changed is allowed too. By exact edits,
// rows are also put in and taken out, whole lines with their line breaks,
// often a copy of the row beside them, and the commented value may be written
// more than once (B8R-3): the comment stays in its own row, and on its words
// exactly when no edit took in its row.
const VALUES = ["1 June", "15 June", "29 June", "1 July", "15 July", "Done", "Open", "Blocked", "Yes", "No", "Q1", "Q2", "Q3", "1,200", "800", "Ana", "Ben", "Cleo"];

/** A list, or a table of one or two columns: the lines above its rows, how many values a row holds, and a row's line. Each value is a line of the document's words. */
interface Shape {
  head: string[];
  per: number;
  row: (values: string[]) => string;
}
const SHAPES: Shape[] = [
  { head: [], per: 1, row: ([v]) => `- ${v}` },
  { head: ["| Value |", "| --- |"], per: 1, row: ([v]) => `| ${v} |` },
  { head: ["| First | Second |", "| --- | --- |"], per: 2, row: ([a, b]) => `| ${a} | ${b} |` },
];
const rowsOf = (values: string[], per: number) => Array.from({ length: values.length / per }, (_, k) => values.slice(k * per, k * per + per));
const written = (shape: Shape, rows: string[][]) => [...shape.head, ...rows.map(shape.row)].join("\n") + "\n";

interface Span {
  /** Lines i0 to i1 (not included) of the older text, and j0 to j1 of the newer. */
  i0: number;
  i1: number;
  j0: number;
  j1: number;
  /** Whether the edit takes in its last line break. */
  breaks: boolean;
}

/**
 * Exact edits from one text to another, `was[j]` being the line of the older
 * text that line j of the newer one was (-1 for a line put in). Each edit
 * changes a run of lines between lines kept as they were: whole lines with
 * their line breaks, or, for lines changed in place, half the time without
 * the last one. A line put in is given with the line above or below it. Each
 * takes in lines around it until it's written once.
 */
function exactEdits(before: string, after: string, was: number[], r: ReturnType<typeof random>): { find: string; replace: string; lines: [number, number]; now: [number, number] }[] {
  const [b, a] = [before.split("\n").slice(0, -1), after.split("\n").slice(0, -1)];
  const spans: Span[] = [];
  let [i, j] = [0, 0];
  const close = (toI: number, toJ: number) => {
    if (toI > i || toJ > j) spans.push({ i0: i, i1: toI, j0: j, j1: toJ, breaks: toI - i !== toJ - j || r.rnd() < 0.5 });
  };
  a.forEach((line, k) => {
    if (was[k] < 0 || b[was[k]] !== line) return;
    close(was[k], k);
    [i, j] = [was[k] + 1, k + 1];
  });
  close(b.length, a.length);
  const breaks = (s: Span) => s.breaks || s.i1 - s.i0 !== s.j1 - s.j0;
  const text = (lines: string[], from: number, to: number, s: Span) => lines.slice(from, to).join("\n") + (breaks(s) && to > from ? "\n" : "");
  const once = (s: Span) => {
    const find = text(b, s.i0, s.i1, s);
    return s.i1 > s.i0 && before.indexOf(find, before.indexOf(find) + 1) < 0;
  };
  for (let k = 0; k < spans.length; k++) {
    const s = spans[k];
    // A line put in goes with the line above or below it; then more lines until it's written once. Edits that meet are one.
    let down = s.i0 === s.i1 ? s.i0 === 0 || (s.i1 < b.length && r.rnd() < 0.5) : true;
    while (!once(s)) {
      if (down && s.i1 < b.length) {
        const next = spans[k + 1];
        if (next && next.i0 === s.i1) {
          Object.assign(s, { i1: next.i1, j1: next.j1, breaks: s.breaks || next.breaks });
          spans.splice(k + 1, 1);
        } else [s.i1, s.j1] = [s.i1 + 1, s.j1 + 1];
      } else {
        const prev = spans[k - 1];
        if (prev && prev.i1 === s.i0) {
          Object.assign(prev, { i1: s.i1, j1: s.j1, breaks: s.breaks || prev.breaks });
          spans.splice(k--, 1);
          break; // (prev was written once already: so is it with more lines.)
        }
        [s.i0, s.j0] = [s.i0 - 1, s.j0 - 1];
      }
      down = true;
    }
  }
  return spans.map((s) => ({ find: text(b, s.i0, s.i1, s), replace: text(a, s.j0, s.j1, s), lines: [s.i0, s.i1 - 1], now: [s.j0, s.j1 - 1] }));
}

describe("a comment stays on its own line when an agent changes several short lines in one call (R-4)", () => {
  const data = mkdtempSync(path.join(tmpdir(), "corillo-follow-lines-"));
  afterAll(() => rmSync(data, { recursive: true, force: true }));

  it("in random lists and tables, by exact edits or the whole text", async () => {
    const failures: string[] = [];
    let checked = 0;
    /** Exact edits that put in or took out a row, and of those, ones where the commented row has a twin. */
    let reshaped = 0;
    let twinned = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const r = random(seed);
      const shape = SHAPES[seed % SHAPES.length];
      const { per, head } = shape;
      const count = 2 * (3 + r.below(5));
      const values = Array.from({ length: count }, () => r.pick(VALUES));
      const L = r.below(count);
      const exact = seed % 2 === 0;
      // Through the whole text, the commented value is written once, so there's no doubt which words the comment is on.
      if (!exact && values.filter((v) => v === values[L]).length !== 1) continue;
      const own = Math.floor(L / per);
      // By exact edits, often with a twin of the commented row right beside it.
      const twin = exact && r.rnd() < 0.4 ? own + (r.rnd() < 0.5 ? -1 : 1) : -1;
      if (twin >= 0 && twin < count / per) for (let c = 0; c < per; c++) values[twin * per + c] = values[own * per + c];
      const before = written(shape, rowsOf(values, per));
      let after: string;
      let rows = rowsOf(values, per).map((vals, id) => ({ vals, id }));
      if (exact) {
        // Often first a whole row beside the commented one: its twin taken out, or a copy of it put in.
        if (r.rnd() < 0.5) {
          const here = rows.findIndex((x) => x.id === own);
          const beside = [here - 1, here + 1].find((t) => rows[t] && rows[t].vals.join() === rows[here].vals.join());
          if (beside !== undefined && r.rnd() < 0.5) rows.splice(beside, 1);
          else rows.splice(here + r.below(2), 0, { vals: [...rows[here].vals], id: -1 });
        }
        for (let c = 0, changes = 1 + r.below(3); c < changes; c++) {
          // Most changes beside the commented row: a value changed, a row put in (often a copy of its neighbour), a row taken out.
          const here = rows.findIndex((x) => x.id === own);
          const k = r.rnd() < 0.6 ? Math.max(0, Math.min(rows.length - 1, here + r.below(3) - 1)) : r.below(rows.length);
          const kind = r.below(3);
          if (kind === 0) {
            const vals = [...rows[k].vals];
            vals[r.below(per)] = r.pick(VALUES);
            rows[k] = { vals, id: rows[k].id };
          } else if (kind === 1) {
            rows.splice(k + r.below(2), 0, { vals: r.rnd() < 0.6 ? [...rows[k].vals] : Array.from({ length: per }, () => r.pick(VALUES)), id: -1 });
          } else if (rows.length > 2 && rows[k].id !== own) rows.splice(k, 1);
        }
        after = written(shape, rows.map((x) => x.vals));
      } else {
        const changed = [...values];
        for (let c = 0, changes = 2 + r.below(2); c < changes; c++) changed[r.below(count)] = r.pick(VALUES);
        after = written(shape, rowsOf(changed, per));
        rows = rowsOf(changed, per).map((vals, id) => ({ vals, id }));
      }
      if (after === before) continue;

      const files = new Files();
      const file = `/docs/case-${seed}.md`;
      const storeId = `case-${seed}`;
      files.files.set(file, before);
      const comments = new CommentService(new DocumentStore(path.join(data, String(seed))), () => {});
      const service = new AgentService(files, comments, noHooks, { waitMs: 0 });
      const { sessionId } = service.connect({ name: "claude-code" });
      const call = async (tool: string, args: Record<string, unknown>) => {
        const result = await service.call(sessionId, tool, args);
        if (result.isError) throw new Error(`${tool}: ${result.text}`);
        return result.text;
      };
      await call("open_document", { path: file });
      const doc = parseMarkdown(before).doc;
      const index = textIndex(doc);
      /** Which line of the document's words an offset is on, and where a row's value is (a table's head row is words too). */
      const lineOf = (text: string, offset: number) => text.slice(0, offset).split("\n").length - 1;
      const wordsLine = (row: number, cell: number) => (head.length ? per : 0) + row * per + cell;
      const line = wordsLine(own, L % per);
      expect(index.text.split("\n")[line]).toBe(values[L]);
      const start = index.text.split("\n").slice(0, line).join("\n").length + (line ? 1 : 0);
      const asked = comments.add(storeId, { kind: "person" }, "Is this right?", anchorFor(doc, posAt(index, start, "start"), posAt(index, start + values[L].length, "end"), index), null);

      await call("take_document", { path: file });
      const mdLine = head.length + own;
      /** For each line of the newer Markdown, the line of the older it was (-1 for a row put in). */
      const was = [...head.map((_, k) => k), ...rows.map((x) => (x.id < 0 ? -1 : head.length + x.id))];
      let edits: ReturnType<typeof exactEdits> = [];
      if (exact) {
        edits = exactEdits(before, after, was, r);
        await call("edit_document", {
          path: file,
          edits: edits.map(({ find, replace, lines: [x, y] }) => ({ find, replace, ...(x <= mdLine && mdLine <= y && r.rnd() < 0.5 ? { comment_ids: [asked.id.slice(0, 8)] } : {}) })),
        });
      } else await call("replace_document", { path: file, text: after });
      expect(files.files.get(file)).toBe(after);
      const now = comments.threads(storeId).find((t) => t.id === asked.id)!;
      checked++;
      const ownNow = rows.findIndex((x) => x.id === own);
      const [oldLines, newLines] = [before.split("\n"), after.split("\n")];
      const ownLine = newLines[head.length + ownNow];
      if (exact && (rows.length !== count / per || was.includes(-1))) {
        reshaped++;
        if (newLines.filter((l) => l === ownLine).length > 1 || oldLines.filter((l) => l === oldLines[mdLine]).length > 1) twinned++;
      }
      const said = () => `\n  before: ${before.trimEnd().split("\n").join(" / ")}\n  after:  ${after.trimEnd().split("\n").join(" / ")}${edits.length ? `\n  edits:  ${JSON.stringify(edits.map(({ find, replace }) => [find, replace]))}` : ""}`;
      const where = `seed ${seed} (${exact ? "exact edits" : "whole text"}): the comment on "${values[L]}" (words line ${line})`;
      if (!exact) {
        // Through the whole text, a guess may say its text has changed.
        if (!now.detached && !now.gap && now.anchor) {
          const is = lineOf(textIndex(parseMarkdown(after).doc).text, now.anchor.offset);
          if (is !== line) failures.push(`${where} is now on "${now.anchor.quote}" (line ${is})${said()}`);
        }
      } else {
        // By exact edits: on its words exactly when no edit took in its row. Where one did and only changed rows in
        // place, in its own row (or a copy of it the edit wrote), or saying its text has changed; and where its row
        // reads otherwise now, on a row an edit wrote that reads as its row did (moved there, B8R-1). Where that edit
        // also put in or took out rows, or wrote one of its rows at another of its places, which of its rows is which
        // is a guess: anywhere in what it wrote, or deleted.
        const took = edits.find(({ lines: [x, y] }) => x <= mdLine && mdLine <= y);
        const inPlace =
          !took ||
          (took.now[1] - took.now[0] === took.lines[1] - took.lines[0] &&
            was.slice(took.now[0], took.now[1] + 1).every((w, k) => w === took.lines[0] + k) &&
            newLines.slice(took.now[0], took.now[1] + 1).every((l, k) => oldLines.slice(took.lines[0], took.lines[1] + 1).every((o, k2) => k === k2 || o !== l)));
        /** Where line m of the newer Markdown starts in its words, by lines (a table's head row is words, its dashes aren't). */
        const cellsBefore = (m: number) => (head.length && m >= 1 ? per : 0) + Math.max(0, m - head.length) * per;
        const rowsOk = [head.length + ownNow];
        if (took) for (let m = took.now[0]; m <= took.now[1]; m++) if (newLines[m] === ownLine) rowsOk.push(m);
        if (took && (!inPlace || ownLine !== oldLines[mdLine])) for (const e of edits) for (let m = e.now[0]; m <= e.now[1]; m++) if (newLines[m] === oldLines[mdLine]) rowsOk.push(m);
        // (Its own words written in another cell of its row, by the edit that rewrote the row, are its words too.)
        const ok = rowsOk.flatMap((m) => Array.from({ length: per }, (_, c) => c).filter((c) => c === L % per || (took && now.anchor?.quote === values[L])).map((c) => wordsLine(m - head.length, c)));
        if (now.gap) {
          if (inPlace) failures.push(`${where} says its text was deleted${said()}`);
        } else if (now.detached) {
          if (!took) failures.push(`${where} says its text has changed, though no edit took in its row${said()}`);
        } else if (now.anchor) {
          const words = textIndex(parseMarkdown(after).doc).text;
          const [is, last] = [lineOf(words, now.anchor.offset), lineOf(words, now.anchor.offset + now.anchor.quote.length)];
          const inEdit = !!took && cellsBefore(took.now[0]) <= is && last < cellsBefore(took.now[1] + 1);
          if (!(ok.includes(is) && last === is) && !(inEdit && !inPlace)) failures.push(`${where} is now on "${now.anchor.quote}" (line ${is}), not line ${ok[0]}${said()}`);
          else if (!took && now.anchor.quote !== values[L]) failures.push(`${where} is now on "${now.anchor.quote}", though no edit took in its row${said()}`);
        }
      }
      service.disconnect(sessionId);
    }
    expect(failures.slice(0, 5).join("\n\n")).toBe("");
    expect(checked).toBeGreaterThan(200);
    expect(reshaped).toBeGreaterThan(100);
    expect(twinned).toBeGreaterThan(60);
  }, 60_000);
});
