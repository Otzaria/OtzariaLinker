import { pushTo } from "../core/collections";
import type { LinkSide } from "../core/links/model";
import type { Severity } from "../core/links/validate";
import { escapeHtml as esc } from "../core/text/html";
import { QA_CATEGORIES, suggestedFix, type QaCategory, type QaIssue, type QaReport } from "./qa";

/*
 * The quality report as ONE self-contained HTML page (stage 16) — to keep, print or send to someone
 * who does not have the tool. Inline CSS only: no script, no image, no font, no link to anywhere, and
 * a CSP that forbids them, so the page is inert even if a value slipped through unescaped. Every value
 * that comes from a book or a link (titles, heRef_2, type, messages) is untrusted (docs/SECURITY.md)
 * and passes through escapeHtml. Deterministic for a given input: the date is passed in.
 * Order: summary; then by severity (errors, warnings, info) and inside it by category, in the order
 * of QA_CATEGORIES; issues keep runQa's order (book, then line).
 */
export interface QaHtmlInput {
  report: QaReport;
  /** already formatted for display */
  date: string;
  app: string;
}

export const QA_HTML_MIME = "text/html;charset=utf-8";

const SEVERITIES: readonly Severity[] = ["error", "warning", "info"];
const SEV_TITLE: Record<Severity, string> = { error: "שגיאות", warning: "אזהרות", info: "מידע" };
const SEV_HINT: Record<Severity, string> = {
  error: "קישור חדש או ערוך עם שגיאה לא ייוצא, ואוצריא או הסנכרון השבועי ידחו אותו.",
  warning: "הקישור ייוצא, אבל לא כמו שכנראה התכוונתם.",
  info: "כדאי לדעת; אין חובה לתקן.",
};

const n = (v: number) => v.toLocaleString("he");
/** Untrusted text, isolated for bidi so an English title does not reorder the Hebrew around it. */
const bdi = (v: unknown) => `<bdi>${esc(v)}</bdi>`;

/** "<title> 12" or "<title> 12–15", 1-based like the links file. */
const place = (s: LinkSide) => `${bdi(s.book.title)} ${s.line + 1}${s.end !== undefined && s.end > s.line ? `–${s.end + 1}` : ""}`;

const CSS = `
:root{color-scheme:light dark;--bg:#fff8f4;--fg:#201b13;--muted:#4f4539;--line:#d3c4b4;--card:#ffffff;--head:#f3e6da;--err:#ba1a1a;--warn:#8a5a00;--info:#51643f}
@media (prefers-color-scheme:dark){:root{--bg:#18120b;--fg:#ede0d4;--muted:#d3c4b4;--line:#4f4539;--card:#201b13;--head:#2f2921;--err:#ffb4ab;--warn:#ffc46b;--info:#b8cea1}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 "Segoe UI",Roboto,Arial,"Noto Sans Hebrew",sans-serif}
main{max-width:1200px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:24px 0 8px}h3{font-size:15px;margin:0;display:inline}
.muted{color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px}
.tile{padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card)}
.tile b{display:block;font-size:22px}
.tile.error b{color:var(--err)}.tile.warning b{color:var(--warn)}
table{border-collapse:collapse;width:100%;background:var(--card);margin:6px 0 12px}
th,td{border:1px solid var(--line);padding:4px 8px;text-align:start;vertical-align:top}
th{background:var(--head)}
td.num{text-align:end;font-variant-numeric:tabular-nums}
code{font-family:ui-monospace,Consolas,monospace;font-size:12px;direction:ltr;unicode-bidi:isolate}
section.error>h2{color:var(--err)}section.warning>h2{color:var(--warn)}section.info>h2{color:var(--info)}
details{border:1px solid var(--line);border-radius:8px;padding:6px 10px;margin:8px 0;background:var(--card)}
section.error details{border-inline-start:4px solid var(--err)}section.warning details{border-inline-start:4px solid var(--warn)}section.info details{border-inline-start:4px solid var(--info)}
summary{cursor:pointer}
.fix{font-weight:600}
@media print{details{break-inside:auto}summary{list-style:none}}
`.trim();

export function buildQaHtml({ report, date, app }: QaHtmlInput): string {
  const body = [header(date, app), summary(report), ...SEVERITIES.map((s) => severitySection(report, s)), footer(report)].join("\n");
  return [
    "<!doctype html>",
    '<html lang="he" dir="rtl">',
    "<head>",
    '<meta charset="utf-8">',
    // nothing may load or run: the page is data only
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>דוח בדיקת קישורים — ${esc(date)}</title>`,
    `<style>\n${CSS}\n</style>`,
    "</head>",
    "<body>",
    "<main>",
    body,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function header(date: string, app: string): string {
  return `<header>\n<h1>דוח בדיקת קישורים</h1>\n<p class="muted">מנהל הקישורים של אוצריא ${esc(app)} · ${esc(date)}</p>\n</header>`;
}

function summary(r: QaReport): string {
  const tile = (cls: string, value: number, label: string) => `<div class="tile${cls ? ` ${cls}` : ""}"><b>${n(value)}</b><span class="muted">${label}</span></div>`;
  const tiles = [
    tile("", r.checked, "קישורים נבדקו"),
    tile("", r.clean, "תקינים"),
    tile("error", r.bySeverity.error, SEV_TITLE.error),
    tile("warning", r.bySeverity.warning, SEV_TITLE.warning),
    tile("info", r.bySeverity.info, SEV_TITLE.info),
  ].join("\n");
  return `<section class="summary">\n<h2>סיכום</h2>\n<div class="tiles">\n${tiles}\n</div>\n${categoryTable(r)}\n${bookTable(r)}\n</section>`;
}

/** Severity counts of a group of issues. */
function counts(issues: readonly QaIssue[]): Record<Severity, number> {
  const c: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const i of issues) c[i.problem.severity]++;
  return c;
}

const countRow = (label: string, c: Record<Severity, number>) =>
  `<tr><td>${label}</td>${SEVERITIES.map((s) => `<td class="num">${n(c[s])}</td>`).join("")}<td class="num">${n(c.error + c.warning + c.info)}</td></tr>`;
const countHead = (first: string) => `<tr><th>${first}</th>${SEVERITIES.map((s) => `<th>${SEV_TITLE[s]}</th>`).join("")}<th>סה"כ</th></tr>`;

function categoryTable(r: QaReport): string {
  const rows = categoriesIn(r.issues).map((c) => countRow(esc(QA_CATEGORIES[c].title), counts(r.issues.filter((i) => i.category === c))));
  if (!rows.length) return "";
  return `<h3>לפי קטגוריה</h3>\n<table>\n<thead>${countHead("קטגוריה")}</thead>\n<tbody>\n${rows.join("\n")}\n</tbody>\n</table>`;
}

/** Per source book: the file each fix lands in. Sorted by title (code-point order: deterministic). */
function bookTable(r: QaReport): string {
  const byBook = new Map<string, QaIssue[]>();
  for (const i of r.issues) pushTo(byBook, i.link.source.book.title, i);
  if (!byBook.size) return "";
  const rows = [...byBook].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([title, issues]) => countRow(bdi(title), counts(issues)));
  return `<h3>לפי ספר המקור</h3>\n<table>\n<thead>${countHead("ספר")}</thead>\n<tbody>\n${rows.join("\n")}\n</tbody>\n</table>`;
}

/** The categories that occur, in the order of QA_CATEGORIES (stable, unlike first-seen order). */
const categoriesIn = (issues: readonly QaIssue[]): QaCategory[] => {
  const seen = new Set(issues.map((i) => i.category));
  return (Object.keys(QA_CATEGORIES) as QaCategory[]).filter((c) => seen.has(c));
};

function severitySection(r: QaReport, sev: Severity): string {
  const issues = r.issues.filter((i) => i.problem.severity === sev);
  if (!issues.length) return "";
  const groups = categoriesIn(issues).map((c) => categoryBlock(c, issues.filter((i) => i.category === c)));
  return `<section class="${sev}">\n<h2>${SEV_TITLE[sev]} (${n(issues.length)})</h2>\n<p class="muted">${SEV_HINT[sev]}</p>\n${groups.join("\n")}\n</section>`;
}

function categoryBlock(cat: QaCategory, issues: readonly QaIssue[]): string {
  const { title, hint } = QA_CATEGORIES[cat];
  const head = "<tr><th>מקור</th><th>יעד</th><th>שם המקום ביעד</th><th>סוג</th><th>הסבר</th><th>תיקון מוצע</th><th>קוד</th></tr>";
  return [
    "<details open>",
    `<summary><h3>${esc(title)} (${n(issues.length)})</h3>${hint ? ` <span class="muted">— ${esc(hint)}</span>` : ""}</summary>`,
    "<table>",
    `<thead>${head}</thead>`,
    "<tbody>",
    ...issues.map(issueRow),
    "</tbody>",
    "</table>",
    "</details>",
  ].join("\n");
}

function issueRow(i: QaIssue): string {
  const l = i.link;
  const cells = [place(l.source), place(l.target), bdi(l.heRef2), bdi(l.declaredType), esc(i.problem.message), `<span class="fix">${esc(suggestedFix(i.problem.code, i.category))}</span>`, `<code>${esc(i.problem.code)}</code>${i.problem.detail ? `<br><span class="muted">${esc(i.problem.detail)}</span>` : ""}`];
  return `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
}

function footer(r: QaReport): string {
  const none = r.issues.length ? "" : "<p><b>לא נמצאו בעיות. אפשר לייצא.</b></p>\n";
  return `${none}<footer class="muted">\n<p>מספרי השורות מתחילים ב־1, כמו בקובץ הקישורים. הקוד של כל בעיה יציב, וזהה לקוד בקובץ ה־CSV של הבדיקה.</p>\n</footer>`;
}
