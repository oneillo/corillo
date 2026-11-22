import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, renameSync, readFileSync, existsSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addThread, reply, editMessage, deleteMessage, setResolved, setAnchors, type Author, type Thread,
} from "../../src/core/comments";
import { DocumentStore } from "../../src/main/store";

const me: Author = { kind: "person" };
const claude: Author = { kind: "agent", name: "Claude" };
const anchor = { quote: "x", prefix: "", suffix: "", offset: 0 };

describe("comment rules", () => {
  it("the person comments; agents reply and ask back in the same thread", () => {
    let { threads, thread } = addThread([], me, "Tighten this.", anchor, null);
    threads = reply(threads, thread.id, claude, "Done. Cut it to one sentence. OK?");
    threads = reply(threads, thread.id, me, "Yes.");
    expect(threads[0].messages.map((m) => m.body)).toEqual(["Tighten this.", "Done. Cut it to one sentence. OK?", "Yes."]);
    expect(threads[0].to).toBeNull(); // the default agent
  });

  it("a comment can be directed at one agent", () => {
    const { thread } = addThread([], me, "Check the numbers.", null, "Writer");
    expect(thread.to).toBe("Writer");
  });

  it("a comment an agent starts is addressed to the person", () => {
    const { thread } = addThread([], claude, "Should this section stay?", anchor, "Writer");
    expect(thread.to).toBe("person");
  });

  it("the person edits and deletes their own comments; agents can't edit, delete or resolve", () => {
    let { threads, thread } = addThread([], me, "Tighten this.", anchor, null);
    threads = reply(threads, thread.id, claude, "Done.");
    const [mine, theirs] = threads[0].messages;
    threads = editMessage(threads, thread.id, mine.id, me, "Tighten this a lot.");
    expect(threads[0].messages[0].body).toBe("Tighten this a lot.");
    expect(threads[0].messages[0].edited).toBeTruthy();
    expect(() => editMessage(threads, thread.id, mine.id, claude, "x")).toThrow("Agents can't edit");
    expect(() => editMessage(threads, thread.id, theirs.id, me, "x")).toThrow("your own");
    expect(() => deleteMessage(threads, thread.id, mine.id, claude)).toThrow("Agents can't delete");
    expect(() => setResolved(threads, thread.id, claude, true)).toThrow("Only you");
    expect(deleteMessage(threads, thread.id, mine.id, me)).toEqual([]);
  });

  it("deleting a reply keeps the comment", () => {
    let { threads, thread } = addThread([], me, "One.", null, null);
    threads = reply(threads, thread.id, me, "Two.");
    threads = deleteMessage(threads, thread.id, threads[0].messages[1].id, me);
    expect(threads[0].messages.map((m) => m.body)).toEqual(["One."]);
  });

  it("resolved comments can be reopened", () => {
    let { threads, thread } = addThread([], me, "One.", null, null);
    threads = setResolved(threads, thread.id, me, true);
    expect(threads[0].status).toBe("resolved");
    threads = setResolved(threads, thread.id, me, false);
    expect(threads[0].status).toBe("open");
  });

  it("empty comments aren't added", () => {
    expect(() => addThread([], me, "   ", null, null)).toThrow();
  });

  it("anchors update, and a comment whose text is gone is marked detached", () => {
    const { threads, thread } = addThread([], me, "One.", anchor, null);
    const moved = setAnchors(threads, { [thread.id]: { ...anchor, offset: 9 } });
    expect(moved[0].anchor?.offset).toBe(9);
    const gone: Thread[] = setAnchors(moved, { [thread.id]: "detached" });
    expect(gone[0].detached).toBe(true);
    expect(gone[0].anchor?.offset).toBe(9);
  });
});

describe("where comments are kept", () => {
  it("in Corillo's data folder, never in the document, and found again after a Finder move", () => {
    const base = mkdtempSync(join(tmpdir(), "corillo-store-"));
    const docs = mkdtempSync(join(tmpdir(), "corillo-docs-"));
    const file = join(docs, "plan.md");
    writeFileSync(file, "Text.\n");
    const store = new DocumentStore(base);
    const id = store.idFor(file);
    const { threads } = addThread([], me, "A note.", null, null);
    store.writeComments(id, threads);
    expect(readFileSync(file, "utf8")).toBe("Text.\n");
    expect(store.idFor(file)).toBe(id);
    // Moved in Finder:
    const moved = join(docs, "plan renamed.md");
    renameSync(file, moved);
    const again = new DocumentStore(base);
    expect(again.idFor(moved)).toBe(id);
    expect(again.readComments(id)[0].messages[0].body).toBe("A note.");
    expect(existsSync(join(base, "documents", id, "comments.json.gz"))).toBe(true);
  });

  it("the same document opened through a linked folder, or with other capitals, has the same comments", () => {
    const base = mkdtempSync(join(tmpdir(), "corillo-store-"));
    const docs = mkdtempSync(join(tmpdir(), "corillo-docs-"));
    const file = join(docs, "Plan.md");
    writeFileSync(file, "Text.\n");
    const store = new DocumentStore(base);
    const id = store.idFor(file);
    const linked = join(mkdtempSync(join(tmpdir(), "corillo-link-")), "vault");
    symlinkSync(docs, linked);
    expect(store.idFor(join(linked, "Plan.md"))).toBe(id);
    expect(new DocumentStore(base).idFor(join(linked, "Plan.md"))).toBe(id);
    // macOS disks don't mind capitals in names; elsewhere this is simply another file.
    const otherCase = join(docs, "plan.md");
    if (existsSync(otherCase)) expect(store.idFor(otherCase)).toBe(id);
    // Two different files at different paths stay apart.
    writeFileSync(join(docs, "Other.md"), "Other.\n");
    expect(store.idFor(join(linked, "Other.md"))).not.toBe(id);
  });

  it("a new document made where a deleted one used to be starts with no comments of its own", () => {
    const base = mkdtempSync(join(tmpdir(), "corillo-store-"));
    const docs = mkdtempSync(join(tmpdir(), "corillo-docs-"));
    const file = join(docs, "Untitled.md");
    writeFileSync(file, "Old.\n");
    const store = new DocumentStore(base);
    const old = store.idFor(file);
    store.writeComments(old, addThread([], me, "About the old one.", null, null).threads);
    unlinkSync(file);
    writeFileSync(file, "");
    store.created(file);
    const id = store.idFor(file);
    expect(id).not.toBe(old);
    expect(store.readComments(id)).toEqual([]);
    expect(store.readComments(old)).toHaveLength(1); // kept, not deleted
  });

  it("a document renamed onto the name of one deleted earlier keeps its own comments", () => {
    const base = mkdtempSync(join(tmpdir(), "corillo-store-"));
    const docs = mkdtempSync(join(tmpdir(), "corillo-docs-"));
    const gone = join(docs, "Report.md");
    writeFileSync(gone, "Gone.\n");
    const store = new DocumentStore(base);
    const goneId = store.idFor(gone);
    unlinkSync(gone);
    const draft = join(docs, "Draft.md");
    writeFileSync(draft, "Draft.\n");
    const id = store.idFor(draft);
    renameSync(draft, gone);
    store.moved(id, gone);
    expect(store.idFor(gone)).toBe(id);
    expect(new DocumentStore(base).idFor(gone)).toBe(id);
    expect(goneId).not.toBe(id);
  });
});
