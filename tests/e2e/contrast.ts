// Contrast, focus, names and roles, measured as the window draws them. Grown from the measuring of roadmap
// Batch 12, item 2 (an accessibility review); the standing tests use it (Batch 12, item 3): every word and edge
// meets its contrast in both modes (design.spec.ts), Tab walks the window with a visible focus, and every control
// has a name and a role. The rules are WCAG 2.2's (public): words 4.5 to 1 (3 to 1 when large: 24 px, or
// 18.66 px bold), edges, "on" looks, graphics and focus rings 3 to 1 against what is next to them.
//
// Everything here measures; nothing asserts. The tests decide what must hold.
import type { Page } from "@playwright/test";

/** One colour pair measured on screen: its words or edge, what it's drawn on, the ratio and the ratio needed. */
export interface Pair {
  /** "word", "edge" (a control's border, ring or fill against its surface), "state" (the fill that shows a control on, chosen or open), "graphic" (an icon, a dot, the frog). */
  kind: "word" | "edge" | "state" | "graphic";
  /** The part of the window: tabs, toolbar, page, comments panel, … */
  part: string;
  /** The element, as tag#id.class. */
  what: string;
  /** Its visible words, or its name for a screen reader, cut short. */
  words: string;
  /** For an edge: "border", "ring" (box-shadow), "fill"; for a graphic: "icon", "dot", "frog"; for a word: its size. */
  how: string;
  ink: string;
  behind: string;
  ratio: number;
  need: number;
  /** How many on screen share this element, colours and ratio. */
  count: number;
  /** An edge that WCAG asks for (a field, a box, an icon alone), as against one the roadmap asks for on top. */
  wcag?: boolean;
}

export interface Measured {
  pairs: Pair[];
  /** Text drawn where something opaque covers it, or scrolled out: not counted. */
  hidden: number;
  /** Words on controls that can't be used right now: WCAG leaves them out. */
  inactive: number;
  /** Things the pointer turns into a hand on, with no role a screen reader would read as something to click. */
  clickableNoRole: string[];
  /** Links on the page told from their sentence by colour alone, with that colour's contrast against the sentence. */
  linksByColour: string[];
}

/**
 * Every word, every control's edge and every small graphic on screen, measured against what is drawn behind it.
 * The colour behind is found by stacking every element under the spot (the layers drawn below, translucent ones
 * composited, and any drawn over it), so marks laid behind the words and fades count.
 */
export function measure(page: Page): Promise<Measured> {
  return page.evaluate(() => {
    type RGBA = [number, number, number, number];
    const parse = (c: string | null | undefined): RGBA | null => {
      const m = c && /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const over = (top: RGBA, under: RGBA): RGBA => {
      const a = top[3];
      return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
    };
    const hex = (c: RGBA) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
    const lum = (c: RGBA) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (x: RGBA, y: RGBA) => {
      const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p);
      return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100;
    };
    const opacities = new Map<Element, number>();
    const opacityOf = (el: Element | null): number => {
      if (!el) return 1;
      const known = opacities.get(el);
      if (known !== undefined) return known;
      const o = parseFloat(getComputedStyle(el).opacity) * opacityOf(el.parentElement);
      opacities.set(el, o);
      return o;
    };
    const fillOf = (el: Element): RGBA | null => {
      const c = parse(getComputedStyle(el).backgroundColor);
      if (!c || c[3] === 0) return null;
      c[3] *= opacityOf(el);
      return c;
    };
    /** What shows at this spot from the elements list[from] down: each one's fill, bottom up. */
    const under = (list: Element[], from: number): RGBA => {
      let col: RGBA = [255, 255, 255, 1];
      for (let i = list.length - 1; i >= from; i--) {
        const f = fillOf(list[i]);
        if (f) col = over(f, col);
      }
      return col;
    };
    const PARTS: [string, string][] = [
      [".screen-reader-only", "screen reader only"],
      ["dialog", "dialog"],
      ["[role='menu'], .menu, #mention-list", "menu"],
      [".tabs", "tabs"],
      ["#toolbar", "toolbar"],
      [".status-bar", "status bar"],
      [".find-bar", "find bar"],
      [".export-notice, .notices, .notice", "notices"],
      [".comments-panel", "comments panel"],
      [".history-panel", "history"],
      [".outline-pane", "outline"],
      [".banner, .pass-notice, .agent-notice, .version-banner, .version-steps", "lines at the top"],
      [".ProseMirror, .version-page, .preview, .source, .page", "page"],
      ["#empty", "start screen"],
      [".about-head, .about-section, .about", "about"],
      [".help, .help-page, .help-nav, main", "help"],
    ];
    const partOf = (el: Element) => PARTS.find(([sel]) => el.closest(sel))?.[1] ?? "window";
    const nameOf = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${[...el.classList].slice(0, 3).map((c) => `.${c}`).join("")}`;
    const wordsOf = (el: Element) =>
      ((el.textContent ?? "").trim() || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").slice(0, 40);
    const inView = (r: DOMRect) => r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    const spot = (r: DOMRect): [number, number] => [
      Math.min(Math.max(r.left + Math.min(r.width / 2, 12), 0), innerWidth - 1),
      Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1),
    ];

    // Every element answers to a hit at its spot, so layers that ignore the pointer still count.
    const all = document.createElement("style");
    all.textContent = "*, *::before, *::after { pointer-events: auto !important; }";
    document.head.append(all);

    const found = new Map<string, Pair>();
    const add = (p: Omit<Pair, "count">) => {
      const key = [p.kind, p.part, p.what, p.how, p.ink, p.behind].join("|");
      const had = found.get(key);
      if (had) had.count++;
      else found.set(key, { ...p, count: 1 });
    };
    let hidden = 0;
    let inactive = 0;

    /** At a spot on el: what's drawn under it (with el's own fill) and the layers drawn over it, or null if covered. */
    const layersAt = (el: Element, x: number, y: number, withOwn: boolean): { below: RGBA; above: RGBA[] } | null => {
      const list = document.elementsFromPoint(x, y);
      const i = list.indexOf(el);
      if (i < 0) return null;
      const above: RGBA[] = [];
      for (let j = i - 1; j >= 0; j--) {
        if (el.contains(list[j])) continue; // its own children, drawn on it
        const f = fillOf(list[j]);
        if (!f) continue;
        if (f[3] > 0.98) return null; // covered
        above.push(f);
      }
      return { below: under(list, withOwn ? i : i + 1), above };
    };
    const seen = (c: RGBA, above: RGBA[]) => above.reduce((col, layer) => over(layer, col), c);
    /** Each shadow in a box-shadow, as the browser writes it: "rgb(…) 0px 2px 0px 0px inset, …". */
    const shadowsOf = (value: string) =>
      value === "none"
        ? []
        : value.split(/,(?![^(]*\))/).flatMap((part) => {
            const colour = parse(part);
            const n = part.replace(/rgba?\([^)]*\)/, "").match(/-?[\d.]+px/g)?.map(parseFloat) ?? [];
            return colour && colour[3] > 0 ? [{ colour, x: n[0] ?? 0, y: n[1] ?? 0, blur: n[2] ?? 0, spread: n[3] ?? 0, inset: /\binset\b/.test(part) }] : [];
          });

    // Words.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || !node.textContent?.trim()) continue;
      if (el.closest("svg, .diagram-picture, .screen-reader-only, style, script")) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = [...range.getClientRects()].find(inView);
      if (!rect) continue;
      const style = getComputedStyle(el);
      const ink = parse(style.webkitTextFillColor && style.webkitTextFillColor !== style.color ? style.webkitTextFillColor : style.color);
      if (!ink || ink[3] === 0) continue; // a copy of the words drawn in no colour, to place marks
      const at = layersAt(el, ...spot(rect), true);
      if (!at) {
        hidden++;
        continue;
      }
      if (el.closest(":disabled, [aria-disabled='true']")) {
        inactive++;
        continue;
      }
      const drawnInk = seen(over([ink[0], ink[1], ink[2], ink[3] * opacityOf(el)], at.below), at.above);
      const behind = seen(at.below, at.above);
      const size = parseFloat(style.fontSize);
      const weight = parseInt(style.fontWeight, 10);
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      add({
        kind: "word",
        part: partOf(el),
        what: nameOf(el),
        words: node.textContent.trim().replace(/\s+/g, " ").slice(0, 40),
        how: `${Math.round(size * 10) / 10}px/${weight}`,
        ink: hex(drawnInk),
        behind: hex(behind),
        ratio: ratio(drawnInk, behind),
        need: large ? 3 : 4.5,
      });
    }
    // Words typed in fields, and a field's grey hint while empty.
    for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input:not([type='hidden'], [type='checkbox'], [type='radio']), textarea")) {
      const rect = field.getBoundingClientRect();
      if (!inView(rect) || !field.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const at = layersAt(field, ...spot(rect), true);
      if (!at) continue;
      const style = field.value ? getComputedStyle(field) : getComputedStyle(field, "::placeholder");
      const words = field.value || field.placeholder;
      const ink = parse(style.color);
      if (!words || !ink) continue;
      const drawnInk = seen(over(ink, at.below), at.above);
      const behind = seen(at.below, at.above);
      add({
        kind: "word", part: partOf(field), what: `${nameOf(field)}${field.value ? "" : "::placeholder"}`, words: words.slice(0, 40),
        how: `${parseFloat(style.fontSize)}px/${parseInt(style.fontWeight, 10)}`, ink: hex(drawnInk), behind: hex(behind), ratio: ratio(drawnInk, behind), need: 4.5,
      });
    }

    // Edges: what you click, against the surface it sits on. A border or a ring drawn with box-shadow is the edge;
    // with neither, the control's own fill against the surface is (WCAG 1.4.11). A control known by its words alone
    // (a text link) needs no edge; one known by an icon alone is measured by its icon, below.
    const CONTROLS = [
      "button", "input:not([type='hidden'])", "select", "textarea", "summary", "a[href]",
      "[role='button']", "[role='tab']", "[role='checkbox']", "[role='radio']", "[role='switch']", "[role='slider']", "[role='separator'][tabindex]",
      "[role='option']", "[role='combobox']", "[role='menuitem']", "[role='menuitemradio']", "[role='menuitemcheckbox']",
      ".comment-card", ".recent-card", "[tabindex]:not([tabindex='-1'])",
    ].join(", ");
    /** The first stroke or fill drawn by the control's own icon (not one inside a control of its own within it). */
    const iconOf = (el: Element): { colour: RGBA; shape: Element } | null => {
      for (const shape of el.querySelectorAll("svg path, svg line, svg circle, svg rect, svg polyline, svg polygon, svg ellipse")) {
        if (shape.closest("mask, defs, clipPath")) continue;
        if (el.matches(CONTROLS) && shape.parentElement!.closest(CONTROLS) !== el) continue;
        const svg = shape.closest("svg")!;
        if (!svg.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        const s = getComputedStyle(shape);
        if (s.display === "none" || s.visibility === "hidden") continue;
        for (const [paint, alpha] of [[s.stroke, s.strokeOpacity], [s.fill, s.fillOpacity]] as const) {
          const c = parse(paint);
          if (c && c[3] > 0 && parseFloat(alpha || "1") > 0) {
            c[3] *= parseFloat(alpha || "1") * opacityOf(shape);
            return { colour: c, shape };
          }
        }
      }
      return null;
    };
    // A control whose look says it is on, chosen or open: its fill is how that shows.
    const STATE = "[aria-pressed='true'], [aria-selected='true'], [aria-current]:not([aria-current='false']), [aria-expanded='true'], [aria-checked='true'], .on, .active";
    for (const el of document.querySelectorAll<HTMLElement>(CONTROLS)) {
      if (el.closest(".ProseMirror, .preview, .version-page, .screen-reader-only")) continue; // the page's own links are words
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const rect = el.getBoundingClientRect();
      if (!inView(rect)) continue;
      const [x, y] = [rect.left + rect.width / 2, rect.top + rect.height / 2];
      const at = layersAt(el, Math.min(Math.max(x, 0), innerWidth - 1), Math.min(Math.max(y, 0), innerHeight - 1), false);
      if (!at) continue;
      if (el.matches(":disabled, [aria-disabled='true']")) continue;
      const style = getComputedStyle(el);
      const surface = seen(at.below, at.above);
      const ownFill = fillOf(el);
      const filled = ownFill ? over(ownFill, at.below) : at.below;
      const fill = seen(filled, at.above);
      // An edge goes all the way round: a border on all four sides, or a ring drawn with box-shadow. A line on one
      // side only divides, and isn't an edge.
      const sides = (["top", "right", "bottom", "left"] as const)
        .map((side) => ({ w: parseFloat(style.getPropertyValue(`border-${side}-width`)), s: style.getPropertyValue(`border-${side}-style`), c: parse(style.getPropertyValue(`border-${side}-color`)) }))
        .filter((b) => b.w >= 1 && b.s !== "none" && b.c && b.c[3] > 0);
      const shadows = shadowsOf(style.boxShadow);
      const ring = shadows.find((sh) => !sh.inset && !sh.x && !sh.y && !sh.blur && sh.spread >= 1);
      const inset = shadows.find((sh) => sh.inset && !sh.x && !sh.y && !sh.blur && sh.spread >= 1);
      // A bar along one side, drawn inside (the card in focus's, the tab in front's): against the control's own
      // fill on one side and what is round it on the other.
      const bar = shadows.find((sh) => sh.inset && !sh.blur && !sh.spread && Math.max(Math.abs(sh.x), Math.abs(sh.y)) >= 2 && (!sh.x || !sh.y));
      let edge: { how: string; ink: RGBA; against?: RGBA } | null = null;
      if (sides.length === 4) edge = { how: "border", ink: seen(over(sides[0].c!, filled), at.above) };
      else if (ring) edge = { how: "ring", ink: seen(over(ring.colour, at.below), at.above) };
      else if (inset) edge = { how: "ring", ink: seen(over(inset.colour, filled), at.above) };
      else if (bar) edge = { how: "bar", ink: seen(over(bar.colour, filled), at.above), against: fill };
      const words = (el.textContent ?? "").trim();
      const field = el.matches("input:not([type='button'], [type='submit']), textarea, select, [role='combobox'], [role='checkbox'], [role='radio'], [role='switch'], [role='textbox']");
      const fillRatio = ratio(fill, surface);
      const edgeRatio = edge ? Math.min(ratio(edge.ink, surface), edge.against ? ratio(edge.ink, edge.against) : Infinity) : 0;
      const best = edgeRatio >= fillRatio && edge ? { how: edge.how, ink: edge.ink, r: edgeRatio } : { how: "fill", ink: fill, r: fillRatio };
      if (el.matches(STATE) && fillRatio > 1.01) {
        add({ kind: "state", part: partOf(el), what: nameOf(el), words: wordsOf(el), how: best.how, ink: hex(best.ink), behind: hex(surface), ratio: best.r, need: 3 });
      } else if (edge || fillRatio > 1.01) {
        // The edge counts against the surface outside it; a fill that already stands apart carries the edge too.
        add({ kind: "edge", part: partOf(el), what: nameOf(el), words: wordsOf(el), how: best.how, ink: hex(best.ink), behind: hex(surface), ratio: best.r, need: 3, wcag: field });
      }
      // An icon with no words is the control's only sign of what it does: its strokes against the control's fill.
      const icon = words ? null : iconOf(el);
      if (icon) {
        const ink = seen(over(icon.colour, filled), at.above);
        add({ kind: "graphic", part: partOf(el), what: nameOf(el), words: wordsOf(el), how: "icon", ink: hex(ink), behind: hex(fill), ratio: ratio(ink, fill), need: 3, wcag: true });
      }
    }
    // Small graphics that say something: dots (whose turn, something new, an agent's colour), the coquí.
    for (const el of document.querySelectorAll<HTMLElement>("[class*='dot'], [class*='swatch'], .coqui-frog, .coqui-mark")) {
      if (el.closest(".screen-reader-only") || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const rect = el.getBoundingClientRect();
      if (!inView(rect)) continue;
      const list = document.elementsFromPoint(Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1), Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1));
      // Its own box may not answer at its middle (a frog's legs): find where it sits by its parent.
      let i = list.indexOf(el);
      if (i < 0) i = list.indexOf(el.parentElement!) - 1;
      if (i < -1) continue;
      const below = under(list, i + 1);
      const style = getComputedStyle(el);
      if (el.matches(".coqui-frog, .coqui-mark")) {
        const icon = iconOf(el);
        const body = el.querySelector(".frog-body");
        const edgeShape = el.querySelector(".frog-edge");
        const colour = el.matches(".coqui-mark") ? parse(style.color) : parse(edgeShape ? getComputedStyle(edgeShape).fill : body ? getComputedStyle(body).fill : null) ?? icon?.colour ?? null;
        if (!colour) continue;
        const ink = over([colour[0], colour[1], colour[2], colour[3] * opacityOf(el)], below);
        add({ kind: "graphic", part: partOf(el), what: nameOf(el), words: el.matches(".coqui-mark") ? "the coquí mark" : "the coquí", how: el.matches(".coqui-mark") ? "frog" : "frog's outline", ink: hex(ink), behind: hex(below), ratio: ratio(ink, below), need: 3 });
        continue;
      }
      const own = fillOf(el);
      const border = parseFloat(style.borderLeftWidth) >= 1 ? parse(style.borderLeftColor) : null;
      const ring = /^(rgba?\([^)]*\))\s+0px\s+0px\s+0px\s+([\d.]+)px/.exec(style.boxShadow);
      const outline = border ?? (ring ? parse(ring[1]) : null);
      const shown = outline && outline[3] > 0 ? over(outline, below) : own ? over(own, below) : null;
      if (!shown) continue;
      add({ kind: "graphic", part: partOf(el), what: nameOf(el), words: (el.getAttribute("aria-label") || el.title || el.parentElement?.getAttribute("aria-label") || "").slice(0, 40), how: outline ? "dot's edge" : "dot", ink: hex(shown), behind: hex(below), ratio: ratio(shown, below), need: 3 });
    }

    // Looks clickable (the pointer becomes a hand) but has no role a screen reader would read as one.
    const clickableNoRole: string[] = [];
    const ROLE = "button, a[href], input, select, textarea, summary, label, [role='button'], [role='link'], [role='tab'], [role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox'], [role='option'], [role='checkbox'], [role='radio'], [role='switch'], [role='slider'], [role='separator'], [role='treeitem'], [role='article'], article, [role='listitem'] [role='button']";
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      if (el.closest(".ProseMirror, .preview, .version-page, svg")) continue;
      if (getComputedStyle(el).cursor !== "pointer") continue;
      if (el.parentElement && getComputedStyle(el.parentElement).cursor === "pointer") continue; // inherited
      if (el.closest(ROLE)) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || !inView(el.getBoundingClientRect())) continue;
      clickableNoRole.push(`${partOf(el)}: ${nameOf(el)} "${wordsOf(el)}"`);
    }
    // The page's links: underlined, or told from their sentence by 3 to 1 (WCAG 1.4.1).
    const linksByColour: string[] = [];
    for (const a of document.querySelectorAll<HTMLElement>(".ProseMirror a, .preview a")) {
      if (!a.checkVisibility() || !inView(a.getBoundingClientRect())) continue;
      const s = getComputedStyle(a);
      if (s.textDecorationLine.includes("underline")) continue;
      const r = ratio(parse(s.color)!, parse(getComputedStyle(a.parentElement!).color)!);
      linksByColour.push(`${nameOf(a)} "${wordsOf(a)}": ${s.color} against its sentence ${r}`);
    }
    all.remove();
    return { pairs: [...found.values()], hidden, inactive, clickableNoRole: [...new Set(clickableNoRole)], linksByColour: [...new Set(linksByColour)] };
  });
}

/** A stop on a Tab walk, and how its focus shows. */
export interface Stop {
  part: string;
  what: string;
  words: string;
  role: string;
  /** How the focus shows: "outline", "ring" (box-shadow), "border", "fill", "nothing". */
  how: string;
  /** The ring's colour, and what is next to it outside and inside. */
  ring: string | null;
  outside: string | null;
  inside: string | null;
  /** The ring against what is next to it (the lower of the two sides it touches), or the focused look against the unfocused one. */
  ratio: number | null;
  /** Whether the browser drew the keyboard's focus (:focus-visible). */
  visible: boolean;
  /** Tab didn't move on from here (the page keeps Tab for indenting, by design). */
  kept?: boolean;
}

/** How the focus shows on what has the keyboard now. Call with the keyboard there by Tab or its own keys. */
export function focusNow(page: Page): Promise<Stop | null> {
  return page.evaluate(() => {
    type RGBA = [number, number, number, number];
    const parse = (c: string | null | undefined): RGBA | null => {
      const m = c && /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const over = (top: RGBA, under: RGBA): RGBA => {
      const a = top[3];
      return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
    };
    const hex = (c: RGBA) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
    const lum = (c: RGBA) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (x: RGBA, y: RGBA) => {
      const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p);
      return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100;
    };
    const opacityOf = (el: Element | null): number => (el ? parseFloat(getComputedStyle(el).opacity) * opacityOf(el.parentElement) : 1);
    const fillOf = (el: Element): RGBA | null => {
      const c = parse(getComputedStyle(el).backgroundColor);
      if (!c || c[3] === 0) return null;
      c[3] *= opacityOf(el);
      return c;
    };
    const under = (list: Element[], from: number): RGBA => {
      let col: RGBA = [255, 255, 255, 1];
      for (let i = list.length - 1; i >= from; i--) {
        const f = fillOf(list[i]);
        if (f) col = over(f, col);
      }
      return col;
    };
    const PARTS: [string, string][] = [
      ["dialog", "dialog"], ["[role='menu'], .menu, #mention-list", "menu"], [".tabs", "tabs"], ["#toolbar", "toolbar"],
      [".status-bar", "status bar"], [".find-bar", "find bar"], [".export-notice, .notice", "notices"], [".comments-panel", "comments panel"],
      [".history-panel", "history"], [".outline-pane", "outline"], [".banner, .pass-notice, .agent-notice, .version-banner, .version-steps", "lines at the top"],
      [".ProseMirror, .version-page, .preview, .source, .page", "page"], ["#empty", "start screen"], [".about-head, .about-section, .about", "about"], ["main, nav", "help"],
    ];
    let el = document.activeElement as HTMLElement | null;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement as HTMLElement;
    if (!el || el === document.body) return null;
    const part = PARTS.find(([sel]) => el!.closest(sel))?.[1] ?? "window";
    const what = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${[...el.classList].slice(0, 3).map((c) => `.${c}`).join("")}`;
    const words = ((el.getAttribute("aria-label") || (el.textContent ?? "").trim() || el.getAttribute("title") || (el as HTMLInputElement).placeholder || "")).replace(/\s+/g, " ").slice(0, 40);
    const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
    const visible = el.matches(":focus-visible");
    const all = document.createElement("style");
    all.textContent = "*, *::before, *::after { pointer-events: auto !important; }";
    document.head.append(all);
    try {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1);
      const listIn = document.elementsFromPoint(Math.min(Math.max(rect.left + Math.min(4, rect.width / 2), 0), innerWidth - 1), cy);
      const inI = listIn.indexOf(el);
      const inside = inI >= 0 ? under(listIn, inI) : null;
      const outlineW = style.outlineStyle !== "none" ? parseFloat(style.outlineWidth) : 0;
      const ringShadow = /(rgba?\([^)]*\))\s+0px\s+0px\s+0px\s+([\d.]+)px(?!\s+inset)/.exec(style.boxShadow);
      const outsideAt = (gap: number): RGBA | null => {
        const ox = rect.left - gap - 1;
        return ox >= 0 ? under(document.elementsFromPoint(ox, cy), 0) : null;
      };
      type Way = { how: string; ring: RGBA; outside: RGBA | null; inside: RGBA | null; ratio: number };
      const ways: Way[] = [];
      const sidesOf = (ring: RGBA, outside: RGBA | null, inner: RGBA | null) => [outside, inner].filter((c): c is RGBA => !!c).map((c) => ratio(ring, c));
      if (outlineW >= 1) {
        const offset = parseFloat(style.outlineOffset);
        const outside = offset < 0 ? inside : outsideAt(Math.max(offset, 0) + outlineW);
        const ring = over(parse(style.outlineColor)!, outside ?? inside ?? [255, 255, 255, 1]);
        // With a gap the ring has what's outside on both sides; with none, the control's own fill inside.
        const inner = offset > 0 ? outside : inside;
        const r = sidesOf(ring, outside, inner);
        if (r.length) ways.push({ how: "outline", ring, outside, inside: inner, ratio: Math.min(...r) });
      }
      const borderC = (["top", "right", "bottom", "left"] as const).every((side) => parseFloat(style.getPropertyValue(`border-${side}-width`)) >= 1 && style.getPropertyValue(`border-${side}-style`) !== "none")
        ? parse(style.borderLeftColor)
        : null;
      if (ringShadow) {
        const outside = outsideAt(parseFloat(ringShadow[2]));
        const ring = over(parse(ringShadow[1])!, outside ?? inside ?? [255, 255, 255, 1]);
        if (outside) ways.push({ how: "ring", ring, outside, inside, ratio: ratio(ring, outside) });
        // A field shows its focus by its border turning blue-grey inside a soft ring: the border against the ring and the fill.
        if (borderC && inside) {
          const b = over(borderC, inside);
          ways.push({ how: "border in a ring", ring: b, outside: ring, inside, ratio: Math.min(ratio(b, ring), ratio(b, inside)) });
        }
      }
      // A line drawn by the control's ::before or ::after (the panels' edges, which light up when the keyboard is on them).
      for (const pseudo of ["::after", "::before"]) {
        const ps = getComputedStyle(el, pseudo);
        const c = parse(ps.backgroundColor);
        if (ps.content === "none" || !c || c[3] === 0) continue;
        const behind = outsideAt(-rect.width / 2) ?? inside;
        if (!behind) continue;
        const line = over(c, behind);
        ways.push({ how: `line (${pseudo.slice(2)})`, ring: line, outside: behind, inside: null, ratio: ratio(line, behind) });
      }
      // A change of border or fill from how it looked before the keyboard came (a field's border, a menu item's fill):
      // the focused colour against the unfocused one, and against what's next to it.
      const before = (window as unknown as { accessLooks?: Record<string, { border: string; fill: string }> }).accessLooks?.[el.getAttribute("data-access-look") ?? ""];
      if (before && inside) {
        const outside = outsideAt(0) ?? inside;
        const nowBorder = parse(style.borderLeftColor);
        const wasBorder = parse(before.border);
        if (borderC && nowBorder && wasBorder && style.borderLeftColor !== before.border) {
          const b = over(nowBorder, inside);
          ways.push({ how: "border turns", ring: b, outside: over(wasBorder, inside), inside, ratio: Math.min(ratio(b, over(wasBorder, inside)), ratio(b, inside), ratio(b, outside)) });
        }
        const wasFill = parse(before.fill);
        if (wasFill && style.backgroundColor !== before.fill) {
          const was = over(wasFill, outside);
          ways.push({ how: "fill turns", ring: inside, outside: was, inside: null, ratio: ratio(inside, was) });
        }
      }
      if (ways.length) {
        const best = ways.sort((a, b) => b.ratio - a.ratio)[0];
        return { part, what, words, role, how: best.how, ring: hex(best.ring), outside: best.outside && hex(best.outside), inside: best.inside && hex(best.inside), ratio: best.ratio, visible };
      }
      const caret = el.isContentEditable || el.matches("textarea, input");
      return { part, what, words, role, how: caret ? "the cursor only" : "nothing", ring: null, outside: null, inside: inside && hex(inside), ratio: null, visible };
    } finally {
      all.remove();
    }
  });
}

/**
 * How plainly the keyboard's arrival shows on a field or control: `focus` puts the keyboard there, and what changed
 * is measured against how it looked before (WCAG 2.2's focus appearance, 2.4.13): an outline or an outer ring
 * against what is round it, or a border that turns against the border it had. The best of these.
 */
export async function focusSeen(page: Page, selector: string, focus: () => Promise<void>): Promise<{ what: string; how: string; ratio: number }> {
  const look = (sel: string) =>
    page.evaluate((sel) => {
      type RGBA = [number, number, number, number];
      const parse = (c: string | null | undefined): RGBA | null => {
        const m = c && /rgba?\(([^)]+)\)/.exec(c);
        if (!m) return null;
        const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
      };
      const over = (top: RGBA, under: RGBA): RGBA => {
        const a = top[3];
        return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
      };
      const under = (list: Element[], from: number): RGBA => {
        let col: RGBA = [255, 255, 255, 1];
        for (let i = list.length - 1; i >= from; i--) {
          const c = parse(getComputedStyle(list[i]).backgroundColor);
          if (c && c[3] > 0) col = over(c, col);
        }
        return col;
      };
      const el = [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.checkVisibility());
      if (!el) throw new Error(`Nothing on screen for ${sel}`);
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1);
      const hit = document.elementsFromPoint(Math.min(Math.max(rect.left + 4, 0), innerWidth - 1), cy);
      const inside = under(hit, Math.max(hit.indexOf(el), 0));
      const outsideAt = (gap: number) => {
        const x = Math.max(rect.left - gap - 1, 0);
        const list = document.elementsFromPoint(x, cy);
        return under(list, 0);
      };
      const border = parseFloat(style.borderLeftWidth) >= 1 && style.borderLeftStyle !== "none" ? parse(style.borderLeftColor) : null;
      const outlineW = style.outlineStyle !== "none" ? parseFloat(style.outlineWidth) : 0;
      const ring = style.boxShadow
        .split(/,(?![^(]*\))/)
        .map((part) => ({ colour: parse(part), n: part.replace(/rgba?\([^)]*\)/, "").match(/-?[\d.]+px/g)?.map(parseFloat) ?? [], inset: /\binset\b/.test(part) }))
        .find((sh) => sh.colour && sh.colour[3] > 0 && !sh.inset && !sh.n[0] && !sh.n[1] && !sh.n[2] && (sh.n[3] ?? 0) >= 1);
      const offset = parseFloat(style.outlineOffset) || 0;
      return {
        what: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${[...el.classList].slice(0, 3).map((c) => `.${c}`).join("")}`,
        border: border && over(border, inside),
        outline: outlineW >= 1 ? { colour: parse(style.outlineColor)!, outside: outsideAt(Math.max(offset, 0) + outlineW) } : null,
        ring: ring ? { colour: ring.colour!, outside: outsideAt(ring.n[3]) } : null,
      };
    }, sel);
  const before = await look(selector);
  await focus();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const after = await look(selector);
  const ways: { how: string; ratio: number }[] = [];
  const hexOf = (c: number[]) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  const on = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]));
  if (after.outline && !before.outline) ways.push({ how: "outline", ratio: contrast(hexOf(on(after.outline.colour, after.outline.outside)), hexOf(after.outline.outside)) });
  if (after.ring) ways.push({ how: "ring", ratio: contrast(hexOf(on(after.ring.colour, after.ring.outside)), hexOf(after.ring.outside)) });
  if (after.border && before.border) ways.push({ how: "border turns", ratio: contrast(hexOf(after.border), hexOf(before.border)) });
  const best = ways.sort((a, b) => b.ratio - a.ratio)[0] ?? { how: "nothing", ratio: 1 };
  return { what: after.what, ...best };
}

/** Interactive and landmark roles: each needs a name a screen reader can read. */
const NEEDS_NAME = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox",
  "menuitemradio", "option", "slider", "spinbutton", "treeitem", "listbox", "menu", "menubar", "tablist", "tree", "dialog",
  "alertdialog", "toolbar", "tabpanel", "navigation", "complementary", "region", "form", "search", "article", "img", "image", "separator",
]);
/** Roles that say nothing about what a thing does: wrong for anything the keyboard can reach. */
const NO_ROLE = new Set(["generic", "none", "presentation", "StaticText", "paragraph", "group", "Section", "div", "LayoutTableCell", "InlineTextBox"]);

export interface Named {
  role: string;
  name: string;
  part: string;
  what: string;
  focusable: boolean;
  /** "richtext" or "plaintext" for a place to type, as the tree says. */
  editable?: string;
}

/**
 * Every node of the page's accessibility tree a screen reader would announce as something to use or a place to
 * go, with its role and name, and the ones that fall short: no name, or reachable with no role that says what it is.
 */
export async function namesAndRoles(page: Page): Promise<{ checked: Named[]; noName: Named[]; noRole: Named[] }> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as unknown as {
      nodes: { ignored: boolean; role?: { value: string }; name?: { value: string }; properties?: { name: string; value: { value: unknown } }[]; backendDOMNodeId?: number }[];
    };
    const checked: Named[] = [];
    const noName: Named[] = [];
    const noRole: Named[] = [];
    for (const n of nodes) {
      if (n.ignored || !n.backendDOMNodeId) continue;
      const role = n.role?.value ?? "";
      const name = (n.name?.value ?? "").trim();
      const prop = (p: string) => n.properties?.find((x) => x.name === p)?.value.value;
      const focusable = prop("focusable") === true;
      const hiddenNode = prop("hidden") === true;
      if (hiddenNode) continue;
      const interesting = NEEDS_NAME.has(role) || (focusable && NO_ROLE.has(role));
      if (!interesting) continue;
      // Where it is in the window, by the DOM node behind it.
      let part = "window";
      let what = "";
      let shown = true;
      try {
        const { object } = (await cdp.send("DOM.resolveNode", { backendNodeId: n.backendDOMNodeId })) as { object: { objectId?: string } };
        if (object.objectId) {
          const { result } = (await cdp.send("Runtime.callFunctionOn", {
            objectId: object.objectId,
            returnByValue: true,
            functionDeclaration: `function () {
              const el = this.nodeType === 1 ? this : this.parentElement;
              const PARTS = [["dialog","dialog"],["[role='menu'], .menu, #mention-list","menu"],[".tabs","tabs"],["#toolbar","toolbar"],[".status-bar","status bar"],[".find-bar","find bar"],[".export-notice, .notice","notices"],[".comments-panel","comments panel"],[".history-panel","history"],[".outline-pane","outline"],[".banner, .pass-notice, .agent-notice, .version-banner, .version-steps","lines at the top"],[".ProseMirror, .version-page, .preview, .source, .page","page"],["#empty","start screen"],[".about-head, .about-section, .about","about"],["main, nav","help"]];
              const part = (PARTS.find(([s]) => el.closest(s)) || [0, "window"])[1];
              const what = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + [...el.classList].slice(0, 3).map((c) => "." + c).join("");
              const r = el.getBoundingClientRect();
              const shown = el.checkVisibility({ visibilityProperty: true }) && r.width > 0 && r.height > 0;
              return { part, what, shown };
            }`,
          })) as { result: { value: { part: string; what: string; shown: boolean } } };
          ({ part, what, shown } = result.value);
          await cdp.send("Runtime.releaseObject", { objectId: object.objectId });
        }
      } catch {
        // A node gone while reading: leave its place unknown.
      }
      if (!shown) continue;
      const entry: Named = { role, name, part, what, focusable, ...(prop("editable") ? { editable: String(prop("editable")) } : {}) };
      checked.push(entry);
      if (NO_ROLE.has(role)) noRole.push(entry);
      // A landmark or group without a name is read by its role alone; for these, that is a gap only when there are several.
      else if (!name && !["region", "form", "toolbar", "tabpanel", "separator"].includes(role)) noName.push(entry);
      else if (!name && role === "separator" && focusable) noName.push(entry);
    }
    return { checked, noName, noRole };
  } finally {
    await cdp.detach();
  }
}

/** Every control a Tab walk could reach right now (inside the open dialog, when one is), and whether each was. */
export function tabbables(page: Page): Promise<{ what: string; words: string; part: string; inWidget: string | null; reached: boolean }[]> {
  return page.evaluate(() => {
    const SEL = "button, a[href], input:not([type='hidden']), select, textarea, summary, [tabindex]:not([tabindex='-1']), [contenteditable='true']";
    const PARTS: [string, string][] = [
      ["dialog", "dialog"], ["[role='menu'], .menu, #mention-list", "menu"], [".tabs", "tabs"], ["#toolbar", "toolbar"],
      [".status-bar", "status bar"], [".find-bar", "find bar"], [".export-notice, .notice", "notices"], [".comments-panel", "comments panel"],
      [".history-panel", "history"], [".outline-pane", "outline"], [".banner, .pass-notice, .agent-notice, .version-banner, .version-steps", "lines at the top"],
      [".ProseMirror, .version-page, .preview, .source, .page", "page"], ["#empty", "start screen"], [".about-head, .about-section, .about", "about"], ["main, nav", "help"],
    ];
    const modal = [...document.querySelectorAll("dialog[open]")].find((d) => d.matches(":modal"));
    const out: { what: string; words: string; part: string; inWidget: string | null; reached: boolean }[] = [];
    for (const el of (modal ?? document).querySelectorAll<HTMLElement>(SEL)) {
      if (el.matches(":disabled") || el.closest("[inert], .screen-reader-only")) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (el.closest(".ProseMirror") && !el.matches(".ProseMirror")) continue; // inside the document: the cursor's
      // Inside a widget that is one stop (the tab bar, a menu, a list), its own keys move among them.
      const widget = el.closest("[role='tablist'], [role='menu'], [role='listbox'], [role='tree'], [role='radiogroup'], [role='grid'], .outline-pane");
      const radios = el.matches("input[type='radio']") ? `radios ${(el as HTMLInputElement).name}` : null;
      out.push({
        what: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${[...el.classList].slice(0, 3).map((c) => `.${c}`).join("")}`,
        words: (el.getAttribute("aria-label") || (el.textContent ?? "").trim() || el.title || "").replace(/\s+/g, " ").slice(0, 40),
        part: PARTS.find(([sel]) => el.closest(sel))?.[1] ?? "window",
        inWidget: radios ?? (widget ? widget.getAttribute("role") ?? widget.className : null),
        reached: el.hasAttribute("data-access-reached"),
      });
    }
    return out;
  });
}

/**
 * Before a walk: how each control looks without the keyboard, in light and in dark, so focusInBoth can measure its
 * focused look against it (review of Batch 12, B12-3). Leaves the window in light, as the tests pin it.
 */
export async function rememberLooks(page: Page): Promise<void> {
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate((scheme) => {
      type Looks = Record<string, { border: string; fill: string; color: string }>;
      const w = window as unknown as { accessLooksBy?: Record<string, Looks> };
      const by = (w.accessLooksBy ??= {});
      const looks: Looks = (by[scheme] = {});
      let n = 0;
      for (const el of document.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, summary, [tabindex]")) {
        if (el.closest(".ProseMirror")) continue; // the editor watches its own DOM
        const id = String(++n);
        el.setAttribute("data-access-look", id);
        const s = getComputedStyle(el);
        looks[id] = { border: s.borderLeftColor, fill: s.backgroundColor, color: s.color };
      }
    }, scheme);
  }
}

/** After a walk: forget what rememberLooks kept. */
export function forgetLooks(page: Page): Promise<void> {
  return page.evaluate(() => {
    for (const el of document.querySelectorAll("[data-access-look]")) el.removeAttribute("data-access-look");
    const w = window as unknown as { accessLooks?: unknown; accessLooksBy?: unknown };
    delete w.accessLooks;
    delete w.accessLooksBy;
  });
}

/** How the focus shows on what has the keyboard now, in light and then dark (rememberLooks first). Leaves it in light. */
export async function focusInBoth(page: Page): Promise<{ light: Stop | null; dark: Stop | null }> {
  const out: { light: Stop | null; dark: Stop | null } = { light: null, dark: null };
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate((scheme) => {
      const w = window as unknown as { accessLooks?: unknown; accessLooksBy?: Record<string, unknown> };
      w.accessLooks = w.accessLooksBy?.[scheme];
      return new Promise((r) => requestAnimationFrame(r));
    }, scheme);
    out[scheme] = await focusNow(page);
  }
  await page.emulateMedia({ colorScheme: "light" });
  return out;
}

/**
 * Walk the window with Tab from its top until it comes round, or `max` stops. At a place that keeps Tab (the
 * page, which indents with it), the walk notes it and goes on from the next control in the window's order.
 */
export async function tabWalk(page: Page, max = 120): Promise<{ stops: Stop[]; cameRound: boolean; missed: { what: string; words: string; part: string; inWidget: string | null }[] }> {
  // Start from the top: a stand-in at the start of the window (or of the open dialog) takes the keyboard, then goes.
  await page.evaluate(() => {
    getSelection()?.removeAllRanges();
    const modal = [...document.querySelectorAll("dialog[open]")].find((d) => d.matches(":modal"));
    const start = document.createElement("span");
    start.id = "access-walk-start";
    start.tabIndex = -1;
    (modal ?? document.body).prepend(start);
    start.focus();
    // How each control looks before the keyboard reaches it, so its focused look can be compared with it.
    const looks: Record<string, { border: string; fill: string; color: string }> = {};
    let n = 0;
    for (const el of document.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, summary, [tabindex]")) {
      if (el.closest(".ProseMirror")) continue; // the editor watches its own DOM
      const id = String(++n);
      el.setAttribute("data-access-look", id);
      const s = getComputedStyle(el);
      looks[id] = { border: s.borderLeftColor, fill: s.backgroundColor, color: s.color };
    }
    (window as unknown as { accessLooks: typeof looks }).accessLooks = looks;
  });
  const stops: Stop[] = [];
  let cameRound = false;
  let previous: string | null = null;
  const mark = () =>
    page.evaluate(() => {
      document.getElementById("access-walk-start")?.remove();
      const el = document.activeElement;
      if (!el || el === document.body) return "body";
      const had = el.getAttribute("data-access-reached");
      if (!had) el.setAttribute("data-access-reached", String(document.querySelectorAll("[data-access-reached]").length + 1));
      return had ? `again:${had}` : el.getAttribute("data-access-reached")!;
    });
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    let key = await mark();
    if (key === `again:${previous}`) {
      // Tab stayed where it was: note it, then go on from the next control in the window's order.
      stops[stops.length - 1].kept = true;
      const moved = await page.evaluate(() => {
        const SEL = "button, a[href], input:not([type='hidden']), select, textarea, summary, [tabindex]:not([tabindex='-1']), [contenteditable='true']";
        const here = document.activeElement!;
        const next = [...document.querySelectorAll<HTMLElement>(SEL)].find(
          (e) =>
            !e.matches(":disabled") && e.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && e.getBoundingClientRect().width > 0 &&
            !e.closest(".ProseMirror *") && !here.contains(e) && !!(here.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING),
        );
        if (!next) return false;
        next.focus();
        return true;
      });
      if (!moved) break;
      key = await mark();
    }
    if (key === "body") continue;
    if (key.startsWith("again:")) {
      cameRound = true;
      break;
    }
    previous = key;
    const stop = await focusNow(page);
    if (stop) stops.push(stop);
  }
  const all = await tabbables(page);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("[data-access-reached]")) el.removeAttribute("data-access-reached");
    for (const el of document.querySelectorAll("[data-access-look]")) el.removeAttribute("data-access-look");
    delete (window as unknown as { accessLooks?: unknown }).accessLooks;
  });
  // A control inside a one-stop widget counts as reached when the widget was: its own keys move to it.
  const widgetsReached = new Set(all.filter((c) => c.reached && c.inWidget).map((c) => c.inWidget));
  const missed = all.filter((c) => !c.reached && !(c.inWidget && widgetsReached.has(c.inWidget))).map(({ reached: _, ...c }) => c);
  return { stops, cameRound, missed };
}

/** WCAG 2's contrast ratio between two "#RRGGBB" colours. */
export function contrast(a: string, b: string): number {
  const lum = (h: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
}

/**
 * The colour nearest to `colour` in its own hue and saturation (only its lightness moved) that reaches `need`
 * against every one of `against`; null if none does. For a suggestion that stays in the palette's family.
 */
export function nearestPassing(colour: string, against: string[], need: number): string | null {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l0 = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l0 - 1));
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  const toHex = (l: number) => {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [rr, gg, bb] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return `#${[rr, gg, bb].map((v) => Math.round(Math.min(Math.max(v + m, 0), 1) * 255).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
  };
  for (let step = 1; step <= 100; step++) {
    for (const dir of [-1, 1]) {
      const l = l0 + (dir * step) / 200;
      if (l < 0 || l > 1) continue;
      const candidate = toHex(l);
      if (against.every((bg) => contrast(candidate, bg) >= need)) return candidate;
    }
  }
  return null;
}

/** The palette as the window has it now (light or dark), every custom colour by its name. */
export function palette(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    const root = getComputedStyle(document.documentElement);
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      const visit = (list: CSSRuleList) => {
        for (const rule of list) {
          if (rule instanceof CSSStyleRule) {
            for (const prop of rule.style) if (prop.startsWith("--")) out[prop] = root.getPropertyValue(prop).trim();
          } else if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
        }
      };
      visit(rules);
    }
    return out;
  });
}

const AGENTS = ["peach", "sky", "mint", "lilac", "ochre", "rose"];
const CALLOUTS = ["sky", "mint", "ochre", "rose", "lilac"].map((c) => `--callout-${c}`);
const SURFACES = ["--page", "--panel", "--side", "--chrome", "--ground", "--button", "--float", "--card-focus", "--hover", "--float-hover", "--accent-tint"];

/** Why a shading behind words is measured but not held to a ratio. */
const SHADING = "a shading behind words: WCAG gives it no ratio; the words on it are held to 4.5, and each has another sign (its card, an underline, Find's count)";

/**
 * The page's own colours and the palette's pairs, by their names in style.css: what each is drawn on, and the
 * ratio it needs. "word" is WCAG's 4.5 to 1; "edge" and "graphic" 3 to 1; "mark" (a shading behind words) is listed
 * against 3 to 1 for comparison. A pair with a `why` is measured and reported but not held to its ratio, for the
 * reason given. Together they cover the states no scene draws: under the pointer, while pressed, every agent's colour.
 */
export const PAGE_PAIRS: { what: string; kind: "word" | "edge" | "graphic" | "mark"; ink: string; on: string[]; need: number; why?: string }[] = [
  { what: "selected words", kind: "word", ink: "--ink", on: ["--accent-line"], need: 4.5 },
  { what: "the page's words", kind: "word", ink: "--ink", on: ["--page", "--comment-mark", "--comment-mark-active", "--change-mark", "--diff-added", "--find-tint", "--find-current", "--highlight-mark", "--raw", ...CALLOUTS], need: 4.5 },
  { what: "headings' ink", kind: "word", ink: "--accent-ink", on: ["--page", "--comment-mark", "--change-mark", "--diff-added"], need: 4.5 },
  { what: "headings and links in the comment in focus (in dark they take the ink)", kind: "word", ink: "--focused-comment-ink", on: ["--comment-mark-active"], need: 4.5 },
  { what: "soft words (times, quotes, Obsidian's marks, hints)", kind: "word", ink: "--ink-soft", on: [...SURFACES, "--chip", "--raw", ...CALLOUTS], need: 4.5 },
  { what: "line numbers", kind: "word", ink: "--line-number", on: ["--page"], need: 4.5 },
  { what: "blue-grey words (links, status, the card's label)", kind: "word", ink: "--accent-ink", on: SURFACES, need: 4.5 },
  { what: "words removed (Show changes, an older version)", kind: "word", ink: "--diff-removed", on: ["--page", "--diff-removed-tint", "--card-focus"], need: 4.5 },
  { what: "words that need him (warm banners)", kind: "word", ink: "--warning-ink", on: ["--warn-tint", "--page"], need: 4.5 },
  { what: "words on the main button", kind: "word", ink: "--on-accent", on: ["--accent", "--accent-strong"], need: 4.5 },
  { what: "an agent's initial on its colour", kind: "word", ink: "--agent-ink", on: AGENTS.map((a) => `--agent-${a}`), need: 4.5 },
  { what: "commented words' shading", kind: "mark", ink: "--comment-mark", on: ["--page"], need: 3, why: SHADING },
  { what: "the comment in focus, against the others", kind: "mark", ink: "--comment-mark-active", on: ["--page", "--comment-mark"], need: 3, why: SHADING },
  { what: "the coral line (under the comment being written, beside a card's quote)", kind: "graphic", ink: "--coral-line", on: ["--page", "--side", "--panel", "--card-focus"], need: 3 },
  { what: "the coral line, inside the comment in focus's shading", kind: "graphic", ink: "--coral-line", on: ["--comment-mark-active"], need: 3, why: "it runs along the foot of the shading, against the page below it (held above); the shading itself marks the comment" },
  { what: "an agent's change for a comment (shading)", kind: "mark", ink: "--change-mark", on: ["--page"], need: 3, why: SHADING },
  { what: "an agent's change: its underline, the outline's dot, the card's swatch", kind: "graphic", ink: "--change-mark-line", on: ["--page", "--change-mark", "--panel", "--side"], need: 3 },
  { what: "words added (Show changes)", kind: "mark", ink: "--diff-added", on: ["--page"], need: 3, why: SHADING },
  { what: "words added: their underline", kind: "graphic", ink: "--diff-added-line", on: ["--page"], need: 3 },
  { what: "Find's matches", kind: "mark", ink: "--find-tint", on: ["--page"], need: 3, why: SHADING },
  { what: "Find's current match, against the others", kind: "mark", ink: "--find-current", on: ["--page", "--find-tint"], need: 3, why: SHADING },
  { what: "==highlights==", kind: "mark", ink: "--highlight-mark", on: ["--page"], need: 3, why: SHADING },
  // Read Aloud (roadmap Batch 14, item 4): every ink the page's words take, on the sentence being read and the word being said.
  { what: "words being read aloud", kind: "word", ink: "--ink", on: ["--read-mark", "--read-word"], need: 4.5 },
  { what: "headings and links being read aloud", kind: "word", ink: "--accent-ink", on: ["--read-mark", "--read-word"], need: 4.5 },
  { what: "soft words being read aloud", kind: "word", ink: "--ink-soft", on: ["--read-mark", "--read-word"], need: 4.5 },
  { what: "the sentence being read aloud", kind: "mark", ink: "--read-mark", on: ["--page"], need: 3, why: SHADING },
  { what: "the word being said, against its sentence", kind: "mark", ink: "--read-word", on: ["--page", "--read-mark"], need: 3, why: SHADING },
  { what: "the word being said: its underline", kind: "graphic", ink: "--accent", on: ["--read-word"], need: 3 },
  { what: "the focus ring (blue-grey)", kind: "graphic", ink: "--accent", on: [...SURFACES, "--chip", "--pressed"], need: 3 },
  { what: "edges of what you click, also under the pointer", kind: "edge", ink: "--control-line", on: SURFACES, need: 3 },
  { what: "a comment card's edge (quiet on purpose)", kind: "edge", ink: "--card-line", on: ["--side", "--panel"], need: 3, why: "Batch 9 keeps it quiet so the card in focus (its wash, bar and edge) stands out; a card isn't a control, its buttons are held" },
  { what: "lines between areas", kind: "edge", ink: "--chrome-line", on: ["--chrome", "--panel", "--page", "--side"], need: 3, why: "not a control's edge: WCAG gives them no ratio, and the spec wants them calmer than one" },
  { what: "a field's line while typing", kind: "edge", ink: "--accent", on: ["--page", "--accent-tint"], need: 3 },
  { what: "an agent's colour as a dot or a frog's body", kind: "graphic", ink: "", on: ["--chrome", "--panel", "--page", "--side", "--accent-tint", "--card-focus"], need: 3, why: "the pastel is the dot's fill: every dot and frog carries an edge, held in the next pair and the coquí's" },
  { what: "an agent's dot's edge", kind: "graphic", ink: "", on: ["--chrome", "--panel", "--page", "--side", "--card-focus", "--accent-tint"], need: 3 },
  { what: "the coquí's outline and smile", kind: "graphic", ink: "--agent-ink", on: ["--chrome", "--panel", "--page", "--accent-tint"], need: 3 },
  { what: "something on: a pressed toolbar button's edge, the view in front's, the front tab's line, the chosen item's bar", kind: "graphic", ink: "--accent", on: ["--accent-tint", "--panel", "--chrome", "--pressed", "--button", "--float", "--float-hover"], need: 3 },
];

/** Each of PAGE_PAIRS measured in a palette: one row per colour pair, the agents' colours spread out. */
export function pagePairs(colours: Record<string, string>): { what: string; kind: string; ink: string; inkName: string; on: string; onName: string; ratio: number; need: number; why?: string }[] {
  const hexOf = (name: string) => {
    const v = colours[name];
    return v && /^#[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : null;
  };
  const rows: { what: string; kind: string; ink: string; inkName: string; on: string; onName: string; ratio: number; need: number; why?: string }[] = [];
  for (const pair of PAGE_PAIRS) {
    const inks = pair.ink
      ? [pair.ink]
      : pair.what.includes("edge")
        ? AGENTS.map((a) => `--agent-${a}-edge`)
        : AGENTS.map((a) => `--agent-${a}`);
    for (const inkName of inks) {
      for (const onName of pair.on) {
        const [ink, on] = [hexOf(inkName), hexOf(onName)];
        if (!ink || !on) continue;
        rows.push({ what: pair.what, kind: pair.kind, ink, inkName, on, onName, ratio: contrast(ink, on), need: pair.need, ...(pair.why ? { why: pair.why } : {}) });
      }
    }
  }
  return rows;
}

/** The menu bar's items, as the Mac reads them out: every one with words, and how many there are. */
export function menuNames(app: import("@playwright/test").ElectronApplication): Promise<{ items: number; noLabel: string[] }> {
  return app.evaluate(({ Menu }) => {
    const noLabel: string[] = [];
    let items = 0;
    const walk = (menu: Electron.Menu | null | undefined, path: string) => {
      for (const item of menu?.items ?? []) {
        if (item.type === "separator") continue;
        items++;
        const label = item.label || (item.role ? `(${item.role}, named by the Mac)` : "");
        if (!label.trim()) noLabel.push(`${path} > item ${item.id || "?"}`);
        walk(item.submenu, `${path} > ${label}`);
      }
    };
    walk(Menu.getApplicationMenu(), "menu bar");
    return { items, noLabel };
  });
}
