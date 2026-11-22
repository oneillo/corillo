// What the packaging and fetching scripts share (scripts/script-tools.mjs):
// reading an option, and fetching a file only if its SHA-256 is the pinned
// one. The fetches go to a server on this Mac, never out.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error: a plain JavaScript script, with no types of its own
import { ChecksumMismatch, fetchChecked, option } from "../../scripts/script-tools.mjs";

describe("option", () => {
  it("reads --name=value, and nothing when it isn't given", () => {
    expect(option(["--arch=x64", "--without-pandoc"], "arch")).toBe("x64");
    expect(option(["--commit=abc1234"], "commit")).toBe("abc1234");
    expect(option(["--without-pandoc"], "arch")).toBeUndefined();
    expect(option(["--architecture=x64"], "arch")).toBeUndefined();
  });

  it("refuses --name value, with a space, rather than reading no option", () => {
    expect(() => option(["--arch", "x64"], "arch")).toThrow("Give --arch with an equals sign.");
  });
});

describe("fetchChecked", () => {
  const body = Buffer.from("the program, as published\n".repeat(5000));
  const sha = createHash("sha256").update(body).digest("hex");
  let server: Server;
  let base = "";
  let dir = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "corillo-fetch-checked-"));
    server = createServer((req, res) => {
      if (req.url === "/file") res.end(body);
      else {
        res.statusCode = 404;
        res.end("no");
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise((done) => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  });

  it("puts the file in place when its SHA-256 is the pinned one, leaving no part behind", async () => {
    const target = join(dir, "ok", "program");
    const underWay = new Set<string>();
    await fetchChecked(`${base}/file`, sha, target, { underWay });
    expect(readFileSync(target).equals(body)).toBe(true);
    expect(readdirSync(join(dir, "ok"))).toEqual(["program"]);
    expect(underWay.size).toBe(0);
  });

  it("refuses a file whose SHA-256 isn't the pinned one, and leaves nothing", async () => {
    const target = join(dir, "bad", "program");
    const part = `${target}.part`;
    await expect(fetchChecked(`${base}/file`, "0".repeat(64), target, { part })).rejects.toBeInstanceOf(ChecksumMismatch);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(part)).toBe(false);
  });

  it("fails when the server has no such file, and writes nothing", async () => {
    const target = join(dir, "missing", "program");
    await expect(fetchChecked(`${base}/nothing`, sha, target)).rejects.toThrow("Download failed (404");
    expect(existsSync(join(dir, "missing"))).toBe(false);
  });
});
