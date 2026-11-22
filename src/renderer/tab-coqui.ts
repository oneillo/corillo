// A small coquí sits on a document's tab while an agent works on it, and hops
// (roadmap Batch 9, item 13; Orlando: "Do we do any sort of animation when an
// agent is working on a tab? If not, can we do something cute on brand? Like
// the Coqui hopping or something?").
//
// The frog is drawn here, in code, for Corillo: a coquí sitting and facing you,
// with big eyes and round toe pads, in the agent's colour and edged like the
// tab's dot. It's decoration: screen readers hear "Claude is editing" from the
// tab's name and the line at the top, never the frog.
//
// Calm, not busy: every frog on screen hops once, together, every few seconds,
// and rests between. One timer for the whole window, and only while a frog is
// on the page (an agent holds a document); with none, nothing runs. With Reduce
// Motion on in the Mac's settings, the frogs sit still and no timer runs. The
// hop moves only the frog's own layer, so the page isn't laid out or painted
// again for it.

/** The coquí's body: everything that's edged and filled with the agent's colour. */
const SHAPES =
  '<ellipse cx="9" cy="20.6" rx="4.8" ry="3.3"/><ellipse cx="27" cy="20.6" rx="4.8" ry="3.3"/>' +
  '<circle cx="4.6" cy="22.8" r="1.9"/><circle cx="31.4" cy="22.8" r="1.9"/>' +
  '<path d="M8 16.6Q8 9.6 18 9.6Q28 9.6 28 16.6Q28 24.1 18 24.1Q8 24.1 8 16.6Z"/>' +
  '<circle cx="11.6" cy="7.6" r="5.4"/><circle cx="24.4" cy="7.6" r="5.4"/>' +
  '<circle cx="14.4" cy="23.6" r="2.2"/><circle cx="21.6" cy="23.6" r="2.2"/>';

/** The drawing: the shapes edged (drawn wider underneath), then filled, then the eyes and a small smile. */
const DRAWING =
  '<svg viewBox="0 0 36 28" focusable="false">' +
  `<g class="frog-edge">${SHAPES}</g>` +
  `<g class="frog-body">${SHAPES}</g>` +
  '<circle class="frog-eye" cx="11.6" cy="7.6" r="3.4"/><circle class="frog-eye" cx="24.4" cy="7.6" r="3.4"/>' +
  '<circle class="frog-pupil" cx="12.1" cy="8" r="2"/><circle class="frog-pupil" cx="23.9" cy="8" r="2"/>' +
  '<path class="frog-smile" d="M15 16.8Q18 18.8 21 16.8"/>' +
  "</svg>";

/** A new frog, for a tab or the "is editing" line. Hidden from screen readers. */
export function coquiFrog(colour: string | null): HTMLElement {
  const frog = document.createElement("span");
  frog.className = "coqui-frog";
  frog.setAttribute("aria-hidden", "true");
  frog.innerHTML = DRAWING;
  paintFrog(frog, colour);
  return frog;
}

/** Paint the frog in an agent's colour (one of the --agent-<colour> names), or Corillo's blue-grey with none. */
export function paintFrog(frog: HTMLElement, colour: string | null): void {
  if ((frog.dataset.colour ?? "") === (colour ?? "")) return;
  if (colour) {
    frog.dataset.colour = colour;
    frog.style.setProperty("--frog-colour", `var(--agent-${colour})`);
  } else {
    delete frog.dataset.colour;
    frog.style.removeProperty("--frog-colour");
  }
}

// The hop -------------------------------------------------------------------------

/** The first hop comes a moment after a frog arrives, so it's seen landing; then one every few seconds. */
const FIRST_HOP_MS = 600;
const HOP_EVERY_MS = 4000;
const HOP_MS = 640;
/**
 * A crouch, a small jump of about a third of its height, stretching a little in
 * the air, and a soft landing. From its feet, so it never sinks into the tab.
 */
const HOP: Keyframe[] = [
  { transform: "none", easing: "ease-out" },
  { transform: "scale(1.12, 0.84)", offset: 0.18, easing: "cubic-bezier(0.2, 0.6, 0.4, 1)" },
  { transform: "translateY(-32%) scale(0.94, 1.08)", offset: 0.5, easing: "cubic-bezier(0.6, 0, 0.8, 0.4)" },
  { transform: "scale(1.1, 0.88)", offset: 0.8, easing: "ease-out" },
  { transform: "none" },
];

/** What the hops follow, from the first call on (the window draws its tabs at once, so that's at launch). */
let watched: { frogs: HTMLCollectionOf<HTMLElement>; lessMotion: MediaQueryList } | undefined;
let timer: number | undefined;
const hopping = new Set<Animation>();

function watching(): NonNullable<typeof watched> {
  if (watched) return watched;
  // Every frog on the page now (the browser keeps this list up to date), and the Mac's Reduce Motion.
  watched = {
    frogs: document.getElementsByClassName("coqui-frog") as HTMLCollectionOf<HTMLElement>,
    lessMotion: matchMedia("(prefers-reduced-motion: reduce)"),
  };
  // Reduce Motion turned on stops the hops at once; turned off, they start again.
  watched.lessMotion.addEventListener("change", frogsChanged);
  return watched;
}

/**
 * Frogs came or went: hop while there are any, and stop the timer when there
 * are none. Called whenever a frog is put on or taken off the page.
 */
export function frogsChanged(): void {
  const { frogs, lessMotion } = watching();
  const wanted = frogs.length > 0 && !lessMotion.matches;
  if (wanted && timer === undefined) timer = window.setTimeout(hop, FIRST_HOP_MS);
  else if (!wanted) rest();
}

function rest(): void {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  for (const jump of hopping) jump.cancel();
  hopping.clear();
}

function hop(): void {
  timer = undefined;
  const { frogs, lessMotion } = watching();
  if (!frogs.length || lessMotion.matches) return rest();
  for (const frog of [...frogs]) {
    if (!hopsNow(frog)) continue;
    const jump = frog.animate(HOP, { duration: HOP_MS });
    hopping.add(jump);
    jump.onfinish = jump.oncancel = () => hopping.delete(jump);
  }
  timer = window.setTimeout(hop, HOP_EVERY_MS);
}

/**
 * Whether this frog hops now: it's on screen, and it's its document's one
 * frog that hops. That's the tab's; the one by "is editing" at the top sits
 * still for it, and hops only when there's no tab bar (one document open).
 */
function hopsNow(frog: HTMLElement): boolean {
  if (!frog.checkVisibility()) return false;
  return !frog.closest(".agent-notice") || document.body.classList.contains("single-doc");
}
