// Read Aloud, for proofreading by ear (roadmap Batch 14, item 4): Review >
// Read Aloud, the toolbar's More menu, or Control-Command-R. It reads the page
// in the Mac's own voice, sentence by sentence, from the cursor to the end or
// only the words selected (what it reads: src/core/spoken-text.ts). A bar over
// the page says "Reading aloud" and holds Previous sentence, Pause or Resume,
// Next sentence and Stop. The sentence being read is marked softly on the
// page, and the word being said too, where the voice says which it is.
//
// Quiet by default: nothing speaks unless the person chooses Read Aloud. It
// stops on Escape, on Stop, when the tab closes or another comes to the front,
// when the page goes out of sight (the Markdown view, a version), when the
// document changes under it (their typing, an agent's edit), and when the
// window closes or Corillo quits.
//
// The speech is the window's own (the Web Speech API), which Chromium speaks
// through the Mac's voices: nothing is shipped for it. Corillo picks no voice,
// so the Mac's own is used. Everything goes through one seam, `Speech`. While
// tests run it is a recorder that says nothing (the tests drive it), and the
// window's real speech refuses to start, so a test that reaches it fails
// instead of speaking.
//
// The marks are the browser's own highlights (CSS.highlights), which don't
// change the page: nothing is laid out again for them, and the editor never
// sees them.
import type { Node } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import type { CorilloApi } from "../preload/preload";
import { hasSpokenWords, spokenSentences, type Sentence } from "../core/spoken-text";
import type { DocTab } from "./doc-tab";
import { ICONS } from "./icons";
import { forTests } from "./for-tests";
import type { MenuEntry } from "./popup-menu";

/** What the voice tells as it speaks. */
export interface SpeechEvents {
  /** It is saying the word at this place in the text (its length, when the voice says). */
  word(charIndex: number, charLength: number): void;
  /** It finished the text. */
  end(): void;
  /** It couldn't say it. */
  failed(): void;
}

/** The one seam between Corillo and the speech. */
export interface Speech {
  speak(text: string, events: SpeechEvents): void;
  pause(): void;
  resume(): void;
  /** Stop and forget what was asked for. */
  cancel(): void;
}

/**
 * While tests run: every call written down, nothing said. Tests end a sentence or say a word with `finish` and `word`.
 * It keeps "paused" as Chromium's speech does (B14-04): pause sets it, cancel leaves it set, and resume clears it
 * only while something is queued (with nothing queued it does nothing). A sentence asked for while it's set waits silent.
 */
export class SpeechRecorder implements Speech {
  calls: string[] = [];
  /** Times the window's real speech was asked for while tests run (it refused each time). */
  realReached = 0;
  paused = false;
  private current: SpeechEvents | null = null;
  /** Whether the voice would be heard now: a sentence asked for, and not paused. */
  get speaking(): boolean {
    return !!this.current && !this.paused;
  }
  speak(text: string, events: SpeechEvents): void {
    this.calls.push(`speak: ${text}`);
    this.current = events;
  }
  pause(): void {
    this.calls.push("pause");
    this.paused = true;
  }
  resume(): void {
    this.calls.push("resume");
    if (this.current) this.paused = false;
  }
  cancel(): void {
    this.calls.push("cancel");
    this.current = null;
  }
  /** The voice finished the sentence. */
  finish(): void {
    const events = this.current;
    this.current = null;
    events?.end();
  }
  /** The voice says it's at this word. */
  word(charIndex: number, charLength = 0): void {
    this.current?.word(charIndex, charLength);
  }
  /** The voice couldn't say it. */
  fail(): void {
    const events = this.current;
    this.current = null;
    events?.failed();
  }
}

const testing = () => window.corillo.forTests === true;

/** The Mac's voice, through the window's speech. */
function macSpeech(): Speech {
  // Held while it speaks: an utterance let go of can stop telling where it is.
  let speaking: SpeechSynthesisUtterance | null = null;
  return {
    speak(text, events) {
      if (testing()) throw new Error("Real speech reached while tests run");
      const u = new SpeechSynthesisUtterance(text);
      u.onboundary = (e) => {
        if (e.name === "word") events.word(e.charIndex, e.charLength ?? 0);
      };
      u.onend = () => {
        if (speaking === u) speaking = null;
        events.end();
      };
      u.onerror = (e) => {
        if (speaking === u) speaking = null;
        if (e.error !== "interrupted" && e.error !== "canceled") events.failed();
      };
      speaking = u;
      speechSynthesis.speak(u);
    },
    pause: () => speechSynthesis.pause(),
    resume: () => speechSynthesis.resume(),
    cancel: () => {
      speaking = null;
      speechSynthesis.cancel();
    },
  };
}

/** The speech in use: the recorder while tests run, with the real one refusing to start; the Mac's voice otherwise. */
function chooseSpeech(): Speech {
  if (!testing()) return macSpeech();
  const recorder = new SpeechRecorder();
  forTests.speech = recorder;
  const synth = window.speechSynthesis as SpeechSynthesis | undefined;
  if (synth) {
    Object.defineProperty(synth, "speak", {
      configurable: true,
      value: () => {
        recorder.realReached++;
        window.corillo.realSpeechReached(); // the whole run fails, whichever test it was (B14-09)
        throw new Error("Real speech reached while tests run");
      },
    });
  }
  return recorder;
}

const SENTENCE_MARK = "read-aloud-sentence";
const WORD_MARK = "read-aloud-word";
/** A word as a voice counts one, when it doesn't say how long it is. */
const WORD = /^[\p{L}\p{N}\p{M}'’-]+/u;

export const READ_ALOUD_KEYS = "⌃⌘R";

export interface ReadAloudHost {
  api: CorilloApi;
  active(): DocTab | null;
  /** A version or Show changes is in place of the page. */
  isViewing(tab: DocTab): boolean;
  /** Reading started or stopped: the menus and the toolbar say so. */
  changed(): void;
}

export interface ReadAloud {
  /** Whether the tab in front can be read now (or is being read). */
  available(): boolean;
  reading(): boolean;
  /** Read Aloud chosen: start, or stop if reading. */
  toggle(): void;
  stop(): void;
  /** Something changed: stop if the document changed, the page went out of sight, or another tab is in front. */
  check(): void;
  /** This tab is closing. */
  forget(tab: DocTab): void;
  /** Its item at the end of the toolbar's More menu. */
  moreEntry(): MenuEntry;
}

interface Reading {
  tab: DocTab;
  /** The document as it was when reading started: if it changes, reading stops. */
  doc: Node;
  sentences: Sentence[];
  index: number;
  paused: boolean;
  bar: HTMLElement;
  pauseButton: HTMLButtonElement;
  /** Tells a sentence's events from an earlier one's, which may still arrive after it was stopped. */
  turn: number;
  keydown: (e: KeyboardEvent) => void;
  pagehide: () => void;
}

function button(className: string, label: string, icon: string | null, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  if (icon) {
    b.innerHTML = icon;
    b.setAttribute("aria-label", label);
  } else b.textContent = label;
  b.title = title;
  // The keyboard stays in the page, where Escape stops reading.
  b.addEventListener("mousedown", (e) => e.preventDefault());
  return b;
}

/** The scrolled part of the formatted view. */
const scrollerOf = (view: EditorView) => view.dom.closest<HTMLElement>(".canvas");

/** A range of the page's text, for the browser's highlights. */
function rangeOf(view: EditorView, from: number, to: number): Range | null {
  try {
    const a = view.domAtPos(from, 1);
    const b = view.domAtPos(to, -1);
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    return range;
  } catch {
    return null;
  }
}

function mark(name: string, range: Range | null): void {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  if (range) CSS.highlights.set(name, new Highlight(range));
  else CSS.highlights.delete(name);
}

/** Keep the sentence in sight: the page moves only when it would leave the screen, as Find's does. */
function keepInSight(view: EditorView, s: Sentence): void {
  const scroller = scrollerOf(view);
  if (!scroller) return;
  try {
    const top = view.coordsAtPos(s.from, 1).top;
    const bottom = view.coordsAtPos(s.to, -1).bottom;
    const seen = scroller.getBoundingClientRect();
    if (top < seen.top + 24 || bottom > seen.bottom - 24) scroller.scrollTop += top - seen.top - seen.height / 3;
  } catch {
    // A place that can't be measured: the page stays where it is.
  }
}

/** Put the bar in or take it out without moving the words on screen. */
function keepWordsStill(view: EditorView, change: () => void): void {
  const scroller = scrollerOf(view);
  const before = view.dom.getBoundingClientRect().top;
  change();
  if (!scroller) return;
  const after = view.dom.getBoundingClientRect().top;
  if (after !== before) scroller.scrollTop += after - before;
}

export function setUpReadAloud(host: ReadAloudHost): ReadAloud {
  const speech = chooseSpeech();
  let now: Reading | null = null;
  let turns = 0;

  /** The tab's formatted page is on screen (not the Markdown view, not a version). */
  const onPage = (tab: DocTab) => tab.mode === "formatted" && !host.isViewing(tab) && !tab.view.isDestroyed;
  const available = () => {
    const tab = host.active();
    if (now) return true;
    if (!tab || !onPage(tab) || tab.words === 0) return false;
    // Words, not only code (B14-10): with words selected, among them, as start reads only those.
    const { selection, doc } = tab.view.state;
    return hasSpokenWords(doc, selection.empty ? undefined : { from: selection.from, to: selection.to });
  };

  function speakCurrent(r: Reading): void {
    const turn = (r.turn = ++turns);
    const s = r.sentences[r.index];
    const view = r.tab.view;
    mark(SENTENCE_MARK, rangeOf(view, s.from, s.to));
    mark(WORD_MARK, null);
    keepInSight(view, s);
    speech.speak(s.text, {
      word: (at, length) => {
        if (now !== r || r.turn !== turn || at < 0 || at >= s.text.length) return;
        const end = Math.min(s.text.length, at + (length > 0 ? length : (WORD.exec(s.text.slice(at))?.[0].length ?? 0)));
        mark(WORD_MARK, end > at ? rangeOf(view, s.places[at], s.places[end]) : null);
      },
      end: () => {
        if (now !== r || r.turn !== turn) return;
        // The document may have changed in a way nothing announced: it is read as it was only while it still is.
        if (r.tab.view.state.doc !== r.doc) return stop();
        if (r.index + 1 >= r.sentences.length) return stop();
        r.index++;
        speakCurrent(r);
      },
      failed: () => {
        if (now === r && r.turn === turn) stop();
      },
    });
  }

  function start(): void {
    const tab = host.active();
    if (now || !tab || !onPage(tab)) return;
    const { selection, doc } = tab.view.state;
    const { sentences, start: first } = spokenSentences(doc, selection.empty ? { cursor: selection.from } : { from: selection.from, to: selection.to });
    if (!sentences.length) return;

    const bar = document.createElement("div");
    bar.className = "banner read-aloud-bar";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Read aloud");
    const words = document.createElement("span");
    words.className = "read-aloud-words";
    words.textContent = "Reading aloud";
    const steps = document.createElement("div");
    steps.className = "read-aloud-steps";
    const back = button("read-aloud-step back", "Previous sentence", ICONS.previous, "Previous sentence");
    const pauseButton = button("read-aloud-step pause", "Pause", ICONS.pause, "Pause");
    const next = button("read-aloud-step next", "Next sentence", ICONS.next, "Next sentence");
    steps.append(back, pauseButton, next);
    const stopButton = button("read-aloud-stop", "Stop", null, "Stop reading aloud (Esc)");
    bar.append(words, steps, stopButton);
    back.addEventListener("click", () => step(-1));
    next.addEventListener("click", () => step(1));
    pauseButton.addEventListener("click", () => pauseOrResume());
    stopButton.addEventListener("click", () => stop());

    const r: Reading = {
      tab,
      doc,
      sentences,
      index: first,
      paused: false,
      bar,
      pauseButton,
      turn: 0,
      // Escape in the page or on the bar stops reading, before the page's own Escape (which selects the paragraph).
      // In a box being typed in, a menu or a dialog, Escape keeps its own meaning.
      keydown: (e) => {
        if (e.key !== "Escape" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        const at = e.target instanceof globalThis.Node ? e.target : null;
        if (at !== document.body && !r.tab.view.dom.contains(at) && !bar.contains(at)) return;
        e.preventDefault();
        e.stopPropagation();
        stop();
      },
      pagehide: () => stop(),
    };
    now = r;
    // Under the lines and banners at the top of the page, right above it.
    const views = tab.main.querySelector(":scope > .views");
    keepWordsStill(tab.view, () => tab.main.insertBefore(bar, views));
    window.addEventListener("keydown", r.keydown, true);
    window.addEventListener("pagehide", r.pagehide);
    speakCurrent(r);
    host.changed();
  }

  function step(by: 1 | -1): void {
    const r = now;
    if (!r) return;
    if (by > 0 && r.index + 1 >= r.sentences.length) return stop();
    r.index = Math.max(0, r.index + by);
    r.turn = ++turns; // what the voice says of the sentence it was on no longer counts
    // Resumed before it's cancelled: with nothing left to say, the browser ignores a resume and stays paused (B14-04).
    if (r.paused) {
      speech.resume();
      setPaused(r, false);
    }
    speech.cancel();
    speakCurrent(r);
  }

  function setPaused(r: Reading, paused: boolean): void {
    r.paused = paused;
    r.pauseButton.innerHTML = paused ? ICONS.play : ICONS.pause;
    r.pauseButton.setAttribute("aria-label", paused ? "Resume" : "Pause");
    r.pauseButton.title = paused ? "Resume" : "Pause";
  }

  function pauseOrResume(): void {
    const r = now;
    if (!r) return;
    if (r.paused) speech.resume();
    else speech.pause();
    setPaused(r, !r.paused);
  }

  function stop(): void {
    const r = now;
    if (!r) return;
    now = null;
    r.turn = ++turns;
    if (r.paused) speech.resume(); // as in step: else the next reading would start paused, silent
    speech.cancel();
    mark(SENTENCE_MARK, null);
    mark(WORD_MARK, null);
    window.removeEventListener("keydown", r.keydown, true);
    window.removeEventListener("pagehide", r.pagehide);
    const hadKeyboard = r.bar.contains(document.activeElement);
    if (r.tab.view.isDestroyed) r.bar.remove();
    else keepWordsStill(r.tab.view, () => r.bar.remove());
    if (hadKeyboard && !r.tab.view.isDestroyed) r.tab.view.focus();
    host.changed();
  }

  function check(): void {
    const r = now;
    if (!r) return;
    if (host.active() !== r.tab || !onPage(r.tab) || r.tab.view.state.doc !== r.doc) stop();
  }

  function toggle(): void {
    if (now) stop();
    else start();
  }

  host.api.onMenu((action) => {
    if (action === "read-aloud") toggle();
  });

  return {
    available,
    reading: () => !!now,
    toggle,
    stop,
    check,
    forget(tab) {
      if (now?.tab === tab) stop();
    },
    moreEntry: () => ({
      label: now ? "Stop reading aloud" : "Read aloud",
      icon: ICONS.readAloud,
      shortcut: READ_ALOUD_KEYS,
      enabled: available(),
      run: () => toggle(),
    }),
  };
}
