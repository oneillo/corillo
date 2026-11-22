// How much Corillo keeps beside each document as the work goes on (Orlando,
// 2026-11-09: "if we save too much information, the amount of info per
// markdown document and total disk space required to do this balloons
// quickly"). Long sessions are played through the real history and comment
// stores, in throwaway data folders, and what they leave on disk is measured.
import { beforeAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import { VersionHistory } from "../../src/main/version-store";
import { DocumentStore } from "../../src/main/store";
import { CommentService } from "../../src/main/comment-service";
import { anchorIn } from "../../src/core/anchors";
import type { Author, Thread } from "../../src/core/comments";
import type { Version } from "../../src/core/versions";
import { longSession, numbers, sentenceFrom, wordsFrom } from "../fixtures/long-history";

const me: Author = { kind: "person" };
const claude: Author = { kind: "agent", name: "Claude" };
const KB = 1024;

function folderSize(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    total += s.isDirectory() ? folderSize(p) : s.size;
  }
  return total;
}

/** Every file under a folder, by its path inside it. */
function snapshot(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p), readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

/** What was written between two snapshots: for a file added to, what was added; for any other change, the whole file. */
function written(before: Map<string, Buffer>, after: Map<string, Buffer>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [name, now] of after) {
    const was = before.get(name);
    if (was?.equals(now)) continue;
    const appended = was && now.length > was.length && now.subarray(0, was.length).equals(was);
    out.set(name, appended ? now.length - was.length : now.length);
  }
  return out;
}
const total = (sizes: Map<string, number>) => [...sizes.values()].reduce((a, b) => a + b, 0);

describe("what Corillo keeps beside a document stays small as the work goes on", () => {
  let s: ReturnType<typeof longSession>;
  beforeAll(() => {
    s = longSession();
  }, 120_000);

  it("a long session on a 5,000-word document (200 passes, agents answering comments and chat requests, most comments resolved) keeps under 400 KB beside it", () => {
    expect(s.start.split(/\s+/).length).toBeGreaterThan(5000);
    expect(s.h.list(s.id)).toHaveLength(201);
    // A full copy per version would be 6 MB; before 2026-11-09 Corillo kept 640 KB here.
    // What has to be kept is the conversation (about 600 messages on 200
    // comments), compressed, twice: once with the comments, and once in the
    // history, which has to outlive a comment deleted later; plus the edits
    // between versions and the newest text. That's about 300 KB here, and 400
    // leaves room for wordier comments.
    expect(folderSize(s.docDir)).toBeLessThan(400 * KB);
  });

  it("the comments, resolved ones too, are kept compressed, in under 160 KB", () => {
    const threads = s.comments.threads(s.id);
    expect(threads.length).toBeGreaterThan(200);
    expect(threads.filter((t) => t.status === "resolved").length).toBeGreaterThan(195);
    expect(existsSync(join(s.docDir, "comments.json"))).toBe(false);
    // Their messages alone are 145 KB of plain text; as pretty-printed JSON they took 485 KB.
    expect(statSync(join(s.docDir, "comments.json.gz")).size).toBeLessThan(160 * KB);
  });

  it("every version's text, every pass's comments, request and other changes, and every comment come back exactly", () => {
    const again = new VersionHistory(s.data); // nothing remembered from the session
    const versions = again.list(s.id);
    expect(versions).toHaveLength(s.texts.length);
    for (const v of versions) expect(again.text(s.id, v.n)).toBe(s.texts[v.n - 1]);
    expect(s.recorded.size).toBe(100);
    for (const [n, feedback] of s.recorded) {
      const v = versions[n - 1];
      expect(v).toMatchObject({ n, kind: "agent", agent: "Claude" });
      expect({ addressed: v.addressed, other: v.other, request: v.request }).toEqual(feedback);
    }
    expect(versions.filter((v) => v.kind !== "agent").every((v) => !v.addressed && !v.other && !v.request)).toBe(true);
    expect(new DocumentStore(s.data).readComments(s.id)).toEqual(s.comments.threads(s.id));
  });

  // These two type more, so they come after the check above.
  it("one autosave writes the newest text and the list of versions, not the whole history: under 32 KB", () => {
    const before = snapshot(s.data);
    s.autosave(3);
    const sizes = written(before, snapshot(s.data));
    // The newest text has to be written, about 11 KB compressed here, and the
    // list of versions, about 2 KB; 32 KB leaves room for a longer document.
    // Before 2026-11-09 every agent's feedback was in the same file: 130 KB here.
    expect(total(sizes)).toBeLessThan(32 * KB);
    expect([...sizes.keys()].filter((name) => !name.endsWith("latest.json.gz"))).toEqual([]);
  });

  it("the comments moving as the person types rewrites only the comments file", () => {
    s.autosave(5);
    const before = snapshot(s.data);
    s.commentsFollow();
    const sizes = written(before, snapshot(s.data));
    expect([...sizes.keys()]).toEqual([join("documents", s.id, "comments.json.gz")]);
    expect(total(sizes)).toBeLessThan(160 * KB);
  });
});

describe("the history grows with what changed", () => {
  it("the same 40 passes on a document twice as long take only about one more compressed copy of the extra words, not one per version", () => {
    const short = longSession({ sentences: 260, passes: 40 });
    const long = longSession({ sentences: 520, passes: 40 });
    const extra = long.start.length - short.start.length; // about 30 KB of words
    const grew = folderSize(join(long.docDir, "versions")) - folderSize(join(short.docDir, "versions"));
    // The newest text is kept whole once (compressed, a third of its size);
    // everything else is what changed, the same in both. A copy per version
    // would grow by 40 times the extra words.
    expect(grew).toBeLessThan(extra / 2);
  }, 60_000);

  it("a comment discussed over 100 passes keeps each message once in the history, not once per pass", () => {
    const rand = numbers(3);
    const data = mkdtempSync(join(tmpdir(), "corillo-storage-"));
    const file = join(mkdtempSync(join(tmpdir(), "corillo-docs-")), "plan.md");
    writeFileSync(file, "# Plan\n\nA short plan.\n");
    const h = new VersionHistory(data);
    const comments = new CommentService(h, () => {});
    const id = h.idFor(file);
    h.seen(id, "# Plan\n\nA short plan.\n");
    const thread = comments.add(id, me, wordsFrom(rand, 40), null, null).id;
    const asRecorded: Thread[] = [];
    for (let pass = 0; pass < 100; pass++) {
      h.beginPass(id, "Claude");
      comments.reply(id, thread, claude, wordsFrom(rand, 30 + rand(50)));
      h.endPass(id, { addressed: comments.threads(id) });
      asRecorded.push(structuredClone(comments.threads(id)[0]));
      comments.reply(id, thread, me, wordsFrom(rand, 15 + rand(25)));
    }
    const conversation = JSON.stringify(comments.threads(id)[0].messages).length; // about 90 KB
    // Kept once each and compressed, the history is smaller than the
    // conversation itself. A copy of the thread per pass (as before
    // 2026-11-09) is 100 copies of a growing conversation: megabytes.
    expect(folderSize(join(data, "documents", id, "versions"))).toBeLessThan(conversation);
    // And each pass still reads with the whole conversation as it was then.
    const versions = new VersionHistory(data).list(id);
    expect(versions).toHaveLength(101);
    versions.slice(1).forEach((v, i) => expect(v.addressed).toEqual([asRecorded[i]]));
  }, 60_000);

  it("a comment on a long passage, answered over 20 passes, keeps the passage once in the history", () => {
    const rand = numbers(5);
    const data = mkdtempSync(join(tmpdir(), "corillo-storage-"));
    const file = join(mkdtempSync(join(tmpdir(), "corillo-docs-")), "plan.md");
    const passage = Array.from({ length: 100 }, () => sentenceFrom(rand)).join(" ");
    const text = `# Plan\n\n${passage}\n`;
    writeFileSync(file, text);
    const h = new VersionHistory(data);
    const comments = new CommentService(h, () => {});
    const id = h.idFor(file);
    h.seen(id, text);
    // A comment on the whole passage (Select All, say): its quote is the passage.
    const thread = comments.add(id, me, "Tighten this.", anchorIn(`Plan\n${passage}`, 5, 5 + passage.length), null).id;
    const asRecorded: Thread[] = [];
    for (let pass = 0; pass < 20; pass++) {
      h.beginPass(id, "Claude");
      comments.reply(id, thread, claude, wordsFrom(rand, 20));
      h.endPass(id, { addressed: comments.threads(id) });
      asRecorded.push(structuredClone(comments.threads(id)[0]));
      comments.reply(id, thread, me, wordsFrom(rand, 10));
    }
    // The feedback kept, compressed or not: the passage is in it once, not once per pass.
    const dir = join(data, "documents", id, "versions");
    const feedback = readdirSync(dir)
      .filter((name) => name.startsWith("feedback"))
      .map((name) => (name.endsWith(".gz") ? gunzipSync(readFileSync(join(dir, name))) : readFileSync(join(dir, name))).toString("utf8"))
      .join("");
    expect(feedback.split(passage).length - 1).toBe(1);
    // And each pass still reads with its comment on the passage, as it was then.
    const versions = new VersionHistory(data).list(id);
    expect(versions).toHaveLength(21);
    versions.slice(1).forEach((v, i) => expect(v.addressed).toEqual([asRecorded[i]]));
  }, 60_000);

  it("a pass's cover note is kept once, with its feedback, never in the file written again on every save (roadmap Batch 2, item 3)", () => {
    const data = mkdtempSync(join(tmpdir(), "corillo-storage-"));
    const file = join(mkdtempSync(join(tmpdir(), "corillo-docs-")), "plan.md");
    const note = "I also called the budget very tight; say if that's too strong.";
    writeFileSync(file, "# Plan\n\nThe budget is tight.\n");
    const h = new VersionHistory(data);
    const id = h.idFor(file);
    h.seen(id, "# Plan\n\nThe budget is tight.\n");
    h.beginPass(id, "Claude");
    h.edited(id, "# Plan\n\nThe budget is very tight.\n");
    const v = h.endPass(id, { note })!;
    // The person types on, saving again and again.
    for (let i = 0; i < 5; i++) h.edited(id, `# Plan\n\nThe budget is very tight.\n\nMore ${i}.\n`);
    const dir = join(data, "documents", id, "versions");
    const read = (name: string) => (name.endsWith(".gz") ? gunzipSync(readFileSync(join(dir, name))) : readFileSync(join(dir, name))).toString("utf8");
    expect(read("latest.json.gz")).not.toContain(note);
    const kept = readdirSync(dir).filter((name) => name.startsWith("feedback")).map(read).join("");
    expect(kept.split(note).length - 1).toBe(1);
    // And it reads back with its version: in the list, in brief for History's row, and whole for its conversation.
    const again = new VersionHistory(data);
    expect(again.list(id).find((x) => x.n === v.n)?.note).toBe(note);
    expect(again.rows(id).briefs?.[v.n]?.note).toBe(note);
    expect(again.conversation(id, v.n)?.note).toBe(note);
  });

  it("a damaged feedback record loses only its own pass's comments, never another pass's", () => {
    const data = mkdtempSync(join(tmpdir(), "corillo-storage-"));
    const file = join(mkdtempSync(join(tmpdir(), "corillo-docs-")), "plan.md");
    writeFileSync(file, "One.\n");
    const h = new VersionHistory(data);
    const comments = new CommentService(h, () => {});
    const id = h.idFor(file);
    h.seen(id, "One.\n");
    for (const word of ["Two", "Three", "Four"]) {
      const t = comments.add(id, me, `Make it ${word}.`, null, null);
      h.beginPass(id, "Claude");
      h.edited(id, `${word}.\n`);
      h.endPass(id, { addressed: [comments.reply(id, t.id, claude, `Now ${word}.`)] });
    }
    const log = join(data, "documents", id, "versions", "feedback.jsonl");
    writeFileSync(log, readFileSync(log, "utf8").replace("Make it Three.", 'Make it Three.\u0000"}{'));
    const versions = h.list(id);
    expect(versions.map((v) => v.addressed?.[0]?.messages.map((m) => m.body))).toEqual([
      undefined,
      ["Make it Two.", "Now Two."],
      undefined,
      ["Make it Four.", "Now Four."],
    ]);
    expect(h.text(id, 3)).toBe("Three.\n");
  });
});

describe("what Corillo kept before 2026-11-09 still opens", () => {
  // Written by Corillo's history and comment code as it was on 2026-11-09,
  // before the feedback moved out of latest.json.gz and comments were compressed:
  // a person's version, Claude answering two comments, Writer answering a
  // follow-up and a chat request with a change nobody asked for, a pass that
  // only replied, and the person's open version.
  const FIXTURE = join(import.meta.dirname, "..", "fixtures", "history-before-2026-11-09");
  const expected = JSON.parse(readFileSync(join(FIXTURE, "expected.json"), "utf8")) as {
    versions: Version[];
    texts: Record<string, string>;
    threads: Thread[];
  };
  const copy = () => {
    const data = mkdtempSync(join(tmpdir(), "corillo-storage-"));
    cpSync(join(FIXTURE, "documents"), join(data, "documents"), { recursive: true });
    return { data, h: new VersionHistory(data), dir: join(data, "documents", "doc") };
  };

  it("every version, the comments each pass answered, every version's text and every comment read as they did", () => {
    const { h, data } = copy();
    expect(expected.versions.map((v) => v.kind)).toEqual(["first", "person", "agent", "agent", "agent", "person"]);
    expect(h.list("doc")).toEqual(expected.versions);
    for (const v of expected.versions) expect(h.text("doc", v.n)).toBe(expected.texts[v.n]);
    expect(new DocumentStore(data).readComments("doc")).toEqual(expected.threads);
  });

  it("the first save moves them to the new layout, and nothing is lost", () => {
    const { h, data, dir } = copy();
    const newest = expected.texts[expected.versions.length];
    h.edited("doc", `${newest}More.\n`);
    // The agents' feedback has moved out of the file rewritten on every save.
    const latest = gunzipSync(readFileSync(join(dir, "versions", "latest.json.gz"))).toString("utf8");
    expect(latest).not.toContain("addressed");
    expect(latest).not.toContain("Make the budget line");
    expect(existsSync(join(dir, "versions", "feedback.jsonl"))).toBe(true);
    const versions = new VersionHistory(data).list("doc");
    expect(versions.slice(0, -1)).toEqual(expected.versions.slice(0, -1));
    expect(versions[versions.length - 1]).toMatchObject({ n: 6, kind: "person", open: true });
    for (const v of expected.versions.slice(0, -1)) expect(h.text("doc", v.n)).toBe(expected.texts[v.n]);
    expect(h.text("doc", 6)).toBe(`${newest}More.\n`);
    // The comments are compressed the next time they're written.
    const store = new DocumentStore(data);
    store.writeComments("doc", store.readComments("doc"));
    expect(existsSync(join(dir, "comments.json"))).toBe(false);
    expect(new DocumentStore(data).readComments("doc")).toEqual(expected.threads);
  });
});
