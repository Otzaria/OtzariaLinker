import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import type { ValidationContext } from "../../../src/core/links/validate";
import { planAltTocExport } from "../../../src/formats/alt-toc/export";
import { recordToLink } from "../../../src/formats/links-json/convert";
import { parseLinksJson } from "../../../src/formats/links-json/parse";
import { planExport } from "../../../src/formats/links-json/export";
import { buildExportReport, REPORT_FILE_NAME } from "../../../src/formats/report/export-report";
import { planSefariaCsv } from "../../../src/formats/sefaria-csv/write";
import { nextSteps, nextStepsText } from "../../../src/formats/report/next-steps";

const S: BookRef = { key: "t:1", title: "פירוש על בראשית", origin: "otzaria" };
const T: BookRef = { key: "t:2", title: "בראשית", origin: "otzaria" };
const ctx: ValidationContext = {
  lineCount: () => 50,
  line: (_b, i) => ({ exists: true, heading: i === 0 ? 1 : null, anchorLength: 40 }),
};
const link = (id: string, line: number, extra: Partial<Link> = {}): Link => ({ id, status: "new", provenance: "user", source: { book: S, line }, target: { book: T, line: 3 }, declaredType: "commentary", heRef2: "בראשית א, ב", ...extra });
const links = [
  link("a", 2, { source: { book: S, line: 2, end: 4 }, anchor: { rawStart: 0, rawEnd: 3 } }),
  link("b", 5, { declaredType: "reference" }),
  link("c", 0), // a heading line: held back
];
const plan = planExport(links, ctx);
const altToc = planAltTocExport(
  [
    { title: "בראשית", origin: "user", structures: [{ key: "Parasha", heTitle: "פרשה", entries: [{ heTitle: "בראשית", line: 1, level: 0 }, { heTitle: "עליה א", line: 2, level: 1 }] }] },
    { title: "שמות", origin: "user", structures: [{ key: "", entries: [{ heTitle: "x", line: 1, level: 0 }] }] },
  ],
  () => ({}),
);
const report = buildExportReport({ date: "1.1.2026, 10:00:00", app: "2.0.0-test", format: "json", links: plan, altToc });

describe("_report.txt", () => {
  it("is named like version 3's and is deterministic plain text ending in a line break", () => {
    expect(REPORT_FILE_NAME).toBe("_report.txt");
    expect(buildExportReport({ date: "1.1.2026, 10:00:00", app: "2.0.0-test", format: "json", links: plan, altToc })).toBe(report);
    expect(report.endsWith("\n")).toBe(true);
    expect(report.includes("\r")).toBe(false);
    expect(report.startsWith("דוח ייצוא — מנהל הקישורים של אוצריא\n")).toBe(true);
  });

  it("counts what was written: links, ranges, anchors, refs, structures", () => {
    const line = (label: string) => report.split("\n").find((l) => l.trimStart().startsWith(label))!;
    expect(line("קישורים שנכתבו")).toMatch(/ 2$/);
    expect(line("לא ייוצאו (שגיאה)")).toMatch(/ 1$/);
    expect(line("טווחים בצד המקור")).toMatch(/ 1$/);
    expect(line("עוגני מילה")).toMatch(/ 1$/);
    expect(line("ציוני ספריא")).toMatch(/ 0$/); // plain words (audit F14); the field names only in advanced mode
    expect(line("מבני כותרות (alt_toc)")).toMatch(/ 1$/);
    expect(report).toContain("(commentary) — 1");
    expect(report).toContain("(reference) — 1");
  });

  it("says which library folder every file goes to", () => {
    expect(report).toContain("links/פירוש על בראשית_links.json  (2 רשומות)  [קובץ חדש");
    expect(report).toContain("alt_toc/בראשית_alt_toc.json  (1 מבנים, 2 צמתים)");
    expect(report).toContain("את התיקיות links/ ו־alt_toc/ מעתיקים לשורש otzaria-library");
  });

  it("lists what was held back and why, per book", () => {
    expect(report).toContain("קישורים שלא ייוצאו (1)");
    expect(report).toMatch(/✗ פירוש על בראשית 1 ← בראשית א, ב: .*כותרת/);
    expect(report).toContain("מבני כותרות שלא ייוצאו (1)");
    expect(report).toContain("  ✗ שמות:");
    expect(report).toContain("לפי ספר");
    expect(report).toContain("  שמות: מבני הכותרות לא ייוצאו (שגיאה)");
  });

  it("in CSV mode lists the CSV files and says they are for Sefaria", () => {
    const csv = planSefariaCsv(plan.written, () => undefined);
    const r = buildExportReport({ date: "d", app: "a", format: "sefaria-csv", links: plan, csv, altToc: { files: [], heldBack: [] } });
    expect(r).toContain("פירוש על בראשית.links.csv  (2 שורות)");
    expect(r).toContain("קובצי ה־CSV מיועדים להעלאת קישורים לספריא");
    expect(r).not.toContain("links/פירוש");
  });

  it("ends with what to do with the files: the library, the user's own Otzaria (unverified), not into a database (audit F13)", () => {
    const tail = report.slice(report.indexOf("מה עושים עכשיו עם הקבצים"));
    expect(tail).toMatch(/^מה עושים עכשיו עם הקבצים\n=+\n\nלספריית אוצריא, לכל המשתמשים:\n {2}1\. פותחים את קובץ ה־ZIP\./);
    expect(tail).toContain("בקשת משיכה");
    expect(tail).toContain("לאוצריא שלכם בלבד (הספרייה האישית):");
    expect(tail).toContain('"ייבוא נתונים"');
    expect(tail).toContain("שימו לב: המסלול הזה נבדק בתוך אוצריא 0.9.98.3");
    expect(tail).toContain("הכלי לא כותב קישורים לתוך מסד");
    // private use puts the personal library first
    const priv = buildExportReport({ date: "d", app: "a", format: "json", links: plan, altToc, purpose: "private" });
    expect(priv.slice(priv.indexOf("מה עושים עכשיו"))).toMatch(/=\n\nלאוצריא שלכם בלבד/);
  });
});

describe("next steps after an export", () => {
  it("one file is taken as is; without alt_toc only links/ is copied; CSV is for Sefaria only", () => {
    const [lib] = nextSteps({ format: "json", purpose: "submission", altToc: false, zip: false });
    expect(lib!.steps[0]).toBe("לוקחים את הקובץ שירד.");
    expect(lib!.steps[1]).toMatch(/^את התיקייה links\/ מעתיקים/);
    expect(nextSteps({ format: "json", purpose: "submission", altToc: false, zip: false }).map((r) => r.id)).toEqual(["library", "personal", "database"]);
    expect(nextSteps({ format: "json", purpose: "private", altToc: false, zip: true }).map((r) => r.id)).toEqual(["personal", "library", "database"]);
    const csv = nextSteps({ format: "sefaria-csv", purpose: "submission", altToc: true, zip: true });
    expect(csv.map((r) => r.id)).toEqual(["sefaria"]);
    expect(csv[0]!.steps.join(" ")).toContain("alt_toc/");
    expect(nextStepsText({ format: "json", purpose: "submission", altToc: false, zip: false })[0]).toBe("");
  });

  // V7 live tests (docs/reviews/V7_LIVE_OTZARIA_TESTS.md, run 1 and run 3): the personal route was used inside the open app, so it
  // no longer says "not yet tested live"; and what the run saw goes to the user: renaming a book leaves its links dead without a
  // message (22), an open tab keeps the old links after a rescan (finding ד), and the version does not read alt_toc files (25)
  it("the personal route: tested inside Otzaria, renaming a book, reopening after a rescan, alt_toc not read", () => {
    const personal = nextSteps({ format: "json", purpose: "private", altToc: false, zip: false }).find((r) => r.id === "personal")!;
    const text = personal.steps.join(" ");
    expect(personal.note).not.toContain("עוד לא בתוך האפליקציה");
    expect(personal.note).toContain("0.9.98.3");
    expect(text).toContain("אל תשנו את השם של ספר שלכם");
    expect(text).toContain("סגרו את הספר ופתחו אותו שוב");
    expect(personal.note).toContain("alt_toc");
  });
});

describe("_report.txt: a private export's source links written at their base", () => {
  it("names the base's file and the commentary whose links it holds", () => {
    const p = planExport([link("s", 2, { declaredType: "source" })], { ...ctx, purpose: "private" });
    const text = buildExportReport({ date: "d", app: "a", format: "json", links: p, altToc: planAltTocExport([], () => ({})), purpose: "private" });
    expect(text).toContain("links/בראשית_links.json");
    expect(text).toContain('מהן 1 קישורים של "פירוש על בראשית" אל הספר הזה, מסוג "מקור", שנכתבים כאן כפירוש');
    expect(text).not.toContain("Conection Type");
    // a file of moved records only is not "new": it adds to the base, it replaces nothing
    expect(text).not.toContain("[קובץ חדש");
  });
});

/*
 * 1.8 (task list): the report says how many suggestions the user approved and rejected, and names a file that
 * REPLACES one the tool imported from the library (an untouched-name file written back), apart from a "new file".
 */
describe("_report.txt: suggestions and replaced files", () => {
  const base = { date: "1.1.2026, 10:00:00", app: "2.0.0-test", format: "json" as const, links: plan, altToc };

  it("shows the numbers of suggestions approved and rejected, and omits the lines when there were none", () => {
    const withS = buildExportReport({ ...base, suggestions: { approved: 12, rejected: 3 } });
    const line = (label: string) => withS.split("\n").find((l) => l.trimStart().startsWith(label))!;
    expect(line("הצעות שאושרו")).toMatch(/ 12$/);
    expect(line("הצעות שנדחו")).toMatch(/ 3$/);
    expect(report).not.toContain("הצעות שאושרו");
    expect(buildExportReport({ ...base, suggestions: { approved: 0, rejected: 0 } })).not.toContain("הצעות שנדחו");
  });

  it("labels a file that replaces the library file the tool imported, differently from a new file", () => {
    const imported = JSON.stringify([{ line_index_1: 3, heRef_2: "בראשית א, ב", path_2: "בראשית.txt", line_index_2: 4, "Conection Type": "commentary" }], null, 2);
    const parsed = parseLinksJson(imported).records.map((r, i) => recordToLink(r, i, S, () => T, `f${i}`).link);
    const replaced = planExport([...parsed, link("new", 9)], ctx);
    expect(replaced.files[0]!.isNewFile).toBe(false);
    const text = buildExportReport({ ...base, links: replaced });
    expect(text).toContain("[מחליף את הקובץ של הספר בספרייה, שנטען לכלי]");
    expect(text).not.toContain("[קובץ חדש");
    expect(report).toContain("[קובץ חדש"); // the all-new plan above still says so
  });
});

/*
 * Fix round before merge (task 2): a file written although the library's file-name LIST (a snapshot) says the library has
 * one is recorded in the report, with the snapshot's date, so the reader can check the existing file before submitting.
 */
describe("_report.txt: files the library's snapshot list says already exist", () => {
  const LABEL = "תמונת מצב של רשימת קובצי הקישורים של הספרייה מ־2026-11-22 (3207ad3f)";
  const listed = { ...ctx, linksFile: () => "missing" as const, libraryFileListed: (t: string) => t === S.title, libraryFileListLabel: LABEL };
  const mk = (c: ValidationContext) => buildExportReport({ date: "1.1.2026, 10:00:00", app: "2.0.0-test", format: "json", links: planExport([link("a", 2), link("b", 5)], c), altToc });

  it("names the books, the snapshot date, and says the file would replace an existing one", () => {
    const text = mk(listed);
    const at = text.indexOf("קבצים שהרשימה מציינת שכבר קיימים בספרייה");
    expect(at).toBeGreaterThan(-1);
    const section = text.slice(at, at + 700);
    expect(section).toContain("2026-11-22");
    expect(section).toContain("תמונת מצב");
    expect(section).toContain("פירוש על בראשית_links.json (2 קישורים)");
    expect(section).toMatch(/יחליף/);
  });

  it("has no such section when the list names nothing", () => {
    expect(mk({ ...listed, libraryFileListed: () => false })).not.toContain("קבצים שהרשימה מציינת");
    expect(report).not.toContain("קבצים שהרשימה מציינת");
  });

  it("does not hold or drop any link", () => {
    const p = planExport([link("a", 2), link("b", 5)], listed);
    expect(p.heldBack).toEqual([]);
    expect(p.written).toHaveLength(2);
  });
});
