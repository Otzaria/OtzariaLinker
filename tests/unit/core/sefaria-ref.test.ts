import { describe, expect, it } from "vitest";
import { sefariaRefFromHeRef } from "../../../src/core/links/sefaria-ref";
import { embeddedSefariaTitles, isSefariaOwned, parseSefariaTitles } from "../../../src/core/links/sefaria-titles";

/*
 * Compatibility review B1/B6. Real pairs: each line is (DB heRef of the target line in seforim.db
 * db_version 37, the ref_2 the library record carries) — Otzaria/otzaria-library @aa2c293b:
 * MoreBooks/links/סידור אשכנז_links.json, BeitAharonVeYisraelToOtzaria/links/מקל יעקב_links.json,
 * DictaToOtzaria/ערוך/links/אבן העוזר על זבים_links.json,
 * MoreBooks/links/תיקונים מזוהר חדש - דפוס וילנא_links.json; Rashi/Tosafot from the research sample.
 */
const REAL: readonly [heRef: string, ref: string][] = [
  ["משנה ברורה,  נו, ב", "Mishnah Berurah,  56:2"],
  ["שולחן ערוך, חושן משפט, מט, ו", "Shulchan Arukh, Choshen Mishpat 49:6"],
  ["משנה תורה, הלכות תפילה וברכת כהנים, ז, ג", "Mishneh Torah, Prayer and the Priestly Blessing 7:3"],
  ["בראשית, יג, יז", "Genesis 13:17"],
  ["תהילים, ק, א", "Psalms 100:1"],
  ["משנה זבים, ד, ו", "Mishnah Zavim 4:6"],
  ["זוהר חדש, תקונים מזהר חדש,  א", "Zohar Chadash, Tikkunim Mizohar Chadash,  1"],
  ["ברכות, ח., א", "Berakhot 8a:1"],
  ["בבא מציעא, קי:, יז", "Bava Metzia 110b:17"],
  ["תוספות על ביצה, ח:, ח, א", "Tosafot on Beitzah 8b:8:1"],
  ['רש"י על בבא מציעא, מח:, ה, ב', "Rashi on Bava Metzia 48b:5:2"],
];

describe("ref_2 built from the database heRef (B1)", () => {
  for (const [he, ref] of REAL) it(`${he} → ${ref}`, () => expect(sefariaRefFromHeRef(he)).toBe(ref));

  it("never guesses: an unknown prefix, a non-numeral address or no heRef give null", () => {
    expect(sefariaRefFromHeRef("ספר שאינו בטבלה, א, ב")).toBeNull();
    expect(sefariaRefFromHeRef("בראשית, הקדמה")).toBeNull();
    expect(sefariaRefFromHeRef("בראשית")).toBeNull();
    expect(sefariaRefFromHeRef(null)).toBeNull();
  });
});

describe("Sefaria-owned as the library decides it (B6)", () => {
  it("the embedded snapshot classifies by exact title", () => {
    const list = embeddedSefariaTitles();
    expect(list.titles.size).toBeGreaterThan(6000);
    expect(isSefariaOwned({ title: "משנה ברורה" })).toBe(true);
    // a Sefaria-sourced book of the database that the library's list does not hold: ref_2 is forbidden there
    expect(isSefariaOwned({ title: "לכה דודי" })).toBe(false);
    expect(isSefariaOwned({ title: "ארצות החיים" })).toBe(false);
  });

  it("a list the user opens is read like the gate reads it, and replaces the embedded one", () => {
    const opened = parseSefariaTitles("# comment\n\nלכה דודי\r\nמשנה ברורה\n", "x")!;
    expect([...opened.titles]).toEqual(["לכה דודי", "משנה ברורה"]);
    expect(isSefariaOwned({ title: "לכה דודי" }, opened)).toBe(true);
    expect(parseSefariaTitles("# only comments\n", "x")).toBeNull();
  });
});
