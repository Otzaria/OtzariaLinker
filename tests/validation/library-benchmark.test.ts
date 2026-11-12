import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SourceBook } from "../../src/core/books";
import type { Link } from "../../src/core/links/model";
import type { EngineContext, EngineId } from "../../src/linking/automatic/types";
import { mergeSuggestions, type MergeItem } from "../../src/linking/merge";
import { planMaxLink, type PlanBook, type PlanStep } from "../../src/linking/plan";
import { SourceRegistry } from "../../src/sources/registry";
import { maxlinkJob } from "../../src/workers/maxlink-job";
import { DB, fileBlob, fingerprint, oracle, cleanupTmp } from "./env";
import {
  addCounters,
  allocate,
  CONFIDENCES,
  count,
  countBucket,
  decodeIds,
  encodeIds,
  estimate,
  excerpt,
  indexDbLinks,
  ownerBooks,
  ownerOf,
  rankOf,
  scoreBook,
  sizeBucket,
  stratify,
  suggestionSpan,
  type Counters,
  type DbEnd,
  type Estimate,
  type Owner,
  type Stratum,
  type Unit,
} from "./library-benchmark";

/*
 * The library benchmark (docs/validation/LIBRARY_BENCHMARK.md): "if the tool runs on the books Otzaria
 * already links, does it produce at least the links that exist?" — per stored connection type, over
 * the whole library or a stratified sample of it.
 *
 * A RUN of a book = what max-link does for that book in the app: the planner's steps for its own
 * relations (headings + dibur-hamatchil to its base, footnotes for a notes book; linking/plan.ts) and
 * the citations engine on it, executed by the worker's own job (workers/maxlink-job.ts) on the real
 * database opened read-only (a file-backed Blob, never copied, never written), and merged as the app
 * merges them (linking/merge.ts, with the database's links as the calibration reference, as in the app).
 * The run is then scored against EVERY link the database has at that book (library-benchmark.ts
 * scoreBook), and the ids of the database links it regenerated are kept per owner, so that a link
 * found from either end counts once.
 *
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db \
 *   npx vitest run --config vitest.validation.config.ts tests/validation/library-benchmark.test.ts --silent=false
 *
 *   BENCH_MODE      sample (default): a stratified sample per type (owners: books for LINKER and
 *                   dependant→base links, book PAIRS for the undirected layers); full: every owner of
 *                   BENCH_TYPES; report: no runs, only the report of what the cache holds
 *   BENCH_TYPES     types whose owners are run (default: all), e.g. COMMENTARY,LINKER
 *   BENCH_N         sampled owners per type and kind (default 60 books / 60 pairs)
 *   BENCH_SEED      the sample's seed (default "otzaria-bench-1")
 *   BENCH_SHARD     k/n: this process runs every n-th book from k (run up to 4 in parallel)
 *   BENCH_BUDGET_MIN  stop starting books after this many minutes (resume later)
 *   BENCH_STEP_S    a step that runs longer is stopped and its partial result kept (default 600)
 *   BENCH_DRY=1     only print the design (owners and books per type), run nothing
 *   BENCH_DIR       cache and results (default .bench/ in the repository, git-ignored): the per-book
 *                   results (runs-<k>of<n>.jsonl, one JSON line per book: resume skips books already
 *                   there), the oracle's population (oracle-*.json) and the reports
 */
const MODE = (process.env.BENCH_MODE ?? "sample") as "sample" | "full" | "report";
const ONLY_TYPES = process.env.BENCH_TYPES?.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
const N = Number(process.env.BENCH_N ?? 60);
const SEED = process.env.BENCH_SEED ?? "otzaria-bench-1";
const [SHARD, SHARDS] = (process.env.BENCH_SHARD ?? "0/1").split("/").map(Number) as [number, number];
const BUDGET_MS = Number(process.env.BENCH_BUDGET_MIN ?? 1e9) * 60_000;
const STEP_MS = Number(process.env.BENCH_STEP_S ?? 600) * 1000;
const DIR = resolve(process.env.BENCH_DIR ?? ".bench");
/** hand-check and miss examples are kept for one book in SAMPLE_EVERY (by rank), to keep the cache small */
const SAMPLE_EVERY = 4;
const PER_BUCKET = 2;

interface OracleData {
  /** id → [top category, lines] */
  books: Record<string, [string, number]>;
  rows: [string, number, number, number][];
}

/** One book's run, as one JSON line of the cache. */
interface BookRecord {
  id: number;
  title: string;
  ms: number;
  steps: string[];
  errors: string[];
  /** steps stopped by BENCH_STEP_S (their partial result is kept) */
  stopped: string[];
  raw: number;
  merged: number;
  contradictedPairs: number;
  counters: Counters;
  /** "<type>|<owner>" → encoded ids of the database links this run regenerated */
  matched: Record<string, string>;
  /** suggestions the database does not have (unconfirmed) or contradicts (wrong), for the hand check */
  fresh?: Sample[];
  /** database links at this book this run did not regenerate */
  misses?: Miss[];
}

interface Sample {
  verdict: string;
  group: string;
  confidence: string;
  pairType: string;
  engines: string[];
  line: number;
  text: string;
  target: string;
  tLine: number;
  tEnd: number;
  heRef2: string;
  tText: string;
  rank: number;
}

interface Miss {
  id: number;
  type: string;
  owner: Owner;
  line: number;
  other: string;
  oLine: number;
  oEnd: number;
  text: string;
  oText: string;
  /** the planner relates this book and the other one (pair steps ran between them) */
  planned: boolean;
  /** suggestions from this line: to the other book (at other lines), and to any book */
  toOther: number[];
  atLine: number;
  rank: number;
}

const idOf = (key: string) => Number(key.slice(key.lastIndexOf(":") + 1));

describe.runIf(DB)("library benchmark: the tool on the books Otzaria already links", () => {
  const before = DB ? fingerprint(DB) : "";
  let registry: SourceRegistry;
  /**
   * The same registry without the database's links, for a book whose run is the citations engine
   * alone. maxlinkJob reads every link at the books it ran on, for the merge's calibration against the
   * library — which never judges a citation (merge.ts: single-book groups are outside it) — and for a
   * base book (בראשית: every incoming link) that read is most of the run. One proxy for all such books,
   * so the citations job's per-registry caches are shared between them.
   */
  let citationsOnly: SourceRegistry;
  let books: SourceBook[];
  let byId: Map<number, SourceBook>;
  let sourceId: string;
  let data: OracleData;

  beforeAll(async () => {
    mkdirSync(DIR, { recursive: true });
    registry = new SourceRegistry();
    const opened = await registry.open([{ path: "seforim.db", blob: await fileBlob(DB!) }]);
    books = opened.sources[0]!.books;
    citationsOnly = new Proxy(registry, {
      get(target, prop) {
        if (prop === "existingLinks") return async () => [];
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    sourceId = opened.sources[0]!.info.id;
    byId = new Map(books.map((b) => [idOf(b.key), b]));
    data = loadOracle();
  }, 600_000);

  afterAll(() => {
    cleanupTmp();
    expect(fingerprint(DB!)).toBe(before);
  });

  /** The population: link counts per (type, source, target) and each book's top category, cached per database build. */
  function loadOracle(): OracleData {
    const file = join(DIR, `oracle-${before.replace(/[^0-9a-z]/gi, "_")}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as OracleData;
    const b = JSON.parse(readFileSync(oracle("books", "books.json"), "utf8")) as { books: { id: number; categoryPath: string[]; lineCount: number }[] };
    const t = JSON.parse(readFileSync(oracle("typepairs", "typepairs.json"), "utf8")) as { rows: [string, number, number, number][] };
    const out: OracleData = { books: Object.fromEntries(b.books.map((x) => [String(x.id), [x.categoryPath[0] ?? "?", x.lineCount]])), rows: t.rows };
    writeFileSync(file, JSON.stringify(out));
    return out;
  }

  it(
    `${MODE}${SHARDS > 1 ? ` shard ${SHARD}/${SHARDS}` : ""}`,
    async () => {
      const t0 = performance.now();
      const library: PlanBook[] = books.map((b) => ({ key: b.key, title: b.title, origin: b.origin, ...(b.isBaseBook !== undefined && { isBaseBook: b.isBaseBook }), ...(b.bases && { bases: b.bases }), ...(b.dependence && { dependence: b.dependence }) }));
      // every relation of the library at once: the planner's steps for "all books selected"
      const plan = planMaxLink({ selected: books.map((b) => b.key), library, singleEngines: ["citations"] });
      const stepsOf = new Map<number, PlanStep[]>();
      const related = new Set<string>();
      for (const s of plan.steps) {
        const owner = s.kind === "pair" ? s.relation.dependant.key : s.source.key;
        if (s.kind === "pair") related.add(`${idOf(s.relation.dependant.key)}>${idOf(s.relation.base.key)}`);
        const list = stepsOf.get(idOf(owner));
        if (list) list.push(s);
        else stepsOf.set(idOf(owner), [s]);
      }
      const isRelated = (dep: number, base: number) => related.has(`${dep}>${base}`);
      const own = (type: string, s: number, t: number) => ownerOf(type, s, t, isRelated);

      // owners per type, and their link counts
      const owned = new Map<string, Map<Owner, number>>();
      for (const [type, s, t, n] of data.rows) {
        const m = owned.get(type) ?? new Map<Owner, number>();
        const o = own(type, s, t);
        m.set(o, (m.get(o) ?? 0) + n);
        owned.set(type, m);
      }
      const types = [...owned.keys()].filter((t) => !ONLY_TYPES || ONLY_TYPES.includes(t)).sort((a, b) => total(owned.get(b)!) - total(owned.get(a)!));
      const top = (id: number) => data.books[String(id)]?.[0] ?? "?";
      const lines = (id: number) => data.books[String(id)]?.[1] ?? 0;
      const strataOf = (type: string, kind: "D" | "U"): Stratum[] => {
        const units: Unit[] = [];
        for (const [o, n] of owned.get(type)!) {
          if (o[0] !== kind) continue;
          const [a, b] = ownerBooks(o) as [number, number?];
          const stratum = kind === "D" ? `${top(a)}|${sizeBucket(lines(a))}` : `${[top(a), top(b!)].sort().join("~")}|${countBucket(n)}`;
          units.push({ id: o, stratum, links: n });
        }
        return stratify(units, `${SEED}|${type}|${kind}`);
      };
      /** the owners whose links are measured: all of them (full), or the stratified sample */
      const chosen = (st: Stratum): Unit[] => (MODE === "full" ? st.units : st.units.slice(0, alloc.get(st)!));
      const alloc = new Map<Stratum, number>();
      const design = new Map<string, { kind: "D" | "U"; strata: Stratum[] }[]>();
      for (const type of types) {
        const kinds = (["D", "U"] as const).map((kind) => ({ kind, strata: strataOf(type, kind) })).filter((k) => k.strata.length);
        for (const k of kinds) {
          const a = allocate(k.strata, N);
          for (const st of k.strata) alloc.set(st, a.get(st.name) ?? 0);
        }
        design.set(type, kinds);
      }
      const wanted = new Set<number>();
      for (const kinds of design.values()) for (const k of kinds) for (const st of k.strata) for (const u of chosen(st)) for (const b of ownerBooks(u.id)) wanted.add(b);
      const order = [...wanted].filter((id) => byId.has(id)).sort((a, b) => rankOf(SEED, `book:${a}`) - rankOf(SEED, `book:${b}`) || a - b);

      const done = readRecords();
      if (process.env.BENCH_DRY) {
        const lines = [...design].map(([type, kinds]) => `${type}: ${kinds.map((k) => `${k.kind} ${k.strata.reduce((a, st) => a + chosen(st).length, 0)}/${k.strata.reduce((a, st) => a + st.units.length, 0)} units in ${k.strata.length} strata`).join(", ")}`);
        const lineSum = order.reduce((a, id) => a + (byId.get(id)?.lineCount ?? 0), 0);
        return void console.log([`[bench] ${MODE}: ${order.length} books, ${lineSum.toLocaleString()} lines, ${order.filter((id) => done.has(id)).length} cached`, ...lines].join("\n"));
      }
      if (MODE !== "report") {
        const mine = order.filter((_, i) => i % SHARDS === SHARD).filter((id) => !done.has(id));
        const out = join(DIR, `runs-${SHARD}of${SHARDS}.jsonl`);
        console.log(`[bench] ${MODE}: ${order.length} books in the design, ${done.size} cached; this shard runs ${mine.length}`);
        for (const [i, id] of mine.entries()) {
          if (performance.now() - t0 > BUDGET_MS) {
            console.log(`[bench] time budget reached after ${i} books`);
            break;
          }
          const rec = await runBook(id, stepsOf.get(id) ?? [], isRelated, own);
          appendFileSync(out, JSON.stringify(rec) + "\n");
          done.set(id, rec);
          console.log(`[bench] ${i + 1}/${mine.length} ${rec.title}: ${(rec.ms / 1000).toFixed(1)} s, ${rec.merged} suggestions${rec.errors.length ? `, ${rec.errors.length} errors` : ""}${rec.stopped.length ? `, ${rec.stopped.length} stopped` : ""}`);
        }
      }
      if (SHARDS === 1 || MODE === "report") report(types, design, chosen, done, owned, isRelated);
    },
    24 * 3_600_000,
  );

  /** The database's links at the given lines of a book (contiguous runs read together), or at every line. */
  async function linksAt(key: string, at: readonly number[], all: boolean): Promise<Link[]> {
    if (all) return registry.existingLinks(key, 0, Number.MAX_SAFE_INTEGER);
    const sorted = [...new Set(at)].sort((a, b) => a - b);
    const out: Link[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < sorted.length; ) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1]! - sorted[j]! <= 32) j++;
      for (const l of await registry.existingLinks(key, sorted[i]!, sorted[j]!)) if (!seen.has(l.id)) seen.add(l.id), out.push(l);
      i = j + 1;
    }
    return out;
  }

  /** the dominant stored type of each book this one is linked with (both directions), from the oracle's counts */
  let pairIndex: Map<number, [string, number, number][]> | null = null;
  function pairTypesOf(id: number): Map<number, string> {
    if (!pairIndex) {
      pairIndex = new Map();
      for (const [type, s, t, n] of data.rows)
        for (const [a, b] of s === t ? [[s, t]] : [[s, t], [t, s]]) {
          const list = pairIndex.get(a!);
          if (list) list.push([type, b!, n]);
          else pairIndex.set(a!, [[type, b!, n]]);
        }
    }
    const counts = new Map<number, Map<string, number>>();
    for (const [type, other, n] of pairIndex.get(id) ?? []) {
      const m = counts.get(other) ?? new Map<string, number>();
      m.set(type, (m.get(type) ?? 0) + n);
      counts.set(other, m);
    }
    return new Map([...counts].map(([o, m]) => [o, [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0]]));
  }

  function readRecords(): Map<number, BookRecord> {
    const out = new Map<number, BookRecord>();
    for (const f of readdirSync(DIR).filter((x) => /^runs-.*\.jsonl$/.test(x)))
      for (const line of readFileSync(join(DIR, f), "utf8").split("\n"))
        if (line.trim()) {
          const r = JSON.parse(line) as BookRecord;
          out.set(r.id, r);
        }
    return out;
  }

  /**
   * A signal whose "aborted" turns true when the CURRENT step of maxlinkJob runs longer than STEP_MS.
   * The engines are synchronous and only read `aborted` (a timer could not fire inside them); they
   * return what they found, with a note, and the job goes on to the next step. throwIfAborted is a
   * no-op so that the job itself never gives up the book.
   */
  function stepDeadline(): { signal: AbortSignal; progress: (d: number, n: number) => void } {
    let step = -1;
    let deadline = Date.now() + STEP_MS;
    const signal = {
      get aborted() {
        return Date.now() > deadline;
      },
      reason: undefined,
      throwIfAborted() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
      onabort: null,
    } as unknown as AbortSignal;
    return {
      signal,
      progress: (d) => {
        const s = Math.floor(d / 1000);
        if (s !== step) (step = s), (deadline = Date.now() + STEP_MS);
      },
    };
  }

  async function runBook(id: number, steps: PlanStep[], isRelated: (a: number, b: number) => boolean, own: (type: string, s: number, t: number) => Owner): Promise<BookRecord> {
    const book = byId.get(id)!;
    const t0 = Date.now();
    const rec: BookRecord = { id, title: book.title, ms: 0, steps: steps.map((s) => s.id), errors: [], stopped: [], raw: 0, merged: 0, contradictedPairs: 0, counters: {}, matched: {} };
    if (!steps.length) return { ...rec, ms: Date.now() - t0 };
    const { signal, progress } = stepDeadline();
    const ctx: EngineContext = { signal, progress };
    const res = await maxlinkJob(steps.some((s) => s.kind === "pair") ? registry : citationsOnly, steps, {}, ctx);
    const byStep = new Map(steps.map((s) => [s.id, s]));
    const items: MergeItem[] = [];
    for (const it of res.items) {
      const step = byStep.get(it.stepId)!;
      if (it.error !== undefined) rec.errors.push(`${it.stepId}: ${it.error}`);
      if (it.result?.notes.some((n) => n.code === "engine/aborted")) rec.stopped.push(it.stepId);
      for (const sg of it.result?.suggestions ?? []) items.push({ suggestion: sg, focus: step.source.key });
    }
    // as the app merges (state/maxlink.ts): the database's links as the calibration reference
    const merged = mergeSuggestions(items, { reference: new Set(res.dbLinkKeys) });
    rec.raw = merged.stats.input;
    rec.merged = merged.stats.output;
    rec.contradictedPairs = merged.stats.contradictedPairs ?? 0;
    const keep = rankOf(SEED, `book:${id}`) % SAMPLE_EVERY === 0;
    if (!merged.suggestions.length && !keep) return { ...rec, ms: Date.now() - t0 };

    // the database's links at the lines the run speaks about (all of them for a book whose examples are kept)
    const at = merged.suggestions.flatMap((s) => [s.source, s.target].filter((x) => x.book.key === book.key).map((x) => x.line));
    const links = await linksAt(book.key, at, keep || new Set(at).size > 0.3 * (book.lineCount ?? 0));
    const db = indexDbLinks(book.key, links, own);
    db.pairType = pairTypesOf(id);
    let text: Map<number, string> | null = null;
    const lineText = (l: number) => text?.get(l);
    // the book's lines, only when a citation needs its words or examples are kept
    if (keep || merged.suggestions.some((s) => s.engines.length === 1 && s.engines[0] === "citations" && db.byLine.has(s.source.line)))
      text = new Map((await registry.lines(book.key, 0, Number.MAX_SAFE_INTEGER)).map((l) => [l.index, l.anchorText] as const));
    const score = scoreBook(book.key, merged.suggestions.map((s) => ({ s, engines: s.engines as EngineId[] })), db, lineText);
    rec.counters = count(score.scored);
    for (const [k, ids] of score.matched) rec.matched[k] = encodeIds(ids);
    if (keep) {
      const otherLine = async (bookId: number, line: number) => (await registry.lines(`${sourceId}:${bookId}`, line, line))[0]?.anchorText;
      // new or contradicted suggestions: PER_BUCKET per (group, confidence, pair type), by rank
      const buckets = new Map<string, typeof score.scored>();
      for (const x of score.scored) {
        if (x.verdict === "correct") continue;
        const k = `${x.group}|${x.s.confidence}|${x.pairType}|${x.verdict}`;
        buckets.set(k, [...(buckets.get(k) ?? []), x]);
      }
      rec.fresh = [];
      for (const list of buckets.values())
        for (const x of list.sort((a, b) => rankOf(SEED, a.s.id) - rankOf(SEED, b.s.id)).slice(0, PER_BUCKET))
          rec.fresh.push({
            verdict: x.verdict,
            group: x.group,
            confidence: x.s.confidence,
            pairType: x.pairType,
            engines: [...x.engines],
            line: x.bLine,
            text: excerpt(lineText(x.bLine), x.group === "citations" ? suggestionSpan(x.s.id, lineText(x.bLine)) : null),
            target: byId.get(x.other)?.title ?? `#${x.other}`,
            tLine: x.oFrom,
            tEnd: x.oTo,
            heRef2: x.s.heRef2,
            tText: excerpt(await otherLine(x.other, x.oFrom), null, 70),
            rank: rankOf(SEED, x.s.id),
          });
      // misses: links this book is responsible for (it owns them, or one end of an undirected pair), PER_BUCKET per type
      const found = new Set([...score.matched.values()].flatMap((s) => [...s]));
      const fromLine = new Map<number, typeof score.scored>();
      for (const x of score.scored) fromLine.set(x.bLine, [...(fromLine.get(x.bLine) ?? []), x]);
      const byType = new Map<string, { line: number; e: DbEnd }[]>();
      const seen = new Set<number>();
      for (const [line, list] of db.byLine)
        for (const e of list) {
          if (found.has(e.id) || seen.has(e.id)) continue;
          if (!(e.owner === `D:${id}` || (e.owner[0] === "U" && ownerBooks(e.owner).includes(id)))) continue;
          seen.add(e.id);
          byType.set(e.type, [...(byType.get(e.type) ?? []), { line, e }]);
        }
      rec.misses = [];
      for (const [type, list] of byType)
        for (const { line, e } of list.sort((a, b) => rankOf(SEED, `link:${a.e.id}`) - rankOf(SEED, `link:${b.e.id}`)).slice(0, PER_BUCKET)) {
          const here = fromLine.get(line) ?? [];
          rec.misses.push({
            id: e.id,
            type,
            owner: e.owner,
            line,
            other: byId.get(e.other)?.title ?? `#${e.other}`,
            oLine: e.oFrom,
            oEnd: e.oTo,
            text: excerpt(lineText(line), e.span ?? null),
            oText: excerpt(await otherLine(e.other, e.oFrom), null, 70),
            planned: isRelated(id, e.other) || isRelated(e.other, id),
            toOther: here.filter((x) => x.other === e.other).map((x) => x.oFrom),
            atLine: here.length,
            rank: rankOf(SEED, `link:${e.id}`),
          });
        }
    }
    return { ...rec, ms: Date.now() - t0 };
  }

  function report(
    types: string[],
    design: Map<string, { kind: "D" | "U"; strata: Stratum[] }[]>,
    chosen: (st: Stratum) => Unit[],
    done: Map<number, BookRecord>,
    owned: Map<string, Map<Owner, number>>,
    isRelated: (a: number, b: number) => boolean,
  ): void {
    // the union of what every run regenerated, per "<type>|<owner>"
    const matched = new Map<string, Set<number>>();
    for (const r of done.values())
      for (const [k, enc] of Object.entries(r.matched)) {
        const set = matched.get(k) ?? new Set<number>();
        for (const i of decodeIds(enc)) set.add(i);
        matched.set(k, set);
      }
    const ran = (o: Owner) => ownerBooks(o).every((b) => done.has(b) || !byId.has(b));
    const perType: Record<string, unknown> = {};
    const lines: string[] = [];
    const runBooks = new Set<number>();
    let libTotal = 0;
    let libMatched = 0;
    let libVar = 0;
    const totals = new Map(types.map((t) => [t, total(owned.get(t)!)]));
    const grand = [...totals.values()].reduce((a, b) => a + b, 0);
    for (const type of types) {
      const kinds = design.get(type)!;
      const parts: Record<string, Estimate & { links: number; populationUnits: number }> = {};
      for (const k of kinds) {
        const strata = k.strata.map((st) => {
          const obs = chosen(st)
            .filter((u) => ran(u.id))
            .map((u) => {
              for (const b of ownerBooks(u.id)) runBooks.add(b);
              return { scope: u.links, matched: matched.get(`${type}|${u.id}`)?.size ?? 0 };
            });
          return { links: st.links, population: st.units.length, obs };
        });
        parts[k.kind] = { ...estimate(strata), links: k.strata.reduce((a, s) => a + s.links, 0), populationUnits: k.strata.reduce((a, s) => a + s.units.length, 0) };
      }
      const L = Object.values(parts).reduce((a, p) => a + (p.units ? p.links : 0), 0);
      const recall = L ? Object.values(parts).reduce((a, p) => a + (p.units ? (p.links / L) * p.recall : 0), 0) : 0;
      const ci = L ? Math.sqrt(Object.values(parts).reduce((a, p) => a + (p.units ? ((p.links / L) * p.ci) ** 2 : 0), 0)) : 0;
      const T = totals.get(type)!;
      perType[type] = { dbLinks: T, recall: pct(recall), ci: pct(ci), parts };
      libTotal += T;
      libMatched += recall * T;
      libVar += ((T / grand) * ci) ** 2;
      const d = parts.D;
      const u = parts.U;
      lines.push(
        `${type.padEnd(18)} ${String(T).padStart(9)}  ${pct(recall).padStart(6)} ±${pct(ci).padStart(5)}` +
          `   D: ${d ? `${pct(d.recall)} (${d.units}/${d.populationUnits} owners, ${d.matched}/${d.scope})` : "—"}` +
          `   U: ${u ? `${pct(u.recall)} (${u.units}/${u.populationUnits} pairs, ${u.matched}/${u.scope})` : "—"}`,
      );
    }
    // precision over the books whose runs were measured
    const counters: Counters = {};
    let ms = 0;
    const errors: string[] = [];
    const stopped: string[] = [];
    for (const b of runBooks) {
      const r = done.get(b);
      if (!r) continue;
      addCounters(counters, r.counters);
      ms += r.ms;
      errors.push(...r.errors.map((e) => `${r.title}: ${e}`));
      stopped.push(...r.stopped.map((e) => `${r.title}: ${e}`));
    }
    const prec = (filter: (group: string, conf: string, pairType: string) => boolean) => {
      const t = [0, 0, 0, 0];
      for (const [k, v] of Object.entries(counters)) {
        const [g, c, p] = k.split("|") as [string, string, string];
        if (filter(g, c, p)) for (let i = 0; i < 4; i++) t[i]! += v[i]!;
      }
      const [n, c, w, u] = t as [number, number, number, number];
      return { n, correct: c, wrong: w, unconfirmed: u, strict: pct(n ? c / n : 0), judged: pct(c + w ? c / (c + w) : 0) };
    };
    const precision: Record<string, unknown> = {};
    for (const g of ["structural", "citations"]) for (const c of CONFIDENCES) precision[`${g}|${c}`] = prec((gg, cc) => gg === g && cc === c);
    const pairTypes = [...new Set(Object.keys(counters).map((k) => k.split("|")[2]!))];
    const byPairType: Record<string, unknown> = {};
    for (const p of pairTypes) for (const g of ["structural", "citations"]) for (const c of ["certain", "high"]) {
      const x = prec((gg, cc, pp) => gg === g && cc === c && pp === p);
      if (x.n) byPairType[`${p}|${g}|${c}`] = x;
    }
    lines.unshift(`type                 db links  recall  ±95%   (D: owner books — LINKER source, dependant→base; U: undirected book pairs)`);
    lines.push(`${"ALL".padEnd(18)} ${String(libTotal).padStart(9)}  ${pct(libMatched / libTotal).padStart(6)} ±${pct(Math.sqrt(libVar)).padStart(5)}`);
    lines.push("", "precision over the measured books (strict = correct/all; judged = correct/(correct+wrong)):");
    for (const [k, v] of Object.entries(precision) as [string, { n: number; strict: string; judged: string; unconfirmed: number }][]) if (v.n) lines.push(`  ${k.padEnd(22)} n=${String(v.n).padStart(8)}  strict ${v.strict.padStart(6)}  judged ${v.judged.padStart(6)}  new ${v.unconfirmed}`);
    lines.push(`books run: ${runBooks.size} (${(ms / 3_600_000).toFixed(2)} CPU-hours), errors ${errors.length}, stopped steps ${stopped.length}`);
    console.log(lines.join("\n"));

    // hand-check material: new suggestions and misses of the measured books, by rank
    const fresh = [...runBooks].flatMap((b) => (done.get(b)?.fresh ?? []).map((x) => ({ book: done.get(b)!.title, ...x })));
    const misses = [...runBooks].flatMap((b) => (done.get(b)?.misses ?? []).map((x) => ({ book: done.get(b)!.title, ...x }))).filter((m) => !matched.get(`${m.type}|${m.owner}`)?.has(m.id));
    const take = <T extends { rank: number }>(list: T[], key: (x: T) => string, n: number) => {
      const by = new Map<string, T[]>();
      for (const x of list) by.set(key(x), [...(by.get(key(x)) ?? []), x]);
      return Object.fromEntries([...by].map(([k, xs]) => [k, xs.sort((a, b) => a.rank - b.rank).slice(0, n)]));
    };
    writeFileSync(
      join(DIR, `handcheck-${MODE}.json`),
      JSON.stringify(
        {
          fresh: take(fresh.filter((x) => x.verdict === "unconfirmed" && (x.confidence === "certain" || x.confidence === "high")), (x) => `${x.pairType}|${x.group}`, 30),
          wrong: take(fresh.filter((x) => x.verdict === "wrong" && (x.confidence === "certain" || x.confidence === "high")), (x) => `${x.pairType}|${x.group}`, 15),
          misses: take(misses, (x) => x.type, 40),
        },
        null,
        1,
      ),
    );
    writeFileSync(
      join(DIR, `summary-${MODE}.json`),
      JSON.stringify({ mode: MODE, seed: SEED, n: N, at: new Date().toISOString(), db: before, books: runBooks.size, cpuMs: ms, errors, stopped, perType, precision, byPairType, missesByType: tallyMisses(misses, isRelated) }, null, 1),
    );
  }
});

function tallyMisses(misses: readonly Miss[], _isRelated: (a: number, b: number) => boolean): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const m of misses) {
    const k = m.toOther.length ? "suggested elsewhere in that book" : m.atLine ? "line linked, to other books" : m.planned ? "pair planned, line not linked" : "nothing from this line";
    const t = (out[m.type] ??= {});
    t[k] = (t[k] ?? 0) + 1;
  }
  return out;
}

const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
