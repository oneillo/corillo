// How wide the side panel (comments or history, which take the same place)
// and the two halves of the Markdown view can be. The person drags the line
// between them; these rules keep both sides usable at any window size.

/**
 * The narrowest side panel that keeps a comment card readable: Reply, Edit and
 * Delete fit on one line, and a comment still gets four or five words a line.
 * The cards were laid out for this width on narrow windows before the panel
 * could be resized.
 */
export const SIDE_MIN = 264;
/** The side panel's usual width. */
export const SIDE_DEFAULT = 304;
/** The page keeps at least this much beside the side panel: lines of about 50 characters. */
export const PAGE_MIN = 480;
/** Each half of the Markdown view keeps at least this much: about 30 characters of Markdown text. */
export const SPLIT_MIN = 320;
/** The Markdown text's usual share of the Markdown view: half. */
export const SPLIT_DEFAULT = 0.5;
/** One press of the Left or Right arrow moves the line this far. */
export const STEP = 16;

export interface Limits {
  min: number;
  max: number;
}

export function clampTo(value: number, { min, max }: Limits): number {
  return Math.round(Math.min(max, Math.max(min, value)));
}

/**
 * The side panel's limits in a window this wide: at most half the window, and
 * never so wide that the page gets less than PAGE_MIN. It never gets narrower
 * than SIDE_MIN, though: in a window too narrow for both, the page gives way
 * (the panel can be hidden from the status bar).
 */
export function sideLimits(windowWidth: number, pageMin = PAGE_MIN): Limits {
  const max = Math.min(Math.floor(windowWidth / 2), windowWidth - pageMin);
  return { min: SIDE_MIN, max: Math.max(SIDE_MIN, max) };
}

/**
 * How wide the side panel is in a window this wide, when the person chose
 * `chosen`. The choice is kept as it is, so a window made narrower and then
 * wide again gets its panel back at the chosen width. In the Markdown view
 * the text and its preview each keep SPLIT_MIN (`pageMin` = 2 × SPLIT_MIN),
 * so the panel gives way first there.
 */
export function sideWidth(chosen: number, windowWidth: number, pageMin = PAGE_MIN): number {
  return clampTo(chosen, sideLimits(windowWidth, pageMin));
}

/**
 * The limits of the Markdown text's width in a Markdown view this wide. When
 * there isn't room for both halves' minimum, they share it equally.
 */
export function splitLimits(total: number): Limits {
  if (total < 2 * SPLIT_MIN) {
    const half = Math.round(total / 2);
    return { min: half, max: half };
  }
  return { min: SPLIT_MIN, max: total - SPLIT_MIN };
}

/**
 * How wide the Markdown text is, given its share of a Markdown view this wide.
 * A share, not a width, is what's remembered, so the halves keep their
 * proportions when the window changes size.
 */
export function splitLeft(share: number, total: number): number {
  return clampTo(share * total, splitLimits(total));
}

/** A remembered side panel width, or the usual one if there's none or it can't be used. */
export function savedSide(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.max(SIDE_MIN, Math.round(value)) : SIDE_DEFAULT;
}

/** A remembered share of the Markdown view, or half if there's none or it can't be used. */
export function savedSplit(value: unknown): number {
  return typeof value === "number" && value > 0 && value < 1 ? value : SPLIT_DEFAULT;
}
