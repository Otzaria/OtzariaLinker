import { useEffect, useState } from "preact/hooks";
import { useStore } from "../context";

/*
 * Before the run (3.2): how many links the chosen books ALREADY have — the project's, and the open database's — and what
 * will and will not be in the final file. The database's count is read book by book (DbLinksState.totalsOf), the first
 * BOOKS_COUNTED books of the plan and its bases, and says so when the list was longer. Nothing here changes a link.
 */
const BOOKS_COUNTED = 40;
const n = (x: number) => x.toLocaleString("he");

export function ExistingLinks() {
  const store = useStore();
  const plan = store.guided.plan.value;
  const links = store.linkState.value.links;
  const [db, setDb] = useState<{ total: number; books: number; of: number } | "loading" | null>("loading");
  const planKeys = plan ? [...new Set([...plan.books.map((b) => b.book.key), ...plan.steps.flatMap((s) => (s.kind === "pair" ? [s.source.key, s.target.key] : [s.source.key]))])] : [];
  const keyId = planKeys.join("|");

  // links of the project that touch a book of the plan
  let inProject = 0;
  for (const l of links.values()) if (l.status !== "deleted" && planKeys.some((k) => store.sameBook(l.source.book, k) || store.sameBook(l.target.book, k))) inProject++;

  useEffect(() => {
    const dbBooks = planKeys.filter((k) => store.sources.value.some((s) => s.info.kind !== "text-files" && s.books.some((b) => b.key === k)));
    if (!dbBooks.length) return setDb(null);
    const ac = new AbortController();
    setDb("loading");
    void store.dbLinks.totalsOf(dbBooks.slice(0, BOOKS_COUNTED), ac.signal).then((m) => {
      if (!ac.signal.aborted) setDb({ total: [...m.values()].reduce((a, b) => a + b, 0), books: m.size, of: dbBooks.length });
    });
    return () => ac.abort();
  }, [keyId]);

  if (!plan) return null;
  return (
    <>
      <p class="guided-existing" role="status">
        <b>קישורים שכבר יש לספרים האלה:</b> בפרויקט {n(inProject)} · {db === null ? "במסד: אין מסד פתוח לספרים האלה" : db === "loading" ? "במסד: סופר…" : `במסד ${n(db.total)}`}
        {db && db !== "loading" && db.of > BOOKS_COUNTED && <span class="muted"> (נספרו {n(db.books)} מתוך {n(db.of)} ספרים)</span>}
        {db && db !== "loading" && <span class="muted"> — קישור של הספר נספר פעם אחת, מכל צד</span>}
      </p>
      <div class="guided-final">
        <b>מה ייכנס לקובץ הסופי, ומה מוחזק:</b>
        <ul>
          <li>ייכתבו: הקישורים החדשים שתאשרו, וקישורים שיובאו מקובץ וערכתם.</li>
          <li>קישורי המסד לא נכתבים: הם כבר בספרייה. הצעה שמקשרת שתי שורות שהמסד כבר מקשר מסומנת "כבר קיים" ואינה נכתבת.</li>
          <li>מוחזק: קישור שהבדיקה פוסלת (ראו "ידוע כבר עכשיו" ובדיקת הייצוא אחרי ההרצה). הוא נשאר בפרויקט עד שתתקנו אותו או תבחרו "לשימוש שלי בלבד".</li>
        </ul>
      </div>
    </>
  );
}
