// Front matter: the YAML block at the very top of a file, between two "---"
// lines, that Obsidian shows as a note's properties and Corillo as "Document
// details". The same rule is used by the editor, exports and the start screen.
//
// Obsidian's help says only that properties are YAML "at the top of the file"
// and start with "---" at its very beginning. A file can also open with a
// horizontal rule, though, and have another rule further down; everything
// between them isn't front matter. So a block counts only when:
//   - the first line is "---" (spaces after it are fine);
//   - a later line closes it: "---" or "...";
//   - it's empty, or JSON (its first line starts with "{"), or every line in
//     it looks like YAML: a "name:", a "- " list item, a "#" comment, an
//     indented line (more of the line above) or a blank line, with at least
//     one "name:" (a list alone isn't properties) and not starting blank.
// Otherwise the first line is a rule, as any Markdown app shows it: a line
// of ordinary words or a heading with no "name:" means it isn't YAML.

const OPEN = /^---[ \t]*$/;
const CLOSE = /^(---|\.\.\.)[ \t]*$/;
// "title: Q3", "tags:", "'quoted key': x".
const KEY = /^["']?[^\s:#'"-][^:]*["']?:(?:\s|$)/;
// "- item", "-", "# comment", an indented line, a blank line.
const OTHER_YAML = /^(?:-(?:\s|$)|\s*#|[ \t]+\S|\s*$)/;

/** What frontMatterEnd says when the lines given end before it can tell (see `whole`). */
export const NOT_YET = -2;

/**
 * The index of the line that closes the front matter at the top, or -1 if
 * there is none. With `whole` false, the lines are only the file's first:
 * NOT_YET if they end before that can be told.
 */
export function frontMatterEnd(lines: readonly string[], whole = true): number {
  if (!OPEN.test(lines[0] ?? "")) return -1;
  const first = lines[1];
  if (first === undefined && !whole) return NOT_YET;
  if (first === undefined || !first.trim()) return -1;
  if (CLOSE.test(first)) return 1; // an empty block
  const json = /^\s*\{/.test(first);
  let key = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (CLOSE.test(line)) return json || key ? i : -1;
    if (json) continue;
    if (KEY.test(line)) key = true;
    else if (!OTHER_YAML.test(line)) return -1;
  }
  return whole ? -1 : NOT_YET;
}
