import { useEffect, useRef, useState } from "preact/hooks";
import type { SefariaCsvFile } from "../../formats/sefaria-csv/write";
import type { ExportBundle } from "../../state/store";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { DbCopyFiles } from "./db-copy-files";

/*
 * The confirmation before export (plan, "three extra decisions" §3): in plain words, what will be
 * written, what is held back and why, and which library files would be replaced. Nothing is written
 * until the user confirms. More than one file downloads as a ZIP laid out like the library (links/,
 * alt_toc/) with `_report.txt`; advanced mode can write the links as CSV in Sefaria's layout instead.
 */
export function ExportDialog({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const ref = useRef<HTMLDialogElement>(null);
  const [plan, setPlan] = useState<ExportBundle | null>(null);
  const [failed, setFailed] = useState(false);
  const [format, setFormat] = useState<"json" | "sefaria-csv">("json");
  const [csv, setCsv] = useState<SefariaCsvFile[] | null>(null);
  const advanced = store.prefs.advanced.value;

  const replan = () => void store.prepareExport().then((p) => (p ? (setPlan(p), setCsv(null)) : setFailed(true)));
  useEffect(() => {
    ref.current?.showModal();
    replan();
  }, []);

  useEffect(() => {
    if (format !== "sefaria-csv" || !plan || csv) return;
    void store.prepareSefariaCsv(plan).then((f) => (f ? setCsv(f) : setFormat("json")));
  }, [format, plan]);

  const c = plan?.counts;
  const asCsv = format === "sefaria-csv";
  const alt = plan?.altToc;
  const outputs = plan ? (asCsv ? (csv?.length ?? 0) : plan.files.length) + (alt?.files.length ?? 0) : 0;
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="export-title">
      <div class="dlg">
        <header>
          <Icon name="oz_link_download" size={24} />
          <h2 id="export-title">ייצוא קובצי קישורים</h2>
        </header>
        <div class="body">
          {!plan && !failed && <p>בודק את כל הקישורים מול הספרים…</p>}
          {failed && <p>הבדיקה לא הושלמה, ולכן לא ייצאתי כלום.</p>}
          {plan && c && (
            <>
              <div class="stats">
                {/* only the numbers that say something (UX review suggestion 4) */}
                {c.new > 0 && <Stat n={c.new} label="קישורים חדשים" />}
                {c.edited > 0 && <Stat n={c.edited} label="קישורים ערוכים" />}
                {c.kept > 0 && <Stat n={c.kept} label="נשמרים כמו שהם" />}
                {c.deleted > 0 && <Stat n={c.deleted} label="יימחקו מהקובץ" />}
                {c.heldBack > 0 && <Stat n={c.heldBack} label="לא ייוצאו (שגיאה)" bad />}
                <Stat n={c.files} label="קבצים" />
                {alt && alt.files.length > 0 && <Stat n={alt.files.reduce((n, f) => n + f.structures, 0)} label="מבני כותרות" />}
                {alt && alt.heldBack.length > 0 && <Stat n={alt.heldBack.length} label="ספרים שמבני הכותרות שלהם לא ייוצאו" bad />}
              </div>
              <label style="display:grid;gap:4px">
                <span class="muted">הייצוא מיועד ל…</span>
                <select
                  value={store.exportPurpose.value}
                  onChange={(e) => ((store.exportPurpose.value = e.currentTarget.value as "submission" | "private"), replan())}
                  aria-label="למה מיועד הייצוא"
                  title={`ספרי ספריא נקבעים לפי ${store.sefariaTitles.value.label}`}
                >
                  <option value="submission">שליחה לספריית אוצריא (מומלץ): כללי הסנכרון של הספרייה מחייבים</option>
                  <option value="private">שימוש פרטי: חסר ref_1/ref_2 או טווח בספר ספריא — רק אזהרה</option>
                </select>
              </label>
              {advanced && (
                <label style="display:grid;gap:4px">
                  <span class="muted">פורמט קובצי הקישורים</span>
                  <select value={format} onChange={(e) => setFormat(e.currentTarget.value as "json" | "sefaria-csv")} aria-label="פורמט קובצי הקישורים">
                    <option value="json">‎_links.json לספריית אוצריא (מומלץ)</option>
                    <option value="sefaria-csv">CSV בפורמט ספריא (בלי טווחים ועוגנים)</option>
                  </select>
                </label>
              )}
              {asCsv && !csv && <p class="muted">קורא את כותרות הספרים כדי לבנות מראי מקום…</p>}
              {asCsv && csv && (
                <>
                  <h3 style="margin:4px 0 0">קובצי CSV בפורמט ספריא</h3>
                  <ul class="files">
                    {csv.map((f) => (
                      <li key={f.name}>
                        <Icon name="oz_document_links" size={18} />
                        <span class="grow">{f.name}</span>
                        <span class="muted">{f.rows.toLocaleString("he")} שורות</span>
                      </li>
                    ))}
                  </ul>
                  <p class="muted" style="margin:0">הקבצים האלה מיועדים לספריא, לא לספריית אוצריא: אין בהם טווחים ועוגני מילה.</p>
                </>
              )}
              {!asCsv && plan.files.length > 0 && (
                <>
                  <h3 style="margin:4px 0 0">הקבצים שייווצרו</h3>
                  <ul class="files">
                    {plan.files.map((f) => (
                      <li key={f.name}>
                        <Icon name="oz_document_links" size={18} />
                        <span class="grow">{f.name}</span>
                        <span class="muted">{f.records.toLocaleString("he")} רשומות</span>
                        {f.isNewFile && <span class="status edited">קובץ חדש</span>}
                      </li>
                    ))}
                  </ul>
                  {plan.files.some((f) => f.isNewFile) && (
                    <p class="muted" style="margin:0">
                      לספרים שמסומנים "קובץ חדש" לא יובא קובץ קישורים קיים. אם בספרייה כבר יש להם קובץ, ייבאו אותו קודם — אחרת הקובץ החדש יחליף אותו והקישורים הישנים יאבדו.
                    </p>
                  )}
                </>
              )}
              <DbCopyFiles plan={plan} onChange={replan} />
              {alt && alt.files.length > 0 && (
                <>
                  <h3 style="margin:4px 0 0">מבני כותרות (alt_toc)</h3>
                  <ul class="files">
                    {alt.files.map((f) => (
                      <li key={f.name}>
                        <Icon name="oz_text_bullet_list_tree" size={18} />
                        <span class="grow">alt_toc/{f.name}</span>
                        <span class="muted">{f.clears ? "ריק: מוחק את המבנים מהספרייה" : `${f.structures} מבנים, ${f.nodes.toLocaleString("he")} צמתים`}</span>
                        {f.problems.some((p) => p.severity === "warning") && (
                          <span class="status edited" title={f.problems.filter((p) => p.severity === "warning").map((p) => p.message).join("\n")}>
                            אזהרה
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {alt && alt.heldBack.length > 0 && (
                <details class="held" open>
                  <summary>מבני הכותרות של {alt.heldBack.length} ספרים לא ייוצאו, ולמה</summary>
                  <ul class="problems" style="margin-top:8px">
                    {alt.heldBack.map((b) => (
                      <li key={b.title} class="error" style="cursor:pointer" onClick={() => ((store.dialog.value = "alt-toc"), ref.current?.close())}>
                        <span>
                          <b>{b.title}</b>: {b.problems.filter((p) => p.severity === "error").slice(0, 5).map((p) => p.message).join(" ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {plan.heldBack.length > 0 && (
                <details class="held" open={plan.heldBack.length <= 5}>
                  <summary>{plan.heldBack.length} קישורים לא ייוצאו, ולמה</summary>
                  <ul class="problems" style="margin-top:8px">
                    {plan.heldBack.slice(0, 200).map(({ link, problems }) => (
                      <li key={link.id} class="error" style="cursor:pointer" onClick={() => (store.revealLink(link), ref.current?.close())}>
                        <span>
                          <b>{link.source.book.title} {link.source.line + 1} → {link.heRef2}</b>: {problems.filter((p) => p.severity === "error").map((p) => p.message).join(" ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {plan.warned.length > 0 && (
                <details class="held">
                  <summary>{plan.warned.length} קישורים ייוצאו עם אזהרה</summary>
                  <ul class="problems" style="margin-top:8px">
                    {plan.warned.slice(0, 200).map(({ link, problems }) => (
                      <li key={link.id} class="warning">
                        <span>
                          <b>{link.source.book.title} {link.source.line + 1} → {link.heRef2}</b>: {problems.filter((p) => p.severity !== "info").map((p) => p.message).join(" ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {outputs === 0 && !(asCsv && !csv) && <p>אין מה לייצא: אין קישורים או מבני כותרות שנוצרו או יובאו (קישורים מתוך מסד אינם נכתבים לקובץ).</p>}
            </>
          )}
        </div>
        <footer>
          <button class="btn text" style="margin-inline-end:auto" disabled={!plan || (asCsv && !csv)} onClick={() => plan && store.saveReport(plan, asCsv ? csv ?? undefined : undefined)} title="סיכום בטקסט: כמה נכתב, לאן כל קובץ הולך, מה לא ייוצא ולמה. הוא נכלל גם בכל ZIP">
            הורדת הדוח (_report.txt)
          </button>
          <button class="btn text" onClick={() => ref.current?.close()}>סגירה</button>
          <button
            class="btn filled"
            disabled={!plan || outputs === 0 || (asCsv && !csv)}
            onClick={() => {
              if (plan) store.saveExport(plan, asCsv ? csv ?? undefined : undefined);
              ref.current?.close();
            }}
          >
            <Icon name="fl_arrow_download" size={18} />
            {outputs > 1 ? "הורדת ZIP" : "הורדת הקובץ"}
          </button>
        </footer>
      </div>
    </dialog>
  );
}

function Stat({ n, label, bad }: { n: number; label: string; bad?: boolean }) {
  return (
    <div class={`stat${bad ? " bad" : ""}`}>
      <b>{n.toLocaleString("he")}</b>
      <span class="muted">{label}</span>
    </div>
  );
}
