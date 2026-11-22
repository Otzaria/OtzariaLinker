import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { ExternalLinksReader } from "../../../src/database/otzaria/external-links-reader";
import { OtzariaDbReader } from "../../../src/database/otzaria/reader";
import type { ByteSource } from "../../../src/database/sqlite/lazy/byte-source";

/*
 * external_link of a real personal database (Personal-DB-Creator, e.g. "otzarya-unofficial-books" v52), read
 * through the lazy reader and cross-checked with SQLite. Runs only with the file (it is copyright-restricted and
 * never copied into the repo; opened read-only):
 *   OTZARIA_PERSONAL_DB=C:/Users/User/Documents/DEV/otzarya-unofficial-books-52.db npx vitest run tests/integration/database/external-links-real-db.local.test.ts
 */
const path = process.env.OTZARIA_PERSONAL_DB;
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
afterAll(() => void (path && closeSync(fd)));

describe.runIf(path)("external_link in a real personal database (read-only)", () => {
  it("the outgoing rows of the biggest books match SQLite; the internal scan matches too", async () => {
    const sql = new DatabaseSync(path!, { readOnly: true });
    const reader = await OtzariaDbReader.open(source!);
    const ext = (await ExternalLinksReader.open(reader.file, reader.caps))!;
    expect(ext.indexed).toBe(true);
    const top = sql.prepare("SELECT sourceBookId AS b, count(*) AS n FROM external_link GROUP BY sourceBookId ORDER BY n DESC LIMIT 3").all() as { b: number; n: number }[];
    for (const { b, n } of top) {
      const t0 = performance.now();
      const rows = await ext.outgoing(b);
      console.log(`outgoing of book ${b}: ${rows.length} rows in ${(performance.now() - t0).toFixed(0)} ms`);
      expect(rows).toHaveLength(n);
    }
    const libraryId = reader.caps.meta["library_id"]!;
    const titles = new Map((await reader.books()).map((b) => [b.title, b.id]));
    const t0 = performance.now();
    const internal = await ext.internal(libraryId, titles);
    console.log(`internal scan: ${internal.rowid.length} rows in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    const want = sql.prepare("SELECT count(*) AS n FROM external_link WHERE targetSource = ?").get(libraryId) as { n: number };
    expect(internal.rowid.length + internal.skipped).toBeLessThanOrEqual(want.n);
    expect(internal.rowid.length).toBe(want.n); // every internal row names a book of the database (audit: 180 of 180 titles)
    sql.close();
  }, 600_000);
});
