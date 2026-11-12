import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DbLinksReader } from "../../../../src/database/otzaria/links-reader";
import { OtzariaDbReader, type DbBook } from "../../../../src/database/otzaria/reader";
import type { ByteSource } from "../../../../src/database/sqlite/lazy/byte-source";
import { runHeadingsEngine } from "../../../../src/linking/automatic/headings";
import { runPatternEngine, type PatternOptions } from "../../../../src/linking/automatic/pattern";
import type { EngineBook } from "../../../../src/linking/automatic/types";
import { engineBook, goldPairs, measure, pct, summary } from "../headings/measure";

/*
 * The structure presets of the pattern engine against books of the FULL library, measured with the
 * links the database already has. Runs only with a real Otzaria database (opened read-only):
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db npx vitest run tests/integration/linking/pattern/real-db.local.test.ts
 *
 * "precision" = certain+high suggestions whose target contains a base line the database links that
 * source line to, among such suggestions on lines that have any database link to the target. The
 * database links of a commentary come from Sefaria and from the generator's own matching, so a
 * reference inside the text that points ELSEWHERE in the target (לעיל, לקמן) is often absent from
 * the gold and counts as wrong here; the per-pair floors are set below the measured values.
 *
 * The second part checks heading detection WITHOUT tags: the commentary's heading tags are removed
 * ("<h3>משנה א</h3>" → "משנה א"), and the headings engine must still find (nearly) what it finds with them.
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

const PAIRS: readonly { source: string; target: string; options: PatternOptions; minPrecision: number }[] = [
  // "<b>ס"ק ג ומיד</b>" under "סימן א": a ס"ק commentary on its base, the סימן from the source's headings
  // anywhere in the line: the rest are mostly true cross-references inside מגן אברהם that the DB does not hold (79.6%)
  { source: "מחצית השקל על אורח חיים", target: "מגן אברהם", options: { preset: "siman-seif-sk" }, minPrecision: 0.75 },
  { source: "מחצית השקל על אורח חיים", target: "מגן אברהם", options: { preset: "siman-seif-sk", position: "start" }, minPrecision: 0.95 },
  { source: "מחצית השקל על אורח חיים", target: "מגן אברהם", options: { preset: "siman-seif-sk", position: "start", carry: true }, minPrecision: 0.9 },
  { source: "מחצית השקל על אורח חיים", target: "מגן אברהם", options: { preset: "general" }, minPrecision: 0.45 },
  // cross-references inside the text ("לעיל במשנה ד'", "עי' לקמן דף מו ע"א", "בפרק ט'"): the DB holds the
  // commented place only, so these floors are 0. A hand check of every certain/high suggestion
  // (2026-11-12, after the another-book guard): תוי"ט 12/12, לחם משנה 26/26, גליון הש"ס 27/27 correct;
  // ביאור הלכה 16/20 of an even sample (wrong: books the guard does not know — החינוך, מהרי"ט, ת' חתם סופר).
  { source: "תוספות יום טוב על משנה ברכות", target: "משנה ברכות", options: { preset: "perek-mishna" }, minPrecision: 0 },
  { source: "לחם משנה על משנה תורה, הלכות שבת", target: "משנה תורה, הלכות שבת", options: { preset: "perek-halacha" }, minPrecision: 0 },
  { source: "גליון הש\"ס על ברכות", target: "ברכות", options: { preset: "daf" }, minPrecision: 0 },
  { source: "ביאור הלכה", target: "שולחן ערוך, אורח חיים", options: { preset: "siman-seif" }, minPrecision: 0 },
];

const UNTAGGED: readonly { commentary: string; base: string; minRatio: number }[] = [
  { commentary: "ברטנורא על משנה ברכות", base: "משנה ברכות", minRatio: 0.95 },
  { commentary: "לחם משנה על משנה תורה, הלכות שבת", base: "משנה תורה, הלכות שבת", minRatio: 0.95 },
  { commentary: "ביאור הלכה", base: "שולחן ערוך, אורח חיים", minRatio: 0.95 },
];

const stripHeadingTags = (b: EngineBook): EngineBook => ({
  book: b.book,
  lines: b.lines.map((l, i) => (l.heading !== null && i > 0 ? { ...l, text: l.text.replace(/<\/?h\d[^>]*>/g, ""), heading: null } : l)),
});

describe.runIf(path)("pattern presets vs the links of the real seforim.db (read-only)", () => {
  let reader: OtzariaDbReader;
  let links: DbLinksReader;
  let books: DbBook[];
  beforeAll(async () => {
    reader = await OtzariaDbReader.open(source!);
    links = (await DbLinksReader.open(reader.file, reader.caps))!;
    books = await reader.books();
  }, 120_000);

  for (const pair of PAIRS) {
    it(`${pair.source} → ${pair.target} (${JSON.stringify(pair.options)})`, async () => {
      const s = books.find((b) => b.title === pair.source);
      const t = books.find((x) => x.title === pair.target);
      if (!s || !t) return console.info(`skipped: ${pair.source} / ${pair.target} not in this database`);
      const sLines = await reader.lines(s.id);
      const src = engineBook(`db:${s.id}`, s.title, sLines);
      const tgt = engineBook(`db:${t.id}`, t.title, await reader.lines(t.id));
      const gold = goldPairs(await links.atLines(sLines.map((l) => l.lineId)), s.id, t.id);
      const t0 = performance.now();
      const r = runPatternEngine(src, tgt, pair.options);
      const ms = Math.round(performance.now() - t0);
      const m = measure(r, gold);
      const onGold = r.suggestions.filter((x) => gold.has(x.source.line)).length;
      const linesWithRefs = new Set(r.suggestions.map((x) => x.source.line)).size;
      console.info(
        `${summary(`${pair.source} → ${pair.target} ${JSON.stringify(pair.options)}`, m)}; ${r.suggestions.length} suggestions on ${linesWithRefs} lines ` +
          `(${pct(onGold, r.suggestions.length)} on lines the DB links to the target), ${r.unmatched.length} unplaced; ${ms}ms`,
      );
      if (m.wrong.length) console.info(`  wrong (first): ${m.wrong.slice(0, 6).join(" | ")}`);
      if (process.env.PATTERN_DEBUG)
        for (const w of m.wrong.slice(0, Number(process.env.PATTERN_DEBUG))) {
          const line = Number(w.split(" ")[0]);
          const sug = r.suggestions.find((x) => x.source.line === line && w.includes(`→ ${x.target.line}`));
          console.info(`  [${line}] ${src.lines.find((l) => l.index === line)?.text.slice(0, 220)}
     ⇒ ${sug?.reasons[0]?.text} ${sug?.confidence}`);
        }
      expect(m.correct / Math.max(1, m.judged)).toBeGreaterThanOrEqual(pair.minPrecision);
    }, 300_000);
  }

  for (const pair of UNTAGGED) {
    it(`untagged headings: ${pair.commentary} → ${pair.base}`, async () => {
      const c = books.find((b) => b.title === pair.commentary);
      const b = books.find((x) => x.title === pair.base);
      if (!c || !b) return console.info(`skipped: ${pair.commentary} / ${pair.base} not in this database`);
      const cLines = await reader.lines(c.id);
      const commentary = engineBook(`db:${c.id}`, c.title, cLines);
      const base = engineBook(`db:${b.id}`, b.title, await reader.lines(b.id));
      const gold = goldPairs(await links.atLines(cLines.map((l) => l.lineId)), c.id, b.id);
      const tagged = measure(runHeadingsEngine(commentary, base), gold);
      const bare = stripHeadingTags(commentary);
      const r = runHeadingsEngine(bare, base);
      const untagged = measure(r, gold);
      const headings = commentary.lines.filter((l) => l.heading !== null).length;
      console.info(
        `untagged ${pair.commentary}: ${headings} heading tags removed; ${r.notes.find((n) => n.code === "heading/untagged")?.text ?? "no untagged headings found"}; ` +
          `recall ${pct(untagged.recalled, untagged.goldLines)} vs ${pct(tagged.recalled, tagged.goldLines)} with tags, precision ${pct(untagged.correct, untagged.judged)} vs ${pct(tagged.correct, tagged.judged)}`,
      );
      expect(untagged.recalled).toBeGreaterThanOrEqual(Math.floor(tagged.recalled * pair.minRatio));
      expect(untagged.correct / Math.max(1, untagged.judged)).toBeGreaterThanOrEqual((tagged.correct / Math.max(1, tagged.judged)) * pair.minRatio);
    }, 300_000);
  }
});
