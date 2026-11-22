// Word and PDF export, from the window: the Export menu at the right of the
// toolbar (also File > Export to Word… and Export to PDF…), the Export
// Settings sheet, and the notice that says where the export went, with
// buttons to open it or show it in the Finder. The Export menu also has Copy
// for Email (also in the Edit menu), whose notice offers the subject to copy.
// Each document has its own notice (roadmap Batch 4, item 3): it sits in the
// document's tab, so it goes when the person goes to another tab, is there
// again on coming back, and goes with the tab when it closes.
import type { CorilloApi } from "../preload/preload";
import type { ExportFileKind, ExportFormat, ExportSettings } from "../preload/export-api";
import type { DocTab } from "./doc-tab";
import { ICONS } from "./icons";
import { PopupMenu } from "./popup-menu";
import { fromButton, movable } from "./more";
import { copyForEmail, type EmailCopy } from "./copy";
import { cornerOf } from "./file-notice";

export interface ExportUiHost {
  api: CorilloApi;
  activeTab: () => DocTab | null;
  toolbar: HTMLElement;
}

const { export: ICON, chevron: CHEVRON, close: CLOSE } = ICONS;

const FORMAT_NAMES: Record<ExportFormat, string> = { docx: "Word", pdf: "PDF" };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function button(label: string, className = "", ariaLabel?: string): HTMLButtonElement {
  const b = el("button", className, label);
  b.type = "button";
  if (ariaLabel) b.setAttribute("aria-label", ariaLabel);
  return b;
}

const fileName = (p: string) => p.split("/").pop() ?? p;

// The notice ------------------------------------------------------------------------

class Notice {
  readonly el = el("div", "export-notice");
  /** Says how it went: blue-grey done, coral not done, grey still working. */
  private dot = el("span", "export-notice-dot");
  private text = el("span", "export-notice-text");
  private detail = el("span", "export-notice-detail");
  private openButton = button("Open");
  private revealButton = button("Show in Finder");
  private subjectButton = button("Copy subject");
  private closeButton = button("", "export-notice-close", "Close");
  private outputPath = "";
  private subject = "";

  constructor(
    private api: CorilloApi,
    place: HTMLElement,
  ) {
    this.el.hidden = true;
    this.el.setAttribute("role", "status");
    this.closeButton.innerHTML = CLOSE;
    const words = el("div", "export-notice-words");
    words.append(this.text, this.detail);
    this.el.append(this.dot, words, this.openButton, this.revealButton, this.subjectButton, this.closeButton);
    this.openButton.addEventListener("click", async () => {
      const problem = await this.api.openExported(this.outputPath);
      if (problem) this.failed(problem);
    });
    this.revealButton.addEventListener("click", () => void this.api.showExported(this.outputPath));
    // The subject on its own, for the email's subject line.
    this.subjectButton.addEventListener("click", () => {
      const html = this.subject.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      this.api.writeClipboard(`<meta charset="utf-8">${html}`, this.subject);
      this.text.textContent = "Copied the subject.";
    });
    this.closeButton.addEventListener("click", () => this.hide());
    cornerOf(place).append(this.el);
  }

  private show(state: string, text: string, detail = "", actions = false): void {
    this.el.dataset.state = state;
    this.el.setAttribute("role", state === "failed" ? "alert" : "status");
    this.text.textContent = text;
    this.detail.textContent = detail;
    this.detail.hidden = !detail;
    this.openButton.hidden = this.revealButton.hidden = !actions;
    this.subjectButton.hidden = true;
    this.closeButton.hidden = state === "working";
    this.el.hidden = false;
  }

  /** After Copy for Email: what was copied, and the subject, if any, with its own Copy button. */
  copiedForEmail(copy: EmailCopy | null, current: boolean): void {
    if (!copy) {
      this.show("failed", "There's nothing to copy yet.", "The document has no words.");
      return;
    }
    const what = !copy.copied ? "The email has no words yet." : current ? "Copied the current version for email." : "Copied for email.";
    this.subject = copy.subject ?? "";
    this.show("done", what, copy.subject !== null ? `Subject: ${copy.subject}` : "");
    this.subjectButton.hidden = !copy.subject;
  }

  working(format: ExportFormat): void {
    this.show("working", `Exporting to ${FORMAT_NAMES[format]}…`);
  }

  /**
   * Where the export went; `by` names the agent when an agent made it.
   * `current` says the current version was exported while an earlier one
   * was on screen (the export is always of the document as it is now).
   */
  done(outcome: { outputPath: string; name: string; notes: string[] }, by?: string, current = false): void {
    this.outputPath = outcome.outputPath;
    const what = by ? `${by} exported ${outcome.name}` : current ? `Exported the current version to ${outcome.name}` : `Exported to ${outcome.name}`;
    this.show("done", what, outcome.notes.join(" "), true);
  }

  failed(message: string): void {
    this.show("failed", "Couldn't export", message);
  }

  hide(): void {
    this.el.hidden = true;
  }
}

// The settings sheet ------------------------------------------------------------------

class SettingsSheet {
  private dialog = el("dialog", "sheet export-settings");
  private tabId = "";
  private settings: ExportSettings = { style: "corillo" };
  private corilloRadio!: HTMLInputElement;
  private wordRadio!: HTMLInputElement;
  private wordName = el("span", "file-name");
  private luaName = el("span", "file-name");
  private scriptName = el("span", "file-name");
  private removeLua = button("Remove", "", "Remove the Lua filter");
  private removeScript = button("Remove", "", "Remove the script");
  private advanced = el("details", "advanced");

  constructor(private api: CorilloApi) {
    const d = this.dialog;
    d.setAttribute("aria-label", "Export settings");
    const heading = el("h2", "", "Export settings");
    const note = el("p", "sheet-note", "These are for Word documents. PDFs use Corillo's own look.");

    const style = el("fieldset", "sheet-group");
    style.append(el("legend", "", "Style"));
    this.corilloRadio = this.radio(style, "corillo", "Corillo (clean)");
    this.wordRadio = this.radio(style, "word", "Use the styles of a Word document");
    const chooseWord = button("Choose…", "", "Choose a Word document");
    style.append(this.fileRow(this.wordName, chooseWord));
    chooseWord.addEventListener("click", () => void this.choose("word"));

    this.advanced.append(el("summary", "", "Advanced"));
    const chooseLua = button("Choose…", "", "Choose a Lua filter");
    chooseLua.addEventListener("click", () => void this.choose("lua"));
    this.removeLua.addEventListener("click", () => this.set({ luaFilter: undefined }));
    this.advanced.append(
      this.field("Lua filter", "A Pandoc Lua filter that changes the document on its way to Word.", this.fileRow(this.luaName, chooseLua, this.removeLua)),
    );
    const chooseScript = button("Choose…", "", "Choose a script");
    chooseScript.addEventListener("click", () => void this.choose("script"));
    this.removeScript.addEventListener("click", () => this.set({ script: undefined }));
    this.advanced.append(
      this.field(
        "Script to run afterwards",
        "An app to open the finished Word document in, or a script that touches it up. It gets the Word document's location.",
        this.fileRow(this.scriptName, chooseScript, this.removeScript),
      ),
    );

    const actions = el("div", "sheet-actions");
    const cancel = button("Cancel");
    const save = button("Save", "primary");
    // The keyboard starts on the main action, the one that looks it (roadmap Batch 11, F-20).
    save.autofocus = true;
    cancel.addEventListener("click", () => d.close());
    save.addEventListener("click", () => void this.save());
    actions.append(cancel, save);
    d.append(heading, note, style, this.advanced, actions);
    document.body.append(d);
  }

  private radio(parent: HTMLElement, value: "corillo" | "word", label: string): HTMLInputElement {
    const row = el("label", "radio-row");
    const input = el("input");
    input.type = "radio";
    input.name = "export-style";
    input.value = value;
    input.addEventListener("change", () => {
      if (!input.checked) return;
      // Word styles need a Word document to take them from: ask for one now.
      if (value === "word" && !this.settings.referenceDoc) void this.choose("word").then(() => this.render());
      else this.set({ style: value });
    });
    row.append(input, el("span", "", label));
    parent.append(row);
    return input;
  }

  private fileRow(name: HTMLElement, ...buttons: HTMLButtonElement[]): HTMLElement {
    const row = el("div", "file-row");
    row.append(name, ...buttons);
    return row;
  }

  private field(label: string, help: string, row: HTMLElement): HTMLElement {
    const f = el("div", "sheet-field");
    f.append(el("span", "sheet-label", label), el("p", "sheet-help", help), row);
    return f;
  }

  private set(change: Partial<ExportSettings>): void {
    this.settings = { ...this.settings, ...change };
    this.render();
  }

  private render(): void {
    const s = this.settings;
    this.corilloRadio.checked = s.style !== "word";
    this.wordRadio.checked = s.style === "word";
    this.wordName.textContent = s.referenceDoc ? fileName(s.referenceDoc) : "No document chosen";
    this.wordName.title = s.referenceDoc ?? "";
    this.wordName.classList.toggle("none", !s.referenceDoc);
    this.luaName.textContent = s.luaFilter ? fileName(s.luaFilter) : "None";
    this.luaName.title = s.luaFilter ?? "";
    this.luaName.classList.toggle("none", !s.luaFilter);
    this.removeLua.hidden = !s.luaFilter;
    this.scriptName.textContent = s.script ? fileName(s.script) : "None";
    this.scriptName.title = s.script ?? "";
    this.scriptName.classList.toggle("none", !s.script);
    this.removeScript.hidden = !s.script;
  }

  private async choose(kind: ExportFileKind): Promise<void> {
    const file = await this.api.chooseExportFile(this.tabId, kind);
    if (!file) return;
    if (kind === "word") this.set({ style: "word", referenceDoc: file });
    else if (kind === "lua") this.set({ luaFilter: file });
    else this.set({ script: file });
  }

  private async save(): Promise<void> {
    const s = { ...this.settings };
    // Word styles with no document to take them from means Corillo's own.
    if (s.style === "word" && !s.referenceDoc) s.style = "corillo";
    await this.api.saveExportSettings(this.tabId, s);
    this.dialog.close();
  }

  async open(tab: DocTab): Promise<void> {
    this.tabId = tab.id;
    this.settings = await this.api.exportSettings(tab.id);
    this.advanced.open = !!(this.settings.luaFilter || this.settings.script);
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
  }
}

// The Export menu ------------------------------------------------------------------------

export function setupExport(host: ExportUiHost): void {
  const { api } = host;
  const sheet = new SettingsSheet(api);
  let busy = false;
  /** Each tab's notice, made the first time it has something to say. */
  const notices = new WeakMap<HTMLElement, Notice>();
  const noticeIn = (place: HTMLElement): Notice => {
    let n = notices.get(place);
    if (!n) notices.set(place, (n = new Notice(api, place)));
    return n;
  };

  async function exportActive(format: ExportFormat): Promise<void> {
    const tab = host.activeTab();
    if (!tab || busy) return;
    const notice = noticeIn(tab.el);
    busy = true;
    try {
      await tab.saveNow();
      if (tab.status === "conflict") {
        notice.failed("This document was changed outside Corillo. Choose which version to keep, then export.");
        return;
      }
      if (tab.status !== "saved") {
        notice.failed("Your latest changes aren't saved yet (Corillo shows why at the bottom of the window). Sort that out, then export.");
        return;
      }
      const outputPath = await api.chooseExportPath(tab.id, format);
      if (!outputPath) return;
      // An earlier version on screen (History) isn't what's exported: say so.
      const earlierShown = tab.el.classList.contains("viewing-version");
      notice.working(format);
      const outcome = await api.exportDocument(tab.id, format, outputPath);
      if (outcome.status === "done") notice.done(outcome, undefined, earlierShown);
      else notice.failed(outcome.message);
    } finally {
      busy = false;
    }
  }

  function openSettings(): void {
    const tab = host.activeTab();
    if (tab) void sheet.open(tab);
  }

  /** Copy for Email: the whole document as it is now (also while an earlier version is on screen, which the notice says). */
  function copyEmail(): void {
    const tab = host.activeTab();
    if (!tab) return;
    noticeIn(tab.el).copiedForEmail(copyForEmail(tab), tab.el.classList.contains("viewing-version"));
  }

  // The toolbar button and its menu, like the toolbar's Insert and Table menus.
  const group = el("div", "tool-group export-group");
  const b = button("", "tool tool-menu", "Export");
  b.innerHTML = `${ICON}<span>Export</span>${CHEVRON}`;
  b.title = "Export to Word or PDF, or copy for email";
  b.setAttribute("aria-haspopup", "menu");
  b.setAttribute("aria-expanded", "false");
  group.append(b);
  host.toolbar.append(group);

  // An ellipsis where a box follows (the save box, the settings), as in the File menu (roadmap Batch 11, F-24).
  // The menu bar's words, in sentence case (roadmap Batch 24, row 28: W-16).
  const items: [string, () => void, boolean?][] = [
    ["Export to Word…", () => void exportActive("docx")],
    ["Export to PDF…", () => void exportActive("pdf")],
    ["Copy for email", copyEmail],
    ["Export settings…", openSettings, true],
  ];
  const menu = new PopupMenu(
    "Export",
    () =>
      items.map(([label, run, separatorBefore]) => ({
        label,
        run,
        separatorBefore,
        // One export at a time; the settings and copying can be used meanwhile.
        enabled: !!host.activeTab() && !(busy && (label === "Export to Word…" || label === "Export to PDF…")),
      })),
    () => host.activeTab()?.focus(),
  );
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", (e) => {
    if (menu.isOpen) menu.close();
    else menu.open(b, { keyboard: e.detail === 0 });
  });
  // The first to go into More in a narrow window: used once a document is finished, and in the File menu too.
  movable("export", b, () => [fromButton(b, menu)]);

  // An agent's export gets the same notice, with Open and Show in Finder, in its document's tab (the one in front, or the window, if that tab has gone).
  if (typeof api.onAgentExported === "function") {
    api.onAgentExported((done) => {
      const tab = done.docId ? document.querySelector<HTMLElement>(`.doc[data-doc-id="${CSS.escape(done.docId)}"]`) : null;
      noticeIn(tab ?? host.activeTab()?.el ?? document.body).done(done, done.agent);
    });
  }

  // File > Export to Word…, Export to PDF…, Export Settings…, and Edit > Copy for Email
  api.onMenu((action) => {
    if (action === "export:docx") void exportActive("docx");
    else if (action === "export:pdf") void exportActive("pdf");
    else if (action === "export:settings") openSettings();
    else if (action === "copy:email") copyEmail();
  });
}
