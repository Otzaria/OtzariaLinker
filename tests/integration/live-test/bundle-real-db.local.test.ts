import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { BUNDLE_BOOKS, GENESIS } from "../../../scripts/live-test/bundle";
import { OtzariaDbReader } from "../../../src/database/otzaria/reader";
import type { ByteSource } from "../../../src/database/sqlite/lazy/byte-source";

/*
 * Before a live test (docs/LIVE_TESTING.md): the bundle's facts against the user's FULL seforim.db.
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db npx vitest run tests/integration/live-test/bundle-real-db.local.test.ts
 * Read-only ("r"); the file's size and mtime are checked unchanged at the end.
 *   • no bundle book title exists in the official library: a title in both libraries makes the app
 *     reject the links file as ambiguous (user_link_ref_resolver.dart:156-158, upstream/dev@ceff2b13);
 *   • בראשית has the line count, base-book flag and heRefs the bundle was built with.
 */
const path = process.env.OTZARIA_DB;
const fd = path ? openSync(path, "r") : -1;
const before = path ? statSync(path) : null;
const source: ByteSource | null = path
  ? {
      size: fstatSync(fd).size,
      async read(offset, length) {
        const buf = new Uint8Array(length);
        const n = readSync(fd, buf, 0, length, offset);
        return buf.subarray(0, n);
      },
    }
  : null;

afterAll(() => {
  if (!path) return;
  closeSync(fd);
  const after = statSync(path);
  expect([after.size, after.mtimeMs]).toEqual([before!.size, before!.mtimeMs]);
});

describe.runIf(path)("the live-test bundle against the real seforim.db (read-only)", () => {
  it("no bundle title is an official book, and בראשית matches", async () => {
    const reader = await OtzariaDbReader.open(source!);
    const books = await reader.books();
    const titles = new Set(books.map((b) => b.title));
    for (const title of Object.keys(BUNDLE_BOOKS)) expect(titles.has(title), title).toBe(false);

    const g = books.filter((b) => b.title === GENESIS.title);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ isBaseBook: true, totalLines: GENESIS.totalLines });
    const heRefs = await reader.heRefs(g[0]!.id);
    for (const [i, heRef] of Object.entries(GENESIS.heRefs)) expect(heRefs.find((h) => h.index === Number(i))?.heRef).toBe(heRef);
  }, 300_000);
});
