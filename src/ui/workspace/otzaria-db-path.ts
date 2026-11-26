/*
 * Where Otzaria keeps its database on Windows, and what the "copy" buttons put on the clipboard. Pure strings, so a unit test
 * can pin them (#16).
 *
 * Only the FOLDER is copied. A file path pasted into the file dialog's "file name" field and confirmed with Enter makes Windows
 * open the file in its own program; a folder path navigates the dialog to the folder, and the user picks the file there. Windows
 * hides the extension by default, so the file shows as "seforim", not "seforim.db".
 *
 * Two installs (Otzaria/otzaria lib/core/app_paths.dart, getDefaultLibraryPath, @a6be90800): installed for all users, the library
 * is under %ProgramData%\otzaria\books; installed for one user, under %APPDATA%\otzaria\books (getDataRootPath). The Windows file
 * dialog expands %APPDATA% typed into its name field, so that path is copied as it is. A library the user moved elsewhere is shown
 * in Otzaria's settings.
 */
export const OTZARIA_DB_DIR = "C:\\ProgramData\\otzaria\\books";
export const OTZARIA_DB_DIR_USER = "%APPDATA%\\otzaria\\books";
export const OTZARIA_DB_FILE = "seforim.db";
/** Where the user sees the real place when it is neither (the library was moved). */
export const OTZARIA_DB_WHERE = 'אם הספרייה הועברה למקום אחר, הנתיב שלה מופיע באוצריא בהגדרות, בחלק "מיקום הספרייה".';

/** What goes on the clipboard: the folder, never the file. */
export function otzariaDbCopyText(install: "all" | "user" = "all"): string {
  return install === "user" ? OTZARIA_DB_DIR_USER : OTZARIA_DB_DIR;
}

/** The message after copying: what happened and what to do next. */
export function otzariaDbCopyNotice(): string {
  return `נתיב התיקייה הועתק. לחצו "מסד נתונים", הדביקו אותו בשדה "שם הקובץ" ולחצו Enter, ואז בחרו בתיקייה את הקובץ בשם seforim (בסייר הקבצים הסיומת ‎.db‎ לרוב מוסתרת) ולחצו "פתח".`;
}
