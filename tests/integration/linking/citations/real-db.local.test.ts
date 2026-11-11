import { writeFileSync } from "node:fs";
import { fileBlob } from "./file-blob";
import { beforeAll, describe, expect, it } from "vitest";
import type { BookRef } from "../../../../src/core/links/model";
import type { EngineResult } from "../../../../src/linking/automatic";
import type { SourceBook } from "../../../../src/sources/book-source";
import { SourceRegistry } from "../../../../src/sources/registry";
import { citationsJob } from "../../../../src/workers/citations-job";
import { visibleUnits } from "../../../../src/core/text/offsets";
import { add, emptyTally, goldOf, judge, LEVELS, pct, precision, type Judged, type Tally } from "./measure";

/*
 * The citations engine against the FULL library, judged by the citation links the database already
 * has (LINKER from LinkerToOtzaria, REFERENCE, QUOTATION — see measure.ts). The database is opened
 * read-only through the same registry and worker job the app uses (a file-backed Blob, never copied):
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db npx vitest run tests/integration/linking/citations/real-db.local.test.ts
 * Optional: CITATIONS_REPORT=<file.json> writes every judged suggestion; CITATIONS_ONLY=<title> runs one book.
 *
 * The sample: 17 category groups, from each the 3 books with the smallest sha1(book id) among those with
 * 200–6000 lines and at least 20 LINKER links (deterministic for a given library build; the script
 * that chose them is described in docs/AUTOMATION_ENGINE.md §5).
 */
const path = process.env.OTZARIA_DB;

const SAMPLE: readonly { group: string; title: string }[] = [
  { group: "תנ\"ך", title: "רש\"י על תהילים" },
  { group: "תנ\"ך", title: "אבן עזרא על שמות; פירוש הקצר" },
  { group: "תנ\"ך", title: "תורת הגאונים - ישעיה" },
  { group: "תנ\"ך", title: "מהרם שיק על התורה" },
  { group: "תנ\"ך", title: "מנחת שי על משלי" },
  { group: "תנ\"ך", title: "מצודת דוד על יחזקאל" },
  { group: "דרשות", title: "קובץ פרשיות ומועדים" },
  { group: "דרשות", title: "בית דוד (דרשות)" },
  { group: "דרשות", title: "מקור אהרן" },
  { group: "בבלי", title: "קרבן נתנאל על נדרים" },
  { group: "בבלי", title: "תוספות על מעילה" },
  { group: "בבלי", title: "פסקי תוספות על יבמות" },
  { group: "בבלי", title: "שות הרשבא - הגהות הגראש וסרמן" },
  { group: "בבלי", title: "חידושי חתם סופר על כתובות" },
  { group: "בבלי", title: "חידושי חתם סופר על גיטין" },
  { group: "משנה", title: "לחם שמים על משנה שביעית" },
  { group: "משנה", title: "רש״ש על משנה נגעים" },
  { group: "משנה", title: "עיקר תוספות יום טוב על משנה נזיר" },
  { group: "ירושלמי", title: "פירוש שלמה סיריליו על תלמוד ירושלמי פאה" },
  { group: "ירושלמי", title: "נועם ירושלמי על דמאי" },
  { group: "ירושלמי", title: "נועם ירושלמי על תרומות" },
  { group: "הלכה", title: "מקור חיים - ב (טור פטדה חלק ב)" },
  { group: "הלכה", title: "כסף נבחר חלק ב" },
  { group: "הלכה", title: "חוות דעת ביאורים" },
  { group: "הלכה", title: "קרית מלך רב" },
  { group: "הלכה", title: "דברי ירמיהו על משנה תורה, הלכות עבודה זרה וחוקות הגויים" },
  { group: "הלכה", title: "מגדל עוז על משנה תורה, הלכות איסורי ביאה" },
  { group: "הלכה", title: "חכמת אדם" },
  { group: "הלכה", title: "מטה אפרים" },
  { group: "הלכה", title: "עין התכלת" },
  { group: "הלכה", title: "ספר האורה" },
  { group: "הלכה", title: "מחזור ויטרי" },
  { group: "הלכה", title: "מהריל (מנהגים)" },
  { group: "שו\"ת", title: "בית הלוי חלק א" },
  { group: "שו\"ת", title: "שות פרחי כהונה" },
  { group: "שו\"ת", title: "הליכות אליהו (קליסינקר)" },
  { group: "שו\"ת", title: "תשובות הריב\"ש" },
  { group: "שו\"ת", title: "שו\"ת הרשב\"א חלק ו" },
  { group: "שו\"ת", title: "שות מהרם מינץ" },
  { group: "מוסר", title: "מרבה תבונה" },
  { group: "מוסר", title: "ספר הישר" },
  { group: "מוסר", title: "בלבבי משכן אבנה - ד" },
  { group: "חסידות", title: "ערבי נחל" },
  { group: "חסידות", title: "מקור מים חיים על בעל שם טוב" },
  { group: "חסידות", title: "אגרא דפרקא" },
  { group: "מחשבה", title: "נצח ישראל" },
  { group: "מחשבה", title: "דרך ה'" },
  { group: "מחשבה", title: "כתבי הרמבם" },
  { group: "מדרש", title: "ילקוט שמעוני על התורה" },
  { group: "מדרש", title: "עץ יוסף על דברים רבה" },
  { group: "מדרש", title: "מתנות כהונה על שמות רבה" },
];

/** Minimum precision (strict: unconfirmed counts as wrong) the sample must keep; see the report for the judged numbers. */
const MIN_STRICT = { certain: 0.9, high: 0.75 } as const;

describe.runIf(path)("citations engine vs the citation links of the real seforim.db (read-only)", () => {
  let registry: SourceRegistry;
  let books: SourceBook[];
  beforeAll(async () => {
    registry = new SourceRegistry();
    const blob = fileBlob(path!);
    const opened = await registry.open([{ path: "seforim.db", blob }]);
    books = opened.sources[0]!.books;
  }, 120_000);

  it("precision and recall per confidence level and category", async () => {
    const only = process.env.CITATIONS_ONLY;
    const byLevel = new Map<string, Tally>(LEVELS.map((l) => [l, emptyTally()]));
    const byGroup = new Map<string, Map<string, Tally>>();
    const recall = new Map<string, { linker: number; found: number }>();
    const all: (Judged & { group: string; book: string })[] = [];
    const misses: { book: string; line: number; target: string; heRef: string; span: string }[] = [];
    const timings: string[] = [];
    for (const { group, title } of SAMPLE) {
      if (only && title !== only) continue;
      const b = books.find((x) => x.title === title);
      if (!b) {
        console.log(`missing: ${title}`);
        continue;
      }
      const ref: BookRef = { key: b.key, title: b.title, origin: b.origin };
      const t0 = performance.now();
      const result: EngineResult = await citationsJob(registry, ref, {}, {});
      const ms = performance.now() - t0;
      const gold = goldOf(await registry.existingLinks(b.key, 0, Number.MAX_SAFE_INTEGER), b.key);
      const { judged, found, linkerTotal } = judge(result.suggestions, gold);
      const g = byGroup.get(group) ?? new Map(LEVELS.map((l) => [l, emptyTally()]));
      byGroup.set(group, g);
      for (const j of judged) {
        add(byLevel.get(j.s.confidence)!, j);
        add(g.get(j.s.confidence)!, j);
        all.push({ ...j, group, book: title });
      }
      if (process.env.CITATIONS_REPORT) {
        const missed = gold.filter((x) => x.type === "linker" && !found.has(x));
        const lineText = new Map<number, string>();
        for (const m of missed.slice(0, 400)) {
          if (!lineText.has(m.line)) lineText.set(m.line, (await registry.lines(b.key, m.line, m.line))[0]?.anchorText ?? "");
          const a = m.link.dbAnchors?.find((x) => x.side === 0);
          const vis = visible(lineText.get(m.line)!);
          misses.push({ book: title, line: m.line, target: m.bookTitle, heRef: m.link.heRef2, span: a ? vis.slice(Math.max(0, a.charStart - 15), (a.charEnd ?? a.charStart) + 5).join("") : "" });
        }
      }
      const r = recall.get(group) ?? { linker: 0, found: 0 };
      r.linker += linkerTotal;
      r.found += [...found].filter((x) => x.type === "linker").length;
      recall.set(group, r);
      timings.push(`${title}: ${ms.toFixed(0)} ms, ${result.suggestions.length} suggestions, gold linker ${linkerTotal}, found ${[...found].filter((x) => x.type === "linker").length}`);
      console.log(timings.at(-1));
    }
    const lines: string[] = [];
    lines.push("level      n      correct  wrong  unconf  strict   judged   exact");
    for (const [l, t] of byLevel) {
      const p = precision(t);
      lines.push(`${l.padEnd(10)} ${String(t.n).padStart(6)} ${String(t.correct).padStart(8)} ${String(t.wrong).padStart(6)} ${String(t.unconfirmed).padStart(7)}  ${pct(p.strict).padStart(6)}  ${pct(p.judged).padStart(6)}  ${pct(t.n ? t.exact / t.n : 0)}`);
    }
    lines.push("", "group: certain strict/judged (n) | high strict/judged (n) | recall vs LINKER");
    for (const [group, g] of byGroup) {
      const c = g.get("certain")!;
      const h = g.get("high")!;
      const r = recall.get(group)!;
      lines.push(`${group}: ${pct(precision(c).strict)}/${pct(precision(c).judged)} (${c.n}) | ${pct(precision(h).strict)}/${pct(precision(h).judged)} (${h.n}) | ${pct(r.linker ? r.found / r.linker : 0)} of ${r.linker}`);
    }
    const totalR = [...recall.values()].reduce((a, r) => ({ linker: a.linker + r.linker, found: a.found + r.found }), { linker: 0, found: 0 });
    lines.push(`recall vs LINKER (all levels): ${pct(totalR.linker ? totalR.found / totalR.linker : 0)} of ${totalR.linker}`);
    console.log([...timings, "", ...lines].join("\n"));
    if (process.env.CITATIONS_REPORT) writeFileSync(process.env.CITATIONS_REPORT.replace(/.json$/, ".misses.json"), JSON.stringify(misses));
    if (process.env.CITATIONS_REPORT)
      writeFileSync(
        process.env.CITATIONS_REPORT,
        JSON.stringify(
          all.map((j) => ({ group: j.group, book: j.book, verdict: j.verdict, exact: j.exact, confidence: j.s.confidence, score: j.s.score, line: j.s.source.line, target: j.s.target.book.title, tline: j.s.target.line, tend: j.s.target.end, heRef2: j.s.heRef2, rules: j.s.rules, reason: j.s.reasons.map((r) => r.text).join(" | ") })),
        ),
      );
    if (!only) {
      expect(precision(byLevel.get("certain")!).strict).toBeGreaterThanOrEqual(MIN_STRICT.certain);
      expect(precision(byLevel.get("high")!).strict).toBeGreaterThanOrEqual(MIN_STRICT.high);
    }
  }, 3_600_000);
});

/** the visible characters of a line (one per unit, an entity as one char) — to show a missed LINKER span */
function visible(html: string): string[] {
  return visibleUnits(html).map((u) => (u.end - u.start > 1 ? " " : html[u.start]!));
}
