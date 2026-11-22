import { useEffect, useState } from "preact/hooks";
import type { CoverageSummary, LineCoverage, LineRange } from "../../linking/coverage";
import type { Side } from "../../state/store";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { plainText } from "./plain-text";

/*
 * "Which parts of this book are still unlinked?" (issue 17), in the check tab. The numbers and the ranges come from
 * state/coverage.ts (linking/coverage.ts): every line is linked, covered only inside a range, linked to several places,
 * unlinked, or cannot carry a link (a heading). The list is the consecutive unlinked content lines, each with the start of
 * its text, a jump to it and "link by hand", which picks the range as the source of the builder. Nothing here changes a
 * link. It is computed from the project links as they are now, and again after each change; it is not saved with the
 * project (cheap to recompute), and the links the database already has are not counted.
 */
const PAGE = 50;
const BUCKETS: readonly { id: LineCoverage; label: string; hint: string }[] = [
  { id: "linked", label: "מקושרות", hint: "השורה פותחת קישור אחד (או כמה אל אותו מקום)" },
  { id: "partial", label: "מכוסות בטווח", hint: "קישור של שורה קודמת מגיע עד אליה בטווח" },
  { id: "multiple", label: "לכמה מקומות", hint: "שורה שמקושרת לשני מקומות שונים או יותר" },
  { id: "unlinked", label: "בלי קישור", hint: "שורת תוכן שאף קישור לא נוגע בה" },
  { id: "not-suitable", label: "כותרות", hint: "כותרת לא מקבלת קישור (אוצריא מוחקת אותו)" },
];
const placeLabel = (r: LineRange) => (r.end > r.start ? `שורות ${r.start + 1}–${r.end + 1}` : `שורה ${r.start + 1}`);
const n = (x: number) => x.toLocaleString("he");

export function CoveragePanel() {
  const store = useStore();
  const [side, setSide] = useState<Side>("source");
  const [summary, setSummary] = useState<(CoverageSummary & { bookKey: string; revision: number }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const bookKey = store.view[side].value;
  const book = bookKey ? store.books.value.get(bookKey) : undefined;
  const revision = store.linkState.value.revision;
  store.lines.tick.value; // the start of each range's text arrives with its chunk

  const compute = async () => {
    if (!bookKey || busy) return;
    setBusy(true);
    const s = await store.coverage.summary(bookKey);
    setBusy(false);
    if (!s) return void store.notify("warning", "אי אפשר לחשב כיסוי: הספר לא פתוח, או שאורכו עדיין לא ידוע. פתחו אותו בקורא ונסו שוב.");
    setSummary({ ...s, bookKey, revision });
    setShown(PAGE);
  };
  // once computed, a change of the links (a link made, undone, imported) makes the numbers again
  useEffect(() => {
    if (summary && summary.bookKey === bookKey && summary.revision !== revision && !busy) void compute();
  }, [revision]);

  const current = summary && summary.bookKey === bookKey ? summary : null;
  // the start of the text of the ranges shown
  useEffect(() => {
    if (!current || !bookKey) return;
    for (const r of current.ranges.slice(0, shown)) void store.lines.load(bookKey, r.start, r.start).catch(() => {});
  }, [current, shown, bookKey]);

  const show = (r: LineRange) => bookKey && store.reveal(side, bookKey, r.start);
  const byHand = (r: LineRange) => {
    if (!bookKey) return;
    store.reveal(side, bookKey, r.start);
    store.pickLine(side, bookKey, r.start);
    if (r.end > r.start) store.pickLine(side, bookKey, r.end, true);
    store.sideTab.value = "builder";
  };

  return (
    <details class="coverage">
      <summary>כיסוי הספר — אילו שורות עדיין בלי קישור</summary>
      <div class="cov-body">
        <div class="row">
          <label class="field grow">
            הספר
            <select value={side} onChange={(e) => (setSide(e.currentTarget.value as Side), setSummary(null))}>
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
        {current && (
          <>
            <p class="cov-sum" role="status">
              {current.suitable === 0
                ? "אין בספר שורות תוכן."
                : current.unlinked === 0
                  ? `כל ${n(current.suitable)} שורות התוכן של הספר מקושרות או מכוסות בטווח.`
                  : `${n(current.unlinked)} מתוך ${n(current.suitable)} שורות תוכן (${Math.round(current.unlinkedShare * 100)}%) עדיין בלי קישור, ב־${n(current.ranges.length)} קטעים.`}
              <span class="muted"> רק קישורי הפרויקט נספרים, לא קישורי המסד.</span>
            </p>
            <ul class="cov-counts">
              {BUCKETS.map((b) => (
                <li key={b.id} class="cov-count" data-bucket={b.id} title={b.hint}>
                  <span>{b.label}</span> <b>{n(current.byBucket[b.id])}</b>
                </li>
              ))}
            </ul>
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
