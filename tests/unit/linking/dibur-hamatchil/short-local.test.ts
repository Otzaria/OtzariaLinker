import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../../src/core/links/model";
import { headingLevel } from "../../../../src/core/text/html";
import { toGematria } from "../../../../src/core/text/gematria";
import { runDiburHamatchilEngine } from "../../../../src/linking/automatic/dibur-hamatchil";
import { SHORT_LOCAL, shortLocalCap, unorderedShare } from "../../../../src/linking/automatic/dibur-hamatchil/confidence";
import type { EngineBook, EngineResult, Suggestion } from "../../../../src/linking/automatic/types";

/*
 * A ד"ה of one to three words inside a LOCAL window (the section a heading of the commentary names) — the case the B2 cap of the
 * whole-base search does not cover (V7_MATCHING_BENCHMARK.md §7, §7.1). The verified engine errors were such words in כף החיים
 * ("ואם", "כבד", "שם בהגה"): a word the commentary opens a note with, not a quote, placed by the walk's order. Two rules, both only
 * at "high" and only in a local window:
 *   - found BEFORE the previous line's place (dh/backward): "possible" (dh/short-backward);
 *   - in a commentary that does not follow the base's order (at least SHORT_LOCAL.minPlaced placements in local windows, and at least
 *     SHORT_LOCAL.unorderedShare of them backward), a ד"ה of one or two words: "possible" (dh/short-unordered), with a note.
 * The books here are built from invented words (one unique word per base line), so each case is exactly the one named.
 */
const ref = (key: string, title: string): BookRef => ({ key, title, origin: "otzaria", isBaseBook: false });
const BASE = ref("txt:base", "ספר הבסיס");
const COMM = ref("txt:comm", "פירוש על ספר הבסיס");
const book = (r: BookRef, texts: readonly string[]): EngineBook => ({ book: r, lines: texts.map((text, index) => ({ index, text, heading: headingLevel(text) })) });

/** an invented word, unique per (section, line): letters that spell no common word */
const LETTERS = "בגדזטכלמנסעפצקרש";
const word = (s: number, l: number) => `${LETTERS[s % 16]}${LETTERS[(s >> 4) % 16]}ו${LETTERS[l % 16]}${LETTERS[(l >> 4) % 16]}ת`;
/** a base section: lines "(א) <unique word> and three more unique words" */
const baseSection = (s: number, n: number) => [`<h2>סימן ${toGematria(s + 1)}</h2>`, ...Array.from({ length: n }, (_, l) => `(${toGematria(l + 1)}) ${word(s, l)} ${word(s, l + 20)} ${word(s, l + 40)} ${word(s, l + 60)} סוף`)];
/** a commentary line quoting base line l of section s: one word, or four (more than the three a backward cap counts) */
const quote = (s: number, l: number, words: 1 | 4) => (words === 1 ? `<b>${word(s, l)}</b> פירוש` : `<b>${word(s, l)} ${word(s, l + 20)} ${word(s, l + 40)} ${word(s, l + 60)}</b> פירוש`);

const commentaryLine = (s: Suggestion) => (s.source.book.key === COMM.key ? s.source.line : s.target.line);
const baseLine = (s: Suggestion) => (s.source.book.key === BASE.key ? s.source.line : s.target.line);

/**
 * Sections of a commentary on a base of `sections` sections of 6 lines. `order` lists, per section, the base lines quoted and with how
 * many words. Returns the result and, per (section, index in order), the commentary line.
 */
function run(sections: number, order: readonly (readonly [number, 1 | 4])[]): { res: EngineResult; line: (s: number, k: number) => number } {
  const base = ["<h1>ספר הבסיס</h1>", ...Array.from({ length: sections }, (_, s) => baseSection(s, 6)).flat()];
  const comm = ["<h1>פירוש</h1>"];
  const at = new Map<string, number>();
  for (let s = 0; s < sections; s++) {
    comm.push(`<h2>סימן ${toGematria(s + 1)}</h2>`);
    order.forEach(([l, w], k) => {
      at.set(`${s}:${k}`, comm.length);
      comm.push(quote(s, l, w));
    });
  }
  return { res: runDiburHamatchilEngine(book(COMM, comm), book(BASE, base)), line: (s, k) => at.get(`${s}:${k}`)! };
}
const at = (res: EngineResult, line: number) => res.suggestions.find((s) => commentaryLine(s) === line);

describe('a short ד"ה in a local window (V7 §7.1): the rule itself', () => {
  it("only in a local window, only short ones; backward: up to three words; an unordered book: up to two", () => {
    expect(shortLocalCap({ words: 1, local: true, backward: true, unordered: false })).toEqual({ cap: "possible", rule: "dh/short-backward" });
    expect(shortLocalCap({ words: 3, local: true, backward: true, unordered: false })).toEqual({ cap: "possible", rule: "dh/short-backward" });
    expect(shortLocalCap({ words: 4, local: true, backward: true, unordered: false })).toBeNull();
    expect(shortLocalCap({ words: 2, local: true, backward: false, unordered: true })).toEqual({ cap: "possible", rule: "dh/short-unordered" });
    expect(shortLocalCap({ words: 3, local: true, backward: false, unordered: true })).toBeNull();
    expect(shortLocalCap({ words: 1, local: true, backward: false, unordered: false })).toBeNull();
    // the whole-base search has its own caps (evidenceCap, #41 B2)
    expect(shortLocalCap({ words: 1, local: false, backward: true, unordered: true })).toBeNull();
  });

  it("a book is unordered from SHORT_LOCAL.minPlaced placements and SHORT_LOCAL.unorderedShare of them backward", () => {
    expect(unorderedShare(SHORT_LOCAL.minPlaced - 1, SHORT_LOCAL.minPlaced - 1)).toBe(false);
    expect(unorderedShare(1000, Math.ceil(1000 * SHORT_LOCAL.unorderedShare))).toBe(true);
    expect(unorderedShare(1000, Math.floor(1000 * SHORT_LOCAL.unorderedShare) - 1)).toBe(false);
  });
});

describe('a short ד"ה in a local window (V7 §7.1): the engine', () => {
  // per section: a long quote of line 5, then one word of line 2 (BEFORE it), then long quotes of lines 3 and 4. The order pass keeps
  // 2, 3, 4 (the longest chain) and drops the quote of 5; the one word stays, found backward
  const jumping = run(1, [[5, 4], [2, 1], [3, 4], [4, 4]]);

  it("a word found before the previous line's place is \"possible\", and says why", () => {
    const s = at(jumping.res, jumping.line(0, 1))!;
    expect(s, "the one-word ד\"ה is placed").toBeDefined();
    expect(baseLine(s)).toBe(4); // "(ב)" of סימן א: line 1 is the heading
    expect(s.warnings.map((w) => w.code)).toContain("dh/backward");
    expect(s.confidence).toBe("possible");
    expect(s.rules).toContain("dh/short-backward");
    expect(s.warnings.find((w) => w.code === "dh/short-backward")!.text).toMatch(/לפני/);
  });

  it("a long quote found backward keeps its level: the words themselves place it", () => {
    const back = run(1, [[5, 4], [2, 4], [3, 4], [4, 4]]);
    const s = at(back.res, back.line(0, 1))!;
    expect(s.warnings.map((w) => w.code)).toContain("dh/backward");
    expect(["certain", "high"]).toContain(s.confidence);
    expect(s.rules).not.toContain("dh/short-backward");
  });

  // 20 sections, each [long 5, long 2, word 3, long 4]: every section opens with a jump back — a book that does not follow its base
  const unordered = run(20, [[5, 4], [2, 4], [3, 1], [4, 4]]);
  // the same quotes in the base's order
  const ordered = run(20, [[2, 4], [3, 1], [4, 4], [5, 4]]);

  it("in a book that keeps jumping back, a one-word ד\"ה found in order is \"possible\" too, and the run says why", () => {
    const words = Array.from({ length: 20 }, (_, s) => at(unordered.res, unordered.line(s, 2))!);
    expect(words.every((s) => s && !s.warnings.some((w) => w.code === "dh/backward"))).toBe(true);
    for (const s of words) {
      expect(s.confidence, s.id).toBe("possible");
      expect(s.rules).toContain("dh/short-unordered");
    }
    expect(unordered.res.notes.map((n) => n.code)).toContain("dh/short-unordered");
  });

  it("the same one-word quotes in a book that follows its base stay \"high\"", () => {
    const words = Array.from({ length: 20 }, (_, s) => at(ordered.res, ordered.line(s, 1))!);
    for (const s of words) {
      expect(s.confidence, s.id).toBe("high");
      expect(s.rules).not.toContain("dh/short-unordered");
    }
    expect(ordered.res.notes.map((n) => n.code)).not.toContain("dh/short-unordered");
  });
});
