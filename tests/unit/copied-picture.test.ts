// A web picture copied from where it waits keeps waiting (roadmap Batch 19,
// item 1, the review of Batch 18's R18-7): Corillo's copy says which of its
// pictures wait, beside their addresses; and what the window may send the
// app to say so is checked there (only adds, web addresses only, within limits).
import { afterEach, describe, expect, it } from "vitest";
import { clipboardHTML } from "../../src/core/clipboard-text";
import { parseMarkdown } from "../../src/core/markdown";
import { setImageResolver } from "../../src/core/schema";
import { forgetReadTexts, inCalls, readTextsHeld, WAIT_CALL } from "../../src/core/web-pictures";
import { copiedToWait } from "../../src/main/waiting-pictures";
import { picturesInText, WAITING_TYPE, waitAsOnClipboard } from "../../src/renderer/paste";
import type { PictureStore } from "../../src/renderer/images";
import { copiedHere, waitingOfCopy } from "../../src/renderer/copy";

const WAITS = "https://a.test/chart.png?q=offer";
const SHOWN = "https://a.test/shown.png";

/** The copy of a whole document, as Corillo puts it on the clipboard, with WAITS waiting. */
function copied(markdown: string): string {
  setImageResolver((src) => (src === WAITS ? "" : src));
  const doc = parseMarkdown(markdown).doc;
  return clipboardHTML(doc.slice(0, doc.content.size, true), 0, { number: () => "" });
}

afterEach(() => setImageResolver((src) => src));

describe("Corillo's copy of a picture that waits", () => {
  it("says it waits beside its address, with nothing to load; a picture that doesn't wait isn't marked", () => {
    const html = copied(`![chart](${WAITS})\n\n![other](${SHOWN})\n`);
    expect(html).toContain(`<img src="" data-src="${WAITS}" data-waiting="true" alt="chart">`);
    expect(html).toContain(`<img src="${SHOWN}" data-src="${SHOWN}" alt="other">`);
  });

  it("a diagram lists which of its web addresses wait, and only those", () => {
    const code = ["```mermaid", "flowchart LR", `  A@{ img: "${WAITS}", label: "Chart" }`, `  B["<img src='${SHOWN}'>"]`, "```"].join("\n");
    const html = copied(`${code}\n`);
    const listed = /<pre [^>]*data-waiting="([^"]*)"/.exec(html)?.[1];
    expect(JSON.parse(listed!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"))).toEqual([WAITS]);
    expect(html).toContain('data-params="mermaid"');
  });

  it("a code block that isn't a diagram, or a diagram with nothing waiting, has no mark", () => {
    expect(copied(`\`\`\`text\n${WAITS}\n\`\`\`\n`)).not.toContain("data-waiting");
    expect(copied(`\`\`\`mermaid\nflowchart LR\n  B["<img src='${SHOWN}'>"]\n\`\`\`\n`)).not.toContain("data-waiting");
  });
});

describe("what the window may send to say pictures wait", () => {
  it("keeps, once each, every address the window would ask the web for, and leaves out a file on this Mac or a picture written into the text", () => {
    expect(copiedToWait([WAITS, WAITS, "HTTP://a.test/x.png", "file:///Users/x.png", "data:image/png;base64,AA", "blob:x", "ftp://a.test/x"])).toEqual([
      WAITS,
      "HTTP://a.test/x.png",
      "ftp://a.test/x",
    ]);
  });

  it("keeps an address written without its slashes, which the window still asks the web for (the review of Batch 19, R19-1)", () => {
    expect(copiedToWait(["https:a.test/x.png", "HTTPS:/a.test/y.png", " https:a.test/z.png"])).toEqual(["https:a.test/x.png", "HTTPS:/a.test/y.png", " https:a.test/z.png"]);
  });

  it("refuses the whole call if it isn't a list of strings, or is over the limits", () => {
    expect(copiedToWait(WAITS)).toEqual([]);
    expect(copiedToWait(null)).toEqual([]);
    expect(copiedToWait({ 0: WAITS, length: 1 })).toEqual([]);
    expect(copiedToWait([WAITS, 42])).toEqual([]);
    expect(copiedToWait(Array.from({ length: WAIT_CALL.addresses + 1 }, (_, i) => `https://a.test/${i}.png`))).toEqual([]);
    expect(copiedToWait([`https://a.test/${"x".repeat(WAIT_CALL.characters)}`])).toEqual([]);
    expect(copiedToWait(Array.from({ length: WAIT_CALL.addresses }, (_, i) => `https://a.test/${i}.png`))).toHaveLength(WAIT_CALL.addresses);
  });

  it("the window sends many addresses in calls within the limits, all of them", () => {
    const many = Array.from({ length: 2_500 }, (_, i) => `https://a.test/${i}.png`);
    const calls = inCalls(many);
    expect(calls.map((c) => c.length)).toEqual([1_000, 1_000, 500]);
    expect(calls.flat()).toEqual(many);
    for (const call of calls) expect(copiedToWait(call)).toEqual(call);
    const long = `https://a.test/${"x".repeat(WAIT_CALL.characters / 2)}`;
    const big = inCalls([long, long + "1", long + "2"]);
    expect(big).toHaveLength(3);
    for (const call of big) expect(copiedToWait(call)).toEqual(call);
  });
});

/** What a paste finds on the clipboard, by type, as the window's paste event gives it. */
const clipboard = (types: Record<string, string>) => ({ getData: (type: string) => types[type] ?? "" }) as unknown as DataTransfer;

/** A picture store that keeps what it's told waits. */
function waitingStore() {
  const told: string[][] = [];
  return { told, store: { wait: (srcs: string[]) => told.push(srcs) } as unknown as PictureStore };
}

describe("the list of waiting addresses a paste carries (the review of Batch 19, R19-5)", () => {
  it("only addresses that are pictures in what's pasted are added: 5,000 listed beside text holding one, one waits", () => {
    const { told, store } = waitingStore();
    const listed = Array.from({ length: 5_000 }, (_, i) => `https://a.test/${i}.png`);
    const ok = waitAsOnClipboard(clipboard({ "text/plain": `Words.\n\n![one](${listed[7]})\n`, [WAITING_TYPE]: JSON.stringify(listed) }), store);
    expect(ok).toBe(true);
    expect(told).toEqual([[listed[7]]]);
  });

  it("an address in a diagram's code counts, its fence copied or not", () => {
    const { told, store } = waitingStore();
    waitAsOnClipboard(clipboard({ "text/plain": `  A@{ img: "${WAITS}", label: "Chart" }`, [WAITING_TYPE]: JSON.stringify([WAITS, SHOWN]) }), store);
    expect(told).toEqual([[WAITS]]);
  });

  it("a paste that says more web pictures wait than a document's list holds isn't pasted, and nothing is added", () => {
    const { told, store } = waitingStore();
    const listed = Array.from({ length: WAIT_CALL.addresses + 1 }, (_, i) => `https://a.test/${i}.png`);
    const text = listed.map((a) => `![p](${a})`).join("\n\n");
    expect(waitAsOnClipboard(clipboard({ "text/plain": text, [WAITING_TYPE]: JSON.stringify(listed) }), store)).toBe(false);
    expect(told).toEqual([]);
    // At the limit, it goes in, every one waiting.
    const fits = listed.slice(1);
    expect(waitAsOnClipboard(clipboard({ "text/plain": fits.map((a) => `![p](${a})`).join("\n\n"), [WAITING_TYPE]: JSON.stringify(fits) }), store)).toBe(true);
    expect(told.flat()).toHaveLength(WAIT_CALL.addresses);
  });
});

describe("the window's last copy, for Paste and Match Style (the review of Batch 19, R19-3)", () => {
  it("says which pictures waited only for that copy's text, and keeps a fingerprint, not the text", () => {
    const text = `  A@{ img: "${WAITS}" }\n`;
    copiedHere(text, [WAITS]);
    expect(waitingOfCopy(text)).toEqual([WAITS]);
    expect(waitingOfCopy(text + " ")).toEqual([]);
    expect(waitingOfCopy(text.replace("A@", "B@"))).toEqual([]);
    // A later copy with nothing waiting forgets it.
    copiedHere("Words.", []);
    expect(waitingOfCopy(text)).toEqual([]);
  });
});

describe("what the Markdown view's copy reads (the review of Batch 19, R19-9)", () => {
  it("finds the pictures without keeping the text", () => {
    forgetReadTexts();
    expect([...picturesInText(`# Plan\n\n![a](${WAITS})\n`)]).toEqual([WAITS]);
    expect(readTextsHeld()).toBe(0);
  });
});
