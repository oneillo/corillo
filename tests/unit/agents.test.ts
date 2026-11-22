import { describe, expect, it } from "vitest";
import {
  Roster,
  Turns,
  AGENT_COLOURS,
  addressedTo,
  agentColour,
  agentColours,
  answeredBy,
  mayReply,
  nameForClient,
  nameProblem,
  toolForClient,
  numberedName,
  cleanName,
  waitingFor,
} from "../../src/core/agents";
import { addThread, reply, setResolved, type Author, type Thread } from "../../src/core/comments";

const me: Author = { kind: "person" };
const agent = (name: string): Author => ({ kind: "agent", name });

describe("agent names", () => {
  it("an agent is named after its tool", () => {
    expect(nameForClient("claude-code")).toBe("Claude");
    expect(nameForClient("claude-ai")).toBe("Claude"); // Claude Desktop
    expect(nameForClient("codex-mcp-client")).toBe("Codex");
    expect(nameForClient("cursor-vscode")).toBe("Cursor");
    expect(nameForClient("gemini-cli-mcp-client")).toBe("Gemini");
    expect(nameForClient("Visual Studio Code")).toBe("Copilot");
  });

  // The Connect screen turns a tool's row to Connected when one of its sessions reaches Corillo (roadmap Batch 5, item 2, P-5).
  it("a session is known by the agent tool it runs in, as the Connect screen lists them", () => {
    expect(toolForClient("claude-code")).toBe("claude-code");
    expect(toolForClient("claude-ai")).toBe("claude-desktop"); // Claude Desktop
    expect(toolForClient("codex-mcp-client")).toBe("codex");
    expect(toolForClient("cursor-vscode")).toBe("cursor");
    expect(toolForClient("gemini-cli-mcp-client")).toBe("gemini");
    expect(toolForClient("Visual Studio Code")).toBe("vscode");
    expect(toolForClient("github-copilot-cli")).toBe("copilot-cli");
    expect(toolForClient("acme-mcp-client")).toBeNull();
    expect(toolForClient("")).toBeNull();
  });

  it("other tools get a tidied version of their own name, and an unknown one is just Agent", () => {
    expect(nameForClient("acme-mcp-client")).toBe("Acme");
    expect(nameForClient("windsurf")).toBe("Windsurf");
    expect(nameForClient("")).toBe("Agent");
    expect(nameForClient(undefined)).toBe("Agent");
    expect(nameForClient("mcp-client")).toBe("Agent");
  });

  it("names are one tidy line, and the person's own words are kept for the person", () => {
    expect(cleanName("  Writer\n<b>  ")).toBe("Writer b");
    expect(cleanName("x".repeat(80))).toHaveLength(32);
    expect(nameProblem("person")).toMatch(/kept for the person/);
    expect(nameProblem("")).toMatch(/at least one letter/);
    expect(nameProblem("Writer")).toBeNull();
  });

  it("a long name is cut at the last whole word that fits, never on a word like \"for\" or \"the\"", () => {
    // 32 characters fit; "for" would be the last whole word, so it goes too.
    expect(cleanName("Senior Marketing Copywriter for Brand Launches")).toBe("Senior Marketing Copywriter");
    expect(cleanName("Head of Research and the Archives")).toBe("Head of Research");
    expect(cleanName("Editor in Chief of the Quarterlies")).toBe("Editor in Chief");
    expect(cleanName("Writer, Editor, Fact Checker, Proofreader")).toBe("Writer, Editor, Fact Checker");
    expect(cleanName("Policy Analyst - Health and Social Care")).toBe("Policy Analyst - Health");
    expect(cleanName("Assistant to a Regional Manager Abroad")).toBe("Assistant to a Regional Manager");
    // A name that ends exactly where the room does keeps every word.
    expect(cleanName("Head of Research and the Archive Team")).toBe("Head of Research and the Archive");
    // Short names, and the words inside them, are left alone.
    expect(cleanName("Writer for the Blog")).toBe("Writer for the Blog");
    // One word too long for the room is cut where the room ends.
    expect(cleanName("Supercalifragilisticexpialidocious Writer")).toBe("Supercalifragilisticexpialidocious".slice(0, 32));
  });

  it("several agents with the same name are numbered from the second: Claude, Claude 2, Claude 3", () => {
    expect(numberedName("Claude", [])).toBe("Claude");
    expect(numberedName("Claude", ["Claude"])).toBe("Claude 2");
    expect(numberedName("Claude", ["Claude", "Claude 2"])).toBe("Claude 3");
    expect(numberedName("Writer", ["Claude", "Claude 2"])).toBe("Writer");
  });

  it("each agent on a document gets its own pastel colour, the same one each time for the same name", () => {
    expect(agentColour("Claude")).toBe(agentColour("Claude"));
    expect(agentColour("Claude 2")).not.toBe(agentColour("Claude"));
    const roster = new Roster();
    const colours = ["a", "b", "c"].map((s) => roster.look("doc", s, "Claude").colour);
    expect(new Set(colours).size).toBe(3);
  });

  it("gives every agent named on a document a different colour until there are more agents than colours", () => {
    const names = ["Claude", "Claude 2", "Writer", "Codex", "Agent", "Editor"];
    const colours = agentColours(names);
    expect(new Set(colours.values()).size).toBe(names.length);
    for (const c of colours.values()) expect(AGENT_COLOURS).toContain(c);
  });

  it("gives an agent the same colour whenever it's the first on a document", () => {
    expect(agentColours(["Writer"]).get("Writer")).toBe(agentColours(["Writer", "Claude"]).get("Writer"));
  });

  it("an agent connected now keeps the colour the app gave it, so its comments match its editing notice", () => {
    // Claude arrived second and was given sky; Writer, who left, wrote comments too.
    const roster = new Roster();
    roster.look("doc", "s1", "Codex");
    const claude = roster.look("doc", "s2", "Claude");
    roster.leave("s1");
    const colours = agentColours(["Writer", "Claude"], [[claude.name, claude.colour]]);
    expect(colours.get("Claude")).toBe(claude.colour);
    expect(colours.get("Writer")).not.toBe(claude.colour);
  });

  it("the window and the app pick the same colour for an agent the same way", () => {
    const roster = new Roster();
    const names = ["Claude", "Writer", "Claude 2"];
    const given = names.map((n, i) => roster.look("doc", `s${i}`, n));
    expect(given.map((m) => m.colour)).toEqual(names.map((n) => agentColours(names).get(n)));
  });
});

describe("who is on a document", () => {
  it("numbers are per document: the second Claude on one document can be the only Claude on another", () => {
    const roster = new Roster();
    expect(roster.look("plan", "s1", "Claude").name).toBe("Claude");
    expect(roster.look("plan", "s2", "Claude").name).toBe("Claude 2");
    expect(roster.look("notes", "s2", "Claude").name).toBe("Claude");
    expect(roster.look("plan", "s3", "Codex").name).toBe("Codex");
  });

  it("a session keeps its name on a document while it lives", () => {
    const roster = new Roster();
    roster.look("plan", "s1", "Claude");
    roster.look("plan", "s2", "Claude");
    roster.look("plan", "s1", "Claude");
    expect(roster.member("plan", "s2")?.name).toBe("Claude 2");
  });

  it("when a session ends it leaves the document, and its name is free again (roadmap Batch 3, item 3: there's no default agent any more)", () => {
    const roster = new Roster();
    roster.look("plan", "s1", "Claude");
    roster.look("plan", "s2", "Codex");
    roster.leave("s1");
    expect(roster.members("plan").map((m) => m.name)).toEqual(["Codex"]);
    roster.look("plan", "s3", "Claude"); // the next to look
    expect(roster.member("plan", "s3")?.name).toBe("Claude"); // the name is free again
  });

  it("what an agent would be called on a document can be asked without joining it", () => {
    const roster = new Roster();
    roster.look("plan", "s1", "Claude");
    expect(roster.prospect("plan", "s2", "Claude")).toEqual({ name: "Claude 2" });
    expect(roster.prospect("notes", "s2", "Claude")).toEqual({ name: "Claude" });
    // The Claude there isn't in a round: a new chat would be plain Claude.
    expect(roster.prospect("plan", "s2", "Claude", () => false)).toEqual({ name: "Claude" });
    expect(roster.members("plan")).toHaveLength(1);
  });

  it("a session that introduces itself is renamed on the documents it's on", () => {
    const roster = new Roster();
    roster.look("plan", "s1", "Claude");
    roster.look("plan", "s2", "Claude");
    roster.rename("s2", "Writer");
    expect(roster.members("plan").map((m) => m.name)).toEqual(["Claude", "Writer"]);
  });
});

describe("which comments are for which agent", () => {
  const thread = (to: string | null, author: Author = me): Thread => addThread([], author, "Fix this.", null, to).thread;

  it("a comment directed at an agent is for that agent only", () => {
    const t = thread("Claude 2");
    expect(addressedTo(t, "Claude 2", false)).toBe(true);
    expect(addressedTo(t, "Claude", true)).toBe(false);
  });

  it("a comment directed at nobody is for the agent whose it is (the first to pick it up: see comments-to-agent-told.test.ts)", () => {
    const t = thread(null);
    expect(addressedTo(t, "Claude", true)).toBe(true);
    expect(addressedTo(t, "Codex", false)).toBe(false);
    expect(addressedTo(t, "Claude", (x) => x.id === t.id)).toBe(true);
    expect(addressedTo(t, "Claude", () => false)).toBe(false);
  });

  it("an agent may reply on comments it started, which are addressed to the person", () => {
    const t = thread("ignored", agent("Writer"));
    expect(t.to).toBe("person");
    expect(mayReply(t, "Writer", false)).toBe(true);
    expect(mayReply(t, "Claude", true)).toBe(false);
  });

  it("a comment waits for the agent until it answers; then it waits for the person", () => {
    let threads = [thread(null)];
    expect(waitingFor(threads[0], "Claude", true)).toBe(true);
    threads = reply(threads, threads[0].id, agent("Claude"), "Done: cut the intro.");
    expect(waitingFor(threads[0], "Claude", true)).toBe(false);
    expect(answeredBy(threads[0], "Claude", true)).toBe(true);
    threads = reply(threads, threads[0].id, me, "Shorter still, please.");
    expect(waitingFor(threads[0], "Claude", true)).toBe(true);
  });

  it("the person answering an agent's own question puts it back with that agent", () => {
    let threads = [thread(null, agent("Claude"))];
    expect(waitingFor(threads[0], "Claude", true)).toBe(false);
    threads = reply(threads, threads[0].id, me, "Yes, keep it.");
    expect(waitingFor(threads[0], "Claude", true)).toBe(true);
  });

  it("resolved comments wait for nobody", () => {
    const open = thread(null);
    const [t] = setResolved([open], open.id, me, true);
    expect(waitingFor(t, "Claude", true)).toBe(false);
    expect(answeredBy(t, "Claude", true)).toBe(false);
  });
});

describe("taking turns", () => {
  it("one agent holds a document at a time; the others are told who has it", () => {
    const turns = new Turns();
    expect(turns.take("plan", "s1", "Claude")).toMatchObject({ ok: true, already: false });
    expect(turns.take("plan", "s2", "Claude 2")).toEqual({ ok: false, heldBy: "Claude" });
    expect(turns.take("plan", "s1", "Claude")).toMatchObject({ ok: true, already: true });
    expect(turns.take("notes", "s2", "Claude")).toMatchObject({ ok: true });
  });

  it("when a pass ends, the next agent can take the document", () => {
    const turns = new Turns();
    turns.take("plan", "s1", "Claude");
    expect(turns.end("plan")?.name).toBe("Claude");
    expect(turns.holder("plan")).toBeUndefined();
    expect(turns.take("plan", "s2", "Claude 2")).toMatchObject({ ok: true });
  });

  it("knows every document a session holds, so they can be given back when it ends", () => {
    const turns = new Turns();
    turns.take("plan", "s1", "Claude");
    turns.take("notes", "s1", "Claude");
    turns.take("other", "s2", "Codex");
    expect(turns.heldBy("s1").sort()).toEqual(["notes", "plan"]);
  });
});
