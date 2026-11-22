// Show changes, since the person handed the document over (roadmap Batch 3,
// item 1): where the hand-over is, what happened since, and what's marked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VersionHistory } from "../../src/main/version-store";
import { addThread, setResolved, type Author } from "../../src/core/comments";
import { handOverIndex, handedOverAt, type Version } from "../../src/core/versions";
import { extentOf, freshWords, marksSince, positionsOf, rebase, type Step } from "../../src/core/since-hand-over";
import { diffDocs, PICTURE_STAND_IN as OBJECT } from "../../src/core/doc-diff";
import { parseMarkdown } from "../../src/core/markdown";
import { textIndex } from "../../src/core/anchors";

const me: Author = { kind: "person" };
const claude: Author = { kind: "agent", name: "Claude" };

const folders: string[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true });
});

/** A throwaway data folder and document; the clock moves by hand, comments' and versions' alike. */
function setup(text = "# Plan\n\nThe cat sat.\n\nThe dog ran.\n") {
  const data = mkdtempSync(join(tmpdir(), "corillo-since-"));
  const docs = mkdtempSync(join(tmpdir(), "corillo-since-docs-"));
  folders.push(data, docs);
  const file = join(docs, "plan.md");
  writeFileSync(file, text);
  const h = new VersionHistory(data, () => new Date());
  const id = h.idFor(file);
  h.seen(id, text);
  const later = (minutes = 1) => vi.setSystemTime(new Date(Date.now() + minutes * 60_000));
  const pass = (agent: string, ...texts: string[]) => {
    later();
    h.beginPass(id, agent);
    for (const t of texts) {
      later();
      h.edited(id, t);
    }
    later();
    h.endPass(id);
  };
  return { h, id, later, pass };
}

describe("the hand-over: when an agent takes the document from the person", () => {
  it("the first agent's pass takes it; one after it with only reading between is the same round", () => {
    const { h, id, pass } = setup();
    pass("Claude", "# Plan\n\nThe lion sat.\n\nThe dog ran.\n");
    pass("Writer", "# Plan\n\nThe lion sat.\n\nThe dog slept.\n");
    const [, first, second] = h.list(id);
    expect(first.handedOver).toBe(true);
    expect(second.handedOver).toBe(false);
    expect(first.taken && first.ended && first.taken < first.ended).toBe(true);
    const since = h.sinceHandOver(id);
    expect(since.at).toBe(first.taken);
    expect(since.base).toBe("# Plan\n\nThe cat sat.\n\nThe dog ran.\n");
    expect(since.agents).toEqual(["Claude", "Writer"]);
    expect(since.steps).toEqual([{ yours: false, text: "# Plan\n\nThe lion sat.\n\nThe dog slept.\n" }]);
  });

  it("the person editing between two passes hands it over again: only the later pass is since", () => {
    const { h, id, pass, later } = setup();
    pass("Claude", "# Plan\n\nThe lion sat.\n\nThe dog ran.\n");
    later();
    h.edited(id, "# Plan\n\nThe lion sat down.\n\nThe dog ran.\n");
    pass("Writer", "# Plan\n\nThe lion sat down.\n\nThe dog slept.\n");
    expect(h.list(id).map((v) => v.handedOver)).toEqual([undefined, true, undefined, true]);
    const since = h.sinceHandOver(id);
    expect(since.base).toBe("# Plan\n\nThe lion sat down.\n\nThe dog ran.\n");
    expect(since.agents).toEqual(["Writer"]);
  });

  it("a comment the person writes, edits or resolves after a pass hands it over again; an agent's doesn't", () => {
    const { h, id, pass, later } = setup();
    pass("Claude", "# Plan\n\nThe lion sat.\n\nThe dog ran.\n");
    later();
    const { threads, thread } = addThread([], claude, "I changed the cat.", null, null);
    h.writeComments(id, threads);
    pass("Writer", "# Plan\n\nThe lion sat.\n\nThe dog slept.\n");
    expect(h.list(id)[2].handedOver).toBe(false); // only an agent's comment between

    later();
    h.writeComments(id, setResolved(threads, thread.id, me, true));
    pass("Claude", "# Plan\n\nThe lion sat.\n\nThe dog slept well.\n");
    expect(h.list(id)[3].handedOver).toBe(true); // the person resolved one

    later();
    h.writeComments(id, addThread(h.readComments(id), me, "Shorter?", null, null).threads);
    pass("Writer", "# Plan\n\nThe lion sat.\n\nThe dog slept.\n");
    expect(h.list(id)[4].handedOver).toBe(true); // the person wrote one
  });

  it("a change from another app between two passes doesn't end the round, and is counted in it", () => {
    const { h, id, pass, later } = setup();
    pass("Claude", "# Plan\n\nThe lion sat.\n\nThe dog ran.\n");
    later();
    h.outside(id, "# Plan\n\nThe lion sat.\n\nThe dog ran.\n\nFrom elsewhere.\n");
    pass("Writer", "# Plan\n\nThe lion sat.\n\nThe dog slept.\n\nFrom elsewhere.\n");
    expect(h.list(id)[3].handedOver).toBe(false);
    const since = h.sinceHandOver(id);
    expect(since.base).toBe("# Plan\n\nThe cat sat.\n\nThe dog ran.\n");
    expect(since.agents).toEqual(["Claude", "Writer"]);
    expect(since.outside).toBe(true);
  });

  it("the person's edits after the round are a step of their own", () => {
    const { h, id, pass, later } = setup();
    pass("Claude", "# Plan\n\nThe lion sat.\n\nThe dog ran.\n");
    later();
    h.edited(id, "# Plan\n\nThe lion sat.\n\nThe dog ran fast.\n");
    const since = h.sinceHandOver(id);
    expect(since.steps).toEqual([
      { yours: false, text: "# Plan\n\nThe lion sat.\n\nThe dog ran.\n" },
      { yours: true, text: "# Plan\n\nThe lion sat.\n\nThe dog ran fast.\n" },
    ]);
    expect(since.agents).toEqual(["Claude"]);
  });

  it("an agent that only replied isn't named, and nothing has changed", () => {
    const { h, id, later } = setup();
    later();
    h.beginPass(id, "Claude");
    later();
    h.endPass(id, { note: "Looks good to me." });
    const since = h.sinceHandOver(id);
    expect(since.at).not.toBeNull();
    expect(since.agents).toEqual([]);
    expect(since.base).toBe(since.text);
  });

  it("while an agent that took it hasn't changed anything yet, nothing is since; with no agent ever, there's no hand-over", () => {
    const { h, id, later } = setup();
    expect(h.sinceHandOver(id).at).toBeNull();
    later();
    h.beginPass(id, "Claude");
    const since = h.sinceHandOver(id);
    expect(since.at).toBe(new Date().toISOString());
    expect(since.base).toBe(since.text);
    expect(since.steps).toEqual([]);
  });

  it("a pass split by another app's change took the document only once", () => {
    const { h, id, later } = setup();
    later();
    h.beginPass(id, "Claude");
    h.edited(id, "# Plan\n\nThe lion sat.\n\nThe dog ran.\n");
    later();
    h.outside(id, "# Plan\n\nThe lion sat.\n\nThe dog ran.\n\nMore.\n");
    later();
    h.edited(id, "# Plan\n\nThe lion sat.\n\nThe dog slept.\n\nMore.\n");
    h.endPass(id);
    expect(h.list(id).map((v) => v.handedOver)).toEqual([undefined, true, undefined, false]);
    expect(h.sinceHandOver(id).base).toBe("# Plan\n\nThe cat sat.\n\nThe dog ran.\n");
  });

  it("in a history from before the hand-over was recorded, a pass took it unless another agent's came right before", () => {
    const v = (kind: Version["kind"], handedOver?: boolean) => ({ kind, handedOver });
    expect(handOverIndex([v("first"), v("person")])).toBe(-1);
    expect(handOverIndex([v("first"), v("agent"), v("agent")])).toBe(1);
    expect(handOverIndex([v("first"), v("agent"), v("outside"), v("agent")])).toBe(1);
    expect(handOverIndex([v("first"), v("agent"), v("person"), v("agent"), v("person")])).toBe(3);
    expect(handOverIndex([v("first"), v("agent", true), v("agent", false), v("agent", true)])).toBe(3);
  });
});

describe("handedOverAt", () => {
  const now = new Date(2026, 10, 10, 15, 0);
  it("says when, in the middle of a sentence", () => {
    expect(handedOverAt(new Date(2026, 10, 10, 10, 42).toISOString(), now, "en-US")).toBe("at 10:42 AM");
    expect(handedOverAt(new Date(2026, 10, 9, 19, 55).toISOString(), now, "en-US")).toBe("yesterday at 7:55 PM");
    expect(handedOverAt(new Date(2026, 10, 6, 9, 5).toISOString(), now, "en-US")).toBe("on Friday at 9:05 AM");
    expect(handedOverAt(new Date(2026, 10, 3, 9, 5).toISOString(), now, "en-US")).toBe("on Nov 3 at 9:05 AM");
    expect(handedOverAt(new Date(2025, 10, 3, 9, 5).toISOString(), now, "en-US")).toBe("on Nov 3, 2025 at 9:05 AM");
  });
});

/** What Show changes marks: the words put in (as they read now), the words taken out, and how many changes. */
function shown(base: string, steps: Step[]) {
  const now = steps[steps.length - 1].text;
  const { doc } = parseMarkdown(now);
  const { before, yours } = rebase(base, steps, (md) => textIndex(parseMarkdown(md).doc).text);
  const was = parseMarkdown(before).doc;
  const changes = before === now ? [] : diffDocs(was, doc);
  const marks = marksSince(doc, changes, positionsOf(textIndex(doc), yours, doc.content.size), () => freshWords(textIndex(doc), textIndex(was).text));
  const added: string[] = [];
  const removed: string[] = [];
  for (const c of marks.changes) {
    if (c.kind === "added-text" || c.kind === "added-block" || c.kind === "changed-block") added.push(doc.textBetween(c.from, c.to, " ", OBJECT).trim());
    else if (c.kind === "removed-text") removed.push(c.text.trim());
    else removed.push(c.node.textContent.trim());
  }
  return { added, removed, count: marks.count, groups: marks.groups };
}

const others = (text: string): Step => ({ yours: false, text });
const yours = (text: string): Step => ({ yours: true, text });

describe("what Show changes marks", () => {
  const base = "# Plan\n\nThe cat sat on the mat.\n\nThe dog ran fast.\n\nThe bird sang.\n";

  it("everything others changed since, each change counted once", () => {
    const s = shown(base, [others("# Plan\n\nThe lion sat on the mat.\n\nThe dog ran fast.\n\nThe bird sang loudly.\n")]);
    expect(s.added).toEqual(["lion", "loudly"]);
    expect(s.removed).toEqual(["cat"]);
    expect(s.count).toBe(2);
    expect(new Set(s.groups).size).toBe(s.count);
  });

  it("the person's edits between two others' changes aren't marked", () => {
    const s = shown(base, [
      others("# Plan\n\nThe lion sat on the mat.\n\nThe dog ran fast.\n\nThe bird sang.\n"),
      yours("# Plan\n\nThe lion sat on the mat.\n\nThe puppy ran fast.\n\nThe bird sang.\n"),
      others("# Plan\n\nThe lion sat on the mat.\n\nThe puppy ran fast.\n\nThe bird sang loudly.\n"),
    ]);
    expect(s.added).toEqual(["lion", "loudly"]);
    expect(s.removed).toEqual(["cat"]);
    expect(s.count).toBe(2);
  });

  it("the person's edit in a sentence an agent changed elsewhere isn't marked, and the agent's still is", () => {
    const s = shown(base, [
      others("# Plan\n\nThe lion sat on the mat.\n\nThe dog ran fast.\n\nThe bird sang.\n"),
      yours("# Plan\n\nThe lion sat on the rug.\n\nThe dog ran fast.\n\nThe bird sang.\n"),
    ]);
    expect(s.added).toEqual(["lion"]);
    expect(s.removed).toEqual(["cat"]);
  });

  it("the person's edit inside a passage an agent wrote isn't marked; the rest of the passage is", () => {
    const s = shown(base, [
      others("# Plan\n\nThe cat sat on the mat.\n\nA new paragraph about lions and tigers.\n\nThe dog ran fast.\n\nThe bird sang.\n"),
      yours("# Plan\n\nThe cat sat on the mat.\n\nA new paragraph about bears and tigers.\n\nThe dog ran fast.\n\nThe bird sang.\n"),
    ]);
    expect(s.added.join(" ")).not.toContain("bears");
    expect(s.added.join(" ")).toContain("A new paragraph about");
    expect(s.added.join(" ")).toContain("and tigers.");
    expect(s.count).toBe(1);
  });

  it("the person's edit to words an agent changed isn't marked as the agent's", () => {
    const s = shown(base, [
      others("# Plan\n\nThe lion sat on the mat.\n\nThe dog ran fast.\n\nThe bird sang.\n"),
      yours("# Plan\n\nThe tiger sat on the mat.\n\nThe dog ran fast.\n\nThe bird sang.\n"),
    ]);
    expect(s.added).not.toContain("tiger");
    expect(s.added.join(" ")).not.toContain("tiger");
    expect(s.count).toBe(0);
  });

  it("a passage an agent wrote that the person then deleted leaves no mark", () => {
    const s = shown(base, [
      others("# Plan\n\nThe lion sat on the mat.\n\nA new paragraph about lions.\n\nThe dog ran fast.\n\nThe bird sang.\n"),
      yours("# Plan\n\nThe lion sat on the mat.\n\nThe dog ran fast.\n\nThe bird sang.\n"),
    ]);
    expect(s.added).toEqual(["lion"]);
    expect(s.removed).toEqual(["cat"]);
    expect(s.count).toBe(1);
  });

  it("a passage an agent changed that the person then deleted isn't marked as the agent's deletion", () => {
    const s = shown(base, [
      others("# Plan\n\nThe lion sat on the mat.\n\nThe dog ran very fast.\n\nThe bird sang.\n"),
      yours("# Plan\n\nThe lion sat on the mat.\n\nThe bird sang.\n"),
    ]);
    expect(s.added).toEqual(["lion"]);
    expect(s.removed).toEqual(["cat"]);
    expect(s.count).toBe(1);
  });

  it("a passage nobody else touched that the person deleted leaves no mark", () => {
    const s = shown(base, [
      others("# Plan\n\nThe lion sat on the mat.\n\nThe dog ran fast.\n\nThe bird sang.\n"),
      yours("# Plan\n\nThe lion sat on the mat.\n\nThe bird sang.\n"),
    ]);
    expect(s.added).toEqual(["lion"]);
    expect(s.removed).toEqual(["cat"]);
  });

  it("the person's own edits alone leave nothing to mark", () => {
    const s = shown(base, [yours("# Plan\n\nThe cat sat on the rug.\n\nThe bird sang.\n")]);
    expect(s).toMatchObject({ added: [], removed: [], count: 0 });
  });

  it("a paragraph the agent edited and the person deleted isn't struck through, also when the next one starts with the same word", () => {
    const start = "The launch moves to the second week of June.\n\nThe team is small.\n\nWe meet on Friday.\n";
    const s = shown(start, [others(start.replace("second week", "third week")), yours("The crew is small.\n\nWe meet on Friday.\n")]);
    expect(s).toMatchObject({ added: [], removed: [] });
  });

  it("the person's word in the last paragraph isn't marked when another app then puts paragraphs after it", () => {
    const start = "Intro stays here.\n\nOld notes go.\n\nReview costs soon.\n";
    const s = shown(start, [
      others(start.replace("soon", "today")),
      yours(start.replace("costs soon", "prices today")),
      others("Intro stays here.\n\nReview prices today.\n\nBudget agreed.\n\nReview prices again later.\n"),
    ]);
    // Their "prices" is left alone. ("Review" beside it is still marked: a paragraph both changed, see the random rounds below.)
    expect(s.added.filter((words) => words.includes("prices today"))).toEqual([]);
    expect(s.added).toContain("Budget agreed.");
  });

  describe("where the agent cut a list in two", () => {
    const list = "- Email the members\n- Print the posters\n- Book the hall\n\nNotes follow here.\n";
    const split = "- Email the members\n\nThe rest can wait until May.\n\n- Print the posters\n- Book the hall\n\nNotes follow here.\n";

    it("only the agent's paragraph is marked", () => {
      expect(shown(list, [others(split)])).toMatchObject({ added: ["The rest can wait until May."], removed: [] });
    });

    it("the person's rewrite of a bullet below it isn't marked as the agent's", () => {
      const s = shown(list, [others(split), yours(split.replace("until May", "until June").replace("Print the posters", "Order two hundred flyers"))]);
      expect(s).toMatchObject({ added: ["The rest can wait until", "."], removed: [] });
    });

    it("the bullets below it aren't marked when the person takes back a word the agent added above", () => {
      const s = shown(list, [others(split.replace("Email the members", "Email the members today")), yours(split)]);
      expect(s).toMatchObject({ added: ["The rest can wait until May."], removed: [] });
    });
  });

  it("an inserted clause that repeats a word next to it is marked as one, also with the person's edits elsewhere", () => {
    const before = "# Plan\n\nRequests reach us through four inboxes and two group chats.\n\nThe bird sang.\n";
    const after = "# Plan\n\nRequests reach us through four inboxes (help, info, volunteers and events) and two group chats.\n\nThe bird sang.\n";
    expect(shown(before, [others(after)]).added).toEqual(["(help, info, volunteers and events)"]);
    const s = shown(before, [others(after), yours(after.replace("The bird sang.", "The bird sang loudly."))]);
    expect(s.added).toEqual(["(help, info, volunteers and events)"]);
    expect(s.count).toBe(1);
  });

  it("a long new section and a one-word fix elsewhere are two changes; words only spaces apart are one", () => {
    const s = shown(base, [
      others("# Plan\n\nThe cat sat on the mat.\n\n## New part\n\nFirst new line.\n\nSecond new line.\n\nThe dog ran fast.\n\nThe bird sang well.\n"),
    ]);
    expect(s.count).toBe(2);
    expect(new Set(s.groups).size).toBe(2);
  });
});

// Random rounds, with fixed seeds so a failure always comes back the same.
// Words come from short lists, so they repeat as in real text, and blocks
// are paragraphs or bullets, so lists get cut in two and made one. Each word
// remembers who wrote it: the text handed over is common words, others write
// capitals, the person their own few words. Checked by place on the page: no
// word of the person's is marked as put in, and no word only they took out is
// struck through. A word that was there and still is is marked only in a
// passage shown rewritten (struck through, and put in again), as for a single
// agent's pass.
describe("what Show changes marks, in random rounds", () => {
  const BASE = "plan team launch review pilot report draft client cost hire two this the a and of to in is we may june new small board money room city year week hall food".split(" ");
  const OTHERS = "ALPHA BETA GAMMA DELTA EPSILON ZETA ETA THETA IOTA KAPPA".split(" ");
  const YOURS = "mine ours typed noted fixed mended".split(" ");
  type By = "base" | "others" | "yours";
  interface Word {
    w: string;
    by: By;
  }
  interface Block {
    item: boolean;
    words: Word[];
    /** Who changed it since the hand-over. */
    changed: Set<By>;
  }
  function random(seed: number) {
    let s = seed;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const int = (n: number) => Math.floor(rnd() * n);
    return { rnd, int, pick: <T>(xs: readonly T[]) => xs[int(xs.length)] };
  }
  /** Bullets next to each other make one list; a blank line between everything else. */
  const markdown = (doc: Block[]) =>
    doc.map((b, i) => (i ? (doc[i - 1].item && b.item ? "\n" : "\n\n") : "") + (b.item ? "- " : "") + b.words.map((t) => t.w).join(" ")).join("") + "\n";

  it("never marks the person's words, or words that were there, as others'", () => {
    const wrong: string[] = [];
    const bothChanged: string[] = [];
    for (let seed = 1; seed <= 2000; seed++) {
      const { rnd, int, pick } = random(seed);
      const doc: Block[] = Array.from({ length: 3 + int(5) }, () => ({
        item: rnd() < 0.4,
        words: Array.from({ length: 2 + int(8) }, () => ({ w: pick(BASE), by: "base" as const })),
        changed: new Set<By>(),
      }));
      const base = markdown(doc);
      const takenOut = { yours: new Set<string>(), others: new Set<string>() };
      const edit = (yours: boolean): Step => {
        const by: By = yours ? "yours" : "others";
        const fresh = (): Word => ({ w: pick(yours ? YOURS : OTHERS), by });
        const out = takenOut[by];
        for (let k = 1 + int(4); k > 0; k--) {
          const p = int(doc.length);
          const block = doc[p];
          const at = int(block.words.length);
          const what = int(6);
          if (what !== 3 && what !== 4) block.changed.add(by);
          if (what === 0) {
            out.add(block.words[at].w);
            block.words[at] = fresh();
          } else if (what === 1 && block.words.length > 1) {
            out.add(block.words[at].w);
            block.words.splice(at, 1);
          } else if (what === 2) block.words.splice(at + 1, 0, fresh());
          else if (what === 3) doc.splice(p + 1, 0, { item: rnd() < 0.5, words: Array.from({ length: 1 + int(4) }, fresh), changed: new Set([by]) });
          else if (what === 4 && doc.length > 1) {
            for (const t of block.words) out.add(t.w);
            doc.splice(p, 1);
          } else if (what === 5) {
            // A stretch rewritten.
            const n = Math.min(block.words.length - at, 2 + int(3));
            for (const t of block.words.slice(at, at + n)) out.add(t.w);
            block.words.splice(at, n, ...Array.from({ length: 1 + int(4) }, fresh));
          }
        }
        return { yours, text: markdown(doc) };
      };
      const steps: Step[] = [edit(false)];
      for (let more = int(4); more > 0; more--) steps.push(edit(steps[steps.length - 1].yours ? false : rnd() < 0.8));

      const now = steps[steps.length - 1].text;
      const page = parseMarkdown(now).doc;
      const { before, yours } = rebase(base, steps, (md) => textIndex(parseMarkdown(md).doc).text);
      const was = parseMarkdown(before).doc;
      const changes = before === now ? [] : diffDocs(was, page);
      // In the page's order: the window numbers changes by it.
      const starts = changes.map((c) => extentOf(c).start);
      expect(starts, `seed ${seed}: changes in order`).toEqual([...starts].sort((x, y) => x - y));
      const marks = marksSince(page, changes, positionsOf(textIndex(page), yours, page.content.size), () => freshWords(textIndex(page), textIndex(was).text)).changes;
      const putIn: [number, number][] = [];
      const struck: string[] = [];
      for (const c of marks) {
        if (c.kind === "removed-text") struck.push(...(c.text.split(OBJECT).join(" ").match(/\S+/g) ?? []));
        else if (c.kind === "removed-block") struck.push(...(c.node.textBetween(0, c.node.content.size, " ").match(/\S+/g) ?? []));
        else putIn.push([c.from, c.to]);
      }
      const found: string[] = [];
      const known: string[] = [];
      let b = 0;
      page.descendants((node, pos) => {
        if (!node.isTextblock) return true;
        const block = doc[b++];
        expect(node.textContent, `seed ${seed}: the page reads as the round wrote it`).toBe(block.words.map((t) => t.w).join(" "));
        let at = pos + 1;
        for (const t of block.words) {
          const marked = putIn.some(([from, to]) => from < at + t.w.length && at < to);
          if (marked && t.by === "yours") found.push(`the person's "${t.w}" is marked as put in`);
          else if (!marked && t.by === "others" && steps.length === 1) found.push(`"${t.w}", put in by others, isn't marked`);
          else if (marked && t.by === "base" && !struck.includes(t.w)) {
            // In a paragraph both changed, a stricter rule would leave these unmarked too, and others' words with them: Orlando's call (review R-13).
            (block.changed.has("yours") && block.changed.has("others") ? known : found).push(`"${t.w}", there all along, is marked as put in`);
          }
          at += t.w.length + 1;
        }
        return false;
      });
      const left = new Set(doc.flatMap((block) => block.words.map((t) => t.w)));
      const mineOnly = [...new Set(struck)].filter((w) => !takenOut.others.has(w) && !left.has(w));
      if (mineOnly.length) found.push(`struck through, though only the person took them out: ${mineOnly.join(" ")}`);
      if (found.length) wrong.push(`seed ${seed}: ${found.join("; ")}`);
      if (known.length) bothChanged.push(`seed ${seed}: ${known.join("; ")}`);
    }
    // Left, and named so any change shows (review R-13): a run of changed lines, compared word by word, can pair a line
    // with the wrong one on their spaces and line ends, and the person's place goes with it (seed 1694); and in a
    // paragraph both changed, a word there all along can be marked as put in, where a stricter rule would mark fewer of
    // others' words too: Orlando's call.
    expect(wrong).toEqual([`seed 1694: the person's "mine" is marked as put in; struck through, though only the person took them out: to`]);
    expect(bothChanged).toEqual([
      `seed 740: "week", there all along, is marked as put in; "city", there all along, is marked as put in; "is", there all along, is marked as put in`,
      `seed 1092: "small", there all along, is marked as put in`,
    ]);
  });
});
