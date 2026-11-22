// How Corillo reads Markdown into tokens: markdown-it with its plugins, and what it gives.
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import { obsidianSyntax } from "./obsidian";

type Token = ReturnType<MarkdownIt["parse"]>[number];

// (The footnote plugin's type definitions lag behind markdown-it's; it works with both.)
// Obsidian's links, math and comments are read as plain text (see obsidian.ts).
const md = new MarkdownIt("default", { html: true, linkify: false, typographer: false })
  .use(footnote as unknown as (md: MarkdownIt) => void)
  .use(obsidianSyntax)
  .use(referenceForms);
md.core.ruler.at("footnote_tail", footnoteTail);

type CoreState = Parameters<Parameters<MarkdownIt["core"]["ruler"]["push"]>[1]>[0];
interface FootnoteEnv {
  footnotes?: { list?: { label?: string; count?: number; content?: string; tokens?: Token[] }[] };
}

/**
 * The footnote plugin's last step, the same tokens built in one pass (review
 * W-4): each note's own parts taken out of the text's, and put after it, a
 * group per note with its back links. The plugin's step (MIT, its shape
 * followed here) copies the whole list of tokens once for every note, which
 * in a long document with many notes is megabytes each time it's read.
 */
export function footnoteTail(state: CoreState): void {
  const env = state.env as FootnoteEnv;
  if (!env.footnotes) return;
  const notes = new Map<string, Token[]>();
  let note: Token[] | null = null;
  const kept: Token[] = [];
  for (const tok of state.tokens) {
    if (tok.type === "footnote_reference_open") notes.set(tok.meta.label, (note = []));
    else if (tok.type === "footnote_reference_close") note = null;
    else if (note) note.push(tok);
    else kept.push(tok);
  }
  state.tokens = kept;
  const list = env.footnotes.list;
  if (!list) return;
  const out = state.tokens;
  out.push(new state.Token("footnote_block_open", "", 1));
  // (Kept from one note to the next, as the plugin does, for a note with neither words nor label.)
  let parts: Token[] | undefined;
  list.forEach((entry, id) => {
    const open = new state.Token("footnote_open", "", 1);
    open.meta = { id, label: entry.label };
    out.push(open);
    if (entry.tokens) {
      const p = new state.Token("paragraph_open", "p", 1);
      p.block = true;
      const inline = new state.Token("inline", "", 0);
      inline.children = entry.tokens;
      inline.content = entry.content as string;
      const close = new state.Token("paragraph_close", "p", -1);
      close.block = true;
      parts = [p, inline, close];
    } else if (entry.label) parts = notes.get(entry.label);
    if (parts) for (const tok of parts) out.push(tok);
    const last = out[out.length - 1].type === "paragraph_close" ? out.pop()! : null;
    for (let subId = 0; subId < Math.max(entry.count ?? 0, 1); subId++) {
      const anchor = new state.Token("footnote_anchor", "", 0);
      anchor.meta = { id, subId, label: entry.label };
      out.push(anchor);
    }
    if (last) out.push(last);
    out.push(new state.Token("footnote_close", "", -1));
  });
  out.push(new state.Token("footnote_block_close", "", -1));
}

type InlineRule = Parameters<MarkdownIt["inline"]["ruler"]["push"]>[1];
type InlineState = Parameters<InlineRule>[0];

/**
 * Note on each link and picture written by reference ("[words][label]",
 * "[label][]", "[label]", and the same with "!") its label and form, so an
 * edit writes it the same way rather than with its address.
 */
function referenceForms(it: MarkdownIt): void {
  for (const name of ["link", "image"]) {
    const rules = (it.inline.ruler as unknown as { __rules__: { name: string; fn: InlineRule }[] }).__rules__;
    const original = rules.find((r) => r.name === name)!.fn;
    it.inline.ruler.at(name, (state: InlineState, silent: boolean) => {
      const start = state.pos;
      const before = state.tokens.length;
      if (!original(state, silent)) return false;
      if (silent || state.src[state.pos - 1] !== "]") return true; // written with its address: "(...)"
      const open = name === "image" ? start + 1 : start;
      const end = it.helpers.parseLinkLabel(state, open, false);
      const tail = state.src.slice(end + 1, state.pos);
      const tok = state.tokens.slice(before).find((t) => t.type === "link_open" || t.type === "image");
      if (end < 0 || !tok) return true;
      const form = tail === "" ? "shortcut" : tail === "[]" ? "collapsed" : "full";
      tok.meta = { ...tok.meta, ref: form === "full" ? tail.slice(1, -1) : state.src.slice(open + 1, end), refForm: form };
      return true;
    });
  }
}
const TokenClass = md.parse("x", {})[0].constructor as new (type: string, tag: string, nesting: number) => Token;

export type MarkdownToken = Token;
/** How Corillo reads some Markdown: its tokens, each block's with the lines it came from. */
export function markdownTokens(text: string): Token[] {
  return md.parse(text, {});
}

/**
 * The lines of a paragraph's text (as its inline token holds it) that end in
 * a line break, in order, counted from 0. A line ending inside code or a
 * link's title doesn't: the page shows those on one line.
 */
export function lineBreakLines(content: string): number[] {
  const lines: number[] = [];
  type State = InlineState & { push(type: string, tag: string, nesting: number): Token };
  const state = new md.inline.State(content, md, {}, []) as State;
  const push = state.push.bind(state);
  state.push = (type, tag, nesting) => {
    if (type === "softbreak" || type === "hardbreak") {
      let line = 0;
      for (let i = content.indexOf("\n"); i >= 0 && i < state.pos; i = content.indexOf("\n", i + 1)) line++;
      lines.push(line);
    }
    return push(type, tag, nesting);
  };
  md.inline.tokenize(state);
  return lines;
}

export { md, TokenClass };
