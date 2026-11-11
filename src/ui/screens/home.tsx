import { useState } from "preact/hooks";
import { useStore } from "../context";
import { fromDataTransfer, pickFiles } from "../files";
import { Icon, type IconName } from "../icons/icon";

/*
 * Home (ADR 0005 §1): guided tasks, with a drop strip at the side. Every task ends in the same
 * workspace; a task only decides what to ask for first. Tasks whose automatic part is not built yet
 * say so instead of pretending.
 */
interface TaskDef {
  icon: IconName;
  title: string;
  hint: string;
  pick: { folder?: boolean; accept?: string };
  soon?: string;
}

const TASKS: TaskDef[] = [
  { icon: "oz_book_link", title: "קישור ספר לפירוש", hint: "ספר בסיס ופירוש עליו — לפי כותרות (דיבור המתחיל בדרך)", pick: {} },
  { icon: "oz_link_marker", title: "קישור הערות שוליים", hint: "מספרי ההערות בספר מול ספר ההערות", pick: {}, soon: "הזיהוי האוטומטי בדרך" },
  { icon: "oz_search_in_folder", title: "קישור תיקייה שלמה", hint: "ספרים רבים מתיקייה מול ספריית אוצריא", pick: { folder: true }, soon: "הקישור האצוותי בדרך" },
  { icon: "oz_library_link", title: "קישור בין מסדים", hint: "שני מסדי SQLite, אישיים או של אוצריא", pick: { accept: ".db,.sqlite,.sqlite3" } },
  { icon: "oz_link_edit", title: "עריכת קישורים קיימים", hint: "קובצי ‎_links.json — בדיקה, תיקון וייצוא מחדש", pick: { accept: ".json,.zip" } },
  { icon: "oz_link_add", title: "עבודה ידנית חופשית", hint: "בוחרים ספרים, שורות, טווחים ומילים בעצמכם", pick: {} },
];

export function Home() {
  const store = useStore();
  const [over, setOver] = useState(false);
  const open = async (opts: TaskDef["pick"]) => store.openFiles(await pickFiles(opts));
  const hasWork = store.sources.value.length > 0 || store.linkState.value.links.size > 0;

  return (
    <main class="home">
      <section>
        <h1>מה תרצו לעשות?</h1>
        <p class="lede">בוחרים משימה, והכלי יבקש רק את מה שצריך. הכול נשאר במחשב שלכם — שום קובץ לא נשלח לשום מקום.</p>
        <div class="tasks">
          {TASKS.map((t) => (
            <button key={t.title} class="task-card" onClick={() => open(t.pick)}>
              <Icon name={t.icon} size={28} />
              <b>{t.title}</b>
              <span>{t.hint}</span>
              {t.soon && <em class="soon">{t.soon}</em>}
            </button>
          ))}
        </div>
        {hasWork && (
          <div class="recent">
            <button class="btn tonal" onClick={() => (store.screen.value = "workspace")}>
              <Icon name="oz_book_open_medium_lines" size={18} />
              חזרה לסביבת העבודה ({store.sources.value.length} מקורות, {store.linkState.value.links.size.toLocaleString("he")} קישורים)
            </button>
          </div>
        )}
      </section>

      <aside
        class={`drop-strip${over ? " over" : ""}`}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          if (e.dataTransfer) await store.openFiles(await fromDataTransfer(e.dataTransfer));
        }}
      >
        <Icon name="fl_arrow_upload" size={36} />
        <b>גררו לכאן ספרים, תיקייה, מסד או קובץ קישורים</b>
        <span class="muted">הכלי מזהה לבד את סוג כל קובץ ומציע מה לעשות איתו.</span>
        <div class="actions">
          <button class="btn outlined" onClick={() => open({})}><Icon name="fl_add" size={16} />קבצים</button>
          <button class="btn outlined" onClick={() => open({ folder: true })}><Icon name="fl_folder_open" size={16} />תיקייה</button>
          <button class="btn outlined" onClick={() => open({ accept: ".db,.sqlite,.sqlite3" })}><Icon name="fl_database" size={16} />מסד נתונים</button>
        </div>
        <p class="privacy">
          <Icon name="fl_info" size={16} />
          <span>מסדי נתונים נפתחים לקריאה בלבד. הכלי לעולם לא משנה את הקבצים שלכם — כל תוצר נשמר כקובץ חדש.</span>
        </p>
      </aside>
    </main>
  );
}
