import { describe, expect, it } from "vitest";
import { headingLevel } from "../../../src/core/text/html";
import { sectionFor, sectionNames } from "../../../src/linking/sections";
import type { EngineBook } from "../../../src/linking/automatic/types";

const book = (texts: readonly string[]): EngineBook => ({
  book: { key: "c", title: "חזקוני", origin: "otzaria" },
  lines: texts.map((text, index) => ({ index, text, heading: headingLevel(text) })),
});
const TORAH = book([
  "<h1>חזקוני</h1>", "<h2>הקדמה</h2>", "פתיחה",
  "<h2>בראשית</h2>", "<h3>פרק א</h3>", "בראשית ברא", "<h3>פרק ב</h3>", "ויכלו",
  "<h2>ספר שמות</h2>", "<h3>פרק א</h3>", "ואלה שמות",
]);

describe("sectionFor", () => {
  it("the lines under the heading that names the base, up to the next heading of its level; original line numbers kept", () => {
    const s = sectionFor(TORAH, "בראשית")!;
    expect(s.heading).toBe("בראשית");
    expect(s.book.lines.map((l) => l.index)).toEqual([4, 5, 6, 7]);
    expect(sectionFor(TORAH, "שמות")!.book.lines.map((l) => l.index)).toEqual([9, 10]); // "ספר " is ignored
  });

  it("a supercommentary's base 'X על Y' is found by Y", () => {
    expect(sectionNames('רש"י על בראשית')).toEqual(new Set(["רשי על בראשית", "בראשית"]));
    expect(sectionFor(TORAH, 'רש"י על בראשית')!.book.lines.length).toBe(4);
  });

  it("no heading names the base: null; the title heading never counts", () => {
    expect(sectionFor(TORAH, "ויקרא")).toBeNull();
    expect(sectionFor(TORAH, "חזקוני")).toBeNull();
  });

  it("the highest level wins: a part beats a parsha of the same name inside it", () => {
    const b = book(["<h1>ספר</h1>", "<h2>בראשית</h2>", "<h3>בראשית</h3>", "א", "<h3>נח</h3>", "ב", "<h2>שמות</h2>", "ג"]);
    expect(sectionFor(b, "בראשית")!.book.lines.map((l) => l.index)).toEqual([2, 3, 4, 5]);
  });

  it("a base that comes back later contributes every part", () => {
    const b = book(["<h1>ספר</h1>", "<h2>בראשית</h2>", "א", "<h2>שמות</h2>", "ב", "<h2>בראשית</h2>", "ג"]);
    expect(sectionFor(b, "בראשית")!.book.lines.map((l) => l.index)).toEqual([2, 6]);
  });
});
