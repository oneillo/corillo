// Walking the window by keys, for the standing test that every control can be
// reached in order with a focus you can see (roadmap Batch 12, item 3). Tab
// goes from control to control; at the page's text, which keeps Tab for
// indenting, F6 steps past it to the next area, as a person would, and the
// walk goes on from the first control after the text, so what F6 skips over
// (the side panel's edge, its header) is walked too. At each stop the focus is
// measured, in light and in dark, with contrast.ts: the look the keyboard
// brings against what is next to it, or against how the control looked
// before it came (review of Batch 12, B12-3).
import type { Page } from "@playwright/test";
import { focusInBoth, forgetLooks, rememberLooks } from "./contrast";

/** The window's areas, in the order they sit on screen and F6 goes round them. */
export const AREA_ORDER = ["tabs", "toolbar", "outline", "find bar", "line at the top", "page", "side panel", "notices", "status bar"] as const;
export type AreaName = (typeof AREA_ORDER)[number] | "start screen" | "dialog" | "menu" | "window";

export interface Stop {
  area: AreaName;
  /** The control: its tag and first classes, and its name. */
  what: string;
  /** How its focus shows, measured: "outline 4.2 in light, 3.4 in dark", "the cursor", "nothing in dark". */
  shows: string;
  /** The focus's contrast in light and in dark (the lower of the two); null where nothing was measured. */
  ratio: number | null;
  /** The page's own text, whose focus is its cursor (it draws no ring, by design). */
  text: boolean;
  /** The browser drew it as the keyboard's focus (:focus-visible). */
  visible: boolean;
}

export interface Walk {
  stops: Stop[];
  /** The areas in the order the walk met them, each once per run of stops in it. */
  areas: AreaName[];
  /** Controls showing that no Tab (or F6, then Shift-Tab) reached. */
  missed: string[];
  /** A place Tab couldn't leave, besides the page's text. */
  trapped: string[];
  /** Where each F6 from the page's text took the keyboard. */
  f6: AreaName[];
  /** Whether it came round to where it started. */
  cameRound: boolean;
}

/**
 * Runs in the window: what the keyboard is on now. Marks it, so a second visit is known; `after: "text"` first moves
 * the keyboard on to the first control after the page's text, round to the top if there's none, and `look` only
 * says where it is, marking nothing.
 */
function stepHere(how: "mark" | "look" | "after-text"): { key: string; again: boolean; text: boolean; stop: Stop | null } {
  document.getElementById("walk-start")?.remove();
  if (how === "after-text") {
    const SEL = "button, a[href], input:not([type='hidden']), select, textarea, summary, [tabindex]:not([tabindex='-1']), [contenteditable='true']";
    const text = [...document.querySelectorAll(".doc:not([hidden]) .views .ProseMirror, .doc:not([hidden]) textarea.source")].find((e) => e.checkVisibility())!;
    const all = [...document.querySelectorAll<HTMLElement>(SEL)].filter(
      (e) => !e.matches(":disabled") && e.tabIndex >= 0 && !e.closest(".ProseMirror *, [inert]") && e.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && e.getBoundingClientRect().width > 0,
    );
    const next = all.find((e) => !text.contains(e) && !!(text.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING)) ?? all[0];
    next?.focus();
  }
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return { key: "", again: false, text: false, stop: null };
  const AREAS: [string, string][] = [
    ["dialog[open], [role='dialog']", "dialog"], ["[role='menu']", "menu"], ["#tabs, .tabs-end", "tabs"], ["#toolbar", "toolbar"],
    [".outline-pane", "outline"], [".find-bar", "find bar"], [".doc-main > .banner, .agent-notice, .pass-notice", "line at the top"],
    [".views", "page"], [".comments-panel, .history-panel, .side-handle", "side panel"], [".corner-notices", "notices"],
    [".status-bar", "status bar"], ["#empty", "start screen"],
  ];
  const area = (AREAS.find(([sel]) => el.closest(sel))?.[1] ?? "window") as AreaName;
  const had = el.getAttribute("data-walk");
  if (how === "look") return { key: "", again: false, text: false, stop: { area, what: "", shows: "", ratio: null, text: false, visible: true } };
  if (!had) el.setAttribute("data-walk", String(document.querySelectorAll("[data-walk]").length + 1));
  const name = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const what = `${el.tagName.toLowerCase()}${[...el.classList].slice(0, 2).map((c) => `.${c}`).join("")} "${name}"`;
  const text = !!el.closest(".ProseMirror") || el.matches("textarea.source");
  return {
    key: el.getAttribute("data-walk")!,
    again: !!had,
    text,
    stop: { area, what, shows: "", ratio: null, text, visible: el.matches(":focus-visible") },
  };
}

/** Runs in the window: every control showing that Tab could stop on, and whether the walk reached it. */
function notReached(): string[] {
  const SEL = "button, a[href], input:not([type='hidden']), select, textarea, summary, [tabindex]:not([tabindex='-1']), [contenteditable='true']";
  const modal = [...document.querySelectorAll("dialog[open]")].find((d) => d.matches(":modal"));
  const widgets = "[role='tablist'], [role='menu'], [role='listbox'], [role='radiogroup'], .outline-pane";
  const reachedWidgets = new Set([...document.querySelectorAll("[data-walk]")].map((e) => e.closest(widgets)).filter(Boolean));
  const out: string[] = [];
  for (const el of (modal ?? document).querySelectorAll<HTMLElement>(SEL)) {
    if (el.hasAttribute("data-walk") || el.matches(":disabled") || el.tabIndex < 0 || el.closest("[inert], .screen-reader-only")) continue;
    if (el.closest(".ProseMirror") && !el.matches(".ProseMirror")) continue; // inside the text: the cursor's
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const widget = el.closest(widgets);
    if (widget && reachedWidgets.has(widget)) continue; // its own keys move inside it
    // A group of radio buttons is one stop: the arrows choose among them.
    if (el instanceof HTMLInputElement && el.type === "radio" && document.querySelector(`input[type='radio'][name='${CSS.escape(el.name)}'][data-walk]`)) continue;
    const name = (el.getAttribute("aria-label") || el.textContent || el.title || "").replace(/\s+/g, " ").trim().slice(0, 40);
    out.push(`${el.tagName.toLowerCase()}${[...el.classList].slice(0, 2).map((c) => `.${c}`).join("")} "${name}"`);
  }
  return out;
}

const frame = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/**
 * Walk the window from its top (or the open dialog's) with Tab, stepping past the page's text with F6, until the walk
 * comes round or `max` presses.
 */
export async function walkWindow(page: Page, max = 120): Promise<Walk> {
  await rememberLooks(page);
  await page.evaluate(() => {
    for (const e of document.querySelectorAll("[data-walk]")) e.removeAttribute("data-walk");
    const modal = [...document.querySelectorAll("dialog[open]")].find((d) => d.matches(":modal"));
    const start = document.createElement("span");
    start.id = "walk-start";
    start.tabIndex = -1;
    (modal ?? document.body).prepend(start);
    start.focus();
  });
  const stops: Stop[] = [];
  const trapped: string[] = [];
  const f6: AreaName[] = [];
  let cameRound = false;
  let previous = "";
  let nowhere = 0;
  for (let i = 0; i < max; i++) {
    const onText = stops.length > 0 && stops[stops.length - 1].area === "page" && (await page.evaluate(() => !!document.activeElement?.closest(".ProseMirror, textarea.source")));
    let how: "mark" | "after-text" = "mark";
    if (onText) {
      // F6 takes the keyboard out of the text; the walk then goes on from the first control after it.
      await page.keyboard.press("F6");
      await frame(page);
      f6.push((await page.evaluate(stepHere, "look" as const)).stop?.area ?? "window");
      how = "after-text";
    } else {
      await page.keyboard.press("Tab");
      await frame(page);
    }
    const here = await page.evaluate(stepHere, how);
    if (!here.key) {
      if (++nowhere > 3) break;
      continue;
    }
    nowhere = 0;
    if (here.again) {
      if (here.key === previous) trapped.push(stops[stops.length - 1]?.what ?? "?");
      else cameRound = true;
      break;
    }
    const stop = here.stop!;
    // Measured in light and in dark: the look the keyboard brings, the best way it shows.
    const seen = await focusInBoth(page);
    const ratios = [seen.light?.ratio, seen.dark?.ratio];
    stop.ratio = ratios.every((r) => typeof r === "number") ? Math.min(...(ratios as number[])) : null;
    stop.shows =
      stop.ratio !== null
        ? `${seen.light!.how} ${seen.light!.ratio} in light, ${seen.dark!.how} ${seen.dark!.ratio} in dark`
        : stop.text
          ? "the cursor"
          : `${seen.light?.how ?? "nothing"} in light, ${seen.dark?.how ?? "nothing"} in dark`;
    stops.push(stop);
    previous = here.key;
  }
  const missed = await page.evaluate(notReached);
  await forgetLooks(page);
  await page.evaluate(() => {
    for (const e of document.querySelectorAll("[data-walk]")) e.removeAttribute("data-walk");
    document.getElementById("walk-start")?.remove();
  });
  const areas: AreaName[] = [];
  for (const s of stops) if (areas[areas.length - 1] !== s.area) areas.push(s.area);
  return { stops, areas, missed, trapped, f6, cameRound };
}

/** The focus's contrast needed at every stop, in light and dark (WCAG 2.2: 3 to 1 against what is next to it). */
export const FOCUS_NEEDS = 3;

/** The stops whose focus can't be seen, or shows at less than 3 to 1 in light or dark (the page's text: its cursor). */
export const unseen = (walk: Walk): string[] =>
  walk.stops.filter((s) => !s.visible || (s.text ? false : s.ratio === null || s.ratio < FOCUS_NEEDS)).map((s) => `${s.area}: ${s.what} [${s.shows}]`);
