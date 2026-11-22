// A server of pictures on 127.0.0.1, for the tests of web pictures that wait
// (roadmap Batch 19). Nothing leaves this Mac: the picture is served over
// HTTPS from 127.0.0.1, with a certificate made for the run, which the app is
// told to accept for 127.0.0.1 only. The server counts every connection, so a
// picture asked for at all is seen, and keeps the headers each request came
// with. The one server for every test of web pictures (G21-16).
import type { ElectronApplication } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePng } from "../fixtures/make-png";

/** A request the server heard: its path, and the headers it came with. */
export interface Heard {
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

/** A picture server on 127.0.0.1 over HTTPS: the paths asked for, each request with its headers, and every connection made. */
export async function pictureServer(): Promise<{
  origin: string;
  port: number;
  asked: string[];
  heard: Heard[];
  connections: () => number;
  close: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "corillo-cert-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  try {
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
      { stdio: "ignore" },
    );
    const png = makePng(40, 30);
    const asked: string[] = [];
    const heard: Heard[] = [];
    const server: Server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      asked.push(req.url ?? "");
      heard.push({ path: req.url ?? "", headers: { ...req.headers } });
      // A site that would like to remember the person.
      res.writeHead(200, { "Content-Type": "image/png", "Set-Cookie": "seen=yes; Path=/; Max-Age=86400; Secure; SameSite=None", "Cache-Control": "no-store" });
      res.end(png);
    });
    // Any connection at all, even one that never became a request (plain http to this port, say).
    let connections = 0;
    server.on("connection", () => connections++);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      origin: `https://127.0.0.1:${port}`,
      port,
      asked,
      heard,
      connections: () => connections,
      close: () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The app accepts this run's certificate, for 127.0.0.1 only. */
export function trustLocalServer(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ session }) => {
    session.defaultSession.setCertificateVerifyProc((request, callback) => callback(request.hostname === "127.0.0.1" ? 0 : -3));
  });
}
