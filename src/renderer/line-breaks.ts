// A paragraph keeps the file's single line breaks as line breaks in its text,
// as Obsidian shows them (see keepLineBreaks in markdown-read.ts). As someone
// types, ProseMirror reads the changed text back from the page, and would
// turn those line breaks into spaces; this keeps them. The page's text is
// shown with its spacing as it is, so reading it back as it is is right.
// Pasting still tidies the spacing of what's pasted, as before.
import { DOMParser, type ParseOptions } from "prosemirror-model";
import { Plugin } from "prosemirror-state";
import { schema } from "../core/schema";

const asPasted = DOMParser.fromSchema(schema);

class AsTyped extends DOMParser {
  parse(dom: globalThis.Node, options: ParseOptions = {}) {
    return super.parse(dom, { ...options, preserveWhitespace: options.preserveWhitespace === true ? "full" : options.preserveWhitespace });
  }
}

const asTyped = new AsTyped(schema, asPasted.rules);

export function lineBreaksPlugin(): Plugin {
  return new Plugin({ props: { domParser: asTyped, clipboardParser: asPasted } });
}
