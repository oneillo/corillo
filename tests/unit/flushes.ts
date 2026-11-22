// Counting flushes to disk (fsync) of one file, for tests that check a file
// is on the disk before it takes the old one's place.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

/** Count the flushes to disk of a file written whole (through its temporary copy beside it). */
export function countFlushes(file: string, except?: string) {
  const opened = new Map<number, string>();
  const result = { count: 0, stop: () => {} };
  const fsModule = fs as unknown as { openSync: typeof fs.openSync; fsyncSync: typeof fs.fsyncSync };
  const realOpen = fsModule.openSync;
  const realSync = fsModule.fsyncSync;
  fsModule.openSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    const fd = (realOpen as (...a: unknown[]) => number)(p, ...rest);
    opened.set(fd, String(p));
    return fd;
  }) as typeof fs.openSync;
  fsModule.fsyncSync = ((fd: number) => {
    const p = opened.get(fd);
    if (p?.startsWith(file) && !(except && p.startsWith(except))) result.count++;
    realSync(fd);
  }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  result.stop = () => {
    fsModule.openSync = realOpen;
    fsModule.fsyncSync = realSync;
    syncBuiltinESMExports();
  };
  return result;
}
