import { parseConnectionType, TYPE_LABELS } from "../../core/links/connection-type";
import type { Link } from "../../core/links/model";
import { CONFIDENCE_LABELS, ENGINES } from "../../linking/automatic";
import type { RowStatus, TableRow } from "../../state/links-table";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { activatable } from "../keyboard";

/*
 * One row of a links list: the project's links table (links-panel.tsx), the database's links
 * (db-links-panel.tsx) and the builder. Its own module so the two panels do not import each other.
 */
export const STATUS_LABEL: Record<RowStatus, string> = { pending: "ממתינה", new: "חדש", edited: "ערוך", existing: "מקורי", deleted: "יימחק" };
/** a link copied from the database says so, instead of a plain "new" */
const statusLabel = (l: Link) => (l.provenance === "db-copy" && l.status === "new" ? "הועתק מהמסד" : STATUS_LABEL[l.status]);

/**
 * One link (in the table: with a check box, its engine, confidence and problem; positioned at `top`).
 * Two lines (V5 UX audit U17, the owner's choice A): the source with its line, then "← the target" —
 * both names nearly whole in a narrow panel. The type, the method and the rest of the details are the
 * row's tooltip (and the table's filters); a problem stays on the row.
 */
export function LinkItem({ l, row, top, selected, onSelect }: { l: Link; row?: TableRow; top?: number; selected?: boolean; onSelect?: () => void }) {
  const store = useStore();
  const type = parseConnectionType(l.declaredType);
  const where = (line: number, end?: number) => (end !== undefined ? `${line + 1}–${end + 1}` : `${line + 1}`);
  const pending = row?.status === "pending";
  const details = [
    `${TYPE_LABELS[type.type].he}${type.known ? "" : " (סוג לא מוכר)"}`,
    l.anchor && "עם עוגן",
    l.ref2,
    row?.engine && `${ENGINES.find((e) => e.id === row.engine)?.title ?? row.engine}${row.confidence ? ` (${CONFIDENCE_LABELS[row.confidence]})` : ""}`,
    l.origins && `מ־${l.origins.join(", ")}`,
  ].filter(Boolean);
  return (
    <li class={`link-item${l.status === "deleted" ? " deleted" : ""}`} style={top === undefined ? undefined : `top:${top}px`} {...activatable(() => store.revealLink(l))} title={`${details.join(" · ")}
לחיצה: הצגת שני צדי הקישור`}>
      <div class="ends">
        {onSelect && <input type="checkbox" checked={selected} onClick={(e) => e.stopPropagation()} onChange={onSelect} aria-label="בחירה" />}
        <span class={`status ${pending ? "new" : l.status}`} title={l.provenance === "db-copy" ? "קישור שהועתק מהמסד ושוחזר ממנו לקובץ קישורים. אפשר לערוך ולייצא אותו" : undefined}>{pending ? STATUS_LABEL.pending : statusLabel(l)}</span>
        {/* in the narrow row the name shortens, never the line number (V5 UX audit) */}
        <span class="end">
          <span class="t">{l.source.book.title}</span> {where(l.source.line, l.source.end)}
        </span>
      </div>
      <div class="ends to">
        <span class="arrow" aria-hidden="true">←</span>
        <span class="end">
          <span class="t">{l.heRef2 || l.target.book.title}</span> <span class="muted">({where(l.target.line, l.target.end)})</span>
        </span>
        {/* for a screen reader the details are words, not only a tooltip */}
        <span class="sr-only">{details.join(", ")}</span>
        {row?.problem && <span class={`lt-${row.problem}`}>{row.problem === "error" ? "שגיאה" : "אזהרה"}</span>}
      </div>
      {/* where a continuation was inherited from (#44), and its cancel: one undoable step */}
      {l.continued && l.status !== "deleted" && (
        <div class="continued" onClick={(e) => e.stopPropagation()}>
          {l.continued.kind === "copy" ? `הועתק מהקטע הקודם (שורה ${l.continued.fromLine + 1})` : `הטווח הורחב כהמשך של שורה ${l.continued.fromLine + 1}`}{" "}
          <button class="adv-link" onClick={() => store.ranges.cancelContinuation([l.id])}>ביטול ההמשך</button>
        </div>
      )}
      <div class="acts" onClick={(e) => e.stopPropagation()}>
        {pending ? null : l.status === "deleted" ? (
          <button class="icon-btn" onClick={() => store.restoreLinks([l.id])} title="שחזור" aria-label="שחזור">
            <Icon name="fl_arrow_undo" size={18} />
          </button>
        ) : (
          <>
            <button class="icon-btn" onClick={() => (store.editInBuilder(l.id), (store.sideTab.value = "builder"))} title="עריכה בבונה" aria-label="עריכה">
              <Icon name="oz_link_edit" size={18} />
            </button>
            <button class="icon-btn" onClick={() => store.deleteLinks([l.id])} title="מחיקה" aria-label="מחיקה">
              <Icon name="oz_link_delete" size={18} />
            </button>
          </>
        )}
      </div>
    </li>
  );
}
