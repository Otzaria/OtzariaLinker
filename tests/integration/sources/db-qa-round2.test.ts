import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import { describe, expect, it, vi } from "vitest";
import type { DbLinkSummary } from "../../../src/core/links/db-links";
import { DictionaryPool, LineContentCodec, sharedDictionaries } from "../../../src/database/compression/zstd";
import { DbLinksReader } from "../../../src/database/otzaria/links-reader";
import { OtzariaDbReader } from "../../../src/database/otzaria/reader";
import { bytesSource } from "../../../src/database/sqlite/lazy/byte-source";
import { SqliteFile } from "../../../src/database/sqlite/lazy/sqlite-file";
import { DbBookSource } from "../../../src/sources/db/db-source";
import { SourceRegistry } from "../../../src/sources/registry";

/*
 * QA round 2, H: what the external_link reader and the database source answer must not depend on the order of the
 * calls or on who cancelled; and hostile or odd rows are counted and flagged, never turned into NaN or dropped
 * unseen. Rows are placeholders added to a copy of the real v52 DDL (tests/fixtures/db/pdc-personal-mini.db).
 */
const require = createRequire(import.meta.url);
const FIXTURE = new Uint8Array(readFileSync("tests/fixtures/db/pdc-personal-mini.db"));
const ROW = "INSERT INTO external_link (sourceBookId, sourceLineIndex, targetSource, targetTitle, targetRef, targetLineIndex, connectionType) VALUES (?, ?, ?, ?, ?, ?, ?)";
const lid = (book: number, i: number) => book * 2 ** 20 + i + 1;
const MAX = Number.MAX_SAFE_INTEGER;

async function variant(sql?: (run: (q: string, args?: unknown[]) => void) => void) {
  const SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
  const d = new SQL.Database(FIXTURE);
  sql?.((q, args = []) => void d.run(q, args as never));
  const bytes = d.export();
  d.close();
  return { path: "personal.db", blob: new Blob([bytes as BlobPart]) };
}
async function open(file: { path: string; blob: Blob }) {
  const r = new SourceRegistry();
  const res = await r.open([file]);
  const pdc = res.sources[0]!;
  return { r, pdc, key: (id: number) => `${pdc.info.id}:${id}` };
}
const summary = async (r: SourceRegistry, key: string): Promise<DbLinkSummary> => {
  const s = await r.dbLinkSummary(key);
  if (!("total" in s)) throw new Error(s.reason);
  return s;
};

describe("H1: existingLinks over a whole book does not depend on whether the links tab was opened first", () => {
  it("the same answer before and after the summary", async () => {
    const { r, key } = await open(await variant());
    const before = (await r.existingLinks(key(12), 0, MAX)).map((l) => l.id).sort();
    await summary(r, key(12));
    const after = (await r.existingLinks(key(12), 0, MAX)).map((l) => l.id).sort();
    expect(before).toEqual(after);
    expect(after).toHaveLength(3); // 1 outgoing + 2 incoming from the book's own database
  });
});

describe("H2: a shared scan is not bound to the first caller's signal", () => {
  it("aborting the first caller does not reject a second one that has no signal", async () => {
    const { r, key } = await open(await variant());
    const ac = new AbortController();
    const first = r.dbLinkSummary(key(11), { signal: ac.signal });
    const second = r.dbLinkSummary(key(11));
    ac.abort();
    await first.catch(() => undefined);
    const s = await second;
    expect("total" in s).toBe(true);
  });
  it("when every caller left, the cancelled work is not cached: the next caller gets an answer", async () => {
    const { r, key } = await open(await variant());
    const ac = new AbortController();
    const only = r.dbLinkSummary(key(11), { signal: ac.signal });
    ac.abort();
    await only.catch(() => undefined);
    expect("total" in (await r.dbLinkSummary(key(11)))).toBe(true);
  });
});

describe("H3: the numbering rule of the table of contents is checked across the whole table", () => {
  it("a toc entry whose line is another book's line switches the header flags off instead of guessing", async () => {
    const f = await variant((run) => {
      run("INSERT INTO tocText (id, text) VALUES (1, 'PLACEHOLDER heading')");
      run("INSERT INTO tocEntry (id, bookId, parentId, textId, level, lineId) VALUES (1, 11, NULL, 1, 1, ?)", [lid(11, 1)]); // sound: book 11 line 1
      run("INSERT INTO tocEntry (id, bookId, parentId, textId, level, lineId) VALUES (2, 11, NULL, 1, 1, ?)", [lid(12, 2)]); // the line row says: book 12
    });
    const { r, key } = await open(f);
    const s = await summary(r, key(11));
    expect((s.flags ?? []).filter((x) => x.flag.startsWith("header")).map((x) => x.flag)).toEqual([]);
  });
});

describe("H4: a link from a line to itself is not a reverse duplicate", () => {
  it("is flagged by nothing", async () => {
    const { r, key } = await open(await variant((run) => run(ROW, [11, 3, "pdc-fixture", "PLACEHOLDER base", null, 3, "REFERENCE"])));
    const page = await r.dbLinksPage(key(11), { offset: 0, limit: 100 });
    const self = page.links.filter((l) => l.source.line === 3 && l.target.line === 3 && l.target.book.title === "PLACEHOLDER base");
    expect(self.length).toBeGreaterThan(0);
    for (const l of self) expect(l.dbFlags ?? []).not.toContain("reverse-duplicate");
  });
});

describe("H5/H6: odd rows are validated, flagged or counted, never NaN or -1", () => {
  const rows = (run: (q: string, a?: unknown[]) => void) => {
    run(ROW, [11, 0, "pdc-fixture", "PLACEHOLDER notes on base", null, -1, "SOURCE"]); // negative target line
    run(ROW, [11, 1, "pdc-fixture", "PLACEHOLDER notes on base", null, 2.5, "SOURCE"]); // fractional
    run(ROW, [11, 2, "pdc-fixture", "PLACEHOLDER notes on base", null, "abc", "SOURCE"]); // not a number
    run(ROW, [11, 99, "pdc-fixture", "PLACEHOLDER notes on base", null, 1, "SOURCE"]); // a source line past the end of the book
    run(ROW, [11, 3, "pdc-fixture", "PLACEHOLDER notes on base", null, null, "SOURCE"]); // no line and no ref
    run(ROW, [777, 0, "pdc-fixture", "PLACEHOLDER base", null, 1, "SOURCE"]); // a source book that does not exist
  };
  it("a source line past the end of its book is flagged; the odd target lines are not listed as links", async () => {
    const { r, key } = await open(await variant(rows));
    const page = await r.dbLinksPage(key(11), { offset: 0, limit: 100 });
    for (const l of page.links) {
      expect(Number.isInteger(l.source.line) && l.source.line >= 0, l.id).toBe(true);
      expect(Number.isInteger(l.target.line) && l.target.line >= 0, l.id).toBe(true);
    }
    const far = page.links.find((l) => l.source.line === 99);
    expect(far?.dbFlags).toContain("source-out-of-range");
    // the internal scan does not turn "abc" or -1 into line 0
    const into12 = await r.dbLinksPage(key(12), { offset: 0, limit: 100 });
    expect(into12.links.filter((l) => l.source.book.title === "PLACEHOLDER base" && l.source.line === 2)).toEqual([]);
  });
  it("the summary counts what could not be listed", async () => {
    const { r, key } = await open(await variant(rows));
    const s11 = await summary(r, key(11));
    expect(s11.unlisted).toMatchObject({ badLine: 3, noPlace: 1, orphanSource: 1 });
    const s12 = await summary(r, key(12));
    expect(s12.unlisted).toMatchObject({ badLine: 3, noPlace: 1 });
  });
});

describe("H6/H7: an external_link the reader cannot use says why", () => {
  const dropCol = (name: string) =>
    `CREATE TABLE external_link (${["sourceBookId INTEGER NOT NULL", "sourceLineIndex INTEGER NOT NULL", "targetSource TEXT", "targetTitle TEXT NOT NULL", "targetRef TEXT", "targetLineIndex INTEGER", "connectionType TEXT"].filter((c) => !c.startsWith(name)).join(", ")})`;
  it("names the missing mandatory columns", async () => {
    const f = await variant((run) => {
      run("DROP TABLE external_link");
      run(dropCol("sourceLineIndex"));
    });
    const { pdc, r, key } = await open(f);
    const w = pdc.info.warnings.find((x) => x.code === "db/external-links-columns-missing");
    expect(w?.message).toContain("sourceLineIndex");
    expect(w?.message).not.toContain("sourceBookId");
    const s = await r.dbLinkSummary(key(11));
    expect("reason" in s && s.reason).toContain("sourceLineIndex");
  });
  it("a WITHOUT ROWID external_link is not read, with a warning, instead of a raw format error", async () => {
    const f = await variant((run) => {
      run("DROP TABLE external_link");
      run("CREATE TABLE external_link (sourceBookId INTEGER NOT NULL, sourceLineIndex INTEGER NOT NULL, targetSource TEXT, targetTitle TEXT NOT NULL, targetRef TEXT, targetLineIndex INTEGER, connectionType TEXT, PRIMARY KEY (sourceBookId, sourceLineIndex, targetTitle)) WITHOUT ROWID");
      run(ROW, [11, 0, "pdc-fixture", "PLACEHOLDER notes on base", null, 0, "SOURCE"]);
    });
    const { pdc, r, key } = await open(f);
    expect(pdc.info.warnings.map((x) => x.code)).toContain("db/external-links-without-rowid");
    const s = await r.dbLinkSummary(key(11));
    expect("reason" in s).toBe(true);
  });
});

describe("H8: the dictionary pool", () => {
  const dictOf = async () => {
    const SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
    const db = new SQL.Database(new Uint8Array(readFileSync("tests/fixtures/db/seforim-v7-mini.db")));
    const d = db.exec("SELECT dict FROM zstd_dict")[0]!.values[0]![0] as Uint8Array;
    db.close();
    return d;
  };
  it("closing a database releases its dictionary: a conflict ends when one of the two is gone", async () => {
    const dict = await dictOf();
    const other = dict.slice();
    other[100] = other[100]! ^ 0xff;
    const pool = new DictionaryPool();
    const a = new LineContentCodec([dict], pool, "a");
    const b = new LineContentCodec([other], pool, "b");
    expect(pool.isConflicted(32768)).toBe(true);
    b.release();
    expect(pool.isConflicted(32768)).toBe(false);
    expect(pool.get(32768)).toBeDefined();
    a.release();
    expect(pool.get(32768)).toBeUndefined();
  });
  it("a DbBookSource gives its dictionary back to the worker's pool when it closes", async () => {
    const src = await DbBookSource.open("h8", "seforim.db", bytesSource(new Uint8Array(readFileSync("tests/fixtures/db/seforim-v7-mini.db"))));
    expect(sharedDictionaries.get(32768)).toBeDefined();
    src.close();
    expect(sharedDictionaries.get(32768)).toBeUndefined();
  });
  // Issue #41 C3: an open that failed half-way left the dictionary in the worker's pool for the rest of the session
  it("a DbBookSource whose open fails after the dictionary was registered gives it back", async () => {
    const fail = vi.spyOn(DbLinksReader, "open").mockRejectedValueOnce(new Error("נכשל באמצע הפתיחה"));
    try {
      await expect(DbBookSource.open("h8b", "seforim.db", bytesSource(new Uint8Array(readFileSync("tests/fixtures/db/seforim-v7-mini.db"))))).rejects.toThrow("נכשל באמצע הפתיחה");
      expect(fail).toHaveBeenCalled();
      expect(sharedDictionaries.get(32768)).toBeUndefined();
    } finally {
      fail.mockRestore();
    }
  });
  it("an OtzariaDbReader whose open fails after the dictionary was registered gives it back", async () => {
    // every table read after the dictionary entered the pool (line_content, line_note, source) fails
    const table = SqliteFile.prototype.table;
    let registered = false;
    const added = vi.spyOn(sharedDictionaries, "add").mockImplementation(function (this: DictionaryPool, ...args: Parameters<DictionaryPool["add"]>) {
      registered = true;
      return DictionaryPool.prototype.add.apply(this, args);
    });
    const fail = vi.spyOn(SqliteFile.prototype, "table").mockImplementation(async function (this: SqliteFile, name: string) {
      if (registered) throw new Error("נכשל אחרי המילון");
      return table.call(this, name);
    });
    try {
      await expect(OtzariaDbReader.open(bytesSource(new Uint8Array(readFileSync("tests/fixtures/db/seforim-v7-mini.db"))))).rejects.toThrow("נכשל אחרי המילון");
      expect(registered).toBe(true);
      expect(sharedDictionaries.get(32768)).toBeUndefined();
    } finally {
      fail.mockRestore();
      added.mockRestore();
    }
  });
});
