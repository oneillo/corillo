// About's line for the stamp packaging puts in the app (scripts/package-mac.mjs).
// The packaged app is checked in tests/package; this is the wording.
import { describe, expect, it, vi } from "vitest";
import { buildLine } from "../../src/main/about";

// about.ts sets up About's window and messages when loaded; here only its words are wanted.
vi.mock("electron", () => ({ app: {}, BrowserWindow: class {}, ipcMain: { handle: () => {}, on: () => {}, emit: () => false }, session: {}, shell: {} }));

const plist = (commit: string, date = "2026-11-09T21:05") =>
  `<dict><key>CorilloBuildCommit</key><string>${commit}</string><key>CorilloBuildDate</key><string>${date}</string></dict>`;

describe("the build line in About", () => {
  it("names the commit and when the build was made", () => {
    expect(buildLine(plist("1a2b3c4"))).toBe("Build 1a2b3c4, made 9 November 2026 at 21:05");
  });

  it("says when the build has changes not yet committed, so it isn't taken for that commit's code (R-EX-12)", () => {
    expect(buildLine(plist("1a2b3c4+changes"))).toBe("Build 1a2b3c4 with changes, made 9 November 2026 at 21:05");
  });

  it("says nothing when the app wasn't stamped", () => {
    expect(buildLine("<dict></dict>")).toBeNull();
  });
});
