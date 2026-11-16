import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { SourceBook } from "../../src/core/books";
import { declaredBaseTitle } from "../../src/core/links/titles";
import { titleIndex } from "../../src/linking/batch";
import { LINKED_MIN, linkedFields, linkedProps, planMaxLink, relationsOf, type LinkedEvidence, type PlanBook } from "../../src/linking/plan";
import { SourceRegistry } from "../../src/sources/registry";
import { DB, fileBlob, fingerprint } from "./env";
import { allocate, countBucket, ownerBooks, ownerOf, stratify, type Unit } from "./library-benchmark";

/*
 * The COMMENTARY links the max-link planner does not plan (the library benchmark's `U` owners of
 * COMMENTARY, LIBRARY_BENCHMARK.md §0.7): every (base, dependant) pair with COMMENTARY links between two
 * books the planner does not relate, with what the planner knows about both books — the relations it
 * gives each (relationsOf, or why none), the declaration, the title's base and the counted evidence —
 * and whether the pair is in the benchmark's sample (same seed and N). The planner is built exactly
 * as library-benchmark.test.ts builds it (all books selected, evidence from the oracle's counts), from
 * the oracle cached in BENCH_DIR by a benchmark run on the same database.
 *
 *   OTZARIA_DB=… BENCH_DIR=.bench/<dir> npx vitest run --config vitest.validation.config.ts tests/validation/planner-unplanned.test.ts --silent=false
 *
 * Writes <BENCH_DIR>/unplanned.json (the pairs and the sample's strata) and <BENCH_DIR>/plan-steps.tsv
 * (every pair step: id, dependant, base, COMMENTARY links between them, scope) — two plans' steps
 * diffed tell exactly which pairs a planner change adds or drops in the whole library.
 */
const DIR = resolve(process.env.BENCH_DIR ?? ".bench");
const SEED = process.env.BENCH_SEED ?? "otzaria-bench-1";
const N = Number(process.env.BENCH_N ?? 60);
const idOf = (key: string) => Number(key.slice(key.lastIndexOf(":") + 1));

describe.runIf(DB)("COMMENTARY pairs the max-link planner does not plan", () => {
  const before = DB ? fingerprint(DB) : "";
  let books: SourceBook[];
  beforeAll(async () => {
    const registry = new SourceRegistry();
    books = (await registry.open([{ path: "seforim.db", blob: await fileBlob(DB!) }])).sources[0]!.books;
  }, 600_000);
  afterAll(() => {
    if (fingerprint(DB!) !== before) throw new Error("the database changed during the run");
  });

  it("lists them, with the planner's view of both books", () => {
    const oracleFile = join(DIR, `oracle-${before.replace(/[^0-9a-z]/gi, "_")}.json`);
    if (!existsSync(oracleFile)) throw new Error(`no oracle for this database in ${DIR}: run library-benchmark.test.ts there first (BENCH_DRY=1 is enough)`);
    const data = JSON.parse(readFileSync(oracleFile, "utf8")) as { books: Record<string, [string, number]>; rows: [string, number, number, number][] };
    const byId = new Map(books.map((b) => [idOf(b.key), b]));
    const keyOfId = (id: number) => byId.get(id)?.key;
    // as library-benchmark.test.ts: default_commentator, and the oracle's counts as complete evidence
    const evidence: LinkedEvidence[] = books.flatMap((b) => (b.linkedBases ?? []).map((base) => ({ dependant: b.key, base })));
    for (const [type, s, t, n] of data.rows) {
      const base = keyOfId(s);
      const dependant = keyOfId(t);
      if (!base || !dependant || s === t) continue;
      if (type === "COMMENTARY") evidence.push({ dependant, base, count: n, complete: true });
      else if ((type === "TARGUM" || type === "MIDRASH") && n >= LINKED_MIN) evidence.push({ dependant, base, kind: type === "TARGUM" ? "targum" : "midrash", count: n, complete: true });
    }
    const fields = linkedFields(evidence);
    const library: PlanBook[] = books.map((b) => {
      const f = fields.get(b.key);
      return { key: b.key, title: b.title, origin: b.origin, ...(b.isBaseBook !== undefined && { isBaseBook: b.isBaseBook }), ...(b.bases && { bases: b.bases }), ...(b.dependence && { dependence: b.dependence }), ...linkedProps(f) };
    });
    const plan = planMaxLink({ selected: books.map((b) => b.key), library, singleEngines: [] });
    const related = new Set<string>();
    const comm = new Map<string, number>();
    for (const [type, s, t, n] of data.rows) if (type === "COMMENTARY") comm.set(`${t}>${s}`, n);
    const stepRows: string[] = [];
    for (const s of plan.steps) {
      if (s.kind !== "pair") continue;
      const pair = `${idOf(s.relation.dependant.key)}>${idOf(s.relation.base.key)}`;
      related.add(pair);
      stepRows.push([s.id, s.relation.dependant.title, s.relation.base.title, comm.get(pair) ?? 0, JSON.stringify({ scope: s.relation.scope, dhOnly: s.relation.dhOnly, options: s.options })].join("\t"));
    }
    writeFileSync(join(DIR, "plan-steps.tsv"), stepRows.sort().join("\n") + "\n");
    const isRelated = (dep: number, base: number) => related.has(`${dep}>${base}`);
    const byKey = new Map(library.map((b) => [b.key, b]));
    const index = titleIndex(library);
    const relationsText = (id: number) => {
      const b = byKey.get(byId.get(id)?.key ?? "");
      if (!b) return "(not in the library)";
      const r = relationsOf(b, byKey, index);
      return "problem" in r ? `PROBLEM: ${r.problem}` : r.map((x) => `${x.kind}/${x.via}→${x.base.title}${x.scope ? `[${x.scope.section}]` : ""}${x.through ? "(through)" : ""}${x.dhOnly ? `(dh:${x.dhOnly})` : ""}`).join(" | ");
    };
    // the COMMENTARY U owners and the benchmark's sample of them (library-benchmark.test.ts strataOf)
    const owned = new Map<string, number>();
    for (const [type, s, t, n] of data.rows) {
      if (type !== "COMMENTARY") continue;
      const o = ownerOf(type, s, t, isRelated);
      if (o[0] === "U") owned.set(o, (owned.get(o) ?? 0) + n);
    }
    const top = (id: number) => data.books[String(id)]?.[0] ?? "?";
    const units: Unit[] = [...owned].map(([o, n]) => {
      const [a, b] = ownerBooks(o) as [number, number];
      return { id: o, stratum: `${[top(a), top(b)].sort().join("~")}|${countBucket(n)}`, links: n };
    });
    const strata = stratify(units, `${SEED}|COMMENTARY|U`);
    const alloc = allocate(strata, N);
    const chosen = (name: string) => strata.find((s) => s.name === name)!.units.slice(0, alloc.get(name) ?? 0);
    const sampled = new Set(strata.flatMap((st) => chosen(st.name).map((u) => u.id)));
    const rows: Record<string, unknown>[] = [];
    for (const [type, s, t, n] of data.rows) {
      if (type !== "COMMENTARY") continue;
      const owner = ownerOf(type, s, t, isRelated);
      if (owner[0] !== "U") continue;
      const dep = byKey.get(byId.get(t)?.key ?? "");
      rows.push({
        owner,
        sampled: sampled.has(owner),
        n,
        // COMMENTARY links are stored base → commentary
        base: byId.get(s)?.title ?? `#${s}`,
        dep: dep?.title ?? `#${t}`,
        baseId: s,
        depId: t,
        baseIsBase: byKey.get(byId.get(s)?.key ?? "")?.isBaseBook,
        depIsBase: dep?.isBaseBook,
        depDeclared: dep?.bases?.map((k) => byKey.get(k)?.title ?? k),
        depTitleBase: dep ? declaredBaseTitle(dep.title) : null,
        depLinked: dep?.linkedBases?.map((k) => `${byKey.get(k)?.title}:${dep.linkedCounts?.[k] ?? "?"}${dep.linkedKinds?.[k] ? `/${dep.linkedKinds[k]}` : ""}`),
        depRel: relationsText(t),
        baseRel: relationsText(s),
      });
    }
    rows.sort((a, b) => (b.n as number) - (a.n as number));
    const links = units.reduce((a, u) => a + u.links, 0);
    const strataOut = strata.map((st) => ({ name: st.name, links: st.links, population: st.units.length, chosen: chosen(st.name).map((u) => [u.id, u.links]) }));
    writeFileSync(join(DIR, "unplanned.json"), JSON.stringify({ db: before, seed: SEED, n: N, pairs: units.length, links, sampled: [...sampled], strata: strataOut, rows }, null, 1));
    console.log(`unplanned COMMENTARY: ${units.length} book pairs, ${links} links; ${sampled.size} pairs in the sample`);
    for (const r of rows.slice(0, 40)) console.log(`${String(r.n).padStart(6)} ${r.sampled ? "S" : " "} ${r.dep} ← ${r.base}   [${String(r.depRel).slice(0, 120)}]`);
  }, 3_600_000);
});
