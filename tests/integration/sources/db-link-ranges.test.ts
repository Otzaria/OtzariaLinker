import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { MAX_BOOK_LINES } from "../../../src/core/limits";
import { bytesSource } from "../../../src/database/sqlite/lazy/byte-source";
import { DbBookSource } from "../../../src/sources/db/db-source";

/*
 * Issue #41 C1: a range end read from a database nobody vouches for (link_range.endLineIndex) reached the loops as it
 * was — 20,000,000 cost 400+ MB in the max-link job, 2^31 would be tens of GB. The real slice of the library
 * (tests/fixtures/db/seforim-v7-mini.db) with the end of a few of its own ranges overwritten through sql.js.
 */
const require = createRequire(import.meta.url);
const BYTES = new Uint8Array(readFileSync("tests/fixtures/db/seforim-v7-mini.db"));

/** the slice with the given link_range rows' endLineIndex replaced; returns which links were changed */
async function hostile(values: unknown[]) {
  const SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
  const db = new SQL.Database(BYTES);
  const rows = db.exec(`SELECT r.linkId, r.side, l.sourceBookId FROM link_range r JOIN link l ON l.id = r.linkId ORDER BY r.linkId, r.side LIMIT ${values.length}`)[0]!.values as [number, number, number][];
  expect(rows).toHaveLength(values.length);
  rows.forEach(([linkId, side], i) => db.run("UPDATE link_range SET endLineIndex = ? WHERE linkId = ? AND side = ?", [values[i], linkId, side] as never));
  const bytes = db.export();
  db.close();
  return { bytes, rows: rows.map(([linkId, side, sourceBookId], i) => ({ linkId, side, sourceBookId, value: values[i] })) };
}

describe("range ends from the database are checked before they reach a loop (Issue #41 C1)", () => {
  it("an end past the book, negative, fractional, not a number or before its start is clamped to the book or dropped", async () => {
    const { bytes, rows } = await hostile([20_000_000, 2 ** 31, -5, 2.5, "abc", 0]);
    const src = await DbBookSource.open("t", "seforim.db", bytesSource(bytes));
    const lineCount = new Map((await src.books()).map((b) => [b.key, b.lineCount]));
    for (const r of rows) {
      const link = (await src.existingLinks(`t:${r.sourceBookId}`, 0, Number.MAX_SAFE_INTEGER)).find((l) => l.id === `t:link:${r.linkId}`);
      expect(link, `link ${r.linkId}`).toBeDefined();
      const side = r.side === 1 ? link!.target : link!.source;
      const count = lineCount.get(side.book.key) ?? MAX_BOOK_LINES;
      if (side.end !== undefined) {
        expect(Number.isInteger(side.end), `${r.linkId}: ${String(r.value)}`).toBe(true);
        expect(side.end, `${r.linkId}: ${String(r.value)}`).toBeGreaterThan(side.line);
        expect(side.end, `${r.linkId}: ${String(r.value)}`).toBeLessThan(count);
      }
      // only a whole number past the start can be a range end
      if (typeof r.value !== "number" || !Number.isInteger(r.value) || r.value <= side.line) expect(side.end, `${r.linkId}: ${String(r.value)}`).toBeUndefined();
    }
    src.close();
  });
});
