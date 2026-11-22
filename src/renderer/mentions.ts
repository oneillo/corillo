// @ to name an agent in a comment, the way people mention a colleague in Word,
// Google Docs or Slack. Every comment box (a new comment, a whole-document
// comment, a reply, an edit) gets it: typing @ opens a small list of agents
// just under it, those connected to Corillo right now first; picking one
// writes @Name, shown as a tag in the agent's colour; and the first agent a
// comment names is the one it's for. Typing the name by hand counts too, and
// deleting the tag takes the direction away.
//
// The box stays a plain text box. A layer behind it, laid out exactly like its
// text, draws the tags' colour, so typing stays as quick as before: the layer
// is drawn again only while there's a tag or the list is open. The rules
// (what counts as a tag, what the list offers) are in src/core/mentions.ts.
import type { AgentColour } from "../core/agents";
import type { Message } from "../core/comments";
import {
  baseName,
  filterChoices,
  findTags,
  mentionChoices,
  namedAgents,
  typingAt,
  type Choice,
  type KnownAgent,
  type Tag,
} from "../core/mentions";
import type { CorilloApi } from "../preload/preload";

/** What a comment box needs to know about the agents. */
export interface MentionSource {
  api: CorilloApi;
  /** The agents on the document, the default marked. */
  onDoc(): { name: string; isDefault: boolean }[];
  /** Agents this document's comments name (who wrote them, whom they were for). */
  named(): string[];
  colourOf(name: string): AgentColour;
}

export interface MentionOptions {
  /** A reply hands the comment to the agent it names; the note says so. */
  kind: "comment" | "reply" | "edit";
  /** For a reply: the agent the comment is for now. */
  current?: () => string | null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

/** "A", "A and B", "A, B and C". */
const andList = (names: string[]) =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

// The agents Corillo knows, from every document: connected now, or met before ----------

let known: KnownAgent[] = [];
let listening = false;
/**
 * Every comment box with the @ list, to tell when the agents change. Held
 * loosely: a box that's gone (its comment posted, resolved or deleted, its
 * document closed) is let go of, not kept here until an agent next comes or goes.
 */
const fields = new Set<WeakRef<MentionField>>();
const watchers = new Set<() => void>();

function keepField(field: MentionField): void {
  for (const ref of fields) if (!ref.deref()) fields.delete(ref);
  fields.add(new WeakRef(field));
}

/** Learn the agents Corillo knows, and hear when that changes (no asking again and again). Call once a document is open. */
export function listenForAgents(api: CorilloApi): void {
  if (listening) return;
  listening = true;
  let heard = false;
  const take = (agents: KnownAgent[]) => {
    known = Array.isArray(agents)
      ? agents.filter((a) => a && typeof a.name === "string").map((a) => ({ name: a.name, connected: a.connected === true }))
      : [];
    refreshMentionFields();
    for (const watch of watchers) watch();
  };
  // The list as it is now, unless news of a change came first.
  void api.knownAgents().then((agents) => heard || take(agents), () => {});
  api.onKnownAgents((agents) => {
    heard = true;
    take(agents);
  });
}

/** Hear when an agent connects, leaves or is seen (a comment waiting for it says so). */
export function whenAgentsChange(watch: () => void): void {
  watchers.add(watch);
}

/** This agent (or one of its name on another document: Claude 2 is Claude) is connected to Corillo right now. */
export function isConnected(name: string): boolean {
  const key = baseName(name, known.map((a) => a.name)).toLocaleLowerCase();
  return known.some((a) => a.connected && a.name.toLocaleLowerCase() === key);
}

/** The agents changed (one arrived or left, or was remembered): boxes draw their tags again, and an open list follows. */
export function refreshMentionFields(): void {
  for (const ref of fields) {
    const f = ref.deref();
    if (!f) fields.delete(ref);
    else if (f.input.isConnected) f.agentsChanged();
  }
}

// The list -----------------------------------------------------------------------------

/** One list for the whole window: only one box has the keyboard at a time. */
class MentionList {
  readonly el: HTMLElement;
  /** Says how many agents the list holds as it opens or narrows, for a screen reader (Batch 24, K-15). */
  private readonly count: HTMLElement;
  private owner: MentionField | null = null;
  private shown: Choice[] = [];
  private active = 0;
  private readonly onScroll = () => this.owner?.placeList();

  constructor() {
    this.el = el("div", "mention-list");
    this.el.id = "mention-list";
    this.el.setAttribute("role", "listbox");
    this.el.setAttribute("aria-label", "Agents");
    this.el.hidden = true;
    // Clicking in the list keeps the cursor in the comment box.
    this.el.addEventListener("mousedown", (e) => e.preventDefault());
    this.count = el("span", "mention-count");
    this.count.setAttribute("role", "status");
    document.body.append(this.el, this.count);
  }

  get openFor(): MentionField | null {
    return this.el.hidden ? null : this.owner;
  }

  get choices(): Choice[] {
    return this.shown;
  }

  show(owner: MentionField, choices: Choice[], connect: () => void): void {
    // A list that opens afresh starts at the top.
    if (this.owner !== owner || this.el.hidden) this.shown = [];
    const same = this.owner === owner && !this.el.hidden && sameChoices(this.shown, choices);
    this.owner = owner;
    if (!same) {
      const was = this.shown[this.active]?.name;
      this.shown = choices;
      const keep = choices.findIndex((c) => c.name === was);
      this.active = keep >= 0 ? keep : 0;
      this.draw(connect);
      const n = choices.length;
      this.count.textContent = n ? `${n === 1 ? "1 agent" : `${n} agents`}. Up and Down to choose.` : "No agents";
    }
    if (this.el.hidden) {
      this.el.hidden = false;
      addEventListener("scroll", this.onScroll, true);
      addEventListener("resize", this.onScroll);
    }
    owner.expanded(true, this.activeId());
  }

  hide(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    removeEventListener("scroll", this.onScroll, true);
    removeEventListener("resize", this.onScroll);
    this.owner?.expanded(false, null);
    // Nothing kept of the box it was for, so a closed document is let go of.
    this.owner = null;
    this.el.replaceChildren();
    this.count.textContent = "";
  }

  move(by: number): void {
    if (!this.shown.length) return;
    this.active = (this.active + by + this.shown.length) % this.shown.length;
    this.el.querySelectorAll<HTMLElement>("[role='option']").forEach((o, i) => o.setAttribute("aria-selected", String(i === this.active)));
    this.el.querySelector<HTMLElement>("[aria-selected='true']")?.scrollIntoView({ block: "nearest" });
    this.owner?.expanded(true, this.activeId());
  }

  get picked(): Choice | null {
    return this.shown[this.active] ?? null;
  }

  private activeId(): string | null {
    return this.shown.length ? `mention-option-${this.active}` : null;
  }

  private draw(connect: () => void): void {
    const owner = this.owner!;
    const rows: HTMLElement[] = [];
    if (!this.shown.length) {
      // Corillo knows no agents at all yet.
      const none = el("div", "mention-empty");
      const link = el("button", "link-button mention-connect", "Connect your agents");
      link.type = "button";
      link.addEventListener("click", () => {
        this.hide();
        connect();
      });
      none.append(el("span", "", "Corillo hasn't met any agents yet."), link);
      rows.push(none);
    }
    let group: boolean | null = null;
    this.shown.forEach((c, i) => {
      if (c.connected !== group) {
        group = c.connected;
        const label = el("div", "mention-group", c.connected ? "Connected" : "Not connected");
        label.setAttribute("aria-hidden", "true");
        rows.push(label);
      }
      const row = el("div", c.connected ? "mention-option connected" : "mention-option");
      row.id = `mention-option-${i}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === this.active));
      row.setAttribute("aria-label", [c.name, c.connected ? "connected" : "not connected", ...(c.isDefault ? ["default"] : [])].join(", "));
      row.title = c.connected
        ? `${c.name} is connected to Corillo now.`
        : `${c.name} isn't connected right now. A comment for it waits until it is.`;
      const badge = el("span", "mention-badge", (c.name || "A").slice(0, 1).toUpperCase());
      badge.style.setProperty("--tag", `var(--agent-${owner.colourOf(c.name)})`);
      badge.setAttribute("aria-hidden", "true");
      // A connected agent's badge has a dot, as people show who's online in a chat app.
      if (c.connected) badge.append(el("span", "mention-dot"));
      row.append(badge, el("span", "mention-name", c.name));
      if (c.isDefault) row.append(el("span", "mention-default", "Default"));
      row.addEventListener("click", () => owner.pick(c));
      rows.push(row);
    });
    this.el.replaceChildren(...rows);
  }

  /**
   * Put the list just under the @, or above it when the box is near the
   * bottom of the window, so it's always seen whole. In a window too short for
   * all of it either way, it takes the bigger side and scrolls inside.
   */
  place(at: DOMRect): void {
    const margin = 8;
    const gap = 4;
    this.el.style.maxHeight = "";
    let box = this.el.getBoundingClientRect();
    const below = innerHeight - margin - (at.bottom + gap);
    const above = at.top - gap - margin;
    const up = box.height > below && above > below;
    const room = Math.max(0, Math.floor(up ? above : below));
    if (box.height > room) {
      this.el.style.maxHeight = `${room}px`;
      box = this.el.getBoundingClientRect();
    }
    const top = up ? at.top - gap - box.height : at.bottom + gap;
    const left = Math.max(margin, Math.min(at.left - 4, innerWidth - box.width - margin));
    this.el.classList.toggle("above", up);
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(top)}px`;
  }
}

const sameChoices = (a: Choice[], b: Choice[]) =>
  a.length === b.length && a.every((c, i) => c.name === b[i].name && c.connected === b[i].connected && c.isDefault === b[i].isDefault);

let list: MentionList | null = null;
const theList = () => (list ??= new MentionList());

// A comment box --------------------------------------------------------------------------

export class MentionField {
  /** The box and everything with it: put this where the text box would go. */
  readonly el: HTMLElement;
  private readonly box: HTMLElement;
  private readonly layer: HTMLElement;
  private readonly note: HTMLElement;
  private tags: Tag[] = [];
  /** The @ the person closed the list on with Escape: it stays closed for that one. */
  private dismissed: number | null = null;
  /** The @ the list is showing names for. */
  private typing: { start: number; query: string } | null = null;
  private drawn = "";

  constructor(
    readonly input: HTMLTextAreaElement,
    private readonly source: MentionSource,
    private readonly options: MentionOptions,
  ) {
    listenForAgents(source.api);
    this.el = el("div", "mention-field");
    this.box = el("div", "mention-box");
    this.layer = el("div", "mention-layer");
    this.layer.setAttribute("aria-hidden", "true");
    this.note = el("p", "mention-note");
    this.note.hidden = true;
    this.box.append(this.layer, input);
    this.el.append(this.box, this.note);
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-haspopup", "listbox");

    input.addEventListener("input", () => this.update());
    input.addEventListener("keyup", (e) => {
      if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") this.update();
    });
    input.addEventListener("mouseup", () => this.update());
    input.addEventListener("focus", () => this.update());
    input.addEventListener("blur", () => {
      if (theList().openFor === this) theList().hide();
    });
    // Before the box's own keys (Return posts, Escape leaves): while the list is open, it has them.
    this.box.addEventListener("keydown", (e) => this.key(e), true);
    keepField(this);
    this.refresh();
  }

  /** Every agent name that counts as a tag here. */
  private names(): string[] {
    return this.choices().map((c) => c.name);
  }

  private choices(): Choice[] {
    return mentionChoices(this.source.onDoc(), known, this.source.named());
  }

  colourOf(name: string): AgentColour {
    return this.source.colourOf(name);
  }

  /** The tags in some words (most words have no @, and need no looking). */
  private tagsIn(text: string): Tag[] {
    return text.includes("@") ? findTags(text, this.names()) : [];
  }

  /** The agent this box's words are for: the first one they name with @, or null. */
  mention(): string | null {
    return this.tagsIn(this.input.value)[0]?.name ?? null;
  }

  /** The words or the agents changed: draw the tags and the note again. */
  refresh(): void {
    this.tags = this.tagsIn(this.input.value);
    this.draw();
    this.updateNote();
  }

  private update(): void {
    this.refresh();
    this.updateList();
  }

  /** An agent connected, left or was remembered: a name may now be a tag, and an open list shows who's connected now. */
  agentsChanged(): void {
    this.refresh();
    if (theList().openFor === this) this.updateList();
  }

  /** The tags that direct the comment: those naming its first agent. Others are plain words. */
  private directing(): Tag[] {
    const first = this.tags[0]?.name;
    return first ? this.tags.filter((t) => t.name === first) : [];
  }

  /** The layer behind the words: each tag's colour, and a mark at the @ being typed (to put the list under it). */
  private draw(): void {
    const text = this.input.value;
    const tags = this.directing();
    const at = this.typing && theList().openFor === this ? this.typing.start : -1;
    const key = tags.length || at >= 0 ? JSON.stringify([text, tags.map((t) => [t.start, t.end, t.name]), at]) : "";
    if (key === this.drawn) return;
    this.drawn = key;
    if (!key) {
      this.layer.replaceChildren();
      return;
    }
    const parts: Node[] = [];
    let from = 0;
    const plain = (to: number) => {
      if (at >= from && at <= to) {
        if (at > from) parts.push(document.createTextNode(text.slice(from, at)));
        parts.push(el("span", "mention-at"));
        if (to > at) parts.push(document.createTextNode(text.slice(at, to)));
      } else if (to > from) parts.push(document.createTextNode(text.slice(from, to)));
      from = to;
    };
    for (const t of tags) {
      plain(t.start);
      const mark = el("mark", "mention-tag");
      mark.style.setProperty("--tag", `var(--agent-${this.colourOf(t.name)})`);
      mark.append(el("span", "", text.slice(t.start, t.end)));
      parts.push(mark);
      from = t.end;
    }
    plain(text.length);
    // A last empty line needs something on it to be laid out like the box's.
    if (text.endsWith("\n")) parts.push(document.createTextNode("\u200B"));
    this.layer.replaceChildren(...parts);
  }

  /** A line under the box when there's more to say: a second agent, or a reply handing the comment over. */
  private updateNote(): void {
    const named = namedAgents(this.tags);
    let text = "";
    if (named.length > 1) {
      text = `Goes to ${named[0]} only. A comment goes to one agent, so start another one for ${andList(named.slice(1))}.`;
    } else if (named.length === 1 && this.options.kind === "reply" && this.options.current?.() !== named[0]) {
      text = `Hands this comment to ${named[0]}.`;
    }
    if (this.note.textContent !== text) this.note.textContent = text;
    this.note.hidden = !text;
  }

  // The list ------------------------------------------------------------------------------

  private updateList(): void {
    const input = this.input;
    const caret = input.selectionStart === input.selectionEnd ? input.selectionStart : -1;
    const typing = caret >= 0 && document.activeElement === input ? typingAt(input.value, caret) : null;
    if (this.dismissed !== null && typing?.start !== this.dismissed) this.dismissed = null;
    if (!typing && theList().openFor !== this && !this.typing) return;
    const all = typing ? this.choices() : [];
    const shown = typing ? filterChoices(all, typing.query) : [];
    // Nothing to offer for what's typed (a space after a name, say), or the name is already whole: no list.
    // With no agents known, it says so.
    const whole = shown.length === 1 && typing !== null && shown[0].name.toLocaleLowerCase() === typing.query.toLocaleLowerCase();
    const open = !!typing && this.dismissed === null && !whole && (shown.length > 0 || (!all.length && !/\s/.test(typing.query)));
    this.typing = open ? typing : null;
    if (!open) {
      if (theList().openFor === this) theList().hide();
      this.draw();
      return;
    }
    theList().show(this, shown, () => void this.source.api.agents.showConnect());
    this.draw();
    this.placeList();
  }

  /** Keep the list under the @ (the page scrolled, or the box moved). */
  placeList(): void {
    const mark = this.layer.querySelector(".mention-at");
    if (!mark || !this.input.isConnected) {
      theList().hide();
      return;
    }
    theList().place(mark.getBoundingClientRect());
  }

  /**
   * The list is open or closed for this box, with this option chosen (for
   * screen readers). The box stays a text box: it says which list it opened
   * and the option chosen in it, but not "expanded", which a text box can't be.
   */
  expanded(open: boolean, active: string | null): void {
    if (open) this.input.setAttribute("aria-controls", "mention-list");
    else this.input.removeAttribute("aria-controls");
    if (active) this.input.setAttribute("aria-activedescendant", active);
    else this.input.removeAttribute("aria-activedescendant");
    if (!open) this.draw();
  }

  /** Write @Name in place of the @ and what's typed after it, and carry on after it. */
  pick(choice: Choice): void {
    const input = this.input;
    const typing = this.typing;
    if (!typing) return;
    const text = input.value;
    let end = input.selectionStart;
    while (end < text.length && /[\p{L}\p{N}_]/u.test(text[end])) end++; // the rest of a word the cursor was in
    const space = end < text.length && /\s/.test(text[end]);
    input.focus();
    input.setSelectionRange(typing.start, end);
    // As typing, so Undo takes it back and the box hears of it.
    document.execCommand("insertText", false, `@${choice.name}${space ? "" : " "}`);
    if (space) input.setSelectionRange(input.selectionStart + 1, input.selectionStart + 1);
    theList().hide();
    this.update();
  }

  private key(e: KeyboardEvent): void {
    if (e.isComposing) return;
    const list = theList();
    if (list.openFor === this) {
      const options = list.choices.length > 0;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!options) return;
        list.move(e.key === "ArrowDown" ? 1 : -1);
      } else if ((e.key === "Enter" || e.key === "Tab") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const picked = list.picked;
        if (!picked) {
          list.hide();
          return;
        }
        this.pick(picked);
      } else if (e.key === "Escape") {
        // The list closes; the @ stays as typed.
        this.dismissed = this.typing?.start ?? null;
        list.hide();
      } else return this.deleteTag(e);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    this.deleteTag(e);
  }

  private deleteTag(e: KeyboardEvent): void {
    // A tag goes in one keystroke, like a name in Word or Google Docs, and with it the direction.
    if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey && !e.altKey && !e.ctrlKey) {
      const input = this.input;
      if (input.selectionStart !== input.selectionEnd) return;
      const at = input.selectionStart;
      const tag = this.directing().find((t) => (e.key === "Backspace" ? t.end === at : t.start === at));
      if (!tag) return;
      e.preventDefault();
      e.stopPropagation();
      input.setSelectionRange(tag.start, tag.end);
      document.execCommand("delete");
    }
  }
}

/** Give a comment box the @ list and tags. Put the result's `el` where the box goes. */
export function mentionField(input: HTMLTextAreaElement, source: MentionSource, options: MentionOptions): MentionField {
  return new MentionField(input, source, options);
}

/**
 * A posted message's words, with the agent it was for shown as a tag in that
 * agent's colour. Other @ names stay plain words, as they did in the box.
 */
export function messageBody(m: Pick<Message, "body" | "mention">, colourOf: (name: string) => AgentColour): HTMLElement {
  const body = el("div", "comment-body");
  const tags = m.mention ? findTags(m.body, [m.mention]) : [];
  if (!tags.length) {
    body.textContent = m.body;
    return body;
  }
  let from = 0;
  for (const t of tags) {
    if (t.start > from) body.append(m.body.slice(from, t.start));
    const tag = el("span", "mention-tag", m.body.slice(t.start, t.end));
    tag.style.setProperty("--tag", `var(--agent-${colourOf(t.name)})`);
    body.append(tag);
    from = t.end;
  }
  if (from < m.body.length) body.append(m.body.slice(from));
  return body;
}
