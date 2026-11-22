// The history's latest text is packed at zlib's quickest level, as the
// comments are (roadmap Batch 18, item 3, A16-4): about five times quicker on
// every save, for a file about 15% larger. A history packed at the old level
// reads as before, and one packed at the new level reads by the same code
// (any level unpacks the same way).
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { VersionHistory } from "../../src/main/version-store";

const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function aHistory() {
  const data = fs.mkdtempSync(path.join(tmpdir(), "corillo-packing-"));
  folders.push(data);
  const file = path.join(data, "plan.md");
  const first = "# Plan\n\nWe should hire two people this quarter.\n";
  fs.writeFileSync(file, first);
  const history = new VersionHistory(data);
  const id = history.idFor(file, first);
  history.seen(id, first);
  history.edited(id, first.replace("two", "three"));
  return { data, id, history, latest: path.join(data, "documents", id, "versions", "latest.json.gz") };
}

/** The gzip header's "extra flags" byte: 4 when zlib packed at its quickest level, 0 at its usual one, 2 at its smallest. */
const packedQuickest = (file: string) => fs.readFileSync(file)[8] === 4;

describe("the history's latest text on disk", () => {
  it("is packed at zlib's quickest level", () => {
    const { latest } = aHistory();
    expect(packedQuickest(latest)).toBe(true);
  });

  it("packed at the old (usual) level, still reads, and is packed quickly at the next save", () => {
    const { data, id, latest } = aHistory();
    // Pack today's record again at zlib's usual level, as builds before Batch 18 wrote it.
    fs.writeFileSync(latest, gzipSync(gunzipSync(fs.readFileSync(latest))));
    expect(packedQuickest(latest)).toBe(false);
    const again = new VersionHistory(data);
    expect(again.list(id).length).toBe(2);
    expect(again.text(id, 2)).toBe("# Plan\n\nWe should hire three people this quarter.\n");
    expect(again.text(id, 1)).toBe("# Plan\n\nWe should hire two people this quarter.\n");
    again.edited(id, "# Plan\n\nWe should hire four people this quarter.\n");
    expect(packedQuickest(latest)).toBe(true);
    expect(new VersionHistory(data).text(id, 2)).toBe("# Plan\n\nWe should hire four people this quarter.\n");
  });

  it("packed at the new level, reads by the same unpacking an older build uses", () => {
    const { latest } = aHistory();
    // An older build unpacks with gunzipSync and no options, as today's code does.
    const record = JSON.parse(gunzipSync(fs.readFileSync(latest)).toString("utf8")) as { text: string };
    expect(record.text).toBe("# Plan\n\nWe should hire three people this quarter.\n");
  });
});
