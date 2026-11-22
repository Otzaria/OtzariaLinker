import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../src/core/links/model";
import { headingLevel } from "../../../src/core/text/html";
import { runEngine, type EngineBook, type Suggestion } from "../../../src/linking/automatic";
import { applySourceFilter, compileSourceFilter, parseSourceFilter, previewSourceFilter, type SourceFilter } from "../../../src/linking/automatic/source-filter";
import { defaultFormValues, sanitizeStoredOptions, toEngineOptions } from "../../../src/linking/automatic/option-specs";

/*
 * Issue #27: link by the dibur hamatchil, but ONLY the lines that start with a marker ("[א] בישול אכילה הנאה:"), and find the target by the
 * words AFTER the marker. One general mechanism, four stages, none of them an engine:
 *   (a) eligibility  which source lines enter the engine (SourceFilter, a preset or a regex of the user's);
 *   (b) preprocessing the marker is blanked for MATCHING ONLY, with as many spaces as it has characters, so every raw offset is the original's;
 *   (c) matching     the engine of the user's choice, untouched;
 *   (d) output       line, anchor and matched spans refer to the ORIGINAL line: they were never computed on another string.
 * Synthetic neutral words; no book text.
 */
const ref = (key: string, title: string): BookRef => ({ key, title, origin: "otzaria" });
const book = (r: BookRef, texts: readonly string[]): EngineBook => ({ book: r, lines: texts.map((text, index) => ({ index, text, heading: headingLevel(text) })) });
const BASE = ref("base", "ספר בסיס");
const COMM = ref("comm", "פירוש על ספר בסיס");
const BASE_LINES = ["<h1>ספר בסיס</h1>", "<h2>פרק א</h2>", "אלפא בטא גמא דלתא הא וו זין חית טית יוד", "כף למד מם נון סמך עין פא צדי קוף ריש", "שין תיו אלף בית גימל דלת הי ואו זיי חית"];
const HEAD = ["<h1>פירוש על ספר בסיס</h1>", "<h2>פרק א</h2>"];
const sorted = (xs: readonly Suggestion[]) => [...xs].sort((a, b) => (a.source.book.key === "comm" ? a.source.line : a.target.line) - (b.source.book.key === "comm" ? b.source.line : b.target.line));
const dh = (lines: readonly string[], options: Record<string, unknown> = {}) => runEngine("dibur-hamatchil", book(COMM, lines), book(BASE, BASE_LINES), { anchors: "off", ...options });
const commLine = (s: Suggestion) => s.source.book.key === "comm" ? s.source.line : s.target.line;

describe("the marker styles of the issue", () => {
  // each case: a marker line, the same words with no marker (not eligible), and a marker line for another verse
  const STYLES: readonly [name: string, filter: SourceFilter, mark: (n: number) => string][] = [
    ["square [א]", { prefix: { preset: "square" } }, (n) => `[${"אבג"[n]}] `],
    ["round (א)", { prefix: { preset: "round" } }, (n) => `(${"אבג"[n]}) `],
    ["close-paren א)", { prefix: { preset: "close-paren" } }, (n) => `${"אבג"[n]}) `],
    ["bold ד\"ה label", { prefix: { preset: "bold-dh" } }, () => '<b>ד"ה</b> '],
    ["custom regex {12}", { prefix: { regex: String.raw`\{\d{1,3}\}` } }, (n) => `{${n + 12}} `],
    ["marker inside a tag", { prefix: { preset: "square" } }, (n) => `<b>[${"אבג"[n]}]</b> `],
  ];
  for (const [name, filter, mark] of STYLES) {
    it(`${name}: only the marked lines are linked, by the words after the marker, and the offsets are the original's`, () => {
      const lines = [...HEAD, `${mark(0)}אלפא בטא גמא: פירוש על הדברים האלה כאן`, "כף למד מם נון: שורה בלי סימן, שאינה צריכה להיכנס", `${mark(1)}כף למד מם נון: ועוד פירוש לדברים`];
      const all = sorted(dh(lines).suggestions);
      expect(all.map(commLine)).toEqual([2, 3, 4]); // without the filter every line is linked
      const only = sorted(dh(lines, { sourceFilter: filter }).suggestions);
      expect(only.map(commLine)).toEqual([2, 4]);
      for (const s of only) {
        const line = lines[commLine(s)]!;
        const span = s.matched!.source!;
        expect(span.rawStart).toBeGreaterThanOrEqual(line.indexOf(mark(0).trimEnd()) >= 0 ? 0 : 0);
        // the span is the dibur AFTER the marker, in the ORIGINAL text
        expect(line.slice(span.rawStart, span.rawEnd)).toBe(commLine(s) === 2 ? "אלפא בטא גמא" : "כף למד מם נון");
        expect(span.rawStart).toBe(line.indexOf(commLine(s) === 2 ? "אלפא" : "כף"));
      }
      // the target is the right verse of the base
      expect(only.map((s) => (s.target.book.key === "base" ? s.target.line : s.source.line))).toEqual([2, 3]);
    });
  }

  it("the matched spans are the same as when the marker is replaced by spaces in the text itself (no shift)", () => {
    const original = [...HEAD, "[א] אלפא בטא גמא: פירוש על הדברים האלה כאן"];
    const blanked = [...HEAD, "    אלפא בטא גמא: פירוש על הדברים האלה כאן"];
    const a = dh(original, { sourceFilter: { prefix: { preset: "square" } } }).suggestions[0]!;
    const b = dh(blanked).suggestions[0]!;
    expect(a.matched).toEqual(b.matched);
    expect(a.id).toBe(b.id);
  });

  it("with an anchor on the base (anchors auto) the base's offsets do not move either", () => {
    const lines = [...HEAD, "[א] אלפא בטא גמא: פירוש על הדברים האלה כאן"];
    const withFilter = dh(lines, { anchors: "auto", sourceFilter: { prefix: { preset: "square" } } }).suggestions[0]!;
    const plain = dh([...HEAD, "אלפא בטא גמא: פירוש על הדברים האלה כאן"], { anchors: "auto" }).suggestions[0]!;
    expect(withFilter.anchor).toEqual(plain.anchor);
    expect(withFilter.source.line).toBe(plain.source.line);
  });

  it("exclude mode: every line EXCEPT the marked ones", () => {
    const lines = [...HEAD, "[א] אלפא בטא גמא: פירוש על הדברים האלה כאן", "כף למד מם נון: שורה בלי סימן שנכנסת"];
    const s = dh(lines, { sourceFilter: { prefix: { preset: "square" }, mode: "exclude" } }).suggestions;
    expect(s.map(commLine)).toEqual([3]);
  });

  it("another engine takes the same filter (headings: eligibility only, nothing is stripped)", () => {
    const base = ["<h1>ספר בסיס</h1>", "<h2>פרק א</h2>", "<h3>פסוק א</h3>", "א", "<h3>פסוק ב</h3>", "ב"];
    const comm = ["<h1>פירוש על ספר בסיס</h1>", "<h2>פרק א</h2>", "<h3>פסוק א</h3>", "[א] הערה ראשונה", "הערה בלי סימן", "<h3>פסוק ב</h3>", "[ב] הערה שנייה"];
    const unfiltered = runEngine("headings", book(COMM, comm), book(BASE, base)).suggestions.map((s) => s.source.line);
    expect(unfiltered).toEqual(expect.arrayContaining([3, 4, 6]));
    const filtered = runEngine("headings", book(COMM, comm), book(BASE, base), { sourceFilter: { prefix: { preset: "square" } } }).suggestions.map((s) => s.source.line);
    expect(filtered.sort()).toEqual([3, 6]);
  });

  it("the result says how many lines entered", () => {
    const lines = [...HEAD, "[א] אלפא בטא גמא: פירוש על הדברים האלה כאן", "כף למד מם נון: שורה בלי סימן"];
    const r = dh(lines, { sourceFilter: { prefix: { preset: "square" } } });
    expect(r.notes.map((n) => n.code)).toContain("source-filter/applied");
    expect(r.notes.find((n) => n.code === "source-filter/applied")!.text).toContain("1 מתוך 2");
  });

  it("a filter that is not valid is an error with a code, never ignored", () => {
    expect(() => dh([...HEAD, "[א] אלפא בטא גמא"], { sourceFilter: { prefix: { regex: "(a+)+$" } } })).toThrow(/כמת|קינון/);
    expect(() => dh([...HEAD, "[א] אלפא בטא גמא"], { sourceFilter: { prefix: {} } })).toThrow();
  });
});

describe("compileSourceFilter — the prefix", () => {
  const ok = (f: SourceFilter) => {
    const c = compileSourceFilter(f);
    if (!c.ok) throw new Error(c.reason);
    return c.filter;
  };
  it("the presets read Hebrew letters, numbers and gershayim, with tags and spaces before", () => {
    const sq = ok({ prefix: { preset: "square" } });
    for (const t of ["[א] x", "[יז] x", "[12] x", '[ט"ו] x', "  [א] x", "<b>[א]</b> x", "<i> [ב] </i>x", "[ א ] x"]) expect(sq.match(t), t).not.toBeNull();
    for (const t of ["א] x", "[] x", "[אבגדהוזחטיכלמנ] x", "x [א]", "(א) x", "בישול [א]"]) expect(sq.match(t), t).toBeNull();
    const round = ok({ prefix: { preset: "round" } });
    expect(round.match("(א) x")).not.toBeNull();
    expect(round.match("[א] x")).toBeNull();
    const close = ok({ prefix: { preset: "close-paren" } });
    expect(close.match("א) x")).not.toBeNull();
    expect(close.match("בשו\"ע מבואר) x")).toBeNull();
    const bold = ok({ prefix: { preset: "bold-dh" } });
    for (const t of ['<b>ד"ה</b> x', "<strong>ד״ה.</strong> x", '<b> בד"ה: </b>x']) expect(bold.match(t), t).not.toBeNull();
    expect(bold.match('<b>ד"ה אלפא</b> x')).toBeNull();
  });

  it("where the matching text starts: after the marker, its closing tags and the space after it", () => {
    const sq = ok({ prefix: { preset: "square" } });
    expect(sq.match("[א] בישול")!.matchFrom).toBe(4);
    expect(sq.match("<b>[א]</b> בישול")!.matchFrom).toBe(11);
    expect(sq.match("[א]בישול")!.matchFrom).toBe(3);
  });

  it("a custom regex is a PREFIX (anchored, with the same tag and space allowance), bounded, and refused when it can freeze the tool", () => {
    const f = ok({ prefix: { regex: String.raw`\{\d+\}` } });
    expect(f.match("{12} x")).not.toBeNull();
    expect(f.match("x {12}")).toBeNull();
    expect(f.match("<b>{3}</b> x")).not.toBeNull();
    // a leading ^ the user wrote is the same thing
    expect(ok({ prefix: { regex: String.raw`^\{\d+\}` } }).match("{12} x")).not.toBeNull();
    for (const bad of ["(a+)+$", "(a|aa)+b", String.raw`(\w+)\1`, "a*a*a*b", "", "x*"]) expect(compileSourceFilter({ prefix: { regex: bad } }).ok, bad).toBe(false);
    const refused = compileSourceFilter({ prefix: { regex: "(a+)+$" } });
    expect(refused.ok === false && refused.reason.length > 10).toBe(true);
  });

  it("a hostile line costs nothing: only the start of the line is looked at", () => {
    const f = ok({ prefix: { regex: String.raw`[a-z]{1,40}x` } });
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) f.match("a".repeat(500_000));
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("parseSourceFilter takes only what the form can make", () => {
    expect(parseSourceFilter({ prefix: { preset: "square" } })).toEqual({ prefix: { preset: "square" } });
    expect(parseSourceFilter({ prefix: { preset: "square" }, mode: "exclude", strip: false })).toEqual({ prefix: { preset: "square" }, mode: "exclude", strip: false });
    expect(parseSourceFilter({ prefix: { preset: "nope" } })).toBeNull();
    expect(parseSourceFilter({ prefix: { regex: 7 } })).toBeNull();
    expect(parseSourceFilter({ prefix: { preset: "square" }, mode: "weird" })).toBeNull();
    expect(parseSourceFilter("square")).toBeNull();
    expect(parseSourceFilter(null)).toBeNull();
    expect(parseSourceFilter({ prefix: { preset: "__proto__" } })).toBeNull();
  });
});

describe("applySourceFilter — the book the engine sees", () => {
  const f = (spec: SourceFilter, strip?: boolean) => {
    const c = compileSourceFilter(spec, strip === undefined ? undefined : { strip });
    if (!c.ok) throw new Error(c.reason);
    return c.filter;
  };
  const lines = ["<h1>כותרת</h1>", "[א] ראשון: טקסט", "בלי סימן", "", "<b>[ב]</b> שני: טקסט"];
  const src = book(COMM, lines);

  it("keeps every index and every length: an ineligible line is empty, headings stay, a marker becomes spaces", () => {
    const seen = applySourceFilter(src, f({ prefix: { preset: "square" } }, true));
    expect(seen.lines.map((l) => l.index)).toEqual([0, 1, 2, 3, 4]);
    expect(seen.lines[0]!.text).toBe(lines[0]);
    expect(seen.lines[0]!.heading).toBe(1);
    expect(seen.lines[2]!.text).toBe("");
    expect(seen.lines[1]!.text).toBe("    ראשון: טקסט");
    expect(seen.lines[1]!.text.length).toBe(lines[1]!.length);
    expect(seen.lines[4]!.text.length).toBe(lines[4]!.length);
    expect(seen.lines[4]!.text.endsWith(" שני: טקסט")).toBe(true);
    // the original book is not touched
    expect(src.lines[1]!.text).toBe("[א] ראשון: טקסט");
  });

  it("without strip the eligible lines are the original, untouched", () => {
    const seen = applySourceFilter(src, f({ prefix: { preset: "square" } }, false));
    expect(seen.lines[1]!.text).toBe(lines[1]);
    expect(seen.lines[2]!.text).toBe("");
  });
});

describe("previewSourceFilter — which lines are in and which are out", () => {
  const lines = ["<h1>כותרת</h1>", "[א] בישול אכילה הנאה: ראשון", "א) בשו\"ע מבואר שכל בשר בחלב", "ב) עוד שורה", "", "[ב] דין שני: טקסט", "x"].map((text, index) => ({ index, text, heading: headingLevel(text) }));
  const c = compileSourceFilter({ prefix: { preset: "square" } });
  if (!c.ok) throw new Error(c.reason);

  it("counts, and shows the first lines of each side with the marker and the words that will be matched", () => {
    const p = previewSourceFilter(lines, c.filter, 5);
    expect(p).toMatchObject({ headings: 1, blank: 1, included: 2, excluded: 3 });
    expect(p.total).toBe(5);
    expect(p.includedSample[0]).toEqual({ line: 1, prefix: "[א]", rest: "בישול אכילה הנאה: ראשון" });
    expect(p.includedSample[1]!.line).toBe(5);
    expect(p.excludedSample.map((x) => x.line)).toEqual([2, 3, 6]);
    expect(p.excludedSample[0]!.text).toContain("בשו\"ע");
  });

  it("the samples are bounded", () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ index: i, text: `[א] שורה ${i}`, heading: null }));
    const p = previewSourceFilter(many, c.filter, 4);
    expect(p.included).toBe(1000);
    expect(p.includedSample).toHaveLength(4);
  });
});

describe("the form: the engine options carry the filter", () => {
  it("dibur-hamatchil: choosing a marker puts sourceFilter in the options (strip is the engine's default and is not stored)", () => {
    const v = { ...defaultFormValues("dibur-hamatchil"), lineFilter: "square" };
    expect(toEngineOptions("dibur-hamatchil", v, "essential").options).toEqual({ sourceFilter: { prefix: { preset: "square" } } });
    expect(toEngineOptions("dibur-hamatchil", { ...v, lineFilterExclude: true }, "all").options["sourceFilter"]).toEqual({ prefix: { preset: "square" }, mode: "exclude" });
  });

  it("the default is no filter: nothing is added, so a run with untouched settings is byte-identical", () => {
    expect(toEngineOptions("dibur-hamatchil", defaultFormValues("dibur-hamatchil"), "all").options).toEqual({});
  });

  it("a regex is checked by the same guard as the engine: a dangerous one is an error on its field and no run starts", () => {
    const v = { ...defaultFormValues("dibur-hamatchil"), lineFilter: "regex", lineFilterRegex: "(a+)+$" };
    const c = toEngineOptions("dibur-hamatchil", v, "essential");
    expect(c.errors["lineFilterRegex"]).toBeTruthy();
    expect(c.options["sourceFilter"]).toBeUndefined();
    const empty = toEngineOptions("dibur-hamatchil", { ...v, lineFilterRegex: "" }, "essential");
    expect(empty.errors["lineFilterRegex"]).toBeTruthy();
    const good = toEngineOptions("dibur-hamatchil", { ...v, lineFilterRegex: String.raw`\{\d+\}` }, "essential");
    expect(good.errors).toEqual({});
    expect(good.options["sourceFilter"]).toEqual({ prefix: { regex: String.raw`\{\d+\}` } });
  });

  it("the headings engine has it too, with strip OFF by default (its inline numbering needs the marker)", () => {
    const v = { ...defaultFormValues("headings"), lineFilter: "square" };
    expect(toEngineOptions("headings", v, "all").options["sourceFilter"]).toEqual({ prefix: { preset: "square" } });
    expect(toEngineOptions("headings", { ...v, lineFilterStrip: true }, "all").options["sourceFilter"]).toEqual({ prefix: { preset: "square" }, strip: true });
  });

  it("stored options come back only if they are valid", () => {
    expect(sanitizeStoredOptions("dibur-hamatchil", { sourceFilter: { prefix: { preset: "round" } } })).toEqual({ sourceFilter: { prefix: { preset: "round" } } });
    expect(sanitizeStoredOptions("dibur-hamatchil", { sourceFilter: { prefix: { regex: "(a+)+$" } } })).toEqual({});
    expect(sanitizeStoredOptions("dibur-hamatchil", { sourceFilter: 5 })).toEqual({});
  });
});
