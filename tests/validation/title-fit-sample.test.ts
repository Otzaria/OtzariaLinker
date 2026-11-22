import { appendFileSync, writeFileSync } from "node:fs";
import { afterAll, it } from "vitest";
import { DbLinksReader } from "../../src/database/otzaria/links-reader";
import { OtzariaDbReader, type DbBook } from "../../src/database/otzaria/reader";
import { runHeadingsEngine } from "../../src/linking/automatic/headings";
import { titleFit } from "../../src/linking/title-fit";
import { engineBook, goldPairs, measure } from "../integration/linking/headings/measure";
import { DB, fileSource } from "./env";

/*
 * Fix round before the merge of PR 2, claim 2: measure the title-fit verdict on samples of the OFFICIAL library, read-only, aggregate numbers only.
 *
 *   OTZARIA_DB  the official seforim.db      TITLEFIT_OUT  a file the run appends one JSON line per pair to
 *   TITLEFIT_SET  "calibration" (the pairs tests/integration/linking/title-fit.local.test.ts took with TITLE_FIT_SAMPLE=80: indexes 0, step, 2*step…)
 *                 or "holdout" (a different set: indexes shifted by HALF a step and by a third, minus every pair of the calibration set and of the
 *                 18 listed pairs of that test); TITLEFIT_COUNT  how many pairs at most (default 80)
 *
 * Per pair: the verdict and the metrics of titleFit, next to what the headings engine really did against the database's own links (precision of
 * certain+high on the lines the database links, recall of those lines). The database's links are not guaranteed correct or complete, so "engine
 * good/bad" is agreement with them, not truth. No text of any book is read into the output.
 */
const OUT = process.env.TITLEFIT_OUT;
const SET = process.env.TITLEFIT_SET ?? "holdout";
const COUNT = Number(process.env.TITLEFIT_COUNT ?? 80);
const fs = DB ? fileSource(DB) : null;
afterAll(() => fs?.close());

/** the 18 pairs the calibration test listed by name (titles) */
const LISTED = new Set([
  "תרגום אונקלוס על בראשית", 'רש"י על בראשית', 'רש"י על ברכות', "תוספות על ברכות", "ברטנורא על משנה ברכות", "שער הציון", "ביאור הלכה", "כסף משנה על משנה תורה, הלכות שבת", 'מלבי"ם על ישעיהו', 'רמב"ן על בראשית',
  'ריטב"א על ראש השנה', "רבינו יונה על משלי", "אברבנאל על מורה נבוכים", "קובץ שיטות קמאי על מגילה", 'ראב"ד על ספרא', "הערות שוליים על מכילתא דרבי שמעון בן יוחאי", "פסקי תוספות על נדה", "הגהות מנחם ציון",
]);

it.runIf(DB && OUT)("title fit against the headings engine, on a sample of the official library", async () => {
  const reader = await OtzariaDbReader.open(fs!.source);
  const links = (await DbLinksReader.open(reader.file, reader.caps))!;
  const books = await reader.books();
  const byTitle = new Map(books.map((b) => [b.title, b]));
  const pairs: { c: DbBook; b: DbBook }[] = [];
  for (const c of books) {
    const at = c.title.lastIndexOf(" על ");
    if (at < 0) continue;
    const b = byTitle.get(c.title.slice(at + 4));
    if (b) pairs.push({ c, b });
  }
  // the calibration set: exactly what title-fit.local.test.ts walked with TITLE_FIT_SAMPLE=80
  const stepOf = (n: number) => Math.max(1, Math.floor(pairs.length / n));
  const calibrationStep = stepOf(80);
  const calibrationIdx = new Set<number>();
  for (let i = 0; i < pairs.length; i += calibrationStep) calibrationIdx.add(i);
  const calibrationTitles = new Set([...calibrationIdx].map((i) => pairs[i]!.c.title));
  const order: number[] = [];
  if (SET === "calibration") for (let i = 0; i < pairs.length; i += calibrationStep) order.push(i);
  else {
    const seen = new Set<number>();
    for (const shift of [Math.floor(calibrationStep / 2), Math.floor(calibrationStep / 3)])
      for (let i = shift; i < pairs.length; i += calibrationStep) if (!calibrationIdx.has(i) && !seen.has(i) && !calibrationTitles.has(pairs[i]!.c.title) && !LISTED.has(pairs[i]!.c.title)) (seen.add(i), order.push(i));
  }
  appendFileSync(OUT!, JSON.stringify({ meta: { set: SET, candidatePairs: pairs.length, step: calibrationStep, orderLength: order.length } }) + "\n");
  let done = 0;
  const skipped = { size: 0, gold: 0 };
  for (const i of order) {
    if (done >= COUNT) break;
    const { c, b } = pairs[i]!;
    const cLines = await reader.lines(c.id);
    if (cLines.length > 12_000 || cLines.length < 30) {
      skipped.size++;
      continue;
    }
    const bLines = await reader.lines(b.id);
    if (bLines.length > 30_000) {
      skipped.size++;
      continue;
    }
    const gold = goldPairs(await links.atLines(cLines.map((l) => l.lineId)), c.id, b.id);
    if (gold.size < 20) {
      skipped.gold++;
      continue;
    }
    const commentary = engineBook(`db:${c.id}`, c.title, cLines);
    const base = engineBook(`db:${b.id}`, b.title, bLines);
    const t0 = performance.now();
    const fit = titleFit(commentary, base);
    const fitMs = performance.now() - t0;
    const m = measure(runHeadingsEngine(commentary, base), gold);
    done++;
    appendFileSync(OUT!, JSON.stringify({ i, commentary: c.title, base: b.title, lines: cLines.length, baseLines: bLines.length, verdict: fit.verdict, reasons: fit.reasons.map((r) => r.code), metrics: fit.metrics, fitMs: Math.round(fitMs), engine: { judged: m.judged, correct: m.correct, exact: m.exact, goldLines: m.goldLines, recalled: m.recalled, byConfidence: m.byConfidence } }) + "\n");
  }
  appendFileSync(OUT!, JSON.stringify({ done: { pairs: done, skipped } }) + "\n");
  writeFileSync(`${OUT}.done`, "ok");
}, 3_600_000);
