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

describe("titleFit — QA round 2 (H)", () => {
  const LETTERS = "אבגדהוזחטיכלמנסעפצקרשת";
  const word = (n: number): string => {
    let s = "";
    let x = n + 1;
    while (x > 0) {
      s = LETTERS[x % LETTERS.length]! + s;
      x = Math.floor(x / LETTERS.length);
    }
    return s + "ם";
  };

  it("an unfit book against a big base: the placed() scan is bounded (20,000 base units under one number, 800 commentary titles that match none)", () => {
    const baseLines = ["<h1>ספר</h1>"];
    for (let i = 0; i < 20_000; i++) baseLines.push(`<h2>שער ${word(i)}</h2>`, "<h3>פרק א</h3>", "שורה של טקסט");
    const comLines = ["<h1>פירוש</h1>"];
    for (let j = 0; j < 800; j++) comLines.push(`<h2>מדור ${word(100_000 + j)}</h2>`, "<h3>פסוק א</h3>", "שורה של פירוש");
    const t0 = Date.now();
    const r = titleFit(book("פירוש", comLines), book("ספר", baseLines));
    const ms = Date.now() - t0;
    expect(r.verdict).toBe("unfit");
    expect(ms).toBeLessThan(3_000);
  }, 120_000);

  it("a place that is there is still found among thousands of units with the same number (the likeliest candidates come first)", () => {
    const baseLines = ["<h1>ספר</h1>"];
    for (let i = 0; i < 3_000; i++) baseLines.push(`<h2>שער ${word(i)}</h2>`, "<h3>פרק א</h3>", "שורה של טקסט");
    const comLines = ["<h1>פירוש</h1>"];
    for (const i of [0, 1_500, 2_999]) comLines.push(`<h2>שער ${word(i)}</h2>`, "<h3>פרק א</h3>", "שורה של פירוש");
    const r = titleFit(book("פירוש", comLines), book("ספר", baseLines));
    expect(r.metrics.placedShare).toBe(1);
    expect(r.verdict).toBe("fit");
  }, 60_000);

  it("a name written with gershayim, geresh or nikud is the same place (רש\"י, רש״י, רַשִׁ\"י)", () => {
    const mk = (spelling: string) => book("פירוש", ["<h1>פירוש</h1>", `<h2>${spelling}</h2>`, "<h3>פרק א</h3>", "שורה של פירוש", `<h2>${spelling}</h2>`, "<h3>פרק ב</h3>", "שורה של פירוש"]);
    const b = book("ספר", ["<h1>ספר</h1>", '<h2>רש"י</h2>', "<h3>פרק א</h3>", "שורה", "<h3>פרק ב</h3>", "שורה"]);
    for (const s of ['רש"י', "רש״י", "רַשִׁ״י", "רש׳י"]) expect(titleFit(mk(s), b).metrics.placedShare, s).toBe(1);
  });
});

/* #42 C15: the explanation names the headings behind the share, not only the share */
describe("titleFit — the reasons show which headings fit and which do not", () => {
  it("other titles: the reason quotes headings that have no place in the base", () => {
    const r = titleFit(book("פירוש", ["<h1>פירוש</h1>", "<h2>שער הראשון</h2>", "מילים של פסקה", "<h2>שער השני</h2>", "מילים של פסקה", "<h2>שער השלישי</h2>", "מילים של פסקה"]), base);
    expect(r.reasons.find((x) => x.code === "title-fit/other-titles")!.text).toContain('"שער הראשון"');
  });

  it("the same titles: the reason quotes one that was found; some titles: one found and one not", () => {
    const fit = titleFit(book("פירוש על ספר", ["<h1>פירוש על ספר</h1>", ...chapters(8)]), base);
    expect(fit.reasons.find((x) => x.code === "title-fit/same-titles")!.text).toContain('"פרק א"');
    const lines = ["<h1>פירוש</h1>", ...chapters(2), "<h2>פרק יא</h2>", "מילים", "<h2>פרק יב</h2>", "מילים", "<h2>פרק יג</h2>", "מילים"];
    const text = titleFit(book("פירוש", lines), base).reasons.find((x) => x.code === "title-fit/some-titles")!.text;
    expect(text).toContain('"פרק א"');
    expect(text).toContain('"פרק יא"');
  });
});

