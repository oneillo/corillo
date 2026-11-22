// What the app tells the window about pictures on this Mac: when each last
// changed (so a picture written again shows afresh), and the dots per inch it
// says, read from the start of the file only.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { HEAD_BYTES, pictureDpiOfFile, pictureHead, pictureStamp, picturesAllowed } from "../../src/main/picture-stamps";
import { makePng } from "../fixtures/make-png";
import { pictureDpi } from "../../src/core/picture-size";

const folder = mkdtempSync(join(tmpdir(), "corillo-stamps-"));
const url = (name: string) => pathToFileURL(join(folder, name)).href;

describe("pictures on this Mac", () => {
  it("a PNG's dots per inch come from its start, however big the file", () => {
    const png = makePng(400, 300, 144);
    writeFileSync(join(folder, "big.png"), png);
    appendFileSync(join(folder, "big.png"), new Uint8Array(20 * HEAD_BYTES)); // megabytes after the picture's header
    return expect(pictureDpiOfFile(url("big.png"))).resolves.toEqual(pictureDpi(png)); // 144, as a whole number of dots per metre gives it
  });

  it("only the start is read: a PNG that says its dots per inch past the first 64 KB has none", async () => {
    // A long note (a tEXt part) between the PNG's header and the part that says its dots per inch.
    const png = makePng(400, 300, 144);
    const afterHeader = 8 + 25;
    const note = new Uint8Array(12 + 2 * HEAD_BYTES);
    new DataView(note.buffer).setUint32(0, 2 * HEAD_BYTES);
    note.set([..."tEXt"].map((c) => c.charCodeAt(0)), 4);
    const late = new Uint8Array(png.length + note.length);
    late.set(png.subarray(0, afterHeader));
    late.set(note, afterHeader);
    late.set(png.subarray(afterHeader), afterHeader + note.length);
    expect(pictureDpi(late)).toEqual(pictureDpi(png)); // the whole file says it
    expect(pictureDpi(late)).not.toBeNull();
    writeFileSync(join(folder, "late.png"), late);
    expect(await pictureDpiOfFile(url("late.png"))).toBeNull();
  });

  it("a JPEG's dots per inch come from its JFIF header", () => {
    const head = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...[..."JFIF"].map((c) => c.charCodeAt(0)), 0, 1, 1, 1, 0x01, 0x2c, 0x01, 0x2c, 0, 0];
    const bytes = new Uint8Array(3 * HEAD_BYTES);
    bytes.set(head);
    writeFileSync(join(folder, "photo.jpg"), bytes);
    return expect(pictureDpiOfFile(url("photo.jpg"))).resolves.toEqual({ x: 300, y: 300 });
  });

  it("a picture that doesn't say, or isn't there, has none", async () => {
    writeFileSync(join(folder, "plain.png"), makePng(10, 10));
    expect(await pictureDpiOfFile(url("plain.png"))).toBeNull();
    expect(await pictureDpiOfFile(url("gone.png"))).toBeNull();
    expect(await pictureDpiOfFile("https://example.com/chart.png")).toBeNull();
  });

  // A named pipe waits for something to write into it: opened the usual way, it would hold one of Node's
  // four file threads for good (or the whole app, read in one go). It's answered as not there (R-MAIN-4).
  it("a named pipe with a picture's name is answered as not there, at once, and its start is never waited for", async () => {
    execFileSync("/usr/bin/mkfifo", [join(folder, "pipe.png")]);
    const started = Date.now();
    expect(await pictureDpiOfFile(url("pipe.png"))).toBeNull();
    expect(await pictureStamp(url("pipe.png"))).toBeNull();
    expect(await pictureHead(join(folder, "pipe.png"), 4096)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    writeFileSync(join(folder, "small.png"), makePng(10, 10));
    expect(await pictureHead(join(folder, "small.png"), 4096)).toEqual(new Uint8Array(makePng(10, 10)));
  });

  it("a picture's stamp changes when it's written again, and is null while it isn't there", async () => {
    expect(await pictureStamp(url("chart.png"))).toBeNull();
    writeFileSync(join(folder, "chart.png"), makePng(40, 30));
    utimesSync(join(folder, "chart.png"), new Date(2026, 0, 1), new Date(2026, 0, 1));
    const first = await pictureStamp(url("chart.png"));
    expect(first).not.toBeNull();
    expect(await pictureStamp(url("chart.png"))).toBe(first);
    writeFileSync(join(folder, "chart.png"), makePng(40, 30));
    expect(await pictureStamp(url("chart.png"))).not.toBe(first);
    expect(await pictureStamp(pathToFileURL(folder).href)).toBeNull(); // a folder isn't a picture
  });
});

describe("which pictures the window may ask about", () => {
  const root = mkdtempSync(join(tmpdir(), "corillo-allowed-"));
  const vault = join(root, "Vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  mkdirSync(join(vault, "Notes"), { recursive: true });
  const doc = { filePath: join(vault, "Notes", "plan.md"), diskText: "![a](/Shared/My%20Chart.png) and ![[Pasted image 1.PNG]]\n" };
  const allowed = picturesAllowed([doc]);

  it("pictures beside the document, below its folder or anywhere in its Obsidian vault", () => {
    expect(allowed(join(vault, "Notes", "plan images", "chart.png"))).toBe(true);
    expect(allowed(join(vault, "attachments", "photo.jpeg"))).toBe(true);
    expect(allowed(join(root, "elsewhere.png"))).toBe(false);
  });

  it("a picture elsewhere only when the document's text names it, however its name is written", () => {
    expect(allowed("/Shared/My Chart.png")).toBe(true);
    expect(allowed("/Elsewhere/pasted image 1.png")).toBe(true);
    expect(allowed("/Shared/Other.png")).toBe(false);
  });

  it("never a file of another kind, wherever it is", () => {
    expect(allowed(join(vault, "Notes", "secret.txt"))).toBe(false);
    expect(allowed(join(vault, "Notes", "plan.md"))).toBe(false);
    expect(picturesAllowed([{ ...doc, diskText: "See /Users/me/.ssh/id_rsa\n" }])("/Users/me/.ssh/id_rsa")).toBe(false);
  });
});
