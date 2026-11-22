// The recent documents are kept in memory: read once, written on each change,
// and which still exist is looked at only when asked (when Corillo comes back
// to the front), so building a menu never waits on the disk (MP-14).
import { describe, expect, it } from "vitest";
import { RecentList, type RecentStore } from "../../src/main/recent-list";

/** A pretend data folder and disk that count what's asked of them. */
function pretend(saved: string[] | null, present: string[] = saved ?? []) {
  const disk = new Set(present);
  const counts = { reads: 0, writes: 0, looks: 0 };
  let text = saved ? JSON.stringify(saved) : null;
  const store: RecentStore = {
    read: () => {
      counts.reads++;
      return text;
    },
    write: (t) => {
      counts.writes++;
      text = t;
    },
    exists: async (p) => {
      counts.looks++;
      return disk.has(p);
    },
  };
  return { store, counts, disk, saved: () => JSON.parse(text ?? "null") as string[] | null };
}

describe("the recent list", () => {
  it("is read from the data folder once, however often the menus are built", () => {
    const { store, counts } = pretend(["/docs/a.md", "/docs/b.md"]);
    const recent = new RecentList(store);
    for (let i = 0; i < 5; i++) expect(recent.entries().map((e) => e.path)).toEqual(["/docs/a.md", "/docs/b.md"]);
    expect(counts).toEqual({ reads: 1, writes: 0, looks: 0 });
  });

  it("keeps the newest first, at most 15, and writes each change through", () => {
    const { store, counts, saved } = pretend(null);
    const recent = new RecentList(store);
    for (let i = 1; i <= 17; i++) recent.add(`/docs/${i}.md`);
    recent.add("/docs/5.md");
    expect(recent.all()[0]).toBe("/docs/5.md");
    expect(recent.all()).toHaveLength(15);
    expect(saved()).toEqual(recent.all());
    expect(counts.writes).toBe(18);
    recent.replace("/docs/5.md", "/docs/five.md");
    expect(recent.all()[0]).toBe("/docs/five.md");
    expect(recent.all()).not.toContain("/docs/5.md");
    recent.forget("/docs/five.md");
    expect(recent.all()).not.toContain("/docs/five.md");
    recent.clear();
    expect(saved()).toEqual([]);
  });

  it("leaves documents found missing out of the menus, keeps them on the list, and shows them again once they're back", async () => {
    const { store, counts, disk } = pretend(["/docs/a.md", "/docs/gone.md", "/docs/b.md"], ["/docs/a.md", "/docs/b.md"]);
    const recent = new RecentList(store);
    expect(recent.entries()).toHaveLength(3); // nothing looked at yet: building the menu doesn't wait on the disk
    expect(await recent.recheck()).toBe(true);
    expect(counts.looks).toBe(3);
    expect(recent.entries().map((e) => e.path)).toEqual(["/docs/a.md", "/docs/b.md"]);
    expect(recent.all()).toContain("/docs/gone.md");
    expect(await recent.recheck()).toBe(false); // nothing changed
    disk.add("/docs/gone.md");
    expect(await recent.recheck()).toBe(true);
    expect(recent.entries()).toHaveLength(3);
    // One the person tried to open and wasn't there.
    expect(recent.missing("/docs/b.md")).toBe(true);
    expect(recent.entries().map((e) => e.path)).toEqual(["/docs/a.md", "/docs/gone.md"]);
    recent.add("/docs/b.md"); // opened again: it's there
    expect(recent.entries().map((e) => e.path)[0]).toBe("/docs/b.md");
  });

  it("follows a closed document found moved in its place on the list, not at the top (roadmap Batch 4, item 3)", async () => {
    const { store, saved } = pretend(["/docs/a.md", "/docs/b.md", "/docs/c.md"], ["/docs/a.md", "/docs/c.md"]);
    const recent = new RecentList(store);
    await recent.recheck(); // b.md is missing: out of the menus
    expect(recent.entries().map((e) => e.path)).toEqual(["/docs/a.md", "/docs/c.md"]);
    expect(recent.moved("/docs/b.md", "/work/b.md")).toBe(true);
    expect(recent.all()).toEqual(["/docs/a.md", "/work/b.md", "/docs/c.md"]);
    expect(saved()).toEqual(recent.all());
    // Found, so it's back in the menus under its new path.
    expect(recent.entries().map((e) => e.path)).toEqual(["/docs/a.md", "/work/b.md", "/docs/c.md"]);
    // Already on the list at its new place (opened from there since): the old entry just goes.
    expect(recent.moved("/docs/c.md", "/docs/a.md")).toBe(true);
    expect(recent.all()).toEqual(["/docs/a.md", "/work/b.md"]);
    // Not on the list: nothing changes.
    expect(recent.moved("/docs/z.md", "/docs/y.md")).toBe(false);
    expect(recent.all()).toEqual(["/docs/a.md", "/work/b.md"]);
  });

  it("names two documents with the same name by their folders", () => {
    const { store } = pretend(["/work/plan.md", "/home/plan.md", "/work/notes.md"]);
    expect(new RecentList(store).entries().map((e) => e.label)).toEqual(["plan (work)", "plan (home)", "notes"]);
  });

  // Roadmap Batch 11, F-24: File > Open Recent and the Dock's menu name a document as its tab does, without ".md".
  it("names each document without its Markdown ending, as its tab does, and in full only where that alone tells two apart", () => {
    const { store } = pretend(["/work/Offsite notes.md", "/work/Budget.markdown", "/work/todo.txt", "/work/plan.md", "/work/plan.mdown", "/home/plan.md"]);
    expect(new RecentList(store).entries().map((e) => e.label)).toEqual([
      "Offsite notes",
      "Budget",
      "todo.txt",
      "plan.md (work)",
      "plan.mdown (work)",
      "plan (home)",
    ]);
  });

  it("starts again empty from a damaged list, and never fails over writing it", () => {
    const { store } = pretend(null);
    store.read = () => "{ not a list";
    store.write = () => {
      throw new Error("disk full");
    };
    const recent = new RecentList(store);
    expect(recent.all()).toEqual([]);
    expect(() => recent.add("/docs/a.md")).not.toThrow();
    expect(recent.all()).toEqual(["/docs/a.md"]);
  });
});
