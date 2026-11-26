import { describe, expect, it } from "vitest";
import { AliasIndex, citationGate, citationHintStrength } from "../../../../src/linking/automatic/citations";
import { LIB } from "./v7-fixture";

/*
 * The V7 round of the citations engine (spec §2.9, §2.10; issue #23; review findings #41 B6–B9, #42 C17–C21). Each block
 * reproduces one finding on skeleton books with the database's heRef shapes (v7-fixture.ts); no book text.
 */

const names = AliasIndex.build(LIB.catalog);
const knows = (k: string) => names.hasFirstWord(k);

describe("B6 — a book that cites only as 'ברכות יג:' opens the gate", () => {
  // the open book's name and a daf in letters with its amud mark glued on: an address with no place word (issue #23's first form)
  it.each(["ברכות יג:", "ברכות יג.", "(ברכות יג:)", "ועיין בברכות יג. ושם", "וכן וברכות כ\"ג: ועוד", "ברכות יג׃ ועוד"])("%s: strong", (t) => {
    expect(citationHintStrength(t, knows)).toBe("strong");
  });

  it.each(["ברכות יג ועוד", "הלך לברכות. ושם", "אמר ברכות רבות.", "ברכות יג:"])("%s: not strong (no amud mark, no numeral, or no open book)", (t) => {
    // the last one without the names of the open books: nothing says "ברכות" is a book
    expect(citationHintStrength(t, t === "ברכות יג:" ? undefined : knows)).not.toBe("strong");
  });

  it("a four-line book of such citations opens the book-level gate", () => {
    const g = citationGate(knows);
    const open = ["פתיחה לספר", "כמו שאמרו ברכות יג: ושם", "ועיין שבת לא. ושם", "ועוד בביצה יב: ושם"].map((l) => g.add(l));
    expect(open).toEqual([false, true, true, true]);
  });
});
