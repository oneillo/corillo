// A picture's alt text: as read from between its brackets, and as written back so it reads the same.
import { md } from "./markdown-tokens";

/**
 * A picture's alt text, written as it was between the brackets when that
 * reads back the same; otherwise with its lone brackets escaped ("Q3 [draft",
 * as unescapedAlt took it from the file); otherwise, for text that never came
 * from a file (a pasted picture's), with every bracket and backslash escaped,
 * which keeps what it says.
 */
function altText(alt: string): string {
  const flat = alt.replace(/\r?\n/g, " ");
  if (readsBackAs(flat, flat)) return flat;
  const lone = escapeLoneBrackets(flat);
  if (lone !== flat && readsBackAs(lone, flat)) return lone;
  return flat.replace(/[\\[\]]/g, "\\$&");
}

function readsBackAs(written: string, alt: string): boolean {
  const toks = md.parseInline(`![${written}](x)`, {})[0]?.children ?? [];
  return toks.length === 1 && toks[0].type === "image" && unescapedAlt(toks[0].content) === alt;
}

type AltPiece = { text: string; bracket?: "[" | "]"; escaped?: boolean };

/**
 * Alt text as written, in pieces: each bracket on its own, marked when a
 * backslash escapes it; everything else (other escapes, code spans, where a
 * backslash is only a backslash) kept as written.
 */
function altPieces(written: string): AltPiece[] {
  const out: AltPiece[] = [];
  for (let i = 0; i < written.length; ) {
    const c = written[i];
    if (c === "\\" && i + 1 < written.length && /[!-/:-@[-`{-~]/.test(written[i + 1])) {
      const n = written[i + 1];
      out.push(n === "[" || n === "]" ? { text: n, bracket: n, escaped: true } : { text: c + n });
      i += 2;
    } else if (c === "`") {
      let run = 1;
      while (written[i + run] === "`") run++;
      let close = -1;
      for (let j = i + run; j < written.length; ) {
        if (written[j] !== "`") {
          j++;
          continue;
        }
        let k = 1;
        while (written[j + k] === "`") k++;
        if (k === run) {
          close = j;
          break;
        }
        j += k;
      }
      const to = close < 0 ? i + run : close + run;
      out.push({ text: written.slice(i, to) });
      i = to;
    } else {
      out.push(c === "[" || c === "]" ? { text: c, bracket: c } : { text: c });
      i++;
    }
  }
  return out;
}

/** Which bracket pieces pair up, a "]" with the nearest "[" still open, as links and pictures pair them. */
function pairedBrackets(pieces: AltPiece[], counts: (p: AltPiece) => boolean): Set<AltPiece> {
  const open: AltPiece[] = [];
  const paired = new Set<AltPiece>();
  for (const p of pieces) {
    if (!p.bracket || !counts(p)) continue;
    if (p.bracket === "[") open.push(p);
    else if (open.length) {
      paired.add(open.pop()!);
      paired.add(p);
    }
  }
  return paired;
}

/**
 * Alt text as written between the brackets, with the backslash taken out of
 * each escaped bracket that, unescaped, would still be a lone bracket ("Q3
 * \[draft" is "Q3 [draft"). Otherwise as written: a doubled backslash, an
 * escaped pair that could then read as a link ("\[x\]"), and anything that
 * could hold a backslash of its own (a code span, HTML, math, a comment) keep
 * their meaning only as written, so two different files never give the same
 * text (review B15-01).
 */
function unescapedAlt(written: string): string {
  if (!/\\[[\]]/.test(written) || /[<$%]/.test(written)) return written;
  const pieces = altPieces(written);
  const paired = pairedBrackets(pieces, () => true);
  if (pieces.some((p) => p.escaped && paired.has(p))) return written;
  return pieces.map((p) => p.text).join("");
}

/** Alt text with each bracket that pairs with none escaped, so it can't end the description early. */
function escapeLoneBrackets(alt: string): string {
  const pieces = altPieces(alt);
  const paired = pairedBrackets(pieces, (p) => !p.escaped);
  return pieces.map((p) => (p.bracket && !p.escaped && !paired.has(p) ? "\\" + p.text : p.escaped ? "\\" + p.text : p.text)).join("");
}

export { altText, unescapedAlt };
