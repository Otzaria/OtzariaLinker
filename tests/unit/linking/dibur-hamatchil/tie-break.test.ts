import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../../src/core/links/model";
import { headingLevel } from "../../../../src/core/text/html";
import { hebrewTokens } from "../../../../src/matching/hebrew-tokens";
import { runDiburHamatchilEngine, type DhOptions } from "../../../../src/linking/automatic/dibur-hamatchil";
import { CONTEXT_GAIN, contextScore, contextWords, lineKeys, pickByContext, pickByOrder, type TieCandidate } from "../../../../src/linking/automatic/dibur-hamatchil/tie-break";
import type { EngineBook, EngineResult, Suggestion } from "../../../../src/linking/automatic/types";

/*
 * Breaking a tie between places that score alike (tie-break.ts): the commentary line's own words after
 * its ד"ה, and the order of the strongly placed lines around it. A tie-break chooses among the tied
 * places only: the number of suggestions and their tier stay as they were.
 */
const ref = (key: string, title: string): BookRef => ({ key, title, origin: "otzaria", isBaseBook: false });
const book = (r: BookRef, texts: readonly string[]): EngineBook => ({ book: r, lines: texts.map((text, index) => ({ index, text, heading: headingLevel(text) })) });
const BASE = ref("txt:base", "ספר הבסיס");
const COMM = ref("txt:comm", "פירוש על ספר הבסיס");
const run = (comm: readonly string[], base: readonly string[], opts: DhOptions = {}): EngineResult => runDiburHamatchilEngine(book(COMM, comm), book(BASE, base), opts);
const commentaryLine = (s: Suggestion) => (s.source.book.key === COMM.key ? s.source.line : s.target.line);
const baseLine = (s: Suggestion) => (s.source.book.key === BASE.key ? s.source.line : s.target.line);
const byLine = (res: EngineResult, line: number) => res.suggestions.find((s) => commentaryLine(s) === line)!;
const tie = (line: number, score: number, context: number): TieCandidate => ({ line, score, context });

describe("contextWords: what the commentary line says after its ד\"ה", () => {
  const toks = hebrewTokens("אמן ב' אין עונין אמן יתומה של ברכות");
  const dh = toks.slice(0, 1);
  const ctx = contextWords(toks, 1, dh, () => 1);

  it("keeps distinct content words, not the ד\"ה's own words, stop words or short ones", () => {
    expect(ctx.map((w) => w.key)).toEqual(["עונינ", "יתומה", "ברכות"]);
  });

  it("weighs each word by the given weight", () => {
    expect(contextWords(toks, 1, dh, (k) => (k === "יתומה" ? 1.3 : 0.5)).map((w) => w.weight)).toEqual([0.5, 1.3, 0.5]);
  });

  it("reads at most `max` words after the ד\"ה", () => {
    expect(contextWords(toks, 1, dh, () => 1, 3).map((w) => w.key)).toEqual(["עונינ"]);
  });
});

describe("contextScore: the context words that stand in a base line", () => {
  const ctx = contextWords(hebrewTokens("X אין עונין אמן יתומה"), 1, [], () => 1);

  it("counts a word found as written", () => {
    expect(contextScore(lineKeys(hebrewTokens("אין עונים אמן יתומה")), ctx)).toBe(2); // אמן, יתומה (עונין ≠ עונים, אין is a stop word)
  });

  it("counts a word found in another spelling of its stem (loose form)", () => {
    expect(contextScore(lineKeys(hebrewTokens("ויתומה")), ctx)).toBe(1);
  });

  it("a line with none of the words scores 0", () => {
    expect(contextScore(lineKeys(hebrewTokens("האומנין קורין בראש האילן")), ctx)).toBe(0);
  });
});

describe("pickByContext", () => {
  it("keeps the current pick when no rival has clearly more context", () => {
    expect(pickByContext([tie(10, 0.8, 1), tie(12, 0.8, 1.5)], null, 0.6)).toBe(0);
    expect(pickByContext([tie(10, 0.8, 0), tie(12, 0.8, 0)], null, 0.6)).toBe(0);
  });

  it("moves to the rival whose line holds the commentary's words, by at least the gain", () => {
    expect(pickByContext([tie(10, 0.8, 0.5), tie(12, 0.8, 2.6)], null, 0.6)).toBe(1);
    expect(pickByContext([tie(10, 0.8, 1), tie(12, 0.8, 1 + CONTEXT_GAIN)], null, 0.6)).toBe(1);
    expect(pickByContext([tie(10, 0.8, 1), tie(12, 0.8, 0.99 + CONTEXT_GAIN)], null, 0.6)).toBe(0);
  });

  it("the gain is over the next best place, not only over the current pick", () => {
    expect(pickByContext([tie(10, 0.8, 0), tie(12, 0.8, 2.6), tie(14, 0.8, 2.2)], null, 0.6)).toBe(0);
  });

  it("never moves before the previous line's place, nor to a place scored below the bar", () => {
    expect(pickByContext([tie(10, 0.8, 0), tie(8, 0.8, 3)], 9, 0.6)).toBe(0);
    expect(pickByContext([tie(10, 0.8, 0), tie(12, 0.58, 3)], null, 0.6)).toBe(0);
  });
});

describe("pickByOrder", () => {
  it("keeps a pick between the strong lines before and after", () => {
    expect(pickByOrder([tie(5, 0.8, 0), tie(9, 0.8, 0)], 0, 3, 6, 0.6)).toBe(0);
    expect(pickByOrder([tie(5, 0.8, 0), tie(9, 0.8, 0)], 0, null, null, 0.6)).toBe(0);
  });

  it("moves a pick past the next strong line back between them", () => {
    expect(pickByOrder([tie(5, 0.8, 0), tie(9, 0.8, 3)], 1, 3, 6, 0.6)).toBe(0);
  });

  it("among several that fit: the most context, then the best score, then the earliest", () => {
    expect(pickByOrder([tie(20, 0.8, 0), tie(5, 0.8, 0), tie(4, 0.8, 1), tie(6, 0.82, 0)], 0, 3, 10, 0.6)).toBe(2);
    expect(pickByOrder([tie(20, 0.8, 0), tie(5, 0.8, 0), tie(6, 0.82, 0)], 0, 3, 10, 0.6)).toBe(2);
    expect(pickByOrder([tie(20, 0.8, 0), tie(6, 0.8, 0), tie(5, 0.8, 0)], 0, 3, 10, 0.6)).toBe(2);
  });

  it("keeps the pick when no tied place fits either, or the one that fits is below the bar", () => {
    expect(pickByOrder([tie(9, 0.8, 0), tie(12, 0.8, 0)], 0, 3, 6, 0.6)).toBe(0);
    expect(pickByOrder([tie(9, 0.8, 0), tie(5, 0.5, 0)], 0, 3, 6, 0.6)).toBe(0);
  });
});

describe("the engine: a tie broken by the commentary's own words", () => {
  // a lexicon: one headword opens three entries; the commentary names the second ("ב'") and quotes it
  // (with other entries around them, so that the words of one entry are rare in the book, as in a real one)
  const filler = Array.from({ length: 40 }, (_, i) => `<b>ערך${"אבגדהוזחטיכלמנסעפצקרשת"[i % 22]}</b> דבר אחר בפני עצמו מספר ${i}`);
  const base = [
    "<h2>אות א</h2>",
    "<b>אמן</b> האומנין קורין בראש האילן ולא יעשה עמו באומן",
    "<b>אמן</b> אין עונים אמן יתומה ופריק הא דתניא",
    "<b>אמן</b> ונותנין פיאה מכל אומן ואומן",
    ...filler,
  ];
  const comm = ["<h2>אות א</h2>", "<b>אמן</b> ב' אין עונין אמן יתומה ופריק בברכות. קשיא ליה לרבינו"];
  const res = run(comm, base);
  const s = byLine(res, 1);

  it("chooses the entry whose text the commentary quotes, and stays ambiguous", () => {
    expect(baseLine(s)).toBe(2);
    expect(s.confidence).toBe("ambiguous");
    expect(s.rules).toContain("dh/tie-context");
    expect(s.reasons.map((r) => r.code)).toContain("dh/tie-context");
  });

  it("each alternative says why it lost", () => {
    expect(s.alternatives.map((a) => a.target.line).sort()).toEqual([1, 3]);
    for (const a of s.alternatives) expect(a.reasons.map((r) => r.code)).toEqual(["dh/alternative", "dh/alt-context"]);
  });

  it("does not add or drop a suggestion", () => {
    expect(res.suggestions).toHaveLength(1);
    expect(res.unmatched).toEqual([]);
  });

  it("without context words the old order decides, and the alternatives say so", () => {
    const plain = byLine(run(["<h2>אות א</h2>", "<b>אמן</b> פירוש"], base), 1);
    expect(baseLine(plain)).toBe(1);
    expect(plain.rules).not.toContain("dh/tie-context");
    expect(plain.alternatives[0]!.reasons.map((r) => r.code)).toEqual(["dh/alternative", "dh/alt-tie"]);
  });

  it("an untied suggestion names its alternatives as weaker matches", () => {
    const r = run(["<b>ויאמר משה אל העם הזה היום.</b> פירוש"], ["ויאמר משה אל העם הזה היום", "ויאמר משה בבקר"]);
    const one = r.suggestions[0]!;
    expect(one.confidence).not.toBe("ambiguous");
    for (const a of one.alternatives) expect(a.reasons.map((x) => x.code)).toEqual(["dh/alternative", "dh/alt-weaker"]);
  });
});

describe("the engine: a context pick past the next strong line goes back between its neighbours", () => {
  const filler = Array.from({ length: 40 }, (_, i) => `<b>ערך${"אבגדהוזחטיכלמנסעפצקרשת"[i % 22]}</b> דבר אחר בפני עצמו מספר ${i}`);
  const base = [
    "<h2>אות א</h2>",
    "<b>אמן</b> האומנין קורין בראש האילן",
    "<b>אמן</b> ונותנין פיאה מכל אומן",
    "<b>נגר</b> ויבא הנגר הגדול אל המקדש בשחר",
    "<b>אמן</b> אין עונים אמן יתומה ופריק הא דתניא",
    ...filler,
  ];
  // the first line's words stand in line 4, but the next line is placed, certainly, on line 3
  const comm = ["<h2>אות א</h2>", "<b>אמן</b> אין עונין אמן יתומה ופריק בברכות", "<b>ויבא הנגר הגדול אל המקדש בשחר.</b> פירוש"];
  const res = run(comm, base);

  it("the line stays ambiguous, between the strong lines, and says why", () => {
    const next = byLine(res, 2);
    expect(baseLine(next)).toBe(3);
    expect(["certain", "high"]).toContain(next.confidence);
    const s = byLine(res, 1);
    expect(baseLine(s)).toBeLessThanOrEqual(3);
    expect(s.confidence).toBe("ambiguous");
    expect(s.rules).toContain("dh/tie-order");
    expect(s.alternatives.find((a) => a.target.line === 4)!.reasons.map((r) => r.code)).toEqual(["dh/alternative", "dh/alt-order"]);
    expect(res.suggestions).toHaveLength(2);
  });

  it("a moved place is 'ambiguous', so the short-ד\"ה cap (it reads only 'high') never sees it (V7 round 2 review, finding 10)", () => {
    // the place moved by the order pass; its SHORT_LOCAL facts now follow the new place, but they are not read: the cap is for "high"
    const s = byLine(res, 1);
    expect(s.rules).toContain("dh/tie-order");
    expect(s.confidence).toBe("ambiguous");
    expect(s.rules.filter((r) => r.startsWith("dh/short-"))).toEqual([]);
  });

  it("with the order pass off, the context pick stands", () => {
    expect(baseLine(byLine(run(comm, base, { order: false }), 1))).toBe(4);
  });
});
