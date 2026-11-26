import { appendFileSync, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SourceBook, SourceLine } from "../../../src/core/books";
import { fromGematria } from "../../../src/core/text/gematria";
import { commentatorOfTitle } from "../../../src/linking/automatic/dibur-hamatchil/addressee";
import { extractDh } from "../../../src/linking/automatic/dibur-hamatchil/extract";
import { linePairKey, mergeSuggestions, type MergeItem, type MergedSuggestion } from "../../../src/linking/merge";
import { planMaxLink } from "../../../src/linking/plan";
import { SourceRegistry } from "../../../src/sources/registry";
import { maxlinkJob } from "../../../src/workers/maxlink-job";

/*
 * #41 B13 / #45 on the REAL library (docs/validation/V7_MATCHING_BENCHMARK.md §12): a commentary on the Shulchan Aruch whose lines open
 * "<commentator> ס"ק N" ("ש"ך ס"ק ג", "בט"ז סק"ה") is linked with a target hierarchy — the Shulchan Aruch primary, the commentators it
 * names secondary — and every such line is checked:
 *   routed      — its suggestion is on the named commentator's book;
 *   right place — that line of the commentator is in the SAME siman as the citing line and opens with the number N ("(ג)", "[ג]");
 *   wrong place — on the commentator, another siman or another number;
 *   to the base — it stayed on the Shulchan Aruch (what #41 B13 found: the previous line of the author, "high");
 *   none        — no suggestion at all.
 * The truth here is STRUCTURAL (siman and number, read from the two books' own headings and openings, independently of the engine's
 * code), not the database's links; the database's agreement is reported next to it. Runs only with a real database, opened READ-ONLY:
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db B13_OUT=<file.jsonl> npx vitest run tests/integration/linking/target-hierarchy-real-db.local.test.ts
 *   B13_MIN=<n>     a book is measured when at least n of its lines open with a commentator and a ס"ק (default 20)
 *   B13_ONLY="<title>;…"  only these books
 */
const path = process.env.OTZARIA_DB;
const OUT = process.env.B13_OUT;
const MIN = Number(process.env.B13_MIN ?? 20);
const ONLY = process.env.B13_ONLY?.split(";").map((s) => s.trim());

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

const plain = (t: string) => t.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/[֑-ׇ]/g, "").replace(/\s+/g, " ").trim();
/** a Hebrew numeral written with or without quote marks ("י"ב", "יב", "ג'"), else null */
const numeral = (s: string): number | null => {
  const t = s.replace(/["'״׳]/g, "");
  if (!/^[א-ת]{1,4}$/.test(t)) return null;
  const n = fromGematria(t);
  return n !== null && n > 0 ? n : null;
};
/** the siman a heading names ("סימן קטו", "סי' י"ב"), else null */
const simanOf = (heading: string): number | null => {
  const m = /(?:^|\s)(?:סימן|סי['׳])\s*([א-ת"'״׳]{1,6})(?:\s|$|[.,:-])/.exec(plain(heading));
  return m ? numeral(m[1]!) : null;
};
/** the number a line opens with: "(ג)", "[ג]", "ג)" — else null */
const openingNumber = (text: string): number | null => {
  const m = /^\s*[([]?\s*([א-ת"'״׳]{1,5})\s*[)\]]/.exec(plain(text));
  return m ? numeral(m[1]!) : null;
};
/** line index → the siman of the nearest heading above it that names one */
const simanMap = (lines: readonly SourceLine[]): Map<number, number> => {
  const out = new Map<number, number>();
  let cur: number | null = null;
  for (const l of lines) {
    if (l.heading !== null || /^\s*<h[1-6]/i.test(l.text)) {
      const s = simanOf(l.text);
      if (s !== null) cur = s;
      continue;
    }
    if (cur !== null) out.set(l.index, cur);
  }
  return out;
};
/** the number a heading below the siman gives ("סעיף יב", "ס"ק יב"), else null */
const subOf = (heading: string): number | null => {
  const m = /^(?:סעיף קטן|סעיף|ס"ק|סק['׳]?)\s*([א-ת"'״׳]{1,6})\s*$/.exec(plain(heading).replace(/״/g, '"'));
  return m ? numeral(m[1]!) : null;
};
/**
 * line index → the seif katan of a commentator's line. Two layouts in the library: the number opens the line ("(ג) …", מגן אברהם), or
 * a heading under the siman names it ("<h3>סעיף יג</h3>" in שפתי כהן — its OWN ס"ק, headings/consistency.ts), and the lines under it
 * (several paragraphs, sometimes numbered "ב)" "ג)" inside the note) are that note. A book with such headings is read by them.
 */
const seifKatanMap = (lines: readonly SourceLine[]): Map<number, number> => {
  const isHead = (l: SourceLine) => l.heading !== null || /^\s*<h[1-6]/i.test(l.text);
  const byHeading = lines.filter((l) => isHead(l) && subOf(l.text) !== null).length >= 10;
  const out = new Map<number, number>();
  let cur: number | null = null;
  for (const l of lines) {
    if (isHead(l)) {
      if (simanOf(l.text) !== null) cur = null;
      const n = subOf(l.text);
      if (n !== null) cur = n;
      continue;
    }
    const n = byHeading ? cur : openingNumber(l.text);
    if (n !== null) out.set(l.index, n);
  }
  return out;
};

describe.runIf(path && OUT)("#41 B13: routing to a named commentator by seif katan, on the real seforim.db (read-only)", () => {
  it("measures every commentary on the Shulchan Aruch that names its commentators by ס\"ק", async () => {
    const fd = openSync(path!, "r");
    try {
      const reg = new SourceRegistry();
      const opened = await reg.open([{ path: "seforim.db", blob: fileBlob(fd) }]);
      const books: SourceBook[] = opened.sources.flatMap((s) => s.books);
      const byKey = new Map(books.map((b) => [b.key, b] as const));
      const parts = books.filter((b) => /^שולחן ערוך, (אורח חיים|יורה דעה|אבן העזר|חושן משפט)$/.test(b.title));
      const totals = { lines: 0, routed: 0, right: 0, wrongPlace: 0, toBase: 0, toBaseHigh: 0, none: 0, undecidable: 0, dbJudged: 0, dbAgrees: 0 };
      const byLevel: Record<string, [number, number]> = {};
      const byVia: Record<string, [number, number]> = {};
      const baseBy: Record<string, number> = {};
      let measured = 0;
      for (const sa of parts) {
        const deps = books.filter((b) => b.bases?.includes(sa.key) && (!ONLY || ONLY.includes(b.title)));
        // the commentators of this part, by the name a line uses (the book whose title names it and the part)
        const partName = sa.title.slice("שולחן ערוך, ".length);
        const commentatorBooks = books.filter((b) => b.bases?.includes(sa.key) || b.title.includes(partName));
        for (const d of deps) {
          const lines = await reg.lines(d.key, 0, Number.MAX_SAFE_INTEGER);
          // the population: lines that open with a commentator and a ס"ק (the extractor's own reading, which is what routes them)
          const named = new Map<number, { who: string; n: number }>();
          for (const l of lines) {
            if (l.heading !== null) continue;
            const ex = extractDh({ text: l.anchorText, heading: l.heading });
            const a = ex.addressee;
            if (a?.kind === "named" && a.seifKatan !== undefined) named.set(l.index, { who: a.commentator.key, n: a.seifKatan });
          }
          if (named.size < MIN) continue;
          // the targets: the books of the commentators the lines name, in this part
          const whoBook = new Map<string, SourceBook>();
          for (const b of commentatorBooks) {
            if (b.key === d.key) continue;
            const c = commentatorOfTitle(b.title);
            if (c && [...named.values()].some((x) => x.who === c.key) && !whoBook.has(c.key)) whoBook.set(c.key, b);
          }
          const targets = [...whoBook.values()];
          if (!targets.length) {
            console.log(`${d.title}: ${named.size} lines name a commentator by ס"ק, none of whose books is in this part — skipped`);
            continue;
          }
          measured++;
          const t0 = performance.now();
          const plan = planMaxLink({
            selected: [d.key],
            library: books,
            choices: { pairs: [sa, ...targets].map((b) => ({ dependant: d.title, base: b.title, dependantKey: d.key, baseKey: b.key })), targets: { [d.title]: { primary: sa.title } } },
          });
          const steps = plan.steps.filter((s) => s.kind === "pair" && s.source.key === d.key);
          const job = await maxlinkJob(reg, steps, {}, {});
          const items: MergeItem[] = job.items.flatMap((it) => (it.result?.suggestions ?? []).map((suggestion) => ({ suggestion, focus: d.key })));
          const db = new Set(job.dbLinkKeys);
          const merged = mergeSuggestions(items, { reference: db, existing: (s) => (db.has(linePairKey(s)) ? "db" : null) });
          // the database's links of the citing lines, to each target
          const gold = new Map<string, Set<number>>();
          for (const l of await reg.existingLinks(d.key, 0, Number.MAX_SAFE_INTEGER)) {
            const [mine, other] = l.source.book.key === d.key ? [l.source, l.target] : [l.target, l.source];
            if (mine.book.key !== d.key) continue;
            const k = `${mine.line}>${other.book.key}`;
            (gold.get(k) ?? gold.set(k, new Set()).get(k)!).add(other.line);
          }
          const dSiman = simanMap(lines);
          const tLines = new Map<string, { siman: Map<number, number>; open: Map<number, number> }>();
          for (const t of targets) {
            const tl = await reg.lines(t.key, 0, Number.MAX_SAFE_INTEGER);
            tLines.set(t.key, { siman: simanMap(tl), open: seifKatanMap(tl) });
          }
          // every merged suggestion of each citing line (a line may have one on the commentator AND one on the base)
          const ofLine = new Map<number, MergedSuggestion[]>();
          for (const s of merged.suggestions as MergedSuggestion[]) {
            const f = s.source.book.key === d.key ? s.source : s.target;
            if (named.has(f.line)) (ofLine.get(f.line) ?? ofLine.set(f.line, []).get(f.line)!).push(s);
          }
          const order = ["certain", "high", "possible", "ambiguous"];
          const strong = (s: MergedSuggestion) => s.confidence === "certain" || s.confidence === "high";
          const row = { book: d.title, part: sa.title, targets: targets.map((t) => t.title), lines: named.size, routed: 0, right: 0, wrongPlace: 0, toBase: 0, toBaseHigh: 0, none: 0, undecidable: 0, dbJudged: 0, dbAgrees: 0, levels: {} as Record<string, [number, number]>, via: {} as Record<string, [number, number]>, baseBy: {} as Record<string, number>, samples: [] as object[], ms: 0 };
          for (const [line, want] of named) {
            const all = (ofLine.get(line) ?? []).sort((a, b) => order.indexOf(a.confidence) - order.indexOf(b.confidence));
            if (!all.length) {
              row.none++;
              continue;
            }
            const other = (s: MergedSuggestion) => (s.source.book.key === d.key ? s.target : s.source);
            const target = whoBook.get(want.who);
            const onBase = all.filter((s) => other(s).book.key === sa.key);
            if (onBase.length) row.toBase++;
            if (onBase.some(strong)) row.toBaseHigh++;
            // which engine links the line to the base at "high" or above
            for (const b of onBase.filter(strong)) for (const e of b.engines) row.baseBy[e] = (row.baseBy[e] ?? 0) + 1;
            const s = target ? all.find((x) => other(x).book.key === target.key) : undefined;
            if (!s) {
              if (row.samples.length < 6) row.samples.push({ line, want, got: all.map((x) => `${byKey.get(other(x).book.key)?.title}:${other(x).line}:${x.confidence}`), rules: all[0]!.rules.slice(0, 4) });
              continue;
            }
            row.routed++;
            const o = other(s);
            const info = tLines.get(target!.key)!;
            const sim = dSiman.get(line);
            const tSim = info.siman.get(o.line);
            const lv = (row.levels[s.confidence] ??= [0, 0]);
            if (sim === undefined || tSim === undefined) {
              row.undecidable++;
            } else {
              const ok = sim === tSim && info.open.get(o.line) === want.n;
              // placed by the number (dh/seif-katan) or by the words of its ד"ה
              const via = (row.via[s.rules.includes("dh/seif-katan") ? "number" : "words"] ??= [0, 0]);
              via[0]++;
              if (ok) via[1]++;
              lv[0]++;
              if (ok) (row.right++, lv[1]++);
              else {
                row.wrongPlace++;
                if (row.samples.length < 12) row.samples.push({ line, want, siman: sim, gotSiman: tSim, gotOpen: info.open.get(o.line), at: o.line, level: s.confidence });
              }
            }
            const g = gold.get(`${line}>${target!.key}`);
            if (g) (row.dbJudged++, (row.dbAgrees += g.has(o.line) ? 1 : 0));
          }
          row.ms = Math.round(performance.now() - t0);
          appendFileSync(OUT!, `${JSON.stringify(row)}\n`);
          console.log(`${d.title}: ${JSON.stringify({ ...row, samples: undefined })}`);
          for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += row[k as keyof typeof row] as number;
          for (const [k, v] of Object.entries(row.levels)) ((byLevel[k] ??= [0, 0])[0] += v[0]), (byLevel[k]![1] += v[1]);
          for (const [k, v] of Object.entries(row.via)) ((byVia[k] ??= [0, 0])[0] += v[0]), (byVia[k]![1] += v[1]);
          for (const [k, v] of Object.entries(row.baseBy)) baseBy[k] = (baseBy[k] ?? 0) + v;
        }
      }
      appendFileSync(OUT!, `${JSON.stringify({ total: totals, byLevel, byVia, baseBy, books: measured })}\n`);
      console.log(`TOTAL ${JSON.stringify(totals)} by level ${JSON.stringify(byLevel)} by placement ${JSON.stringify(byVia)} base links by engine ${JSON.stringify(baseBy)}`);
      expect(measured).toBeGreaterThan(0);
    } finally {
      closeSync(fd);
    }
  }, 4 * 3_600_000);
});
