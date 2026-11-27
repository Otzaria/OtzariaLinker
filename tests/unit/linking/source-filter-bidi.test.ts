import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../src/core/links/model";
import { headingLevel } from "../../../src/core/text/html";
import { runEngine, type EngineBook, type Suggestion } from "../../../src/linking/automatic";
import { compileSourceFilter, type SourceFilter } from "../../../src/linking/automatic/source-filter";

/*
 * Findings #42 C11: a marker written with a bidi mark before it (U+200E, U+200F, as text or as an entity), with one inside the brackets, or
 * with nikud on its letter ("[אֿ]") was not a marker: the LEAD and LABEL patterns knew only spaces, tags and bare letters.
 * Synthetic neutral words; no book text.
 */
const ref = (key: string, title: string): BookRef => ({ key, title, origin: "otzaria" });
const BASE = ref("base", "ספר בסיס");
const COMM = ref("comm", "פירוש על ספר בסיס");
const book = (r: BookRef, texts: readonly string[]): EngineBook => ({ book: r, lines: texts.map((text, index) => ({ index, text, heading: headingLevel(text) })) });
const BASE_LINES = ["<h1>ספר בסיס</h1>", "<h2>פרק א</h2>", "אלפא בטא גמא דלתא הא וו זין חית טית יוד", "כף למד מם נון סמך עין פא צדי קוף ריש"];
const HEAD = ["<h1>פירוש על ספר בסיס</h1>", "<h2>פרק א</h2>"];
const dh = (lines: readonly string[], options: Record<string, unknown> = {}) => runEngine("dibur-hamatchil", book(COMM, lines), book(BASE, BASE_LINES), { anchors: "off", ...options });
const commLine = (s: Suggestion) => (s.source.book.key === "comm" ? s.source.line : s.target.line);
const SQUARE: SourceFilter = { prefix: { preset: "square" } };
const compiled = (spec: SourceFilter) => {
  const c = compileSourceFilter(spec);
  if (!c.ok) throw new Error(c.reason);
  return c.filter;
};

describe("C11: markers with bidi marks or nikud are markers", () => {
  const sq = compiled(SQUARE);
  it.each([
    ["nikud in the label", "[אֿ] אלפא"],
    ["a dagesh and a kamatz", "[בָּ] אלפא"],
    ["RLM before", "‏[א] אלפא"],
    ["LRM before", "‎[א] אלפא"],
    ["an RLM entity before", "&rlm;[א] אלפא"],
    ["a bidi mark inside the brackets", "[‏א‏] אלפא"],
    ["a bidi mark before a bold marker", "‏<b>[א]</b> אלפא"],
    ["a zero-width space before", "​[א] אלפא"],
  ])("%s", (_name, text) => {
    const m = sq.match(text);
    expect(m).not.toBeNull();
    expect(text.slice(m!.matchFrom)).toBe("אלפא");
  });

  it("the other presets too", () => {
    expect(compiled({ prefix: { preset: "round" } }).match("‏(אֿ) אלפא")).not.toBeNull();
    expect(compiled({ prefix: { preset: "close-paren" } }).match("‏בּ) אלפא")).not.toBeNull();
    expect(compiled({ prefix: { preset: "bold-dh" } }).match('‏<b>ד"ה</b> אלפא')).not.toBeNull();
  });

  it("still not a marker: a long word in brackets, a marker later in the line, a bare bidi mark", () => {
    for (const t of ["[אבגדהוזחטיכלמנ] x", "x [א]", "‏ x", "‏‏", "[ָ] x"]) expect(sq.match(t), t).toBeNull();
  });

  it("dibur-hamatchil with the filter links the marked lines by the words after the mark", () => {
    const lines = [...HEAD, "‏[אֿ] אלפא בטא גמא: פירוש", "כף למד מם נון: שורה בלי סימן", "‎[ב] כף למד מם נון: ועוד"];
    expect(dh(lines, { sourceFilter: SQUARE }).suggestions.map(commLine).sort()).toEqual([2, 4]);
  });
});
