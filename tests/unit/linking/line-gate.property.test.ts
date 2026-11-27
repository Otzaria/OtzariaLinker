import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../src/core/links/model";
import { headingLevel, stripTags } from "../../../src/core/text/html";
import { runEngine, runLineFilter, type EngineBook, type EngineId, type Suggestion } from "../../../src/linking/automatic";
import { compileSourceFilter, LineGate, type SourceFilter } from "../../../src/linking/automatic/source-filter";

/*
 * Findings #40 A1: the line filter is the RUN's. For any filter and any book, no engine proposes a link from a line the filter excludes —
 * whatever the engine reads for its structure (the headings engine still sees every line). The permitted lines are computed here on their
 * own, from the filter's prefix alone, never through the gate under test. Synthetic neutral words; no book text.
 */
const ref = (key: string, title: string): BookRef => ({ key, title, origin: "otzaria" });
const BASE = ref("base", "ספר בסיס");
const COMM = ref("comm", "ביאור על ספר בסיס");
const NOTES = ref("notes", "הערות על ביאור");
const book = (r: BookRef, texts: readonly string[]): EngineBook => ({ book: r, lines: texts.map((text, index) => ({ index, text, heading: headingLevel(text) })) });
const HEB = ["א", "ב", "ג", "ד", "ה"];
const WORDS = ["אלפא", "בטא", "גמא", "דלתא", "הא", "וו", "זין", "חית", "טית", "יוד", "כף", "למד", "מם", "נון", "סמך", "עין", "פא", "צדי"];
const MARKERS = ["[א] ", "(ב) ", "ג) ", '<b>ד"ה</b> ', "{12} ", "", "<b>[ד]</b> ", "<b>[ה] "];

interface Case {
  base: string[];
  comm: string[];
  notes: string[];
}

/** a base book of chapters, and a commentary whose lines quote it after a random marker, some with a footnote mark and a cross reference */
const bookCase = fc
  .array(fc.array(fc.record({ marker: fc.constantFrom(...MARKERS), verse: fc.nat(2), note: fc.boolean(), cite: fc.boolean() }), { minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 3 })
  .map((chapters): Case => {
    const base = [`<h1>${BASE.title}</h1>`];
    const comm = [`<h1>${COMM.title}</h1>`];
    const notes = [`<h1>${NOTES.title}</h1>`];
    chapters.forEach((lines, c) => {
      base.push(`<h2>פרק ${HEB[c]}</h2>`);
      comm.push(`<h2>פרק ${HEB[c]}</h2>`);
      notes.push(`<h2>פרק ${HEB[c]}</h2>`);
      for (let v = 0; v < 3; v++) base.push(WORDS.slice((c * 5 + v * 3) % 12, ((c * 5 + v * 3) % 12) + 6).join(" "));
      let n = 0;
      for (const l of lines) {
        const quote = WORDS.slice((c * 5 + l.verse * 3) % 12, ((c * 5 + l.verse * 3) % 12) + 3).join(" ");
        const mark = l.note ? ` <sup>${++n}</sup>` : "";
        comm.push(`${l.marker}${quote}: פירוש לדברים${mark}${l.cite ? " וראה פרק ב" : ""}${l.marker.endsWith("] ") && l.marker.startsWith("<b>") ? "</b>" : ""}`);
        if (l.note) notes.push(`(${n}) הערה לדברים`);
      }
    });
    return { base, comm, notes };
  });

const filterArb: fc.Arbitrary<SourceFilter> = fc.record(
  {
    prefix: fc.oneof(fc.constantFrom("square", "round", "close-paren", "bold-dh").map((preset) => ({ preset }) as SourceFilter["prefix"]), fc.constant({ regex: String.raw`\{\d{1,3}\}` })),
    mode: fc.constantFrom("include", "exclude"),
    strip: fc.boolean(),
  },
  { requiredKeys: ["prefix"] },
) as fc.Arbitrary<SourceFilter>;

/** the lines a filter permits, from its prefix alone: a content line that starts with it (include), or every line but those (exclude) */
function permitted(lines: readonly string[], spec: SourceFilter): Set<number> {
  const c = compileSourceFilter(spec);
  if (!c.ok) throw new Error(c.reason);
  const out = new Set<number>();
  lines.forEach((text, i) => {
    const content = headingLevel(text) === null && stripTags(text).trim() !== "";
    const marked = content && c.filter.match(text) !== null;
    if ((spec.mode ?? "include") === "include" ? marked : !marked) out.add(i);
  });
  return out;
}

const commLine = (s: Suggestion) => (s.source.book.key === "comm" ? s.source.line : s.target.book.key === "comm" ? s.target.line : null);

function run(engine: EngineId, k: Case, options: Record<string, unknown>) {
  const comm = book(COMM, k.comm);
  if (engine === "footnotes") return runEngine(engine, comm, book(NOTES, k.notes), options);
  if (engine === "pattern") return runEngine(engine, comm, book(BASE, k.base), options);
  return runEngine(engine, comm, book(BASE, k.base), { ...(engine === "dibur-hamatchil" && { anchors: "off" }), ...options });
}

const ENGINES: readonly EngineId[] = ["headings", "dibur-hamatchil", "footnotes", "pattern"];
const ENGINES_BY_EVIDENCE = { words: ["dibur-hamatchil", "pattern"] as readonly EngineId[] };

describe("the line filter of a run: no suggestion from an excluded line, in any engine (#40 A1)", () => {
  for (const engine of ENGINES) {
    it(`${engine}: random filters on random books`, () => {
      // the property must have teeth: without the filter the same books do give suggestions on lines the filter excludes
      let leakWithout = 0;
      fc.assert(
        fc.property(bookCase, filterArb, (k, spec) => {
          const allowed = permitted(k.comm, spec);
          const r = run(engine, k, { sourceFilter: spec });
          for (const s of r.suggestions) {
            const line = commLine(s);
            if (line !== null && !allowed.has(line)) return false;
          }
          for (const u of r.unmatched) if (!allowed.has(u.line)) return false;
          leakWithout += run(engine, k, {}).suggestions.filter((s) => {
            const line = commLine(s);
            return line !== null && !allowed.has(line);
          }).length;
          return true;
        }),
        { numRuns: 60 },
      );
      expect(leakWithout).toBeGreaterThan(0);
    });
  }

  /*
   * The range policy (V7 round 2, item 5) through every engine: with the run's source ranges "until the next match" (linking/ranges.ts), no
   * range on the filtered book runs over a content line the filter excludes — the guard trims it, whichever engine proposed it. The property
   * has teeth: without the filter, the same ranges do cover such lines.
   */
  for (const engine of ENGINES) {
    it(`${engine}: no range on the filtered book covers an excluded line`, () => {
      let coveredWithout = 0;
      const commSide = (s: Suggestion) => (s.source.book.key === "comm" ? s.source : s.target.book.key === "comm" ? s.target : null);
      fc.assert(
        fc.property(bookCase, filterArb, (k, spec) => {
          const allowed = permitted(k.comm, spec);
          const excluded = new Set(k.comm.map((t, i) => i).filter((i) => headingLevel(k.comm[i]!) === null && stripTags(k.comm[i]!).trim() !== "" && !allowed.has(i)));
          const covers = (r: { suggestions: readonly Suggestion[] }) =>
            r.suggestions.filter((s) => {
              const side = commSide(s);
              if (!side || side.end === undefined) return false;
              for (let x = side.line + 1; x <= side.end; x++) if (excluded.has(x)) return true;
              return false;
            }).length;
          const options = { sourceRange: "next-match", ...(engine === "footnotes" && { targetRange: "next-match" }) };
          if (covers(run(engine, k, { sourceFilter: spec, ...options }))) return false;
          coveredWithout += covers(run(engine, k, options));
          return true;
        }),
        { numRuns: 60 },
      );
      // the structure engines (headings, footnotes) propose on every line, so their own suggestions already bound each range; the words engines
      // skip lines, and there the guard is what keeps a range off an excluded line
      if (ENGINES_BY_EVIDENCE.words.includes(engine)) expect(coveredWithout).toBeGreaterThan(0);
    });
  }

  it("the structure engine keeps its context: a heading engine run with a filter links the permitted lines exactly as without it", () => {
    fc.assert(
      fc.property(bookCase, filterArb, (k, spec) => {
        const allowed = permitted(k.comm, spec);
        const key = (s: Suggestion) => `${commLine(s)}>${s.target.line}:${s.confidence}`;
        const plain = run("headings", k, {}).suggestions.filter((s) => allowed.has(commLine(s) ?? -1)).map(key);
        const filtered = run("headings", k, { sourceFilter: { ...spec, strip: false } }).suggestions.map(key);
        expect(filtered.sort()).toEqual(plain.sort());
      }),
      { numRuns: 60 },
    );
  });
});

describe("LineGate — the guard alone", () => {
  const spec: SourceFilter = { prefix: { preset: "square" } };
  const lines = ["<h1>כותרת</h1>", "[א] אלפא", "א) רעש", "", "[ב] בטא"];
  const gate = () => {
    const c = compileSourceFilter(spec);
    if (!c.ok) throw new Error(c.reason);
    const g = new LineGate("comm", c.filter);
    g.book(book(COMM, lines));
    return g;
  };
  const sug = (line: number, reversed = false): Suggestion => {
    const own = { book: COMM, line };
    const other = { book: BASE, line: 2 };
    return { id: `x${line}${reversed}`, engine: "headings", source: reversed ? other : own, target: reversed ? own : other, declaredType: "commentary", heRef2: "", score: 1, confidence: "certain", reasons: [], rules: [], alternatives: [], warnings: [] } as Suggestion;
  };

  it("drops a suggestion of an excluded line on either side of the record, keeps the permitted ones, and says how many", () => {
    const r = gate().guard({ suggestions: [sug(1), sug(2), sug(2, true), sug(0), sug(4, true)], notes: [], unmatched: [{ line: 2, reasons: [] }, { line: 4, reasons: [] }] });
    expect(r.suggestions.map((s) => commLine(s))).toEqual([1, 4]);
    expect(r.unmatched.map((u) => u.line)).toEqual([4]);
    expect(r.notes[0]).toMatchObject({ code: "source-filter/guard" });
    expect(r.notes[0]!.text).toContain("3");
  });

  // V7 PR2 review, finding 6: an internal reference ("לעיל", "לקמן") has both sides in the filtered book; each side is a line of it
  it("a suggestion with both sides in the filtered book is kept only when both lines are permitted", () => {
    const internal = (from: number, to: number): Suggestion => ({ ...sug(from), id: `i${from}>${to}`, target: { book: COMM, line: to } });
    const r = gate().guard({ suggestions: [internal(4, 1), internal(4, 2), internal(1, 2), internal(2, 4)], notes: [], unmatched: [] });
    expect(r.suggestions.map((s) => `${s.source.line}>${s.target.line}`)).toEqual(["4>1"]);
  });

  it("a suggestion of another book is not the gate's to judge", () => {
    const other = { ...sug(2), source: { book: NOTES, line: 2 } };
    expect(gate().guard({ suggestions: [other], notes: [], unmatched: [] }).suggestions).toHaveLength(1);
  });

  /*
   * The policy for a RANGE on the filtered book (V7 round 2, item 5): the start line decides whether the suggestion stays (above); a range
   * that runs over a line the filter EXCLUDES is TRIMMED to end before it — never split into pieces, never kept over it. A range never
   * ends on a heading (Otzaria drops such a range), so a cut that lands on one steps back; a cut back to the start leaves a single line.
   * Blank lines and headings are not the filter's (it judges content lines only), and a line the gate never saw is not judged either:
   * they do not cut. Every engine's result passes this guard (index.ts engineSteps, maxlink-job, citations-job).
   */
  describe("a range on the filtered book", () => {
    // 0 heading · 1 [א] · 2 [ב] · 3 blank · 4 [ג] · 5 excluded · 6 [ד] · 7 heading · 8 excluded · 9 [ה]
    const ranged = ["<h1>כותרת</h1>", "[א] אלפא", "[ב] בטא", "", "[ג] גמא", "רעש בלי סימן", "[ד] דלתא", "<h2>פרק ב</h2>", "עוד רעש", "[ה] הא"];
    const g = () => {
      const c = compileSourceFilter(spec);
      if (!c.ok) throw new Error(c.reason);
      const x = new LineGate("comm", c.filter);
      x.book(book(COMM, ranged));
      return x;
    };
    const span = (line: number, end: number, reversed = false): Suggestion => {
      const own = { book: COMM, line, end };
      const other = { book: BASE, line: 2 };
      return { ...sug(line), id: `r${line}-${end}${reversed}`, source: reversed ? other : own, target: reversed ? own : other } as Suggestion;
    };
    const ownSide = (s: Suggestion) => (s.source.book.key === "comm" ? s.source : s.target);

    it("is trimmed to end before the first excluded line, on either side of the record, with a warning and a note", () => {
      const r = g().guard({ suggestions: [span(1, 6), span(4, 6, true)], notes: [], unmatched: [] });
      expect(r.suggestions.map((s) => [ownSide(s).line, ownSide(s).end])).toEqual([
        [1, 4],
        [4, undefined],
      ]);
      expect(r.suggestions.every((s) => s.warnings.some((w) => w.code === "source-filter/range-trimmed"))).toBe(true);
      expect(r.suggestions[0]!.warnings.find((w) => w.code === "source-filter/range-trimmed")!.text).toContain("6");
      expect(r.notes.find((n) => n.code === "source-filter/range-trimmed")?.text).toContain("2");
    });

    it("blank lines and headings inside the range do not cut it; a cut that lands on a heading steps back from it", () => {
      const r = g().guard({ suggestions: [span(1, 2), span(1, 4), span(6, 9)], notes: [], unmatched: [] });
      expect(r.suggestions.map((s) => [ownSide(s).line, ownSide(s).end])).toEqual([
        [1, 2],
        [1, 4],
        [6, undefined], // 8 is excluded: the cut is at 7, a heading, so it steps back to 6 — a single line
      ]);
      expect(r.suggestions.slice(0, 2).some((s) => s.warnings.length)).toBe(false);
      expect(r.notes.some((n) => n.code === "source-filter/range-trimmed")).toBe(true);
    });

    it("an excluded start still drops the whole suggestion (no range is moved to a permitted line)", () => {
      expect(g().guard({ suggestions: [span(5, 6)], notes: [], unmatched: [] }).suggestions).toEqual([]);
    });

    it("the single-line records of a span (spanLines) on the filtered book keep only the permitted lines, and the cited span is trimmed like a range", () => {
      const s: Suggestion = { ...span(1, 1, true), target: { book: COMM, line: 1 }, citedSpan: { line: 1, end: 6 }, spanLines: [1, 2, 4, 5, 6].map((line) => ({ line, heRef2: `h${line}` })) };
      const [out] = g().guard({ suggestions: [s], notes: [], unmatched: [] }).suggestions;
      expect(out!.spanLines?.map((x) => x.line)).toEqual([1, 2, 4]);
      expect(out!.citedSpan).toEqual({ line: 1, end: 4 });
    });

    it("exclude mode: a range over a marked line is trimmed before it", () => {
      const c = compileSourceFilter({ ...spec, mode: "exclude" });
      if (!c.ok) throw new Error(c.reason);
      const x = new LineGate("comm", c.filter);
      x.book(book(COMM, ["רעש", "עוד", "[א] אלפא", "סוף"]));
      const r = x.guard({ suggestions: [span(0, 3)], notes: [], unmatched: [] });
      expect(r.suggestions.map((s) => [ownSide(s).line, ownSide(s).end])).toEqual([[0, 1]]);
    });
  });
});

describe("runLineFilter — the run's one filter out of the forms' per-engine options", () => {
  const sq: SourceFilter = { prefix: { preset: "square" } };
  it("lifts the filter out of the engine it was chosen under, and leaves the other options", () => {
    const r = runLineFilter({ "dibur-hamatchil": { sourceFilter: sq, maxDhWords: 8 }, headings: { numbering: "strict" } });
    expect(r).toEqual({ ok: true, filter: sq, engineOptions: { "dibur-hamatchil": { maxDhWords: 8 }, headings: { numbering: "strict" } } });
  });
  it("the same filter twice is one; two different ones are a conflict; an invalid one is refused", () => {
    expect(runLineFilter({ "dibur-hamatchil": { sourceFilter: sq }, headings: { sourceFilter: { ...sq } } })).toMatchObject({ ok: true, filter: sq, engineOptions: {} });
    expect(runLineFilter({ "dibur-hamatchil": { sourceFilter: sq }, headings: { sourceFilter: { prefix: { preset: "round" } } } }).ok).toBe(false);
    expect(runLineFilter({ "dibur-hamatchil": { sourceFilter: { prefix: { regex: "(a+)+$" } } } }).ok).toBe(false);
    expect(runLineFilter(undefined, { prefix: { regex: "(a+)+$" } }).ok).toBe(false);
  });
  it("an explicit run filter wins; none anywhere is none", () => {
    expect(runLineFilter({ headings: { sourceFilter: sq } }, { prefix: { preset: "round" } })).toMatchObject({ ok: true, filter: { prefix: { preset: "round" } } });
    expect(runLineFilter({}, null)).toEqual({ ok: true, filter: null, engineOptions: {} });
  });
});
