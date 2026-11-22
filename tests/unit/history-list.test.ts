// The History panel stays quick however long a document's history gets
// (review finding CM-6). Its list carries only what its rows show (who, when,
// the start of each comment and reply, the change line); the whole
// conversation is fetched for the one version opened. While the panel is open,
// a save sends only the newest row. Agents still read the whole history.
import { beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VersionHistory, briefOf } from "../../src/main/version-store";
import { CommentService } from "../../src/main/comment-service";
import { summarizeChanges } from "../../src/core/change-summary";
import type { Author } from "../../src/core/comments";
import { longSession } from "../fixtures/long-history";

const KB = 1024;
const size = (x: unknown) => Buffer.byteLength(JSON.stringify(x));
const me: Author = { kind: "person" };
const claude: Author = { kind: "agent", name: "Claude" };

describe("History's list on a long history (5,000 words, 200 passes, about 200 comments)", () => {
  let s: ReturnType<typeof longSession>;
  beforeAll(() => {
    s = longSession();
  }, 120_000);

  it("opening the panel sends what its rows show: under 300 KB, where it sent every conversation whole (610 KB)", () => {
    const list = s.h.rows(s.id);
    expect(list.versions).toHaveLength(201);
    expect(list.from).toBe(0);
    // Every agent's pass in brief: about 210 KB here, nearly all the start of
    // each comment and reply (the session's messages are mostly short enough to send whole).
    expect(Object.keys(list.briefs!)).toHaveLength(100);
    expect(size(list)).toBeLessThan(300 * KB);
    // What agents read is unchanged: every version with its whole conversation.
    expect(size(s.h.list(s.id))).toBeGreaterThan(500 * KB);
  });

  it("a save while the panel is open sends only the newest version's row: under 2 KB, where it sent 610 KB", () => {
    const first = s.h.rows(s.id);
    s.autosave(4);
    const next = s.h.rows(s.id, { stamp: first.stamp, count: first.versions.length });
    expect(next.from).toBe(200);
    expect(next.versions).toHaveLength(1);
    expect(next.briefs).toBeUndefined();
    expect(next.versions[0].saved > first.versions[200].saved).toBe(true);
    expect(size(next)).toBeLessThan(2 * KB);
  });

  it("each row's brief is the start of the pass's comments and replies, and its change line, as the full history has them", () => {
    const { briefs } = s.h.rows(s.id);
    let replied = 0;
    for (const v of s.h.list(s.id).filter((v) => v.kind === "agent")) {
      const brief = briefs![v.n];
      expect(brief.threads).toHaveLength(v.addressed!.length);
      v.addressed!.forEach((thread, i) => {
        // The pass's agent's own replies (the brief shows the last).
        const replies = thread.messages.slice(1).filter((m) => m.author.kind === "agent" && m.author.name === v.agent);
        const t = brief.threads[i];
        expect(t.comment.replace(/…$/, "")).not.toBe("");
        expect(thread.messages[0].body.startsWith(t.comment.replace(/…$/, ""))).toBe(true);
        if (replies.length) {
          replied++;
          expect(t.reply).toBeTruthy();
          expect(replies[replies.length - 1].body.startsWith(t.reply!.replace(/…$/, ""))).toBe(true);
        } else expect(t.reply).toBeUndefined();
        expect(t.change).toEqual(thread.change ? summarizeChanges(thread.change.spans) : undefined);
      });
      expect(!!brief.loose).toBe(!!(v.request || v.other?.length));
      if (v.request) expect(v.request.startsWith(brief.loose!.request!.replace(/…$/, ""))).toBe(true);
    }
    expect(replied).toBeGreaterThan(50); // the session's agent replies on most comments it addresses
  });

  it("the version opened gets its whole conversation, exactly as agents read it", () => {
    const versions = s.h.list(s.id);
    const agents = versions.filter((v) => v.kind === "agent");
    for (const v of [agents[0], agents[50], agents[agents.length - 1]]) {
      expect(s.h.conversation(s.id, v.n)).toEqual({ addressed: v.addressed, ...(v.other ? { other: v.other } : {}), ...(v.request ? { request: v.request } : {}) });
    }
    expect(s.h.conversation(s.id, 1)).toBeNull(); // the first version: no conversation
  });

  // Roadmap Batch 4, item 2: History reads as the story of the document.
  it("every row but the first names the sections it touched, every row of yours says what you changed, and nothing more is kept on disk", async () => {
    const dir = join(s.docDir, "versions");
    const files = readdirSync(dir).sort();
    const rows = s.h.rows(s.id).versions;
    expect(rows.length).toBeGreaterThan(200);
    const told = new Map<number, { sections?: string[]; change?: unknown }>();
    // As History asks while the list scrolls: a screenful at a time, newest first.
    const ns = rows.map((r) => r.n).reverse();
    for (let i = 0; i < ns.length; i += 24) for (const [n, story] of Object.entries(await s.h.stories(s.id, ns.slice(i, i + 24)))) told.set(Number(n), story);
    expect(told.has(1)).toBe(false);
    for (const r of rows.slice(1)) {
      expect(told.get(r.n)?.sections?.length, `version ${r.n}`).toBeGreaterThan(0);
      if (r.kind === "person") expect(told.get(r.n)?.change, `version ${r.n}`).toBeTruthy();
    }
    expect(readdirSync(dir).sort()).toEqual(files);
  });
});

describe("only what's new is sent, and everything when the feedback changes", () => {
  const start = () => {
    const data = mkdtempSync(join(tmpdir(), "corillo-storage-"));
    const file = join(mkdtempSync(join(tmpdir(), "corillo-docs-")), "plan.md");
    writeFileSync(file, "One.\n");
    const h = new VersionHistory(data);
    const comments = new CommentService(h, () => {});
    const id = h.idFor(file);
    h.seen(id, "One.\n");
    return { h, comments, id, data };
  };
  const knownOf = (list: { stamp: string; versions: unknown[] }, count = list.versions.length) => ({ stamp: list.stamp, count });

  it("a new version: the window's newest row and the new one", () => {
    const { h, id } = start();
    h.edited(id, "One. Two.\n");
    const first = h.rows(id);
    h.outside(id, "Three.\n");
    const next = h.rows(id, knownOf(first));
    expect(next.from).toBe(1);
    expect(next.versions.map((v) => v.kind)).toEqual(["person", "outside"]);
  });

  it("a pass's feedback added: everything again, with each pass in brief", () => {
    const { h, comments, id } = start();
    const first = h.rows(id);
    const t = comments.add(id, me, "Make it two.", null, null);
    h.beginPass(id, "Claude");
    h.edited(id, "Two.\n");
    const midPass = h.rows(id, knownOf(first));
    expect(midPass.from).toBe(0); // the stamp is the same, but nothing was known beyond the first version
    const during = h.rows(id, knownOf(midPass));
    expect(during.from).toBe(1);
    h.endPass(id, { addressed: [comments.reply(id, t.id, claude, "Made it two.")] });
    const after = h.rows(id, knownOf(during));
    expect(after.from).toBe(0);
    expect(after.briefs).toEqual({ 2: { threads: [{ comment: "Make it two.", reply: "Made it two." }] } });
  });

  it("versions undone back to where a pass started: from the row before", () => {
    const { h, id } = start();
    h.edited(id, "One. Two.\n");
    const first = h.rows(id);
    h.edited(id, "One.\n"); // back to where the person's pass started: the version goes
    const next = h.rows(id, knownOf(first));
    expect(next.from).toBe(0);
    expect(next.versions.map((v) => v.n)).toEqual([1]);
  });

  it("a history started again (the old one set aside): everything again", () => {
    const { h, id, data } = start();
    h.edited(id, "One. Two.\n");
    const first = h.rows(id);
    writeFileSync(join(data, "documents", id, "versions", "latest.json.gz"), "damaged");
    h.seen(id, "Fresh.\n");
    const next = h.rows(id, knownOf(first));
    expect(next.from).toBe(0);
    expect(next.versions.map((v) => v.kind)).toEqual(["first"]);
  });

  it("a long comment or reply is cut, with an ellipsis, at a space, after enough for two lines in the widest panel", () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const brief = briefOf({
      n: 2,
      kind: "agent",
      agent: "Claude",
      created: "",
      saved: "",
      addressed: [{ id: "t", anchor: null, status: "open", messages: [{ id: "m", author: me, body: long, at: "" }, { id: "r", author: claude, body: "Done.", at: "" }] }],
    } as never)!;
    const comment = brief.threads[0].comment;
    expect(comment.endsWith("…")).toBe(true);
    expect(comment.length).toBeGreaterThan(400);
    expect(comment.length).toBeLessThanOrEqual(501);
    expect(long.startsWith(comment.slice(0, -1))).toBe(true);
    expect(long[comment.length - 1]).toBe(" "); // cut between words
    expect(brief.threads[0].reply).toBe("Done.");
  });

  it("a history kept before 2026-11-09, with its feedback inside the newest file, is always sent whole, each pass in brief", () => {
    const data = mkdtempSync(join(tmpdir(), "corillo-storage-"));
    cpSync(join(import.meta.dirname, "..", "fixtures", "history-before-2026-11-09", "documents"), join(data, "documents"), { recursive: true });
    const h = new VersionHistory(data);
    const first = h.rows("doc");
    expect(first.stamp).toBe("");
    expect(Object.keys(first.briefs!).map(Number)).toEqual(h.list("doc").filter((v) => briefOf(v)).map((v) => v.n));
    expect(h.rows("doc", knownOf(first)).from).toBe(0);
  });
});
