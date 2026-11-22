// The safety net (roadmap Batch 14, item 1): a save never writes a file that
// has lost words the page holds. Faults are planted to stand in for a bug in
// how Corillo writes Markdown: where the block can be written the careful way
// and read back exactly, it is; otherwise the save is refused, and the words
// are kept for recovery. An agent's find and replace must leave the text
// outside what it found as it was.
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorState } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { parseMarkdown, serializeMarkdown, type Source } from "../../src/core/markdown";
import { schema } from "../../src/core/schema";
import { checkSave, meaningOf, readsBack, spliceLoss, wordsOf } from "../../src/core/write-check";
import { applyEdits } from "../../src/core/text-changes";
import { bigDocument } from "../fixtures/big-document";
import { ChangedMeanwhile, FileProblem, readsBackAs, savingPathFor, fileStamp, writeDocument, writeSeams } from "../../src/main/files";

const DOC = "# Plan\n\nWe should hire **two** people this quarter.\n\n- Budget\n- Venue\n\nThe end.\n";

/** The document with words typed at the end of the block holding `words`. */
function typed(text: string, words: string, extra: string): { doc: Node; source: Source } {
  const { doc, source } = parseMarkdown(text);
  let at = -1;
  doc.descendants((n, pos) => {
    if (at < 0 && n.isTextblock && n.textContent.includes(words)) at = pos + n.nodeSize - 1;
    return at < 0;
  });
  if (at < 0) throw new Error(`no block with ${words}`);
  const state = EditorState.create({ doc });
  return { doc: state.apply(state.tr.insertText(extra, at)).doc, source };
}

describe("a save the net lets through", () => {
  it("is the text Corillo would write anyway, an unedited document byte for byte", () => {
    const { doc, source } = parseMarkdown(DOC);
    expect(checkSave(doc, source)).toEqual({ ok: true, text: DOC, repaired: 0 });
    const edited = typed(DOC, "hire", " Soon.");
    expect(checkSave(edited.doc, edited.source)).toEqual({ ok: true, text: serializeMarkdown(edited.doc, edited.source), repaired: 0 });
  });

  it("reads a note, a note's definition and a link by label back as they are in the document", () => {
    const text = "Words with a note[^1] and a [link][site].\n\n[^1]: The note, see[^2].\n\n[^2]: Another.\n\n[site]: https://example.org\n";
    for (const words of ["Words with", "The note", "Another"]) {
      const edited = typed(text, words, " More");
      const net = checkSave(edited.doc, edited.source);
      expect(net, words).toEqual({ ok: true, text: serializeMarkdown(edited.doc, edited.source), repaired: 0 });
    }
  });

  it("takes words the person deleted as theirs to take out", () => {
    const { doc, source } = parseMarkdown(DOC);
    const state = EditorState.create({ doc });
    const second = doc.child(0).nodeSize;
    const gone = state.apply(state.tr.delete(second, second + doc.child(1).nodeSize)).doc;
    expect(checkSave(gone, source)).toEqual({ ok: true, text: "# Plan\n\n- Budget\n- Venue\n\nThe end.\n", repaired: 0 });
  });

  it("lets a space or a line break typed at a paragraph's end through, though Markdown doesn't keep it", () => {
    const space = typed(DOC, "The end.", " ");
    expect(checkSave(space.doc, space.source)).toMatchObject({ ok: true, repaired: 0 });
    const { doc, source } = parseMarkdown(DOC);
    const state = EditorState.create({ doc });
    const end = doc.content.size - 1;
    const broken = state.apply(state.tr.replaceWith(end, end, schema.node("hard_break"))).doc;
    expect(checkSave(broken, source)).toMatchObject({ ok: true, repaired: 0 });
  });

  it("lets every paragraph of the long test document through when it's typed in, with nothing repaired", () => {
    const text = bigDocument(4);
    const { doc, source } = parseMarkdown(text);
    let checked = 0;
    doc.forEach((block, offset) => {
      if (block.type.name !== "paragraph" || !block.textContent.trim() || checked > 80) return;
      const state = EditorState.create({ doc });
      const page = state.apply(state.tr.insertText(" typed", offset + block.nodeSize - 1)).doc;
      const net = checkSave(page, source);
      expect(net, block.textContent).toEqual({ ok: true, text: serializeMarkdown(page, source), repaired: 0 });
      checked++;
    });
    expect(checked).toBeGreaterThan(50);
  });

  it("lets every block of the tests' sample documents through when it's typed in: lists, quotes, tables, notes and Obsidian's syntax", () => {
    let checked = 0;
    for (const name of ["word-preview.md", "obsidian-note.md"]) {
      const text = fs.readFileSync(join(import.meta.dirname, "..", "fixtures", name), "utf8");
      const { doc, source } = parseMarkdown(text);
      const ends: number[] = [];
      doc.descendants((n, pos) => {
        if (n.isTextblock && n.content.size) ends.push(pos + n.nodeSize - 1);
        return !n.isTextblock;
      });
      for (const end of ends) {
        const state = EditorState.create({ doc });
        const page = state.apply(state.tr.insertText("x", end)).doc;
        expect(checkSave(page, source), `${name} at ${end}`).toEqual({ ok: true, text: serializeMarkdown(page, source), repaired: 0 });
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);
  });
});

describe("a block Markdown reads its own way, every word still there", () => {
  it("is written as before, not held back: a table with a short row", () => {
    const cell = (t: string) => schema.nodes.table_cell.create(null, t ? schema.text(t) : null);
    const header = (t: string) => schema.nodes.table_header.create(null, schema.text(t));
    const table = schema.nodes.table.create(null, [
      schema.nodes.table_row.create(null, [header("a"), header("b")]),
      schema.nodes.table_row.create(null, [cell("1")]),
    ]);
    const doc = schema.node("doc", null, [table]);
    const { source } = parseMarkdown("");
    expect(checkSave(doc, source)).toEqual({ ok: true, text: serializeMarkdown(doc, source), repaired: 0 });
  });

  it("is written as before, not held back: a task list whose last sub-item is still empty", () => {
    const { list_item, paragraph, ordered_list, bullet_list } = schema.nodes;
    const item = (t: string, more: Node[] = [], checked: boolean | null = null) =>
      list_item.create({ checked }, [paragraph.create(null, t ? schema.text(t) : null), ...more]);
    const list = ordered_list.create({ order: 1 }, [
      item("x y"),
      item("z"),
      item("task", [bullet_list.create(null, [item("su"), item("")])], false),
    ]);
    const doc = schema.node("doc", null, [list]);
    const { source } = parseMarkdown("");
    const out = serializeMarkdown(doc, source);
    expect(readsBack(list, out.trimEnd())).toBe(false); // (read as Markdown text, its words all there)
    expect(checkSave(doc, source)).toEqual({ ok: true, text: out, repaired: 0 });
  });
});

describe("a planted fault in how a block is written", () => {
  const edited = () => typed(DOC, "hire", " Soon");
  const meant = () => {
    const e = edited();
    return serializeMarkdown(e.doc, e.source);
  };

  it("that drops a word is repaired: the block is written the careful way and the file has every word", () => {
    const { doc, source } = edited();
    const net = checkSave(doc, source, "drop-word");
    expect(net).toMatchObject({ ok: true, repaired: 1 });
    if (!net.ok) return;
    expect(net.text).toContain("Soon");
    const back = parseMarkdown(net.text).doc;
    expect(meaningOf(back)).toBe(meaningOf(doc));
    expect(net.text).toBe(meant().replace("**two**", "<strong>two</strong>")); // written another way: the bold as HTML
  });

  it("that writes a block reading back as another kind is repaired too", () => {
    const { doc, source } = edited();
    const net = checkSave(doc, source, "other-kind");
    expect(net).toMatchObject({ ok: true, repaired: 1 });
    if (net.ok) expect(meaningOf(parseMarkdown(net.text).doc)).toBe(meaningOf(doc));
  });

  it("that the careful way can't get round is refused, naming the word, and keeps every word for recovery", () => {
    const { doc, source } = edited();
    const net = checkSave(doc, source, "drop-word-always");
    expect(net.ok).toBe(false);
    if (net.ok) return;
    expect(net.lost).toEqual(["Soon"]);
    for (const word of wordsOf(doc)) expect(net.keep).toContain(word);
  });

  it("that leaves out a block nobody edited is refused, with that block's words named", () => {
    const { doc, source } = edited();
    const net = checkSave(doc, source, "lose-block");
    expect(net.ok).toBe(false);
    if (!net.ok) {
      expect(net.lost).toEqual(["Plan"]);
      expect(net.keep).toContain("Plan");
    }
  });
});

describe("reading a block back", () => {
  const p = (...kids: Node[]) => schema.node("paragraph", null, kids);
  it("tells a lost word, a lost bold, another kind of block and another link address apart from the block the page holds", () => {
    const page = p(schema.text("We hire "), schema.text("two", [schema.marks.strong.create()]), schema.text(" people."));
    expect(readsBack(page, "We hire **two** people.")).toBe(true);
    expect(readsBack(page, "We hire <b>two</b> people.")).toBe(true);
    expect(readsBack(page, "We hire **two** .")).toBe(false);
    expect(readsBack(page, "We hire two people.")).toBe(false);
    expect(readsBack(page, "# We hire **two** people.")).toBe(false);
    expect(readsBack(page, "We hire **two** people.\n\nAnd more.")).toBe(false);
    const link = p(schema.text("site", [schema.marks.link.create({ href: "https://a.org" })]));
    expect(readsBack(link, "[site](https://a.org)")).toBe(true);
    expect(readsBack(link, "[site](https://b.org)")).toBe(false);
  });

  it("takes a block kept as Markdown text by its lines, whatever they read as", () => {
    const raw = schema.node("raw_block", { kind: "html" }, [schema.text("<div>\nhello\n</div>")]);
    expect(readsBack(raw, "<div>\r\nhello\r\n</div>")).toBe(true);
    expect(readsBack(raw, "<div>\n</div>")).toBe(false);
  });
});

describe("an agent's find and replace", () => {
  const text = "# Plan\n\nWe hire two people.\n\nThe budget is tight.\n\nThe end.\n";
  const splices = (r: ReturnType<typeof applyEdits>) => (r.ok ? r.placed : []);

  it("that changes only what it found passes, a whole paragraph taken out included", () => {
    const r = applyEdits(text, [{ find: "The budget is tight.\n\n", replace: "" }, { find: "two", replace: "three" }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(spliceLoss(text, r.text, splices(r))).toBeNull();
  });

  it("whose splice would also take out words outside what it found names them", () => {
    const r = applyEdits(text, [{ find: "two", replace: "three" }]);
    if (!r.ok) throw new Error(r.error);
    const faulty = r.text.replace("The end.", "The.");
    expect(spliceLoss(text, faulty, splices(r))).toEqual(["end"]);
    // Off by one: the splice eats a letter of the word after it.
    const off = r.text.slice(0, r.placed[0].end) + r.text.slice(r.placed[0].end + 2);
    expect(spliceLoss(text, off, splices(r))).toEqual(["people"]);
  });
});

describe("what the net costs", () => {
  it("adds at most 10 ms to a save of one edited paragraph in the tests' longest document (best of five)", () => {
    const text = bigDocument();
    const { doc, source } = parseMarkdown(text);
    let at = -1;
    doc.forEach((block, offset) => {
      if (at < 0 && block.type.name === "paragraph" && offset > doc.content.size / 2) at = offset + block.nodeSize - 1;
    });
    // Each save edits afresh, so nothing is remembered from the one before.
    const page = () => {
      const state = EditorState.create({ doc });
      return state.apply(state.tr.insertText(" typed", at)).doc;
    };
    const first = performance.now();
    checkSave(page(), source); // (the file's blocks are looked up once, at a document's first save)
    const firstSave = performance.now() - first;
    let serialize = Infinity;
    let netted = Infinity;
    for (let i = 0; i < 5; i++) {
      const d = page();
      const t0 = performance.now();
      serializeMarkdown(d, source);
      const t1 = performance.now();
      checkSave(d, source);
      const t2 = performance.now();
      serialize = Math.min(serialize, t1 - t0);
      netted = Math.min(netted, t2 - t1);
    }
    console.log(`save of one edited paragraph, ${text.length} characters: writing the text ${serialize.toFixed(2)} ms, the net ${netted.toFixed(2)} ms more (${firstSave.toFixed(2)} ms at the first save)`);
    expect(netted).toBeLessThan(10);
  });

  // B14-02: what was read back at one save isn't read back again at the next, so the cost
  // follows the blocks changed since then, not everything changed since the file was opened.
  /** The net's cost per save, best of five, for one keystroke after a first save of `doc`. */
  function keystrokeCost(doc: Node, source: Source): { first: number; netted: number } {
    serializeMarkdown(doc, source);
    const t = performance.now();
    expect(checkSave(doc, source).ok).toBe(true); // the first save after the change, which reads it all back
    const first = performance.now() - t;
    let at = -1;
    doc.forEach((block, offset) => {
      if (at < 0 && block.type.name === "paragraph" && offset > doc.content.size / 2) at = offset + block.nodeSize - 1;
    });
    let page = doc;
    let netted = Infinity;
    for (let i = 0; i < 5; i++) {
      const state = EditorState.create({ doc: page });
      page = state.apply(state.tr.insertText("x", at + i)).doc; // one keystroke more, on the page as it was
      serializeMarkdown(page, source);
      const t0 = performance.now();
      expect(checkSave(page, source).ok).toBe(true);
      netted = Math.min(netted, performance.now() - t0);
    }
    return { first, netted };
  }

  it("adds at most 10 ms to each save after a long text is pasted into a new document, once the first save is made (best of five)", () => {
    const { doc } = parseMarkdown(bigDocument());
    const { first, netted } = keystrokeCost(doc, parseMarkdown("").source); // every block new: none from a file
    console.log(`every block new: the first save ${first.toFixed(2)} ms, then ${netted.toFixed(2)} ms a keystroke`);
    expect(netted).toBeLessThan(10);
    expect(netted).toBeLessThan(first / 5); // (and, measured within the run, a small part of reading it all back)
  });

  it("adds at most 10 ms to each save after Replace All touched every paragraph, once the first save is made (best of five)", () => {
    const { doc, source } = parseMarkdown(bigDocument());
    const state = EditorState.create({ doc });
    const tr = state.tr;
    let touched = 0;
    doc.descendants((n, pos) => {
      if (n.type.name !== "paragraph" || !n.textContent.includes("the")) return n.type.name !== "paragraph";
      tr.insertText("T", tr.mapping.map(pos + 1), tr.mapping.map(pos + 2)); // its first letter replaced
      touched++;
      return false;
    });
    expect(touched).toBeGreaterThan(500);
    const { first, netted } = keystrokeCost(state.apply(tr).doc, source);
    console.log(`${touched} paragraphs replaced: the first save ${first.toFixed(2)} ms, then ${netted.toFixed(2)} ms a keystroke`);
    expect(netted).toBeLessThan(10);
    expect(netted).toBeLessThan(first / 5); // (and, measured within the run, a small part of reading it all back)
  });
});

describe("the bytes of a save, read back", () => {
  const folders: string[] = [];
  afterEach(() => {
    writeSeams.afterTemp = writeSeams.afterSwap = null;
    for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const doc = (text: string) => {
    const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "corillo-net-")));
    folders.push(dir);
    const file = join(dir, "plan.md");
    fs.writeFileSync(file, text);
    return file;
  };

  it("are as meant: the save says nothing more", () => {
    const file = doc("# Plan\n");
    expect(writeDocument(file, "# Plan\n\nMore.\n")).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe("# Plan\n\nMore.\n");
    expect(readsBackAs(file, "# Plan\n\nMore.\n")).toBe(true);
    expect(readsBackAs(file, "# Plan\n")).toBe(false);
  });

  it("in a temporary file planted with wrong bytes never take the document's place, and nothing is left behind", () => {
    const file = doc("# Plan\n\nThe words he had.\n");
    writeSeams.afterTemp = (temp) => fs.writeFileSync(temp, "# Plan\n\nThe words.\n");
    expect(() => writeDocument(file, "# Plan\n\nThe words he had, and more.\n")).toThrow(FileProblem);
    expect(fs.readFileSync(file, "utf8")).toBe("# Plan\n\nThe words he had.\n");
    expect(fs.existsSync(savingPathFor(file))).toBe(false);
  });

  it("changed on disk in the moment after the save come back as the file's text now, to be taken in, not written over", () => {
    const file = doc("# Plan\n");
    writeSeams.afterSwap = (target) => fs.writeFileSync(target, "# Plan\n\nAnother app's line.\n");
    expect(writeDocument(file, "# Plan\n\nMine.\n")).toBe("# Plan\n\nAnother app's line.\n");
    expect(fs.readFileSync(file, "utf8")).toBe("# Plan\n\nAnother app's line.\n");
  });

  // A16-1: another app's save that landed while Corillo was writing was replaced, and nobody was told.
  it("changed on disk while Corillo writes them never take the other app's place: the save stops, and the file is theirs", () => {
    const mine = "# Plan\n\nThe words he had, and more.\n";
    const theirs = "# Plan\n\nThe words he had.\n\nA paragraph another app added.\n";
    // Saved over in place, or by a new file put in its place; checked by the file's stamp at Corillo's look, or by the text an agent read.
    const inPlace = (file: string) => () => fs.writeFileSync(file, theirs);
    const newFile = (file: string) => () => {
      fs.writeFileSync(`${file}.theirs`, theirs);
      fs.renameSync(`${file}.theirs`, file);
    };
    for (const how of [inPlace, newFile]) {
      for (const look of ["stamp", "text"] as const) {
        const file = doc("# Plan\n\nThe words he had.\n");
        const stillAs = look === "stamp" ? { stamp: fileStamp(file)! } : { text: "# Plan\n\nThe words he had.\n" };
        writeSeams.afterTemp = how(file);
        expect(() => writeDocument(file, mine, stillAs)).toThrow(ChangedMeanwhile);
        expect(fs.readFileSync(file, "utf8")).toBe(theirs);
        expect(fs.existsSync(savingPathFor(file))).toBe(false);
        // Unchanged, it saves.
        writeSeams.afterTemp = null;
        expect(writeDocument(file, mine, look === "stamp" ? { stamp: fileStamp(file)! } : { text: theirs })).toBeNull();
        expect(fs.readFileSync(file, "utf8")).toBe(mine);
      }
    }
  });

  it("cost little on the tests' longest document (best of five)", () => {
    const text = bigDocument();
    const file = doc(text);
    let write = Infinity;
    let read = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      writeDocument(file, text + i);
      const t1 = performance.now();
      fs.readFileSync(file).equals(Buffer.from(text + i));
      const t2 = performance.now();
      write = Math.min(write, t1 - t0);
      read = Math.min(read, t2 - t1);
    }
    console.log(`writing ${text.length} characters: ${write.toFixed(2)} ms in all, of which reading back takes about ${(2 * read).toFixed(2)} ms (twice ${read.toFixed(2)})`);
    expect(2 * read).toBeLessThan(10);
  });
});
