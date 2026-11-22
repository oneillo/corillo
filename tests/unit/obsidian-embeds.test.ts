// Pictures embedded the Obsidian way (![[chart.png]]) are found one by one
// after a note opens: each found redoes the marks of the blocks that embed it
// only, not of the whole note.
import { expect, it, vi } from "vitest";
import { EditorState, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { schema } from "../../src/core/schema";

const read = vi.hoisted(() => ({ blocks: 0 }));
vi.mock("../../src/core/obsidian", async (original) => {
  const real = await original<typeof import("../../src/core/obsidian")>();
  return {
    ...real,
    findObsidian: (text: string) => {
      read.blocks++;
      return real.findObsidian(text);
    },
  };
});
const { obsidianPlugin } = await import("../../src/renderer/obsidian");

it("a picture found redoes only the blocks that embed it", async () => {
  const lines = Array.from({ length: 2000 }, (_, i) => schema.node("paragraph", null, schema.text(`Line ${i} with ==a highlight== and #tag.`)));
  lines.splice(1000, 0, schema.node("paragraph", null, schema.text("![[chart.png]]")));
  let found!: (url: string) => void;
  const plugin = obsidianPlugin({ reading: false, findPicture: () => new Promise((resolve) => (found = resolve)) });
  let state = EditorState.create({ doc: schema.node("doc", null, lines), plugins: [plugin] });
  const view = {
    get state() {
      return state;
    },
    isDestroyed: false,
    dispatch(tr: Transaction) {
      state = state.apply(tr);
    },
  };
  const shown = plugin.spec.view!(view as unknown as EditorView);
  read.blocks = 0;
  found("file:///notes/chart.png");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(read.blocks).toBe(1);
  const pictures = plugin.getState(state)!.decorations.find(undefined, undefined, (spec) => String(spec.key ?? "").startsWith("pic "));
  expect(pictures.map((d) => d.spec.key)).toEqual(["pic file:///notes/chart.png x"]);
  shown.destroy?.();
});

// A picture not found yet: the likely places at each look, the whole vault at most once a minute (R-FE-5).

const { EmbeddedPictures, SEARCH_AGAIN_MS } = await import("../../src/renderer/obsidian");

/** A pretend app: counts each search of the vault and each question about the likely places. */
function lookup(there: Set<string> = new Set()) {
  const counts = { searches: 0, asked: 0 };
  let clock = 1_000_000;
  let failNext = false;
  const near = (name: string) => [`file:///notes/${name}`, `file:///notes/Plan%20images/${name}`];
  const pictures = new EmbeddedPictures({
    search: async (name) => {
      counts.searches++;
      if (failNext) {
        failNext = false;
        throw new Error("Can't read the folder.");
      }
      return there.has(`file:///vault/far/${name}`) ? `file:///vault/far/${name}` : null;
    },
    near,
    stamps: async (urls) => {
      counts.asked++;
      return urls.map((u) => (there.has(u) ? "1-1" : null));
    },
    now: () => clock,
  });
  return { pictures, counts, there, tick: (ms: number) => (clock += ms), failNext: () => (failNext = true) };
}

it("a missing picture is searched for across the vault at most once a minute, whatever the moments Corillo looks again", async () => {
  const { pictures, counts, tick } = lookup();
  expect(await pictures.find("chart.png")).toBeNull();
  expect(counts.searches).toBe(1);
  // Agent edits, pass ends and returns to the window, every few seconds for most of a minute.
  for (let i = 0; i < 25; i++) {
    tick(2000);
    expect(await pictures.find("chart.png")).toBeNull();
  }
  expect(counts.searches).toBe(1);
  expect(counts.asked).toBe(25); // the likely places only, one question each time
  tick(SEARCH_AGAIN_MS);
  expect(await pictures.find("chart.png")).toBeNull();
  expect(counts.searches).toBe(2);
});

it("several pages asking at once (the editor, the preview) share one question", async () => {
  const { pictures, counts, tick } = lookup();
  await pictures.find("chart.png");
  tick(1000);
  const answers = await Promise.all([pictures.find("chart.png"), pictures.find("chart.png"), pictures.find("chart.png")]);
  expect(answers).toEqual([null, null, null]);
  expect(counts.asked).toBe(1);
});

it("a picture that appears in a likely place is found at the next look, and one that appears far away within a minute", async () => {
  const { pictures, counts, there, tick } = lookup();
  expect(await pictures.find("chart.png")).toBeNull();
  expect(await pictures.find("logo.png")).toBeNull();
  there.add("file:///notes/Plan%20images/chart.png");
  there.add("file:///vault/far/logo.png");
  tick(1000);
  expect(await pictures.find("chart.png")).toBe("file:///notes/Plan%20images/chart.png");
  expect(await pictures.find("logo.png")).toBeNull();
  tick(SEARCH_AGAIN_MS);
  expect(await pictures.find("logo.png")).toBe("file:///vault/far/logo.png");
  // Found: kept, with no more questions.
  const before = { ...counts };
  for (let i = 0; i < 5; i++) {
    tick(SEARCH_AGAIN_MS);
    await pictures.find("chart.png");
    await pictures.find("logo.png");
  }
  expect(counts).toEqual(before);
});

it("a search that failed is tried again in full the next time", async () => {
  const { pictures, counts, tick, failNext } = lookup();
  failNext();
  expect(await pictures.find("chart.png")).toBeNull();
  tick(1000);
  await pictures.find("chart.png");
  expect(counts.searches).toBe(2);
});

it("after a move every picture is looked for afresh, and the names remembered stay bounded", async () => {
  const { pictures, counts } = lookup();
  await pictures.find("chart.png");
  pictures.clear();
  expect(pictures.size).toBe(0);
  await pictures.find("chart.png");
  expect(counts.searches).toBe(2);
  for (let i = 0; i < 1200; i++) await pictures.find(`typed ${i}.png`);
  expect(pictures.size).toBeLessThanOrEqual(500);
});
