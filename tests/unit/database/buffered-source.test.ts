import { describe, expect, it } from "vitest";
import { bufferedSource, bytesSource, type ByteSource } from "../../../src/database/sqlite/lazy/byte-source";

/* The read-ahead source used by the generic-database reader: same bytes as the source, fewer reads. */
describe("bufferedSource", () => {
  const data = Uint8Array.from({ length: 10_000 }, (_, i) => (i * 31) & 255);
  const counting = (): ByteSource & { reads: number } => {
    const inner = bytesSource(data);
    const s = { size: inner.size, reads: 0, read: (o: number, l: number) => (s.reads++, inner.read(o, l)) };
    return s;
  };

  it("returns exactly the requested bytes, inside a chunk, across chunks and at the end of the file", async () => {
    const b = bufferedSource(counting(), 1024, 4);
    for (const [o, l] of [[0, 100], [1000, 100], [1020, 3000], [9_990, 50], [5_000, 0], [4096, 1024]] as const)
      expect(Array.from(await b.read(o, l))).toEqual(Array.from(data.subarray(o, Math.min(o + l, data.length))));
  });

  it("reads each chunk once while it stays cached, and returns copies (a cached page must not pin a chunk)", async () => {
    const src = counting();
    const b = bufferedSource(src, 1024, 4);
    for (let o = 0; o < 4096; o += 512) await b.read(o, 512);
    expect(src.reads).toBe(4);
    const page = await b.read(0, 512);
    expect(page.buffer.byteLength).toBe(512);
    expect(src.reads).toBe(4); // chunk 0 is now the most recently used
    await b.read(8192, 512); // a fifth chunk evicts the least recently used: chunk 1
    await b.read(1024, 512);
    expect(src.reads).toBe(6);
  });
});
