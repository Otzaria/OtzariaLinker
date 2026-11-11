import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import initSqlJs, { type Database } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import { countVisibleChars } from "../../../src/core/text/offsets";
import { stripNikud } from "../../../src/core/text/hebrew";
import { OtzariaDbReader } from "../../../src/database/otzaria/reader";
import { bytesSource } from "../../../src/database/sqlite/lazy/byte-source";

/* The reader against a REAL schema-7 slice of seforim.db (tests/fixtures/db/seforim-v7-mini.db),
   cross-checked with SQLite itself (sql.js) and with real link anchors. */
const require = createRequire(import.meta.url);
const BYTES = new Uint8Array(readFileSync("tests/fixtures/db/seforim-v7-mini.db"));
let reader: OtzariaDbReader;
let db: Database;

beforeAll(async () => {
  reader = await OtzariaDbReader.open(bytesSource(BYTES));
  const SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
  db = new SQL.Database(BYTES);
});
const q = (sql: string) => (db.exec(sql)[0]?.values ?? []) as unknown[][];

describe("capabilities of a real schema-7 database", () => {
  it("detects kind, schema and every feature by structure", () => {
    expect(reader.caps).toMatchObject({
      kind: "official", declaredSchema: 7, inferredSchema: 7, text: "line_content", compressed: true,
      lineNotes: true, links: true, anchors: true, ranges: true, coverage: true, suppressedSides: true, toc: true, altToc: true,
    });
    expect(reader.caps.warnings).toEqual([]);
  });
});

describe("books and lines", () => {
  it("lists books with their source and base-book flag", async () => {
    const books = await reader.books();
    const bereshit = books.find((b) => b.id === 1)!;
    expect(bereshit).toMatchObject({ title: "בראשית", source: "Sefaria", isBaseBook: true });
    expect(books.map((b) => b.id).sort((a, b) => a - b)).toEqual(q("SELECT id FROM book ORDER BY id").map((r) => r[0]));
  });

  it("lines come in lineIndex order with heRef, and the text decodes", async () => {
    const lines = await reader.lines(1);
    expect(lines.map((l) => [l.index, l.lineId, l.heRef])).toEqual(q("SELECT lineIndex, id, heRef FROM line WHERE bookId = 1 ORDER BY lineIndex"));
    expect(lines[0]!.content).toBe("<h1>בראשית</h1>");
    expect(stripNikud(lines.map((l) => l.content).join("\n"))).toContain("ברא אלהים את השמים ואת הארץ");
    const window = await reader.lines(1, 10, 14);
    expect(window.map((l) => l.index)).toEqual([10, 11, 12, 13, 14]);
  });
});

describe("schema-7 footnotes (line_note) and anchors", () => {
  it("rehydration puts each body back as <i class=\"footnote\">…</i> and keeps the stored text around it", async () => {
    const lines = (await reader.lines(8441)).filter((l) => l.notes.length);
    expect(lines.length).toBeGreaterThan(20);
    for (const l of lines) {
      const full = reader.anchorText(l);
      const opened = full.split('<i class="footnote">').length - 1;
      expect(opened).toBe(l.notes.length);
      let stripped = full;
      for (const n of l.notes) stripped = stripped.replace(`<i class="footnote">${n.body}</i>`, "");
      expect(stripped).toBe(l.content);
    }
  });

  it("every real link_anchor (side 0) lies inside the visible text of its rehydrated source line", async () => {
    const rows = q(`SELECT a.charStart, a.charEnd, l.bookId, l.lineIndex FROM link_anchor a JOIN link k ON k.id = a.linkId
                    JOIN line l ON l.id = k.sourceLineId WHERE a.side = 0`);
    expect(rows.length).toBeGreaterThan(5);
    for (const [charStart, charEnd, bookId, lineIndex] of rows as [number, number | null, number, number][]) {
      const [line] = await reader.lines(bookId, lineIndex, lineIndex);
      const visible = countVisibleChars(reader.anchorText(line!));
      expect(charStart).toBeLessThanOrEqual(visible);
      if (charEnd !== null) expect(charEnd).toBeLessThanOrEqual(visible);
    }
  });

  it("the library record's raw `start`, counted on the line read back, gives the charStart the generator stored", async () => {
    const fixture = JSON.parse(readFileSync("tests/fixtures/contracts/anchor-point.json", "utf8")) as {
      examples: { record: { start: number }; dbRows: { link: { sourceLineId: number }; link_anchor: { side: number; charStart: number }[] }[] }[];
    };
    let checked = 0;
    for (const ex of fixture.examples) {
      for (const row of ex.dbRows) {
        const [loc] = q(`SELECT bookId, lineIndex FROM line WHERE id = ${row.link.sourceLineId}`) as [number, number][];
        if (!loc) continue;
        const [line] = await reader.lines(loc[0], loc[1], loc[1]);
        const anchor = row.link_anchor.find((a) => a.side === 0)!;
        expect(countVisibleChars(reader.anchorText(line!), ex.record.start)).toBe(anchor.charStart);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(3);
  });
});
