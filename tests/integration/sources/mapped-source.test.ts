import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";

/* A dropped SQLite file in someone else's schema: the registry asks for a mapping instead of refusing it. */
const file = (name: string) => ({ path: `dir/${name}`, blob: new Blob([readFileSync(`tests/fixtures/db/generic/${name}`)]) });

describe("SourceRegistry — databases that need a mapping", () => {
  it("returns the schema preview and a guess, then opens through the mapping", async () => {
    const r = new SourceRegistry();
    const res = await r.open([file("books-lines.db")]);
    expect(res.sources).toEqual([]);
    expect(res.skipped).toEqual([]);
    const [p] = res.needsMapping!;
    expect(p).toMatchObject({ path: "dir/books-lines.db", label: "books-lines.db", guess: { layout: "two-tables" } });
    expect(p!.preview.tables.map((t) => t.name)).toContain("paragraphs");

    const opened = await r.openMapped(p!.token, p!.guess!);
    expect(opened.info).toMatchObject({ kind: "mapped-db", label: "books-lines.db" });
    expect(opened.books.map((b) => [b.title, b.lineCount, b.origin])).toEqual([["ספר הדוגמה", 12, "personal"], ["פירוש על ספר הדוגמה", 6, "personal"], ["ספר ריק", 0, "personal"]]);
    const [base, comm] = opened.books;
    const lines = await r.lines(base!.key, 0, 1);
    expect(lines[0]).toEqual({ index: 0, text: "ספר הדוגמה", anchorText: "ספר הדוגמה", heRef: null, heading: 1, existsInDb: true });
    const links = await r.existingLinks(comm!.key, 0, 5);
    expect(links.map((l) => [l.source.book.title, l.source.line, l.target.book.title, l.target.line, l.declaredType, l.provenance])).toEqual([
      ["פירוש על ספר הדוגמה", 1, "ספר הדוגמה", 1, "commentary", "db"],
      ["פירוש על ספר הדוגמה", 2, "ספר הדוגמה", 2, "commentary", "db"],
      ["פירוש על ספר הדוגמה", 3, "ספר הדוגמה", 3, "reference", "db"],
    ]);
    expect(links[0]!.heRef2).toBe("ספר הדוגמה 2");

    // the token stays valid: the same file can be opened again with another mapping
    const again = await r.openMapped(p!.token, { ...p!.guess!, links: undefined } as never);
    expect(again.info.id).not.toBe(opened.info.id);
    expect(await r.existingLinks(again.books[1]!.key, 0, 5)).toEqual([]);
  });

  it("tables named book/line without Otzaria's columns are mapped, not read as an empty Otzaria database", async () => {
    const res = await new SourceRegistry().open([file("compressed.db"), { path: "bracket.db", blob: new Blob([readFileSync("tests/fixtures/db/hostile/bracket.db")]) }]);
    expect(res.sources).toEqual([]);
    expect(res.needsMapping!.map((p) => [p.label, p.guess?.lines.table ?? null])).toEqual([["compressed.db", "line"], ["bracket.db", null]]);
  });

  it("a database with no usable text still gets the wizard (with no guess)", async () => {
    const res = await new SourceRegistry().open([file("no-text.db")]);
    expect(res.needsMapping![0]!.guess).toBeNull();
  });

  it("an Otzaria database is still opened directly, and an unknown token fails clearly", async () => {
    const r = new SourceRegistry();
    const res = await r.open([{ path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) }]);
    expect(res.sources[0]!.info.kind).toBe("otzaria-db");
    expect(res.needsMapping).toBeUndefined();
    await expect(r.openMapped("m999", { layout: "single-table", lines: { table: "t", book: "a", order: "b", text: "c" } })).rejects.toMatchObject({ code: "db/mapping-unknown-token" });
  });

  it("a corrupt generic database is skipped with a reason, not offered for mapping", async () => {
    const bytes = new Uint8Array(readFileSync("tests/fixtures/db/generic/single-table.db"));
    bytes.fill(0xff, 4096, 8192); // page 2 (the table's root) is garbage
    const res = await new SourceRegistry().open([{ path: "bad.db", blob: new Blob([bytes]) }]);
    expect(res.needsMapping ?? []).toEqual([]);
    expect(res.skipped[0]!.reason.length).toBeGreaterThan(10);
  });
});

describe("a database whose tables are all still in its -wal file", () => {
  it("is refused with the WAL reason, not just 'no tables'", async () => {
    const initSqlJs = (await import("sql.js")).default;
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run("PRAGMA user_version = 1"); // an empty schema, but a real header page
    const bytes = db.export();
    db.close();
    const plain = await new SourceRegistry().open([{ path: "empty.db", blob: new Blob([new Uint8Array(bytes)]) }]);
    expect(plain.skipped[0]!.reason).toBe("במסד אין אף טבלה שאפשר לקרוא ממנה ספרים.");
    const wal = new Uint8Array(bytes);
    wal[18] = 2; // file format write/read version 2 = WAL mode
    wal[19] = 2;
    const res = await new SourceRegistry().open([{ path: "personal_notes.db", blob: new Blob([wal]) }]);
    expect(res.skipped[0]!.reason).toContain("‎-wal");
  });
});
