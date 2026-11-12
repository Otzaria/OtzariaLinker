import { useEffect, useRef, useState } from "preact/hooks";
import type { SefariaCsvFile } from "../../formats/sefaria-csv/write";
import { qaAction } from "../../linking/qa";
import type { ExportBundle } from "../../state/exchange";
import type { AppStore } from "../../state/store";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { DbCopyFiles } from "./db-copy-files";
import { FileName, ltr } from "../shell/file-name";

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
  /** what was downloaded: the dialog stays open on "what now?" (audit F13) */
  const [saved, setSaved] = useState<string | null>(null);
  const advanced = store.prefs.advanced.value;

  const replan = () => void store.exchange.prepareExport().then((p) => (p ? (setPlan(p), setCsv(null)) : setFailed(true)));
  useEffect(() => {
    ref.current?.showModal();
    replan();
  }, []);

  useEffect(() => {
    if (format !== "sefaria-csv" || !plan || csv) return;
    void store.exchange.prepareSefariaCsv(plan).then((f) => (f ? setCsv(f) : setFormat("json")));
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
        {saved && plan ? (
          <>
            <div class="body">
              <p class="saved-note">
                <Icon name="fl_checkmark_circle" size={18} />
                <span>{saved}</span>
              </p>
              <h3 style="margin:0">מה עכשיו?</h3>
              <NextSteps routes={store.exchange.nextSteps(plan, asCsv ? csv ?? undefined : undefined)} open />
            </div>
            <footer>
              <button class="btn text" style="margin-inline-end:auto" onClick={() => store.exchange.saveReport(plan, asCsv ? csv ?? undefined : undefined)}>
                <span>הורדת הדוח (<bdi dir="ltr">_report.txt</bdi>)</span>
              </button>
              <button class="btn filled" onClick={() => ref.current?.close()}>סגירה</button>
            </footer>
          </>
        ) : (
        <>
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
                  <option value="private">{advanced ? "שימוש פרטי: חסר ref_1/ref_2 או טווח בספר ספריא — רק אזהרה" : "שימוש פרטי: ציון ספריא חסר או טווח בספר ספריא — רק אזהרה"}</option>
                </select>
              </label>
              {advanced && (
                <label style="display:grid;gap:4px">
                  <span class="muted">פורמט קובצי הקישורים</span>
                  <select value={format} onChange={(e) => setFormat(e.currentTarget.value as "json" | "sefaria-csv")} aria-label="פורמט קובצי הקישורים">
                    <option value="json">{ltr("_links.json")} לספריית אוצריא (מומלץ)</option>
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
                        <span class="grow"><FileName name={f.name} /></span>
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
                        <span class="grow"><FileName name={f.name} /></span>
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
                        <span class="grow"><FileName name={`alt_toc/${f.name}`} /></span>
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
              {outputs === 0 && !(asCsv && !csv) && <NothingWritten plan={plan} onPrivate={() => ((store.exportPurpose.value = "private"), replan())} />}
              {!(asCsv && !csv) && (
                <details class="next-steps-box">
                  <summary>מה עושים עם הקבצים? (לספרייה, לאוצריא שלכם, למסד אישי)</summary>
                  <NextSteps routes={store.exchange.nextSteps(plan, asCsv ? csv ?? undefined : undefined)} />
                </details>
              )}
            </>
          )}
        </div>
        <footer>
          <button class="btn text" style="margin-inline-end:auto" disabled={!plan || (asCsv && !csv)} onClick={() => plan && store.exchange.saveReport(plan, asCsv ? csv ?? undefined : undefined)} title="סיכום בטקסט: כמה נכתב, לאן כל קובץ הולך, מה לא ייוצא ולמה. הוא נכלל גם בכל ZIP">
            {/* one span: a .btn is a flex row, and loose text and <bdi> would become items with gaps between them */}
            <span>הורדת הדוח (<bdi dir="ltr">_report.txt</bdi>)</span>
          </button>
          <button class="btn text" onClick={() => ref.current?.close()}>סגירה</button>
          <button
            class="btn filled"
            disabled={!plan || outputs === 0 || (asCsv && !csv)}
            onClick={() => {
              if (!plan) return;
              store.exchange.saveExport(plan, asCsv ? csv ?? undefined : undefined);
              setSaved(outputs > 1 ? `ירד קובץ ZIP עם ${outputs.toLocaleString("he")} קבצים ודוח הייצוא.` : "הקובץ ירד.");
            }}
          >
            <Icon name="fl_arrow_download" size={18} />
            {outputs > 1 ? "הורדת ZIP" : "הורדת הקובץ"}
          </button>
        </footer>
        </>
        )}
      </div>
    </dialog>
  );
}

/** Folder and file names in a Hebrew step ("links/", "_links.json") as LTR units: "links/" never reads "/links". */
function withPaths(text: string) {
  return text.split(/([A-Za-z_][\w.-]*\/|‎?_links\.json)/).map((part, i) => (i % 2 ? <bdi key={i} dir="ltr">{part}</bdi> : part));
}

/** The ways back to Otzaria (formats/report/next-steps.ts): one expander per route, the first open when asked. */
export function NextSteps({ routes, open }: { routes: ReturnType<AppStore["exchange"]["nextSteps"]>; open?: boolean }) {
  return (
    <div class="next-steps">
      {routes.map((r, i) => (
        <details key={r.id} open={open && i === 0} data-route={r.id}>
          <summary>{r.title}</summary>
          <ol>
            {r.steps.map((s, n) => (
              <li key={n}>{withPaths(s)}</li>
            ))}
          </ol>
          {r.note && <p class="muted">{r.note}</p>}
        </details>
      ))}
    </div>
  );
}

/**
 * Why nothing will be written. "Nothing to export: no links were made" next to "11 held back" read as
 * a contradiction (product audit F9): when links were held back, say that all of them were, point at
 * the reasons, and offer the switch that releases them when it would.
 */
function NothingWritten({ plan, onPrivate }: { plan: ExportBundle; onPrivate: () => void }) {
  const store = useStore();
  const held = plan.heldBack.length + plan.altToc.heldBack.length;
  if (!held) return <p>אין מה לייצא: אין קישורים או מבני כותרות שנוצרו או יובאו (קישורים מתוך מסד אינם נכתבים לקובץ).</p>;
  const purpose = store.exportPurpose.value;
  const privateHelps = plan.heldBack.some((h) => h.problems.some((p) => qaAction(p, purpose) === "private"));
  return (
    <p role="status">
      {held === 1 ? "הקישור היחיד נעצר" : `כל ${held.toLocaleString("he")} הקישורים נעצרו`}, ולכן אין קובץ לייצא. הסיבה כתובה ליד כל אחד ברשימה שלמעלה.
      {privateHelps && (
        <>
          {" "}
          אם הקישורים לשימוש שלכם ולא לשליחה לספרייה:{" "}
          <button class="btn text small" onClick={onPrivate}>
            ייצוא לשימוש פרטי
          </button>
        </>
      )}
    </p>
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
