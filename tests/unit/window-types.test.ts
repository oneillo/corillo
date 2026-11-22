// The window hears documents, agents and finished passes in the shapes the
// app sends them (roadmap Batch 18, item 3, A16-10). The preload and the
// comments' logic take those shapes from the app rather than copying them by
// hand, so a change on one side can't drift from the other unseen. These
// checks are made by the type check (`npm run typecheck`, which reads the
// tests too); at run time they do nothing.
import { describe, expectTypeOf, it } from "vitest";
import type {
  AgentInfo as WindowAgent,
  DocInfo as WindowDoc,
  MissingKind as WindowMissing,
  NewPlace as WindowPlace,
  PassSummary as WindowPass,
  RenameResult as WindowRename,
  SaveResult,
} from "../../src/preload/preload";
import type { AgentInfo as PanelAgent, PassDone } from "../../src/renderer/comment-format";
import type { DocInfo, MissingKind, NewPlace, OpenDoc, RenameResult, SaveOutcome } from "../../src/main/doc-on-disk";
import type { AgentInfo, PassSummary } from "../../src/main/agents/agent-service";
import type { MainParts } from "../../src/main/agents/host";

describe("the window's shapes are the app's", () => {
  it("a document, as the window opens it", () => {
    expectTypeOf<WindowDoc>().toEqualTypeOf<DocInfo>();
  });

  it("an agent on a document", () => {
    expectTypeOf<WindowAgent>().toEqualTypeOf<AgentInfo>();
    // The comments' logic needs less of it (no colour or editing), but what it reads has the app's types.
    expectTypeOf<AgentInfo>().toMatchTypeOf<PanelAgent>();
    expectTypeOf<PanelAgent["colour"]>().toEqualTypeOf<AgentInfo["colour"] | undefined>();
    expectTypeOf<PanelAgent["has"]>().toEqualTypeOf<AgentInfo["has"]>();
  });

  it("a save's answer, a file that's gone or moved, and a rename's answer (S21-57)", () => {
    expectTypeOf<SaveResult>().toEqualTypeOf<SaveOutcome>();
    expectTypeOf<WindowMissing>().toEqualTypeOf<MissingKind>();
    expectTypeOf<WindowPlace>().toEqualTypeOf<NewPlace>();
    expectTypeOf<WindowRename>().toEqualTypeOf<RenameResult>();
  });

  it("an agent's finished pass", () => {
    expectTypeOf<WindowPass>().toEqualTypeOf<PassSummary>();
    expectTypeOf<PassDone>().toEqualTypeOf<PassSummary>();
  });
});

describe("the agents' document is the document on disk", () => {
  it("each takes the other as it is, so doc-on-disk.ts gives the agents its parts without a cast (S21-11's casts)", () => {
    type AgentsDoc = Parameters<MainParts["saved"]>[0];
    expectTypeOf<AgentsDoc>().toMatchTypeOf<OpenDoc>();
    expectTypeOf<OpenDoc>().toMatchTypeOf<AgentsDoc>();
  });
});
