// Column widths for a table in a Word document (Orlando, 2026-11-09): the
// widths that make the whole table as short as possible on the page. Each row
// is as tall as its tallest cell, and a cell grows a line each time its words
// wrap; so the room goes where it saves the most lines, a column of long
// sentences gets it and a column of numbers stays narrow.
//
// Text widths are estimates, not measurements: each character's width as a
// share of the font size, in a few groups (narrow letters such as i and l,
// capitals, wide letters such as m and W, and so on), close to the proportions
// of the plain sans-serif fonts Word uses. Bold is a little wider. Good enough
// to tell which column needs the room; Word does the real wrapping.

/** How a table's text is set in Word (Corillo's Word style): sizes in points. */
export interface TableType {
  /** The text size. */
  size: number;
  /** Space inside each cell, on the left and on the right. */
  padding: number;
  /** The narrowest a column may be, padding included. */
  minColumn: number;
}

export const WORD_TABLE: TableType = { size: 10, padding: 5.75, minColumn: 28 };

const GROUPS: [RegExp, number][] = [
  [/[ijl.,:;'|!`\u00A0 ]/, 0.26],
  [/[ftrI()[\]{}/\\\-"*]/, 0.34],
  [/[sz?]/, 0.45],
  [/[mw]/, 0.8],
  [/[MW@%]/, 0.9],
  [/[A-HJ-LN-VX-Z&]/, 0.66],
  [/[0-9$#+=<>~^_]/, 0.55],
  [/[a-z]/, 0.52],
  // Wide characters: Chinese, Japanese, Korean, emoji.
  [/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|\p{Extended_Pictographic}/u, 1],
];

const charWidths = new Map<string, number>();

function charWidth(ch: string): number {
  let w = charWidths.get(ch);
  if (w === undefined) {
    w = GROUPS.find(([pattern]) => pattern.test(ch))?.[1] ?? 0.55;
    charWidths.set(ch, w);
  }
  return w;
}

/** About how wide this text is, in points, at this size. */
export function textWidth(text: string, size: number, bold = false): number {
  let em = 0;
  for (const ch of text) em += charWidth(ch);
  return em * size * (bold ? 1.06 : 1);
}

interface Measured {
  /** Each line the cell's own line breaks make: its words' widths. */
  lines: number[][];
  space: number;
  /** The longest line, unwrapped, and the longest word. */
  natural: number;
  longestWord: number;
  /** How many words: the work of counting its lines. */
  words: number;
}

function measure(text: string, type: TableType, bold: boolean): Measured {
  const space = textWidth(" ", type.size, bold);
  const lines = text.split("\n").map((line) =>
    line
      .split(/[ \t]+/)
      .filter(Boolean)
      .map((word) => textWidth(word, type.size, bold)),
  );
  const natural = Math.max(0, ...lines.map((words) => words.reduce((sum, w) => sum + w, 0) + space * Math.max(0, words.length - 1)));
  const longestWord = Math.max(0, ...lines.flat());
  return { lines, space, natural, longestWord, words: lines.reduce((sum, words) => sum + words.length, 0) };
}

/** How many lines a cell's text takes in this much room (points, padding left out). */
function lineCount(cell: Measured, room: number): number {
  let count = 0;
  for (const words of cell.lines) {
    count++;
    let used = 0;
    for (const w of words) {
      if (used > 0 && used + cell.space + w <= room) {
        used += cell.space + w;
        continue;
      }
      if (used > 0) count++;
      // A word wider than the column is broken across lines, as Word does.
      const pieces = Math.max(1, Math.ceil(w / Math.max(room, 1) - 1e-9));
      count += pieces - 1;
      used = w - (pieces - 1) * room;
    }
  }
  return Math.max(1, count);
}

export interface TableText {
  /** Each row's cells, as text; a line break in a cell as "\n". */
  rows: string[][];
  /** How many rows at the top are the header (bold in Word). */
  headerRows: number;
}

/**
 * What the search for a document's column widths may still do, in steps of
 * work: a word placed on a line is one; a line count looked up again takes
 * about as long as placing ten. Shared by every table of an export (see
 * SEARCH_BUDGET).
 */
export interface SearchBudget {
  left: number;
}

const LOOKUP_WORK = 10;

class Grid {
  readonly cells: Measured[][];
  readonly columns: number;
  private memo = new Map<string, number>();

  constructor(table: TableText, readonly type: TableType, readonly budget: SearchBudget = { left: Infinity }) {
    this.columns = Math.max(0, ...table.rows.map((r) => r.length));
    this.cells = table.rows.map((row, r) =>
      Array.from({ length: this.columns }, (_, c) => measure(row[c] ?? "", type, r < table.headerRows)),
    );
  }

  /** A cell's line count in this much room (points, padding left out), its work counted. */
  count(cell: Measured, room: number): number {
    this.budget.left -= cell.words + 1;
    return lineCount(cell, room);
  }

  lines(r: number, c: number, width: number): number {
    const key = `${r},${c},${Math.round(width * 4)}`;
    this.budget.left -= LOOKUP_WORK;
    let n = this.memo.get(key);
    if (n === undefined) {
      n = this.count(this.cells[r][c], width - 2 * this.type.padding);
      this.memo.set(key, n);
    }
    return n;
  }

  /** The narrowest room in which the cell takes no more than this many lines. */
  roomFor(cell: Measured, lines: number): number {
    let low = 1;
    let high = Math.max(cell.natural, 1);
    if (this.count(cell, high) > lines) return Infinity;
    while (high - low > 0.25) {
      const mid = (low + high) / 2;
      if (this.count(cell, mid) <= lines) high = mid;
      else low = mid;
    }
    return high;
  }

  /**
   * The table's height, in lines: each row as tall as its tallest cell.
   * `exact` counts afresh rather than reusing a count for a width within a
   * quarter point, which can be a line off.
   */
  height(widths: number[], exact = false): number {
    let total = 0;
    for (let r = 0; r < this.cells.length; r++) {
      let tallest = 1;
      for (let c = 0; c < this.columns; c++) {
        const lines = exact ? lineCount(this.cells[r][c], widths[c] - 2 * this.type.padding) : this.lines(r, c, widths[c]);
        tallest = Math.max(tallest, lines);
      }
      total += tallest;
    }
    return total;
  }

  /** Each column's width with nothing wrapped, padding included. */
  natural(c: number): number {
    return Math.max(this.type.minColumn, ...this.cells.map((row) => row[c].natural + 2 * this.type.padding));
  }

  /** Each column's narrowest width that breaks no word. */
  floor(c: number): number {
    return Math.min(this.natural(c), Math.max(this.type.minColumn, ...this.cells.map((row) => row[c].longestWord + 2 * this.type.padding)));
  }
}

/** How tall a table is, in lines, with these column widths (points). */
export function tableHeight(table: TableText, widths: number[], type: TableType = WORD_TABLE): number {
  return new Grid(table, type).height(widths);
}

/**
 * How much work the search for the best widths may do for a whole document,
 * in steps (see SearchBudget): about a quarter of a second on an M4 Mac mini,
 * longer on a slower or busier Mac, but the same widths on any Mac, however
 * busy. A table of a hundred rows of prose takes under half of it; a
 * document of tables of thousands of rows stops here, each table with the
 * widths found so far, or the simple ways if they do better.
 */
export const SEARCH_BUDGET = 25_000_000;

/**
 * Widths for the columns of a table that must fit in `width` points, as
 * shares of that width (adding up to 1); or null when every column fits
 * without wrapping, and Word can size the table to its words. The search
 * takes its work from `budget`, shared by a document's tables.
 */
export function columnWidths(
  table: TableText,
  width: number,
  type: TableType = WORD_TABLE,
  budget: SearchBudget = { left: SEARCH_BUDGET },
): number[] | null {
  const grid = new Grid(table, type, budget);
  const n = grid.columns;
  if (!n || !grid.cells.length) return null;
  const natural = Array.from({ length: n }, (_, c) => grid.natural(c));
  if (natural.reduce((a, b) => a + b, 0) <= width) return null;

  // Start each column at its longest word (or squeeze them all, if even that doesn't fit)...
  const floors = Array.from({ length: n }, (_, c) => grid.floor(c));
  const floorTotal = floors.reduce((a, b) => a + b, 0);
  const widths = floorTotal >= width ? floors.map((f) => (f * width) / floorTotal) : [...floors];
  let spare = width - widths.reduce((a, b) => a + b, 0);

  // ...then hand out the rest a step at a time, to the column where it saves
  // the most lines for the room it takes, until the work allowed is done
  // (looked at after each row, so it's never far over).
  const rows = grid.cells.length;
  const spent = () => budget.left <= 0;
  while (spare > 0.5 && !spent()) {
    let best: { c: number; to: number; rate: number } | null = null;
    for (let c = 0; c < n && !spent(); c++) {
      if (widths[c] >= natural[c]) continue;
      const others: number[] = [];
      for (let r = 0; r < rows && !spent(); r++) {
        let tallest = 1;
        for (let k = 0; k < n; k++) if (k !== c) tallest = Math.max(tallest, grid.lines(r, k, widths[k]));
        others.push(tallest);
      }
      const now = others.reduce((sum, h, r) => sum + Math.max(h, grid.lines(r, c, widths[c])), 0);
      // Where to try: the widths at which a cell in this column loses a line.
      const steps = new Set<number>([Math.min(natural[c], widths[c] + spare)]);
      for (let r = 0; r < rows && !spent(); r++) {
        const lines = grid.lines(r, c, widths[c]);
        if (lines <= others[r]) continue;
        const to = grid.roomFor(grid.cells[r][c], lines - 1) + 2 * type.padding;
        if (to > widths[c] && to - widths[c] <= spare) steps.add(to);
      }
      for (const to of [...steps].sort((a, b) => a - b).slice(0, 12)) {
        if (spent()) break;
        const after = others.reduce((sum, h, r) => sum + Math.max(h, grid.lines(r, c, to)), 0);
        const rate = (now - after) / (to - widths[c]);
        if (now > after && (!best || rate > best.rate)) best = { c, to, rate };
      }
    }
    // A step weighed only in part is no guide: stop with the widths so far.
    if (!best || spent()) break;
    spare -= best.to - widths[best.c];
    widths[best.c] = best.to;
  }

  // Room left over goes to the columns still short of their full width, or
  // else to all of them, so the table spans the page.
  if (spare > 0) {
    const short = widths.map((w, c) => Math.max(0, natural[c] - w));
    const shortTotal = short.reduce((a, b) => a + b, 0);
    const share = shortTotal > 0 ? short.map((s) => s / shortTotal) : widths.map((w) => w / (width - spare));
    share.forEach((s, c) => (widths[c] += s * spare));
  }

  // Never worse than the simple ways: equal columns, or columns in proportion to their words.
  const naturalTotal = natural.reduce((a, b) => a + b, 0);
  const choices = [widths, natural.map(() => width / n), natural.map((w) => (w * width) / naturalTotal)];
  const heights = choices.map((w) => grid.height(w, true));
  const best = choices[heights.indexOf(Math.min(...heights))];
  return best.map((w) => w / width);
}
