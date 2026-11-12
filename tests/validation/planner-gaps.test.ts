import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SourceBook } from "../../src/core/books";
import type { EngineId } from "../../src/linking/automatic/types";
import { evidenceFromCounts, linkedFields, planMaxLink, type LinkedEvidence, type PlanBook, type PlanStep } from "../../src/linking/plan";
import { SourceRegistry } from "../../src/sources/registry";
import { mergeSuggestions, type MergeItem } from "../../src/linking/merge";
import { maxlinkJob } from "../../src/workers/maxlink-job";
import { DB, fileBlob, fingerprint, record } from "./env";
import { indexDbLinks, scoreBook } from "./library-benchmark";

/*
 * The max-link planner on chosen books, the way the app runs it: the evidence pass (link summary →
 * evidenceFromCounts), planMaxLink with the selected books, maxlinkJob on the pair steps whose
 * dependant was selected. The steps of one pair are merged as the app merges them (merge.ts, with the
 * database's links as the calibration reference), then scored against EVERY link the database has
 * between the two books (library-benchmark.ts scoreBook: "correct" = the database links that line to
 * an intersecting place, "wrong" = it links the line to the same book elsewhere). Used for the planner
 * gaps of
 * docs/validation/LIBRARY_BENCHMARK.md §8 row 5 (docs/AUTOMATION_ENGINE.md §5.1).
 *
 *   OTZARIA_DB=… BENCH_SELECT="משנה שבת;תרגום ותפסיר רסג" npx vitest run --config vitest.validation.config.ts tests/validation/planner-gaps.test.ts --silent=false
 *   BENCH_ENGINES="dibur-hamatchil"   only these pair engines
 */
const SELECT = (process.env.BENCH_SELECT ?? "משנה שבת;משנה יבמות;משנה בבא מציעא;תרגום ותפסיר רסג;מדרש אגדה").split(";").map((s) => s.trim()).filter(Boolean);
const ENGINES = process.env.BENCH_ENGINES ? new Set(process.env.BENCH_ENGINES.split(",") as EngineId[]) : undefined;

type Cell = { certain: [number, number, number]; high: [number, number, number]; possible: [number, number, number]; ambiguous: [number, number, number] };

describe.runIf(DB)("max-link planner gaps on the real database", () => {
  const before = DB ? fingerprint(DB) : "";
  let registry: SourceRegistry;
  let books: SourceBook[];
  beforeAll(async () => {
    registry = new SourceRegistry();
    books = (await registry.open([{ path: "seforim.db", blob: await fileBlob(DB!) }])).sources[0]!.books;
  }, 600_000);
  afterAll(() => expect(fingerprint(DB!)).toBe(before));

  it("plan, run and score the selected books", async () => {
    const byTitle = new Map(books.map((b) => [b.title, b] as const));
    const selected = SELECT.map((t) => byTitle.get(t)).filter((b): b is SourceBook => !!b);
    const keys = new Set(books.map((b) => b.key));
    const evidence: LinkedEvidence[] = books.flatMap((b) => (b.linkedBases ?? []).map((base) => ({ dependant: b.key, base })));
    for (const b of selected) {
      const s = await registry.dbLinkSummary(b.key);
      if ("byBook" in s) evidence.push(...evidenceFromCounts(b.key, s.byBook).filter((e) => keys.has(e.dependant) && keys.has(e.base)));
    }
    const fields = linkedFields(evidence);
    const library: PlanBook[] = books.map((b) => {
      const f = fields.get(b.key);
      return { key: b.key, title: b.title, origin: b.origin, ...(b.isBaseBook !== undefined && { isBaseBook: b.isBaseBook }), ...(b.bases && { bases: b.bases }), ...(b.dependence && { dependence: b.dependence }), ...(f && { linkedBases: f.linkedBases }), ...(f && Object.keys(f.linkedKinds).length && { linkedKinds: f.linkedKinds }) };
    });
    const sel = new Set(selected.map((b) => b.key));
    const plan = planMaxLink({ selected: [...sel], library, singleEngines: [], ...(ENGINES && { engines: ENGINES }) });
    const steps = plan.steps.filter((s): s is Extract<PlanStep, { kind: "pair" }> => s.kind === "pair" && sel.has(s.relation.dependant.key));
    for (const r of plan.books) console.log(JSON.stringify({ book: r.book.title, steps: r.steps, decisions: r.decisions, skipped: r.skipped }));

    // one pair at a time, all its steps together, merged as the app merges them (state/maxlink.ts): the
    // database's links of the two books as the calibration reference (merge.ts REFERENCE_DISAGREEMENT)
    const byPair = new Map<string, Extract<PlanStep, { kind: "pair" }>[]>();
    for (const s of steps) {
      const k = `${s.relation.dependant.key}>${s.relation.base.key}`;
      byPair.set(k, [...(byPair.get(k) ?? []), s]);
    }
    const rows: Record<string, unknown>[] = [];
    const total: Record<string, [number, number, number]> = {};
    for (const group of byPair.values()) {
      const t0 = Date.now();
      const res = await maxlinkJob(registry, group, {}, {});
      const items: MergeItem[] = [];
      for (const it of res.items) for (const sg of it.result?.suggestions ?? []) items.push({ suggestion: sg, focus: group.find((s) => s.id === it.stepId)!.source.key });
      const merged = mergeSuggestions(items, { reference: new Set(res.dbLinkKeys) });
      const ms = Date.now() - t0;
      const dep = group[0]!.relation.dependant;
      const base = group[0]!.relation.base;
      const links = (await registry.existingLinks(dep.key, 0, Number.MAX_SAFE_INTEGER)).filter((l) => l.source.book.key === base.key || l.target.book.key === base.key);
      const db = indexDbLinks(dep.key, links, (type) => type);
      const sc = scoreBook(dep.key, merged.suggestions.map((s) => ({ s, engines: s.engines })), db, () => undefined);
      const cell: Cell = { certain: [0, 0, 0], high: [0, 0, 0], possible: [0, 0, 0], ambiguous: [0, 0, 0] };
      for (const x of sc.scored) {
        const c = cell[x.s.confidence as keyof Cell];
        if (!c) continue;
        c[0]++;
        if (x.verdict === "correct") c[1]++;
        else if (x.verdict === "wrong") c[2]++;
        const t = (total[x.s.confidence] ??= [0, 0, 0]);
        t[0]++;
        if (x.verdict === "correct") t[1]++;
        else if (x.verdict === "wrong") t[2]++;
      }
      const dbByType = new Map<string, number>();
      for (const l of links) dbByType.set(l.declaredType.toUpperCase(), (dbByType.get(l.declaredType.toUpperCase()) ?? 0) + 1);
      const matched = (t: string) => [...sc.matched].filter(([k]) => k.startsWith(`${t}|`)).reduce((a, [, s]) => a + s.size, 0);
      rows.push({
        pair: `${dep.title} → ${base.title}`,
        engines: group.map((s) => s.engine),
        ms,
        errors: res.items.filter((i) => i.error).map((i) => i.error),
        notes: [...new Set(res.items.flatMap((i) => i.result?.notes.filter((n) => n.code.startsWith("maxlink/") || n.code.startsWith("footnotes/positional")).map((n) => n.code) ?? []))],
        merged: merged.suggestions.length,
        contradicted: merged.stats.contradictedPairs,
        byConf: Object.fromEntries(Object.entries(cell).filter(([, c]) => c[0]).map(([k, [n, ok, bad]]) => [k, `${ok}/${n} correct, ${bad} wrong`])),
        recall: Object.fromEntries([...dbByType].map(([t, n]) => [t, `${matched(t)}/${n}`])),
      });
      console.log(JSON.stringify(rows.at(-1)));
    }
    console.log("TOTAL", JSON.stringify(Object.fromEntries(Object.entries(total).map(([k, [n, ok, bad]]) => [k, `${ok}/${n} correct, ${bad} wrong`]))));
    record("planner-gaps", { selected: SELECT, pairs: rows, total });
  }, 6 * 3_600_000);
});
