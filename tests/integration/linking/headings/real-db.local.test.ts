import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DbLinksReader } from "../../../../src/database/otzaria/links-reader";
import { OtzariaDbReader, type DbBook } from "../../../../src/database/otzaria/reader";
import type { ByteSource } from "../../../../src/database/sqlite/lazy/byte-source";
import { runHeadingsEngine } from "../../../../src/linking/automatic/headings";
import { engineBook, goldPairs, measure, summary, type Measure } from "./measure";

/*
 * The headings engine against the FULL library, measured with the links the database already has.
 * Runs only on a machine with a real Otzaria database (opened read-only, never written):
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db npx vitest run tests/integration/linking/headings/real-db.local.test.ts
 *
 * A suggestion counts as correct when its target (a line, or every line of a range) contains a base
 * line the database links that commentary line to. "exact-line" counts only single-line targets equal
 * to a linked line. The database's links come from other tools (Sefaria, dibur-hamatchil matching),
 * so a range to the right chapter is "correct" here but coarser than the stored link.
 */
const path = process.env.OTZARIA_DB;
const fd = path ? openSync(path, "r") : -1;
const source: ByteSource | null = path
  ? {
      size: fstatSync(fd).size,
      async read(offset, length) {
        const buf = new Uint8Array(length);
        const n = readSync(fd, buf, 0, length, offset);
        return buf.subarray(0, n);
      },
    }
  : null;
afterAll(() => {
  if (path) closeSync(fd);
});

const PAIRS: readonly { commentary: string; base: string; minPrecision: number }[] = [
  { commentary: "תרגום אונקלוס על בראשית", base: "בראשית", minPrecision: 0.99 },
  { commentary: 'רש"י על בראשית', base: "בראשית", minPrecision: 0.97 },
  { commentary: 'רש"י על ברכות', base: "ברכות", minPrecision: 0.95 },
  { commentary: "ברטנורא על משנה ברכות", base: "משנה ברכות", minPrecision: 0.97 },
  { commentary: "משנה ברורה", base: "שולחן ערוך, אורח חיים", minPrecision: 0.9 },
  { commentary: "תוספות על ברכות", base: "ברכות", minPrecision: 0.95 },
  { commentary: 'רמב"ן על בראשית', base: "בראשית", minPrecision: 0.97 },
  { commentary: "כסף משנה על משנה תורה, הלכות שבת", base: "משנה תורה, הלכות שבת", minPrecision: 0.97 },
  { commentary: "שער הציון", base: "משנה ברורה", minPrecision: 0.95 },
  { commentary: "ביאור הלכה", base: "שולחן ערוך, אורח חיים", minPrecision: 0.95 },
  { commentary: "ארץ יהודה על ארצות החיים", base: "ארצות החיים", minPrecision: 0.95 },
  { commentary: "המאיר לארץ על ארצות החיים", base: "ארצות החיים", minPrecision: 0.95 },
  { commentary: 'מלבי"ם על ישעיהו', base: "ישעיהו", minPrecision: 0.97 },
];

describe.runIf(path)("headings engine vs the links of the real seforim.db (read-only)", () => {
  let reader: OtzariaDbReader;
  let links: DbLinksReader;
  let books: DbBook[];
  beforeAll(async () => {
    reader = await OtzariaDbReader.open(source!);
    links = (await DbLinksReader.open(reader.file, reader.caps))!;
    books = await reader.books();
  }, 120_000);

  for (const pair of PAIRS) {
    it(`${pair.commentary} → ${pair.base}`, async () => {
      const c = books.find((b) => b.title === pair.commentary);
      const b = books.find((x) => x.title === pair.base);
      if (!c || !b) return console.info(`skipped: ${pair.commentary} / ${pair.base} not in this database`);
      const cLines = await reader.lines(c.id);
      const commentary = engineBook(`db:${c.id}`, c.title, cLines);
      const base = engineBook(`db:${b.id}`, b.title, await reader.lines(b.id));
      const gold = goldPairs(await links.atLines(cLines.map((l) => l.lineId)), c.id, b.id);
      const t0 = performance.now();
      const r = runHeadingsEngine(commentary, base);
      const ms = Math.round(performance.now() - t0);
      const m: Measure = measure(r, gold);
      console.info(`${summary(`${pair.commentary} → ${pair.base}`, m)}; ${commentary.lines.length} lines in ${ms}ms; notes: ${r.notes.map((n) => n.code).join(", ")}`);
      if (m.wrong.length) console.info(`  wrong (first): ${m.wrong.slice(0, 6).join(" | ")}`);
      expect(m.correct / Math.max(1, m.judged)).toBeGreaterThanOrEqual(pair.minPrecision);
    }, 300_000);
  }
});
