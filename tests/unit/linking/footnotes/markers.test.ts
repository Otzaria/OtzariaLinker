import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { countVisibleChars, visibleUnits } from "../../../../src/core/text/offsets";
import {
  appRecognisesMarker, checkCustomPattern, detectMarkers, leadingMarker, parseMarkerToken, MAX_CUSTOM_REGEX_INPUT, type Marker,
} from "../../../../src/linking/automatic/footnotes";

/** What the reader sees between the anchor offsets, counted the generator's way. */
function shownByGenerator(line: string, m: Pick<Marker, "rawStart" | "rawEnd">): string {
  const units = visibleUnits(line);
  const a = countVisibleChars(line, m.rawStart);
  const b = countVisibleChars(line, m.rawEnd);
  return units.slice(a, b).map((u) => line.slice(u.start, u.end)).join("");
}
const keys = (ms: Marker[]) => ms.map((m) => m.key);

describe("parseMarkerToken (Link-Notes normalizeRefToken)", () => {
  it("digits, letters, gershayim, final letters", () => {
    expect(parseMarkerToken("12")).toMatchObject({ num: 12, key: "12", numbering: "digits", decorated: false });
    expect(parseMarkerToken("יב")).toMatchObject({ num: 12, key: "12", numbering: "letters" });
    expect(parseMarkerToken('קכ"ג')).toMatchObject({ num: 123 });
    expect(parseMarkerToken("ט״ו")).toMatchObject({ num: 15 });
    expect(parseMarkerToken("ך")).toMatchObject({ num: 20 });
  });
  it("wrappers and punctuation are decoration; stars are part of the key", () => {
    expect(parseMarkerToken("(א)")).toMatchObject({ num: 1, key: "1", decorated: true });
    expect(parseMarkerToken("א)")).toMatchObject({ num: 1, key: "1", decorated: true });
    expect(parseMarkerToken("[12]")).toMatchObject({ key: "12" });
    expect(parseMarkerToken("*3")).toMatchObject({ num: 3, key: "*3" });
    expect(parseMarkerToken("(3*)")).toMatchObject({ key: "3*" });
  });
  it("stars alone are a marker without a number", () => {
    expect(parseMarkerToken("*")).toMatchObject({ num: 0, key: "*", numbering: "stars" });
    expect(parseMarkerToken("**")).toMatchObject({ key: "**" });
  });
  it("lenient by default (books write יה, ער), ordered when asked (running text)", () => {
    expect(parseMarkerToken("ער")?.num).toBe(270);
    expect(parseMarkerToken("ער", { ordered: true })).toBeNull();
    expect(parseMarkerToken('הג"ה', { ordered: true })).toBeNull();
    expect(parseMarkerToken("טו", { ordered: true })?.num).toBe(15);
    expect(parseMarkerToken("תקכ", { maxLetters: 2 })).toBeNull();
  });
  it("refuses long numbers, Latin, empty input; words only under the ordered rule", () => {
    for (const bad of ["", "12345", "a", "1a", "()", "שלומות"]) expect(parseMarkerToken(bad)).toBeNull();
    // a 4-letter word inside an explicit marker tag is read leniently (Link-Notes); running text uses `ordered`
    expect(parseMarkerToken("שלום")?.num).toBe(376);
    expect(parseMarkerToken("שלום", { ordered: true })).toBeNull();
  });
});

describe("detectMarkers: <sup> / <sub> / any tag", () => {
  it("one marker per element, spanning the whole element", () => {
    const line = "שלום<sup>1</sup> עולם<sup>2</sup>.";
    const ms = detectMarkers(line, "sup");
    expect(keys(ms)).toEqual(["1", "2"]);
    expect(line.slice(ms[0]!.rawStart, ms[0]!.rawEnd)).toBe("<sup>1</sup>");
    expect(ms[0]!.visible).toBe("1");
  });
  it("Hebrew letters, parentheses inside the tag, stars, attributes, upper case", () => {
    expect(detectMarkers('א<sup>(יב)</sup> ב<SUP class="x">*3</SUP> ג<sup>**</sup>', "sup").map((m) => [m.key, m.numbering])).toEqual([
      ["12", "letters"], ["*3", "digits"], ["**", "stars"],
    ]);
  });
  it("<sub> and a named tag", () => {
    expect(keys(detectMarkers("א<sub>4</sub>", "sub"))).toEqual(["4"]);
    expect(keys(detectMarkers("א<small>5</small> <sup>6</sup>", { tag: "small" }))).toEqual(["5"]);
  });
  it("several numbers in one element: one marker for each, each spanning its own number", () => {
    const line = "טקסט<sup>3,4</sup>";
    const ms = detectMarkers(line, "sup");
    expect(keys(ms)).toEqual(["3", "4"]);
    expect(ms.map((m) => line.slice(m.rawStart, m.rawEnd))).toEqual(["3", "4"]);
  });
  it("a tag with words is not a marker", () => {
    expect(detectMarkers("א<sup>ראה שם</sup> <sup>st</sup>", "sup")).toEqual([]);
  });
  it("broken tags are repaired and flagged", () => {
    const noGt = detectMarkers("א<sup>7</sup ב", "sup");
    expect(noGt.map((m) => [m.key, m.broken])).toEqual([["7", "close-without-gt"]]);
    const unclosed = detectMarkers("א<sup>8 ב<sup>9</sup>", "sup");
    expect(unclosed.map((m) => [m.key, m.broken ?? null])).toEqual([["8", "unclosed"], ["9", null]]);
    expect(unclosed[0]!.visible).toBe("8");
    expect(keys(detectMarkers("א< sup >10</ sup > ב", "sup"))).toEqual(["10"]);
  });
  it("skips the generator's own inline-note markers unless asked", () => {
    const line = 'א<sup class="footnote-marker">1</sup> ב<sup>2</sup>';
    expect(keys(detectMarkers(line, "sup"))).toEqual(["2"]);
    const all = detectMarkers(line, "sup", { includeInlineNoteMarkers: true });
    expect(all.map((m) => [m.key, !!m.inlineNote])).toEqual([["1", true], ["2", false]]);
  });
  it("numbering filter keeps stars", () => {
    expect(keys(detectMarkers("<sup>1</sup><sup>א</sup><sup>*</sup>", "sup", { numbering: "letters" }))).toEqual(["1", "*"]);
  });
});

describe("detectMarkers: parentheses in running text", () => {
  it("finds (12) and (יב), also across tags, never inside a tag", () => {
    const line = 'שלום (12) עולם (<b>יג</b>) <span title="(14)">x</span>';
    const ms = detectMarkers(line, "parentheses");
    expect(keys(ms)).toEqual(["12", "13"]);
    expect(line.slice(ms[1]!.rawStart, ms[1]!.rawEnd)).toBe("(<b>יג</b>)");
    expect(ms[1]!.visible).toBe("(יג)");
  });
  it("citations are not markers: (שם), unordered letters, longer words", () => {
    expect(detectMarkers("(שם) (הגה) (בראשית) (רות ד ב) (תשרי)", "parentheses")).toEqual([]);
  });
});

describe("custom regex rules", () => {
  it("group n or 1 is the number, the span is the whole match on the raw line", () => {
    const line = "א [*12] ב [יג]";
    const ms = detectMarkers(line, { regex: "\\[(?<n>[^\\]]{1,5})\\]" });
    expect(keys(ms)).toEqual(["*12", "13"]);
    expect(line.slice(ms[0]!.rawStart, ms[0]!.rawEnd)).toBe("[*12]");
  });
  it("a match inside a tag (nothing visible) is dropped", () => {
    expect(detectMarkers('<a href="#12">x</a>', { regex: "#(\\d+)" })).toEqual([]);
  });
  it("refuses catastrophic and unsafe patterns", () => {
    for (const bad of ["(a+)+$", "(\\d*)*", "(a|aa)+", "(x+x+)+y", "(.)\\1", "a*b*c*d*", "", "(", "x?", "a".repeat(400)])
      expect(checkCustomPattern(bad).ok, bad).toBe(false);
    for (const good of ["\\((\\d{1,3})\\)", "<sup>([א-ת]{1,3})</sup>", "\\[(\\d+)\\]", "(?:x|y)\\d"]) expect(checkCustomPattern(good).ok, good).toBe(true);
  });
  it("an invalid rule detects nothing instead of throwing", () => {
    expect(detectMarkers("(1)", { regex: "(a+)+" })).toEqual([]);
  });
  it("lines over the cap are not searched", () => {
    expect(detectMarkers("x".repeat(MAX_CUSTOM_REGEX_INPUT + 1) + "[1]", { regex: "\\[(\\d)\\]" })).toEqual([]);
  });
});

describe("leadingMarker: how a note line opens", () => {
  it.each([
    ["(12) הערה", "12"], ["[יב] הערה", "12"], ["12. הערה", "12"], ["12) הערה", "12"], ["יב) הערה", "12"], ["א. הערה", "1"],
    ["<sup>יב</sup> הערה", "12"], ["<sup>א</sup>מלשון", "1"], ["<b>12</b> הערה", "12"], ["  <small>(ג)</small> הערה", "3"], ["* הערה", "*"],
    ["<sup>*</sup> הערה", "*"], ["<sup>א)</sup> א) הערה", "1"],
  ])("%s → %s", (line, key) => expect(leadingMarker(line)?.key).toBe(key));
  it.each([["אמר רבי"], ["<b>ומה</b> שכתב"], ["תשובה. ועוד"], ["(שם) ראה"], ["ראה (12)"], [""]])("%s → none", (line) => expect(leadingMarker(line)).toBeNull());
  it("with an explicit style the marker must come first", () => {
    expect(leadingMarker("<sup>3</sup> הערה", "sup")?.key).toBe("3");
    expect(leadingMarker("הערה <sup>3</sup>", "sup")).toBeNull();
  });
});

describe("the app's popup grammar (numbered_note_markers.dart)", () => {
  const first = (line: string, style: "sup" | "parentheses") => detectMarkers(line, style)[0]!;
  it("a number only as (12) in text, a letter only as the whole <sup>(א)</sup>", () => {
    expect(appRecognisesMarker("א (12) ב", first("א (12) ב", "parentheses"))).toBe(true);
    expect(appRecognisesMarker("א<sup>(12)</sup>", first("א<sup>(12)</sup>", "sup"))).toBe(true);
    expect(appRecognisesMarker("א<sup>(יב)</sup>", first("א<sup>(יב)</sup>", "sup"))).toBe(true);
    expect(appRecognisesMarker("א<sup>(*יב)</sup>", first("א<sup>(*יב)</sup>", "sup"))).toBe(true);
    expect(appRecognisesMarker("א<sup>9</sup>", first("א<sup>9</sup>", "sup"))).toBe(false);
    expect(appRecognisesMarker("א<sup>יב</sup>", first("א<sup>יב</sup>", "sup"))).toBe(false);
    expect(appRecognisesMarker("א (יב) ב", first("א (יב) ב", "parentheses"))).toBe(false);
  });
});

/* ---------------------------------------------------------------- property: raw offsets */

const word = fc.constantFrom("שלום", "עולם", "אב", "דה", "x", " ", ", ", "&amp;", "&nbsp;", "&quot;", "ב׳");
const filler = fc.array(fc.oneof(word, fc.constantFrom("<b>", "</b>", "<i>", "</i>", "<span class=\"a\">", "</span>")), { maxLength: 6 }).map((xs) => xs.join(""));
const number = fc.oneof(fc.integer({ min: 1, max: 999 }).map(String), fc.constantFrom("א", "יב", "קכג", "ט״ו", "*", "*3"));
const wrap = (style: "sup" | "sub" | "parentheses", n: string) =>
  style === "parentheses" ? fc.constantFrom(`(${n})`, `(<b>${n}</b>)`) : fc.constantFrom(`<${style}>${n}</${style}>`, `<${style}>(${n})</${style}>`, `<${style} class="m"><b>${n}</b></${style}>`);

describe("property: the anchor's visible text is exactly the marker (generator offsets)", () => {
  for (const style of ["sup", "sub", "parentheses"] as const) {
    it(style, () => {
      fc.assert(
        fc.property(filler, number, filler, number, filler, (a, n1, b, n2, c) => {
          const m1 = fc.sample(wrap(style, n1), 1)[0]!;
          const m2 = fc.sample(wrap(style, n2), 1)[0]!;
          const line = `${a}${m1} ${b}${m2}${c}`;
          const found = detectMarkers(line, style);
          if (style === "parentheses" && (n1.startsWith("*") || n2.startsWith("*"))) return; // "(*3)" is fine, but keep the oracle simple
          expect(found.map((m) => m.key)).toEqual([n1, n2].map((n) => parseMarkerToken(n)!.key));
          for (const m of found) {
            expect(shownByGenerator(line, m)).toBe(m.visible);
            expect(m.visible.replace(/[()\s]/g, "")).toBe(found[0] === m ? n1 : n2);
            expect(m.rawStart).toBeGreaterThanOrEqual(0);
            expect(m.rawEnd).toBeLessThanOrEqual(line.length);
          }
        }),
        { numRuns: 300 },
      );
    });
  }
});
