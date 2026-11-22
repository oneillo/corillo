// Where the window opens: where the person left it (kept in view.json), as
// long as that place is still on one of the screens there now. A window that
// was on a screen since unplugged opens in the usual place instead.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function asRect(saved: unknown): Rect | null {
  if (!saved || typeof saved !== "object") return null;
  const { x, y, width, height } = saved as Record<string, unknown>;
  const all = [x, y, width, height];
  if (!all.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if ((width as number) <= 0 || (height as number) <= 0) return null;
  return { x: Math.round(x as number), y: Math.round(y as number), width: Math.round(width as number), height: Math.round(height as number) };
}

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * The place to open the window, from the one kept and the screens' usable
 * areas: on the screen it was mostly on, moved and made smaller as needed to
 * fit it. Null for the usual place.
 */
export function placeOnScreens(saved: unknown, screens: Rect[]): Rect | null {
  const place = asRect(saved);
  if (!place) return null;
  let best: Rect | null = null;
  let most = 0;
  for (const screen of screens) {
    const shared = overlap(place, screen);
    if (shared > most) {
      most = shared;
      best = screen;
    }
  }
  if (!best) return null;
  const width = Math.min(place.width, best.width);
  const height = Math.min(place.height, best.height);
  return {
    x: Math.min(Math.max(place.x, best.x), best.x + best.width - width),
    y: Math.min(Math.max(place.y, best.y), best.y + best.height - height),
    width,
    height,
  };
}
