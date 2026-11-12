import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SourceBook } from "../../src/core/books";
import type { BookRef } from "../../src/core/links/model";
import { SourceRegistry } from "../../src/sources/registry";
import { engineJob } from "../../src/workers/engine-job";
import { DB, fileBlob, fingerprint, record } from "./env";
import { indexDbLinks, scoreBook } from "./library-benchmark";

/*
 * The library benchmark's "what if" (docs/validation/LIBRARY_BENCHMARK.md §5): pairs the max-link
 * planner does NOT relate today (no book_base_text, no "X על Y" title), run through an existing pair
 * engine anyway, and scored against every link the database has between the two books. It tells which
 * missing relation or engine would close the most links — not what the tool does today.
 *
 *   OTZARIA_DB=… npx vitest run --config vitest.validation.config.ts tests/validation/library-benchmark-whatif.test.ts --silent=false
 *   BENCH_WHATIF="dibur-hamatchil|משנה שבת|שבת;headings|מדרש תהילים|תהילים"   (default: the list below)
 */
type PairEngine = "headings" | "dibur-hamatchil" | "footnotes";
const DEFAULT: readonly [PairEngine, string, string, string][] = [
  // [engine, input source, input target, the gap it probes]
  ["dibur-hamatchil", "משנה שבת", "שבת", "MISHNAH_IN_TALMUD"],
  ["dibur-hamatchil", "משנה יבמות", "יבמות", "MISHNAH_IN_TALMUD"],
  ["dibur-hamatchil", "משנה בבא מציעא", "בבא מציעא", "MISHNAH_IN_TALMUD"],
  ["headings", "מדרש אגדה", "בראשית", "MIDRASH"],
  ["dibur-hamatchil", "מדרש אגדה", "בראשית", "MIDRASH"],
  ["headings", "מדרש תהילים", "תהילים", "MIDRASH"],
  ["headings", "תרגום ותפסיר רסג", "בראשית", "TARGUM"],
  ["headings", "בית יוסף", "טור", "COMMENTARY"],
  ["dibur-hamatchil", "בית יוסף", "טור", "COMMENTARY"],
  ["headings", "שער הציון", "משנה ברורה", "COMMENTARY"],
  ["footnotes", "משנה ברורה", "שער הציון", "COMMENTARY"],
  ["headings", "ביאור הגרא על תקוני הזהר", "תקוני הזהר מסודר על פי הגרא", "COMMENTARY"],
  ["dibur-hamatchil", "מחוקקי יהודה יהל אור", "אבן עזרא על שמות", "COMMENTARY"],
];
const PAIRS = process.env.BENCH_WHATIF
  ? process.env.BENCH_WHATIF.split(";").map((p) => [...p.split("|"), "?"] as [PairEngine, string, string, string])
  : DEFAULT;
const STEP_MS = Number(process.env.BENCH_STEP_S ?? 600) * 1000;

describe.runIf(DB)("library benchmark: what if the planner related these pairs", () => {
  const before = DB ? fingerprint(DB) : "";
  let registry: SourceRegistry;
  let books: SourceBook[];
  beforeAll(async () => {
    registry = new SourceRegistry();
    books = (await registry.open([{ path: "seforim.db", blob: await fileBlob(DB!) }])).sources[0]!.books;
  }, 600_000);
  afterAll(() => expect(fingerprint(DB!)).toBe(before));

  it("pair engines on unplanned pairs", async () => {
    const ref = (b: SourceBook): BookRef => ({ key: b.key, title: b.title, origin: b.origin, ...(b.isBaseBook !== undefined && { isBaseBook: b.isBaseBook }) });
    const rows: Record<string, unknown>[] = [];
    for (const [engine, s, t, gap] of PAIRS) {
      const a = books.find((b) => b.title === s);
      const b = books.find((x) => x.title === t);
      if (!a || !b) {
        rows.push({ engine, pair: `${s} → ${t}`, missing: true });
        continue;
      }
      const t0 = Date.now();
      const deadline = Date.now() + STEP_MS;
      const signal = { get aborted() { return Date.now() > deadline; }, throwIfAborted() {} } as unknown as AbortSignal;
      const res = await engineJob(registry, engine, ref(a), ref(b), {}, { signal });
      // the side scored is the book whose lines the database links (the dependant, or the notes book)
      const focus = engine === "footnotes" ? b : a;
      const other = focus === a ? b : a;
      const links = (await registry.existingLinks(focus.key, 0, Number.MAX_SAFE_INTEGER)).filter((l) => l.source.book.key === other.key || l.target.book.key === other.key);
      const db = indexDbLinks(focus.key, links, (type) => type);
      const sc = scoreBook(focus.key, res.suggestions.map((x) => ({ s: x, engines: [engine] })), db, () => undefined);
      const byType: Record<string, [number, number]> = {};
      for (const l of links) (byType[l.declaredType.toUpperCase()] ??= [0, 0])[0]++;
      for (const [k, ids] of sc.matched) byType[k.split("|")[0]!]![1] += ids.size;
      const byConf: Record<string, string> = {};
      for (const c of ["certain", "high", "possible", "ambiguous"]) {
        const xs = sc.scored.filter((x) => x.s.confidence === c);
        if (xs.length) byConf[c] = `${xs.filter((x) => x.verdict === "correct").length}/${xs.length} (${xs.filter((x) => x.verdict === "wrong").length} wrong)`;
      }
      rows.push({ gap, engine, pair: `${s} → ${t}`, ms: Date.now() - t0, stopped: res.notes.some((n) => n.code === "engine/aborted"), suggestions: res.suggestions.length, dbLinks: Object.fromEntries(Object.entries(byType).map(([k, [n, m]]) => [k, `${m}/${n} = ${n ? ((100 * m) / n).toFixed(1) : "0"}%`])), byConfidence: byConf });
      console.log(JSON.stringify(rows.at(-1)));
    }
    record("library-benchmark-whatif", rows);
  }, 6 * 3_600_000);
});
