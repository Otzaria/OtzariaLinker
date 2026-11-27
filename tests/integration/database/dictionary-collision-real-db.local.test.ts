import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { OFFICIAL_DICTIONARY_SHA256, sharedDictionaries } from "../../../src/database/compression/zstd";
import type { ByteSource } from "../../../src/database/sqlite/lazy/byte-source";
import { DbBookSource } from "../../../src/sources/db/db-source";

/*
 * Two different zstd dictionaries with the SAME dictID 32768: the personal database v52 carries its own (112,640 B)
 * and the official seforim.db has the Sefaria-trained one (2,097,152 B) (docs/research/PERSONAL_DB_V52_AUDIT.md §7).
 * Each database must be read with ITS OWN dictionary (LineContentCodec: a database's dictionaries win over the shared
 * pool, which marks the id "conflict"). Runs only with both files (read-only, never copied into the repo):
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db OTZARIA_PERSONAL_DB=C:/Users/User/Documents/DEV/otzarya-unofficial-books-52.db \
 *     npx vitest run tests/integration/database/dictionary-collision-real-db.local.test.ts
 */
const official = process.env.OTZARIA_DB;
const personal = process.env.OTZARIA_PERSONAL_DB;
const fds: number[] = [];
const source = (path: string): ByteSource => {
  const fd = openSync(path, "r");
  fds.push(fd);
  return {
    size: fstatSync(fd).size,
    async read(offset, length) {
      const buf = new Uint8Array(length);
      return buf.subarray(0, readSync(fd, buf, 0, length, offset));
    },
  };
};
afterAll(() => fds.forEach((fd) => closeSync(fd)));

describe.runIf(official && personal)("dictID 32768 in two open databases", () => {
  it("reads lines of several books from each, in either order of opening", { timeout: 300_000 }, async () => {
    for (const order of [["official", "personal"], ["personal", "official"]] as const) {
      const opened = new Map<string, DbBookSource>();
      for (const [i, which] of order.entries()) opened.set(which, await DbBookSource.open(`s${i + 1}`, which === "official" ? "seforim.db" : "personal.db", source(which === "official" ? official! : personal!)));
      // both dictionaries are in the shared pool now; only the official one may be lent to a database that lacks
      // one (B19: v52's own dictionary shares the dictID, not the identity), and each database decodes with its own
      expect(sharedDictionaries.isConflicted(32768)).toBe(false);
      expect(sharedDictionaries.lend(32768)?.sha256).toBe(OFFICIAL_DICTIONARY_SHA256);
      expect(sharedDictionaries.unlendableOrigins(32768)).toEqual(["personal.db"]);
      for (const [which, src] of opened) {
        let read = 0;
        for (const b of (await src.books()).slice(0, 60)) {
          const lines = await src.lines(b.key, 0, 4);
          if (lines.length && lines.every((l) => l.text.length > 0)) read++;
          if (read >= 3) break;
        }
        console.log(`${which}: ${read} books read (order ${order.join(" then ")})`);
        expect(read, which).toBeGreaterThanOrEqual(3);
      }
      // closed, both give their dictionaries back: the next order starts from an empty pool
      for (const src of opened.values()) src.close();
      expect(sharedDictionaries.lend(32768)).toBeUndefined();
      expect(sharedDictionaries.unlendableOrigins(32768)).toEqual([]);
    }
  });
});
