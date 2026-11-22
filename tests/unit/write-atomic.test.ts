// The one way Corillo writes its own files whole or not at all (writeAtomic in
// store.ts), used by its records, the history and the unsaved edits kept for a
// crash (Batch 18, A16-9): the new file takes the old one's place only once
// it's all written, flushed to the disk when asked, its folder made when asked,
// and a write that fails leaves the old file and no temporary file behind.
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fsCalls = vi.hoisted(() => ({ fsyncs: 0, cutWrite: false }));
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const fsyncSync = ((fd: number) => {
    fsCalls.fsyncs++;
    return real.fsyncSync(fd);
  }) as typeof real.fsyncSync;
  const writeFileSync = ((target: string | number, data: string | Uint8Array, ...rest: unknown[]) => {
    if (fsCalls.cutWrite && typeof target === "number") {
      if (typeof data === "string") real.writeSync(target, data.slice(0, 3));
      else real.writeSync(target, data.subarray(0, 3));
      throw new Error("The disk is full.");
    }
    return (real.writeFileSync as (...a: unknown[]) => void)(target, data, ...rest);
  }) as typeof real.writeFileSync;
  return { ...real, fsyncSync, writeFileSync, default: { ...real, fsyncSync, writeFileSync } };
});

const { writeAtomic } = await import("../../src/main/store");
const { RecoveryStore } = await import("../../src/main/recovery");

const root = mkdtempSync(join(tmpdir(), "corillo-write-atomic-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const folder = () => {
  const dir = join(root, `case-${++n}`);
  mkdirSync(dir);
  return dir;
};

describe("writing a file whole or not at all", () => {
  it("puts the new text in place of the old, with no temporary file left", () => {
    const dir = folder();
    const file = join(dir, "list.json");
    writeFileSync(file, "old");
    writeAtomic(file, "new text");
    expect(readFileSync(file, "utf8")).toBe("new text");
    writeAtomic(file, Buffer.from("bytes"));
    expect(readFileSync(file, "utf8")).toBe("bytes");
    expect(readdirSync(dir)).toEqual(["list.json"]);
  });

  it("flushes to the disk only when asked", () => {
    const file = join(folder(), "records.json");
    fsCalls.fsyncs = 0;
    writeAtomic(file, "not flushed");
    expect(fsCalls.fsyncs).toBe(0);
    writeAtomic(file, "flushed", true);
    expect(fsCalls.fsyncs).toBe(1);
  });

  it("makes the file's folder when asked, and otherwise fails leaving nothing", () => {
    const dir = folder();
    const missing = join(dir, "history", "deeper", "latest.json.gz");
    expect(() => writeAtomic(missing, "text")).toThrow();
    expect(readdirSync(dir)).toEqual([]);
    writeAtomic(missing, "text", true, { makeFolder: true });
    expect(readFileSync(missing, "utf8")).toBe("text");
  });

  it("leaves the old file and no temporary file when the write fails half-way", () => {
    const dir = folder();
    const file = join(dir, "comments.json.gz");
    writeFileSync(file, "the old comments");
    fsCalls.cutWrite = true;
    try {
      expect(() => writeAtomic(file, "the new comments", true)).toThrow("The disk is full.");
    } finally {
      fsCalls.cutWrite = false;
    }
    expect(readFileSync(file, "utf8")).toBe("the old comments");
    expect(readdirSync(dir)).toEqual(["comments.json.gz"]);
  });

  it("leaves no temporary file when the new file can't take the old one's place", () => {
    const dir = folder();
    const target = join(dir, "taken");
    mkdirSync(target);
    writeFileSync(join(target, "inside"), "a folder with something in it, which no file can replace");
    expect(() => writeAtomic(target, "text")).toThrow();
    expect(readdirSync(dir)).toEqual(["taken"]);
  });
});

describe("unsaved edits kept for a crash, through it", () => {
  it("are kept flushed, in a folder made for them, and read back", () => {
    const data = folder();
    const store = new RecoveryStore(data);
    fsCalls.fsyncs = 0;
    expect(store.keep("doc-1", { filePath: "/docs/plan.md", base: "a", text: "ab" })).toBe(true);
    expect(fsCalls.fsyncs).toBe(1);
    expect(store.all()).toEqual([{ id: "doc-1", entry: { filePath: "/docs/plan.md", base: "a", text: "ab" } }]);
    expect(readdirSync(join(data, "recovery"))).toEqual(["doc-1.json"]);
  });

  it("say they couldn't be kept when the write fails, and keep the earlier copy", () => {
    const data = folder();
    const store = new RecoveryStore(data);
    store.keep("doc-1", { filePath: "/docs/plan.md", base: "a", text: "ab" });
    fsCalls.cutWrite = true;
    try {
      expect(store.keep("doc-1", { filePath: "/docs/plan.md", base: "a", text: "abc" })).toBe(false);
    } finally {
      fsCalls.cutWrite = false;
    }
    expect(store.all()).toEqual([{ id: "doc-1", entry: { filePath: "/docs/plan.md", base: "a", text: "ab" } }]);
    expect(readdirSync(join(data, "recovery"))).toEqual(["doc-1.json"]);
  });

  it("say they couldn't be kept when the data folder can't hold them", () => {
    const data = folder();
    writeFileSync(join(data, "recovery"), "a file where the folder would go");
    expect(new RecoveryStore(data).keep("doc-1", { filePath: "/docs/plan.md", base: "a", text: "ab" })).toBe(false);
  });
});
