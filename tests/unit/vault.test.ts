// Finding the note or picture an Obsidian link points to, in made-up folders
// (never a real vault).
import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressFrom, fileNameFor, findLinked, vaultOf } from "../../src/main/vault";

let root: string;
const make = (...parts: string[]) => {
  const file = join(root, ...parts);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "x");
  return file;
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "corillo-vault-")));
});

describe("what a link names", () => {
  it("a note's name means a Markdown file; other files keep their names", () => {
    expect(fileNameFor("Plan")).toBe("Plan.md");
    expect(fileNameFor("Plan.md")).toBe("Plan.md");
    expect(fileNameFor("Q2 review")).toBe("Q2 review.md");
    expect(fileNameFor("chart.png")).toBe("chart.png");
    expect(fileNameFor("Projects/Plan")).toBe("Projects/Plan.md");
    expect(fileNameFor("v1.2 notes")).toBe("v1.2 notes.md");
  });
});

describe("finding it", () => {
  it("a vault is the nearest folder above with Obsidian's settings folder", () => {
    mkdirSync(join(root, "Vault", ".obsidian"), { recursive: true });
    const doc = make("Vault", "Projects", "Plan.md");
    expect(vaultOf(doc)).toBe(join(root, "Vault"));
    expect(vaultOf(make("Elsewhere", "Note.md"))).toBe(null);
  });

  it("a note next to the document", async () => {
    const doc = make("Notes", "Plan.md");
    const other = make("Notes", "Q2 review.md");
    expect(await findLinked(doc, "Q2 review")).toBe(other);
    expect(await findLinked(doc, "Q2 review.md")).toBe(other);
  });

  it("a picture in the document's picture folder, as Corillo keeps them", async () => {
    const doc = make("Notes", "Plan.md");
    const pic = make("Notes", "Plan images", "chart.png");
    expect(await findLinked(doc, "chart.png")).toBe(pic);
  });

  it("a picture in an attachments folder next to the document or above it, inside the vault", async () => {
    mkdirSync(join(root, "Vault", ".obsidian"), { recursive: true });
    const doc = make("Vault", "Projects", "Q3", "Plan.md");
    const pic = make("Vault", "attachments", "chart.png");
    expect(await findLinked(doc, "chart.png")).toBe(pic);
    const nearer = make("Vault", "Projects", "Q3", "attachments", "chart.png");
    expect(await findLinked(doc, "chart.png")).toBe(nearer);
  });

  it("anywhere else in the vault, by name, nearest folder first", async () => {
    mkdirSync(join(root, "Vault", ".obsidian"), { recursive: true });
    const doc = make("Vault", "Projects", "Plan.md");
    const deep = make("Vault", "Archive", "2024", "Old", "Ana López.md");
    expect(await findLinked(doc, "Ana López")).toBe(deep);
    const shallow = make("Vault", "People", "Ana López.md");
    expect(await findLinked(doc, "Ana López")).toBe(shallow);
  });

  it("a path in the link, from the vault's top folder or the document's", async () => {
    mkdirSync(join(root, "Vault", ".obsidian"), { recursive: true });
    const doc = make("Vault", "Projects", "Plan.md");
    const team = make("Vault", "Team", "Marcus.md");
    make("Vault", "Old", "Marcus.md");
    expect(await findLinked(doc, "Team/Marcus")).toBe(team);
    const here = make("Vault", "Projects", "Sub", "Notes.md");
    expect(await findLinked(doc, "Sub/Notes")).toBe(here);
  });

  it("hidden folders aren't searched, and what isn't there is null", async () => {
    mkdirSync(join(root, "Vault", ".obsidian"), { recursive: true });
    const doc = make("Vault", "Plan.md");
    make("Vault", ".trash", "Gone.md");
    expect(await findLinked(doc, "Gone")).toBe(null);
    expect(await findLinked(doc, "Missing note")).toBe(null);
    expect(await findLinked(doc, "")).toBe(null);
  });

  it("outside a vault, only the document's folder and the folders below it are searched", async () => {
    const doc = make("Folder", "Plan.md");
    make("Elsewhere", "Far.md");
    const below = make("Folder", "Sub", "Near.md");
    expect(await findLinked(doc, "Far")).toBe(null);
    expect(await findLinked(doc, "Near")).toBe(below);
  });

  it("gives an address from the document's folder, the way Markdown writes it", () => {
    expect(addressFrom(join(root, "A", "Plan.md"), join(root, "attachments", "chart one.png"))).toBe("../attachments/chart one.png");
  });
});
