import { describe, expect, it } from "vitest";
import { headingLevel } from "../../../src/core/text/html";
import type { EngineBook } from "../../../src/linking/automatic/types";
import { TITLE_FIT, titleFit } from "../../../src/linking/title-fit";

/* Hand-written minimal books (headings and filler words only; no book text). The real-data checks are
   tests/integration/linking/title-fit*.test.ts. */
const book = (title: string, lines: readonly string[]): EngineBook => ({
  book: { key: title, title, origin: "personal" },
  lines: lines.map((text, index) => ({ index, text, heading: headingLevel(text) })),
});
const chapters = (n: number, perChapter = 2): string[] => {
  const g = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"];
  const out: string[] = [];
  for (let c = 1; c <= n; c++) {
    out.push(`<h2>פרק ${g[c]}</h2>`);
    for (let i = 0; i < perChapter; i++) out.push(`שורה ${i + 1} של פרק ${c}`);
  }
  return out;
};
const base = book("ספר", ["<h1>ספר</h1>", ...chapters(8)]);
const codes = (r: ReturnType<typeof titleFit>) => r.reasons.map((x) => x.code);

describe("titleFit", () => {
  it("the same chapters: fit, every reason in its favour", () => {
    const r = titleFit(book("פירוש על ספר", ["<h1>פירוש על ספר</h1>", ...chapters(8)]), base);
    expect(r.verdict).toBe("fit");
    expect(codes(r)).toEqual(["title-fit/titles", "title-fit/same-titles"]);
    expect(r.metrics.placedShare).toBe(1);
    expect(r.metrics.duplicateShare).toBe(0);
  });

  it("a commentary on part of the base is still fit (every title it has is the base's)", () => {
    expect(titleFit(book("פירוש", ["<h1>פירוש</h1>", ...chapters(3)]), base).verdict).toBe("fit");
  });

  it("no headings at all: unfit, 'no-titles'", () => {
    const r = titleFit(book("פירוש", ["פסקה ראשונה של הפירוש", "פסקה שניה של הפירוש", "פסקה שלישית של הפירוש"]), base);
    expect(r.verdict).toBe("unfit");
    expect(codes(r)).toEqual(["title-fit/no-titles"]);
    expect(r.metrics.titleDensity).toBe(0);
  });

  it("headings over only a small part of the text: unfit, 'sparse-titles'", () => {
    const lines = ["<h2>פרק א</h2>", "שורה אחת בפרק", "<h2>פרק ב</h2>", "שורה אחת בפרק", ...Array.from({ length: 12 }, () => "שורה בלי כותרת במקום המתאים")];
    // the lines after the last heading still sit under it: put them BEFORE any heading to keep them untitled
    const r = titleFit(book("פירוש", [...lines.slice(4), ...lines.slice(0, 4)]), base);
    expect(r.verdict).toBe("unfit");
    expect(codes(r)).toContain("title-fit/sparse-titles");
  });

  it("headings that are not the base's (other names, chapters it does not have): unfit, 'other-titles'", () => {
    const r = titleFit(book("פירוש", ["<h1>פירוש</h1>", "<h2>שער הראשון</h2>", "מילים של פסקה", "<h2>שער השני</h2>", "מילים של פסקה", "<h2>שער השלישי</h2>", "מילים של פסקה"]), base);
    expect(r.verdict).toBe("unfit");
    expect(codes(r)).toContain("title-fit/other-titles");
  });

  it("some of its chapters are the base's: partial, 'some-titles'", () => {
    // chapters א, ב of the base, then פרק יא..יד that the 8-chapter base does not have
    const lines = ["<h1>פירוש</h1>", ...chapters(2), "<h2>פרק יא</h2>", "מילים", "<h2>פרק יב</h2>", "מילים", "<h2>פרק יג</h2>", "מילים"];
    const r = titleFit(book("פירוש", lines), base);
    expect(r.metrics.placedShare).toBeGreaterThan(TITLE_FIT.unfitPlaced);
    expect(r.metrics.placedShare).toBeLessThan(TITLE_FIT.fitPlaced);
    expect(r.verdict).toBe("partial");
    expect(codes(r)).toContain("title-fit/some-titles");
  });

  it("a title per unit: the same place headed again and again is partial, 'duplicates'", () => {
    const rep: string[] = ["<h1>פירוש</h1>"];
    for (let i = 0; i < 4; i++) rep.push("<h2>פרק א</h2>", "מילים של פסקה", "<h2>פרק ב</h2>", "מילים של פסקה");
    const r = titleFit(book("פירוש", rep), base);
    expect(r.metrics.duplicateShare).toBeGreaterThan(TITLE_FIT.maxDuplicates);
    expect(r.verdict).toBe("partial");
    expect(codes(r)).toContain("title-fit/duplicates");
  });

  it("does not depend on the line indexes, only on the order of lines", () => {
    const shifted: EngineBook = { ...base, lines: base.lines.map((l) => ({ ...l, index: l.index + 100 })) };
    const c = book("פירוש", ["<h1>פירוש</h1>", ...chapters(5)]);
    expect(titleFit(c, shifted)).toEqual(titleFit(c, base));
  });
});
