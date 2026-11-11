import { useMemo, useState } from "preact/hooks";
import { parseConnectionType, TYPE_LABELS } from "../../core/links/connection-type";
import type { Link, LinkStatus } from "../../core/links/model";
import { useStore } from "../context";
import { Icon } from "../icons/icon";

/*
 * Every link of the project, filterable by status and book, with jump/edit/delete. Long lists are
 * rendered in pages so a 30k-link import stays responsive.
 */
const STATUS_LABEL: Record<LinkStatus, string> = { new: "חדש", edited: "ערוך", existing: "מקורי", deleted: "יימחק" };
const PAGE = 300;

export function LinksPanel() {
  const store = useStore();
  const [status, setStatus] = useState<LinkStatus | "all">("all");
  const [onlyBook, setOnlyBook] = useState(true);
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const all = store.allLinks.value;
  const book = store.view.source.value;

  const filtered = useMemo(() => {
    const needle = q.trim();
    return all
      .filter((l) => status === "all" || l.status === status)
      .filter((l) => !onlyBook || !book || store.sameBook(l.source.book, book) || store.sameBook(l.target.book, book))
      .filter((l) => !needle || l.heRef2.includes(needle) || l.source.book.title.includes(needle) || l.target.book.title.includes(needle))
      .sort((a, b) => a.source.book.title.localeCompare(b.source.book.title, "he") || a.source.line - b.source.line);
  }, [all, status, onlyBook, book, q]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: all.length };
    for (const l of all) c[l.status] = (c[l.status] ?? 0) + 1;
    return c;
  }, [all]);

  if (!all.length)
    return (
      <div class="empty">
        <Icon name="oz_links" size={40} />
        <span>עדיין אין קישורים בפרויקט. צרו קישור בבונה, או גררו לכאן קובץ ‎_links.json קיים כדי לערוך אותו.</span>
      </div>
    );

  return (
    <>
      <div class="filters">
        {(["all", "new", "edited", "existing", "deleted"] as const).map((s) =>
          s === "all" || counts[s] ? (
            <button key={s} class="chip" aria-pressed={status === s} onClick={() => (setStatus(s), setShown(PAGE))}>
              {s === "all" ? "הכול" : STATUS_LABEL[s]} <span class="count">{(counts[s] ?? 0).toLocaleString("he")}</span>
            </button>
          ) : null,
        )}
        {book && (
          <button class="chip" aria-pressed={onlyBook} onClick={() => setOnlyBook(!onlyBook)} title="רק קישורים של ספר המקור המוצג">
            רק הספר המוצג
          </button>
        )}
        <input type="search" placeholder="חיפוש בשמות ובמקומות…" value={q} onInput={(e) => setQ(e.currentTarget.value)} style="margin-top:4px" />
      </div>
      <ul class="link-list">
        {filtered.slice(0, shown).map((l) => (
          <LinkItem key={l.id} l={l} />
        ))}
      </ul>
      {filtered.length > shown && (
        <div style="padding:8px;text-align:center">
          <button class="btn outlined" onClick={() => setShown(shown + PAGE)}>
            הצגת עוד ({(filtered.length - shown).toLocaleString("he")} נותרו)
          </button>
        </div>
      )}
      {!filtered.length && <p class="empty">אין קישורים שמתאימים לסינון.</p>}
    </>
  );
}

export function LinkItem({ l }: { l: Link }) {
  const store = useStore();
  const type = parseConnectionType(l.declaredType);
  const where = (line: number, end?: number) => (end !== undefined ? `${line + 1}–${end + 1}` : `${line + 1}`);
  return (
    <li class={`link-item${l.status === "deleted" ? " deleted" : ""}`} onClick={() => store.revealLink(l)} title="הצגת שני צדי הקישור">
      <div class="ends">
        <span class={`status ${l.status}`}>{STATUS_LABEL[l.status]}</span>
        <span>
          {l.source.book.title} {where(l.source.line, l.source.end)}
        </span>
        <Icon name="oz_link" size={14} />
        <span>{l.heRef2 || `${l.target.book.title} ${where(l.target.line, l.target.end)}`}</span>
      </div>
      <div class="acts" onClick={(e) => e.stopPropagation()}>
        {l.status === "deleted" ? (
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
      <div class="muted">
        {TYPE_LABELS[type.type].he}
        {!type.known && " (סוג לא מוכר)"}
        {l.anchor && " · עם עוגן"}
        {l.ref2 && ` · ${l.ref2}`}
      </div>
    </li>
  );
}
