import { useMemo, useState } from "preact/hooks";
import { parseConnectionType, TYPE_LABELS } from "../../core/links/connection-type";
import type { Link, LinkStatus } from "../../core/links/model";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { DbLinksPanel } from "./db-links-panel";

/*
 * Every link of the project, filterable by status and book, with jump/edit/delete. Long lists are
 * rendered in pages so a 30k-link import stays responsive.
 */
const STATUS_LABEL: Record<LinkStatus, string> = { new: "חדש", edited: "ערוך", existing: "מקורי", deleted: "יימחק" };
/** a link copied from the database says so, instead of a plain "new" */
const statusLabel = (l: Link) => (l.provenance === "db-copy" && l.status === "new" ? "הועתק מהמסד" : STATUS_LABEL[l.status]);
const PAGE = 300;

/** The links tab: the project's links, or the links the open database already has (stage 10). */
export function LinksPanel() {
  const store = useStore();
  const tab = store.dbLinks.tab.value;
  return (
    <>
      <div class="filters" role="tablist" aria-label="אילו קישורים">
        <button role="tab" class="chip" aria-selected={tab === "project"} aria-pressed={tab === "project"} onClick={() => (store.dbLinks.tab.value = "project")}>
          <Icon name="oz_links" size={14} /> קישורי הפרויקט <span class="count">{store.allLinks.value.length.toLocaleString("he")}</span>
        </button>
        <button role="tab" class="chip" aria-selected={tab === "db"} aria-pressed={tab === "db"} onClick={() => (store.dbLinks.tab.value = "db")} title="הקישורים שכבר יש במסד הפתוח לספר שבקורא — לקריאה, לבדיקה ולהעתקה לפרויקט">
          <Icon name="oz_library_link" size={14} /> קישורים מהמסד
        </button>
      </div>
      {tab === "db" ? <DbLinksPanel /> : <ProjectLinksPanel />}
    </>
  );
}

function ProjectLinksPanel() {
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

  const altToc = store.altToc.count.value;
  const altTocButton = (
    <button class="btn text" onClick={() => (store.dialog.value = "alt-toc")} title="חלוקה שנייה של ספר לצד תוכן העניינים הרגיל (פרשות ועליות, ימי לימוד…) — נכתבת לקובץ alt_toc">
      <Icon name="oz_text_bullet_list_tree" size={16} />
      מבני כותרות{altToc ? ` (${altToc.toLocaleString("he")})` : ""}
    </button>
  );

  if (!all.length)
    return (
      <>
        <div class="bulk" style="padding:6px 6px 0">{altTocButton}</div>
        <div class="empty">
          <Icon name="oz_links" size={40} />
          <span>עדיין אין קישורים בפרויקט. צרו קישור בבונה, או גררו לכאן קובץ ‎_links.json קיים כדי לערוך אותו.</span>
        </div>
      </>
    );

  return (
    <>
      <div class="bulk" style="padding:6px 6px 0">
        <button class="btn text" onClick={() => (store.dialog.value = "relink")} title="כשספר השתנה (שורות נוספו, נמחקו או נערכו) — מעבירים את הקישורים למהדורה החדשה">
          <Icon name="oz_text_compare" size={16} />
          מעבר למהדורה חדשה של ספר
        </button>
        {altTocButton}
      </div>
      <FillRanges />
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

/**
 * Range completion (v3 F-084/F-105): every link of a book on one side runs until one line before the
 * next link (the last one to the end of the book). One undoable step; the rule is linking/ranges.ts.
 */
function FillRanges() {
  const store = useStore();
  const books = [store.view.source.value, store.view.target.value].filter((k, i, a): k is string => !!k && a.indexOf(k) === i);
  const [bookKey, setBookKey] = useState<string>("");
  const [side, setSide] = useState<"source" | "target">("source");
  const [onlyRanged, setOnlyRanged] = useState(true);
  const key = books.includes(bookKey) ? bookKey : books[0];
  if (!key) return null;
  return (
    <details class="held" style="margin:6px 6px 0">
      <summary>השלמת טווחים</summary>
      <div class="builder" style="padding:6px 0 0">
        <span class="muted">כל טווח נמשך עד שורה אחת לפני תחילת הקישור הבא, והאחרון עד סוף הספר. שורת כותרת אינה סוף טווח. אפשר לבטל ב־Ctrl+Z.</span>
        <label class="field">
          הספר
          <select value={key} onChange={(e) => setBookKey(e.currentTarget.value)}>
            {books.map((k) => (
              <option key={k} value={k}>{store.refOf(k).title}</option>
            ))}
          </select>
        </label>
        <label class="field">
          הספר הוא, בקישורים
          <select value={side} onChange={(e) => setSide(e.currentTarget.value as "source" | "target")}>
            <option value="source">צד המקור</option>
            <option value="target">צד היעד</option>
          </select>
        </label>
        <label class="check">
          <input type="checkbox" checked={onlyRanged} onChange={(e) => setOnlyRanged(e.currentTarget.checked)} />
          <span>רק קישורים שכבר מוגדרים כטווח (בטלו כדי להפוך גם קישורי שורה לטווחים)</span>
        </label>
        <div class="row">
          <button class="btn tonal" disabled={!!store.task.value} onClick={() => void store.ranges.fill(key, side, onlyRanged)}>השלמה</button>
        </div>
      </div>
    </details>
  );
}

export function LinkItem({ l }: { l: Link }) {
  const store = useStore();
  const type = parseConnectionType(l.declaredType);
  const where = (line: number, end?: number) => (end !== undefined ? `${line + 1}–${end + 1}` : `${line + 1}`);
  return (
    <li class={`link-item${l.status === "deleted" ? " deleted" : ""}`} onClick={() => store.revealLink(l)} title="הצגת שני צדי הקישור">
      <div class="ends">
        <span class={`status ${l.status}`} title={l.provenance === "db-copy" ? "קישור שהועתק מהמסד ושוחזר ממנו לקובץ קישורים. אפשר לערוך ולייצא אותו" : undefined}>{statusLabel(l)}</span>
        <span>
          {l.source.book.title} {where(l.source.line, l.source.end)}
        </span>
        <Icon name="oz_link" size={14} />
        <span>
          {l.heRef2 || l.target.book.title} <span class="muted">({where(l.target.line, l.target.end)})</span>
        </span>
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
