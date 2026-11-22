// The start screen's document cards: how a folder and a date read on a card,
// how much of a document goes into its preview, and reading the files (only
// the top of each, missing and unreadable ones told apart).
import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewSource, readRecentCards, shortFolder, PREVIEW_CHARS } from "../../src/main/recent-cards";
import { whenLabel } from "../../src/renderer/start-screen";

const HOME = "/Users/ana";

describe("A card's folder", () => {
  // As Finder shows it (roadmap Batch 5, item 2, person quick win 7): "Documents › Work", never "~/Documents/Work".
  it("starts from the home folder, as Finder names it", () => {
    expect(shortFolder("/Users/ana/Documents/Plans", HOME)).toBe("Documents › Plans");
    expect(shortFolder("/Users/ana/Desktop", HOME)).toBe("Desktop");
    expect(shortFolder("/Users/ana", HOME)).toBe("ana");
    expect(shortFolder("/Users/ana/Documents", HOME + "/")).toBe("Documents");
  });

  it("keeps only the last two folders when there are more than three", () => {
    expect(shortFolder("/Users/ana/Documents/Work/Plans", HOME)).toBe("Documents › Work › Plans");
    expect(shortFolder("/Users/ana/Documents/Work/2026/Plans", HOME)).toBe("… › 2026 › Plans");
    expect(shortFolder("/private/var/folders/ab/T/corillo-doc-1", HOME)).toBe("… › T › corillo-doc-1");
  });

  it("names iCloud Drive, cloud drives and other disks as Finder's sidebar does", () => {
    expect(shortFolder("/Users/ana/Library/Mobile Documents/com~apple~CloudDocs/Work", HOME)).toBe("iCloud Drive › Work");
    expect(shortFolder("/Users/ana/Library/Mobile Documents/com~apple~CloudDocs", HOME)).toBe("iCloud Drive");
    expect(shortFolder("/Users/ana/Library/CloudStorage/OneDrive-Personal/Plans", HOME)).toBe("OneDrive-Personal › Plans");
    expect(shortFolder("/Volumes/Backup/Plans", HOME)).toBe("Backup › Plans");
  });

  it("isn't fooled by a folder whose name starts like the home folder's", () => {
    expect(shortFolder("/Users/ana2/Documents", HOME)).toBe("Users › ana2 › Documents");
    expect(shortFolder("/tmp", HOME)).toBe("tmp");
  });
});

describe("A card's date", () => {
  const now = new Date(2026, 10, 9, 15, 30).getTime(); // 9 November 2026, mid-afternoon

  it("is Today or Yesterday for the last two days", () => {
    expect(whenLabel(new Date(2026, 10, 9, 0, 5).getTime(), now, "en-GB")).toBe("Today");
    expect(whenLabel(new Date(2026, 10, 8, 23, 59).getTime(), now, "en-GB")).toBe("Yesterday");
    expect(whenLabel(new Date(2026, 10, 8, 0, 1).getTime(), now, "en-GB")).toBe("Yesterday");
  });

  it("is the day and month before that, with the year when it isn't this year", () => {
    expect(whenLabel(new Date(2026, 10, 7, 23, 0).getTime(), now, "en-GB")).toBe("7 Nov");
    expect(whenLabel(new Date(2026, 0, 3).getTime(), now, "en-GB")).toBe("3 Jan");
    expect(whenLabel(new Date(2025, 10, 3).getTime(), now, "en-GB")).toBe("3 Nov 2025");
    expect(whenLabel(new Date(2026, 10, 3).getTime(), now, "en-US")).toBe("Nov 3");
  });

  it("is empty when the time isn't known", () => {
    expect(whenLabel(0, now)).toBe("");
  });
});

describe("A preview's text", () => {
  it("is the whole of a short document, without its front matter", () => {
    expect(previewSource("# Plan\n\nHire two people.\n", true)).toBe("# Plan\n\nHire two people.\n");
    expect(previewSource("---\ntitle: Plan\n---\n\n# Plan\n", true)).toBe("# Plan\n");
    expect(previewSource("﻿---\r\ntitle: Plan\r\n...\r\n# Plan\r\n", true)).toBe("# Plan\r\n");
  });

  it("keeps a rule at the top of a short document that has no front matter", () => {
    expect(previewSource("---\n\n# Plan\n", true)).toBe("---\n\n# Plan\n");
  });

  it("stops at the end of a line, or between words in a very long paragraph, so no word is cut in half", () => {
    const long = "word ".repeat(10) + "\n" + "more ".repeat(10) + "\n";
    expect(previewSource(long, true, 60)).toBe("word ".repeat(10) + "\n");
    const oneLine = "# Big\n\n" + "A sentence. ".repeat(1000);
    const cut = previewSource(oneLine, true, 100);
    expect(cut.startsWith("# Big\n\nA sentence. A sentence.")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(100);
    expect(oneLine.startsWith(cut + " ")).toBe(true);
    // A read that stopped part way through a word leaves that word out.
    expect(previewSource("# Plan\n\nHire two peo", false)).toBe("# Plan\n\nHire two");
  });

  it("drops a character the read cut in half", () => {
    expect(previewSource("Café\n\nNiño�", false)).toBe("Café\n\n");
    expect(previewSource("Café�", false)).toBe("Café");
  });

  it("is empty when the front matter is longer than what was read", () => {
    expect(previewSource("---\ntitle: Plan\ntags: [a, b]\n", false)).toBe("");
  });
});

describe("Reading the cards", () => {
  it("reads only the top of each file, and says which are missing or can't be read", async () => {
    const home = mkdtempSync(join(tmpdir(), "corillo-cards-"));
    const folder = join(home, "Documents", "Plans");
    mkdirSync(folder, { recursive: true });
    const big = join(folder, "big.md");
    writeFileSync(big, "# Big\n\n" + "A sentence of the document. ".repeat(40_000) + "\nThe end.\n");
    const locked = join(folder, "locked.md");
    writeFileSync(locked, "# Locked\n");
    chmodSync(locked, 0o000);
    const gone = join(folder, "gone.md");
    const cards = await readRecentCards([big, gone, locked, folder], home);
    chmodSync(locked, 0o644);

    expect(cards.map((c) => [c.name, c.state])).toEqual([
      ["big.md", "ok"],
      ["gone.md", "missing"],
      ["locked.md", "unreadable"],
      ["Plans", "unreadable"],
    ]);
    const [first] = cards;
    expect(first.folder).toBe("Documents › Plans");
    expect(first.folderName).toBe("Plans");
    expect(first.dirUrl).toMatch(/^file:\/\/.*\/Documents\/Plans\/$/);
    expect(first.changed).toBeGreaterThan(Date.now() - 60_000);
    expect(first.head!.startsWith("# Big\n\nA sentence")).toBe(true);
    expect(first.head!.length).toBeLessThanOrEqual(PREVIEW_CHARS);
    expect(first.head).not.toContain("The end.");
    expect(cards[1].head).toBeNull();
  });
});
