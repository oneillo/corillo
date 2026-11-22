// Menu shortcuts as the menus write them ("CmdOrCtrl+Alt+M"), matched against
// the keys a person presses. The window handles the menus' shortcuts itself
// while it has the keyboard (see src/renderer/menus.ts), so a shortcut does
// exactly what its menu item does, whichever sees the keys first.
//
// The character typed decides, as in a Mac app's menus, so a shortcut follows
// the letters printed on the keys whatever the keyboard: Command-Z on a French
// keyboard is Z (Undo), not W (Close Tab), whose place Z takes on an American
// one. With Option, which changes the character, the character the key types
// on its own on the keyboard in use decides (the window asks the Mac). The
// key's place counts only where the character can't say: for a key with a
// name (arrows, Return, Tab); for a character outside plain ASCII (the "à" on
// a French keyboard's 0 key); for a sign Shift made (Shift-8 types "*", for
// Shift-Command-8); and with Option while the keyboard's layout isn't known.
// A press matches one shortcut at most.

/** The parts of a key press that matter here (a KeyboardEvent has them all). */
export interface KeyPress {
  key: string;
  code: string;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
}

export interface Accelerator {
  meta: boolean;
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
  /** Physical keys that count (KeyboardEvent.code), so Option doesn't change the letter. */
  codes: string[];
  /** Or the character typed, for keys whose place differs between keyboards. */
  keys: string[];
  /** Shift doesn't matter (Plus is Shift-= on most keyboards). */
  anyShift: boolean;
}

const MODIFIERS: Record<string, "meta" | "alt" | "shift" | "ctrl"> = {
  cmdorctrl: "meta",
  commandorcontrol: "meta",
  cmd: "meta",
  command: "meta",
  meta: "meta",
  super: "meta",
  alt: "alt",
  option: "alt",
  altgr: "alt",
  shift: "shift",
  ctrl: "ctrl",
  control: "ctrl",
};

const NAMED: Record<string, string[]> = {
  "=": ["Equal"],
  "-": ["Minus"],
  "/": ["Slash"],
  "[": ["BracketLeft"],
  "]": ["BracketRight"],
  ",": ["Comma"],
  ".": ["Period"],
  ";": ["Semicolon"],
  "'": ["Quote"],
  "`": ["Backquote"],
  "\\": ["Backslash"],
  up: ["ArrowUp"],
  down: ["ArrowDown"],
  left: ["ArrowLeft"],
  right: ["ArrowRight"],
  enter: ["Enter", "NumpadEnter"],
  return: ["Enter", "NumpadEnter"],
  tab: ["Tab"],
  escape: ["Escape"],
  esc: ["Escape"],
  space: ["Space"],
  backspace: ["Backspace"],
  delete: ["Delete"],
  plus: ["Equal", "NumpadAdd"],
};

const KEY_NAMES: Record<string, string> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  space: " ",
  backspace: "Backspace",
  delete: "Delete",
  plus: "+",
};

/** Read a shortcut as the menus write it; null if it isn't one. */
export function parseAccelerator(accelerator: string): Accelerator | null {
  if (!accelerator) return null;
  // "CmdOrCtrl++" is Command and the plus key.
  const parts = accelerator.endsWith("++") ? [...accelerator.slice(0, -2).split("+"), "Plus"] : accelerator.split("+");
  const name = parts.pop();
  if (!name) return null;
  const result: Accelerator = { meta: false, alt: false, shift: false, ctrl: false, codes: [], keys: [], anyShift: false };
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier) return null;
    result[modifier] = true;
  }
  const lower = name.toLowerCase();
  if (/^[a-z]$/.test(lower)) {
    result.codes = [`Key${lower.toUpperCase()}`];
    result.keys = [lower, lower.toUpperCase()];
  } else if (/^[0-9]$/.test(name)) {
    result.codes = [`Digit${name}`];
    result.keys = [name];
  } else if (NAMED[lower]) {
    result.codes = NAMED[lower];
    result.keys = [KEY_NAMES[lower] ?? name];
  } else if (name.length === 1) {
    result.keys = [name];
  } else return null;
  if (lower === "plus") {
    result.anyShift = true;
    result.keys.push("="); // Plus is Shift-= on an American keyboard
  }
  return result;
}

const PLAIN = /^[!-~]$/; // a printable ASCII character
const LETTER = /^[a-z]$/i;

/** The character each key types on its own on the keyboard in use, by its place (KeyboardEvent.code); undefined where unknown. */
export type KeyboardLayout = (code: string) => string | undefined;

/**
 * The shortcut a key press is, if any (the first, should two share keys).
 * With Option, which changes the character typed, the keyboard's layout says
 * what the key types on its own, and that decides as it does without Option:
 * Option-Command-M is the key with M on it, on any keyboard. Without the
 * layout, or for a key that types no plain letter (a number, a sign, a
 * letter of another alphabet), the key's place on an American keyboard does,
 * but never for a letter's shortcut when the key types another plain
 * character, so a key is never one shortcut by its letter and another by its place.
 */
export function findShortcut<T extends { keys: Accelerator }>(list: readonly T[], e: KeyPress, layout?: KeyboardLayout): T | undefined {
  const others = (a: Accelerator) => e.metaKey === a.meta && e.altKey === a.alt && e.ctrlKey === a.ctrl;
  const shift = (a: Accelerator) => a.anyShift || e.shiftKey === a.shift;
  if (e.altKey && layout) {
    const own = layout(e.code);
    if (own !== undefined && PLAIN.test(own)) {
      const letter = LETTER.test(own);
      const same = (k: string) => (letter ? k.toLowerCase() === own.toLowerCase() : k === own);
      const hit = list.find((s) => others(s.keys) && shift(s.keys) && same(s.keys.keys[0] ?? ""));
      if (hit || letter) return hit;
      const isLetter = (a: Accelerator) => a.codes.length === 1 && /^Key[A-Z]$/.test(a.codes[0]);
      return list.find((s) => others(s.keys) && shift(s.keys) && !isLetter(s.keys) && s.keys.codes.includes(e.code));
    }
  }
  const char = e.key;
  if (!e.altKey && PLAIN.test(char)) {
    const letter = LETTER.test(char);
    const same = (k: string) => (letter ? k.toLowerCase() === char.toLowerCase() : k === char);
    // The shortcut's own character, then (for a sign or number) whatever Shift it took to type it, as "/" is Shift-7 in Germany.
    const hit =
      list.find((s) => others(s.keys) && shift(s.keys) && same(s.keys.keys[0] ?? "")) ??
      (letter ? undefined : list.find((s) => others(s.keys) && (s.keys.anyShift || (e.shiftKey && !s.keys.shift)) && s.keys.keys.some(same)));
    if (hit || letter || !e.shiftKey) return hit;
  }
  return list.find((s) => others(s.keys) && shift(s.keys) && s.keys.codes.includes(e.code));
}

/** Whether a key press is this shortcut. */
export function matchesAccelerator(accelerator: Accelerator, e: KeyPress, layout?: KeyboardLayout): boolean {
  return findShortcut([{ keys: accelerator }], e, layout) !== undefined;
}

/** One spelling for each shortcut ("Alt+CmdOrCtrl+M" and "CmdOrCtrl+Option+M" are the same keys), to tell whether two clash. */
export function canonicalAccelerator(accelerator: string): string {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return accelerator;
  // Plus is Shift and the = key.
  const mods = (["ctrl", "alt", "shift", "meta"] as const).filter((m) => parsed[m] || (m === "shift" && parsed.anyShift));
  return [...mods, parsed.codes[0] ?? parsed.keys[0]].join("+");
}
