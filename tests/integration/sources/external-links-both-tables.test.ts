import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadSqlJs } from "../../support/sql-js";

/*
 * #13, a database with BOTH a `link` table and `external_link`: it used to be read through `link` alone, and the
 * external_link rows were never shown. Now both are listed, each link once, each keeping its own id (`:link:<id>`,
 * `:ext:<rowid>`) and provenance "db". Real DDL: the `link` family from tests/fixtures/schemas/v0.sql, `external_link`
 * and `schema_meta` copied from the real v52 DDL (tests/fixtures/db/pdc-personal-mini.db). Rows are placeholders.
 */
type SqlRunner = { run: (sql: string, params?: (string | number | null)[]) => unknown };
const v0 = readFileSync("tests/fixtures/schemas/v0.sql", "utf8");
const FIXTURE = new Uint8Array(readFileSync("tests/fixtures/db/pdc-personal-mini.db"));
const LIB = "both-fixture";

async function database(extra?: (d: SqlRunner) => void): Promise<{ path: string; blob: Blob }> {
  const SQL = await loadSqlJs();
  const real = new SQL.Database(FIXTURE);
  const ddl = (t: string) => String(real.exec(`SELECT sql FROM sqlite_master WHERE name = '${t}'`)[0]!.values[0]![0]);
  const d = new SQL.Database();
  d.exec(v0);
  d.exec(ddl("schema_meta"));
  d.exec(ddl("external_link"));
  real.close();
  d.run("INSERT INTO schema_meta (key, value) VALUES ('library_id', ?)", [LIB]);
  d.exec(`INSERT INTO source(id, name) VALUES (1, 'MoreBooks');
          INSERT INTO category(id, title) VALUES (1, 'x');
          INSERT INTO book(id, categoryId, sourceId, title, isBaseBook) VALUES (1, 1, 1, 'PLACEHOLDER base', 1), (2, 1, 1, 'PLACEHOLDER commentary', 0);
          INSERT INTO connection_type(id, name) VALUES (1, 'COMMENTARY'), (24, 'FOOTNOTES');`);
  for (const b of [1, 2]) for (let i = 0; i < 6; i++) d.run("INSERT INTO line(id, bookId, lineIndex, content) VALUES (?, ?, ?, ?)", [b * 100 + i, b, i, `PLACEHOLDER ${i}`]);
  // the link table: base 1:1 → commentary 2:1, base 1:2 → commentary 2:2 (COMMENTARY)
  d.exec(`INSERT INTO link(id, sourceBookId, targetBookId, sourceLineId, targetLineId, targetLineIndex, connectionTypeId) VALUES
          (1, 1, 2, 101, 201, 1, 1), (2, 1, 2, 102, 202, 2, 1);`);
  // external_link: the SAME link as link 1 (a duplicate across the two tables), and two that only this table has
  const ext = "INSERT INTO external_link (sourceBookId, sourceLineIndex, targetSource, targetTitle, targetRef, targetLineIndex, connectionType) VALUES (?, ?, ?, ?, ?, ?, ?)";
  d.run(ext, [1, 1, LIB, "PLACEHOLDER commentary", null, 1, "COMMENTARY"]);
  d.run(ext, [1, 3, LIB, "PLACEHOLDER commentary", null, 4, "FOOTNOTES"]);
  d.run(ext, [1, 4, "official", "PLACEHOLDER not open", "PLACEHOLDER ref", 0, "SOURCE"]);
  extra?.(d);
  const bytes = d.export();
  d.close();
  return { path: "both.db", blob: new Blob([bytes as BlobPart]) };
}

describe("a database with a link table AND external_link", () => {
  it("lists the links of both tables, once each, with their own ids", async () => {
    const r = new SourceRegistry();
    const res = await r.open([await database()]);
    const sid = res.sources[0]!.info.id;
    const s = await r.dbLinkSummary(`${sid}:1`);
    expect("total" in s && s).toMatchObject({ out: 4, in: 0, total: 4 }); // 2 (link) + 2 only in external_link; the repeated one is not counted twice
    const page = await r.dbLinksPage(`${sid}:1`, { offset: 0, limit: 20 });
    expect(page.links.map((l) => [l.source.line, l.target.book.title, l.target.line, l.declaredType, l.provenance])).toEqual([
      [1, "PLACEHOLDER commentary", 1, "commentary", "db"],
      [2, "PLACEHOLDER commentary", 2, "commentary", "db"],
      [3, "PLACEHOLDER commentary", 4, "footnotes", "db"],
      [4, "PLACEHOLDER not open", 0, "source", "db"],
    ]);
    expect(page.links.map((l) => l.id.replace(/^s\d+:/, "").replace(/\d+$/, "N"))).toEqual(["link:N", "link:N", "ext:N", "ext:N"]);
  });

  it("a page asks each table for its own links, and the line panel merges them too", async () => {
    const r = new SourceRegistry();
    const res = await r.open([await database()]);
    const sid = res.sources[0]!.info.id;
    const onlyExt = await r.dbLinksPage(`${sid}:1`, { offset: 2, limit: 2 });
    expect(onlyExt.links.map((l) => l.id.includes(":ext:"))).toEqual([true, true]);
    const lines = await r.existingLinks(`${sid}:1`, 0, 5);
    expect(lines).toHaveLength(4);
    expect(lines.filter((l) => l.source.line === 1)).toHaveLength(1); // the link repeated in both tables is one
  });

  /* fix round before merge (task 1): the origin table is a typed field, a repeated link that carries a ref is still one,
   * and the summary says what the merge did instead of dropping rows unseen */
  const REPEAT_WITH_REF = (d: SqlRunner) =>
    d.run("INSERT INTO external_link (sourceBookId, sourceLineIndex, targetSource, targetTitle, targetRef, targetLineIndex, connectionType) VALUES (?, ?, ?, ?, ?, ?, ?)", [1, 2, LIB, "PLACEHOLDER commentary", "PLACEHOLDER ref 3", 2, "COMMENTARY"]);

  it("every listed link says which table it came from (dbTable), not only in its id", async () => {
    const r = new SourceRegistry();
    const res = await r.open([await database()]);
    const sid = res.sources[0]!.info.id;
    const page = await r.dbLinksPage(`${sid}:1`, { offset: 0, limit: 20 });
    expect(page.links.map((l) => l.dbTable)).toEqual(["link", "link", "external_link", "external_link"]);
    const lines = await r.existingLinks(`${sid}:1`, 0, 5);
    expect(lines.map((l) => l.dbTable).sort()).toEqual(["external_link", "external_link", "link", "link"]);
  });

  it("an external_link row that repeats a link row but also carries a targetRef is the same link, not a second one", async () => {
    const r = new SourceRegistry();
    const res = await r.open([await database(REPEAT_WITH_REF)]);
    const sid = res.sources[0]!.info.id;
    const s = await r.dbLinkSummary(`${sid}:1`);
    expect("total" in s && s.total).toBe(4); // link 1, link 2 (the repeated ref row is link 2 again), two only in external_link
    const page = await r.dbLinksPage(`${sid}:1`, { offset: 0, limit: 20 });
    expect(page.links.filter((l) => l.source.line === 2)).toHaveLength(1);
    const lines = await r.existingLinks(`${sid}:1`, 0, 5);
    expect(lines.filter((l) => l.source.line === 2)).toHaveLength(1); // the line panel and the list agree
  });

  it("the summary says that two tables were merged, how many rows each gave and how many repeats were dropped", async () => {
    const r = new SourceRegistry();
    const res = await r.open([await database(REPEAT_WITH_REF)]);
    const sid = res.sources[0]!.info.id;
    const s = await r.dbLinkSummary(`${sid}:1`);
    expect("tables" in s && s.tables).toEqual({ link: 2, externalLink: 2, duplicatesDropped: 2, incomingUnchecked: 0 });
  });

  it("a database with one table has no merge summary", async () => {
    const r = new SourceRegistry();
    const res = await r.open([{ path: "pdc.db", blob: new Blob([FIXTURE as BlobPart]) }]);
    const sid = res.sources[0]!.info.id;
    const s = await r.dbLinkSummary(`${sid}:1`);
    expect("total" in s && s.tables).toBeUndefined();
  });
});
