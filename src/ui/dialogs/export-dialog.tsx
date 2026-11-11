import { useEffect, useRef, useState } from "preact/hooks";
import type { ExportPlan } from "../../formats/links-json/export";
import { useStore } from "../context";
import { Icon } from "../icons/icon";

/*
 * The confirmation before export (plan, "three extra decisions" §3): in plain words, what will be
 * written, what is held back and why, and which library files would be replaced. Nothing is written
 * until the user confirms.
 */
export function ExportDialog({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const ref = useRef<HTMLDialogElement>(null);
  const [plan, setPlan] = useState<ExportPlan | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
    void store.prepareExport().then((p) => (p ? setPlan(p) : setFailed(true)));
  }, []);

  const c = plan?.counts;
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
                <Stat n={c.new} label="קישורים חדשים" />
                <Stat n={c.edited} label="קישורים ערוכים" />
                <Stat n={c.kept} label="נשמרים כמו שהם" />
                <Stat n={c.deleted} label="יימחקו מהקובץ" />
                <Stat n={c.heldBack} label="לא ייוצאו (שגיאה)" bad={c.heldBack > 0} />
                <Stat n={c.files} label="קבצים" />
              </div>
              {plan.files.length > 0 && (
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
              {plan.files.length === 0 && <p>אין מה לייצא: אין קישורים שנוצרו או יובאו (קישורים מתוך מסד אינם נכתבים לקובץ).</p>}
            </>
          )}
        </div>
        <footer>
          <button class="btn text" onClick={() => ref.current?.close()}>סגירה</button>
          <button
            class="btn filled"
            disabled={!plan || plan.files.length === 0}
            onClick={() => {
              if (plan) store.saveExport(plan);
              ref.current?.close();
            }}
          >
            <Icon name="fl_arrow_download" size={18} />
            {plan && plan.files.length > 1 ? "הורדת ZIP" : "הורדת הקובץ"}
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
