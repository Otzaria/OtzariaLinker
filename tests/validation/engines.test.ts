import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SourceBook } from "../../src/core/books";
import type { BookRef } from "../../src/core/links/model";
import { SourceRegistry } from "../../src/sources/registry";
import { ENGINE_CASES, score, type GoldLink, type Scored } from "./engine-harness";
import { decodeText } from "../../src/core/text/decode";
import { sourceTitleFromLinksFileName, titleFromPath2 } from "../../src/core/links/titles";
import { parseLinksJson } from "../../src/formats/links-json/parse";
import { cleanupTmp, DB, fileBlob, fingerprint, gitBlobs, gitFiles, LIBRARY, ms, oracle, record, tmpDir } from "./env";

/*
 * Check 5 — the automatic engines on real commentary pairs of the database, scored against the
 * links the database already has between the same two books (engine-harness.ts).
 *
 * Pairs: scripts/validation/db_oracle.py `pairs` — book_base_text and "X על Y" titles, stratified by
 * category, Sefaria/Otzaria and origin, both books within size limits, at least 30 COMMENTARY links.
 * Precision per confidence = correct / judged (judged: the commentary line has a gold link). Recall:
 * gold commentary lines with a correct certain/high suggestion (and with any suggestion).
 * The engines run through engineJob — the worker's own path, on the lines the registry returns.
 *
 *   OTZARIA_DB=… npx vitest run --config vitest.validation.config.ts tests/validation/engines.test.ts
 *   VALIDATE_ENGINES=headings,dibur-hamatchil   (default: every case in ENGINE_CASES)
 *   VALIDATE_PAIRS_STRIDE=104729   a HELD-OUT sample: another fixed stride through the same groups,
 *                                  without the main sample's pairs (results go to engine-<id>-heldout)
 */
const ONLY = process.env.VALIDATE_ENGINES?.split(",");
const FOOTNOTE_PAIRS = 12;
const STRIDE = process.env.VALIDATE_PAIRS_STRIDE;
const SINGLE_BOOKS = (process.env.VALIDATE_CITATION_BOOKS ?? "משנה ברורה;ספר החינוך;מסילת ישרים").split(";");

interface Pair { commentary: number; base: number; origin: string; top: string; sefaria: boolean; gold: number; titles: [string, string]; lines: [number, number] }

describe.runIf(DB)("check 5: engines vs the links already in the database", () => {
  const before = DB ? fingerprint(DB) : "";
  let registry: SourceRegistry;
  let byId: Map<number, SourceBook>;
  let pairs: Pair[];
  let gold: Map<string, [number, string, number, number | null, number, number | null, boolean, number?][]>;
  const refOf = (id: number): BookRef => {
    const b = byId.get(id)!;
    return { key: b.key, title: b.title, origin: b.origin, ...(b.isBaseBook !== undefined && { isBaseBook: b.isBaseBook }) };
  };
  const idOf = (key: string) => Number(key.slice(key.indexOf(":") + 1));

  beforeAll(async () => {
    registry = new SourceRegistry();
    const opened = await registry.open([{ path: "seforim.db", blob: await fileBlob(DB!) }]);
    byId = new Map(opened.sources[0]!.books.map((b) => [idOf(b.key), b]));
    pairs = (JSON.parse(readFileSync(STRIDE ? oracle("pairs", "pairs.json", "36", "12000", "30000", "30", STRIDE) : oracle("pairs", "pairs.json"), "utf8")) as { pairs: Pair[] }).pairs;
    const singles = SINGLE_BOOKS.map((t) => [...byId.values()].find((b) => b.title === t)).filter((b): b is SourceBook => !!b).map((b) => [idOf(b.key), null]);
    const q = join(tmpDir(), "gold-pairs.json");
    writeFileSync(q, JSON.stringify([...pairs.map((p) => [p.commentary, p.base]), ...(ENGINE_CASES.some((c) => c.pairs === "single-book") ? singles : [])]));
    gold = new Map((JSON.parse(readFileSync(oracle("gold", "gold.json", q), "utf8")) as { a: number; b: number | null; links: [number, string, number, number | null, number, number | null, boolean, number?][] }[]).map((g) => [`${g.a}:${g.b}`, g.links]));
  });
  afterAll(() => {
    cleanupTmp();
    expect(fingerprint(DB!)).toBe(before);
  });

  /**
   * A main book and its "הערות על" companion from the library clone, opened as text the way a user
   * drops them, scored against the library's own footnote records (line_index_1 → line_index_2).
   */
  async function footnotePairs(c: (typeof ENGINE_CASES)[number]): Promise<void> {
    if (!LIBRARY) return void record(`engine-${c.id}`, { engine: c.id, skipped: "needs OTZARIA_LIBRARY" });
    const sync = JSON.parse(readFileSync(join(LIBRARY, "manual_links_sync.json"), "utf8")) as { links_roots: { path: string; expected_state: string }[] };
    const roots = sync.links_roots.filter((r) => r.expected_state === "present").map((r) => r.path);
    const texts = gitFiles(LIBRARY, (p) => p.endsWith(".txt") && /\/ספרים\/אוצריא\//.test(p));
    const txtOf = (root: string, title: string) => texts.find((t) => t.path.startsWith(`${root.split("/")[0]}/`) && t.path.split("/").at(-1) === `${title}.txt`);
    const candidates: { file: string; main: (typeof texts)[number]; notes: (typeof texts)[number]; gold: GoldLink[] }[] = [];
    for (const [f, bytes] of gitBlobs(LIBRARY, gitFiles(LIBRARY, (p) => p.endsWith("_links.json") && roots.some((r) => p.startsWith(`${r}/`))))) {
      const text = decodeText(bytes).text;
      if (!/"Conection Type"\s*:\s*"footnote/i.test(text)) continue;
      const recs = parseLinksJson(text).records.filter((r) => c.goldTypes.includes(r.connectionType.trim().toLowerCase()));
      const byTarget = new Map<string, typeof recs>();
      for (const r of recs) {
        const t = titleFromPath2(r.path_2);
        const list = byTarget.get(t);
        if (list) list.push(r);
        else byTarget.set(t, [r]);
      }
      const [target, list] = [...byTarget].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
      if (!target || !list || list.length < 20) continue;
      const root = roots.find((r) => f.path.startsWith(`${r}/`))!;
      const main = txtOf(root, sourceTitleFromLinksFileName(f.path)!);
      const notes = txtOf(root, target);
      if (!main || !notes) continue;
      candidates.push({ file: f.path, main, notes, gold: list.map((r) => ({ from: Math.max(0, Math.trunc(r.line_index_1) - 1), toBook: 1, to: Math.max(0, Math.trunc(r.line_index_2) - 1), toEnd: Math.max(0, Math.trunc(r.line_index_2_end ?? r.line_index_2) - 1) })) });
    }
    const chosen = Array.from({ length: Math.min(FOOTNOTE_PAIRS, candidates.length) }, (_, j) => candidates[Math.floor((j * candidates.length) / Math.min(FOOTNOTE_PAIRS, candidates.length))]!);
    const rows: (Scored & { pair: string; ms: number; error?: string })[] = [];
    for (const p of chosen) {
      const reg = new SourceRegistry();
      const blobs = [...gitBlobs(LIBRARY, [p.main, p.notes])].map(([f, b]) => ({ path: f.path.split("/").at(-1)!, blob: new Blob([new Uint8Array(b)]) }));
      const opened = await reg.open(blobs);
      const books = opened.sources.flatMap((s) => s.books);
      const main = books.find((b) => b.path === blobs[0]!.path)!;
      const notes = books.find((b) => b.path === blobs[1]!.path)!;
      const t0 = performance.now();
      const pair = `${main.title} → ${notes.title}`;
      try {
        const s = await c.run({ registry: reg, source: { key: main.key, title: main.title, origin: main.origin }, target: { key: notes.key, title: notes.title, origin: notes.origin } });
        rows.push({ pair, ms: ms(t0), ...score(s, p.gold, main.key, (k) => (k === notes.key ? 1 : 0)) });
      } catch (err) {
        rows.push({ pair, ms: ms(t0), error: String(err), suggestions: 0, byConfidence: {}, goldLines: 0, recalledStrong: 0, recalledAny: 0, wrong: [] });
      }
    }
    summarize(c, rows, { candidates: candidates.length });
  }

  function summarize(c: (typeof ENGINE_CASES)[number], rows: (Scored & { pair: string; ms: number; error?: string })[], extra: Record<string, unknown> = {}) {
    const total: Record<string, { n: number; judged: number; correct: number; precision: string }> = {};
    for (const r of rows)
      for (const [conf, v] of Object.entries(r.byConfidence)) {
        const t = (total[conf] ??= { n: 0, judged: 0, correct: 0, precision: "" });
        t.n += v.n;
        t.judged += v.judged;
        t.correct += v.correct;
      }
    for (const t of Object.values(total)) t.precision = pct(t.correct, t.judged);
    const goldLines = rows.reduce((n, r) => n + r.goldLines, 0);
    const summary = record(`engine-${c.id}${STRIDE && c.pairs === "pair" ? "-heldout" : ""}`, {
      engine: c.id,
      ...(STRIDE && c.pairs === "pair" && { stride: Number(STRIDE) }),
      goldTypes: c.goldTypes,
      ...extra,
      pairs: rows.length,
      errors: rows.filter((r) => r.error).map((r) => `${r.pair}: ${r.error}`),
      byConfidence: total,
      recall: { goldLines, strong: pct(rows.reduce((n, r) => n + r.recalledStrong, 0), goldLines), any: pct(rows.reduce((n, r) => n + r.recalledAny, 0), goldLines) },
      perPair: rows.map((r) => ({
        pair: r.pair,
        ms: r.ms,
        suggestions: r.suggestions,
        certainHigh: `${(r.byConfidence.certain?.correct ?? 0) + (r.byConfidence.high?.correct ?? 0)}/${(r.byConfidence.certain?.judged ?? 0) + (r.byConfidence.high?.judged ?? 0)}`,
        recall: pct(r.recalledStrong, r.goldLines),
        goldLines: r.goldLines,
        wrong: r.wrong.slice(0, 4),
      })),
    });
    expect(summary.errors).toEqual([]);
  }

  for (const c of ENGINE_CASES.filter((x) => !ONLY || ONLY.includes(x.id))) {
    it(`${c.id}`, async () => {
      const rows: (Scored & { pair: string; ms: number; error?: string })[] = [];
      if (c.pairs === "library-footnotes") return void (await footnotePairs(c));
      const jobs = c.pairs === "pair" ? pairs.map((p) => ({ a: p.commentary, b: p.base as number | null })) : SINGLE_BOOKS.map((t) => [...byId.values()].find((b) => b.title === t)).filter((b): b is SourceBook => !!b).map((b) => ({ a: idOf(b.key), b: null }));
      for (const { a, b } of jobs) {
        const links = gold.get(`${a}:${b}`) ?? [];
        const g: GoldLink[] = [];
        for (const [, type, aLine, aEnd, bLine, bEnd, , tb] of links) {
          if (!c.goldTypes.includes(type)) continue;
          for (let x = aLine; x <= (aEnd ?? aLine); x++) g.push({ from: x, toBook: b ?? tb!, to: bLine, toEnd: bEnd ?? bLine });
        }
        const t0 = performance.now();
        try {
          const s = await c.run({ registry, source: refOf(a), ...(b !== null && { target: refOf(b) }) });
          rows.push({ pair: `${byId.get(a)!.title} → ${b === null ? "*" : byId.get(b)!.title}`, ms: ms(t0), ...score(s, g, byId.get(a)!.key, idOf) });
        } catch (err) {
          rows.push({ pair: `${byId.get(a)!.title} → ${b === null ? "*" : byId.get(b)!.title}`, ms: ms(t0), error: String(err), suggestions: 0, byConfidence: {}, goldLines: 0, recalledStrong: 0, recalledAny: 0, wrong: [] });
        }
      }
      summarize(c, rows);
    });
  }
});

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
