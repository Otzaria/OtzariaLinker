import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DbLinkSummary } from "../../../src/core/links/db-links";
import type { Link } from "../../../src/core/links/model";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadSqlJs } from "../../support/sql-js";

/*
 * Issue #41 B20 (V7 spec §1.4): Otzaria's user_books.db keeps the user's personal links in `user_link`. The tool detected the table
 * but read nothing from it, so a personal book with links showed 0 links and coverage looked "100% unlinked", with no warning.
 *
 * Real DDL only: tests/fixtures/schemas/user-books.sql (database.dart @ a6be90800) and user-books-user-link-v1.sql (the first
 * user_link, @ 65db26bd2). What a row means (docs/contracts/LINK_SCHEMA_MATRIX.md §6.1): each side is a book named by its exact
 * title and an isUserBook flag (1 = a personal book of user_books.db itself, 0 = the official library) or an attached database's
 * slug (sourceDb/targetDb); lines are 0-based; *End are inclusive 0-based range ends; anchorStart/anchorEnd are the source line's raw
 * offsets as the native links file wrote them. Rows are placeholders.
 */
type Db = { run: (sql: string, params?: (string | number | null)[]) => unknown; exec: (sql: string) => unknown };
const USER_BOOKS = readFileSync("tests/fixtures/schemas/user-books.sql", "utf8");
const AT_USER_LINK = USER_BOOKS.indexOf("CREATE TABLE IF NOT EXISTS user_link");
/** user_books.db without its user_link (to put the old one, or a broken one, in its place) */
const WITHOUT_USER_LINK = USER_BOOKS.slice(0, AT_USER_LINK);
const USER_LINK_DDL = USER_BOOKS.slice(AT_USER_LINK);
const USER_LINK_V1 = readFileSync("tests/fixtures/schemas/user-books-user-link-v1.sql", "utf8");
const V0 = readFileSync("tests/fixtures/schemas/v0.sql", "utf8");
const PDC = new Uint8Array(readFileSync("tests/fixtures/db/pdc-personal-mini.db"));

const sql = () => loadSqlJs();
const blob = (d: { export(): Uint8Array; close(): void }) => {
  const bytes = d.export();
  d.close();
  return new Blob([bytes as BlobPart]);
};

const A = "PLACEHOLDER personal A";
const B = "PLACEHOLDER personal B";
const LIB = "PLACEHOLDER library";

/** the books of a user_books.db: personal books whose text is a file (no `line` rows, totalLines 0), as Otzaria imports them */
function personalBooks(d: Db): void {
  d.exec(`INSERT INTO source(id, name) VALUES (1, 'PLACEHOLDER source');
          INSERT INTO category(id, title) VALUES (1, 'PLACEHOLDER category');`);
  d.run("INSERT INTO book(id, categoryId, sourceId, title, isContentExternal, isPersonal, filePath) VALUES (1, 1, 1, ?, 1, 1, 'a.txt'), (2, 1, 1, ?, 1, 1, 'b.txt')", [A, B]);
}

type Row = Partial<Record<"sourceTitle" | "targetTitle" | "targetRef" | "targetRefEnd" | "anchorLabel" | "connectionType" | "sourceDb" | "targetDb", string | null> & Record<"sourceIsUserBook" | "targetIsUserBook" | "sourceLineIndex" | "targetLineIndex" | "sourceLineIndexEnd" | "targetLineIndexEnd" | "anchorStart" | "anchorEnd" | "sourceCategoryId" | "targetCategoryId", number | null>>;
const insert = (d: Db, id: number, r: Row) => {
  const cols = Object.keys(r);
  d.run(`INSERT INTO user_link (id, ${cols.join(", ")}) VALUES (?, ${cols.map(() => "?").join(", ")})`, [id, ...(Object.values(r) as (string | number | null)[])]);
};

/** The rows of the current schema. Book A's: out 1, 4, 5, 8, 9, 11; in 2, 3. Not links: 6 (line -1), 7 (no target line). */
function currentRows(d: Db): void {
  const own = (t: string) => ({ title: t, user: 1 });
  const row = (s: { title: string; user: number }, sl: number | null, t: { title: string; user: number }, tl: number | null, type: string, more: Row = {}) => ({ sourceTitle: s.title, sourceIsUserBook: s.user, sourceLineIndex: sl, targetTitle: t.title, targetIsUserBook: t.user, targetLineIndex: tl, connectionType: type, ...more });
  const lib = (t: string) => ({ title: t, user: 0 });
  insert(d, 1, row(own(A), 0, lib(LIB), 4, "COMMENTARY", { targetRef: "PLACEHOLDER ref 5" }));
  insert(d, 2, row(own(B), 2, own(A), 1, "REFERENCE"));
  insert(d, 3, row(lib(LIB), 3, own(A), 5, "SOURCE"));
  insert(d, 4, row(own(A), 7, own(A), 2, "COMMENTARY", { sourceLineIndexEnd: 9, targetLineIndexEnd: 3, anchorStart: 3, anchorEnd: 8, anchorLabel: "א" }));
  // the library's book of the SAME title as personal book A: never the personal one
  insert(d, 5, row(own(A), 1, lib(A), 0, "REFERENCE"));
  insert(d, 6, row(own(A), -1, own(B), 0, "REFERENCE"));
  insert(d, 7, row(own(A), 1, own(B), null, "REFERENCE"));
  // an end no book reaches is dropped (no huge walk); a fractional end is no line
  insert(d, 8, row(own(A), 3, own(B), 0, "REFERENCE", { sourceLineIndexEnd: 99_999_999, targetLineIndexEnd: 2.5 }));
  insert(d, 9, row(own(A), 4, lib("PLACEHOLDER attached"), 0, "REFERENCE", { targetDb: "other-lib" }));
  // a PERSONAL book this database does not have: stays unresolved, even when the library has that title
  insert(d, 11, row(own(A), 6, own(LIB), 0, "REFERENCE"));
}

async function userBooks(fill: (d: Db) => void = currentRows, ddl = USER_BOOKS): Promise<{ path: string; blob: Blob }> {
  const d = new (await sql()).Database();
  d.exec(ddl);
  personalBooks(d);
  fill(d);
  return { path: "user_books.db", blob: blob(d) };
}

/** the library: books of the same titles the rows name (v0 DDL; the file name says it is the library, isLibraryDb) */
async function library(): Promise<{ path: string; blob: Blob }> {
  const d = new (await sql()).Database();
  d.exec(V0);
  d.exec("INSERT INTO source(id, name) VALUES (1, 'PLACEHOLDER source'); INSERT INTO category(id, title) VALUES (1, 'x');");
  d.run("INSERT INTO book(id, categoryId, sourceId, title, totalLines) VALUES (1, 1, 1, ?, 10), (2, 1, 1, ?, 10)", [LIB, A]);
  return { path: "seforim.db", blob: blob(d) };
}

/** an attached database whose library_id is "Other-Lib": Otzaria's slug of it is "other-lib" (attached_library_probe.dart:203-229) */
async function attached(): Promise<{ path: string; blob: Blob }> {
  const S = await sql();
  const real = new S.Database(PDC);
  const meta = String(real.exec("SELECT sql FROM sqlite_master WHERE name = 'schema_meta'")[0]!.values[0]![0]);
  real.close();
  const d = new S.Database();
  d.exec(V0);
  d.exec(meta);
  d.run("INSERT INTO schema_meta (key, value) VALUES ('library_id', 'Other-Lib')");
  d.exec("INSERT INTO source(id, name) VALUES (1, 'PLACEHOLDER source'); INSERT INTO category(id, title) VALUES (1, 'x');");
  d.run("INSERT INTO book(id, categoryId, sourceId, title) VALUES (1, 1, 1, 'PLACEHOLDER attached')");
  return { path: "attached.db", blob: blob(d) };
}

const summary = async (r: SourceRegistry, key: string): Promise<DbLinkSummary> => {
  const s = await r.dbLinkSummary(key);
  if (!("total" in s)) throw new Error(`no summary: ${s.reason}`);
  return s;
};
const all = async (r: SourceRegistry, key: string): Promise<Link[]> => (await r.dbLinksPage(key, { offset: 0, limit: 100 })).links;
const byId = (links: Link[], rowid: number) => links.find((l) => l.id.endsWith(`:user:${rowid}`));

describe("user_link of Otzaria's user_books.db", () => {
  it("a personal book lists its user_link rows, out and in, each once — not 0 links", async () => {
    const r = new SourceRegistry();
    const [ub] = (await r.open([await userBooks()])).sources;
    const s = await summary(r, `${ub!.info.id}:1`);
    expect(s).toMatchObject({ total: 8, out: 6, in: 2 });
    expect(s.unlisted).toEqual({ badLine: 1, noPlace: 1, orphanSource: 0 });
    const links = await all(r, `${ub!.info.id}:1`);
    expect(links.map((l) => l.id.replace(/^s\d+:/, "")).sort()).toEqual(["user:1", "user:11", "user:2", "user:3", "user:4", "user:5", "user:8", "user:9"]);
    expect(new Set(links.map((l) => l.provenance))).toEqual(new Set(["db"]));
    expect(new Set(links.map((l) => l.dbTable))).toEqual(new Set(["user_link"]));
  });

  it("ranges, anchors, types and the stored direction of a row", async () => {
    const r = new SourceRegistry();
    const [ub] = (await r.open([await userBooks()])).sources;
    const sid = ub!.info.id;
    const links = await all(r, `${sid}:1`);
    expect(byId(links, 4)).toMatchObject({
      status: "existing",
      source: { book: { key: `${sid}:1`, title: A, origin: "personal" }, line: 7, end: 9 },
      target: { book: { key: `${sid}:1` }, line: 2, end: 3 },
      declaredType: "commentary",
      anchor: { rawStart: 3, rawEnd: 8, label: "א" },
    });
    // the row of another personal book INTO this one keeps its stored direction (source = book B)
    expect(byId(links, 2)).toMatchObject({ source: { book: { key: `${sid}:2`, title: B }, line: 2 }, target: { book: { key: `${sid}:1` }, line: 1 }, declaredType: "reference" });
    const huge = byId(links, 8)!;
    expect(huge.source).toEqual({ book: expect.objectContaining({ key: `${sid}:1` }), line: 3 });
    expect(huge.target).toEqual({ book: expect.objectContaining({ key: `${sid}:2` }), line: 0 });
    expect(byId(links, 1)).toMatchObject({ heRef2: "PLACEHOLDER ref 5", declaredType: "commentary" });
  });

  it("a library side that is not open stays unresolved, and is never bound to the personal book of the same title", async () => {
    const r = new SourceRegistry();
    const [ub] = (await r.open([await userBooks()])).sources;
    const links = await all(r, `${ub!.info.id}:1`);
    expect(byId(links, 5)!.target.book).toMatchObject({ key: `unresolved:${A}`, title: A, origin: "otzaria" });
    expect(byId(links, 1)!.target.book).toMatchObject({ key: `unresolved:${LIB}`, origin: "otzaria" });
    expect(byId(links, 3)!.source.book).toMatchObject({ key: `unresolved:${LIB}`, origin: "otzaria" });
  });

  it("with the library and an attached database open: each side binds to the book of its own kind only", async () => {
    const r = new SourceRegistry();
    const res = await r.open([await library(), await attached(), await userBooks()]);
    const lib = res.sources.find((s) => s.info.label === "seforim.db")!.info.id;
    const att = res.sources.find((s) => s.info.label === "attached.db")!.info.id;
    const ub = res.sources.find((s) => s.info.label === "user_books.db")!.info.id;
    const links = await all(r, `${ub}:1`);
    expect(byId(links, 1)!.target.book.key).toBe(`${lib}:1`);
    expect(byId(links, 3)!.source.book.key).toBe(`${lib}:1`);
    // the library's "PLACEHOLDER personal A", not the personal book A
    expect(byId(links, 5)!.target.book.key).toBe(`${lib}:2`);
    // targetDb is the attached database's slug
    expect(byId(links, 9)!.target.book.key).toBe(`${att}:1`);
    // a personal side never binds to a library book of the same title
    expect(byId(links, 11)!.target.book).toMatchObject({ key: `unresolved:${LIB}`, origin: "personal" });
  });

  it("the line panel (existingLinks) gives the same links, a link inside the book once", async () => {
    const r = new SourceRegistry();
    const [ub] = (await r.open([await userBooks()])).sources;
    const sid = ub!.info.id;
    const lines = await r.existingLinks(`${sid}:1`, 0, 10);
    expect(lines.map((l) => l.id.replace(/^s\d+:/, "")).sort()).toEqual(["user:1", "user:11", "user:2", "user:3", "user:4", "user:5", "user:8", "user:9"]);
    expect(await r.existingLinks(`${sid}:1`, 5, 5)).toHaveLength(1); // row 3, into line 5
    const b = await r.existingLinks(`${sid}:2`, 0, 10);
    expect(b.map((l) => l.id.replace(/^s\d+:/, "")).sort()).toEqual(["user:2", "user:8"]);
  });

  it("the first schema (sourceBookId) is read too", async () => {
    const r = new SourceRegistry();
    const [ub] = (
      await r.open([
        await userBooks((d) => {
          d.exec(USER_LINK_V1);
          insert(d, 1, { sourceBookId: 1, sourceLineIndex: 0, targetTitle: LIB, targetIsUserBook: 0, targetLineIndex: 4, connectionType: "COMMENTARY" } as Row);
          insert(d, 2, { sourceBookId: 2, sourceLineIndex: 2, targetTitle: A, targetIsUserBook: 1, targetLineIndex: 1, connectionType: "REFERENCE" } as Row);
          insert(d, 3, { sourceBookId: 99, sourceLineIndex: 2, targetTitle: A, targetIsUserBook: 1, targetLineIndex: 1, connectionType: "REFERENCE" } as Row);
        }, WITHOUT_USER_LINK),
      ])
    ).sources;
    const sid = ub!.info.id;
    expect(ub!.info.warnings.map((w) => w.code)).not.toContain("db/user-link-not-read");
    const s = await summary(r, `${sid}:1`);
    expect(s).toMatchObject({ total: 2, out: 1, in: 1 });
    expect(s.unlisted?.orphanSource).toBe(1);
    const links = await all(r, `${sid}:1`);
    expect(byId(links, 2)).toMatchObject({ source: { book: { key: `${sid}:2` }, line: 2 }, target: { book: { key: `${sid}:1` }, line: 1 } });
  });

  it("a user_link that cannot be read warns, and the book's links are not reported as 0", async () => {
    const r = new SourceRegistry();
    // the real table without one of its required columns: not a layout this reader knows
    const broken = USER_LINK_DDL.replace(/\n\s*targetIsUserBook INTEGER NOT NULL DEFAULT 0,/, "").replace(/CREATE INDEX[^\n]*targetIsUserBook[^\n]*\n/, "");
    const [ub] = (await r.open([await userBooks(() => {}, WITHOUT_USER_LINK + broken)])).sources;
    const w = ub!.info.warnings.find((x) => x.code === "db/user-link-not-read");
    expect(w?.message).toMatch(/user_link/);
    const s = await r.dbLinkSummary(`${ub!.info.id}:1`);
    // either no summary with a reason, or a summary that says it is incomplete: never a plain 0
    expect("total" in s ? s.unread : s.reason).toMatch(/user_link/);
    // the book itself says so, for coverage (state/coverage.ts) and every other count
    const book = ub!.books.find((b) => b.key === `${ub!.info.id}:1`);
    expect(book?.linksUnread).toMatch(/user_link/);
  });

  it("a database with link, external_link AND user_link lists a link the three repeat once", async () => {
    const S = await sql();
    const real = new S.Database(PDC);
    const ddl = (t: string) => String(real.exec(`SELECT sql FROM sqlite_master WHERE name = '${t}'`)[0]!.values[0]![0]);
    const d = new S.Database();
    d.exec(V0);
    d.exec(ddl("schema_meta"));
    d.exec(ddl("external_link"));
    real.close();
    d.exec(USER_LINK_DDL);
    d.run("INSERT INTO schema_meta (key, value) VALUES ('library_id', 'three')");
    d.exec("INSERT INTO source(id, name) VALUES (1, 'MoreBooks'); INSERT INTO category(id, title) VALUES (1, 'x'); INSERT INTO connection_type(id, name) VALUES (1, 'COMMENTARY');");
    d.run("INSERT INTO book(id, categoryId, sourceId, title) VALUES (1, 1, 1, ?), (2, 1, 1, ?)", [A, B]);
    for (const b of [1, 2]) for (let i = 0; i < 4; i++) d.run("INSERT INTO line(id, bookId, lineIndex, content) VALUES (?, ?, ?, ?)", [b * 100 + i, b, i, `PLACEHOLDER ${i}`]);
    d.exec("INSERT INTO link(id, sourceBookId, targetBookId, sourceLineId, targetLineId, targetLineIndex, connectionTypeId) VALUES (1, 1, 2, 101, 201, 1, 1);");
    d.run("INSERT INTO external_link (sourceBookId, sourceLineIndex, targetSource, targetTitle, targetRef, targetLineIndex, connectionType) VALUES (1, 1, 'three', ?, NULL, 1, 'COMMENTARY')", [B]);
    insert(d, 1, { sourceTitle: A, sourceIsUserBook: 1, sourceLineIndex: 1, targetTitle: B, targetIsUserBook: 1, targetLineIndex: 1, connectionType: "COMMENTARY" });
    insert(d, 2, { sourceTitle: A, sourceIsUserBook: 1, sourceLineIndex: 2, targetTitle: B, targetIsUserBook: 1, targetLineIndex: 3, connectionType: "COMMENTARY" });
    const r = new SourceRegistry();
    const [src] = (await r.open([{ path: "three.db", blob: blob(d) }])).sources;
    const s = await summary(r, `${src!.info.id}:1`);
    expect(s.total).toBe(2);
    expect(s.tables).toEqual({ link: 1, externalLink: 0, userLink: 1, duplicatesDropped: 2, incomingUnchecked: 0 });
    const links = await all(r, `${src!.info.id}:1`);
    expect(links.map((l) => l.dbTable)).toEqual(["link", "user_link"]);
  });
});
