// The toolbar: always visible, like Word's. Buttons light up for what the
// cursor is in, and grey out where they don't apply (inside a table cell, a
// heading style doesn't make sense, for example).
//
// Like goes with like, so the bar reads in groups (Orlando, 2026-11-09). First,
// the Outline button, over where the outline opens (outline.ts adds it;
// roadmap Batch 9, item 10). Then writing: Undo and Redo; the paragraph style;
// Bold, Italic and Strikethrough, which style words; the two lists; Quote and
// Code block, which make a paragraph something else; then what's put in:
// Link, the Insert menu,
// and the Table menu for the table put in. At the right, working with others
// and the document as a whole (Show changes, History and Comments are added
// by history.ts and app.ts, Export by export.ts): Comment and the Comments
// panel; Show changes and History; the two views; Export. In a narrow window
// the least used move into More (more.ts).
import type { Command, EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { undo, redo, undoDepth, redoDepth } from "prosemirror-history";
import { isInTable } from "prosemirror-tables";
import { schema } from "../core/schema";
import * as cmd from "./commands";
import { insertFootnote } from "./footnotes";
import { canInsertPicture } from "./images";
import { setColumnAlign, tableCommands } from "./tables";
import { ICONS } from "./icons";
import { PopupMenu, type MenuEntry } from "./popup-menu";
import { anchorFor, fromButton, movable } from "./more";

export type Mode = "formatted" | "markdown";

export interface ToolbarHost {
  /** The document's editor, when nobody else holds it and no old version shows (the link editor's target). */
  view: () => EditorView | null;
  /**
   * The document's state when the writing buttons apply right now, as the
   * menu bar's items do (editable.ts): null greys them out, while an agent
   * edits, a version shows, the Markdown view is on, or the keyboard is in a
   * comment box or the link editor.
   */
  writing: () => EditorState | null;
  /**
   * The document's state as the formatted view shows it, even while it can't
   * be written (an agent edits, the keyboard is in a comment box): the style
   * box keeps naming the paragraph, greyed out. Null in the Markdown view and
   * while a version or the changes show.
   */
  shown?: () => EditorState | null;
  mode: () => Mode;
  setMode: (mode: Mode) => void;
  insertPicture: () => void;
  /** Start a comment on the selection, or on the whole document. */
  addComment?: () => void;
  /** Commenting has its own rule: it stays available while an agent edits. */
  canComment?: () => boolean;
  /**
   * Undo straight after Resolve reopens the comment (undo-resolve.ts): whether
   * it would, or, with `perform`, do it (true if it did).
   */
  undoResolve?: (perform: boolean) => boolean;
}

interface ButtonSpec {
  label: string;
  shortcut?: string;
  html: string;
  run: Command;
  active?: (state: EditorState) => boolean;
  /**
   * What it does while the writing buttons don't apply (Undo straight after
   * Resolve reopens the comment, wherever the keyboard is): whether it would,
   * or, with `perform`, do it.
   */
  otherwise?: (perform: boolean) => boolean;
}

interface MenuItem {
  label: string;
  /** A document command, or an action of its own (like opening a file dialog). */
  run?: Command;
  action?: () => void;
  enabled?: (state: EditorState) => boolean;
  separatorBefore?: boolean;
}

export interface Toolbar {
  update(): void;
  openLinkEditor(): void;
}

export function createToolbar(root: HTMLElement, host: ToolbarHost): Toolbar {
  const updaters: ((state: EditorState | null) => void)[] = [];

  const exec = (command: Command) => {
    const view = host.view();
    if (!view || host.mode() !== "formatted" || !host.writing()) return;
    command(view.state, view.dispatch, view);
    view.focus();
  };
  const focusDocument = () => host.view()?.focus();
  // A greyed-out button does nothing, not even take the keyboard from where it is (a comment box, say).
  // The browser sends it no mousedown to stop, so it's stopped here.
  root.addEventListener("pointerdown", (e) => {
    if (e.target instanceof Element && e.target.closest(":disabled")) e.preventDefault();
  });

  const group = () => {
    const g = document.createElement("div");
    g.className = "tool-group";
    root.append(g);
    return g;
  };

  const button = (parent: HTMLElement, spec: ButtonSpec) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tool";
    b.innerHTML = spec.html;
    b.setAttribute("aria-label", spec.label);
    b.title = spec.shortcut ? `${spec.label} (${spec.shortcut})` : spec.label;
    b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the cursor in the document
    b.addEventListener("click", () => {
      if (!host.writing() && spec.otherwise?.(true)) return;
      exec(spec.run);
    });
    parent.append(b);
    updaters.push((state) => {
      b.disabled = state ? !spec.run(state) : !spec.otherwise?.(false);
      if (spec.active) {
        const on = !!state && spec.active(state);
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
      }
    });
    return b;
  };

  // Undo, redo
  const history = group();
  const undoButton = button(history, {
    label: "Undo",
    shortcut: "⌘Z",
    html: ICONS.undo,
    run: (s, d) => !!host.undoResolve?.(!!d) || (undoDepth(s) > 0 && undo(s, d)),
    otherwise: (perform) => !!host.undoResolve?.(perform),
  });
  undoButton.dataset.undo = ""; // pressing it isn't "something else" after a Resolve
  movable("redo", button(history, { label: "Redo", shortcut: "⇧⌘Z", html: ICONS.redo, run: (s, d) => redoDepth(s) > 0 && redo(s, d) }));

  // Paragraph style
  const styles = group();
  const select = document.createElement("select");
  select.className = "style-select";
  select.setAttribute("aria-label", "Paragraph style");
  for (const [value, label] of [
    ["paragraph", "Normal text"],
    ["h1", "Heading 1"],
    ["h2", "Heading 2"],
    ["h3", "Heading 3"],
    ["h4", "Heading 4"],
    ["", ""],
  ]) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    if (!value) o.hidden = true; // shown when the cursor is in something without a style, like a code block
    select.append(o);
  }
  select.addEventListener("change", () => exec(cmd.setStyle(select.value)));
  // The box draws its own arrow (style.css), with room on its right: the Mac's sits against the edge.
  const styleBox = document.createElement("span");
  styleBox.className = "style-box";
  styleBox.append(select);
  styles.append(styleBox);
  // In a block kept as Markdown source, the menu names it instead of a style.
  const SOURCE_NAMES: Record<string, string> = {
    "front-matter": "Document details",
    table: "Table as Markdown",
    html: "HTML",
    definitions: "Footnote",
    links: "Link definitions",
    comment: "Comment",
  };
  const other = select.lastElementChild as HTMLOptionElement;
  const LISTED = new Set(["paragraph", "h1", "h2", "h3", "h4"]);
  updaters.push((state) => {
    // While it can't be used (an agent editing, a comment being written) it
    // still names the paragraph, greyed out, so it doesn't flicker to "Style"
    // and back (roadmap Batch 11, F-14).
    const seen = state ?? host.shown?.() ?? null;
    const style = seen ? cmd.currentStyle(seen) : "";
    const kind = seen ? cmd.sourceKindAt(seen) : null;
    // The menu always says what the cursor is in, never an empty box: a block
    // kept as Markdown, a heading smaller than the menu lists, a code block, or,
    // with nothing to name (changes or a version shown, the Markdown view),
    // just what the greyed-out menu is for.
    other.textContent = !seen
      ? "Style"
      : kind
        ? (SOURCE_NAMES[kind] ?? "Markdown")
        : /^h\d$/.test(style)
          ? `Heading ${style.slice(1)}`
          : cmd.codeBlockActive(seen)
            ? /^mermaid\b/.test(String(seen.selection.$from.parent.attrs.params)) ? "Diagram" : "Code block"
            : "Style";
    select.value = LISTED.has(style) ? style : "";
    select.disabled = !state || (!cmd.setStyle("paragraph")(state) && !cmd.setStyle("h1")(state));
  });
  // In More, only if even the narrowest window had no room: the same choices as a menu of their own.
  const styleMenu = new PopupMenu(
    "Style",
    () =>
      [...select.options]
        .filter((o) => !o.hidden)
        .map((o) => ({
          label: o.textContent ?? "",
          checked: select.value === o.value,
          radio: true,
          enabled: !select.disabled,
          run: () => {
            select.value = o.value;
            select.dispatchEvent(new Event("change"));
          },
        })),
    focusDocument,
  );
  movable("style", styleBox, () => [{ label: "Style", enabled: !select.disabled, submenu: styleMenu }]);

  // Text formatting: what styles words
  const text = group();
  const m = schema.marks;
  movable("bold", button(text, { label: "Bold", shortcut: "⌘B", html: "<b>B</b>", run: cmd.toggleBold, active: (s) => cmd.markActive(s, m.strong) }));
  movable("italic", button(text, { label: "Italic", shortcut: "⌘I", html: "<i>I</i>", run: cmd.toggleItalic, active: (s) => cmd.markActive(s, m.em) }));
  movable("strikethrough", button(text, { label: "Strikethrough", shortcut: "⇧⌘X", html: "<s>S</s>", run: cmd.toggleStrike, active: (s) => cmd.markActive(s, m.strike) }));

  // Lists
  const lists = group();
  const nd = schema.nodes;
  movable("bullets", button(lists, { label: "Bulleted list", shortcut: "⇧⌘8", html: ICONS.bullets, run: cmd.toggleList(nd.bullet_list), active: (s) => cmd.listActive(s, nd.bullet_list) }));
  movable("numbers", button(lists, { label: "Numbered list", shortcut: "⇧⌘7", html: ICONS.numbers, run: cmd.toggleList(nd.ordered_list), active: (s) => cmd.listActive(s, nd.ordered_list) }));

  // Blocks: a paragraph made something else (the <> button is a code block, not code in a line)
  const blocks = group();
  movable("quote", button(blocks, { label: "Quote", html: ICONS.quote, run: cmd.toggleQuote, active: cmd.quoteActive }));
  movable("code-block", button(blocks, { label: "Code block", html: ICONS.code, run: cmd.toggleCodeBlock, active: cmd.codeBlockActive }));

  // What's put in: a link, the Insert menu, and the Table menu for a table put in
  // (Link is with them, as in the Insert menu, Word's Insert tab and Google Docs).
  const inserts = group();
  const linkButton = button(inserts, {
    label: "Link",
    shortcut: "⌘K",
    html: ICONS.link,
    run: (s) => cmd.canLink(s),
    active: (s) => !!cmd.linkAt(s) || (!s.selection.empty && cmd.markActive(s, m.link)),
  });
  linkButton.addEventListener("click", () => openLinkEditor());
  movable("link", linkButton);
  menuButton("insert", inserts, "Insert", `${ICONS.plus}<span>Insert</span>${ICONS.chevron}`, [
    { label: "Table", run: cmd.insertTable },
    { label: "Picture…", action: () => host.insertPicture(), enabled: canInsertPicture },
    { label: "Footnote", run: insertFootnote },
    { label: "Horizontal line", run: cmd.insertHorizontalLine },
  ]);
  const t = tableCommands;
  menuButton(
    "table",
    inserts,
    "Table",
    `${ICONS.table}<span>Table</span>${ICONS.chevron}`,
    [
      { label: "Add row above", run: t.addRowAbove },
      { label: "Add row below", run: t.addRowBelow },
      { label: "Add column left", run: t.addColumnLeft },
      { label: "Add column right", run: t.addColumnRight },
      { label: "Align column left", run: setColumnAlign("left"), separatorBefore: true },
      { label: "Align column center", run: setColumnAlign("center") },
      { label: "Align column right", run: setColumnAlign("right") },
      { label: "Delete row", run: t.deleteRow, separatorBefore: true },
      { label: "Delete column", run: t.deleteColumn },
      { label: "Delete table", run: t.deleteTable },
    ],
    isInTable,
  );

  // At the right, working with others: Comment, on the selected text or the
  // whole document, beside the Comments panel's button (app.ts adds it).
  // Comment, the main action, has its name on the bar wherever named buttons
  // do; the panel's button shows its icon and the count (2026-11-09 night).
  const spacer = document.createElement("div");
  spacer.className = "tool-spacer";
  root.append(spacer);
  const notes = group();
  notes.classList.add("comment-tools");
  const commentButton = button(notes, { label: "Comment", shortcut: "⌥⌘M", html: `${ICONS.comment}<span>Comment</span>`, run: () => true });
  commentButton.classList.add("tool-text");
  commentButton.addEventListener("click", () => host.addComment?.());
  updaters.push(() => {
    if (host.canComment) commentButton.disabled = !host.canComment();
  });
  movable("comment", commentButton);

  // Formatted or Markdown view (history.ts puts Show changes and History before it)
  const modes = document.createElement("div");
  modes.className = "mode-switch";
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "View");
  root.append(modes);
  const modeButtons = (["formatted", "markdown"] as const).map((mode) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = mode === "formatted" ? "Formatted" : "Markdown";
    b.title = mode === "formatted" ? "Show the document formatted" : "Show the Markdown text, with a preview";
    b.addEventListener("click", () => host.setMode(mode));
    modes.append(b);
    return { mode, b };
  });
  // In More, the two views, the one showing ticked; Command-/ goes to the other, as in the View menu.
  movable("views", modes, () =>
    modeButtons.map(({ mode, b }) => ({
      label: b.textContent ?? "",
      checked: mode === host.mode(),
      radio: true,
      shortcut: mode === host.mode() ? undefined : "⌘/",
      run: () => b.click(),
    })),
  );

  // The link editor ------------------------------------------------------
  const popover = document.createElement("form");
  popover.className = "popover link-editor";
  popover.setAttribute("role", "dialog"); // for screen readers: "Link, dialog", then its two named boxes
  popover.setAttribute("aria-label", "Link");
  popover.hidden = true;
  popover.innerHTML = `
    <label class="field link-text"><span>Text</span><input name="text" type="text" autocomplete="off"></label>
    <label class="field"><span>Link</span><input name="href" type="text" placeholder="Paste or type a web address" autocomplete="off" spellcheck="false"></label>
    <div class="popover-actions">
      <button type="button" class="remove-link">Remove link</button>
      <button type="submit" class="primary">Apply</button>
    </div>`;
  document.body.append(popover);
  const hrefInput = popover.querySelector<HTMLInputElement>('input[name="href"]')!;
  const textInput = popover.querySelector<HTMLInputElement>('input[name="text"]')!;
  const textField = popover.querySelector<HTMLElement>(".link-text")!;
  const removeButton = popover.querySelector<HTMLButtonElement>(".remove-link")!;

  // The text the link editor was opened on. If it's replaced meanwhile (an
  // agent took the document, or a change came from outside), the selection
  // it was for is gone, so the editor closes rather than link something else.
  let linkTarget: { view: EditorView; doc: EditorState["doc"] } | null = null;
  const linkTargetGone = () => {
    const view = host.view();
    return !linkTarget || view !== linkTarget.view || view.state.doc !== linkTarget.doc || host.mode() !== "formatted";
  };

  function closeLinkEditor(refocus = true) {
    popover.hidden = true;
    linkTarget = null;
    if (refocus) host.view()?.focus();
  }

  function openLinkEditor() {
    const view = host.view();
    if (!view || host.mode() !== "formatted" || !cmd.canLink(view.state)) return;
    const existing = cmd.linkAt(view.state);
    const empty = view.state.selection.empty;
    hrefInput.value = existing?.href ?? "";
    textInput.value = "";
    textField.hidden = !(empty && !existing);
    removeButton.hidden = !existing && !(!empty && cmd.markActive(view.state, schema.marks.link));
    const r = anchorFor(linkButton).getBoundingClientRect(); // under More, while Link is in there
    popover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 336))}px`;
    popover.style.top = `${r.bottom + 6}px`;
    popover.hidden = false;
    linkTarget = { view, doc: view.state.doc };
    (textField.hidden ? hrefInput : textInput).focus();
  }

  popover.addEventListener("submit", (e) => {
    e.preventDefault();
    const view = host.view();
    if (view && !linkTargetGone() && hrefInput.value.trim()) cmd.applyLink(hrefInput.value, textInput.value)(view.state, view.dispatch);
    closeLinkEditor();
  });
  removeButton.addEventListener("click", () => {
    const view = host.view();
    if (view && !linkTargetGone()) cmd.removeLink(view.state, view.dispatch);
    closeLinkEditor();
  });
  popover.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLinkEditor();
  });
  document.addEventListener("mousedown", (e) => {
    const target = e.target as globalThis.Node;
    if (!popover.hidden && !popover.contains(target) && !linkButton.contains(target)) closeLinkEditor(false);
  });

  // Menus ------------------------------------------------------------------
  function menuButton(
    name: string,
    parent: HTMLElement,
    label: string,
    html: string,
    items: MenuItem[],
    enabled?: (state: EditorState) => boolean,
  ) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tool tool-menu";
    b.innerHTML = html;
    b.setAttribute("aria-label", label);
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-expanded", "false");
    b.title = label;
    parent.append(b);
    const menu = new PopupMenu(
      label,
      (): MenuEntry[] => {
        const state = host.writing();
        return items.map((item) => ({
          label: item.label,
          separatorBefore: item.separatorBefore,
          enabled: !!state && (item.enabled ? item.enabled(state) : item.run ? item.run(state) : true),
          run: () => {
            if (item.action) item.action();
            else if (item.run) exec(item.run);
          },
        }));
      },
      focusDocument,
    );
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      if (menu.isOpen) menu.close();
      else menu.open(b, { keyboard: e.detail === 0 });
    });
    updaters.push((state) => {
      b.disabled = !state || (enabled ? !enabled(state) : false);
      if (b.disabled) menu.close();
    });
    // In More, a menu of its own, beside it.
    movable(name, b, () => [fromButton(b, menu)]);
  }

  function update() {
    const state = host.writing();
    for (const u of updaters) u(state);
    if (!popover.hidden && linkTargetGone()) closeLinkEditor(false);
    for (const { mode, b } of modeButtons) {
      b.classList.toggle("on", mode === host.mode());
      b.setAttribute("aria-pressed", String(mode === host.mode()));
    }
  }

  return { update, openLinkEditor };
}
