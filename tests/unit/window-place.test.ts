// The window opens where the person left it, as long as that place is still
// on one of the screens there now.
import { describe, expect, it } from "vitest";
import { placeOnScreens } from "../../src/main/window-place";

const laptop = { x: 0, y: 25, width: 1512, height: 920 };
const monitor = { x: 1512, y: -200, width: 2560, height: 1415 };

describe("where the window opens", () => {
  it("where it was, on a screen that's still there", () => {
    expect(placeOnScreens({ x: 1700, y: 0, width: 1200, height: 900 }, [laptop, monitor])).toEqual({
      x: 1700,
      y: 0,
      width: 1200,
      height: 900,
    });
  });

  it("in the usual place when the screen it was on is gone", () => {
    expect(placeOnScreens({ x: 1700, y: 0, width: 1200, height: 900 }, [laptop])).toBeNull();
  });

  it("moved back onto the screen when part of it is off the edge", () => {
    expect(placeOnScreens({ x: 1200, y: 600, width: 1000, height: 700 }, [laptop])).toEqual({
      x: 512,
      y: 245,
      width: 1000,
      height: 700,
    });
  });

  it("made smaller to fit a smaller screen than the one it was on", () => {
    expect(placeOnScreens({ x: 10, y: 30, width: 2400, height: 1300 }, [laptop])).toEqual({
      x: 0,
      y: 25,
      width: 1512,
      height: 920,
    });
  });

  it("goes on the screen it was mostly on", () => {
    expect(placeOnScreens({ x: 1400, y: 100, width: 1000, height: 800 }, [laptop, monitor])).toEqual({
      x: 1512,
      y: 100,
      width: 1000,
      height: 800,
    });
  });

  it("in the usual place when nothing sensible was kept", () => {
    for (const saved of [undefined, null, "big", { x: 1, y: 2 }, { x: 0, y: 25, width: -5, height: 400 }, { x: NaN, y: 0, width: 800, height: 600 }]) {
      expect(placeOnScreens(saved, [laptop])).toBeNull();
    }
    expect(placeOnScreens({ x: 0, y: 25, width: 800, height: 600 }, [])).toBeNull();
  });
});
