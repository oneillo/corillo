// Undo straight after Resolve reopens the comment, as in Word: a card resolved
// by mistake comes back with the key everyone tries first, wherever the
// keyboard is (the document, a comment box, nowhere). Undo straight after
// Delete brings the comment or reply back the same way (roadmap Batch 9, item
// 4: Delete no longer asks first). Only the last Resolve or Delete, and only
// while it's the last thing the person did: once they do anything else (a key,
// a click, typing, a menu command), Undo is back to undoing their edits as
// usual. Scrolling doesn't count; it's only looking.

/** A comment just resolved or deleted, and how to bring it back. */
export interface JustDone {
  /** The tab's comments it belongs to: Undo in another tab leaves it. */
  owner: object;
  undo(): void;
  /** Undo has something else to do now, or no longer: the toolbar's Undo follows. */
  changed(): void;
}

let last: JustDone | null = null;

/** A comment was just resolved or deleted: the next Undo, if nothing else comes first, brings it back. */
export function justDone(done: JustDone): void {
  last = done;
  done.changed();
}

/** Whether Undo in this tab would bring back a comment just resolved or deleted. */
export function undoReopens(owner: object | null | undefined): boolean {
  return !!last && last.owner === owner;
}

/** Undo, from wherever it came: bring the comment back if that's what it undoes. False: undo as usual. */
export function undoResolve(owner: object | null | undefined): boolean {
  const was = last;
  if (!was) return false;
  forget();
  if (was.owner !== owner) return false;
  was.undo();
  return true;
}

/** The tab is closing: nothing of it is kept. */
export function forgetResolvedIn(owner: object): void {
  if (last?.owner === owner) last = null;
}

function forget(): void {
  const was = last;
  last = null;
  was?.changed();
}

const MODIFIERS = new Set(["Meta", "Shift", "Alt", "Control", "CapsLock", "Fn", "FnLock"]);
const isUndo = (e: KeyboardEvent) => e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "z";
const isRedo = (e: KeyboardEvent) => e.metaKey && !e.ctrlKey && !e.altKey && e.shiftKey && e.key.toLowerCase() === "z";

// The Markdown text's own Undo -------------------------------------------------------------
//
// The page has one Undo list for every box on it, and Undo acts only where the
// keyboard is (below). So while a comment box he had typed in was open, its
// typing sat on top of the list and Undo in the Markdown text did nothing
// until the box closed (W-1's side effect; roadmap Batch 10, item 3). The text
// keeps a list of its own here instead: each change made in it as the
// person's (typed, pasted, cut, dropped, a Tab, an option chosen, Replace) is
// a step, a run of typing one step as the page's own Undo has it, and Undo
// and Redo with the keyboard in the text go back and forward through them,
// whatever else is on the page's list. A change Corillo makes to the text
// that isn't the person's (an agent's change, the text shown afresh) starts
// the list again, as before. And once the keyboard has gone elsewhere, the
// text's typing is taken off the page's list, so it never stands in the way
// of a box's own Undo either.

/** One change: the words at `from` that were `removed`, and `inserted` in their place. */
interface TextEdit {
  from: number;
  removed: string;
  inserted: string;
}

interface TextStep {
  edits: TextEdit[];
  /** A run of typing, which the next letter typed where it left the cursor joins. */
  typing: boolean;
  /** Text dragged out, which the drop that follows joins. */
  dragged?: boolean;
}

interface TextHistory {
  done: TextStep[];
  undone: TextStep[];
  /** The text as the last step (or Corillo's own change) left it. */
  was: string;
  /** In the middle of an accent or an input method's letters: one step once it's done. */
  composing: boolean;
}

/** Enough to go back over a long session's work, never so much it grows without end. */
const MOST_STEPS = 1000;
const TYPING = new Set([
  "insertText",
  "insertLineBreak",
  "insertParagraph",
  "deleteContentBackward",
  "deleteContentForward",
  "deleteWordBackward",
  "deleteWordForward",
  "deleteSoftLineBackward",
  "deleteSoftLineForward",
  "deleteHardLineBackward",
  "deleteHardLineForward",
]);

const histories = new WeakMap<HTMLTextAreaElement, TextHistory>();
/** The text this module is changing now (its own Undo or Redo), whose changes aren't new steps. */
let applying: HTMLTextAreaElement | null = null;
/** A text with typing on the page's Undo list since it last went off it (see takeOffPageList). */
let onPageList: HTMLTextAreaElement | null = null;

/**
 * The Markdown text keeps its own Undo (above). Called once, as it's made,
 * before anything else listens to it.
 */
export function keepOwnUndo(area: HTMLTextAreaElement): void {
  const history: TextHistory = { done: [], undone: [], was: area.value, composing: false };
  histories.set(area, history);
  // Every change made to the text other than as an edit goes through these two, so none is missed: the list starts again.
  const proto = HTMLTextAreaElement.prototype;
  const value = Object.getOwnPropertyDescriptor(proto, "value")!;
  Object.defineProperty(area, "value", {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      return value.get!.call(this);
    },
    set(this: HTMLTextAreaElement, text: string) {
      value.set!.call(this, text);
      changedAside(area, history);
    },
  });
  area.setRangeText = function (this: HTMLTextAreaElement, ...args: unknown[]) {
    (proto.setRangeText as (...a: unknown[]) => void).apply(this, args);
    changedAside(area, history);
  } as HTMLTextAreaElement["setRangeText"];
  // The cursor moved since the last letter typed (a click, an arrow key): the next letter starts a step of its own.
  area.addEventListener("beforeinput", () => {
    const last = history.done.at(-1);
    if (!last?.typing) return;
    const edit = last.edits.at(-1)!;
    const at = edit.from + edit.inserted.length;
    if (area.selectionStart !== at || area.selectionEnd !== at) last.typing = false;
  });
  area.addEventListener("input", (e) => {
    onPageList = area;
    if (applying === area) return;
    if ((e as InputEvent).isComposing) {
      history.composing = true;
      return;
    }
    record(area, history, (e as InputEvent).inputType);
  });
  area.addEventListener("compositionend", () => {
    history.composing = false;
    record(area, history, "insertText");
  });
  area.addEventListener("blur", () => {
    const last = history.done.at(-1);
    if (last) last.typing = false;
  });
}

/**
 * A change made in a text as one of its own Undo steps, not part of the
 * typing beside it (B10-3): Paste and Match Style, or an agent's option
 * chosen, made with the browser's own typing command so the page follows it.
 * Typing just before it, or just after it where it left the cursor, is a
 * step of its own. Any other text box: just the change.
 */
export function asStepOfItsOwn(area: HTMLTextAreaElement, change: () => void): void {
  const history = histories.get(area);
  const before = history?.done.at(-1);
  if (before) before.typing = false;
  change();
  const made = history?.done.at(-1);
  if (made) made.typing = false;
}

/** The text's tab is closing: nothing here holds on to it (B10-4). Its own list goes with it. */
export function forgetText(area: HTMLTextAreaElement): void {
  if (onPageList === area) onPageList = null;
  if (applying === area) applying = null;
}

/** Corillo changed the text other than as the person's edit: Undo starts again from here. */
function changedAside(area: HTMLTextAreaElement, history: TextHistory): void {
  if (applying === area) return;
  history.done = [];
  history.undone = [];
  history.was = area.value;
  history.composing = false;
}

/** The person changed the text: a step, or more of the run of typing before it. */
function record(area: HTMLTextAreaElement, history: TextHistory, inputType: string): void {
  const before = history.was;
  const after = area.value;
  if (before === after) return;
  history.was = after;
  history.undone = [];
  const edit = editBetween(before, after, area.selectionEnd);
  const typing = TYPING.has(inputType);
  const last = history.done.at(-1);
  if (last?.typing && typing && joined(last.edits.at(-1)!, edit, before, after)) return;
  if (last?.dragged && inputType === "insertFromDrop") {
    last.edits.push(edit);
    last.dragged = false;
    return;
  }
  history.done.push({ edits: [edit], typing, dragged: inputType === "deleteByDrag" });
  if (history.done.length > MOST_STEPS) history.done.shift();
}

/**
 * The one stretch that differs between two texts, found from both ends.
 * Looked for first just before the cursor (`caret`, after the change), where
 * typing is, so a long text isn't read letter by letter on every key.
 */
function editBetween(a: string, b: string, caret: number): TextEdit {
  const most = Math.min(a.length, b.length);
  let from = 0;
  const surely = Math.min(most, caret - Math.max(0, b.length - a.length)) - 16;
  if (surely > 0 && a.startsWith(b.slice(0, surely))) from = surely;
  while (from < most && a.charCodeAt(from) === b.charCodeAt(from)) from++;
  const room = most - from;
  let end = 0;
  const after = Math.min(room, b.length - caret) - 16;
  if (after > 0 && a.endsWith(b.slice(b.length - after))) end = after;
  while (end < room && a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)) end++;
  return { from, removed: own(a.slice(from, a.length - end)), inserted: own(b.slice(from, b.length - end)) };
}

/**
 * `next`, made on the text `mid` that `edit` left, joined into `edit` when the
 * two touch, so the step takes the text from before `edit` straight to `end`.
 */
function joined(edit: TextEdit, next: TextEdit, mid: string, end: string): boolean {
  const editEnd = edit.from + edit.inserted.length;
  const nextEnd = next.from + next.removed.length;
  if (next.from > editEnd || nextEnd < edit.from) return false;
  const from = Math.min(edit.from, next.from);
  const to = Math.max(editEnd, nextEnd);
  edit.removed = own(mid.slice(from, edit.from) + edit.removed + mid.slice(editEnd, to));
  edit.inserted = own(end.slice(from, to + next.inserted.length - next.removed.length));
  edit.from = from;
  return true;
}

/**
 * A copy of a piece of a text that holds nothing else of it. (The engine
 * keeps a long piece cut from a text as a view of the whole text, so a step
 * would otherwise keep the whole document as it was then.)
 */
function own(piece: string): string {
  return piece.length < 13 ? piece : (JSON.parse(JSON.stringify(piece)) as string);
}

/** Undo (`back`) or Redo in the text, with the keyboard there. */
function textStep(area: HTMLTextAreaElement, history: TextHistory, back: boolean): void {
  if (area.readOnly || area.disabled || history.composing) return;
  // Changed by something that didn't say so: nothing here fits it any more.
  if (area.value !== history.was) return changedAside(area, history);
  const step = (back ? history.done : history.undone).pop();
  if (!step) return;
  step.typing = false;
  step.dragged = false;
  // Made as an edit, so everything that follows the text (the page, the save, the preview) follows this too.
  applying = area;
  try {
    for (const e of back ? [...step.edits].reverse() : step.edits) {
      const [out, put] = back ? [e.inserted, e.removed] : [e.removed, e.inserted];
      area.setSelectionRange(e.from, e.from + out.length);
      if (put) document.execCommand("insertText", false, put);
      else if (out) document.execCommand("delete");
    }
  } finally {
    applying = null;
  }
  history.was = area.value;
  (back ? history.undone : history.done).push(step);
  // The cursor as the page's own Undo leaves it: on the words brought back, or where the words taken out were.
  if (back) {
    const first = step.edits[0];
    area.setSelectionRange(first.from, first.from + first.removed.length);
  } else {
    const last = step.edits.at(-1)!;
    area.setSelectionRange(last.from + last.inserted.length, last.from + last.inserted.length);
  }
}

/**
 * The keyboard went from the text into another box: the text's typing goes
 * off the page's Undo list (the text keeps its own), so the box's Undo finds
 * the box's own typing on top. The browser lets go of a box's steps when the
 * box leaves the page, so the text is put back in its own place, where it
 * stays as it is, scrolled where it was. Anywhere else (a card, a button) it
 * stays on the list, where Edit > Undo, chosen with the mouse back in the
 * text, finds a step to start from.
 */
function takeOffPageList(now: EventTarget | null): void {
  const area = onPageList;
  if (!area || !typesIn(now) || area.contains(now)) return;
  onPageList = null;
  if (!area.isConnected || area === document.activeElement) return;
  const { scrollTop, scrollLeft } = area;
  area.parentNode!.insertBefore(area, area.nextSibling);
  area.scrollTop = scrollTop;
  area.scrollLeft = scrollLeft;
}

/** A box that takes typing: a text, a field, an editor. */
function typesIn(el: EventTarget | null): el is HTMLElement {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement || (el instanceof HTMLElement && el.isContentEditable);
}

/**
 * Edit > Undo (`back`) or Redo chosen with the mouse (src/main/editing.ts;
 * their keys go as they always have): done where the keyboard is, as the keys
 * would. A comment just resolved or deleted comes back first; the Markdown
 * text goes through its own list; the Formatted page through the editor's
 * (`formatted`, which says false when the keyboard isn't there); anywhere
 * else, the page's own Undo, which keeps to the box the keyboard is in.
 */
export function undoWhereKeyboardIs(back: boolean, owner: object | null | undefined, formatted: (back: boolean) => boolean): void {
  if (back && undoResolve(owner)) return;
  forget(); // Redo, or an Undo with no comment to bring back: something else done
  const area = document.activeElement;
  const own = area instanceof HTMLTextAreaElement ? histories.get(area) : undefined;
  if (own) return textStep(area as HTMLTextAreaElement, own, back);
  if (formatted(back)) return;
  window.corillo.menus.pageUndo(back);
}

/** Listen, for the whole window, for Undo and for anything else the person does. */
export function setUpUndoResolve(owner: () => object | null): void {
  // Ahead of everything else in the window, so Command-Z reaches no editor or box first.
  window.addEventListener(
    "keydown",
    (e) => {
      if (!last || MODIFIERS.has(e.key)) return;
      if (isUndo(e) && undoResolve(owner())) {
        e.preventDefault();
        e.stopImmediatePropagation();
      } else forget();
    },
    true,
  );
  // Edit > Undo with the keyboard in the document or a box arrives as an edit; so does typing.
  window.addEventListener(
    "beforeinput",
    (e) => {
      if (!last) return;
      if (e.inputType === "historyUndo" && undoResolve(owner())) {
        e.preventDefault();
        e.stopImmediatePropagation();
      } else forget();
    },
    true,
  );
  // With the keyboard in the Markdown text, Command-Z and Shift-Command-Z go through the text's own list (above).
  window.addEventListener(
    "keydown",
    (e) => {
      const area = document.activeElement;
      const history = area instanceof HTMLTextAreaElement ? histories.get(area) : undefined;
      if (!history || (!isUndo(e) && !isRedo(e))) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      textStep(area as HTMLTextAreaElement, history, isUndo(e));
    },
    true,
  );
  // The Markdown text's typing goes off the page's list once the keyboard is elsewhere (takeOffPageList).
  window.addEventListener("focusin", (e) => takeOffPageList(e.target), true);
  // The page has one Undo list for every box on it. With the keyboard in a
  // box (a comment, the find field), Undo and Redo act on that box alone: one
  // pressed once too often never reaches typing elsewhere (the document's, or
  // another box's), where the person isn't looking. The Markdown text has a
  // list of its own (Edit > Undo with the keyboard there arrives here).
  window.addEventListener(
    "beforeinput",
    (e) => {
      if (e.inputType !== "historyUndo" && e.inputType !== "historyRedo") return;
      const typingIn = document.activeElement;
      const own = typingIn instanceof HTMLTextAreaElement ? histories.get(typingIn) : undefined;
      if (own) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return textStep(typingIn as HTMLTextAreaElement, own, e.inputType === "historyUndo");
      }
      if (!typesIn(typingIn) || (e.target instanceof Node && typingIn.contains(e.target))) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
  // The toolbar's Undo is marked, so pressing it doesn't count as doing something else.
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (last && !(e.target instanceof Element && e.target.closest("[data-undo]"))) forget();
    },
    true,
  );
  // Edit > Undo and Redo chosen with the mouse decide for themselves (undoWhereKeyboardIs).
  window.corillo.onMenu((action) => {
    if (action !== "edit:undo" && action !== "edit:redo") forget();
  });
}
