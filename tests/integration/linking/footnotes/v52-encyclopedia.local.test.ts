import { describe, expect, it } from "vitest";
import { headingLevel } from "../../../../src/core/text/html";
import { runFootnotesEngine } from "../../../../src/linking/automatic/footnotes";
import type { EngineBook } from "../../../../src/linking/automatic/types";
import { SourceRegistry } from "../../../../src/sources/registry";
import { fileBlob } from "../../../validation/env";

/*
 * #41 B12, issue #14, V7 §2.11 on the real books: אנציקלופדיה תלמודית in the personal database v52, whose notes books
 * ("הערות על אנציקלופדיה תלמודית אות X") write each note as "number, space, text". The finding: the automatic setting gave 0
 * suggestions; a manual "^(\d+)" gave 2,763 in volume 6 (אות ו). Runs only with the file (copyright-restricted, never copied into the
 * repo, opened read-only):
 *   OTZARIA_PERSONAL_DB=C:/Users/User/Documents/DEV/otzarya-unofficial-books-52.db npx vitest run tests/integration/linking/footnotes/v52-encyclopedia.local.test.ts
 * Printed per letter: suggestions of the automatic setting, of the manual regex, how many of the automatic ones the manual run also
 * makes (agreement), and the confidences.
 */
const path = process.env.OTZARIA_PERSONAL_DB;
const LETTERS = process.env.V52_LETTERS?.split(",") ?? ["ו", "א", "ג", "ז", "צ"];

describe.runIf(path)("אנציקלופדיה תלמודית in v52: notes that open with '12 ' (read-only)", () => {
  it("the automatic setting finds the notes the manual regex finds", async () => {
    const reg = new SourceRegistry();
    const res = await reg.open([{ path: "v52.db", blob: await fileBlob(path!) }]);
    const books = res.sources[0]!.books;
    const engineBook = async (title: string): Promise<EngineBook | null> => {
      const b = books.find((x) => x.title === title);
      if (!b) return null;
      const lines = await reg.lines(b.key, 0, b.lineCount ?? 1_000_000);
      return { book: { key: b.key, title: b.title, origin: b.origin }, lines: lines.map((l) => ({ index: l.index, text: l.anchorText ?? l.text, heading: headingLevel(l.text) })) };
    };
    let auto = 0;
    let manual = 0;
    let agree = 0;
    for (const letter of LETTERS) {
      const main = await engineBook(`אנציקלופדיה תלמודית אות ${letter}`);
      const notes = await engineBook(`הערות על אנציקלופדיה תלמודית אות ${letter}`);
      if (!main || !notes) continue;
      const a = runFootnotesEngine(main, notes);
      const m = runFootnotesEngine(main, notes, { notesMarkers: { regex: "^(\\d+)" } });
      const key = (s: { source: { line: number }; target: { line: number }; anchor?: { rawStart: number } }) => `${s.source.line}@${s.anchor?.rawStart}>${s.target.line}`;
      const manualKeys = new Set(m.suggestions.map(key));
      const same = a.suggestions.filter((s) => manualKeys.has(key(s))).length;
      const conf: Record<string, number> = {};
      for (const s of a.suggestions) conf[s.confidence] = (conf[s.confidence] ?? 0) + 1;
      console.log(`אות ${letter}: auto ${a.suggestions.length}, manual ^(\\d+) ${m.suggestions.length}, auto∩manual ${same}, confidences ${JSON.stringify(conf)}; notes: ${a.notes.map((n) => n.code).join(" ")}`);
      auto += a.suggestions.length;
      manual += m.suggestions.length;
      agree += same;
    }
    console.log(`TOTAL v52 encyclopedia (${LETTERS.join(",")}): auto ${auto}, manual ${manual}, auto∩manual ${agree}`);
    expect(auto).toBeGreaterThan(0);
  }, 1_800_000);
});
