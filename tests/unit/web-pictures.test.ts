// Which web pictures an agent's change added (roadmap Batch 18, item 1): read
// as the page reads the Markdown, so no way of writing a picture slips by.
import { describe, expect, it } from "vitest";
import { addedWebPictures, asRequested, BLANK_PICTURE, diagramPictures, isWebAddress, webPicturesIn, withoutWaiting } from "../../src/core/web-pictures";
import { INSTRUCTIONS } from "../../src/mcp/tools";

describe("web pictures", () => {
  it("a picture on the web is one with an address the window would ask the web for", () => {
    expect(isWebAddress("https://example.com/a.png")).toBe(true);
    expect(isWebAddress("HTTPS://example.com/a.png")).toBe(true);
    expect(isWebAddress("http://example.com/a.png")).toBe(true);
    expect(isWebAddress("plan%20images/chart.png")).toBe(false);
    expect(isWebAddress("/Users/someone/chart.png")).toBe(false);
    expect(isWebAddress("file:///Users/someone/chart.png")).toBe(false);
    expect(isWebAddress("data:image/png;base64,AAAA")).toBe(false);
  });

  it("finds a picture however it's written: plainly, by reference, in a table, a heading, a footnote or a list", () => {
    const text = [
      "# Title ![h](https://a.test/heading.png)",
      "",
      "![plain](https://a.test/plain.png) and ![local](plan%20images/x.png)",
      "",
      "![by reference][r]",
      "",
      "| A |",
      "| --- |",
      "| ![cell](https://a.test/cell.png) |",
      "",
      "- ![item](<https://a.test/item one.png>)",
      "",
      "Words.[^1]",
      "",
      "[^1]: ![note](https://a.test/note.png)",
      "",
      "[r]: https://a.test/ref.png?q=words",
      "",
    ].join("\n");
    expect([...webPicturesIn(text)].sort()).toEqual(
      ["https://a.test/cell.png", "https://a.test/heading.png", "https://a.test/item%20one.png", "https://a.test/note.png", "https://a.test/plain.png", "https://a.test/ref.png?q=words"].sort(),
    );
  });

  it("an address spelled with an entity or a backslash is read as the page reads it", () => {
    expect([...webPicturesIn("![a](h&#116;tps://a.test/x.png)\n")]).toEqual(["https://a.test/x.png"]);
  });

  it("added: only the web pictures that weren't there before", () => {
    const before = "Text.\n\n![old](https://a.test/old.png)\n";
    const after = "Text, changed.\n\n![old, moved](https://a.test/old.png)\n\n![new](https://a.test/new.png?q=secret)\n\n![mine](x%20images/y.png)\n";
    expect(addedWebPictures(before, after)).toEqual(["https://a.test/new.png?q=secret"]);
    expect(addedWebPictures(after, before)).toEqual([]);
    expect(addedWebPictures("", "No pictures at all.\n")).toEqual([]);
  });

  it("a link definition changed to point a picture already there at the web counts as added", () => {
    const before = "![chart][c]\n\n[c]: plan%20images/chart.png\n";
    const after = "![chart][c]\n\n[c]: https://a.test/chart.png?q=words\n";
    expect(addedWebPictures(before, after)).toEqual(["https://a.test/chart.png?q=words"]);
  });

  it("agents are told, where pictures are described, that a web picture waits for the person", () => {
    expect(INSTRUCTIONS).toContain("A picture at a web address waits for the person to show it.");
  });

  // The review of Batch 18, R18-2: a diagram asks the web for pictures too.
  const DIAGRAM = [
    "```mermaid",
    "flowchart LR",
    '  A@{ img: "https://a.test/shape.png?q=offer to Acme", label: "Chart" }',
    "  B[\"<img src='https://a.test/label.png?a=1&amp;b=2'>\"]",
    "  C@{ img: https://a.test/bare.png }",
    "  style C fill:url(https://a.test/fill.png)",
    "  A --> B --> C",
    "```",
    "",
  ].join("\n");

  it("a diagram's pictures on the web count: a picture shape, a picture in a label, any other address in its code", () => {
    expect([...webPicturesIn(DIAGRAM)].sort()).toEqual(
      ["https://a.test/bare.png", "https://a.test/fill.png", "https://a.test/label.png?a=1&b=2", "https://a.test/shape.png?q=offer to Acme"].sort(),
    );
    expect(addedWebPictures("Before.\n", `Before.\n\n${DIAGRAM}`)).toHaveLength(4);
    // Code that isn't a diagram draws nothing, so asks for nothing.
    expect([...webPicturesIn(DIAGRAM.replace("```mermaid", "```js"))]).toEqual([]);
  });

  it("a diagram drawn without the addresses that wait: a blank picture in their place, the rest as written", () => {
    const code = DIAGRAM.split("\n").slice(1, -2).join("\n");
    const { code: drawn, waiting } = withoutWaiting(code, (a) => a !== "https://a.test/bare.png");
    expect(waiting).toEqual(["https://a.test/shape.png?q=offer to Acme", "https://a.test/label.png?a=1&b=2", "https://a.test/fill.png"]);
    expect(drawn).not.toMatch(/shape\.png|label\.png|fill\.png/);
    expect(drawn).toContain("https://a.test/bare.png");
    expect(drawn.split(BLANK_PICTURE)).toHaveLength(4);
    expect(withoutWaiting(code, () => false)).toEqual({ code, waiting: [] });
    expect(diagramPictures("flowchart LR\n  A --> B")).toEqual([]);
  });

  // The third code read, G21-1: a diagram's address written so the scan didn't read it was asked for as the diagram was drawn.
  // (A backslash is put together from its number, so this file holds no escape for a tool or an editor to read as the character.)
  const BS = String.fromCharCode(92);
  /** The diagram library's stand-ins while it reads (put back as "&#", "&" and ";" once drawn), put together from their numbers. */
  const STAND_IN = { number: String.fromCharCode(0xfb02, 0xb0, 0xb0), name: String.fromCharCode(0xfb02, 0xb0), end: String.fromCharCode(0xb6, 0xdf) };
  const SPELLED: [way: string, code: string, address: string][] = [
    ["a picture shape's colon as a YAML escape", `flowchart LR\n  A@{ img: "https${BS}u003a//a.test/yaml.png?q=41500", label: "Chart" }`, "https://a.test/yaml.png?q=41500"],
    ["the CSS's slashes as JSON escapes", `%%{init: {"themeCSS": "p{background:url(https:${BS}u002f${BS}u002fa.test/json.png?q=41500)}"}}%%\nflowchart LR\n  A --> B`, "https://a.test/json.png?q=41500"],
    ["the CSS's address without its slashes", `%%{init: {"themeCSS": "p{background:url(https:a.test/noslash.png?q=41500)}"}}%%\nflowchart LR\n  A --> B`, "https:a.test/noslash.png?q=41500"],
    ["the CSS's colon as a CSS escape", `%%{init: {"themeCSS": "p{background:url(https${BS}${BS}3a //a.test/css.png?q=41500)}"}}%%\nflowchart LR\n  A --> B`, "https://a.test/css.png?q=41500"],
    ["a label picture's colon written as diagrams write a character by number", `flowchart LR\n  A --> B["<img src='https#58;//a.test/entity.png?q=41500'>"]`, "https://a.test/entity.png?q=41500"],
    ["a label picture's colon as HTML's &colon;", `flowchart LR\n  A --> B["<img src='https&colon;//a.test/named.png?q=41500'>"]`, "https://a.test/named.png?q=41500"],
    ["a label's picture set without its slashes", `flowchart LR\n  A --> B["<img srcset='https:a.test/srcset.png?q=41500 1x'>"]`, "https:a.test/srcset.png?q=41500"],
    ["a label's style without its slashes", `flowchart LR\n  A --> B["<span style='background:url(https:a.test/span.png?q=41500)'>Next</span>"]`, "https:a.test/span.png?q=41500"],
    // G21-2: read whole, as the drawing asks for it, so the marker shows the address his click asks for.
    ["an unquoted label picture with a comma in it", `flowchart LR\n  A --> B["<img src=https://a.test/pic.png,q41500>"]`, "https://a.test/pic.png,q41500"],
    ["the CSS's query as CSS escapes", `%%{init: {"themeCSS": "p{background:url(https://a.test/pic.png${BS}${BS}3fq${BS}${BS}3d 41500)}"}}%%\nflowchart LR\n  A --> B`, "https://a.test/pic.png?q=41500"],
    // The review of Batch 21, R21-8: the diagram library's own stand-ins for "&#", "&" and ";", written directly.
    ["a label picture's colon in the library's stand-ins", `flowchart LR\n  A --> B["<img src='https${STAND_IN.number}58${STAND_IN.end}//a.test/standin.png?q=41500'>"]`, "https://a.test/standin.png?q=41500"],
    ["a label picture's colon in the library's stand-in for a name", `flowchart LR\n  A --> B["<img src='https${STAND_IN.name}colon${STAND_IN.end}//a.test/standin.png?q=41500'>"]`, "https://a.test/standin.png?q=41500"],
    ["the CSS's colon in the library's stand-ins", `%%{init: {"themeCSS": "p{background:url(https${STAND_IN.number}58${STAND_IN.end}//a.test/standin.png?q=41500)}"}}%%\nflowchart LR\n  A --> B`, "https://a.test/standin.png?q=41500"],
    // R21-8: a tab, line feed or carriage return an escape writes into an address, which the browser drops.
    ["a tab after the CSS's colon, as a CSS escape", `%%{init: {"themeCSS": "p{background:url(https:${BS}${BS}9 //a.test/tab.png?q=41500)}"}}%%\nflowchart LR\n  A --> B`, "https://a.test/tab.png?q=41500"],
    ["a line feed after the CSS's colon, as a CSS escape", `%%{init: {"themeCSS": "p{background:url(https:${BS}${BS}a //a.test/tab.png?q=41500)}"}}%%\nflowchart LR\n  A --> B`, "https://a.test/tab.png?q=41500"],
    ["a carriage return after the CSS's colon, as a CSS escape", `%%{init: {"themeCSS": "p{background:url(https:${BS}${BS}d //a.test/tab.png?q=41500)}"}}%%\nflowchart LR\n  A --> B`, "https://a.test/tab.png?q=41500"],
    ["a tab before the CSS's colon, as a CSS escape", `%%{init: {"themeCSS": "p{background:url(https${BS}${BS}9 ://a.test/tab.png?q=41500)}"}}%%\nflowchart LR\n  A --> B`, "https://a.test/tab.png?q=41500"],
    ["a tab in a label style's quoted address, as HTML's &Tab;", `flowchart LR\n  A --> B["<span style='background:url(&quot;https:&Tab;//a.test/tab.png?q=41500&quot;)'>Next</span>"]`, "https://a.test/tab.png?q=41500"],
    ["a tab in a label style's quoted address, as diagrams write a character by number", `flowchart LR\n  A --> B["<span style='background:url(#quot;https:#9;//a.test/tab.png?q=41500#quot;)'>Next</span>"]`, "https://a.test/tab.png?q=41500"],
    ["a tab in the CSS's quoted address, as a JSON escape", `%%{init: {"themeCSS": "p{background:url('https:${BS}u0009//a.test/tab.png?q=41500')}"}}%%\nflowchart LR\n  A --> B`, "https://a.test/tab.png?q=41500"],
    ["a tab in the front matter CSS's quoted address, as a YAML escape", `---\nconfig:\n  themeCSS: "p{background:url('https:${BS}x09//a.test/tab.png?q=41500')}"\n---\nflowchart LR\n  A --> B`, "https://a.test/tab.png?q=41500"],
    // R21-8: YAML's escaped line break in front matter.
    ["the front matter CSS's address broken by YAML's escaped line break", `---\nconfig:\n  themeCSS: "p{background:url(https:${BS}\n    //a.test/break.png?q=41500)}"\n---\nflowchart LR\n  A --> B`, "https://a.test/break.png?q=41500"],
    // R21-9: read whole, so the marker shows all his click asks for.
    ["a label style's quoted address with brackets in it", `flowchart LR\n  A --> B["<span style='background:url(#quot;https://a.test/x.png?q=Acme(offer-10M)#quot;)'>Next</span>"]`, "https://a.test/x.png?q=Acme(offer-10M)"],
    ["the CSS's quoted address with a bar and braces in it", `%%{init: {"themeCSS": "p{background:url(${BS}"https://a.test/x.png?q=Acme|offer{10M}${BS}")}"}}%%\nflowchart LR\n  A --> B`, "https://a.test/x.png?q=Acme|offer{10M}"],
    ["an unquoted label picture with a tab after its colon, as HTML's &Tab;", `flowchart LR\n  A --> B["<img src=https:&Tab;//a.test/x.png?q=41500>"]`, "https://a.test/x.png?q=41500"],
  ];
  for (const [way, code, address] of SPELLED) {
    it(`a diagram's address is read whole however it's spelled, and blanked where it's written: ${way} (G21-1, G21-2)`, () => {
      expect(diagramPictures(code).map((p) => p.address)).toEqual([address]);
      const { code: drawn, waiting } = withoutWaiting(code, () => true);
      expect(waiting).toEqual([address]);
      expect(drawn).toContain(BLANK_PICTURE);
      expect(drawn).not.toMatch(/a\.test|41500/);
    });
  }

  it("an address as the network sees it: spaces escaped, the host in small letters, no #part", () => {
    expect(asRequested("https://A.test/x.png?q=offer to Acme#top")).toBe("https://a.test/x.png?q=offer%20to%20Acme");
    expect(asRequested("not an address")).toBeNull();
  });
});
