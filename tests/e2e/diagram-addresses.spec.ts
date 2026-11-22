// Batch 21, G21-1: a web address an agent wrote into a diagram in a form the scan in
// src/core/web-pictures.ts didn't read (escaped, or without its slashes) was
// asked for as soon as the diagram was drawn: nothing waited, nobody clicked.
// G21-2 (the tests at the end): where the scan read an address short, the
// marker showed one address and his click asked the web for another.
//
// Nothing leaves this Mac: the pictures are on 127.0.0.1 (tests/e2e/picture-server.ts).
// Each asserts that nothing is asked for before his click, and that the
// marker shows what the click asks for. (Diagram settings stay as they are.)
import { test, expect } from "@playwright/test";
import { openText, type Running } from "./helpers";
import { AgentSession } from "./agent-session";
import { pictureServer, trustLocalServer } from "./picture-server";

const PLAN = "# Plan\n\nThe offer to Acme is 41,500 dollars, not yet public.\n\nNext steps follow.\n";

async function agentAdds(run: Running, session: AgentSession, added: string): Promise<void> {
  await session.ok("take_document", { path: run.file });
  await session.ok("edit_document", { path: run.file, edits: [{ find: "Next steps follow.", replace: `Next steps follow.\n\n${added}` }] });
  await session.ok("finish_editing", { path: run.file });
}

/**
 * A character written by its number, the way JSON and YAML do: a backslash,
 * the letter u and four hex digits. Put together here so that this file
 * itself holds no such escape for a tool or an editor to read as the character.
 */
const ESCAPED = (hex: string) => `${String.fromCharCode(92)}u${hex}`;
/** A backslash, put together the same way. */
const BS = String.fromCharCode(92);
/** The diagram library's stand-ins while it reads, for "&#" and ";" (put back once drawn), put together from their numbers. */
const STAND_IN = { number: String.fromCharCode(0xfb02, 0xb0, 0xb0), end: String.fromCharCode(0xb6, 0xdf) };
/** A diagram whose own CSS is `css`, in its first line's settings. */
const withCss = (css: string) => [`%%{init: {"themeCSS": "${css}"}}%%`, "flowchart LR", "  A[Offer] --> B[Next]"];
/** A diagram whose own CSS is `css`, in its front matter (YAML). */
const withFrontCss = (...css: string[]) => ["---", "config:", `  themeCSS: "${css.join("\n")}"`, "---", "flowchart LR", "  A[Offer] --> B[Next]"];

/** The diagram's code for each way of writing the address; `host` is 127.0.0.1:port. */
const WAYS: Record<string, (host: string) => string[]> = {
  // The control: written plainly.
  "plainly in the diagram's own CSS (the control)": (host) => [
    `%%{init: {"themeCSS": "span,div,p{background-image:url(https://${host}/plain.png?q=41500)}"}}%%`,
    "flowchart LR",
    "  A[Offer] --> B[Next]",
  ],
  "in the diagram's own CSS, its slashes written as JSON escapes": (host) => [
    `%%{init: {"themeCSS": "span,div,p{background-image:url(https:${ESCAPED("002f")}${ESCAPED("002f")}${host}/json.png?q=41500)}"}}%%`,
    "flowchart LR",
    "  A[Offer] --> B[Next]",
  ],
  "in the diagram's own CSS, without its slashes": (host) => [
    `%%{init: {"themeCSS": "span,div,p{background-image:url(https:${host}/noslash.png?q=41500)}"}}%%`,
    "flowchart LR",
    "  A[Offer] --> B[Next]",
  ],
  "in the diagram's own CSS, its colon written as a CSS escape": (host) => [
    String.raw`%%{init: {"themeCSS": "span,div,p{background-image:url(https\\3a //` + `${host}/css.png?q=41500)}"}}%%`,
    "flowchart LR",
    "  A[Offer] --> B[Next]",
  ],
  "in a label's picture, its colon written the way diagrams write a character by number": (host) => [
    "flowchart LR",
    `  A[Offer] --> B["<img src='https#58;//${host}/entity.png?q=41500'>"]`,
  ],
  "in a label's picture, its colon written as HTML's &colon;": (host) => [
    "flowchart LR",
    `  A[Offer] --> B["<img src='https&colon;//${host}/named.png?q=41500'>"]`,
  ],
  "in a label's picture set, without its slashes": (host) => [
    "flowchart LR",
    `  A[Offer] --> B["<img srcset='https:${host}/srcset.png?q=41500 1x'>"]`,
  ],
  "in a picture shape, its colon written as a YAML escape": (host) => [
    "flowchart LR",
    `  A@{ img: "https${ESCAPED("003a")}//${host}/yaml.png?q=41500", label: "Chart", w: 40, h: 30 }`,
    "  A --> B[Next]",
  ],
  "in a label's style, without its slashes": (host) => [
    "flowchart LR",
    `  A[Offer] --> B["<span style='background-image:url(https:${host}/span.png?q=41500)'>Next</span>"]`,
  ],
  // The review of Batch 21, R21-8: the library's own stand-ins, written directly.
  "in a label's picture, its colon written in the diagram library's own stand-ins": (host) => [
    "flowchart LR",
    `  A[Offer] --> B["<img src='https${STAND_IN.number}58${STAND_IN.end}//${host}/standin.png?q=41500'>"]`,
  ],
  "in the diagram's own CSS, its colon written in the diagram library's own stand-ins": (host) =>
    withCss(`span,div,p{background-image:url(https${STAND_IN.number}58${STAND_IN.end}//${host}/standin-css.png?q=41500)}`),
  // R21-8: a tab, line feed or carriage return an escape writes, which the browser drops from an address.
  "in the diagram's own CSS, a tab after its colon as a CSS escape": (host) => withCss(`span,div,p{background-image:url(https:${BS}${BS}9 //${host}/tab.png?q=41500)}`),
  "in the diagram's own CSS, a line feed after its colon as a CSS escape": (host) => withCss(`span,div,p{background-image:url(https:${BS}${BS}a //${host}/lf.png?q=41500)}`),
  "in the diagram's own CSS, a carriage return after its colon as a CSS escape": (host) => withCss(`span,div,p{background-image:url(https:${BS}${BS}d //${host}/cr.png?q=41500)}`),
  "in the diagram's own CSS, a tab before its colon as a CSS escape": (host) => withCss(`span,div,p{background-image:url(https${BS}${BS}9 ://${host}/tab-first.png?q=41500)}`),
  "in a label's style, a tab in its quoted address as HTML's &Tab;": (host) => [
    "flowchart LR",
    `  A[Offer] --> B["<span style='background-image:url(&quot;https:&Tab;//${host}/tab-entity.png?q=41500&quot;)'>Next</span>"]`,
  ],
  "in a label's style, a tab in its quoted address written the way diagrams write a character by number": (host) => [
    "flowchart LR",
    `  A[Offer] --> B["<span style='background-image:url(#quot;https:#9;//${host}/tab-number.png?q=41500#quot;)'>Next</span>"]`,
  ],
  "in the diagram's own CSS, a tab in its quoted address as a JSON escape": (host) =>
    withCss(`span,div,p{background-image:url(${BS}"https:${ESCAPED("0009")}//${host}/tab-json.png?q=41500${BS}")}`),
  "in the front matter's CSS, a tab in its quoted address as a YAML escape": (host) =>
    withFrontCss(`span,div,p{background-image:url('https:${BS}x09//${host}/tab-yaml.png?q=41500')}`),
  // R21-8: YAML's escaped line break.
  "in the front matter's CSS, broken by YAML's escaped line break": (host) =>
    withFrontCss(`span,div,p{background-image:url(https:${BS}`, `    //${host}/break.png?q=41500)}`),
};

for (const [way, code] of Object.entries(WAYS)) {
  test(`an agent's diagram with a web address ${way} asks the web for nothing`, async () => {
    const web = await pictureServer();
    const run = await openText(PLAN, { name: "plan.md" });
    await trustLocalServer(run.app);
    const { session } = await AgentSession.start(run.dataDir, "claude-code");
    const host = web.origin.replace("https://", "");
    await agentAdds(run, session, ["```mermaid", ...code(host), "```"].join("\n"));
    const diagram = run.page.locator(".doc:not([hidden]) .page.editor .diagram");
    await expect(diagram.locator(".diagram-picture svg")).toBeVisible({ timeout: 15_000 });
    await diagram.scrollIntoViewIfNeeded();
    await run.page.waitForTimeout(1500);
    const asked = [...web.asked];
    const connections = web.connections();
    await run.app.close();
    await session.stop();
    await web.close();
    expect(asked).toEqual([]);
    expect(connections).toBe(0);
  });
}

// The same scan decides what the marker says. Where it reads an address short
// of what the drawing asks for, the person is shown one address and, on his
// click, the web is asked for another.
const CUT_SHORT: Record<string, (origin: string) => string[]> = {
  "an unquoted address with a comma in it": (origin) => ["flowchart LR", `  A[Offer] --> B["<img src=${origin}/pic.png,q41500>"]`],
  "an address in the diagram's own CSS with its query written as CSS escapes": (origin) => [
    String.raw`%%{init: {"themeCSS": "span,div,p{background-image:url(` + origin + String.raw`/pic.png\\3fq\\3d 41500)}"}}%%`,
    "flowchart LR",
    "  A[Offer] --> B[Next]",
  ],
  // The review of Batch 21, R21-9.
  "a quoted address in a label's style with brackets in it": (origin) => [
    "flowchart LR",
    `  A[Offer] --> B["<span style='background-image:url(#quot;${origin}/pic.png?q=Acme(offer-10M)#quot;)'>Next</span>"]`,
  ],
  "a quoted address in the diagram's own CSS with a bar in it": (origin) => withCss(`span,div,p{background-image:url(${BS}"${origin}/pic.png?q=Acme|offer${BS}")}`),
  "an unquoted label picture with a tab after its colon, as HTML's &Tab;": (origin) => [
    "flowchart LR",
    `  A[Offer] --> B["<img src=${origin.replace("https://", "https:&Tab;//")}/pic.png?q=41500>"]`,
  ],
};

for (const [way, code] of Object.entries(CUT_SHORT)) {
  test(`the address a diagram's marker shows is the one asked for on his click: ${way}`, async () => {
    const web = await pictureServer();
    const run = await openText(PLAN, { name: "plan.md" });
    await trustLocalServer(run.app);
    const { session } = await AgentSession.start(run.dataDir, "claude-code");
    await agentAdds(run, session, ["```mermaid", ...code(web.origin), "```"].join("\n"));
    const diagram = run.page.locator(".doc:not([hidden]) .page.editor .diagram");
    await expect(diagram.locator(".diagram-picture svg")).toBeVisible({ timeout: 15_000 });
    await diagram.scrollIntoViewIfNeeded();
    await expect(diagram.locator(".picture.waiting")).toHaveCount(1);
    const shown = (await diagram.locator(".picture.waiting .picture-waiting-text").innerText()).replace("Picture from the web, not shown: ", "").trim();
    const before = [...web.asked];
    await diagram.getByRole("button", { name: /^Show picture/ }).click();
    await run.page.waitForTimeout(2500);
    const asked = web.asked.map((path) => web.origin + path);
    await run.app.close();
    await session.stop();
    await web.close();
    expect(before).toEqual([]);
    expect(asked).toEqual([shown]);
  });
}
