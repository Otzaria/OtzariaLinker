import { useEffect, useRef } from "preact/hooks";
import { linksCount } from "../../state/history";
import { useStore } from "../context";
import { Icon } from "../icons/icon";

/*
 * Version 3's "איפוס מלא" (F-028), with its confirmation. What will close and what stays is said before the choice;
 * with work that was not saved the first choice saves the project, and the other still keeps the work aside
 * (AppStore.resetAll): nothing is lost without a word.
 */
export function ResetDialog({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  const ls = store.linkState.value;
  const links = [...ls.links.values()].filter((l) => l.status !== "deleted").length;
  const sources = store.sources.value.length;
  const unsaved = store.dirty.value && (ls.links.size > 0 || ls.altToc.size > 0 || ls.rejected.size > 0);
  const run = (save: boolean) => {
    ref.current?.close();
    void store.resetAll({ save });
  };
  return (
    <dialog ref={ref} class="reset-dialog" onClose={onClose} aria-labelledby="reset-title" aria-describedby="reset-what">
      <div class="dlg">
        <header>
          <Icon name="fl_warning" size={22} />
          <h2 id="reset-title">איפוס מלא</h2>
        </header>
        <div class="body" id="reset-what">
          <p style="margin:0">
            {sources ? `${sources === 1 ? "הקובץ או המסד הפתוח ייסגר" : `${sources.toLocaleString("he")} הקבצים והמסדים הפתוחים ייסגרו`}` : "אין קבצים פתוחים"}
            {links ? `, ו־${linksCount(links)} בפרויקט יימחקו מהכלי` : ""}, יחד עם היסטוריית הפעולות. הקבצים במחשב לא ישתנו.
          </p>
          <p class="muted" style="margin:0">נשארים: ההגדרות, רשימת הכותרות של ספריא ומיפויי המסדים.</p>
          {unsaved && (
            <p class="notice-inline" style="margin:0">
              יש עבודה שלא נשמרה לקובץ. מומלץ לשמור אותה כפרויקט. גם בלי שמירה היא תישמר בצד, ואפשר יהיה להחזיר אותה מההודעה שתופיע.
            </p>
          )}
        </div>
        <footer>
          <button class="btn text" onClick={() => ref.current?.close()} autoFocus>
            ביטול
          </button>
          <button class={`btn ${unsaved ? "outlined danger" : "filled"}`} onClick={() => run(false)}>
            {unsaved ? "איפוס בלי שמירה" : "איפוס"}
          </button>
          {unsaved && (
            <button class="btn filled" onClick={() => run(true)}>
              <Icon name="fl_save" size={18} />
              שמירת הפרויקט ואיפוס
            </button>
          )}
        </footer>
      </div>
    </dialog>
  );
}
