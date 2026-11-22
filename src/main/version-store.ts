// Each document's version history, kept in Corillo's data folder beside its
// comments, never in the document. One editing pass is one version:
//
// - The first time Corillo sees a document, its text is the first version.
// - The person's edits since someone else's last version are one version. It
//   stays open, updated as Corillo saves, until an agent takes the document or
//   a change from outside arrives. Closing the document doesn't end it.
// - An agent's pass (beginPass to endPass) is one version by that agent, with
//   the comment threads it addressed attached as they were when it finished.
// - A change made outside Corillo is a version of its own.
// - Restoring an old version adds a new version; nothing is lost.
//
// How it's stored, so many passes stay small: the newest version's text is
// kept in full once, in latest.json.gz, with the list of versions (who and
// when). Every older version is kept only as the edits that turn the version
// after it back into it. The newest of those edits is in latest.json.gz too,
// because it changes while a pass is open; once a later version exists it
// never changes again and is appended to older.jsonl, one per line. When that
// file grows past a few pages it is compressed into a segment
// (older-<n>.jsonl.gz) that is never written again, and a new older.jsonl
// starts. Each record carries a fingerprint of the text it gives back, so a
// damaged or missing record is noticed: the versions before it can't be shown
// any more, but newer ones and the current text are never affected.
//
// latest.json.gz is written again on every save, so it holds nothing else.
// What an agent's pass leaves (the comments it answered, as they were, its
// chat request, the changes no comment asked for and its note) is appended once, when
// the pass ends, to feedback.jsonl, compressed into feedback-<n>.jsonl.gz
// segments the same way. A comment answered over several passes keeps each
// message once: a later record keeps only what's new in the thread (see
// KeptThread). Histories from before 2026-11-09 have the feedback inside
// latest.json.gz; it's read from there, and moved out the first time the
// history is written.
//
// What History's rows say each version changed (the sections it touched,
// and for a version that isn't an agent's, its change line; roadmap Batch 4,
// item 2) isn't stored: it's worked out the first time History shows the row
// (see stories), from the version's text and the one before it, and kept in
// memory, for a bounded number of rows. Nothing is added on disk, and
// histories of any age get it.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { DocumentStore, writeAtomic, type StoreOptions } from "./store";
import { applyDelta, makeDelta, type Delta } from "../core/diff";
import { summarizeChanges } from "../core/change-summary";
import { readText, whatChanged, type ReadText, type VersionStory } from "../core/change-sections";
import { handOverIndex, type Brief, type Conversation, type HistoryKnown, type HistoryList, type RestoreResult, type RowStory, type SinceHandOver, type StoryAsk, type Version, type VersionRow, type VersionTexts } from "../core/versions";
import type { Message, Thread } from "../core/comments";
import type { ChangeSpan } from "../core/change-links";

/** The edits that turn the next version's text into version n's. */
interface Back {
  n: number;
  /** Fingerprint of version n's text, to check the edits gave it back exactly. */
  to: string;
  ops: Delta;
}

interface Latest {
  versions: Version[];
  /** The newest version's text. */
  text: string;
  back?: Back;
}

/** What an agent's pass left with its version, kept in feedback.jsonl rather than latest.json.gz. */
type Feedback = Pick<Version, "n" | "addressed" | "other" | "request" | "note">;
const FEEDBACK = ["addressed", "other", "request", "note"] as const;

/**
 * A thread as feedback.jsonl keeps it. A comment answered over several passes
 * is in several records; each keeps only the messages that are new or changed
 * since the thread's record before, and says how many at its start are the
 * same as in that version's record. So each message is kept once, however
 * many passes the conversation runs over. The words it's on are left out too
 * when they're the same as in that record (`anchor: true`, and the thread's
 * own anchor is null): a comment on a long passage doesn't keep the passage
 * once per pass.
 */
type KeptThread = Thread & { earlier?: { n: number; messages: number; anchor?: true } };

const sameMessage = (a: Message, b: Message) => JSON.stringify(a) === JSON.stringify(b);

/** The two files records are appended to: the edits that give back older versions, and agents' feedback. */
type Log = "older" | "feedback";

/** A log is compressed into a segment once it's bigger than this. */
const SEGMENT_BYTES = 16 * 1024;
const SEGMENT = /^(older|feedback)-(\d+)\.jsonl\.gz$/;

/** How many documents' newest version's story is kept in memory (one each). */
const NEWEST_KEPT = 4;
/** How many other rows' stories are kept in memory, across documents (a few hundred bytes each). */
const STORIES_KEPT = 2000;
/** The most rows worked out in one go: the window asks for the rows in sight, a screenful or two. */
export const STORIES_AT_ONCE = 24;

const fingerprint = (text: string) => createHash("sha256").update(text).digest("base64url").slice(0, 16);

function isBack(x: unknown): x is Back {
  const b = x as Back;
  return !!b && Number.isInteger(b.n) && typeof b.to === "string" && Array.isArray(b.ops);
}

function isFeedback(x: unknown): x is Feedback {
  const f = x as Feedback;
  return !!f && Number.isInteger(f.n) && (f.addressed === undefined || Array.isArray(f.addressed));
}

export class VersionHistory extends DocumentStore {
  /**
   * Agents mid-pass, by document, and the versions their pass has made so
   * far; when it took the document, and whether from the person (see
   * Version.handedOver).
   */
  private passes = new Map<string, { agent: string; versions: number[]; taken: string; handedOver: boolean }>();
  /** A restore the window asked for, waiting for its save. */
  private restores = new Map<string, { n: number; text: string }>();
  /**
   * By document, for its newest version (see newestStory): the text before
   * it, read, and what it changed as of its text now. Kept for a few
   * documents only, and for one version each.
   */
  private newest = new Map<string, { key: string; prev: ReadText | null; now?: { text: string; read: ReadText; story: RowStory } }>();
  /** What older versions changed, once worked out (see stories), by document, history and version; the longest unused goes first. */
  private kept = new Map<string, RowStory>();
  /** Called after a document's history changes. */
  onChange: (docId: string) => void = () => {};

  constructor(
    private dataDir: string,
    clock: () => Date = () => new Date(),
    options: StoreOptions = {},
  ) {
    super(dataDir, clock, options);
  }

  // Storage --------------------------------------------------------------------

  private dir(id: string): string {
    return path.join(this.dataDir, "documents", id, "versions");
  }

  /**
   * The newest version and the list, or null if there's no history yet or
   * it's damaged. `strict` (before starting a history again over it): a
   * file that's there but can't be read right now throws instead, so a
   * history is never set aside over a moment's read error.
   */
  private read(id: string, strict = false): Latest | null {
    let raw: Buffer;
    try {
      raw = fs.readFileSync(path.join(this.dir(id), "latest.json.gz"));
    } catch (err) {
      if (strict && (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return null;
    }
    try {
      const data = JSON.parse(gunzipSync(raw).toString("utf8")) as Latest;
      if (!Array.isArray(data.versions) || !data.versions.length || typeof data.text !== "string") return null;
      if (data.back !== undefined && !isBack(data.back)) delete data.back;
      return data;
    } catch {
      return null;
    }
  }

  /**
   * Write latest.json.gz. An agent's feedback never goes in it, since it's
   * rewritten on every save: feedback a version carries is appended to
   * feedback.jsonl instead, before latest.json.gz is replaced. That includes
   * feedback a history written before 2026-11-09 kept inline, so an older
   * history moves over the first time it's written.
   */
  private write(id: string, latest: Latest): void {
    const feedback: Feedback[] = [];
    const versions = latest.versions.map((v) => {
      if (!FEEDBACK.some((k) => k in v)) return v;
      const { addressed, other, request, note, ...rest } = v;
      const f: Feedback = { n: v.n };
      if ("addressed" in v) f.addressed = addressed;
      if ("other" in v) f.other = other;
      if ("request" in v) f.request = request;
      if ("note" in v) f.note = note;
      feedback.push(f);
      return rest;
    });
    if (feedback.length) this.appendLog(id, "feedback", this.share(id, feedback));
    // zlib's quickest level, as comments.json.gz: rewritten on every save, about five times quicker for a file about 15% larger (Batch 18, A16-4).
    writeAtomic(path.join(this.dir(id), "latest.json.gz"), gzipSync(JSON.stringify({ ...latest, versions }), { level: 1 }), true, { makeFolder: true });
  }

  /** Feedback as it's kept: each thread without the messages its record before already has (see KeptThread). */
  private share(id: string, feedback: Feedback[]): Feedback[] {
    if (!feedback.some((f) => f.addressed?.length)) return feedback;
    // Each thread's messages and words in the newest record that has it.
    const kept = new Map<string, { n: number; messages: Message[]; anchor: Thread["anchor"] }>();
    for (const [n, f] of this.readFeedback(id)) for (const t of f.addressed ?? []) kept.set(t.id, { n, messages: t.messages, anchor: t.anchor });
    return feedback.map((f) => {
      if (!f.addressed) return f;
      const addressed = f.addressed.map((t): KeptThread => {
        const before = kept.get(t.id);
        kept.set(t.id, { n: f.n, messages: t.messages, anchor: t.anchor });
        if (!before) return t;
        let same = 0;
        while (same < before.messages.length && same < t.messages.length && sameMessage(before.messages[same], t.messages[same])) same++;
        const sameWords = !!t.anchor && JSON.stringify(t.anchor) === JSON.stringify(before.anchor);
        if (!same && !sameWords) return t;
        return {
          ...t,
          ...(sameWords ? { anchor: null } : {}),
          earlier: { n: before.n, messages: same, ...(sameWords ? { anchor: true as const } : {}) },
          messages: t.messages.slice(same),
        };
      });
      return { ...f, addressed };
    });
  }

  /** Records never change once written; each starts on a new line, so a half-written one spoils only itself. */
  private appendLog(id: string, log: Log, records: unknown[]): void {
    fs.mkdirSync(this.dir(id), { recursive: true });
    const file = path.join(this.dir(id), `${log}.jsonl`);
    const fd = fs.openSync(file, "a");
    let size = 0;
    try {
      fs.writeSync(fd, records.map((r) => `\n${JSON.stringify(r)}`).join(""));
      fs.fsyncSync(fd);
      size = fs.fstatSync(fd).size;
    } finally {
      fs.closeSync(fd);
    }
    if (size > SEGMENT_BYTES) {
      // Compressed, the records take about a third of the room. The segment is
      // written in full before the log is emptied, so a crash between the two
      // leaves the records twice, never not at all.
      const raw = fs.readFileSync(file);
      const first = /"n":(\d+)/.exec(raw.toString("utf8"));
      writeAtomic(path.join(this.dir(id), `${log}-${first ? first[1] : Date.now()}.jsonl.gz`), gzipSync(raw), true, { makeFolder: true });
      writeAtomic(file, Buffer.alloc(0), true, { makeFolder: true });
    }
  }

  /**
   * Every record in a log that can be read, oldest segment first. A damaged
   * segment or line is skipped. With `from`, only the segments that can hold
   * records of that version and later: each is named by its first record's version.
   */
  private readLog(id: string, log: Log, from?: number): unknown[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir(id));
    } catch {
      return [];
    }
    const segments = names
      .map((name) => ({ name, m: SEGMENT.exec(name) }))
      .filter(({ m }) => m?.[1] === log)
      .sort((a, b) => Number(a.m![2]) - Number(b.m![2]));
    // The newest segment starting at or before `from` holds it; those before it are older still (B3-R08).
    let first = 0;
    if (from !== undefined) for (const [i, { m }] of segments.entries()) if (Number(m![2]) <= from) first = i;
    const read = segments.slice(first).map(({ name }) => name);
    if (names.includes(`${log}.jsonl`)) read.push(`${log}.jsonl`);
    const texts: string[] = [];
    for (const name of read) {
      try {
        const raw = fs.readFileSync(path.join(this.dir(id), name));
        texts.push(name.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8"));
      } catch {
        // a damaged segment: only what it holds is lost
      }
    }
    const records: unknown[] = [];
    for (const line of texts.join("\n").split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // a damaged line: only that record is lost
      }
    }
    return records;
  }

  /** The edit records, by version (with `from`, of that version and later). A damaged one means the versions before it can't be rebuilt; newer ones can. */
  private readOlder(id: string, from?: number): Map<number, Back[]> {
    const records = new Map<number, Back[]>();
    for (const rec of this.readLog(id, "older", from)) if (isBack(rec)) records.set(rec.n, [...(records.get(rec.n) ?? []), rec]);
    return records;
  }

  /**
   * Each agent's pass's feedback, by version, every thread with all its
   * messages again. A damaged record loses that version's feedback, and the
   * earlier messages of its threads in the records after it.
   */
  private readFeedback(id: string): Map<number, Feedback> {
    const records = new Map<number, Feedback>();
    // Oldest version first, so the records a thread shares messages with are read before it.
    for (const rec of this.readLog(id, "feedback").filter(isFeedback).sort((a, b) => a.n - b.n)) {
      try {
        if (rec.addressed) {
          rec.addressed = (rec.addressed as KeptThread[]).map(({ earlier, ...t }) => {
            if (!earlier) return t;
            const from = records.get(earlier.n)?.addressed?.find((x) => x.id === t.id);
            const messages = [...(from?.messages ?? []).slice(0, earlier.messages), ...t.messages];
            // The words, if left out as the same as before (lost with that record if it's damaged).
            return earlier.anchor ? { ...t, anchor: from?.anchor ?? null, messages } : { ...t, messages };
          });
        }
        records.set(rec.n, rec);
      } catch {
        // a record that isn't what it should be: only its version's feedback is lost
      }
    }
    return records;
  }

  /** A history that can't be read is set aside (not deleted), and a new one starts. */
  private setAside(id: string): void {
    const stamp = this.clock().toISOString().replace(/[:.]/g, "-");
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir(id));
    } catch {
      return;
    }
    let setAside = 0;
    for (const name of names) {
      if (name === "latest.json.gz" || name === "older.jsonl" || name === "feedback.jsonl" || SEGMENT.test(name)) {
        fs.renameSync(path.join(this.dir(id), name), path.join(this.dir(id), `set-aside-${stamp}-${name}`));
        setAside++;
      }
    }
    if (setAside) this.onSetAside(id, "history");
  }

  private now(): string {
    return this.clock().toISOString();
  }

  /** Add a version after the newest, which closes. */
  private append(id: string, latest: Latest, fields: Omit<Version, "n" | "created" | "saved">, text: string): Version {
    const last = latest.versions[latest.versions.length - 1];
    delete last.open;
    if (latest.back) this.appendLog(id, "older", [latest.back]);
    this.retireNewest(id, latest);
    const t = this.now();
    const v: Version = { n: last.n + 1, ...fields, created: t, saved: t };
    this.write(id, {
      versions: [...latest.versions, v],
      text,
      back: { n: last.n, to: fingerprint(latest.text), ops: makeDelta(text, latest.text) },
    });
    this.onChange(id);
    return v;
  }

  // What each version changed, for History's rows -------------------------------------

  /** What a version's story is kept under: the document, its history (its first version's time, as a history set aside starts again) and the version (or versions, "from-to"). */
  private storyKey(id: string, latest: Latest, n: number | string): string {
    return `${id}|${latest.versions[0].created}|${n}`;
  }

  /**
   * What the newest version changed (see RowStory), worked out from its text
   * and the one before it, and kept while its text stays the same: a save
   * while History is open reads only the newest text again. Null for the
   * first version, or when the one before it can't be rebuilt.
   */
  private newestStory(id: string, latest: Latest): RowStory | null {
    const vs = latest.versions;
    const last = vs[vs.length - 1];
    if (vs.length < 2 || last.kind === "first") return null;
    const key = this.storyKey(id, latest, last.n);
    const kept = this.newest.get(id);
    if (kept?.key === key && kept.now?.text === latest.text) return kept.now.story;
    let prev = kept?.key === key ? kept.prev : null;
    if (!prev) {
      const before = this.previousText(id, latest);
      if (before === null) return null;
      prev = readText(before);
    }
    const read = readText(latest.text);
    const story = rowStory(last, whatChanged(prev, read));
    this.newest.delete(id); // the most recent last, so the longest unused goes first
    this.newest.set(id, { key, prev, now: { text: latest.text, read, story } });
    while (this.newest.size > NEWEST_KEPT) this.newest.delete(this.newest.keys().next().value!);
    return story;
  }

  /**
   * The newest version is about to stop being the newest. If what it changed
   * was worked out for its text as it ends, that's kept with the other rows'
   * (nothing is worked out here), and its text, already read, is the next
   * version's text before.
   */
  private retireNewest(id: string, latest: Latest): void {
    const entry = this.newest.get(id);
    this.newest.delete(id);
    const last = latest.versions[latest.versions.length - 1];
    if (!entry?.now || entry.key !== this.storyKey(id, latest, last.n) || entry.now.text !== latest.text) return;
    this.keep(entry.key, entry.now.story);
    this.newest.set(id, { key: this.storyKey(id, latest, last.n + 1), prev: entry.now.read });
  }

  /** The document's last tab closed: the texts kept for its newest version's story go (the rows' stories stay, bounded). */
  forget(id: string): void {
    this.newest.delete(id);
  }

  private keep(key: string, story: RowStory): void {
    this.kept.delete(key);
    this.kept.set(key, story);
    while (this.kept.size > STORIES_KEPT) this.kept.delete(this.kept.keys().next().value!);
  }

  /** A row's story worked out before, if it's still kept (it then counts as just used). */
  private keptStory(key: string): RowStory | undefined {
    const story = this.kept.get(key);
    if (story) {
      this.kept.delete(key);
      this.kept.set(key, story);
    }
    return story;
  }

  /**
   * What versions changed, for History's rows in sight (see RowStory): those
   * worked out before are given as kept; the rest from one walk back through
   * the history, as far as the oldest asked for, each text read once. At most
   * STORIES_AT_ONCE asked for at once; the first version, one that can't be
   * rebuilt (part of the history was damaged) and one no longer there are
   * left out.
   *
   * Each is asked for by its number, given back under it; or, for several of
   * the person's versions in a row shown as one, as from-to (the first and
   * last of them), given back under "from-to": what the last changed since the
   * version before the first. Those are kept too, unless the last is the
   * newest version, which can still change.
   *
   * Each text is read in a turn of the event loop of its own, so an agent's
   * call or a save that comes meanwhile isn't kept waiting: on a long
   * document, eight rows worked out in one go held the app for about 80 ms
   * (Batch 6).
   */
  async stories(id: string, asks: readonly StoryAsk[]): Promise<Record<string, RowStory>> {
    const out: Record<string, RowStory> = {};
    const latest = this.read(id);
    if (!latest) return out;
    const vs = latest.versions;
    const newestIndex = vs.length - 1;
    const indexOf = new Map(vs.map((v, i) => [v.n, i]));
    /** Each still to work out: under what it's given back, the two versions compared, and whether to keep it. */
    const need: { key: string; was: number; now: number; keep: boolean }[] = [];
    for (const ask of asks.slice(0, STORIES_AT_ONCE)) {
      if (typeof ask === "number") {
        const i = indexOf.get(ask) ?? -1;
        if (i < 1) continue;
        if (i === newestIndex) {
          const story = this.newestStory(id, latest);
          if (story) out[ask] = story;
          continue;
        }
        const kept = this.keptStory(this.storyKey(id, latest, ask));
        if (kept) out[ask] = kept;
        else need.push({ key: String(ask), was: i - 1, now: i, keep: true });
      } else {
        const from = indexOf.get(ask.from) ?? -1;
        const to = indexOf.get(ask.to) ?? -1;
        if (from < 1 || to <= from) continue;
        const key = `${ask.from}-${ask.to}`;
        const kept = to === newestIndex ? undefined : this.keptStory(this.storyKey(id, latest, key));
        if (kept) out[key] = kept;
        else need.push({ key, was: from - 1, now: to, keep: to !== newestIndex });
      }
    }
    if (!need.length) return out;
    const wanted = new Set(need.flatMap((x) => [x.was, x.now]));
    const texts = new Map<number, string>();
    this.walk(id, latest, Math.min(...need.map((x) => x.was)), null, (i, text) => {
      if (wanted.has(i)) texts.set(i, text);
    });
    const reads = new Map<number, ReadText>();
    const read = async (i: number) => {
      let r = reads.get(i);
      if (!r) {
        await nextTurn();
        reads.set(i, (r = readText(texts.get(i)!)));
      }
      return r;
    };
    for (const x of need) {
      if (!texts.has(x.was) || !texts.has(x.now)) continue; // damaged: that row goes without
      const story = rowStory(vs[x.now], whatChanged(await read(x.was), await read(x.now)));
      if (x.keep) this.keep(this.storyKey(id, latest, x.key), story);
      out[x.key] = story;
    }
    return out;
  }

  /** How many rows' stories are kept in memory, for the leak checks. */
  get storiesKept(): number {
    return this.kept.size + this.newest.size;
  }

  /** The newest version's predecessor, from the newest edits record; null if it can't be rebuilt. */
  private previousText(id: string, latest: Latest): string | null {
    const vs = latest.versions;
    if (vs.length < 2) return null;
    return this.rebuild(id, latest, vs.length - 2, null);
  }

  /**
   * Walk back from the newest text to the version at index `target`. `on`,
   * if given, is the index of another version whose text is kept in `seen` on
   * the way, so two versions take one walk.
   */
  private rebuild(
    id: string,
    latest: Latest,
    target: number,
    older: Map<number, Back[]> | null,
    on?: { index: number; seen?: string },
  ): string | null {
    return this.walk(id, latest, target, older, (index, text) => {
      if (on?.index === index) on.seen = text;
    });
  }

  /** The same walk back, telling `visit` each version's text on the way (the newest first). */
  private walk(id: string, latest: Latest, target: number, older: Map<number, Back[]> | null, visit: (index: number, text: string) => void): string | null {
    const vs = latest.versions;
    let text = latest.text;
    visit(vs.length - 1, text);
    const undo = (from: string, c: Back): string | null => {
      try {
        const t = applyDelta(from, c.ops);
        return fingerprint(t) === c.to ? t : null;
      } catch {
        return null; // damaged
      }
    };
    // Only the records back to the target are read, so the cost follows the versions walked, not the
    // whole history (B3-R08); every record is read if one isn't found among them.
    let whole = false;
    const fromOlder = (n: number, from: string): string | null => {
      for (;;) {
        older ??= this.readOlder(id, vs[target].n);
        // There may be more than one copy after a crash.
        for (const c of older.get(n) ?? []) {
          const t = undo(from, c);
          if (t !== null) return t;
        }
        if (whole) return null;
        whole = true;
        older = this.readOlder(id);
      }
    };
    for (let i = vs.length - 2; i >= target; i--) {
      const n = vs[i].n;
      let next = latest.back?.n === n ? undo(text, latest.back) : null;
      // Otherwise the record in older.jsonl or a segment of it.
      if (next === null) next = fromOlder(n, text);
      if (next === null) return null;
      text = next;
      visit(i, text);
    }
    return text;
  }

  // What the editor tells it ---------------------------------------------------------

  /**
   * Corillo opened the document: the first version, or a change made outside
   * since the last one. A copy of a Word document says which (`madeFrom`, the
   * Word file's name) on its first version.
   */
  seen(id: string, text: string, madeFrom?: string): boolean {
    const latest = this.read(id, true);
    if (!latest) {
      this.setAside(id);
      const t = this.now();
      this.write(id, { versions: [{ n: 1, kind: "first", created: t, saved: t, ...(madeFrom ? { madeFrom } : {}) }], text });
      this.onChange(id);
      return false;
    }
    if (latest.text !== text) this.outside(id, text);
    return latest.versions.some((v) => v.kind === "agent");
  }

  /** Corillo saved the document: the person's edits, or the edits of the agent holding it. */
  edited(id: string, text: string): void {
    const latest = this.read(id, true);
    if (!latest) {
      this.seen(id, text);
      return;
    }
    const restore = this.restores.get(id);
    this.restores.delete(id);
    if (latest.text === text) return;
    if (restore && restore.text === text) {
      const from = latest.versions.find((v) => v.n === restore.n);
      this.append(id, latest, { kind: "restored", restoredFrom: { n: restore.n, saved: from?.saved ?? "" } }, text);
      return;
    }
    const pass = this.passes.get(id);
    const last = latest.versions[latest.versions.length - 1];
    const ours =
      last.open === true && (pass ? last.kind === "agent" && last.agent === pass.agent : last.kind === "person");
    const before = ours && latest.back ? this.previousText(id, latest) : null;
    if (before !== null && latest.back) {
      if (before === text && !last.addressed?.length) {
        // Back to where the pass started: nothing to keep.
        latest.versions.pop();
        if (pass) pass.versions = pass.versions.filter((n) => n !== last.n);
        this.write(id, { versions: latest.versions, text: before });
        this.onChange(id);
        return;
      }
      last.saved = this.now();
      this.write(id, {
        versions: latest.versions,
        text,
        back: { n: latest.back.n, to: latest.back.to, ops: makeDelta(text, before) },
      });
      this.onChange(id);
      return;
    }
    const v = this.append(
      id,
      latest,
      // A pass split by another app's change carries on in a second version: only its first took the document.
      pass ? { kind: "agent", agent: pass.agent, open: true, taken: pass.taken, handedOver: pass.handedOver && !pass.versions.length } : { kind: "person", open: true },
      text,
    );
    pass?.versions.push(v.n);
  }

  /** The file changed outside Corillo and Corillo took the new text. */
  outside(id: string, text: string): void {
    this.restores.delete(id);
    const latest = this.read(id, true);
    if (!latest) {
      this.seen(id, text);
      return;
    }
    if (latest.text === text) return;
    this.append(id, latest, { kind: "outside" }, text);
  }

  // Agents' passes (step 5 calls these) -------------------------------------------------

  /** An agent takes the document. The person's open version ends here. */
  beginPass(id: string, agent: string): void {
    const current = this.passes.get(id);
    if (current) {
      if (current.agent === agent) return;
      throw new Error(`${current.agent} is editing this document.`);
    }
    const latest = this.read(id);
    this.passes.set(id, { agent, versions: [], taken: this.now(), handedOver: this.fromPerson(id, latest?.versions ?? []) });
    this.restores.delete(id);
    const last = latest?.versions[latest.versions.length - 1];
    if (latest && last?.open) {
      delete last.open;
      this.write(id, latest);
    }
    this.onChange(id);
  }

  /**
   * Whether an agent taking the document now takes it from the person: no
   * agent has had it yet, or since the last agent's pass ended the person
   * has edited it (a version of theirs, or a restore) or written, edited or
   * resolved a comment. If they only read in between, the two passes are one
   * round (roadmap Batch 3, item 1).
   */
  private fromPerson(id: string, versions: Version[]): boolean {
    let i = versions.length - 1;
    while (i >= 0 && versions[i].kind === "outside") i--;
    const last = versions[i];
    if (!last || last.kind !== "agent") return true;
    const since = Date.parse(last.ended ?? last.saved);
    const after = (iso: string | undefined) => !!iso && Date.parse(iso) > since;
    let threads: Thread[];
    try {
      threads = this.readComments(id);
    } catch {
      return false; // can't tell: the round goes on, so nothing is left out of Show changes
    }
    return threads.some((t) => after(t.resolved) || t.messages.some((m) => m.author.kind === "person" && (after(m.created) || after(m.edited))));
  }

  /**
   * The agent is done. Its pass is one version, with the threads it addressed
   * attached as they are now. A pass that only replied to comments still gets
   * a version, so the feedback stays in the history (and so does one that
   * only left a note). Returns the version, or null if the pass changed
   * nothing and left nothing.
   */
  endPass(id: string, options: { addressed?: Thread[]; other?: ChangeSpan[]; request?: string; note?: string } = {}): Version | null {
    const pass = this.passes.get(id);
    if (!pass) return null;
    this.passes.delete(id);
    const latest = this.read(id);
    if (!latest) return null;
    const addressed: Thread[] = structuredClone(options.addressed ?? []);
    const target = [...latest.versions].reverse().find((v) => pass.versions.includes(v.n));
    if (!target) {
      this.onChange(id);
      if (!addressed.length && !options.request && !options.note) return null;
      const request = options.request ? { request: options.request } : {};
      const note = options.note ? { note: options.note } : {};
      const when = { taken: pass.taken, ended: this.now(), handedOver: pass.handedOver };
      return this.append(id, latest, { kind: "agent", agent: pass.agent, addressed, ...request, ...note, ...when }, latest.text);
    }
    delete target.open;
    target.ended = this.now();
    if (addressed.length) target.addressed = addressed;
    if (options.other?.length) target.other = structuredClone(options.other);
    if (options.request) target.request = options.request;
    if (options.note) target.note = options.note;
    this.write(id, latest);
    this.onChange(id);
    return target;
  }

  /** The agent holding the document, or null. */
  holder(id: string): string | null {
    return this.passes.get(id)?.agent ?? null;
  }

  /**
   * The window wants to make version n current. It then saves that text the
   * usual way, and the save becomes a "Restored version" version.
   */
  prepareRestore(id: string, n: number): RestoreResult {
    const holder = this.holder(id);
    if (holder) return { ok: false, reason: `${holder} is editing this document. You can restore a version once it's done.` };
    const latest = this.read(id);
    const index = latest ? latest.versions.findIndex((v) => v.n === n) : -1;
    if (!latest || index < 0) return { ok: false, reason: "That version isn't in the history any more." };
    const text = this.rebuild(id, latest, index, null);
    if (text === null) return { ok: false, reason: "That version can't be restored: part of the history was damaged." };
    if (text === latest.text) return { ok: true, text, same: true };
    this.restores.set(id, { n, text });
    return { ok: true, text, same: false };
  }

  // Reading the history (the window, and agents) -------------------------------------------

  /** Every version, oldest first, each agent's pass with its feedback. */
  list(id: string): Version[] {
    return this.withFeedback(id, this.read(id)?.versions ?? []);
  }

  private withFeedback(id: string, versions: Version[]): Version[] {
    if (!versions.some((v) => v.kind === "agent")) return versions;
    const feedback = this.readFeedback(id);
    return versions.map((v) => {
      const f = feedback.get(v.n);
      if (!f) return v;
      const { n: _n, ...fields } = f;
      return { ...v, ...fields };
    });
  }

  /**
   * The History panel's list (see HistoryList): who and when for each
   * version, and each agent's pass in brief. Given what the window already
   * has, and the feedback hasn't changed since, only the versions from the
   * window's newest on, so a save reads no feedback and sends one row.
   */
  rows(id: string, known?: HistoryKnown): Omit<HistoryList, "holder"> {
    const latest = this.read(id);
    const versions = latest?.versions ?? [];
    const stamp = this.feedbackStamp(id, versions);
    const whole = !known || !stamp || known.stamp !== stamp;
    const from = whole ? 0 : Math.max(0, Math.min(known.count, versions.length) - 1);
    // What each row says it changed, where it's been worked out (the window asks for the rest as they come into sight), and the newest version's now.
    const story = (n: number, newest: boolean): RowStory | undefined => {
      if (!latest) return undefined;
      if (!newest) return this.kept.get(this.storyKey(id, latest, n));
      try {
        return this.newestStory(id, latest) ?? undefined;
      } catch (err) {
        console.error("Version history: couldn't work out what the newest version changed.", err);
        return undefined;
      }
    };
    const row = ({ n, kind, agent, restoredFrom, madeFrom, saved }: Version, i: number): VersionRow => ({
      n,
      kind,
      ...(agent !== undefined ? { agent } : {}),
      ...(restoredFrom ? { restoredFrom } : {}),
      ...(madeFrom ? { madeFrom } : {}),
      saved,
      ...story(n, from + i === versions.length - 1),
    });
    const list: Omit<HistoryList, "holder"> = { versions: versions.slice(from).map(row), from, stamp };
    if (whole) {
      const briefs: Record<number, Brief> = {};
      for (const v of this.withFeedback(id, versions)) {
        const b = briefOf(v);
        if (b) briefs[v.n] = b;
      }
      list.briefs = briefs;
    }
    return list;
  }

  /**
   * Says which feedback the history has: it changes when a pass's feedback
   * is added (or the history starts again), not when a save only changes the
   * text. Empty for a history from before 2026-11-09 with its feedback still
   * in latest.json.gz: then the list is always sent whole.
   */
  private feedbackStamp(id: string, versions: Version[]): string {
    if (!versions.length || versions.some((v) => FEEDBACK.some((k) => k in v))) return "";
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir(id)).filter((name) => name.startsWith("feedback")).sort();
    } catch {
      // no folder: no feedback
    }
    const parts = names.map((name) => {
      if (name !== "feedback.jsonl") return name; // a segment never changes once written
      try {
        const s = fs.statSync(path.join(this.dir(id), name));
        return `${name}:${s.size}:${s.mtimeMs}`;
      } catch {
        return name;
      }
    });
    return [versions[0].created, ...parts].join("|");
  }

  /** What an agent's pass left with version n, every message whole; null if it left nothing. */
  conversation(id: string, n: number): Conversation | null {
    const v = this.withFeedback(id, this.read(id)?.versions ?? []).find((x) => x.n === n);
    if (!v || !FEEDBACK.some((k) => k in v)) return null;
    const out: Conversation = {};
    for (const k of FEEDBACK) if (k in v) (out as Record<string, unknown>)[k] = v[k];
    return out;
  }

  /**
   * Every version's text, newest first, told to `visit` in one walk back
   * (for which web pictures History can still draw: waiting-pictures.ts).
   * False if there's no history to read, or a version can't be rebuilt.
   */
  everyText(id: string, visit: (text: string) => void): boolean {
    const latest = this.read(id);
    if (!latest || !latest.versions.length) return false;
    return this.walk(id, latest, 0, null, (_index, text) => visit(text)) !== null;
  }

  /** The text of version n, or null if it isn't there or can't be rebuilt. */
  text(id: string, n: number): string | null {
    const latest = this.read(id);
    const index = latest ? latest.versions.findIndex((v) => v.n === n) : -1;
    if (!latest || index < 0) return null;
    return this.rebuild(id, latest, index, null);
  }

  /**
   * Version n's text and the one before it's, for showing it with its
   * changes: one walk back through the history, its records read once. With
   * `base`, an earlier version to compare it with instead (several of the
   * person's versions in a row, shown together in History).
   */
  versionTexts(id: string, n: number, base?: number): VersionTexts {
    const latest = this.read(id);
    const index = latest ? latest.versions.findIndex((v) => v.n === n) : -1;
    if (!latest || index < 0) return { text: null, before: null, hasBefore: false };
    const asked = base === undefined ? -1 : latest.versions.findIndex((v) => v.n === base);
    const from = asked >= 0 && asked < index ? asked : index - 1;
    if (from < 0) return { text: this.rebuild(id, latest, 0, null), before: null, hasBefore: false };
    const on: { index: number; seen?: string } = { index };
    const before = this.rebuild(id, latest, from, null, on);
    return { text: on.seen ?? null, before, hasBefore: true };
  }

  /**
   * What Show changes shows (see SinceHandOver): the text the person last
   * handed over, then what happened since in runs (everyone else's versions,
   * the person's own), each with the text it left. One walk back through the
   * history, only as far as the hand-over.
   */
  sinceHandOver(id: string): SinceHandOver {
    const latest = this.read(id);
    const vs = latest?.versions ?? [];
    const newest = vs[vs.length - 1];
    const none: SinceHandOver = { n: newest?.n ?? 0, saved: newest?.saved ?? "", text: latest?.text ?? "", at: null, base: null, steps: [], agents: [], outside: false };
    if (!latest || !newest) return none;
    // A pass that took the document from the person and hasn't changed it yet: nothing has changed since.
    const pass = this.passes.get(id);
    if (pass?.handedOver && !pass.versions.length) return { ...none, at: pass.taken, base: latest.text };
    const h = handOverIndex(vs);
    if (h < 1) return none;
    const at = vs[h].taken ?? vs[h].created;
    const yours = (v: Version) => v.kind === "person" || v.kind === "restored" || v.kind === "first";
    const ends = (i: number) => i === vs.length - 1 || yours(vs[i]) !== yours(vs[i + 1]);
    const texts = new Map<number, string>();
    const changed = new Set<number>();
    let after: string | null = null;
    const base = this.walk(id, latest, h - 1, null, (i, text) => {
      if (i >= h && ends(i)) texts.set(i, text);
      if (after !== null && text !== after) changed.add(i + 1);
      after = text;
    });
    if (base === null) return { ...none, at };
    const steps: SinceHandOver["steps"] = [];
    const agents: string[] = [];
    let outside = false;
    for (let i = h; i < vs.length; i++) {
      const v = vs[i];
      if (ends(i)) steps.push({ yours: yours(v), text: texts.get(i)! });
      if (!changed.has(i)) continue;
      if (v.kind === "agent" && !agents.includes(v.agent || "Agent")) agents.push(v.agent || "Agent");
      if (v.kind === "outside") outside = true;
    }
    return { ...none, at, base, steps, agents, outside };
  }
}

/**
 * The start of a comment or reply in the History list: enough for its two
 * lines in the widest panel. The list clamps it to two lines and draws the
 * ellipsis; one cut here keeps its own.
 */
const BRIEF_CHARS = 500;
function startOf(text: string): string {
  if (text.length <= BRIEF_CHARS) return text;
  let cut = text.slice(0, BRIEF_CHARS);
  const space = cut.search(/\s\S*$/);
  if (space > BRIEF_CHARS / 2) cut = cut.slice(0, space);
  return `${cut.replace(/[\uD800-\uDBFF]$/, "")}…`;
}

/**
 * What a version's row says it changed (see RowStory): the sections it
 * touched, and the change line unless it's an agent's pass, whose brief
 * has a change line for each comment it answered.
 */
function rowStory(v: Version, story: VersionStory): RowStory {
  return {
    ...(story.sections.length ? { sections: story.sections } : {}),
    ...(story.moreSections ? { moreSections: story.moreSections } : {}),
    ...(v.kind !== "agent" && story.change.total ? { change: story.change } : {}),
  };
}

/** An agent's pass in brief, as the History list shows it (see Brief); undefined for a version that left no feedback. */
export function briefOf(v: Version): Brief | undefined {
  if (!(v.addressed?.length || v.request || v.other?.length || v.note)) return undefined;
  const change = (spans: ChangeSpan[] | undefined) => {
    const summary = summarizeChanges(spans ?? []);
    return summary.total ? { change: summary } : {};
  };
  const brief: Brief = {
    threads: (v.addressed ?? []).map((thread) => {
      const replies = thread.messages.slice(1).filter((m) => m.author.kind === "agent" && m.author.name === v.agent);
      const reply = replies[replies.length - 1];
      return {
        comment: startOf(thread.messages[0]?.body ?? ""),
        ...(reply ? { reply: startOf(reply.body) } : {}),
        ...change(thread.change?.spans),
      };
    }),
  };
  if (v.request || v.other?.length) brief.loose = { ...(v.request ? { request: startOf(v.request) } : {}), ...change(v.other) };
  if (v.note) brief.note = startOf(v.note);
  return brief;
}
