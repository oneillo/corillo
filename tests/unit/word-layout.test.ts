// Laying out a Word document (Orlando, 2026-11-09): "we should control the
// size of images to keep them from being too massive and we should calculate
// the optimal length of table column widths to get to the smallest vertical
// height possible for the entire table."
import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { columnWidths, tableHeight, textWidth, type TableText } from "../../src/core/column-widths";
import { fitPicture, LETTER_TEXT, ownSize, pictureDpi } from "../../src/core/picture-size";
import { textArea, wordLayout } from "../../src/main/export-prep";
import { buildReferenceDocx } from "../../src/main/reference-docx";
import { makeZip, readZipEntry } from "../../src/main/zip";
import { toWord } from "./word";
import { makePng } from "../fixtures/make-png";

const WIDTH = LETTER_TEXT.width;

const png = makePng;

const sentence = (n: number) => Array.from({ length: n }, (_, i) => ["the", "quarterly", "plan", "covers", "hiring", "and", "budget"][i % 7]).join(" ");

describe("table column widths", () => {
  const people: TableText = {
    headerRows: 1,
    rows: [
      ["Name", "Age", "Notes"],
      ["Ana", "34", sentence(40)],
      ["Luis", "29", sentence(25)],
      ["Marisol", "41", sentence(55)],
    ],
  };

  it("give a column of long text the room, and keep a column of numbers narrow", () => {
    const shares = columnWidths(people, WIDTH)!;
    const [name, age, notes] = shares.map((s) => s * WIDTH);
    expect(notes).toBeGreaterThan(0.7 * WIDTH);
    // The numbers column is about as wide as its widest word ("Age", bold), plus the cell's padding.
    expect(age).toBeLessThan(textWidth("Age", 10, true) + 2 * 5.75 + 12);
    expect(name).toBeLessThan(textWidth("Marisol", 10) + 2 * 5.75 + 12);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it("make the table shorter than equal columns do", () => {
    const shares = columnWidths(people, WIDTH)!;
    const ours = tableHeight(people, shares.map((s) => s * WIDTH));
    const equal = tableHeight(people, [WIDTH / 3, WIDTH / 3, WIDTH / 3]);
    expect(ours).toBeLessThan(equal);
  });

  it("share the room between two long columns by how much each has to say", () => {
    const table: TableText = {
      headerRows: 1,
      rows: [
        ["Short", "Long"],
        [sentence(12), sentence(60)],
        [sentence(10), sentence(50)],
      ],
    };
    const [short, long] = columnWidths(table, WIDTH)!;
    expect(long).toBeGreaterThan(short);
    expect(tableHeight(table, [short * WIDTH, long * WIDTH])).toBeLessThan(tableHeight(table, [WIDTH / 2, WIDTH / 2]));
  });

  it("are never worse than equal columns or columns in proportion to their words", () => {
    // A spread of tables, made the same way each run.
    let seed = 7;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let t = 0; t < 40; t++) {
      const columns = 2 + Math.floor(random() * 6);
      const rows = 2 + Math.floor(random() * 10);
      const table: TableText = {
        headerRows: 1,
        rows: Array.from({ length: rows }, () => Array.from({ length: columns }, () => sentence(Math.floor(random() * random() * 40)))),
      };
      const shares = columnWidths(table, WIDTH);
      if (!shares) continue;
      const ours = tableHeight(table, shares.map((s) => s * WIDTH));
      expect(ours).toBeLessThanOrEqual(tableHeight(table, Array(columns).fill(WIDTH / columns)));
      expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
      expect(Math.min(...shares)).toBeGreaterThan(0);
    }
  });

  it("come back quickly for a very large table of prose, and are still no worse than the simple ways (EX-13)", () => {
    // The review's tables: cells of 1 to 200 (or 300) words, made the same way each run.
    let seed = 12345;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const words = ["alpha", "beta", "gamma", "delta", "programme", "of", "the", "a", "international", "x", "reorganisation", "to", "and", "quarterly", "results", "it", "is", "budget", "plan"];
    const prose = (n: number) => Array.from({ length: n }, () => words[Math.floor(random() * words.length)]).join(" ");
    for (const [rows, columns, most] of [[1000, 4, 200], [3000, 3, 300]]) {
      const table: TableText = { headerRows: 1, rows: Array.from({ length: rows }, () => Array.from({ length: columns }, () => prose(1 + Math.floor(random() * most)))) };
      const started = performance.now();
      const shares = columnWidths(table, WIDTH)!;
      // Took about 2 s and 12 s before; the search now stops after a set amount of work, about a quarter of a second.
      expect(performance.now() - started).toBeLessThan(1_500);
      const ours = tableHeight(table, shares.map((s) => s * WIDTH));
      // This also checks that the choice is made by exact line counts (R-EX-13): for the
      // second table, counts reused from widths within a quarter point would choose the
      // search's widths, 108 lines taller than equal columns.
      expect(ours).toBeLessThanOrEqual(tableHeight(table, Array(columns).fill(WIDTH / columns)));
      expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    }
  });

  // The review's prose, made the same way each run.
  function proseTables(seed: number, count: number, rows: number, columns: number, most: number): TableText[] {
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const words = ["alpha", "beta", "gamma", "delta", "programme", "of", "the", "a", "international", "x", "reorganisation", "to", "and", "quarterly", "results", "it", "is", "budget", "plan"];
    const prose = (n: number) => Array.from({ length: n }, () => words[Math.floor(random() * words.length)]).join(" ");
    return Array.from({ length: count }, () => ({
      headerRows: 1,
      rows: Array.from({ length: rows }, () => Array.from({ length: columns }, () => prose(1 + Math.floor(random() * most)))),
    }));
  }

  /** A clock that runs this many times as fast as the real one, as on a Mac too busy to do much in a given time. */
  function busyMac<T>(times: number, work: () => T): T {
    const real = performance.now.bind(performance);
    const start = real();
    const clock = vi.spyOn(performance, "now").mockImplementation(() => start + (real() - start) * times);
    try {
      return work();
    } finally {
      clock.mockRestore();
    }
  }

  it("are the same on a busy Mac as on a quiet one: the search stops after a set amount of work, not time (R-TE-2)", () => {
    const tables = [...proseTables(12345, 1, 1000, 4, 200), ...proseTables(777, 1, 200, 4, 60)];
    const quiet = tables.map((t) => columnWidths(t, WIDTH));
    const busy = busyMac(50, () => tables.map((t) => columnWidths(t, WIDTH)));
    expect(busy).toEqual(quiet);
  });

  it("for a document of many big tables come back quickly, the same however busy the Mac, each no worse than the simple ways (R-EX-2)", () => {
    // Twenty-four tables of 400 rows of prose: about 6 seconds of work for the window's process before (a quarter of a second each).
    const tables = proseTables(4242, 24, 400, 4, 60);
    const cell = (text: string) => [["", [], []], { t: "AlignDefault" }, 1, 1, [{ t: "Plain", c: [{ t: "Str", c: text }] }]];
    const row = (cells: string[]) => [["", [], []], cells.map(cell)];
    const ast = {
      blocks: tables.map((t) => ({
        t: "Table",
        c: [["", [], []], [null, []], t.rows[0].map(() => [{ t: "AlignDefault" }, { t: "ColWidthDefault" }]), [["", [], []], [row(t.rows[0])]], [[["", [], []], 0, [], t.rows.slice(1).map(row)]], [["", [], []], []]],
      })),
    };
    const started = performance.now();
    const layout = wordLayout(ast, LETTER_TEXT);
    expect(performance.now() - started).toBeLessThan(3_000); // about 0.4 s on an M4 Mac mini
    expect(layout.tables).toHaveLength(24);
    layout.tables.forEach((shares, i) => {
      expect(shares, `table ${i + 1}`).not.toBeNull();
      expect(tableHeight(tables[i], shares!.map((s) => s * WIDTH))).toBeLessThanOrEqual(tableHeight(tables[i], Array(4).fill(WIDTH / 4)));
    });
    expect(busyMac(50, () => wordLayout(ast, LETTER_TEXT).tables)).toEqual(layout.tables);
  });

  it("are left to Word when every column fits without wrapping", () => {
    expect(columnWidths({ headerRows: 1, rows: [["Name", "Age"], ["Ana", "34"]] }, WIDTH)).toBeNull();
  });

  it("count a line break in a cell as a line", () => {
    const table: TableText = { headerRows: 0, rows: [["one\ntwo\nthree", "x"]] };
    expect(tableHeight(table, [200, 200])).toBe(3);
  });

  it("break a word too long for any column, as Word does, rather than fail", () => {
    const long = "x".repeat(400);
    const shares = columnWidths({ headerRows: 0, rows: [[long, long, long]] }, WIDTH)!;
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it("land in the Word document: the long column wide, the number column narrow, the whole width of the page", () => {
    const markdown =
      "| Name | Age | Notes |\n|---|---:|---|\n" + people.rows.slice(1).map((r) => `| ${r.join(" | ")} |`).join("\n") + "\n\n| A | B |\n|---|---|\n| fits | fine |\n";
    const word = toWord(markdown);
    const [wide, fits] = [...word.xml.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>/g)].map((m) => m[1]);
    expect(wide).toContain('<w:tblW w:type="pct" w:w="5000" />');
    expect(wide).toContain('<w:tblLayout w:type="fixed" />');
    const grid = [...wide.matchAll(/<w:gridCol w:w="(\d+)" \/>/g)].map((m) => Number(m[1]));
    const total = grid.reduce((a, b) => a + b, 0);
    const expected = columnWidths(people, WIDTH)!;
    grid.forEach((g, i) => expect(g / total).toBeCloseTo(expected[i], 2));
    expect(grid[2]).toBeGreaterThan(grid[0] + grid[1]);
    expect(word.layout.tables).toEqual([expected, null]);
    // The table that fits is sized by Word, to its words.
    expect(fits).toContain('<w:tblW w:type="auto" w:w="0" />');
  });
});

describe("picture sizes", () => {
  it("never make a picture bigger than its own size", () => {
    expect(fitPicture({ width: 60, height: 30 })).toEqual({ width: 60, height: 30 });
  });

  it("fit a wide picture to the page's text width, keeping its shape", () => {
    const fitted = fitPicture({ width: 2000, height: 500 });
    expect(fitted.width).toBeCloseTo(WIDTH);
    expect(fitted.height).toBeCloseTo(117);
  });

  it("keep a tall picture to half the height of the page's text", () => {
    const fitted = fitPicture({ width: 600, height: 2400 });
    expect(fitted.height).toBeCloseTo(LETTER_TEXT.height / 2);
    expect(fitted.width).toBeCloseTo(81);
  });

  it("show a Retina screenshot (144 dots per inch) at half its pixel size; a picture that doesn't say, a point per pixel", () => {
    expect(ownSize({ width: 800, height: 600 }, { x: 144, y: 144 })).toEqual({ width: 400, height: 300 });
    expect(ownSize({ width: 800, height: 600 }, null)).toEqual({ width: 800, height: 600 });
  });

  it("read the dots per inch from a PNG and from a JPEG's header", () => {
    expect(pictureDpi(png(10, 10, 288))).toEqual({ x: 288, y: 288 });
    expect(pictureDpi(png(10, 10, 144))).toEqual({ x: 143, y: 143 }); // as Pandoc reads it
    expect(pictureDpi(png(10, 10))).toBeNull();
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, 0, 150, 0, 150, 0, 0]);
    expect(pictureDpi(jpeg)).toEqual({ x: 150, y: 150 });
    expect(pictureDpi(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("are the same in the Word document as Corillo works them out for the page", () => {
    const pictures: [string, Uint8Array, string][] = [
      ["small.png", png(60, 30), ""],
      ["wide.png", png(2000, 500), ""],
      ["tall.png", png(400, 1600, 144), ""],
      ["retina.png", png(1600, 1000, 144), ""],
      ["dialog.png", png(500, 300, 144), ""],
      ["half.png", png(300, 100), "{width=50%}"],
    ];
    const markdown = pictures.map(([name, , attrs]) => `![${name}](${name})${attrs}`).join("\n\n") + "\n";
    const word = toWord(markdown, {}, (dir) => pictures.forEach(([name, bytes]) => writeFileSync(join(dir, name), bytes)));
    const extents = [...word.xml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)].map((m) => ({ width: Number(m[1]) / 12700, height: Number(m[2]) / 12700 }));
    expect(extents).toHaveLength(pictures.length);
    pictures.forEach(([name, bytes, attrs], i) => {
      const dpi = pictureDpi(bytes);
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      const own = ownSize({ width: view.getUint32(16), height: view.getUint32(20) }, dpi);
      const asked = attrs ? { width: WIDTH / 2, height: (own.height * WIDTH) / 2 / own.width } : own;
      const expected = fitPicture(asked);
      // Word sizes are written to a hundredth of an inch.
      expect(Math.abs(extents[i].width - expected.width), name).toBeLessThan(0.75);
      expect(Math.abs(extents[i].height - expected.height), name).toBeLessThan(0.75);
    });
    // The Retina dialog is about half its pixel size: 250 by 150 points (Pandoc reads 143 dots per inch).
    expect(Math.abs(extents[4].width - 250)).toBeLessThan(3);
    // Nothing is wider than the page's text or taller than half of it.
    for (const e of extents) {
      expect(e.width).toBeLessThanOrEqual(WIDTH + 0.5);
      expect(e.height).toBeLessThanOrEqual(LETTER_TEXT.height / 2 + 0.5);
    }
  });
});

describe("the page's text area", () => {
  it("is read from the Word document the styles come from", () => {
    expect(textArea(buildReferenceDocx("Letter"))).toEqual({ width: 468, height: 648 });
    const a4 = textArea(buildReferenceDocx("A4"));
    expect(a4.width).toBeCloseTo(451.3, 1);
    expect(a4.height).toBeCloseTo(697.9, 1);
  });

  it("is a Letter page's when the document doesn't say", () => {
    expect(textArea(makeZip([{ name: "word/document.xml", data: "<w:document/>" }]))).toEqual(LETTER_TEXT);
    expect(textArea(new Uint8Array([1, 2, 3]))).toEqual(LETTER_TEXT);
  });

  it("can be read from a zip Corillo didn't write (stored or compressed)", () => {
    const zip = makeZip([
      { name: "a.txt", data: "first" },
      { name: "word/document.xml", data: "<w:sectPr/>" },
    ]);
    expect(readZipEntry(zip, "a.txt")?.toString()).toBe("first");
    expect(readZipEntry(zip, "word/document.xml")?.toString()).toBe("<w:sectPr/>");
    expect(readZipEntry(zip, "missing")).toBeNull();
  });

  it("won't unpack a file far bigger than any Word document's (a zip made to fill the memory)", () => {
    const zip = makeZip([{ name: "word/document.xml", data: new Uint8Array(2 * 1024 * 1024) }]);
    expect(zip.length).toBeLessThan(10 * 1024);
    expect(readZipEntry(zip, "word/document.xml", 512 * 1024)).toBeNull();
    expect(readZipEntry(zip, "word/document.xml")?.length).toBe(2 * 1024 * 1024);
  });
});
