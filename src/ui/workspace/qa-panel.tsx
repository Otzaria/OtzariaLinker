import { useMemo, useState } from "preact/hooks";
import { QA_CATEGORIES, redundantDuplicates, type QaCategory } from "../../linking/qa";
import { useStore } from "../context";
import { Icon } from "../icons/icon";

/*
 * Quality check (stage 16): every project link checked against Otzaria's rules, grouped by what
 * to do about it. Click an issue to see both ends; fix it in the builder; safe bulk fixes only
 * (removing the later copy of exact duplicates). The report can be saved as CSV, or as a full
 * offline HTML page with a suggested fix for every issue (linking/qa-html.ts).
 */
const PAGE = 200;
const SEV_LABEL = { error: "שגיאות", warning: "אזהרות", info: "מידע" } as const;

export function QaPanel() {
  const store = useStore();
  const report = store.quality.report.value;
  const [cat, setCat] = useState<QaCategory | "all">("all");
  const [sev, setSev] = useState<"error" | "warning" | "info" | "all">("all");
  const [shown, setShown] = useState(PAGE);
  // a report goes stale as soon as links change
  const stale = store.quality.revision.value !== store.linkState.value.revision;

  const rows = useMemo(() => (report?.issues ?? []).filter((i) => (cat === "all" || i.category === cat) && (sev === "all" || i.problem.severity === sev)), [report, cat, sev]);

  const run = () => void store.quality.run().then(() => (setCat("all"), setShown(PAGE)));

  if (!report)
    return (
      <div class="empty">
        <Icon name="oz_link_check" size={40} />
        <span>הבדיקה עוברת על כל הקישורים בפרויקט ומוצאת מה אוצריא תדחה, תשנה או תכפיל — לפני הייצוא.</span>
        <button class="btn filled" onClick={run} disabled={!store.allLinks.value.length || !!store.task.value}>
          <Icon name="oz_link_check" size={18} />
          בדיקת הקישורים
        </button>
      </div>
    );

  const dups = redundantDuplicates(report);
  return (
    <>
      <div class="sug-head">
        <div class="grow">
          <b>{report.checked.toLocaleString("he")} קישורים נבדקו</b>
          <div class="muted" style="font-size:var(--fs-sm)">
            {report.clean.toLocaleString("he")} תקינים · {report.bySeverity.error.toLocaleString("he")} שגיאות · {report.bySeverity.warning.toLocaleString("he")} אזהרות
          </div>
        </div>
        <button class="btn text" onClick={run} title={stale ? "הקישורים השתנו מאז הבדיקה" : "הרצה מחדש"}>
          <Icon name="fl_arrow_sort" size={16} />
          {stale ? "בדיקה מחדש (השתנה)" : "בדיקה מחדש"}
        </button>
        <button class="icon-btn" onClick={() => store.quality.saveReport()} title="שמירת הדוח כ־CSV (לגיליון)" aria-label="שמירת הדוח כ־CSV">
          <Icon name="fl_arrow_download" size={18} />
        </button>
        <button class="icon-btn" onClick={() => store.quality.saveHtmlReport()} title="שמירת דוח מלא כדף HTML: לשמירה, להדפסה או לשליחה (נפתח בכל דפדפן, בלי רשת)" aria-label="שמירת הדוח כ־HTML">
          <Icon name="oz_document_text" size={18} />
        </button>
      </div>
      <div class="filters">
        {(["all", "error", "warning", "info"] as const).map((k) =>
          k === "all" || report.bySeverity[k] ? (
            <button key={k} class="chip" aria-pressed={sev === k} onClick={() => (setSev(k), setShown(PAGE))}>
              {k === "all" ? "כל החומרות" : SEV_LABEL[k]} {k !== "all" && <span class="count">{report.bySeverity[k].toLocaleString("he")}</span>}
            </button>
          ) : null,
        )}
      </div>
      <div class="filters" style="padding-top:0">
        <button class="chip" aria-pressed={cat === "all"} onClick={() => setCat("all")}>כל הסוגים</button>
        {(Object.keys(report.byCategory) as QaCategory[]).map((k) => (
          <button key={k} class="chip" aria-pressed={cat === k} onClick={() => (setCat(k), setShown(PAGE))} title={QA_CATEGORIES[k].hint}>
            {QA_CATEGORIES[k].title} <span class="count">{report.byCategory[k]!.toLocaleString("he")}</span>
          </button>
        ))}
      </div>
      {dups.length > 0 && (cat === "all" || cat === "duplicate") && (
        <div class="bulk">
          <button class="btn tonal" onClick={() => (store.deleteLinks(dups), void store.quality.run())} title="משאיר את הראשון מכל קבוצה">
            <Icon name="oz_link_delete" size={18} />
            מחיקת {dups.length.toLocaleString("he")} העתקים כפולים
          </button>
        </div>
      )}
      {report.issues.length === 0 ? (
        <div class="empty">
          <Icon name="fl_checkmark_circle" size={40} />
          <span>לא נמצאו בעיות. אפשר לייצא.</span>
        </div>
      ) : (
        <ul class="problems" style="padding:0 6px 8px">
          {rows.slice(0, shown).map((i, k) => (
            <li key={`${i.link.id}:${i.problem.code}:${k}`} class={i.problem.severity} style="cursor:pointer" onClick={() => store.revealLink(i.link)}>
              <Icon name={i.problem.severity === "error" ? "fl_error_circle" : i.problem.severity === "warning" ? "fl_warning" : "fl_info"} size={16} />
              <span class="grow">
                <b>
                  {i.link.source.book.title} {i.link.source.line + 1} ← {i.link.heRef2 || i.link.target.book.title}
                </b>
                <br />
                {i.problem.message}
              </span>
              <span onClick={(e) => e.stopPropagation()} style="display:flex">
                <button class="icon-btn" title="תיקון בבונה" aria-label="תיקון" onClick={() => (store.editInBuilder(i.link.id), (store.sideTab.value = "builder"))}>
                  <Icon name="oz_link_edit" size={16} />
                </button>
                <button class="icon-btn" title="מחיקת הקישור" aria-label="מחיקה" onClick={() => store.deleteLinks([i.link.id])}>
                  <Icon name="oz_link_delete" size={16} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {rows.length > shown && (
        <div style="padding:8px;text-align:center">
          <button class="btn outlined" onClick={() => setShown(shown + PAGE)}>הצגת עוד ({(rows.length - shown).toLocaleString("he")})</button>
        </div>
      )}
    </>
  );
}
