import { pushTo } from "../../core/collections";
import { parseConnectionType, TYPE_LABELS } from "../../core/links/connection-type";
import { isRange, type Link } from "../../core/links/model";
import type { AltTocExportPlan } from "../alt-toc/export";
import type { ExportPlan } from "../links-json/export";
import type { SefariaCsvFile } from "../sefaria-csv/write";
import { nextStepsText, type ExportPurpose } from "./next-steps";

/*
 * `_report.txt`: a plain-text Hebrew summary that travels with the export — version 3 wrote one
 * into every export (legacy/OtzariaLinker-v3.html, `ExportBuilder.report`). It says what was
 * written and where each file goes in otzaria-library, what was held back and why, the
 * warnings, and what to do with the files (next-steps.ts). Deterministic for a given input (the date is passed in), LF line breaks, no BOM.
 */
export const REPORT_FILE_NAME = "_report.txt";

export type ExportFormat = "json" | "sefaria-csv";

export interface ReportInput {
  /** already formatted for display */
  date: string;
  app: string;
  format: ExportFormat;
  links: ExportPlan;
  /** the CSV files, when format is "sefaria-csv" */
  csv?: readonly SefariaCsvFile[];
  altToc: AltTocExportPlan;
  /** what the export is for: the next steps put its route first (default: the library) */
  purpose?: ExportPurpose;
}

const RULE = (ch: string) => ch.repeat(60);
const LIMIT = 200;

/** "  label ........ value", dotted to a fixed column like version 3's report. */
function row(label: string, value: number | string): string {
  return `  ${label} ${".".repeat(Math.max(3, 30 - label.length))} ${typeof value === "number" ? value.toLocaleString("he") : value}`;
}

const linkPlace = (l: Link) => `${l.source.book.title} ${l.source.line + 1}${l.source.end !== undefined ? `–${l.source.end + 1}` : ""} ← ${l.heRef2 || l.target.book.title}`;

export function buildExportReport(r: ReportInput): string {
  const L: string[] = [];
  const { links, altToc } = r;
  const w = links.written;
  const c = links.counts;
  const section = (title: string, ch = "-") => L.push("", title, RULE(ch));

  L.push("דוח ייצוא — מנהל הקישורים של אוצריא", RULE("="));
  L.push(`תאריך:   ${r.date}`);
  L.push(`גרסה:    OtzariaLinker ${r.app}`);
  L.push(`פורמט:   ${r.format === "json" ? "קובצי ‎_links.json לספריית אוצריא" : "קובצי CSV בפורמט ספריא"}`);

  section("סיכום");
  L.push(row("קישורים שנכתבו", w.length));
  L.push(row("  מהם חדשים", c.new));
  L.push(row("  מהם ערוכים", c.edited));
  L.push(row("  מהם נשמרו כמו שהם", c.kept));
  L.push(row("נמחקו מהקבצים", c.deleted));
  L.push(row("לא ייוצאו (שגיאה)", c.heldBack));
  L.push(row("קובצי קישורים", r.format === "json" ? links.files.length : r.csv?.length ?? 0));
  L.push(row("טווחים בצד המקור", w.filter((l) => isRange(l.source)).length));
  L.push(row("טווחים בצד היעד", w.filter((l) => isRange(l.target)).length));
  L.push(row("עוגני מילה", w.filter((l) => l.anchor).length));
  L.push(row("שדות ref_1/ref_2", w.reduce((n, l) => n + (l.ref1 ? 1 : 0) + (l.ref2 ? 1 : 0), 0)));
  L.push(row("מבני כותרות (alt_toc)", altToc.files.reduce((n, f) => n + f.structures, 0)));
  L.push(row("קובצי alt_toc", altToc.files.length));
  if (altToc.heldBack.length) L.push(row("ספרים שמבני הכותרות שלהם לא ייוצאו", altToc.heldBack.length));

  if (w.length) {
    section("לפי סוג קשר");
    const byType = new Map<string, number>();
    for (const l of w) byType.set(l.declaredType, (byType.get(l.declaredType) ?? 0) + 1);
    for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
      const p = parseConnectionType(t);
      L.push(`  ${TYPE_LABELS[p.type].he}${p.known ? "" : " (סוג לא מוכר)"} (${t}) — ${n.toLocaleString("he")}`);
    }
  }

  section("הקבצים ולאן הם הולכים");
  if (r.format === "json") {
    for (const f of links.files)
      L.push(`  links/${f.name}  (${f.records.toLocaleString("he")} רשומות)${f.isNewFile ? "  [קובץ חדש: אם לספר כבר יש קובץ בספרייה, הוא יוחלף]" : ""}`);
  } else {
    for (const f of r.csv ?? []) L.push(`  ${f.name}  (${f.rows.toLocaleString("he")} שורות)`);
  }
  for (const f of altToc.files)
    L.push(`  alt_toc/${f.name}  (${f.clears ? "ריק: מוחק את מבני הכותרות של הספר מהספרייה" : `${f.structures} מבנים, ${f.nodes.toLocaleString("he")} צמתים`})`);
  if (!links.files.length && !(r.csv?.length) && !altToc.files.length) L.push("  (אין קבצים)");

  // per book: what happens to each book of the library
  const books = new Map<string, string[]>();
  const note = (title: string, text: string) => pushTo(books, title, text);
  if (r.format === "json") for (const f of links.files) note(f.sourceTitle, `${f.records.toLocaleString("he")} קישורים`);
  else for (const f of r.csv ?? []) note(f.sourceTitle, `${f.rows.toLocaleString("he")} קישורים`);
  for (const f of altToc.files) note(f.title, f.clears ? "מבני הכותרות נמחקים" : `${f.structures} מבני כותרות`);
  for (const b of altToc.heldBack) note(b.title, "מבני הכותרות לא ייוצאו (שגיאה)");
  if (books.size > 1) {
    section("לפי ספר");
    for (const [title, parts] of [...books].sort(([a], [b]) => (a < b ? -1 : 1))) L.push(`  ${title}: ${parts.join("; ")}`);
  }

  const errs = links.heldBack;
  if (errs.length) {
    section(`קישורים שלא ייוצאו (${errs.length.toLocaleString("he")})`, "!");
    for (const { link, problems } of errs.slice(0, LIMIT))
      L.push(`  ✗ ${linkPlace(link)}: ${problems.filter((p) => p.severity === "error").map((p) => p.message).join(" ")}`);
    if (errs.length > LIMIT) L.push(`  … ועוד ${(errs.length - LIMIT).toLocaleString("he")}`);
  }
  if (altToc.heldBack.length) {
    section(`מבני כותרות שלא ייוצאו (${altToc.heldBack.length})`, "!");
    for (const b of altToc.heldBack) {
      L.push(`  ✗ ${b.title}:`);
      for (const p of b.problems.filter((x) => x.severity === "error").slice(0, LIMIT)) L.push(`      ${p.message}`);
    }
  }
  const warned = links.warned;
  const altWarnings = altToc.files.flatMap((f) => f.problems.filter((p) => p.severity === "warning").map((p) => `${f.title}: ${p.message}`));
  if (warned.length || altWarnings.length) {
    section(`אזהרות (${(warned.length + altWarnings.length).toLocaleString("he")})`);
    for (const { link, problems } of warned.slice(0, LIMIT))
      L.push(`  • ${linkPlace(link)}: ${problems.filter((p) => p.severity !== "info").map((p) => p.message).join(" ")}`);
    if (warned.length > LIMIT) L.push(`  … ועוד ${(warned.length - LIMIT).toLocaleString("he")}`);
    for (const m of altWarnings.slice(0, LIMIT)) L.push(`  • ${m}`);
  }

  // what to do with the files, for each way back to Otzaria (audit F13)
  section("מה עושים עכשיו עם הקבצים", "=");
  const files = (r.format === "json" ? links.files.length : (r.csv?.length ?? 0)) + altToc.files.length;
  L.push(...nextStepsText({ format: r.format, purpose: r.purpose ?? "submission", altToc: altToc.files.length > 0, zip: files > 1 }));
  return L.join("\n") + "\n";
}
