import type { ExportPlan } from "../../formats/links-json/export";
import { pickFiles } from "../files";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import "../workspace/db-links.css";

/*
 * In the export dialog: links copied from the database whose book's links file is not in the
 * project are held back (export/db-copy-no-file), because a links file REPLACES the book's whole
 * file in the library — writing it without the library's file would delete every other link of
 * that book. Here the user loads that file (the file itself, or a whole library folder), or says
 * the library has none. Nothing is replaced silently. `onChange` re-plans the export.
 */
export function DbCopyFiles({ plan, onChange }: { plan: ExportPlan; onChange: () => void }) {
  const store = useStore();
  const titles = [...new Set(plan.heldBack.filter((h) => h.problems.some((p) => p.code === "export/db-copy-no-file")).map((h) => h.link.source.book.title))].sort();
  if (!titles.length) return null;
  const load = async (folder: boolean, only?: string) => {
    const files = await pickFiles(folder ? { folder: true } : { accept: ".json,application/json" });
    if (!files.length) return;
    const found = await store.dbLinks.loadLinksFiles(files, only ? [only] : titles);
    if (found.length) onChange();
  };
  return (
    <div class="dbcopy-files" role="alert">
      <b>
        <Icon name="fl_warning" size={16} /> קישורים שהועתקו מהמסד מחכים לקובץ הקישורים של הספר
      </b>
      <p class="muted" style="margin:4px 0">
        קובץ קישורים מחליף בספרייה את כל הקובץ של הספר. הקישורים האלה באו מהמסד, ולכן כנראה יש לספר קובץ בספרייה; ייצוא בלעדיו היה מוחק את שאר הקישורים שבו. טענו את הקובץ מהספרייה (למשל מהתיקייה <code>MoreBooks/links</code>), או אשרו שאין לספר קובץ.
      </p>
      <ul>
        {titles.map((t) => (
          <li key={t}>
            <span class="grow">{t}_links.json</span>
            <button class="btn text" onClick={() => void load(false, t)}>
              <Icon name="oz_document_links" size={16} /> טעינת הקובץ…
            </button>
            <button class="btn text" onClick={() => (store.dbLinks.confirmNewFile(t), onChange())} title="רק אם בדקתם שבספרייה אין קובץ קישורים לספר הזה: אז ייכתב קובץ חדש">
              אין לספר קובץ בספרייה
            </button>
          </li>
        ))}
      </ul>
      <button class="btn outlined" onClick={() => void load(true)} title="בוחרים את תיקיית הספרייה (או תיקייה של links); הכלי טוען ממנה רק את הקבצים של הספרים האלה">
        <Icon name="fl_folder_open" size={16} /> טעינה מתיקיית הספרייה…
      </button>
    </div>
  );
}
