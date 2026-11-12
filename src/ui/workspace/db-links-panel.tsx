import { useEffect, useMemo, useState } from "preact/hooks";
import { TYPE_LABELS, parseConnectionType, type ConnectionType } from "../../core/links/connection-type";
import { DB_LINK_ORIGIN_LABELS, dbLinkOrigin, type DbLinkSummary } from "../../core/links/db-links";
import { isRange, type Link } from "../../core/links/model";
import type { Side } from "../../state/store";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { LinkItem } from "./links-panel";
import "./db-links.css";

/*
 * "קישורים מהמסד" in the links tab (stage 10): the links the open database already has for the
 * book shown in a reader — READ-ONLY. Counted by the other book and by type (both are filters),
 * by direction and by the picked line; paged from the worker. A click shows both ends in the
 * readers. "העתקה לפרויקט" turns chosen links into project links that can be edited and exported.
 */
const SIDE_LABEL: Record<Side, string> = { source: "ספר המקור", target: "ספר היעד" };
const BOOK_ROWS = 40;

export function DbLinksPanel() {
  const store = useStore();
  const s = store.dbLinks;
  const side = s.side.value;
  const bookKey = s.bookKey.value;
  const book = bookKey ? store.books.value.get(bookKey) : undefined;
  const summary = s.summary.value;
  const ready = summary && summary.bookKey === bookKey && "total" in summary ? summary : null;
  const query = s.query();
  const queryKey = query ? JSON.stringify(query) : "";

  useEffect(() => {
    if (!bookKey) return;
    if (!summary || summary.bookKey !== bookKey) {
      s.forgetSummary();
      if (s.filter.peek().otherBookKey) s.setFilter({ otherBookKey: undefined });
      void s.loadSummary(bookKey);
    }
  }, [bookKey]);
  useEffect(() => {
    if (ready) void s.loadPage();
  }, [queryKey, ready]);

  if (!s.available) return <p class="empty">הכלי שפתוח כאן אינו יודע לקרוא קישורים ממסד.</p>;

  return (
    <div class="dbl">
      <div class="dbl-head">
        <div class="filters" role="group" aria-label="איזה ספר להציג">
          {(["source", "target"] as const).map((k) => (
            <button key={k} class="chip" aria-pressed={side === k} onClick={() => (s.side.value = k)} disabled={!store.view[k].value}>
              {SIDE_LABEL[k]}
            </button>
          ))}
        </div>
        <span class="dbl-readonly" title="הקישורים שבמסד לא משתנים כאן, והמסד עצמו לא נכתב לעולם. כדי לערוך קישור, העתיקו אותו לפרויקט.">
          <Icon name="fl_database" size={14} />
          קריאה בלבד
        </span>
      </div>
      {!book ? (
        <div class="empty">
          <Icon name="oz_library_link" size={40} />
          <span>פתחו ספר מתוך מסד אוצריא בקורא ה{side === "source" ? "מקור" : "יעד"}, ויוצגו כאן הקישורים שכבר יש לו במסד.</span>
        </div>
      ) : summary && summary.bookKey === bookKey && "reason" in summary ? (
        <div class="empty">
          <Icon name="oz_library_link" size={40} />
          <span>{summary.reason}</span>
          {summary.retry && (
            <button class="btn outlined" onClick={() => void s.loadSummary(book.key)} disabled={!!store.task.value}>
              ניסיון נוסף
            </button>
          )}
        </div>
      ) : !ready ? (
        <p class="empty">קורא את הקישורים של "{book.title}" מהמסד…</p>
      ) : (
        <Loaded summary={ready} />
      )}
    </div>
  );
}

function Loaded({ summary }: { summary: DbLinkSummary }) {
  const store = useStore();
  const advanced = store.prefs.advanced.value;
  const s = store.dbLinks;
  const f = s.filter.value;
  const list = s.list.value;
  const side = s.side.value;
  const [groupBy, setGroupBy] = useState<"book" | "type">("book");
  const selected = s.selected.value;
  const shown = list?.links ?? [];
  const title = store.books.value.get(summary.bookKey)?.title ?? "";

  if (!summary.total)
    return (
      <div class="empty">
        <Icon name="oz_library_link" size={40} />
        <span>במסד אין קישורים לספר "{title}".</span>
      </div>
    );

  const toggleType = (t: ConnectionType) => {
    const cur = new Set(f.types ?? []);
    if (!cur.delete(t)) cur.add(t);
    s.setFilter({ types: cur.size ? [...cur] : undefined });
  };
  const copy = (links: Link[]) => void s.adopt(links);
  const pick = store.pick[side].value;
  // only what copying can make something of (whyNotCopyable: the row's button says the same)
  const copyable = shown.filter((l) => !s.whyNotCopyable(l));

  return (
    <>
      <p class="dbl-sum">
        <b>{summary.total.toLocaleString("he")}</b> קישורים במסד ל"{title}": {summary.out.toLocaleString("he")} שהספר הוא צד המקור שלהם, {summary.in.toLocaleString("he")} שהוא צד היעד; עם {summary.byBook.length.toLocaleString("he")} ספרים.
        {summary.method === "scan" && " (במסד הזה אין אינדקס לפי ספר, ולכן הקריאה איטית.)"}
      </p>
      <LineView side={side} />
      <div class="filters" role="group" aria-label="כיוון">
        {(["all", "out", "in"] as const).map((d) => (
          <button key={d} class="chip" aria-pressed={(f.dir ?? "all") === d} onClick={() => s.setFilter({ dir: d === "all" ? undefined : d })} title={d === "out" ? `הספר הוא צד המקור של הקישור במסד${advanced ? " (side 0)" : ""}` : d === "in" ? `הספר הוא צד היעד של הקישור במסד${advanced ? " (side 1)" : ""}` : undefined}>
            {d === "all" ? "שני הכיוונים" : d === "out" ? "יוצאים" : "נכנסים"} <span class="count">{(d === "all" ? summary.total : summary[d]).toLocaleString("he")}</span>
          </button>
        ))}
        <button class="chip" aria-pressed={!!f.pickedLine} onClick={() => s.setFilter({ pickedLine: !f.pickedLine })} disabled={!pick} title="רק הקישורים של השורה שנבחרה בקורא">
          רק השורה הנבחרת{pick ? ` (${pick.line + 1})` : ""}
        </button>
      </div>
      <div class="filters" role="tablist" aria-label="קיבוץ">
        <button role="tab" class="chip" aria-selected={groupBy === "book"} aria-pressed={groupBy === "book"} onClick={() => setGroupBy("book")}>
          <Icon name="oz_book_links" size={14} /> לפי ספר
        </button>
        <button role="tab" class="chip" aria-selected={groupBy === "type"} aria-pressed={groupBy === "type"} onClick={() => setGroupBy("type")}>
          <Icon name="fl_filter" size={14} /> לפי סוג
        </button>
      </div>
      {groupBy === "type" ? (
        <div class="filters" style="padding-top:0">
          {summary.byType.map((t) => (
            <button key={t.type} class="chip" aria-pressed={!!f.types?.includes(t.type)} onClick={() => toggleType(t.type)} title={TYPE_LABELS[t.type].hint}>
              {TYPE_LABELS[t.type].he} <span class="count">{(t.out + t.in).toLocaleString("he")}</span>
            </button>
          ))}
        </div>
      ) : (
        <BookGroups summary={summary} />
      )}
      {(f.types?.length || f.otherBookKey) && (
        <div class="filters" style="padding-top:0">
          {f.otherBookKey && (
            <button class="chip" aria-pressed onClick={() => s.setFilter({ otherBookKey: undefined })} title="ביטול הסינון לפי ספר">
              {summary.byBook.find((b) => b.bookKey === f.otherBookKey)?.title} <Icon name="fl_dismiss" size={12} />
            </button>
          )}
          {f.types?.map((t) => (
            <button key={t} class="chip" aria-pressed onClick={() => toggleType(t)} title="ביטול הסינון לפי סוג">
              {TYPE_LABELS[t].he} <Icon name="fl_dismiss" size={12} />
            </button>
          ))}
        </div>
      )}
      <div class="bulk dbl-bulk">
        <span class="muted dbl-count" aria-live="polite">
          {list?.loading && !shown.length ? "טוען…" : `${(list?.total ?? 0).toLocaleString("he")} קישורים${shown.length < (list?.total ?? 0) ? `, מוצגים ${shown.length.toLocaleString("he")}` : ""}`}
        </span>
        <button
          class="btn text"
          onClick={() => (s.selected.value = new Set(copyable.map((l) => l.id)))}
          disabled={!copyable.length}
          title={copyable.length < shown.length ? `${(shown.length - copyable.length).toLocaleString("he")} מהמוצגים אינם ניתנים להעתקה (ספריא↔ספריא, ציטוט אוטומטי, או כבר בפרויקט), ולכן לא יסומנו` : undefined}
        >
          {copyable.length === shown.length ? "סימון המוצגים" : `סימון מה שאפשר להעתיק (${copyable.length.toLocaleString("he")} מתוך ${shown.length.toLocaleString("he")})`}
        </button>
        <button class="btn tonal" onClick={() => copy(shown.filter((l) => selected.has(l.id)))} disabled={!selected.size || !!store.task.value} title="יוצר בפרויקט קישורים חדשים כמו אלה, שאפשר לערוך ולייצא. הקישורים שבמסד לא משתנים">
          <Icon name="fl_copy" size={16} />
          העתקה לפרויקט{selected.size ? ` (${selected.size.toLocaleString("he")})` : ""}
        </button>
      </div>
      <ul class="link-list" aria-label="קישורים מהמסד">
        {shown.map((l) => (
          <DbLinkItem key={l.id} l={l} checked={selected.has(l.id)} />
        ))}
      </ul>
      {list && shown.length < list.total && (
        <div style="padding:8px;text-align:center">
          <button class="btn outlined" onClick={() => void s.loadPage(true)} disabled={list.loading}>
            הצגת עוד ({(list.total - shown.length).toLocaleString("he")} נותרו)
          </button>
        </div>
      )}
      {list && !list.loading && !list.total && <p class="empty">אין קישורים שמתאימים לסינון.</p>}
    </>
  );
}

/** The other books, most links first, filterable by name; a click filters the list to one book. */
function BookGroups({ summary }: { summary: DbLinkSummary }) {
  const store = useStore();
  const s = store.dbLinks;
  const [q, setQ] = useState("");
  const rows = useMemo(() => summary.byBook.filter((b) => !q.trim() || b.title.includes(q.trim())), [summary, q]);
  const current = s.filter.value.otherBookKey;
  return (
    <div class="dbl-books">
      {summary.byBook.length > 8 && <input type="search" placeholder="חיפוש ספר…" value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label="חיפוש בין הספרים המקושרים" />}
      <ul>
        {rows.slice(0, BOOK_ROWS).map((b) => (
          <li key={b.bookKey}>
            <button class="dbl-book" aria-pressed={current === b.bookKey} onClick={() => s.setFilter({ otherBookKey: current === b.bookKey ? undefined : b.bookKey })}>
              <span class="grow">{b.title}</span>
              {b.origin === "sefaria" && <span class="muted">ספריא</span>}
              <span class="count" title={`${b.out.toLocaleString("he")} יוצאים, ${b.in.toLocaleString("he")} נכנסים`}>{(b.out + b.in).toLocaleString("he")}</span>
            </button>
          </li>
        ))}
      </ul>
      {rows.length > BOOK_ROWS && <p class="muted dbl-more">ועוד {(rows.length - BOOK_ROWS).toLocaleString("he")} ספרים. חפשו לפי שם.</p>}
    </div>
  );
}

/** The picked line: the project's links and the database's, side by side (read-only for the database). */
function LineView({ side }: { side: Side }) {
  const store = useStore();
  const v = store.dbLinks.lineLinks(side);
  if (!v || v.bookKey !== store.dbLinks.bookKey.value) return null;
  const where = v.end > v.line ? `${v.line + 1}–${v.end + 1}` : `${v.line + 1}`;
  return (
    <details class="dbl-line" open>
      <summary>
        השורה הנבחרת ({where}): {v.project.length.toLocaleString("he")} בפרויקט · {v.db ? v.db.length.toLocaleString("he") : "…"} במסד
      </summary>
      <div class="dbl-line-body">
        <h3>בפרויקט</h3>
        {v.project.length ? (
          <ul class="link-list">
            {v.project.map((l) => (
              <LinkItem key={l.id} l={l} />
            ))}
          </ul>
        ) : (
          <p class="muted dbl-none">אין לשורה קישורים בפרויקט.</p>
        )}
        <h3>במסד (קריאה בלבד)</h3>
        {v.db === undefined ? (
          <p class="muted dbl-none">טוען…</p>
        ) : v.db.length ? (
          <ul class="link-list">
            {v.db.map((l) => (
              <DbLinkItem key={l.id} l={l} />
            ))}
          </ul>
        ) : (
          <p class="muted dbl-none">אין לשורה קישורים במסד.</p>
        )}
      </div>
    </details>
  );
}

function DbLinkItem({ l, checked }: { l: Link; checked?: boolean }) {
  const store = useStore();
  const s = store.dbLinks;
  const type = parseConnectionType(l.declaredType).type;
  const origin = dbLinkOrigin(l);
  const inProject = s.inProject(l);
  const why = s.whyNotCopyable(l);
  const where = (line: number, end?: number) => (end !== undefined ? `${line + 1}–${end + 1}` : `${line + 1}`);
  // the listed book's end stays in its reader; the other end goes to the other reader
  const show = () => {
    const mine = s.side.value;
    const [own, other] = l.source.book.key === s.bookKey.value ? [l.source, l.target] : [l.target, l.source];
    store.reveal(mine, own.book.key, own.line);
    store.reveal(mine === "source" ? "target" : "source", other.book.key, other.line);
  };
  const anchors = l.dbAnchors?.length ?? 0;
  return (
    <li class="link-item dbl-item" tabIndex={0} onClick={show} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && show()} title="הצגת שני צדי הקישור">
      <div class="ends">
        {checked !== undefined && (
          <input type="checkbox" checked={checked} disabled={!!why && !checked} title={why ?? undefined} onClick={(e) => e.stopPropagation()} onChange={() => s.toggleSelected(l.id)} aria-label="סימון להעתקה" />
        )}
        <span class="status dbl-status" title={DB_LINK_ORIGIN_LABELS[origin].hint}>
          {DB_LINK_ORIGIN_LABELS[origin].he}
        </span>
        <span>
          {l.source.book.title} {where(l.source.line, l.source.end)}
        </span>
        <Icon name="oz_link" size={14} />
        <span>
          {l.target.book.title} {where(l.target.line, l.target.end)}
        </span>
      </div>
      <div class="acts" onClick={(e) => e.stopPropagation()}>
        <button class="icon-btn" onClick={() => void s.adopt([l])} disabled={!!why || !!store.task.value} title={why ?? "העתקה לפרויקט"} aria-label="העתקה לפרויקט">
          <Icon name="fl_copy" size={18} />
        </button>
      </div>
      <div class="muted">
        {TYPE_LABELS[type].he}
        {anchors > 0 && ` · ${anchors === 1 ? "עוגן" : `${anchors} עוגנים`}`}
        {(isRange(l.source) || isRange(l.target)) && " · טווח"}
        {l.dbSuppressed?.length ? " · מוסתר בצד אחד" : ""}
        {inProject === "same-link" && <span class="dbl-in"> · כבר בפרויקט</span>}
        {inProject === "same-lines" && <span class="dbl-in"> · בפרויקט בסוג אחר</span>}
        {l.heRef2 && <span> · {l.heRef2}</span>}
      </div>
    </li>
  );
}
