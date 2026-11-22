// Cleans HTML pasted from other apps (Word, Google Docs, Pages, Outlook, web
// pages) down to what a Markdown document can hold: headings, paragraphs,
// bold, italic, strikethrough, links, lists, quotes, code, tables and
// pictures. Fonts, colours, sizes, classes, spans, comments, empty paragraphs
// and Office's own markup are dropped. Word's list paragraphs (which are
// paragraphs with a bullet typed in, not real lists, in its HTML) become lists.

export interface Cleaned {
  html: string;
  /** Has formatting or structure beyond plain paragraphs. */
  rich: boolean;
  text: string;
}

type Style = Record<string, string>;

interface Ctx {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  href: string | null;
  /** In a heading or a table's header row: bold is implied, so not added. */
  plainBold: boolean;
  /** In a heading: no line breaks. */
  noBreaks: boolean;
  /** In a table cell: line breaks stay, and each paragraph goes on a line of its own. */
  cellLines?: boolean;
}

const char = (...codes: number[]) => String.fromCharCode(...codes);
const NBSP = new RegExp(char(0xa0), "g");
// Zero-width spaces and byte-order marks only: joiners hold emoji (and some scripts' words) together.
const INVISIBLE = new RegExp(`[${char(0x200b, 0xfeff)}]`, "g");

const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "center", "dd", "details", "dialog", "dir", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup",
  "hr", "li", "main", "menu", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot",
  "th", "thead", "tr", "ul",
]);
const BLOCK_SELECTOR = [...BLOCK].join(",");
// Dropped with everything inside them.
const DROP = new Set([
  "script", "style", "meta", "link", "title", "head", "noscript", "template", "iframe", "object", "embed",
  "video", "audio", "canvas", "svg", "math", "button", "input", "select", "textarea", "option", "map", "area",
  "xml", "o:p", "w:sdtpr", "colgroup", "col", "caption",
]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const RICH = "h1,h2,h3,h4,h5,h6,ul,ol,table,blockquote,pre,hr,img,strong,em,s,a,code";
const WORD_LIST = /mso-list:\s*l\d+/i;
const WORD_LIST_MARKER = /mso-list:\s*ignore/i;
const ORDERED_MARKER = /^\(?(\d+(\.\d+)*|[a-z]{1,3})[.)]?$/i;
// Bullets Word uses, including the letters its Symbol and Wingdings fonts draw as bullets.
const BULLET_MARKERS = new Set([
  ...[0xb7, 0x2022, 0x25aa, 0x25e6, 0x2023, 0x2219, 0x25cf, 0x25cb, 0x25a0, 0x25a1, 0xa7, 0xd8, 0xfc, 0x178, 0x2013, 0x2014, 0xbb, 0x27a2, 0x2713].map((c) => char(c)),
  "q", "v", "o", "-", "*",
]);

let doc: Document;
let classStyles = new WeakMap<Element, Style>();
let headingLevels = new Map<Element, number>();

const tag = (e: Element) => e.tagName.toLowerCase();

function parseDeclarations(text: string, into: Style): Style {
  for (const part of text.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const name = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).replace(/!important/i, "").trim().toLowerCase();
    if (name) into[name] = value;
  }
  return into;
}

/** Styles from the pasted page's style sheet (Word and Pages keep them there), then the element's own. */
function styleOf(e: Element): Style {
  const style: Style = { ...(classStyles.get(e) ?? {}) };
  const own = e.getAttribute("style");
  return own ? parseDeclarations(own, style) : style;
}

function readStyleSheets(d: Document): void {
  classStyles = new WeakMap();
  for (const sheet of [...d.styleSheets]) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of [...rules]) {
      if (!(rule instanceof CSSStyleRule)) continue;
      let matches: NodeListOf<Element>;
      try {
        matches = d.body.querySelectorAll(rule.selectorText);
      } catch {
        continue;
      }
      if (!matches.length) continue;
      const declared: Style = {};
      for (const name of [...rule.style]) declared[name] = rule.style.getPropertyValue(name).toLowerCase();
      for (const m of matches) classStyles.set(m, { ...(classStyles.get(m) ?? {}), ...declared });
    }
  }
}

function pixels(size: string | undefined): number {
  const m = /^([\d.]+)(px|pt)$/.exec(size ?? "");
  if (!m) return 0;
  return m[2] === "pt" ? (Number(m[1]) * 4) / 3 : Number(m[1]);
}

/**
 * Pages, TextEdit and Notes put their headings on the clipboard as paragraphs
 * in a bigger font. Paragraphs bigger than the body text become headings,
 * the biggest Heading 1.
 */
function findCocoaHeadings(d: Document): void {
  headingLevels = new Map();
  const generator = d.querySelector('meta[name="Generator" i]')?.getAttribute("content") ?? "";
  if (!/cocoa/i.test(generator) || d.querySelector("h1,h2,h3,h4,h5,h6")) return;
  const paragraphs = [...d.body.querySelectorAll("p")].map((p) => ({
    p,
    size: pixels(styleOf(p)["font-size"]),
    length: (p.textContent ?? "").trim().length,
  }));
  const weight = new Map<number, number>();
  for (const { size, length } of paragraphs) weight.set(size, (weight.get(size) ?? 0) + length);
  const body = [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  if (!body) return;
  const sizes = [...new Set(paragraphs.map((x) => x.size).filter((s) => s >= body * 1.15))].sort((a, b) => b - a);
  for (const { p, size, length } of paragraphs) {
    const level = sizes.indexOf(size);
    if (level >= 0 && length > 0 && length <= 120) headingLevels.set(p, Math.min(level + 1, 4));
  }
}

// What to leave out ---------------------------------------------------------

function dropped(e: Element): boolean {
  const name = tag(e);
  if (DROP.has(name) || name.startsWith("v:")) return true;
  const cls = e.getAttribute("class") ?? "";
  // Word's comments and the marks that point at them.
  if (/^(msocomoff|msocomtxt|MsoCommentReference)$/i.test(cls) || /msocomanchor/i.test(cls)) return true;
  const raw = (e.getAttribute("style") ?? "").toLowerCase();
  if (/mso-element:\s*comment/.test(raw) || /mso-hide:\s*all/.test(raw)) return true;
  if (/display:\s*none/.test(raw) || /visibility:\s*hidden/.test(raw)) return true;
  if (name === "a" && /^#(_msocom|_msoanchor|cmnt)/i.test(e.getAttribute("href") ?? "")) return true;
  // Tracked deletions (Word's track changes) aren't part of the text.
  if (name === "del" && (e.hasAttribute("cite") || e.hasAttribute("datetime"))) return true;
  return false;
}

const isMarker = (e: Element) => WORD_LIST_MARKER.test(e.getAttribute("style") ?? "");

// Inline content ------------------------------------------------------------

function isBold(weight: string): boolean {
  return /^(bold|bolder)$/.test(weight) || (/^\d+$/.test(weight) && Number(weight) >= 600);
}

// The kinds of link kept: web pages, mail and phone numbers, and (with no kind
// written) other files nearby. Any other kind is left as its words.
const KEPT_LINK = /^(https?|mailto|tel)$/i;

/** The link's address, if it's of a kind Corillo keeps. */
function keptHref(href: string): string | null {
  // As a browser reads it: tabs, line breaks and the like inside are ignored.
  const bare = href.replace(/[\u0000-\u0020\u007f]/g, "");
  // A file elsewhere on the Mac (an address from its top folder, "/Applications/..."), or another site's: not nearby.
  if (!bare || bare.startsWith("#") || bare.startsWith("/") || bare.startsWith("\\")) return null;
  const kind = /^([a-z][a-z0-9+.-]*):/i.exec(bare);
  return !kind || KEPT_LINK.test(kind[1]) ? href : null;
}

/** Where a pasted link goes, if it's of a kind Corillo keeps (see keptHref); null: paste its words alone. */
export function keptLink(address: string): string | null {
  const href = keptHref(address.trim());
  // Google's redirect links: keep where they go, if that's a kind kept.
  const redirect = href ? /^https?:\/\/(www\.)?google\.[a-z.]+\/url\?(.*)$/i.exec(href) : null;
  const target = redirect ? new URLSearchParams(redirect[2]).get("q") : null;
  return target ? keptHref(target) : href;
}

const cleanHref = (e: Element) => keptLink(e.getAttribute("href") ?? "");

function childCtx(e: Element, ctx: Ctx): Ctx {
  const next = { ...ctx };
  const name = tag(e);
  if (name === "b" || name === "strong") next.bold = true;
  if (name === "i" || name === "em" || name === "cite" || name === "dfn" || name === "var") next.italic = true;
  if (name === "s" || name === "strike" || name === "del") next.strike = true;
  if (name === "code" || name === "kbd" || name === "samp" || name === "tt") next.code = true;
  if (name === "a") next.href = cleanHref(e) ?? ctx.href;
  if (name === "th" || HEADINGS.has(name)) next.plainBold = true;
  const style = styleOf(e);
  if (style["font-weight"] !== undefined) next.bold = isBold(style["font-weight"]);
  if (style["font-style"] !== undefined) next.italic = /italic|oblique/.test(style["font-style"]);
  // A line through text can't be taken off by what's inside it, so it only ever turns on.
  if (`${style["text-decoration"] ?? ""} ${style["text-decoration-line"] ?? ""}`.includes("line-through")) next.strike = true;
  return next;
}

/** A run of text with its formatting, as tags a Markdown document can hold. */
function styledText(text: string, ctx: Ctx): Node {
  let node: Node = doc.createTextNode(text);
  const wrap = (name: string) => {
    const el = doc.createElement(name);
    el.append(node);
    node = el;
  };
  if (ctx.code) wrap("code");
  else {
    if (ctx.strike) wrap("s");
    if (ctx.italic) wrap("em");
    if (ctx.bold && !ctx.plainBold) wrap("strong");
  }
  if (ctx.href) {
    wrap("a");
    (node as Element).setAttribute("href", ctx.href);
  }
  return node;
}

/** A size of two pixels or less ("0", "1", "2px"). */
const tiny = (size: string | null | undefined) => {
  const m = /^\s*([\d.]+)\s*(px)?\s*$/i.exec(size ?? "");
  return !!m && Number(m[1]) <= 2;
};

function picture(e: Element, ctx: Ctx): Node | null {
  const src = (e.getAttribute("src") ?? "").trim();
  if (!src || /^(cid|about|blob):/i.test(src)) return null;
  // Tracking pixels in emails and web pages: two pixels or less across or down, however it's said.
  const style = styleOf(e);
  if ([e.getAttribute("width"), e.getAttribute("height"), style.width, style.height].some(tiny)) return null;
  const img = doc.createElement("img");
  img.setAttribute("src", src);
  const alt = (e.getAttribute("alt") ?? "").trim();
  if (alt) img.setAttribute("alt", alt);
  if (!ctx.href) return img;
  const a = doc.createElement("a");
  a.setAttribute("href", ctx.href);
  a.append(img);
  return a;
}

function appendInline(target: Element, node: Node, ctx: Ctx): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.nodeValue ?? "").replace(INVISIBLE, "").replace(NBSP, " ");
    if (text) target.append(styledText(text, ctx));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const e = node as Element;
  if (dropped(e) || isMarker(e)) return;
  const name = tag(e);
  if (name === "br") {
    target.append(ctx.noBreaks ? doc.createTextNode(" ") : doc.createElement("br"));
    return;
  }
  if (name === "img") {
    const img = picture(e, ctx);
    if (img) target.append(img);
    return;
  }
  const inner = childCtx(e, ctx);
  const block = BLOCK.has(name);
  if (block && ctx.cellLines) {
    const part = doc.createElement("span");
    for (const child of [...e.childNodes]) appendInline(part, child, inner);
    if (!hasContent(part)) return; // an empty paragraph adds no empty line
    if (hasContent(target) && target.lastChild?.nodeName !== "BR") target.append(doc.createElement("br"));
    target.append(...part.childNodes);
    return;
  }
  if (block && target.lastChild) target.append(doc.createTextNode(" "));
  for (const child of [...e.childNodes]) appendInline(target, child, inner);
  if (block) target.append(doc.createTextNode(" "));
}

const hasContent = (e: Element) => !!(e.textContent ?? "").trim() || !!e.querySelector("img");

// Blocks --------------------------------------------------------------------

/** The next child after `i` that shows something (an element, or text that isn't only spacing); -1 if none does. */
function nextContentIndex(kids: Node[], i: number): number {
  for (let j = i + 1; j < kids.length; j++) {
    const k = kids[j];
    if (k.nodeType === Node.ELEMENT_NODE && !dropped(k as Element)) return j;
    if (k.nodeType === Node.TEXT_NODE && (k.nodeValue ?? "").replace(NBSP, " ").trim()) return j;
  }
  return -1;
}

const isWordListParagraph = (e: Element) =>
  /^(p|div|h[1-6])$/.test(tag(e)) && WORD_LIST.test(e.getAttribute("style") ?? "");

/** Fill `out` with clean blocks made from the children of `el`. */
function blocks(el: Element, ctx: Ctx, out: Element, paragraphTag = "p"): void {
  let para: Element | null = null;
  const flush = () => {
    if (para && hasContent(para)) out.append(para);
    para = null;
  };
  const current = () => (para ??= doc.createElement(paragraphTag));
  const kids = [...el.childNodes];
  for (let i = 0; i < kids.length; i++) {
    const node = kids[i];
    if (node.nodeType === Node.TEXT_NODE) {
      if (para || (node.nodeValue ?? "").replace(NBSP, " ").trim()) appendInline(current(), node, ctx);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const e = node as Element;
    if (dropped(e)) continue;
    const name = tag(e);
    if (name === "br") {
      // Two line breaks in a row separate paragraphs; one is a line break,
      // kept only when more of the paragraph follows it.
      const next = nextContentIndex(kids, i);
      const after = next >= 0 ? kids[next] : null;
      const element = after?.nodeType === Node.ELEMENT_NODE ? (after as Element) : null;
      if (element && tag(element) === "br") {
        flush();
        i = next;
      } else if (para && after && !(element && (BLOCK.has(tag(element)) || isWordListParagraph(element) || element.querySelector(BLOCK_SELECTOR)))) {
        appendInline(para, e, ctx);
      }
      continue;
    }
    if (isWordListParagraph(e)) {
      flush();
      i = wordList(kids, i, ctx, out);
      continue;
    }
    if (BLOCK.has(name) || e.querySelector(BLOCK_SELECTOR)) {
      flush();
      block(e, ctx, out);
      continue;
    }
    appendInline(current(), e, ctx);
  }
  flush();
}

function block(e: Element, ctx: Ctx, out: Element): void {
  const name = tag(e);
  const inner = childCtx(e, ctx);
  if (HEADINGS.has(name) || (name === "p" && /\bMsoTitle\b/.test(e.getAttribute("class") ?? ""))) {
    const level = HEADINGS.has(name) ? name : "h1";
    blocks(e, { ...inner, plainBold: true, noBreaks: true }, out, level);
  } else if (name === "p" && headingLevels.has(e)) {
    blocks(e, { ...inner, plainBold: true, noBreaks: true }, out, `h${headingLevels.get(e)}`);
  } else if (name === "p" || name === "dt" || name === "dd" || name === "summary" || name === "figcaption") {
    blocks(e, inner, out, "p");
  } else if (name === "blockquote") {
    const quote = doc.createElement("blockquote");
    blocks(e, inner, quote);
    if (quote.childNodes.length) out.append(quote);
  } else if (name === "ul" || name === "ol" || name === "dir" || name === "menu") {
    list(e, inner, out);
  } else if (name === "li") {
    const wrapper = doc.createElement("ul");
    wrapper.setAttribute("data-tight", "true");
    wrapper.append(listItem(e, inner));
    out.append(wrapper);
  } else if (name === "pre") {
    codeBlock(e, out);
  } else if (name === "table") {
    table(e as HTMLTableElement, inner, out);
  } else if (name === "hr") {
    out.append(doc.createElement("hr"));
  } else {
    // div, section, article, an inline wrapper around blocks (Google Docs) and so on.
    blocks(e, inner, out);
  }
}

function listItem(li: Element, ctx: Ctx): Element {
  const item = doc.createElement("li");
  blocks(li, ctx, item);
  return item;
}

function list(e: Element, ctx: Ctx, out: Element): void {
  const ordered = tag(e) === "ol";
  const l = doc.createElement(ordered ? "ol" : "ul");
  l.setAttribute("data-tight", "true");
  const start = Number(e.getAttribute("start"));
  if (ordered && start > 1) l.setAttribute("start", String(start));
  for (const child of [...e.childNodes]) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const c = child as Element;
    if (dropped(c)) continue;
    const name = tag(c);
    if (name === "li") {
      const item = listItem(c, childCtx(c, ctx));
      if (item.childNodes.length) l.append(item);
    } else if (name === "ul" || name === "ol") {
      // Google Docs puts a nested list beside the item it belongs to.
      let last = l.lastElementChild;
      if (!last) l.append((last = doc.createElement("li")));
      list(c, childCtx(c, ctx), last);
    } else {
      const item = doc.createElement("li");
      blocks(c, childCtx(c, ctx), item);
      if (item.childNodes.length) l.append(item);
    }
  }
  if (l.childNodes.length) out.append(l);
}

/** Word's list paragraphs: each is a paragraph with its bullet or number typed in. */
function wordList(kids: Node[], start: number, ctx: Ctx, out: Element): number {
  const stack: { level: number; list: Element }[] = [];
  let i = start;
  let last = start;
  for (; i < kids.length; i++) {
    const node = kids[i];
    if (node.nodeType === Node.COMMENT_NODE) continue;
    if (node.nodeType === Node.TEXT_NODE && !(node.nodeValue ?? "").trim()) continue;
    if (node.nodeType !== Node.ELEMENT_NODE || !isWordListParagraph(node as Element)) break;
    last = i;
    const p = node as Element;
    const style = p.getAttribute("style") ?? "";
    const level = Number(/level(\d+)/i.exec(style)?.[1] ?? 1);
    const markerEl = [...p.querySelectorAll("[style]")].find(isMarker);
    const marker = (markerEl?.textContent ?? "").replace(NBSP, " ").replace(/\s/g, "");
    const ordered = ORDERED_MARKER.test(marker) && !BULLET_MARKERS.has(marker);
    const listTag = ordered ? "ol" : "ul";
    while (stack.length && stack[stack.length - 1].level > level) stack.pop();
    let top = stack[stack.length - 1];
    if (top && top.level === level && tag(top.list) !== listTag) {
      stack.pop();
      top = stack[stack.length - 1];
    }
    if (!top || top.level < level) {
      const l = doc.createElement(listTag);
      l.setAttribute("data-tight", "true");
      const number = Number(/^\(?(\d+)/.exec(marker)?.[1]);
      if (ordered && number > 1) l.setAttribute("start", String(number));
      const parentItem = top?.list.lastElementChild;
      if (parentItem) parentItem.append(l);
      else out.append(l);
      stack.push((top = { level, list: l }));
    }
    const item = doc.createElement("li");
    const para = doc.createElement("p");
    const inner = childCtx(p, ctx);
    for (const child of [...p.childNodes]) appendInline(para, child, inner);
    item.append(para);
    top.list.append(item);
  }
  return last;
}

function codeBlock(e: Element, out: Element): void {
  const copy = e.cloneNode(true) as Element;
  for (const br of [...copy.querySelectorAll("br")]) br.replaceWith("\n");
  const text = (copy.textContent ?? "").replace(NBSP, " ").replace(/\n+$/, "");
  if (!text.trim()) return;
  const pre = doc.createElement("pre");
  const cls = `${e.getAttribute("class") ?? ""} ${e.querySelector("code")?.getAttribute("class") ?? ""}`;
  const language = /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(cls)?.[1];
  if (language) pre.setAttribute("data-params", language);
  const code = doc.createElement("code");
  code.textContent = text;
  pre.append(code);
  out.append(pre);
}

function table(t: HTMLTableElement, ctx: Ctx, out: Element): void {
  const rows = [...t.rows].filter((r) => r.closest("table") === t);
  const cells = rows.flatMap((r) => [...r.cells]);
  // A table used only for layout (a single box, or boxes holding tables) is read as its contents.
  if (cells.length <= 1 || cells.some((c) => c.querySelector("table"))) {
    for (const cell of cells) blocks(cell, childCtx(cell, ctx), out);
    return;
  }
  const clean = doc.createElement("table");
  const body = doc.createElement("tbody");
  clean.append(body);
  rows.forEach((row, r) => {
    const tr = doc.createElement("tr");
    for (const cell of row.cells) {
      const c = doc.createElement(cell.tagName === "TH" ? "th" : "td");
      for (const span of ["colspan", "rowspan"]) {
        const n = Number(cell.getAttribute(span));
        if (n > 1) c.setAttribute(span, String(n));
      }
      const inner = { ...childCtx(cell, ctx), noBreaks: false, cellLines: true, plainBold: r === 0 || cell.tagName === "TH" };
      for (const child of [...cell.childNodes]) appendInline(c, child, inner);
      // Line breaks at the very start or end of a cell are only spacing.
      const edge = (node: ChildNode | null) => node && (node.nodeName === "BR" || (node.nodeType === Node.TEXT_NODE && !node.nodeValue?.trim()));
      while (edge(c.firstChild)) c.firstChild!.remove();
      while (edge(c.lastChild)) c.lastChild!.remove();
      tr.append(c);
    }
    body.append(tr);
  });
  if (hasContent(clean)) out.append(clean);
}

// ---------------------------------------------------------------------------

const BASE: Ctx = { bold: false, italic: false, strike: false, code: false, href: null, plainBold: false, noBreaks: false };

/** Clean HTML from another app. */
export function cleanPastedHTML(html: string): Cleaned {
  doc = new DOMParser().parseFromString(html, "text/html");
  readStyleSheets(doc);
  findCocoaHeadings(doc);
  const out = doc.createElement("div");
  blocks(doc.body, BASE, out);
  classStyles = new WeakMap();
  headingLevels = new Map();
  return { html: out.innerHTML, rich: !!out.querySelector(RICH), text: out.textContent ?? "" };
}
