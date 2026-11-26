<div dir="rtl">

# מאגרי ספרים לבדיקה (V7 §4.16, בעיה 46)

נוצרים ב־`node scripts/fixtures/make-repo-fixtures.mjs` (דטרמיניסטי; לא לערוך ביד). `.gitattributes` שומר את הבייטים שלהם
(`-text`), כי `links.csv` אמיתי הוא UTF-8 עם BOM ו־CRLF.

- **המבנה** (תיקיות, שמות קבצים, מקום קובצי הקישורים, סוגי הקבצים שאינם ספרים) נקרא מה־API הציבורי של GitHub ב־26.11.2026,
  לקריאה בלבד, בלי clone: `Otzaria/zmanenu-library` (ענף ברירת המחדל; `README.md`, `docs/format.md`, הדוגמאות שב־
  `builder/test/fixtures/examples/links/`) ו־`YairDaniel11/Otzarya-Unofficial-Books` (עץ הקבצים המלא, 4,481 רשומות, `truncated=false`).
- **הטקסטים** נוצרו בקוד ואינם מועתקים משם: בסיס של מילים נבדלות ופירוש שמצטט את פתיחת כל שורה (כמו ב־
  `tests/unit/linking/adapters.test.ts`), ופירושים על בראשית בצורה של `tests/integration/state/guided-flow.test.ts`, שמתקשרים לפרוסה
  האמיתית של המסד הרשמי (`tests/fixtures/db/seforim-v7-mini.db`).
- `zmanenu/source/links/ביאור לדוגמה על בראשית_links.json` כתוב בפורמט של zmanenu (`book_2`, `target_library`), כמו הדוגמה שלהם.

הבדיקות: `tests/unit/headless/repo-layout.test.ts`, `tests/integration/cli/`. התיעוד: [`docs/HEADLESS.md`](../../../docs/HEADLESS.md).

</div>
