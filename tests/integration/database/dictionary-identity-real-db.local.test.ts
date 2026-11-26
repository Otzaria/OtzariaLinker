import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { DictionaryPool, LineContentCodec, OFFICIAL_DICTIONARY_SHA256, dictionaryFingerprint, sharedDictionaries } from "../../../src/database/compression/zstd";
import { OtzariaDbReader } from "../../../src/database/otzaria/reader";
import type { ByteSource } from "../../../src/database/sqlite/lazy/byte-source";

/*
 * B19 (issue #41) on the real official database: its dictionary is the pinned official one, and line text decoded
 * with it — owned, or lent to a database that lacks it — matches an independent decoder (Node's libzstd) byte for
 * byte; a different dictionary with the same dictID is never lent. Read-only ("r"), never written or copied:
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db npx vitest run tests/integration/database/dictionary-identity-real-db.local.test.ts
 * Not covered here: the v52 personal database itself (its own 112,640-byte dictionary with dictID 32768) is not on the
 * machine where this was written; dictionary-collision-real-db.local.test.ts covers the pair when both files exist.
 */
const path = process.env.OTZARIA_DB;
const fd = path ? openSync(path, "r") : -1;
const source: ByteSource | null = path
  ? {
      size: fstatSync(fd).size,
      async read(offset, length) {
        const buf = new Uint8Array(length);
        return buf.subarray(0, readSync(fd, buf, 0, length, offset));
      },
    }
  : null;
afterAll(() => {
  if (path) closeSync(fd);
});

describe.runIf(path)("dictionary identity on the real seforim.db (read-only)", () => {
  it("the official dictionary is pinned, lent only while open, and decodes like libzstd", { timeout: 300_000 }, async () => {
    const reader = await OtzariaDbReader.open(source!, "seforim.db");
    try {
      let dict: Uint8Array | undefined;
      for await (const r of reader.file.scan((await reader.file.table("zstd_dict"))!)) dict = r.values[1] as Uint8Array;
      expect(dictionaryFingerprint(dict!)).toBe(OFFICIAL_DICTIONARY_SHA256);
      expect(sharedDictionaries.lend(32768)?.sha256).toBe(OFFICIAL_DICTIONARY_SHA256);

      // 400 frames from four places in the table (line ids are sparse: 1…10.5M)
      const content = (await reader.file.table("line_content"))!;
      const frames: Uint8Array[] = [];
      for (const from of [1, 2_500_000, 5_000_000, 9_000_000]) {
        let n = 0;
        for await (const r of reader.file.scan(content, { from })) {
          const v = r.values.find((x) => x instanceof Uint8Array);
          if (v instanceof Uint8Array) frames.push(v);
          if (++n >= 100) break;
        }
      }
      expect(frames.length).toBeGreaterThanOrEqual(350);

      const own = new LineContentCodec([dict!], new DictionaryPool());
      const borrower = new LineContentCodec([]); // a personal database without the dictionary, on the worker's pool
      for (const f of frames) {
        const reference = zstdDecompressSync(f, { dictionary: dict } as never).toString("utf8");
        expect(own.decode(f)).toBe(reference);
        expect(borrower.decode(f)).toBe(reference);
      }

      // a different dictionary with the same id, brought by another database, is never lent
      const other = dict!.slice();
      for (let i = other.length - 200_000; i < other.length; i++) other[i] = other[i]! ^ 0x5a;
      const pool = new DictionaryPool();
      new LineContentCodec([other], pool, "v52.db");
      const lonely = new LineContentCodec([], pool);
      for (const f of frames) expect(() => lonely.decode(f)).toThrow(expect.objectContaining({ code: "db/compressed-unknown-dictionary" }));
      console.log(`${frames.length} real frames: own and lent decoding match libzstd; a same-id foreign dictionary is refused`);
    } finally {
      reader.close();
    }
    expect(sharedDictionaries.lend(32768)).toBeUndefined();
  });
});
