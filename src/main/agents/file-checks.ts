// Why Corillo can't open or create a file for an agent, in words the agent can
// pass on to the person: each problem its own, never a code.
import * as fs from "node:fs";
import * as path from "node:path";
import { FileProblem, LONG_DOCUMENT_BYTES, MAX_DOCUMENT_BYTES, megabytes, problemText } from "../files";
import { wordForAgent } from "../word-copy";
import { AgentError } from "./shapes";

const codeOf = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code;

/** Why Corillo can't read this file as a document, for the agent. */
export function openProblem(err: unknown, filePath: string): string {
  // Over 25 MB, or not text saved as UTF-8: files.ts has the words.
  if (err instanceof FileProblem) return err.message;
  switch (codeOf(err)) {
    case "ENOENT":
    case "ENOTDIR":
      return `There's no file at ${filePath}. To start a new document, use create_document.`;
    case "EACCES":
    case "EPERM":
      return `Corillo isn't allowed to read ${filePath}. The Mac may be keeping Corillo out of that folder: the person can let it in under System Settings > Privacy & Security > Files and Folders, then try again.`;
    default:
      return `Corillo couldn't read ${filePath} just now. Try again in a moment.`;
  }
}

/** Throws an AgentError, in plain words, if Corillo can't open this file as a document. */
export function checkOpenable(filePath: string, readText: (filePath: string) => string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    throw new AgentError(openProblem(err, filePath));
  }
  if (!stat.isFile()) throw new AgentError(`${filePath} is a folder, not a document.`);
  // A Word document opens as a Markdown copy, made only when the person opens it (review of Batch 11, B11R-6).
  const word = wordForAgent(filePath);
  if (word) throw new AgentError(word);
  try {
    readText(filePath);
  } catch (err) {
    throw new AgentError(openProblem(err, filePath));
  }
  checkNotLong(filePath, stat.size);
}

/** A document long enough to slow the window down is opened only by the person, who's asked first; a new one, not made yet (`exists` false), isn't made. */
export function checkNotLong(filePath: string, size: number, exists = true): void {
  if (size > LONG_DOCUMENT_BYTES && size <= MAX_DOCUMENT_BYTES) {
    const name = path.basename(filePath);
    throw new AgentError(
      exists
        ? `${name} is ${megabytes(size)}, so long that opening it would slow Corillo's window down. Ask the person to open it in Corillo if they want to work on it there; once it's open, you can work on it too.`
        : `${name} would be ${megabytes(size)}, so long that opening it would slow Corillo's window down. It wasn't created.`,
    );
  }
}

/** Why a new document (or its folder) couldn't be made. */
export function createProblem(err: unknown, filePath: string): string {
  return `Corillo couldn't create ${filePath}: ${problemText(err)}.`;
}
