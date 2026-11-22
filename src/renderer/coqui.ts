// The coquí call, "co-quí", played when a document is back with the person
// and Corillo isn't in front (roadmap Batch 2, item 2; decision D5), and once
// when the person turns the sound on, to hear it. The coquí is the small
// Puerto Rican tree frog whose call is two notes, the second higher and
// rising.
//
// The call of a coast coquí (roadmap Batch 6, item 5: Orlando chose it of
// three, "Coast is the closest. No question."). Pitch and timing are a
// coquí's at sea level, from table 1 of Meenderink, Quiñones and Narins,
// "Behavioural tuning in a tropical amphibian along an altitudinal gradient",
// Biology Letters 13 (2017); the swell of each note, the bend of the rise and
// the overtones were measured from two field recordings on Wikimedia Commons
// (Coquí.flac, CC BY-SA 4.0; Coquíes1.ogg, CC BY-SA 3.0), which aren't part of
// Corillo.
//
// Made in code with the browser's own audio, no recording: the samples are
// worked out here and played once through an AudioContext, which is closed as
// soon as the call ends, so nothing is held between calls. A call asked for
// while one plays is that same call. In test runs (offline) the same samples
// go through an OfflineAudioContext instead, which never reaches the speakers.

/** One note of the call. Times in seconds, pitches in hertz. */
interface Note {
  start: number;
  length: number;
  /** Its pitch at its start and at its end. */
  from: number;
  to: number;
  /** How the pitch moves between: the share of the move done is the share of the note gone, to this power (1, a straight line; under 1, quickly at first, then easing). */
  bend: number;
  /** Where it's loudest, as a share of the way through it, and how loud then, as a share of the call's peak. */
  loudestAt: number;
  level: number;
  /** Its overtones: which (2, the second), and how loud, as a share of the note. */
  overtones: readonly (readonly [number, number])[];
}

/** The whole call, from the start of "co" to the end of "quí". */
const LENGTH = 0.306;
const QUI_LENGTH = 0.108;

export const CALL = {
  length: LENGTH,
  notes: [
    // "co": 1,630 Hz, sagging a little, fullest before its middle, a touch quieter than "quí".
    { start: 0, length: 0.089, from: 1630 * 1.015, to: 1630 * 0.985, bend: 1, loudestAt: 0.42, level: 0.8, overtones: [[2, 0.07], [3, 0.03]] },
    // "quí", after 109 ms of silence: rising from 2,650 to 3,030 Hz, quickly at first, then easing; fullest just past its middle.
    { start: LENGTH - QUI_LENGTH, length: QUI_LENGTH, from: 2650, to: 3030, bend: 0.7, loudestAt: 0.58, level: 1, overtones: [[2, 0.02], [3, 0.09]] },
  ] satisfies Note[],
  /** Each note swells to its loudest point and falls from it as a quarter sine raised to this, so it never clicks. */
  fullness: 1.2,
  /** The loudest it gets, as a share of full volume: soft, under the Mac's own alert sounds. */
  peak: 0.16,
};

/** A little silence after the last note, so the end is never cut short. */
const TAIL = 0.02;

/** How loud a note is at share `u` of the way through it, from 0 to 1. */
function swell(note: Note, u: number): number {
  const x = u < note.loudestAt ? u / note.loudestAt : (1 - u) / (1 - note.loudestAt);
  return Math.sin((Math.PI / 2) * Math.max(0, Math.min(1, x))) ** CALL.fullness;
}

/** The call's samples at this rate, one channel. */
export function callSamples(sampleRate: number): Float32Array {
  const out = new Float32Array(Math.ceil(CALL.length * sampleRate) + Math.round(TAIL * sampleRate));
  for (const note of CALL.notes) {
    const first = Math.round(note.start * sampleRate);
    const count = Math.round(note.length * sampleRate);
    let phase = 0;
    for (let i = 0; i < count; i++) {
      const u = i / count;
      let wave = Math.sin(phase);
      for (const [n, gain] of note.overtones) wave += gain * Math.sin(n * phase);
      out[first + i] += CALL.peak * note.level * swell(note, u) * wave;
      phase += (2 * Math.PI * (note.from + (note.to - note.from) * u ** note.bend)) / sampleRate;
    }
  }
  return out;
}

/** What a call sounded like, worked out from what was played: how long it was heard and its loudest point. */
export interface CallHeard {
  seconds: number;
  peak: number;
}

function heardIn(samples: Float32Array, sampleRate: number): CallHeard {
  let first = -1;
  let last = -1;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    if (a > 0.001) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return { seconds: first < 0 ? 0 : (last - first + 1) / sampleRate, peak };
}

/** Where the call is played: the speakers, or (in test runs) off-line, without a sound. */
export interface CallContexts {
  aloud(): AudioContext;
  offline(length: number, sampleRate: number): OfflineAudioContext;
}

const browser: CallContexts = {
  aloud: () => new AudioContext({ latencyHint: "playback" }),
  offline: (length, sampleRate) => new OfflineAudioContext(1, length, sampleRate),
};

/** Longer than the call: the audio is let go of by then even if the browser never says it ended. */
const LET_GO_MS = 2000;
const OFFLINE_RATE = 48_000;

let playing: Promise<CallHeard | null> | null = null;
/** Stops the call playing aloud now, if one is. */
let hush: (() => void) | null = null;

/** The person turned the sound off: a call that is playing stops at once. */
export function stopCall(): void {
  hush?.();
  // Hushed: the next call plays anew, without waiting for this one to let go of the speakers (B6-R06).
  playing = null;
}

/** Play the call once (`offline`: render it without a sound). Resolves with what was heard, or null if it couldn't play. */
export function playCall(offline: boolean, contexts: CallContexts = browser): Promise<CallHeard | null> {
  if (playing) return playing;
  const call: Promise<CallHeard | null> = (offline ? renderOffline(contexts) : playAloud(contexts))
    .catch((err) => {
      console.error("Corillo couldn't play the coquí call.", err);
      return null;
    })
    .finally(() => {
      if (playing === call) playing = null;
    });
  playing = call;
  return call;
}

/** The samples as a one-channel buffer source on this context, connected to its output. */
function sourceOf(context: BaseAudioContext, samples: Float32Array): AudioBufferSourceNode {
  const buffer = context.createBuffer(1, samples.length, context.sampleRate);
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  return source;
}

async function playAloud(contexts: CallContexts): Promise<CallHeard> {
  const context = contexts.aloud();
  try {
    if (context.state === "suspended") await context.resume();
    const samples = callSamples(context.sampleRate);
    const source = sourceOf(context, samples);
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(letGo);
        hush = null;
        resolve();
      };
      const letGo = setTimeout(done, LET_GO_MS);
      source.onended = done;
      hush = () => {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // ended already
        }
        done();
      };
      source.start();
    });
    return heardIn(samples, context.sampleRate);
  } finally {
    await context.close();
  }
}

async function renderOffline(contexts: CallContexts): Promise<CallHeard> {
  const samples = callSamples(OFFLINE_RATE);
  const context = contexts.offline(samples.length, OFFLINE_RATE);
  sourceOf(context, samples).start();
  const rendered = await context.startRendering();
  return heardIn(rendered.getChannelData(0), OFFLINE_RATE);
}
