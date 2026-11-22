// History reads as the story of the document (roadmap Batch 4, item 2,
// L-10): each row names the sections its version touched, and the person's
// own rows say what they changed. Worked out the first time History shows a
// row, from one walk back through the history, and kept in memory (a bounded
// number of rows); nothing more is kept on disk.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VersionHistory } from "../../src/main/version-store";
import * as sections from "../../src/core/change-sections";
import { longSession, numbers, sentenceFrom } from "../fixtures/long-history";

const DOC = `# Plan

## Budget

The budget is tight.

## Hiring

We should hire two people.

## Risks

Nobody answers the phone.
`;

afterEach(() => {
  vi.restoreAllMocks();
});

function setup(text = DOC) {
  const data = mkdtempSync(join(tmpdir(), "corillo-history-"));
  const file = join(mkdtempSync(join(tmpdir(), "corillo-docs-")), "plan.md");
  writeFileSync(file, text);
  let time = new Date("2026-11-10T10:00:00Z").getTime();
  const h = new VersionHistory(data, () => new Date((time += 1000)));
  const id = h.idFor(file);
  h.seen(id, text);
  const dir = join(data, "documents", id, "versions");
  /** Every version's story, as History's rows get them: the newest with the list, the rest asked for. */
  const stories = async (on = h) => {
    const rows = on.rows(id).versions;
    const asked = await on.stories(id, rows.map((r) => r.n));
    return rows.map((r) => (r.n in asked ? asked[r.n] : { sections: r.sections, change: r.change }));
  };
  return { h, id, data, dir, stories };
}

/** An agent's pass that makes these edits, one save each. */
function pass(h: VersionHistory, id: string, texts: string[], agent = "Claude") {
  h.beginPass(id, agent);
  for (const t of texts) h.edited(id, t);
  h.endPass(id, { addressed: [] });
}

describe("History's rows say what each version changed", () => {
  it("an agent's pass that edits two sections names both, in the order they come", async () => {
    const { h, id, stories } = setup();
    const after = DOC.replace("hire two", "hire three").replace("The budget is tight.", "The budget is very tight.");
    pass(h, id, [after]);
    h.edited(id, after.replace("Nobody", "No one")); // the agent's version is no longer the newest
    const rows = h.rows(id).versions;
    expect(rows.map((r) => r.kind)).toEqual(["first", "agent", "person"]);
    const all = await stories();
    expect(all[1].sections).toEqual(["Budget", "Hiring"]);
    // An agent's change lines are in its brief, one per comment it answered: the row doesn't repeat them.
    expect(all[1].change).toBeUndefined();
    expect(all[0]).toEqual({ sections: undefined, change: undefined });
  });

  it("your own row says what you changed, and where, as you go: worked out again only when the text changes", () => {
    const { h, id } = setup();
    pass(h, id, [DOC.replace("hire two", "hire three")]);
    h.edited(id, DOC.replace("hire two", "hire three").replace("Nobody answers the phone.", "Nobody answers the phone after five."));
    let mine = h.rows(id).versions[2];
    expect(mine.kind).toBe("person");
    expect(mine.sections).toEqual(["Risks"]);
    expect(mine.change).toEqual({ total: 1, shown: [{ removed: "", added: "after five" }] });
    // Asked again with the text the same: what was worked out is given again, not worked out anew.
    expect(h.rows(id).versions[2].sections).toBe(mine.sections);
    h.edited(id, DOC.replace("hire two", "hire four").replace("Nobody answers the phone.", "Nobody answers the phone after five."));
    mine = h.rows(id).versions[2];
    expect(mine.sections).toEqual(["Hiring", "Risks"]);
    expect(mine.change!.total).toBe(2);
  });

  it("a row is worked out once: asked again, or listed again, it's given as kept", async () => {
    const { h, id } = setup();
    pass(h, id, [DOC.replace("hire two", "hire three")]);
    h.edited(id, DOC.replace("hire two", "hire three").replace("tight", "fine"));
    pass(h, id, [DOC.replace("hire two", "hire four").replace("tight", "fine")]);
    const read = vi.spyOn(sections, "readText");
    const first = await h.stories(id, [2, 3]);
    expect(first).toEqual({ 2: { sections: ["Hiring"] }, 3: { sections: ["Budget"], change: { total: 1, shown: [{ removed: "tight", added: "fine" }] } } });
    // One walk back, each text read once: versions 1, 2 and 3.
    expect(read).toHaveBeenCalledTimes(3);
    read.mockClear();
    expect(await h.stories(id, [2, 3])).toEqual(first);
    expect(read).not.toHaveBeenCalled();
    // The list gives them as kept; only the newest, not asked for before, is worked out.
    expect(h.rows(id).versions.map((r) => r.sections)).toEqual([undefined, ["Hiring"], ["Budget"], ["Hiring"]]);
    read.mockClear();
    h.rows(id);
    expect(read).not.toHaveBeenCalled();
  });

  it("the newest version's story, once it's no longer the newest, is kept without being worked out again", () => {
    const { h, id } = setup();
    pass(h, id, [DOC.replace("hire two", "hire three")]);
    expect(h.rows(id).versions[1].sections).toEqual(["Hiring"]); // worked out as the newest
    const read = vi.spyOn(sections, "readText");
    h.edited(id, DOC.replace("hire two", "hire three").replace("tight", "fine"));
    expect(h.rows(id).versions[1].sections).toEqual(["Hiring"]);
    // Only the new version's text was read: the agent's, and the one before it, were read already.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("a change from another app, and a restore, say what they changed too", async () => {
    const { h, id, stories } = setup();
    h.outside(id, DOC.replace("## Risks\n\nNobody answers the phone.\n", "## Risks\n\nThe phone.\n\n## Timeline\n\nBy June.\n"));
    h.prepareRestore(id, 1);
    h.edited(id, DOC);
    expect(h.rows(id).versions.map((r) => r.kind)).toEqual(["first", "outside", "restored"]);
    const all = await stories();
    expect(all[1].sections).toEqual(["Risks", "Timeline"]);
    expect(all[1].change!.total).toBeGreaterThan(0);
    expect(all[2].sections).toEqual(["Risks", "Timeline"]);
  });

  it("a version that changed nothing in the text (an agent that only replied) names nothing", async () => {
    const { h, id, stories } = setup();
    h.beginPass(id, "Claude");
    h.endPass(id, { addressed: [{ id: "c1", anchor: null, status: "open", messages: [] } as never] });
    h.edited(id, DOC.replace("tight", "loose"));
    expect((await stories())[1]).toEqual({});
  });

  it("nothing more is kept on disk for it", async () => {
    const { h, id, dir, stories } = setup();
    pass(h, id, [DOC.replace("hire two", "hire three")]);
    h.edited(id, DOC.replace("tight", "fine"));
    const before = readdirSync(dir).sort();
    await stories();
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it("a save while History is open sends the newest row with what it changed, still small", () => {
    const s = longSession({ passes: 20 });
    const first = s.h.rows(s.id);
    s.autosave(4);
    const next = s.h.rows(s.id, { stamp: first.stamp, count: first.versions.length });
    expect(next.versions).toHaveLength(1);
    expect(next.versions[0].sections).toEqual(["Help desk proposal"]);
    expect(next.versions[0].change!.total).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThan(2 * 1024);
  }, 60_000);

  it("a history kept before 2026-11-09 gets its rows' stories too", async () => {
    const data = mkdtempSync(join(tmpdir(), "corillo-storage-"));
    cpSync(join(import.meta.dirname, "..", "fixtures", "history-before-2026-11-09", "documents"), join(data, "documents"), { recursive: true });
    const h = new VersionHistory(data);
    const rows = h.rows("doc").versions;
    expect(rows.length).toBeGreaterThan(2);
    const asked = await h.stories("doc", rows.map((r) => r.n));
    const told = rows.slice(1).filter((r) => asked[r.n]?.sections || asked[r.n]?.change || r.sections || r.change);
    expect(told.length).toBeGreaterThan(0);
  });

  it("a version that can't be rebuilt (part of the history damaged) goes without; newer ones don't", async () => {
    const { h, id, dir } = setup();
    pass(h, id, [DOC.replace("hire two", "hire three")]);
    h.edited(id, DOC.replace("hire two", "hire three").replace("tight", "fine"));
    pass(h, id, [DOC.replace("hire two", "hire four").replace("tight", "fine")]);
    h.edited(id, DOC.replace("hire two", "hire four").replace("tight", "fine").replace("Nobody", "No one"));
    // The record that gives back version 1 from version 2 is lost.
    writeFileSync(join(dir, "older.jsonl"), readFileSync(join(dir, "older.jsonl"), "utf8").replace(/\n\{"n":1,[^\n]*/, ""));
    const fresh = new VersionHistory(join(dir, "..", "..", ".."));
    const asked = await fresh.stories(id, [2, 3, 4]);
    expect(asked[2]).toBeUndefined();
    expect(asked[3]).toEqual({ sections: ["Budget"], change: { total: 1, shown: [{ removed: "tight", added: "fine" }] } });
    expect(asked[4]).toEqual({ sections: ["Hiring"] });
  });

  it("keeps a bounded number of stories in memory, however many rows are shown, and gives at most a screenful or two at once", async () => {
    const s = longSession({ passes: 30 });
    const ns = s.h.rows(s.id).versions.map((r) => r.n);
    expect(Object.keys(await s.h.stories(s.id, ns.slice(1))).length).toBe(24);
    for (let i = 0; i < ns.length; i += 10) await s.h.stories(s.id, ns.slice(i, i + 10));
    expect(s.h.storiesKept).toBeLessThanOrEqual(31);
    // Many documents: the newest versions' are kept for a few only.
    const h = new VersionHistory(mkdtempSync(join(tmpdir(), "corillo-history-")));
    const folder = mkdtempSync(join(tmpdir(), "corillo-docs-"));
    for (let i = 0; i < 10; i++) {
      const file = join(folder, `doc${i}.md`);
      writeFileSync(file, DOC);
      const id = h.idFor(file);
      h.seen(id, DOC);
      h.edited(id, DOC.replace("tight", `tight ${i}`));
      expect(h.rows(id).versions[1].sections).toEqual(["Budget"]);
    }
    expect(h.storiesKept).toBeLessThanOrEqual(4);
  }, 60_000);
});

describe("several of your versions in a row, shown together", () => {
  it("the newest is compared with the version before them, in one walk back", () => {
    const { h, id } = setup();
    pass(h, id, [DOC.replace("hire two", "hire three")]);
    h.edited(id, DOC.replace("hire two", "hire three").replace("tight", "fine"));
    // An agent takes the document and gives it back with nothing: the person's next edits are a version of their own.
    h.beginPass(id, "Claude");
    h.endPass(id, {});
    h.edited(id, DOC.replace("hire two", "hire three").replace("tight", "fine").replace("Nobody", "No one"));
    expect(h.list(id).map((v) => v.kind)).toEqual(["first", "agent", "person", "person"]);
    const both = h.versionTexts(id, 4, 2);
    expect(both.before).toBe(DOC.replace("hire two", "hire three"));
    expect(both.text).toBe(DOC.replace("hire two", "hire three").replace("tight", "fine").replace("Nobody", "No one"));
    // A base that isn't earlier is the version before, as without one.
    expect(h.versionTexts(id, 4, 4).before).toBe(h.text(id, 3));
  });

  it("their row says what they changed together: an edit made and then undone isn't there", async () => {
    const { h, id } = setup();
    pass(h, id, [DOC.replace("hire two", "hire three")]);
    h.edited(id, DOC.replace("hire two", "hire three").replace("tight", "fine"));
    h.beginPass(id, "Claude");
    h.endPass(id, {});
    h.edited(id, DOC.replace("hire two", "hire three").replace("Nobody", "No one")); // "fine" back to "tight"
    h.beginPass(id, "Claude");
    h.endPass(id, {});
    h.edited(id, DOC.replace("hire two", "hire three").replace("Nobody", "No one").replace("## Risks", "## Big risks"));
    expect(h.list(id).map((v) => v.kind)).toEqual(["first", "agent", "person", "person", "person"]);
    // The newest of them is the newest version: worked out each time, never kept.
    const read = vi.spyOn(sections, "readText");
    const together = await h.stories(id, [{ from: 3, to: 5 }, 3]);
    // The heading and the words under it changed together: one place.
    expect(together["3-5"]).toEqual({ sections: ["Big risks"], change: { total: 1, shown: [{ removed: "Risks Nobody", added: "Big risks No one" }] } });
    expect(together[3]).toEqual({ sections: ["Budget"], change: { total: 1, shown: [{ removed: "tight", added: "fine" }] } });
    read.mockClear();
    await h.stories(id, [{ from: 3, to: 5 }]);
    expect(read).toHaveBeenCalledTimes(2);
    // Once an agent's pass comes after them, kept.
    pass(h, id, [h.text(id, 5)!.replace("hire three", "hire five")]);
    await h.stories(id, [{ from: 3, to: 5 }]);
    read.mockClear();
    expect((await h.stories(id, [{ from: 3, to: 5 }]))["3-5"].sections).toEqual(["Big risks"]);
    expect(read).not.toHaveBeenCalled();
    // Asked for the wrong way round, or for the first version: nothing.
    expect(await h.stories(id, [{ from: 5, to: 3 }, { from: 1, to: 3 }])).toEqual({});
  });
});

/**
 * A history of `rounds` rounds, each an agent's pass and then the person's
 * edit, each rewriting a paragraph, with a heading for each, so the record
 * of older versions is long (about half a megabyte at 250 rounds); the last
 * rounds are the same whatever `rounds` (as quick.spec.ts's Show changes test
 * has it).
 */
function rounds(count: number) {
  const rand = numbers(5);
  const data = mkdtempSync(join(tmpdir(), "corillo-history-"));
  const file = join(mkdtempSync(join(tmpdir(), "corillo-docs-")), "plan.md");
  let time = Date.parse("2026-11-09T09:00:00Z");
  const h = new VersionHistory(data, () => new Date((time += 60_000)));
  const paragraph = () => Array.from({ length: 12 }, () => sentenceFrom(rand)).join(" ");
  const [one, two, other] = [paragraph(), paragraph(), paragraph()];
  const doc = (middle: string, end: string) => `# Plan\n\n## Why\n\n${one}\n\n## How\n\n${middle}\n\n## Budget\n\n${end}\n`;
  writeFileSync(file, doc(two, "The budget is tight."));
  const id = h.idFor(file);
  h.seen(id, doc(two, "The budget is tight."));
  let end = "The budget is tight.";
  for (let i = 0; i < count; i++) {
    pass(h, id, [doc(other, end)]);
    end = `The budget is tight ${i % 2 ? "again" : "still"}.`;
    h.edited(id, doc(two, end));
  }
  return { data, id };
}

describe("History's rows never hold up the rest of Corillo", () => {
  it("the rows asked for are worked out a text per turn, so an agent's call or a save can come in between; each still read once (Batch 6)", async () => {
    // On the bench's long document, eight rows worked out in one go kept the
    // app's main process busy for about 80 ms, with agents' calls waiting.
    const s = longSession({ passes: 12 });
    const ns = s.h.rows(s.id).versions.map((r) => r.n).slice(1, 9); // eight rows, none of them the newest
    const read = vi.spyOn(sections, "readText");
    const before = s.h.storiesKept;
    let done = false;
    const asking = s.h.stories(s.id, ns).then((told) => ((done = true), told));
    // After each turn: the texts read, and the rows worked out, so far.
    const turns = [{ reads: read.mock.calls.length, rows: s.h.storiesKept - before }];
    while (!done && turns.length < 100) {
      await new Promise((resolve) => setImmediate(resolve));
      turns.push({ reads: read.mock.calls.length, rows: s.h.storiesKept - before });
    }
    const told = await asking;
    expect(Object.keys(told).map(Number)).toEqual(ns);
    expect(read).toHaveBeenCalledTimes(ns.length + 1); // the eight and the one before the first
    expect(turns[0]).toEqual({ reads: 0, rows: 0 });
    const more = turns.slice(1).map((t, i) => ({ reads: t.reads - turns[i].reads, rows: t.rows - turns[i].rows }));
    expect(more.filter((m) => m.reads > 1 || m.rows > 1)).toEqual([]);
    expect(turns.at(-1)!.rows).toBe(ns.length);
  }, 60_000);
});

describe("History opens as quickly on a long history as on a short one", () => {
  it("the rows in sight say what they changed as quickly after 250 rounds as after 15: only the versions they need are read", async () => {
    const short = rounds(15);
    const long = rounds(250);
    /** A fresh start (nothing kept in memory), the list, then the first screenful's stories: how long those take, in ms. */
    const open = async ({ data, id }: { data: string; id: string }) => {
      const h = new VersionHistory(data);
      const ns = h.rows(id).versions.map((r) => r.n).reverse().slice(0, 24);
      const start = performance.now();
      const told = await h.stories(id, ns);
      const ms = performance.now() - start;
      expect(Object.keys(told)).toHaveLength(24);
      expect(told[ns[1]].sections).toEqual(["How"]);
      return ms;
    };
    await open(short); // warm up
    const times = { short: [] as number[], long: [] as number[] };
    for (let i = 0; i < 5; i++) {
      times.short.push(await open(short));
      times.long.push(await open(long));
    }
    const quickest = (xs: number[]) => Math.min(...xs);
    console.log(`The first screenful's stories, quickest of five: ${quickest(times.short).toFixed(1)} ms after 15 rounds, ${quickest(times.long).toFixed(1)} ms after 250`);
    expect(quickest(times.long)).toBeLessThan(4 * quickest(times.short));
  }, 60_000);
});
