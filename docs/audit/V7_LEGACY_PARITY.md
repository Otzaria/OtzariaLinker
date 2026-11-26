<div dir="rtl">

# V7 — שוויון יכולות מול גרסה 3

הבדיקה של מפרט V7 §4.14: כל יכולת של גרסה 3 שב־[`FEATURE_INVENTORY.md`](FEATURE_INVENTORY.md) (‏F-001 עד F-142, קיצורי
המקלדת ב־§16 ו־93 הבדיקות העצמיות ב־§22), מול הקוד של V7. לכל יכולת: איפה היא בגרסה 3, איפה היא ב־V7, מה קרה לה,
איזו בדיקה מגינה עליה, מאיזה מסך מגיעים אליה ומה המגבלה.

התאריך: 2026-11-26. הבסיס: ענף ה־PR הרביעי של V7, על `v7/03-wip` ‏(`e9bdad1`). הקוד של גרסה 3 הוא
`legacy/OtzariaLinker-v3.html` (קריאה בלבד, byte-exact), ומספרי השורות הם של המלאי.

## 1. איך נבדק

- **לא הסקנו שוויון משם של פונקציה.** לכל שורה נקרא הקוד של V7 שמממש את היכולת, ונפתחה הבדיקה שמופיעה בעמודה
  "בדיקת רגרסיה", כדי לוודא שהיא באמת בודקת את ההתנהגות. בדיקה שנוגעת ביכולת רק בעקיפין מסומנת "חלקי". כשלא הייתה
  ודאות כתוב "לא אומת".
- את הקריאה עשו ארבעה סוקרים במקביל, כל אחד על טווח של המלאי. שלוש טענות מרכזיות נבדקו שוב ישירות בקוד:
  `createFromDraft` (`src/state/store.ts`) לא בודק כפילות בתוך הפרויקט; `validateLink` (`src/core/links/validate.ts`)
  לא בודק קישור של שורה לעצמה; יש 42 תגי `<select>` מובנים ב־`src/**/*.tsx`, ושום קוד לא מציב `data-density`.
- **העמודה "מצב":** נשמר · שופר (נשמר, עם שיפור) · שונה (התנהגות שהשתנתה בכוונה, עם ההצדקה אם נמצאה) ·
  הוחלף (מנגנון אחר משיג את אותה מטרה) · הוסר · לא נמצא.

## 2. הבדיקות העצמיות של גרסה 3 (`npm run test:legacy`)

`tests/e2e/legacy-baseline.spec.ts` מריץ את `window.runSelfTests()` של `legacy/OtzariaLinker-v3.html` מ־`file://`,
אופליין, ובודק 93 מתוך 93 ושאין אף בקשת רשת. ההרצה ב־2026-11-26, על `e9bdad1`:

```
  ok 2 [edge] › tests\e2e\legacy-baseline.spec.ts:6:1 › legacy v3 self-tests: 93/93 (2.0s)
  ok 1 [chrome] › tests\e2e\legacy-baseline.spec.ts:6:1 › legacy v3 self-tests: 93/93 (4.4s)

  2 passed (9.1s)
```

**חשוב:** הבדיקה הזו רצה על **קובץ גרסה 3**, ולכן היא שומרת על בסיס ההשוואה, ולא על V7. איזה חלק מ־93 הבדיקות נוייד
לבדיקות של V7: §5 למטה.

## 3. סיכום: מה אבד, ומה לא נבדק

### 3.1 יכולות שהוסרו או נחלשו, בלי הצדקה כתובה

אלה הממצאים העיקריים של הבדיקה. אף אחד מהם לא תוקן ב־PR הזה, כי כל אחד הוא החלטת מוצר. הם רשומים במגבלות הידועות של
[`V7_RELEASE_READINESS.md`](../release/V7_RELEASE_READINESS.md) §6.

| מזהה | מה היה בגרסה 3 | מה יש ב־V7 |
|---|---|---|
| F-070, F-072, F-086 | יצירה, עריכה ושחזור שיוצרים קישור זהה נדחו (בדיקות "נסיגה" של גרסה 3) | הכפילות נוצרת, ומסומנת רק באזהרה `export/duplicate` בבקרה ובייצוא. יש "מחיקת הכפולים" |
| F-087 | קישור משורה לאותה שורה בדיוק היה שגיאה | אין כלל כזה ב־`validateLink`. לא אומת שהממשק מאפשר ליצור אותו |
| F-061, F-046 | בחירה לא רציפה (Ctrl/Cmd), ויצירה של קישור מכל שורת מקור בבת אחת | אין. Shift בוחר רק רצף, שהופך לטווח |
| F-054, F-055 | הקלדת "עד שורה", "עד הסוף", והצעת סוף אוטומטית (`rangeAutoEnd`) | רק Shift ו"טווח עד הקישור הבא". אין הקלדה של מספר שורה |
| F-075 | דיאלוג "סמן" לעוגן, ו־" אות X" ב־heRef | אין דיאלוג. התווית נשמרת רק בקישור מיובא |
| F-028 | "איפוס מלא" | אין. אפשר לסגור מקורות (הקישורים נשארים) או לטעון את הדף מחדש |
| F-035 | הסרת ספר אחד עם הקישורים שלו, עם ביטול | אין. סגירת מקור שלם, בלי ביטול, והקישורים נשארים |
| F-016 | מניעת טעינה כפולה גם לקובצי טקסט | למסד: לפי תוכן (שופר). תיקייה או `.txt` שנבחרו שוב נפתחים כמקור נוסף |
| F-009, F-012 | הודעה ממוקדת על מסד לא נכון, ועל קובץ נעול או בענן | "לא נמצאו ספרים" כללי, ושם שגיאה באנגלית בסוגריים |
| F-079, F-083 | ההגדרות `rangeEndBasis` ו־`rangeTrimPrevious` | הקוד תומך בבסיסים, אבל המסך מעביר תמיד `auto`, והקיצור תמיד פעיל |
| F-095, F-097 | מנוע כותרות: מצבי "תוכן הכותרת" ו"תת־סעיפים", ו"פסקאות כסעיפים" | מצב אחד (יישור לפי סוג ומספר). אין פיצול פסקאות |
| F-102, F-104 | רשימת יעדים שלא הופנו; טווח מקור "עד ההתאמה הנבחרת הבאה" | יעדים כפולים כספירה בלבד. טווח מקור רק דרך "השלמת טווחים" |
| F-129 | ההגדרות נשמרו ב־`otzaria-linker/settings/v2` | מפתח חדש, `otzaria-linker:prefs:v1`, בלי הגירה. רוב 16 ההגדרות הוסרו |
| F-133, F-134 | צפיפות בארבע רמות; `prefers-reduced-motion`; `@media print` | ה־CSS של הצפיפות נשאר, אבל שום קוד לא מפעיל אותו. אין reduced-motion ואין print |
| F-136 | אין `<select>` מובנה (בדיקה עצמית של גרסה 3) | 42 תגי `<select>` מובנים |
| F-137 | מגירת יומן בתוך הכלי | יומן אבחון שיורד כקובץ. אי אפשר לראות אותו בכלי |
| F-139 | איתור כותרת בכל הספרים, ופתיחה כמקור | רק "מעבר לכותרת" בספר אחד |
| §16 | Ctrl+E; ‏PgUp/PgDn/Home/End בשורות; Esc מבטל "בחירה מחדש" | אין |

### 3.2 יכולות "חובה" שאין להן בדיקה

לכידת עוגן מהמסך (`anchorFromSelection`, ‏F-074, F-077), תצוגת הטווח בקורא (F-041), Shift+לחיצה (F-046), העריכה
בבונה כזרימה מלאה (F-071, F-073), "החלפה" ו"ניקוי" (F-051, F-052), דוח הייבוא שהמשתמש רואה (F-018, F-026), סוג ריק
שנשמר כ־`OTHER` (F-022), `export/range-ignored`, ‏`heading/similar-name`, ‏`sefaria/both-sides`, מחיקה של מבנה
`alt_toc`, והחזרת הסטטוס `existing` אחרי ביטול של קיצור טווח.

### 3.3 חוב של גרסה 3 שתוקן

TD-C2 (קישורים לשורות כותרת), TD-C3 (fuzzer שלא נכשל, הוחלף בבדיקות property), TD-C4 (XSS, ‏`sanitizeBookHtml`),
TD-H1 (שמירה אוטומטית ואזהרה לפני סגירה), TD-H2 (קישורי מסד לא מיוצאים), TD-H3 (נרמול סוגי קשר), TD-H4 (אופסטים
ב־Regex), TD-H8 (ביטול מחזיר סטטוס), TD-M1 (חיפוש בינארי בסמנים), TD-M5 (ZIP במקום הורדות רבות), TD-M6 (שער
ל־CSV), TD-M7 (ייבוא `alt_toc`), TD-M8 (JSON פגום מדווח), L5 ("חזרה לכאן"). חלקי: TD-M4. לא תוקן: L7 (תאריך
מקומי בדוח).

## 4. היכולת אחר יכולת

### 4.1 מסכים, מקורות וייבוא, רשימת הספרים (F-001–F-037)

| # | יכולת | V3 | V7 | מצב | בדיקת רגרסיה | נגיש למשתמש | מגבלה |
|---|---|---|---|---|---|---|---|
| F-001 | שלושה מסכים ומעבר שסוגר דיאלוגים | `UI.show` 4461 | `src/ui/app.tsx` `App`; `src/state/router.ts` `Router.applyHash` | הוחלף: ניתוב hash, והעזרה היא דיאלוג | `tests/unit/state/router.test.ts` "a tab or a screen pushes an entry; Back and Forward walk them"; `tests/e2e/routing.spec.ts` "routes: a guided workflow, tabs, max-link, help and export; …" | כפתור המותג, Back בדפדפן | — |
| F-002 | העזרה זוכרת מאיפה הגיעו | 4465, 6650 | `HelpDialog` מעל המסך; `Router.onState` | הוחלף: דיאלוג מעל המסך | `tests/e2e/help.spec.ts` "help: F1 and the app-bar button open the guide; …"; `router.test.ts` "closing a dialog goes back to the entry it was opened from; …" | "עזרה", F1 | — |
| F-003 | כלי העורך רק במסך העורך | 4470 | `src/ui/shell/app-bar.tsx` `AppBar` (`inWorkspace`) | נשמר | חלקי: צילומי מסך ב־`tests/visual/` | אוטומטי | אין assert ישיר |
| F-004 | שבבי "N ספרים" ו"N ממתינים" | `updateChips` 4475 | `AppBar`: מונה על "ייצוא"; `HistoryMenu` | שונה: אין מונה NEW+EDITED ואין שבב ספרים | ההיסטוריה: `tests/e2e/history-list.spec.ts` "history list: newest first, …"; המונה: אין | "ייצוא (N)", Ctrl+H | המונה סופר את כל הקישורים |
| F-005 | "כניסה לעורך" מושבת עד שנטען ספר | `Boot.refreshEnter` 7040 | `AppStore.openFiles`; `Router.applyHash` (`hasWork`) | הוחלף: פתיחת קבצים נכנסת לבד | `router.test.ts` "a deep link without open sources falls back home, with a note" | "חזרה לסביבת העבודה" | — |
| F-006 | עמוד פתיחה עם 4 שלבים ובאנר למדריך | 1062–1083 | `src/ui/screens/home.tsx` `Home`, `PathChooser`, `TaskSheet` | הוחלף: 5 מסלולים ואשף משימה | `tests/e2e/home-tasks.spec.ts` "home: five paths; …" | "מה תרצו לעשות?" | אין באנר שמפנה למדריך |
| F-007 | מסד SQLite, הסוג לפי שם הקובץ | `Boot.handleDbFile` 7049 | `src/sources/registry.ts` `route`; `db-source.ts` `isLibraryDb` | שופר: זיהוי לפי תוכן, סכמות 6–7 נתמכות | `tests/integration/state/sefaria-ownership.test.ts` "the official database is the library: …"; `tests/integration/sources/registry.test.ts` "a database, loose text files and a links file in one drop" | "מסד נתונים", גרירה | — |
| F-008 | sql.js או קורא עצל לפי גודל | 2709 | `src/database/sqlite/lazy/*` | הוחלף: תמיד קורא עצל (AGENTS §2.3) | `tests/integration/database/lazy-sqlite.test.ts` "a book's lines via the index touch a small fraction of the pages" | פנימי | — |
| F-009 | אבחון "מסד לא נכון" | `diagnoseWrongDb` 2445 | `src/sources/db/pending.ts`; `src/core/db-guess.ts`; `DbMappingDialog` | הוחלף: אשף מיפוי עם נימוקים ורמז WAL | `tests/e2e/db-mapping.spec.ts` "a database without books: 'no books' with the reasons, …" | אשף המיפוי | ההודעות הממוקדות (נתוני משתמש, וריאנטים) וההפניה ל־seforim.db הוסרו |
| F-010 | זיהוי גמיש של שמות עמודות | `DbBookRepository` 2482 | `src/database/otzaria/capabilities.ts`; `db-guess.ts` + `DbMappingDialog` | הוחלף: מסד שאינו בסכמה נפתח באשף מיפוי | `tests/unit/core/db-mapping.test.ts` "two tables: …"; `tests/integration/database/wizard-structures.test.ts` | אשף המיפוי | — |
| F-011 | שבב "ספריא" לפי טבלת `source` | 2496–2518 | `DbBookSource.originOf` | נשמר עם שינוי: מסד אישי תמיד "personal" (AGENTS §3) | `tests/integration/sources/db-source.test.ts` "books carry origin and base-book flag" | "ספריא" בשורת הספר | — |
| F-012 | הודעה על קובץ נעול או בענן | `Util.readArrayBuffer` 2061 | `TextFilesSource.load` (`text/unreadable`); `registry.reasonOf` | שונה: הודעה כללית | חלקי: `tests/e2e/maxlink-job.spec.ts` | "N קבצים לא נפתחו" | ההנחיה על אוצריא פתוחה ו־OneDrive אבדה |
| F-013 | התקדמות הטעינה | `setStatus` 7033 | `AppStore.openFiles` → `runTask`; פס המשימה ב־`AppBar` | שונה: תווית וביטול, בלי שלבים | חלקי: `tests/integration/state/store.test.ts` "a task that ends never takes away another one's progress and cancel" | פס המשימה | אין התקדמות באחוזים בפתיחה |
| F-014 | קובצי `.txt`, UTF-8 | `fromFiles` 2416 | `src/sources/text/text-source.ts` `splitBookLines` | שונה ושופר: כמו הגנרטור; CR בודד וקידוד אחר עם אזהרה | `tests/unit/sources/text-source.test.ts` "a non-UTF-8 book is read, with a warning …" | "קבצים", גרירה | — |
| F-015 | תיקייה כולל תתי־תיקיות | `fromFolder` 2432 | `src/ui/files.ts` `pickFiles`; `registry.open` | שופר: כל סוגי הקבצים בתיקייה מסווגים לפי תוכן | `tests/e2e/multi-source.spec.ts` "a folder, the Otzaria database and a second folder: …" | "תיקייה" | — |
| F-016 | מניעת טעינה כפולה | `Domain.addBooks` 2858 | `SourceRegistry.byIdentity`, `fileIdentity` | שונה: למסד לפי תוכן; לטקסט אין | `tests/integration/sources/open-twice.test.ts` "the same database picked twice is one source; …" | הודעה "כבר פתוח" | תיקייה או `.txt` פעמיים = מקור כפול, בלי בדיקה |
| F-017 | ייבוא `_links.json`, המקור לפי שם הקובץ | `parseFiles` 2753 | `src/state/exchange.ts` `importLinksFile` | שונה: חובה `_links.json`, אובייקט בודד לא מיובא | `store.test.ts` "an imported links file binds to books opened later by exact title, and re-exports unchanged" | גרירה | — |
| F-018 | JSON פגום מדולג, השגיאה ביומן | 2761 | `parseLinksJson` (`file/not-json`) | שופר (TD-M8): הודעה גלויה | חלקי: `tests/unit/formats/links-json.test.ts` "says it in plain words; …" | הודעת שגיאה | ההודעה עצמה לא נבדקת |
| F-019 | שערי תקינות לרשומה | `importJsonRecords` 3414 | `parse.ts` `decodeRecord`; `convert.ts` `recordToLink` | שונה בכוונה, כמו הגנרטור | `links-json.test.ts` "one undecodable record makes the generator drop the WHOLE file; …" | הודעת הייבוא | — |
| F-020 | המרה 1→0 במקום אחד | 3422 | `src/formats/links-json/convert.ts` | נשמר (AGENTS §2.4) | `links-json.test.ts` "converts indexes, ranges and the anchor (label from the LAST ' אות ')" | פנימי | — |
| F-021 | "Connection Type" עם שתי n | 3466 | `decodeRecord` (`record/double-n-type`) | שונה: לא נלקח כסוג, נכתב חזרה, עם אזהרה (AGENTS §2.9) | `links-json.test.ts` '"Connection Type" with two n is ignored by the generator' | הודעת הייבוא | — |
| F-022 | סוג ריק → commentary | 3479 | `parseConnectionType` | שונה: `OTHER`, כמו ה־build (LINK_FORMATS §2.5) | חלקי: `links-json.test.ts` 'a null or missing "Conection Type" is written back as it was, …' | פנימי | אין assert על `OTHER` |
| F-023 | עוגן גולמי ותווית מ־heRef_2 | 3484 | `recordToLink` | נשמר | `links-json.test.ts` "converts indexes, ranges and the anchor …" | פנימי | — |
| F-024 | ספר־צל | 3425 | `unresolved:<title>`; `attachLinks` | הוחלף: הקישור נקשר כשהספר נפתח | `tests/integration/state/links-before-books.test.ts` "attach to the books when they open: …" | הודעה "ספר המקור … עדיין לא פתוח" | לא פטור מבדיקות (בכוונה) |
| F-025 | EXISTING; כפילויות מדולגות | 3475, 3487 | `recordToLink`; `validateExport` (`export/duplicate`) | שונה: כפילות נשמרת (קובץ יוצא זהה) ומסומנת | `tests/unit/core/validate.test.ts` "links that collapse into one stored link are flagged as duplicates" | "מחיקת העתקים כפולים" | — |
| F-026 | דיאלוג דוח ייבוא | `Dialogs.importReport` 5567 | `importLinksFile` → `notify` עם פירוט | הוחלף: הודעה מתקפלת | אין | הודעה | תוכן ההודעה לא נבדק |
| F-027 | רשימת כותרות ספריא | `Sefaria.loadTitles` 2966 | `sefaria-titles-snapshot.ts`; `AppStore.loadSefariaTitles` | שופר: רשימה מוטמעת, ורשימת הספרייה מחליפה אותה | `tests/integration/state/sefaria-refs.test.ts` "the library's own list of Sefaria titles replaces the embedded one (B6)" | חלון הייצוא | גרירה של הקובץ פותחת אותו כספר |
| F-028 | "איפוס מלא" | 7123 | — | **הוסר** | אין | לא נגיש | §3.1 |
| F-029 | אין ייבוא `alt_toc` | — | `detectKind`; `AltTocState.importFile` | שופר (TD-M7) | `tests/integration/state/alt-toc-export.test.ts` "an imported _alt_toc.json becomes the book's structures …" | גרירה | — |
| F-030 | רשימה וירטואלית | `rowHeight` 4491 | `src/ui/workspace/book-picker.tsx` `BookList` (`LIMIT=200`) | הוחלף: עד 200 לכל מקור, ואז חיפוש | חלקי: `tests/e2e/touch-targets.spec.ts` | "קבצים ומסדים" | מעבר ל־200 רק בחיפוש |
| F-031 | חיפוש תת־מחרוזת | `filterBooks` 4496 | `useBookSearch` | שופר: מתעלם מניקוד וגרשיים, מדרג | חלקי: `tests/e2e/maxlink.spec.ts` | "חיפוש ספר…" | — |
| F-032 | שבבי סינון | 1186; 4499 | `BookList`, קבוצה לכל מקור | הוחלף | `multi-source.spec.ts` (אותו מבחן) | כותרות הקבוצות | אין סינון לפי סוג |
| F-033 | תגיות ספר | `bookTag` 4505 | `SourceBadge`; `side-btn[aria-pressed]` | שונה: התג על הקבוצה | `multi-source.spec.ts` | רשימת הספרים | — |
| F-034 | מתג "פתיחה אל: מקור/יעד" | `setLoadInto` 4565 | `BookList.row`, כפתור לכל צד | הוחלף | `multi-source.spec.ts` | "מקור"/"יעד" בשורה | — |
| F-035 | הסרת ספר יחיד, עם ביטול | `removeBookAsked` 5293 | רק `AppStore.closeSource` | **הוסר** | `tests/integration/state/export-completeness.test.ts` "close the database and open it again: …" (לסגירת מקור) | ✕ "סגירת <מקור>" | §3.1 |
| F-036 | ספירת ספרים | 4530 | `SourcesBody`; `group-head .count` | שונה: לכל מקור | אין | לוח המקורות | — |
| F-037 | סדר הספרים | 2512/2647 | `OtzariaDbReader.books` (לפי rowid) | לא שופר (היה "לשפר") | אין | — | המסד לא ממוין |

### 4.2 הקוראים, הבונה, קישורי השורה ועוגן (F-038–F-077)

| # | יכולת | V3 | V7 | מצב | בדיקת רגרסיה | נגיש למשתמש | מגבלה |
|---|---|---|---|---|---|---|---|
| F-038 | פתיחת ספר וקישוריו מהמסד | `openBookInto` 4571 | `src/ui/workspace/reader.tsx` `BookView`; `src/state/lines.ts` `LineStore.existingAt` | שונה: טעינה עצלה, קישורי המסד לכל מנה | חלקי: `tests/integration/state/db-links-state.test.ts` "the picked line: project links and database links, kept apart" | "מקור"/"יעד" | אין E2E למונה המסד בקורא |
| F-039 | HTML של השורה | `renderPane` 4636 | `reader.tsx` `Line` + `sanitizeBookHtml` | שופר: מחוטא (TD-C4) | `tests/unit/core/text/sanitize.test.ts` "never lets a tag carry an attribute or an event handler" | הקוראים | אין התווית "(שורה ריקה)" |
| F-040 | טעינה במנות | 4661; 7196 | `BookView` (`IntersectionObserver`) | הוחלף: וירטואליזציה | חלקי: `tests/e2e/manual-editor.spec.ts`; `tests/unit/state/lines.test.ts` | אוטומטי | — |
| F-041 | תצוגה מקדימה של טווח | `previewRange` 4626 | `Chunk` → `Line picked` | נשמר | **אין** | הקורא | — |
| F-042 | שורת תחתית | 4696 | `ReaderTools`; `End`; live region | הוחלף | חלקי: `tests/e2e/accessibility.spec.ts` "keyboard only: …" | סרגל הקורא, הבונה | אין מונה "שורות עם קישור" |
| F-043 | חיפוש בטקסט | `runFind` 4720 | `src/ui/workspace/book-find.tsx`; `src/state/book-find.ts`; `src/core/text/find.ts` | שופר: בכל הספר, ב־Worker, עם רשימת תוצאות | `tests/e2e/book-search.spec.ts` "search in a book: Ctrl+F, next/previous, result list, …" | "חיפוש בטקסט הספר", Ctrl+F | עד 1,000 שורות |
| F-044 | הדגשת התאמות | `highlight` 4618 | `paintMatches` (CSS Custom Highlight API) | הוחלף | חלקי: book-search; `tests/unit/core/text/find.test.ts` | הקורא | צביעת המילים לא נבדקת |
| F-045 | מעבר לשורה | 4703 | `store.reveal` + `BookView` | נשמר | `manual-editor.spec.ts` "the manual editor by touch: …" | "מעבר לשורה" | ההבהוב לא נבדק |
| F-046 | בחירת שורות | `onLineClick` 4753 | `BookView.onClick` → `store.pickLine` | שונה: Ctrl/Cmd הוסר | חלקי: `tests/integration/state/ranges.test.ts` | לחיצה, Shift+לחיצה | §3.1; אין E2E ל־Shift |
| F-047 | לחיצה עם סימון טקסט אינה בחירה | 7205 | `BookView.onClick` | נשמר | **אין** | הקורא | — |
| F-048 | ניווט מקלדת | `moveLineCursor` 4807 | `BookView.onKey` | שונה: רק ↑↓ ו־Shift, בלי listbox | `accessibility.spec.ts` "keyboard only: …"; `tests/e2e/line-links.spec.ts` "by keyboard: …" | אזור השורות | §3.1 |
| F-049 | שורת מקור קובעת `activeLine` | 4791 | `builder.tsx` `PickedLineLinks`; `db-links-panel.tsx` | הוחלף | `db-links-state.test.ts` "the picked line: …" | הבונה, "קישורים מהמסד" | — |
| F-050 | תוכן עניינים | `Dialogs.toc` 5611 | `reader.tsx` `HeadingJump` | שונה: רשימה שטוחה, 200 תוצאות | `manual-editor.spec.ts` "… jump to a heading and to a line, …" | "מעבר לכותרת" | אין קיפול |
| F-051 | החלפת מקור ⇄ יעד | `swapSides` 4591 | `builder.tsx` `swap` | שונה | **אין** | "החלפה" | לפי קריאת הקוד, ref שהוקלד נשאר בטיוטה (לא הורץ) |
| F-052 | הצגת מקור ויעד, "ניקוי" | `renderBuilder` 4950 | `builder.tsx` `End`; `store.clearPicks` | נשמר | חלקי: `tests/integration/state/worker-restart.test.ts` | "ניקוי" | הכפתור לא נבדק |
| F-053 | בורר מבנה (5 מבנים) | `setKind` 5130 | נגזר מהבחירה | הוחלף ([ADR 0005](../adr/0005-ui-decisions.md) #3) | אין | — | — |
| F-054 | "עד שורה", "עד הבא", "עד הסוף" | `rangeRow` 5050 | `builder.tsx` `RangeButtons`; `src/state/ranges.ts` `suggestEnd` | שונה | `ranges.test.ts` (integration) "until the next link: stops one line before the next link, and before a heading" | הבונה | §3.1 |
| F-055 | `effectiveEnd` | 4901 | `store.draft` | שונה: הסוף הוא מה שנבחר | חלקי: `tests/unit/linking/ranges.test.ts` | הבונה | §3.1 |
| F-056 | בורר סוג הקשר | 4996 | `builder.tsx`; `type-options.tsx` | שופר | `tests/e2e/manual-linking.spec.ts` "the link type picker is grouped into commentary types and link types" | "סוג הקשר" | — |
| F-057 | "מתקדם": heRef_2, ref_2, ref_1 | `advancedBlock` 5088 | `builder.tsx` | שונה: לפי סיווג ספריא | `manual-linking.spec.ts` "open → pick → create → undo/redo → export, offline" | "אפשרויות מתקדמות" | — |
| F-058 | משפט סיכום | `summarySentence` 4917 | `builder.tsx` `StoredAs` | הוחלף | `manual-linking.spec.ts` (`.stored-as`) | הבונה | לא מזכיר טווח או עוגן |
| F-059 | אזהרות מקדימות | 5018 | `store.draftProblems` | שופר | `store.test.ts` "a link to a heading line is refused, with the reason" | הבונה | — |
| F-060 | כפתור יצירה מושבת עם הסבר | `canCreate` 4942 | `Builder` | נשמר | חלקי: אותה בדיקה | "יצירת קישור", Ctrl+Enter | כשחסר צד, Ctrl+Enter שקט |
| F-061 | יצירה מרובה | `buildLinksFromSelection` 5173 | — | **הוסר** | אין | לא נגיש | §3.1 |
| F-062 | heRef אוטומטי | `computeHeRef` 3749 | `store.autoHeRef` | שונה: קודם heRef מהמסד | `store.test.ts` "open → pick → create → undo/redo → export"; `compat-edit.test.ts` "a cleared field and a blank database reference fall back to title and line" | "שם המקום ביעד" | שרשרת הכותרות לא נבדקת |
| F-063 | חסימה רק על שגיאות | 5195 | `store.createFromDraft` | נשמר | `store.test.ts` "a link to a heading line is refused, with the reason" | הבונה | — |
| F-064 | קיצור הטווח הקודם | `trimPrevious` 3299 | `store.trimAround` → `RangesState.trimFor` | שופר: באותו צעד ביטול, עם הודעה | `ranges.test.ts` "a new link inside another link's range cuts that range — in the same undo step" | אוטומטי | — |
| F-065 | אחרי היצירה | 5217 | `store.createFromDraft` | שונה: toast עם "ביטול" רק במצב "לחיצה ולחיצה" | `store.test.ts`; `manual-linking.spec.ts` | הבונה | — |
| F-066 | לשוניות מפרשים / קישורים | `renderLinkPanel` 5237 | `links-panel.tsx` `LinksPanel` | הוחלף | חלקי: `manual-linking.spec.ts` | "קישורים" | — |
| F-067 | פריט ברשימה | `linkItem` 5264 | `link-item.tsx` `LinkItem` | שונה | חלקי: `tests/e2e/db-links.spec.ts` | "קישורים" | עוגן ו־ref_2 רק ב־tooltip |
| F-068 | מעבר לשורת היעד | 5281 | `store.revealLink` | שופר: שני הצדדים | `store.test.ts` "showing a link keeps both its lines marked in the readers; …" | לחיצה על פריט | — |
| F-069 | מחיקה עם אישור | `UI.deleteLink` 5315 | `store.deleteLinks` | שונה: בלי אישור, עם "ביטול" (#42 C31) | `tests/integration/state/hebrew-counts.test.ts` "says what was deleted, with an undo action that brings it back" | "מחיקה" | — |
| F-070 | שחזור נחסם כשנוצר קישור זהה | `restore` 3120 | `history.restoreChange` | **הוסר** | אין | "שחזור" | §3.1 |
| F-071 | דיאלוג עריכה | `Dialogs.editLink` 5395 | `store.editInBuilder` + `Builder` | הוחלף: עריכה בבונה | חלקי: `matched-words-persist.test.ts` | "עריכה בבונה" | אין הקלדת מספרים; אין E2E |
| F-072 | שמירת עריכה | 5495 | `createFromDraft` (ענף `editing`) | שונה: דחיית הכפילות הוסרה | חלקי: `tests/unit/state/history.test.ts` | "שמירת השינויים" | §3.1 |
| F-073 | "בחירה מחדש מהמסך" | 5466 | `pickLine` בזמן `editing` | הוחלף | `compat-edit.test.ts` "moving the source line drops ref_1, …" | לחיצה בקורא | Esc לא מבטל |
| F-074 | לכידת עוגן | `captureAnchor` 4865 | `anchor-selection.ts` `anchorFromSelection` | שונה: לפי ה־DOM המחוטא | **אין** (רק `sanitize.test.ts` כתנאי מקדים) | סימון מילים | §3.2 |
| F-075 | דיאלוג "סמן" | `anchorLabel` 5544 | `store.pickAnchor` | שונה: הדיאלוג הוסר | אין | הבונה | §3.1 |
| F-076 | אופסט גלוי → גולמי | `rawOffsetFromVisible` 2124 | `src/core/text/offsets.ts` | שונה ומוצדק (AGENTS §2.4) | `tests/unit/core/text/offsets.test.ts` 'אופסט גלוי→גולמי: "אב <b>ג</b> דה" 3..5 → 6..12' | פנימי | — |
| F-077 | עוגן דורש שורה אחת | 4946 | מבני | נשמר מבנית | אין | — | `editInBuilder` טוען עוגן וטווח יחד |

### 4.3 טווחים, מודל, ספריא, קישור אוטומטי, `alt_toc` (F-078–F-111)

| # | יכולת | V3 | V7 | מצב | בדיקת רגרסיה | נגיש למשתמש | מגבלה |
|---|---|---|---|---|---|---|---|
| F-078 | רק שורת הסיום נשמרת | `LinkService.build` 3031 | `src/core/links/model.ts` `LinkSide.end`; `convert.ts` | נשמר (AGENTS §3) | `links-json.test.ts` "a reversed or degenerate range is dropped with a warning (generator ignores it)" | הבונה | — |
| F-079 | סמנים לפי `rangeEndBasis` | `Ranges.markers` 3242 | `src/linking/ranges.ts` `rangeMarkers` | ההגדרה הוסרה: תמיד `auto` | `ranges.test.ts` (unit) "markers are the starts of this side's links plus the headings, sorted and unique" | פנימי | §3.1 |
| F-080 | `suggestEnd` | 3260 | `src/linking/ranges.ts` `suggestEnd` | שופר: נסוג מכותרת | unit "an end on a heading line steps back (Otzaria drops a range that ends on a heading)" | "טווח עד הקישור הבא" | — |
| F-081 | `validateSide` | 3269 | `validate.ts` `sideChecks` | שונה: מחוץ לספר = שגיאה ([POLICY_TO_CODES](POLICY_TO_CODES.md)) | `validate.test.ts` "policy: a range that ends past the book is an error; …" | בונה, בקרה, ייצוא | `export/range-ignored` בלי בדיקה |
| F-082 | `isEffective` | 3287 | `isRange` + `convert.ts` | שונה: סוף על כותרת נכתב עם אזהרה | `tests/unit/formats/link-range-end-bounds.test.ts` "is refused at import with a warning, …" | פנימי | — |
| F-083 | `trimPrevious` | 3299 | `trimBefore`; `RangesState.trimFor` | שופר (TD-H8). המתג הוסר | unit "a cut never ends on a heading: it steps back from it (review C11)" | אוטומטי | הסטטוס אחרי ביטול לא נבדק |
| F-084 | `autoFillBook` | 3321 | `fillRanges`; `RangesState.fill` | שונה (review C15): גם כותרת עוצרת | unit "a book with no known length (a shadow book from a links file) is never touched"; integration "range completion of a book: one step, undoable, …" | "השלמת טווחים" | — |
| F-085 | `revert`/`reapply` | 3358 | `src/state/history.ts` | הוחלף: היסטוריה אחידה | `history.test.ts` "property: undoing every step of any sequence returns to the start" | Ctrl+Z | — |
| F-086 | מפתח ייחודיות ו־`dedup` | `dedupKey` 3021 | `src/core/links/equality.ts`; `validateExport` | שונה: כפילות לא נחסמת ביצירה | `validate.test.ts` "links that collapse into one stored link are flagged as duplicates"; `tests/e2e/qa.spec.ts` "QA finds a duplicate and a link to a heading line; …" | בקרה, ייצוא | §3.1 |
| F-087 | `validate` | 3045 | `validateLink`; `draftProblems` | שונה: קישור לכותרת חוסם. אין בדיקת "אותה שורה" | `validate.test.ts` "legacy: קישור משורת כותרת מדולג"; "legacy: שורה מחוץ לתחום נחסמת בייצוא" | בונה | §3.1 |
| F-088 | `checkIntegrity` | 3179 | — | הוסר: אין מפת dedup | חלקי: `history.test.ts` (property) | פנימי | — |
| F-089 | סיווג מפרש | `isDependent` 3222 | `connection-type.ts` `APP_DEPENDENT_TYPES`, `appPanelOf` | שופר: 9 סוגים, לפי האפליקציה | `tests/unit/core/connection-type-groups.test.ts` "agrees with where Otzaria shows a stored link (appPanelOf)" | בורר הסוג | — |
| F-090 | `typeLabel` | 3223 | `TYPE_LABELS`, `typeShown` | הוחלף (TD-H3) | חלקי: "every type has a Hebrew name and a short description" | רשימת הקישורים | — |
| F-091 | זיהוי ספר ספריא | 2978 | `sefaria-titles.ts` `isSefariaOwned` | שונה (B6): לפי רשימת כותרות | `tests/unit/core/sefaria-ref.test.ts` "the embedded snapshot classifies by exact title" | פנימי | — |
| F-092 | קודי `checkLink` | 2984 | `validate.ts` `sefariaChecks` | שופר | `validate.test.ts` "legacy: ref_1 ו-ref_2 יחד → שגיאה ; …"; `tests/contracts/field-route-matrix.test.ts` | בונה, בקרה, ייצוא | `sefaria/both-sides` בלי בדיקה |
| F-093 | בדיקות ספריא תמיד בייצוא | 3604 | `validateExport` | שונה: חוסמות בשליחה לספרייה | `validate.test.ts` "legacy: רשומה שיובאה בלי ref_2 — …"; `sefaria-refs.test.ts` | חלון הייצוא | — |
| F-094 | דיאלוג אוטומטי, 4 לשוניות | `Dialogs.auto` 5732 | `suggestions-panel.tsx`; `src/linking/automatic/index.ts` | הוחלף: לשונית "הצעות", הצעות לאישור | `tests/e2e/automatic-linking.spec.ts` "headings engine: run in the worker → table → approve all certain → card view → undo" | "הצעות" | — |
| F-095 | לפי כותרות, 3 מצבים | `buildStruct` 5999 | `src/linking/automatic/headings/` | הוחלף: מצב אחד (TD-C2 תוקן) | `tests/unit/linking/headings/engine.test.ts` "never targets a heading line, at either end of a range" | "לפי כותרות" | §3.1 |
| F-096 | התאמה גמישה לכתיב | 3824 | `headings/align.ts` `compat` | שונה: רק לשמות, סף 0.85 | **אין** | פנימי | — |
| F-097 | "פסקאות כסעיפים" | `trySplit` 3862 | — | **הוסר** | אין | — | §3.1 |
| F-098 | אבחון "אין מקבילה" | 3896 | `headings/index.ts` `unmatched` | הוחלף | `headings/engine.test.ts` "a chapter missing in the base is unmatched with a reason" | "בלי התאמה" | — |
| F-099 | לפי תגיות | `buildTag` 6055 | `pattern/engine.ts` `tagFinder` | שונה: חלק מ"לפי תבנית", הסוג `reference` | `tests/unit/linking/pattern/engine.test.ts` "the content of <sup> is the number; …" | "לפי תבנית" | — |
| F-100 | לפי Regex | `buildRegex` 6102 | `pattern/engine.ts`; `template.ts` | שופר (TD-H4), שומר ReDoS | `engine.test.ts` "the match on the visible text maps back to the raw span …"; `tests/e2e/pattern-and-ranges.spec.ts` | "התבנית" | — |
| F-101 | קובץ הערות לפי פרקים | `resolveTargets` 5970 | `pattern/engine.ts` (`chapter-line`) | נשמר ושופר | `engine.test.ts` "a number that does not grow moves to the next chapter; …" | "לאן ההפניה מצביעה" | — |
| F-102 | אבחון התבנית | `diagnose` 5958 | `pattern/engine.ts` | הוחלף חלקית | `engine.test.ts` "a number past the end, or pointing at a heading line, is reported …" | הערות הריצה | §3.1 |
| F-103 | דרגות ודאות, 300 שורות | `renderMatches` 5798 | `types.ts` `DEFAULT_THRESHOLDS`; `bulk-approve.tsx` | שופר | `store.test.ts` "run → approve all certain (one undo step) → …"; `tests/integration/state/bulk-approve.test.ts` | "אישור כל הוודאיות" | — |
| F-104 | `runMatches` | 5906 | `src/state/suggestions.ts` `approve` | שונה ([AUTOMATION_ENGINE](../AUTOMATION_ENGINE.md) §9) | `store.test.ts` | אישור הצעות | §3.1 |
| F-105 | השלמת טווחים | `buildRanges` 6156 | `links-panel.tsx`; `RangesState.fill` | הוחלף: מוחל כצעד אחד שאפשר לבטל | `pattern-and-ranges.spec.ts` "pattern method → approve → range completion → undo" | "השלמת טווחים" | אין תצוגה מקדימה |
| F-106 | עורך `alt_toc` | `Dialogs.altToc` 6222 | `alt-toc-dialog.tsx`; `src/state/alt-toc.ts` | שופר (TD-M7) | `tests/e2e/alt-toc.spec.ts` "alt_toc: build a structure from the headings, number it, save, export it with the links" | "מבני כותרות" | — |
| F-107 | מבנים: חדש ומחיקה | 6259 | הדיאלוג; `validateAltToc` | שונה קלות: מחיקה בלי אישור | `tests/unit/core/alt-toc.test.ts` "errors: missing/duplicate key, …" | "מבנה חדש" | המחיקה לא נבדקת |
| F-108 | צמתים, מילוי מכותרות | 6310 | `src/core/alt-toc/edit.ts` `entriesFromHeadings` | נשמר ושופר | `alt-toc.test.ts` "fill from headings: …" | "מילוי מכותרות הספר" | — |
| F-109 | מספור בגימטריה | 6331 | `edit.ts` `numberInGematria` | נשמר | `alt-toc.test.ts` "gematria numbering: …" | "מספור בגימטריה" | — |
| F-110 | ולידציה בשמירה | `AltToc.validate` 3969 | `src/core/alt-toc/model.ts` `validateAltToc` | שונה (TD-M7) | `alt-toc.test.ts` "a clean structure has no problems; siblings may share a line (library doc §6)" | חלון וייצוא | — |
| F-111 | ייצוא `alt_toc` | 3993 | `serializeAltToc`; `planAltTocExport` | שונה | `tests/unit/formats/alt-toc.test.ts` "writes key, title, heTitle, nodes in that order; …"; `alt-toc.test.ts` "version 3's regression case: …" | ייצוא | — |

### 4.4 ייצוא, היסטוריה, הגדרות, יומן, עזרה (F-112–F-142)

| # | יכולת | V3 | V7 | מצב | בדיקת רגרסיה | נגיש למשתמש | מגבלה |
|---|---|---|---|---|---|---|---|
| F-112 | סדר שדות קבוע | `ExportBuilder.build` 3564 | `src/formats/links-json/record.ts` `CANONICAL_ORDER` | שונה: סדר הספרייה; לרשומה מיובאת הסדר המקורי | `links-json.test.ts` "new links get the canonical key order and a folder-less path_2" | פנימי | — |
| F-113 | `"Conection Type"` | 1885 | `record.ts` `CONNECTION_TYPE_KEY` | נשמר | אותה בדיקה | פנימי | — |
| F-114 | 0→1 רק בייצוא | 3565 | `convert.ts` | נשמר | `links-json.test.ts` "converts indexes, …" | פנימי | — |
| F-115 | שערי ייצוא | 3527 | `validate.ts`; `export.ts` `planExport` | שונה: קצה שהוא כותרת = שגיאה; סוף טווח על כותרת נכתב עם אזהרה | `validate.test.ts` "range end on a heading, and anchors outside the line" | חלון הייצוא | — |
| F-116 | אופסטי עוגן | 3619 | המודל שומר `rawStart/rawEnd` | נשמר | `tests/unit/formats/export.test.ts` "re-exporting an untouched imported file gives back the same bytes" | פנימי | — |
| F-117 | `path_2`, קיבוץ לפי כותר | 3600 | `convert.ts` `path2ForTitle`; `planExport` | שונה (AGENTS §3); TD-M4 חלקי | `export.test.ts` "a link whose source title is unsafe is held back…" | פנימי | — |
| F-118 | היקף ייצוא | 6424 | `export-dialog.tsx` | הוחלף: בחירת מטרה; קישורי מסד לא מיוצאים (TD-H2) | `export.test.ts` "db links are never written" | "ייצוא" | אין "רק חדשים ושנערכו" |
| F-119 | `_report.txt` | 3634 | `src/formats/report/export-report.ts` | שופר | `tests/unit/formats/export-report.test.ts`; `export-accounting.test.ts` "every held-back link is in the report — …" | "הורדת הדוח" | L7 |
| F-120 | בדיקה מקדימה | 6458 | `export-dialog.tsx` | שופר | `tests/e2e/export-completeness.spec.ts` "the check and the export dialog hold back the same links and deletions, …" | חלון הייצוא | — |
| F-121 | ZIP | 2774 | `exchange.ts` `saveExport`; `export.ts` `zipBundle` | שונה: `links-YYYY-MM-DD.zip`, ZIP רק ליותר מקובץ אחד | `export.test.ts` "the ZIP is deterministic and lays files out under links/" | "הורדת ZIP" | קובץ יחיד יורד בלי הדוח |
| F-122 | JSON נפרדים | 6499 | — | הוסר (TD-M5) | אין | — | — |
| F-123 | CSV ספריא | `buildCsv` 3681 | `src/formats/sefaria-csv/write.ts` | נשמר ושופר (TD-M6) | `tests/unit/formats/sefaria-csv.test.ts` "is byte-identical to version 3's buildCsv on the same links" | מצב מתקדם | — |
| F-124 | ייצוא חסום כשאין מה לייצא | 6421 | `export-dialog.tsx` `NothingWritten` | שופר (#42 C24) | `alt-toc-export.test.ts` "says so, instead of returning without a word" | "ייצוא" | — |
| F-125 | מחסנית פקודות | 3707 | `history.ts`, `HISTORY_LIMIT` | שונה: 500 | `history.test.ts` "one action = one undo step, and redo replays it" | ביטול / ביצוע חוזר | המגבלה לא נבדקת |
| F-126 | מה נרשם בהיסטוריה | `History.push` | `store.apply`/`commit` | שופר | `tests/integration/state/history-list.test.ts` "labels read as Hebrew, with counts…" | פנימי | — |
| F-127 | דיאלוג היסטוריה | 6385 | `src/ui/shell/history-menu.tsx` | הוחלף (L5) | `history-list.spec.ts` "history list: newest first, jump back and forward, keyboard" | "היסטוריית פעולות" | — |
| F-128 | כפתורי ביטול, toast | 5348 | `app-bar.tsx`; `store.deleteLinks` | חלקי | `hebrew-counts.test.ts` "says what was deleted, with an undo action …" | "ביטול הפעולה האחרונה" | אין toast אחרי יצירה |
| F-129 | הגדרות ב־localStorage | 1930 | `src/state/preferences.ts` | שונה: מפתח חדש בלי הגירה | חלקי: `tests/unit/state/preferences.test.ts` | פנימי | §3.1 |
| F-130 | אין התמדה | — | `src/app/idb-store.ts`, `autosave-window.ts`, פרויקטים | שופר (TD-H1) | `store.test.ts` "autosave writes after a change and offers recovery in a new session"; `tests/e2e/autosave-tabs.spec.ts` | "שמירת פרויקט" | `beforeunload` לא נבדק |
| F-131 | דיאלוג הגדרות | 6525 | תפריט "הגדרות" ב־`app-bar.tsx` | הוחלף | חלקי: `accessibility.spec.ts` | "הגדרות" | אין "איפוס להגדרות ברירת המחדל" |
| F-132 | ערכת נושא | 6986 | `src/ui/theme/theme.ts` | שונה: הבחירה בתפריט | חלקי: `manual-linking.spec.ts` "dark theme and narrow screen keep the workspace usable" | "ערכת צבעים" | — |
| F-133 | צפיפות | CSS 136 | `tokens.css` `[data-density]` — לא מופעל | **הוסר** (CSS מת) | אין | "גודל טקסט" במקום | §3.1 |
| F-134 | רספונסיביות, מגע, reduced-motion, print | CSS 853 | `fitLayoutToWidth`, media queries | חלקי | `tests/e2e/layout.spec.ts`; `touch-targets.spec.ts` | פנימי | אין reduced-motion ו־print |
| F-135 | פוקוס בדיאלוגים | `Kit.open` 4093 | `<dialog>.showModal()`; `menu.tsx` | נשמר | `accessibility.spec.ts` "dialogs and menus keep focus inside, close with Esc and give focus back" | כל הדיאלוגים | — |
| F-136 | אין `<select>` מובנה | 4220 | 42 תגי `<select>` | שונה, בלי תיעוד | אין | — | §3.1 |
| F-137 | מגירת יומן | 1979 | `src/diagnostics/log.ts`; `store.saveDiagnostics` | הוחלף: קובץ `.jsonl` | `tests/unit/diagnostics/log.test.ts` "is bounded and keeps the newest entries" | "שמירת יומן אבחון" | §3.1 |
| F-138 | toast ושכבת המתנה | `Kit` 4041 | `notices.tsx`, `notice-policy.ts`; פס המשימה | הוחלף | `tests/unit/state/notice-policy.test.ts` "errors and notices with an action stay until closed"; `tests/e2e/robustness.spec.ts` | פנימי | — |
| F-139 | איתור כותרת בכל הספרים | `GlobalIndex` 3905 | רק `HeadingJump` בספר אחד | **הוסר** | חלקי | "מעבר לכותרת" | §3.1 |
| F-140 | מסך עזרה | 6660 | `help-dialog.tsx` מ־USER_GUIDE ו־TROUBLESHOOTING | שופר | `help.spec.ts`; `tests/unit/ui/help-markdown.test.ts` "every in-guide link points at a heading that exists" | "עזרה", F1 | — |
| F-141 | שמירת עותק עצמאי | 7012 | `src/ui/shell/offline-download.tsx` | שונה: רק מאתר http(s), ומציג את הגרסה (#26) | `tests/e2e/offline-single-file.spec.ts` "http(s): the control is a same-origin download link…"; `tests/e2e/pages-artifact.spec.ts`; `tests/unit/ui/offline-download.test.ts` | "הורדת הכלי לעבודה בלי אינטרנט" | ב־`file://` אין, כי המשתמש כבר מחזיק את הקובץ |
| F-142 | בדיקות עצמיות `?selftest` | 7339 | Vitest ו־Playwright; `ping` ב־`main.tsx` | הוחלף | `legacy-baseline.spec.ts` (על קובץ V3); offline-single-file | לא נגיש | אין בדיקה עצמית למשתמש |

## 5. קיצורי מקלדת (§16)

| קיצור | V3 | V7 (קובץ) | מצב | בדיקה |
|---|---|---|---|---|
| Ctrl/⌘+Enter | יצירה, גם בזמן הקלדה | `builder.tsx` | נשמר | `accessibility.spec.ts` "keyboard only: …" |
| Ctrl+Z / Ctrl+Y | בטל / בצע שוב | `src/ui/app.tsx` | נשמר, ונוסף Ctrl+Shift+Z | `manual-linking.spec.ts` "open → pick → create → undo/redo → export, offline" |
| Ctrl+F | חיפוש במקור | `reader.tsx` | שונה: בקורא שבפוקוס | `book-search.spec.ts` |
| Ctrl+E | ייצוא | — | **הוסר** | אין |
| Ctrl+H | היסטוריה | `app.tsx` | נשמר | `history-list.spec.ts` |
| F1 | עזרה | `app.tsx` | נשמר | `help.spec.ts` |
| Esc (שרשרת) | תפריט ← דיאלוג ← יומן ← ביטול "בחירה מחדש" | `menu.tsx`, `<dialog>`, `book-find.tsx` | חלקי: אין מגירת יומן, ו־Esc לא מבטל עריכה | `accessibility.spec.ts` |
| ↑↓ PgUp PgDn Home End | ניווט ובחירה | `reader.tsx` `onKey` | חלקי: רק ↑↓ ו־Shift | `accessibility.spec.ts` |
| ניווט בתפריט | `Kit.menu` | `menu.tsx` | נשמר | `accessibility.spec.ts` |
| Tab בדיאלוג | מלכודת פוקוס | `<dialog>.showModal()` | נשמר | `accessibility.spec.ts` |
| Enter / Shift+Enter בחיפוש | 7259 | `book-find.tsx` (וגם F3) | נשמר | `book-search.spec.ts` |
| (חדש) Ctrl+S, ‏Alt+←/→, ‏A/R/J/K בהצעות | — | `app.tsx`, `suggestions-panel.tsx` | נוסף | לא נבדק כאן |

## 6. 93 הבדיקות העצמיות (§22) ב־V7

[`REGRESSION_BASELINE.md`](REGRESSION_BASELINE.md) קבע שהן יעברו ל־Vitest בשמן העברי. בפועל:

| קבוצה (מספר) | הבדיקות ב־V7 | הערה |
|---|---|---|
| אופסטים (4) | `tests/unit/core/text/offsets.test.ts` ("אופסטים גלוי↔גולמי (legacy §10)") | נוידו בשמות זהים |
| גימטריה (3) | `tests/unit/core/text/gematria.test.ts` | נוידו |
| `Util.Heb` (13) | `tests/unit/matching/similarity.test.ts` ("השוואת טקסט עברי (legacy §10)") | נוידו, 13 מתוך 13 |
| התאמה מבנית (3) | `tests/unit/linking/headings/engine.test.ts` | חלקי: המנוע הוחלף |
| כותרות ועוגן (3) | `tests/unit/core/text/html.test.ts` ("כותרות ועוגן (legacy §10)") | נוידו |
| ייצוא רגיל (4) | `links-json.test.ts`; `tests/contracts/links-json.contract.test.ts` | מכוסה, בשמות אנגליים |
| טווחים בייצוא (9) | `links-json.test.ts`; `export.test.ts`; `field-route-matrix.test.ts` | חלקי. "סיום טווח על כותרת מושמט" השתנה: אזהרה, והטווח נכתב |
| עוגן בייצוא (3) | `offsets.test.ts`; `html.test.ts`; `export.test.ts` | מכוסה |
| דילוג כותרות (1) | `validate.test.ts` "legacy: קישור משורת כותרת מדולג" | נוידה |
| הצעת סיום והשלמה (5) | `tests/unit/linking/ranges.test.ts`; `tests/integration/state/ranges.test.ts` | מכוסה |
| סיווג (3) | `connection-type-groups.test.ts` | חלקי: "שמונה סוגי מפרש בדיוק" לא נוידה (יש תשעה) |
| ref_1/ref_2 (7) | `validate.test.ts` ("… (legacy §10 ref_1/ref_2)"); `sefaria-ref.test.ts` | חלקי: "מלכודת הגרשיים: רשי" לא נמצאה בשמה |
| `alt_toc` (1) | `alt-toc.test.ts` "version 3's regression case: …" | נוידה |
| תוכן עניינים ו־heRef (2) | `sefaria-csv.test.ts`; `headings/engine.test.ts` | חלקי |
| נסיגות (25) | `offsets`, `gematria`, `similarity` ("נסיגה: …"); `validate.test.ts`; `links-json.test.ts`; `ranges.test.ts`; `history.test.ts` | חלקי. **לא נוידו:** edit שיוצר כפילות נדחה, restore חסום (ההתנהגות הוסרה, §3.1), "אופסט כמחרוזת", הסרת ספר ושחזורו |
| סביבה וממשק (7) | `offline-single-file.spec.ts`, `helpers.ts` (`watchPage`), `scripts/package-release.mjs`; `accessibility.spec.ts` | חלקי. בלי מקבילה: "אין `<select>` מובנה" (סותר), רקע ליומן, גובה הטורים, "כל האייקונים ב־sprite" |

</div>
