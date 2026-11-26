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
