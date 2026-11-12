import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../src/core/links/model";
import { pairByTitle } from "../../../src/linking/batch";

const ref = (key: string, title: string, origin: BookRef["origin"] = "otzaria"): BookRef => ({ key, title, origin });

describe("pairByTitle", () => {
  const bases = [ref("d:1", "בראשית", "sefaria"), ref("d:2", "ברכות", "sefaria"), ref("p:9", "ברכות", "personal"), ref("d:3", "שמות"), ref("d:4", "שמות")];
  const pairs = pairByTitle(
    [ref("t:a", 'רש"י על בראשית'), ref("t:b", "תוספות על מסכת ברכות"), ref("t:c", "חידושים"), ref("t:d", "פירוש על ויקרא"), ref("t:e", "פירוש על שמות")],
    bases,
  );

  it("pairs by the declared base, ignoring quote marks and prefixes like מסכת", () => {
    expect(pairs[0]!.target?.key).toBe("d:1");
    expect(pairs[1]!.target?.key).toBe("d:2"); // the official book wins over the personal copy
  });

  it("explains every book it does not pair, and never guesses between equals", () => {
    expect(pairs.slice(2).map((p) => p.target)).toEqual([null, null, null]);
    expect(pairs[2]!.reason).toContain("על");
    expect(pairs[3]!.reason).toContain("ויקרא");
    expect(pairs[4]!.reason).toContain("2");
  });
});

describe("pairByTitle — books that share a base key (LIBRARY_BENCHMARK.md §6.1)", () => {
  const talmud = [ref("d:1", "ברכות", "sefaria"), ref("d:2", "משנה ברכות", "sefaria"), ref("d:3", "תלמוד ירושלמי ברכות", "sefaria")];
  const one = (title: string, bases = talmud) => pairByTitle([ref("t:x", title)], bases)[0]!;

  it("a bare tractate name is the Bavli; the corpus the title names wins otherwise", () => {
    expect(one("חברותא על ברכות").target?.key).toBe("d:1");
    expect(one("ראשון לציון על מסכת ברכות").target?.key).toBe("d:1");
    expect(one("תפארת ישראל על משנה ברכות").target?.key).toBe("d:2");
    expect(one("פני משה על תלמוד ירושלמי ברכות").target?.key).toBe("d:3");
    expect(one("פני משה על ירושלמי ברכות").target?.key).toBe("d:3");
  });

  it("says how the name was resolved", () => {
    expect(one("חברותא על ברכות").note).toContain("3 ספרים");
    expect(one("פני משה על ירושלמי ברכות").note).toContain("ירושלמי");
  });

  it("still refuses two books of the same corpus", () => {
    const p = one("חברותא על ברכות", [...talmud, ref("d:4", "ברכות", "sefaria")]);
    expect(p.target).toBeNull();
    expect(p.reason).toContain("2");
  });

  it("matches another spelling of the base only when the exact name finds nothing", () => {
    const sa = [ref("d:5", "שולחן ערוך, אורח חיים", "sefaria"), ref("d:6", "שולחן ערוך, יורה דעה", "sefaria")];
    expect(one("לבושי שרד על שלחן ערוך אורח חיים", sa).target?.key).toBe("d:5");
    expect(one("לבושי שרד על שלחן ערוך אורח חיים", sa).note).toContain("כתיב");
    expect(one("אוצר ההלכה על שולחן ערוך אורח חיים חלק ו", sa).target?.key).toBe("d:5");
    expect(one("ביאור על שולחן ערוך חושן משפט", sa).target).toBeNull();
  });
});
