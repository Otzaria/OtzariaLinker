import { useMemo, useState } from "preact/hooks";
import type { SourceBook } from "../../core/books";
import { normalize } from "../../core/text/hebrew";
import type { Side } from "../../state/store";
import { useStore } from "../context";

/*
 * Searchable list of every open book. A database has thousands of books, so only the best matches
 * are rendered; the search ignores nikud and quote-mark differences (search normalisation only).
 */
const LIMIT = 200;

export function useBookSearch(query: string): { hits: SourceBook[]; total: number } {
  const store = useStore();
  const all = store.books.value;
  const index = useMemo(() => [...all.values()].map((b) => ({ b, key: normalize(b.title) })), [all]);
  return useMemo(() => {
    const q = normalize(query.trim());
    if (!q) return { hits: index.slice(0, LIMIT).map((x) => x.b), total: index.length };
    const starts: SourceBook[] = [];
    const contains: SourceBook[] = [];
    for (const x of index) {
      if (x.key.startsWith(q)) starts.push(x.b);
      else if (x.key.includes(q)) contains.push(x.b);
    }
    const all2 = [...starts, ...contains];
    return { hits: all2.slice(0, LIMIT), total: all2.length };
  }, [index, query]);
}

export function BookList({ query, onPick }: { query: string; onPick?: (side: Side, key: string) => void }) {
  const store = useStore();
  const { hits, total } = useBookSearch(query);
  const show = onPick ?? ((side: Side, key: string) => store.showBook(side, key));
  const multi = store.sources.value.length > 1;
  const labelOf = (key: string) => store.sources.value.find((s) => key.startsWith(`${s.info.id}:`))?.info.label;
  return (
    <>
      <ul class="book-list" aria-label="ספרים">
        {hits.map((b) => (
          <li key={b.key}>
            <button class="title" title={b.path ?? b.title} onClick={() => show(store.view.source.value ? "target" : "source", b.key)}>
              <span class="name">{b.title}</span>
              {(b.origin === "sefaria" || multi) && (
                <span class="meta">{[b.origin === "sefaria" && "ספריא", multi && labelOf(b.key)].filter(Boolean).join(" · ")}</span>
              )}
            </button>
            <button class="side-btn" aria-pressed={store.view.source.value === b.key} onClick={() => show("source", b.key)} title="להציג כספר המקור">
              מקור
            </button>
            <button class="side-btn" aria-pressed={store.view.target.value === b.key} onClick={() => show("target", b.key)} title="להציג כספר היעד">
              יעד
            </button>
          </li>
        ))}
      </ul>
      {total > hits.length && <p class="muted" style="padding:0 12px">מוצגים {hits.length} מתוך {total.toLocaleString("he")} — הקלידו כדי לצמצם.</p>}
    </>
  );
}
