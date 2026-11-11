import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import type { ValidationContext } from "../../../src/core/links/validate";
import { planAltTocExport } from "../../../src/formats/alt-toc/export";
import { planExport } from "../../../src/formats/links-json/export";
import { buildExportReport, REPORT_FILE_NAME } from "../../../src/formats/report/export-report";
import { planSefariaCsv } from "../../../src/formats/sefaria-csv/write";

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
    expect(line("שדות ref_1/ref_2")).toMatch(/ 0$/);
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
});
