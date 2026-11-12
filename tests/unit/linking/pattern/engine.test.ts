import { describe, expect, it } from "vitest";
import type { BookOrigin } from "../../../../src/core/links/model";
import { countVisibleChars } from "../../../../src/core/text/offsets";
import { headingLevel } from "../../../../src/core/text/html";
import { PATTERN_PRESETS, runPatternEngine, type PatternOptions } from "../../../../src/linking/automatic/pattern";
import { defaultFormValues, ENGINE_OPTION_SPECS, toEngineOptions } from "../../../../src/linking/automatic/option-specs";
import type { EngineBook, EngineResult } from "../../../../src/linking/automatic/types";

const book = (title: string, key: string, texts: readonly string[], origin: BookOrigin = "personal"): EngineBook => ({
  book: { key, title, origin },
  lines: texts.map((text, index) => ({ index, text, heading: headingLevel(text) })),
});
const run = (src: string[], tgt: string[], opts?: PatternOptions, origin: BookOrigin = "personal") =>
  runPatternEngine(book("מקור", "s", src, origin), book("יעד", "t", tgt, origin), opts);
const pairs = (res: EngineResult) => res.suggestions.map((s) => `${s.source.line}>${s.target.line}${s.target.end !== undefined ? `-${s.target.end}` : ""}`);
const codes = (xs: readonly { code: string }[]) => xs.map((x) => x.code);
const unmatchedCodes = (res: EngineResult) => res.unmatched.flatMap((u) => codes(u.reasons));

describe("target = line (v3's default, now the preset \"v3\")", () => {
  const tgt = ["<h1>יעד</h1>", "שורה 2", "שורה 3", "שורה 4"];
  const v3: PatternOptions = { preset: "v3" };

  it("the number is a 1-based line number of the target; Hebrew numerals are read", () => {
    const res = run(["<h1>מקור</h1>", "עיין סימן ג", "ובדף 4 שם", "בלי הפניה"], tgt, v3);
    expect(pairs(res)).toEqual(["1>2", "2>3"]);
    expect(res.suggestions.every((s) => s.confidence === "certain" && s.engine === "pattern" && s.declaredType === "reference")).toBe(true);
  });

  it("only the first match of a line by default; every match with matches: all", () => {
    const src = ["סימן ב וסימן ג"];
    expect(pairs(run(src, tgt, v3))).toEqual(["0>1"]);
    expect(pairs(run(src, tgt, { ...v3, matches: "all" }))).toEqual(["0>1", "0>2"]);
  });

  it("a number past the end, or pointing at a heading line, is reported and not suggested", () => {
    const res = run(["סימן ט", "סימן א"], tgt, v3);
    expect(res.suggestions).toEqual([]);
    expect(unmatchedCodes(res)).toEqual(["pattern/out-of-range", "pattern/target-heading"]);
  });

  it("heading lines of the source are never searched", () => {
    expect(run(["<h2>סימן ב</h2>"], tgt, v3).suggestions).toEqual([]);
  });

  it("gematria off: letters are not a number", () => {
    const res = run(["סימן ב"], tgt, { ...v3, gematria: false });
    expect(res.suggestions).toEqual([]);
    expect(unmatchedCodes(res)).toEqual(["pattern/not-a-number"]);
  });
});

describe("anchors are generator-exact raw offsets (v3's TD-H4 drift is gone)", () => {
  const line = "ראה <b>סימן</b> ג &quot;שם&quot;";

  it("the match on the visible text maps back to the raw span the generator counts the same way", () => {
    const res = run([line], ["א", "ב", "ג"], { preset: "v3" }, "otzaria");
    const a = res.suggestions[0]!.anchor!;
    expect(line.slice(a.rawStart, a.rawEnd)).toBe("סימן</b> ג");
    expect(countVisibleChars(line, a.rawStart)).toBe(4);
    expect(countVisibleChars(line, a.rawEnd)).toBe(10);
  });

  it("no anchor when a book is not from the Otzaria library, or anchors are off", () => {
    expect(run([line], ["א", "ב", "ג"], { preset: "v3" }).suggestions[0]!.anchor).toBeUndefined();
    expect(run([line], ["א", "ב", "ג"], { preset: "v3", anchors: "off" }, "otzaria").suggestions[0]!.anchor).toBeUndefined();
  });
});

describe("target = chapter-line (v3's 'notes file split into chapters')", () => {
  const tgt = ["<h2>פרק א</h2>", "הערה 1", "הערה 2", "<h2>פרק ב</h2>", "הערה 1", "הערה 2"];
  const src = ["שלום (1) עולם", "(2)", "שוב (1)", "ושוב (2)"];
  const opts: PatternOptions = { regex: "\\((\\d+)\\)", target: "chapter-line" };

  it("a number that does not grow moves to the next chapter; the label reads back from heRef_2", () => {
    const res = run(src, tgt, opts, "otzaria");
    expect(pairs(res)).toEqual(["0>1", "1>2", "2>4", "3>5"]);
    expect(res.suggestions.every((s) => s.confidence === "certain")).toBe(true);
    expect(codes(res.notes)).toContain("pattern/chapters-agree");
    expect(res.suggestions[2]!.anchor!.label).toBe("א");
    expect(res.suggestions[2]!.heRef2).toBe("יעד, פרק ב אות א");
  });

  it("more numbering series than chapters: the extra ones are reported, the rest marked for review", () => {
    const res = run([...src, "(1)"], tgt, opts);
    expect(pairs(res)).toEqual(["0>1", "1>2", "2>4", "3>5"]);
    expect(res.suggestions.every((s) => s.confidence === "high")).toBe(true);
    expect(codes(res.notes)).toContain("pattern/chapters-differ");
    expect(unmatchedCodes(res)).toEqual(["pattern/no-chapter"]);
  });

  it("a number past the end of its chapter is reported", () => {
    expect(unmatchedCodes(run(["(3)"], tgt, opts))).toEqual(["pattern/not-in-chapter"]);
  });
});

describe("target = heading", () => {
  const tgt = ["<h1>יעד</h1>", "<h2>סימן א</h2>", "טקסט א", "<h2>סימן ב</h2>", "טקסט ב1", "טקסט ב2", "<h2>פרק ג</h2>", "טקסט ג"];

  it("links to the first text line under the heading with the same kind and number", () => {
    const res = run(["עיין סימן ב"], tgt, { target: "heading" });
    expect(pairs(res)).toEqual(["0>4"]);
    expect(res.suggestions[0]!.confidence).toBe("certain");
  });

  it("the whole section as a range on request", () => {
    expect(pairs(run(["עיין סימן ב"], tgt, { target: "heading", sectionRanges: true }))).toEqual(["0>4-5"]);
  });

  it("a kind the target does not number that way is reported, not guessed", () => {
    expect(unmatchedCodes(run(["עיין פרק ב"], tgt, { target: "heading", regex: "פרק ([א-ת]{1,4})" }))).toEqual(["pattern/heading-kind"]);
  });

  it("a bare number matches by number only, and says so", () => {
    const res = run(["(ג)"], tgt, { target: "heading", regex: "\\(([א-ת]+)\\)" });
    expect(pairs(res)).toEqual(["0>7"]);
    expect(res.suggestions[0]!.confidence).toBe("high");
    expect(codes(res.suggestions[0]!.warnings)).toEqual(["pattern/heading-kindless"]);
  });

  it("two headings with the same number: the first is suggested, the other is an alternative", () => {
    const res = run(["סימן א"], [...tgt, "<h2>סימן א</h2>", "שוב"], { target: "heading" });
    expect(pairs(res)).toEqual(["0>2"]);
    expect(res.suggestions[0]!.confidence).toBe("ambiguous");
    expect(res.suggestions[0]!.alternatives.map((a) => a.target.line)).toEqual([9]);
  });
});

describe("guards", () => {
  it("a dangerous or empty-matching pattern is refused before anything runs", () => {
    for (const regex of ["(a+)+", "x*", "(\\d+)\\1"]) {
      const res = run(["aaaa"], ["א"], { regex });
      expect(codes(res.notes)).toEqual(["pattern/invalid"]);
      expect(res.suggestions).toEqual([]);
    }
  });

  it("a pattern without a group cannot give a number", () => {
    expect(unmatchedCodes(run(["סימן ב"], ["א", "ב"], { regex: "סימן" }))).toEqual(["pattern/not-a-number"]);
  });

  it("an aborted run returns nothing", () => {
    const ac = new AbortController();
    ac.abort();
    const res = runPatternEngine(book("מקור", "s", ["סימן א"]), book("יעד", "t", ["א"]), {}, { signal: ac.signal });
    expect(res.suggestions).toEqual([]);
    expect(codes(res.notes)).toEqual(["pattern/aborted"]);
  });

  it("ids are deterministic and unique", () => {
    const a = run(["סימן ב וסימן ג"], ["א", "ב", "ג"], { preset: "v3", matches: "all" });
    const b = run(["סימן ב וסימן ג"], ["א", "ב", "ג"], { preset: "v3", matches: "all" });
    expect(a.suggestions.map((s) => s.id)).toEqual(b.suggestions.map((s) => s.id));
    expect(new Set(a.suggestions.map((s) => s.id)).size).toBe(2);
  });
});

describe("options (simple mode passes the essential ones only)", () => {
  it("the preset and the target are essential; the pattern is essential only with the preset \"custom\"", () => {
    const v = { ...defaultFormValues("pattern"), regex: "(a+)+", "t.certain": 80 };
    // a pattern typed in advanced mode does not leak into simple mode while a preset is chosen
    expect(toEngineOptions("pattern", v, "essential")).toEqual({ options: {}, errors: {}, changed: 0 });
    expect(Object.keys(toEngineOptions("pattern", v).errors)).toContain("regex");
    const custom = { ...v, preset: "custom" };
    expect(Object.keys(toEngineOptions("pattern", custom, "essential").errors)).toEqual(["regex"]);
    expect(Object.keys(toEngineOptions("pattern", { ...custom, regex: "" }, "essential").errors)).toEqual(["regex"]);
  });

  it("untouched defaults give no options; a chosen preset, a custom template and a target are passed", () => {
    expect(toEngineOptions("pattern", defaultFormValues("pattern"), "essential").options).toEqual({});
    expect(toEngineOptions("pattern", { ...defaultFormValues("pattern"), preset: "siman-seif-sk" }, "essential").options).toEqual({ preset: "siman-seif-sk" });
    const v = { ...defaultFormValues("pattern"), preset: "custom", regex: "\\((\\d+)\\)", target: "chapter-line" };
    expect(toEngineOptions("pattern", v, "essential").options).toEqual({ preset: "custom", regex: "\\((\\d+)\\)", target: "chapter-line" });
    expect(toEngineOptions("pattern", { ...v, regex: "סי'\\s?{סימן}" }, "essential").errors).toEqual({});
    expect(toEngineOptions("pattern", { ...v, regex: "סי' {שמש}" }, "essential").errors["regex"]).toContain("{שמש}");
  });

  it("the preset's own template, shown in the field, is not passed as a custom pattern", () => {
    const sk = PATTERN_PRESETS.find((p) => p.id === "siman-seif-sk")!;
    const v = { ...defaultFormValues("pattern"), preset: sk.id, regex: sk.template };
    expect(toEngineOptions("pattern", v).options).toEqual({ preset: sk.id });
    expect(toEngineOptions("pattern", { ...v, regex: sk.template.replace("סימן", "סימנא") }).options["regex"]).toBeDefined();
  });

  it("every preset is offered by name with an example", () => {
    const spec = ENGINE_OPTION_SPECS.pattern.find((s) => s.key === "preset")!;
    expect(spec.kind).toBe("select");
    const choices = spec.kind === "select" ? spec.choices.map(([id]) => id) : [];
    expect(choices).toEqual([...PATTERN_PRESETS.map((p) => p.id), "custom"]);
    expect(spec.hintOf?.({ preset: "perek-mishna" })).toContain('"פ"ב מ"ג" ← פרק ב › משנה ג');
  });
});

describe("the number inside a tag (v3 'לפי תגיות')", () => {
  it("the content of <sup> is the number; the anchor is the whole element; the pattern is not used", () => {
    const src = ["טקסט<sup>2</sup> ועוד<sup>ג</sup>", "בלי סימן"];
    const res = run(src, ["א", "ב", "ג"], { tag: "sup", regex: "(a+)+", matches: "all" }, "otzaria");
    expect(pairs(res)).toEqual(["0>1", "0>2"]);
    const a = res.suggestions[0]!.anchor!;
    expect(src[0]!.slice(a.rawStart, a.rawEnd)).toBe("<sup>2</sup>");
  });

  it("gematria off reads digits only", () => {
    expect(pairs(run(["<sup>ב</sup> <sup>3</sup>"], ["א", "ב", "ג"], { tag: "sup", gematria: false, matches: "all" }))).toEqual(["0>2"]);
  });

  it("the tag choice is an essential option", () => {
    const v = { ...defaultFormValues("pattern"), tag: "sup" };
    expect(toEngineOptions("pattern", v, "essential").options).toEqual({ tag: "sup" });
  });
});
