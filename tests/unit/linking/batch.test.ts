import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../src/core/links/model";
import type { Suggestion } from "../../../src/linking/automatic/types";
import { capUndecided, pairByTitle, pairOne, titleIndex } from "../../../src/linking/batch";

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

/*
 * V7 §2.8, #41 B4: the batch path picked the official "ברכות" over a personal copy of the same title silently — no note, and what it
 * found could be approved in bulk, while the max-link path caps such a step ("ambiguousBase"). One rule now decides for every path:
 * a choice made only by origin (or by the dependant's own source) is a provisional default, named in the note with every edition,
 * and flagged `undecided` until the user chooses the source; an explicit choice (index.prefer) is kept and decides.
 */
describe("pairByTitle — several editions of the base (V7 §2.8, #41 B4)", () => {
  const official = ref("s1:103", "ברכות", "otzaria");
  const personal = ref("s2:9386", "ברכות", "personal");
  const comm = ref("s3:1", "ספר נר על ברכות", "personal");

  it("the official book chosen by origin only: a note that names every edition, and the pair is undecided", () => {
    const [p] = pairByTitle([comm], [official, personal]);
    expect(p!.target?.key).toBe("s1:103");
    expect(p!.note).toBeDefined();
    expect(p!.note).toContain("ספר אישי");
    expect(p!.note).toContain("אפשרית");
    expect(p!.undecided?.map((b) => b.key)).toEqual(["s2:9386"]);
  });

  it("the dependant's own source is a rule too, not evidence", () => {
    const own = ref("s2:7839", "ספר נר על ברכות", "personal");
    const [p] = pairByTitle([own], [official, personal]);
    expect(p!.target?.key).toBe("s2:9386");
    expect(p!.note).toContain("מאותו מקור");
    expect(p!.undecided?.map((b) => b.key)).toEqual(["s1:103"]);
  });

  it("the source the user chose decides: no flag", () => {
    const index = titleIndex([official, personal], "s2");
    const p = pairOne(comm, index);
    expect(p.target?.key).toBe("s2:9386");
    expect(p.undecided).toBeUndefined();
  });

  it("an edition under an equivalent title (personal 'מסכת ברכות') is an edition too", () => {
    const [p] = pairByTitle([comm], [official, ref("s2:1", "מסכת ברכות", "personal")]);
    expect(p!.target?.key).toBe("s1:103");
    expect(p!.undecided?.map((b) => b.key)).toEqual(["s2:1"]);
  });

  it("one book of the title: decided, no note", () => {
    const [p] = pairByTitle([comm], [official]);
    expect(p!.target?.key).toBe("s1:103");
    expect(p!.undecided).toBeUndefined();
    expect(p!.note).toBeUndefined();
  });

  it("a corpus the title names is evidence, not a rule: no flag", () => {
    const [p] = pairByTitle([ref("t:x", "תפארת ישראל על משנה ברכות")], [official, ref("s1:200", "משנה ברכות", "otzaria")]);
    expect(p!.target?.key).toBe("s1:200");
    expect(p!.undecided).toBeUndefined();
  });

  it("capUndecided lowers what the engine found to 'possible', each suggestion and the run say why", () => {
    const sg = (confidence: Suggestion["confidence"]) => ({ id: confidence, confidence, warnings: [] }) as unknown as Suggestion;
    const r = capUndecided({ suggestions: [sg("certain"), sg("high"), sg("possible"), sg("ambiguous")], notes: [], unmatched: [] }, "ברכות", "batch/undecided-base");
    expect(r.suggestions.map((s) => s.confidence)).toEqual(["possible", "possible", "possible", "ambiguous"]);
    expect(r.suggestions[0]!.warnings[0]!.code).toBe("batch/undecided-base");
    expect(r.notes[0]!.code).toBe("batch/undecided-base");
  });
});
