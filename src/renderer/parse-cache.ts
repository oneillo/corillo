// Reading a long document's Markdown takes a noticeable moment, and the same
// text is often read again soon after: switching to the Markdown view and
// back, Show changes on the latest version, restoring the version just looked
// at. The same text always reads the same way and the result is never
// changed, so the last few results are kept and handed out again.
import { parseMarkdown, type Loaded } from "../core/markdown";

const KEEP = 4;
const recent = new Map<string, Loaded>();

/** parseMarkdown, reusing the result for a text read recently. */
export function parseCached(text: string): Loaded {
  let loaded = recent.get(text);
  if (loaded) recent.delete(text);
  else loaded = parseMarkdown(text);
  recent.set(text, loaded);
  if (recent.size > KEEP) recent.delete(recent.keys().next().value as string);
  return loaded;
}

/** Let go of the kept results (a document closed, so its texts aren't needed). */
export function forgetParsed(): void {
  recent.clear();
}
