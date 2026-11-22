// The Markdown view's text area only knows "\n" line endings. What goes in
// and comes back out must keep the document's own bytes where it wasn't edited.
import { describe, expect, it } from "vitest";
import { forTextArea, fromTextArea } from "../../src/core/text-area";
import type { Eol } from "../../src/core/markdown";

/** Open in the Markdown view, change it as the person would, take the text back. */
function edit(text: string, eol: Eol, change: (shown: string) => string): string {
  return fromTextArea(text, change(forTextArea(text)), eol);
}

describe("the Markdown view's text area", () => {
  it("gives back the exact bytes when nothing was changed", () => {
    for (const text of ["a\r\nb\r\n", "﻿title\n", "a\rb\r", "mixed\r\nends\nhere\r", "", "﻿"]) {
      expect(fromTextArea(text, forTextArea(text), "\n")).toBe(text);
    }
  });

  it("hides the byte-order mark so it can't be deleted by accident, and keeps it on save", () => {
    expect(forTextArea("﻿Hello\r\n")).toBe("Hello\n");
    expect(edit("﻿Hello\r\n", "\r\n", (s) => s.replace("Hello", "Hello there"))).toBe("﻿Hello there\r\n");
    expect(edit("﻿Hello\n", "\n", () => "")).toBe("﻿");
  });

  it("keeps Windows line endings, also on lines typed in the Markdown view", () => {
    const text = "# Plan\r\n\r\nFirst.\r\n";
    expect(edit(text, "\r\n", (s) => s + "Second.\nThird.\n")).toBe("# Plan\r\n\r\nFirst.\r\nSecond.\r\nThird.\r\n");
    expect(edit(text, "\r\n", (s) => s.replace("First.", "First, edited."))).toBe("# Plan\r\n\r\nFirst, edited.\r\n");
  });

  it("leaves mixed line endings outside the edit as they were", () => {
    const text = "one\r\ntwo\nthree\rfour\n";
    expect(edit(text, "\n", (s) => s.replace("three", "THREE"))).toBe("one\r\ntwo\nTHREE\rfour\n");
    expect(edit(text, "\n", (s) => s.replace("one", "ONE"))).toBe("ONE\r\ntwo\nthree\rfour\n");
  });

  it("an added blank line next to an old Mac line ending stays a blank line", () => {
    expect(forTextArea(edit("a\rb", "\r", (s) => s.replace("\n", "\n\n")))).toBe("a\n\nb");
    expect(forTextArea(edit("a\rX\nb", "\n", (s) => s.replace("X", "")))).toBe("a\n\nb");
  });

  it("over many random edits, what's saved reads exactly as what the person sees", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
    for (let round = 0; round < 3000; round++) {
      const eol = pick<Eol>(["\n", "\r\n", "\r"]);
      const pieces = ["a", "b", " ", "#", "\n", "\r\n", "\r", "é", "😀"];
      let text = random() < 0.2 ? "﻿" : "";
      const length = Math.floor(random() * 20);
      for (let k = 0; k < length; k++) text += pick(pieces);
      const shown = forTextArea(text);
      const from = Math.floor(random() * (shown.length + 1));
      const to = from + Math.floor(random() * (shown.length - from + 1));
      let typed = "";
      const typedLength = Math.floor(random() * 4);
      for (let k = 0; k < typedLength; k++) typed += pick(["x", "\n", " "]);
      const value = shown.slice(0, from) + typed + shown.slice(to);
      const saved = fromTextArea(text, value, eol);
      expect(forTextArea(saved), JSON.stringify({ text, value, eol })).toBe(value);
      expect(saved.startsWith("﻿")).toBe(text.startsWith("﻿"));
      if (value === shown) expect(saved).toBe(text);
    }
  });
});
