// Which web pictures wait for the person in each document, in the app (roadmap
// Batch 18, item 1, and its review's R18-1, R18-2 and R18-9). The list is kept
// with the document's records (store.ts); this holds what the app needs
// around it: it fails closed (records that can't be read make every web
// picture in the document wait), it remembers what couldn't be kept, and it
// tells whether a request the window makes is for an address that waits in
// an open document, so no way of drawing one can ask the web for it.
//
// The list is kept small (roadmap Batch 19, item 2, the review's R18-6): at
// most CAP addresses a document. To make room, an address is let go only when
// nothing Corillo can draw for the document still holds it (its text, every
// version in History, its comments) and it didn't come to wait while the app
// runs; when that can't be known, nothing is let go. If there still isn't
// room, every web picture in the document waits, from then on, but those he
// shows: no address is ever dropped, so none loads without his click.
import { asRequested, isWebAddress, webPicturesOfText, WAIT_CALL } from "../core/web-pictures";
import { applyOption, type ReplyOption } from "../core/options";

/** The most addresses a document's list holds. */
export const CAP = 1_000;

export interface WaitingRecords {
  /** The list kept for a document: null if its records are there but couldn't be read (damaged); throws if they can't be read now. */
  waitingPictures(id: string): string[] | null;
  changeWaitingPictures(id: string, change: { wait?: string[]; shown?: string[] }): string[];
  /** Every web picture in the document waits but these (shown): null if that isn't so. */
  everyWebPictureWaits?(id: string): string[] | null;
  markEveryWebPictureWaits?(id: string, shown: string[]): void;
}

/** The web pictures Corillo could still draw for a document (its text, History's versions, its comments): null if that can't be known now. */
export type Drawable = (id: string) => Set<string> | null;

export class WaitingPictures {
  /** What waits in the documents read since they opened, as the network would ask for them. */
  private known = new Map<string, Set<string>>();
  /** Addresses that couldn't be kept with the records (the disk full, say): they wait for as long as the app runs. */
  private unkept = new Map<string, Set<string>>();
  /** Addresses the person showed while the app runs (as requested). */
  private shown = new Set<string>();
  /** Addresses that came to wait in each document while the app runs: never let go to make room (the window may hold them in words not yet saved). */
  private recent = new Map<string, Set<string>>();

  constructor(
    private readonly records: WaitingRecords,
    /** The records' ids of the documents open now. */
    private readonly open: () => Iterable<string>,
    /** What Corillo could still draw for a document, to make room in its list. */
    private readonly drawable: Drawable = () => null,
  ) {}

  /**
   * Every web picture in the document waits but these (he showed them); null
   * if the list says which; undefined if that can't be read now. Then a tab
   * open on it is told nothing, so it keeps what it has (the review of Batch
   * 19, R19-7), and what opens or is read fails closed (everyAtOpen, of).
   */
  everyBut(id: string): string[] | null | undefined {
    try {
      return this.records.everyWebPictureWaits?.(id) ?? null;
    } catch (err) {
      console.error("Couldn't read whether every web picture waits.", err);
      return undefined;
    }
  }

  /** What a tab opening on the document is told: if it can't be read now, every web picture waits. */
  everyAtOpen(id: string): string[] | null {
    const every = this.everyBut(id);
    return every === undefined ? [] : every;
  }

  /**
   * The web pictures that wait in a document, from its records. If they can't
   * be read, every web picture in its text waits (kept so, where that can be),
   * rather than none.
   */
  of(id: string, text: string): string[] {
    let list: string[] | null = null;
    try {
      list = this.records.waitingPictures(id);
    } catch (err) {
      console.error("Couldn't read which web pictures wait, so every one in the document does.", err);
    }
    if (list === null) {
      list = [...webPicturesOfText(text)];
      if (list.length) this.keep(id, { wait: list });
    }
    let all = [...new Set([...list, ...(this.unkept.get(id) ?? [])])];
    const every = this.everyAtOpen(id);
    if (every) all = [...new Set([...all, ...webPicturesOfText(text)])].filter((a) => !every.includes(a));
    this.remember(id, all);
    return all;
  }

  /** Change which wait in a document: kept with its records, within the cap, and known here at once. */
  change(id: string, change: { wait?: string[]; shown?: string[] }): void {
    if (change.wait?.length) {
      const recent = this.recent.get(id) ?? new Set<string>();
      for (const a of change.wait) recent.add(a);
      this.recent.set(id, recent);
    }
    const every = this.everyBut(id);
    if (every) this.keepEvery(id, every, change);
    else this.keepWithin(id, change);
    const now = this.known.get(id) ?? new Set<string>();
    for (const a of change.wait ?? []) {
      const asked = asRequested(a);
      if (asked) now.add(asked);
    }
    for (const a of change.shown ?? []) {
      const asked = asRequested(a);
      if (asked) {
        now.delete(asked);
        this.shown.add(asked);
      }
      this.unkept.get(id)?.delete(a);
    }
    this.hold(id, now);
  }

  /**
   * The file Save Somewhere Else leaves where it was is a document of its own
   * from then on (the review of Batch 19, R19-4): it gets the same web
   * pictures waiting as the document had, what couldn't be kept with the
   * records among them, and "every web picture waits" if the document had
   * that. If which wait can't be read, every web picture in it waits, and
   * every one in the document's own text (`fromText`) still waits for the
   * document too, as of() would have made it (the review of Batch 20, R20-1:
   * a damaged list is set aside at its first read, so this read is the one
   * that must fail closed).
   */
  leftBehind(fromId: string, toId: string, fromText: string): void {
    if (fromId === toId) return; // the records didn't move: the old path is still this document
    let list: string[] | null = null;
    try {
      list = this.records.waitingPictures(fromId);
    } catch (err) {
      console.error("Couldn't read which web pictures wait, so every one in the file left behind does.", err);
    }
    if (list === null) {
      const own = [...webPicturesOfText(fromText)];
      if (own.length) this.keep(fromId, { wait: own });
    }
    const every = this.everyBut(fromId);
    const wait = list && [...new Set([...list, ...(this.unkept.get(fromId) ?? [])])];
    if (!wait || every === undefined || wait.length > CAP) return this.everyWaits(toId, [], wait ?? []);
    if (wait.length) this.keep(toId, { wait });
    if (every) this.everyWaits(toId, every, wait);
  }

  /** Every web picture in the document waits but these (shown); if that can't be kept, the list is, as far as it's known. */
  private everyWaits(id: string, shown: string[], wait: string[]): void {
    try {
      this.records.markEveryWebPictureWaits!(id, shown);
    } catch (err) {
      console.error("Couldn't mark that every web picture waits, so the list is kept instead.", err);
      if (wait.length) this.keep(id, { wait });
    }
  }

  /**
   * Whether a request the window makes is for an address that waits in a
   * document open now. One the person showed goes, wherever else it waits: it
   * has gone to that site already, by his click.
   */
  blocks(url: string): boolean {
    const asked = asRequested(url);
    if (!asked || this.shown.has(asked)) return false;
    for (const id of this.open()) if (this.known.get(id)?.has(asked)) return true;
    return false;
  }

  /** How many documents' lists are held here (for the leak checks). */
  held(): number {
    return this.known.size;
  }

  /**
   * Kept in the list, if there's room in it, or once addresses nothing can
   * draw any more are let go; otherwise every web picture in the document
   * waits from now on, and the list stays as it is.
   */
  private keepWithin(id: string, change: { wait?: string[]; shown?: string[] }): void {
    let list: string[] | null = null;
    try {
      list = change.wait?.length ? this.records.waitingPictures(id) : null;
    } catch {
      list = null; // keep() holds it while the app runs
    }
    if (list) {
      const shown = new Set(change.shown ?? []);
      const after = [...new Set([...list, ...change.wait!])].filter((a) => !shown.has(a));
      if (after.length > CAP) {
        const drop = this.undrawable(id, after);
        if (after.length - drop.length > CAP) {
          try {
            this.records.markEveryWebPictureWaits!(id, []);
            if (change.shown?.length) this.keep(id, { shown: change.shown });
            return;
          } catch (err) {
            console.error("Couldn't mark that every web picture waits, so the list grows instead.", err);
          }
        } else if (drop.length) return this.keep(id, { wait: change.wait, shown: [...(change.shown ?? []), ...drop] });
      }
    }
    this.keep(id, change);
  }

  /** Every web picture already waits: the list isn't added to; one he shows is kept as shown, and one added again waits again. */
  private keepEvery(id: string, every: string[], change: { wait?: string[]; shown?: string[] }): void {
    const shown = new Set([...every, ...(change.shown ?? [])]);
    for (const a of change.wait ?? []) shown.delete(a);
    try {
      this.records.markEveryWebPictureWaits!(id, [...shown]);
    } catch (err) {
      console.error("Couldn't keep which web pictures he showed.", err);
    }
    if (change.shown?.length) this.keep(id, { shown: change.shown });
  }

  /** Of these addresses, those nothing Corillo can draw for the document holds any more, that didn't come to wait while the app runs. None if that can't be known. */
  private undrawable(id: string, addresses: string[]): string[] {
    let held: Set<string> | null = null;
    try {
      held = this.drawable(id);
    } catch (err) {
      console.error("Couldn't tell which web pictures can still be drawn, so none is let go.", err);
    }
    if (!held) return [];
    const recent = this.recent.get(id);
    const unkept = this.unkept.get(id);
    return addresses.filter((a) => !held.has(a) && !recent?.has(a) && !unkept?.has(a));
  }

  private keep(id: string, change: { wait?: string[]; shown?: string[] }): void {
    try {
      this.records.changeWaitingPictures(id, change);
    } catch (err) {
      console.error("Couldn't keep which web pictures wait.", err); // held here instead, while the app runs
      if (change.wait?.length) {
        const kept = this.unkept.get(id) ?? new Set<string>();
        for (const a of change.wait) kept.add(a);
        this.unkept.set(id, kept);
      }
    }
  }

  /** Known for this document, as requested. */
  private remember(id: string, addresses: string[]): void {
    const set = new Set<string>();
    for (const a of addresses) {
      const asked = asRequested(a);
      if (asked) set.add(asked);
    }
    this.hold(id, set);
  }

  /** Held for this document; documents no longer open are let go. */
  private hold(id: string, set: Set<string>): void {
    this.known.set(id, set);
    const open = new Set(this.open());
    for (const known of this.known.keys()) if (known !== id && !open.has(known)) this.known.delete(known);
    for (const recent of this.recent.keys()) if (recent !== id && !open.has(recent)) this.recent.delete(recent);
  }
}

/**
 * The addresses the window says wait in a copy it pasted into one of its
 * documents (roadmap Batch 19, item 1), checked here, in the app: an array of
 * strings within WAIT_CALL's limits, or nothing at all; of those, every
 * address the window would ask the web for is kept (isWebAddress, as the rest
 * of the list reads them: `https:host/x.png` too, the review of Batch 19,
 * R19-1). They can only be added to a document's
 * list: nothing the window sends takes one off or shows a picture, so a mark
 * forged in a paste could only make a picture wait.
 */
export function copiedToWait(addresses: unknown): string[] {
  if (!Array.isArray(addresses) || addresses.length > WAIT_CALL.addresses) return [];
  let size = 0;
  for (const a of addresses) {
    if (typeof a !== "string") return [];
    size += a.length;
  }
  if (size > WAIT_CALL.characters) return [];
  return [...new Set((addresses as string[]).filter(isWebAddress))];
}

/**
 * The web pictures the options on a document's replies would put in it, each
 * read as applied to the text, as he would choose it: a picture an option
 * writes by reference (![c][r]) takes its address from the text (the review
 * of Batch 19, R19-10). An option that no longer fits the text adds nothing.
 */
export function picturesOfOptions(text: string, threads: { messages: { options?: ReplyOption[] }[] }[]): Set<string> {
  const found = new Set<string>();
  for (const thread of threads)
    for (const message of thread.messages)
      for (const option of message.options ?? []) {
        const applied = applyOption(text, option);
        if (applied.ok) for (const a of webPicturesOfText(applied.text)) found.add(a);
      }
  return found;
}
