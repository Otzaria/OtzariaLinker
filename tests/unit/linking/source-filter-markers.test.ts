import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../src/core/links/model";
import { headingLevel } from "../../../src/core/text/html";
import { countVisibleChars } from "../../../src/core/text/offsets";
import { sanitizeBookHtml } from "../../../src/core/text/sanitize";
import { runEngine, type EngineBook, type Suggestion } from "../../../src/linking/automatic";
import { applySourceFilter, compileSourceFilter, type SourceFilter } from "../../../src/linking/automatic/source-filter";

/*
 * Findings #41 B3: the marker is blanked for matching together with the tags around it — "<b>[א] אלפא בטא</b> …" became spaces up to the
 * words, the "<b>" was gone and a stray "</b>" was left, the visible offsets moved by the tag's length, and the line that is linked without
 * the filter came back "unmatched" with it. Only the marker's visible characters may become spaces: tags and entities stay, so the HTML,
 * the line index, the raw and the visible offsets and the anchor are the original's.
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
const compiled = (spec: SourceFilter, strip = true) => {
  const c = compileSourceFilter(spec, { strip });
  if (!c.ok) throw new Error(c.reason);
  return c.filter;
};
/** the one line as the engine reads it after the filter */
const seen = (text: string, spec: SourceFilter = SQUARE) => applySourceFilter(book(COMM, [text]), compiled(spec)).lines[0]!.text;
const tags = (s: string) => [...s.matchAll(/<[^>]*>/g)].map((m) => `${m.index}:${m[0]}`);

describe("B3: a marker inside a bold label that goes on after it", () => {
  it("the measured case: linked without the filter, and linked the same with it (not unmatched)", () => {
    const lines = [...HEAD, "<b>[א] אלפא בטא גמא</b> פירוש על הדברים האלה כאן", "<b>כף למד מם נון</b> שורה בלי סימן"];
    const plain = dh(lines).suggestions.filter((s) => commLine(s) === 2);
    expect(plain).toHaveLength(1);
    const r = dh(lines, { sourceFilter: SQUARE });
    expect(r.unmatched.map((u) => u.line)).not.toContain(2);
    const only = r.suggestions;
    expect(only.map(commLine)).toEqual([2]);
    expect(only[0]!.target.book.key === "base" ? only[0]!.target.line : only[0]!.source.line).toBe(2);
    // the matched words are the dibur after the marker, at their place in the ORIGINAL line
    const span = only[0]!.matched!.source!;
    expect(lines[2]!.slice(span.rawStart, span.rawEnd)).toBe("אלפא בטא גמא");
  });

  it("only the marker's characters become spaces: the tag stays, so the HTML is valid and nothing moves", () => {
    const line = "<b>[א] אלפא בטא</b> גמא";
    expect(seen(line)).toBe("<b>    אלפא בטא</b> גמא");
  });

  it("nested tags, a tag inside the marker, an entity and a bidi mark before it", () => {
    expect(seen("<big><b>[א]</b></big> אלפא")).toBe("<big><b>   </b></big> אלפא");
    expect(seen("&nbsp;<b>[א] אלפא</b>")).toBe("&nbsp;<b>    אלפא</b>");
    expect(seen("<i> [ב] </i>אלפא")).toBe("<i>     </i>אלפא");
  });
});

describe("B3: the blanked line keeps every offset (property)", () => {
  const PIECE = ["<b>", "</b>", "<i>", "</i>", "<big>", "</big>", " ", "&nbsp;", " ", "‎", "‏", "​", "&rlm;", "&lrm;"];
  const MARK = ["[א]", "[אֿ]", "[יב]", "[ט\"ו]", "[ ב ]", "[‏א]", "[בּ]", "[אָ]"];
  const REST = ["אלפא", "בטא", " ", "<b>", "</b>", "&quot;", "גמא", "ְ", "‏", " ", "&nbsp;", "😀", "<i>", "</i>"];
  const line = fc
    .tuple(fc.array(fc.constantFrom(...PIECE), { maxLength: 5 }), fc.constantFrom(...MARK), fc.array(fc.constantFrom(...PIECE), { maxLength: 3 }), fc.array(fc.constantFrom(...REST), { minLength: 1, maxLength: 12 }))
    .map(([lead, mark, after, rest]) => `${lead.join("")}${mark}${after.join("")}${rest.join("")}`);

  it("same length, same tags at the same places, same visible count at every raw offset, the words after the marker untouched", () => {
    fc.assert(
      fc.property(line, (text) => {
        const f = compiled(SQUARE);
        const m = f.match(text);
        fc.pre(m !== null);
        const out = seen(text);
        expect(out.length).toBe(text.length);
        expect(tags(out)).toEqual(tags(text));
        for (let p = 0; p <= text.length; p++) expect(countVisibleChars(out, p)).toBe(countVisibleChars(text, p));
        expect(out.slice(m!.matchFrom)).toBe(text.slice(m!.matchFrom));
        // the sanitizer sees the same structure: the same tags, and as many visible characters
        const a = sanitizeBookHtml(text);
        const b = sanitizeBookHtml(out);
        expect(tags(b).map((t) => t.split(":")[1])).toEqual(tags(a).map((t) => t.split(":")[1]));
        expect(countVisibleChars(b)).toBe(countVisibleChars(a));
      }),
      { numRuns: 400 },
    );
  });

  it("a dibur-hamatchil link and its matched words are where they are without the marker (the marker replaced by spaces in the text)", () => {
    fc.assert(
      fc.property(fc.constantFrom("", "<b>", "‏", "&nbsp;", "<i>‎"), fc.constantFrom("[א]", "[אֿ]", "[יב]"), fc.boolean(), (lead, mark, bold) => {
        const close = lead.startsWith("<i>") ? "</i>" : "";
        const words = bold ? "<b>אלפא בטא גמא</b>" : "אלפא בטא גמא";
        const text = `${lead}${mark}${close} ${words}: פירוש לדברים`;
        const withFilter = dh([...HEAD, text], { sourceFilter: SQUARE }).suggestions;
        expect(withFilter).toHaveLength(1);
        const span = withFilter[0]!.matched!.source!;
        expect(text.slice(span.rawStart, span.rawEnd).replace(/<[^>]*>/g, "")).toBe("אלפא בטא גמא");
        expect(countVisibleChars(text, span.rawStart)).toBe(countVisibleChars(text, text.indexOf("אלפא")));
      }),
    );
  });
});
