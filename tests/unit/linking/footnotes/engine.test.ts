import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../../src/core/links/model";
import { validateLink, type ValidationContext } from "../../../../src/core/links/validate";
import { headingLevel } from "../../../../src/core/text/html";
import { runFootnotesEngine, type FootnotesOptions } from "../../../../src/linking/automatic/footnotes";
import type { EngineBook, EngineResult, Suggestion } from "../../../../src/linking/automatic/types";

const book = (title: string, key: string, texts: readonly string[]): EngineBook => ({
  book: { key, title, origin: "personal" },
  lines: texts.map((text, index) => ({ index, text, heading: headingLevel(text) })),
});
const MAIN = "ספר";
const NOTES = "הערות לספר";
const run = (main: string[], notes: string[], opts?: FootnotesOptions, title = NOTES) => runFootnotesEngine(book(MAIN, "m", main), book(title, "n", notes), opts);
const pairs = (res: EngineResult) => res.suggestions.map((s) => `${s.source.line}>${s.target.line}`);
const codes = (xs: readonly { code: string }[]) => xs.map((x) => x.code);
const noteLines = (keys: readonly string[], wrap = (k: string) => `<sup>${k}</sup>`) => keys.map((k) => `${wrap(k)} הערה ${k}`);

describe("basic linking", () => {
  const main = ["<h1>ספר</h1>", "שלום<sup>1</sup> עולם<sup>2</sup>.", "עוד<sup>3</sup>"];
  const notes = ["<h1>הערות לספר</h1>", ...noteLines(["1", "2", "3"])];
  const res = run(main, notes);

  it("one suggestion per marker, several markers on one line, the note line as target", () => {
    expect(pairs(res)).toEqual(["1>1", "1>2", "2>3"]);
    expect(res.suggestions.every((s) => s.confidence === "certain" && s.engine === "footnotes" && s.declaredType === "footnotes")).toBe(true);
    expect(res.unmatched).toEqual([]);
  });

  it("the anchor is the marker's RAW span on the source line, with a label the generator reads back", () => {
    const s = res.suggestions[1]!;
    expect(main[1]!.slice(s.anchor!.rawStart, s.anchor!.rawEnd)).toBe("<sup>2</sup>");
    expect(s.anchor!.label).toBe("ב");
    expect(s.heRef2).toBe("הערות לספר אות ב");
  });

  it("ids are deterministic and unique; every suggestion explains itself in Hebrew", () => {
    expect(pairs(run(main, notes))).toEqual(pairs(res));
    expect(new Set(res.suggestions.map((s) => s.id)).size).toBe(3);
    expect(res.suggestions.map((s) => s.id)).toEqual(run(main, notes).suggestions.map((s) => s.id));
    for (const s of res.suggestions) {
      expect(s.reasons.length).toBeGreaterThan(0);
      for (const r of [...s.reasons, ...s.warnings]) expect(r.text).toMatch(/[א-ת]/);
    }
  });

  it("heRef_2 carries the notes book's heading path", () => {
    const r = run(["<sup>1</sup>"], ["<h1>הערות לספר</h1>", "<h2>חלק א</h2>", "<h3>פרק ב</h3>", "<sup>1</sup> הערה"]);
    expect(r.suggestions[0]!.heRef2).toBe("הערות לספר, חלק א, פרק ב אות א");
  });

  it("suggestions pass the export validation (no errors): never a heading line, anchor inside the line", () => {
    const m = book(MAIN, "m", main);
    const n = book(NOTES, "n", notes);
    const ctx: ValidationContext = {
      line: (b: BookRef, i: number) => {
        const l = (b.key === "m" ? m : n).lines[i];
        return l && { exists: true, heading: l.heading, anchorLength: l.text.length };
      },
      lineCount: (b: BookRef) => (b.key === "m" ? m : n).lines.length,
    };
    for (const s of res.suggestions) {
      const link: Link = { id: s.id, status: "new", provenance: "auto", source: s.source, target: s.target, declaredType: s.declaredType, heRef2: s.heRef2, anchor: s.anchor! };
      expect(validateLink(link, ctx).filter((p) => p.severity === "error")).toEqual([]);
    }
  });
});

describe("marker styles", () => {
  it("(12) in the text, notes opening with (12): the app shows a popup, no warning", () => {
    const res = run(["שלום (1) עולם (2)"], noteLines(["1", "2"], (k) => `(${k})`));
    expect(pairs(res)).toEqual(["0>0", "0>1"]);
    expect(res.suggestions.flatMap((s) => codes(s.warnings))).toEqual([]);
    expect(codes(res.notes)).toContain("footnotes/style-auto");
  });

  it("Hebrew letters as <sup>(א)</sup> are recognised by the app; plain <sup>9</sup> gets a warning", () => {
    const letters = run(["א<sup>(א)</sup> ב<sup>(ב)</sup>"], noteLines(["(א)", "(ב)"]));
    expect(letters.suggestions.flatMap((s) => codes(s.warnings))).toEqual([]);
    const plain = run(["א<sup>9</sup>"], noteLines(["9"]));
    expect(codes(plain.suggestions[0]!.warnings)).toEqual(["footnotes/no-popup"]);
    expect(codes(plain.notes)).toContain("footnotes/no-popup");
  });

  it("the popup also needs the note to open with the identical marker", () => {
    const res = run(["א (3)"], ["3. הערה"]);
    expect(codes(res.suggestions[0]!.warnings)).toEqual(["footnotes/note-opening-differs"]);
  });

  it("<sub>, a named tag and a custom rule", () => {
    expect(pairs(run(["א<sub>1</sub>"], noteLines(["1"]), { mainMarkers: "sub" }))).toEqual(["0>0"]);
    expect(pairs(run(["א<small>1</small>"], ["1) הערה"], { mainMarkers: { tag: "small" } }))).toEqual(["0>0"]);
    expect(pairs(run(["א [1] ב [2]"], ["[1] הערה", "[2] הערה"], { mainMarkers: { regex: "\\[(\\d{1,3})\\]" } }))).toEqual(["0>0", "0>1"]);
  });

  it("a refused custom rule stops the run with the reason", () => {
    const res = run(["א (1)"], ["(1) הערה"], { mainMarkers: { regex: "(\\d+)+" } });
    expect(res.suggestions).toEqual([]);
    expect(codes(res.notes)).toContain("footnotes/bad-style");
  });

  it("the numbering of the notes book filters the main book (letters here, the digits are something else)", () => {
    const res = run(["א<sup>א</sup> ב<sup>5</sup>"], noteLines(["א"]));
    expect(pairs(res)).toEqual(["0>0"]);
    expect(res.unmatched).toEqual([]);
  });

  it("the generator's own inline-note markers are skipped and reported", () => {
    const res = run(['א<sup class="footnote-marker">1</sup> ב<sup>1</sup>'], noteLines(["1"]));
    expect(res.suggestions.map((s) => s.anchor!.rawStart)).toEqual([39]);
    expect(codes(res.notes)).toContain("footnotes/inline-markers-skipped");
  });

  it("a broken tag is linked with a warning and less confidence", () => {
    const s = run(["א<sup>1</sup ב"], noteLines(["1"])).suggestions[0]!;
    expect(codes(s.warnings)).toContain("footnotes/broken-tag");
    expect(s.confidence).toBe("high");
  });

  it("stars-only markers are paired by order when the counts agree", () => {
    const ok = run(["א<sup>*</sup> ב<sup>*</sup>", "ג<sup>**</sup>"], noteLines(["*", "**", "*"]));
    expect(pairs(ok)).toEqual(["0>0", "0>2", "1>1"]);
    expect(ok.suggestions.every((s) => s.rules.includes("match:order") && s.confidence === "high")).toBe(true);
    const bad = run(["א<sup>*</sup> ב<sup>*</sup>"], noteLines(["*"]));
    expect(bad.suggestions).toEqual([]);
    expect(bad.unmatched[0]!.reasons.map((r) => r.code)).toEqual(["footnotes/stars-count", "footnotes/stars-count"]);
  });

  it("a BOM on the first line is not counted (the generator strips it)", () => {
    const s = run(["﻿א<sup>1</sup>"], noteLines(["1"])).suggestions[0]!;
    expect(s.anchor!.rawStart).toBe(1);
  });
});

describe("numbering that restarts per chapter", () => {
  const notes = ["<h1>הערות לספר</h1>", ...noteLines(["1", "2", "3"]), ...noteLines(["1", "2", "3"]), ...noteLines(["1", "2"])];
  const main = ["א<sup>1</sup> ב<sup>2</sup>", "ג<sup>3</sup>", "ד<sup>1</sup>", "ה<sup>2</sup> ו<sup>3</sup>", "ז<sup>1</sup> ח<sup>2</sup>"];

  it("follows the restarts (no headings): first chapter certain, inferred chapters lower", () => {
    const res = run(main, notes);
    expect(pairs(res)).toEqual(["0>1", "0>2", "1>3", "2>4", "3>5", "3>6", "4>7", "4>8"]);
    expect(res.suggestions.map((s) => s.confidence)).toEqual(["certain", "certain", "certain", "high", "high", "high", "high", "high"]);
    expect(codes(res.notes)).toEqual(expect.arrayContaining(["footnotes/chapters", "footnotes/resets"]));
  });

  it("a restart with a heading at the same place in both books is confirmed → certain", () => {
    const n = ["<h2>פרק א</h2>", ...noteLines(["1", "2", "3"]), "<h2>פרק ב</h2>", ...noteLines(["1", "2"])];
    const m = ["<h2>פרק א</h2>", "א<sup>1</sup><sup>2</sup><sup>3</sup>", "<h2>פרק ב</h2>", "ב<sup>1</sup><sup>2</sup>"];
    const res = run(m, n, { chapterSplit: "reset" });
    expect(pairs(res)).toEqual(["1>1", "1>2", "1>3", "3>5", "3>6"]);
    expect(res.suggestions.every((s) => s.confidence === "certain")).toBe(true);
  });

  it("SHORT chapters (1–2 notes): the global alignment follows them, Link-Notes' greedy rules cannot", () => {
    const n = noteLines(["1", "2", "1", "1", "1", "2"]);
    const m = ["<sup>1</sup><sup>2</sup>", "<sup>1</sup>", "<sup>1</sup>", "<sup>1</sup><sup>2</sup>"];
    expect(pairs(run(m, n))).toEqual(["0>0", "0>1", "1>2", "2>3", "3>4", "3>5"]);
    const greedy = pairs(run(m, n, { chapterAlignment: "greedy" }));
    expect(greedy).not.toEqual(["0>0", "0>1", "1>2", "2>3", "3>4", "3>5"]);
  });

  it("a notes chapter that restarts at 2 (its 1 is elsewhere) is still split", () => {
    const n = noteLines(["1", "2", "3", "2", "3"]);
    const m = ["<sup>1</sup><sup>2</sup><sup>3</sup>", "<sup>2</sup><sup>3</sup>"];
    expect(pairs(run(m, n))).toEqual(["0>0", "0>1", "0>2", "1>3", "1>4"]);
  });

  it("chapterSplit 'none' reads one series", () => {
    const res = run(["<sup>1</sup>", "<sup>1</sup>"], noteLines(["1", "2", "1"]), { chapterSplit: "none" });
    expect(res.suggestions[0]!.alternatives.length).toBe(1);
    expect(res.suggestions[0]!.confidence).toBe("ambiguous");
  });
});

describe("chapters anchored to headings", () => {
  const notes = ["<h1>הערות לספר</h1>", "<h2>פרק א</h2>", ...noteLines(["1", "2"]), "<h2>פרק ב</h2>", ...noteLines(["1", "2"]), "<h2>פרק ג</h2>", ...noteLines(["1"])];
  // the book has no marker in פרק ב: by numbering alone פרק ג's "1" could go to פרק ב
  const main = ["<h1>ספר</h1>", "<h2>פרק א</h2>", "א<sup>1</sup> ב<sup>2</sup>", "<h2>פרק ב</h2>", "בלי סימנים", "<h2>פרק ג</h2>", "ג<sup>1</sup>"];

  it("pairs chapters by heading text: certain, and the right chapter even when one has no markers", () => {
    const res = run(main, notes);
    expect(pairs(res)).toEqual(["2>2", "2>3", "6>8"]);
    expect(res.suggestions.every((s) => s.confidence === "certain" && s.rules.includes("chapter:heading"))).toBe(true);
    expect(res.notes.find((n) => n.code === "footnotes/chapters")!.text).toContain("כותרות");
    expect(codes(res.notes)).toContain("footnotes/note-without-marker");
  });

  it("explicit 'headings' with no common heading falls back to numbering and says so", () => {
    const res = run(["<h2>אחר</h2>", "<sup>1</sup>"], ["<h2>שונה</h2>", ...noteLines(["1"])], { chapterSplit: "headings" });
    expect(pairs(res)).toEqual(["1>1"]);
    expect(codes(res.notes)).toContain("footnotes/headings-unpaired");
  });
});

describe("repeats, duplicates and the unmatched report", () => {
  it("one note referenced from two places: both linked, the repeat is not certain", () => {
    const res = run(["א<sup>1</sup> ב<sup>2</sup>", "ג<sup>1</sup>"], noteLines(["1", "2"]));
    expect(pairs(res)).toEqual(["0>0", "0>1", "1>0"]);
    expect(res.suggestions[2]!.confidence).toBe("high");
    expect(res.suggestions[2]!.rules).toContain("repeat");
  });

  it("two notes with the same number in one chapter: ambiguous, the other one as an alternative", () => {
    const s = run(["א<sup>2</sup>"], noteLines(["1", "2", "2"]), { chapterSplit: "none" }).suggestions[0]!;
    expect(s.confidence).toBe("ambiguous");
    expect(s.alternatives.map((a) => a.target.line)).toEqual([2]);
  });

  it("markers without notes and notes without markers are reported, with a diagnosis", () => {
    const res = run(["א<sup>1</sup> ב<sup>4</sup>", "ג<sup>*3</sup>"], noteLines(["1", "2", "3"]));
    expect(pairs(res)).toEqual(["0>0"]);
    expect(res.unmatched.map((u) => [u.line, codes(u.reasons)])).toEqual([
      [0, ["footnotes/not-found"]],
      [1, ["footnotes/decoration-mismatch"]],
    ]);
    const lonely = res.notes.find((n) => n.code === "footnotes/note-without-marker")!;
    expect(lonely.text).toContain("2, 3");
    expect(codes(res.notes)).toContain("footnotes/note-decoration-mismatch");
  });

  it("a marker in a heading line is not linked (the generator drops it) and is reported", () => {
    const res = run(["<h2>פרק<sup>1</sup></h2>", "א<sup>1</sup>"], ["<h2>פרק</h2>", ...noteLines(["1"])]);
    expect(pairs(res)).toEqual(["1>1"]);
    expect(res.unmatched.map((u) => [u.line, codes(u.reasons)])).toEqual([[0, ["footnotes/heading-line"]]]);
    expect(res.suggestions.every((s) => s.target.line !== 0)).toBe(true);
  });

  it("note lines that do not open with a marker are counted", () => {
    const res = run(["א<sup>1</sup>"], [...noteLines(["1"]), "המשך ההערה"]);
    expect(res.notes.find((n) => n.code === "footnotes/unmarked-note-lines")!.text).toContain("1 שורות");
  });

  it("nothing to do: clear notes instead of an empty result", () => {
    expect(codes(run(["א"], noteLines(["1"])).notes)).toContain("footnotes/no-markers");
    expect(codes(run(["א<sup>1</sup>"], ["הערה בלי סימן"]).notes)).toContain("footnotes/no-notes");
  });
});

describe("Otzaria rules", () => {
  it('"הערות על X" is merged into X and its links dropped: a run warning and one on every suggestion', () => {
    const res = run(["א<sup>1</sup>"], ["<h2>כותרת</h2>", ...noteLines(["1"])], {}, "הערות על ספר");
    expect(codes(res.notes)).toEqual(expect.arrayContaining(["footnotes/companion-merged", "footnotes/merge-loses-headings"]));
    expect(codes(res.suggestions[0]!.warnings)).toContain("footnotes/companion-merged");
    expect(codes(run(["א<sup>1</sup>"], noteLines(["1"]), {}, "הערות לספר").notes)).not.toContain("footnotes/companion-merged");
  });

  it("a type and title that give no popup are reported once for the run", () => {
    const res = run(["א (1)"], ["(1) הערה"], { declaredType: "reference" }, "ביאורים");
    expect(codes(res.notes)).toContain("footnotes/no-popup-type");
    expect(res.suggestions[0]!.declaredType).toBe("reference");
  });
});

describe("cooperation with the worker", () => {
  const big = { main: Array.from({ length: 3000 }, (_, i) => `שורה ${i}<sup>${(i % 50) + 1}</sup>`), notes: noteLines(Array.from({ length: 50 }, (_, i) => String(i + 1))) };

  it("reports progress, done never above total", () => {
    const calls: [number, number][] = [];
    runFootnotesEngine(book(MAIN, "m", big.main), book(NOTES, "n", big.notes), {}, { progress: (d, t) => calls.push([d, t]) });
    expect(calls.length).toBeGreaterThan(3);
    expect(calls.every(([d, t]) => d <= t)).toBe(true);
  });

  it("stops when aborted — before the start and in the middle", () => {
    const before = new AbortController();
    before.abort();
    const r1 = runFootnotesEngine(book(MAIN, "m", big.main), book(NOTES, "n", big.notes), {}, { signal: before.signal });
    expect(r1.suggestions).toEqual([]);
    expect(codes(r1.notes)).toContain("footnotes/aborted");

    const mid = new AbortController();
    let calls = 0;
    const r2 = runFootnotesEngine(book(MAIN, "m", big.main), book(NOTES, "n", big.notes), {}, {
      signal: mid.signal,
      progress: () => {
        if (++calls === 2) mid.abort();
      },
    });
    expect(r2.suggestions).toEqual([]);
    expect(codes(r2.notes)).toContain("footnotes/aborted");
    expect(calls).toBe(2);
  });
});

/** Narrowing helper for readers of the result in other tests. */
export const sourceText = (s: Suggestion, main: EngineBook) => main.lines[s.source.line]!.text.slice(s.anchor!.rawStart, s.anchor!.rawEnd);

describe("Sefaria's notes: data-label markers in the book, unnumbered note lines (notes numbered by position)", () => {
  const mark = (n: number, who = "Notes by R") => `<i data-commentator="${who}" data-label="${n}"></i>`;
  const main = [
    "<h1>ספר</h1>",
    "<h2>פרק א</h2>",
    `שורה${mark(1)} ועוד${mark(2)}`,
    `שורה שנייה${mark(3)}${mark(1, "Other")}`,
    "<h2>פרק ב</h2>",
    `פרק אחר${mark(1)} וסוף${mark(2)}`,
  ];
  const notes = ["<h1>הערות לספר</h1>", "<h2>פרק א</h2>", "הערה ראשונה", "הערה שנייה", "הערה שלישית", "<h2>פרק ב</h2>", "הערה א", "הערה ב"];

  it("note n of a chapter is the n-th line under the chapter's heading; the commentator whose labels fit is chosen", () => {
    const res = run(main, notes);
    expect(pairs(res)).toEqual(["2>2", "2>3", "3>4", "5>6", "5>7"]);
    expect(res.suggestions.every((s) => s.confidence === "certain")).toBe(true);
    expect(codes(res.notes)).toContain("footnotes/positional");
    expect(res.notes.find((n) => n.code === "footnotes/style-auto")!.text).toContain("Notes by R");
  });

  it("a data-label element shows nothing: no anchor", () => {
    expect(run(main, notes).suggestions.every((s) => s.anchor === undefined)).toBe(true);
  });

  it("a chapter whose note count is not its highest marker is left for review", () => {
    const res = run(main, [...notes.slice(0, 5), "המשך של הערה שלישית", ...notes.slice(5)]);
    const inA = res.suggestions.filter((s) => s.source.line < 4);
    expect(inA.every((s) => s.confidence === "possible" && s.rules.includes("notes:position-count"))).toBe(true);
    expect(res.suggestions.filter((s) => s.source.line === 5).every((s) => s.confidence === "certain")).toBe(true);
  });

  it("numbered note lines keep the usual reading; unnumbered notes with no shared headings link nothing", () => {
    expect(codes(run(main, ["<h1>הערות לספר</h1>", "<h2>פרק א</h2>", "(1) א", "(2) ב", "(3) ג"]).notes)).not.toContain("footnotes/positional");
    const flat = run(["<h1>ספר</h1>", `שורה${mark(1)}`], ["<h1>הערות לספר</h1>", "<h2>מבוא</h2>", "הערה"]);
    expect(flat.suggestions).toEqual([]);
  });
});
