// The version history against a simple model of what it should hold, with
// fixed seeds: random person edits, undoing back to the start of a pass,
// changes from outside (also mid-pass), agents' passes with feedback over
// shared threads, restores and relaunches. Every version must come back
// exactly, no closed version may change, and all feedback must read back whole.
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VersionHistory } from "../../src/main/version-store";
import type { Thread } from "../../src/core/comments";

function random(seed: number) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
  return { rnd, pick };
}

const WORDS = ["alpha", "beta", "gamma", "delta", "the", "of", "plan", "budget", "Q3", "café", "😀", "team", "ship", "review"];

function round(seed: number, steps: number, base: string): string[] {
  const { rnd, pick } = random(seed);
  const sentence = () => Array.from({ length: 5 + Math.floor(rnd() * 12) }, () => pick(WORDS)).join(" ") + ".";
  const para = () => Array.from({ length: 1 + Math.floor(rnd() * 4) }, sentence).join(" ");
  const mutate = (s: string) => {
    const ps = s.split("\n\n");
    for (let i = 0, k = 1 + Math.floor(rnd() * 3); i < k; i++) {
      const r = rnd();
      const at = Math.floor(rnd() * ps.length);
      if (r < 0.4) ps[at] = para();
      else if (r < 0.7) ps.splice(at, 0, para());
      else if (ps.length > 2) ps.splice(at, 1);
      else ps[at] += " " + sentence();
    }
    return ps.join("\n\n");
  };
  const fails: string[] = [];
  const fail = (m: string) => fails.push(`seed ${seed}: ${m}`);
  let now = Date.parse("2026-11-09T10:00:00Z");
  const clock = () => new Date((now += 1000));
  const dataDir = join(base, `data-${seed}`);
  const file = join(base, `doc-${seed}.md`);
  let text = Array.from({ length: 30 }, para).join("\n\n");
  writeFileSync(file, text);
  let h = new VersionHistory(dataDir, clock);
  const id = h.idFor(file, text);
  h.seen(id, text);
  let snap = new Map<number, string>();
  const feedback = new Map<number, { addressed: Thread[]; request?: string }>();
  let pass: string | null = null;
  const threads: Thread[] = [];
  let made = 0;
  const message = (kind: "person" | "agent", body: string) => ({
    id: `m${made++}`,
    author: kind === "person" ? ({ kind } as const) : ({ kind, name: pass ?? "Claude" } as const),
    body,
    created: new Date(now).toISOString(),
  });
  let checks = 0;
  const check = (what: string) => {
    const vs = h.list(id);
    // Rebuilding every version each step costs more than the steps: every few steps,
    // and the newest at every one (a closed version that changed stays changed).
    if (checks++ % 6 !== 0) {
      if (h.text(id, vs[vs.length - 1].n) !== text) fail(`${what}: the newest version isn't the current text`);
      return;
    }
    const current = new Map<number, string>();
    for (const v of vs) {
      const t = h.text(id, v.n);
      if (t === null) fail(`${what}: version ${v.n} can't be rebuilt`);
      else current.set(v.n, t);
    }
    if (current.get(vs[vs.length - 1].n) !== text) fail(`${what}: the newest version isn't the current text`);
    const newest = [...snap.keys()].pop();
    for (const [n, t] of snap) {
      if (n === newest) continue;
      if (!current.has(n)) fail(`${what}: closed version ${n} went`);
      else if (current.get(n) !== t) fail(`${what}: closed version ${n} changed`);
    }
    for (const [n, expected] of feedback) {
      const v = vs.find((x) => x.n === n);
      if (!v) fail(`${what}: version ${n}, with feedback, went`);
      else {
        if (JSON.stringify(v.addressed ?? []) !== JSON.stringify(expected.addressed)) fail(`${what}: version ${n}'s feedback differs`);
        if ((v.request ?? "") !== (expected.request ?? "")) fail(`${what}: version ${n}'s request differs`);
      }
    }
    snap = current;
  };
  check("start");
  for (let step = 0; step < steps; step++) {
    const r = rnd();
    let what = "";
    if (pass) {
      if (r < 0.6) {
        text = mutate(text);
        h.edited(id, text);
        what = "agent edit";
      } else if (r < 0.65) {
        text = mutate(text);
        h.outside(id, text);
        what = "outside, mid-pass";
      } else {
        if (rnd() < 0.5 || !threads.length) {
          threads.push({ id: `t${seed}-${threads.length}`, anchor: { quote: sentence(), prefix: "", suffix: "", offset: 0 }, to: null, status: "open", messages: [message("person", para())] });
        }
        const addressed = threads.filter(() => rnd() < 0.6).map((t) => {
          t.messages = [...t.messages, message("agent", para())];
          return structuredClone(t);
        });
        const request = rnd() < 0.3 ? sentence() : undefined;
        const v = h.endPass(id, { addressed, request });
        if (v) feedback.set(v.n, { addressed, request });
        else if (addressed.length || request) fail("endPass kept nothing although it had feedback");
        pass = null;
        what = "end of pass";
        for (const t of threads) if (rnd() < 0.3) t.messages = [...t.messages, message("person", sentence())];
        if (threads.length && rnd() < 0.1) threads[0].messages[0] = { ...threads[0].messages[0], body: sentence(), edited: new Date(now).toISOString() };
      }
    } else if (r < 0.5) {
      text = mutate(text);
      h.edited(id, text);
      what = "person edit";
    } else if (r < 0.58) {
      const vs = h.list(id);
      const last = vs[vs.length - 1];
      if (last.open && last.kind === "person" && vs.length >= 2) {
        text = h.text(id, vs[vs.length - 2].n)!;
        h.edited(id, text);
        what = "person undoes back to the start";
      }
    } else if (r < 0.66) {
      text = mutate(text);
      h.outside(id, text);
      what = "outside";
    } else if (r < 0.72) {
      const v = pick(h.list(id));
      const res = h.prepareRestore(id, v.n);
      if (res.ok && !res.same) {
        text = res.text;
        h.edited(id, text);
        what = `restore ${v.n}`;
      }
    } else if (r < 0.8) {
      h = new VersionHistory(dataDir, clock);
      what = "relaunch";
    } else {
      pass = pick(["Claude", "Writer"]);
      h.beginPass(id, pass);
      what = "start of pass";
    }
    if (what) check(`${what} (step ${step})`);
  }
  return fails;
}

describe("the version history, against a model", () => {
  it("gives back every version and all feedback, whatever happens in between", () => {
    const base = mkdtempSync(join(tmpdir(), "corillo-versions-fuzz-"));
    try {
      const fails: string[] = [];
      for (let seed = 777; seed < 780; seed++) fails.push(...round(seed, 90, base));
      expect(fails.slice(0, 10)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
    // About two seconds; more room when the Mac is busy.
  }, 30_000);
});
