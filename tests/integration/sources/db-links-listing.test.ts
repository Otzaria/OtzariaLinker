import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { strToU8 } from "fflate";
import initSqlJs, { type Database } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import { CONNECTION_TYPES } from "../../../src/core/links/connection-type";
import type { DbLinkQuery, DbLinkSummary } from "../../../src/core/links/db-links";
import { SourceRegistry } from "../../../src/sources/registry";

/*
 * A book's database links, listed through the registry (stage 10), on the REAL schema-7 slice
 * tests/fixtures/db/seforim-v7-mini.db — every count and page cross-checked with SQLite (sql.js)
 * on the same bytes. Then the older layouts: schema 0 (real DDL from tests/fixtures/schemas/v0.sql)
 * and a database with no link table at all.
 */
const require = createRequire(import.meta.url);
const BYTES = new Uint8Array(readFileSync("tests/fixtures/db/seforim-v7-mini.db"));
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
let db: Database;
let reg: SourceRegistry;
let sid: string;
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
  db = new SQL.Database(BYTES);
  reg = new SourceRegistry();
  const res = await reg.open([{ path: "seforim.db", blob: new Blob([BYTES]) }]);
  sid = res.sources[0]!.info.id;
});
const q = (sql: string, d = db) => (d.exec(sql)[0]?.values ?? []) as unknown[][];
const summaryOf = async (key: string) => {
  const s = await reg.dbLinkSummary(key);
  if (!("total" in s)) throw new Error(s.reason);
  return s;
};

describe("summary of a book's database links — same numbers as SQL", () => {
  for (const bookId of [1, 3695, 8050, 3860, 3201]) {
    it(`book ${bookId}`, async () => {
      const s: DbLinkSummary = await summaryOf(`${sid}:${bookId}`);
      const out = Number(q(`SELECT count(*) FROM link WHERE sourceBookId = ${bookId}`)[0]![0]);
      const all = Number(q(`SELECT count(*) FROM link WHERE sourceBookId = ${bookId} OR targetBookId = ${bookId}`)[0]![0]);
      expect(s).toMatchObject({ total: all, out, in: all - out, method: "index" });
      // by type: a link inside the book counts once, as "out"
      const types = q(`SELECT ct.name, sum(k.sourceBookId = ${bookId}), sum(k.sourceBookId <> ${bookId}) FROM link k JOIN connection_type ct ON ct.id = k.connectionTypeId
                       WHERE k.sourceBookId = ${bookId} OR k.targetBookId = ${bookId} GROUP BY ct.name`);
      expect(new Map(s.byType.map((t) => [t.type, [t.out, t.in]]))).toEqual(new Map(types.map(([n, o, i]) => [n, [Number(o), Number(i)]])));
      const books = q(`SELECT CASE WHEN k.sourceBookId = ${bookId} THEN k.targetBookId ELSE k.sourceBookId END AS other, sum(k.sourceBookId = ${bookId}), sum(k.sourceBookId <> ${bookId})
                       FROM link k WHERE k.sourceBookId = ${bookId} OR k.targetBookId = ${bookId} GROUP BY other`);
      expect(new Map(s.byBook.map((b) => [b.bookKey, [b.out, b.in]]))).toEqual(new Map(books.map(([b, o, i]) => [`${sid}:${b}`, [Number(o), Number(i)]])));
      for (const b of s.byBook) expect(b.title).toBe(q(`SELECT title FROM book WHERE id = ${b.bookKey.split(":")[1]}`)[0]![0]);
      // COMMENTARY links per book: the max-link planner's evidence
      const comm = q(`SELECT CASE WHEN k.sourceBookId = ${bookId} THEN k.targetBookId ELSE k.sourceBookId END AS other, sum(k.sourceBookId = ${bookId}), sum(k.sourceBookId <> ${bookId})
                      FROM link k JOIN connection_type ct ON ct.id = k.connectionTypeId WHERE ct.name = 'COMMENTARY' AND (k.sourceBookId = ${bookId} OR k.targetBookId = ${bookId}) GROUP BY other`);
      expect(new Map(s.byBook.filter((b) => b.commentaryOut + b.commentaryIn).map((b) => [b.bookKey, [b.commentaryOut, b.commentaryIn]]))).toEqual(
        new Map(comm.map(([b, o, i]) => [`${sid}:${b}`, [Number(o), Number(i)]])),
      );
      // most links first
      expect(s.byBook.map((b) => b.out + b.in)).toEqual([...s.byBook.map((b) => b.out + b.in)].sort((a, b) => b - a));
    });
  }
});

describe("pages — filtered, in the book's line order, with full details", () => {
  const own = (bookId: number) => `CASE WHEN k.sourceBookId = ${bookId} THEN sl.lineIndex ELSE k.targetLineIndex END`;
  const sqlIds = (bookId: number, where = "1") =>
    q(`SELECT k.id FROM link k JOIN line sl ON sl.id = k.sourceLineId JOIN connection_type ct ON ct.id = k.connectionTypeId
       WHERE (k.sourceBookId = ${bookId} OR k.targetBookId = ${bookId}) AND ${where} ORDER BY ${own(bookId)}, k.id`).map((r) => `${sid}:link:${r[0]}`);

  it("all links of בראשית, page by page, equal SQL's order", async () => {
    const key = `${sid}:1`;
    const want = sqlIds(1);
    const got: string[] = [];
    for (let offset = 0; offset < want.length; offset += 100) {
      const p = await reg.dbLinksPage(key, { offset, limit: 100 });
      expect(p.total).toBe(want.length);
      got.push(...p.links.map((l) => l.id));
    }
    expect(got).toEqual(want);
  });

  it("each filter matches SQL: direction, types, the other book, lines", async () => {
    const key = `${sid}:1`;
    const page = (query: Omit<DbLinkQuery, "offset" | "limit">) => reg.dbLinksPage(key, { ...query, offset: 0, limit: 1000 });
    expect((await page({ dir: "in" })).links.map((l) => l.id)).toEqual(sqlIds(1, "k.sourceBookId <> 1"));
    expect((await page({ types: ["TARGUM", "REFERENCE"] })).links.map((l) => l.id)).toEqual(sqlIds(1, "ct.name IN ('TARGUM','REFERENCE')"));
    expect((await page({ otherBookKey: `${sid}:3695`, dir: "out" })).links.map((l) => l.id)).toEqual(sqlIds(1, "k.sourceBookId = 1 AND k.targetBookId = 3695"));
    expect((await page({ lines: { from: 3, to: 5 } })).links.map((l) => l.id)).toEqual(sqlIds(1, `${own(1)} BETWEEN 3 AND 5`));
    expect((await page({ otherBookKey: `${sid}:99999` })).total).toBe(0);
  });

  it("a page carries anchors, ranges and Sefaria's hidden sides; links are read-only 'db' links", async () => {
    const p = await reg.dbLinksPage(`${sid}:1`, { offset: 0, limit: 1000 });
    expect(p.links.every((l) => l.provenance === "db" && l.status === "existing")).toBe(true);
    const suppressed = q("SELECT linkId, side FROM link_suppressed_side ORDER BY linkId, side");
    for (const [id, side] of suppressed) {
      const l = p.links.find((x) => x.id === `${sid}:link:${id}`);
      if (l) expect(l.dbSuppressed).toContain(side);
    }
    expect(p.links.some((l) => l.dbSuppressed?.length)).toBe(true);
    expect(p.links.some((l) => l.source.end !== undefined || l.target.end !== undefined)).toBe(true);
    // LINKER links into בראשית carry their side-0 anchor
    const linker = (await reg.dbLinksPage(`${sid}:1`, { offset: 0, limit: 100, types: ["LINKER"] })).links;
    expect(linker.length).toBeGreaterThan(0);
    expect(linker.every((l) => l.dbAnchors?.some((a) => a.side === 0))).toBe(true);
  });

  it("text files have no database links, and say so", async () => {
    const r = await reg.open([{ path: "ספר.txt", blob: new Blob([strToU8("<h1>ספר</h1>\nשורה")]) }]);
    const s = await reg.dbLinkSummary(r.sources[0]!.books[0]!.key);
    expect("reason" in s && s.reason).toMatch(/קובצי טקסט/);
    expect((await reg.dbLinksPage(r.sources[0]!.books[0]!.key, { offset: 0, limit: 10 })).total).toBe(0);
  });
});

describe("older layouts, by capability", () => {
  const v0 = readFileSync("tests/fixtures/schemas/v0.sql", "utf8");
  /** a schema-0 database (real DDL) with three books and a few links, built in memory */
  function schema0(withLinks: boolean): Uint8Array {
    const d = new SQL.Database();
    d.exec(v0);
    if (!withLinks) d.exec("DROP TABLE link");
    d.exec(`INSERT INTO source(id, name) VALUES (1, 'Sefaria'), (2, 'MoreBooks');
            INSERT INTO category(id, title) VALUES (1, 'x');
            INSERT INTO book(id, categoryId, sourceId, title, isBaseBook) VALUES (1, 1, 1, 'בראשית', 1), (2, 1, 2, 'פירוש על בראשית', 0), (3, 1, 2, 'ספר אחר', 0);`);
    for (const b of [1, 2, 3]) for (let i = 0; i < 5; i++) d.run("INSERT INTO line(id, bookId, lineIndex, content) VALUES (?, ?, ?, ?)", [b * 100 + i, b, i, `שורה ${i}`]);
    d.exec(`INSERT INTO connection_type(id, name) VALUES (1, 'COMMENTARY'), (4, 'REFERENCE');`);
    if (withLinks)
      d.exec(`INSERT INTO link(id, sourceBookId, targetBookId, sourceLineId, targetLineId, targetLineIndex, connectionTypeId) VALUES
              (1, 1, 2, 101, 201, 1, 1), (2, 1, 2, 102, 203, 3, 1), (3, 3, 1, 300, 104, 4, 4);`);
    const bytes = d.export();
    d.close();
    return bytes;
  }

  it("schema 0: no anchors/ranges tables, type names through connection_type — listed from the book indexes", async () => {
    const r = new SourceRegistry();
    const res = await r.open([{ path: "old.db", blob: new Blob([schema0(true) as BlobPart]) }]);
    const id = res.sources[0]!.info.id;
    const s = await r.dbLinkSummary(`${id}:1`);
    expect(s).toMatchObject({ total: 3, out: 2, in: 1, method: "index", byType: [{ type: "COMMENTARY", out: 2, in: 0 }, { type: "REFERENCE", out: 0, in: 1 }] });
    const p = await r.dbLinksPage(`${id}:1`, { offset: 0, limit: 10 });
    expect(p.links.map((l) => [l.source.book.title, l.source.line, l.target.book.title, l.target.line, l.declaredType])).toEqual([
      ["בראשית", 1, "פירוש על בראשית", 1, "commentary"],
      ["בראשית", 2, "פירוש על בראשית", 3, "commentary"],
      ["ספר אחר", 0, "בראשית", 4, "reference"],
    ]);
  });

  it("a database without a link table says it has no links", async () => {
    const r = new SourceRegistry();
    const res = await r.open([{ path: "nolinks.db", blob: new Blob([schema0(false) as BlobPart]) }]);
    const s = await r.dbLinkSummary(`${res.sources[0]!.info.id}:1`);
    expect("reason" in s && s.reason).toMatch(/אין טבלת קישורים/);
  });

  it("every stored type name of the real database maps to the generator's enum", () => {
    for (const [name] of q("SELECT name FROM connection_type")) expect(CONNECTION_TYPES).toContain(name);
  });
});
