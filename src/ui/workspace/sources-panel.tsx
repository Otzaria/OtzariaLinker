import { useState } from "preact/hooks";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { AddSources } from "./add-sources";
import { BookList } from "./book-picker";
import { badgeOf, SourceBadge } from "./source-badge";
import { ReopenSources } from "./reopen-sources";
import { SourceName } from "../shell/file-name";

/** Open sources (databases, folders, files), adding more, and a search over all their books. */
export function SourcesBody() {
  const store = useStore();
  const [q, setQ] = useState("");
  const sources = store.sources.value;
  return (
    <>
      <div class="sources-list">
        {/* with no book open the source reader shows the list; once some are open, it is here */}
        {store.books.value.size > 0 && <ReopenSources />}
        {sources.length === 0 && (
          <p class="muted empty-sources">
            אין מקור פתוח. הוסיפו תיקייה, קבצים או מסד — אפשר כמה מקורות יחד, ולקשר בין ספרים של מקורות שונים.
          </p>
        )}
        {sources.map((s) => (
          <div class="source-row" key={s.info.id}>
            <Icon name={s.info.kind !== "text-files" ? "fl_database" : "fl_folder"} size={18} />
            <div class="grow">
              <div title={s.info.label}><SourceName name={s.info.label} class="source-label" /></div>
              <div class="meta">
                <SourceBadge source={s} />
                <span>{s.books.length.toLocaleString("he")} ספרים</span>
                {s.info.warnings.length > 0 && <span>{s.info.warnings.length} אזהרות</span>}
              </div>
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
