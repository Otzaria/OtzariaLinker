import { useMemo, useState } from "preact/hooks";
import type { SourceBook } from "../../core/books";
import { sourceIdOfBookKey } from "../../core/books";
import { normalize } from "../../core/text/hebrew";
import type { OpenedSource } from "../../state/services";
import type { Side } from "../../state/store";
import { useStore } from "../context";
import { badgeOf, SourceBadge } from "./source-badge";

/*
 * Searchable list of every open book, grouped by source when more than one is open (the Otzaria
 * database last: its thousands of books would otherwise push a folder's few out of sight). A
 * database has thousands of books, so only the best matches of each source are rendered; the search
 * ignores nikud and quote-mark differences (search normalisation only). A title that more than one
 * source has is marked, so the user picks the copy they mean.
 */
const LIMIT = 200;

export function useBookSearch(query: string): { hits: SourceBook[]; total: number } {
  const store = useStore();
  const all = store.books.value;
  const index = useMemo(() => [...all.values()].map((b) => ({ b, key: normalize(b.title) })), [all]);
  return useMemo(() => {
    const q = normalize(query.trim());
    if (!q) return { hits: index.map((x) => x.b), total: index.length };
    const starts: SourceBook[] = [];
    const contains: SourceBook[] = [];
    for (const x of index) {
      if (x.key.startsWith(q)) starts.push(x.b);
      else if (x.key.includes(q)) contains.push(x.b);
    }
    const all2 = [...starts, ...contains];
    return { hits: all2, total: all2.length };
  }, [index, query]);
}

interface Group {
  source: OpenedSource;
  books: SourceBook[];
  total: number;
}

export function BookList({ query, onPick }: { query: string; onPick?: (side: Side, key: string) => void }) {
  const store = useStore();
  const { hits } = useBookSearch(query);
  const show = onPick ?? ((side: Side, key: string) => store.showBook(side, key));
  const sources = store.sources.value;
  const multi = sources.length > 1;
  const byTitle = store.booksByTitle.value;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const groups = useMemo(() => {
    const m = new Map<string, Group>();
    // the Otzaria database last; otherwise in the order the sources were opened
    const order = [...sources].sort((a, b) => Number(badgeOf(a).kind === "otzaria") - Number(badgeOf(b).kind === "otzaria"));
    for (const s of order) m.set(s.info.id, { source: s, books: [], total: 0 });
    for (const b of hits) {
      const g = m.get(sourceIdOfBookKey(b.key));
      if (!g) continue;
      g.total++;
      if (g.books.length < LIMIT) g.books.push(b);
    }
    return [...m.values()];
  }, [hits, sources]);
  const sameTitle = (b: SourceBook) => new Set((byTitle.get(b.title) ?? []).map((x) => sourceIdOfBookKey(x.key))).size > 1;

  const row = (b: SourceBook, g: Group) => {
    const twin = multi && sameTitle(b);
    return (
      <li key={b.key} class={twin ? "twin" : undefined}>
        <button class="title" title={b.path ?? b.title} onClick={() => show(store.view.source.value ? "target" : "source", b.key)}>
          <span class="name">{b.title}</span>
          {(b.origin === "sefaria" || twin || b.path?.includes("/")) && (
            <span class="meta">
              {[b.origin === "sefaria" && "ספריא", b.path?.includes("/") && b.path, twin && `גם במקור אחר — זה מ־${g.source.info.label}`].filter(Boolean).join(" · ")}
            </span>
          )}
        </button>
        <button class="side-btn" aria-pressed={store.view.source.value === b.key} onClick={() => show("source", b.key)} title="להציג כספר המקור">
          מקור
        </button>
        <button class="side-btn" aria-pressed={store.view.target.value === b.key} onClick={() => show("target", b.key)} title="להציג כספר היעד">
          יעד
        </button>
      </li>
    );
  };

  if (!multi) {
    const g = groups[0];
    if (!g) return null;
    return (
      <>
        <ul class="book-list" aria-label="ספרים">{g.books.map((b) => row(b, g))}</ul>
        {g.total > g.books.length && <p class="muted" style="padding:0 12px">מוצגים {g.books.length} מתוך {g.total.toLocaleString("he")} — הקלידו כדי לצמצם.</p>}
        {g.total === 0 && query.trim() && <p class="muted" style="padding:0 12px">אין ספר בשם הזה במקורות הפתוחים.</p>}
      </>
    );
  }
  const found = groups.reduce((n, g) => n + g.total, 0);
  return (
    <div class="book-groups" aria-label="ספרים לפי מקור">
      {groups.map((g) => {
        const shut = collapsed.has(g.source.info.id);
        return (
          <section key={g.source.info.id} class="book-group" aria-label={`ספרים מ־${g.source.info.label}`}>
            <button
              class="group-head"
              aria-expanded={!shut}
              onClick={() => setCollapsed((c) => { const n = new Set(c); shut ? n.delete(g.source.info.id) : n.add(g.source.info.id); return n; })}
            >
              <span class="chev" aria-hidden="true">{shut ? "◂" : "▾"}</span>
              <SourceBadge source={g.source} />
              <bdi class="grow label">{g.source.info.label}</bdi>
              <span class="count">{g.total.toLocaleString("he")}</span>
            </button>
            {!shut && (
              <>
                <ul class="book-list" aria-label={`ספרים מ־${g.source.info.label}`}>{g.books.map((b) => row(b, g))}</ul>
                {g.total > g.books.length && <p class="muted" style="padding:0 12px;margin:2px 0 6px">מוצגים {g.books.length} מתוך {g.total.toLocaleString("he")} — הקלידו כדי לצמצם.</p>}
              </>
            )}
          </section>
        );
      })}
      {found === 0 && query.trim() && <p class="muted" style="padding:0 12px">אין ספר בשם הזה באף מקור פתוח.</p>}
    </div>
  );
}
