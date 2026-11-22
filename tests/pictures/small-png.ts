// Help's pictures as small files: a screenshot's colours brought down to at
// most 256 (median cut, no dithering, so text and flat colours stay crisp)
// and saved as a palette PNG at zlib's best compression. Nothing to install:
// Node's own zlib does the packing.
import { crc32, deflateSync, inflateSync } from "node:zlib";

/** A screenshot (8-bit RGB or RGBA, as Chromium writes them) as a smaller palette PNG, of at most this many colours. */
export function smallPng(png: Buffer, colours = 256): Buffer {
  const { width, height, rgb } = decode(png);
  const { palette, indexOf } = quantize(rgb, colours);
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (width + 1)] = 0; // no filter: best for palette pictures
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      rows[y * (width + 1) + 1 + x] = indexOf.get((rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2])!;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 3, 0, 0, 0], 8); // 8 bits, palette, no interlace
  const plte = Buffer.alloc(palette.length * 3);
  palette.forEach((c, i) => plte.set([c >> 16, (c >> 8) & 255, c & 255], i * 3));
  return Buffer.concat([
    png.subarray(0, 8),
    chunk("IHDR", header),
    chunk("PLTE", plte),
    chunk("IDAT", deflateSync(rows, { level: 9, memLevel: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function decode(png: Buffer): { width: number; height: number; rgb: Uint8Array } {
  let header: Buffer | null = null;
  const data: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    if (type === "IHDR") header = png.subarray(at + 8, at + 8 + length);
    if (type === "IDAT") data.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  if (!header || header[8] !== 8 || (header[9] !== 2 && header[9] !== 6) || header[12] !== 0) throw new Error("Not a plain 8-bit RGB screenshot");
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bpp = header[9] === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(data));
  const pixels = new Uint8Array(stride * height);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? pixels[y * stride + i - bpp] : 0;
      const b = y ? pixels[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y ? pixels[(y - 1) * stride + i - bpp] : 0;
      const guess = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
      pixels[y * stride + i] = (raw[y * (stride + 1) + 1 + i] + guess) & 255;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let p = 0; p < width * height; p++) rgb.set(pixels.subarray(p * bpp, p * bpp + 3), p * 3);
  return { width, height, rgb };
}

/** At most this many colours to stand for all of these, and which one stands for each. */
function quantize(rgb: Uint8Array, most: number): { palette: number[]; indexOf: Map<number, number> } {
  const counts = new Map<number, number>();
  for (let i = 0; i < rgb.length; i += 3) {
    const c = (rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2];
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const colours = [...counts.keys()];
  const channel = (c: number, k: number) => (c >> (16 - 8 * k)) & 255;
  // Median cut: keep splitting the box with the most pixels spread over the widest range.
  let boxes = [colours];
  const weight = (box: number[]) => box.reduce((n, c) => n + counts.get(c)!, 0);
  const widest = (box: number[]) => {
    let best = { k: 0, range: -1 };
    for (let k = 0; k < 3; k++) {
      const values = box.map((c) => channel(c, k));
      const range = Math.max(...values) - Math.min(...values);
      if (range > best.range) best = { k, range };
    }
    return best;
  };
  while (boxes.length < most) {
    let pick = -1;
    let score = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      const s = widest(box).range * Math.sqrt(weight(box));
      if (s > score) [pick, score] = [i, s];
    });
    if (pick < 0) break;
    const box = boxes[pick];
    const { k } = widest(box);
    box.sort((x, y) => channel(x, k) - channel(y, k));
    const half = weight(box) / 2;
    let split = 1;
    for (let sum = counts.get(box[0])!; split < box.length - 1 && sum + counts.get(box[split])! <= half; split++) sum += counts.get(box[split])!;
    boxes = [...boxes.slice(0, pick), box.slice(0, split), box.slice(split), ...boxes.slice(pick + 1)];
  }
  // Each box's colour: its most common one when that's most of it (a flat background stays exact), else the average.
  const palette = boxes.map((box) => {
    const total = weight(box);
    const common = box.reduce((a, b) => (counts.get(b)! > counts.get(a)! ? b : a));
    if (counts.get(common)! * 2 >= total) return common;
    const mean = [0, 1, 2].map((k) => Math.round(box.reduce((n, c) => n + channel(c, k) * counts.get(c)!, 0) / total));
    return (mean[0] << 16) | (mean[1] << 8) | mean[2];
  });
  const indexOf = new Map<number, number>();
  for (const c of colours) {
    let best = 0;
    let bestDistance = Infinity;
    palette.forEach((p, i) => {
      const d = (channel(c, 0) - channel(p, 0)) ** 2 + (channel(c, 1) - channel(p, 1)) ** 2 + (channel(c, 2) - channel(p, 2)) ** 2;
      if (d < bestDistance) [best, bestDistance] = [i, d];
    });
    indexOf.set(c, best);
  }
  return { palette, indexOf };
}
