import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { SourceBook } from "../../../../src/core/books";
import { runDiburHamatchilEngine } from "../../../../src/linking/automatic/dibur-hamatchil";
import type { EngineBook, EngineResult, Suggestion } from "../../../../src/linking/automatic/types";
import { SourceRegistry } from "../../../../src/sources/registry";

/*
 * The verified engine errors of V7_MATCHING_BENCHMARK.md §7 that are a short ד"ה inside a LOCAL window (§7.1): fifteen lines of כף החיים
 * על שולחן ערוך יורה דעה, read in the text and judged against the database (the database right, the engine wrong). Each case is the
 * commentary line, the base line the engine chose, the line the database links, and the word(s) the line opens with — no book text.
 * Before §7.1 every one of them was "high" at the wrong line; now none is "certain" or "high" there. The control: ש"ך and ט"ז on the
 * same base, books that follow the base, keep their short ד"ה (no dh/short-unordered). Runs only with the real database, read-only:
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db npx vitest run tests/integration/linking/dibur-hamatchil/short-local.local.test.ts
 */
const path = process.env.OTZARIA_DB;
const BASE = "שולחן ערוך, יורה דעה";
const KAF = "כף החיים על שולחן ערוך יורה דעה";
/** [commentary line, the engine's wrong base line, the database's base line, the opening word(s)] — 0-based line indexes */
const CASES: readonly (readonly [number, number, number, string])[] = [
  [6318, 369, 370, "כבד"],
  [6320, 369, 370, "כבד"],
  [5231, 326, 328, "ואם"],
  [3193, 245, 246, "ואם"],
  [5285, 327, 328, "מראה"],
  [3973, 289, 292, "שם בהגה"],
  [6906, 410, 411, "שם הגה"],
  [7293, 437, 436, "וכן"],
  [3953, 289, 292, 'אע"ג'],
  [6694, 395, 394, "בהמה"],
  // five more of the same sample, judged again by the database's own structure: its links of כף החיים come in unbroken blocks of
  // consecutive notes per seif (5185–5295 → 328, 16170–16284 → 1090, 16520–16539 → 1097), and the engine's place is an island inside
  // such a block (V7_MATCHING_BENCHMARK.md §7)
  [5195, 326, 328, "ואם"],
  [5267, 326, 328, "ואם"],
  [16190, 1088, 1090, "סכנה"],
  [16274, 1088, 1090, "מים"],
  [16522, 1096, 1097, "מדברי"],
];

function fileBlob(fd: number, from = 0, to = fstatSync(fd).size): Blob {
  return {
    size: to - from,
    slice: (a = 0, b = to - from) => fileBlob(fd, from + a, from + Math.min(b, to - from)),
    async arrayBuffer() {
      const buf = new Uint8Array(to - from);
      const n = readSync(fd, buf, 0, buf.length, from);
      return buf.buffer.slice(0, n);
    },
  } as unknown as Blob;
}

describe.runIf(path)('a short ד"ה in a local window: the verified errors of כף החיים (V7 benchmark §7.1, read-only)', () => {
  let fd = -1;
  const results = new Map<string, { res: EngineResult; cKey: string }>();
  beforeAll(async () => {
    fd = openSync(path!, "r");
    const reg = new SourceRegistry();
    const opened = await reg.open([{ path: "seforim.db", blob: fileBlob(fd) }]);
    const books: SourceBook[] = opened.sources.flatMap((s) => s.books);
    const load = async (title: string): Promise<EngineBook> => {
      const b = books.find((x) => x.title === title)!;
      const lines = await reg.lines(b.key, 0, Number.MAX_SAFE_INTEGER);
      return { book: { key: b.key, title: b.title, origin: b.origin, ...(b.isBaseBook !== undefined && { isBaseBook: b.isBaseBook }) }, lines: lines.map((l) => ({ index: l.index, text: l.anchorText, heading: l.heading, heRef: l.heRef })) };
    };
    const base = await load(BASE);
    for (const t of [KAF, "שפתי כהן על שולחן ערוך יורה דעה", "טורי זהב על שולחן ערוך יורה דעה"]) {
      const c = await load(t);
      results.set(t, { res: runDiburHamatchilEngine(c, base), cKey: c.book.key });
    }
    closeSync(fd);
  }, 1_800_000);

  const ends = (s: Suggestion, cKey: string) => (s.source.book.key === cKey ? [s.source, s.target] : [s.target, s.source]);

  it('none of the fifteen is "certain" or "high" at the wrong line; each says why', () => {
    const { res, cKey } = results.get(KAF)!;
    const wrong: string[] = [];
    for (const [cLine, bad, , dh] of CASES) {
      const s = res.suggestions.find((x) => ends(x, cKey)[0]!.line === cLine);
      if (!s) continue; // not placed at all: not a wrong "high"
      const at = ends(s, cKey)[1]!.line;
      if (at === bad && (s.confidence === "certain" || s.confidence === "high")) wrong.push(`${cLine} "${dh}" → ${bad} ${s.confidence}`);
      else if (at === bad) expect(s.rules.some((r) => r === "dh/short-unordered" || r === "dh/short-backward"), `${cLine}`).toBe(true);
    }
    expect(wrong).toEqual([]);
    expect(res.notes.map((n) => n.code)).toContain("dh/short-unordered");
  });

  it("books that follow the base keep their short ד\"ה", () => {
    for (const t of ["שפתי כהן על שולחן ערוך יורה דעה", "טורי זהב על שולחן ערוך יורה דעה"]) {
      const { res } = results.get(t)!;
      expect(res.notes.map((n) => n.code), t).not.toContain("dh/short-unordered");
      expect(res.suggestions.filter((s) => s.rules.includes("dh/short-unordered")).length, t).toBe(0);
    }
  });
});
