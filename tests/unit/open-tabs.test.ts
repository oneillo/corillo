// The list of open tabs Corillo brings back at launch (roadmap Batch 10,
// item 2): read without trusting it, written whole, and the one line in the
// window's corner for the documents it couldn't bring back.
import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A write cut off half-way (a power cut, a full disk): each write stops after half its bytes.
const cut = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const half = (d: string | Uint8Array) => (typeof d === "string" ? d.slice(0, Math.floor(d.length / 2)) : d.subarray(0, Math.floor(d.length / 2)));
  const writeFileSync = ((target: string | number, d: string | Uint8Array, ...rest: unknown[]) => {
    if (!cut.on) return (real.writeFileSync as (...a: unknown[]) => void)(target, d, ...rest);
    if (typeof target === "number") real.writeSync(target, half(d) as string);
    else (real.writeFileSync as (...a: unknown[]) => void)(target, half(d), ...rest);
    throw new Error("The power went.");
  }) as typeof real.writeFileSync;
  return { ...real, writeFileSync, default: { ...real, writeFileSync } };
});

const data = vi.hoisted(() => ({ dir: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => data.dir, emit: () => true },
  ipcMain: { handle: () => {}, on: () => {} },
}));
data.dir = mkdtempSync(join(tmpdir(), "corillo-open-tabs-"));

const { bringBackTabs, leftOutLine, readSaved, tabsToBringBack, within, CLOSED_UNEXPECTEDLY } = await import("../../src/main/open-tabs");

const list = () => join(data.dir, "open-tabs.json");

describe("the corner line for documents not brought back", () => {
  const none = { gone: [] as string[], away: [] as string[], unreadable: [] as string[], long: [] as string[] };

  it("says nothing when every document came back", () => {
    expect(leftOutLine(none)).toBeNull();
  });

  it("names one moved or deleted, as its tab did, without .md", () => {
    expect(leftOutLine({ ...none, gone: ["/docs/Plan.md"] })).toEqual({ text: "Plan couldn't be opened again.", detail: "It was moved or deleted." });
  });

  it("counts and names several", () => {
    expect(leftOutLine({ ...none, gone: ["/docs/Plan.md", "/docs/Notes.md", "/docs/Budget.md"] })).toEqual({
      text: "3 documents couldn't be opened again: Plan, Notes and Budget.",
      detail: "They were moved or deleted.",
    });
  });

  it("says when its drive isn't connected or a share didn't answer (B10-8)", () => {
    expect(leftOutLine({ ...none, away: ["/Volumes/Work/Notes.md"] })).toEqual({ text: "Notes wasn't opened.", detail: "It's on a drive or share that didn't answer." });
    expect(leftOutLine({ ...none, away: ["/Volumes/Work/Notes.md", "/Volumes/Work/Ideas.md"] })).toEqual({
      text: "2 documents weren't opened: Notes and Ideas.",
      detail: "They're on a drive or share that didn't answer.",
    });
  });

  it("says when Corillo can't read it (permission refused, say) (B10-8)", () => {
    expect(leftOutLine({ ...none, unreadable: ["/docs/Private.md"] })).toEqual({ text: "Private couldn't be opened again.", detail: "Corillo can't read it." });
    expect(leftOutLine({ ...none, unreadable: ["/docs/Private.md", "/docs/Locked.md"] })).toEqual({
      text: "2 documents couldn't be opened again: Private and Locked.",
      detail: "Corillo can't read them.",
    });
  });

  it("leaves one over 10 MB to be opened from File > Open Recent, never asking at launch (B10-8)", () => {
    expect(leftOutLine({ ...none, long: ["/docs/Big log.md"] })).toEqual({
      text: "Big log wasn't opened, since it's over 10 MB.",
      detail: "Open it from File > Open Recent when you're ready.",
    });
    expect(leftOutLine({ ...none, long: ["/docs/Big log.md", "/docs/Bigger log.md"] })?.detail).toBe("Open them from File > Open Recent when you're ready.");
  });

  it("puts several reasons in one line, in order: moved or deleted, can't be read, a drive away, over 10 MB", () => {
    expect(
      leftOutLine({ gone: ["/docs/Plan.md"], unreadable: ["/docs/Private.md"], away: ["/Volumes/Work/Notes.md", "/Volumes/Work/Ideas.md"], long: ["/docs/Big log.md"] }),
    ).toEqual({
      text: "5 documents weren't opened again: Plan, Private, Notes and 2 more.",
      detail:
        "Plan was moved or deleted. Corillo can't read Private. Notes and Ideas are on a drive or share that didn't answer. Big log is over 10 MB: open it from File > Open Recent when you're ready.",
    });
  });

  it("keeps a long list of names short", () => {
    const gone = ["A", "B", "C", "D", "E", "F"].map((n) => `/docs/${n}.md`);
    expect(leftOutLine({ ...none, gone })?.text).toBe("6 documents couldn't be opened again: A, B, C and 3 more.");
  });
});

describe("the list kept in the data folder", () => {
  it("is no list when it's missing, damaged or not a list", () => {
    expect(readSaved(join(data.dir, "nothing-here.json"))).toEqual({ tabs: [], front: null });
    writeFileSync(list(), '{ "tabs": ["/docs/plan.md", ');
    expect(readSaved()).toEqual({ tabs: [], front: null });
    writeFileSync(list(), "[1, 2]");
    expect(readSaved()).toEqual({ tabs: [], front: null });
  });

  it("keeps only full paths, each once, and a front that's among them", () => {
    writeFileSync(list(), JSON.stringify({ tabs: ["/docs/plan.md", "notes.md", 7, "/docs/plan.md", "/docs/budget.md"], front: "/docs/elsewhere.md" }));
    expect(readSaved()).toEqual({ tabs: ["/docs/plan.md", "/docs/budget.md"], front: null });
  });

  it("is written whole or not at all: a write cut off half-way leaves the list as it was", () => {
    const before = JSON.stringify({ tabs: ["/docs/plan.md", "/docs/notes.md"], front: "/docs/notes.md" });
    writeFileSync(list(), before);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    cut.on = true;
    try {
      tabsToBringBack(() => {}); // writes the mark
    } finally {
      cut.on = false;
      error.mockRestore();
    }
    expect(readFileSync(list(), "utf8")).toBe(before);
  });

  it("is marked while the tabs come back; a launch that finds the mark still set brings nothing back, says why, and empties it", () => {
    writeFileSync(list(), JSON.stringify({ tabs: ["/docs/plan.md"], front: "/docs/plan.md" }));
    const said: string[] = [];
    expect(tabsToBringBack((text) => said.push(text))).toEqual({ tabs: ["/docs/plan.md"], front: "/docs/plan.md" });
    expect(JSON.parse(readFileSync(list(), "utf8"))).toEqual({ tabs: ["/docs/plan.md"], front: "/docs/plan.md", restoring: true });
    expect(said).toEqual([]);
    // Corillo closed unexpectedly before the mark went.
    expect(tabsToBringBack((text) => said.push(text))).toBeNull();
    expect(said).toEqual([CLOSED_UNEXPECTEDLY.text]);
    expect(JSON.parse(readFileSync(list(), "utf8"))).toEqual({ tabs: [], front: null });
    // And the launch after that: nothing to bring back, nothing to say.
    expect(tabsToBringBack((text) => said.push(text))).toBeNull();
    expect(said).toHaveLength(1);
  });
});

describe("bringing the tabs back", () => {
  /** What the restore asked of the window, with these documents already open (by path, to their tab's id) and these kept after a crash. */
  async function restoreOf(tabs: string[], { open = {} as Record<string, string>, kept = [] as string[] } = {}) {
    const said: string[] = [];
    const opened: string[] = [];
    const placed: string[][] = [];
    await bringBackTabs(
      { tabs, front: null },
      {
        open: (p) => (opened.push(p), `tab of ${p}`),
        openAlready: (p) => open[p] ?? null,
        findMoved: async () => new Map(),
        keptAfterCrash: () => kept,
        place: (ids) => placed.push(ids),
        activate: () => {},
        say: (text, detail) => said.push(`${text} ${detail}`),
      },
      { frontTaken: true },
    );
    return { said, opened, placed: placed.at(-1) ?? [] };
  }

  it("never names a document over 10 MB that has edits kept after a crash: those come back in its tab (B10-2)", async () => {
    const big = join(data.dir, "Big log.md");
    writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1, 97));
    expect((await restoreOf([big])).said).toEqual(["Big log wasn't opened, since it's over 10 MB. Open it from File > Open Recent when you're ready."]);
    expect((await restoreOf([big], { kept: [big] })).said).toEqual([]);
  });

  it("never names a document that's open already under another name (renamed, then opened where it went), and puts it in its place (B10-2)", async () => {
    const plan = join(data.dir, "Plan.md");
    writeFileSync(plan, "Plan.\n");
    const notes = join(data.dir, "Notes, renamed since.md"); // not there any more
    const { said, opened, placed } = await restoreOf([notes, plan], { open: { [notes]: "tab of Notes v2" } });
    expect(said).toEqual([]);
    expect(opened).toEqual([plan]);
    expect(placed).toEqual(["tab of Notes v2", `tab of ${plan}`]);
  });
});

describe("the line after a launch that closed unexpectedly", () => {
  it("names only the documents left closed when edits kept after the crash bring one back (B10-2)", () => {
    writeFileSync(list(), JSON.stringify({ tabs: ["/docs/plan.md", "/docs/notes.md"], front: "/docs/plan.md", restoring: true }));
    const said: string[] = [];
    expect(tabsToBringBack((text, detail) => said.push(`${text} ${detail}`), ["/docs/plan.md"])).toBeNull();
    expect(said).toEqual(["notes wasn't opened again, since Corillo closed unexpectedly the last time it opened it. Open it from File > Open Recent when you're ready."]);
    // Every one of them back with its kept edits: nothing to say.
    writeFileSync(list(), JSON.stringify({ tabs: ["/docs/plan.md"], front: "/docs/plan.md", restoring: true }));
    expect(tabsToBringBack((text) => said.push(text), ["/docs/plan.md"])).toBeNull();
    expect(said).toHaveLength(1);
  });
});

describe("where a document on the list is", () => {
  it("is there, gone, or a place Corillo isn't allowed to read (B10-8)", async () => {
    const { lookAt } = await import("../../src/main/open-tabs");
    const here = join(data.dir, "Here.md");
    writeFileSync(here, "Here.\n");
    expect(await lookAt(here)).toEqual({ kind: "here", size: 6 });
    expect(await lookAt(join(data.dir, "Not here.md"))).toEqual({ kind: "gone" });
    const locked = join(data.dir, "Locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "Private.md"), "Private.\n");
    chmodSync(locked, 0o000);
    try {
      expect(await lookAt(join(locked, "Private.md"))).toEqual({ kind: "unreadable" });
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

// One helper for waiting a little and no longer, here and for the start screen (A16-11).
describe("waiting for something only so long", () => {
  it("gives its result in time, else null, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    try {
      expect(await within(Promise.resolve("here"), 100)).toBe("here");
      expect(vi.getTimerCount()).toBe(0);
      const late = within(new Promise<string>(() => {}), 100);
      await vi.advanceTimersByTimeAsync(100);
      expect(await late).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
