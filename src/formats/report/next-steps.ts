/*
 * "What now?" after an export (audit F13): the ways the exported files reach Otzaria, in plain
 * Hebrew, shared by the export dialog and `_report.txt`. Kept to what is documented:
 * - the library: links/ and alt_toc/ go into otzaria-library (USER_GUIDE §1, §10), and the generator
 *   builds the Otzaria database from it;
 * - the user's own Otzaria: the app's personal-library import of `_links.json` files (0.9.98+,
 *   LIVE_TESTING.md §1). It is read from the app's code and NOT yet tested live, and the text says so;
 * - a database file: the tool opens databases read-only and never writes links into one.
 */
export type ExportPurpose = "submission" | "private";

export interface NextStepsRoute {
  id: "library" | "personal" | "database" | "sefaria";
  title: string;
  steps: string[];
  /** a caveat the user must see (an unverified route, a limitation) */
  note?: string;
}

export interface NextStepsInput {
  format: "json" | "sefaria-csv";
  purpose: ExportPurpose;
  /** the export holds alt_toc files */
  altToc: boolean;
  /** more than one file: they come as a ZIP */
  zip: boolean;
}

const LIBRARY = (i: NextStepsInput): NextStepsRoute => ({
  id: "library",
  title: "לספריית אוצריא, לכל המשתמשים",
  steps: [
    i.zip ? "פותחים את קובץ ה־ZIP." : "לוקחים את הקובץ שירד.",
    i.altToc
      ? "את התיקיות links/ ו־alt_toc/ מעתיקים לשורש otzaria-library, ליד תיקיית הספרים. כל קובץ מחליף את הקובץ של אותו ספר בספרייה: קובץ קישורים את כל הקישורים הידניים של הספר, וקובץ alt_toc את כל מבני הכותרות שלו."
      : "את התיקייה links/ מעתיקים לשורש otzaria-library, ליד תיקיית הספרים. כל קובץ מחליף את קובץ הקישורים של אותו ספר בספרייה, כלומר את כל הקישורים הידניים שלו.",
    "otzaria-library הוא המאגר של הספרייה ב־GitHub: שולחים אליו את השינוי (בקשת משיכה), או שולחים את הקבצים למי שמתחזק את הספרייה.",
    "אחרי שהשינוי מתקבל, מסד אוצריא נבנה מחדש מהספרייה, והקישורים מגיעים לכולם בעדכון הספרים הבא.",
  ],
});

const PERSONAL: NextStepsRoute = {
  id: "personal",
  title: "לאוצריא שלכם בלבד (הספרייה האישית)",
  steps: [
    'באוצריא 0.9.98 ומעלה, במחשב: בהגדרות, "ייבוא נתונים", ובוחרים את קובצי הקישורים שירדו מהכלי (שם כל אחד מהם מסתיים ב־‎_links.json). או: שמים אותם בתיקיית ספרים אישיים שהוספתם לאוצריא, והם נקלטים כשהתיקייה נסרקת.',
    "שני הספרים של כל קישור צריכים להיות באוצריא באותו שם בדיוק. ספר שנמצא גם בספרים האישיים וגם בספרייה הרשמית, או ספר מספרייה מצורפת, לא יקבל את הקישורים.",
    'שגיאה אחת בקובץ גורמת לאוצריא לדחות את כולו. לכן בחלון הייצוא בחרו "שימוש פרטי": כך הכלי עוצר מראש חלק ממה שהייבוא הזה דוחה, למשל סוג קשר לא מוכר.',
  ],
  note: "המסלול הזה מתואר לפי הקוד של אוצריא, ועוד לא נבדק בפועל עם קבצים מהכלי.",
};

const DATABASE: NextStepsRoute = {
  id: "database",
  title: "לתוך מסד אישי (קובץ ‎.db)",
  steps: [
    "הכלי לא כותב קישורים לתוך מסד: כל מסד נפתח לקריאה בלבד, כדי שלא ייפגע.",
    'כדי לראות את הקישורים ליד ספרים מהמסד האישי, השתמשו במסלול "לאוצריא שלכם" שלמעלה.',
  ],
};

const SEFARIA: NextStepsRoute = {
  id: "sefaria",
  title: "לספריא",
  steps: ["קובצי ה־CSV מיועדים להעלאת קישורים לספריא, ולא לאוצריא. אין בהם טווחים ועוגני מילה."],
};

/** The routes for this export, the one that fits its purpose first. */
export function nextSteps(i: NextStepsInput): NextStepsRoute[] {
  if (i.format === "sefaria-csv")
    return [i.altToc ? { ...SEFARIA, steps: [...SEFARIA.steps, "את התיקייה alt_toc/ מעתיקים לשורש המאגר otzaria-library, ליד תיקיית הספרים."] } : SEFARIA];
  return i.purpose === "private" ? [PERSONAL, LIBRARY(i), DATABASE] : [LIBRARY(i), PERSONAL, DATABASE];
}

/** The routes as plain text lines, for `_report.txt`. */
export function nextStepsText(i: NextStepsInput): string[] {
  const out: string[] = [];
  for (const r of nextSteps(i)) {
    out.push("", `${r.title}:`);
    r.steps.forEach((s, n) => out.push(`  ${n + 1}. ${s}`));
    if (r.note) out.push(`  שימו לב: ${r.note}`);
  }
  return out;
}
