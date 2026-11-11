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
