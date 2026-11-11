import { useState } from "preact/hooks";
import { useStore } from "../context";
import { pickFiles } from "../files";
import { Icon } from "../icons/icon";
import { BookList } from "./book-picker";

const KIND_LABEL = { "otzaria-db": "מסד", "text-files": "קבצים", "mapped-db": "מסד ממופה" } as const;

/** Open sources (databases, folders, files) and a search over all their books. */
export function SourcesBody() {
  const store = useStore();
  const [q, setQ] = useState("");
  const sources = store.sources.value;
  return (
    <>
      <div class="sources-list">
        {sources.map((s) => (
          <div class="source-row" key={s.info.id}>
            <Icon name={s.info.kind !== "text-files" ? "fl_database" : "fl_folder"} size={18} />
            <div class="grow">
              <div title={s.info.label} style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{s.info.label}</div>
              <div class="meta">
                {KIND_LABEL[s.info.kind]} · {s.books.length.toLocaleString("he")} ספרים
                {s.info.warnings.length > 0 && ` · ${s.info.warnings.length} אזהרות`}
              </div>
            </div>
            <button class="icon-btn" title="סגירת המקור" aria-label={`סגירת ${s.info.label}`} onClick={() => void store.closeSource(s.info.id)}>
              <Icon name="fl_dismiss" size={16} />
            </button>
          </div>
        ))}
        <button class="btn outlined" onClick={async () => store.openFiles(await pickFiles())}>
          <Icon name="fl_add" size={16} />
          הוספת מקור
        </button>
      </div>
      {sources.length > 0 && (
        <>
          <div class="book-search">
            <input type="search" placeholder="חיפוש ספר…" value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label="חיפוש ספר" />
          </div>
          <BookList query={q} />
        </>
      )}
    </>
  );
}
