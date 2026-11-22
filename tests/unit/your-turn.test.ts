// It's your turn (roadmap Batch 2, item 2): the coquí call and the words a
// tab, its tooltip and the Window menu use for whose turn it is.
//
// Nobody can listen to a test, so the call is checked from its samples: two
// notes, the second higher and rising, soft, short, and starting and ending
// at silence (no click). Playing it is checked with a stand-in for the
// browser's audio, so no test ever makes a sound.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALL, callSamples, playCall, type CallContexts } from "../../src/renderer/coqui";
import { toReadWords, turnWords } from "../../src/renderer/turn-words";

const RATE = 48_000;

/** The parts of the samples louder than a whisper, as [start, end] in seconds. */
function bursts(samples: Float32Array, rate: number): [number, number][] {
  const found: [number, number][] = [];
  const window = Math.round(rate * 0.005);
  let start = -1;
  let quietSince = -1;
  for (let i = 0; i < samples.length; i += window) {
    let loudest = 0;
    for (let j = i; j < Math.min(i + window, samples.length); j++) loudest = Math.max(loudest, Math.abs(samples[j]));
    const loud = loudest > 0.01;
    if (loud && start < 0) start = i;
    if (loud) quietSince = -1;
    else if (start >= 0 && quietSince < 0) quietSince = i;
    if (start >= 0 && quietSince >= 0 && i - quietSince >= rate * 0.02) {
      found.push([start / rate, quietSince / rate]);
      start = -1;
      quietSince = -1;
    }
  }
  if (start >= 0) found.push([start / rate, (quietSince >= 0 ? quietSince : samples.length) / rate]);
  return found;
}

/** The pitch over a stretch, in hertz, from how often the wave crosses zero going up. */
function pitch(samples: Float32Array, rate: number, from: number, to: number): number {
  let crossings = 0;
  const a = Math.round(from * rate);
  const b = Math.round(to * rate);
  for (let i = a + 1; i < b; i++) if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
  return crossings / (to - from);
}

describe("the coquí call", () => {
  const samples = callSamples(RATE);

  it("is two notes, the second higher than the first, as the coquí sings", () => {
    const notes = bursts(samples, RATE);
    expect(notes).toHaveLength(2);
    const [co, qui] = notes;
    const coPitch = pitch(samples, RATE, co[0], co[1]);
    const quiPitch = pitch(samples, RATE, qui[0], qui[1]);
    expect(quiPitch).toBeGreaterThan(coPitch * 1.3);
    // Each where a coquí on the coast sings (changed 2026-11-10, roadmap Batch 6, item 5: below 2,200 Hz until then; see coqui-call.test.ts).
    expect(coPitch).toBeGreaterThan(1550);
    expect(coPitch).toBeLessThan(1700);
    expect(quiPitch).toBeGreaterThan(2600);
    expect(quiPitch).toBeLessThan(3100);
  });

  it("rises within the second note, the 'quí'", () => {
    const [, qui] = bursts(samples, RATE);
    const third = (qui[1] - qui[0]) / 3;
    expect(pitch(samples, RATE, qui[1] - third, qui[1])).toBeGreaterThan(pitch(samples, RATE, qui[0], qui[0] + third) * 1.04);
  });

  it("is short, well under a second", () => {
    const notes = bursts(samples, RATE);
    expect(notes[notes.length - 1][1] - notes[0][0]).toBeLessThan(0.5);
    expect(samples.length / RATE).toBeLessThan(0.6);
  });

  it("is soft: never louder than a fifth of full volume", () => {
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    expect(peak).toBeLessThanOrEqual(0.2);
    expect(peak).toBeGreaterThan(0.08); // but there to be heard
    expect(CALL.peak).toBeLessThanOrEqual(0.2);
  });

  it("starts and ends at silence, so it never clicks, and fades in rather than snapping on", () => {
    expect(Math.abs(samples[0])).toBeLessThan(1e-6);
    expect(Math.abs(samples[samples.length - 1])).toBeLessThan(1e-6);
    // The first 2 ms stay well under the peak.
    let early = 0;
    for (let i = 0; i < RATE * 0.002; i++) early = Math.max(early, Math.abs(samples[i]));
    expect(early).toBeLessThan(CALL.peak / 3);
  });

  it("sounds the same at the Mac's usual sample rates", () => {
    for (const rate of [44_100, 48_000, 96_000]) {
      const s = callSamples(rate);
      expect(bursts(s, rate)).toHaveLength(2);
      expect(Math.abs(s.length / rate - samples.length / RATE)).toBeLessThan(0.001);
    }
  });
});

/** A stand-in for the browser's audio: it records what was asked of it and never makes a sound. */
function standIn(options: { ends?: boolean; startsSuspended?: boolean } = {}) {
  const made: { closed: boolean; started: number; resumed: number; samples: Float32Array | null; connected: boolean }[] = [];
  const contexts: CallContexts = {
    aloud: () => {
      const record = { closed: false, started: 0, resumed: 0, samples: null as Float32Array | null, connected: false };
      made.push(record);
      const context = {
        sampleRate: RATE,
        state: options.startsSuspended ? "suspended" : "running",
        destination: {},
        createBuffer: (_channels: number, length: number, rate: number) => ({
          length,
          sampleRate: rate,
          copyToChannel: (data: Float32Array) => (record.samples = data),
        }),
        createBufferSource: () => {
          const source = {
            buffer: null as unknown,
            onended: null as (() => void) | null,
            connect: () => (record.connected = true),
            start: () => {
              record.started++;
              if (options.ends !== false) setTimeout(() => source.onended?.(), 10);
            },
          };
          return source;
        },
        resume: async () => {
          record.resumed++;
        },
        close: async () => {
          record.closed = true;
        },
      };
      return context as unknown as AudioContext;
    },
    offline: () => {
      throw new Error("not used here");
    },
  };
  return { made, contexts };
}

describe("playing the call", () => {
  afterEach(() => vi.useRealTimers());

  it("plays the samples once and lets go of the audio as soon as the call ends", async () => {
    const { made, contexts } = standIn();
    const heard = await playCall(false, contexts);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ started: 1, connected: true, closed: true });
    expect(made[0].samples).toEqual(callSamples(RATE));
    expect(heard!.seconds).toBeLessThan(0.6);
    expect(heard!.peak).toBeLessThanOrEqual(0.2);
  });

  it("asked again while it plays is the same call, not a second one on top", async () => {
    const { made, contexts } = standIn();
    await Promise.all([playCall(false, contexts), playCall(false, contexts), playCall(false, contexts)]);
    expect(made).toHaveLength(1);
    await playCall(false, contexts);
    expect(made).toHaveLength(2);
    expect(made.every((m) => m.closed)).toBe(true);
  });

  it("lets go of the audio even if the browser never says the call ended", async () => {
    vi.useFakeTimers();
    const { made, contexts } = standIn({ ends: false });
    const playing = playCall(false, contexts);
    await vi.advanceTimersByTimeAsync(3000);
    await playing;
    expect(made[0].closed).toBe(true);
    // And the next call can play.
    vi.useRealTimers();
    const next = standIn();
    await playCall(false, next.contexts);
    expect(next.made).toHaveLength(1);
  });

  it("wakes the audio if the browser starts it asleep", async () => {
    const { made, contexts } = standIn({ startsSuspended: true });
    await playCall(false, contexts);
    expect(made[0].resumed).toBe(1);
    expect(made[0].closed).toBe(true);
  });

  it("never reaches for the speakers when told to render it off-line", async () => {
    let aloud = 0;
    let rendered = 0;
    const contexts: CallContexts = {
      aloud: () => {
        aloud++;
        throw new Error("no sound in tests");
      },
      offline: (length, rate) => {
        rendered++;
        let data: Float32Array = new Float32Array(length);
        return {
          sampleRate: rate,
          destination: {},
          createBuffer: () => ({ copyToChannel: (d: Float32Array) => (data = d) }),
          createBufferSource: () => ({ buffer: null, connect: () => undefined, start: () => undefined }),
          startRendering: async () => ({ getChannelData: () => data, length, sampleRate: rate }),
        } as unknown as OfflineAudioContext;
      },
    };
    const heard = await playCall(true, contexts);
    expect(aloud).toBe(0);
    expect(rendered).toBe(1);
    expect(heard!.seconds).toBeGreaterThan(0.2);
    expect(heard!.seconds).toBeLessThan(0.6);
    expect(heard!.peak).toBeGreaterThan(0.08);
    expect(heard!.peak).toBeLessThanOrEqual(0.2);
  });
});

describe("whose turn, in words", () => {
  it("says who is editing", () => {
    expect(turnWords({ kind: "editing", agent: "Claude", colour: "peach" })).toBe("Claude is editing");
  });

  it("says who it came back from and how much is new to read", () => {
    expect(turnWords({ kind: "back", agent: "Writer", colour: "sky", opened: false, toRead: { cards: 3 } })).toBe("Back from Writer: 3 to read");
    expect(turnWords({ kind: "back", agent: "Claude", colour: "peach", opened: false, toRead: { cards: 0 } })).toBe("Back from Claude");
    expect(turnWords({ kind: "back", agent: null, colour: null, opened: false, toRead: { cards: 1 } })).toBe("Back with you: 1 to read");
  });

  it("says when an agent opened the document for the person", () => {
    expect(turnWords({ kind: "back", agent: "Claude", colour: "peach", opened: true, toRead: { cards: 0 } })).toBe("Opened for you by Claude");
    expect(turnWords({ kind: "back", agent: "Claude", colour: "peach", opened: true, toRead: { cards: 2 } })).toBe("Opened for you by Claude: 2 to read");
  });

  it("says With you once the person has looked", () => {
    expect(turnWords({ kind: "with-you" })).toBe("With you");
  });

  it("counts what's to read in one place", () => {
    expect(toReadWords({ cards: 0 })).toBe("");
    expect(toReadWords({ cards: 1 })).toBe("1 to read");
    expect(toReadWords({ cards: 12 })).toBe("12 to read");
  });
});
