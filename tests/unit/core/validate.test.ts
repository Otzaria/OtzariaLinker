import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import { storedKey } from "../../../src/core/links/stored-form";
import { validateExport, validateLink, type LineFacts, type ValidationContext } from "../../../src/core/links/validate";

const book = (title: string, extra: Partial<BookRef> = {}): BookRef => ({ key: `k:${title}`, title, origin: "otzaria", isBaseBook: false, ...extra });
const A = book("ספר א");
const B = book("ספר ב");
const SEF = book("בראשית", { origin: "sefaria", isBaseBook: true });

/** Books of 10 lines; line 0 is a heading, line 5 an empty heading; every line is 20 chars. */
const ctx: ValidationContext = {
  lineCount: () => 10,
  line: (_b, i): LineFacts | undefined => (i === 9 ? undefined : { exists: i !== 5, heading: i === 0 || i === 5 ? 2 : null, anchorLength: 20 }),
};
const link = (over: Partial<Link> = {}): Link => ({
  id: "x", status: "new", provenance: "user",
  source: { book: A, line: 1 }, target: { book: B, line: 2 },
  declaredType: "reference", heRef2: "ספר ב 3", ...over,
});
const codes = (l: Link) => validateLink(l, ctx).map((p) => `${p.severity}:${p.code}`);

describe("validateLink — generator gates", () => {
  it("a clean link has no problems", () => expect(codes(link())).toEqual([]));
  it("legacy: קישור משורת כותרת מדולג", () => expect(codes(link({ source: { book: A, line: 0 } }))).toContain("error:export/heading-line"));
  it("an empty heading line does not exist in the database", () => expect(codes(link({ target: { book: B, line: 5 } }))).toContain("error:export/line-not-in-db"));
  it("legacy: שורה מחוץ לתחום נחסמת בייצוא", () => expect(codes(link({ target: { book: B, line: 10 } }))).toContain("error:export/line-out-of-range"));
  it("an unloaded line is reported as not verified, not guessed", () => expect(codes(link({ target: { book: B, line: 9 } }))).toEqual(["info:export/line-not-verified"]));
  it("linker is never imported; an unknown type becomes OTHER", () => {
    expect(codes(link({ declaredType: "linker" }))).toContain("error:export/linker");
    expect(codes(link({ declaredType: "sifrei mitsvot" }))).toContain("warning:export/unknown-type");
  });
  it("a links file whose source title is no open book: the generator drops the whole file", () => {
    // real library case: "וזה לשונו - שובבי׳׳ם_links.json" — the database spells the book "…שובבי״ם"
    const unknown: BookRef = { key: "unresolved:וזה לשונו - שובבי׳׳ם", title: "וזה לשונו - שובבי׳׳ם", origin: "unknown" };
    expect(codes(link({ provenance: "file", status: "existing", source: { book: unknown, line: 1 } }))).toContain("warning:export/source-unknown");
    expect(codes(link())).not.toContain("warning:export/source-unknown");
  });
  it("db links cannot be exported as file records", () => expect(codes(link({ provenance: "db", status: "existing" }))).toContain("error:export/db-link"));
  it("a companion 'הערות על X' target is silently dropped by the generator", () => {
    expect(codes(link({ target: { book: book("הערות על ספר א"), line: 2 } }))).toContain("warning:export/companion-merged");
  });
  it("an Otzaria title with ASCII quotes never matches the database", () => {
    expect(codes(link({ target: { book: book('רש"י על ספר'), line: 2 } }))).toContain("error:export/title-not-normalized");
  });
  it("range end on a heading, and anchors outside the line", () => {
    expect(codes(link({ target: { book: B, line: 3, end: 5 } }))).toContain("warning:export/range-end-heading");
    expect(codes(link({ anchor: { rawStart: 25 } }))).toContain("warning:export/anchor-out-of-line");
    expect(codes(link({ anchor: { rawStart: 3, rawEnd: 2 } }))).toContain("warning:export/anchor-end-ignored");
  });
  it("an anchor on a record that the generator flips is dropped", () => {
    expect(codes(link({ declaredType: "source", anchor: { rawStart: 1 } }))).toContain("warning:export/anchor-dropped-flip");
  });
});

describe("validateLink — Sefaria rules (legacy §10 ref_1/ref_2)", () => {
  // Compatibility review B1: for a submission to the library (the default) a missing ref_2 is an
  // ERROR — the weekly sync throws new_target_ref_required and the whole refresh fails. For private use
  // it is a warning. (The builder never blocks on it: it validates as "private", and the export fills
  // the ref from the database heRef when it can.) An untouched imported record is written anyway.
  it("יעד ספריא בלי ref_2 → שגיאה לשליחה לספרייה, אזהרה לשימוש פרטי ; עם ref_2 — כלום", () => {
    expect(codes(link({ target: { book: SEF, line: 2 } }))).toContain("error:sefaria/ref2-required");
    expect(validateLink(link({ target: { book: SEF, line: 2 } }), { ...ctx, purpose: "private" }).map((p) => `${p.severity}:${p.code}`)).toContain("warning:sefaria/ref2-required");
    expect(codes(link({ target: { book: SEF, line: 2 }, ref2: "Genesis 1:3" })).filter((c) => c.includes("ref2-required"))).toEqual([]);
  });
  it("legacy: רשומה שיובאה בלי ref_2 — השגיאה מדווחת, והייצוא כותב אותה כמו שהיא", () => {
    expect(codes(link({ target: { book: SEF, line: 2 }, status: "existing", provenance: "file" }))).toContain("error:sefaria/ref2-required");
  });
  it("a range end on a Sefaria side drifts in the sync: sefaria/range-side", () => {
    expect(codes(link({ target: { book: SEF, line: 2, end: 4 }, ref2: "Genesis 1:3" }))).toContain("error:sefaria/range-side");
    expect(codes(link({ source: { book: A, line: 1, end: 3 }, target: { book: SEF, line: 2 }, ref2: "Genesis 1:3" }))).not.toContain("error:sefaria/range-side");
  });
  it("Sefaria-owned is the library's list when given (B6): a DB-Sefaria book outside it must not carry ref_2", () => {
    const lecha = book("לכה דודי", { origin: "sefaria" });
    const owned = (b: BookRef) => b.title === "בראשית";
    const c2 = (l: Link) => validateLink(l, { ...ctx, sefariaOwned: owned }).map((p) => `${p.severity}:${p.code}`);
    expect(c2(link({ target: { book: lecha, line: 2 } })).filter((c) => c.startsWith("error:sefaria"))).toEqual([]);
    expect(c2(link({ target: { book: lecha, line: 2 }, ref2: "Lekha Dodi 1" }))).toContain("error:sefaria/ref2-side");
  });
  it("legacy: ref_1 ו-ref_2 יחד → שגיאה ; ref_2 על יעד שאינו ספריא → שגיאה", () => {
    expect(codes(link({ ref1: "a", ref2: "b" }))).toContain("error:sefaria/both-refs");
    expect(codes(link({ ref2: "Genesis 1:3" }))).toContain("error:sefaria/ref2-side");
  });
  it("anchors into Sefaria and anchor ranges touching Sefaria are refused by the pipeline", () => {
    const into = codes(link({ target: { book: SEF, line: 2 }, ref2: "Genesis 1:3", anchor: { rawStart: 1, rawEnd: 3 } }));
    expect(into).toContain("error:sefaria/anchor-into-sefaria");
    expect(into).toContain("error:sefaria/anchor-range");
  });
});

describe("validateExport", () => {
  it("links that collapse into one stored link are flagged as duplicates", () => {
    const base = book("בסיס", { isBaseBook: true });
    const dep = book("פירוש על בסיס");
    const a = link({ id: "a", source: { book: dep, line: 3 }, target: { book: base, line: 4 }, declaredType: "source" });
    const b = link({ id: "b", source: { book: base, line: 4 }, target: { book: dep, line: 3 }, declaredType: "commentary" });
    const res = validateExport([a, b], ctx, storedKey);
    expect(res.get("a")!.map((p) => p.code)).not.toContain("export/duplicate");
    expect(res.get("b")!.map((p) => p.code)).toContain("export/duplicate");
  });
});

describe("heRef_2 is never blank (compatibility review B3)", () => {
  it("an empty or whitespace heRef_2 is an error: the weekly sync rejects it", () => {
    expect(codes(link({ heRef2: "" }))).toContain("error:export/heref-missing");
    expect(codes(link({ heRef2: "   " }))).toContain("error:export/heref-missing");
  });
});

describe("'הערות על X' — the real outcome (compatibility review B5, Generator.kt:1004-1008)", () => {
  const C = book("הערות על ספר א");
  it("an unanchored record is merged; an anchored one cancels the merge and keeps the link", () => {
    expect(codes(link({ target: { book: C, line: 2 } }))).toContain("warning:export/companion-merged");
    const anchored = codes(link({ target: { book: C, line: 2 }, anchor: { rawStart: 3 } }));
    expect(anchored).toContain("info:export/companion-merge-cancelled");
    expect(anchored).not.toContain("warning:export/companion-merged");
  });

  it("a new anchored record on a note line the library's file merges today is warned about", () => {
    const merged = link({ id: "f1", provenance: "file", status: "existing", target: { book: C, line: 2 } });
    const anchoredSameLine = link({ id: "n1", target: { book: C, line: 3 }, anchor: { rawStart: 3 } });
    const anchoredOtherLine = link({ id: "n2", source: { book: A, line: 4 }, target: { book: C, line: 4 }, anchor: { rawStart: 3 } });
    const out = validateExport([merged, anchoredSameLine, anchoredOtherLine], ctx, storedKey);
    expect(out.get("n1")!.map((p) => p.code)).toContain("export/companion-merge-broken");
    expect(out.get("n2")!.map((p) => p.code)).not.toContain("export/companion-merge-broken");
  });
});
