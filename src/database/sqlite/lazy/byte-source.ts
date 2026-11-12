/**
 * Random-access bytes of a database file. A `File` is read with `slice()`, so a multi-GB
 * seforim.db is never loaded whole — only the pages a query touches (works inside a Worker).
 */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    async read(offset, length) {
      return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    },
  };
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    async read(offset, length) {
      return bytes.subarray(offset, Math.min(offset + length, bytes.length));
    },
  };
}

/**
 * Reads ahead in large chunks and keeps the last few (LRU). In a browser every Blob.slice read is an
 * async round trip (~0.5 ms), so a full scan that reads 40,000 pages one by one took 26 s for a
 * 163 MB file; reading 256 KiB at a time makes the same scan CPU-bound. Meant for sources that are
 * scanned (the generic-database reader), not for the random seeks into a multi-GB seforim.db.
 */
export function bufferedSource(src: ByteSource, chunk = 256 * 1024, maxChunks = 64): ByteSource {
  const chunks = new Map<number, Promise<Uint8Array>>();
  const get = (no: number): Promise<Uint8Array> => {
    let p = chunks.get(no);
    if (p) chunks.delete(no);
    else {
      p = src.read(no * chunk, Math.min(chunk, src.size - no * chunk));
      p.catch(() => chunks.delete(no));
    }
    chunks.set(no, p);
    while (chunks.size > maxChunks) chunks.delete(chunks.keys().next().value as number);
    return p;
  };
  return {
    size: src.size,
    async read(offset, length) {
      const end = Math.min(offset + length, src.size);
      const first = Math.floor(offset / chunk);
      const last = Math.floor(Math.max(end - 1, offset) / chunk);
      if (first === last) {
        const c = await get(first);
        // a copy: a page kept in the SqliteFile cache must not pin its whole chunk
        return c.slice(offset - first * chunk, end - first * chunk);
      }
      const out = new Uint8Array(Math.max(0, end - offset));
      for (let no = first; no <= last; no++) {
        const c = await get(no);
        const from = Math.max(offset, no * chunk);
        const to = Math.min(end, (no + 1) * chunk);
        out.set(c.subarray(from - no * chunk, to - no * chunk), from - offset);
      }
      return out;
    },
  };
}
