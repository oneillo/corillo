// How wide the side panel and the Markdown view's two halves can be: the
// limits that keep comment cards readable and leave the page room, at any
// window size.
import { describe, expect, it } from "vitest";
import {
  PAGE_MIN,
  SIDE_DEFAULT,
  SIDE_MIN,
  SPLIT_DEFAULT,
  SPLIT_MIN,
  STEP,
  savedSide,
  savedSplit,
  sideLimits,
  sideWidth,
  splitLeft,
  splitLimits,
} from "../../src/core/columns";

describe("The side panel", () => {
  it("is 304 pixels unless the person changes it, at least 264, and moves 16 pixels a key press, all on the 4-pixel scale", () => {
    expect([SIDE_DEFAULT, SIDE_MIN, PAGE_MIN, STEP]).toEqual([304, 264, 480, 16]);
    for (const n of [SIDE_DEFAULT, SIDE_MIN, PAGE_MIN, SPLIT_MIN, STEP]) expect(n % 4).toBe(0);
  });

  it("takes at most half of a wide window", () => {
    expect(sideLimits(1600)).toEqual({ min: 264, max: 800 });
    expect(sideLimits(1101)).toEqual({ min: 264, max: 550 });
    expect(sideWidth(5000, 1600)).toBe(800);
  });

  it("leaves the page at least 480 pixels in a narrower window", () => {
    expect(sideLimits(900)).toEqual({ min: 264, max: 420 });
    expect(sideWidth(600, 900)).toBe(420);
    expect(900 - sideWidth(600, 900)).toBe(PAGE_MIN);
    // Where the two rules meet: half the window is exactly what leaves the page 480.
    expect(sideLimits(960).max).toBe(480);
  });

  it("never gets narrower than its minimum, even if the page then has less than 480", () => {
    expect(sideLimits(700)).toEqual({ min: 264, max: 264 });
    expect(sideWidth(304, 700)).toBe(264);
    expect(sideWidth(100, 1600)).toBe(264);
  });

  it("gives way first in the Markdown view, so the text and its preview keep 320 pixels each where they can", () => {
    const markdown = 2 * SPLIT_MIN;
    expect(sideWidth(304, 1280, markdown)).toBe(304);
    expect(sideWidth(304, 944, markdown)).toBe(304);
    expect(sideWidth(304, 920, markdown)).toBe(280);
    expect(920 - sideWidth(304, 920, markdown)).toBe(markdown);
    // Never narrower than its minimum: below that, the two halves share what's left.
    expect(sideWidth(304, 800, markdown)).toBe(SIDE_MIN);
    // The formatted view, in the same window, keeps the chosen width.
    expect(sideWidth(304, 920)).toBe(304);
  });

  it("keeps the chosen width when the window has room for it", () => {
    expect(sideWidth(304, 1100)).toBe(304);
    expect(sideWidth(412.6, 1440)).toBe(413);
  });

  it("shrinks with the window, then grows back to the chosen width", () => {
    const chosen = 500;
    expect([1400, 900, 800, 760, 744, 700, 900, 1400].map((w) => sideWidth(chosen, w))).toEqual([500, 420, 320, 280, 264, 264, 420, 500]);
  });

  it("uses a remembered width only if it's a real number, never below the minimum", () => {
    expect(savedSide(420)).toBe(420);
    expect(savedSide(100)).toBe(264);
    for (const bad of [undefined, null, "420", NaN, Infinity, -5, 0, {}]) expect(savedSide(bad)).toBe(304);
  });
});

describe("The Markdown view's two halves", () => {
  it("are equal unless the person changes them", () => {
    expect(SPLIT_DEFAULT).toBe(0.5);
    expect(splitLeft(SPLIT_DEFAULT, 1000)).toBe(500);
  });

  it("each keep at least 320 pixels", () => {
    expect(splitLimits(1000)).toEqual({ min: 320, max: 680 });
    expect(splitLeft(0.1, 1000)).toBe(320);
    expect(splitLeft(0.9, 1000)).toBe(680);
    expect(splitLeft(0.4, 1000)).toBe(400);
  });

  it("keep their proportions when the window changes size", () => {
    expect(splitLeft(0.4, 1500)).toBe(600);
    expect(splitLeft(0.4, 900)).toBe(360);
    expect(splitLeft(0.4, 800)).toBe(320); // 0.4 would leave the text 320; any narrower and the minimum holds
    expect(splitLeft(0.4, 700)).toBe(320);
  });

  it("share the room equally when there isn't enough for both minimums", () => {
    expect(splitLimits(600)).toEqual({ min: 300, max: 300 });
    expect(splitLeft(0.2, 600)).toBe(300);
    expect(splitLeft(0.8, 600)).toBe(300);
  });

  it("use a remembered share only if it's between none and all", () => {
    expect(savedSplit(0.35)).toBe(0.35);
    for (const bad of [undefined, null, "0.3", 0, 1, 1.5, -0.2, NaN]) expect(savedSplit(bad)).toBe(0.5);
  });
});
