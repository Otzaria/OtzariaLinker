import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeSchema } from "../../../src/core/db-guess";
import { mappingProblems, type DbAnalysis, type DbMapping, type SchemaPreview } from "../../../src/core/db-mapping";
import { MappedDbReader } from "../../../src/database/generic/mapped-reader";
import { previewSchema } from "../../../src/database/generic/preview";
import { bytesSource } from "../../../src/database/sqlite/lazy/byte-source";
import { SqliteFile } from "../../../src/database/sqlite/lazy/sqlite-file";
import { testMapping } from "../../../src/sources/db/mapped-source";

/*
 * One fixture per database structure the mapping wizard meets (scripts/fixtures/make_wizard_dbs.py):
 * what the explained guess proposes — or that it says "no books" — and what reading through that
 * guess gives. The books are the same short Hebrew texts everywhere (make_wizard_dbs.book_lines),
 * so every readable structure must give the same titles and lines in the same order.
 */
const bytes = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/db/wizard/${name}`));
const open = (name: string) => SqliteFile.open(bytesSource(bytes(name)));

async function analyze(name: string): Promise<{ p: SchemaPreview; a: DbAnalysis }> {
  const p = await previewSchema(await open(name));
  return { p, a: analyzeSchema(p) };
}

async function read(name: string, m: DbMapping) {
  const r = await MappedDbReader.open(await open(name), m);
  const books = [];
  for (const b of r.books) books.push({ title: b.title, lines: (await r.lines(b.n)).map((l) => l.text) });
  return { r, books };
}

/** make_wizard_dbs.book_lines(b): "<h1>title</h1>", sentences, "<h2>פרק ב</h2>" at line 3 */
const H1 = ["<h1>ספר הדוגמה</h1>", "<h1>פירוש על ספר הדוגמה</h1>"];

describe("structures with books: the guess, and reading through it", () => {
  const plain = ["blob-utf8.db", "blob-utf16.db", "legacy-encoding.db", "zlib.db", "zstd.db", "utf16-database.db", "books-lines-fk.db", "books-lines-nofk.db", "line-per-row.db", "links-table.db", "chunked.db", "book-per-row.db"];
  it.each(plain)("%s: two books of 8+ lines, first line the <h1>, line 3 the chapter heading", async (name) => {
    const { p, a } = await analyze(name);
    expect(a.noBooks).toBe(false);
    expect(a.guess).not.toBeNull();
    expect(mappingProblems(p, a.guess!).filter((x) => x.level === "error")).toEqual([]);
    const { r, books } = await read(name, a.guess!);
    expect(r.undecodable).toBe(0);
    expect(books[0]!.title).toBe("ספר הדוגמה");
    expect(books[0]!.lines[0]).toBe(H1[0]);
    expect(books[0]!.lines[3]).toBe("<h2>פרק ב</h2>");
    expect(books[0]!.lines.length).toBeGreaterThanOrEqual(8);
    if (name !== "legacy-encoding.db") expect(books[1]!.lines[0]).toBe(H1[1]);
    expect(books.every((b) => b.lines.every((l) => !l.includes("�")))).toBe(true);
  });

  it("books + lines with a FOREIGN KEY: the reason names it, and the index makes it lazy", async () => {
    const { a } = await analyze("books-lines-fk.db");
    expect(a.candidates[0]!.reasons.map((x) => x.text).join(" | ")).toContain("FOREIGN KEY");
    expect((await read("books-lines-fk.db", a.guess!)).r.strategy).toBe("index");
  });

  it("no hints in the names, no FOREIGN KEY, no index: tied by the values", async () => {
    const { a } = await analyze("books-lines-nofk.db");
    expect(a.guess).toMatchObject({ layout: "two-tables", books: { table: "t_main", title: "label" }, lines: { table: "t_items", book: "parent", order: "pos", text: "payload" } });
    expect(a.candidates[0]!.reasons.map((x) => x.text).join(" | ")).toContain('כל הערכים של "parent" הם מזהים');
  });

  it("one book per row: each row is split into its lines", async () => {
    const { a } = await analyze("book-per-row.db");
    expect(a.guess).toMatchObject({ layout: "single-table", lines: { table: "books", book: "title", text: "content", unit: "lines" } });
    const { books } = await read("book-per-row.db", a.guess!);
    expect(books.map((b) => [b.title, b.lines.length])).toEqual([["ספר הדוגמה", 8], ["פירוש על ספר הדוגמה", 8], ["קובץ שיעורים", 8]]);
  });

  it("chunks of one text, cut mid-line: joined, then split at line breaks", async () => {
    const { a } = await analyze("chunked.db");
    expect(a.guess?.lines).toMatchObject({ table: "chunks", order: "part", unit: "chunks" });
    const { books } = await read("chunked.db", a.guess!);
    expect(books.map((b) => b.lines.length)).toEqual([10, 10]);
    expect(books[0]!.lines.every((l) => l.length > 5)).toBe(true); // no piece of a line on its own
  });

  it("JSON chapters: arrays of lines, and {title, verses} objects whose titles become headings", async () => {
    const { a } = await analyze("json-chapters.db");
    expect(a.guess).toMatchObject({ layout: "single-table", lines: { book: "title", text: "chapters", unit: "json" } });
    const r = await MappedDbReader.open(await open("json-chapters.db"), a.guess!);
    expect(await r.lineCount(0)).toBe(9);
    const second = await r.lines(1);
    expect(second.length).toBe(9); // 3 chapters × (title + 2 verses)
    expect(second.filter((l) => l.heading === 2).map((l) => l.text)).toEqual(["פרק א", "פרק ב", "פרק ג"]);
  });

  it("chapters + lines: the lines join their book in (chapter, line) order", async () => {
    const { a } = await analyze("chapters-lines.db");
    expect(a.guess).toMatchObject({ layout: "two-tables", books: { table: "books" }, lines: { table: "verses", book: "chapter_id", order: "num" }, via: { table: "chapters", book: "book_id", order: "num", kind: "part" } });
    const { books } = await read("chapters-lines.db", a.guess!);
    expect(books.map((b) => b.lines.length)).toEqual([9, 9]);
  });

  it("several versions of a book: each version is a book of its own", async () => {
    const { a } = await analyze("versions.db");
    expect(a.guess?.via).toMatchObject({ table: "versions", kind: "edition", title: "name" });
    const { books } = await read("versions.db", a.guess!);
    expect(books.map((b) => b.title)).toEqual(["ספר הדוגמה — דפוס ראשון", "ספר הדוגמה — מהדורה מתוקנת", "פירוש על ספר הדוגמה — דפוס ראשון", "פירוש על ספר הדוגמה — מהדורה מתוקנת"]);
    expect(books[1]!.lines[2]).toMatch(/\(מתוקן\)$/);
    expect(books[0]!.lines[2]).not.toMatch(/מתוקן/);
  });

  it.each(["composite-key.db", "composite-key-rowid.db"])("%s: (chapter, verse) order from the composite key", async (name) => {
    const { a } = await analyze(name);
    expect(a.guess?.lines).toMatchObject({ order: "chapter", orderThen: ["verse"] });
    const { books } = await read(name, a.guess!);
    expect(books[0]!.lines.map((l) => l.slice(0, 3))).toEqual(["1:1", "1:2", "1:3", "2:1", "2:2", "2:3"]);
  });

  it("a separate links table by line id is guessed; one by (book, line number) is not", async () => {
    const { a } = await analyze("links-table.db");
    expect(a.guess?.links).toEqual({ table: "links", source: "source_line_id", target: "target_line_id", type: "type" });
    const { r } = await read("links-table.db", a.guess!);
    expect(r.linksAt(1, 0, 10).map((l) => [l.source.line, l.target.line])).toEqual([[1, 1], [2, 2], [4, 4]]);
  });

  it("a TOC table: the lines are read, and the wizard says the TOC table is not", async () => {
    const { a } = await analyze("toc-table.db");
    expect(a.guess?.lines.table).toBe("lines");
    expect(a.limitations.join(" ")).toContain('טבלת תוכן העניינים "toc" אינה נקראת');
  });

  it("legacy code page: BLOBs in Windows-1255 decode; the same text stored as TEXT is rejected with the reason", async () => {
    const { a } = await analyze("legacy-encoding.db");
    expect(a.guess?.lines).toMatchObject({ table: "line", text: "data" });
    const old = a.candidates.find((c) => c.table === "old_line")!;
    expect(old.verdict).toBe("rejected");
    expect(old.reasons.map((r) => r.text).join()).toMatch(/אינו UTF-8 תקין/);
    expect(a.limitations.join(" ")).toMatch(/old_line\.txt.*Windows-1255/);
  });

  it("the FTS storage table holds text: proposed, with a warning that names its columns", async () => {
    const { a } = await analyze("fts-stored.db");
    expect(a.guess?.lines).toMatchObject({ table: "docs_content", book: "c0", text: "c1" });
    expect(a.candidates[0]!.warnings.join(" ")).toContain("title, body");
    expect(a.limitations.join(" ")).toContain('"docs" הוא אינדקס חיפוש (fts5)');
  });
});

describe("databases without books: said plainly, nothing proposed", () => {
  it.each([
    ["settings-log.db", /בדקתי \d+ עמודות טקסט/],
    ["fts-contentless.db", /בדקתי \d+ עמודות טקסט/],
    ["views-only.db", /בדקתי \d+ עמודות טקסט/],
    ["catalog.db", /בדקתי \d+ עמודות טקסט/],
    ["empty-tables.db", /כל הטבלאות בו ריקות/],
  ])("%s", async (name, why) => {
    const { a } = await analyze(name);
    expect(a.noBooks).toBe(true);
    expect(a.guess).toBeNull();
    expect(a.summary).toMatch(/^לא נמצאו ספרים במסד הזה/);
    expect(a.summary).toMatch(why);
    expect(a.candidates.every((c) => c.verdict !== "books")).toBe(true);
  });

  it("the log table loses on its own evidence: repeated values, its name, a time column", async () => {
    const { a } = await analyze("settings-log.db");
    const log = a.candidates.find((c) => c.table === "log" && c.column === "message")!;
    const text = log.reasons.filter((r) => r.weight < 0).map((r) => r.text).join(" | ");
    expect(text).toMatch(/ערכים חוזרים/);
    expect(text).toMatch(/שם הטבלה \("log"\)/);
    expect(text).toMatch(/עמודת זמן \("ts"\)/);
  });

  it("limitations: a contentless FTS index, and views", async () => {
    expect((await analyze("fts-contentless.db")).a.limitations.join(" ")).toMatch(/בלי תוכן \(content=''\)/);
    const views = (await analyze("views-only.db")).a;
    expect(views.limitations.join(" ")).toMatch(/2 מבטים \(VIEW\): v_books, v_lines.*\(kv\)/);
    expect(views.candidates.find((c) => c.column === "val")!.reasons.map((r) => r.text).join()).toMatch(/מפתח־ערך/);
  });
});

describe("test the mapping before opening", () => {
  it("first lines of the first books; bounded; no links read", async () => {
    const { a } = await analyze("links-table.db");
    const t = await testMapping(bytesSource(bytes("links-table.db")), a.guess!);
    expect(t.books).toBe(2);
    expect(t.partial).toBe(false);
    expect(t.sample[0]).toMatchObject({ title: "ספר הדוגמה", lineCount: 8 });
    expect(t.sample[0]!.lines.map((l) => l.text).slice(0, 1)).toEqual([H1[0]]);
    expect(t.sample[0]!.lines[0]!.heading).toBe(1);
  });

  it("a wrong manual mapping shows what it would give (no books) instead of failing silently", async () => {
    const t = await testMapping(bytesSource(bytes("settings-log.db")), { layout: "single-table", lines: { table: "log", book: "level", order: "id", text: "message" } });
    expect(t.sample.map((b) => b.title).sort()).toEqual(["ERROR", "INFO"]);
    expect(t.books).toBe(2);
  });
});
