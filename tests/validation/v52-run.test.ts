import { appendFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import type { LinkSide } from "../../src/core/links/model";
import { stripTags } from "../../src/core/text/html";
import { discoverPairs, type DiscoveryBook, type PairProposal } from "../../src/linking/discovery";
import { linePairKey, mergeSuggestions, type MergedSuggestion, type MergeItem } from "../../src/linking/merge";
import { evidenceFromCounts, linkedFields, linkedProps, planMaxLink, type PlanBook } from "../../src/linking/plan";
import { SourceRegistry } from "../../src/sources/registry";
import { maxlinkJob } from "../../src/workers/maxlink-job";
import { DB, fileBlob } from "./env";

/*
 * ONE run of the existing engines on a seeded sample of identifiable pairs of the personal database (v52) — the commentary in v52,
 * the base in the official library or in v52 itself — read-only, through the same registry the app uses (docs/validation/V6_V52_RUN.md).
 *
 *   OTZARIA_DB   the official seforim.db        V52_DB   the personal database (otzarya-unofficial-books-<N>.db)
 *   V52_OUT      a file the run appends its log to; <V52_OUT>.json gets the numbers, <V52_OUT>.handcheck.json the lines to look at
 *   V52_SEED     the sample's seed (default 52)
 *
 * The database's own external_link rows are the PARTIAL gold: they are not guaranteed correct or complete, so precision/recall here
 * are agreement with them, not truth. Nothing is written to any database; the texts of the hand-check file stay out of the repository.
 */
const OUT = process.env.V52_OUT;
const log = (s: string) => OUT && appendFileSync(OUT, s + "\n");
const seed = Number(process.env.V52_SEED ?? 52);

function rng(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffled = <T>(xs: readonly T[], r: () => number): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

it.runIf(DB && process.env.V52_DB && OUT)("v52 run on a seeded sample of pairs", async () => {
  const reg = new SourceRegistry();
  const res = await reg.open([{ path: "seforim.db", blob: await fileBlob(DB!) }, { path: "v52.db", blob: await fileBlob(process.env.V52_DB!) }]);
  const [official, v52] = [res.sources[0]!, res.sources[1]!];
  const all = [...official.books, ...v52.books];
  log(`books: official ${official.books.length}, v52 ${v52.books.length}`);

  /* discovery, with the links each titled v52 book already has */
  const linked = new Map<string, { total: number; byBook: Record<string, number>; byKey: Record<string, number> }>();
  for (const b of v52.books.filter((x) => x.title.includes(" על "))) {
    const s = await reg.dbLinkSummary(b.key, {});
    if ("byBook" in s) {
      const notes = b.title.startsWith("הערות");
      linked.set(b.key, { total: notes ? s.in : s.out, byBook: Object.fromEntries(s.byBook.map((x) => [x.title, notes ? x.in : x.out])), byKey: Object.fromEntries(s.byBook.map((x) => [x.bookKey, notes ? x.in : x.out])) });
    }
  }
  const disc: DiscoveryBook[] = all.map((b) => ({ key: b.key, title: b.title, origin: b.origin, ...(b.lineCount !== undefined && { lineCount: b.lineCount }), ...(linked.get(b.key) && { linkedLines: linked.get(b.key)!.total, linkedTo: linked.get(b.key)!.byBook, linkedKeys: linked.get(b.key)!.byKey }) }));
  const found = discoverPairs(disc, { dependants: (b) => b.origin === "personal" });
  log(`discovery: ${JSON.stringify(found.summary)}`);

  /* the sample: seeded, by group, within sizes the run can do in minutes */
  const r = rng(seed);
  const eligible = found.proposals.filter((p) => (p.dependant.lineCount ?? 0) >= 30 && (p.dependant.lineCount ?? 0) <= 6000 && (p.base.lineCount ?? 0) <= 30_000 && p.confidence !== "low" && p.kind === "commentary");
  const take = (pred: (p: PairProposal) => boolean, n: number) => shuffled(eligible.filter(pred), r).slice(0, n);
  const sample = [
    ...take((p) => p.status === "unlinked" && p.baseIsOfficial, 8),
    ...take((p) => p.status === "unlinked" && !p.baseIsOfficial, 3),
    ...take((p) => p.status === "partly-linked", 3),
    ...take((p) => p.status === "linked" && p.baseIsOfficial, 4),
    ...take((p) => p.status === "linked" && !p.baseIsOfficial, 3),
  ];
  log(`sample: ${sample.length} pairs (eligible ${eligible.length}, seed ${seed})`);

  const library: PlanBook[] = all.map((b) => ({ key: b.key, title: b.title, origin: b.origin, ...(b.lineCount !== undefined && { lineCount: b.lineCount }) }));
  type Row = { dep: string; base: string; group: string; depLines: number; baseLines: number; ms: number; steps: string[]; gated: boolean; byConf: Record<string, number>; total: number; existing: number; fresh: number; gold: number; goldTargets: number; goldTopShare: number; judged: number; correct: number; recalled: number; recalledAny: number; near1: number; errors: number };
  const rows: Row[] = [];
  const handPool: { depKey: string; baseKey: string; dep: string; base: string; depLine: number; baseLine: number; conf: string; depText: string; baseText: string }[] = [];
  for (const p of sample) {
    const dep = p.dependant;
    const group = `${p.status}/${p.baseIsOfficial ? "official" : "v52"}`;
    // the planner as the app runs it: the book's own link summary is evidence of what it is written on (state/maxlink.ts gatherEvidence)
    const sum = await reg.dbLinkSummary(dep.key, {});
    const fields = "byBook" in sum ? linkedFields(evidenceFromCounts(dep.key, sum.byBook)).get(dep.key) : undefined;
    const lib = library.map((x) => (x.key === dep.key ? { ...x, ...linkedProps(fields) } : x));
    const plan = planMaxLink({ selected: [dep.key], library: lib, singleEngines: [] });
    const t0 = performance.now();
    const job = await maxlinkJob(reg, plan.steps, { stepBudgetMs: 180_000 }, {});
    const ms = Math.round(performance.now() - t0);
    const db = new Set(job.dbLinkKeys);
    const items: MergeItem[] = job.items.flatMap((i) => (i.result?.suggestions ?? []).map((suggestion) => ({ suggestion, focus: dep.key })));
    const merged = mergeSuggestions(items, { reference: db, existing: (s) => (db.has(linePairKey(s)) ? "db" : null) }).suggestions;
    // the partial gold: the database's own links between the two books
    const gold = new Map<number, Set<number>>();
    const mine = (await reg.existingLinks(dep.key, 0, Number.MAX_SAFE_INTEGER)).filter((l) => l.source.book.title === p.base.title || l.target.book.title === p.base.title);
    for (const l of mine) {
      const [m, o] = l.source.book.key === dep.key ? [l.source, l.target] : [l.target, l.source];
      for (let x = m.line; x <= (m.end ?? m.line); x++) {
        const s = gold.get(x) ?? new Set<number>();
        for (let y = o.line; y <= (o.end ?? o.line); y++) s.add(y);
        gold.set(x, s);
      }
    }
    // how coarse the gold is: the share of its lines pointing at the most common target line (1 = every line to one place)
    const goldCount = new Map<number, number>();
    for (const set of gold.values()) for (const y of set) goldCount.set(y, (goldCount.get(y) ?? 0) + 1);
    const goldTop = Math.max(0, ...goldCount.values());
    const byConf: Record<string, number> = {};
    let existing = 0, judged = 0, correct = 0, near1 = 0;
    const recalled = new Set<number>();
    const recalledAny = new Set<number>();
    const sides = (s: MergedSuggestion): [LinkSide, LinkSide] => (s.source.book.key === dep.key ? [s.source, s.target] : [s.target, s.source]);
    for (const s of merged) {
      byConf[s.confidence] = (byConf[s.confidence] ?? 0) + 1;
      if (s.rules.some((x) => x.startsWith("maxlink/exists-"))) existing++;
      const [m, o] = sides(s);
      const g = gold.get(m.line);
      const hit = !!g && [...g].some((y) => y >= o.line && y <= (o.end ?? o.line));
      if (hit) recalledAny.add(m.line);
      else if (g && [...g].some((y) => Math.abs(y - o.line) <= 1)) near1++;
      if (s.confidence === "certain" || s.confidence === "high") {
        if (g) {
          judged++;
          if (hit) (correct++, recalled.add(m.line));
        } else if (!s.rules.some((x) => x.startsWith("maxlink/exists-"))) handPool.push({ depKey: dep.key, baseKey: o.book.key, dep: dep.title, base: o.book.title, depLine: m.line, baseLine: o.line, conf: s.confidence, depText: "", baseText: "" });
      }
    }
    rows.push({
      dep: dep.title, base: p.base.title, group, depLines: dep.lineCount ?? 0, baseLines: p.base.lineCount ?? 0, ms, steps: plan.steps.map((x) => x.engine),
      gated: job.items.some((i) => i.result?.notes.some((n) => n.code === "title-fit/skipped")), byConf, total: merged.length, existing, fresh: merged.length - existing,
      gold: gold.size, goldTargets: goldCount.size, goldTopShare: gold.size ? Math.round((goldTop / gold.size) * 100) / 100 : 0, judged, correct, recalled: recalled.size, recalledAny: recalledAny.size, near1, errors: job.items.filter((i) => i.error).length,
    });
    log(`${group} | ${dep.title} -> ${p.base.title}: ${merged.length} suggestions ${JSON.stringify(byConf)}, existing ${existing}, gold lines ${gold.size} (distinct targets ${goldCount.size}, top share ${gold.size ? Math.round((goldTop / gold.size) * 100) : 0}%), agree ${recalledAny.size}, off by one ${near1}, judged ${judged}, correct ${correct}, ${ms} ms`);
  }

  /* the hand-check pool: new certain/high suggestions, seeded 14; the texts go to a scratch file, never the repository */
  const pick = shuffled(handPool, rng(seed + 1)).slice(0, 14);
  for (const h of pick) {
    const [a] = await reg.lines(h.depKey, h.depLine, h.depLine);
    const [b] = await reg.lines(h.baseKey, h.baseLine, h.baseLine);
    h.depText = stripTags(a?.text ?? "").slice(0, 220);
    h.baseText = stripTags(b?.text ?? "").slice(0, 220);
  }
  writeFileSync(`${OUT}.handcheck.json`, JSON.stringify(pick, null, 1));
  writeFileSync(`${OUT}.json`, JSON.stringify({ seed, summary: found.summary, rows, handPoolSize: handPool.length }, null, 1));
  log(`done: ${rows.length} pairs, hand-check pool ${handPool.length}, picked ${pick.length}`);
}, 7_200_000);
