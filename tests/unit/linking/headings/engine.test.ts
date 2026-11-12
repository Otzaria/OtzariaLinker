import { describe, expect, it } from "vitest";
import { headingLevel } from "../../../../src/core/text/html";
import type { EngineBook } from "../../../../src/linking/automatic/types";
import { runHeadingsEngine } from "../../../../src/linking/automatic/headings";

/* Small hand-made books: one string per line, "<hN>" lines are headings exactly as the generator sees them. */
function book(key: string, title: string, lines: readonly string[], heRefs?: readonly (string | null)[]): EngineBook {
  return {
    book: { key, title, origin: "otzaria" },
    lines: lines.map((text, index) => ({ index, text, heading: headingLevel(text), heRef: heRefs?.[index] ?? null })),
  };
}

const TORAH = book("b:torah", "בראשית", [
  "<h1>בראשית</h1>", //            0
  "<h2>פרק א</h2>", //             1
  "(א) בראשית ברא אלהים", //       2
  "(ב) והארץ היתה תהו ובהו", //    3
  "(ג) ויאמר אלהים יהי אור", //    4
  "<h2>פרק ב</h2>", //             5
  "(א) ויכלו השמים והארץ", //      6
  "(ב) ויכל אלהים ביום השביעי", // 7
]);

const at = (r: ReturnType<typeof runHeadingsEngine>, line: number) => r.suggestions.find((s) => s.source.line === line);

describe("headings engine — nesting", () => {
  const rashi = book("c:rashi", 'רש"י על בראשית', [
    '<h1>רש"י על בראשית</h1>', // 0
    "רש״י", //                    1  author line: no position
    "<h2>פרק א</h2>", //          2
    "<h3>פסוק א</h3>", //         3
    "בראשית. אמר רבי יצחק", //    4
    "ברא אלהים. ולא נאמר", //     5
    "<h3>פסוק ג</h3>", //         6
    "יהי אור. כמשמעו", //         7
    "<h2>פרק ב</h2>", //          8
    "פתיחה לפרק בלי פסוק", //     9
    "<h3>פסוק ב</h3>", //         10
    "ויכל אלהים. רבי שמעון", //   11
  ]);
  const r = runHeadingsEngine(rashi, TORAH);

  it("a פסוק heading lands on the base line numbered (N) in the same chapter — certain", () => {
    expect(at(r, 4)!.target).toMatchObject({ line: 2 });
    expect(at(r, 5)!.target).toMatchObject({ line: 2 });
    expect(at(r, 7)!.target).toMatchObject({ line: 4 });
    expect(at(r, 11)!.target).toMatchObject({ line: 7 });
    for (const l of [4, 5, 7, 11]) expect(at(r, l)!.confidence).toBe("certain");
    expect(at(r, 4)!.reasons.map((x) => x.text)).toContain("מספר הפרק תואם (א)");
    expect(at(r, 4)!.rules).toContain("headings.path-exact");
  });

  it("a line with only a chapter above it links to the chapter's content range, never its heading", () => {
    const s = at(r, 9)!;
    expect(s.target).toMatchObject({ line: 6, end: 7 });
    expect(s.confidence).toBe("high");
    expect(s.rules).toContain("headings.range");
  });

  it("headings, title and author lines are never sources; the author line is reported unmatched", () => {
    for (const l of [0, 2, 3, 6, 8, 10]) expect(at(r, l)).toBeUndefined();
    expect(r.unmatched.map((u) => u.line)).toEqual([1]);
    expect(r.unmatched[0]!.reasons[0]!.code).toBe("heading/no-position");
  });

  it("ids are deterministic and carry engine, source and target; defaults are commentary", () => {
    const again = runHeadingsEngine(rashi, TORAH);
    expect(again.suggestions.map((s) => s.id)).toEqual(r.suggestions.map((s) => s.id));
    expect(at(r, 4)!.id).toBe("headings:c:rashi:4>b:torah:2");
    expect(at(r, 9)!.id).toBe("headings:c:rashi:9>b:torah:6-7");
    expect(at(r, 4)!.declaredType).toBe("source");
    expect(runHeadingsEngine(rashi, TORAH, { declaredType: "targum" }).suggestions[0]!.declaredType).toBe("targum");
  });

  it("heRef2: the base line's heRef when given, else title + Hebrew path", () => {
    expect(at(r, 4)!.heRef2).toBe("בראשית פרק א, א");
    expect(at(r, 9)!.heRef2).toBe("בראשית פרק ב");
    const withRefs = book("b:torah", "בראשית", TORAH.lines.map((l) => l.text), [null, null, "בראשית, א, א", "בראשית, א, ב", "בראשית, א, ג", null, "בראשית, ב, א", "בראשית, ב, ב"]);
    const r2 = runHeadingsEngine(rashi, withRefs);
    expect(at(r2, 4)!.heRef2).toBe("בראשית, א, א");
    expect(at(r2, 9)!.heRef2).toBe("בראשית פרק ב"); // a range is never labelled with its first verse
  });

  it("a verse missing in the base gives a PARTIAL link to the chapter, with a warning", () => {
    const c = book("c:x", "פירוש", ["<h2>פרק א</h2>", "<h3>פסוק ט</h3>", "פירוש על פסוק שאינו קיים"]);
    const s = runHeadingsEngine(c, TORAH).suggestions[0]!;
    expect(s.target).toMatchObject({ line: 2, end: 4 });
    expect(s.confidence).toBe("possible");
    expect(s.rules).toContain("headings.path-partial");
    expect(s.warnings.map((w) => w.code)).toContain("heading/partial");
  });

  it("a chapter missing in the base is unmatched with a reason", () => {
    const c = book("c:x", "פירוש", ["<h2>פרק ט</h2>", "פירוש על פרק שאינו קיים"]);
    const res = runHeadingsEngine(c, TORAH);
    expect(res.suggestions).toEqual([]);
    expect(res.unmatched[0]).toMatchObject({ line: 1, reasons: [{ code: "heading/not-found" }] });
  });
});

describe("headings engine — targum with parallel numbered lines", () => {
  const targum = book("c:onk", "אונקלוס על בראשית", [
    "<h1>אונקלוס על בראשית</h1>",
    "<h2>פרק א</h2>",
    "(א) בקדמין ברא ייי",
    "(ב) וארעא הות צדיא",
    "(ג) ואמר ייי יהי נהורא",
    "<h2>פרק ב</h2>",
    "(א) ואשתכללו שמיא וארעא",
    "(ב) ושיצי ייי ביומא שביעאה",
  ]);

  it("auto mode uses the (N) numbers because they run parallel to the base's", () => {
    const r = runHeadingsEngine(targum, TORAH);
    expect(r.suggestions.map((s) => [s.source.line, s.target.line, s.target.end, s.confidence])).toEqual([
      [2, 2, undefined, "certain"], [3, 3, undefined, "certain"], [4, 4, undefined, "certain"],
      [6, 6, undefined, "certain"], [7, 7, undefined, "certain"],
    ]);
    expect(r.notes.map((n) => n.code)).toContain("heading/markers-parallel");
  });

  it("non-parallel numbers (ס\"ק vs סעיף) are ignored: the link goes to the whole סימן", () => {
    const sa = book("b:sa", "שולחן ערוך", ["<h2>סימן א</h2>", "(א) יתגבר כארי", "(ב) המשכים", "<h2>סימן ב</h2>", "(א) לא ילבש"]);
    const mb = book("c:mb", "משנה ברורה", ["<h2>סימן א</h2>", "(א) יתגבר וכו'", "(ב) כארי", "(ג) לעמוד", "(ד) בבוקר", "(ה) עוד", "<h2>סימן ב</h2>", "(א) לא ילבש"]);
    const r = runHeadingsEngine(mb, sa);
    expect(r.notes.map((n) => n.code)).toContain("heading/markers-not-parallel");
    expect(r.suggestions.map((s) => [s.source.line, s.target.line, s.target.end, s.confidence])).toEqual([
      [1, 1, 2, "high"], [2, 1, 2, "high"], [3, 1, 2, "high"], [4, 1, 2, "high"], [5, 1, 2, "high"],
      [7, 4, undefined, "high"], // the whole סימן ב, although it has one line: the base divides it, the commentary does not
    ]);
    // forcing the numbers on reads them as the base's numbered lines
    const forced = runHeadingsEngine(mb, sa, { inlineMarkers: "always" });
    expect(forced.suggestions.find((s) => s.source.line === 2)!.target).toMatchObject({ line: 2 });
  });
});

describe("headings engine — daf and amud", () => {
  const bavli = book("b:ber", "ברכות", [
    "<h1>ברכות</h1>", //    0
    "<h2>דף ב.</h2>", //    1
    "מאימתי קורין", //      2
    "גמרא תנא היכא קאי", // 3
    "<h2>דף ב:</h2>", //    4
    "דילמא ביאת אורו", //   5
    "<h2>דף ג.</h2>", //    6
    "פליגא דרבי אליעזר", // 7
  ]);

  it("'.' / ':' / ע\"א / עמוד ב in the commentary match the base's amud headings", () => {
    const rashi = book("c:r", 'רש"י על ברכות', [
      '<h1>רש"י על ברכות</h1>', "<h2>פרק ראשון</h2>", '<h3>דף ב ע"א</h3>', "מאימתי. משעה", "<h3>דף ב עמוד ב</h3>", "דילמא. שיאור", "<h3>דף ג.</h3>", "פליגא. רבי",
    ]);
    const r = runHeadingsEngine(rashi, bavli);
    expect(r.suggestions.map((s) => [s.source.line, s.target.line, s.target.end ?? null])).toEqual([[3, 2, 3], [5, 5, null], [7, 7, null]]);
    // "פרק ראשון" does not exist in the base: skipped, so no longer certain
    expect(at(r, 3)!.warnings.map((w) => w.code)).toContain("heading/skipped-commentary-level");
    expect(at(r, 3)!.confidence).toBe("high");
  });

  it("a daf with no amud links to both amudim as one range", () => {
    const c = book("c:x", "חידושים", ["<h2>דף ב</h2>", "חידוש על הדף כולו"]);
    const s = runHeadingsEngine(c, bavli).suggestions[0]!;
    expect(s.target).toMatchObject({ line: 2, end: 5 });
    expect(s.rules).toContain("headings.daf-both-amudim");
    expect(s.confidence).toBe("certain");
  });

  it("an amud heading on its own inherits the last daf (DafTracker)", () => {
    const c = book("c:x", "חידושים", ["<h2>דף ב</h2>", "<h3>עמוד ב</h3>", "חידוש על עמוד ב"]);
    expect(runHeadingsEngine(c, bavli).suggestions[0]!.target).toMatchObject({ line: 5 });
  });
});

describe("headings engine — numbering, missing levels, ambiguity", () => {
  it("summed numerals (יה, רחצ) match canonical ones in lenient mode only", () => {
    const base = book("b", "בסיס", ["<h2>סימן טו</h2>", "תוכן טו", "<h2>סימן רצח</h2>", "תוכן רצח"]);
    const c = book("c", "פירוש", ["<h2>סימן יה</h2>", "על טו", "<h2>סי' רחצ</h2>", "על רצח"]);
    expect(runHeadingsEngine(c, base).suggestions.map((s) => s.target.line)).toEqual([1, 3]);
    expect(runHeadingsEngine(c, base, { numbering: "strict" }).suggestions.map((s) => s.target.line)).toEqual([]);
  });

  it("levels are matched by kind, not by tag depth; a base grouping level absent from the commentary is skipped", () => {
    const base = book("b", "משנה תורה", ["<h1>משנה תורה</h1>", "<h2>הלכות שבת</h2>", "<h3>פרק א</h3>", "(א) שביתה ממלאכה", "<h3>פרק ב</h3>", "(א) דחויה היא"]);
    const c = book("c", "כסף משנה", ["<h1>כסף משנה</h1>", "<h4>פרק ב</h4>", "<h5>הלכה א</h5>", "דחויה. כתב"]);
    const s = runHeadingsEngine(c, base).suggestions[0]!;
    expect(s.target).toMatchObject({ line: 5 });
    expect(s.warnings.map((w) => w.code)).toContain("heading/skipped-base-level");
    expect(s.confidence).toBe("certain"); // the base's named grouping is noise when the commentary has no names at all
  });

  it("the same position twice in the base is ambiguous — unless the book's order decides", () => {
    const base = book("b", "בסיס", ["<h2>חלק א</h2>", "<h3>סימן א</h3>", "א-א", "<h2>חלק ב</h2>", "<h3>סימן א</h3>", "ב-א"]);
    const c1 = book("c", "פירוש", ["<h2>סימן א</h2>", "על סימן א"]);
    const r1 = runHeadingsEngine(c1, base);
    expect(r1.suggestions[0]!.confidence).toBe("ambiguous");
    expect(r1.suggestions[0]!.alternatives.length).toBe(1);
    expect(r1.suggestions[0]!.warnings.map((w) => w.code)).toContain("heading/ambiguous");

    const base2 = book("b", "בסיס", ["<h2>חלק א</h2>", "<h3>סימן א</h3>", "א-א", "<h3>סימן ב</h3>", "א-ב", "<h2>חלק ב</h2>", "<h3>סימן א</h3>", "ב-א"]);
    // סימן ב exists once (in חלק א); the next סימן א is the one AFTER it, in חלק ב
    const c2 = book("c", "פירוש", ["<h2>סימן ב</h2>", "על א-ב", "<h2>סימן א</h2>", "על סימן א"]);
    const r2 = runHeadingsEngine(c2, base2);
    expect(r2.suggestions.find((x) => x.source.line === 1)!.target.line).toBe(4);
    const s = r2.suggestions.find((x) => x.source.line === 3)!;
    expect(s.target.line).toBe(7);
    expect(s.confidence).toBe("high");
    expect(s.rules).toContain("headings.order-tiebreak");
  });

  it("untagged headings are recognized only in the strict shape", () => {
    const base = book("b", "בסיס", ["<h2>פרק א</h2>", "תוכן א", "<h2>פרק ב</h2>", "תוכן ב"]);
    const c = book("c", "פירוש", ["פרק ב", "על פרק ב", "פרק ב ועוד מילים כאן", "המשך"]);
    const r = runHeadingsEngine(c, base);
    expect(r.suggestions.map((s) => [s.source.line, s.target.line])).toEqual([[1, 3], [2, 3], [3, 3]]);
    expect(r.notes.map((n) => n.code)).toContain("heading/untagged");
    expect(runHeadingsEngine(c, base, { untaggedHeadings: false }).suggestions).toEqual([]);
  });

  it("skips empty lines and lines with fewer than 2 Hebrew letters", () => {
    const c = book("c", "פירוש", ["<h2>פרק א</h2>", "", "א", "*", "12", "תוכן"]);
    const r = runHeadingsEngine(c, TORAH);
    expect(r.suggestions.map((s) => s.source.line)).toEqual([5]);
    expect(r.notes.map((n) => n.code)).toContain("heading/skipped-lines");
  });

  it("notes numbering gaps in the base", () => {
    const base = book("b", "בסיס", ["<h2>סימן א</h2>", "א", "תוכן", "<h2>סימן ג</h2>", "תוכן"]);
    const r = runHeadingsEngine(book("c", "פ", ["<h2>סימן ג</h2>", "תוכן"]), base);
    expect(r.notes.map((n) => n.code)).toContain("heading/base-gaps");
  });
});

describe("headings engine — targets and cooperation", () => {
  it("never targets a heading line, at either end of a range", () => {
    const base = book("b", "בסיס", ["<h1>בסיס</h1>", "<h2>פרק א</h2>", "<h3>משנה א</h3>", "תוכן", "<h3>משנה ב</h3>", "תוכן ב", "<h2>פרק ב</h2>", "<h3>משנה א</h3>", "תוכן"]);
    const c = book("c", "פירוש", ["<h2>פרק א</h2>", "הקדמה לפרק", "<h3>משנה ב</h3>", "על משנה ב", "<h2>פרק ב</h2>", "סיכום", "<h2>פרק ג</h2>", "x y z"]);
    const r = runHeadingsEngine(c, base);
    for (const s of r.suggestions) {
      expect(base.lines[s.target.line]!.heading).toBeNull();
      expect(base.lines[s.target.end ?? s.target.line]!.heading).toBeNull();
    }
    expect(at(r, 1)!.target).toMatchObject({ line: 3, end: 5 });
  });

  it("stops when aborted and reports progress", () => {
    const lines = ["<h2>פרק א</h2>", ...Array.from({ length: 1200 }, () => "שורת פירוש")];
    const c = book("c", "פירוש", lines);
    const seen: [number, number][] = [];
    const ac = new AbortController();
    const r = runHeadingsEngine(c, TORAH, {}, { signal: ac.signal, progress: (d, t) => { seen.push([d, t]); if (d >= 500) ac.abort(); } });
    expect(r.notes.map((n) => n.code)).toContain("engine/aborted");
    expect(r.suggestions.length).toBeLessThan(1200);
    expect(seen[0]).toEqual([0, 1201]);
    const full = runHeadingsEngine(c, TORAH, {}, { progress: (d, t) => seen.push([d, t]) });
    expect(full.suggestions.length).toBe(1200);
    expect(seen[seen.length - 1]).toEqual([1201, 1201]);
  });
});
