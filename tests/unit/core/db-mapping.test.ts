import { describe, expect, it } from "vitest";
import { analyzeSchema, guessMapping } from "../../../src/core/db-guess";
import { describeMapping, mappingProblems, parseDbMapping, ROWID, type ColumnPreview, type DbMapping, type SchemaPreview, type TablePreview } from "../../../src/core/db-mapping";

/* Pure rules of the mapping wizard: the guess, the checks, and reading a mapping from untrusted JSON. */
const col = (name: string, kind: ColumnPreview["kind"], extra: Partial<ColumnPreview> = {}): ColumnPreview => ({ name, type: "", rowidAlias: false, kind, avgLength: kind === "text" || kind === "html" ? 20 : 0, distinct: 5, filled: 5, ...extra });
const table = (name: string, columns: ColumnPreview[], extra: Partial<TablePreview> = {}): TablePreview => ({ name, withoutRowid: false, primaryKey: [], columns, indexes: [], samples: [], pages: 1, ...extra });
const preview = (...tables: TablePreview[]): SchemaPreview => ({ fingerprint: "f", tables, notes: [] });

const SEFARIA_LIKE = preview(
  table("texts", [col("id", "integer", { rowidAlias: true }), col("book_id", "integer"), col("line_index", "integer"), col("content", "html", { avgLength: 300 })], { pages: 900, indexes: [{ name: "ix", columns: ["book_id", "line_index"], seekable: true }] }),
  table("books", [col("id", "integer", { rowidAlias: true }), col("title", "text"), col("path", "text")], { pages: 3 }),
);

describe("guessMapping", () => {
  it("two tables: the big text table refers to the table with titles", () => {
    expect(guessMapping(SEFARIA_LIKE)).toEqual({
      layout: "two-tables",
      books: { table: "books", id: "id", title: "title", path: "path" },
      lines: { table: "texts", book: "book_id", order: "line_index", text: "content" },
    });
  });

  it("one table: a short repeating text column is the title; no order column → rowid", () => {
    const p = preview(table("rows", [col("work", "text", { distinct: 2, avgLength: 12 }), col("txt", "text", { avgLength: 200 })]));
    expect(guessMapping(p)).toEqual({ layout: "single-table", lines: { table: "rows", book: "work", order: ROWID, text: "txt" } });
  });

  it("nothing textual → no guess", () => {
    expect(guessMapping(preview(table("m", [col("a", "integer"), col("b", "binary")])))).toBeNull();
  });
});

describe("mappingProblems", () => {
  const ok = guessMapping(SEFARIA_LIKE)!;

  it("a good mapping with an index has no problems (no scan needed)", () => {
    expect(mappingProblems(SEFARIA_LIKE, ok)).toEqual([]);
  });

  it("missing tables/columns, rowid where a column is needed, the same table twice", () => {
    const errs = (m: DbMapping) => mappingProblems(SEFARIA_LIKE, m).filter((p) => p.level === "error").map((p) => p.message);
    expect(errs({ ...ok, lines: { ...ok.lines, table: "nope" } }).join()).toContain('"nope"');
    expect(errs({ ...ok, lines: { ...ok.lines, text: "" } }).join()).toContain("טקסט השורה");
    expect(errs({ ...ok, lines: { ...ok.lines, text: ROWID } }).join()).toContain("לא את מספר הרשומה");
    expect(errs({ ...ok, books: { ...ok.books!, table: "texts" } }).join()).toContain("אותה טבלה");
  });

  it("WITHOUT ROWID lines are readable only with a (book, order) primary key", () => {
    const p = preview(
      table("t", [col("b", "integer"), col("n", "integer"), col("x", "text")], { withoutRowid: true, primaryKey: ["n", "b"] }),
      table("books", [col("id", "integer", { rowidAlias: true }), col("title", "text")]),
    );
    const m: DbMapping = { layout: "two-tables", books: { table: "books", id: "id", title: "title" }, lines: { table: "t", book: "b", order: "n", text: "x" } };
    expect(mappingProblems(p, m).some((x) => x.level === "error" && /WITHOUT ROWID/.test(x.message))).toBe(true);
    p.tables[0]!.primaryKey = ["b", "n"];
    expect(mappingProblems(p, m).filter((x) => x.level === "error")).toEqual([]);
  });

  it("numbers or nothing in the text column are warnings, not errors", () => {
    const m = { ...ok, lines: { ...ok.lines, text: "line_index" } };
    expect(mappingProblems(SEFARIA_LIKE, m).map((p) => p.level)).toEqual(["warning"]);
  });
});

describe("parseDbMapping", () => {
  it("rebuilds a mapping field by field and refuses anything else", () => {
    const m = guessMapping(SEFARIA_LIKE)!;
    expect(parseDbMapping(JSON.parse(JSON.stringify({ ...m, x: 1 })))).toEqual(m);
    expect(parseDbMapping({ layout: "two-tables", lines: m.lines })).toBeNull(); // no books
    expect(parseDbMapping({ layout: "single-table", lines: { ...m.lines, text: 5 } })).toBeNull();
    expect(parseDbMapping({ layout: "single-table", lines: { ...m.lines, book: "x".repeat(300) } })).toBeNull();
    expect(parseDbMapping("x")).toBeNull();
  });

  it("describes a mapping in one sentence", () => {
    expect(describeMapping(guessMapping(SEFARIA_LIKE)!)).toContain('ספרים מ"books"');
  });
});

describe("text units, composite order and chapters/versions (wizard round V5)", () => {
  const two = guessMapping(SEFARIA_LIKE)!;

  it("parses the new optional fields, drops bad ones, and reads an older mapping unchanged", () => {
    const m: DbMapping = {
      ...two,
      lines: { ...two.lines, orderThen: ["verse"], unit: "chunks" },
      via: { table: "chapters", id: "id", book: "book_id", order: "num", title: "name", kind: "part" },
    };
    expect(parseDbMapping(JSON.parse(JSON.stringify(m)))).toEqual(m);
    // an older project file: none of the new fields → the very same object as before
    expect(parseDbMapping(JSON.parse(JSON.stringify(two)))).toEqual(two);
    // unknown unit, "line" (the default), bad orderThen entries and a via without kind are dropped
    const bad = parseDbMapping({ ...two, lines: { ...two.lines, unit: "pages", orderThen: [5, "", "ok"] }, via: { table: "c", id: "id", book: "b" } })!;
    expect(bad.lines).toEqual({ ...two.lines, orderThen: ["ok"] });
    expect(bad.via).toBeUndefined();
    expect(parseDbMapping({ ...two, lines: { ...two.lines, unit: "line" } })!.lines.unit).toBeUndefined();
    // a via on a single-table mapping is dropped
    const single = { layout: "single-table", lines: { table: "t", book: "b", order: "o", text: "x" }, via: { table: "c", id: "id", book: "b", kind: "part" } };
    expect(parseDbMapping(single)!.via).toBeUndefined();
  });

  it("problems: orderThen after rowid, links with a multi-line unit, via on one table", () => {
    const err = (m: DbMapping) => mappingProblems(SEFARIA_LIKE, m).filter((x) => x.level === "error").map((x) => x.message).join(" | ");
    expect(err({ ...two, lines: { ...two.lines, order: ROWID, orderThen: ["line_index"] } })).toMatch(/סדר משני/);
    expect(err({ ...two, lines: { ...two.lines, unit: "lines" }, links: { table: "texts", source: "id", target: "id" } })).toMatch(/רשומה אינה שורה אחת/);
    expect(err({ layout: "single-table", lines: { table: "texts", book: "book_id", order: "line_index", text: "content" }, via: { table: "books", id: "id", book: "id", kind: "part" } })).toMatch(/פרקים או מהדורות/);
    expect(err({ ...two, via: { table: "books", id: "id", book: "id", kind: "part" } })).toMatch(/טבלה שלישית/);
  });

  it("hints: several lines per value, JSON values, garbled TEXT", () => {
    const p = preview(
      table("t", [col("title", "text", { distinct: 3, filled: 3 }), col("body", "text", { avgLength: 300, newlines: 7 }), col("js", "text", { avgLength: 300, jsonLines: 9 }), col("old", "text", { garbled: 1 })]),
    );
    const msgs = (text: string) => mappingProblems(p, { layout: "single-table", lines: { table: "t", book: "title", order: ROWID, text } }).map((x) => x.message).join(" | ");
    expect(msgs("body")).toMatch(/יש בממוצע 8 שורות/);
    expect(msgs("js")).toMatch(/JSON/);
    expect(msgs("old")).toMatch(/אינו UTF-8 תקין/);
  });

  it("describes units, composite order and chapters", () => {
    const d = describeMapping({ ...two, lines: { ...two.lines, orderThen: ["verse"], unit: "json" }, via: { table: "chapters", id: "id", book: "book_id", kind: "part" } });
    expect(d).toContain("line_index ואז verse");
    expect(d).toContain("JSON");
    expect(d).toContain('פרקים מ"chapters"');
  });
});

describe("a database that is not the books database says which one it is (V7 parity F-009)", () => {
  const otzariaHint = /seforim\.db/;
  it("Otzaria's user data (notes, highlights, bookmarks)", () => {
    const a = analyzeSchema(preview(table("user_notes", [col("id", "integer"), col("note", "text")]), table("bookmarks", [col("ref", "text")])));
    expect(a.noBooks).toBe(true);
    expect(a.summary).toContain("מסד נתוני המשתמש של אוצריא");
    expect(a.summary).toMatch(otzariaHint);
  });
  it("a text-analysis (variants) database, and an index or metadata database", () => {
    expect(analyzeSchema(preview(table("variant", [col("id", "integer")]), table("processed_lines", [col("txt", "text")]))).summary).toContain("ניתוח טקסט");
    expect(analyzeSchema(preview(table("db_meta", [col("k", "text"), col("v", "text")]))).summary).toContain("מסד אינדקס");
  });
  it("any other database keeps the general reasons", () => {
    expect(analyzeSchema(preview(table("log", [col("ts", "integer")]))).summary).not.toMatch(otzariaHint);
  });
});
