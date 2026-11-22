// Switches only tests turn on, to compare two ways of doing one thing (an
// agent's change shown as an edit, or the page read again). They're offered
// only when Corillo runs for tests (hidden, from the test helpers), as the
// window's `corilloTests`, which a test's own script sets. Corillo reads them
// here, never from a name on the window: the browser makes every element with
// an id such a name, and a document can put one on the page (in a diagram's
// label, say), so a switch read from there could be turned on by a document
// (review of Batch 7, B7-R01).

import { plantInSerializer, serializerFault, type PlantedFault } from "../core/write-check";
import { wordsKept } from "../core/change-links";

/**
 * netFault: a fault planted in how a save writes the page, for the safety net to catch (see core/write-check.ts).
 * serializerFault: the same planted in the serializer itself, which the Markdown view's text comes from too.
 * speech: Read Aloud's recorder, which stands in for the speech while tests run (see read-aloud.ts).
 * wordsKept: how many texts the window keeps read as words for a document (an option chosen reads them), for the leak checks.
 * savesSet: how many times a document's save has been set going (or put off), for the check that a keystroke does it once.
 */
export const forTests: {
  readAgain: boolean;
  netFault: PlantedFault | null;
  serializerFault: PlantedFault | null;
  speech?: unknown;
  wordsKept: (doc: string) => number;
  savesSet: number;
} = {
  readAgain: false,
  netFault: null,
  wordsKept,
  savesSet: 0,
  get serializerFault() {
    return serializerFault();
  },
  set serializerFault(fault) {
    plantInSerializer(fault);
  },
};

if (window.corillo.forTests === true) Object.defineProperty(window, "corilloTests", { value: forTests });
