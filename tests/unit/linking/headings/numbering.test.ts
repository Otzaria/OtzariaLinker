import { describe, expect, it } from "vitest";
import { inlineMarker, parseHeading, parseNumeral, untaggedHeading } from "../../../../src/linking/automatic/headings/numbering";

const els = (h: string, mode: "lenient" | "strict" = "lenient") => parseHeading(h, mode).map((e) => [e.kind, e.n ?? e.name, e.amud ?? null]);

describe("heading numbering", () => {
  it("reads kind words, their abbreviations and Arabic numerals", () => {
    expect(els("<h2>פרק א</h2>")).toEqual([["perek", 1, null]]);
    expect(els("פ' ג")).toEqual([["perek", 3, null]]);
    expect(els("סי' קכג")).toEqual([["siman", 123, null]]);
    expect(els("סימן קכ\"ג")).toEqual([["siman", 123, null]]);
    expect(els("סימן 12")).toEqual([["siman", 12, null]]);
    expect(els('ס"ק ד')).toEqual([["seifkatan", 4, null]]);
    expect(els("סעיף קטן ד")).toEqual([["seifkatan", 4, null]]);
    expect(els("פרק ראשון")).toEqual([["perek", 1, null]]);
    expect(els("פֶּרֶק ב׳")).toEqual([["perek", 2, null]]);
  });

  it("reads several elements in one heading and ignores a subtitle", () => {
    expect(els("פרק א משנה ב")).toEqual([["perek", 1, null], ["mishna", 2, null]]);
    expect(els("פרק ב - היה קורא")).toEqual([["perek", 2, null]]);
  });

  it("daf and amud: '.' / ':' / ע\"א / עמוד ב / amud alone", () => {
    expect(els("דף ב.")).toEqual([["daf", 2, 1]]);
    expect(els("דף ב:")).toEqual([["daf", 2, 2]]);
    expect(els('דף ב ע"א')).toEqual([["daf", 2, 1]]);
    expect(els("דף ב ע״ב")).toEqual([["daf", 2, 2]]);
    expect(els("דף קיא עמוד ב")).toEqual([["daf", 111, 2]]);
    expect(els("דף ב")).toEqual([["daf", 2, null]]);
    expect(els("עמוד ב")).toEqual([["amud", 2, null]]);
    expect(els('ע"א')).toEqual([["amud", 1, null]]);
  });

  it("lenient structural numerals are summed (REUSE §5.1); strict rejects them", () => {
    expect(els("סימן יה")).toEqual([["siman", 15, null]]);
    expect(els("סימן רחצ")).toEqual([["siman", 298, null]]);
    expect(els("סימן יה", "strict")).toEqual([["name", "סימן יה", null]]);
    expect(els("סימן טו", "strict")).toEqual([["siman", 15, null]]);
  });

  it("lenient reads the spellings books use for a number, not any word that sums to one (review C5)", () => {
    // words after a kind word: a name, never a chapter number
    expect(els("<h2>פרק בא לו</h2>")).toEqual([["name", "פרק בא לו", null]]);
    expect(els("פרק במה מדליקין")).toEqual([["name", "פרק במה מדליקין", null]]);
    expect(els("פרק כל כתבי")).toEqual([["name", "פרק כל כתבי", null]]);
    expect(els("פרק אלו טריפות")).toEqual([["name", "פרק אלו טריפות", null]]);
    expect(els("פרק גיד הנשה")).toEqual([["name", "פרק גיד הנשה", null]]);
    expect(els("פרק אין עומדין")).toEqual([["name", "פרק אין עומדין", null]]);
    expect(els("פרק אחד עשר")).toEqual([["name", "פרק אחד עשר", null]]); // was 13
    expect(els("משנה תורה")).toEqual([["name", "משנה תורה", null]]); // was משנה 722
    expect(els("משנה שבת פרק א")[0]![0]).toBe("name"); // was משנה 702
    expect(els("פרק גן עדן")).toEqual([["name", "פרק גן עדן", null]]); // גן reordered, but words follow
    // the spellings books do use
    expect(els("סימן חי")).toEqual([["siman", 18, null]]);
    expect(els("סימן טל")).toEqual([["siman", 39, null]]);
    expect(els("סימן תגל")).toEqual([["siman", 433, null]]);
    expect(els("סימן ער - במה")).toEqual([["siman", 270, null]]);
    expect(els("דף טל:")).toEqual([["daf", 39, 2]]);
    expect(els('דף חי ע"א')).toEqual([["daf", 18, 1]]);
    expect(els("סימן קיה")).toEqual([["siman", 115, null]]);
    expect(els("פרק יה מאימתי")).toEqual([["perek", 15, null]]); // יה / יו: anywhere
    expect(els("פרק ב היה קורא")).toEqual([["perek", 2, null]]); // canonical: a subtitle may follow
    expect(parseNumeral("בא", "lenient", false)).toBeNull();
    expect(parseNumeral("חי", "lenient", false, false)).toBeNull();
    expect(parseNumeral("חי", "lenient", false, true)?.n).toBe(18);
  });

  it("a bare numeral must look like one; ordinary words stay names", () => {
    expect(els("יב")).toEqual([["?", 12, null]]);
    expect(els("(יב)")).toEqual([["?", 12, null]]);
    expect(els("הלכות שבת")).toEqual([["name", "הלכות שבת", null]]);
    expect(els("הקדמה")).toEqual([["name", "הקדמה", null]]);
    expect(parseNumeral("שבת", "lenient", true)).toBeNull();
    expect(parseNumeral("טז", "lenient", true)?.n).toBe(16);
    expect(parseHeading("<h3></h3>")).toEqual([]);
  });

  it("untagged headings: only a short line made entirely of kind words and numerals", () => {
    expect(untaggedHeading("פרק ג", "lenient")?.map((e) => e.n)).toEqual([3]);
    expect(untaggedHeading('דף ב ע"א', "lenient")?.map((e) => [e.n, e.amud])).toEqual([[2, 1]]);
    expect(untaggedHeading("פרק ג ועוד", "lenient")).toBeNull();
    expect(untaggedHeading("יב", "lenient")).toBeNull();
    expect(untaggedHeading("הלכות שבת", "lenient")).toBeNull();
  });

  it("untagged headings: bold, bracketed, glued ס\"ק, abbreviations and the new kinds", () => {
    const kinds = (s: string) => untaggedHeading(s, "lenient")?.map((e) => `${e.kind}${e.n}`) ?? null;
    expect(kinds("<b>סעיף ג</b>")).toEqual(["seif3"]);
    expect(kinds("(סימן ה)")).toEqual(["siman5"]);
    expect(kinds("[סעי' ג]")).toEqual(["seif3"]);
    expect(kinds('סימן ה סק"ב')).toEqual(["siman5", "seifkatan2"]);
    expect(kinds('סקי"ב')).toEqual(["seifkatan12"]);
    expect(kinds("סימן ה.")).toEqual(["siman5"]);
    expect(kinds("הערה ג")).toEqual(["note3"]);
    expect(kinds("שורש ד")).toEqual(["shoresh4"]);
    expect(kinds("תיקון ע")).toEqual(["tikun70"]);
    expect(kinds("דרוש ב")).toEqual(["drush2"]);
    // text, not headings: a sentence that starts like one, a word that starts like a glued ס"ק, a bare numeral in brackets
    expect(kinds("סימן ה אמר רבי")).toBeNull();
    expect(kinds("סקל")).toBeNull();
    expect(kinds("(יב)")).toBeNull();
    expect(kinds("(סימן ה) ועוד")).toBeNull();
  });

  it("inline markers: '(יב) …' at the start of a line", () => {
    expect(inlineMarker("(יב) וַיֹּאמֶר", "lenient")).toBe(12);
    expect(inlineMarker("<b>(ג)</b> טקסט", "lenient")).toBe(3);
    expect(inlineMarker("טקסט (ג)", "lenient")).toBeNull();
    expect(inlineMarker("(שם) טקסט", "lenient")).toBeNull(); // "(שם)" is a citation, never 340
    expect(inlineMarker("(יה) טקסט", "lenient")).toBe(15);
    expect(inlineMarker("(רחצ) טקסט", "lenient")).toBeNull(); // kind-less: must look like a numeral
  });
});
