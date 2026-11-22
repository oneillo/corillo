// A long formal document, made up at test time, for checking that Corillo
// stays fast on the kind of document its author writes: about 30,000 words, 300
// headings, 60 tables (some of 20 rows), 150 footnotes, 30 pictures, 20
// diagrams, long lists, code blocks and links. The same text every time.
// Ask for more chapters (30 by default) for an even longer one.

export const BIG_PICTURES = 30;

/** Where the document's pictures are, relative to it (a "big images" folder). */
export const bigPicturePath = (i: number) => `big images/figure ${i + 1}.png`;

const WORDS = (
  "the of and to in a is that for it as was with be by on not he this are or his from at which but have an they " +
  "you were her all she there would their we him been has when who will more no if out so said what up its about " +
  "into than them can only other new some could time these two may then do first any my now such like our over " +
  "man me even most made after also did many before must through back years where much your way well down should " +
  "because each just those people how too little state good very make world still own see men work long get here " +
  "between both life being under never day same another know while last might us great old year off come since " +
  "against go came right used take three himself few house use during without again place american around however " +
  "home small found thought went say part once general high upon school every does got united left number course " +
  "war until always away something fact though water less public put think almost hand enough far took head yet " +
  "government system better set told nothing night end why called didn't eyes find going look asked later knew " +
  "budget review proposal volunteer schedule quarter outcome risk partner survey measure service response team"
).split(" ");

/** A small, predictable stream of numbers, so the document is the same every run. */
function numbers(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

export function bigDocument(chapters = 30): string {
  const rnd = numbers(20261108);
  const pick = <T>(list: T[]) => list[Math.floor(rnd() * list.length)];
  const words = (count: number) => Array.from({ length: count }, () => pick(WORDS)).join(" ");
  const sentence = (count: number) => {
    const w = words(count);
    return w[0].toUpperCase() + w.slice(1) + ".";
  };

  let footnote = 0;
  const notes: string[] = [];
  const noteRef = () => {
    footnote++;
    // Labels as people write them: some numbers, some names.
    const label = footnote % 3 === 0 ? `source-${footnote}` : String(footnote);
    notes.push(`[^${label}]: ${sentence(8 + Math.floor(rnd() * 8))} See page ${footnote * 3}.`);
    return `[^${label}]`;
  };

  /** A paragraph with some bold, italics, a link, code and sometimes a footnote. */
  const paragraph = (withNote: boolean) => {
    const parts = [sentence(9), sentence(9), sentence(11)];
    parts[0] = parts[0].replace(/ (\w+) /, " **$1** ");
    parts[1] = parts[1].replace(/ (\w+) /, " *$1* ");
    if (rnd() < 0.5) parts[2] = parts[2].replace(/ (\w+) (\w+) /, " [$1 $2](https://example.org/report/$1) ");
    if (rnd() < 0.2) parts[2] = parts[2].replace(/ (\w+)\.$/, " `$1`.");
    if (withNote) parts[1] = parts[1].replace(/\.$/, "." + noteRef());
    return parts.join(" ");
  };

  const table = (rows: number, cols: number) => {
    const head = Array.from({ length: cols }, (_, c) => (c === 0 ? "Item" : `${pick(WORDS)} ${c}`));
    const rule = Array.from({ length: cols }, (_, c) => (c === cols - 1 ? "--:" : "---"));
    const body = Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) => (c === cols - 1 ? String((r + 1) * 125) : words(1 + Math.floor(rnd() * 3)))),
    );
    return [head, rule, ...body].map((cells) => `| ${cells.join(" | ")} |`).join("\n");
  };

  const diagram = (i: number) =>
    [
      "```mermaid",
      "graph LR",
      `  A${i}[Ask] --> B${i}[Draft ${i + 1}]`,
      `  B${i} --> C${i}{Review}`,
      `  C${i} -->|changes| B${i}`,
      `  C${i} -->|done| D${i}[Send]`,
      "```",
    ].join("\n");

  const out: string[] = ["# Annual report on the volunteer programme", paragraph(false)];
  let tables = 0;
  for (let ch = 0; ch < chapters; ch++) {
    out.push(`## ${ch + 1}. ${sentence(4).slice(0, -1)}`, paragraph(true), paragraph(false));
    for (let sub = 0; sub < 9; sub++) {
      out.push(`### ${ch + 1}.${sub + 1} ${sentence(3).slice(0, -1)}`);
      out.push(paragraph(sub % 2 === 0 && sub < 8), paragraph(false));
      if (sub % 3 === 0) out.push(paragraph(false));
      if (sub === 1) {
        out.push(table(tables % 3 === 0 ? 20 : 5, 4));
        tables++;
      }
      if (sub === 2) {
        const items = Array.from({ length: 10 }, (_, i) => `- ${sentence(6)}${i === 4 ? "\n  - " + sentence(6) + "\n  - " + sentence(5) : ""}`);
        out.push(items.join("\n"));
      }
      if (sub === 4) out.push(`![Figure ${ch + 1}](<${bigPicturePath(ch % BIG_PICTURES)}>)`);
      if (sub === 5) {
        out.push(table(tables % 3 === 0 ? 20 : 6, 3));
        tables++;
      }
      if (sub === 6) out.push(Array.from({ length: 8 }, (_, i) => `${i + 1}. ${sentence(7)}`).join("\n"));
      if (sub === 7 && ch % 3 !== 2) out.push(diagram(ch));
      if (sub === 8) out.push(["```js", `const total${ch} = items.reduce((sum, x) => sum + x.cost, 0);`, `console.log(total${ch});`, "```"].join("\n"));
    }
  }
  out.push(...notes);
  return out.join("\n\n") + "\n";
}
