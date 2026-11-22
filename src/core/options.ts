// Options an agent attaches to a reply (roadmap Batch 3, item 2; decision D7:
// "Agents can attach up to three options to a reply, and you apply one with a
// click"). Each is a short label and edits in edit_document's form. Each find
// must match the text exactly once: checked when the agent posts the reply,
// and again when the person clicks, against the text as it is then. What's
// kept is capped (options, edits, label length, total size), so an agent can't
// grow a comment's record without bound. Plain logic, no app or window code.
import { applyEdits } from "./text-changes";
import type { Message } from "./comments";
import { carry, placeEdits, sharedEnds, OffsetMap, type ChangeSpan } from "./change-links";
import { anchorIn, offsetAt, posAt, type TextIndex } from "./anchors";

export interface OptionEdit {
  find: string;
  replace: string;
}

export interface ReplyOption {
  label: string;
  edits: OptionEdit[];
}

/**
 * An option the person applied, kept on the agent's reply: which, when, how
 * to take it back out of the text, and the text it changed as the person
 * reads it. A reply keeps one for each option chosen, the latest each time.
 */
export interface Choice {
  option: number;
  at: string;
  /**
   * Edits that take the choice back out of the text as it was right after
   * it: each the words it put in, with words around them so it matches once,
   * back to what was there before. While they fit, and the option made again
   * gives the text back as it is, the choice is in the text (see standing).
   */
  undo: OptionEdit[];
  spans: ChangeSpan[];
}

export const MAX_OPTIONS = 3;
export const MAX_LABEL = 60;
export const MAX_EDITS = 10;
/** The options' labels, finds and replacements together, in characters. */
export const MAX_OPTIONS_SIZE = 12_000;

export type OptionsCheck = { ok: true; options: ReplyOption[] } | { ok: false; error: string };
export type Applied = { ok: true; text: string } | { ok: false; error: string };

// Characters that don't belong in a one-line label: controls, and the invisible ones that turn or hide text.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/**
 * A label as one plain line: no tags, no Markdown signs, no control or
 * invisible characters, spaces collapsed, cut at a whole word to fit.
 */
export function cleanLabel(raw: string): string {
  let s = String(raw)
    .replace(/<[^>]*>/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(INVISIBLE, " ")
    .replace(/[*_`~<>[\]\\#|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > MAX_LABEL) {
    const room = s.slice(0, MAX_LABEL - 1);
    const space = room.lastIndexOf(" ");
    s = `${(space > MAX_LABEL / 2 ? room.slice(0, space) : room).replace(/[\s,;:.-]+$/, "")}…`;
  }
  return s;
}

const isEdit = (e: unknown): e is OptionEdit =>
  !!e && typeof e === "object" && typeof (e as OptionEdit).find === "string" && typeof (e as OptionEdit).replace === "string";

/**
 * The options an agent gave with a reply, checked against the text as it is:
 * at most three, each with its own label and one to ten edits that all fit
 * (each find exactly once) and change something. Nothing is posted otherwise.
 */
export function checkOptions(raw: unknown, text: string): OptionsCheck {
  if (raw === undefined || raw === null) return { ok: true, options: [] };
  const no = (error: string): OptionsCheck => ({ ok: false, error: `${error} Nothing was posted.` });
  if (!Array.isArray(raw)) return no("options must be a list of options, each with a label and edits.");
  if (raw.length > MAX_OPTIONS) return no(`At most ${MAX_OPTIONS} options on one reply.`);
  const options: ReplyOption[] = [];
  let size = 0;
  for (const [i, o] of raw.entries()) {
    const n = i + 1;
    if (!o || typeof o !== "object") return no(`Option ${n} must have a label and edits.`);
    const { label: rawLabel, edits } = o as { label?: unknown; edits?: unknown };
    const label = cleanLabel(typeof rawLabel === "string" ? rawLabel : "");
    if (!label) return no(`Option ${n} needs a label: a few words saying what it does.`);
    const name = `Option ${n} ("${label}")`;
    if (options.some((x) => x.label.toLowerCase() === label.toLowerCase())) return no(`${name}: options need different labels.`);
    if (!Array.isArray(edits) || !edits.length || !edits.every(isEdit)) return no(`${name} needs edits, each with find and replace.`);
    if (edits.length > MAX_EDITS) return no(`${name}: at most ${MAX_EDITS} edits in an option.`);
    if (edits.some((e) => (e as { all?: unknown }).all)) return no(`${name}: each find in an option matches once; all isn't used here.`);
    const clean = edits.map((e) => ({ find: e.find, replace: e.replace }));
    size += label.length + clean.reduce((sum, e) => sum + e.find.length + e.replace.length, 0);
    if (size > MAX_OPTIONS_SIZE) return no(`The options are too long together (at most ${MAX_OPTIONS_SIZE.toLocaleString("en")} characters): keep each to the words that differ.`);
    const applied = applyOption(text, { label, edits: clean });
    if (!applied.ok) return no(`${name}: ${lower(applied.error)}`);
    if (applied.text === text) return no(`${name} changes nothing: offer the other versions, not the one the text has now.`);
    options.push({ label, edits: clean });
  }
  return { ok: true, options };
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** One option applied to the text as it is now: each find exactly once, or nothing changes. */
export function applyOption(text: string, option: ReplyOption): Applied {
  const r = applyEdits(text, option.edits.map((e) => ({ find: e.find, replace: e.replace })));
  if (r.ok) return { ok: true, text: r.text };
  return { ok: false, error: r.error.replace(/ Nothing was changed\.$/, "") };
}

/**
 * The texts edits that fit (see applyOption) take the text through, one edit
 * at a time, from the last in the text to the first; the last is the text
 * with all of them made. Each step changes one place, so the window can make
 * them one by one and what's between two places keeps its comments.
 */
export function stagesOf(text: string, edits: OptionEdit[]): string[] {
  const placed = placeEdits(text, edits);
  const out: string[] = [];
  let at = text;
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i];
    at = at.slice(0, p.at) + p.replace + at.slice(p.end);
    out.push(at);
  }
  return out;
}

// Choosing, and switching to another option ----------------------------------------

/** How much of the text around each place a choice changed is kept to find it again, tried in turn until it's found once. */
const AROUND = [0, 8, 16, 32, 64, 128, 256, 512];

/**
 * The edits that take an option back out of `after`, where it was made on
 * `before` with these placed edits: each the words it put in, with as few
 * words around them as make it match once (places whose words around meet
 * go together), back to what was there. None when no such edits give
 * `before` back exactly.
 */
export function undoOf(before: string, after: string, placed: readonly { at: number; end: number; replace: string }[]): OptionEdit[] {
  if (!placed.length) return [];
  // Where each edit is: [at, end) in before, [start, stop) in after.
  const landed: { at: number; end: number; start: number; stop: number }[] = [];
  let shift = 0;
  for (const p of [...placed].sort((x, y) => x.at - y.at)) {
    const start = p.at + shift;
    landed.push({ at: p.at, end: p.end, start, stop: start + p.replace.length });
    shift += p.replace.length - (p.end - p.at);
  }
  for (const k of AROUND) {
    const groups: typeof landed = [];
    for (const l of landed) {
      const last = groups[groups.length - 1];
      if (last && l.start - k <= last.stop + k) groups[groups.length - 1] = { at: last.at, end: l.end, start: last.start, stop: l.stop };
      else groups.push({ ...l });
    }
    const edits: OptionEdit[] = [];
    for (const g of groups) {
      const from = Math.max(0, g.start - k);
      const to = Math.min(after.length, g.stop + k);
      const find = after.slice(from, to);
      if (!find || after.indexOf(find) !== from || after.indexOf(find, from + 1) !== -1) break;
      edits.push({ find, replace: before.slice(g.at - (g.start - from), g.end + (to - g.stop)) });
    }
    if (edits.length < groups.length) continue;
    const back = applyEdits(after, edits);
    if (back.ok && back.text === before) return edits;
  }
  return [];
}

/**
 * Whether a choice is in the text as it is now: its undo fits, and the
 * option made again on what that gives back is the text exactly. The text as
 * it was before the choice when it is; null when it isn't (taken back with
 * Undo, or its words edited since).
 */
export function choiceStands(text: string, option: ReplyOption | undefined, choice: Choice): string | null {
  if (!option || !choice.undo.length) return null;
  const back = applyEdits(text, choice.undo);
  if (!back.ok) return null;
  const again = applyOption(back.text, option);
  return again.ok && again.text === text ? back.text : null;
}

/** The option chosen on a reply that's in the text now (the latest, if more than one could be), and the text before it. */
export function standing(text: string, options: ReplyOption[], choices: Choice[]): { choice: Choice; before: string } | null {
  for (const choice of [...choices].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))) {
    const before = choiceStands(text, options[choice.option], choice);
    if (before !== null) return { choice, before };
  }
  return null;
}

export type Plan =
  | { ok: true; texts: string[]; before: string; after: string; undo: OptionEdit[] }
  | { ok: false; why: "no longer fits" | "in the text" };

/**
 * What a click on option `index` does to the text as it is now. Another
 * option chosen on the reply that's still in the text is taken out first, so
 * the new one goes on the text as it was before that choice, all as one
 * change (review of Batch 3, B3-R03). `texts` are the text now, then each
 * text on the way (see stagesOf); `before` and `after` the text without and
 * with this option; `undo` takes it back out (see undoOf).
 */
export function planChoice(text: string, options: ReplyOption[], choices: Choice[], index: number): Plan {
  const option = options[index];
  if (!option) return { ok: false, why: "no longer fits" };
  const now = standing(text, options, choices);
  if (now?.choice.option === index) return { ok: false, why: "in the text" };
  const before = now ? now.before : text;
  const applied = applyOption(before, option);
  if (!applied.ok) return { ok: false, why: "no longer fits" };
  const texts = [text, ...(now ? stagesOf(text, now.choice.undo) : []), ...stagesOf(before, option.edits)];
  return { ok: true, texts, before, after: applied.text, undo: undoOf(before, applied.text, placeEdits(before, option.edits)) };
}

/** A comment's place in the document, as the editor keeps it. */
export interface Place {
  from: number;
  to: number;
}

/**
 * Where comments in the passage a choice changed are after it, or after its
 * Undo or Redo (roadmap Batch 6): on their words as they are now, the words
 * that took their place where it rewrote them, as after an agent's edit (see
 * carry), never on a letter the two versions happen to share, as the
 * editor's own letter-by-letter steps can leave them. `was` and `now` are the
 * document before and after (see textIndex), `places` each comment's place in
 * `was`, `placed` where the editor has put them. Only those it has somewhere
 * else are given; not those whose words were taken out, or rewritten along
 * with other paragraphs: the editor follows those as it does any edit.
 */
export function placesAfterChoice(was: TextIndex, now: TextIndex, places: ReadonlyMap<string, Place>, placed: ReadonlyMap<string, Place>): Map<string, Place> {
  const out = new Map<string, Place>();
  const before = was.text;
  const after = now.text;
  if (before === after) return out;
  const { head, tail } = sharedEnds(before, after);
  let map: OffsetMap | null = null;
  for (const [id, p] of places) {
    const start = offsetAt(was, p.from);
    const end = offsetAt(was, p.to);
    if (end <= start || end <= head || start >= before.length - tail) continue;
    map ??= new OffsetMap(before, after);
    const c = carry(before, after, start, end, map, anchorIn(before, start, end));
    if (c.kind !== "words" || c.end <= c.start) continue;
    const place = { from: posAt(now, c.start, "start"), to: posAt(now, c.end, "end") };
    const there = placed.get(id);
    if (there?.from !== place.from || there.to !== place.to) out.set(id, place);
  }
  return out;
}

/** A document's text as it was just before or just after a choice, with where the comments were in it then. */
export interface KeptPlaces<D> {
  doc: D;
  ranges: ReadonlyMap<string, Place>;
}

/**
 * Where comments go after an Undo or Redo. Only a step back to, or forward
 * to, a choice's text moves them: back where they were then (`kept`, the last
 * few choices', newest last; `same` says whether two documents are the same
 * text). Any other step leaves them where the editor put them, which follows
 * the person's own typing letter by letter and has it right (review of
 * Batch 6, B6-R01: re-placing them by whole words, as after an agent's edit,
 * took a comment off a word typed beside it). Only comments that were there
 * before the step (`before`) and that the editor has somewhere else now
 * (`placed`) are given.
 */
export function placesThroughHistory<D>(
  kept: readonly KeptPlaces<D>[],
  doc: D,
  same: (a: D, b: D) => boolean,
  before: ReadonlyMap<string, Place>,
  placed: ReadonlyMap<string, Place>,
): Map<string, Place> {
  const out = new Map<string, Place>();
  const back = [...kept].reverse().find((p) => same(p.doc, doc));
  if (!back) return out;
  for (const [id, r] of back.ranges) {
    const there = placed.get(id);
    if (before.has(id) && (there?.from !== r.from || there?.to !== r.to)) out.set(id, r);
  }
  return out;
}

/**
 * The options a stored message offers, cut down to what's safe to show: an
 * agent's reply only, at most three, labels cleaned, edits capped. An older
 * record has none, and reads as a plain reply.
 */
export function optionsOf(message: Message): ReplyOption[] {
  const raw = (message as { options?: unknown }).options;
  if (message.author.kind !== "agent" || !Array.isArray(raw)) return [];
  const out: ReplyOption[] = [];
  let size = 0;
  for (const o of raw.slice(0, MAX_OPTIONS)) {
    if (!o || typeof o !== "object") continue;
    const label = cleanLabel(typeof o.label === "string" ? o.label : "");
    const edits = Array.isArray(o.edits) ? o.edits.filter(isEdit).slice(0, MAX_EDITS).map((e: OptionEdit) => ({ find: e.find, replace: e.replace })) : [];
    if (!label || !edits.length) continue;
    // All the options' words together, as checkOptions counts them: the rest is cut (B3-R12).
    size += label.length + edits.reduce((sum: number, e: OptionEdit) => sum + e.find.length + e.replace.length, 0);
    if (size > MAX_OPTIONS_SIZE) break;
    out.push({ label, edits });
  }
  return out;
}

/**
 * The choices kept on a stored message, cut down to what's safe to use: for
 * options it offers, one each, well formed. An older record kept its choice
 * another way, with no undo: it reads as no choice, so every option is offered.
 */
export function choicesOf(message: Message): Choice[] {
  const raw = (message as { choices?: unknown }).choices;
  if (!Array.isArray(raw)) return [];
  const offered = optionsOf(message).length;
  const out: Choice[] = [];
  for (const c of raw.slice(0, MAX_OPTIONS)) {
    if (!c || typeof c !== "object") continue;
    const { option, at } = c as { option?: unknown; at?: unknown };
    if (!Number.isInteger(option) || (option as number) < 0 || (option as number) >= offered || typeof at !== "string") continue;
    if (out.some((x) => x.option === option)) continue;
    out.push({ option: option as number, at, undo: cleanUndo((c as Choice).undo), spans: cleanSpans((c as Choice).spans) });
  }
  return out;
}

/** The most characters a choice's undo keeps: the options' words both ways, and a little around each place. */
const MAX_UNDO_SIZE = 2 * MAX_OPTIONS_SIZE + 2 * MAX_EDITS * 2 * AROUND[AROUND.length - 1];

/** A choice's undo, as the window reports it: edits, at most one a place an option can change, within the size an undo can have; else none. */
export function cleanUndo(raw: unknown): OptionEdit[] {
  if (!Array.isArray(raw) || raw.length > MAX_EDITS || !raw.every(isEdit)) return [];
  const edits = raw.map((e) => ({ find: e.find, replace: e.replace }));
  const size = edits.reduce((n, e) => n + e.find.length + e.replace.length, 0);
  return size <= MAX_UNDO_SIZE && edits.every((e) => e.find) ? edits : [];
}

/** The most spans one choice lights up. */
const MAX_SPANS = 50;

/**
 * The text an applied option changed, as the window reports it: well-formed
 * spans only, at most 50, none longer than the options themselves can be.
 */
export function cleanSpans(raw: unknown): ChangeSpan[] {
  if (!Array.isArray(raw)) return [];
  const text = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_OPTIONS_SIZE;
  const out: ChangeSpan[] = [];
  for (const s of raw.slice(0, MAX_SPANS)) {
    const a = s?.anchor;
    if (!a || !text(s.removed) || !text(a.quote) || !text(a.prefix) || !text(a.suffix) || !Number.isInteger(a.offset) || a.offset < 0) continue;
    out.push({ anchor: { quote: a.quote, prefix: a.prefix, suffix: a.suffix, offset: a.offset }, removed: s.removed });
  }
  return out;
}
