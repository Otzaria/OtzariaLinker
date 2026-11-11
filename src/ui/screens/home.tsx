import { useState } from "preact/hooks";
import type { EngineId } from "../../linking/automatic";
import type { SideTab } from "../../state/store";
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
  /** where the workspace should start (guided tasks — UX review suggestion 1) */
  then?: { tab: SideTab; engine?: EngineId; batch?: boolean; dialog?: "relink" };
  soon?: string;
}

const TASKS: TaskDef[] = [
  { icon: "oz_book_link", title: "קישור ספר לפירוש", hint: "ספר בסיס ופירוש עליו — לפי כותרות ודיבור המתחיל", pick: {}, then: { tab: "suggestions", engine: "headings" } },
  { icon: "oz_link_marker", title: "קישור הערות שוליים", hint: "מספרי ההערות בספר מול ספר ההערות", pick: {}, then: { tab: "suggestions", engine: "footnotes" } },
  { icon: "oz_search_in_folder", title: "קישור תיקייה שלמה", hint: "פירושים רבים מתיקייה, כל אחד מול הספר שבשמו", pick: { folder: true }, then: { tab: "suggestions", engine: "headings", batch: true } },
  { icon: "oz_library_link", title: "קישור בין מסדים", hint: "שני מסדי SQLite, אישיים או של אוצריא", pick: { accept: ".db,.sqlite,.sqlite3" } },
  { icon: "oz_link_edit", title: "עריכת קישורים קיימים", hint: "קובצי ‎_links.json — בדיקה, תיקון וייצוא מחדש", pick: { accept: ".json,.zip" }, then: { tab: "links" } },
  { icon: "oz_text_compare", title: "תיקון קישורים אחרי שינוי ספר", hint: "המהדורה הישנה, החדשה וקובץ הקישורים — הקישורים עוברים לשורות הנכונות", pick: {}, then: { tab: "links", dialog: "relink" } },
  { icon: "oz_document_link", title: "פתיחת פרויקט שמור", hint: "ממשיכים מאיפה שעצרתם (קובץ ‎.otzlinker.json)", pick: { accept: ".json" } },
  { icon: "oz_link_add", title: "עבודה ידנית חופשית", hint: "בוחרים ספרים, שורות, טווחים ומילים בעצמכם", pick: {} },
];

export function Home() {
  const store = useStore();
  const [over, setOver] = useState(false);
  const open = async (opts: TaskDef["pick"], then?: TaskDef["then"]) => {
    const files = await pickFiles(opts);
    if (!files.length) return;
    await store.openFiles(files);
    if (then && store.screen.value === "workspace") {
      store.intent.value = { ...(then.engine && { engine: then.engine }), ...(then.batch && { batch: true }) };
      store.sideTab.value = then.tab;
      if (then.dialog) store.dialog.value = then.dialog;
    }
  };
  const hasWork = store.sources.value.length > 0 || store.linkState.value.links.size > 0;

  return (
    <main class="home">
      <section>
        {store.recovery.value && (
          <div class="recovery" role="alert">
            <Icon name="fl_history" size={24} />
            <span class="grow">נמצאה עבודה שלא נשמרה מהפעם הקודמת: {store.recovery.value.links.toLocaleString("he")} קישורים.</span>
            <button class="btn filled" onClick={store.recovery.value.restore}>שחזור</button>
            <button class="btn text" onClick={store.recovery.value.dismiss}>התעלמות</button>
          </div>
        )}
        <h1>מה תרצו לעשות?</h1>
        <p class="lede">בוחרים משימה, והכלי יבקש רק את מה שצריך. הכול נשאר במחשב שלכם — שום קובץ לא נשלח לשום מקום.</p>
        <div class="tasks">
          {TASKS.map((t) => (
            <button key={t.title} class="task-card" onClick={() => open(t.pick, t.then)}>
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
