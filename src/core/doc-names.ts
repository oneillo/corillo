// How a document's name reads where the person sees it (roadmap Batch 5,
// item 2): without ".md", as Word shows "Offsite notes" in its title bar, not
// "Offsite notes.docx". Every document in Corillo is Markdown, so the ending
// tells nothing apart there, and to someone who has never heard of Markdown it
// is the most technical-looking thing on the screen. Used on the tabs, the
// window's title, the start screen's cards, Corillo's notices and the Window
// menu. Places that tell files apart, or that agents read, keep the full name:
// the Save and Open dialogs, Finder, the connector's text and its answers,
// export file names.
//
// Always, rather than as Finder's "Show all filename extensions" says: files
// made by agents and command-line tools don't carry Finder's own "hide
// extension" mark, so Finder shows ".md" on nearly all of them whatever that
// setting is, and following it would put the ending back nearly everywhere.

// Markdown's endings, each set named once (the review of Batch 21, G21-13).
// They differ on purpose: what's shown without its ending, what opens, what
// an agent may create or a note link opens, and what dropping takes.

/** Taken off a name to show it (shownName): Markdown's own endings, not plain text's. */
const MARKDOWN_ENDING = /^(.*\S.*)\.(md|markdown|mdown)$/i;
/** What Corillo opens as a document: Markdown's endings, and plain text, which it opens as Markdown. */
export const OPENS_AS_MARKDOWN = /\.(md|markdown|mdown|txt)$/i;
/** What a document an agent creates may be called; also what a note link opens in Corillo (another file is shown in Finder). */
export const MARKDOWN_NAMED = /\.(md|markdown)$/i;
/** What dropping files on the window opens: what Corillo opens, and Word documents (as a Markdown copy). */
export const OPENS_WHEN_DROPPED = /\.(md|markdown|mdown|txt|docx|doc)$/i;

/** "Offsite notes.md" as "Offsite notes"; any other name as it is. */
export function shownName(fileName: string): string {
  const m = MARKDOWN_ENDING.exec(fileName);
  return m ? m[1] : fileName;
}

/**
 * What a blank document's Copy button puts on the clipboard (P-8), for the
 * person to finish in their agent's chat: the document's name and folder as
 * they see them, and a space after, to go on typing.
 */
export function draftRequest(fileName: string, folder: string): string {
  return `Write a first draft of "${shownName(fileName)}" in Corillo (it's in ${folder}). `;
}

/** Endings of other apps' documents, taken off a new document's name (Word's, and the like). */
const OTHER_APP_ENDING = /\.(docx?|dotx?|rtf|odt|pages|pdf)$/i;

/**
 * The file New Document makes for the name the person typed: always a
 * Markdown file. "Plan" and "Notes 11.11" get ".md"; a Word or other app's
 * ending is taken off first ("Plan.docx" is made as "Plan.md"), so Corillo
 * never makes an empty file another app would call damaged (B5-05); a
 * Markdown or text ending stays as typed.
 */
export function newDocumentName(typed: string): string {
  if (OPENS_AS_MARKDOWN.test(typed)) return typed; // an ending a new document's name keeps
  return `${typed.replace(OTHER_APP_ENDING, "") || typed}.md`;
}
