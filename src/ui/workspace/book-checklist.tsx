import { useState } from "preact/hooks";
import { sourceIdOfBookKey } from "../../core/books";
import { useStore } from "../context";
import { useBookSearch } from "./book-picker";

/*
 * Choosing books by ticking them (issue 26: "these books" — two, three, any subset). A search box narrows the list without
 * losing what is ticked; the ticked books keep the order they were ticked in (a plan lists them so). A book with the same
 * title in several sources says which source it is from. Used for max-link's "books I choose" and for the targets of one
 * book in pair mode.
 */
const SHOWN = 200;

export function BookChecklist({ label, selected, onChange, exclude }: { label: string; selected: readonly string[]; onChange: (keys: readonly string[]) => void; exclude?: readonly (string | null | undefined)[] }) {
  const store = useStore();
  const [query, setQuery] = useState("");
  const { hits } = useBookSearch(query);
  const list = hits.filter((b) => !exclude?.includes(b.key));
  const byTitle = store.booksByTitle.value;
  const ticked = new Set(selected);
  const toggle = (key: string, on: boolean) => onChange(on ? [...selected, key] : selected.filter((k) => k !== key));
  const sourceLabel = (key: string) => store.sources.value.find((s) => s.info.id === sourceIdOfBookKey(key))?.info.label ?? "";
  return (
    <fieldset class="book-checklist">
      <legend>{label}</legend>
      <input type="search" aria-label={`חיפוש ספר: ${label}`} placeholder="חיפוש ספר…" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
      <p class="muted pick-count">
        <span role="status">נבחרו {selected.length.toLocaleString("he")}</span>
        {selected.length > 0 && (
          <>
            {" · "}
            <button class="link-btn" onClick={() => onChange([])}>ניקוי הבחירה</button>
          </>
        )}
      </p>
      <ul class="pick-list">
        {list.slice(0, SHOWN).map((b) => {
          const twin = new Set((byTitle.get(b.title) ?? []).map((x) => sourceIdOfBookKey(x.key))).size > 1;
          return (
            <li key={b.key}>
              <label class="check">
                <input type="checkbox" checked={ticked.has(b.key)} onChange={(e) => toggle(b.key, e.currentTarget.checked)} />
                <span>
                  {b.title}
                  {twin && <span class="muted"> — מתוך {sourceLabel(b.key)}</span>}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {list.length > SHOWN && <p class="muted">מוצגים {SHOWN} מתוך {list.length.toLocaleString("he")} — הקלידו כדי לצמצם.</p>}
      {!list.length && <p class="muted">{query.trim() ? "אין ספר בשם הזה במקורות הפתוחים." : "אין ספרים פתוחים."}</p>}
    </fieldset>
  );
}
