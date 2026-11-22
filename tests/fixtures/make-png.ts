// For tests: a plain grey PNG picture of any size, saying how many dots per
// inch it was made at when asked (as a Mac screenshot says 144).
import { deflateSync } from "node:zlib";
import { crc32, withResolution } from "../../src/core/png";

export function makePng(width: number, height: number, dpi?: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set([...type].map((c) => c.charCodeAt(0)), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
    return out;
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 0, 0, 0, 0], 8); // 8-bit grey
  const rows = new Uint8Array((width + 1) * height).fill(180);
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return dpi ? withResolution(out, dpi) : out;
}
