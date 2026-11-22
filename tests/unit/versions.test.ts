import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VersionHistory } from "../../src/main/version-store";
import { addThread, reply, type Author, type Thread } from "../../src/core/comments";
import { versionLabel } from "../../src/core/versions";

const me: Author = { kind: "person" };
const claude: Author = { kind: "agent", name: "Claude" };

/** A throwaway data folder and document, and a clock the test moves by hand. */
function setup(text = "# Plan\n\nFirst draft.\n") {
  const data = mkdtempSync(join(tmpdir(), "corillo-history-"));
  const docs = mkdtempSync(join(tmpdir(), "corillo-docs-"));
  const file = join(docs, "plan.md");
  writeFileSync(file, text);
  let time = new Date("2026-11-08T10:00:00Z").getTime();
  const clock = () => new Date(time);
  const h = new VersionHistory(data, clock);
  const id = h.idFor(file);
  h.seen(id, text);
  const later = (minutes = 1) => {
    time += minutes * 60_000;
  };
  const kinds = () => h.list(id).map((v) => (v.kind === "agent" ? `agent:${v.agent}` : v.kind));
  const versionsDir = join(data, "documents", id, "versions");
  return { h, id, data, file, later, kinds, versionsDir, clock };
}

function folderSize(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    total += s.isDirectory() ? folderSize(p) : s.size;
  }
  return total;
}

describe("versions: one editing pass is one version", () => {
  it("the first time Corillo sees a document, its text is the first version", () => {
    const { h, id, kinds } = setup();
    expect(kinds()).toEqual(["first"]);
    expect(h.text(id, 1)).toBe("# Plan\n\nFirst draft.\n");
  });

  it("all of the person's edits are one version, kept up to date as Corillo saves", () => {
    const { h, id, kinds, later } = setup();
    h.edited(id, "# Plan\n\nFirst draft. More.\n");
    later();
    h.edited(id, "# Plan\n\nFirst draft. More and more.\n");
    expect(kinds()).toEqual(["first", "person"]);
    expect(h.text(id, 2)).toBe("# Plan\n\nFirst draft. More and more.\n");
    expect(h.list(id)[1].open).toBe(true);
  });

  // The status bar says whose turn it is only on a document an agent has worked on (Orlando, 2026-11-09).
  it("opening a document says whether an agent has a version in its history", () => {
    const { h, id } = setup();
    expect(h.seen(id, "# Plan\n\nFirst draft.\n")).toBe(false);
    h.edited(id, "Mine.\n");
    expect(h.seen(id, "Mine.\n")).toBe(false);
    h.beginPass(id, "Claude");
    h.edited(id, "Claude's.\n");
    h.endPass(id);
    expect(h.seen(id, "Claude's.\n")).toBe(true);
    // A document seen for the first time has no history at all.
    const fresh = join(mkdtempSync(join(tmpdir(), "corillo-docs-")), "fresh.md");
    writeFileSync(fresh, "New.\n");
    expect(h.seen(h.idFor(fresh), "New.\n")).toBe(false);
  });

  it("closing and reopening the document doesn't end the person's version", () => {
    const { h, id, kinds } = setup();
    h.edited(id, "Edit one.\n");
    h.seen(id, "Edit one.\n"); // opened again, same text
    h.edited(id, "Edit one. Edit two.\n");
    expect(kinds()).toEqual(["first", "person"]);
  });

  it("an agent's pass is one version by that agent, and ends the person's version", () => {
    const { h, id, kinds } = setup();
    h.edited(id, "Mine.\n");
    h.beginPass(id, "Claude");
    expect(h.holder(id)).toBe("Claude");
    h.edited(id, "Mine. Claude one.\n");
    h.edited(id, "Mine. Claude one. Claude two.\n");
    const v = h.endPass(id, { addressed: [] });
    expect(v?.kind).toBe("agent");
    expect(h.holder(id)).toBeNull();
    // The person's next edits are a new version.
    h.edited(id, "Mine. Claude one. Claude two. Mine again.\n");
    expect(kinds()).toEqual(["first", "person", "agent:Claude", "person"]);
    expect(h.text(id, 3)).toBe("Mine. Claude one. Claude two.\n");
  });

  it("an agent's version keeps the comments it addressed, as they were when it finished", () => {
    const { h, id } = setup();
    let { threads, thread } = addThread([], me, "Tighten the intro.", null, null);
    h.beginPass(id, "Claude");
    h.edited(id, "# Plan\n\nTighter.\n");
    threads = reply(threads, thread.id, claude, "Cut it to one word.");
    h.endPass(id, { addressed: threads });
    // Later replies don't change what the version recorded.
    threads = reply(threads, thread.id, me, "Thanks.");
    const recorded = h.list(id)[1].addressed as Thread[];
    expect(recorded[0].messages.map((m) => m.body)).toEqual(["Tighten the intro.", "Cut it to one word."]);
    expect(h.list(id)[1]).toMatchObject({ kind: "agent", agent: "Claude" });
  });

  it("a pass that only replied to comments is still a version, so the feedback is kept", () => {
    const { h, id, kinds } = setup();
    const { threads } = addThread([], me, "Is this right?", null, null);
    h.beginPass(id, "Writer");
    const v = h.endPass(id, { addressed: reply(threads, threads[0].id, { kind: "agent", name: "Writer" }, "Yes.") });
    expect(kinds()).toEqual(["first", "agent:Writer"]);
    expect(v?.addressed?.length).toBe(1);
    expect(h.text(id, 2)).toBe(h.text(id, 1));
  });

  it("a pass that changed nothing and addressed nothing leaves no version", () => {
    const { h, id, kinds } = setup();
    h.beginPass(id, "Claude");
    expect(h.endPass(id)).toBeNull();
    expect(kinds()).toEqual(["first"]);
  });

  it("only one agent holds the document at a time", () => {
    const { h, id } = setup();
    h.beginPass(id, "Claude");
    h.beginPass(id, "Claude"); // the same agent again: nothing changes
    expect(() => h.beginPass(id, "Codex")).toThrow("Claude is editing");
  });
});

describe("versions: changes made outside Corillo", () => {
  it("become a version of their own, compared with the last version", () => {
    const { h, id, kinds } = setup();
    h.edited(id, "Mine.\n");
    h.outside(id, "Rewritten elsewhere.\n");
    h.edited(id, "Rewritten elsewhere. Mine again.\n");
    expect(kinds()).toEqual(["first", "person", "outside", "person"]);
    expect(h.text(id, 3)).toBe("Rewritten elsewhere.\n");
  });

  it("a document changed while it was closed shows the change when it opens again", () => {
    const { h, id, kinds } = setup();
    h.seen(id, "# Plan\n\nChanged in another app.\n");
    expect(kinds()).toEqual(["first", "outside"]);
    expect(h.text(id, 2)).toBe("# Plan\n\nChanged in another app.\n");
  });
});

describe("versions: nothing stored twice", () => {
  it("skips a version identical to the one before it", () => {
    const { h, id, kinds } = setup();
    h.outside(id, "# Plan\n\nFirst draft.\n");
    h.edited(id, "# Plan\n\nFirst draft.\n");
    expect(kinds()).toEqual(["first"]);
  });

  it("edits undone back to where the pass started leave no version", () => {
    const { h, id, kinds } = setup();
    h.edited(id, "# Plan\n\nFirst draft. Oops.\n");
    h.edited(id, "# Plan\n\nFirst draft.\n");
    expect(kinds()).toEqual(["first"]);
    h.edited(id, "# Plan\n\nSecond go.\n");
    expect(kinds()).toEqual(["first", "person"]);
    expect(h.text(id, 1)).toBe("# Plan\n\nFirst draft.\n");
  });
});

describe("versions: restoring", () => {
  it("makes an old version current as a new version, and loses nothing", () => {
    const { h, id, kinds, later } = setup();
    later();
    h.edited(id, "Second.\n");
    h.outside(id, "Third.\n");
    const r = h.prepareRestore(id, 2);
    expect(r).toEqual({ ok: true, text: "Second.\n", same: false });
    h.edited(id, "Second.\n"); // the window saves the restored text the usual way
    expect(kinds()).toEqual(["first", "person", "outside", "restored"]);
    expect(h.list(id)[3].restoredFrom).toEqual({ n: 2, saved: "2026-11-08T10:01:00.000Z" });
    expect(h.text(id, 3)).toBe("Third.\n");
    // The person's next edits are a new version, not part of the restore.
    h.edited(id, "Second. More.\n");
    expect(kinds()).toEqual(["first", "person", "outside", "restored", "person"]);
  });

  it("is blocked while an agent holds the document", () => {
    const { h, id } = setup();
    h.edited(id, "Second.\n");
    h.beginPass(id, "Claude 2");
    expect(h.prepareRestore(id, 1)).toEqual({ ok: false, reason: expect.stringContaining("Claude 2 is editing") });
    h.endPass(id);
    expect(h.prepareRestore(id, 1)).toMatchObject({ ok: true });
  });

  it("restoring a version with the same text as now changes nothing", () => {
    const { h, id, kinds } = setup();
    expect(h.prepareRestore(id, 1)).toMatchObject({ ok: true, same: true });
    expect(kinds()).toEqual(["first"]);
  });
});

describe("versions: stored as changes, not copies", () => {
  // A 5,000-word document: 250 sentences of 20 words, made up from a word list.
  const vocabulary = (
    "the team would answer people faster with one shared help desk for every volunteer and each request gets " +
    "tracked until someone closes it properly today because members often wait days before anybody notices their " +
    "message so we propose a simple tool that costs little needs no training works on phones and keeps history " +
    "of who said what when budget approval arrives next quarter after review by board treasurer chair"
  ).split(" ");
  const sentence = (seed: number) => {
    let x = seed * 2654435761 + 1;
    const next = () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x;
    };
    const words = Array.from({ length: 20 }, () => vocabulary[next() % vocabulary.length]);
    return words.join(" ").replace(/^./, (c) => c.toUpperCase()) + ".";
  };
  const document = (sentences: string[]) => `# Help desk\n\n${sentences.join(" ")}\n`;

  /** 200 passes, alternately an agent's and the person's, each rewriting one whole sentence. */
  function manyPasses() {
    const sentences = Array.from({ length: 250 }, (_, i) => sentence(i));
    const start = document(sentences);
    const run = setup(start);
    const expected = [start];
    for (let pass = 0; pass < 200; pass++) {
      sentences[(pass * 37) % 250] = sentence(1000 + pass);
      const text = document(sentences);
      if (pass % 2 === 0) {
        run.h.beginPass(run.id, "Claude");
        run.h.edited(run.id, text);
        run.h.endPass(run.id);
      } else {
        run.h.edited(run.id, text);
      }
      expected.push(text);
    }
    return { ...run, start, expected };
  }

  it("200 passes over a 5,000-word document, each changing one sentence, take less room than one copy of it, and every version comes back exactly", () => {
    const { h, id, versionsDir, start, expected } = manyPasses();
    expect(start.split(/\s+/).length).toBeGreaterThan(5000);
    expect(h.list(id)).toHaveLength(201);
    // Full copies would be 201 times the document; the whole history is smaller than one.
    expect(folderSize(versionsDir)).toBeLessThan(start.length);
    for (let n = 1; n <= 201; n++) expect(h.text(id, n)).toBe(expected[n - 1]);
  }, 30_000); // a correctness check on a lot of work, not a speed test: slow when the Mac is busy

  it("a damaged compressed segment loses only the versions it holds and older ones", () => {
    const { h, id, versionsDir, expected } = manyPasses();
    const segments = readdirSync(versionsDir).filter((f) => /^older-\d+\.jsonl\.gz$/.test(f));
    expect(segments.length).toBeGreaterThan(1);
    const oldest = segments.sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))[0];
    writeFileSync(join(versionsDir, oldest), "damaged");
    const second = Number(segments[1].match(/\d+/)![0]);
    // Every version from the second segment on is fine; the current text is untouched.
    for (let n = second; n <= 201; n += 7) expect(h.text(id, n)).toBe(expected[n - 1]);
    expect(h.text(id, 201)).toBe(expected[200]);
    expect(h.text(id, 1)).toBeNull();
  }, 30_000); // the same 200 passes as above: slow when the Mac is busy

  it("the person's open version rewrites one record as he saves, not one per save", () => {
    const { h, id, versionsDir } = setup("Start.\n");
    h.outside(id, "Outside.\n");
    let text = "Outside.";
    for (let i = 0; i < 50; i++) {
      text += ` Word${i}.`;
      h.edited(id, `${text}\n`);
    }
    expect(h.list(id)).toHaveLength(3);
    const older = readFileSync(join(versionsDir, "older.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(older).toHaveLength(1); // the record turning "Outside." back into "Start."
    expect(h.text(id, 2)).toBe("Outside.\n");
    expect(h.text(id, 1)).toBe("Start.\n");
  });

  it("a damaged record loses only the versions before it, never newer ones or the current text", () => {
    const { h, id, versionsDir } = setup("v1\n");
    for (let n = 2; n <= 10; n++) h.outside(id, `v${n}\n`);
    const file = join(versionsDir, "older.jsonl");
    // Damage the record that turns version 6 back into version 5.
    const lines = readFileSync(file, "utf8").split("\n");
    writeFileSync(file, lines.map((l) => (l.includes('"n":5,') ? l.replace('"v5', '"vX') : l)).join("\n"));
    for (let n = 6; n <= 10; n++) expect(h.text(id, n)).toBe(`v${n}\n`);
    expect(h.text(id, 5)).toBeNull();
    expect(h.text(id, 1)).toBeNull();
    expect(h.prepareRestore(id, 3)).toMatchObject({ ok: false });
    expect(h.list(id)).toHaveLength(10);
    // The history carries on.
    h.edited(id, "v11\n");
    expect(h.text(id, 10)).toBe("v10\n");
    expect(h.text(id, 11)).toBe("v11\n");
  });

  it("a damaged or missing file of older records doesn't break the current text", () => {
    const { h, id, versionsDir } = setup("v1\n");
    for (let n = 2; n <= 5; n++) h.outside(id, `v${n}\n`);
    writeFileSync(join(versionsDir, "older.jsonl"), "\u0000garbage{{{\n");
    expect(h.text(id, 5)).toBe("v5\n");
    expect(h.text(id, 4)).toBe("v4\n"); // kept with the current text
    expect(h.text(id, 3)).toBeNull();
    renameSync(join(versionsDir, "older.jsonl"), join(versionsDir, "gone.jsonl"));
    expect(h.text(id, 5)).toBe("v5\n");
    expect(h.text(id, 4)).toBe("v4\n");
  });

  it("a history that can't be read at all is set aside and a new one starts; the document is never touched", () => {
    const { h, id, file, versionsDir } = setup("v1\n");
    h.outside(id, "v2\n");
    writeFileSync(join(versionsDir, "latest.json.gz"), "not a history");
    expect(h.list(id)).toEqual([]);
    h.seen(id, "v2\n");
    expect(h.list(id).map((v) => v.kind)).toEqual(["first"]);
    expect(readdirSync(versionsDir).some((f) => f.startsWith("set-aside-"))).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("v1\n");
  });
});

describe("versions: agents can read them", () => {
  it("lists who made each version, and rebuilds each one's text", () => {
    const { h, id } = setup("# Plan\n\nWe answer slowly.\n");
    h.edited(id, "# Plan\n\nWe answer slowly. Today.\n");
    h.beginPass(id, "Writer");
    h.edited(id, "# Plan\n\nWe answer quickly. Today.\n");
    h.endPass(id);
    expect(h.list(id).map((v) => versionLabel(v, "agent"))).toEqual(["First version", "The person", "Writer"]);
    expect([1, 2, 3].map((n) => h.text(id, n))).toEqual(["# Plan\n\nWe answer slowly.\n", "# Plan\n\nWe answer slowly. Today.\n", "# Plan\n\nWe answer quickly. Today.\n"]);
  });

  it("finds a document's history again after it was moved in Finder", () => {
    const { h, id, file, data, clock } = setup("Text.\n");
    h.edited(id, "Text. More.\n");
    writeFileSync(file, "Text. More.\n");
    h.saved(id, file);
    const moved = file.replace("plan.md", "plan moved.md");
    renameSync(file, moved);
    const again = new VersionHistory(data, clock);
    const sameId = again.idFor(moved);
    expect(sameId).toBe(id);
    expect(again.list(sameId)).toHaveLength(2);
  });
});

describe("showing an old version", () => {
  it("gives its text and the one before it in one walk back, reading the history's records once", () => {
    const { h, id, later } = setup();
    const texts = ["# Plan\n\nFirst draft.\n"];
    for (let i = 0; i < 60; i++) {
      later();
      // Each save after an outside change is a version of its own.
      const next = `${texts[texts.length - 1]}Line ${i} of the plan.\n`;
      h.outside(id, next);
      texts.push(next);
    }
    const versions = h.list(id);
    expect(versions).toHaveLength(61);
    const reads = vi.spyOn(h as unknown as { readLog: () => unknown[] }, "readLog");
    const oldest = h.versionTexts(id, versions[1].n);
    expect(oldest).toEqual({ text: texts[1], before: texts[0], hasBefore: true });
    expect(reads).toHaveBeenCalledTimes(1);
    expect(h.versionTexts(id, versions[0].n)).toEqual({ text: texts[0], before: null, hasBefore: false });
    expect(h.versionTexts(id, versions[60].n)).toEqual({ text: texts[60], before: texts[59], hasBefore: true });
    expect(h.versionTexts(id, 999)).toEqual({ text: null, before: null, hasBefore: false });
    reads.mockRestore();
  });
});
