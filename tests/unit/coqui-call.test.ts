// The call of a coast coquí (roadmap Batch 6, item 5). Orlando heard Batch 2's
// call and found it "a bit off versus real coqui frogs"; of three calls made
// from measured values he chose the coast one: "Coast is the closest. No
// question." These tests state that recipe, measured from the samples Corillo
// plays, so a change to any number shows here.
//
// Pitch and timing are a coquí's at sea level (Meenderink, Quiñones and
// Narins, Biology Letters 13, 2017, table 1); the swell, the bend of the rise
// and the overtones were measured from two field recordings.
import { describe, expect, it } from "vitest";
import { callSamples, stopCall, playCall, type CallContexts } from "../../src/renderer/coqui";

const RATE = 48_000;
const samples = callSamples(RATE);

/** Where the wave crosses zero going up, in seconds, between two times (each found between its two samples). */
function upCrossings(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(1, Math.floor(from * RATE)); i < Math.min(samples.length, Math.ceil(to * RATE)); i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (a < 0 && b >= 0) out.push((i - 1 + a / (a - b)) / RATE);
  }
  return out;
}

/** Each whole cycle of the wave in a stretch: when it starts and ends. */
function cycles(from: number, to: number): [number, number][] {
  const at = upCrossings(from, to);
  return at.slice(1).map((end, i) => [at[i], end]);
}

/** The pitch of one cycle, in hertz. */
const pitchOf = ([a, b]: [number, number]) => 1 / (b - a);

/**
 * The average of some function of the wave over a cycle, which starts and
 * ends where the wave is at zero: the samples joined by straight lines.
 */
function overCycle([a, b]: [number, number], f: (wave: number, t: number) => number): number {
  const first = Math.ceil(a * RATE);
  const last = Math.floor(b * RATE);
  let sum = ((first / RATE - a) * f(samples[first], first / RATE)) / 2;
  for (let i = first; i < last; i++) sum += (f(samples[i], i / RATE) + f(samples[i + 1], (i + 1) / RATE)) / (2 * RATE);
  sum += ((b - last / RATE) * f(samples[last], last / RATE)) / 2;
  return sum / (b - a);
}

/** How loud a cycle is: its root mean square. */
const loudnessOf = (cycle: [number, number]) => Math.sqrt(overCycle(cycle, (s) => s * s));

/** A cycle's overtones, as shares of its first: the wave read against each multiple of its pitch. */
function overtonesOf(cycle: [number, number]): number[] {
  const [a, b] = cycle;
  const part = (n: number) => overCycle(cycle, (s, t) => s * Math.sin((2 * Math.PI * n * (t - a)) / (b - a)));
  const first = part(1);
  return [part(2) / first, part(3) / first];
}

/** Where a note's sound starts and ends: the stretches between silences. */
function notes(): [number, number][] {
  const found: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= samples.length; i++) {
    const sound = i < samples.length && samples[i] !== 0;
    if (sound && start < 0) start = i;
    if (!sound && start >= 0) {
      // A note's first sample is exactly at silence; it starts there.
      found.push([(start - 1) / RATE, i / RATE]);
      start = -1;
    }
  }
  return found;
}

/** The loudest cycle in a stretch. */
function loudest(from: number, to: number): [number, number] {
  const all = cycles(from, to);
  return all.reduce((best, c) => (loudnessOf(c) > loudnessOf(best) ? c : best));
}

const ms = (seconds: number) => seconds * 1000;

describe("the coast coquí's call", () => {
  const [co, qui] = notes();

  it("is two notes, 'co' then 'quí', with nothing else", () => {
    expect(notes()).toHaveLength(2);
  });

  it("lasts 306 ms from the start of 'co' to the end of 'quí': 89 ms of 'co', 109 ms of silence, 108 ms of 'quí'", () => {
    expect(ms(co[1] - co[0])).toBeCloseTo(89, 0);
    expect(ms(qui[0] - co[1])).toBeCloseTo(109, 0);
    expect(ms(qui[1] - qui[0])).toBeCloseTo(108, 0);
    expect(ms(qui[1] - co[0])).toBeCloseTo(306, 0);
  });

  it("'co' is at 1,630 Hz, sagging a little in a straight line: from 1.5% above to 1.5% below", () => {
    const all = cycles(co[0], co[1]);
    expect(pitchOf(all[0])).toBeCloseTo(1630 * 1.015, -1);
    expect(pitchOf(all[all.length - 1])).toBeCloseTo(1630 * 0.985, -1);
    // Halfway, halfway between.
    const middle = all.find(([a, b]) => a <= (co[0] + co[1]) / 2 && b > (co[0] + co[1]) / 2)!;
    expect(pitchOf(middle)).toBeCloseTo(1630, -1);
  });

  it("'quí' rises from 2,650 to 3,030 Hz, quickly at first and then easing", () => {
    const all = cycles(qui[0], qui[1]);
    expect(Math.abs(pitchOf(all[0]) - 2650)).toBeLessThan(10);
    expect(Math.abs(pitchOf(all[all.length - 1]) - 3030)).toBeLessThan(10);
    // The share of the rise done is the share of the note gone, to the power 0.7:
    // halfway through, it has risen 62% of the way, where a straight line would be at 50%.
    const half = (qui[0] + qui[1]) / 2;
    const middle = all.find(([a, b]) => a <= half && b > half)!;
    expect(Math.abs(pitchOf(middle) - (2650 + 380 * 0.5 ** 0.7))).toBeLessThan(10);
    expect(pitchOf(middle)).toBeGreaterThan(2650 + 380 * 0.5 + 30);
  });

  it("each note swells to its loudest point and falls from it: 'co' 42% of the way in, 'quí' 58%", () => {
    const middle = ([a, b]: [number, number]) => (a + b) / 2;
    expect(Math.abs(ms(middle(loudest(co[0], co[1])) - co[0]) - 0.42 * 89)).toBeLessThan(1.5);
    expect(Math.abs(ms(middle(loudest(qui[0], qui[1])) - qui[0]) - 0.58 * 108)).toBeLessThan(1.5);
  });

  it("'quí' is the call's peak, at 0.16 of full volume, and 'co' 0.8 of it", () => {
    // A sine at 0.16 has a root mean square of 0.16 / √2 (the overtones add a little).
    const peak = loudnessOf(loudest(qui[0], qui[1]));
    expect(peak / (0.16 / Math.SQRT2)).toBeGreaterThan(0.99);
    expect(peak / (0.16 / Math.SQRT2)).toBeLessThan(1.01);
    expect(loudnessOf(loudest(co[0], co[1])) / peak).toBeCloseTo(0.8, 2);
  });

  it("'co' has a second overtone at 0.07 of it and a third at 0.03; 'quí' 0.02 and 0.09", () => {
    const [co2, co3] = overtonesOf(loudest(co[0], co[1]));
    expect(co2).toBeCloseTo(0.07, 2);
    expect(co3).toBeCloseTo(0.03, 2);
    const [qui2, qui3] = overtonesOf(loudest(qui[0], qui[1]));
    expect(qui2).toBeCloseTo(0.02, 2);
    expect(qui3).toBeCloseTo(0.09, 2);
  });

  it("starts and ends at silence, each note swelling from nothing and falling to nothing, so it never clicks", () => {
    expect(samples[0]).toBe(0);
    expect(samples[samples.length - 1]).toBe(0);
    // The first and last millisecond of each note stay far under its loudest.
    for (const [a, b] of [co, qui]) {
      let edge = 0;
      for (let i = Math.round(a * RATE); i < a * RATE + RATE / 1000; i++) edge = Math.max(edge, Math.abs(samples[i]));
      for (let i = Math.round(b * RATE - RATE / 1000); i < b * RATE; i++) edge = Math.max(edge, Math.abs(samples[i]));
      expect(edge).toBeLessThan(0.16 * 0.05);
    }
  });
});

describe("a call that is playing", () => {
  it("stops at once when the sound is turned off", async () => {
    let stopped = 0;
    let closed = 0;
    const contexts: CallContexts = {
      aloud: () =>
        ({
          sampleRate: RATE,
          state: "running",
          destination: {},
          createBuffer: () => ({ copyToChannel: () => undefined }),
          createBufferSource: () => {
            const source = {
              buffer: null,
              onended: null as (() => void) | null,
              connect: () => undefined,
              start: () => undefined, // plays on, as a real call would for a third of a second
              stop: () => {
                stopped++;
                source.onended?.();
              },
            };
            return source;
          },
          close: async () => {
            closed++;
          },
        }) as unknown as AudioContext,
      offline: () => {
        throw new Error("not used here");
      },
    };
    const playing = playCall(false, contexts);
    await new Promise((resolve) => setTimeout(resolve, 5));
    stopCall();
    await playing;
    expect(stopped).toBe(1);
    expect(closed).toBe(1);
    // Nothing playing: turning the sound off does nothing.
    stopCall();
    expect(stopped).toBe(1);
  });

  // Review of Batch 6, B6-R06: ticked, unticked and ticked again quickly, the second tick plays the call. (Before, it
  // was handed the call still letting go of the speakers, and nothing sounded.)
  it("hushed, the next call plays anew at once, without waiting for the last to let go of the speakers", async () => {
    let made = 0;
    let started = 0;
    let letGo: () => void = () => undefined;
    const contexts: CallContexts = {
      aloud: () => {
        made++;
        return {
          sampleRate: RATE,
          state: "running",
          destination: {},
          createBuffer: () => ({ copyToChannel: () => undefined }),
          createBufferSource: () => {
            const source = {
              buffer: null,
              onended: null as (() => void) | null,
              connect: () => undefined,
              start: () => void started++,
              stop: () => source.onended?.(),
            };
            return source;
          },
          // Letting go of the speakers takes a moment.
          close: () => new Promise<void>((resolve) => (letGo = resolve)),
        } as unknown as AudioContext;
      },
      offline: () => {
        throw new Error("not used here");
      },
    };
    const first = playCall(false, contexts);
    await new Promise((resolve) => setTimeout(resolve, 5));
    stopCall();
    const second = playCall(false, contexts);
    expect(second).not.toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect([made, started]).toEqual([2, 2]);
    // The first letting go doesn't end the second.
    letGo();
    await first;
    expect(playCall(false, contexts)).toBe(second);
    stopCall();
    await new Promise((resolve) => setTimeout(resolve, 5));
    letGo();
    await second;
  });
});
