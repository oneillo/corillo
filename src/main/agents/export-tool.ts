// Exporting a document for an agent as a Word document or a PDF (export_document), from the file on disk, with the person's export settings.
import * as path from "node:path";
import type { AgentService } from "./agent-service";
import { NO_ANSWER } from "./limits-and-words";
import { AgentError, Later, type Call, type ExportKind } from "./shapes";

export async function exportDocument(this: AgentService, call: Call, args: Record<string, unknown>): Promise<Later> {
  const looked = this.look(call, args);
  const format = typeof args.format === "string" ? args.format.trim().toLowerCase() : "";
  const kind: ExportKind | null = format === "word" || format === "docx" ? "docx" : format === "pdf" ? "pdf" : null;
  if (!kind) throw new AgentError('Give format as "word" or "pdf".');
  const ext = `.${kind}`;
  const fileName = path.basename(looked.doc.filePath).replace(/\.[^.]+$/, "") + ext;
  const place = this.host.exportPlace?.(looked.doc, kind) ?? path.join(path.dirname(looked.doc.filePath), fileName);
  let target = place;
  const asked = typeof args.output_path === "string" ? args.output_path.trim() : "";
  if (asked) {
    if (!path.isAbsolute(asked)) throw new AgentError(`Give output_path as a full path, not ${asked}.`);
    target = path.normalize(asked);
    if (this.host.kindOf(target) === "folder") target = path.join(target, fileName);
    else if (path.extname(target).toLowerCase() !== ext) target += ext;
  }
  // The Word document a copy was made from holds what the copy left out: never written over, whatever the agent says.
  if (this.host.isMadeFrom?.(looked.doc, target)) {
    throw new AgentError(
      `${path.basename(target)} is the Word document ${looked.label} was made from, and Corillo never writes over it, even with replace. Leave out output_path to export to ${path.basename(place)} beside it, or give another.`,
    );
  }
  const there = this.host.kindOf(target);
  if (there === "folder") throw new AgentError(`${target} is a folder. Give a file name for the export.`);
  if (there === "file" && args.replace !== true) {
    throw new AgentError(
      `There's already a file at ${target}, so nothing was exported. To write over it, call export_document again with replace set to true; to keep it, give another output_path.`,
    );
  }
  // The export is of the file on disk, so the person's pending edits are saved first.
  const { flushed } = await this.latest(looked.doc);
  if (flushed === "conflict") {
    throw new AgentError(
      `${looked.label} was changed outside Corillo while the person had edits that weren't saved, and they haven't chosen which version to keep. Ask them to choose in Corillo, then export.`,
    );
  }
  if (flushed === "unsaved") {
    throw new AgentError(
      `Corillo can't save ${looked.label} right now (the file may have been moved, deleted or locked; Corillo shows why in its window), so an export might miss the person's latest edits. Ask them to sort it out in Corillo, then export.`,
    );
  }
  const { doc, label } = looked;
  const agentName = looked.member.name;
  const unsure = flushed === "no-answer" ? `\n\nNote: ${NO_ANSWER} If so, the export doesn't have them.` : "";
  return new Later(async () => {
    const result = await this.host.exportDocument(doc, kind, target, agentName);
    const what = kind === "docx" ? "a Word document" : "a PDF";
    const notes = result.notes.length ? `\n\n${result.notes.join("\n")}` : "";
    return `Exported ${label} as ${what}: ${result.outputPath}${notes}${unsure}\n\nThe person sees a notice in Corillo with Open and Show in Finder.`;
  });
}
