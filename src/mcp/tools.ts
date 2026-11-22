// Everything an agent reads about Corillo: the instructions it gets when it
// connects, and each tool's description. Written to be short, precise and hard
// to misread, and to work the same for any agent tool.
// package.json's version only: the build carries that one field into the connector.
import { version } from "../../package.json";

export const SERVER_NAME = "corillo";
/** Corillo's version, from package.json, so a new version is told to agents with nothing else to change. */
export const SERVER_VERSION: string = version;

export const INSTRUCTIONS = `Corillo is the person's Markdown editor. They review documents in it and leave comments for you, the way a colleague comments in Word, and you make changes through Corillo.

How a round of feedback works:
1. To get the person's review, open the document in Corillo (open_document, or create_document for a new draft), then tell them in the chat that it's ready. When you have something long for the person to read (a proposal, a plan, findings), put it in Corillo, not the chat, and wait there for their review.
2. They review in their own time. Don't look for comments until they tell you in the chat that there's feedback, or send it back from Corillo: after step 1 and step 6, call wait_for_review and end your turn. It wakes you with the document taken for your pass (skip step 3), or says at once if it can't wait in your app.
3. Then call take_document. It gives you every open comment addressed to you and the latest text, and holds the document so nobody else edits it meanwhile.
4. Address all those comments in this one pass: edit_document for changes, replace_document for a big rewrite. A comment that asks a question gets its answer in your reply; change the text for it only if asked. If a comment is unclear, ask your question in your reply instead of guessing. When a choice is the person's to make, make your best version and offer the others as options on your reply.
5. Once your edits have gone in and read well, reply on each comment with reply_to_comment, saying briefly what you changed.
6. Call finish_editing, with a note only for what they should know or decide that isn't on one comment. The document goes back to the person. They read your replies in Corillo, so in the chat a line is enough: that it's back, and anything they must decide.
When the person asks for a change in the chat instead, make it the same way: take_document, edit, finish_editing. Give their request, in their words, as request on take_document: they review the changes made for it in History.

Rules:
- Work only on what you were asked: the comments addressed to you, and the person's request from the chat. Change only the passages they're about and leave the rest of the document as it is. If a change elsewhere seems needed, suggest it in a reply or your note; don't make it.
- Tie every edit to the comments it answers with comment_ids (the ids take_document and list_comments show). The person reviews each change with its comment. Leave comment_ids out only for a change the person asked for in the chat.
- While a document is open in Corillo, read it with read_document and change it only with these tools, never with your own file tools: Corillo's history links each change to the feedback behind it. Always work from the latest text, which includes the person's edits, even unsaved; keep them.
- Only the person resolves comments: you can't edit, delete or resolve any comment.
- Comments are between you and the person. Don't reply to other agents. Comments you start (add_comment) go to the person.
- If the person takes a document back while you're editing, stop: don't take it again unless they ask.
- To answer questions about earlier versions, use list_versions and show_changes; you don't need to take the document for that.
- A custom agent with a role name (for example Writer) calls introduce with that name before anything else.

Corillo shows these well: headings, lists, links, tables, footnotes, code blocks, and Mermaid diagrams (a \`\`\`mermaid code block). Blank lines show and export as empty lines, so use exactly one between paragraphs unless the person wants more space. Pictures go in the folder "<document name> images" next to the document (for "Q3 plan.md", the folder "Q3 plan images"), linked by relative path, spaces written %20 so Obsidian shows it too: ![Chart](Q3%20plan%20images/chart.png). A picture at a web address waits for the person to show it. Notes written for Obsidian keep its syntax as it is: [[links]], ![[embeds]], ==highlights==, callouts (> [!note] Title), %%comments%% and #tags; don't escape or rewrite them.`;

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  _meta?: Record<string, unknown>;
}

/**
 * The tools a round uses (read_document for a long document's parts) load with the session in Claude Code, which
 * otherwise defers a connector's tools and spends a turn looking them up
 * (code.claude.com/docs/en/mcp, "Mark a tool to load upfront"). Other agent
 * tools ignore it.
 */
const UPFRONT = { "anthropic/alwaysLoad": true };

const PATH = { type: "string", description: "The document's full path, for example /Users/ana/Documents/Q3 plan.md." };

const FROM_CHARACTER = {
  type: "integer",
  minimum: 1,
  description: "With from_line, where in that line to start (1 is its first character). Only for a line too long to read at once: the answer that cuts it says where to read on.",
};

const COMMENT_IDS = {
  type: "array",
  items: { type: "string" },
  description:
    "The ids of the comments this change answers, as take_document and list_comments show them. Leave it out only for a change the person asked for in the chat.",
};

const REQUEST = {
  type: "string",
  description:
    "What the person asked for in the chat, in their words where you have them, when they asked for changes there rather than in comments. It's kept with this pass in History, where the person reviews your edits tied to no comment, under it.",
};

const schema = (properties: Record<string, unknown>, required: string[]): ToolSpec["inputSchema"] => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const TOOLS: ToolSpec[] = [
  {
    name: "introduce",
    title: "Introduce yourself",
    description:
      "Only for a custom agent with a role name (for example Writer). Call it once, before any other Corillo tool, so your comments and replies show under that name. Without it you're named after the agent tool you run in.",
    inputSchema: schema({ name: { type: "string", description: "Your role's name, for example Writer." } }, ["name"]),
    annotations: { openWorldHint: false, destructiveHint: false },
  },
  {
    name: "list_documents",
    title: "List open documents",
    description:
      "List the documents open in Corillo: each one's path, which one is in front, who is editing it, and how many open comments are waiting for you. Use it when the person mentions a document without giving its path, before looking for the file yourself.",
    inputSchema: schema({}, []),
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: UPFRONT,
  },
  {
    name: "open_document",
    title: "Open a document for review",
    description:
      "Open an existing Markdown file in Corillo so the person can review it. It opens in a background tab and never interrupts what they're doing. Afterwards, tell them in the chat that it's ready.",
    inputSchema: schema({ path: PATH }, ["path"]),
    annotations: { openWorldHint: false, destructiveHint: false },
  },
  {
    name: "create_document",
    title: "Create a document",
    description:
      "Create a new Markdown document with your text and open it in Corillo for the person to review. Use it for new drafts instead of writing the file yourself. It never overwrites an existing file.",
    inputSchema: schema(
      { path: { ...PATH, description: "Where to create it: a full path ending in .md." }, text: { type: "string", description: "The document's Markdown." } },
      ["path", "text"],
    ),
    annotations: { openWorldHint: false, destructiveHint: false },
  },
  {
    name: "read_document",
    title: "Read the latest text",
    description:
      "Get the latest Markdown of a document, including the person's own edits, even ones not yet saved. Your first read gives the whole text (for a long document, its outline with line numbers and its start). Later reads give only what changed since your last read, as a unified diff with line numbers, or say it's unchanged. Set whole to true to read it from the start again, or give from_line and to_line for just those lines.",
    inputSchema: schema(
      {
        path: PATH,
        whole: { type: "boolean", description: "True to read it from the start again even if you've read it before: the whole text, or for a long document its outline and start." },
        from_line: { type: "integer", minimum: 1, description: "The first line to read (line 1 is the first). For part of a long document." },
        to_line: { type: "integer", minimum: 1, description: "The last line to read. Leave it out to read on as far as one answer allows." },
        from_character: FROM_CHARACTER,
      },
      ["path"],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: UPFRONT,
  },
  {
    name: "list_comments",
    title: "List comments for you",
    description:
      "List the open comments on a document that are waiting for your answer: each with its id, the text it's on (or the whole document) and the conversation so far. Use it once the person has told you there's feedback, or during your pass to check for new comments. Set include_answered to true to also see comments you've already answered. Only the person resolves comments.",
    inputSchema: schema(
      {
        path: PATH,
        include_answered: { type: "boolean", description: "True to include comments you've already answered." },
      },
      ["path"],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "take_document",
    title: "Take the document to edit",
    description:
      "Start your editing pass. You hold the document: the person and other agents can still read and comment, but not edit, until you call finish_editing. Gives you every open comment addressed to you and the latest text (or what changed since your last read), and after an earlier round, what the person did since. Address all those comments in this one pass. For a document open in Corillo its name is enough; with no path, it takes the one document with comments waiting for you. If another agent is editing, Corillo waits up to 45 seconds for it to finish; if it hasn't, you're told who has it.",
    inputSchema: schema(
      {
        path: {
          type: "string",
          description: "The document's full path, or its name if it's open in Corillo (for example Q3 plan). Leave it out to take the one document with comments waiting for you.",
        },
        request: REQUEST,
      },
      [],
    ),
    annotations: { openWorldHint: false, destructiveHint: false },
    _meta: UPFRONT,
  },
  {
    name: "edit_document",
    title: "Edit the text",
    description:
      "Change the Markdown during your editing pass with exact find-and-replace edits. Each find must match the current text exactly once, character for character, Markdown marks and line breaks included; add nearby words to make it unique, or set all to change every match. The edits all apply together to the text as it was before this call, or none do. The result shows each change as it now reads. For a big rewrite use replace_document. Give comment_ids, the comments these edits answer, so the person can review each change with its comment; when the edits in one call answer different comments, give comment_ids on each edit instead.",
    inputSchema: schema(
      {
        path: PATH,
        edits: {
          type: "array",
          minItems: 1,
          description: "The changes, in any order. They must not overlap.",
          items: {
            type: "object",
            properties: {
              find: { type: "string", description: "Exact text now in the document." },
              replace: { type: "string", description: "What to put in its place (empty to delete it)." },
              all: { type: "boolean", description: "True to change every match, for example a name used throughout." },
              comment_ids: { ...COMMENT_IDS, description: "The comments this edit answers, when they differ from the call's comment_ids." },
            },
            required: ["find", "replace"],
            additionalProperties: false,
          },
        },
        comment_ids: COMMENT_IDS,
      },
      ["path", "edits"],
    ),
    annotations: { openWorldHint: false, destructiveHint: true },
    _meta: UPFRONT,
  },
  {
    name: "replace_document",
    title: "Replace the whole text",
    description:
      "Replace the whole Markdown during your editing pass, for a big rewrite, or bring back an earlier version with from_version instead of text. It works only if you've read the latest version first, so nobody's changes are lost. For smaller changes use edit_document. Give comment_ids, the comments the rewrite answers.",
    inputSchema: schema(
      {
        path: PATH,
        text: { type: "string", description: "The document's new Markdown, complete." },
        from_version: {
          type: "integer",
          minimum: 1,
          description: "Instead of text: the number of an earlier version (from list_versions) whose text becomes current.",
        },
        comment_ids: COMMENT_IDS,
      },
      ["path"],
    ),
    annotations: { openWorldHint: false, destructiveHint: true },
  },
  {
    name: "reply_to_comment",
    title: "Reply on a comment",
    description:
      "Reply on a comment addressed to you, or on one you started. After a change, say briefly what you changed. If the comment is unclear, ask your question here instead of guessing. You can't edit, delete or resolve comments; only the person resolves them.",
    inputSchema: schema(
      {
        path: PATH,
        comment_id: { type: "string", description: "The comment's id, as list_comments or take_document shows it." },
        text: { type: "string", description: "Your reply." },
        options: {
          type: "array",
          maxItems: 3,
          description: "Other versions the person can apply with one click, to the text as your edits left it.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "A few words." },
              edits: {
                type: "array",
                minItems: 1,
                maxItems: 10,
                description: "As in edit_document.",
                items: {
                  type: "object",
                  properties: { find: { type: "string" }, replace: { type: "string" } },
                  required: ["find", "replace"],
                  additionalProperties: false,
                },
              },
            },
            required: ["label", "edits"],
            additionalProperties: false,
          },
        },
      },
      ["path", "comment_id", "text"],
    ),
    annotations: { openWorldHint: false, destructiveHint: false },
    _meta: UPFRONT,
  },
  {
    name: "add_comment",
    title: "Start a comment",
    description:
      "Start a new comment for the person: on an exact quote from the document, or on the whole document if you leave quote out. Use it for a question or a note about specific text. It always goes to the person, never to other agents, and only the person resolves it.",
    inputSchema: schema(
      {
        path: PATH,
        text: { type: "string", description: "Your comment." },
        quote: {
          type: "string",
          description: "Words from the document, exactly as they read, that the comment is about. They must appear only once.",
        },
      },
      ["path", "text"],
    ),
    annotations: { openWorldHint: false, destructiveHint: false },
  },
  {
    name: "finish_editing",
    title: "Finish and hand back",
    description:
      "End your editing pass. The document goes back to the person, and the pass is kept as one version in its history, together with the comments you replied to and your note, if you give one. Reply on each comment first: if any is still waiting for you, it lists them and doesn't finish; call it again to leave them for your next pass.",
    inputSchema: schema(
      {
        path: PATH,
        request: { ...REQUEST, description: `${REQUEST.description} Give it here if you didn't with take_document.` },
        note: {
          type: "string",
          description:
            "What the person should know or decide about this pass that doesn't belong on one comment: for example a change you'd suggest outside what you were asked, or a choice only they can make. It waits for them at the top of their Comments panel and is kept with this version. Leave it out when your replies say it all.",
        },
      },
      ["path"],
    ),
    annotations: { openWorldHint: false, destructiveHint: false },
    _meta: UPFRONT,
  },
  {
    name: "wait_for_review",
    title: "Wait for the person's review",
    description:
      "Wait, at no cost, until the person sends one of your documents back to you from Corillo with their review. Call it after you open or create a document for their review, and after finish_editing; one wait covers every document you have open in Corillo. Once it has started, end your turn and do nothing else: you're woken with their comments, and the document is already taken for your editing pass. When it moves to the background, say in one line that you're waiting for their review in Corillo; don't sum up the document or your changes, they're there. If it ends without a review, say so once in the chat and don't call it again. Call it only from your main conversation, never from a subagent: it would hold up the work that started you.",
    inputSchema: schema(
      {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "The documents to wait for: full paths, or names of documents open in Corillo. Leave it out to wait for every document you have open there.",
        },
      },
      [],
    ),
    annotations: { openWorldHint: false, destructiveHint: false },
    _meta: UPFRONT,
  },
  {
    name: "list_versions",
    title: "List earlier versions",
    description:
      "List a document's version history, newest first: each version's number, who made it (the person, an agent, a change outside Corillo) and when, and for an agent's pass each comment it addressed in full (the words it was on and every message so far), any request from the chat, and what it changed. One editing pass is one version. Shows the newest 20 unless all is true.",
    inputSchema: schema({ path: PATH, all: { type: "boolean", description: "True to list every version." } }, ["path"]),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "read_version",
    title: "Read an earlier version",
    description:
      "Get the whole Markdown of one version from the history, by its number from list_versions (for a long document, its outline with line numbers and its start), or give from_line and to_line for just those lines. It doesn't change the document: to bring a whole version back, take the document and call replace_document with from_version; for part of it, edit it in.",
    inputSchema: schema(
      {
        path: PATH,
        version: { type: "integer", minimum: 1, description: "The version's number." },
        from_line: { type: "integer", minimum: 1, description: "The first line to read, in that version (line 1 is the first). For part of a long version." },
        to_line: { type: "integer", minimum: 1, description: "The last line to read. Leave it out to read on as far as one answer allows." },
        from_character: FROM_CHARACTER,
      },
      ["path", "version"],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "show_changes",
    title: "Show what a version changed",
    description:
      "Show what one version changed compared with the version before it, as the person sees with Show changes: only the changed passages, with removed words as [-text-] and added words as {+text+}. By default the newest version. Give compared_with to compare with another version instead, for example to see everything since your last pass.",
    inputSchema: schema(
      {
        path: PATH,
        version: { type: "integer", minimum: 1, description: "The version to show; the newest if left out." },
        compared_with: { type: "integer", minimum: 1, description: "Another version to compare it with, instead of the one before it." },
      },
      ["path"],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "export_document",
    title: "Export to Word or PDF",
    description:
      "Save a Word document or PDF of the latest text, the way the person's Export menu does, with the styling they chose for this document. By default it goes next to the document, with the same name (for a copy made from a Word document, a new name: that Word document is never written over). An existing file is never replaced unless you set replace to true. For Word, the person's own export script, if they set one, runs on the result.",
    inputSchema: schema(
      {
        path: PATH,
        format: { type: "string", enum: ["word", "pdf"], description: "word for a .docx Word document, pdf for a PDF." },
        output_path: { type: "string", description: "Where to save it: a full file path or a folder. Next to the document if left out." },
        replace: { type: "boolean", description: "True to write over a file already at that path." },
      },
      ["path", "format"],
    ),
    // It writes a file, can write over one (replace), and runs any export script the person set, which can do anything.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
