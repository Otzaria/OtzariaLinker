import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, it } from "vitest";
import type { EngineId } from "../../src/linking/automatic/types";
import { mergeSuggestions, type MergedSuggestion, type MergeItem } from "../../src/linking/merge";
import { addCounters, CONFIDENCES, count, detailRows, scoreBook, type Counters, type DbEnd } from "./library-benchmark";

/*
 * The merge of the library benchmark again, without the database and without the engines: the raw
 * engine outputs a benchmark run kept (BENCH_RAW=1 → <BENCH_DIR>/raw/<id>.json.gz) and what scoring
 * needs at their lines (a BENCH_MODE=replay run → <BENCH_DIR>/score/<id>.json.gz) are merged with the
 * current src/linking/merge.ts and scored as the benchmark scores them (library-benchmark.ts scoreBook),
 * in both counting modes. A change to the merge is measured in seconds (docs/AUTOMATION_ENGINE.md §5.3).
 *
 *   BENCH_DIR=.bench/<dir> npx vitest run --config vitest.validation.config.ts tests/validation/merge-replay.test.ts --silent=false
 *
 *   BENCH_SETS   a JSON file { "<set>": [book ids] } (default <BENCH_DIR>/sets.json): one table per set, and "all"
 *   BENCH_TAG    writes <BENCH_DIR>/merge-<tag>.json (the counters per book) and detail-<tag>.jsonl.gz
 *                (library-benchmark.ts detailRows); with BENCH_ROWS=1 also rows-<tag>.jsonl.gz, one short row per
 *                structural suggestion
 */
const DIR = process.env.BENCH_DIR ? resolve(process.env.BENCH_DIR) : undefined;
const TAG = process.env.BENCH_TAG;
const ROWS = !!process.env.BENCH_ROWS;

describe.runIf(DIR && existsSync(join(DIR, "score")))("merge replay: the benchmark's raw engine outputs merged again", () => {
  it("per tier, per set", async () => {
    const dir = DIR!;
    const setsFile = process.env.BENCH_SETS ?? join(dir, "sets.json");
    const sets: Record<string, number[]> = existsSync(setsFile) ? (JSON.parse(readFileSync(setsFile, "utf8")) as Record<string, unknown>) as Record<string, number[]> : {};
    const ids = readdirSync(join(dir, "score")).map((f) => Number(f.split(".")[0])).sort((a, b) => a - b);
    const perBook: Record<string, { all: Counters; written: Counters; stats: unknown }> = {};
    const detail: string[] = [];
    const rows: string[] = [];
    for (const id of ids) {
      const raw = JSON.parse(gunzipSync(readFileSync(join(dir, "raw", `${id}.json.gz`))).toString("utf8")) as { items: MergeItem[]; ref: string[] };
      const cache = JSON.parse(gunzipSync(readFileSync(join(dir, "score", `${id}.json.gz`))).toString("utf8")) as { key: string; byLine: [number, DbEnd[]][]; pairType: [number, string][]; text: [number, string][] };
      const merged = mergeSuggestions(raw.items, { reference: new Set(raw.ref) });
      const db = { byLine: new Map(cache.byLine), pairType: new Map(cache.pairType) };
      const text = new Map(cache.text);
      const spanIdOf = (s: MergedSuggestion) => s.members.find((m) => m.suggestion.engine === "citations" && /@\d+-\d+>/.test(m.suggestion.id))?.suggestion.id ?? s.id;
      const list = merged.suggestions.map((s) => ({ s, engines: s.engines as EngineId[], spanId: spanIdOf(s) }));
      const a = scoreBook(cache.key, list, db, (l) => text.get(l), "all");
      const w = scoreBook(cache.key, list, db, (l) => text.get(l), "citations");
      perBook[id] = { all: count(a.scored), written: count(w.scored), stats: merged.stats };
      if (TAG) await detailRows(id, a.scored, w.scored, db.byLine, detail, null);
      // BENCH_ROWS=1: every structural suggestion as [book, line, other book, other line, confidence, verdict (all), verdict (written), engines]
      if (TAG && ROWS) {
        const vw = new Map(w.scored.map((x) => [x.s.id, x.verdict]));
        for (const x of a.scored) if (x.group === "structural") rows.push(JSON.stringify([id, x.bLine, x.other, x.oFrom, x.s.confidence, x.verdict, vw.get(x.s.id), x.engines]));
      }
    }
    const lines: string[] = [`merge replay: ${ids.length} books${TAG ? ` (${TAG})` : ""}`];
    const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
    for (const [name, members] of [...Object.entries(sets).filter(([, v]) => Array.isArray(v)), ["all", ids] as [string, number[]]]) {
      const inSet = new Set(members);
      for (const mode of ["all", "written"] as const) {
        const c: Counters = {};
        for (const id of ids) if (inSet.has(id)) addCounters(c, perBook[id]![mode]);
        lines.push(`${name} — ${mode === "all" ? "BENCH_SPANS=all" : "BENCH_SPANS=citations"}`);
        for (const g of ["structural", "citations"])
          for (const conf of CONFIDENCES) {
            const t = [0, 0, 0, 0];
            for (const [k, v] of Object.entries(c)) if (k.startsWith(`${g}|${conf}|`)) for (let i = 0; i < 4; i++) t[i]! += v[i]!;
            const [n, ok, bad, fresh] = t as [number, number, number, number];
            if (n) lines.push(`  ${`${g}|${conf}`.padEnd(22)} n=${String(n).padStart(7)}  strict ${pct(ok / n).padStart(6)}  judged ${pct(ok + bad ? ok / (ok + bad) : 0).padStart(6)}  correct ${String(ok).padStart(7)}  wrong ${String(bad).padStart(6)}  new ${fresh}`);
          }
      }
    }
    console.log(lines.join("\n"));
    if (TAG) {
      writeFileSync(join(dir, `merge-${TAG}.json`), JSON.stringify(perBook));
      writeFileSync(join(dir, `detail-${TAG}.jsonl.gz`), gzipSync(detail.join("\n")));
      if (ROWS) writeFileSync(join(dir, `rows-${TAG}.jsonl.gz`), gzipSync(rows.join("\n")));
    }
  }, 3_600_000);
});
