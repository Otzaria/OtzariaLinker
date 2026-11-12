import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SourceBook } from "../../src/core/books";
import { LINKED_MIN, linkedFields, linkedProps, planMaxLink, type LinkedEvidence, type PlanBook } from "../../src/linking/plan";
import { SourceRegistry } from "../../src/sources/registry";
import { DB, fileBlob, fingerprint } from "./env";

/*
 * The planner against the database's own COMMENTARY links, without running any engine: which
 * COMMENTARY links (stored base → dependant) fall between a dependant and a book the planner does NOT
 * relate it to, when the dependant HAS a relation (by its declaration or its title). These are the
 * links "the title names the wrong base" loses (docs/AUTOMATION_ENGINE.md §5.1). Each unplanned base X
 * is classified by how it stands to the dependant's planned bases B:
 *   sibling   X is itself written on some B (a commentary on the same base: פסקי הרא"ש על ברכות for
 *             מעדני יום טוב על ברכות, ספרא for מלבי"ם על ויקרא)
 *   other     anything else
 * Reads the oracle population (BENCH_DIR/oracle-*.json, as library-benchmark.test.ts writes it).
 *
 *   OTZARIA_DB=… BENCH_DIR=.bench/plan3 npx vitest run --config vitest.validation.config.ts tests/validation/planner-evidence.test.ts --silent=false
 */
const DIR = resolve(process.env.BENCH_DIR ?? ".bench");
const TOP = Number(process.env.EVIDENCE_TOP ?? 80);
const idOf = (key: string) => Number(key.slice(key.lastIndexOf(":") + 1));

describe.runIf(DB)("planner vs the database's COMMENTARY evidence", () => {
  const before = DB ? fingerprint(DB) : "";
  let books: SourceBook[];
  beforeAll(async () => {
    const registry = new SourceRegistry();
    books = (await registry.open([{ path: "seforim.db", blob: await fileBlob(DB!) }])).sources[0]!.books;
  }, 600_000);
  afterAll(() => expect(fingerprint(DB!)).toBe(before));

  it("unplanned COMMENTARY links at related dependants", () => {
    const file = readdirSync(DIR).find((f) => f.startsWith("oracle-") && f.endsWith(".json"));
    if (!file || !existsSync(join(DIR, file))) throw new Error(`no oracle-*.json in ${DIR}`);
    const data = JSON.parse(readFileSync(join(DIR, file), "utf8")) as { rows: [string, number, number, number][] };
    const byId = new Map(books.map((b) => [idOf(b.key), b] as const));
    const keyOfId = (id: number) => byId.get(id)?.key;
    const evidence: LinkedEvidence[] = books.flatMap((b) => (b.linkedBases ?? []).map((base) => ({ dependant: b.key, base })));
    const counts = new Map<string, number>(); // "dep>base" → COMMENTARY links
    for (const [type, s, t, n] of data.rows) {
      const base = keyOfId(s);
      const dependant = keyOfId(t);
      if (!base || !dependant || s === t) continue;
      if (type === "COMMENTARY") {
        evidence.push({ dependant, base, count: n, complete: true });
        counts.set(`${dependant}>${base}`, (counts.get(`${dependant}>${base}`) ?? 0) + n);
      } else if ((type === "TARGUM" || type === "MIDRASH") && n >= LINKED_MIN) evidence.push({ dependant, base, kind: type === "TARGUM" ? "targum" : "midrash", count: n, complete: true });
    }
    const fields = linkedFields(evidence);
    const library: PlanBook[] = books.map((b) => {
      const f = fields.get(b.key);
      return { key: b.key, title: b.title, origin: b.origin, ...(b.isBaseBook !== undefined && { isBaseBook: b.isBaseBook }), ...(b.bases && { bases: b.bases }), ...(b.dependence && { dependence: b.dependence }), ...linkedProps(f) };
    });
    const plan = planMaxLink({ selected: books.map((b) => b.key), library, singleEngines: [] });
    const planned = new Map<string, Set<string>>(); // dep → bases
    const via = new Map<string, string>(); // "dep>base" → via
    for (const s of plan.steps)
      if (s.kind === "pair") {
        const d = s.relation.dependant.key;
        (planned.get(d) ?? planned.set(d, new Set()).get(d)!).add(s.relation.base.key);
        via.set(`${d}>${s.relation.base.key}`, s.relation.via + (s.relation.through ? "+through" : "") + (s.relation.scope ? "+scope" : ""));
      }
    const title = (k: string) => byId.get(idOf(k))?.title ?? k;
    // the relations the existing links ADD to a book that has its own (declaration or title): the noise check
    const added = new Map<string, string>();
    const ownDeps = new Set(plan.steps.filter((s) => s.kind === "pair" && s.relation.via !== "links").map((s) => (s.kind === "pair" ? s.relation.dependant.key : "")));
    for (const s of plan.steps)
      if (s.kind === "pair" && s.relation.via === "links" && ownDeps.has(s.relation.dependant.key) && s.relation.dependant.key === s.source.key)
        added.set(`${s.relation.dependant.key}>${s.relation.base.key}`, `${counts.get(`${s.relation.dependant.key}>${s.relation.base.key}`) ?? 0}\t${title(s.relation.dependant.key)} → ${title(s.relation.base.key)}${s.relation.scope ? ` [${s.relation.scope.section}]` : ""}\t${s.relation.caveats.join(" ").slice(0, 90)}`);
    const addedRows = [...added.values()].sort((a, b) => Number(b.split("\t")[0]) - Number(a.split("\t")[0]));
    console.log(`links-added relations at books with their own: ${addedRows.length}, ${addedRows.reduce((a, r) => a + Number(r.split("\t")[0]), 0)} COMMENTARY links`);
    for (const r of process.env.EVIDENCE_ADDED === "all" ? addedRows : addedRows.slice(0, 40).concat(["…"], addedRows.slice(-25))) console.log("  +", r);
    const inTotal = new Map<string, number>();
    for (const [k, n] of counts) {
      const d = k.slice(0, k.indexOf(">"));
      inTotal.set(d, (inTotal.get(d) ?? 0) + n);
    }
    const rows: { dep: string; base: string; n: number; share: number; cls: string; plannedBases: string[]; plannedN: number }[] = [];
    const agg: Record<string, number> = {};
    let plannedLinks = 0;
    for (const [k, n] of counts) {
      const [d, x] = k.split(">") as [string, string];
      const ps = planned.get(d);
      if (ps?.has(x)) {
        plannedLinks += n;
        continue;
      }
      if (!ps) {
        agg["dependant unplanned"] = (agg["dependant unplanned"] ?? 0) + n;
        continue;
      }
      const xBases = planned.get(x) ?? new Set<string>();
      const sibling = [...ps].some((b) => xBases.has(b));
      const baseOfPlanned = [...ps].some((b) => planned.get(b)?.has(x));
      const cls = sibling ? "sibling" : baseOfPlanned ? "base-of-base" : "other";
      agg[cls] = (agg[cls] ?? 0) + n;
      const plannedN = [...ps].reduce((a, b) => a + (counts.get(`${d}>${b}`) ?? 0), 0);
      rows.push({ dep: title(d), base: title(x), n, share: n / (inTotal.get(d) ?? n), cls, plannedBases: [...ps].map((b) => `${title(b)} (${counts.get(`${d}>${b}`) ?? 0}, ${via.get(`${d}>${b}`)})`), plannedN });
    }
    rows.sort((a, b) => b.n - a.n);
    console.log("planned COMMENTARY links", plannedLinks, "unplanned by class", JSON.stringify(agg));
    const bucket = (r: (typeof rows)[number]) => `${r.cls}|n${r.n >= 100 ? "100+" : r.n >= 20 ? "20-99" : "<20"}|${r.n >= r.plannedN ? "dominant" : r.n >= 0.25 * r.plannedN ? "quarter+" : "minor"}`;
    const buckets: Record<string, [number, number]> = {};
    for (const r of rows) {
      const b = (buckets[bucket(r)] ??= [0, 0]);
      b[0]++;
      b[1] += r.n;
    }
    console.log(JSON.stringify(Object.fromEntries(Object.entries(buckets).sort())));
    for (const r of rows.slice(0, TOP)) console.log(`${r.cls}\t${r.n}\t${(100 * r.share).toFixed(0)}%\t${r.dep} ← ${r.base}\t| planned: ${r.plannedBases.join("; ")}`);
    writeFileSync(join(DIR, "planner-evidence.json"), JSON.stringify({ agg, plannedLinks, buckets, rows }, null, 1));
  }, 3_600_000);
});
