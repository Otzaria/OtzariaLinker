import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { diffLines, wordDiff } from "../../../src/matching/line-diff";

const book = Array.from({ length: 30 }, (_, i) => `שורה מספר ${i} עם תוכן ייחודי משלה בספר`);

describe("diffLines", () => {
  it("a line added at the top shifts every line by one, all certain", () => {
    const m = diffLines(book, ["שורה חדשה בראש הספר", ...book]);
    expect([...m.to]).toEqual(book.map((_, i) => i + 1));
    expect(m.stats).toMatchObject({ unique: 30, inserted: 1, deleted: 0 });
  });

  it("a deleted line maps nowhere; an edited line is 'changed', never 'same'", () => {
    const next = [...book];
    next.splice(5, 1);
    next[9] = next[9]!.replace("תוכן", "טקסט");
    const m = diffLines(book, next);
    expect(m.to[5]).toBe(-1);
    expect(m.fate[5]).toBe("deleted");
    expect(m.to[10]).toBe(9);
    expect(m.fate[10]).toBe("changed");
    expect(m.similarity[10]).toBeLessThan(1);
  });

  it("repeated lines (empty, headings repeated) are matched by order, not by guess", () => {
    const old = ["<h2>פרק א</h2>", "א", "<h2>פרק ב</h2>", "א"];
    const m = diffLines(old, ["הקדמה", ...old]);
    expect([...m.to]).toEqual([1, 2, 3, 4]);
  });

  it("property: the mapping is strictly increasing and never maps two old lines to one new line", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("א ב", "ג ד", "ה ו", "ז ח ט", ""), { maxLength: 40 }), fc.array(fc.constantFrom("א ב", "ג ד", "ה ו", "ז ח ט", "י"), { maxLength: 40 }), (a, b) => {
        const m = diffLines(a, b);
        const mapped = [...m.to].filter((j) => j >= 0);
        for (let k = 1; k < mapped.length; k++) expect(mapped[k]).toBeGreaterThan(mapped[k - 1]!);
      }),
    );
  });
});

describe("wordDiff", () => {
  it("marks only the words that changed, and the spans join back to the line", () => {
    const d = wordDiff("אמר רבי יוחנן משום רבי שמעון", "אמר רבי יוחנן בשם רבי שמעון");
    expect(d.old.filter((s) => s.changed).map((s) => s.text.trim())).toEqual(["משום"]);
    expect(d.new.filter((s) => s.changed).map((s) => s.text.trim())).toEqual(["בשם"]);
    expect(d.old.map((s) => s.text).join("")).toBe("אמר רבי יוחנן משום רבי שמעון");
    expect(d.new.map((s) => s.text).join("")).toBe("אמר רבי יוחנן בשם רבי שמעון");
  });

  it("a line too long to compare is shown whole as changed", () => {
    const long = Array.from({ length: 10 }, (_, i) => `מילה${i}`).join(" ");
    const d = wordDiff(long, long, 5);
    expect(d.old.every((s) => s.changed || !s.text.trim())).toBe(true);
  });

  it("property: the spans always join back to both lines", () => {
    const w = fc.constantFrom("א", "ב", "ג", " ", "  ");
    fc.assert(
      fc.property(fc.array(w, { maxLength: 30 }), fc.array(w, { maxLength: 30 }), (x, y) => {
        const a = x.join("");
        const b = y.join("");
        const d = wordDiff(a, b);
        expect(d.old.map((s) => s.text).join("")).toBe(a);
        expect(d.new.map((s) => s.text).join("")).toBe(b);
      }),
    );
  });
});
