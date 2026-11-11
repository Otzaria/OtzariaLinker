import { describe, expect, it } from "vitest";
import { ENGINES } from "../../../src/linking/automatic";
import { customKey, defaultFormValues, ENGINE_OPTION_SPECS, toEngineOptions } from "../../../src/linking/automatic/option-specs";
import { DEFAULT_THRESHOLDS } from "../../../src/linking/automatic/types";

describe("engine option specs", () => {
  it("every engine has specs, and untouched defaults produce no options at all", () => {
    for (const e of ENGINES) {
      expect(ENGINE_OPTION_SPECS[e.id].length).toBeGreaterThan(0);
      expect(toEngineOptions(e.id, defaultFormValues(e.id))).toEqual({ options: {}, errors: {}, changed: 0 });
    }
  });

  it("keys are unique per engine and every select default is one of its choices", () => {
    for (const e of ENGINES) {
      const keys = ENGINE_OPTION_SPECS[e.id].map((s) => s.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const s of ENGINE_OPTION_SPECS[e.id]) if (s.kind === "select") expect(s.choices.map(([v]) => v)).toContain(s.default);
    }
  });

  it("changed values become engine options; numbers are clamped and rounded", () => {
    const r = toEngineOptions("headings", { ...defaultFormValues("headings"), numbering: "strict", untaggedHeadings: false, maxAlternatives: "99", declaredType: "reference" });
    expect(r.errors).toEqual({});
    expect(r.options).toEqual({ numbering: "strict", untaggedHeadings: false, maxAlternatives: 10, declaredType: "reference" });
    expect(r.changed).toBe(4);
  });

  it("thresholds are percentages, merged over the defaults, and must be in order", () => {
    const ok = toEngineOptions("dibur-hamatchil", { ...defaultFormValues("dibur-hamatchil"), "t.possible": 50 });
    expect(ok.options.thresholds).toEqual({ ...DEFAULT_THRESHOLDS, possible: 0.5 });
    const bad = toEngineOptions("dibur-hamatchil", { ...defaultFormValues("dibur-hamatchil"), "t.possible": 90, "t.high": 80 });
    expect(bad.errors["t.certain"]).toBeTruthy();
    expect(bad.options.thresholds).toBeUndefined();
  });

  it("not-a-number and unknown select values are errors, never passed on", () => {
    const r = toEngineOptions("headings", { ...defaultFormValues("headings"), maxAlternatives: "abc", numbering: "weird" });
    expect(Object.keys(r.errors).sort()).toEqual(["maxAlternatives", "numbering"]);
    expect(r.options).toEqual({});
  });

  it("targetStartsWithDh maps to a boolean; automatic leaves it unset", () => {
    expect(toEngineOptions("dibur-hamatchil", { targetStartsWithDh: "yes" }).options).toEqual({ targetStartsWithDh: true });
    expect(toEngineOptions("dibur-hamatchil", { targetStartsWithDh: "no" }).options).toEqual({ targetStartsWithDh: false });
    expect(toEngineOptions("dibur-hamatchil", { targetStartsWithDh: "" }).options).toEqual({});
  });

  it("footnotes headingLevel 0 means every heading (no option)", () => {
    expect(toEngineOptions("footnotes", { headingLevel: 0 }).options).toEqual({});
    expect(toEngineOptions("footnotes", { headingLevel: 2 }).options).toEqual({ headingLevel: 2 });
  });

  it("marker styles: built-in, custom tag, guarded regular expression", () => {
    expect(toEngineOptions("footnotes", { mainMarkers: "sub" }).options).toEqual({ mainMarkers: "sub" });
    expect(toEngineOptions("footnotes", { mainMarkers: "tag", [customKey("mainMarkers")]: "<small>" }).options).toEqual({ mainMarkers: { tag: "small" } });
    expect(toEngineOptions("footnotes", { mainMarkers: "tag", [customKey("mainMarkers")]: "קטן" }).errors.mainMarkers).toBeTruthy();
    expect(toEngineOptions("footnotes", { notesMarkers: "regex", [customKey("notesMarkers")]: "\\[(\\d+)\\]" }).options).toEqual({ notesMarkers: { regex: "\\[(\\d+)\\]" } });
    // the same guard the engine applies: nested quantifiers, back-references, empty matches
    for (const bad of ["(a+)+", "(\\d)\\1", "x*", ""]) {
      const r = toEngineOptions("footnotes", { notesMarkers: "regex", [customKey("notesMarkers")]: bad });
      expect(r.errors.notesMarkers, bad).toBeTruthy();
      expect(r.options.notesMarkers).toBeUndefined();
    }
  });
});
