import { describe, expect, it } from "vitest";
import { movedAddress } from "../../src/renderer/images";

const OLD = "file:///Users/o/Docs";
const moved = { from: "file:///Users/o/Docs/Plan%20images", to: "file:///Users/o/Docs/Q3%20plan%20images" };

describe("picture addresses after a document is renamed or moved", () => {
  it("follow the pictures folder when the document is renamed", () => {
    expect(movedAddress("Plan%20images/chart.png", OLD, OLD, moved)).toBe("Q3%20plan%20images/chart.png");
  });

  it("need no change when the document and its pictures folder move together", () => {
    const to = { from: moved.from, to: "file:///Users/o/Work/Plan%20images" };
    expect(movedAddress("Plan%20images/chart.png", OLD, "file:///Users/o/Work", to)).toBeNull();
  });

  it("still reach other pictures beside the old place", () => {
    expect(movedAddress("logo.png", OLD, "file:///Users/o/Work", null)).toBe("../Docs/logo.png");
    expect(movedAddress("../shared/logo.png", OLD, "file:///Users/o/Docs/Sub", null)).toBe("../../shared/logo.png");
  });

  it("leave web addresses and unchanged ones alone", () => {
    expect(movedAddress("https://example.com/a.png", OLD, "file:///x", null)).toBeNull();
    expect(movedAddress("logo.png", OLD, OLD, null)).toBeNull();
  });
});
