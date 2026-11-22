// One open document: its formatted editor, its Markdown view with a preview,
// autosave, and what happens when its file changes outside Corillo.
//
// The formatted editor holds where each comment is, in both views. In the
// Markdown view it's kept up to date with the text a moment after typing
// stops, changing only what was typed, so comments stay on their words; the
// preview shows that same document, with the comments' highlights, and the
// text shows them on a layer behind it (source-marks.ts).
import { shownName } from "../core/doc-names";
import { EditorState, Plugin, Selection, TextSelection, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { history, undo, redo, closeHistory } from "prosemirror-history";
import { baseKeymap, chainCommands, exitCode } from "prosemirror-commands";
import { liftListItem, sinkListItem } from "prosemirror-schema-list";
import { splitItem, taskInputRule, tasksPlugin } from "./tasks";
import { inputRules, wrappingInputRule, textblockTypeInputRule, undoInputRule } from "prosemirror-inputrules";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { schema } from "../core/schema";
import { findAnchor, posAt, textIndex } from "../core/anchors";
import { serializeMarkdown, type Source } from "../core/markdown";
import { editTo, textChanges, type TextChange } from "../core/smallest-edit";
import { undoThrough } from "../core/undo-through";
import { asStepOfItsOwn } from "./undo-resolve";
import { forgetParsed, parseCached } from "./parse-cache";
import { wordCount } from "../core/words";
import { inCalls, isWebAddress } from "../core/web-pictures";
import { forTextArea } from "../core/text-area";
import type { CloseChoice, CorilloApi, DocInfo, MissingKind, NewPlace, RenameResult, SaveResult } from "../preload/preload";
import * as cmd from "./commands";
import { tableKeys, tableBehaviour, gapBelowEnd } from "./tables";
import { tableTextPlugin } from "./table-highlight";
import { docPlace, docRange, inView, markdownPlace, viewText, type Span } from "../core/place";
import { textEdit } from "../core/source-marks";
import { commentRanges, withRanges, DRAFT } from "./comments";
import { changeMarks, withChanges } from "./change-marks";
import { footnotePlugin } from "./footnotes";
import { EmbeddedPictures, lookForEmbedsAgain, obsidianPlugin } from "./obsidian";
import { lineBreaksPlugin } from "./line-breaks";
import { ImageView, lookAtPicturesAgain, picturePlugin, picturesWaitingChanged, movedAddress, waitingPictureKeys, type PictureStore } from "./images";
import { DiagramView, isDiagram, diagramCursorPlugin, diagramsWaitingChanged } from "./diagrams";
import { everydayPlugins } from "./everyday";
import type { Mode } from "./toolbar";
import { DocComments } from "./comments-panel";
import { toShownPage } from "./comments-panel-keyboard";
import { lineUpPanels, sideHandle } from "./columns";
import { lineNumbersPlugin, lineNumbersShown, onlyLineNumbers } from "./line-numbers";
import { sourceReplaced } from "./find";
import { blankLinesPlugin, emptyLineOutOfQuote, joinOverBlankLine, joinOverBlankLineForward } from "./blank-lines";
import { forTests } from "./for-tests";
import { checkSave, type SaveCheck } from "../core/write-check";
import { noticeOn } from "./file-notice";
import { addressOfLinkIn } from "./link-labels";
import { forgetWords } from "../core/change-links";
import { fromTheText, markAsFromTheText, readAs, replaceBlocks, replaceChanged, throughTexts } from "./doc-tab-edits";
import { MarkdownView } from "./doc-tab-markdown";
import { elWith } from "./el-with";
import { draftMoves, draftPlace, emptyLineIn, mapOffset, selectionPlace, whatsInSight, returnTo, revealIn, touches } from "./doc-tab-place";

const SAVE_DELAY_MS = 400;
const SAVE_AT_LEAST_EVERY_MS = 1600;
const RETRY_MS = 5000;
/** The status bar's reason when the safety net held a save back (roadmap Batch 14, item 1). */
const HELD_BACK = "the file would have lost words";
const HELD_BACK_NOTICE = "Corillo didn't save your latest changes: the file would have lost some of your words";
const n = schema.nodes;

export type SaveState = "saved" | "pending" | "conflict" | "missing" | "trashed" | "recovered" | "error";

/** Why saving waits for the person to choose, and what the notice offers. */
type Hold = "conflict" | "missing" | "trashed" | "recovered";
const HOLDS: Record<Hold, { message: string; first: string; second: string }> = {
  conflict: {
    message: "This document was changed outside Corillo while you had edits that weren't saved yet.",
    first: "Keep my version",
    second: "Use the other version",
  },
  recovered: {
    message: "Corillo brought back changes to this document that weren't saved when it last closed.",
    first: "Keep my changes",
    second: "Use the saved version",
  },
  missing: {
    message: "This document was moved or deleted outside Corillo. Your text is still here.",
    first: "Save it where it was",
    second: "Save somewhere else…",
  },
  trashed: {
    message: "This document was moved to the Trash. Your latest changes are only here.",
    first: "Save somewhere else…",
    second: "Close",
  },
};

/** Why the file can't be found, in the notice and the status bar. */
const MISSING: Record<MissingKind, { message: string; problem: string }> = {
  deleted: { message: "This document was deleted outside Corillo. Your text is still here.", problem: "the file was deleted" },
  away: {
    message: "The drive or cloud folder this document is on isn't available. Your text is still here.",
    problem: "its drive or cloud folder isn't available",
  },
  unknown: { message: HOLDS.missing.message, problem: "the file was moved or deleted" },
};

/** What a tab needs from the window around it. */
export interface TabHost {
  api: CorilloApi;
  /** The tab's state, words or save status changed. */
  changed(tab: DocTab): void;
  /** The tab's document now has another name or place. */
  renamed?(tab: DocTab): void;
  /** Close the tab, as the person would (asking first if that would lose words). */
  close?(tab: DocTab): void;
  openLinkEditor(): void;
}

const hardBreak = chainCommands(exitCode, (state, dispatch) => {
  dispatch?.(state.tr.replaceSelectionWith(n.hard_break.create()).scrollIntoView());
  return true;
});

// Typing Markdown shortcuts at the start of a line formats it, as Word does
// with "1. " and "- ".
const markdownShortcuts = () =>
  inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,4})\s$/, n.heading, (m) => ({ level: m[1].length })),
      wrappingInputRule(/^\s*([-+*])\s$/, n.bullet_list, (m) => ({ bullet: m[1] })),
      wrappingInputRule(
        /^(\d+)([.)])\s$/,
        n.ordered_list,
        (m) => ({ order: Number(m[1]), delim: m[2] }),
        (m, node) => node.childCount + node.attrs.order === Number(m[1]),
      ),
      wrappingInputRule(/^\s*>\s$/, n.blockquote),
      textblockTypeInputRule(/^```$/, n.code_block),
      taskInputRule,
    ],
  });

const withSlash = (url: string) => (url.endsWith("/") ? url : url + "/");

/**
 * ProseMirror's Undo keeps, between changes, the plugins of the last document
 * it recorded a change in (to know whether to keep its steps as they came),
 * and with them that document's whole tab. When a tab closes, a change in a
 * throwaway document of its own takes their place, so a closed tab isn't
 * kept until the next document is typed in (B10-4).
 */
function forgetLastHistory(): void {
  const state = EditorState.create({ schema, plugins: [history()] });
  state.apply(state.tr.insertText("x"));
}

export class DocTab {
  readonly id: string;
  name: string;
  filePath: string;
  private dirUrl: string;
  readonly el: HTMLElement;
  /**
   * The page's own column, beside the Comments or History panel: the lines
   * and banners about the document at its top (an agent editing or done, a
   * change outside Corillo, a version shown), then the view.
   */
  readonly main: HTMLElement;
  /**
   * Called once, the next time the person changes the text (typing in either
   * view, pasting, formatting, Undo): they're working on the document again.
   * Set again to hear of the next time. Costs nothing on later keystrokes.
   */
  onPersonEdit: (() => void) | null = null;
  view!: EditorView;
  mode: Mode = "formatted";
  status: SaveState = "saved";
  words = 0;
  readonly store: PictureStore;
  /** Web pictures an agent added, waiting for the person to show them (roadmap Batch 18, item 1): the app's list. */
  private readonly waitingPictures: Set<string>;
  /** Past the list's cap, every web picture waits but these, which he showed (roadmap Batch 19, item 2); null if the list says which. */
  private everyBut: Set<string> | null;
  /** The document's comments: the panel beside the page and the highlights in the text. */
  readonly comments: DocComments;
  /** An agent holds the document: the person can read and comment, not edit. */
  readOnly = false;
  /** Where the keyboard went when the page locked under it (setReadOnly), while it's locked. */
  private lockedKeyboard: HTMLElement | null = null;
  /** An agent's pass ended and the person hasn't looked at this tab since. */
  backToYou = false;

  /** Pictures embedded the Obsidian way (![[chart.png]]), as they're found (see EmbeddedPictures). */
  private readonly embedded = new EmbeddedPictures({
    search: (name) => this.host.api.findPicture(this.id, name),
    near: (name) => this.nearEmbedded(name),
    stamps: (urls) => this.host.api.pictureStamps(urls),
  });
  private source!: Source;
  private savedText = "";
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** A comment box the person went back to from closing, or was writing in when the tab was put away: it gets the focus next. */
  private showUnpostedNext: HTMLTextAreaElement | null = null;
  /** The card the keyboard rested on when another tab came to the front: it goes back there. */
  private restOnNext: string | null = null;
  /** When the edits waiting for the save timer began. */
  private pendingSince = 0;
  private saving: Promise<boolean> | null = null;
  /** Saving waits for the person: see HOLDS. */
  private hold: Hold | null = null;
  /** The other version, for a conflict or brought-back changes. */
  private conflictText: string | null = null;
  /** Why the last save failed, in plain words, while Corillo keeps trying. */
  private problemNow: string | null = null;
  private get problem(): string | null {
    return this.problemNow;
  }
  /** The one place it changes: the held-back notice goes once a save is held back no longer, whatever comes next (B14-05). */
  private set problem(problem: string | null) {
    if (this.problemNow === HELD_BACK && problem !== HELD_BACK) noticeOn(this.el).hideIf(HELD_BACK_NOTICE);
    this.problemNow = problem;
  }
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly banner: HTMLElement;
  private readonly bannerText: HTMLElement;
  private readonly firstChoice: HTMLButtonElement;
  private readonly secondChoice: HTMLButtonElement;
  private readonly formattedEl: HTMLElement;
  private readonly editorEl: HTMLElement;
  /** The Markdown view: its text, the preview, and the document kept up to date with the text. */
  private readonly md: MarkdownView;
  /** Stops keeping the side panels' headings level with the page, once the tab closes. */
  private readonly stopLineUp: () => void;
  /**
   * How far the page was scrolled to make room for the editing line, so the words being read stayed still
   * (review.ts): the side panels' headings stay that much higher, still too, level with the page, until the
   * line's room is given back (review of Batch 11, B11R-8).
   */
  scrolledForLine = 0;
  /** The address of the link last right-clicked, as written, for Open Link. */
  private rightClicked: string | null = null;
  /**
   * On an empty page, faint words on how to start (roadmap Batch 5, item 2,
   * P-8): type, paste, or ask an agent, with a request to copy. Beside the
   * text, never in it: it isn't part of the document, its file or its lines.
   */
  private readonly blankHint: HTMLElement;
  private readonly blankCopied: HTMLElement;

  constructor(
    info: DocInfo,
    private host: TabHost,
  ) {
    this.id = info.id;
    this.name = info.name;
    this.filePath = info.filePath;
    this.dirUrl = info.dirUrl;
    const api = host.api;
    this.waitingPictures = new Set(info.waitingPictures ?? []);
    this.everyBut = info.everyWebPictureWaits ? new Set(info.everyWebPictureWaits) : null;
    const waits = (src: string) => this.waitingPictures.has(src) || (this.everyBut !== null && isWebAddress(src) && !this.everyBut.has(src));
    this.store = {
      choose: () => api.chooseImage(this.id),
      importFile: (path) => api.importImage(this.id, path),
      saveData: (bytes, mime) => api.saveImageData(this.id, bytes, mime),
      pathForFile: (file) => api.pathForFile(file),
      // A waiting picture has nothing to load, wherever it's drawn (a copy of it too).
      resolve: (src) => (waits(src) ? "" : this.resolve(src)),
      waits,
      // Only from the marker's click or key (images.ts): the app takes it off the list, then tells every tab of the document.
      show: (src) => void api.showWebPicture(this.id, src),
      // Pasted from where they waited (paste.ts): they wait here at once, before they're drawn, and the app keeps them.
      wait: (srcs) => {
        const added = srcs.filter((src) => !this.waitingPictures.has(src));
        for (const src of added) this.waitingPictures.add(src);
        for (const call of inCalls(added)) void api.waitWebPictures(this.id, call);
      },
    };

    this.el = elWith("section", "doc", { "data-doc-id": this.id });
    this.el.hidden = true;
    this.banner = elWith("div", "banner conflict", { role: "alert" });
    this.banner.hidden = true;
    this.bannerText = elWith("span", "");
    this.firstChoice = elWith("button", "keep-mine", { type: "button" });
    this.firstChoice.addEventListener("click", () => void this.choose(true));
    this.secondChoice = elWith("button", "use-theirs", { type: "button" });
    this.secondChoice.addEventListener("click", () => void this.choose(false));
    this.banner.append(this.bannerText, this.firstChoice, this.secondChoice);

    // The page, in its scrolling area. The comments are a column of their own, beside it.
    this.formattedEl = elWith("main", "canvas with-side");
    const pageColumn = elWith("div", "page-column");
    this.editorEl = elWith("article", "page editor", { "aria-label": "Document" });
    pageColumn.append(this.editorEl);
    this.formattedEl.append(pageColumn);
    // A click on the page around the text (an empty document is mostly that)
    // puts the cursor in the nearest line, so typing goes somewhere.
    this.editorEl.addEventListener("mousedown", (event) => {
      if (event.target !== this.editorEl || !this.view) return;
      event.preventDefault();
      const box = this.view.dom.getBoundingClientRect();
      const left = Math.min(Math.max(event.clientX, box.left + 1), box.right - 1);
      const top = Math.min(Math.max(event.clientY, box.top + 1), box.bottom - 1);
      const doc = this.view.state.doc;
      const found = this.view.posAtCoords({ left, top });
      const selection = gapBelowEnd(this.view, event.clientY) ?? (found ? TextSelection.near(doc.resolve(found.pos)) : Selection.atEnd(doc));
      this.view.dispatch(this.view.state.tr.setSelection(selection));
      this.view.focus();
    });

    // The Markdown view: its text, and the preview beside it (doc-tab-markdown.ts).
    const tab = this;
    this.md = new MarkdownView({
      get view() {
        return tab.view;
      },
      get source() {
        return tab.source;
      },
      set source(source) {
        tab.source = source;
      },
      get mode() {
        return tab.mode;
      },
      get comments() {
        return tab.comments;
      },
      get onPersonEdit() {
        return tab.onPersonEdit;
      },
      store: this.store,
      personEdited: () => this.personEdited(),
      scheduleSave: () => this.scheduleSave(),
      dispatch: (tr) => this.dispatch(tr),
      nodeViews: () => this.nodeViews(),
      obsidian: (forPreview) => this.obsidian(forPreview),
      openLink: (href) => this.openLink(href),
      countWords: () => this.countWords(),
      changed: () => this.host.changed(this),
    });

    // The banner, then the views, in the page's column (see `main`). The two
    // views take the same place, one at a time; the one out of sight can stay
    // laid out, so switching back to it is quick (style.css).
    this.main = elWith("div", "doc-main");
    const views = elWith("div", "views");
    views.append(this.formattedEl, this.md.markdownEl);
    this.main.append(this.banner, views);
    this.el.append(this.main);
    // The menu only gets the address as the window reads it (a file next to
    // the app's own page, for a relative one), so the link's own is kept here.
    this.el.addEventListener("contextmenu", (event) => {
      const link = (event.target as HTMLElement).closest?.("a[href]");
      const view = [this.view, this.md.preview].find((v) => v && link && v.dom.contains(link));
      this.rightClicked = link ? (view ? addressOfLinkIn(view, link) : link.getAttribute("href")) : null;
    });

    // Comments sit in a panel to the right of the page, in either view.
    this.comments = new DocComments(
      {
        api,
        id: this.id,
        view: () => this.view,
        settle: () => this.settle(),
        reveal: (pos) => this.reveal(pos),
        focusDocument: () => {
          if (this.view.isDestroyed) return; // a reply posted as its document closed
          // Show changes in place of the page: the keyboard goes there, nothing selected (roadmap Batch 25, item 1).
          if (toShownPage(this.el)) return;
          if (this.mode === "markdown") this.md.sourceEl.focus();
          // Locked while an agent edits, the page can't take the keyboard: New comment does (roadmap Batch 12, G-6).
          else if (this.readOnly && !this.el.hidden) this.lockedKeyboard = this.comments.keyboardWhileLocked() ?? this.lockedKeyboard;
          else this.view.focus();
        },
        changed: () => this.host.changed(this),
        text: () => this.currentText(),
        applyText: (next) => this.applyAsTyped(next),
      },
      info.threads ?? [],
      info.notes ?? [],
    );
    // Each panel's left edge can be dragged to make it wider or narrower. The
    // History panel, added at the end of the row, takes the comments' place
    // and width, with an edge of its own just before it.
    const body = elWith("div", "doc-body");
    this.main.before(body);
    body.append(this.main, this.comments.handle, this.comments.el, sideHandle(() => undefined));
    // Only while the line, or its empty room, is shown: Show changes and a version take its room away.
    const lineShown = () => [...this.main.querySelectorAll(":scope > .agent-notice, :scope > .pass-notice")].some((l) => l.getClientRects().length > 0);
    this.stopLineUp = lineUpPanels(body, views, (change) => this.comments.keepStill(change), () => (lineShown() ? this.scrolledForLine : 0));
    this.blankHint = elWith("div", "blank-hint");
    this.blankHint.hidden = true;
    const copy = elWith("button", "link-button blank-hint-copy", { type: "button" });
    copy.textContent = "Copy a request";
    copy.addEventListener("mousedown", (e) => e.preventDefault()); // the cursor stays on the page
    this.blankCopied = elWith("span", "blank-hint-copied", { role: "status" });
    copy.addEventListener("click", () => {
      void api.copyDraftRequest(this.id).then((copied) => {
        if (copied) this.blankCopied.textContent = "Copied. Paste it in your agent's chat and say what to write.";
      });
    });
    const first = elWith("div", "blank-hint-first");
    first.textContent = "Start typing, or paste from Word or Google Docs.";
    const ask = elWith("div", "blank-hint-ask");
    ask.append("Or ask your agent to write it: ", copy, " ", this.blankCopied);
    const word = elWith("div", "blank-hint-word");
    word.textContent = "A Word document can also be opened with File > Open.";
    this.blankHint.append(first, ask, word);
    this.load(info.text);
    // After the page's own text, so it never comes before it (see blank-hint in style.css).
    this.editorEl.append(this.blankHint);
  }

  /** The URL to display a picture at this address (relative to the document). */
  resolve(src: string): string {
    if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src)) return src;
    try {
      return new URL(src, withSlash(this.dirUrl)).href;
    } catch {
      return src;
    }
  }

  /** Web pictures that now wait in this document, or were shown (the app's word, before an agent's change that brings them). */
  picturesWaiting(change: { wait: string[]; shown: string[]; every?: string[] | null }): void {
    for (const src of change.wait) this.waitingPictures.add(src);
    for (const src of change.shown) this.waitingPictures.delete(src);
    if (change.every !== undefined) this.everyBut = change.every ? new Set(change.every) : null;
    picturesWaitingChanged();
    diagramsWaitingChanged();
  }

  private plugins() {
    return [
      waitingPictureKeys(this.store), // before any key that would put something in a selected picture's place
      tableKeys(),
      keymap({
        "Mod-z": undo,
        "Shift-Mod-z": redo,
        "Mod-y": redo,
        "Mod-b": cmd.toggleBold,
        "Mod-i": cmd.toggleItalic,
        "Shift-Mod-x": cmd.toggleStrike,
        "Mod-e": cmd.toggleCode,
        "Mod-u": () => true, // Markdown has no underline; don't let the browser add one
        "Mod-k": () => {
          this.host.openLinkEditor();
          return true;
        },
        "Mod-Alt-0": cmd.setStyle("paragraph"),
        "Mod-Alt-1": cmd.setStyle("h1"),
        "Mod-Alt-2": cmd.setStyle("h2"),
        "Mod-Alt-3": cmd.setStyle("h3"),
        "Mod-Alt-4": cmd.setStyle("h4"),
        "Shift-Mod-7": cmd.toggleList(n.ordered_list),
        "Shift-Mod-8": cmd.toggleList(n.bullet_list),
        "Shift-Enter": hardBreak,
        Enter: chainCommands(splitItem, emptyLineOutOfQuote),
        // In a list, Tab and Shift-Tab indent and outdent; in code, they indent
        // and outdent lines. Anywhere else they do nothing, rather than send the
        // keyboard out of the document (a Markdown paragraph can't be
        // indented), so typing carries on here.
        Tab: chainCommands(sinkListItem(n.list_item), cmd.indentCode, () => true),
        "Shift-Tab": chainCommands(liftListItem(n.list_item), cmd.outdentCode, () => true),
        Backspace: chainCommands(undoInputRule, joinOverBlankLine),
        Delete: joinOverBlankLineForward,
      }),
      keymap(baseKeymap),
      markdownShortcuts(),
      history(),
      new Plugin({ appendTransaction: cmd.joinTouchingLists }),
      footnotePlugin(),
      picturePlugin(this.store),
      ...everydayPlugins(this.store),
      diagramCursorPlugin(),
      dropCursor({ color: false, width: 2, class: "drop-cursor" }),
      cmd.dropsOutsideSource(),
      gapCursor(),
      ...tableBehaviour(),
      tableTextPlugin(),
      this.comments.plugin(),
      this.comments.changePlugin(),
      lineNumbersPlugin(() => this.source),
      blankLinesPlugin(() => this.source),
      this.obsidian(false),
      lineBreaksPlugin(),
      tasksPlugin(),
    ];
  }

  /** Obsidian's links, highlights, callouts and the rest (see obsidian.ts), as the preview reads them or as the page edits them. */
  private obsidian(forPreview: boolean) {
    return obsidianPlugin({
      reading: forPreview,
      findPicture: (name) => this.embedded.find(name),
      openNote: (target) => void this.host.api.openNote(this.id, target),
    });
  }

  /**
   * Where an embedded picture not found yet would most likely appear, as the
   * app looks first (main/vault.ts): the path written in the link, beside the
   * document, its pictures folder, an attachments folder beside it.
   */
  private nearEmbedded(name: string): string[] {
    const base = name.split("/").pop() ?? name;
    const stem = this.name.replace(/\.[^.]+$/, "");
    const places = [...(name.includes("/") ? [name] : []), base, `${stem} images/${base}`, `attachments/${base}`, `Attachments/${base}`];
    const folder = withSlash(this.dirUrl);
    return places.flatMap((p) => {
      try {
        return [new URL(p.split("/").map(encodeURIComponent).join("/"), folder).href];
      } catch {
        return [];
      }
    });
  }

  private nodeViews(): ConstructorParameters<typeof EditorView>[1]["nodeViews"] {
    return {
      image: (node, v, getPos) => new ImageView(node, v, getPos, this.store),
      code_block: (node, v, getPos) => (isDiagram(node) ? new DiagramView(node, v, getPos, this.store) : (null as never)),
    };
  }

  /**
   * Show text in the editor, without changing what counts as saved.
   * keepPlaces: false when Corillo has already worked out where each comment
   * is in the new text (an agent's change), so the old text's places aren't
   * saved over them.
   */
  private show(text: string, keepPlaces = true): void {
    // Where comments were, before the text is replaced, and the card in focus, which stays so.
    let focus: { active: string | null; selected: string | null } | null = null;
    // A comment being written, where it was in the text, to carry through an agent's change (see carryDraft).
    let draft: { text: string; from: number; to: number } | null = null;
    if (this.view) {
      if (keepPlaces) this.comments.saveAnchorsNow();
      else draft = draftPlace(this.view.state);
      focus = { active: commentRanges(this.view.state).active, selected: changeMarks(this.view.state).selected };
    }
    const parsed = parseCached(text);
    this.source = parsed.source;
    const state = EditorState.create({ doc: parsed.doc, selection: firstText(parsed.doc), plugins: this.plugins() });
    if (this.view) this.view.updateState(state);
    else {
      this.view = new EditorView(this.editorEl, {
        state,
        // For screen readers: a text box of many lines, named after the document as its tab is (roadmap Batch 12, N-1).
        attributes: () => ({ role: "textbox", "aria-multiline": "true", "aria-label": shownName(this.name) }),
        nodeViews: this.nodeViews(),
        dispatchTransaction: (tr) => this.dispatch(tr),
        handleDOMEvents: {
          // Cmd-click opens a link (see openLink); a plain click just places the cursor.
          click: (view, event) => {
            const link = (event.target as HTMLElement).closest("a");
            if (link && (event.metaKey || event.ctrlKey)) {
              this.openLink(addressOfLinkIn(view, link));
              event.preventDefault();
              return true;
            }
            return false;
          },
        },
      });
    }
    this.comments.reanchor(focus);
    if (draft) this.carryDraft(draft, focus?.active === DRAFT);
    if (this.mode === "markdown") {
      if (this.md.fromSourceArea() !== text) {
        const { selectionStart, selectionEnd } = this.md.sourceEl;
        this.md.setSourceArea(text);
        this.md.sourceEl.setSelectionRange(selectionStart, selectionEnd);
      }
      // The editor's document is this text now, with a history of its own.
      this.md.modelText = text;
      this.md.typingGroup = null;
      // What was kept about the document before it isn't needed now: don't hold on to it.
      this.md.unread = null;
      this.md.replacing = null;
      this.md.updatePreview();
      this.md.placeMarks();
    }
    this.countWords();
    this.showIfBlank();
    this.host.changed(this);
  }

  /**
   * A comment being written, through an agent's change: Corillo carries each
   * posted comment through by where its words are (the app never knows of the
   * one being written), so this one goes the same way when the change was
   * all before or all after its words, and a word added at its edge stays
   * outside it. Where the change touched its words, they were found again by
   * searching (reanchor), as before.
   */
  private carryDraft(was: { text: string; from: number; to: number }, inFocus: boolean): void {
    const state = this.view.state;
    const index = textIndex(state.doc);
    const at = draftMoves(was.text, index.text, was.from, was.to);
    if (at === null) return;
    const range = { from: posAt(index, was.from + at, "start"), to: posAt(index, was.to + at, "end") };
    const found = commentRanges(state).ranges.get(DRAFT);
    if (found && found.from === range.from && found.to === range.to) return;
    const tr = withRanges(state.tr, { type: "add", id: DRAFT, range, shown: true });
    this.view.dispatch(inFocus ? withRanges(tr, { type: "active", id: DRAFT }) : tr);
    this.comments.saveAnchorsNow(); // its quote, as its words are now
  }

  /** Show text that is what's on disk. */
  private load(text: string, keepPlaces = true): void {
    this.savedText = text;
    this.release();
    this.problem = null;
    if (this.mode === "formatted") this.md.unkeepMarkdown(); // changed here: the Markdown view is made afresh when next shown
    this.show(text, keepPlaces);
    this.setStatus("saved");
  }

  private dispatch(tr: Transaction): void {
    if (this.readOnly && tr.docChanged) return; // an agent is editing: nothing changes the text here
    const before = this.view.state;
    this.view.updateState(before.apply(tr));
    if (onlyLineNumbers(tr)) return;
    this.comments.afterTransaction(tr);
    // From the Markdown text: its typing set the save going already (doc-tab-markdown.ts), so it isn't put off again here.
    const fromText = this.mode === "markdown" && fromTheText(tr);
    if (this.mode === "markdown") {
      // Changed other than from the text (a pasted picture's copy put in once an agent is done, say): the text follows.
      if (tr.docChanged && !fromText) this.md.textFollows();
      this.md.marksMoved(before);
    }
    if (tr.docChanged) {
      if (this.mode === "formatted") {
        this.md.unkeepMarkdown();
        // In the Markdown view the text area heard of the typing first.
        if (this.onPersonEdit) this.personEdited();
      }
      this.countWords();
      this.showIfBlank();
      if (!fromText) this.scheduleSave(false); // the window hears of it just below, once per keystroke
    }
    this.host.changed(this);
  }

  /** The person changed the text: tell whoever is listening, once. */
  private personEdited(): void {
    const listener = this.onPersonEdit;
    this.onPersonEdit = null;
    listener?.();
  }

  currentText(): string {
    if (this.mode === "markdown") return this.md.fromSourceArea();
    return serializeMarkdown(this.view.state.doc, this.source);
  }

  /**
   * The person's own change to the text, made in one step Undo takes back (an
   * agent's option they chose, roadmap Batch 3 item 2). `texts` are the text
   * as it is now, then each text on the way, one place changed at a time (see
   * stagesOf), the last the text wanted. In the Markdown view it's typed
   * there as one change; in either view the document changes place by place,
   * so what's between two places keeps its comments and agents' change
   * highlights (review of Batch 3, B3-R01). False when it can't be done
   * faithfully; then nothing changed.
   */
  applyAsTyped(texts: readonly string[]): boolean {
    if (this.readOnly || !texts.length) return false;
    const next = texts[texts.length - 1];
    const steps = texts.slice(1);
    if (this.mode === "markdown") {
      const area = this.md.sourceEl;
      const shown = forTextArea(next);
      const edit = textEdit(area.value, shown);
      if (!edit) return true;
      this.settle(); // what was typed before is in the document first
      this.md.replacing = { doc: this.view.state.doc, text: next, build: (tr) => throughTexts(tr, steps) };
      // With Show changes on, the text is out of sight, where it can't take the
      // keyboard: it's let back for the moment the change takes, with nothing
      // drawn meanwhile, and the keyboard goes back where it was (B3-R02).
      const away = this.el.classList.contains("viewing-version");
      const had = document.activeElement;
      if (away) this.el.classList.remove("viewing-version");
      try {
        area.focus({ preventScroll: true });
        area.setSelectionRange(edit.from, edit.oldTo);
        const words = shown.slice(edit.from, edit.newTo);
        // The text's own Undo takes it back, as a step of its own (B10-3).
        asStepOfItsOwn(area, () => document.execCommand(words ? "insertText" : "delete", false, words));
      } finally {
        if (away) {
          this.el.classList.add("viewing-version");
          area.blur();
          if (had instanceof HTMLElement && had !== area && had.isConnected) had.focus({ preventScroll: true });
        }
      }
      this.settle(); // the document follows now, place by place
      return true;
    }
    const parsed = parseCached(next);
    const state = this.view.state;
    const stepped = steps.length ? throughTexts(readAs(state, parseCached(texts[0]).doc), steps) : null;
    const tr = stepped ?? replaceChanged(state, parsed.doc).tr;
    if (!tr.docChanged) return true;
    if (serializeMarkdown(tr.doc, parsed.source) !== next) return false;
    this.source = parsed.source;
    this.view.dispatch(closeHistory(tr));
    this.view.dispatch(closeHistory(this.view.state.tr)); // typing straight after is a step of its own
    return true;
  }

  /** Save soon. `tell`: tell the window the status changed (unless the caller is about to). */
  private scheduleSave(tell = true): void {
    forTests.savesSet++;
    const status = this.hold ?? (this.problem ? "error" : "pending");
    if (tell) this.setStatus(status);
    else this.status = status;
    if (this.saveTimer) {
      // Typing postpones the save, but never for long, so a crash can't take much.
      if (Date.now() - this.pendingSince >= SAVE_AT_LEAST_EVERY_MS) return;
      clearTimeout(this.saveTimer);
    } else this.pendingSince = Date.now();
    this.saveTimer = setTimeout(() => void this.saveNow(), SAVE_DELAY_MS);
  }

  async saveNow(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    while (this.saving) await this.saving;
    const text = this.currentText();
    if (this.hold) {
      // Waiting for the person to choose; meanwhile the edits are kept safe (as the safety net would write them).
      if (text !== this.savedText) {
        const net = this.netted(text);
        this.keepRecovery(net.ok ? net.text : net.keep);
      }
      return;
    }
    if (text === this.savedText) {
      this.problem = null;
      this.setStatus("saved");
      return;
    }
    await this.write(text, false);
  }

  /**
   * Write the text to the file (forced: even if it changed or went away).
   * If that can't be done, the text stays here, the status bar says why,
   * the edits are kept in Corillo's data folder, and Corillo tries again.
   */
  private async write(text: string, force: boolean): Promise<boolean> {
    const api = this.host.api;
    const net = this.netted(text);
    if (!net.ok) return this.heldBack(net);
    const saving = (async () => {
      let result: SaveResult;
      try {
        result = await (force ? api.forceSave(this.id, net.text) : api.save(this.id, net.text));
      } catch {
        result = { ok: false, problem: "something went wrong saving" };
      }
      if (result.ok) {
        // (Repaired, the file holds the same words written another way: the page's own text still counts as saved.)
        this.savedText = text;
        this.problem = null; // (saved now: the held-back notice goes)
        if (force) this.release();
        this.setStatus(this.currentText() === text ? "saved" : "pending");
        // Changed again in the moment after (a cloud folder, another app): taken in as any outside change, never written over.
        if (result.changedAfter !== undefined) this.changedOnDisk(result.changedAfter);
        return true;
      }
      if ("diskText" in result) this.holdFor("conflict", result.diskText);
      else if ("missing" in result) {
        if (this.hold !== "trashed" && this.hold !== "missing") this.holdFor("missing");
      }
      else {
        this.problem = result.problem;
        this.setStatus(this.hold ?? "error");
        if (!this.hold) this.retryTimer = setTimeout(() => void this.saveNow(), RETRY_MS);
      }
      this.keepRecovery(net.text);
      return false;
    })();
    this.saving = saving;
    try {
      return await saving;
    } finally {
      if (this.saving === saving) this.saving = null;
    }
  }

  private keepRecovery(text: string): void {
    this.host.api.keepRecovery(this.id, text).catch(() => undefined);
  }

  /**
   * The safety net (roadmap Batch 14, item 1): the text a save would write,
   * checked against the page, every edited block read back, and repaired
   * where that's safe (see core/write-check.ts). In the Markdown view the
   * text is what the person typed, so there's nothing to read back; its
   * bytes are still read back as every save's are. (The view starts from
   * text the net let through: see setMode.)
   */
  private netted(text: string): SaveCheck {
    if (this.mode === "markdown") return { ok: true, text, repaired: 0 };
    return checkSave(this.view.state.doc, this.source, forTests.netFault);
  }

  /**
   * A save the net held back: the file stays as it was, the words stay here
   * and in the edits kept for recovery (as after a crash), and one notice
   * says so. Never a dialog: typing goes on, and each change tries again.
   */
  private heldBack(net: Extract<SaveCheck, { ok: false }>, more = ""): false {
    this.problem = HELD_BACK;
    this.setStatus(this.hold ?? "error");
    this.keepRecovery(net.keep);
    const words = [...new Set(net.lost)];
    const named = words.length ? ` (${words.slice(0, 5).map((w) => `"${w}"`).join(", ")}${words.length > 5 ? " and more" : ""})` : "";
    noticeOn(this.el).show(
      `${HELD_BACK_NOTICE}${named}.`,
      `${more ? more + " " : ""}They're safe here, and come back if Corillo closes. To keep a copy as well, select everything on the page, copy it and paste it into another document.`,
    );
    return false;
  }

  /** The file changed outside Corillo (another app, or an agent writing it). */
  changedOnDisk(diskText: string): void {
    const api = this.host.api;
    const mine = this.currentText();
    if (mine === diskText) {
      this.savedText = diskText;
      this.release();
      this.problem = null;
      void api.acceptDisk(this.id, diskText);
      void api.discardRecovery(this.id);
      this.setStatus("saved");
    } else if (mine === this.savedText && !this.saveTimer) {
      this.loadKeepingPlace(diskText); // nothing unsaved here: show the new version
      void api.acceptDisk(this.id, diskText);
      void api.discardRecovery(this.id);
    } else {
      this.showConflict(diskText);
    }
  }

  /** The file was deleted outside Corillo, or can't be found. */
  missing(kind: MissingKind = "unknown"): void {
    this.problem = MISSING[kind].problem;
    this.holdFor("missing", null, MISSING[kind].message);
  }

  /** The file was renamed or moved outside Corillo: the tab follows it (its pictures' addresses are left as the file has them). */
  followed(place: NewPlace): void {
    const otherFolder = place.dirUrl !== this.dirUrl;
    this.name = place.name;
    this.view.updateState(this.view.state); // the page's name for screen readers
    this.filePath = place.filePath;
    this.dirUrl = place.dirUrl;
    // Pictures whose addresses start from the document's folder are looked for
    // from its new one (drawn again): where they aren't there, the
    // missing-picture notice says so and offers to find them, before an export would miss them.
    if (otherFolder && this.hasLocalPictures()) {
      this.view.setProps({ nodeViews: this.nodeViews() });
      this.md.preview?.setProps({ nodeViews: this.nodeViews() });
    }
    if (otherFolder) this.lookForEmbedsAgain();
    this.host.renamed?.(this);
    this.host.changed(this);
    // A save that waited for the file goes to its new place now.
    if (!this.hold && (this.status === "error" || this.currentText() !== this.savedText)) void this.saveNow();
  }

  /** Whether the document has a picture whose address starts from its own folder. */
  private hasLocalPictures(): boolean {
    let found = false;
    this.view.state.doc.descendants((node) => {
      if (found) return false;
      if (node.type === n.image && node.attrs.src && this.resolve(node.attrs.src) !== node.attrs.src) found = true;
      return !found;
    });
    return found;
  }

  /** Nothing would be lost by closing the tab now: everything is saved, and no comment is half written. */
  canLetGo(): boolean {
    return !this.hold && !this.saveTimer && !this.saving && this.currentText() === this.savedText && !this.comments.unposted();
  }

  /** The file was moved to the Trash while there were changes not saved: the tab stays, and says so. */
  trashed(): void {
    this.problem = "the file is in the Trash";
    this.holdFor("trashed");
  }

  /** The file is back where it was (the move was undone, or put back from the Trash). */
  found(): void {
    if (this.hold !== "missing" && this.hold !== "trashed") return;
    this.release();
    this.problem = null;
    if (this.currentText() !== this.savedText) this.scheduleSave();
    else this.setStatus("saved");
  }

  /** Edits that weren't saved when Corillo last closed: shown, for the person to keep or not. */
  recovered(text: string): void {
    const onDisk = this.savedText;
    if (text === onDisk) {
      void this.host.api.discardRecovery(this.id);
      return;
    }
    this.show(text);
    this.holdFor("recovered", onDisk);
  }

  private showConflict(diskText: string): void {
    this.holdFor("conflict", diskText);
  }

  private holdFor(kind: Hold, otherText: string | null = null, message = HOLDS[kind].message): void {
    this.hold = kind;
    if (otherText !== null) this.conflictText = otherText;
    const copy = HOLDS[kind];
    this.bannerText.textContent = message;
    this.firstChoice.textContent = copy.first;
    this.secondChoice.textContent = copy.second;
    this.banner.hidden = false;
    this.setStatus(kind);
  }

  private release(): void {
    this.hold = null;
    this.conflictText = null;
    if (this.banner) this.banner.hidden = true;
  }

  /** The notice's first or second button. */
  private async choose(first: boolean): Promise<void> {
    if (this.hold === "missing") await (first ? this.saveWhereItWas() : this.saveElsewhere());
    else if (this.hold === "trashed") {
      if (!first) return this.host.close?.(this);
      await this.saveElsewhere();
    } else await this.resolveConflict(first);
    this.focus(); // back to writing
  }

  private async resolveConflict(keepMine: boolean): Promise<void> {
    const diskText = this.conflictText;
    if (diskText === null) return;
    this.release();
    // What's on disk is now the version Corillo knows; mine is saved over it
    // the usual way, so a change made in the meantime still isn't lost.
    // (The kept copy of my edits stays until they're saved.)
    await this.host.api.acceptDisk(this.id, diskText);
    if (keepMine) {
      this.savedText = diskText;
      await this.saveNow();
    } else {
      this.load(diskText);
      await this.host.api.discardRecovery(this.id);
    }
  }

  /** Make this the document's text, saved the usual way (restoring a version from the history). */
  async replaceText(text: string): Promise<void> {
    this.show(text);
    await this.saveNow();
  }

  // Agents ----------------------------------------------------------------------

  /** While an agent edits, the person can read, select and comment, but not change the text. */
  setReadOnly(on: boolean): void {
    if (this.readOnly === on) return;
    // Typing in the Markdown view reaches the document (the preview, the comments on its words) before the text is locked.
    if (on) this.settle();
    // Sent to an agent from the page, by keys: as the page locks under the keyboard (Formatted view), it goes to New
    // comment, not nowhere (roadmap Batch 12, G-6). An agent taking the document otherwise leaves it as it was.
    const inPage = on && !this.el.hidden && this.view.hasFocus() && this.comments.sentFromPage;
    // Sent by keys from its own button: the keyboard on New comment is recorded the same way, so it comes back (B12-6).
    const byButton = on && !this.el.hidden && this.comments.sentFromButton && this.comments.keyboardBySend();
    if (on) this.comments.sentFromPage = this.comments.sentFromButton = false;
    this.readOnly = on;
    this.view.setProps({ editable: () => !this.readOnly });
    this.md.sourceEl.readOnly = on;
    const movedTo = this.lockedKeyboard;
    this.lockedKeyboard = inPage || byButton ? this.comments.keyboardWhileLocked() : null;
    this.showIfBlank(); // not while an agent has it: it may be writing the draft
    // Back in the person's hands: if they're looking at it and nothing else
    // has the keyboard (a comment box, say), or it's still where the lock
    // moved it, typing goes where their cursor was. Not over selected words,
    // which a stray key would replace.
    const idle = !document.activeElement || document.activeElement === document.body || (!on && document.activeElement === movedTo);
    const cursor =
      this.mode === "markdown" ? this.md.sourceEl.selectionStart === this.md.sourceEl.selectionEnd : this.view.state.selection.empty;
    if (!on && !this.el.hidden && idle && cursor) this.focus();
    // Still where the lock moved it, with words selected: back in the page as Help says, at the end of those words
    // with nothing selected, so a stray key replaces nothing (Batch 24, K-8).
    else if (!on && !this.el.hidden && movedTo && document.activeElement === movedTo && this.mode !== "markdown") {
      const end = this.view.state.selection.to;
      this.view.dispatch(this.view.state.tr.setSelection(Selection.near(this.view.state.doc.resolve(end), -1)));
      this.focus();
    }
    this.host.changed(this);
  }


  /**
   * An agent's change is on its way: read its text now, while Corillo ties
   * the change to its comments, so it shows sooner when it arrives (the
   * reading is kept, see parse-cache.ts). Nothing on screen changes yet.
   */
  readAhead(text: string): void {
    parseCached(text);
  }

  /**
   * An agent changed the document through Corillo. The file already holds the
   * new text, and the tab had nothing unsaved (it was saved and locked when
   * the agent took it), so there's nothing to choose: just show it.
   */
  applyAgentText(text: string): void {
    // (Its text was usually read ahead: see readAhead.)
    // Not the comments' places in the old text: the tab was locked, its places saved when the agent
    // took it, and Corillo has sent where each comment is in the new text.
    this.loadKeepingPlace(text, false);
  }

  /**
   * Show new text from outside the tab (an agent's change, or another app's),
   * keeping the person's selection or cursor on the same words, the way
   * comments keep to theirs; if those words were rewritten, as near where
   * they were as the new text allows. Otherwise it would jump to the top,
   * and a comment or typing meant for one place would land in another. What
   * the person is reading stays where it is on screen, whatever was put in or
   * taken out above it. The view showing is kept so; the other is placed
   * when it's shown.
   */
  private loadKeepingPlace(text: string, keepPlaces = true): void {
    this.settle(); // in the Markdown view, the document has the typing first
    if (this.showAsEdit(text, keepPlaces)) return;
    const formatted = this.mode === "formatted";
    const area = this.md.sourceEl;
    const kept = formatted ? selectionPlace(this.view.state) : null;
    const typed = formatted ? null : { value: area.value, from: area.selectionStart, to: area.selectionEnd };
    const page = formatted ? whatsInSight(this.view, this.formattedEl) : null;
    const lines = !formatted && area.scrollTop > 0 ? { value: area.value, scroll: area.scrollTop, height: area.scrollHeight } : null;
    if (!formatted) this.md.together.holdText(); // the text keeps its place, and the preview follows it
    this.load(text, keepPlaces);
    try {
      if (kept) this.selectAgain(kept);
      if (typed) this.md.selectAgainInText(typed);
      if (page) returnTo(this.view, this.formattedEl, page);
      if (lines) this.md.returnToLine(lines);
      if (!formatted) this.md.together.kept();
    } catch {
      // Where the person was is a convenience; the new text is what matters.
    }
    if (!formatted) sourceReplaced(area);
  }

  /**
   * New text from outside the tab as an edit (roadmap Batch 7, item 1): on
   * the page only the blocks that changed are replaced, and in the Markdown
   * view only the lines of the text that changed, so nothing else is drawn
   * again and nothing flickers. Where the change didn't touch them, the
   * person's cursor, selection and what they're reading go through it as they
   * are; where it did, they're found again by their words, as when the page is
   * read again (loadKeepingPlace). False, with nothing changed, when the edit
   * can't bring the page exactly to what the file holds: then it's read again.
   */
  private showAsEdit(text: string, keepPlaces: boolean): boolean {
    // For tests only, to compare the page read again with the edit (quick.spec.ts, as-edit-same.spec.ts): see for-tests.ts.
    if (forTests.readAgain === true) return false;
    const formatted = this.mode === "formatted";
    // Typing in the Markdown text the document couldn't take in yet (an agent holds it): read again.
    if (!formatted && this.md.fromSourceArea() !== this.md.modelText) return false;
    const state = this.view.state;
    const tr = state.tr;
    const edit = editTo(tr, parseCached(text), text);
    if (!edit) return false;
    // As show does: the comments' places, the card in focus, a comment being written.
    const focus = { active: commentRanges(state).active, selected: changeMarks(state).selected };
    // Read from the text, as the Markdown view's typing is: nothing tidies it (lists that touch, a note whose number went).
    markAsFromTheText(tr).setMeta("addToHistory", false);
    // Undo never takes the change back; the person's own steps from before it can still be undone, up to one it touched.
    undoThrough(tr, state, edit.changed);
    // The card in focus stays so: the change doesn't put the comment the cursor happens to rest in in focus.
    withRanges(tr, { type: "active", id: focus.active });
    // Where a comment's words went, it's found again by its words (reanchor), as when the page is read
    // again: the change isn't taken for the person deleting them (no "was deleted" in its place).
    const gaps = new Set([...changeMarks(state).gaps.keys(), ...commentRanges(state).shown]);
    if (gaps.size) withChanges(tr, ...[...gaps].map((id) => ({ type: "gap" as const, id, gap: null })));
    const next = state.applyTransaction(tr).state;
    if (next.doc !== tr.doc) return false; // something tidied it after all, so the page would differ from the file

    // Where the person is, before anything on screen moves.
    const area = this.md.sourceEl;
    const page = formatted ? whatsInSight(this.view, this.formattedEl) : null;
    const typed = formatted ? null : { value: area.value, from: area.selectionStart, to: area.selectionEnd, direction: area.selectionDirection };
    const lines = !formatted && area.scrollTop > 0 ? { value: area.value, scroll: area.scrollTop, height: area.scrollHeight } : null;
    const draft = keepPlaces ? null : draftPlace(state);
    if (keepPlaces) this.comments.saveAnchorsNow();
    this.savedText = text;
    this.release();
    this.problem = null;
    if (!formatted) this.md.together.holdText(); // the text keeps its place, and the preview follows it

    this.source = edit.source;
    this.view.updateState(next);
    if (formatted) this.md.unkeepMarkdown(); // changed here, as typing does
    this.comments.reanchor(focus);
    this.comments.carryChoicesThrough(tr, edit.changed);
    if (draft) this.carryDraft(draft, focus.active === DRAFT);
    let changes: TextChange[] = [];
    if (!formatted) {
      changes = textChanges(area.value, forTextArea(text));
      this.md.editSourceArea(text, changes);
      // The editor's document is this text now.
      this.md.modelText = text;
      this.md.typingGroup = null;
      this.md.unread = null;
      this.md.replacing = null;
      this.md.updatePreview();
      this.md.placeMarks();
    }
    this.countWords();
    this.showIfBlank();
    this.setStatus("saved");
    lookAtPicturesAgain(); // as a page read again does: a picture the change came with may be new on disk

    try {
      if (formatted) {
        const { from, to } = state.selection;
        if (touches(edit.changed, from, to)) {
          const kept = selectionPlace(state);
          if (kept) this.selectAgain(kept);
          else {
            const now = this.view.state;
            this.view.dispatch(withRanges(now.tr.setSelection(firstText(now.doc)), { type: "active", id: commentRanges(now).active }));
          }
        }
        if (page) returnTo(this.view, this.formattedEl, page, (from, to) => (touches(edit.changed, from, to) ? null : tr.mapping.map(from)));
      } else {
        if (typed) this.md.selectThroughText(typed, changes);
        if (lines) this.md.keepTopLine(lines, changes);
        this.md.together.kept();
      }
    } catch {
      // Where the person was is a convenience; the new text is what matters.
    }
    if (!formatted) sourceReplaced(area); // Find's marks, on the text's own layer
    return true;
  }

  /** The selection (or cursor) on the same words as before, or where they were. */
  private selectAgain(kept: NonNullable<ReturnType<typeof selectionPlace>>): void {
    const state = this.view.state;
    const doc = state.doc;
    const index = textIndex(doc);
    const emptyLine = kept.emptyLine && emptyLineIn(doc, kept.emptyLine, index);
    const range = emptyLine ? null : findAnchor(doc, kept.anchor, index);
    let selection: Selection;
    if (emptyLine) selection = TextSelection.create(doc, emptyLine);
    else if (range) {
      const $to = doc.resolve(range.to);
      selection = TextSelection.between(kept.cursor ? $to : doc.resolve(range.from), $to);
    } else {
      // Its words were rewritten: as near where it was as the new text allows, never back at the top.
      selection = TextSelection.near(doc.resolve(posAt(index, mapOffset(kept.text, index.text, kept.at), "end")));
    }
    // The card in focus stays so, wherever the cursor lands.
    this.view.dispatch(withRanges(state.tr.setSelection(selection), { type: "active", id: commentRanges(state).active }));
  }

  private async saveWhereItWas(): Promise<boolean> {
    return this.write(this.currentText(), true);
  }

  /** Save to a place the person chooses; the document lives there from then on. */
  private async saveElsewhere(): Promise<boolean> {
    const text = this.currentText();
    const net = this.netted(text);
    if (!net.ok) return this.heldBack(net);
    const result = await this.host.api.saveAs(this.id, net.text);
    if (!result) return false;
    if ("problem" in result) {
      this.problem = result.problem;
      this.setStatus(this.hold ?? "error");
      return false;
    }
    this.release();
    this.problem = null;
    this.savedText = text;
    this.atNewPlace(result); // picture addresses follow the new place
    this.host.renamed?.(this);
    this.setStatus(this.currentText() === this.savedText ? "saved" : "pending");
    if (result.changedAfter !== undefined) this.changedOnDisk(result.changedAfter);
    return true;
  }

  /** Save before closing. False if the person cancelled. */
  async prepareToClose(): Promise<boolean> {
    this.settle();
    this.comments.saveAnchorsNow();
    const api = this.host.api;
    // A comment or reply typed and not posted would be lost: ask first.
    const unposted = this.comments.unposted();
    if (unposted && (await api.askUnposted(this.id)) === "cancel") {
      this.showUnpostedNext = unposted;
      return false;
    }
    for (let asked = 0; asked < 10; asked++) {
      try {
        await this.saveNow();
      } catch {
        // reported by the status below
      }
      if (!this.hold && !this.problem) {
        if (this.currentText() === this.savedText) return true;
        continue; // typed while saving: save again
      }
      let choice: CloseChoice;
      if (this.hold === "conflict") choice = await api.askConflict(this.id);
      // Held back by the safety net, no way of saving would work: its own question (B14-03).
      else if (this.problem === HELD_BACK && !this.netted(this.currentText()).ok) choice = await api.askBeforeClose(this.id, "held-back", HELD_BACK);
      else choice = await api.askBeforeClose(this.id, this.hold ?? "problem", this.problem ?? "");
      if (choice === "cancel") return false;
      if (choice === "discard") {
        await api.discardRecovery(this.id);
        return true;
      }
      if (choice === "mine" || choice === "theirs") await this.resolveConflict(choice === "mine");
      else if (choice === "here") await this.saveWhereItWas();
      else if (choice === "save-as" && !(await this.saveElsewhere())) return false;
    }
    return false;
  }

  destroy(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.comments.destroy();
    this.stopLineUp();
    this.md.destroy();
    this.view.destroy();
    forgetLastHistory();
    forgetWords(this.id); // nor the texts read as words for it (an option chosen)
    this.el.remove();
    forgetParsed();
  }

  // The Markdown view -----------------------------------------------------------

  /** Bring the Markdown view's preview and comments up to date with what was just typed, now. */
  settle(): void {
    this.md.settle();
  }

  /** Replace All in the Markdown text is about to replace these matches, making the text `next` (find.ts; see the Markdown view's). */
  replacingAll(matches: readonly { from: number; to: number }[], replacement: string, next: string): void {
    this.md.replacingAll(matches, replacement, next);
  }

  setMode(next: Mode): void {
    if (next === this.mode) return;
    // A comment, reply or edit being written keeps the keyboard, in either view.
    const box = this.comments.boxInUse();
    if (next === "markdown") {
      // The text shown is what a save would write, checked by the safety net (B14-01):
      // repaired where it repairs. Where it would hold the save back, the view
      // doesn't open, so the text that would lose words is never there to be saved.
      const { doc, selection } = this.view.state;
      const written: Span[] = [];
      const net = checkSave(doc, this.source, forTests.netFault, written);
      if (!net.ok) {
        this.heldBack(net, "The Markdown view opens once they can be saved.");
        return;
      }
      // The cursor goes to the same words in the Markdown text (in a table, the same cell).
      const { text, spans } = inView(net.text, written);
      this.comments.saveAnchorsNow();
      this.mode = "markdown";
      this.el.classList.add("markdown-view");
      this.md.setSourceArea(text);
      this.md.modelText = text;
      this.md.unread = doc;
      this.md.placed = { doc, text: this.md.sourceEl.value, spans };
      this.md.typingGroup = null;
      this.formattedEl.hidden = true;
      this.md.markdownEl.hidden = false;
      this.md.updatePreview();
      this.md.placeMarks();
      this.md.sourceEl.scrollTop = 0;
      if (!box) this.md.sourceEl.focus({ preventScroll: true });
      let from = 0;
      let to = 0;
      try {
        const value = this.md.sourceEl.value;
        from = markdownPlace(doc, selection.from, value, spans);
        to = selection.empty ? from : Math.max(from, markdownPlace(doc, selection.to, value, spans));
      } catch {
        // Keeping the place is a convenience; the text is what matters.
      }
      this.md.sourceEl.setSelectionRange(from, to);
      this.md.textCells.revealCursor();
      this.md.together.shown();
      window.corillo.markdownShown(); // a note in Corillo's log if this took it past 1 GB (memory-note.ts)
    } else {
      this.md.syncModel();
      this.md.unread = null;
      this.md.replacing = null;
      this.md.replacedAll = null;
      const text = this.md.fromSourceArea();
      const { selectionStart, selectionEnd, value } = this.md.sourceEl;
      this.mode = "formatted";
      this.el.classList.remove("markdown-view");
      // What's typed in the formatted view from now on is a step of its own for Undo.
      if (this.md.typingGroup) this.view.dispatch(closeHistory(this.view.state.tr));
      this.md.typingGroup = null;
      this.md.markdownEl.classList.add("kept"); // so coming back to it is quick, until the document changes here
      this.md.markdownEl.hidden = true;
      this.formattedEl.hidden = false;
      lineNumbersShown(this.view);
      // The same text, so nothing is re-saved. Undo keeps what came before.
      if (!this.showKeepingUndo(text)) this.show(text);
      // The cursor goes to the same words (in a table, the same cell), in
      // sight. (The editor's own scrolling to the cursor does nothing here:
      // the keyboard is still in the Markdown text.)
      try {
        const doc = this.view.state.doc;
        const { spans } = viewText(doc, this.source);
        const from = docPlace(doc, value, spans, selectionStart);
        const to = selectionStart === selectionEnd ? from : Math.max(from, docPlace(doc, value, spans, selectionEnd));
        const selection = TextSelection.between(doc.resolve(from), doc.resolve(to));
        // The card in focus stays so, wherever the cursor lands.
        const active = commentRanges(this.view.state).active;
        this.view.dispatch(withRanges(this.view.state.tr.setSelection(selection), { type: "active", id: active }));
        revealIn(this.view, this.formattedEl, selection.head);
      } catch {
        // as above
      }
      if (!box) {
        // The page's own selection goes there first: focusing the editor
        // otherwise puts it at the start of the document for a moment, which
        // takes a while on a long one.
        try {
          const { node, offset } = this.view.domAtPos(this.view.state.selection.head);
          document.getSelection()?.collapse(node, offset);
        } catch {
          // as above
        }
        this.view.focus();
      }
    }
    if (box) box.focus({ preventScroll: true });
    this.comments.modeChanged();
    this.host.changed(this);
  }

  /**
   * Coming back from the Markdown view: keep the editor's undo history, as
   * switching views in Word does. Unchanged, the document is just as it was;
   * changed, the blocks typed in the Markdown view replace the old ones in one
   * step, which Undo can take back. False if that can't be done faithfully
   * (then the text is shown afresh, without the history).
   */
  private showKeepingUndo(text: string): boolean {
    const state = this.view.state;
    if (serializeMarkdown(state.doc, this.source) === text) {
      this.countWords();
      this.host.changed(this);
      return true;
    }
    try {
      const parsed = parseCached(text); // the preview usually read this text already
      const next = state.apply(closeHistory(replaceBlocks(state, parsed.doc)));
      if (serializeMarkdown(next.doc, parsed.source) !== text) return false;
      this.comments.saveAnchorsNow();
      this.source = parsed.source;
      this.view.updateState(next);
      this.comments.reanchor({ active: commentRanges(state).active, selected: changeMarks(state).selected });
      this.countWords();
      this.showIfBlank();
      this.host.changed(this);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Open a link in the document: a web or email address in the browser, a
   * heading in this document comes into sight with the cursor at its start,
   * and the main process opens a document or shows another file in Finder,
   * or says it can't find it (app:open-link).
   */
  openLink(href: string): void {
    if (href.startsWith("#")) {
      const at = this.headingFor(href.slice(1));
      if (at !== null) {
        if (this.mode === "formatted") {
          this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, at + 1)));
          this.view.focus();
        }
        this.reveal(at);
        return;
      }
    }
    void this.host.api.openLink(href, this.id);
  }

  /** Open Link in the right-click menu: the link right-clicked. */
  openRightClickedLink(): void {
    if (this.rightClicked !== null) this.openLink(this.rightClicked);
  }

  /**
   * Where the heading a link's #part names is: by the address GitHub gives
   * it ("#risks-and-issues", a second one with the same words "-1"), or by
   * its words as Obsidian writes them ("#Risks%20and%20issues").
   */
  private headingFor(fragment: string): number | null {
    let wanted = fragment;
    try {
      wanted = decodeURIComponent(fragment);
    } catch {
      // as written
    }
    wanted = wanted.trim().toLowerCase();
    if (!wanted) return null;
    if (this.mode === "markdown") this.settle();
    const seen = new Map<string, number>();
    let found: number | null = null;
    this.view.state.doc.descendants((node, pos) => {
      if (found !== null) return false;
      if (node.type.name !== "heading") return !node.isTextblock;
      const words = node.textContent.trim().toLowerCase();
      const slug = words.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
      const times = seen.get(slug) ?? 0;
      seen.set(slug, times + 1);
      if ((times ? `${slug}-${times}` : slug) === wanted || words === wanted) found = pos;
      return false;
    });
    return found;
  }

  /** The Markdown text's selection in the editor's document, without reading the text again: null with none, or while typing is still to come in. */
  textSelection(): { from: number; to: number } | null {
    const { selectionStart, selectionEnd, value } = this.md.sourceEl;
    const spans = selectionStart === selectionEnd ? null : this.md.spansNow();
    return spans && docRange(this.view.state.doc, value, spans, selectionStart, selectionEnd);
  }

  /** The Markdown text and its preview scrolled by one distance at once, as Corillo's own (review.ts; review of Batch 11, B11R-4). */
  shiftHalves(by: number, from: { text: number; pane: number | null }): void {
    this.md.together.shift(by, from);
  }

  /** Scroll the document so a place in it is in sight: the page, or both the Markdown text and its preview; null: the top. */
  private reveal(pos: number | null): void {
    if (this.mode === "formatted") {
      if (pos === null) this.formattedEl.scrollTop = 0;
      else revealIn(this.view, this.formattedEl, pos);
      return;
    }
    this.settle();
    if (pos === null) return this.md.together.toTop();
    const spans = this.md.spansNow();
    if (spans) {
      // In sight in the text, and beside it in the preview.
      const at = markdownPlace(this.view.state.doc, pos, this.md.sourceEl.value, spans);
      this.md.sourceMarks.reveal(at);
      this.md.together.place(at, pos);
    } else if (this.md.preview && this.md.preview.state.doc === this.view.state.doc) revealIn(this.md.preview, this.md.previewPane, pos);
  }

  /**
   * Another tab is coming to the front. A comment, reply or edit being written
   * here gets the keyboard back when this tab does, so typing goes on in it
   * rather than over the words it's on.
   */
  putAway(): void {
    if (this.mode === "formatted") this.md.unkeepMarkdown(); // behind, it isn't laid out: nor is it held
    const resting = this.comments.restingOn();
    const box = this.comments.boxInUse();
    if (resting) this.restOnNext = resting;
    else if (box?.checkVisibility()) this.showUnpostedNext ??= box;
  }

  focus(): void {
    // Closed already (a moment after it opened, say): focusing would wake the
    // editor up again and keep the whole document in memory. Put away again
    // already: nothing there can take the keyboard, so the box it's to go back to is kept.
    if (this.view.isDestroyed || this.el.hidden) return;
    const box = this.showUnpostedNext;
    const card = this.restOnNext;
    this.showUnpostedNext = this.restOnNext = null;
    if (box?.isConnected) {
      this.comments.showUnposted(box);
      return;
    }
    if (card) {
      this.comments.keyboardTo(card);
      if (this.comments.keyboardOnCard) return;
    }
    // A version or Show changes in place of the page: the keyboard goes there, not nowhere (roadmap Batch 24, row 24: K-11).
    const version = this.el.querySelector<HTMLElement>(".version-view:not([hidden]) .version-page");
    if (version?.checkVisibility()) version.focus({ preventScroll: true });
    else if (this.mode === "markdown") this.md.sourceEl.focus();
    // Locked while an agent edits, the page can't take the keyboard: New comment does, as from the panel (review of Batch 12, B12-1).
    else if (this.readOnly) this.lockedKeyboard = this.comments.keyboardWhileLocked() ?? this.lockedKeyboard;
    else this.view.focus();
  }

  /**
   * The keyboard to the page itself (F6 coming round to it): the version shown, or the
   * text where the cursor was, in either view. Never a comment box or a card. False when
   * the page can't take it: the Formatted page while an agent edits it (review of Batch 12, B12-1).
   */
  focusPage(): boolean {
    if (this.view.isDestroyed || this.el.hidden) return false;
    const version = this.el.querySelector<HTMLElement>(".version-view:not([hidden]) .version-page");
    if (version?.checkVisibility()) {
      version.focus({ preventScroll: true });
      return document.activeElement === version;
    }
    if (this.mode === "markdown") {
      this.md.sourceEl.focus({ preventScroll: true });
      return document.activeElement === this.md.sourceEl;
    }
    this.view.focus();
    return this.view.hasFocus();
  }

  /** The keyboard back to the page with nothing selected there, as when a panel it was in goes (review of Batch 24, R24-1). */
  cursorToPage(): void {
    if (!this.view.isDestroyed && !this.el.hidden) this.comments.focusPage();
  }

  // Comments -------------------------------------------------------------------

  /**
   * Start a comment on these places in the document: the words selected on
   * Show changes' page, found in the document (an empty range: on the whole
   * document). Roadmap Batch 25, item 1.
   */
  addCommentOn(range: { from: number; to: number }): void {
    this.comments.add({ ...range, chosen: false });
  }

  /** Start a comment on the selected words (in either view), or on the whole document when nothing is selected. */
  addComment(): void {
    if (this.mode === "markdown") this.comments.add(this.md.markdownSelection());
    else {
      this.readPageSelection();
      this.comments.add();
    }
  }

  /**
   * The words selected on the page, as the browser has them now: words
   * selected with the keys reach the editor a moment later, so ⌥⌘M pressed
   * straight after made a comment on the whole document (code review of
   * Batch 16, S-1). Only a selection of words: a picture or table cells
   * selected stay as the editor has them.
   */
  private readPageSelection(): void {
    const page = document.getSelection();
    const now = this.view.state.selection;
    if (!page?.anchorNode || !page.focusNode || !(now instanceof TextSelection)) return;
    if (!this.view.dom.contains(page.anchorNode) || !this.view.dom.contains(page.focusNode)) return;
    let anchor: number;
    let head: number;
    try {
      anchor = this.view.posAtDOM(page.anchorNode, page.anchorOffset);
      head = this.view.posAtDOM(page.focusNode, page.focusOffset);
    } catch {
      return;
    }
    if (anchor === now.anchor && head === now.head) return;
    const doc = this.view.state.doc;
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.between(doc.resolve(anchor), doc.resolve(head))));
  }

  // Renaming and moving ---------------------------------------------------------

  /** Corillo put the file at a new place (Rename or Move, Save somewhere else): new name and place, and picture addresses that still point at the pictures. */
  atNewPlace(result: RenameResult): void {
    const newDirUrl = result.info.dirUrl;
    this.name = result.info.name;
    this.view.updateState(this.view.state); // the page's name for screen readers
    this.filePath = result.info.filePath;
    this.dirUrl = newDirUrl;
    // The page catches up with the Markdown text first; it keeps its Undo, and the text follows the addresses' fix (dispatch).
    if (this.mode === "markdown") this.settle();
    const tr = this.view.state.tr;
    this.view.state.doc.descendants((node, pos) => {
      if (node.type !== n.image) return true;
      const src = movedAddress(node.attrs.src, result.oldDirUrl, newDirUrl, result.movedImages);
      if (src) tr.setNodeMarkup(pos, null, { ...node.attrs, src });
      return false;
    });
    if (tr.docChanged) {
      // Part of the move, not an edit of the person's: Undo leaves it alone (the old addresses no longer lead anywhere).
      this.dispatch(tr.setMeta("addToHistory", false));
    }
    this.lookForEmbedsAgain(); // from the new place, its pictures folder perhaps renamed with it
    this.host.changed(this);
  }

  /** Pictures embedded the Obsidian way (![[chart.png]]) are looked for again, from where the document is now. */
  private lookForEmbedsAgain(): void {
    this.embedded.clear();
    lookForEmbedsAgain(this.view);
    if (this.md.preview) lookForEmbedsAgain(this.md.preview);
  }

  // Status ---------------------------------------------------------------------

  private setStatus(status: SaveState): void {
    this.status = status;
    this.host.changed(this);
  }

  /** The status bar's words for the save status. */
  statusLabel(): string {
    switch (this.status) {
      case "saved":
        return "Saved";
      case "pending":
        return "Saving…";
      case "conflict":
        return "Not saved: changed outside Corillo";
      case "recovered":
        return "Not saved: brought back after Corillo closed";
      case "missing":
        return `Not saved: ${this.problem ?? "the file was moved or deleted"}`;
      case "trashed":
        return "Not saved: the file is in the Trash";
      case "error":
        // (A save the safety net held back is tried again at the next change, not on a timer.)
        if (this.problem === HELD_BACK) return `Not saved: ${HELD_BACK}`;
        return `Not saved: ${this.problem ?? "something went wrong"}. Trying again…`;
    }
  }

  /**
   * The empty page's words on how to start (see blankHint), while the page is
   * empty: the document one empty line, nothing else, and nobody else editing
   * it. They go at the first keystroke, paste or agent's edit, and come back
   * if everything is taken out again. Looks at the document's top only, so it
   * costs nothing per keystroke.
   */
  private showIfBlank(): void {
    const doc = this.view.state.doc;
    const only = doc.childCount === 1 ? doc.firstChild : null;
    const blank = !this.readOnly && !!only && only.type === schema.nodes.paragraph && only.content.size === 0;
    if (this.blankHint.hidden !== blank) return;
    this.blankHint.hidden = !blank;
    if (!blank) this.blankCopied.textContent = "";
    this.comments.blankDocument(blank);
  }

  private countWords(): void {
    const doc = this.mode === "markdown" ? this.md.preview?.state.doc : this.view?.state.doc;
    if (!doc) return;
    this.words = wordCount(doc);
  }
}

/** Where the cursor starts: the first text, past the document's details at the top. */
function firstText(doc: EditorState["doc"]): Selection {
  const top = doc.firstChild;
  if (top?.type === schema.nodes.raw_block && top.attrs.kind === "front-matter") {
    const after = Selection.findFrom(doc.resolve(top.nodeSize), 1, true);
    if (after) return after;
  }
  return Selection.atStart(doc);
}
