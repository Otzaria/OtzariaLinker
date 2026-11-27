import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { OtzariaDbReader } from "../../../../src/database/otzaria/reader";
import { bytesSource } from "../../../../src/database/sqlite/lazy/byte-source";
import { runDiburHamatchilEngine } from "../../../../src/linking/automatic/dibur-hamatchil";
import { evidenceCap } from "../../../../src/linking/automatic/dibur-hamatchil/confidence";
import type { EngineBook, EngineResult, Suggestion } from "../../../../src/linking/automatic/types";

/*
 * #41 B2 and #42 C9 on REAL data: רש"י על בראשית against the בראשית slice of tests/fixtures/db/seforim-v7-mini.db. The fixture
 * holds the רש"י lines WITHOUT their headings, so every line is searched in the whole base (dh/window-book) — the case of the
 * findings. Measured on the official database (V7_MATCHING_BENCHMARK.md): a one-word ד"ה found that way was "high" 52 times
 * right and 21 wrong; a phrase of three words that also stands elsewhere in the base, 19 right and 4 wrong.
 */
const BYTES = new Uint8Array(readFileSync("tests/fixtures/db/seforim-v7-mini.db"));
let res: EngineResult;
let rashi: EngineBook;
let base: EngineBook;

const norm = (t: string) => t.replace(/<[^>]+>/g, " ").replace(/[֑-ׇ]/g, "").replace(/[^א-ת\s]/g, " ").replace(/\s+/g, " ").trim();
/** the words of the commentary line the ד"ה matched, and the words of the base line they matched */
const quoted = (s: Suggestion) => {
  const c = rashi.lines.find((l) => l.index === s.source.line)!.text;
  const b = base.lines.find((l) => l.index === s.target.line)!.text;
  const m = s.matched!;
  return { words: norm(c.slice(m.source!.rawStart, m.source!.rawEnd)).split(" ").length, phrase: norm(b.slice(m.target!.rawStart, m.target!.rawEnd)) };
};
/** base lines that hold the phrase as whole words */
const times = (phrase: string) => base.lines.filter((l) => ` ${norm(l.text)} `.includes(` ${phrase} `)).length;

beforeAll(async () => {
  const r = await OtzariaDbReader.open(bytesSource(BYTES));
  const books = await r.books();
  const load = async (id: number): Promise<EngineBook> => {
    const b = books.find((x) => x.id === id)!;
    return {
      book: { key: `db:${id}`, title: b.title, origin: b.source === "Sefaria" ? "sefaria" : "otzaria", isBaseBook: b.isBaseBook ?? undefined },
      lines: (await r.lines(id)).map((l) => ({ index: l.index, text: r.anchorText(l), heading: /^<h[1-6]/i.test(l.content) ? Number(l.content[2]) : null, heRef: l.heRef })),
    };
  };
  base = await load(1);
  rashi = await load(3695);
  res = runDiburHamatchilEngine(rashi, base);
});

describe('ד"ה found in the whole base: a word or two, or a phrase that repeats, is not "high" evidence (#41 B2, #42 C9)', () => {
  it("the fixture is the case of the findings: every line is searched in the whole base", () => {
    expect(res.suggestions.length).toBeGreaterThan(150);
    expect(res.suggestions.every((s) => s.rules.includes("dh/window-book") || !s.rules.some((x) => x.startsWith("dh/window-")))).toBe(true);
  });

  it('a one-word ד"ה found in the whole base is at most "possible", and says why', () => {
    const one = res.suggestions.filter((s) => s.matched?.source && s.matched.target && s.rules.includes("dh/window-book") && quoted(s).words === 1);
    expect(one.length).toBeGreaterThan(20);
    for (const s of one) expect(["possible", "ambiguous"], `${s.id} ${s.confidence}`).toContain(s.confidence);
    const capped = one.filter((s) => s.rules.includes("dh/short-whole-book"));
    expect(capped.length).toBeGreaterThan(20);
    for (const s of capped) expect(s.warnings.find((w) => w.code === "dh/short-whole-book")!.text).toMatch(/בכל ספר הבסיס/);
  });

  it('a phrase that stands in other lines of the base is never "certain", and the other lines are its alternatives', () => {
    const repeated = res.suggestions.filter((s) => s.matched?.source && s.matched.target && s.rules.includes("dh/window-book") && times(quoted(s).phrase) > 1);
    expect(repeated.length).toBeGreaterThan(3);
    for (const s of repeated) {
      expect(s.confidence, s.id).not.toBe("certain");
    }
    const flagged = res.suggestions.filter((s) => s.rules.includes("dh/repeated-phrase"));
    expect(flagged.length).toBeGreaterThan(0);
    for (const s of flagged) expect(s.alternatives.some((a) => a.reasons.some((r) => r.code === "dh/alt-repeat")), s.id).toBe(true);
  });

  it("a longer phrase found once keeps its confidence: the caps take nothing the evidence supports", () => {
    const strong = res.suggestions.filter((s) => s.matched?.source && s.matched.target && quoted(s).words >= 4 && times(quoted(s).phrase) === 1);
    expect(strong.some((s) => s.confidence === "certain")).toBe(true);
    expect(strong.every((s) => !s.rules.includes("dh/short-whole-book") && !s.rules.includes("dh/repeated-phrase"))).toBe(true);
  });
});

describe("evidenceCap (the rule itself)", () => {
  it("whole base: one word → possible; two words, or a phrase that repeats → never certain; a heading's window → nothing", () => {
    expect(evidenceCap({ words: 1, wholeBook: true, repeats: 0 })).toEqual({ cap: "possible", rule: "dh/short-whole-book" });
    expect(evidenceCap({ words: 1, wholeBook: true, repeats: 2 })).toEqual({ cap: "possible", rule: "dh/short-whole-book" });
    expect(evidenceCap({ words: 2, wholeBook: true, repeats: 0 })).toEqual({ cap: "high", rule: "dh/short-whole-book" });
    expect(evidenceCap({ words: 3, wholeBook: true, repeats: 1 })).toEqual({ cap: "high", rule: "dh/repeated-phrase" });
    expect(evidenceCap({ words: 6, wholeBook: true, repeats: 1 })).toEqual({ cap: "high", rule: "dh/repeated-phrase" });
    expect(evidenceCap({ words: 4, wholeBook: true, repeats: 0 })).toBeNull();
    // a heading narrowed the search: the rivals are near, and the search meets them
    expect(evidenceCap({ words: 1, wholeBook: false, repeats: 0 })).toBeNull();
    expect(evidenceCap({ words: 3, wholeBook: false, repeats: 2 })).toBeNull();
  });
});
