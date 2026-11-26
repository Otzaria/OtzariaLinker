import { describe, expect, it } from "vitest";
import { toGematria } from "../../../../src/core/text/gematria";
import { headingLevel } from "../../../../src/core/text/html";
import { runHeadingsEngine } from "../../../../src/linking/automatic/headings";
import { RANGE_WIDTH } from "../../../../src/linking/automatic/headings/consistency";
import type { EngineBook } from "../../../../src/linking/automatic/types";

/*
 * #42 C15: a headings link to a WIDE range was "high" or "certain" by the alignment alone. Measured on the official database
 * (V7_MATCHING_BENCHMARK.md §4): "high" headings ranges averaged 52.8 lines, up to 20 records per commentary line on a Sefaria
 * base (one per line of the span). The heading says the line is about the whole amud or siman — right, but not a place one approves
 * in bulk. Reproduced here as a tractate whose amudim have no deeper headings (מאירי, רשב"א, חתם סופר on the Talmud: the whole amud).
 */
function book(key: string, title: string, lines: readonly string[]): EngineBook {
  return { book: { key, title, origin: "otzaria" }, lines: lines.map((text, index) => ({ index, text, heading: headingLevel(text), heRef: null })) };
}

/** a tractate: "דף N." / "דף N:" for N from 2, each amud `width(amud)` plain lines */
function tractate(amudim: number, width: (a: number) => number): EngineBook {
  const lines = ["<h1>מסכת</h1>"];
  for (let a = 0; a < amudim; a++) {
    lines.push(`<h2>דף ${toGematria(2 + Math.floor(a / 2))}${a % 2 ? ":" : "."}</h2>`);
    for (let i = 0; i < width(a); i++) lines.push(`גמרא דף ${toGematria(2 + Math.floor(a / 2))} שורה ${toGematria(i + 1)} כאן הלאה`);
  }
  return book("b:t", "מסכת", lines);
}
/** a commentary with one line on every amud */
function onEveryAmud(amudim: number): EngineBook {
  const lines = ["<h1>חידושים על מסכת</h1>"];
  for (let a = 0; a < amudim; a++) lines.push(`<h2>דף ${toGematria(2 + Math.floor(a / 2))}${a % 2 ? ":" : "."}</h2>`, `פירוש על הדף הזה ${toGematria(a + 1)} כאן`);
  return book("c:t", "חידושים על מסכת", lines);
}
const widthOf = (s: { target: { line: number; end?: number } }) => (s.target.end ?? s.target.line) - s.target.line + 1;

describe("headings — the confidence of a link is capped by the width of its range (#42 C15)", () => {
  it(`a range wider than ${RANGE_WIDTH.highMax} lines is "possible" at most; up to ${RANGE_WIDTH.highMax} "high" at most; up to ${RANGE_WIDTH.certainMax} as before`, () => {
    const widths = [3, 12, 30, 60];
    const r = runHeadingsEngine(onEveryAmud(8), tractate(8, (a) => widths[a % widths.length]!));
    expect(r.suggestions).toHaveLength(8);
    for (const s of r.suggestions) {
      const w = widthOf(s);
      if (w > RANGE_WIDTH.highMax) expect(s.confidence, `width ${w}`).toBe("possible");
      else if (w > RANGE_WIDTH.certainMax) expect(s.confidence, `width ${w}`).toBe("high");
      else expect(s.confidence, `width ${w}`).toBe("certain");
    }
  });

  it("says why, with the width, and keeps the range: the line is about the whole unit", () => {
    const r = runHeadingsEngine(onEveryAmud(2), tractate(2, () => 40));
    for (const s of r.suggestions) {
      expect(widthOf(s)).toBe(40); // the amud's 40 lines
      expect(s.rules).toContain("headings.wide-range");
      const w = s.warnings.find((x) => x.code === "heading/wide-range")!;
      expect(w.text).toContain("40 שורות");
    }
  });
});
