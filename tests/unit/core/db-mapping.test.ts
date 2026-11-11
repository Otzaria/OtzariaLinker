import { describe, expect, it } from "vitest";
import { describeMapping, guessMapping, mappingProblems, parseDbMapping, ROWID, type ColumnPreview, type DbMapping, type SchemaPreview, type TablePreview } from "../../../src/core/db-mapping";

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
