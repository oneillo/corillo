// Whoever runs the tests, as their Mac knows them, as patterns the stranger
// tests (stranger-mac.spec.ts) look for in what Corillo shows. A name part
// that is also one of Corillo's own words ("Will", "May", "June", "Page", the
// made-up "Ana") can't be told apart from them, so it isn't looked for on its
// own (review B13R-5); the whole name, email, home folder and the rest still are.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Runner {
  username: string;
  host: string;
  computer: string;
  gitName: string;
  email: string;
  home: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (s: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(s)}($|[^\\p{L}\\p{N}])`, "iu");

/** The text of Corillo's own window, Help and About, and of the files the stranger tests write: every word they can show by themselves. */
export function ownWords(root: string): string {
  const texts: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const at = join(dir, name);
      if (statSync(at).isDirectory()) walk(at);
      else if (/\.(ts|html)$/.test(name)) texts.push(readFileSync(at, "utf8"));
    }
  };
  walk(join(root, "src"));
  for (const f of ["tests/e2e/stranger-mac.spec.ts", "tests/fixtures/make-docx.ts"]) texts.push(readFileSync(join(root, f), "utf8"));
  return texts.join("\n");
}

/** What would give the runner away if Corillo showed it. `own` is ownWords' text. */
export function runnerPatterns(runner: Runner, own: string): RegExp[] {
  const always = [runner.email, runner.gitName].filter((s) => s.length >= 3);
  const parts = [runner.username, runner.host.replace(/\.local$/, ""), runner.computer, ...runner.gitName.split(/\s+/)].filter((s) => s.length >= 3);
  const named = [...new Set([...always, ...parts.filter((p) => !word(p).test(own))])];
  return named.map(word).concat([/\/Users\//, /homebrew/i, /~\/ai\b/, new RegExp(escape(runner.home))]);
}
