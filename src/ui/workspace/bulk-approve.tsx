import { useMemo, useState } from "preact/hooks";
import { CONFIDENCE_LABELS, ENGINES, type Confidence, type EngineId } from "../../linking/automatic";
import { BULK_DEFAULT_LEVELS } from "../../state/suggestions";
import { useStore } from "../context";
import { Icon } from "../icons/icon";

/*
 * Approving many suggestions together (V5 UX audit U21, the owner's decision): the default stays one
 * by one — this is a closed section the user opens. It narrows to all pending suggestions, one book or
 * one method, at the levels ticked ("ודאית" and "גבוהה" to start with; "אפשרית" and "עמומה" only when
 * ticked); before anything is approved it says how many, per level, and how many file records they
 * write; the approval is the ordinary one (store.suggestions.approve) — ONE undoable step, with its own
 * "ביטול האישור" right here.
 */
const LEVELS: readonly Confidence[] = ["certain", "high", "possible", "ambiguous"];
const PLURAL: Record<Confidence, string> = { certain: "ודאיות", high: "גבוהות", possible: "אפשריות", ambiguous: "עמומות", none: "בלי התאמה" };
const n = (x: number) => x.toLocaleString("he");
type Scope = "all" | "book" | "engine";

export function BulkApprove() {
  const store = useStore();
  const sg = store.suggestions;
  const run = sg.run.value;
  const st = sg.state.value;
  const [scope, setScope] = useState<Scope>("all");
  const [book, setBook] = useState("");
  const [engine, setEngine] = useState<EngineId | "">("");
  const [levels, setLevels] = useState<ReadonlySet<Confidence>>(new Set(BULK_DEFAULT_LEVELS));
  /** the last bulk approval made here, while it is still the last step in the history */
  const [done, setDone] = useState<{ n: number; label: string } | null>(null);
  const groups = useMemo(() => sg.bulkGroups(), [run, st]);
  const pickedBook = groups.books.some((b) => b.title === book) ? book : (groups.books[0]?.title ?? "");
  const pickedEngine = groups.engines.some((e) => e.id === engine) ? engine : (groups.engines[0]?.id ?? "");
  const preview = useMemo(
    () => sg.bulkPreview({ levels: [...levels], ...(scope === "book" && pickedBook && { book: pickedBook }), ...(scope === "engine" && pickedEngine && { engine: pickedEngine }) }),
    [run, st, scope, pickedBook, pickedEngine, levels],
  );
  const lastStep = store.linkState.value.undo.at(-1)?.label;
  const undoable = done && lastStep === done.label;
  if (!run || (!groups.engines.length && !undoable)) return null;
  const unread = !!run.dbLinksUnread?.length;
  const count = preview.ids.length;
  const toggle = (c: Confidence) => {
    const next = new Set(levels);
    if (!next.delete(c)) next.add(c);
    setLevels(next);
  };
  const approve = () => {
    const made = sg.approve(preview.ids);
    if (made) setDone({ n: made, label: store.linkState.value.undo.at(-1)?.label ?? "" });
  };
  const engineTitle = (id: string) => ENGINES.find((e) => e.id === id)?.title ?? id;
  const parts = LEVELS.filter((c) => preview.byLevel[c]).map((c) => `${n(preview.byLevel[c]!)} ${PLURAL[c]}`);

  return (
    <details class="held bulk-approve">
      <summary>אישור כמה הצעות יחד (לא חובה)</summary>
      <p class="muted small">בדרך כלל עוברים על ההצעות אחת אחת. כאן אפשר לאשר קבוצה שלמה — אחרי שרואים כמה הצעות ייכללו בה.</p>
      <div class="bulk-scope" role="radiogroup" aria-label="אילו הצעות">
        {(
          [
            ["all", "כל הספרים והשיטות"],
            ["book", "ספר אחד"],
            ["engine", "שיטה אחת"],
          ] as const
        ).map(([k, label]) => (
          <label key={k} class="check">
            <input type="radio" name="bulk-scope" checked={scope === k} onChange={() => setScope(k)} />
            <span>{label}</span>
          </label>
        ))}
      </div>
      {scope === "book" && (
        <label class="field">
          הספר
          <select value={pickedBook} onChange={(e) => setBook(e.currentTarget.value)}>
            {groups.books.map((b) => (
              <option key={b.title} value={b.title}>{b.title} ({n(b.count)})</option>
            ))}
          </select>
        </label>
      )}
      {scope === "engine" && (
        <label class="field">
          השיטה
          <select value={pickedEngine} onChange={(e) => setEngine(e.currentTarget.value as EngineId)}>
            {groups.engines.map((e) => (
              <option key={e.id} value={e.id}>{engineTitle(e.id)} ({n(e.count)})</option>
            ))}
          </select>
        </label>
      )}
      <fieldset class="bulk-levels">
        <legend>רמות הוודאות שנכללות</legend>
        {LEVELS.map((c) => (
          <label key={c} class="check">
            <input type="checkbox" checked={levels.has(c)} onChange={() => toggle(c)} />
            <span>{CONFIDENCE_LABELS[c]}</span>
          </label>
        ))}
      </fieldset>
      <p class="bulk-preview" role="status">
        {count ? (
          <>
            <b>יאושרו {n(count)} הצעות</b>: {parts.join(", ")}.
            {preview.records !== count && ` ייכתבו ${n(preview.records)} רשומות בקובץ (הצעה על טווח בספר ספריא נכתבת שורה אחר שורה).`}
          </>
        ) : (
          "אין הצעות ממתינות שמתאימות לבחירה."
        )}{" "}
        הצעות "אפשרית" ו"עמומה" לא נכללות אלא אם סימנתם אותן.
      </p>
      <div class="row">
        <button class="btn filled" disabled={!count || unread} onClick={approve} title={unread ? "מושבת: הקישורים שכבר יש במסד לא נקראו" : undefined}>
          <Icon name="oz_link_check" size={18} />
          {count ? `אישור ${n(count)} ההצעות` : "אישור"}
        </button>
        {undoable && (
          <span class="bulk-done" role="status">
            אושרו {n(done.n)} הצעות.{" "}
            <button class="btn text" onClick={() => (store.undo(), setDone(null))}>
              ביטול האישור
            </button>
          </span>
        )}
      </div>
    </details>
  );
}
