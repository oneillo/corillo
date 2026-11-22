// What changed between two versions, as plain text an agent can read: only
// the blocks that changed, each with where it is, and inside a changed block
// [-what was taken out-] and {+what was put in+}.
import { parseMarkdown } from "./markdown";
import { diffSequence, diffWords, pairAlike, similarityCache } from "./diff";

/** Each block's text, an empty line as "". */
const allBlocks = (text: string) => parseMarkdown(text).source.blocks.map((b) => (b.text.trim() === "" ? "" : b.text));

function blocksOf(text: string): string[] {
  // (Empty lines are left out here, so they don't crowd the words that changed;
  // when they're all that changed, emptyLinesChanged says so.)
  const blocks = allBlocks(text).filter((t) => t !== "");
  return blocks.length || !text.trim() ? blocks : [text];
}

/** Two texts with the same words: how many empty lines went in or out, and where. */
function emptyLinesChanged(before: string, after: string): string {
  const places: { where: string; added: number; removed: number }[] = [];
  let lastWords: string | null = null;
  let place: (typeof places)[number] | null = null;
  for (const op of diffSequence(allBlocks(before), allBlocks(after))) {
    if (op.type === "same") {
      if (op.b !== "") lastWords = op.b;
      place = null;
      continue;
    }
    if (!place) {
      place = { where: lastWords === null ? "at the start" : `after "${firstLine(lastWords)}"`, added: 0, removed: 0 };
      places.push(place);
    }
    if (op.type === "added") place.added++;
    else place.removed++;
  }
  if (!places.length) return "The words and empty lines are the same; only line endings or spaces the page doesn't show changed.";
  const counts = (added: number, removed: number) =>
    [removed ? `${removed} removed` : "", added ? `${added} added` : ""].filter(Boolean).join(" and ");
  if (places.length <= 3) return `Only empty lines changed: ${places.map((p) => `${counts(p.added, p.removed)} ${p.where}`).join(", ")}.`;
  const total = (key: "added" | "removed") => places.reduce((n, p) => n + p[key], 0);
  return `Only empty lines changed: ${counts(total("added"), total("removed"))} in ${places.length} places, the first ${places[0].where}.`;
}

function firstLine(block: string): string {
  const line = block.split(/\r?\n/)[0].trim();
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

export function describeChanges(before: string, after: string): string {
  const ops = diffSequence(blocksOf(before), blocksOf(after));
  const similarity = similarityCache();
  const parts: string[] = [];
  let lastSame: string | null = null;
  for (let i = 0; i < ops.length; ) {
    const op = ops[i];
    if (op.type === "same") {
      lastSame = op.b;
      i++;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    for (; i < ops.length; i++) {
      const o = ops[i];
      if (o.type === "same") break;
      if (o.type === "removed") removed.push(o.a);
      else added.push(o.b);
    }
    const where = lastSame === null ? "at the start" : `after "${firstLine(lastSame)}"`;
    for (const pair of pairAlike(removed, added, (a, b) => {
      const like = similarity(a, b);
      return like >= 0.4 ? like : null;
    })) {
      if (pair.old !== undefined && pair.new !== undefined) {
        const marked = diffWords(pair.old, pair.new)
          .map((p) => (p.type === "same" ? p.text : p.type === "removed" ? `[-${p.text}-]` : `{+${p.text}+}`))
          .join("");
        parts.push(`Changed (${where}):\n${marked}`);
      } else if (pair.old !== undefined) {
        parts.push(`Removed (${where}):\n${pair.old}`);
      } else if (pair.new !== undefined) {
        parts.push(`Added (${where}):\n${pair.new}`);
      }
    }
  }
  if (parts.length) return parts.join("\n\n");
  return before === after ? "No changes." : emptyLinesChanged(before, after);
}
