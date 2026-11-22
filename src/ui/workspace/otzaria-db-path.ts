/*
 * Where Otzaria keeps its database on Windows (the installer's default), and what the "copy" button puts
 * on the clipboard. Pure strings, so a unit test can pin them (#16).
 *
 * Only the FOLDER is copied. A file path pasted into the file dialog's "file name" field and confirmed
 * with Enter makes Windows open the file in its own program; a folder path navigates the dialog to the
 * folder, and the user picks the file there. Windows hides the extension by default, so the file shows
 * as "seforim", not "seforim.db".
 */
export const OTZARIA_DB_DIR = "C:\\ProgramData\\otzaria\\books";
export const OTZARIA_DB_FILE = "seforim.db";

/** What goes on the clipboard: the folder, never the file. */
export function otzariaDbCopyText(): string {
  return OTZARIA_DB_DIR;
}

/** The message after copying: what happened and what to do next. */
export function otzariaDbCopyNotice(): string {
  return `נתיב התיקייה הועתק. לחצו "מסד נתונים", הדביקו אותו בשדה "שם הקובץ" ולחצו Enter, ואז בחרו בתיקייה את הקובץ בשם seforim (בסייר הקבצים הסיומת ‎.db‎ לרוב מוסתרת) ולחצו "פתח".`;
}
