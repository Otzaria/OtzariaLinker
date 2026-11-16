import { countVisibleChars } from "../../../../src/core/text/offsets";
import { headingLevel } from "../../../../src/core/text/html";
import type { EngineBook, EngineLine, EngineResult } from "../../../../src/linking/automatic/types";
import type { DbLine } from "../../../../src/database/otzaria/reader";

/*
 * A real-data benchmark for the footnotes engine built from schema-7 line_note rows.
 *
 * A "הערות על X" companion that the generator merged into X is gone as a book, but its notes are
 * kept in line_note(lineId, charPos, hasMarker, body), and X keeps the marker
 * <sup class="footnote-marker">N</sup> right before each charPos. So the TRUTH is exact: note k of
 * line L belongs to line L, and its marker ends at visible offset charPos.
 *
 * The companion is rebuilt the way such files are written — one line per note, opening with the
 * marker printed in X ("<sup>N</sup> body") — optionally with X's headings copied in. The engine
 * then has to find every marker in X, follow numbering restarts, and point at the right note line.
 */
export interface Bench {
  readonly main: EngineBook;
  readonly notes: EngineBook;
  /** notes line → where its marker is in the main book */
  readonly truth: ReadonlyMap<number, { readonly line: number; readonly charPos: number }>;
}

const MARKER = /<sup\b[^>]*\bclass\s*=\s*"footnote-marker"[^>]*>(.*?)<\/sup>/gis;

export function benchFromLineNotes(title: string, lines: readonly DbLine[], withHeadings: boolean): Bench {
  const mainLines: EngineLine[] = lines.map((l) => ({ index: l.index, text: l.content, heading: headingLevel(l.content) }));
  const notesLines: EngineLine[] = [{ index: 0, text: `<h1>הערות ל${title}</h1>`, heading: 1 }];
  const truth = new Map<number, { line: number; charPos: number }>();
  for (const l of lines) {
    if (withHeadings && headingLevel(l.content) !== null && headingLevel(l.content)! > 1) {
      notesLines.push({ index: notesLines.length, text: l.content, heading: headingLevel(l.content) });
      continue;
    }
    const printed = [...l.content.matchAll(MARKER)].map((m) => m[1]!.replace(/<[^>]*>/g, "").trim());
    let k = 0;
    for (const n of l.notes) {
      if (!n.hasMarker) continue;
      const label = printed[k++];
      if (!label) continue;
      truth.set(notesLines.length, { line: l.index, charPos: n.charPos });
      notesLines.push({ index: notesLines.length, text: `<sup>${label}</sup> ${n.body}`, heading: null });
    }
  }
  return {
    main: { book: { key: `db:${title}`, title, origin: "otzaria" }, lines: mainLines },
    notes: { book: { key: `notes:${title}`, title: `הערות ל${title}`, origin: "personal" }, lines: notesLines },
    truth,
  };
}

export interface Score {
  readonly truth: number;
  readonly suggested: number;
  readonly correct: number;
  readonly anchorsExact: number;
  readonly certain: number;
  readonly certainCorrect: number;
  readonly precision: number;
  readonly recall: number;
}

export function score(b: Bench, res: EngineResult): Score {
  let correct = 0;
  let anchorsExact = 0;
  let certain = 0;
  let certainCorrect = 0;
  const found = new Set<number>();
  for (const s of res.suggestions) {
    const t = b.truth.get(s.target.line);
    const ok = !!t && t.line === s.source.line;
    if (s.confidence === "certain") certain++;
    if (!ok) continue;
    correct++;
    if (s.confidence === "certain") certainCorrect++;
    found.add(s.target.line);
    const text = b.main.lines[s.source.line]!.text;
    if (s.anchor?.rawEnd !== undefined && countVisibleChars(text, s.anchor.rawEnd) === t.charPos) anchorsExact++;
  }
  return {
    truth: b.truth.size,
    suggested: res.suggestions.length,
    correct,
    anchorsExact,
    certain,
    certainCorrect,
    precision: res.suggestions.length ? correct / res.suggestions.length : 1,
    recall: b.truth.size ? found.size / b.truth.size : 1,
  };
}
