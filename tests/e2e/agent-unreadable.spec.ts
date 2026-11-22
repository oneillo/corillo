// A document whose file can no longer be read as text, at the agents' door, against the hidden app (the review of
// Batch 21, G21-5; its proof, review/batch-21/proofs/guards/agents-door.spec.ts, moved here in roadmap Batch 22,
// item 2). Before, the agent was told "hasn't changed since your last read", its edit was refused with "Read it
// again and redo your edit", and the next read said again that nothing changed: it couldn't get out by itself.
import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { openText } from "./helpers";
import { AgentSession } from "./agent-session";

const PLAN = "# Plan\n\nThe offer to Acme is 41,500 dollars, not yet public.\n\nNext steps follow.\n";
const WORDS = "Corillo can only open text files saved as UTF-8.";

test("an agent reading a document whose file can no longer be read as text is told so, not that nothing changed", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  await session.ok("take_document", { path: run.file });
  // Another app saves the file in a form Corillo can't read (UTF-16 here).
  const theirs = Buffer.from(String.fromCharCode(0xfeff) + "Plan, rewritten elsewhere.\n", "utf16le");
  writeFileSync(run.file, theirs);
  // No wait: the agent's calls read the file themselves, and the window has nothing to show for it (R22-12).
  const read = await session.call("read_document", { path: run.file });
  const edit = await session.call("edit_document", { path: run.file, edits: [{ find: "Next steps follow.", replace: "Next steps follow soon." }] });
  const again = await session.call("read_document", { path: run.file });
  const finished = await session.call("finish_editing", { path: run.file });
  const left = readFileSync(run.file);
  // The window threw nothing on its way (R22-12).
  expect(run.thrown?.splice(0) ?? []).toEqual([]);
  await run.app.close();
  await session.stop();
  for (const told of [read, edit, again]) {
    expect(told.isError).toBe(true);
    expect(told.text).toContain(WORDS);
    expect(told.text).not.toContain("hasn't changed since your last read");
    expect(told.text).not.toContain("Read it again and redo your edit");
  }
  expect(finished.isError).toBe(false); // it can still hand the document back
  expect(left.equals(theirs)).toBe(true); // nothing was written over the other app's file
});
