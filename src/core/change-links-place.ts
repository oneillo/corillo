// A comment's changed span found again after the text changes.
import { anchorIn, locate, type Anchor } from "./anchors";
import { OffsetMap } from "./change-links-follow";

export interface ChangeSpan {
  /** Where the words put in are now. An empty quote means words were only taken out, there. */
  anchor: Anchor;
  /** What the text said there before the round ("" when words were only added). */
  removed: string;
}

// Finding a span again ----------------------------------------------------------------

/**
 * A span after the text changed from `before` to `after` (`map` maps between
 * them). Null when its words were all taken out since; unchanged when it
 * can't be found.
 */
export function remapSpan(span: ChangeSpan, before: string, after: string, map: OffsetMap): ChangeSpan | null {
  const at = locate(before, span.anchor);
  if (!at) return span;
  const point = !span.anchor.quote;
  const start = map.map(at.start, point ? -1 : 1);
  const end = point ? start : map.map(at.end, -1);
  if (!point && end <= start) return null;
  return { anchor: anchorIn(after, start, end), removed: span.removed };
}

export function remapSpans(spans: ChangeSpan[], before: string, after: string, map = new OffsetMap(before, after)): ChangeSpan[] {
  const out: ChangeSpan[] = [];
  for (const s of spans) {
    const moved = remapSpan(s, before, after, map);
    if (moved) out.push(moved);
  }
  return out;
}
