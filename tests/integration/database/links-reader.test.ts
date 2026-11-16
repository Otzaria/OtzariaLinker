import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import initSqlJs, { type Database } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import { DbLinksReader } from "../../../src/database/otzaria/links-reader";
import { OtzariaDbReader } from "../../../src/database/otzaria/reader";
import { bytesSource } from "../../../src/database/sqlite/lazy/byte-source";

/* Existing links read by line from a real schema-7 slice, cross-checked with SQL on the same file. */
const require = createRequire(import.meta.url);
const BYTES = new Uint8Array(readFileSync("tests/fixtures/db/seforim-v7-mini.db"));
let links: DbLinksReader;
let reader: OtzariaDbReader;
let db: Database;
beforeAll(async () => {
  reader = await OtzariaDbReader.open(bytesSource(BYTES));
  links = (await DbLinksReader.open(reader.file, reader.caps))!;
  const SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
  db = new SQL.Database(BYTES);
});
const q = (sql: string) => (db.exec(sql)[0]?.values ?? []) as unknown[][];

describe("DbLinksReader.atLines", () => {
  it("uses indexes on the real schema", () => expect(links.indexed).toBe(true));

  it("returns every link that starts, ends or is covered at the lines — same set as SQL", async () => {
    const lineIds = q("SELECT id FROM line WHERE bookId = 1 AND lineIndex BETWEEN 0 AND 60").map((r) => r[0] as number);
    const ids = lineIds.join(",");
    const expected = q(`SELECT id FROM link WHERE sourceLineId IN (${ids}) OR targetLineId IN (${ids})
                        UNION SELECT linkId FROM link_coverage WHERE lineId IN (${ids}) ORDER BY 1`).map((r) => r[0]);
    const rows = await links.atLines(lineIds);
    expect(rows.map((r) => r.id)).toEqual(expected);
    expect(rows.length).toBeGreaterThan(50);
  });

  it("each row matches the database: books, line indexes, type, anchors, range ends, suppressed sides", async () => {
    const all = q("SELECT id FROM line").map((r) => r[0] as number);
    const rows = await links.atLines(all);
    expect(rows.length).toBe(q("SELECT count(*) FROM link")[0]![0]);
    for (const r of rows) {
      const [exp] = q(`SELECT k.sourceBookId, k.targetBookId, sl.lineIndex, k.targetLineIndex, ct.name FROM link k
                       JOIN line sl ON sl.id = k.sourceLineId JOIN connection_type ct ON ct.id = k.connectionTypeId WHERE k.id = ${r.id}`);
      expect([r.source.bookId, r.target.bookId, r.source.lineIndex, r.target.lineIndex, r.typeName]).toEqual(exp);
      const anchors = q(`SELECT side, charStart, charEnd, label FROM link_anchor WHERE linkId = ${r.id} ORDER BY side, charStart`);
      expect(r.anchors.map((a) => [a.side, a.charStart, a.charEnd ?? null, a.label ?? null])).toEqual(anchors);
      for (const [side, end] of q(`SELECT side, endLineIndex FROM link_range WHERE linkId = ${r.id}`) as [number, number][])
        expect((side === 1 ? r.target : r.source).endIndex).toBe(end);
      expect(r.suppressedSides.sort()).toEqual(q(`SELECT side FROM link_suppressed_side WHERE linkId = ${r.id} ORDER BY side`).map((x) => x[0]));
    }
    expect(rows.some((r) => r.anchors.length)).toBe(true);
    expect(rows.some((r) => r.target.endIndex !== undefined || r.source.endIndex !== undefined)).toBe(true);
    expect(rows.some((r) => r.suppressedSides.length)).toBe(true);
  });
});
