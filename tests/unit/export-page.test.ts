// The export's hidden page and the file it writes (roadmap Batch 18, item 3,
// App S2 and S4). A PDF export runs here with Electron stood in for, so a
// page that fails to load and the order of the last writes can be seen:
// - the hidden page is closed when it fails to load, never left open;
// - the finished file is flushed to the disk before it takes its name, so a
//   power cut can't leave a short file under the name the person chose.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const fake = vi.hoisted(() => ({
  /** Make the next export page fail to load. */
  loadFails: false,
  windows: [] as { destroyed: boolean }[],
  heard: new Map<string, (...args: unknown[]) => void>(),
  /** What the file system was asked to do, in order. */
  steps: [] as string[],
  fds: new Map<number, string>(),
  /** Corillo's data folder for this test. */
  data: "",
  /** The Mac's error the export's next flush of its finished file meets, if any. */
  flushFails: null as string | null,
}));

vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const openSync = ((file: fs.PathLike, ...rest: unknown[]) => {
    const fd = (real.openSync as (...a: unknown[]) => number)(file, ...rest);
    fake.fds.set(fd, String(file));
    return fd;
  }) as typeof real.openSync;
  const fsyncSync = ((fd: number) => {
    fake.steps.push(`flush ${path.basename(fake.fds.get(fd) ?? "?")}`);
    const code = fake.fds.get(fd)?.endsWith(".corillo-exporting") ? fake.flushFails : null;
    if (code) fake.flushFails = null;
    if (code) throw Object.assign(new Error(`${code}: the disk said no`), { code });
    return real.fsyncSync(fd);
  }) as typeof real.fsyncSync;
  const renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    fake.steps.push(`rename ${path.basename(String(from))} to ${path.basename(String(to))}`);
    return real.renameSync(from, to);
  }) as typeof real.renameSync;
  const parts = { ...real, openSync, fsyncSync, renameSync };
  return { ...parts, default: parts };
});

vi.mock("electron", () => {
  class BrowserWindow {
    destroyed = false;
    webContents = {
      on: () => {},
      removeListener: () => {},
      setWindowOpenHandler: () => {},
      // The page answers each request at once: drawn, nothing broken.
      send: (_channel: string, id: string) => fake.heard.get("export-page:reply")?.({ sender: this.webContents }, id, { value: { brokenDiagrams: 0 } }),
      printToPDF: async () => Buffer.from("%PDF-1.7\n% a page\n%%EOF\n"),
    };
    constructor() {
      fake.windows.push(this);
    }
    loadFile() {
      return fake.loadFails ? Promise.reject(new Error("ERR_FILE_NOT_FOUND (-6) loading 'export.html'")) : Promise.resolve();
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return {
    app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => fake.data, getSystemLocale: () => "en-US", getLocale: () => "en-US", getAppMetrics: () => [], on: () => {} },
    BrowserWindow,
    dialog: {},
    shell: {},
    net: {},
    webContents: { fromId: () => undefined },
    session: { fromPartition: () => ({ protocol: { handle: () => {} }, webRequest: { onBeforeRequest: () => {} } }) },
    ipcMain: {
      handle: () => {},
      on: (channel: string, fn: (...args: unknown[]) => void) => fake.heard.set(channel, fn),
      removeListener: (channel: string) => fake.heard.delete(channel),
    },
  };
});

const { exportDocument } = await import("../../src/main/export");

let folder: string;
let doc: string;
beforeEach(() => {
  folder = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "corillo-export-page-")));
  doc = path.join(folder, "plan.md");
  fs.writeFileSync(doc, "# Plan\n\nWe should hire two people this quarter.\n");
  fake.data = fs.mkdtempSync(path.join(tmpdir(), "corillo-export-data-"));
  fake.loadFails = false;
  fake.flushFails = null;
  fake.windows.length = 0;
  fake.steps.length = 0;
});
afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
  fs.rmSync(fake.data, { recursive: true, force: true });
});

describe("a PDF export's hidden page", () => {
  it("is closed when it fails to load", async () => {
    fake.loadFails = true;
    await expect(exportDocument(doc, "pdf")).rejects.toThrow();
    expect(fake.windows.length).toBe(1);
    expect(fake.windows[0].destroyed).toBe(true);
    expect(fs.existsSync(path.join(folder, "plan.pdf"))).toBe(false);
  });

  it("is closed after an export that works", async () => {
    await exportDocument(doc, "pdf");
    expect(fake.windows.map((w) => w.destroyed)).toEqual([true]);
  });
});

describe("the exported file", () => {
  it("is flushed to the disk before it takes its name", async () => {
    const { outputPath } = await exportDocument(doc, "pdf");
    expect(outputPath).toBe(path.join(folder, "plan.pdf"));
    expect(fs.readFileSync(outputPath, "utf8")).toBe("%PDF-1.7\n% a page\n%%EOF\n");
    const rename = fake.steps.findIndex((s) => s === "rename .plan.pdf.corillo-exporting to plan.pdf");
    expect(rename).toBeGreaterThan(-1);
    expect(fake.steps.slice(0, rename)).toContain("flush .plan.pdf.corillo-exporting");
    // Nothing of the export's own is left in the person's folder.
    expect(fs.readdirSync(folder).sort()).toEqual(["plan.md", "plan.pdf"]);
  });

  it("clears a temporary file left by an export that was cut off", async () => {
    fs.writeFileSync(path.join(folder, ".plan.pdf.corillo-exporting"), "half a fi");
    await exportDocument(doc, "pdf");
    expect(fs.readdirSync(folder).sort()).toEqual(["plan.md", "plan.pdf"]);
  });

  it("is never written through a link waiting under its temporary name (Batch 21, E21-12)", async () => {
    const other = path.join(folder, "budget.txt");
    fs.writeFileSync(other, "The budget, which no export should touch.\n");
    fs.symlinkSync(other, path.join(folder, ".plan.pdf.corillo-exporting"));
    await expect(exportDocument(doc, "pdf")).rejects.toThrow("Corillo couldn't save plan.pdf: the file couldn't be written.");
    expect(fs.readFileSync(other, "utf8")).toBe("The budget, which no export should touch.\n");
    expect(fs.existsSync(path.join(folder, "plan.pdf"))).toBe(false);
    // The link isn't Corillo's, so it's left as it was.
    expect(fs.lstatSync(path.join(folder, ".plan.pdf.corillo-exporting")).isSymbolicLink()).toBe(true);
  });

  it("says so when the disk is full (Batch 21, E21-7)", async () => {
    fake.flushFails = "ENOSPC";
    await expect(exportDocument(doc, "pdf")).rejects.toThrow("Corillo couldn't save plan.pdf: the disk is full.");
    expect(fs.readdirSync(folder)).toEqual(["plan.md"]);
  });

  it("a Word document's temporary file isn't written through a link either (Batch 21, E21-12)", async () => {
    const other = path.join(folder, "budget.txt");
    fs.writeFileSync(other, "The budget.\n");
    fs.symlinkSync(other, path.join(folder, ".plan.docx.corillo-exporting"));
    await expect(exportDocument(doc, "docx")).rejects.toThrow("Corillo couldn't save plan.docx: the file couldn't be written.");
    expect(fs.readFileSync(other, "utf8")).toBe("The budget.\n");
    expect(fs.existsSync(path.join(folder, "plan.docx"))).toBe(false);
    fs.unlinkSync(path.join(folder, ".plan.docx.corillo-exporting"));
    await exportDocument(doc, "docx");
    expect(fs.readdirSync(folder).sort()).toEqual(["budget.txt", "plan.docx", "plan.md"]);
  });
});
