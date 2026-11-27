import { useEffect, useState } from "preact/hooks";
import type { EngineId } from "../../linking/automatic";
import { parseSourceFilter, type SourceFilter, type SourceFilterPreview } from "../../linking/automatic/source-filter";
import { useStore } from "../context";

/*
 * Issue #27, the preview next to the line filter of the engine form: which lines of the source book the filter lets in, and which it
 * leaves out, before anything runs. It reads the book (through SuggestionsState.previewSourceFilter), runs nothing and changes nothing.
 * Shown only while a filter is chosen. Kept in its own file so the form stays as it was; PR 3 may restyle it.
 */
type Shown = SourceFilterPreview | { error: string };

/**
 * `books`: the books the filter applies to — one in a pair run, every commentary of a batch or a max-link plan (#42 C16), where a
 * choice says which one to look at. `filter`: the run's filter (max-link's runLineFilter); otherwise read from the engine's options.
 */
export function SourceFilterPreviewBox({ engine, books, options, filter: given }: { engine: EngineId; books: readonly string[]; options?: Record<string, unknown>; filter?: SourceFilter | null }) {
  const store = useStore();
  const filter = given !== undefined ? given : parseSourceFilter(options?.["sourceFilter"]);
  const key = filter ? JSON.stringify(filter) : "";
  const [picked, setPicked] = useState<string | null>(null);
  const source = picked && books.includes(picked) ? picked : (books[0] ?? null);
  const [shown, setShown] = useState<Shown | null>(null);
  // a changed filter, source or engine makes the old answer stale
  useEffect(() => setShown(null), [key, source, engine]);
  if (!filter || !source) return null;
  const look = async () => {
    const r = await store.suggestions.previewSourceFilter(source, filter, engine);
    if (r) setShown(r);
  };
  return (
    <div class="source-filter-preview" style="display:grid;gap:6px">
      <p class="muted" style="margin:0;font-size:var(--fs-sm)">סינון השורות חל על כל השיטות ועל כל הספרים של ההרצה: שורה שהוא אינו כולל לא תקבל הצעה.</p>
      {books.length > 1 && (
        <label class="field">
          הספר לתצוגה המקדימה
          <select value={source} onChange={(e) => setPicked(e.currentTarget.value)}>
            {books.map((k) => <option key={k} value={k}>{store.refOf(k).title}</option>)}
          </select>
        </label>
      )}
      <button class="adv-link" onClick={look} disabled={!!store.task.value}>
        תצוגה מקדימה: אילו שורות ייכנסו
      </button>
      {shown && "error" in shown && (
        <span class="field-error" role="alert">
          {shown.error}
        </span>
      )}
      {shown && !("error" in shown) && (
        <div role="status">
          <strong>
            {shown.included.toLocaleString("he")} מתוך {shown.total.toLocaleString("he")} שורות ייכנסו
          </strong>
          <span class="muted"> ({shown.excluded.toLocaleString("he")} ייעדרו; כותרות: {shown.headings.toLocaleString("he")}, ריקות: {shown.blank.toLocaleString("he")})</span>
          {shown.includedSample.length > 0 && (
            <details class="held" open>
              <summary>שורות שייכנסו (ההתאמה לפי המילים אחרי הסימן)</summary>
              <ul class="problems" style="margin-top:6px">
                {shown.includedSample.map((x) => (
                  <li key={x.line} class="info">
                    <span>
                      <span class="muted">שורה {(x.line + 1).toLocaleString("he")}: </span>
                      <bdi>{x.prefix}</bdi> {x.rest}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {shown.excludedSample.length > 0 && (
            <details class="held">
              <summary>שורות שלא ייכנסו</summary>
              <ul class="problems" style="margin-top:6px">
                {shown.excludedSample.map((x) => (
                  <li key={x.line} class="warning">
                    <span>
                      <span class="muted">שורה {(x.line + 1).toLocaleString("he")}: </span>
                      {x.text}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
