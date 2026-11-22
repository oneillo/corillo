// What the end-to-end tests and the real-agent trial (scripts/trial-agent.mjs)
// both do in Corillo's window, in one file so a fix reaches both (C21-20).
// Plain enough for Node to run as it is (types only, nothing from Playwright
// but its types), since the trial is a script, not a test.
import type { Page } from "@playwright/test";

/** The editor of the tab in front. */
export const EDITOR = ".doc:not([hidden]) .page.editor";

/**
 * Let the editor catch up with a click or a cursor move. The browser reports
 * those a moment later, and a test types faster than any person.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
}

/** Select some text in the document, as if dragged over with the mouse. */
export async function selectText(page: Page, text: string): Promise<void> {
  await page.evaluate(
    ([editor, wanted]) => {
      const root = document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!;
      root.focus();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent!.indexOf(wanted);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + wanted.length);
        // The editor reads the selection on the browser's "selectionchange" event, which comes later:
        // under a full run's load a click could arrive first, and a comment went on the whole document.
        // So wait for that event (the editor's own handler runs before ours), or half a second if none comes.
        const read = new Promise<void>((resolve) => {
          const done = () => { document.removeEventListener("selectionchange", done); clearTimeout(timer); setTimeout(resolve, 0); };
          const timer = setTimeout(done, 500);
          document.addEventListener("selectionchange", done);
        });
        const selection = getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        return read;
      }
      throw new Error(`"${wanted}" isn't in the document`);
    },
    [EDITOR, text] as const,
  );
  await settle(page);
}
