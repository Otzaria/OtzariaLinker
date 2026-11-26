import { appendFileSync, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SourceBook } from "../../../src/core/books";
import type { BookRef } from "../../../src/core/links/model";
import { CONFIDENCE_ORDER, type Suggestion } from "../../../src/linking/automatic";
import { linePairKey, mergeSuggestions, type MergeItem, type MergedSuggestion } from "../../../src/linking/merge";
import { planMaxLink, type PlanStep } from "../../../src/linking/plan";
import { SourceRegistry } from "../../../src/sources/registry";
import { maxlinkJob } from "../../../src/workers/maxlink-job";
import { runDiburHamatchilEngine } from "../../../src/linking/automatic/dibur-hamatchil";
import type { EngineBook } from "../../../src/linking/automatic/types";

/*
 * The V7 matching benchmark (docs/validation/V7_MATCHING_BENCHMARK.md): headings and dibur-hamatchil on
 * whole pairs of the FULL library, through the max-link job (the planner's own steps for a real pair), merged,
 * and judged against the links the database already has. Runs only with a real Otzaria database, opened
 * READ-ONLY (openSync(path, "r"); nothing is written to it):
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db V7_BENCH_OUT=<file.jsonl> V7_BENCH_SET=tune|heldout|unrelated \
 *     npx vitest run tests/integration/linking/v7-matching-benchmark.local.test.ts
 *   V7_BENCH_DIS=<file.jsonl>  every "certain"/"high" merged suggestion that contradicts the database, with the texts (for reading)
 *   V7_BENCH_ONLY="<commentary>><base>;…"  only these pairs
 *
 * The three sets were fixed BEFORE any tuning (the benchmark document says so and why):
 *   tune      — named pairs the findings were measured on (משנה ברורה ← שולחן ערוך אורח חיים is finding B1);
 *   heldout   — a fixed rule over the database: every book with a declared base (book_base_text) whose title is
 *               "<X> על <base title>", 300–6,000 lines, base under 40,000 lines, at least 50 of its lines linked to the
 *               base in the database, ordered by an FNV-1a hash of "<commentary>><base>", the first 12 not in `tune`;
 *   noheadings — the next 16 pairs of the held-out rule and order, the ד"ה engine alone on the commentary WITHOUT its heading lines
 *               (as a plain text file without headings: the engine searches the whole base for every line; #41 B2, #42 C9 —
 *               the database has almost no commentary with a declared base and no headings). Every other pair (by that order)
 *               is the half the caps were calibrated on ("tune"), the rest the half they were checked on ("heldout");
 *   unrelated — pairs that are NOT commentary and base: named same-genre neighbours, and each held-out commentary
 *               against the base of the next held-out pair (rotation). Nothing there is a correct pair.
 * "Right"/"wrong" is AGREEMENT WITH THE DATABASE: the suggested place (line or range) holds a line the database
 * links the commentary line to. The database is not ground truth (it is incomplete and sometimes wrong).
 */
const path = process.env.OTZARIA_DB;
const OUT = process.env.V7_BENCH_OUT;
const DIS = process.env.V7_BENCH_DIS;
const SET = (process.env.V7_BENCH_SET ?? "tune") as "tune" | "heldout" | "unrelated" | "noheadings";
const ONLY = process.env.V7_BENCH_ONLY?.split(";").map((s) => s.split(">").map((t) => t.trim()) as [string, string]);

const TUNE: readonly [string, string][] = [
  ["משנה ברורה", "שולחן ערוך, אורח חיים"],
  ['רש"י על בראשית', "בראשית"],
  ["תוספות על ברכות", "ברכות"],
  ["ביאור הלכה", "שולחן ערוך, אורח חיים"],
  ["כסף משנה על משנה תורה, הלכות שבת", "משנה תורה, הלכות שבת"],
  ['רמב"ן על בראשית', "בראשית"],
];
const UNRELATED_NAMED: readonly [string, string][] = [
  ['רש"י על בראשית', "שמות"],
  ["משנה ברורה", "שולחן ערוך, יורה דעה"],
  ["תוספות על ברכות", "שבת"],
  ['רמב"ן על בראשית', "ויקרא"],
];

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Just what the registry and the lazy reader call on a Blob: size, slice, arrayBuffer. */
function fileBlob(fd: number, from = 0, to = fstatSync(fd).size): Blob {
  return {
    size: to - from,
    slice: (a = 0, b = to - from) => fileBlob(fd, from + a, from + Math.min(b, to - from)),
    async arrayBuffer() {
      const buf = new Uint8Array(to - from);
      const n = readSync(fd, buf, 0, buf.length, from);
      return buf.buffer.slice(0, n);
    },
  } as unknown as Blob;
}

type Tally = Record<string, [number, number, number]>; // key → [agrees with db, contradicts db, not judged]
const add = (t: Tally, k: string, v: boolean | null) => {
  const e = (t[k] ??= [0, 0, 0]);
  e[v === true ? 0 : v === false ? 1 : 2]++;
};

describe.runIf(path && OUT)("V7 matching benchmark on the real seforim.db (read-only)", () => {
  it(`set "${SET}"`, async () => {
    const fd = openSync(path!, "r");
    try {
      const reg = new SourceRegistry();
      const opened = await reg.open([{ path: "seforim.db", blob: fileBlob(fd) }]);
      const books: SourceBook[] = opened.sources.flatMap((s) => s.books).filter((b) => b.origin !== "personal");
      const byTitle = new Map(books.map((b) => [b.title, b] as const));
      const byKey = new Map(books.map((b) => [b.key, b] as const));
      const ref = (b: SourceBook): BookRef => ({ key: b.key, title: b.title, origin: b.origin, ...(b.isBaseBook !== undefined && { isBaseBook: b.isBaseBook }) });

      /** commentary line → the base lines the database links it to */
      const goldOf = async (c: SourceBook, b: SourceBook) => {
        const gold = new Map<number, Set<number>>();
        for (const l of await reg.existingLinks(c.key, 0, Number.MAX_SAFE_INTEGER)) {
          const [mine, other] = l.source.book.key === c.key ? [l.source, l.target] : [l.target, l.source];
          if (other.book.key !== b.key || mine.book.key !== c.key) continue;
          for (let x = other.line; x <= (other.end ?? other.line) && x - other.line < 400; x++) gold.set(mine.line, (gold.get(mine.line) ?? new Set()).add(x));
        }
        return gold;
      };

      /** the declared "X על Y" pairs in hash order */
      const candidates = (): [string, string][] => {
        const tuned = new Set(TUNE.map(([c, b]) => `${c}>${b}`));
        const cands: [string, string][] = [];
        for (const c of books) {
          if (!c.bases?.length || !c.title.includes(" על ") || (c.lineCount ?? 0) < 300 || (c.lineCount ?? 0) > 6000) continue;
          for (const bk of c.bases) {
            const b = byKey.get(bk);
            if (!b || !c.title.endsWith(` על ${b.title}`) || (b.lineCount ?? Infinity) > 40000) continue;
            if (!tuned.has(`${c.title}>${b.title}`)) cands.push([c.title, b.title]);
          }
        }
        cands.sort((x, y) => fnv1a(`${x[0]}>${x[1]}`) - fnv1a(`${y[0]}>${y[1]}`) || (x.join(">") < y.join(">") ? -1 : 1));
        return cands;
      };
      const heldout = async (): Promise<[string, string][]> => {
        const out: [string, string][] = [];
        for (const p of candidates()) {
          if (out.length >= 12) break;
          const gold = await goldOf(byTitle.get(p[0])!, byTitle.get(p[1])!);
          if (gold.size >= 50) out.push(p);
        }
        return out;
      };

      /** the 16 candidates after the 12 held-out ones (the same rule and order) */
      const noHeadings = async (): Promise<[string, string][]> => {
        const taken = new Set((await heldout()).map((p) => p.join(">")));
        const out: [string, string][] = [];
        for (const p of candidates()) {
          if (out.length >= 16) break;
          if (taken.has(p.join(">"))) continue;
          if ((await goldOf(byTitle.get(p[0])!, byTitle.get(p[1])!)).size >= 50) out.push(p);
        }
        return out;
      };
      /** a book as the engines read it (maxlink-job.ts load); `dropHeadings`: without its heading lines, as a plain text file without headings would be */
      const engineBook = async (bk: SourceBook, dropHeadings = false): Promise<EngineBook> => {
        const lines = (await reg.lines(bk.key, 0, Number.MAX_SAFE_INTEGER)).map((l) => ({ index: l.index, text: l.anchorText, heading: l.heading, heRef: l.heRef }));
        return { book: ref(bk), lines: dropHeadings ? lines.filter((l) => l.heading === null && !/^\s*<h[1-6]/i.test(l.text)) : lines };
      };
      let pairs: [string, string][];
      if (ONLY) pairs = ONLY;
      else if (SET === "tune") pairs = [...TUNE];
      else if (SET === "heldout") pairs = await heldout();
      else if (SET === "noheadings") pairs = await noHeadings();
      else {
        const h = await heldout();
        pairs = [...UNRELATED_NAMED, ...h.map(([c], i) => [c, h[(i + 1) % h.length]![1]] as [string, string]).filter(([c, b]) => !c.endsWith(` על ${b}`))];
      }
      console.log(`set ${SET}: ${pairs.length} pairs`, pairs.map((p) => p.join(" > ")));

      for (const [ct, bt] of pairs) {
        const c = byTitle.get(ct);
        const b = byTitle.get(bt);
        if (!c || !b) {
          console.log(`skipped (not in the database): ${ct} > ${bt}`);
          continue;
        }
        const t0 = performance.now();
        let items: MergeItem[];
        let steps: PlanStep[] = [];
        let planned = false;
        let res: { items: readonly { result?: { notes: readonly { code: string }[] }; error?: string }[]; dbLinkKeys: readonly string[] };
        if (SET === "noheadings") {
          // #41 B2 / #42 C9: the ד"ה engine alone, on the commentary without its headings — it searches the whole base for every line
          const r = runDiburHamatchilEngine(await engineBook(c, true), await engineBook(b));
          items = r.suggestions.map((suggestion) => ({ suggestion, focus: c.key }));
          res = { items: [{ result: r }], dbLinkKeys: (await reg.existingLinks(c.key, 0, Number.MAX_SAFE_INTEGER)).map((l) => linePairKey(l)) };
        } else {
        const plan = planMaxLink({ selected: [c.key], library: books });
        steps = plan.steps.filter((s) => s.kind === "pair" && s.source.key === c.key && s.target.key === b.key && !s.relation.through && (s.engine === "headings" || s.engine === "dibur-hamatchil"));
        planned = steps.length > 0;
        if (!planned)
          steps = (["headings", "dibur-hamatchil"] as const).map((engine) => ({
            id: `bench:${engine}:${c.key}>${b.key}`,
            kind: "pair" as const,
            engine,
            source: ref(c),
            target: ref(b),
            relation: { kind: "commentary" as const, dependant: ref(c), base: ref(b), via: "corpus" as const, caveats: [] },
            why: "benchmark",
            ...(engine === "headings" && { titleGate: true as const }),
          }));
        const job = await maxlinkJob(reg, steps, {}, {});
        res = job;
        items = job.items.flatMap((it) => (it.result?.suggestions ?? []).map((suggestion) => ({ suggestion, focus: c.key })));
        }
        const ms = Math.round(performance.now() - t0);
        const db = new Set(res.dbLinkKeys);
        const merged = mergeSuggestions(items, { reference: db, existing: (s) => (db.has(linePairKey(s)) ? "db" : null) });
        const gold = await goldOf(c, b);

        const ends = (s: Suggestion, focus: string) => (s.source.book.key === focus ? [s.source, s.target] : [s.target, s.source]) as [typeof s.source, typeof s.target];
        /** agrees with the database: the place the suggestion stands for (its span, `written`: only the line(s) written) holds a line the database links it to */
        const judge = (s: Suggestion, written = false): boolean | null => {
          const [f, o] = ends(s, c.key);
          if (o.book.key !== b.key) return null;
          const known = gold.get(f.line);
          if (!known) return null;
          const span = !written && s.citedSpan && o === s.target ? s.citedSpan : { line: o.line, end: o.end ?? o.line };
          return [...known].some((l) => l >= span.line && l <= span.end);
        };
        /** lines of the base the suggestion stands for: a range collapsed on a Sefaria side keeps its span in citedSpan */
        const width = (s: Suggestion) => {
          const o = ends(s, c.key)[1];
          const span = s.citedSpan && o === s.target ? s.citedSpan : { line: o.line, end: o.end ?? o.line };
          return span.end - span.line + 1;
        };
        const raw: Tally = {};
        for (const it of items) add(raw, `${it.suggestion.engine}|${it.suggestion.confidence}`, judge(it.suggestion));
        // the ד"ה suggestions by search window, quoted words and how often the quoted words stand in the base (#41 B2, #42 C9)
        const dhWords: Tally = {};
        {
          const norm = (t: string) => t.replace(/<[^>]+>/g, " ").replace(/[֑-ׇ]/g, "").replace(/[^א-ת\s]/g, " ").replace(/\s+/g, " ").trim();
          const baseLines = await reg.lines(b.key, 0, Number.MAX_SAFE_INTEGER);
          const byIndex = new Map(baseLines.map((l) => [l.index, l.anchorText] as const));
          const all = ` ${baseLines.map((l) => norm(l.anchorText)).join(" | ")} `;
          const count = (phrase: string) => {
            let n = 0;
            for (let i = all.indexOf(` ${phrase} `); i >= 0 && n < 5; i = all.indexOf(` ${phrase} `, i + 1)) n++;
            return n;
          };
          for (const it of items) {
            const sg = it.suggestion;
            if (sg.engine !== "dibur-hamatchil") continue;
            const baseSide = sg.source.book.key === b.key ? "source" : "target";
            const at = sg.matched?.[baseSide];
            const text = at ? byIndex.get(sg[baseSide].line)?.slice(at.rawStart, at.rawEnd) : undefined;
            const phrase = text ? norm(text) : "";
            const words = phrase ? phrase.split(" ").length : 0;
            const win = sg.rules.find((x) => x.startsWith("dh/window-"))?.slice(10) ?? (sg.rules.includes("dh/note-marker") ? "marker" : "inherit");
            const times = phrase ? count(phrase) : 0;
            add(dhWords, `${sg.confidence}|${win}|w${Math.min(words, 6)}|${times > 1 ? "repeated" : times === 1 ? "once" : "unknown"}`, judge(sg));
          }
        }
        const out: Tally = {};
        const outWritten: Tally = {};
        const combos: Tally = {};
        const innerAlt: Tally = {};
        const b1: Tally = {};
        const rangeHigh: Tally = {};
        const dis: object[] = [];
        let cLines: Map<number, string> | null = null;
        let bLines: Map<number, string> | null = null;
        const text = async () => {
          cLines ??= new Map((await reg.lines(c.key, 0, Number.MAX_SAFE_INTEGER)).map((l) => [l.index, l.text.replace(/<[^>]+>/g, "").slice(0, 220)]));
          bLines ??= new Map((await reg.lines(b.key, 0, Number.MAX_SAFE_INTEGER)).map((l) => [l.index, l.text.replace(/<[^>]+>/g, "").slice(0, 220)]));
        };
        for (const s of merged.suggestions as MergedSuggestion[]) {
          const v = judge(s);
          add(out, s.confidence, v);
          add(outWritten, s.confidence, judge(s, true));
          add(combos, `${s.confidence}|${s.engines.join("+")}`, v);
          // B1: an exact suggestion inside another engine's coarser range — its own level → the merged level
          const coarse = s.members.filter((m) => m.suggestion.engine !== s.engine && width(m.suggestion) > width(s));
          if (coarse.length && s.engines.length === 1) {
            const own = s.members.find((m) => m.suggestion.engine === s.engine && ends(m.suggestion, c.key)[1].line === ends(s, c.key)[1].line);
            add(b1, `${own?.suggestion.confidence ?? "?"}>${s.confidence}`, v);
          }
          // the reverse: a coarse representative that kept a finer suggestion of another engine as its alternative (judged: the finer one)
          for (const m of s.members) if (m.suggestion.engine !== s.engine && width(m.suggestion) < width(s)) add(innerAlt, `${m.suggestion.engine} ${m.suggestion.confidence} in ${s.confidence}`, judge(m.suggestion));
          if (s.engines.length === 1 && s.engine === "headings") add(rangeHigh, `${s.confidence}|w${width(s) <= 1 ? "1" : width(s) <= 5 ? "2-5" : width(s) <= 20 ? "6-20" : width(s) <= 100 ? "21-100" : ">100"}`, v);
          if (v === false && (s.confidence === "certain" || s.confidence === "high") && DIS) {
            await text();
            const [f, o] = ends(s, c.key);
            dis.push({ pair: `${ct} > ${bt}`, level: s.confidence, engines: s.engines, rules: s.rules, cLine: f.line, cText: cLines!.get(f.line), at: [o.line, o.end ?? o.line], atText: bLines!.get(o.line), db: [...gold.get(f.line)!].slice(0, 3).map((l) => [l, bLines!.get(l)]) });
          }
        }
        const notes = res.items.flatMap((i) => (i.result?.notes ?? []).map((n) => n.code));
        const half = SET === "noheadings" ? (pairs.indexOf(pairs.find(([x, y]) => x === ct && y === bt)!) % 2 === 0 ? "tune" : "heldout") : SET;
        const row = { set: SET, half, pair: `${ct} > ${bt}`, planned, ms, gold: gold.size, steps: steps.map((s) => s.engine), errors: res.items.filter((i) => i.error).map((i) => i.error), notes: [...new Set(notes)], raw, dhWords, merged: out, mergedWritten: outWritten, combos, b1, innerAlt, rangeHigh, stats: merged.stats };
        appendFileSync(OUT!, `${JSON.stringify(row)}\n`);
        if (DIS) for (const d of dis) appendFileSync(DIS, `${JSON.stringify(d)}\n`);
        const lv = (t: Tally, k: string) => (t[k] ? `${t[k]![0]}/${t[k]![0] + t[k]![1]}` : "-");
        console.log(`${ct} > ${bt} (${ms}ms, planned ${planned}): ${CONFIDENCE_ORDER.map((l) => `${l} ${lv(out, l)}`).join(", ")}; b1 ${JSON.stringify(b1)}`);
      }
      expect(pairs.length).toBeGreaterThan(0);
    } finally {
      closeSync(fd);
    }
  }, 6 * 3_600_000);
});
