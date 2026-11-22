// Writes a zip file, which is what a Word document is underneath. Only what
// Corillo needs: a handful of small files, compressed, with fixed dates so
// the same input always makes the same bytes. And reads one file back out of
// a zip (the page size of a Word document whose styles the person chose), or
// a few out of a zip on disk without reading the rest (what a Word document
// the person opens holds: its comments and tracked changes).
import * as fs from "node:fs";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { crc32 } from "../core/png";

export interface ZipEntry {
  name: string;
  data: string | Uint8Array;
}

// 1 January 1980, the earliest date a zip file can hold.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UTF8_NAMES = 0x0800;

export function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : Buffer.from(entry.data);
    const packed = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** More than any Word document's own text holds; a file that unpacks to more is made to fill the memory. */
const MOST_UNPACKED = 64 * 1024 * 1024;

/** One file from inside a zip, or null if it isn't there, the zip can't be read, or it unpacks to more than `most` bytes. */
export function readZipEntry(zip: Uint8Array, wanted: string, most = MOST_UNPACKED): Buffer | null {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end record is in the last 64 KB (after an optional comment).
  let end = -1;
  for (let at = buf.length - 22; at >= Math.max(0, buf.length - 65557); at--) {
    if (buf.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) return null;
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  try {
    for (let i = 0; i < count; i++) {
      if (buf.readUInt32LE(at) !== 0x02014b50) return null;
      const method = buf.readUInt16LE(at + 10);
      const packedSize = buf.readUInt32LE(at + 20);
      const nameLength = buf.readUInt16LE(at + 28);
      const extraLength = buf.readUInt16LE(at + 30);
      const commentLength = buf.readUInt16LE(at + 32);
      const local = buf.readUInt32LE(at + 42);
      const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
      at += 46 + nameLength + extraLength + commentLength;
      if (name !== wanted) continue;
      const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const packed = buf.subarray(dataAt, dataAt + packedSize);
      if (method === 0) return packed.length > most ? null : Buffer.from(packed);
      if (method === 8) return inflateRawSync(packed, { maxOutputLength: most });
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

export interface ZipFileReading {
  /** The most bytes all the files read may unpack to together; a file that would go past it is left out (as too big). */
  total?: number;
  /** Filled in with the wanted files left out for unpacking to more than allowed. */
  tooBig?: string[];
}

/**
 * Some files from inside a zip on disk, reading only the zip's list of files
 * and those files: a Word document full of pictures can be a few hundred MB.
 * `wanted` names them, or says yes to each name. A file that isn't there,
 * can't be read or unpacks to more than `most` bytes (or than what's left of
 * `total`) is left out.
 */
export function readZipFileEntries(
  file: string,
  wanted: string[] | ((name: string) => boolean),
  most = MOST_UNPACKED,
  reading: ZipFileReading = {},
): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  const isWanted = typeof wanted === "function" ? wanted : (name: string) => wanted.includes(name);
  const enough = () => typeof wanted !== "function" && found.size >= wanted.length;
  let room = reading.total ?? Infinity;
  const tooBig = (name: string) => reading.tooBig?.push(name);
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return found;
  }
  const read = (length: number, at: number) => {
    const buf = Buffer.alloc(length);
    return buf.subarray(0, fs.readSync(fd, buf, 0, length, at));
  };
  try {
    const size = fs.fstatSync(fd).size;
    // The end record is in the last 64 KB (after an optional comment).
    const tailAt = Math.max(0, size - 65557);
    const tail = read(size - tailAt, tailAt);
    let end = -1;
    for (let at = tail.length - 22; at >= 0; at--) {
      if (tail.readUInt32LE(at) === 0x06054b50) {
        end = at;
        break;
      }
    }
    if (end < 0) return found;
    const count = tail.readUInt16LE(end + 10);
    const listSize = tail.readUInt32LE(end + 12);
    const listAt = tail.readUInt32LE(end + 16);
    if (listAt + listSize > size || listSize > most) return found;
    const list = read(listSize, listAt);
    let at = 0;
    for (let i = 0; i < count && at + 46 <= list.length && !enough(); i++) {
      if (list.readUInt32LE(at) !== 0x02014b50) break;
      const method = list.readUInt16LE(at + 10);
      const packedSize = list.readUInt32LE(at + 20);
      const size = list.readUInt32LE(at + 24);
      const nameLength = list.readUInt16LE(at + 28);
      const local = list.readUInt32LE(at + 42);
      const name = list.toString("utf8", at + 46, at + 46 + nameLength);
      at += 46 + nameLength + list.readUInt16LE(at + 30) + list.readUInt16LE(at + 32);
      if (!isWanted(name) || found.has(name) || (method !== 0 && method !== 8)) continue;
      const allowed = Math.min(most, room);
      // Too big by what the zip says, or by what it holds when unpacked (a zip can say less than it holds).
      if (size > allowed || (method === 0 && packedSize > allowed)) {
        tooBig(name);
        continue;
      }
      if (packedSize > most) continue;
      const head = read(30, local);
      if (head.length < 30 || head.readUInt32LE(0) !== 0x04034b50) continue;
      const packed = read(packedSize, local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28));
      try {
        const data = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: allowed });
        found.set(name, data);
        room -= data.length;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") tooBig(name);
        // otherwise damaged: left out
      }
    }
  } catch {
    // not a zip Corillo can read: what was found so far
  } finally {
    fs.closeSync(fd);
  }
  return found;
}
