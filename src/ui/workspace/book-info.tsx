import { useStore } from "../context";
import { SourceName } from "../shell/file-name";
import { SourceBadge, useBookOrigin } from "./source-badge";

/*
 * The strip under a reader's head that the book name opens (issue 24): the full name (the head wraps it over two lines
 * and can still cut a very long one), where the book comes from — the source's kind and its own name, always, not only
 * when another source has the same title — and its size. A button, so keyboard and touch reach what `title` showed only
 * to a mouse.
 */
export function BookInfo({ id, bookKey }: { id: string; bookKey: string }) {
  const store = useStore();
  const origin = useBookOrigin()(bookKey);
  const book = store.books.value.get(bookKey);
  store.lines.tick.value; // a text book's length is known after its first read
  if (!book) return null;
  const count = store.lines.count(bookKey) ?? book.lineCount;
  return (
    <div class="book-info" id={id} role="group" aria-label="פרטי הספר">
      <b class="bi-title">{book.title}</b>
      <div class="bi-meta">
        {origin.source && <SourceBadge source={origin.source} name />}
        {count !== undefined && <span>{count.toLocaleString("he")} שורות</span>}
        {book.path && book.path !== `${book.title}.txt` && (
          <span class="muted">
            נתיב: <SourceName name={book.path} />
          </span>
        )}
        {origin.ambiguous && <span class="muted">יש ספר באותו שם גם בקובץ או במסד אחר: זה הספר מ־{origin.source ? origin.source.info.label : "קובץ או מסד אחר"}.</span>}
      </div>
    </div>
  );
}
