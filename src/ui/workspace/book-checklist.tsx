import { useState } from "preact/hooks";
import { sourceIdOfBookKey } from "../../core/books";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { useBookSearch } from "./book-picker";

/*
 * Choosing books by ticking them (issue 26: "these books" — two, three, any subset). A search box narrows the list without
 * losing what is ticked, and with more than one file or database open, a filter shows the books of one of them (V7 §3.7); the
 * ticked books keep the order they were ticked in (a plan lists them so). A book with the same title in several sources says
 * which source it is from. The ticked books are listed above, each with a quick remove; `ordered` numbers them, for a choice whose
 * order matters (the target books of a commentary). Used for max-link's "books I choose", the targets of one book in pair mode,
 * and the guided plan's target books.
 */
const SHOWN = 200;

export function BookChecklist({ label, selected, onChange, exclude, ordered }: { label: string; selected: readonly string[]; onChange: (keys: readonly string[]) => void; exclude?: readonly (string | null | undefined)[]; ordered?: boolean }) {
  const store = useStore();
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const { hits } = useBookSearch(query);
  const sources = store.sources.value;
  const list = hits.filter((b) => !exclude?.includes(b.key) && (!from || sourceIdOfBookKey(b.key) === from));
  const byTitle = store.booksByTitle.value;
  const ticked = new Set(selected);
  const toggle = (key: string, on: boolean) => onChange(on ? [...selected, key] : selected.filter((k) => k !== key));
  const sourceLabel = (key: string) => sources.find((s) => s.info.id === sourceIdOfBookKey(key))?.info.label ?? "";
  const twin = (key: string, title: string) => new Set((byTitle.get(title) ?? []).map((x) => sourceIdOfBookKey(x.key))).size > 1 && key;
  const chosen = selected.flatMap((k) => {
    const b = store.books.value.get(k);
    return b ? [b] : [];
  });
  return (
    <fieldset class="book-checklist">
      <legend>{label}</legend>
      <div class="pick-filters">
        <input type="search" aria-label={`חיפוש ספר: ${label}`} placeholder="חיפוש ספר…" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
        {sources.length > 1 && (
          <select aria-label={`מתוך איזה קובץ או מסד: ${label}`} value={from} onChange={(e) => setFrom(e.currentTarget.value)}>
            <option value="">מכל הקבצים והמסדים</option>
            {sources.map((s) => (
              <option key={s.info.id} value={s.info.id}>{s.info.label}</option>
            ))}
          </select>
        )}
      </div>
      <p class="muted pick-count">
        <span role="status">נבחרו {selected.length.toLocaleString("he")}</span>
        {selected.length > 0 && (
          <>
            {" · "}
            <button class="link-btn" onClick={() => onChange([])}>ניקוי הבחירה</button>
          </>
        )}
      </p>
      {chosen.length > 0 && (
        <ol class={`picked${ordered ? " ordered" : ""}`} aria-label={`נבחרו: ${label}`}>
          {chosen.map((b) => (
            <li key={b.key}>
              <span class="grow">
                {b.title}
                {twin(b.key, b.title) && <span class="muted"> — מתוך {sourceLabel(b.key)}</span>}
              </span>
              <button class="icon-btn" onClick={() => toggle(b.key, false)} aria-label={`הסרת ${b.title}`} title="הסרה">
                <Icon name="fl_dismiss" size={14} />
              </button>
            </li>
          ))}
        </ol>
      )}
      <ul class="pick-list">
        {list.slice(0, SHOWN).map((b) => (
          <li key={b.key}>
            <label class="check">
              <input type="checkbox" checked={ticked.has(b.key)} onChange={(e) => toggle(b.key, e.currentTarget.checked)} />
              <span>
                {b.title}
                {twin(b.key, b.title) && <span class="muted"> — מתוך {sourceLabel(b.key)}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {list.length > SHOWN && <p class="muted">מוצגים {SHOWN} מתוך {list.length.toLocaleString("he")} — הקלידו כדי לצמצם.</p>}
      {!list.length && <p class="muted">{query.trim() || from ? "אין ספר כזה בקבצים ובמסדים שבחרתם." : "אין ספרים פתוחים."}</p>}
    </fieldset>
  );
}
