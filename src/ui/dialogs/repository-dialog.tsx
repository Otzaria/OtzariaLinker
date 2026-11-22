import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { TYPE_LABELS } from "../../core/links/connection-type";
import { DB_LINK_FLAG_LABELS, type DbLinkSummary, type DbLinksUnavailable } from "../../core/links/db-links";
import type { CoverageSummary } from "../../linking/coverage";
import type { PairConfidence, PairProposal } from "../../linking/discovery";
import { isSuspicious, SUSPICIOUS_MIN, SUSPICIOUS_SHARE, unlinkedShare, type RepoRow, type RepoSort } from "../../state/repository";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import "./repository.css";

/*
 * "ניתוח המאגר והשלמת קישורים" (V6 3.9): an open database as a whole — how many books and links, which books have none, which kinds
 * of links, which are flagged — a searchable list of the books, one book's details, pairs the tool suggests, and one action:
 * "complete the links of the chosen", which opens the guided flow with those books (and pairs). Nothing is read until the user asks;
 * the count goes one book at a time and can be stopped and continued; nothing runs and nothing is written by choosing.
 * Over state/repository.ts; no graph.
 */
const PAGE = 100;
const PAIRS_PAGE = 50;
const COVERAGE_AT_ONCE = 200;
const n = (x: number) => x.toLocaleString("he");
const FILTERS = {
  all: "כל הספרים",
  "no-links": "בלי קישורים",
  flagged: "עם סימוני בדיקה",
  suspicious: "ספרים חשודים",
  unlinked: "שורות רבות בלי קישור (אחרי חישוב כיסוי)",
} as const;
type Filter = keyof typeof FILTERS;
const SORTS: Record<RepoSort, string> = {
  title: "לפי שם",
  "links-asc": "מעט קישורים תחילה",
  "links-desc": "הרבה קישורים תחילה",
  "unlinked-share": "הכי פחות מכוסים תחילה (אחרי חישוב כיסוי)",
};
const CONFIDENCE: Record<PairConfidence, string> = { high: "ביטחון גבוה", medium: "ביטחון בינוני", low: "ביטחון נמוך" };
const ENDS_LABEL = {
  same: "אל ספרים באותו מסד",
  library: "אל ספרי הספרייה הרשמית",
  other: "אל מסד או קובץ אחר שפתוח",
  unresolved: "אל ספר שלא פתוח (למשל הספרייה הרשמית, אם לא פתחתם אותה)",
} as const;

export function RepositoryDialog({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const repo = store.repository;
  const ref = useRef<HTMLDialogElement>(null);
  const source = repo.source.value;
  const progress = repo.progress.value;
  const totals = repo.totals.value;
  const rows = repo.rows.value;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<RepoSort>("title");
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);
  const [detail, setDetail] = useState<string | null>(null);
  useEffect(() => ref.current?.showModal(), []);

  // the list: filtered and sorted from the small rows; only a page of it is in the page
  const list = useMemo(() => {
    const q = query.trim();
    const out = repo.books.value.filter((b) => {
      if (q && !b.title.includes(q)) return false;
      const r = rows.get(b.key);
      if (filter === "all") return true;
      if (!r || r.unavailable) return false;
      if (filter === "no-links") return r.total === 0;
      if (filter === "flagged") return r.flags.length > 0;
      if (filter === "suspicious") return isSuspicious(r);
      return (unlinkedShare(r) ?? 0) >= 0.5;
    });
    const total = (k: string) => rows.get(k)?.total;
    const share = (k: string) => (rows.get(k) ? unlinkedShare(rows.get(k)!) : null);
    if (sort === "links-asc") out.sort((a, b) => (total(a.key) ?? Infinity) - (total(b.key) ?? Infinity));
    else if (sort === "links-desc") out.sort((a, b) => (total(b.key) ?? -1) - (total(a.key) ?? -1));
    else if (sort === "unlinked-share") out.sort((a, b) => (share(b.key) ?? -1) - (share(a.key) ?? -1));
    return out;
  }, [repo.books.value, rows, query, sort, filter]);
  useEffect(() => setShown(PAGE), [query, sort, filter, source?.info.id]);

  const picked = repo.pickedBooks.value;
  const pairs = repo.pickedPairs.value;
  const chosen = repo.chosenBooks();
  const busy = !!progress;
  const complete = () => {
    if (!chosen.length) return;
    store.guided.startForBooks(chosen, [...pairs.values()]);
    store.dialog.value = null;
  };
  const askedMany = repo.books.value.length > 400;

  return (
    <dialog ref={ref} class="repository" onClose={onClose} aria-labelledby="repo-title">
      <div class="dlg">
        <header>
          <Icon name="oz_search_in_links" size={24} />
          <h2 id="repo-title">ניתוח המאגר והשלמת קישורים</h2>
        </header>
        <div class="body">
          {!source ? (
            <p>אין מסד פתוח. פתחו מסד אוצריא או מסד אישי, ואז אפשר לנתח אותו.</p>
          ) : (
            <>
              <p class="muted" style="margin:0">
                הניתוח קורא את הקישורים של כל ספר במסד, אחד אחד, ומראה איפה חסרים קישורים. הוא רק קורא: שום דבר לא נכתב למסד, ושום דבר לא רץ עד שתבחרו ספרים ותלחצו "השלמת קישורים".
              </p>
              {repo.repositories.value.length > 1 && (
                <label class="field">
                  המסד
                  <select aria-label="המסד לניתוח" value={source.info.id} onChange={(e) => (repo.chooseSource(e.currentTarget.value), setDetail(null))} disabled={busy}>
                    {repo.repositories.value.map((s) => (
                      <option key={s.info.id} value={s.info.id}>
                        {s.info.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div class="repo-run">
                <div class="row">
                  {!busy ? (
                    <>
                      <button class="btn tonal" onClick={() => void repo.analyze()} disabled={!repo.available || totals.counted >= totals.books}>
                        <Icon name="oz_link_check" size={18} />
                        {totals.counted ? "המשך הניתוח" : "ניתוח הקישורים של הספרים"}
                      </button>
                      {totals.counted > 0 && (
                        <button class="btn text" onClick={() => void repo.analyze(true)}>
                          ניתוח מחדש מההתחלה
                        </button>
                      )}
                    </>
                  ) : (
                    <button class="btn outlined" onClick={() => repo.cancel()}>
                      עצירה
                    </button>
                  )}
                </div>
                {progress && (
                  <div role="status" aria-live="polite" class="repo-progress">
                    <progress max={progress.total || 1} value={progress.done} aria-label="התקדמות הניתוח" />
                    <span>
                      {progress.stage === "links" ? "נקראו הקישורים של" : "חושב כיסוי של"} {n(progress.done)} מתוך {n(progress.total)} ספרים. אפשר לעצור, והספרים שנקראו נשמרים.
                    </span>
                  </div>
                )}
                {!progress && repo.analyzedAt.value !== null && (
                  <p class="muted small" role="status" style="margin:0">
                    {totals.counted >= totals.books
                      ? `נקראו הקישורים של כל ${n(totals.books)} הספרים.`
                      : `נקראו הקישורים של ${n(totals.counted)} מתוך ${n(totals.books)} ספרים; "המשך הניתוח" קורא את השאר.`}{" "}
                    הניתוח האחרון: <time class="repo-time">{new Date(repo.analyzedAt.value).toLocaleString("he", { dateStyle: "medium", timeStyle: "short" })}</time>. המספרים לא מתעדכנים לבד אם המסד או הפרויקט משתנים.
                  </p>
                )}
                {!progress && totals.counted === 0 && askedMany && (
                  <p class="muted small" style="margin:0">
                    יש כאן {n(totals.books)} ספרים, ולכן הניתוח המלא עשוי לקחת כמה דקות. הרשימה למטה פועלת כבר עכשיו, ואפשר לנתח רק ספרים מסוימים: חפשו, ובחרו "חישוב כיסוי" לספרים שברשימה.
                  </p>
                )}
              </div>

              <div class="stats" role="group" aria-label="סיכום המאגר">
                <Stat v={n(totals.books)} label="ספרים" />
                <Stat v={totals.counted ? n(totals.links) : "—"} label="קישורים קיימים" />
                <Stat v={totals.counted ? n(totals.noLinks) : "—"} label="ספרים בלי קישורים" />
                <Stat v={totals.counted ? n(totals.flaggedBooks) : "—"} label="ספרים עם סימוני בדיקה" />
                <Stat v={totals.counted ? n(totals.suspicious) : "—"} label="ספרים חשודים" bad={totals.suspicious > 0} />
              </div>
              {totals.counted > 0 && (
                <details class="repo-more">
                  <summary>פירוט: לפי סוג קישור, לפי הצד השני, סימונים</summary>
                  <div class="repo-more-body">
                    <h3>לפי סוג</h3>
                    <ul class="repo-chips" aria-label="קישורים לפי סוג">
                      {totals.byType.map(([t, c]) => (
                        <li key={t} title={TYPE_LABELS[t].hint}>
                          {TYPE_LABELS[t].he} <b>{n(c)}</b>
                        </li>
                      ))}
                    </ul>
                    <h3>לפי הצד השני של הקישור</h3>
                    <ul class="repo-chips" aria-label="קישורים לפי הצד השני">
                      {(Object.keys(ENDS_LABEL) as (keyof typeof ENDS_LABEL)[]).filter((k) => totals.ends[k] > 0).map((k) => (
                        <li key={k}>
                          {ENDS_LABEL[k]} <b>{n(totals.ends[k])}</b>
                        </li>
                      ))}
                    </ul>
                    <h3>סימוני בדיקה</h3>
                    {totals.flags.length ? (
                      <ul class="repo-flag-list" aria-label="סימוני בדיקה">
                        {totals.flags.map((f) => (
                          <li key={f.flag}>
                            <b>{DB_LINK_FLAG_LABELS[f.flag].he}</b>: {n(f.books)} ספרים, {n(f.links)} סימונים. {DB_LINK_FLAG_LABELS[f.flag].hint}.
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p class="muted small">אין סימוני בדיקה. הם קיימים רק במסדים אישיים שהקישורים שלהם שמורים כקישורים חיצוניים.</p>
                    )}
                    <p class="muted small">
                      קישור שמסומן נספר אצל כל אחד משני הספרים שלו. "חשוד" הוא ספר ש־{Math.round(SUSPICIOUS_SHARE * 100)}% לפחות מקישוריו מסומנים (ולפחות {SUSPICIOUS_MIN} קישורים): כדאי לבדוק אותו לפני שסומכים עליו.
                    </p>
                  </div>
                </details>
              )}

              <h3 class="repo-h">הספרים</h3>
              <div class="repo-controls">
                <label class="field grow">
                  חיפוש ספר
                  <input type="search" value={query} onInput={(e) => setQuery(e.currentTarget.value)} placeholder="חלק מהשם…" />
                </label>
                <label class="field">
                  הצגה
                  <select aria-label="אילו ספרים להציג" value={filter} onChange={(e) => setFilter(e.currentTarget.value as Filter)}>
                    {(Object.keys(FILTERS) as Filter[]).map((f) => (
                      <option key={f} value={f}>
                        {FILTERS[f]}
                      </option>
                    ))}
                  </select>
                </label>
                <label class="field">
                  סדר
                  <select aria-label="סדר הרשימה" value={sort} onChange={(e) => setSort(e.currentTarget.value as RepoSort)}>
                    {(Object.keys(SORTS) as RepoSort[]).map((s) => (
                      <option key={s} value={s}>
                        {SORTS[s]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div class="row">
                <span class="muted" role="status" aria-live="polite">
                  {n(list.length)} ספרים{filter !== "all" && totals.counted < totals.books ? " (מתוך מה שנקרא עד עכשיו)" : ""}
                </span>
                <span class="grow" />
                <button class="btn text small" onClick={() => repo.setPickedBooks([...picked, ...list.slice(0, shown).map((b) => b.key)])} disabled={!list.length}>
                  סימון המוצגים
                </button>
                <button class="btn text small" onClick={() => repo.setPickedBooks([])} disabled={!picked.size}>
                  ביטול הסימון
                </button>
                <button class="btn text small" onClick={() => void repo.countCoverage(list.slice(0, COVERAGE_AT_ONCE).map((b) => b.key))} disabled={busy || !totals.counted || !list.length} title="סופר כמה שורות בכל ספר כבר מקושרות. נעשה לספרים שברשימה, עד 200 בכל פעם">
                  חישוב כיסוי לספרים שברשימה
                </button>
              </div>
              <div class="repo-grid">
                <div>
                  <ul class="repo-books" aria-label="הספרים">
                    {list.slice(0, shown).map((b) => (
                      <BookRow key={b.key} title={b.title} row={rows.get(b.key)} checked={picked.has(b.key)} current={detail === b.key} onPick={() => repo.togglePickedBook(b.key)} onOpen={() => setDetail(detail === b.key ? null : b.key)} />
                    ))}
                  </ul>
                  {list.length > shown && (
                    <div style="text-align:center;padding:6px">
                      <button class="btn outlined" onClick={() => setShown(shown + PAGE)}>
                        הצגת עוד ({n(list.length - shown)} ספרים)
                      </button>
                    </div>
                  )}
                  {!list.length && <p class="muted">אין ספרים שמתאימים.</p>}
                </div>
                {detail && <BookDetail bookKey={detail} onClose={() => setDetail(null)} onLeave={() => ref.current?.close()} />}
              </div>

              <h3 class="repo-h">זוגות מוצעים</h3>
              <Suggestions />
            </>
          )}
        </div>
        <footer>
          <span class="repo-chosen muted" role="status" aria-live="polite">
            {chosen.length ? `${chosen.length === 1 ? "נבחר ספר אחד" : `נבחרו ${n(chosen.length)} ספרים`}${pairs.size ? (pairs.size === 1 ? ", עם זוג אחד שנבחר" : `, ${n(pairs.size)} מהם עם זוג שנבחר`) : ""}.` : "עוד לא נבחרו ספרים או זוגות."}
          </span>
          <span class="grow" />
          <button class="btn text" onClick={() => ref.current?.close()}>
            סגירה
          </button>
          <button class="btn filled" disabled={!chosen.length || busy} onClick={complete} title="פותח את התהליך המודרך עם הספרים (והזוגות) שנבחרו. שום דבר לא רץ עד שתלחצו שם על הפעלה">
            <Icon name="oz_links" size={18} />
            השלמת קישורים לנבחרים
          </button>
        </footer>
      </div>
    </dialog>
  );
}

function Stat({ v, label, bad }: { v: string; label: string; bad?: boolean }) {
  return (
    <div class={`stat${bad ? " bad" : ""}`}>
      <b>{v}</b>
      <span class="muted">{label}</span>
    </div>
  );
}

function BookRow({ title, row, checked, current, onPick, onOpen }: { title: string; row: RepoRow | undefined; checked: boolean; current: boolean; onPick: () => void; onOpen: () => void }) {
  const share = row ? unlinkedShare(row) : null;
  return (
    <li class={`repo-book${current ? " current" : ""}`}>
      <input type="checkbox" checked={checked} onChange={onPick} aria-label={`בחירה: ${title}`} />
      <button class="repo-title" onClick={onOpen} aria-pressed={current} aria-label={`פרטי הספר ${title}`}>
        {title}
      </button>
      <span class="repo-meta muted">
        {!row ? "לא נבדק" : row.unavailable ? "אי אפשר לקרוא" : row.total === 0 ? <b class="repo-none">בלי קישורים</b> : `${n(row.total)} קישורים`}
        {row && !row.unavailable && row.flags.length > 0 && (
          <span class="repo-flagged" title={row.flags.map((f) => `${DB_LINK_FLAG_LABELS[f.flag].he}: ${n(f.count)}`).join("\n")}>
            {" "}
            · <Icon name="fl_warning" size={12} /> {isSuspicious(row) ? "חשוד" : "יש סימונים"}
          </span>
        )}
        {share !== null && ` · ${Math.round(share * 100)}% בלי קישור`}
      </span>
    </li>
  );
}

/** One book: who it is linked to and from, its types and flags, its coverage and the unlinked ranges, and the way into the reader. */
function BookDetail({ bookKey, onClose, onLeave }: { bookKey: string; onClose: () => void; onLeave: () => void }) {
  const store = useStore();
  const repo = store.repository;
  const book = store.books.value.get(bookKey);
  const row = repo.rows.value.get(bookKey);
  const [summary, setSummary] = useState<DbLinkSummary | DbLinksUnavailable | null | "loading">("loading");
  const [cov, setCov] = useState<CoverageSummary | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setSummary("loading");
    setCov(null);
    let live = true;
    void repo.detailOf(bookKey).then((s) => live && setSummary(s));
    return () => void (live = false);
  }, [bookKey]);
  if (!book) return null;
  const ok = summary !== "loading" && summary && "total" in summary ? summary : null;
  const countCoverage = async () => {
    setBusy(true);
    setCov(await store.coverage.summary(bookKey));
    setBusy(false);
  };
  const open = (then?: () => void) => {
    store.showBook("source", bookKey);
    then?.();
    store.screen.value = "workspace";
    onLeave();
  };
  // the links panel forgets its filters when it meets another book: its summary is read first, so the flag is kept
  const showFlagged = async (flag: NonNullable<DbLinkSummary["flags"]>[number]["flag"]) => {
    store.showBook("source", bookKey);
    store.dbLinks.side.value = "source";
    await store.dbLinks.loadSummary(bookKey);
    store.dbLinks.tab.value = "db";
    store.dbLinks.setFilter({ flag });
    store.sideTab.value = "links";
    store.screen.value = "workspace";
    onLeave();
  };
  return (
    <section class="repo-detail" aria-label={`פרטי הספר ${book.title}`}>
      <div class="row">
        <h3 class="grow" style="margin:0">{book.title}</h3>
        <button class="icon-btn" onClick={onClose} aria-label="סגירת הפרטים">
          <Icon name="fl_dismiss" size={18} />
        </button>
      </div>
      {summary === "loading" && <p class="muted" role="status">קורא את הקישורים של הספר…</p>}
      {summary !== "loading" && !ok && <p class="warn-text" role="note">{summary && "reason" in summary ? summary.reason : "קריאת הקישורים של הספר לא הושלמה."}</p>}
      {ok && (
        <>
          <p style="margin:0">
            <b>{n(ok.total)}</b> קישורים: {n(ok.out)} שהספר הוא צד המקור שלהם, {n(ok.in)} שהוא צד היעד.
          </p>
          {ok.total === 0 && <p class="muted">לספר אין קישורים במסד: מועמד להשלמת קישורים.</p>}
          {ok.byType.length > 0 && (
            <ul class="repo-chips" aria-label="לפי סוג">
              {ok.byType.map((t) => (
                <li key={t.type} title={TYPE_LABELS[t.type].hint}>
                  {TYPE_LABELS[t.type].he} <b>{n(t.out + t.in)}</b>
                </li>
              ))}
            </ul>
          )}
          {ok.byBook.length > 0 && (
            <>
              <h4>מקושר אל ומאת</h4>
              <ul class="repo-rel" aria-label="הספרים המקושרים">
                {ok.byBook.slice(0, 10).map((b) => (
                  <li key={b.bookKey}>
                    <span class="grow">{b.title}</span>
                    <span class="muted">
                      {b.out > 0 && `${n(b.out)} יוצאים`}
                      {b.out > 0 && b.in > 0 && " · "}
                      {b.in > 0 && `${n(b.in)} נכנסים`}
                    </span>
                  </li>
                ))}
              </ul>
              {ok.byBook.length > 10 && <p class="muted small">ועוד {n(ok.byBook.length - 10)} ספרים מקושרים. הרשימה המלאה בלשונית "קישורים מהמסד".</p>}
            </>
          )}
          {ok.flags && ok.flags.length > 0 && (
            <>
              <h4>סימוני בדיקה</h4>
              <ul class="repo-flag-list" aria-label="סימוני בדיקה של הספר">
                {ok.flags.map((f) => (
                  <li key={f.flag}>
                    <b>{DB_LINK_FLAG_LABELS[f.flag].he}</b> ({n(f.count)}): {DB_LINK_FLAG_LABELS[f.flag].hint}.{" "}
                    <button class="btn text small" onClick={() => void showFlagged(f.flag)} disabled={!!store.task.value}>
                      הצגת הקישורים האלה
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      <h4>כיסוי</h4>
      {row?.coverage && !cov && (
        <p class="small">
          {n(row.coverage.unlinked)} מתוך {n(row.coverage.suitable)} שורות תוכן בלי קישור ({row.coverage.suitable ? Math.round((row.coverage.unlinked / row.coverage.suitable) * 100) : 0}%). כותרות לא נספרות כשורות תוכן, ואם לא נקראו כותרות הספר המספר הוא גבול עליון.
        </p>
      )}
      <div class="row">
        <button class="btn tonal small" onClick={() => void countCoverage()} disabled={busy || !!store.task.value}>
          {cov ? "חישוב מחדש" : "חישוב כיסוי מלא וקטעים בלי קישור"}
        </button>
        <button class="btn text small" onClick={() => open()}>
          פתיחה בקורא
        </button>
      </div>
      {cov && (
        <>
          <p class="small" role="status">
            {cov.unlinked === 0 ? "כל שורות התוכן מקושרות או מכוסות." : `${n(cov.unlinked)} מתוך ${n(cov.suitable)} שורות תוכן בלי קישור, ב־${n(cov.ranges.length)} קטעים.`}
          </p>
          {cov.ranges.length > 0 && (
            <ol class="repo-rel" aria-label="קטעים בלי קישור">
              {cov.ranges.slice(0, 10).map((r) => (
                <li key={r.start}>
                  <span class="grow">{r.end > r.start ? `שורות ${n(r.start + 1)}–${n(r.end + 1)}` : `שורה ${n(r.start + 1)}`}</span>
                  <button class="btn text small" onClick={() => open(() => store.reveal("source", bookKey, r.start))} aria-label={`הצגה בקורא: שורה ${n(r.start + 1)}`}>
                    הצגה בקורא
                  </button>
                </li>
              ))}
            </ol>
          )}
          {cov.ranges.length > 10 && <p class="muted small">ועוד {n(cov.ranges.length - 10)} קטעים. הרשימה המלאה בלשונית "בדיקה", בחלק "כיסוי הספר".</p>}
        </>
      )}
    </section>
  );
}

/** Pairs the tool proposes from the books (title, existing links): nothing is chosen for the user. */
function Suggestions() {
  const store = useStore();
  const repo = store.repository;
  const s = repo.suggestions.value;
  const picked = repo.pickedPairs.value;
  const rows = repo.rows.value;
  const [all, setAll] = useState(false);
  const [shown, setShown] = useState(PAIRS_PAGE);
  const visible = useMemo(() => {
    if (!s) return [];
    const list = s.proposals.filter((p) => {
      if (all) return true;
      const r = rows.get(p.dependant.key);
      // by default the books that still need links: none known to have any, or not counted yet
      return !r || r.unavailable || r.total === 0 || (unlinkedShare(r) ?? 0) >= 0.5;
    });
    const order: Record<PairConfidence, number> = { high: 0, medium: 1, low: 2 };
    return list.sort((a, b) => order[a.confidence] - order[b.confidence] || a.dependant.title.localeCompare(b.dependant.title, "he"));
  }, [s, rows, all]);
  const statusOf = (p: PairProposal): string => {
    const r = rows.get(p.dependant.key);
    if (!r || r.unavailable) return "לא נבדק";
    if (r.total === 0) return "בלי קישורים";
    const share = unlinkedShare(r);
    return share !== null ? `${Math.round(share * 100)}% בלי קישור` : `${n(r.total)} קישורים קיימים`;
  };
  return (
    <div class="repo-pairs">
      <div class="row">
        <button class="btn tonal" onClick={() => void repo.suggest()} disabled={repo.suggesting.value || !repo.books.value.length}>
          <Icon name="oz_book_links" size={18} />
          {s ? "הצעה מחדש" : "הצעת זוגות לפי השמות"}
        </button>
        {s && (
          <label class="check small">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.currentTarget.checked)} />
            <span>גם ספרים שכבר מקושרים</span>
          </label>
        )}
      </div>
      {!s && !repo.suggesting.value && (
        <p class="muted small" style="margin:0">
          הכלי מחפש פירושים וספרי הערות לפי השם ("... על ...") ולפי הקישורים שכבר יש לספר, ומציע לכל אחד את הספר שעליו הוא כתוב. זו הצעה בלבד: בוחרים מה מתאים, והמנועים אחר כך בודקים את השורות.
        </p>
      )}
      {repo.suggesting.value && <p class="muted" role="status">מחפש זוגות…</p>}
      {s && (
        <>
          <p class="muted small" role="status" style="margin:0">
            {n(s.proposals.length)} זוגות הוצעו מתוך {n(s.titled)} ספרים ששמם מציין ספר אחר
            {s.unresolved ? `; ל־${n(s.unresolved)} ספרים השם מציין ספר שלא נמצא` : ""}. מוצגים {n(visible.length)}.
            {!all && " (ספרים שכבר מקושרים מוסתרים, והספרים שלא נבדקו מוצגים.)"}
          </p>
          <ul class="repo-books" aria-label="זוגות מוצעים">
            {visible.slice(0, shown).map((p) => {
              const k = `${p.dependant.key}>${p.base.key}`;
              return (
                <li key={k} class="repo-pair">
                  <input type="checkbox" checked={picked.has(k)} onChange={() => repo.togglePickedPair(p)} aria-label={`בחירת הזוג ${p.dependant.title} על ${p.base.title}`} />
                  <div class="grow">
                    <b>{p.dependant.title}</b> <span aria-hidden="true">←</span>
                    <span class="sr-only"> על </span> {p.base.title}
                    <div class="repo-meta muted">
                      <span class={`fit-badge repo-conf-${p.confidence}`}>{CONFIDENCE[p.confidence]}</span> {p.kind === "notes" ? "ספר הערות" : "פירוש"} · {statusOf(p)}
                    </div>
                    <ul class="repo-reasons small muted">
                      {p.reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                </li>
              );
            })}
          </ul>
          {!visible.length && s.proposals.length > 0 && (
            <p class="muted" role="status">
              כל {n(s.proposals.length)} הזוגות שהוצעו הם של ספרים שכבר מקושרים. סמנו "גם ספרים שכבר מקושרים" כדי לראות אותם ולהשלים קישורים חסרים.
            </p>
          )}
          {!s.proposals.length && <p class="muted" role="status">לא נמצאו זוגות לפי השמות: אין ספרים ששמם מציין ספר אחר שפתוח.</p>}
          {visible.length > shown && (
            <div style="text-align:center">
              <button class="btn outlined" onClick={() => setShown(shown + PAIRS_PAGE)}>
                הצגת עוד ({n(visible.length - shown)} זוגות)
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
