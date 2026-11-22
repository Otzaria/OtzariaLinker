import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { TYPE_LABELS, type ConnectionType } from "../../core/links/connection-type";
import type { Link } from "../../core/links/model";
import { CONFIDENCE_LABELS, CONFIDENCE_ORDER, ENGINES, type Confidence } from "../../linking/automatic";
import { filterRows, sortRows, tableRows, type SortKey, type TableFilter, type TableRow } from "../../state/links-table";
import { TypeOptions } from "./type-options";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { rovingKeys, rovingTabIndex } from "../keyboard";
import { DbLinksPanel } from "./db-links-panel";
import { LinkItem, STATUS_LABEL } from "./link-item";

/*
 * The links table (V5 task 27): every link of the project and every pending suggestion, filtered by
 * status, book, type, engine, confidence and problems, searched and sorted (state/links-table.ts),
 * with multi-select and group actions that are each one undoable step. Virtualized: only the rows in
 * view are rendered, so 100K links stay responsive.
 */

/** The links tab: the project's links, or the links the open database already has (stage 10). */
export function LinksPanel() {
  const store = useStore();
  const tab = store.dbLinks.tab.value;
  return (
    <>
      <div class="filters" role="tablist" aria-label="אילו קישורים" onKeyDown={rovingKeys}>
        <button role="tab" class="chip" aria-selected={tab === "project"} tabIndex={rovingTabIndex(tab === "project")} onClick={() => (store.dbLinks.tab.value = "project")}>
          <Icon name="oz_links" size={14} /> קישורי הפרויקט <span class="count">{store.allLinks.value.length.toLocaleString("he")}</span>
        </button>
        <button role="tab" class="chip" aria-selected={tab === "db"} tabIndex={rovingTabIndex(tab === "db")} onClick={() => (store.dbLinks.tab.value = "db")} title="הקישורים שכבר יש במסד הפתוח לספר שבקורא — לקריאה, לבדיקה ולהעתקה לפרויקט">
          <Icon name="oz_library_link" size={14} /> קישורים מהמסד
        </button>
      </div>
      {tab === "db" ? <DbLinksPanel /> : <ProjectLinksPanel />}
    </>
  );
}

function ProjectLinksPanel() {
  const store = useStore();
  const [f, setF] = useState<TableFilter & { onlyBook?: boolean }>({ onlyBook: true });
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "source", desc: false });
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  const all = store.allLinks.value;
  const run = store.suggestions.run.value;
  const st = store.suggestions.state.value;
  const report = store.quality.report.value;
  const book = store.view.source.value;

  const rows = useMemo(() => tableRows(all, run?.result.suggestions, (id) => st.get(id) === "pending", report), [all, run, st, report]);
  const filtered = useMemo(() => {
    const where = f.onlyBook && book ? (l: Link) => store.sameBook(l.source.book, book) || store.sameBook(l.target.book, book) : undefined;
    return sortRows(filterRows(rows, { ...f, ...(where && { where }) }), sort.key, sort.desc);
  }, [rows, f, book, sort]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length };
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);
  // the choices of the filters, and how many of the chosen rows still exist (an approved suggestion's row goes)
  const opts = useMemo(() => {
    const of = (pick: (r: TableRow) => string | undefined) => [...new Set(rows.map(pick).filter((x): x is string => !!x))].sort();
    return { source: of((r) => r.link.source.book.title), target: of((r) => r.link.target.book.title), type: of((r) => r.type), engine: of((r) => r.engine) };
  }, [rows]);
  const chosen = useMemo(() => (sel.size ? rows.reduce((n, r) => n + (sel.has(r.key) ? 1 : 0), 0) : 0), [rows, sel]);
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });

  const altToc = store.altToc.count.value;
  const altTocButton = (
    <button class="btn text" onClick={() => (store.dialog.value = "alt-toc")} title="חלוקה שנייה של ספר לצד תוכן העניינים הרגיל (פרשות ועליות, ימי לימוד…) — נכתבת לקובץ alt_toc">
      <Icon name="oz_text_bullet_list_tree" size={16} />
      מבני כותרות{altToc ? ` (${altToc.toLocaleString("he")})` : ""}
    </button>
  );
  const compareButton = (
    <button class="btn text" onClick={() => (store.dialog.value = "compare")} title="השוואת הקישורים של ספר בין המסד, הפרויקט וקובצי ‎_links.json, ומיזוג כמה קבצים של אותו ספר">
      <Icon name="oz_text_compare" size={16} />
      השוואה ומיזוג
    </button>
  );

  if (!rows.length)
    return (
      <>
        <div class="bulk" style="padding:6px 6px 0">{altTocButton}{compareButton}</div>
        <div class="empty">
          <Icon name="oz_links" size={40} />
          <span>עדיין אין קישורים בפרויקט. צרו קישור בבונה, או גררו לכאן קובץ ‎_links.json קיים כדי לערוך אותו.</span>
        </div>
      </>
    );

  const choose = (label: string, key: "source" | "target" | "type" | "engine" | "confidence" | "problem", values: readonly string[], text: (v: string) => string = (v) => v) => (
    <label class="field">
      {label}
      <select aria-label={label} value={(f[key] as string | undefined) ?? ""} onChange={(e) => set({ [key]: e.currentTarget.value || undefined })}>
        <option value="">הכול</option>
        {values.map((v) => (
          <option key={v} value={v}>{text(v)}</option>
        ))}
      </select>
    </label>
  );
  const shownKeys = filtered.map((r) => r.key);
  const allShown = shownKeys.length > 0 && sel.size >= shownKeys.length && shownKeys.every((k) => sel.has(k));

  return (
    <>
      <div class="bulk" style="padding:6px 6px 0">
        <button class="btn text" onClick={() => (store.dialog.value = "relink")} title="כשספר השתנה (שורות נוספו, נמחקו או נערכו) — מעבירים את הקישורים למהדורה החדשה">
          <Icon name="oz_text_compare" size={16} />
          מעבר למהדורה חדשה של ספר
        </button>
        {compareButton}
        {altTocButton}
      </div>
      <FillRanges />
      <div class="filters">
        {(["all", "pending", "new", "edited", "existing", "deleted"] as const).map((s) =>
          s === "all" || counts[s] ? (
            <button key={s} class="chip" aria-pressed={(f.status ?? "all") === s} onClick={() => set({ status: s === "all" ? undefined : s })}>
              {s === "all" ? "הכול" : STATUS_LABEL[s]} <span class="count">{(counts[s] ?? 0).toLocaleString("he")}</span>
            </button>
          ) : null,
        )}
        {book && (
          <button class="chip" aria-pressed={!!f.onlyBook} onClick={() => set({ onlyBook: !f.onlyBook })} title="רק קישורים של ספר המקור המוצג">
            רק הספר המוצג
          </button>
        )}
        <input type="search" placeholder="חיפוש בשמות ובמקומות…" value={f.q ?? ""} onInput={(e) => set({ q: e.currentTarget.value })} style="margin-top:4px" />
      </div>
      <details class="held" style="margin:0 6px">
        <summary>סינון ומיון</summary>
        <div class="lt-grid">
          {choose("ספר מקור", "source", opts.source)}
          {choose("ספר יעד", "target", opts.target)}
          {choose("סוג", "type", opts.type, (t) => TYPE_LABELS[t as ConnectionType].he)}
          {choose("שיטה", "engine", ["manual", ...opts.engine], (e) => (e === "manual" ? "ידני / מקובץ" : ENGINES.find((x) => x.id === e)?.title ?? e))}
          {choose("ודאות", "confidence", CONFIDENCE_ORDER.filter((c) => rows.some((r) => r.confidence === c)), (c) => CONFIDENCE_LABELS[c as Confidence])}
          {choose("בעיות", "problem", report ? ["error", "warning"] : [], (p) => (p === "error" ? "שגיאות" : "אזהרות ושגיאות"))}
          <label class="field">
            מיון
            <select aria-label="מיון" value={sort.key} onChange={(e) => setSort({ ...sort, key: e.currentTarget.value as SortKey })}>
              {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                <option key={k} value={k}>{SORT_LABEL[k]}</option>
              ))}
            </select>
          </label>
          <label class="check">
            <input type="checkbox" checked={sort.desc} onChange={(e) => setSort({ ...sort, desc: e.currentTarget.checked })} />
            <span>בסדר יורד</span>
          </label>
        </div>
        {!report && <p class="muted" style="margin:4px 0 0">סינון לפי בעיות: אחרי בדיקה (לשונית "בדיקה").</p>}
      </details>
      <label class="check lt-head">
        <input type="checkbox" checked={allShown} onChange={() => setSel(allShown ? new Set() : new Set(shownKeys))} />
        <span>{filtered.length.toLocaleString("he")} מוצגים{chosen ? ` · ${chosen.toLocaleString("he")} נבחרו` : ""}</span>
      </label>
      {chosen > 0 && <GroupActions sel={sel} rows={rows} clear={() => setSel(new Set())} />}
      <VirtualList
        rows={filtered}
        sel={sel}
        toggle={(k) => {
          const next = new Set(sel);
          if (!next.delete(k)) next.add(k);
          setSel(next);
        }}
      />
      {!filtered.length && <p class="empty">אין קישורים שמתאימים לסינון.</p>}
    </>
  );
}

const SORT_LABEL: Record<SortKey, string> = { source: "ספר ושורת מקור", target: "ספר ושורת יעד", type: "סוג", status: "מצב", engine: "שיטה", confidence: "ודאות" };
const ROW = 64;

/** Only the rows in view are in the DOM: 100K links scroll like 100. */
function VirtualList({ rows, sel, toggle }: { rows: readonly TableRow[]; sel: ReadonlySet<string>; toggle: (key: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(600);
  useEffect(() => {
    if (ref.current?.clientHeight) setHeight(ref.current.clientHeight);
  }, []);
  // a filter that shortens the list while it is scrolled far down still shows its last rows
  const first = Math.max(0, Math.min(Math.floor(top / ROW) - 4, rows.length - Math.ceil(height / ROW) - 4));
  const last = Math.min(rows.length, first + Math.ceil(height / ROW) + 8);
  return (
    <div ref={ref} class="vlist" onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
      <ul class="link-list" style={`height:${rows.length * ROW}px`} aria-label="קישורי הפרויקט">
        {rows.slice(first, last).map((r, i) => (
          <LinkItem key={r.key} l={r.link} row={r} top={(first + i) * ROW} selected={sel.has(r.key)} onSelect={() => toggle(r.key)} />
        ))}
      </ul>
    </div>
  );
}

/** The actions on the chosen rows — each ONE undoable step (store, store.fixes, store.suggestions). */
function GroupActions({ sel, rows, clear }: { sel: ReadonlySet<string>; rows: readonly TableRow[]; clear: () => void }) {
  const store = useStore();
  const [title, setTitle] = useState("");
  const chosen = rows.filter((r) => sel.has(r.key));
  const ids = chosen.filter((r) => r.status !== "pending").map((r) => r.key);
  const pending = chosen.filter((r) => r.status === "pending").map((r) => r.suggestion!);
  const auto = chosen.filter((r) => r.suggestion).map((r) => r.suggestion!);
  const busy = !!store.task.value;
  return (
    <div class="lt-actions" role="toolbar" aria-label="פעולות על הנבחרים">
      {pending.length > 0 && <button class="btn tonal small" onClick={() => store.suggestions.approve(pending)}>אישור ({pending.length.toLocaleString("he")})</button>}
      {auto.length > 0 && <button class="btn text small" onClick={() => store.suggestions.reject(auto)}>דחייה ({auto.length.toLocaleString("he")})</button>}
      {ids.length > 0 && (
        <>
          <button class="btn text small" onClick={() => store.deleteLinks(ids)}>מחיקה</button>
          <button class="btn text small" onClick={() => store.restoreLinks(ids)}>שחזור</button>
          <select aria-label="שינוי סוג הקשר" value="" onChange={(e) => e.currentTarget.value && store.setType(ids, e.currentTarget.value)}>
            <option value="">שינוי סוג…</option>
            <TypeOptions />
          </select>
          <span class="lt-target">
            <input list="lt-titles" placeholder="ספר יעד חדש…" aria-label="ספר יעד חדש" value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
            <datalist id="lt-titles">{[...store.booksByTitle.value.keys()].map((t) => <option key={t} value={t} />)}</datalist>
            <button class="btn text small" disabled={!title.trim()} onClick={() => store.fixes.retarget(ids, title)}>החלפת יעד</button>
          </span>
          <button class="btn text small" disabled={busy} onClick={() => void store.fixes.fixRefs(ids)} title="ציון ספריא באנגלית רק בצד של ספר ספריא; החסר נבנה משם המקום שבמסד">{store.prefs.advanced.value ? "תיקון ref" : "תיקון ציון ספריא"}</button>
          <button class="btn text small" onClick={() => store.fixes.fixDirection(ids)} title='קישור מפירוש אל הספר שעליו נכתב: הסוג "מקור"'>תיקון כיוון</button>
          <button class="btn text small" onClick={() => store.fixes.removeDuplicates(ids)} title="קישורים שבמסד יהיו קישור אחד: נשאר אחד מכל קבוצה">הסרת כפולים</button>
          <button class="btn text small" onClick={() => store.fixes.fixRanges(ids)} title="סוף שאינו אחרי ההתחלה או אחרי סוף הספר, טווח בצד ספריא, וטווח שבולע את הקישור הבא">תיקון טווחים</button>
        </>
      )}
      <button class="btn text small" onClick={clear}>ניקוי הבחירה</button>
    </div>
  );
}

/**
 * Range completion (v3 F-084/F-105): every link of a book on one side runs until one line before the
 * next link or heading (the last one to the end of the book). One undoable step; the rule is linking/ranges.ts.
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
        <span class="muted">כל טווח נמשך עד שורה אחת לפני הקישור הבא או הכותרת הבאה, והאחרון עד סוף הספר. אפשר לבטל ב־Ctrl+Z.</span>
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
