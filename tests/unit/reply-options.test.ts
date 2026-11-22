// Choose between the agent's options with one click (roadmap Batch 3, item 2;
// A-3, L-8; decision D7: "Agents can attach up to three options to a reply,
// and you apply one with a click"). Each option is a label and edits in
// edit_document's form; each find must match exactly once, checked when the
// agent posts it and again when the person clicks, against the text as it is
// then. The record is capped, so an agent can't grow it without bound.
import { describe, expect, it } from "vitest";
import { addThread, chooseOption, reply, waitingForPerson, type Author } from "../../src/core/comments";
import { applyOption, checkOptions, choiceStands, choicesOf, cleanLabel, cleanSpans, cleanUndo, optionsOf, placesAfterChoice, planChoice, stagesOf, standing, undoOf, MAX_EDITS, MAX_LABEL, MAX_OPTIONS_SIZE, type Choice, type Place } from "../../src/core/options";
import { posAt, textIndex } from "../../src/core/anchors";
import { parseMarkdown } from "../../src/core/markdown";
import { applyEdits } from "../../src/core/text-changes";
import { INSTRUCTIONS, TOOLS } from "../../src/mcp/tools";
import { whyNotChangeable } from "../../src/renderer/editable";
import type { DocTab } from "../../src/renderer/doc-tab";
import type { HistoryUi } from "../../src/renderer/history";

const me: Author = { kind: "person" };
const claude: Author = { kind: "agent", name: "Claude" };
const TEXT = "# Plan\n\nWe should hire three people this quarter.\n\nThe budget is tight.\n";
const shorter = { label: "Shorter", edits: [{ find: "We should hire three people this quarter.", replace: "Hire three this quarter." }] };
const formal = { label: "Formal", edits: [{ find: "We should hire three people this quarter.", replace: "The plan is to recruit three staff this quarter." }] };

describe("checking options when the agent posts them", () => {
  it("up to three options, each a label and edits that fit the text as it is", () => {
    const r = checkOptions([shorter, formal], TEXT);
    expect(r).toEqual({ ok: true, options: [shorter, formal] });
    expect(checkOptions(undefined, TEXT)).toEqual({ ok: true, options: [] });
    expect(checkOptions([], TEXT)).toEqual({ ok: true, options: [] });
  });

  it("refuses more than three, and says why", () => {
    const four = ["A", "B", "C", "D"].map((label, i) => ({ label, edits: [{ find: "tight", replace: `tight ${i}` }] }));
    const r = checkOptions(four, TEXT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("At most 3 options on one reply. Nothing was posted.");
  });

  it("each find must match the text exactly once", () => {
    const missing = checkOptions([{ label: "Other", edits: [{ find: "hire two people", replace: "hire four" }] }], TEXT);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/^Option 1 \("Other"\): the text to find isn't in the document\..*Nothing was posted\.$/);
    const twice = checkOptions([{ label: "Plural", edits: [{ find: "e", replace: "E" }] }], TEXT);
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.error).toMatch(/^Option 1 \("Plural"\): the text to find appears \d+ times/);
    // "all" isn't for options: each find matches once.
    const all = checkOptions([{ label: "All", edits: [{ find: "e", replace: "E", all: true }] }], TEXT);
    expect(all.ok).toBe(false);
  });

  it("an option that would change nothing is refused: offer the other versions, not the one already in the text", () => {
    const same = checkOptions([{ label: "Same", edits: [{ find: "tight", replace: "tight" }] }], TEXT);
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.error).toContain("changes nothing");
  });

  it("labels are one plain line, short, and different from each other; no markup", () => {
    expect(cleanLabel("  <b>Shorter</b>\n version ")).toBe("Shorter version");
    expect(cleanLabel("**Bold** `code` [link](https://x.y) ~~gone~~")).toBe("Bold code link gone");
    expect(cleanLabel("# Heading > quote")).toBe("Heading quote");
    expect(cleanLabel("Tab\there\u0000\u202eend")).toBe("Tab here end");
    const long = cleanLabel("Keep the original wording but cut the second clause and move the date to the front of the sentence");
    expect(long.length).toBeLessThanOrEqual(MAX_LABEL);
    expect(long.endsWith("…")).toBe(true);
    expect(long).not.toMatch(/\s…$/);
    const empty = checkOptions([{ label: "<i></i>", edits: shorter.edits }], TEXT);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain("needs a label");
    const twins = checkOptions([shorter, { ...formal, label: "shorter" }], TEXT);
    expect(twins.ok).toBe(false);
    if (!twins.ok) expect(twins.error).toContain("different labels");
  });

  it("is capped: edits per option and the options' total size", () => {
    const many = Array.from({ length: MAX_EDITS + 1 }, (_, i) => ({ find: `x${i}`, replace: "y" }));
    const tooMany = checkOptions([{ label: "Many", edits: many }], TEXT);
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error).toContain(`at most ${MAX_EDITS} edits`);
    const huge = checkOptions([{ label: "Huge", edits: [{ find: "tight", replace: "x".repeat(MAX_OPTIONS_SIZE) }] }], TEXT);
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.error).toContain("too long");
  });

  it("refuses what isn't a list of options, in plain words", () => {
    for (const bad of ["Shorter", { label: "x" }, [null], [{ label: "No edits", edits: [] }], [{ label: "Bad edit", edits: [{ find: 3 }] }]]) {
      const r = checkOptions(bad, TEXT);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("applying an option when the person clicks", () => {
  it("applies to the text as it is then", () => {
    const r = applyOption(TEXT, shorter);
    expect(r).toEqual({ ok: true, text: TEXT.replace("We should hire three people this quarter.", "Hire three this quarter.") });
  });

  it("an option that no longer fits changes nothing", () => {
    const edited = TEXT.replace("three people", "four people");
    expect(applyOption(edited, shorter).ok).toBe(false);
    const twice = `${TEXT}\nWe should hire three people this quarter.\n`;
    expect(applyOption(twice, shorter).ok).toBe(false);
  });

  it("goes in one place at a time, from the last to the first, so the words between two places are never rewritten (B3-R01)", () => {
    const text = "The request is $68,000 for the year.\n\nWe will hire two guides.\n\nIn short, $68,000 in total.\n";
    const keep = {
      label: "Keep",
      edits: [
        { find: "$68,000 in total", replace: "$52,000 in total" },
        { find: "$68,000 for the year", replace: "$52,000 for the year" },
      ],
    };
    const stages = stagesOf(text, keep.edits);
    expect(stages).toEqual([
      text.replace("$68,000 in total", "$52,000 in total"),
      text.replace("$68,000 in total", "$52,000 in total").replace("$68,000 for", "$52,000 for"),
    ]);
    expect(stages[stages.length - 1]).toBe((applyOption(text, keep) as { text: string }).text);
  });
});

describe("switching to another option, and knowing which is in the text (B3-R03)", () => {
  const options = [shorter, formal];
  const SHORT = TEXT.replace("We should hire three people this quarter.", "Hire three this quarter.");
  const FORMAL = TEXT.replace("We should hire three people this quarter.", "The plan is to recruit three staff this quarter.");
  const choose = (text: string, index: number, choices: Choice[] = [], at = "2026-11-10T10:00:00.000Z") => {
    const plan = planChoice(text, options, choices, index);
    if (!plan.ok) throw new Error(plan.why);
    return { plan, choice: { option: index, at, undo: plan.undo, spans: [] } as Choice };
  };

  it("a choice keeps how to take it back out, and stands while that fits and the option made again gives the text", () => {
    const { plan, choice } = choose(TEXT, 0);
    expect(plan.texts).toEqual([TEXT, SHORT]);
    expect(plan.after).toBe(SHORT);
    expect(choiceStands(SHORT, shorter, choice)).toBe(TEXT);
    expect(choiceStands(TEXT, shorter, choice)).toBeNull(); // taken back with Undo
    expect(choiceStands(SHORT.replace("Hire three", "Hire four"), shorter, choice)).toBeNull(); // its words edited since
    // Edits elsewhere leave it standing.
    expect(choiceStands(SHORT.replace("tight", "very tight"), shorter, choice)).toBe(TEXT.replace("tight", "very tight"));
  });

  it("a click on another option takes the first out, then makes the other, from the text as it was before the choice", () => {
    const first = choose(TEXT, 0);
    const edited = SHORT.replace("tight", "very tight");
    const second = choose(edited, 1, [first.choice], "2026-11-10T10:01:00.000Z");
    expect(second.plan.before).toBe(TEXT.replace("tight", "very tight"));
    expect(second.plan.after).toBe(FORMAL.replace("tight", "very tight"));
    expect(second.plan.texts[0]).toBe(edited);
    expect(second.plan.texts[second.plan.texts.length - 1]).toBe(FORMAL.replace("tight", "very tight"));
    const both = [first.choice, second.choice];
    expect(standing(FORMAL, options, both)?.choice.option).toBe(1);
    expect(standing(SHORT, options, both)?.choice.option).toBe(0); // Undo of the switch
    expect(standing(TEXT, options, both)).toBeNull();
    // The one in the text isn't made again; one overtaken by the person's edits doesn't fit.
    expect(planChoice(SHORT, options, [first.choice], 0)).toEqual({ ok: false, why: "in the text" });
    expect(planChoice(SHORT.replace("Hire three", "Hire four"), options, [first.choice], 1)).toEqual({ ok: false, why: "no longer fits" });
  });

  it("each step changes one place, and the undo finds each place once even where its words repeat", () => {
    const text = "Pay $68,000 now.\n\nThen $68,000 later.\n\nNever $68,000 again.\n";
    const keep = { label: "Keep", edits: [{ find: "Pay $68,000", replace: "Pay $52,000" }, { find: "Never $68,000", replace: "Never $52,000" }] };
    const plan = planChoice(text, [keep], [], 0);
    if (!plan.ok) throw new Error(plan.why);
    expect(plan.texts).toHaveLength(3);
    expect(plan.undo).toHaveLength(2);
    expect(applyEdits(plan.after, plan.undo)).toMatchObject({ ok: true, text });
    // Places close together are taken back together.
    expect(undoOf("ab", "xy", [{ at: 0, end: 1, replace: "x" }, { at: 1, end: 2, replace: "y" }])).toEqual([{ find: "xy", replace: "ab" }]);
    // Words only taken out are found by what's around them.
    const cut = undoOf("one two three", "one three", [{ at: 3, end: 7, replace: "" }]);
    expect(applyEdits("one three", cut)).toMatchObject({ ok: true, text: "one two three" });
  });

  it("what's kept of a choice is cut down to what's safe; an older record reads as no choice", () => {
    const m = { id: "m", author: claude, body: "x", created: "", options };
    expect(choicesOf({ ...m, chosen: { option: 0, at: "x" } } as never)).toEqual([]);
    const undo = [{ find: "Hire three", replace: "We should hire three people" }];
    const kept = choicesOf({ ...m, choices: [{ option: 0, at: "t", undo, spans: [] }, { option: 7, at: "t", undo, spans: [] }, { option: 0, at: "u", undo, spans: [] }] } as never);
    expect(kept).toEqual([{ option: 0, at: "t", undo, spans: [] }]);
    expect(cleanUndo([{ find: "", replace: "x" }])).toEqual([]);
    expect(cleanUndo([{ find: "a", replace: "x".repeat(100_000) }])).toEqual([]);
    expect(cleanUndo("x")).toEqual([]);
    expect(cleanUndo(undo)).toEqual(undo);
  });
});

describe("comments on the words a choice changes (roadmap Batch 6)", () => {
  /** Where each comment is in `md`, by its words. */
  const placesIn = (index: ReturnType<typeof textIndex>, comments: Record<string, string>) => {
    const places = new Map<string, Place>();
    for (const [id, words] of Object.entries(comments)) {
      const at = index.text.indexOf(words);
      places.set(id, { from: posAt(index, at, "start"), to: posAt(index, at + words.length, "end") });
    }
    return places;
  };
  /** The comments' words after the text becomes `next`, for those not already there: `placed`, the words the editor put each on. */
  const through = (md: string, next: string, comments: Record<string, string>, placed: Record<string, string> = {}) => {
    const was = textIndex(parseMarkdown(md).doc);
    const doc = parseMarkdown(next).doc;
    const now = textIndex(doc);
    const moved = placesAfterChoice(was, now, placesIn(was, comments), placesIn(now, placed));
    return Object.fromEntries([...moved].map(([id, p]) => [id, doc.textBetween(p.from, p.to)]));
  };
  const SHORT = TEXT.replace("We should hire three people this quarter.", "Hire three this quarter.");
  const FORMAL = TEXT.replace("We should hire three people this quarter.", "The plan is to recruit three staff this quarter.");

  it("end on the words that took their place, as after an agent's edit, not on a letter the versions share", () => {
    expect(through(TEXT, SHORT, { a: "three people", b: "We should hire", c: "budget", d: "Plan" })).toEqual({ a: "three", b: "Hire" });
    expect(through(TEXT, FORMAL, { a: "three people", b: "people this" })).toEqual({ a: "three staff", b: "staff this" });
    // Words that came through as they were stay on them, wherever the editor's own steps left them (Undo of Shorter, say).
    expect(through(SHORT, TEXT, { a: "three" }, { a: "e" })).toEqual({ a: "three" });
  });

  it("only comments the editor has somewhere else are given; those outside the passage it changed never are", () => {
    expect(through(SHORT, FORMAL, { a: "three", b: "budget" }, { a: "three", b: "budget" })).toEqual({});
    const text = "Pay $68,000 now, then more, then $68,000 later.\n";
    const next = text.replace("Pay $68,000", "Pay $52,000").replace("then $68,000", "then $52,000");
    expect(through(text, next, { a: "then more", b: "$68,000 now" }, { a: "then more" })).toEqual({ b: "$52,000 now" });
  });

  it("words rewritten whole are on the words that rewrote them, as the comparison pairs them; words taken out are left to the editor", () => {
    expect(through(TEXT, TEXT.replace("hire three people", "build a team"), { a: "three people", b: "three" })).toEqual({ a: "a team", b: "build a team" });
    expect(through(TEXT, TEXT.replace(" three people", ""), { a: "three people" })).toEqual({});
  });
});

describe("whether a click may change the document now", () => {
  it("not while an agent holds it or a version picked in History is shown; with Show changes on, and in either view, it may (B3-R02)", () => {
    const tab = (readOnly: boolean, mode: "formatted" | "markdown" = "formatted") => ({ readOnly, mode }) as unknown as DocTab;
    const history = (viewing: "latest" | "older" | null, changes = false) =>
      ({ status: () => ({ viewing, panelOpen: false, canRestore: false, changes }) }) as unknown as HistoryUi;
    expect(whyNotChangeable(tab(false), history(null))).toBeNull();
    expect(whyNotChangeable(tab(false, "markdown"), history(null))).toBeNull();
    expect(whyNotChangeable(tab(true), history(null))).toBe("agent");
    expect(whyNotChangeable(tab(true), history("latest", true))).toBe("agent");
    expect(whyNotChangeable(tab(false), history("latest", true))).toBeNull();
    expect(whyNotChangeable(tab(false, "markdown"), history("latest", true))).toBeNull();
    expect(whyNotChangeable(tab(false), history("latest"))).toBe("version"); // the latest version, picked in History
    expect(whyNotChangeable(tab(false), history("older"))).toBe("version");
  });
});

describe("what's kept", () => {
  it("an agent's reply keeps its options; the person's never has any", () => {
    let { threads, thread } = addThread([], me, "Too wordy?", null, null);
    threads = reply(threads, thread.id, claude, "Tightened it. Or pick one:", null, [shorter, formal]);
    expect(threads[0].messages[1].options).toEqual([shorter, formal]);
    expect(() => reply(threads, thread.id, me, "Mine", null, [shorter])).toThrow("Only an agent's reply has options");
  });

  it("the person's choice is recorded on the reply, with the text it changed, beside the agent's change, not in its place; the comment stays open (B3-R04)", () => {
    let { threads, thread } = addThread([], me, "Too wordy?", null, null);
    const agents = { round: 1, agent: "Claude", at: "2026-11-10T09:00:00.000Z", spans: [{ anchor: { quote: "three", prefix: "hire ", suffix: " people", offset: 21 }, removed: "two" }] };
    threads = threads.map((t) => ({ ...t, change: agents }));
    threads = reply(threads, thread.id, claude, "Tightened it. Or pick one:", null, [shorter, formal]);
    const replyId = threads[0].messages[1].id;
    const spans = [{ anchor: { quote: "Hire three this quarter.", prefix: "", suffix: "", offset: 6 }, removed: "We should hire three people this quarter." }];
    const undo = [{ find: "Hire three this quarter.", replace: "We should hire three people this quarter." }];
    threads = chooseOption(threads, thread.id, replyId, me, 0, spans, undo);
    const t = threads[0];
    expect(t.status).toBe("open");
    expect(t.messages[1].choices).toEqual([{ option: 0, at: expect.any(String), undo, spans }]);
    expect(t.change).toEqual(agents); // the agent's change stays, for when the choice is taken back out
    expect(waitingForPerson(t)).toBe(true); // Claude spoke last: the choice doesn't change whose turn it is
    expect(t.messages).toHaveLength(2); // no message from the person: it still waits for them to resolve it
    expect(() => chooseOption(threads, thread.id, replyId, claude, 1, spans)).toThrow("Only you choose");
    expect(() => chooseOption(threads, thread.id, replyId, me, 3, spans)).toThrow("no longer offered");
    expect(() => chooseOption(threads, thread.id, t.messages[0].id, me, 0, spans)).toThrow("no longer offered");
  });

  it("an older record without options reads as a plain reply, and a damaged or hostile one is cut down to what's safe", () => {
    expect(optionsOf({ id: "m", author: claude, body: "Done.", created: "" })).toEqual([]);
    expect(optionsOf({ id: "m", author: claude, body: "x", created: "", options: "nonsense" as never })).toEqual([]);
    const hostile = Array.from({ length: 50 }, (_, i) => ({ label: `<script>${"L".repeat(500)}</script>${i}`, edits: Array.from({ length: 40 }, () => ({ find: "a", replace: "b" })) }));
    const safe = optionsOf({ id: "m", author: claude, body: "x", created: "", options: hostile });
    expect(safe).toHaveLength(3);
    for (const o of safe) {
      expect(o.label.length).toBeLessThanOrEqual(MAX_LABEL);
      expect(o.label).not.toContain("<");
      expect(o.edits.length).toBeLessThanOrEqual(MAX_EDITS);
    }
    // The person's messages never show options.
    expect(optionsOf({ id: "m", author: me, body: "x", created: "", options: [shorter] })).toEqual([]);
  });

  it("a damaged record's options are cut down to the 12,000 characters all the options' words may have together (B3-R12)", () => {
    const long = (label: string) => ({ label, edits: [{ find: "f".repeat(2_500), replace: "r".repeat(2_500) }] });
    const kept = optionsOf({ id: "m", author: claude, body: "x", created: "", options: [long("One"), long("Two"), long("Three")] });
    expect(kept.map((o) => o.label)).toEqual(["One", "Two"]);
    const size = kept.reduce((sum, o) => sum + o.label.length + o.edits.reduce((n, e) => n + e.find.length + e.replace.length, 0), 0);
    expect(size).toBeLessThanOrEqual(MAX_OPTIONS_SIZE);
  });
});

describe("the text a choice changed, as the window reports it", () => {
  it("only well-formed spans are kept, at most 50, none longer than the options can be", () => {
    const good = { anchor: { quote: "Hire three", prefix: "", suffix: " this", offset: 6 }, removed: "We should hire three people" };
    expect(cleanSpans([good])).toEqual([good]);
    expect(cleanSpans("x")).toEqual([]);
    expect(cleanSpans([{ anchor: { quote: 3 } }, null, { ...good, removed: "x".repeat(MAX_OPTIONS_SIZE + 1) }, { ...good, anchor: { ...good.anchor, offset: -1 } }])).toEqual([]);
    expect(cleanSpans(Array.from({ length: 80 }, () => good))).toHaveLength(50);
    expect(cleanSpans([{ ...good, extra: "<script>" }])[0]).toEqual(good);
  });
});

describe("what agents are told", () => {
  it("the instructions say to make the best version and offer the others as options, and still fit", () => {
    expect(INSTRUCTIONS).toContain("When a choice is the person's to make, make your best version and offer the others as options");
    expect(INSTRUCTIONS.length).toBeLessThan(4096);
  });

  it("reply_to_comment takes up to three options, briefly described", () => {
    const tool = TOOLS.find((t) => t.name === "reply_to_comment")!;
    const options = tool.inputSchema.properties.options as { type: string; maxItems: number; items: { properties: Record<string, unknown>; required: string[] } };
    expect(options.type).toBe("array");
    expect(options.maxItems).toBe(3);
    expect(Object.keys(options.items.properties)).toEqual(["label", "edits"]);
    expect(options.items.required).toEqual(["label", "edits"]);
    expect(tool.inputSchema.required).toEqual(["path", "comment_id", "text"]);
    // It loads up front: what it adds stays short.
    expect(JSON.stringify(tool).length).toBeLessThan(1500);
  });
});
