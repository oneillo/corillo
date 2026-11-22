// Help's words on where an agent's export goes match what Corillo does
// (Batch 22, item 5b, his call on the Word copy's export name). A document's
// export goes next to it with its name; a copy made from a Word document can't
// take that name (it's the original's), so each export gets the next free
// number (Offsite notes 2.docx, then 3) and never writes over anything.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync(join(import.meta.dirname, "..", "..", "src/renderer/help.html"), "utf8");
const at = html.indexOf('id="sharing-export"');
const section = html.slice(at, html.indexOf("<h2", at + 1));
const agentLine = section.split("\n").find((l) => l.includes("Export this to Word")) ?? "";

describe("Help on an agent's export", () => {
  it("says a Word copy's export takes the next free number and never writes over a file", () => {
    expect(agentLine).toContain("saves next to the document, with the same name, unless you tell it where");
    expect(agentLine).toContain("Offsite notes 2.docx, then Offsite notes 3.docx");
    expect(agentLine).toMatch(/next free number/);
    expect(agentLine).toMatch(/never writes over/);
  });
});
