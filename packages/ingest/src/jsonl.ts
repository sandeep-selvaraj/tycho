import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export interface JsonlChunk {
  /** Complete physical lines, including blanks, so adapters can track ordinals. */
  lines: string[];
  /** Byte offset just past the last complete line; resume from here. */
  nextOffset: number;
  /** True when the file shrank below the stored offset and was re-read from 0. */
  reset: boolean;
}

const CHUNK = 1 << 20;

/**
 * Read complete lines from `offset` to EOF. A trailing line without `\n` is left for the next read,
 * so a harness that is mid-write never produces a half record.
 */
export function readJsonl(file: string, offset: number, maxBytes = 64 * CHUNK): JsonlChunk {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const reset = size < offset;
    let pos = reset ? 0 : offset;
    const end = Math.min(size, pos + maxBytes);
    const parts: Buffer[] = [];
    while (pos < end) {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, end - pos));
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) break;
      parts.push(buf.subarray(0, n));
      pos += n;
    }
    const data = Buffer.concat(parts);
    const lastNl = data.lastIndexOf(0x0a);
    const start = reset ? 0 : offset;
    if (lastNl < 0) return { lines: [], nextOffset: start, reset };
    const lines = data.subarray(0, lastNl).toString('utf8').split('\n');
    return { lines, nextOffset: start + lastNl + 1, reset };
  } finally {
    closeSync(fd);
  }
}
