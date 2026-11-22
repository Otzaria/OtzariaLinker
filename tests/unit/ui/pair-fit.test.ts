import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../src/core/links/model";
import { fitKey, MAX_AUTO, pairsToAutoCheck } from "../../../src/ui/screens/pair-fit";

const book = (key: string): BookRef => ({ key, title: key, origin: "otzaria" });
const pair = (d: string, b: string, notes = false) => ({ dependant: book(d), base: book(b), notes });

describe("which pairs the plan screen checks by itself", () => {
  it("checks the new ones, not the notes books, not the ones already answered", () => {
    const pairs = [pair("a", "x"), pair("b", "x"), pair("c", "x", true)];
    expect(pairsToAutoCheck(pairs, {}).map((p) => p.dependant.key)).toEqual(["a", "b"]);
    expect(pairsToAutoCheck(pairs, { [fitKey(pairs[0]!)]: { verdict: "fit" } }).map((p) => p.dependant.key)).toEqual(["b"]);
  });

  it("a pair whose check failed (null) is not read again by itself, only by the user's button", () => {
    const pairs = [pair("a", "x")];
    expect(pairsToAutoCheck(pairs, { [fitKey(pairs[0]!)]: null })).toEqual([]);
    expect(pairsToAutoCheck(pairs, { [fitKey(pairs[0]!)]: "loading" })).toEqual([]);
  });

  it("a long list is left to the user", () => {
    const many = Array.from({ length: MAX_AUTO + 1 }, (_, i) => pair(`d${i}`, "x"));
    expect(pairsToAutoCheck(many, {})).toEqual([]);
    expect(pairsToAutoCheck(many.slice(0, MAX_AUTO), {})).toHaveLength(MAX_AUTO);
  });
});

import type { TitleFitReport, TitleFitVerdict } from "../../../src/linking/title-fit";
import { fitBadge, forcedHeadingsWarning } from "../../../src/ui/screens/pair-fit";

const report = (verdict: TitleFitVerdict, code: string, scanCapped = 0): TitleFitReport =>
  ({ verdict, reasons: [{ code, ok: verdict === "fit", text: `סיבה ${code}` }], metrics: { scanCapped } }) as unknown as TitleFitReport;

describe("the verdicts of the title check (PR 2's four states) as the plan screen words them", () => {
  it("every verdict has its own words, and 'undecided' does not read like 'unfit' or like 'fit'", () => {
    const words = (["fit", "partial", "undecided", "unfit"] as const).map((v) => fitBadge(v).text);
    expect(new Set(words).size).toBe(4);
    expect(fitBadge("undecided").text).toContain("לא הכריעה");
    expect(fitBadge("undecided").cls).toBe("fit-undecided");
    expect(fitBadge("fit").cls).toBe("fit-fit");
  });

  it("forcing headings on a pair the check RULES OUT says the links will land in the wrong place", () => {
    const w = forcedHeadingsWarning(report("unfit", "title-fit/other-titles"));
    expect(w).toContain("אינן של ספר הבסיס");
  });

  it("forcing headings where the check only doubts (undecided, partial, unfit by a cut-short search) says it will run, with the reason, and not that it is wrong", () => {
    for (const r of [report("undecided", "title-fit/few-placed"), report("partial", "title-fit/few-placed"), report("unfit", "title-fit/other-titles", 3)]) {
      const w = forcedHeadingsWarning(r)!;
      expect(w).toContain("תרוץ");
      expect(w).toContain(`סיבה ${r.reasons[0]!.code}`);
      expect(w).not.toContain("אינן של ספר הבסיס");
    }
  });

  it("a pair that fits has no warning", () => {
    expect(forcedHeadingsWarning(report("fit", "title-fit/ok"))).toBeNull();
  });
});
