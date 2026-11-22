import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { AliasIndex, citationHintStrength, hasCitationHint, type CatalogBook } from "../../src/linking/automatic/citations";
import { hasPlaceWord } from "../../src/linking/automatic/citations/suitability";
import { SourceRegistry } from "../../src/sources/registry";
import { citationsJob } from "../../src/workers/citations-job";
import { DB, fileBlob } from "./env";

/*
 * Fix round before the merge of PR 2, claim 11 (issue #23): how well does the citations engine's suitability gate tell the books that have references
 * from the books that have none? Read-only over the official library, aggregate numbers only (no text goes into the output).
 *
 *   OTZARIA_DB  the official seforim.db     CITGATE_OUT  a file the run appends one JSON line per book to
 *   CITGATE_COUNT  how many books (default 150)    CITGATE_SEED  the sample's seed (default "fixround-gate")
 *
 * The sample: books of 30 to 4,000 lines, the COUNT with the smallest sha1(seed + ":" + book key). Per book: its content lines, the lines the weak hint
 * (hasCitationHint, the gate before the fix) passes, the lines the strong hint (citationHintStrength) passes, and what the citations engine really
 * finds in it (suggestions by confidence), run as the app runs it. "Reality" for the gate is "the engine finds at least one suggestion of high or
 * certain confidence"; that is the engine's claim, not proof that the link is right, and it is said so wherever the numbers are used.
 */
const OUT = process.env.CITGATE_OUT;
const COUNT = Number(process.env.CITGATE_COUNT ?? 150);
const SEED = process.env.CITGATE_SEED ?? "fixround-gate";

it.runIf(DB && OUT)("the citations gate against what the engine finds, on a sample of the official library", async () => {
  const reg = new SourceRegistry();
  const res = await reg.open([{ path: "seforim.db", blob: await fileBlob(DB!) }]);
  const books = res.sources.flatMap((s) => s.books);
  const catalog = (await reg.citationCatalog()).map(({ book, aliases }): CatalogBook => ({ book: { key: book.key, title: book.title, origin: book.origin, ...(book.isBaseBook !== undefined && { isBaseBook: book.isBaseBook }) }, aliases }));
  const index = AliasIndex.build(catalog);
  const knows = (k: string) => index.hasFirstWord(k);
  const hash = (k: string) => createHash("sha1").update(`${SEED}:${k}`).digest("hex");
  const sample = books.filter((b) => (b.lineCount ?? 0) >= 30 && (b.lineCount ?? 0) <= 4000).sort((a, b) => (hash(a.key) < hash(b.key) ? -1 : 1)).slice(0, COUNT);
  appendFileSync(OUT!, JSON.stringify({ meta: { seed: SEED, books: books.length, eligible: books.filter((b) => (b.lineCount ?? 0) >= 30 && (b.lineCount ?? 0) <= 4000).length, sample: sample.length } }) + "\n");
  for (const b of sample) {
    const lines = await reg.lines(b.key, 0, Number.MAX_SAFE_INTEGER);
    const content = lines.filter((l) => l.heading === null);
    let weak = 0;
    let weakNoNames = 0;
    let strong = 0;
    let strongPlace = 0;
    let placeWords = 0;
    for (const l of content) {
      if (hasPlaceWord(l.anchorText)) placeWords++;
      if (hasCitationHint(l.anchorText, knows)) weak++;
      if (hasCitationHint(l.anchorText)) weakNoNames++;
      if (citationHintStrength(l.anchorText, knows) === "strong") strong++;
      // a place word and a number, an amud or a chapter abbreviation: no book name involved
      if (citationHintStrength(l.anchorText) === "strong") strongPlace++;
    }
    const t0 = performance.now();
    const r = process.env.CITGATE_NOENGINE ? { suggestions: [], notes: [] } : await citationsJob(reg, { key: b.key, title: b.title, origin: b.origin }, {}, {});
    const byConf: Record<string, number> = {};
    for (const s of r.suggestions) byConf[s.confidence] = (byConf[s.confidence] ?? 0) + 1;
    appendFileSync(OUT!, JSON.stringify({ title: b.title, lines: lines.length, content: content.length, weak, weakNoNames, strong, strongPlace, placeWords, byConf, skipped: r.notes.some((n) => n.code === "citations/skipped-no-references"), ms: Math.round(performance.now() - t0) }) + "\n");
  }
  writeFileSync(`${OUT}.done`, "ok");
}, 7_200_000);
