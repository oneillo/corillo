// A long session of work on one document, played through the real history
// and comment stores in a throwaway data folder: 200 passes, an agent's and
// the person's in turn, about 200 comments. The storage tests measure what it
// leaves on disk; the History tests and the benchmark open Corillo on it.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VersionHistory } from "../../src/main/version-store";
import { CommentService } from "../../src/main/comment-service";
import { anchorIn } from "../../src/core/anchors";
import type { ChangeSpan } from "../../src/core/change-links";
import type { Author } from "../../src/core/comments";
import type { Version } from "../../src/core/versions";

const me: Author = { kind: "person" };
const claude: Author = { kind: "agent", name: "Claude" };

/** A repeatable stream of numbers, so every run writes the same session. */
export function numbers(seed: number) {
  let x = seed;
  return (below: number) => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return Math.floor((x / 2147483648) * below);
  };
}

// Made-up words from syllables: a vocabulary of thousands, so the text
// compresses about as well as real prose does (a short word list would flatter it).
const SYLLABLES = "ba ce di fo gu ka le mi no pu ra se ti vo wu xa ye zi tha sho chu pre str ent ion ate ble ing".split(" ");
export function wordsFrom(rand: (n: number) => number, count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let w = "";
    for (let s = 1 + rand(3); s > 0; s--) w += SYLLABLES[rand(SYLLABLES.length)];
    out.push(w);
  }
  return out.join(" ");
}
export const sentenceFrom = (rand: (n: number) => number) => {
  const s = wordsFrom(rand, 14 + rand(12));
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
};

export interface SessionOptions {
  /** How many sentences the session works on (260 is over 5,000 words). */
  sentences?: number;
  passes?: number;
  /** A document the session's paragraphs follow (the long test document, say), untouched by it. */
  after?: string;
  /** The data folder and the document's file; throwaway ones by default. */
  data?: string;
  file?: string;
}

/**
 * A long session on a document of `sentences` sentences: `passes` passes, an
 * agent's and the person's in turn. Before each agent pass the person has
 * left comments: new ones, a follow-up, and on every fifth round a
 * whole-document comment carrying on a long back-and-forth. The agent
 * rewrites a sentence for each comment, replies to each, and on every fourth
 * round also does something asked in its chat (on every second, a change no
 * comment asked for). Between passes the person resolves most comments,
 * follows up on one, and edits a sentence of his own, with several autosaves
 * while typing, after which the comments' places move. The file is left
 * holding the newest text.
 */
export function longSession({ sentences: count = 260, passes = 200, after, data: dataDir, file: filePath }: SessionOptions = {}) {
  const rand = numbers(7);
  const data = dataDir ?? mkdtempSync(join(tmpdir(), "corillo-storage-"));
  const file = filePath ?? join(mkdtempSync(join(tmpdir(), "corillo-docs-")), "plan.md");
  let time = new Date("2026-11-09T09:00:00Z").getTime();
  const clock = () => new Date((time += 60_000));
  const h = new VersionHistory(data, clock);
  const comments = new CommentService(h, () => {});

  // The document's own words come from a stream of their own, so a longer document gets the same session.
  const draft = numbers(11);
  const sentences = Array.from({ length: count }, () => sentenceFrom(draft));
  const text = () => {
    const paragraphs: string[] = [];
    for (let i = 0; i < sentences.length; i += 5) paragraphs.push(sentences.slice(i, i + 5).join(" "));
    return after === undefined ? `# Help desk proposal\n\n${paragraphs.join("\n\n")}\n` : `${after.replace(/\n*$/, "")}\n\n${paragraphs.join("\n\n")}\n`;
  };
  const start = text();
  writeFileSync(file, start);
  const id = h.idFor(file);
  h.seen(id, start);

  /** The sentence each comment is on. */
  const onSentence = new Map<string, number>();
  const anchorFor = (doc: string, i: number) => {
    const at = doc.indexOf(sentences[i]);
    return anchorIn(doc, at, at + sentences[i].length);
  };
  const comment = () => {
    const i = rand(count);
    const t = comments.add(id, me, wordsFrom(rand, 20 + rand(30)), anchorFor(text(), i), null);
    onSentence.set(t.id, i);
    return t.id;
  };
  /** The person types a few words at the end of a sentence, and Corillo saves. */
  const autosave = (i: number) => {
    sentences[i] = `${sentences[i].slice(0, -1)} ${wordsFrom(rand, 3)}.`;
    h.edited(id, text());
  };
  /** The window tells Corillo where every comment is now, as it does once typing pauses. */
  const commentsFollow = () => {
    const doc = text();
    const moved: Record<string, ReturnType<typeof anchorIn>> = {};
    for (const t of comments.threads(id)) {
      const s = onSentence.get(t.id);
      if (s !== undefined) moved[t.id] = anchorFor(doc, s);
    }
    comments.setAnchors(id, moved);
  };

  const whole = comments.add(id, me, wordsFrom(rand, 40), null, null).id;
  let waiting = [comment(), comment(), comment()];
  /** What each agent pass recorded, to check it all comes back exactly. */
  const recorded = new Map<number, Pick<Version, "addressed" | "other" | "request">>();
  const texts: string[] = [start];
  let round = 0;

  for (let pass = 0; pass < passes; pass++) {
    if (pass % 2 === 0) {
      round++;
      const addressing = [...waiting, ...(round % 5 === 0 ? [whole] : [])];
      h.beginPass(id, "Claude");
      const began = new Map(comments.threads(id).map((t) => [t.id, t.anchor]));
      for (const tid of addressing) {
        const s = onSentence.get(tid);
        if (s !== undefined) {
          const before = sentences[s];
          sentences[s] = sentenceFrom(rand);
          const doc = text();
          h.edited(id, doc); // each edit is saved as it's made
          const change = { round, agent: "Claude", at: clock().toISOString(), spans: [{ anchor: anchorFor(doc, s), removed: before }] };
          comments.updateChanges(id, (threads) => threads.map((t) => (t.id === tid ? { ...t, change } : t)));
        }
        comments.reply(id, tid, claude, wordsFrom(rand, 30 + rand(50)));
      }
      let other: ChangeSpan[] = [];
      let request: string | undefined;
      if (round % 2 === 0) {
        const s = rand(count);
        const before = sentences[s];
        sentences[s] = sentenceFrom(rand);
        const doc = text();
        h.edited(id, doc);
        other = [{ anchor: anchorFor(doc, s), removed: before }];
        if (round % 4 === 0) request = wordsFrom(rand, 30 + rand(30));
      }
      // Each comment as it is now, on the words it was on as the pass began (as the agents' side gives it).
      const addressed = comments
        .threads(id)
        .filter((t) => addressing.includes(t.id))
        .map((t) => ({ ...t, anchor: began.get(t.id) ?? t.anchor }));
      const feedback = { addressed, ...(other.length ? { other } : {}), ...(request ? { request } : {}) };
      const v = h.endPass(id, feedback);
      recorded.set(v!.n, structuredClone(feedback));
    } else {
      const [followUp, ...done] = waiting;
      for (const tid of done) comments.resolve(id, tid, me, true);
      comments.reply(id, followUp, me, wordsFrom(rand, 15 + rand(20)));
      if (round % 5 === 0) comments.reply(id, whole, me, wordsFrom(rand, 20 + rand(20)));
      // A follow-up is answered once more, then resolved.
      const again = comments.threads(id).find((t) => t.id === followUp)!.messages.length === 3;
      if (!again) comments.resolve(id, followUp, me, true);
      waiting = again ? [followUp, comment(), comment()] : [comment(), comment()];
      const i = rand(count);
      for (let k = 0; k < 5; k++) autosave(i);
      commentsFollow();
    }
    texts.push(text());
  }
  writeFileSync(file, text());
  return { h, comments, id, data, file, start, texts, text, recorded, autosave, commentsFollow, docDir: join(data, "documents", id) };
}
