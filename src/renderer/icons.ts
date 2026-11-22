// Corillo's icons, all in one style: lines 1.5 pixels wide with round ends and
// corners, no fills (dots excepted). Icons on their own in a button are drawn
// on a 16-pixel grid; the small marks beside a word (a menu's chevron, a close
// cross) on a 12-pixel grid, with the same line.
const draw = (size: number, body: string) =>
  `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const icon = (body: string) => draw(16, body);
const mark = (body: string) => draw(12, body);
const dot = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="1" fill="currentColor" stroke="none"/>`;

export const ICONS = {
  undo: icon('<path d="M5.5 3.5 2.5 6.5l3 3"/><path d="M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7"/>'),
  redo: icon('<path d="m10.5 3.5 3 3-3 3"/><path d="M13.5 6.5h-7a3.5 3.5 0 0 0 0 7H9"/>'),
  link: icon(
    '<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.1-2.1a2.6 2.6 0 0 0-3.7-3.7l-.6.6"/><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.4 8.9a2.6 2.6 0 0 0 3.7 3.7l.6-.6"/>',
  ),
  bullets: icon(`${dot(3, 4)}${dot(3, 8)}${dot(3, 12)}<path d="M6 4h8M6 8h8M6 12h8"/>`),
  // Two numbered lines: a 1 and a 2 beside them.
  numbers: icon('<path d="M2 3.25 3.25 2.5v4"/><path d="M2 9.75a1.25 1.25 0 0 1 2.5.25c0 .9-2.5 1.6-2.5 3.5h2.5"/><path d="M7 4.5h7M7 11.5h7"/>'),
  // Opening quotation marks.
  quote: icon(
    '<path d="M6.5 4.5c-2 .6-3.5 2.2-3.5 4.5v2.5h3V8.5H3.2"/><path d="M13 4.5c-2 .6-3.5 2.2-3.5 4.5v2.5h3V8.5H9.7"/>',
  ),
  code: icon('<path d="M5.5 4 2 8l3.5 4"/><path d="M10.5 4 14 8l-3.5 4"/>'),
  plus: icon('<path d="M8 3v10M3 8h10"/>'),
  table: icon('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6.5h12M2 10h12M6.5 6.5V13"/>'),
  // A speech bubble with a plus: add a comment.
  comment: icon(
    '<path d="M3.5 2.5h9a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H8l-3 2.5v-2.5H3.5A1.5 1.5 0 0 1 2 10V4a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M8 4.8v4M6 6.8h4"/>',
  ),
  // A window with a column at its right: the Comments panel beside the page, the mirror of Outline's, so it
  // isn't taken for Comment's bubble when both show just their icons (roadmap Batch 11, F-30).
  comments: icon('<rect x="2" y="2.75" width="12" height="10.5" rx="1.5"/><path d="M9.5 2.75v10.5"/>'),
  // A page with a plus above a minus: what was added and what was taken out.
  changes: icon('<path d="M4 1.75h5.5l3 3v9a.75.75 0 0 1-.75.75h-7.75a.75.75 0 0 1-.75-.75v-11.25a.75.75 0 0 1 .75-.75z"/><path d="M8 5v4M6 7h4M6 11.5h4"/>'),
  // A window with a column at its left, as the Mac draws a sidebar: the outline beside the page.
  outline: icon('<rect x="2" y="2.75" width="12" height="10.5" rx="1.5"/><path d="M6.5 2.75v10.5"/>'),
  // A clock with an arrow turning back.
  history: icon('<path d="M2.75 8a5.25 5.25 0 1 0 1.6-3.8"/><path d="M2.5 2.25V5h2.75"/><path d="M8 5.25V8l2 1.5"/>'),
  export: icon('<path d="M8 10V2.5"/><path d="M5 5.5 8 2.5l3 3"/><path d="M3 9v3.5A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V9"/>'),
  check: icon('<path d="m3.5 8.5 3 3 6-7"/>'),
  previous: icon('<path d="m4.5 10 3.5-3.5 3.5 3.5"/>'),
  next: icon('<path d="m4.5 6 3.5 3.5 3.5-3.5"/>'),
  // Read Aloud (roadmap Batch 14, item 4): a speaker with two waves; and its bar's Pause (two bars) and Resume (a triangle).
  readAloud: icon('<path d="M2.5 6.25h2L8 3.5v9l-3.5-2.75h-2z"/><path d="M10.5 6a2.5 2.5 0 0 1 0 4"/><path d="M12.25 4.25a5 5 0 0 1 0 7.5"/>'),
  pause: icon('<path d="M5.5 3.5v9M10.5 3.5v9"/>'),
  play: icon('<path d="M5 3.25v9.5L12.5 8z"/>'),
  // Three dots: More, the buttons there's no room for.
  more: icon([3.25, 8, 12.75].map((x) => `<circle cx="${x}" cy="8" r="1.25" fill="currentColor" stroke="none"/>`).join("")),
  chevron: mark('<path d="m3.5 4.75 2.5 2.5 2.5-2.5"/>'),
  // A menu inside a menu opens to the side.
  chevronRight: mark('<path d="m4.75 3.5 2.5 2.5-2.5 2.5"/>'),
  close: mark('<path d="m3.5 3.5 5 5M8.5 3.5l-5 5"/>'),
};
