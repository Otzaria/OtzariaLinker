import { describe, expect, it } from "vitest";
import { headingLevel } from "../../../src/core/text/html";
import type { EngineBook } from "../../../src/linking/automatic/types";
import { TITLE_FIT, titleFit, titleGateAdvice } from "../../../src/linking/title-fit";

/*
 * Fix round, claim 2: the title-fit check ADVISES and WARNS, it does not rule. Measured on 110 pairs of the official library (48 of the
 * first calibration, 62 held out: docs/AUTOMATION_ENGINE.md §2.1) the structure alone cannot tell every method that fails from one that
 * works (3 of 104 "fit" pairs failed against the database's links, one "unfit" pair was right), so:
 *   - "undecided": the share of lines whose title is the base's is neither none nor enough (5%-30%): not "unfit";
 *   - the gate skips a step only for the two rulings the measurement supports (no titles at all, or titles none of which is the base's, with the
 *     search for a place complete); everything else runs, with a note that says why it is doubtful;
 *   - a user who names the method for the pair forces it, and the result carries a warning.
 */
const book = (title: string, lines: readonly string[]): EngineBook => ({
  book: { key: title, title, origin: "personal" },
  lines: lines.map((text, index) => ({ index, text, heading: headingLevel(text) })),
});
const G = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"];
const chapters = (n: number, perChapter = 2): string[] => {
  const out: string[] = [];
  for (let c = 1; c <= n; c++) {
    out.push(`<h2>פרק ${G[c]}</h2>`);
    for (let i = 0; i < perChapter; i++) out.push(`שורה ${i + 1} של פרק ${c}`);
  }
  return out;
};
const base = book("ספר", ["<h1>ספר</h1>", ...chapters(8)]);
const codes = (r: ReturnType<typeof titleFit>) => r.reasons.map((x) => x.code);
/** one chapter the base has, and `others` chapters under names it does not: placed share = 2 / (2 + 2 * others) */
const ORDINALS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שביעי", "שמיני", "תשיעי", "עשירי", "אחד עשר"];
const mixed = (others: number) => {
  const out = ["<h1>פירוש</h1>", ...chapters(1)];
  for (let i = 0; i < others; i++) out.push(`<h2>שער ${ORDINALS[i]}</h2>`, "מילים של פסקה", "עוד מילים");
  return book("פירוש", out);
};

describe("titleFit — 'undecided' where the evidence is neither for nor against", () => {
  it("about 10% of the lines under the base's titles: undecided, not unfit, with the reason and the number", () => {
    const r = titleFit(mixed(9), base);
    expect(r.metrics.placedShare).toBeGreaterThan(TITLE_FIT.unfitPlaced);
    expect(r.metrics.placedShare).toBeLessThan(TITLE_FIT.partialPlaced);
    expect(r.verdict).toBe("undecided");
    expect(codes(r)).toContain("title-fit/unclear-titles");
    expect(r.reasons.find((x) => x.code === "title-fit/unclear-titles")!.text).toContain("10%");
  });

  it("none of its titles is the base's: still unfit, and the reason says so", () => {
    const r = titleFit(book("פירוש", ["<h1>פירוש</h1>", "<h2>שער הראשון</h2>", "מילים של פסקה", "<h2>שער השני</h2>", "מילים של פסקה"]), base);
    expect(r.verdict).toBe("unfit");
    expect(codes(r)).toContain("title-fit/other-titles");
  });

  it("the thresholds of the verdicts, in order: nothing, the grey band, partial, fit", () => {
    expect(TITLE_FIT.unfitPlaced).toBeLessThan(TITLE_FIT.partialPlaced);
    expect(TITLE_FIT.partialPlaced).toBeLessThan(TITLE_FIT.fitPlaced);
  });
});

describe("titleGateAdvice — what the job does with a verdict", () => {
  const advice = (r: ReturnType<typeof titleFit>) => titleGateAdvice(r).action;

  it("fit: run; partial and undecided: run, with a warning", () => {
    expect(advice(titleFit(book("פירוש", ["<h1>פירוש</h1>", ...chapters(8)]), base))).toBe("run");
    expect(advice(titleFit(mixed(9), base))).toBe("warn");
    const partial = titleFit(book("פירוש", ["<h1>פירוש</h1>", ...chapters(2), "<h2>פרק יא</h2>", "מילים", "<h2>פרק יב</h2>", "מילים", "<h2>פרק יג</h2>", "מילים"]), base);
    expect(partial.verdict).toBe("partial");
    expect(advice(partial)).toBe("warn");
  });

  it("no titles at all, or titles none of which is the base's: skip, and the reasons are given", () => {
    const none = titleFit(book("פירוש", ["פסקה ראשונה", "פסקה שניה", "פסקה שלישית"]), base);
    expect(titleGateAdvice(none)).toMatchObject({ action: "skip" });
    expect(titleGateAdvice(none).why).toContain("אין כותרות");
    const other = titleFit(book("פירוש", ["<h1>פירוש</h1>", "<h2>שער הראשון</h2>", "מילים של פסקה", "<h2>שער השני</h2>", "מילים של פסקה"]), base);
    expect(titleGateAdvice(other).action).toBe("skip");
  });

  it("sparse titles are unfit but the threshold was never exercised by the measurement: warn, not skip", () => {
    const lines = ["<h2>פרק א</h2>", "שורה אחת בפרק", "<h2>פרק ב</h2>", "שורה אחת בפרק", ...Array.from({ length: 12 }, () => "שורה בלי כותרת במקום המתאים")];
    const r = titleFit(book("פירוש", [...lines.slice(4), ...lines.slice(0, 4)]), base);
    expect(r.verdict).toBe("unfit");
    expect(codes(r)).toContain("title-fit/sparse-titles");
    expect(titleGateAdvice(r).action).toBe("warn");
  });

  it("an unfit verdict whose search for a place was cut short is not a ruling: warn, not skip", () => {
    const r = titleFit(book("פירוש", ["<h1>פירוש</h1>", "<h2>שער הראשון</h2>", "מילים של פסקה", "<h2>שער השני</h2>", "מילים של פסקה"]), base);
    expect(titleGateAdvice({ ...r, metrics: { ...r.metrics, scanCapped: 3 } }).action).toBe("warn");
  });
});
