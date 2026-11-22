// The tabs' order, between the window and Corillo's main program (roadmap
// Batch 10, item 2: your tabs come back as you left them).
//
// Each time the tab bar is drawn, the window says the tabs' order, by id, if
// it changed: a tab opened, closed or moved, or a tab's document renamed or
// moved (its id stays, its place on disk changes). The main program keeps
// the list from it (src/main/open-tabs.ts). Which tab is in front reaches it
// on its own, as doc:active.
//
// The other way, once: at launch the main program puts the tabs it brought
// back in their order (it opens the one in front first, so the first
// document seen doesn't wait for the others).
import type { DocTab } from "./doc-tab";

const api = window.corillo;

/** What the window last said: each tab's id and file, in order. */
let told = "";
/** The window's tabs (app.ts keeps them, in the bar's order) and the drawing of the bar. */
let bar: { tabs: DocTab[]; draw: () => void } | null = null;

/** Called as the tab bar is drawn (at the end of renderTabs in app.ts): says the order, if it changed. */
export function tellTabOrder(tabs: DocTab[], draw: () => void): void {
  bar = { tabs, draw };
  const now = tabs.map((t) => `${t.id}\n${t.filePath}`).join("\n\n");
  if (now === told) return;
  told = now;
  api.tabOrder(tabs.map((t) => t.id));
}

// The main program puts the tabs in this order; those it doesn't name stay after them, as they were.
api.onPlaceTabs((ids) => {
  if (!bar || !Array.isArray(ids)) return;
  const { tabs, draw } = bar;
  const at = new Map(ids.map((id, i) => [id, i]));
  const placed = [...tabs].sort((a, b) => (at.get(a.id) ?? ids.length) - (at.get(b.id) ?? ids.length));
  if (placed.every((t, i) => t === tabs[i])) return;
  tabs.splice(0, tabs.length, ...placed);
  draw();
});
