import { useState } from "preact/hooks";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { AddSources } from "./add-sources";
import { BookList } from "./book-picker";
import { badgeOf, SourceBadge } from "./source-badge";

/**
 * "Are these the library's own books?" — one switch per source, shown only where it matters: a source
 * with a book the library names like a Sefaria book ("בראשית"). On: the library's Sefaria rules apply
 * to those books; off: they are the user's own (core/links/sefaria-titles.ts, product audit F2).
 */
function LibrarySwitch({ sourceId }: { sourceId: string }) {
  const store = useStore();
  const named = store.sefariaNamedBooks(sourceId);
  if (!named.length) return null;
  const on = store.isLibrarySource(sourceId);
  const which = `${named.slice(0, 2).map((t) => `"${t}"`).join(", ")}${named.length > 2 ? ` ועוד ${(named.length - 2).toLocaleString("he")}` : ""}`;
  return (
    <label
      class="library-switch"
      title={`בספריית אוצריא ${which} ${named.length === 1 ? "הוא ספר" : "הם ספרים"} של ספריא. סמנו אם המקור הזה הוא ספריית אוצריא עצמה (או עותק שלה): אז הקישורים אליהם נבדקים לפי הכללים של ספרי ספריא. בלי הסימון אלה ספרים שלכם, והכללים האלה לא חלים עליהם.`}
    >
      <input type="checkbox" checked={on} onChange={(e) => store.setLibrarySource(sourceId, e.currentTarget.checked)} />
      ספרי ספריית אוצריא
    </label>
  );
}

/** Open sources (databases, folders, files), adding more, and a search over all their books. */
export function SourcesBody() {
  const store = useStore();
  const [q, setQ] = useState("");
  const sources = store.sources.value;
  return (
    <>
      <div class="sources-list">
        {sources.length === 0 && (
          <p class="muted empty-sources">
            אין מקור פתוח. הוסיפו תיקייה, קבצים או מסד — אפשר כמה מקורות יחד, ולקשר בין ספרים של מקורות שונים.
          </p>
        )}
        {sources.map((s) => (
          <div class="source-row" key={s.info.id}>
            <Icon name={s.info.kind !== "text-files" ? "fl_database" : "fl_folder"} size={18} />
            <div class="grow">
              <bdi class="source-label" title={s.info.label}>{s.info.label}</bdi>
              <div class="meta">
                <SourceBadge source={s} />
                <span>{s.books.length.toLocaleString("he")} ספרים</span>
                {s.info.warnings.length > 0 && <span>{s.info.warnings.length} אזהרות</span>}
              </div>
              <LibrarySwitch sourceId={s.info.id} />
            </div>
            {store.canRemap(s.info.id) && (
              <button class="icon-btn" title="שינוי המיפוי של המסד" aria-label={`מיפוי ${s.info.label}`} onClick={() => void store.remapSource(s.info.id)}>
                <Icon name="fl_settings" size={16} />
              </button>
            )}
            <button class="icon-btn" title={`סגירת המקור (${badgeOf(s).label}). הקישורים שבפרויקט נשארים.`} aria-label={`סגירת ${s.info.label}`} onClick={() => void store.closeSource(s.info.id)}>
              <Icon name="fl_dismiss" size={16} />
            </button>
          </div>
        ))}
        <AddSources startOpen={sources.length === 0} />
      </div>
      {sources.length > 0 && (
        <>
          <div class="book-search">
            <input type="search" placeholder="חיפוש ספר…" title="חיפוש בכל המקורות הפתוחים" value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label="חיפוש ספר" />
          </div>
          <BookList query={q} />
        </>
      )}
    </>
  );
}
