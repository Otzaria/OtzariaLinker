import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../../src/core/links/model";
import { countVisibleChars } from "../../../../src/core/text/offsets";
import { buildHeadingsIndex, buildRefIndex, runCitationsEngine, type CitationLibrary, type RefLine } from "../../../../src/linking/automatic/citations";
import type { EngineBook } from "../../../../src/linking/automatic";

const ref = (key: string, title: string, origin: BookRef["origin"] = "sefaria"): BookRef => ({ key, title, origin });
const GEN = ref("gen", "בראשית");
const BER = ref("ber", "ברכות");

/** heRefs shaped like the database's: two heading lines, then "בראשית, א, א"… */
function tanakhRefs(title: string, chapters: number[]): RefLine[] {
  const out: RefLine[] = [{ index: 0, heRef: null }, { index: 1, heRef: null }];
  const g = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י", "יא", "יב"];
  chapters.forEach((verses, c) => {
    out.push({ index: out.length, heRef: null }); // the chapter heading
    for (let v = 1; v <= verses; v++) out.push({ index: out.length, heRef: `${title}, ${g[c + 1]}, ${g[v]}` });
  });
  return out;
}
function bavliRefs(title: string, dapim: number): RefLine[] {
  const out: RefLine[] = [{ index: 0, heRef: null }];
  const g = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"];
  for (let d = 2; d <= dapim; d++)
    for (const side of [".", ":"]) {
      out.push({ index: out.length, heRef: null });
      for (let s = 1; s <= 3; s++) out.push({ index: out.length, heRef: `${title}, ${g[d]}${side}, ${g[s]}` });
    }
  return out;
}

function library(extra: { book: BookRef; refs?: RefLine[]; lines?: EngineBook["lines"] }[] = []): CitationLibrary {
  const books = [{ book: GEN, refs: tanakhRefs("בראשית", [5, 6, 4]) }, { book: BER, refs: bavliRefs("ברכות", 6) }, ...extra];
  return {
    catalog: books.map((b) => ({ book: b.book })),
    index: (b) => {
      const x = books.find((y) => y.book.key === b.key)!;
      return x.refs ? buildRefIndex(b, x.refs) : buildHeadingsIndex(b, x.lines!);
    },
    heRefAt: (b, line) => books.find((y) => y.book.key === b.key)?.refs?.find((r) => r.index === line)?.heRef ?? null,
  };
}

const source = (lines: string[], origin: BookRef["origin"] = "otzaria"): EngineBook => ({
  book: ref("src", "חיבור כלשהו", origin),
  lines: lines.map((text, index) => ({ index, text, heading: /^<h\d/.test(text) ? 2 : null })),
});

describe("citations engine (in memory)", () => {
  it("links a verse citation to the verse line, type reference, deterministic id", () => {
    const r = runCitationsEngine(source(["<h2>פרק</h2>", "כמו שנאמר (בראשית ב, ג) ועוד"]), library());
    expect(r.suggestions).toHaveLength(1);
    const s = r.suggestions[0]!;
    expect(s.engine).toBe("citations");
    expect(s.declaredType).toBe("reference");
    expect(s.source).toEqual({ book: ref("src", "חיבור כלשהו", "otzaria"), line: 1 });
    // chapter 2 starts after: 2 headers + heading + 5 verses + heading → verse 1 at 9, verse 3 at 11
    expect(s.target).toEqual({ book: GEN, line: 11 });
    expect(s.heRef2).toBe("בראשית, ב, ג");
    expect(s.confidence).toBe("certain");
    const again = runCitationsEngine(source(["<h2>פרק</h2>", "כמו שנאמר (בראשית ב, ג) ועוד"]), library());
    expect(again.suggestions[0]!.id).toBe(s.id);
    // a heading line is never a source (the generator drops such links)
    expect(runCitationsEngine(source(["<h2>בראשית ב, ג</h2>"]), library()).suggestions).toHaveLength(0);
  });

  it("a daf with its amud links to the amud's range; a daf without one to both sides", () => {
    const r = runCitationsEngine(source(["עיין ברכות ג. ושם", 'ועיין ברכות דף ה\' ובתוך']), library());
    const [a, b] = r.suggestions;
    // daf ב: heading(1) 2-4, heading(5) 6-8; daf ג.: heading 9, lines 10-12
    expect(a!.target).toEqual({ book: BER, line: 10, end: 12 });
    expect(b!.target.line).toBeLessThan(b!.target.end!);
    expect(b!.warnings.map((w) => w.code)).toContain("citations/whole-daf");
    expect(CONF(b!)).toBeLessThan(CONF(a!));
  });

  it("anchors: generator-exact offsets between two Otzaria books, none towards a Sefaria book", () => {
    const local = ref("loc", "ספר מקומי", "otzaria");
    const lines = ["<h1>ספר מקומי</h1>", "<h2>סימן א</h2>", "תוכן א", "<h2>סימן ב</h2>", "תוכן ב"];
    const lib = library([{ book: local, lines: lines.map((text, index) => ({ index, text, heading: /^<h(\d)/.exec(text) ? Number(/^<h(\d)/.exec(text)![1]) : null })) }]);
    const text = "<b>עיין</b> &quot;ספר מקומי&quot; סימן ב ובסוף (בראשית א, ב)";
    const r = runCitationsEngine(source([text]), lib);
    const toLocal = r.suggestions.find((s) => s.target.book.key === "loc")!;
    expect(toLocal.target).toEqual({ book: local, line: 4 });
    const a = toLocal.anchor!;
    expect(text.slice(a.rawStart, a.rawEnd)).toBe("ספר מקומי&quot; סימן ב");
    // what the generator will store: visible offsets of the same words
    const visible = text.replace(/<[^>]*>/g, "").replace(/&quot;/g, '"');
    expect(visible.slice(countVisibleChars(text, a.rawStart), countVisibleChars(text, a.rawEnd!))).toBe('ספר מקומי" סימן ב');
    const toGen = r.suggestions.find((s) => s.target.book.key === "gen")!;
    expect(toGen.anchor).toBeUndefined();
    expect(r.notes.map((n) => n.code)).toContain("citations/anchors-sefaria");
  });

  it("no anchor from a Sefaria source, nor on a line with merged notes", () => {
    const local = ref("loc", "ספר מקומי", "otzaria");
    const lib = library([{ book: local, lines: [{ index: 0, text: "<h2>סימן א</h2>", heading: 2 }, { index: 1, text: "תוכן", heading: null }] }]);
    expect(runCitationsEngine(source(["ספר מקומי סימן א"], "sefaria"), lib).suggestions[0]!.anchor).toBeUndefined();
    const notes = runCitationsEngine(source(['ספר מקומי סימן א<i class="footnote">הערה</i>']), lib).suggestions[0]!;
    expect(notes.anchor).toBeUndefined();
    expect(notes.warnings.map((w) => w.code)).toContain("citations/anchor-skipped-notes");
  });

  it("a location that does not exist is reported, not guessed", () => {
    const r = runCitationsEngine(source(["כמו שנאמר (בראשית ט, ג) ועוד"]), library());
    expect(r.suggestions).toHaveLength(0);
    expect(r.unmatched[0]!.reasons[0]!.code).toBe("citations/location-not-found");
  });

  it("options: minimum confidence, ranges off, anchors off", () => {
    const lines = ["עיין ברכות דף ה' ושם", "כמו שנאמר (בראשית ב, ג)"];
    expect(runCitationsEngine(source(lines), library(), { minConfidence: "certain" }).suggestions.every((s) => s.confidence === "certain")).toBe(true);
    const noRange = runCitationsEngine(source(lines), library(), { ranges: false });
    expect(noRange.suggestions.every((s) => s.target.end === undefined)).toBe(true);
  });

  it("ibid follows the book its antecedent was linked to", () => {
    const r = runCitationsEngine(source(["כמו שנאמר (בראשית ב, ג) ועוד", "וכן (שם פסוק ד) ועוד", "וכן (שם)"]), library());
    expect(r.suggestions.map((s) => [s.target.line, s.rules.find((x) => x.startsWith("citations.ibid"))])).toEqual([
      [11, undefined],
      [12, "citations.ibid-partial"],
      [12, "citations.ibid-full"],
    ]);
    expect(r.suggestions[1]!.confidence).not.toBe("certain");
  });
});

const CONF = (s: { score: number }) => s.score;
