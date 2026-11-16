import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { readAltToc } from "../../../src/database/otzaria/alt-toc-reader";
import { bytesSource } from "../../../src/database/sqlite/lazy/byte-source";
import { SqliteFile } from "../../../src/database/sqlite/lazy/sqlite-file";

/*
 * Review C17: the entries of a structure were collected with a spread per row — quadratic. The
 * largest structure of the real seforim.db (ערוך השולחן, Seifim) has 26,609 entries and took ~3 s.
 */
const require = createRequire(import.meta.url);
const ENTRIES = 30_000;

async function bigStructureDb(): Promise<SqliteFile> {
  const SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
  const db = new SQL.Database();
  // the real DDL (schema 7), including UNIQUE (bookId, key)
  db.run(`CREATE TABLE alt_toc_structure (id INTEGER PRIMARY KEY NOT NULL, bookId INTEGER NOT NULL, key TEXT NOT NULL, title TEXT, heTitle TEXT, UNIQUE (bookId, key))`);
  db.run(`CREATE TABLE alt_toc_entry (id INTEGER PRIMARY KEY NOT NULL, structureId INTEGER NOT NULL, parentId INTEGER, textId INTEGER NOT NULL, level INTEGER NOT NULL, lineId INTEGER, isLastChild INTEGER NOT NULL DEFAULT 0, hasChildren INTEGER NOT NULL DEFAULT 0)`);
  db.run("CREATE TABLE tocText (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");
  db.run("CREATE INDEX idx_alt_toc_entry_structure ON alt_toc_entry(structureId)");
  db.run("INSERT INTO alt_toc_structure VALUES (1, 7, 'Seifim', 'Seifim', 'סעיפים'), (2, 7, 'SimanNames', NULL, 'סימנים'), (3, 8, 'Other', NULL, NULL)");
  db.run("BEGIN");
  const e = db.prepare("INSERT INTO alt_toc_entry (id, structureId, parentId, textId, level, lineId) VALUES (?,?,?,?,?,?)");
  const t = db.prepare("INSERT INTO tocText VALUES (?, ?)");
  for (let i = 1; i <= ENTRIES; i++) {
    // 300 roots, each with 99 children; lines 1000 + i
    const root = i % 100 === 1;
    e.run([i, 1, root ? null : i - ((i - 1) % 100), i, root ? 0 : 1, 1000 + i]);
    t.run([i, `סעיף ${i}`]);
  }
  for (let i = 1; i <= 50; i++) e.run([ENTRIES + i, 2, null, 1, 0, 1000 + i]);
  for (let i = 1; i <= 5; i++) e.run([ENTRIES + 100 + i, 3, null, 1, 0, 1000 + i]);
  db.run("COMMIT");
  e.free();
  t.free();
  const bytes = db.export();
  db.close();
  return SqliteFile.open(bytesSource(bytes));
}

describe("alt_toc reader (review C17)", () => {
  it(`a structure of ${ENTRIES.toLocaleString("en")} entries is built in linear time`, async () => {
    const file = await bigStructureDb();
    const lineIndexOf = (id: number) => id - 1; // line ids are 1-based rowids here
    await readAltToc(file, 7, lineIndexOf); // warm the page cache: time the build, not the reads
    const t0 = performance.now();
    const s = (await readAltToc(file, 7, lineIndexOf))!;
    const ms = performance.now() - t0;
    console.log(`readAltToc, ${ENTRIES} entries: ${ms.toFixed(1)} ms`);
    expect(s.map((x) => [x.key, x.entries.length, x.skipped])).toEqual([["Seifim", ENTRIES, 0], ["SimanNames", 50, 0]]);
    expect(s[0]!.entries.slice(0, 3)).toEqual([{ heTitle: "סעיף 1", line: 1001, level: 0 }, { heTitle: "סעיף 2", line: 1002, level: 1 }, { heTitle: "סעיף 3", line: 1003, level: 1 }]);
    expect(ms).toBeLessThan(1000);
  });
});
