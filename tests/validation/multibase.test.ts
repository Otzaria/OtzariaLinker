import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SourceBook } from "../../src/core/books";
import type { Suggestion } from "../../src/linking/automatic/types";
import { planMaxLink, type PlanBook, type PlanStep } from "../../src/linking/plan";
import { SourceRegistry } from "../../src/sources/registry";
import { maxlinkJob } from "../../src/workers/maxlink-job";
import { score, type GoldLink } from "./engine-harness";
import { cleanupTmp, DB, fileBlob, fingerprint, ms, oracle, record, tmpDir } from "./env";

/*
 * Check 5b — max-link on books the database declares on SEVERAL bases (book_base_text: חזקוני,
 * רבנו בחיי, שלטי הגיבורים on the Rif and the Ran…). Each base is linked only through the part of the
 * book headed by it (linking/sections.ts); without such a part only dibur-hamatchil runs, capped at
 * "possible" (workers/maxlink-job.ts runScoped). Scored per engine and per
 * TIER against the database's COMMENTARY links between the same two books (engine-harness.ts score).
 *
 *   OTZARIA_DB=… npx vitest run --config vitest.validation.config.ts tests/validation/multibase.test.ts
 *   VALIDATE_MULTIBASE_N=30   books in the sample (every k-th multi-base book by id, ≤ 20,000 lines)
 */
const N = Number(process.env.VALIDATE_MULTIBASE_N ?? 30);
const MAX_LINES = 20_000;
const GOLD_TYPES = ["COMMENTARY"];

type Tier = "section" | "dh-only" | "no-section";
const tierOf = (notes: readonly { code: string }[]): Tier =>
  notes.some((n) => n.code === "maxlink/section") ? "section" : notes.some((n) => n.code === "maxlink/dh-only") ? "dh-only" : "no-section";

describe.runIf(DB)("check 5b: max-link on books with several bases", () => {
  const before = DB ? fingerprint(DB) : "";
  let registry: SourceRegistry;
  let books: SourceBook[];
  const idOf = (key: string) => Number(key.slice(key.indexOf(":") + 1));

  beforeAll(async () => {
    registry = new SourceRegistry();
    const opened = await registry.open([{ path: "seforim.db", blob: await fileBlob(DB!) }]);
    books = opened.sources[0]!.books;
  });
  afterAll(() => {
    cleanupTmp();
    expect(fingerprint(DB!)).toBe(before);
  });

  it("per base, per tier: precision of certain/high and recall vs the database", async () => {
    const multi = books.filter((b) => (b.bases?.length ?? 0) > 1 && (b.lineCount ?? 0) > 0 && b.lineCount! <= MAX_LINES).sort((a, b) => idOf(a.key) - idOf(b.key));
    const step = Math.max(1, Math.floor(multi.length / N));
    const sample = multi.filter((_, i) => i % step === 0).slice(0, N);
    const library: PlanBook[] = books.map((b) => ({ key: b.key, title: b.title, origin: b.origin, ...(b.isBaseBook !== undefined && { isBaseBook: b.isBaseBook }), ...(b.bases && { bases: b.bases }), ...(b.dependence && { dependence: b.dependence }) }));
    const plan = planMaxLink({ selected: sample.map((b) => b.key), library, singleEngines: [] });
    const sampleKeys = new Set(sample.map((b) => b.key));
    const steps = plan.steps.filter((s): s is Extract<PlanStep, { kind: "pair" }> => s.kind === "pair" && sampleKeys.has(s.relation.dependant.key) && !!s.relation.scope);

    const q = join(tmpDir(), "multibase-pairs.json");
    const pairs = [...new Set(steps.map((s) => `${idOf(s.relation.dependant.key)}:${idOf(s.relation.base.key)}`))].map((k) => k.split(":").map(Number));
    writeFileSync(q, JSON.stringify(pairs));
    const gold = new Map((JSON.parse(readFileSync(oracle("gold", "multibase-gold.json", q), "utf8")) as { a: number; b: number; links: [number, string, number, number | null, number, number | null, boolean, number?][] }[]).map((g) => [`${g.a}:${g.b}`, g.links]));

    const t0 = performance.now();
    const res = await maxlinkJob(registry, steps, {}, {});
    const byStep = new Map(res.items.map((i) => [i.stepId, i]));

    type Cell = { steps: number; suggestions: number; certain: [number, number]; high: [number, number]; goldLines: number; recalledStrong: number; wrong: string[] };
    const cells: Record<string, Cell> = {};
    const errors: string[] = [];
    for (const s of steps) {
      const item = byStep.get(s.id)!;
      if (item.error) {
        errors.push(`${s.id}: ${item.error}`);
        continue;
      }
      const result = item.result!;
      const tier = tierOf(result.notes);
      const a = idOf(s.relation.dependant.key);
      const b = idOf(s.relation.base.key);
      const g: GoldLink[] = [];
      for (const [, type, aLine, aEnd, bLine, bEnd] of gold.get(`${a}:${b}`) ?? []) {
        if (!GOLD_TYPES.includes(type)) continue;
        for (let x = aLine; x <= (aEnd ?? aLine); x++) g.push({ from: x, toBook: b, to: bLine, toEnd: bEnd ?? bLine });
      }
      const sc = score(result.suggestions as Suggestion[], g, s.relation.dependant.key, idOf);
      const c = (cells[`${s.engine}/${tier}`] ??= { steps: 0, suggestions: 0, certain: [0, 0], high: [0, 0], goldLines: 0, recalledStrong: 0, wrong: [] });
      c.steps++;
      c.suggestions += sc.suggestions;
      c.certain[0] += sc.byConfidence.certain?.correct ?? 0;
      c.certain[1] += sc.byConfidence.certain?.judged ?? 0;
      c.high[0] += sc.byConfidence.high?.correct ?? 0;
      c.high[1] += sc.byConfidence.high?.judged ?? 0;
      // recall only where the tier ran (a skipped step has no suggestions by design)
      if (tier !== "no-section") (c.goldLines += sc.goldLines), (c.recalledStrong += sc.recalledStrong);
      for (const w of sc.wrong.slice(0, 2)) if (c.wrong.length < 6) c.wrong.push(`${s.relation.dependant.title} → ${s.relation.base.title}: ${w}`);
    }
    const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
    const summary = record("engine-multibase", {
      books: sample.length,
      steps: steps.length,
      ms: ms(t0),
      errors,
      cells: Object.fromEntries(
        Object.entries(cells).map(([k, c]) => [
          k,
          { steps: c.steps, suggestions: c.suggestions, certain: `${c.certain[0]}/${c.certain[1]} = ${pct(...c.certain)}`, high: `${c.high[0]}/${c.high[1]} = ${pct(...c.high)}`, recallStrong: `${pct(c.recalledStrong, c.goldLines)} of ${c.goldLines}`, wrong: c.wrong },
        ]),
      ),
      sample: sample.map((b) => `${b.title} (${b.bases!.length})`),
    });
    expect(summary.errors).toEqual([]);
  }, 1_800_000);
});
