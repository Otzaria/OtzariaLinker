import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ExternalLinksReader } from "../../../src/database/otzaria/external-links-reader";
import { OtzariaDbReader } from "../../../src/database/otzaria/reader";
import { blobSource } from "../../../src/database/sqlite/lazy/byte-source";
import { SqliteFile } from "../../../src/database/sqlite/lazy/sqlite-file";
import { DbBookSource } from "../../../src/sources/db/db-source";

/*
 * Fix round before merge (task 4a, 4b). The tool walks a book in chunks of 200 lines (state/lines.ts CHUNK), so what ONE chunk
 * costs is multiplied by the number of chunks. Measured on the real files (tests/integration/database/fix-round-measure.local.test.ts):
 *   (a) the library's biggest book (190,453 lines): every existingLinks chunk walked the book's whole line index again
 *       (463 ms), 437 ms per chunk, 953 chunks = about 7 minutes for a walk;
 *   (b) v52, the biggest book (119,385 links): a range of 400 lines or more read the whole book's rows and filtered them
 *       (379 ms per call) where 399 lines took 4 ms by seeks, so a walk in pieces of 1000 lines cost 13 s instead of under 1.
 * These tests pin the structure of the fix on the real small fixtures: the line index of a book is read once, and a wide range
 * seeks. The numbers are in docs/reviews/QA_V6_PR1.md.
 */
const LIB = () => blobSource(new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]));
const PDC = () => blobSource(new Blob([readFileSync("tests/fixtures/db/pdc-personal-mini.db")]));
const lineIndexWalks = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => (c[0] as { name: string }).name === "idx_line_book_index").length;

describe("the line index of a book is read once, not once per chunk", () => {
  it("existingLinks, lines and the rest of a walk share one read of the book's line entries", async () => {
    const seek = vi.spyOn(SqliteFile.prototype, "seekIndex");
    try {
      const src = await DbBookSource.open("s1", "seforim.db", LIB());
      const book = (await src.books()).find((b) => b.title !== undefined && (b.lineCount ?? 0) >= 200)!;
      seek.mockClear();
      const a = await src.existingLinks(book.key, 0, 99);
      await src.existingLinks(book.key, 100, 199);
      await src.existingLinks(book.key, 0, 199);
      await src.lines(book.key, 0, 49);
      await src.lines(book.key, 50, 99);
      expect(lineIndexWalks(seek)).toBe(1);
      expect(a.length).toBeGreaterThanOrEqual(0);
      // another book is another read
      const other = (await src.books()).find((b) => b.key !== book.key && (b.lineCount ?? 0) > 0)!;
      await src.existingLinks(other.key, 0, 99);
      expect(lineIndexWalks(seek)).toBe(2);
    } finally {
      seek.mockRestore();
    }
  });

  it("the answers are the same as without the cache (the book's links per chunk add up to the whole)", async () => {
    const src = await DbBookSource.open("s1", "seforim.db", LIB());
    const book = (await src.books()).find((b) => (b.lineCount ?? 0) >= 200)!;
    const whole = await src.existingLinks(book.key, 0, Number.MAX_SAFE_INTEGER);
    const pieces: string[] = [];
    for (let from = 0; from < (book.lineCount ?? 0); from += 50) for (const l of await src.existingLinks(book.key, from, from + 49)) pieces.push(l.id);
    expect([...new Set(pieces)].sort()).toEqual([...new Set(whole.map((l) => l.id))].sort());
  });
});

describe("a wide range of external_link seeks instead of reading the whole book", () => {
  async function ext() {
    const reader = await OtzariaDbReader.open(PDC());
    return (await ExternalLinksReader.open(reader.file, reader.caps))!;
  }

  it("1000 lines are found by seeks (no walk of the book's rows), with the same rows as reading the book", async () => {
    const seek = vi.spyOn(SqliteFile.prototype, "seekIndex");
    try {
      const r = await ext();
      const want = (await r.outgoing(9854)).filter((x) => x.lineIndex >= 0 && x.lineIndex <= 999).map((x) => x.rowid);
      seek.mockClear();
      const got = (await r.atLines(9854, 0, 999)).map((x) => x.rowid);
      expect(got).toEqual(want);
      expect(seek).not.toHaveBeenCalled();
      expect(got.length).toBeGreaterThan(0);
    } finally {
      seek.mockRestore();
    }
  });

  it("a range of the whole book is still one read of the book's rows", async () => {
    const r = await ext();
    const all = (await r.outgoing(9854)).map((x) => x.rowid);
    expect((await r.atLines(9854, 0, Number.MAX_SAFE_INTEGER)).map((x) => x.rowid)).toEqual(all);
  });
});
