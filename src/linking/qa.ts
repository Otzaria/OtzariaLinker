import type { Link } from "../core/links/model";
import { storedKey } from "../core/links/stored-form";
import { validateExport, type Problem, type Severity, type ValidationContext } from "../core/links/validate";

/*
 * Link quality report (stage 16). It reuses the export rules — QA and export must never disagree —
 * and groups every problem into a category a person can act on, with a plain-language title.
 */
export type QaCategory =
  | "duplicate"
  | "missing-book"
  | "out-of-range"
  | "heading"
  | "anchor"
  | "type"
  | "sefaria"
  | "title"
  | "reference"
  | "unverified"
  | "other";

export const QA_CATEGORIES: Readonly<Record<QaCategory, { title: string; hint: string }>> = {
  duplicate: { title: "כפולים", hint: "שני קישורים שבמסד יהפכו לקישור אחד" },
  "missing-book": { title: "ספר לא נמצא", hint: "אחד הספרים אינו פתוח, או ששמו לא קיים במסד" },
  "out-of-range": { title: "מחוץ לספר", hint: "שורה או טווח אחרי סוף הספר" },
  heading: { title: "קישור לכותרת", hint: "אוצריא מדלגת על קישור שאחד מקצותיו שורת כותרת" },
  anchor: { title: "עוגן לא תקין", hint: "העוגן ייזרק או יתקצר" },
  type: { title: "סוג קשר", hint: "סוג לא מוכר, או קישור שיישמר כ\"אחר\"" },
  sefaria: { title: "כללי ספריא", hint: "שדות ref_1/ref_2 ועוגנים מול ספרי ספריא" },
  title: { title: "שם ספר", hint: "שם שאוצריא מנרמלת או ממזגת" },
  reference: { title: "שם המקום", hint: "heRef_2 חסר" },
  unverified: { title: "לא נבדק", hint: "השורה לא נטענה, ולכן לא נבדקה" },
  other: { title: "אחר", hint: "" },
};

const CATEGORY_OF: Record<string, QaCategory> = {
  "export/duplicate": "duplicate",
  "export/source-unknown": "missing-book",
  "export/target-unknown": "missing-book",
  "export/line-out-of-range": "out-of-range",
  "export/range-out-of-range": "out-of-range",
  "export/range-ignored": "out-of-range",
  "export/heading-line": "heading",
  "export/line-not-in-db": "heading",
  "export/range-end-heading": "heading",
  "export/anchor-dropped-flip": "anchor",
  "export/anchor-end-ignored": "anchor",
  "export/anchor-out-of-line": "anchor",
  "export/unknown-type": "type",
  "export/downgraded": "type",
  "export/linker": "type",
  "export/base-unknown": "type",
  "export/sefaria-both": "sefaria",
  "export/title-not-normalized": "title",
  "export/companion-merged": "title",
  "export/heref-missing": "reference",
  "export/line-not-verified": "unverified",
};
export const categoryOf = (code: string): QaCategory => CATEGORY_OF[code] ?? (code.startsWith("sefaria/") ? "sefaria" : "other");

export interface QaIssue {
  link: Link;
  category: QaCategory;
  problem: Problem;
}

export interface QaReport {
  checked: number;
  /** links with no warning or error */
  clean: number;
  issues: QaIssue[];
  bySeverity: Record<Severity, number>;
  byCategory: Partial<Record<QaCategory, number>>;
}

export function runQa(links: readonly Link[], ctx: ValidationContext): QaReport {
  const live = links.filter((l) => l.status !== "deleted" && l.provenance !== "db");
  const problems = validateExport(live, ctx, storedKey);
  const issues: QaIssue[] = [];
  let clean = 0;
  for (const l of live) {
    const ps = (problems.get(l.id) ?? []).filter((p) => p.code !== "export/base-unknown"); // informational only
    if (!ps.some((p) => p.severity !== "info")) clean++;
    for (const p of ps) issues.push({ link: l, category: categoryOf(p.code), problem: p });
  }
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.problem.severity] - order[b.problem.severity] || a.link.source.book.title.localeCompare(b.link.source.book.title, "he") || a.link.source.line - b.link.source.line);
  const bySeverity: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  const byCategory: Partial<Record<QaCategory, number>> = {};
  for (const i of issues) {
    bySeverity[i.problem.severity]++;
    byCategory[i.category] = (byCategory[i.category] ?? 0) + 1;
  }
  return { checked: live.length, clean, issues, bySeverity, byCategory };
}

/** Of each group of duplicates, every link but the first — safe to delete in one action. */
export function redundantDuplicates(report: QaReport): string[] {
  return report.issues.filter((i) => i.problem.code === "export/duplicate").map((i) => i.link.id);
}

/** The report as CSV (UTF-8 with BOM so Excel shows Hebrew), for review outside the tool. */
export function qaCsv(report: QaReport): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["חומרה", "קטגוריה", "ספר מקור", "שורת מקור", "ספר יעד", "שורת יעד", "heRef_2", "סוג", "הסבר", "קוד"];
  const sev: Record<Severity, string> = { error: "שגיאה", warning: "אזהרה", info: "מידע" };
  const rows = report.issues.map((i) =>
    [sev[i.problem.severity], QA_CATEGORIES[i.category].title, i.link.source.book.title, i.link.source.line + 1, i.link.target.book.title, i.link.target.line + 1, i.link.heRef2, i.link.declaredType, i.problem.message, i.problem.code].map(esc).join(","),
  );
  return `﻿${[head.map(esc).join(","), ...rows].join("\r\n")}\r\n`;
}
