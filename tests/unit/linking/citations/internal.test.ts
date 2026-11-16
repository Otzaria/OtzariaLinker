import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../../src/core/links/model";
import { buildHeadingsIndex, buildRefIndex, runCitationsEngine, type CitationLibrary, type RefLine } from "../../../../src/linking/automatic/citations";
import { StructureTracker } from "../../../../src/linking/automatic/citations/self";
import type { EngineBook } from "../../../../src/linking/automatic";

/*
 * References inside the citing book ("לעיל סי' ה", "לקמן כלל ז סי' ח"), self.ts. The shapes are the
 * library's: חכמת אדם is "כלל" › "סימן" with heRef "חכמת אדם, ז, ג" and only the כלל as headings; חוות דעת
 * is a text book with "סימן" headings and bare "א", "ב" sub-headings (the ס"ק).
 */
const ref = (key: string, title: string, origin: BookRef["origin"] = "sefaria"): BookRef => ({ key, title, origin });
const GEN = ref("gen", "בראשית");

/** a book "כלל" › "סימן": headings for the כללים only, heRefs for every line ("<title>, ז, ג") */
function klalBook(title: string, klalim: number, simanim: number): { lines: EngineBook["lines"] & { heRef?: string | null }[]; refs: RefLine[] } {
  const g = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"];
  const lines: { index: number; text: string; heading: number | null; heRef: string | null }[] = [{ index: 0, text: `<h1>${title}</h1>`, heading: 1, heRef: null }];
  for (let k = 1; k <= klalim; k++) {
    lines.push({ index: lines.length, text: `<h2>כלל ${g[k]}</h2>`, heading: 2, heRef: null });
    for (let s = 1; s <= simanim; s++) lines.push({ index: lines.length, text: `(${g[s]}) דין ${k}.${s}`, heading: null, heRef: `${title}, ${g[k]}, ${g[s]}` });
  }
  return { lines, refs: lines.map((l) => ({ index: l.index, heRef: l.heRef })) };
}

function libraryOf(self: { book: BookRef; refs?: RefLine[]; lines?: EngineBook["lines"] }): CitationLibrary {
  const books = [{ book: GEN, refs: [{ index: 0, heRef: "בראשית, א, א" }] as RefLine[] }, self];
  return {
    catalog: books.map((b) => ({ book: b.book })),
    index: (b) => {
      const x = books.find((y) => y.book.key === b.key)!;
      return x.refs ? buildRefIndex(b, x.refs) : buildHeadingsIndex(b, x.lines!);
    },
  };
}

describe("internal references: a place in the citing book itself", () => {
  it("the headings tell each level's kind; the levels above the first one named are the citing line's", () => {
    const CA = ref("ca", "חכמת אדם", "otzaria");
    const { lines, refs } = klalBook("חכמת אדם", 3, 4);
    // line 13 = כלל ג סימן א; write references there and in כלל א
    const at = (k: number, s: number) => lines.findIndex((l) => l.heRef === `חכמת אדם, ${["", "א", "ב", "ג"][k]}, ${["", "א", "ב", "ג", "ד"][s]}`);
    const text = new Map<number, string>([
      [at(3, 2), "כמו שכתבתי לעיל סי' ד' ועיין לעיל כלל א' סימן ב'"],
      [at(1, 1), "ועיין לקמן כלל ג' ובכלל ב' (לקמן סי' ג')"],
    ]);
    const src: EngineBook = { book: CA, lines: lines.map((l) => ({ ...l, text: text.get(l.index) ?? l.text })) };
    const r = runCitationsEngine(src, libraryOf({ book: CA, refs }));
    const got = r.suggestions.filter((s) => s.target.book.key === "ca").map((s) => [s.source.line, s.target.line, s.target.end, s.confidence]);
    expect(got).toEqual([
      // "לקמן כלל ג'": the whole כלל (an Otzaria book: a range)
      [at(1, 1), at(3, 1), at(3, 4), "high"],
      // "לקמן סי' ג'" in כלל א: כלל א סימן ג (one line: no range)
      [at(1, 1), at(1, 3), undefined, "high"],
      // "לעיל סי' ד'" in כלל ג: כלל ג סימן ד lies AFTER the citing line — not "לעיל": no link
      // "לעיל כלל א' סימן ב'"
      [at(3, 2), at(1, 2), undefined, "high"],
    ]);
    const s = r.suggestions.find((x) => x.target.line === at(1, 2))!;
    expect(s.rules).toContain("citations.internal");
    expect(s.anchor).toBeDefined();
  });

  it("not when another book is named next to it, not without a level word, not a daf", () => {
    const CA = ref("ca", "חכמת אדם", "otzaria");
    const { lines, refs } = klalBook("חכמת אדם", 2, 4);
    const last = lines.length - 1;
    const src = (t: string): EngineBook => ({ book: CA, lines: lines.map((l) => ({ ...l, text: l.index === last ? t : l.text })) });
    const internal = (t: string) => runCitationsEngine(src(t), libraryOf({ book: CA, refs })).suggestions.filter((s) => s.target.book.key === "ca");
    expect(internal("עיין לעיל סי' ב'")).toHaveLength(1);
    // the ט"ז's own "לעיל", and a book named after the place
    expect(internal("והט\"ז לעיל סי' ב'")).toHaveLength(0);
    expect(internal("עיין לעיל סי' ב' בט\"ז")).toHaveLength(0);
    // a bare number says nothing of the level; "לעיל ב' ע"א" is a daf
    expect(internal("עיין לעיל ב' ג'")).toHaveLength(0);
    expect(internal("עיין לעיל ב' ע\"א")).toHaveLength(0);
  });

  it("a text book: the heading path ('סימן' › bare letters) places a ס\"ק inside the current siman", () => {
    const CD = ref("cd", "חוות דעת ביאורים", "otzaria");
    const raw = ["<h1>חוות דעת</h1>", "<h2>סימן א</h2>", "<h3>א</h3>", "דין א", "<h3>ב</h3>", "דין ב", "<h2>סימן ב</h2>", "<h3>א</h3>", "דין", "<h3>ב</h3>", "ועיין לעיל ס\"ק א' ובסימן א' ס\"ק ב'"];
    const lines = raw.map((text, index) => ({ index, text, heading: /^<h(\d)/.exec(text) ? Number(/^<h(\d)/.exec(text)![1]) : null }));
    const r = runCitationsEngine({ book: CD, lines }, libraryOf({ book: CD, lines }));
    const got = r.suggestions.filter((s) => s.target.book.key === "cd").map((s) => s.target.line);
    // "לעיל ס"ק א'" = סימן ב ס"ק א (line 8); "ובסימן א' ס"ק ב'" after it is another place, without its own "לעיל"
    expect(got).toEqual([8]);
  });

  it('"(להלן פסוק ג)" in the Yalkut is no level of the book itself, and no guess of a chapter', () => {
    const YS = ref("ys", "ילקוט שמעוני על התורה", "otzaria");
    // "רמז" headings over references "<title>, רמז, קטע": the second level is the Yalkut's own paragraph, not a verse
    const lines = [
      { index: 0, text: "<h2>רמז א</h2>", heading: 2, heRef: null },
      { index: 1, text: "(בראשית א ב) והארץ היתה", heading: null, heRef: "ילקוט שמעוני על התורה, א, א" },
      { index: 2, text: "שנאמר (להלן פסוק ג) ויאמר", heading: null, heRef: "ילקוט שמעוני על התורה, א, ב" },
      { index: 3, text: "<h2>רמז ב</h2>", heading: 2, heRef: null },
      { index: 4, text: "ועוד", heading: null, heRef: "ילקוט שמעוני על התורה, ב, א" },
      { index: 5, text: "ועוד", heading: null, heRef: "ילקוט שמעוני על התורה, ב, ב" },
      { index: 6, text: "ועוד", heading: null, heRef: "ילקוט שמעוני על התורה, ב, ג" },
      { index: 7, text: "כמו שאמרנו (לעיל סעיף ג) וכן", heading: null, heRef: "ילקוט שמעוני על התורה, ב, ג" },
    ];
    const gen = [{ index: 0, heRef: null }, { index: 1, heRef: "בראשית, א, ב" }, { index: 2, heRef: "בראשית, א, ג" }] as RefLine[];
    const lib: CitationLibrary = { catalog: [{ book: GEN }, { book: YS }], index: (b) => (b.key === "gen" ? buildRefIndex(b, gen) : buildRefIndex(b, lines)) };
    const r = runCitationsEngine({ book: YS, lines }, lib);
    // the verse is the Torah's, of a chapter the words do not say (the last citation is often another
    // chapter's, §6.8): no link — neither inside the Yalkut nor a guessed verse
    expect(r.suggestions.filter((x) => x.source.line === 2)).toHaveLength(0);
    // a level no heading names is taken only as a numbered paragraph (סימן, סעיף, ס"ק, אות) — and "לעיל סעיף ג"
    // here is the line itself: no link
    expect(r.suggestions.filter((x) => x.target.book.key === "ys")).toHaveLength(0);
  });

  it('the author\'s own "as explained / will be explained in siman X" (ערוך השולחן): a siman of the book itself, in the line\'s part', () => {
    // the library's shape: "ערוך השולחן, אורח חיים, ו, י" under "סימן ו" headings; the database links these
    // words to the book itself (1,853 of 3,008 such references in ערוך השולחן)
    const AH = ref("ah", "ערוך השולחן", "sefaria");
    const g = ["", "א", "ב", "ג", "ד"];
    const lines: { index: number; text: string; heading: number | null; heRef: string | null }[] = [{ index: 0, text: "<h2>אורח חיים</h2>", heading: 2, heRef: null }];
    for (let s = 1; s <= 4; s++) {
      lines.push({ index: lines.length, text: `<h3>סימן ${g[s]}</h3>`, heading: 3, heRef: null });
      for (let k = 1; k <= 3; k++) lines.push({ index: lines.length, text: `דין ${s}.${k}`, heading: null, heRef: `ערוך השולחן, אורח חיים,  ${g[s]}, ${g[k]}` });
    }
    const refs = lines.map((l) => ({ index: l.index, heRef: l.heRef }));
    const at = (s: number, k: number) => lines.findIndex((l) => l.heRef === `ערוך השולחן, אורח חיים,  ${g[s]}, ${g[k]}`);
    const run = (where: number, t: string) =>
      runCitationsEngine({ book: AH, lines: lines.map((l) => ({ ...l, text: l.index === where ? t : l.text })) }, libraryOf({ book: AH, refs }))
        .suggestions.filter((s) => s.target.book.key === "ah")
        .map((s) => [s.target.line, s.target.end, s.confidence]);
    // the future: a later siman (the whole siman: a range in a Sefaria book is its first line)
    expect(run(at(1, 2), 'ונטילה זו תקנו חכמים, ועוד יתבאר בסימן ג\' בסייעתא דשמיא')).toEqual([[at(3, 1), undefined, "high"]]);
    expect(run(at(4, 1), 'דאם לא כן הוה ליה ברכה לבטלה, כמו שנתבאר בסימן ב\' סעיף ג\'.')).toEqual([[at(2, 3), undefined, "high"]]);
    expect(run(at(4, 1), "ועיין מה שכתבתי בסימן א' בזה")).toEqual([[at(1, 1), undefined, "high"]]);
    // the tense says the direction: "נתבאר" of a siman that comes later is not the book's own
    expect(run(at(1, 2), "כמו שנתבאר בסימן ג'")).toEqual([]);
    // another book named right after it is that book's siman
    expect(run(at(4, 1), "כמו שנתבאר בסימן א' בט\"ז")).toEqual([]);
    // "כמבואר" (as is explained — anywhere) is no word of the author's own book
    expect(run(at(4, 1), "כמבואר בסימן א'")).toEqual([]);
    // "(וע"ל סי' קס"ט)" — the Shulchan Aruch's עיין לעיל / עיין לקמן: either way, never the siman it stands in
    expect(run(at(1, 2), "ואם שכח אינו חוזר (וע\"ל סי' ג')")).toEqual([[at(3, 1), undefined, "high"]]);
    expect(run(at(4, 1), "וע\"ל סי' ב' סעיף ג'")).toEqual([[at(2, 3), undefined, "high"]]);
    expect(run(at(1, 2), "וע\"ל סי' א'")).toEqual([]);
  });

  it("the tracker learns a level's kind from the headings over the references, ignoring a stray match", () => {
    const t = new StructureTracker("חכמת אדם");
    t.heading(2, "<h2>כלל א</h2>");
    t.content("חכמת אדם, א, א");
    for (const [k, g] of [[2, "ב"], [3, "ג"], [4, "ד"], [5, "ה"]] as const) {
      t.heading(2, `<h2>כלל ${g}</h2>`);
      t.content(`חכמת אדם, ${g}, א`);
      expect(k).toBeGreaterThan(1);
    }
    // "כלל ג" over a line whose first level is not ג (a heading out of step): matched one level down once
    t.heading(2, "<h2>כלל ג</h2>");
    t.content("חכמת אדם, ז, ג");
    expect(t.depthKinds()).toEqual(["klal", null]);
    expect(t.here()).toEqual({ keys: ["n7", "n3"], path: [{ kind: "klal", n: 3 }] });
    // fewer than 80% of a kind's headings at one level: no kind for it
    const u = new StructureTracker("ספר");
    u.heading(2, "<h2>כלל א</h2>");
    u.content("ספר, ב, א");
    u.heading(2, "<h2>כלל ב</h2>");
    u.content("ספר, ב, א");
    expect(u.depthKinds()).toEqual([null, null]);
  });
});
