// In the Markdown view the text and the preview move together
// (scroll-together.ts). Which place in each half is lined up with the other,
// and how the difference the cursor makes fades as the person scrolls on.
import { describe, expect, it } from "vitest";
import { fade, share } from "../../src/renderer/scroll-together";

describe("the place lined up in each half", () => {
  const window = 600;
  it("is the middle of the window, in a long document", () => {
    expect(share(3000, 10_000, window)).toBe(0.5);
    expect(share(window, 10_000, window)).toBe(0.5);
    expect(share(10_000 - window, 10_000, window)).toBe(0.5);
  });
  it("slides to the top over the first window's worth of scrolling, so at the top both halves are at their top", () => {
    expect(share(0, 10_000, window)).toBe(0);
    expect(share(window / 2, 10_000, window)).toBe(0.25);
  });
  it("slides to the bottom over the last window's worth, so at the end both halves are at their end", () => {
    expect(share(10_000, 10_000, window)).toBe(1);
    expect(share(10_000 - window / 2, 10_000, window)).toBe(0.75);
  });
  it("in a document under two windows long, goes from the top to the bottom all the way", () => {
    expect(share(0, 900, window)).toBe(0);
    expect(share(450, 900, window)).toBe(0.5);
    expect(share(900, 900, window)).toBe(1);
  });
  it("is the top when the half doesn't scroll", () => {
    expect(share(0, 0, window)).toBe(0);
  });
  it("only ever moves down the window as the half scrolls down", () => {
    for (const end of [500, 1200, 1300, 10_000]) {
      let last = -1;
      for (let at = 0; at <= end; at += 7) {
        const now = share(at, end, window);
        expect(now).toBeGreaterThanOrEqual(last);
        last = now;
      }
    }
  });
});

describe("the difference the cursor makes", () => {
  it("fades over two windows' worth of scrolling", () => {
    expect(fade(100, 3000, 3000 + 300, 10_000, 600)).toBeCloseTo(100 * ((10_000 - 3300) / (10_000 - 3000)) * 0.75);
    expect(fade(100, 3000, 3000 + 1200, 10_000, 600)).toBe(0);
    expect(fade(100, 3000, 3000 - 1500, 10_000, 600)).toBe(0);
  });
  it("is gone at either end", () => {
    expect(fade(80, 400, 0, 10_000, 600)).toBe(0);
    expect(fade(80, 9800, 10_000, 10_000, 600)).toBe(0);
  });
  it("stays while the half doesn't move", () => {
    expect(fade(80, 400, 400, 10_000, 600)).toBe(80);
  });
});
