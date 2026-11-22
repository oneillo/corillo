// A text area only knows one kind of line ending ("\n") and would let the
// person delete an invisible byte-order mark by accident. These two functions
// put a document into the Markdown view's text area and take it back out, so
// the parts the person didn't touch keep their exact bytes.
import type { Eol } from "./markdown";

const BOM = "\uFEFF";

/** What the text area shows for a document's text. */
export function forTextArea(text: string): string {
  return (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n?/g, "\n");
}

/**
 * The document's text after the person edited the text area. `shown` is the
 * text that was put in; unchanged lines at its start and end keep their
 * original line endings, and new lines get the document's usual one.
 */
export function fromTextArea(shown: string, value: string, eol: Eol): string {
  const bom = shown.startsWith(BOM) ? BOM : "";
  const original = bom ? shown.slice(1) : shown;
  // How much of the start is unchanged (i in the original, j in the text area).
  let i = 0;
  let j = 0;
  while (i < original.length && j < value.length) {
    const c = original[i];
    if (c === "\r") {
      if (value[j] !== "\n") break;
      i += original[i + 1] === "\n" ? 2 : 1;
      j += 1;
    } else if (c === value[j]) {
      i++;
      j++;
    } else break;
  }
  if (i === original.length && j === value.length) return shown;
  // A lone "\r" just before the new text could join a "\n" after it into
  // one line ending. Leave it to the new text.
  if (i > 0 && original[i - 1] === "\r") {
    i--;
    j--;
  }
  // How much of the end is unchanged, not overlapping the start.
  let a = original.length;
  let b = value.length;
  while (a > i && b > j) {
    const c = original[a - 1];
    if (c === "\n" && a - 2 >= i && original[a - 2] === "\r") {
      if (value[b - 1] !== "\n") break;
      a -= 2;
      b -= 1;
    } else if (c === "\r") {
      if (value[b - 1] !== "\n") break;
      a--;
      b--;
    } else if (c === value[b - 1]) {
      a--;
      b--;
    } else break;
  }
  const withEol = (s: string) => (eol === "\n" ? s : s.replace(/\n/g, eol));
  const text = original.slice(0, i) + withEol(value.slice(j, b)) + original.slice(a);
  // Never at the cost of what the person sees: if old and new line endings
  // met in a way that reads differently, use the usual ending throughout.
  if (text.replace(/\r\n?/g, "\n") !== value) return bom + withEol(value);
  return bom + text;
}
