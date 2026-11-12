import { FileName } from "../shell/file-name";
import type { ExportPlan } from "../../formats/links-json/export";
import { pickFiles } from "../files";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import "../workspace/db-links.css";

/*
 * In the export dialog: books whose links file is held back because the export would REPLACE the
 * library's file of that book without having it (security review A1–A3, LINK_FORMATS §4.5):
 *   • export/db-copy-no-file — links copied from the database, and the book's file is not loaded;
 *   • export/library-file-not-loaded — the database says the book has links of its own;
 *   • export/file-unverified — the project holds only a SNAPSHOT of the file, from a saved project.
 * Here the user loads that file (the file itself, or a whole library folder), or confirms explicitly.
 * Nothing is replaced silently. `onChange` re-plans the export.
 */
const REASONS = ["export/file-unverified", "export/db-copy-no-file", "export/library-file-not-loaded"] as const;
type Reason = (typeof REASONS)[number];

export function DbCopyFiles({ plan, onChange }: { plan: ExportPlan; onChange: () => void }) {
  const store = useStore();
  const why = new Map<string, Reason>();
  for (const h of plan.heldBack)
    for (const r of REASONS) if (h.problems.some((p) => p.code === r) && !why.has(h.link.source.book.title)) why.set(h.link.source.book.title, r);
  const titles = [...why.keys()].sort();
  if (!titles.length) return null;
  const load = async (folder: boolean, only?: string) => {
    const files = await pickFiles(folder ? { folder: true } : { accept: ".json,application/json" });
    if (!files.length) return;
    const found = await store.dbLinks.loadLinksFiles(files, only ? [only] : titles);
    if (found.length) onChange();
  };
  const stale = titles.filter((t) => why.get(t) === "export/file-unverified");
  return (
    <div class="dbcopy-files" role="alert">
      <b>
        <Icon name="fl_warning" size={16} /> ספרים שקובץ הקישורים שלהם מחכה לקובץ מהספרייה
      </b>
      <p class="muted" style="margin:4px 0">
        קובץ קישורים מחליף בספרייה את כל הקובץ של הספר. לספרים האלה כנראה יש קובץ בספרייה, והכלי לא טען אותו בהפעלה הזו; ייצוא בלעדיו היה מוחק את שאר הקישורים שבו. טענו את הקובץ מהספרייה (למשל מהתיקייה <code>MoreBooks/links</code>), או אשרו במפורש.
        {stale.length > 0 && " בספרים שמסומנים \"עותק מהפרויקט\" הקובץ נשמר בפרויקט: ייתכן שהוא ישן. טעינה מהספרייה בודקת שהוא לא השתנה."}
      </p>
      <ul>
        {titles.map((t) => {
          const unverified = why.get(t) === "export/file-unverified";
          return (
            <li key={t}>
              <span class="grow"><FileName name={`${t}_links.json`} /></span>
              {unverified && <span class="status edited">עותק מהפרויקט</span>}
              <button class="btn text" onClick={() => void load(false, t)}>
                <Icon name="oz_document_links" size={16} /> טעינת הקובץ…
              </button>
              <button
                class="btn text"
                onClick={() => (store.dbLinks.confirmNewFile(t), onChange())}
                title={unverified ? "רק אם בדקתם שהקובץ בספרייה לא השתנה מאז שמירת הפרויקט: אז הקובץ ייכתב מהעותק שבפרויקט" : "רק אם בדקתם שבספרייה אין קובץ קישורים לספר הזה: אז ייכתב קובץ חדש"}
              >
                {unverified ? "העותק בפרויקט הוא העדכני" : "אין לספר קובץ בספרייה"}
              </button>
            </li>
          );
        })}
      </ul>
      <button class="btn outlined" onClick={() => void load(true)} title="בוחרים את תיקיית הספרייה (או תיקייה של links); הכלי טוען ממנה רק את הקבצים של הספרים האלה">
        <Icon name="fl_folder_open" size={16} /> טעינה מתיקיית הספרייה…
      </button>
    </div>
  );
}
