import { describe, expect, it } from "vitest";
import { splitMatched } from "../../../src/ui/workspace/matched-words";

/*
 * Issue #11 (screen): the words the engine matched, cut out of a line for the card. Offsets are raw UTF-16 in the line
 * as stored (tags and entities included, AGENTS.md 2.4); the text shown is the visible text.
 */
describe("splitMatched", () => {
  const line = "<b>אלפא בטא גמא</b> – פירוש על הדברים האלה כאן";
  const span = { rawStart: 3, rawEnd: 3 + "אלפא בטא גמא".length };

  it("cuts the visible text into before, the matched words and after (tags are not text)", () => {
    expect(splitMatched(line, span)).toEqual({ before: "", match: "אלפא בטא גמא", after: " – פירוש על הדברים האלה כאן", clippedBefore: false, clippedAfter: false });
  });

  it("an entity is one visible character, so an offset after it still lands on the right words", () => {
    const l = "א&quot;ב גימל דלת הא";
    const start = l.indexOf("גימל");
    expect(splitMatched(l, { rawStart: start, rawEnd: start + 4 })).toMatchObject({ before: 'א"ב ', match: "גימל", after: " דלת הא" });
  });

  it("a long line is clipped to a window of words around the match, and says so", () => {
    const words = Array.from({ length: 80 }, (_, i) => `מילה${i}`);
    const l = words.join(" ");
    const start = l.indexOf("מילה40");
    const r = splitMatched(l, { rawStart: start, rawEnd: start + "מילה40 מילה41".length }, 10)!;
    expect(r.match).toBe("מילה40 מילה41");
    expect(r.clippedBefore && r.clippedAfter).toBe(true);
    expect(r.before.split(" ").filter(Boolean).length).toBeLessThanOrEqual(10);
    expect(r.after.split(" ").filter(Boolean).length).toBeLessThanOrEqual(10);
  });

  it("no span, an empty span, or one outside the line: nothing to mark", () => {
    expect(splitMatched(line, undefined)).toBeNull();
    expect(splitMatched(line, { rawStart: 5, rawEnd: 5 })).toBeNull();
    expect(splitMatched(line, { rawStart: 900, rawEnd: 990 })).toBeNull();
  });
});
