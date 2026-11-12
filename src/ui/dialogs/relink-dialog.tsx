import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { RelinkPlan, RelinkVerdict } from "../../linking/relink";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { EditionDiffView } from "./edition-diff";
import { ltr } from "../shell/file-name";

/*
 * Moving links to a new edition of a book (stage 11). The user opens the old and the new edition,
 * the tool aligns their lines and proposes where every link goes. Certain moves can be applied in
 * one step; edited lines are reviewed one by one; links whose line is gone are only listed.
 * A second view shows the two editions line by line (edition-diff.tsx), and the line mapping
 * old → new can be saved as CSV (linking/edition-map.ts).
 */
const VERDICT: Record<RelinkVerdict, { title: string; cls: string }> = {
  certain: { title: "בטוח", cls: "info" },
  review: { title: "לבדיקה", cls: "warning" },
  lost: { title: "השורה נמחקה", cls: "error" },
};

export function RelinkDialog({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const ref = useRef<HTMLDialogElement>(null);
  const books = [...store.books.value.values()];
  const withLinks = useMemo(() => books.filter((b) => store.linksOfBook(b.key).length > 0), [books]);
  const [oldKey, setOld] = useState(withLinks[0]?.key ?? "");
  const [newKey, setNew] = useState(() => books.find((b) => b.key !== oldKey && b.title === store.refOf(oldKey).title)?.key ?? "");
  const [filter, setFilter] = useState<RelinkVerdict>("review");
  const [view, setView] = useState<"links" | "lines">("links");
  const r = store.relink.value;
  const fresh = r && r.oldKey === oldKey && r.newKey === newKey ? r : null;

  useEffect(() => ref.current?.showModal(), []);

  return (
    <dialog ref={ref} class="relink" onClose={onClose} aria-labelledby="relink-title">
      <div class="dlg">
        <header>
          <Icon name="oz_text_compare" size={24} />
          <h2 id="relink-title">העברת קישורים למהדורה חדשה של ספר</h2>
        </header>
        <div class="body">
          <p class="muted" style="margin:0">
            פתחו את שתי המהדורות (הישנה, שאליה מצביעים הקישורים, והחדשה). הכלי משווה ביניהן שורה־שורה ומציע לאן כל קישור עובר. קישור לא זז בלי ודאות.
          </p>
          <label class="field">
            המהדורה הישנה (שבה הקישורים)
            <select value={oldKey} onChange={(e) => setOld(e.currentTarget.value)}>
              <option value="">בחרו ספר…</option>
              {withLinks.map((b) => (
                <option key={b.key} value={b.key}>{b.title} — {ltr(b.path ?? store.sources.value.find((s) => b.key.startsWith(`${s.info.id}:`))?.info.label ?? b.key)}</option>
              ))}
            </select>
          </label>
          <label class="field">
            המהדורה החדשה
            <select value={newKey} onChange={(e) => setNew(e.currentTarget.value)}>
              <option value="">בחרו ספר…</option>
              {books.filter((b) => b.key !== oldKey).map((b) => (
                <option key={b.key} value={b.key}>{b.title} — {ltr(b.path ?? store.sources.value.find((s) => b.key.startsWith(`${s.info.id}:`))?.info.label ?? b.key)}</option>
              ))}
            </select>
          </label>
          <div class="row">
            <button class="btn tonal" disabled={!oldKey || !newKey || !!store.task.value} onClick={() => void store.planRelinkFor(oldKey, newKey)}>
              <Icon name="oz_text_compare" size={18} />
              השוואה
            </button>
          </div>
          {fresh && (
            <>
              <div class="stats">
                <div class="stat"><b>{fresh.plan.counts.certain.toLocaleString("he")}</b><span class="muted">יעברו בבטחה</span></div>
                <div class="stat"><b>{fresh.plan.counts.review.toLocaleString("he")}</b><span class="muted">לבדיקה</span></div>
                <div class={`stat${fresh.plan.counts.lost ? " bad" : ""}`}><b>{fresh.plan.counts.lost.toLocaleString("he")}</b><span class="muted">השורה נמחקה</span></div>
                <div class="stat"><b>{(fresh.stats.inserted ?? 0).toLocaleString("he")}</b><span class="muted">שורות חדשות</span></div>
              </div>
              <div class="row">
                <div class="filters" style="padding:0">
                  <button class="chip" aria-pressed={view === "links"} onClick={() => setView("links")}>הקישורים</button>
                  <button class="chip" aria-pressed={view === "lines"} onClick={() => setView("lines")}>השוואת השורות</button>
                </div>
                <button class="btn text" onClick={() => store.saveLineMapping()} title="כל שורה במהדורה הישנה ומספרה במהדורה החדשה, עם המצב שלה">
                  <Icon name="fl_arrow_download" size={18} />
                  שמירת מיפוי השורות (CSV)
                </button>
              </div>
              {view === "lines" && <EditionDiffView oldKey={oldKey} newKey={newKey} rows={fresh.rows} />}
              {view === "links" && <PlanList plan={fresh.plan} filter={filter} setFilter={setFilter} />}
            </>
          )}
        </div>
        <footer>
          <button class="btn text" onClick={() => ref.current?.close()}>סגירה</button>
          <button
            class="btn filled"
            disabled={!fresh || !fresh.plan.counts.certain}
            onClick={() => {
              const n = store.applyRelink(fresh!.plan.items.filter((i) => i.verdict === "certain"));
              store.notify("success", `${n.toLocaleString("he")} קישורים הועברו למהדורה החדשה (Ctrl+Z מבטל).`);
              void store.planRelinkFor(oldKey, newKey);
            }}
          >
            <Icon name="oz_link_check" size={18} />
            העברת הבטוחים ({fresh?.plan.counts.certain.toLocaleString("he") ?? 0})
          </button>
        </footer>
      </div>
    </dialog>
  );
}

/** The links of the plan, one verdict at a time; an item for review can be moved on its own. */
function PlanList({ plan, filter, setFilter }: { plan: RelinkPlan; filter: RelinkVerdict; setFilter: (v: RelinkVerdict) => void }) {
  const store = useStore();
  return (
    <>
      <div class="filters" style="padding:0">
        {(["review", "lost", "certain"] as const).map((v) => (
          <button key={v} class="chip" aria-pressed={filter === v} onClick={() => setFilter(v)}>
            {VERDICT[v].title} <span class="count">{plan.counts[v]}</span>
          </button>
        ))}
      </div>
      <ul class="problems">
        {plan.items.filter((i) => i.verdict === filter).slice(0, 300).map((i) => (
          <li key={i.link.id} class={VERDICT[i.verdict].cls}>
            <span class="grow">
              <b>{i.link.source.book.title} {i.link.source.line + 1} ← {i.link.heRef2}</b>
              <br />
              {i.reasons.join(" ")}
            </span>
            {i.moved && i.verdict === "review" && (
              <button class="btn text" onClick={() => store.applyRelink([i])}>העברה</button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
