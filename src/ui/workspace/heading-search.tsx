import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { MAX_HITS, type HeadingScope } from "../../state/heading-search";
import type { Side } from "../../state/store";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { TaskAnnouncer } from "../shell/app-bar";

/*
 * "חיפוש כותרת בכל הספרים" (version 3's global heading index, F-139): the headings of the books the user works on,
 * or of every open book, searched at once; a result opens the book at the heading in the reader the user picks.
 * Reading a whole database's headings is a task with progress and cancel (shown here: the page behind a modal
 * dialog is inert).
 */
const SCOPE_LABELS: Record<HeadingScope, string> = { light: "הספרים שעובדים עליהם", all: "כל הספרים הפתוחים" };

export function HeadingSearchButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button class="icon-btn" onClick={() => setOpen(true)} title="חיפוש כותרת בכל הספרים" aria-label="חיפוש כותרת בכל הספרים">
        <Icon name="oz_book_search" size={18} />
      </button>
      {open && <HeadingSearchDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function HeadingSearchDialog({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const hs = store.headingSearch;
  const ref = useRef<HTMLDialogElement>(null);
  const [scope, setScope] = useState<HeadingScope>("light");
  const [q, setQ] = useState("");
  const [reading, setReading] = useState(false);
  const [, bump] = useState(0);
  useEffect(() => ref.current?.showModal(), []);
  useEffect(() => {
    let live = true;
    setReading(true);
    void hs.build(scope).then(() => live && (setReading(false), bump((n) => n + 1)));
    return () => void (live = false);
  }, [scope]);
  const counts = useMemo(() => ({ light: hs.booksOf("light").length, all: hs.booksOf("all").length }), [store.books.value]);
  const status = hs.status.value;
  const { hits, more } = reading ? { hits: [], more: false } : hs.search(q, scope);
  const roles = store.roles.value;
  const open = (side: Side, key: string, line: number) => {
    store.reveal(side, key, line);
    ref.current?.close();
  };
  const task = store.task.value;
  return (
    <dialog ref={ref} class="heading-search" onClose={onClose} aria-labelledby="hs-title">
      <div class="dlg">
        <header>
          <Icon name="oz_book_search" size={22} />
          <h2 id="hs-title">חיפוש כותרת בכל הספרים</h2>
          <span class="grow" />
          <button class="icon-btn" onClick={() => ref.current?.close()} aria-label="סגירה" title="סגירה (Esc)">
            <Icon name="fl_dismiss" />
          </button>
        </header>
        <div class="body">
          <TaskAnnouncer />
          <div class="filters" role="group" aria-label="באילו ספרים לחפש">
            {(["light", "all"] as const).map((s) => (
              <button key={s} class="chip" aria-pressed={scope === s} onClick={() => setScope(s)}>
                {SCOPE_LABELS[s]} ({counts[s].toLocaleString("he")})
              </button>
            ))}
          </div>
          <p class="muted" style="margin:0">
            {scope === "light"
              ? "ספרים מקבצים ומתיקיות, הספרים שבקוראים והספרים שיש להם קישורים בפרויקט."
              : "כל הספרים של כל הקבצים והמסדים הפתוחים. במסד שלם הקריאה הראשונה לוקחת זמן, ואפשר לבטל אותה."}
          </p>
          <input type="search" placeholder="מילים מהכותרת או משם הספר…" aria-label="חיפוש כותרת" value={q} onInput={(e) => setQ(e.currentTarget.value)} autoFocus />
          {reading ? (
            <div class="row" style="display:flex;gap:8px;align-items:center">
              <span class="grow">קורא את הכותרות{task?.total ? ` (${task.done.toLocaleString("he")} מתוך ${task.total.toLocaleString("he")} ספרים)` : ""}…</span>
              {task && (
                <button class="btn text" onClick={task.cancel}>
                  ביטול
                </button>
              )}
            </div>
          ) : (
            status &&
            status.read < status.books && <p class="muted" style="margin:0">הכותרות של {(status.books - status.read).toLocaleString("he")} ספרים לא נקראו (הקריאה בוטלה). התוצאות הן מהספרים שנקראו; כדי לקרוא את השאר בחרו שוב את ההיקף.</p>
          )}
          {!reading && q.trim() && (
            <p class="muted" role="status" style="margin:0">
              {!hits.length
                ? "לא נמצאה כותרת עם כל המילים האלה. נסו פחות מילים, או חפשו בכל הספרים הפתוחים."
                : more
                  ? `${MAX_HITS} התוצאות הראשונות מוצגות, ויש עוד. הוסיפו מילה כדי לצמצם.`
                  : hits.length === 1
                    ? "תוצאה אחת."
                    : `${hits.length.toLocaleString("he")} תוצאות.`}
            </p>
          )}
          <ul class="hs-list" aria-label="כותרות שנמצאו">
            {hits.map((h) => (
              <li key={`${h.key}:${h.line}`}>
                <button class="btn text hs-open" onClick={() => open("source", h.key, h.line)} title={`פתיחה בתור ${roles.source.name}`}>
                  <span class="hs-book">{h.title}</span>
                  <span class="hs-head">{h.text || `כותרת בשורה ${h.line + 1}`}</span>
                  <span class="muted">· שורה {(h.line + 1).toLocaleString("he")}</span>
                </button>
                <button class="side-btn" onClick={() => open("target", h.key, h.line)} aria-label={`${roles.target.short}: ${h.title}, ${h.text}`} title={`פתיחה בתור ${roles.target.name}`}>
                  {roles.target.short}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </dialog>
  );
}
