import { useEffect, useRef, useState } from "preact/hooks";
import { coverageSummary, linkOrigins, type LinkOrigins } from "./coverage-summary";
import type { CoverageSummary, LineCoverage, LineRange } from "../../linking/coverage";
import type { BookRef } from "../../core/links/model";
import { COVERAGE_RANGES_MAX, type ProjectCoverage } from "../../state/coverage";
import type { Side } from "../../state/store";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { countCoverage, coverageTrust, needsRecount, type FailedCount, type PanelSummary } from "./coverage-compute";
import { plainText } from "./plain-text";

/*
 * "Which parts of this book are still unlinked?" (issue 17), in the check tab. The numbers and the ranges come from
 * state/coverage.ts (linking/coverage.ts): every line is linked, covered only inside a range, linked to several places,
 * unlinked, or cannot carry a link (a heading). The list is the consecutive unlinked content lines, each with the start of
 * its text, a jump to it and "link by hand", which picks the range as the source of the builder. Nothing here changes a
 * link. It is computed from the project links and the links the book's database already has, as they are now, and again after
 * each change. The last result of each book is kept with the project (state/coverage.ts saved): until the book is counted again
 * the panel shows that one, with the day it was counted and a plain note that it is not up to date.
 */
const PAGE = 50;
const BUCKETS: readonly { id: LineCoverage; label: string; hint: string }[] = [
  { id: "linked", label: "מקושרות", hint: "השורה פותחת קישור אחד (או כמה אל אותו מקום)" },
  { id: "partial", label: "מקושרות חלקית", hint: "בשורה כמה יחידות (ציטוטים, הערות או הפניות) ורק חלקן מקושרות, או שרק טווח של שורה קודמת מגיע אליה" },
  { id: "multiple", label: "לכמה מקומות", hint: "שורה שמקושרת לשני מקומות שונים או יותר" },
  { id: "unlinked", label: "בלי קישור", hint: "שורת תוכן שאף קישור לא נוגע בה" },
  { id: "not-suitable", label: "כותרות", hint: "כותרת לא מקבלת קישור (אוצריא מוחקת אותו)" },
  { id: "candidate", label: "רק הצעה ממתינה", hint: "שורה שרק הצעה שעוד לא אושרה מגיעה אליה: היא אינה קישור עד שתאשרו אותה" },
  { id: "doubtful", label: "קישור בעייתי", hint: "שורה שהבדיקה מפקפקת בקישור שלה" },
];
const ORIGINS: readonly { id: keyof LinkOrigins; label: string }[] = [
  { id: "db", label: "מהמסד" },
  { id: "imported", label: "מיובאים" },
  { id: "manual", label: "נוצרו ידנית" },
  { id: "approved", label: "הצעות שאושרו" },
  { id: "pending", label: "הצעות ממתינות" },
  { id: "rejected", label: "הצעות שנדחו" },
];
const placeLabel = (r: LineRange) => (r.end > r.start ? `שורות ${r.start + 1}–${r.end + 1}` : `שורה ${r.start + 1}`);
const n = (x: number) => x.toLocaleString("he");

/** A saved coverage (ProjectCoverage) as the panel's summary: the buckets by name, the ranges as pairs. */
function fromSaved(c: ProjectCoverage): CoverageSummary {
  const byBucket: Record<LineCoverage, number> = { linked: 0, unlinked: 0, partial: 0, multiple: 0, "not-suitable": 0, candidate: 0, doubtful: 0 };
  for (const [k, v] of Object.entries(c.buckets)) if (k in byBucket) byBucket[k as LineCoverage] = v;
  const suitable = c.lines - byBucket["not-suitable"];
  return { total: c.lines, byBucket, suitable, unlinked: byBucket.unlinked, unlinkedShare: suitable ? byBucket.unlinked / suitable : 0, ranges: c.ranges.map(([start, end]) => ({ start, end })) };
}
const stamp = (at: number) => new Date(at).toLocaleString("he", { dateStyle: "medium", timeStyle: "short" });

/** The book's links by origin (#17, V7 §3.12), as they are now; the database's count is "לא ידוע" when it was not read, never 0. */
function Origins({ bookKey, links }: { bookKey: string; links: PanelSummary["links"] }) {
  const store = useStore();
  const state = store.suggestions.state.value;
  const mine = (s: { source: { book: BookRef }; target: { book: BookRef } }) => store.sameBook(s.source.book, bookKey) || store.sameBook(s.target.book, bookKey);
  const states = (store.suggestions.run.value?.result.suggestions ?? []).filter(mine).map((s) => state.get(s.id) ?? "pending");
  const o = linkOrigins(store.linksOfBook(bookKey), links, states);
  return (
    <ul class="cov-counts" aria-label="קישורים לפי מקור">
      {ORIGINS.filter((x) => o[x.id] !== undefined).map((x) => (
        <li key={x.id} class="cov-count" data-origin={x.id}>
          <span>{x.label}</span> <b>{o[x.id] === null ? "לא ידוע" : n(o[x.id]!)}</b>
        </li>
      ))}
    </ul>
  );
}

export function CoveragePanel() {
  const store = useStore();
  const [side, setSide] = useState<Side>("source");
  const [summary, setSummary] = useState<PanelSummary | null>(null);
  const [failed, setFailed] = useState<FailedCount | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const bookKey = store.view[side].value;
  const book = bookKey ? store.books.value.get(bookKey) : undefined;
  const dbBook = !!bookKey && store.sources.value.some((x) => x.info.kind !== "text-files" && x.books.some((b) => b.key === bookKey));
  const revision = store.linkState.value.revision;
  store.lines.tick.value; // the start of each range's text arrives with its chunk

  const compute = async () => {
    if (!bookKey || busy) return;
    setBusy(true);
    setFailed(null);
    const out = await countCoverage((k) => store.coverage.summary(k), bookKey, revision, (k) => store.books.value.has(k));
    setBusy(false);
    if (!out.ok) {
      // remembered by book and revision, so the "links changed" rule below does not ask again by itself
      setFailed(out.failed);
      // a count the user stopped is no failure: nothing is announced as one
      return out.failed.cancelled ? undefined : void store.notify("warning", out.failed.message);
    }
    setSummary(out.summary);
    setShown(PAGE);
  };
  // once computed, a change of the links (a link made, undone, imported) makes the numbers again
  useEffect(() => {
    if (needsRecount({ summary, bookKey, revision, busy, failed })) void compute();
  }, [revision, bookKey, busy]);

  const fresh = summary && summary.bookKey === bookKey ? summary : null;
  // what the project kept of this book's last count (by title), until it is counted again in this session
  const kept = book ? store.coverage.saved.value.get(book.title) : undefined;
  const current = fresh ?? (kept ? fromSaved(kept) : null);
  const stale = !fresh && !!kept;
  // what the read of the database's links said: a failed or missing read is never shown as "no links" or "all unlinked"
  const trust = coverageTrust(fresh?.links);
  const countedAt = kept?.at;
  // the start of the text of the ranges shown
  useEffect(() => {
    if (!current || !bookKey) return;
    for (const r of current.ranges.slice(0, shown)) void store.lines.load(bookKey, r.start, r.start).catch(() => {});
  }, [current, shown, bookKey]);

  // "כיסוי הספר" in the suggestions panel asks for this section: open it and bring it into view (#41 B26 — it came folded, out of view)
  const section = useRef<HTMLDetailsElement>(null);
  const asked = store.coverageFocus.value;
  useEffect(() => {
    const el = section.current;
    if (!asked || !el) return;
    el.open = true;
    el.scrollIntoView({ block: "start" });
    el.querySelector("summary")?.focus({ preventScroll: true });
  }, [asked]);

  const show = (r: LineRange) => bookKey && store.reveal(side, bookKey, r.start);
  const byHand = (r: LineRange) => {
    if (!bookKey) return;
    store.reveal(side, bookKey, r.start);
    store.pickLine(side, bookKey, r.start);
    if (r.end > r.start) store.pickLine(side, bookKey, r.end, true);
    store.sideTab.value = "builder";
  };

  return (
    <details class="coverage" ref={section}>
      <summary>כיסוי הספר — אילו שורות עדיין בלי קישור</summary>
      <div class="cov-body">
        <div class="row">
          <label class="field grow">
            הספר
            <select value={side} onChange={(e) => (setSide(e.currentTarget.value as Side), setSummary(null), setFailed(null))}>
              {(["source", "target"] as const).map((k) => (
                <option key={k} value={k} disabled={!store.view[k].value}>
                  {store.roles.value[k].name}: {store.view[k].value ? (store.books.value.get(store.view[k].value!)?.title ?? "") : "לא נבחר ספר"}
                </option>
              ))}
            </select>
          </label>
          <button class="btn tonal" onClick={() => void compute()} disabled={!book || busy}>
            <Icon name="oz_link_check" size={18} />
            {current ? "חישוב מחדש" : "חישוב כיסוי"}
          </button>
        </div>
        {!book && <p class="muted">בחרו ספר באחד הקוראים כדי לראות מה עוד לא מקושר בו.</p>}
        {book && failed && failed.bookKey === bookKey && !failed.cancelled && (
          <p class="warn-text" role="alert">
            {failed.message}
          </p>
        )}
        {book && failed && failed.bookKey === bookKey && failed.cancelled && (
          <p class="muted small" role="status">
            החישוב הופסק. לחצו "חישוב כיסוי" כדי לחשב שוב.
          </p>
        )}
        {book && dbBook && (
          <p class="warn-text" role="note">
            הספר הזה הוא מתוך מסד. הקישורים שיש לו במסד נקראים מהמסד ונספרים יחד עם קישורי הפרויקט, ולכן שורה שהמסד כבר מקשר לא תופיע כ"בלי קישור". בספר גדול הקריאה לוקחת כמה שניות.
          </p>
        )}
        {current && !trust.reliable && (
          <p class="warn-text" role="alert" data-links={trust.kind}>
            {trust.text}
          </p>
        )}
        {current && trust.reliable && (
          <>
            {countedAt !== undefined && (
              <p class={`cov-stamp small ${stale ? "warn-text" : "muted"}`} role="note" data-stale={stale || undefined}>
                {stale ? "זה החישוב האחרון ששמור בפרויקט, מ־" : "חושב לאחרונה: "}
                <time class="cov-time" dateTime={new Date(countedAt).toISOString()}>{stamp(countedAt)}</time>
                {stale ? ". הוא לא מתעדכן לבד: ייתכן שהקישורים השתנו מאז. לחצו \"חישוב מחדש\" כדי לראות את המצב עכשיו." : "."}
                {stale && current.ranges.length >= COVERAGE_RANGES_MAX && ` רשימת הקטעים שנשמרה קוצרה ל־${n(COVERAGE_RANGES_MAX)} קטעים; המספרים מדויקים.`}
              </p>
            )}
            <p class="cov-sum" role="status">
              {coverageSummary(current)}
              <span class="muted"> {dbBook ? "קישורי הפרויקט וקישורי המסד נספרים." : "רק קישורי הפרויקט נספרים."}</span>
            </p>
            <ul class="cov-counts">
              {BUCKETS.map((b) => (
                <li key={b.id} class="cov-count" data-bucket={b.id} title={b.hint}>
                  <span>{b.label}</span> <b>{n(current.byBucket[b.id])}</b>
                </li>
              ))}
            </ul>
            {fresh && bookKey && <Origins bookKey={bookKey} links={fresh.links} />}
            {current.ranges.length > 0 && (
              <ol class="cov-ranges" aria-label="קטעים בלי קישור">
                {current.ranges.slice(0, shown).map((r) => {
                  const line = bookKey ? store.lines.peek(bookKey, r.start) : undefined;
                  const words = line ? plainText(line.text).trim().split(/\s+/).slice(0, 8).join(" ") : "";
                  return (
                    <li key={r.start} class="cov-range">
                      <span class="cov-where">
                        <b>{placeLabel(r)}</b>
                        {words && <span class="muted"> {words}…</span>}
                      </span>
                      <button class="btn text small" onClick={() => show(r)} aria-label={`הצגה: ${placeLabel(r)}`}>
                        הצגה
                      </button>
                      <button class="btn text small" onClick={() => byHand(r)} aria-label={`קישור ידני: ${placeLabel(r)}`}>
                        קישור ידני
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
            {current.ranges.length > shown && (
              <button class="btn outlined" onClick={() => setShown(shown + PAGE)}>
                הצגת עוד ({n(current.ranges.length - shown)} קטעים)
              </button>
            )}
          </>
        )}
      </div>
    </details>
  );
}
