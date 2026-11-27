import { appendFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { headingLevel } from "../../../../src/core/text/html";
import { runFootnotesEngine } from "../../../../src/linking/automatic/footnotes";
import type { EngineBook, Suggestion } from "../../../../src/linking/automatic/types";
import { SourceRegistry } from "../../../../src/sources/registry";
import { fileBlob } from "../../../validation/env";

/*
 * #41 B12, a QUALITY SAMPLE (docs/validation/V7_MATCHING_BENCHMARK.md §13): the footnote links the automatic setting now makes on
 * אנציקלופדיה תלמודית in the personal database v52 (all its letters: 504 → 362,308 suggestions). A count is not proof; this draws a fixed
 * sample and writes, for each drawn suggestion, what a reader needs to judge it: the words of the main line before its marker, the
 * marker, and the opening of the note it is linked to. The sample is by level (`B12_PER_LEVEL` per level, default 60): the suggestions
 * with the smallest FNV-1a hash of "<notes book title>|<suggestion id>" — fixed, so a rerun draws the same ones. The judgments
 * (right / wrong / undecidable) are made by reading, and recorded in the document; this test only draws and counts. The file is
 * copyright-restricted: the text goes to B12_SAMPLE_OUT (outside the repo), never into it. Read-only:
 *   OTZARIA_PERSONAL_DB=C:/Users/User/Documents/DEV/otzarya-unofficial-books-52.db B12_SAMPLE_OUT=<file.jsonl> \
 *     npx vitest run tests/integration/linking/footnotes/v52-encyclopedia-sample.local.test.ts
 */
const path = process.env.OTZARIA_PERSONAL_DB;
const OUT = process.env.B12_SAMPLE_OUT;
const PER_LEVEL = Number(process.env.B12_PER_LEVEL ?? 60);

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
const visible = (t: string) => t.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

describe.runIf(path && OUT)("אנציקלופדיה תלמודית in v52: a fixed sample of the automatic footnote links (read-only)", () => {
  it("draws the sample", async () => {
    const reg = new SourceRegistry();
    const res = await reg.open([{ path: "v52.db", blob: await fileBlob(path!) }]);
    const books = res.sources[0]!.books;
    const engineBook = async (title: string): Promise<EngineBook | null> => {
      const b = books.find((x) => x.title === title);
      if (!b) return null;
      const lines = await reg.lines(b.key, 0, b.lineCount ?? 1_000_000);
      return { book: { key: b.key, title: b.title, origin: b.origin }, lines: lines.map((l) => ({ index: l.index, text: l.anchorText ?? l.text, heading: headingLevel(l.text) })) };
    };
    const mains = books.map((b) => b.title).filter((t) => t.startsWith("אנציקלופדיה תלמודית אות ")).sort();
    type Drawn = { h: number; level: string; notesTitle: string; s: Suggestion; before: string; marker: string; note: string; noteLine: number; mainLine: number };
    const pool = new Map<string, Drawn[]>();
    const counts: Record<string, number> = {};
    let total = 0;
    for (const title of mains) {
      const main = await engineBook(title);
      const notesTitle = `הערות על ${title}`;
      const notes = await engineBook(notesTitle);
      if (!main || !notes) continue;
      const r = runFootnotesEngine(main, notes);
      const mainText = new Map(main.lines.map((l) => [l.index, l.text] as const));
      const noteText = new Map(notes.lines.map((l) => [l.index, l.text] as const));
      const per: Record<string, number> = {};
      for (const s of r.suggestions) {
        counts[s.confidence] = (counts[s.confidence] ?? 0) + 1;
        per[s.confidence] = (per[s.confidence] ?? 0) + 1;
        total++;
        const h = fnv1a(`${notesTitle}|${s.id}`);
        const list = pool.get(s.confidence) ?? pool.set(s.confidence, []).get(s.confidence)!;
        if (list.length >= PER_LEVEL && h >= list[list.length - 1]!.h) continue;
        // the main side holds the marker (the anchor); the other side is the note
        const [m, n] = s.source.book.key === main.book.key ? [s.source, s.target] : [s.target, s.source];
        const raw = mainText.get(m.line) ?? "";
        const at = s.anchor ? s.anchor.rawStart : raw.length;
        const end = s.anchor?.rawEnd ?? at;
        list.push({ h, level: s.confidence, notesTitle, s, before: visible(raw.slice(Math.max(0, at - 400), at)).slice(-180), marker: visible(raw.slice(at, end)), note: visible(noteText.get(n.line) ?? "").slice(0, 260), noteLine: n.line, mainLine: m.line });
        list.sort((a, b) => a.h - b.h);
        if (list.length > PER_LEVEL) list.pop();
      }
      console.log(`${title}: ${r.suggestions.length} ${JSON.stringify(per)}`);
    }
    writeFileSync(OUT!, "");
    for (const [level, list] of pool)
      for (const d of list)
        appendFileSync(OUT!, `${JSON.stringify({ level, hash: d.h, notes: d.notesTitle, id: d.s.id, mainLine: d.mainLine, noteLine: d.noteLine, rules: d.s.rules, before: d.before, marker: d.marker, note: d.note })}\n`);
    console.log(`TOTAL ${total} ${JSON.stringify(counts)}; drawn ${[...pool.values()].reduce((n, l) => n + l.length, 0)}`);
    expect(total).toBeGreaterThan(0);
  }, 3_600_000);
});
