// Corillo tells an Undo or Redo from any other change by asking
// prosemirror-history (isHistoryTransaction), never by the name its plugin
// key happens to get ("history$" is the name prosemirror-state gives the
// first key made with the name "history"; a key of that name made earlier
// would take it). The review of Batch 21, S21-31.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { Schema } from "prosemirror-model";
import { EditorState, PluginKey, type Transaction } from "prosemirror-state";

const ROOT = join(import.meta.dirname, "..", "..");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));

const schema = new Schema({
  nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*", toDOM: () => ["p", 0] }, text: {} },
});

describe("telling an Undo from any other change", () => {
  it("is asked of prosemirror-history, which still says yes when another plugin key is named history", async () => {
    // Another key of the same name, made first (prosemirror-history isn't loaded yet in this file).
    const other = new PluginKey("history");
    expect((other as unknown as { key: string }).key).toBe("history$");
    const { history, undo, isHistoryTransaction } = await import("prosemirror-history");
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("three people")])]);
    let state = EditorState.create({ doc, plugins: [history()] });
    state = state.apply(state.tr.insertText("x", 1));
    let undone: Transaction | null = null;
    undo(state, (tr) => (undone = tr));
    expect(isHistoryTransaction(undone as unknown as Transaction)).toBe(true);
    expect(isHistoryTransaction(state.tr.insertText("y", 1))).toBe(false);
  });

  it("never by the history plugin key's generated name", () => {
    const asked = files(join(ROOT, "src")).filter((f) => readFileSync(f, "utf8").includes('getMeta("history$")'));
    expect(asked.map((f) => relative(ROOT, f))).toEqual([]);
  });
});
