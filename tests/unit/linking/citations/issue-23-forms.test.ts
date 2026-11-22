import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../../src/core/links/model";
import { buildRefIndex, runCitationsEngine, type CitationLibrary, type RefLine } from "../../../../src/linking/automatic/citations";
import type { EngineBook } from "../../../../src/linking/automatic";

/*
 * Issue #23 (recognition part). THIS FILE IS A PIN, NOT A BUG TEST: the six forms the reporter listed were
 * already recognised by the V4/V5 engine, so none of these assertions could fail before this change. They
 * keep the behaviour from regressing. The heRef shapes are the database's own (AUTOMATION_ENGINE.md §6.4):
 * "ברכות, יז., ג", "משנה תורה, הלכות שבת, ג, ד", "שולחן ערוך, אורח חיים, קכח, ב". The books are in-memory
 * skeletons with those refs only (no book text).
 */

const ref = (key: string, title: string): BookRef => ({ key, title, origin: "sefaria" });
const BER = ref("ber", "ברכות");
const RASHI_BER = ref("rber", 'רש"י על ברכות');
const SHAB = ref("shab", "משנה תורה, הלכות שבת");
const SA_OC = ref("oc", "שולחן ערוך, אורח חיים");

const GIM = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י", "יא", "יב", "יג", "יד"];
function bavli(title: string): RefLine[] {
  const out: RefLine[] = [{ index: 0, heRef: null }];
  for (let d = 2; d <= 14; d++)
    for (const side of [".", ":"]) {
      out.push({ index: out.length, heRef: null });
      for (let s = 1; s <= 2; s++) out.push({ index: out.length, heRef: `${title}, ${GIM[d]}${side}, ${GIM[s]}` });
    }
  return out;
}
function two(title: string, a: number, b: number, names: (n: number) => string): RefLine[] {
  const out: RefLine[] = [{ index: 0, heRef: null }];
  for (let i = 1; i <= a; i++) for (let j = 1; j <= b; j++) out.push({ index: out.length, heRef: `${title}, ${names(i)}, ${GIM[j]}` });
  return out;
}

const BOOKS: { book: BookRef; refs: RefLine[] }[] = [
  { book: BER, refs: bavli("ברכות") },
  { book: RASHI_BER, refs: bavli('רש"י על ברכות') },
  { book: SHAB, refs: two("משנה תורה, הלכות שבת", 4, 5, (n) => GIM[n]!) },
  // only siman 128 (קכח) is built: a bare skeleton of the database's heRef shape
  { book: SA_OC, refs: [{ index: 0, heRef: null }, { index: 1, heRef: "שולחן ערוך, אורח חיים, קכח, א" }, { index: 2, heRef: "שולחן ערוך, אורח חיים, קכח, ב" }] },
];
const lib: CitationLibrary = {
  catalog: BOOKS.map((b) => ({ book: b.book })),
  index: (b) => buildRefIndex(b, BOOKS.find((x) => x.book.key === b.key)!.refs),
  heRefAt: (b, line) => BOOKS.find((x) => x.book.key === b.key)?.refs.find((r) => r.index === line)?.heRef ?? null,
};
const src = (text: string): EngineBook => ({ book: { key: "s", title: "חיבור כלשהו", origin: "otzaria" }, lines: [{ index: 0, text, heading: null }] });
const run = (text: string) => runCitationsEngine(src(text), lib);

describe("issue #23 — the six forms (pin: these passed before the change)", () => {
  // [text, book, the label the suggestion shows, the first heRef of the place it points to]. A daf points to its
  // amud's heading line (no heRef of its own; the amud's first line follows), so its label is the written place.
  const forms: [string, BookRef, string, string][] = [
    ["כמו שאמרו ברכות יג: ושם", BER, "ברכות יג:", "ברכות, יג:, א"],
    ["ועיין ברכות יג. ושם", BER, "ברכות יג.", "ברכות, יג., א"],
    ['ועיין ברכות דף יג ע"ב ושם', BER, "ברכות יג:", "ברכות, יג:, א"],
    ['ועיין רש"י ברכות יג: ושם', RASHI_BER, 'רש"י על ברכות יג:', 'רש"י על ברכות, יג:, א'],
    ['ועיין רמב"ם הלכות שבת פרק ג הלכה ד ושם', SHAB, "משנה תורה, הלכות שבת, ג, ד", "משנה תורה, הלכות שבת, ג, ד"],
    ['ועיין שו"ע או"ח סימן קכח סעיף ב ושם', SA_OC, "שולחן ערוך, אורח חיים, קכח, ב", "שולחן ערוך, אורח חיים, קכח, ב"],
  ];
  it.each(forms)("%s", (text, book, label, heRef) => {
    const r = run(text);
    expect(r.suggestions).toHaveLength(1);
    const s = r.suggestions[0]!;
    expect(s.target.book.key).toBe(book.key);
    expect(s.heRef2).toBe(label);
    expect(s.confidence).toBe("certain");
    expect(s.declaredType).toBe("reference");
    // the place the heRef names (an amud's start; no range into a Sefaria book)
    expect([lib.heRefAt!(book, s.target.line), lib.heRefAt!(book, s.target.line + 1)]).toContain(heRef);
    expect(s.target.end).toBeUndefined();
  });
});

describe("issue #23 — false-positive guards (running text that only looks like a citation)", () => {
  it.each([
    "ברכות ה' על כל אחד ואחד",
    "דבר ברכות וקללות",
    "שבת שלום ומבורך",
    "נכתב בשנת תשנ\"ג ברכות רבות",
    "אמר רבי יוסי בן חלפתא שהדבר כך",
  ])("no suggestion for %s", (text) => {
    expect(run(text).suggestions).toHaveLength(0);
  });
});

describe("issue #23 — the target books are not open: zero results come with the reason", () => {
  const local = { key: "loc", title: "ספר מקומי", origin: "otzaria" } as const;
  const emptyLib: CitationLibrary = { catalog: [{ book: local }], index: () => null as never, heRefAt: () => null };
  const TEXT = 'כמו שאמרו ברכות יג: ועיין רמב"ם הלכות שבת פרק ג הלכה ד';

  it("a library without Tanakh, Shas, Mishneh Torah or Shulchan Aruch says so, and what to do", () => {
    const r = runCitationsEngine(src(TEXT), emptyLib);
    expect(r.suggestions).toHaveLength(0);
    const note = r.notes.find((n) => n.code === "citations/no-target-books");
    expect(note).toBeDefined();
    // the cause is stated as a possibility: the book may simply cite nothing
    expect(note!.text).toContain("ייתכן");
    expect(note!.text).toContain("תנ\"ך");
    expect(note!.text).toContain("ש\"ס");
    expect(note!.text).toContain("משנה תורה");
    expect(note!.text).toContain("שולחן ערוך");
  });

  it("names only the collections that are missing", () => {
    const only = BOOKS.filter((b) => b.book.key === "ber" || b.book.key === "rber");
    const half: CitationLibrary = { ...lib, catalog: only.map((b) => ({ book: b.book })) };
    const r = runCitationsEngine(src("שום מראה מקום כאן"), half);
    const note = r.notes.find((n) => n.code === "citations/no-target-books")!;
    expect(note.text).not.toContain("ש\"ס");
    expect(note.text).toContain("תנ\"ך");
  });

  it("no such note when citations were found", () => {
    expect(run('ועיין ברכות יג: ושם').notes.map((n) => n.code)).not.toContain("citations/no-target-books");
  });
});
