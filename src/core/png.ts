// Small helpers for PNG pictures and zip files: a CRC-32 checksum (both
// formats use it), and stamping a PNG with its resolution, so a diagram drawn
// at print resolution shows at its intended size in Word rather than three
// times too big.

let table: Uint32Array | null = null;

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const INCH = 0.0254;

function isPng(png: Uint8Array): boolean {
  return png.length > 33 && SIGNATURE.every((b, i) => png[i] === b);
}

interface Chunk {
  type: string;
  start: number;
  end: number;
}

function chunks(png: Uint8Array): Chunk[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const list: Chunk[] = [];
  for (let at = 8; at + 12 <= png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const end = at + 12 + length;
    list.push({ type, start: at, end });
    if (type === "IEND") break;
    at = end;
  }
  return list;
}

/** The PNG with its resolution set to this many dots per inch. */
export function withResolution(png: Uint8Array, dpi: number): Uint8Array {
  if (!isPng(png)) throw new Error("Not a PNG picture.");
  const perMetre = Math.round(dpi / INCH);
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  view.setUint32(8, perMetre);
  view.setUint32(12, perMetre);
  chunk[16] = 1; // the unit is the metre
  view.setUint32(17, crc32(chunk, 4, 17));
  const list = chunks(png);
  const header = list.find((c) => c.type === "IHDR");
  if (!header) throw new Error("Not a PNG picture.");
  const parts: Uint8Array[] = [png.subarray(0, header.end), chunk];
  // Keep everything else, except an earlier resolution.
  for (const c of list) if (c !== header && c.type !== "pHYs") parts.push(png.subarray(c.start, c.end));
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A PNG's size in pixels and resolution in dots per inch (null if it doesn't say). */
export function pngInfo(png: Uint8Array): { width: number; height: number; dpi: number | null } {
  if (!isPng(png)) throw new Error("Not a PNG picture.");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const phys = chunks(png).find((c) => c.type === "pHYs");
  const dpi = phys && png[phys.start + 16] === 1 ? Math.round(view.getUint32(phys.start + 8) * INCH) : null;
  return { width: view.getUint32(16), height: view.getUint32(20), dpi };
}
