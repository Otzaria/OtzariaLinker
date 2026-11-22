import { useEffect, useRef, useState } from "preact/hooks";
import { TYPE_GROUP_LABELS, TYPE_LABELS, typeGroups, type ConnectionType } from "../../core/links/connection-type";
import { Icon } from "../icons/icon";

/*
 * All the link types on one page (3.5): grouped as Otzaria shows them (typeGroups), the Hebrew name, what it is, where it
 * appears in Otzaria, and what export does with it. Text on the page — not a `title`, which a touch screen never shows.
 * Opened from the type picker (TypesHelpButton); a plain <dialog>, closed with Escape or the button.
 */
const WHERE: Record<keyof typeof TYPE_GROUP_LABELS, string> = {
  commentaries: "בפאנל המפרשים של הספר שאליו הקישור מצביע",
  links: "בפאנל הקישורים",
  direction: "נשמר כפירוש בכיוון ההפוך, ולכן הפירוש מופיע בפאנל המפרשים של ספר הבסיס",
};
const GROUPS = typeGroups();

function TypesHelpDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} class="types-help" onClose={onClose} aria-labelledby="types-help-title">
      <div class="dlg">
        <header>
          <Icon name="fl_info" size={22} />
          <h2 id="types-help-title">סוגי הקישור</h2>
          <span class="grow" />
          <button class="icon-btn" onClick={() => ref.current?.close()} aria-label="סגירה" title="סגירה (Esc)">
            <Icon name="fl_dismiss" />
          </button>
        </header>
        <div class="body">
          <p class="muted" style="margin:0">הסוג קובע איפה הקישור יופיע באוצריא. בחרו את הסוג שמתאר את היחס בין שני הספרים.</p>
          {(["commentaries", "links", "direction"] as const).map((g) => (
            <section key={g} class="types-group">
              <h3>{TYPE_GROUP_LABELS[g]}</h3>
              <p class="muted" style="margin:0">איפה זה מופיע: {WHERE[g]}.</p>
              <ul class="types-list">
                {GROUPS[g].map((t: ConnectionType) => (
                  <li key={t} class="type-item">
                    <b>{TYPE_LABELS[t].he}</b> <code dir="ltr">{t.toLowerCase()}</code>
                    <div>{TYPE_LABELS[t].hint}</div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <section class="types-export">
            <h3>מה הייצוא עושה עם הסוג</h3>
            <ul>
              <li>סוג שאינו ברשימה הזו (למשל מקובץ שיובא) הספרייה שומרת כ"אחר", וייבוא אישי באוצריא דוחה את כל הקובץ בגללו. הכלי מזהיר על כך ועוצר את הייצוא לספרייה.</li>
              <li>"קישור אוטומטי" (LINKER) אוצריא יוצרת בעצמה בכל בנייה של המסד, ואי אפשר לכתוב אותו בקובץ קישורים.</li>
              <li>"ציטוט בטקסט" (שיטת מראי מקומות, במצב מתקדם) מוכר רק לייבוא האישי של אוצריא: הוא מוחזק בייצוא לספרייה, ומיוצא בבחירה "לשימוש פרטי".</li>
            </ul>
          </section>
        </div>
        <footer>
          <button class="btn filled" onClick={() => ref.current?.close()}>סגירה</button>
        </footer>
      </div>
    </dialog>
  );
}

/** The link beside a type picker that opens the page of all the types. */
export function TypesHelpButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" class="adv-link" onClick={() => setOpen(true)}>
        מה כל סוג אומר?
      </button>
      {open && <TypesHelpDialog onClose={() => setOpen(false)} />}
    </>
  );
}
