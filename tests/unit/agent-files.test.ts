// What an agent is told when Corillo can't open or create a file for it, and
// when Corillo can't set up the connection agents reach it by.
import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { checkOpenable, createProblem } from "../../src/main/agents/file-checks";
import { listenForAgents } from "../../src/main/agents/socket-server";
import { readText } from "../../src/main/files";
import type { AgentService } from "../../src/main/agents/agent-service";

const folder = () => mkdtempSync(path.join(tmpdir(), "corillo-agent-files-"));
const refusal = (filePath: string) => {
  try {
    checkOpenable(filePath, readText);
    return "";
  } catch (err) {
    return (err as Error).message;
  }
};

describe("files an agent asks Corillo to open", () => {
  it("each problem in its own words: not there, a folder, not allowed, too big, not text", () => {
    const dir = folder();
    expect(refusal(path.join(dir, "gone.md"))).toBe(`There's no file at ${path.join(dir, "gone.md")}. To start a new document, use create_document.`);
    expect(refusal(dir)).toBe(`${dir} is a folder, not a document.`);
    const locked = path.join(dir, "locked.md");
    writeFileSync(locked, "# Secret\n");
    chmodSync(locked, 0o000);
    expect(refusal(locked)).toBe(
      `Corillo isn't allowed to read ${locked}. The Mac may be keeping Corillo out of that folder: the person can let it in under System Settings > Privacy & Security > Files and Folders, then try again.`,
    );
    chmodSync(locked, 0o600);
    const huge = path.join(dir, "huge.md");
    writeFileSync(huge, "");
    truncateSync(huge, 26 * 1024 * 1024);
    expect(refusal(huge)).toBe("The file is over 25 MB, too big for Corillo to open.");
    // Long enough to slow the window down: the person opens it, not an agent.
    const long = path.join(dir, "long.md");
    writeFileSync(long, "");
    truncateSync(long, 12 * 1024 * 1024);
    expect(refusal(long)).toBe(
      "long.md is 12 MB, so long that opening it would slow Corillo's window down. Ask the person to open it in Corillo if they want to work on it there; once it's open, you can work on it too.",
    );
    const old = path.join(dir, "old.md");
    writeFileSync(old, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    expect(refusal(old)).toBe("Corillo can only open text files saved as UTF-8.");
    const fine = path.join(dir, "fine.md");
    writeFileSync(fine, "# Fine\n");
    expect(refusal(fine)).toBe("");
  });

  // Roadmap Batch 11, F-28: a PDF or a picture is told what Corillo opens, in plain words, not "UTF-8".
  it("a PDF, a picture or another kind of file is told what Corillo opens, in plain words", () => {
    const dir = folder();
    const write = (name: string, bytes: number[] | string) => {
      const file = path.join(dir, name);
      writeFileSync(file, typeof bytes === "string" ? bytes : Buffer.from(bytes));
      return file;
    };
    const DOCUMENTS = "Corillo opens Markdown and Word documents";
    const pdf = `${DOCUMENTS}, and this is a PDF. An agent can make a Markdown document from it.`;
    const picture = `${DOCUMENTS}, and this is a picture. To put it in a document, open the document and choose Insert > Picture.`;
    // A PDF, also one written all in plain letters (it would otherwise open as text).
    expect(refusal(write("report.pdf", [...Buffer.from("%PDF-1.7\n%"), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))).toBe(pdf);
    expect(refusal(write("plain.pdf", "%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n"))).toBe(pdf);
    // Review of Batch 11, B11R-1: only a file that starts with it; a document that mentions it is a document.
    expect(refusal(write("headers.md", "# Notes\n\nA note on %PDF-1.7 headers.\n"))).toBe("");
    // Pictures, by what they start with, whatever they're called.
    expect(refusal(write("photo.png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]))).toBe(picture);
    expect(refusal(write("photo.jpg", [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]))).toBe(picture);
    expect(refusal(write("named wrong.md", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]))).toBe(picture);
    // A drawing is text, so only one called .svg is taken for a picture: a document that starts with one stays a document.
    expect(refusal(write("logo.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>\n'))).toBe(picture);
    expect(refusal(write("drawing.md", '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>\n\nA drawing.\n'))).toBe("");
    // Something else that isn't text at all (a spreadsheet, an archive).
    expect(refusal(write("budget.xlsx", [0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0x06, 0, 0x08, 0, 0, 0, 0x21, 0, 0x9c, 0xff]))).toBe(`${DOCUMENTS}, and this file isn't one.`);
    // Text in an older encoding keeps its own words.
    expect(refusal(write("old.md", [0x63, 0x61, 0x66, 0xe9, 0x0a]))).toBe("Corillo can only open text files saved as UTF-8.");
  });

  // Review of Batch 11, B11R-6: a Word document was told it isn't one, and text saved as UTF-16 (as Windows
  // Notepad can) was told it isn't text, where the UTF-8 sentence says what to do.
  it("a Word document is told how it opens in Corillo, and text saved as UTF-16 gets the UTF-8 sentence", () => {
    const dir = folder();
    const write = (name: string, bytes: Buffer) => {
      const file = path.join(dir, name);
      writeFileSync(file, bytes);
      return file;
    };
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0x06, 0, 0x08, 0, 0, 0, 0x21, 0, 0x9c, 0xff]);
    expect(refusal(write("Offsite notes.docx", zip))).toBe(
      "Offsite notes.docx is a Word document. Corillo works on a Markdown copy of it: ask the person to open it in Corillo (File > Open), which saves the copy next to it. Then you can open the copy.",
    );
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect(refusal(write("Old notes.doc", ole))).toBe(
      "Old notes.doc is in Word's older format (.doc), which Corillo can't read. Ask the person to open it in Word and save it as a Word document (.docx), then to open that in Corillo.",
    );
    const utf8Only = "Corillo can only open text files saved as UTF-8.";
    expect(refusal(write("little.md", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("# Notes\n\nA line.\n", "utf16le")])))).toBe(utf8Only);
    expect(refusal(write("big.md", Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("# Notes\n", "utf16le").swap16()])))).toBe(utf8Only);
  });

  it("a new document whose folder can't be made says why, in plain words", () => {
    const dir = folder();
    const shut = path.join(dir, "shut");
    mkdirSync(shut);
    chmodSync(shut, 0o500);
    let error: NodeJS.ErrnoException | null = null;
    try {
      mkdirSync(path.join(shut, "drafts"), { recursive: true });
    } catch (err) {
      error = err as NodeJS.ErrnoException;
    }
    chmodSync(shut, 0o700);
    const target = path.join(shut, "drafts", "new.md");
    expect(createProblem(error, target)).toBe(`Corillo couldn't create ${target}: Corillo isn't allowed to change this file or its folder.`);
    expect(createProblem(Object.assign(new Error("x"), { code: "ENOSPC" }), target)).toBe(`Corillo couldn't create ${target}: the disk is full.`);
  });
});

describe("the connection agents reach Corillo by", () => {
  it("if it can't be set up, Corillo hears why, so it can tell the person", () => {
    const dir = folder();
    const notAFolder = path.join(dir, "sockets");
    writeFileSync(notAFolder, "a file where the folder should be");
    const problems: string[] = [];
    const server = listenForAgents(path.join(notAFolder, "agents.sock"), {} as AgentService, (text) => problems.push(text));
    expect(server).toBeNull();
    expect(problems).toEqual(["Agents can't reach Corillo: it couldn't set up their connection. Quit Corillo and open it again."]);
  });
});
