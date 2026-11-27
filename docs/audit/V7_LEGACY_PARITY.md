<div dir="rtl">

# V7 — שוויון יכולות מול גרסה 3

הבדיקה של מפרט V7 §4.14: כל יכולת של גרסה 3 שב־[`FEATURE_INVENTORY.md`](FEATURE_INVENTORY.md) (‏F-001 עד F-142, קיצורי
המקלדת ב־§16 ו־93 הבדיקות העצמיות ב־§22), מול הקוד של V7. לכל יכולת: איפה היא בגרסה 3, איפה היא ב־V7, מה קרה לה,
איזו בדיקה מגינה עליה, מאיזה מסך מגיעים אליה ומה המגבלה.

התאריך: 2026-11-26, ועדכון בסבב 2 ב־2026-11-27 על `v7/04-validation-release-readiness`. הקוד של גרסה 3 הוא
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

### 3.1 מה שהוסר או נחלש, ומה קרה לו בסבב 2

בסבב 1 נמצאו כאן 18 יכולות שהוסרו או נחלשו בלי הצדקה כתובה. בסבב 2 (אחרי הסקירה של הבעלים) כל אחת קיבלה החלטה:
שוחזרה, הוחלפה במנגנון שעונה על אותו צורך, או נשארה עם הצדקה כתובה. לכל אחת יש בדיקה. הפירוט בטבלאות של §4 ו־§5.

**שוחזרו:**

| מזהה | מה חזר | PR |
|---|---|---|
| F-070, F-072, F-086 | אי אפשר ליצור, לערוך או לשחזר קישור **זהה** לקישור קיים. כך גם ביצירה מכמה שורות וב"שמירה כקישור נוסף". קישור אחר בין אותן שתי שורות מותר | 1, 3 |
| F-087 | קישור משורה לאותה שורה הוא שגיאה | 1 |
| F-016 | קובץ טקסט, תיקייה או ZIP שנבחרו שוב לא נפתחים פעם שנייה | 1 | |  | undefined ספר בתוך ZIP מזוהה לפי כל הבתים שלו, ולכן מהדורה אחרת באותו גודל נפתחת (סקירת סבב 2).
| F-046, F-061 | בחירת שורות לא רצופות עם Ctrl/Cmd, וקישור מכל שורה בפעולה אחת | 3 |
| F-054, F-055 | "עד שורה" בהקלדה, "עד סוף הספר", והצעת סוף אוטומטית (הגדרה לכל צד) | 3 |
| F-079, F-083 | בבונה: איפה "עד הבא" נעצר, והאם לקצר את הטווח הקודם | 3 |
| F-095, F-097 | מנוע הכותרות: התאמה לפי תוכן הכותרת, לפי תתי־סעיפים, ופסקאות כסעיפים | 2 |
| F-102, F-104 | יעדים שהופנו פעמיים ויעדים שלא הופנו; טווח "עד ההתאמה הבאה" | 2, 3 |
| F-028, F-035 | איפוס מלא בלי אובדן עבודה; הסרת ספר אחד, עם ביטול | 3 |
| F-009, F-012 | הודעה ממוקדת על מסד לא נכון, ועל קובץ שלא נקרא | 3 |
| F-129, F-133, F-134 | הגדרות של גרסה 3 עוברות; צפיפות בארבע רמות; פחות תנועה, והדפסה | 3 |
| F-137, F-139 | יומן האבחון בתוך הכלי; חיפוש כותרת בכל הספרים | 3 |
| §16 | Ctrl+E; ‏PgUp/PgDn/Home/End; Esc מבטל עריכה | 3 |

**הוחלפו במנגנון אחר:**

| מזהה | במקום | למה זה עונה על הצורך |
|---|---|---|
| F-075 | הדיאלוג "סמן" ← שדה "תווית העוגן" בבונה | אותה תווית, באותו מקום ב־heRef_2. בלי חלון נוסף, ועם בדיקה שהגנרטור יקרא אותה |
| F-055 | בורר "מבנה טווח" ← הגדרה לכל צד | ב־V7 המבנה נגזר מהבחירה, ולכן אין בורר. ההגדרה לכל צד נותנת את אותה התנהגות |

**מגבלות מוצדקות:**

| מזהה | מה נשאר | ההצדקה |
|---|---|---|
| F-079, F-083 בהשלמת טווחים | ההשלמה נשארת "אוטומטית", והקיצור פעיל בה תמיד | בסיס אחר יוצר טווח שעובר כותרת של פרק, או טווחים חופפים (C15). בבונה שתי ההגדרות חזרו |
| F-136 | תגי `<select>` מובנים | רכיב מובנה נגיש במקלדת ובקורא מסך בלי קוד נוסף. הבדיקה העצמית של גרסה 3 נגעה ברכיב משלה |
| F-129 | רק שלוש הגדרות עוברות | ל־13 ההגדרות האחרות של גרסה 3 אין מקבילה ב־V7 |

**מגבלות שנשארו:**
- **F-134:** ההדפסה מינימלית: הטקסטים, בלי הממשק. כמו בגרסה 3.
- **F-095, F-097:** האופנים החדשים של מנוע הכותרות לא נמדדו על ספרים אמיתיים.
- **F-137:** אין ניקוי יומן ואין מתג DEBUG.
- **F-102:** בסקירת ההצעות, רק אחרי הרצת זוג של דיבור המתחיל או של כותרות.

### 3.2 יכולות "חובה" שאין להן בדיקה

**נוספה בדיקה בסבב 2:**
- Shift+לחיצה (F-046): `builder-selection.spec.ts`.
- החזרת הסטטוס `existing` אחרי ביטול של קיצור טווח (F-083): `ranges.test.ts`.
- התאמה גמישה לכתיב (F-096): `modes.test.ts`.

**עדיין בלי בדיקה:**
- לכידת עוגן מהמסך (`anchorFromSelection`, F-074, F-077).
- תצוגת הטווח בקורא (F-041).
- העריכה בבונה כזרימה מלאה (F-071).
- "החלפה" ו"ניקוי" (F-051, F-052).
- דוח הייבוא שהמשתמש רואה (F-018, F-026).
- סוג ריק שנשמר כ־`OTHER` (F-022).
- הקודים `export/range-ignored`, ‏`heading/similar-name` ו־`sefaria/both-sides`.
- מחיקה של מבנה `alt_toc`.

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
| F-009 | אבחון "מסד לא נכון" | `diagnoseWrongDb` 2445 | `src/core/db-guess.ts` `noBooksSummary`, `WRONG_DBS`; אשף המיפוי | שוחזר (סבב 2): מסד נתוני משתמש, מסד ניתוח נוסחים ומסד אינדקס מזוהים, וההודעה מפנה ל־seforim.db | `tests/unit/core/db-mapping.test.ts` "a database that is not the books database says which one it is" | אשף המיפוי, "לא נמצאו ספרים" | — |
| F-010 | זיהוי גמיש של שמות עמודות | `DbBookRepository` 2482 | `src/database/otzaria/capabilities.ts`; `db-guess.ts` + `DbMappingDialog` | הוחלף: מסד שאינו בסכמה נפתח באשף מיפוי | `tests/unit/core/db-mapping.test.ts` "two tables: …"; `tests/integration/database/wizard-structures.test.ts` | אשף המיפוי | — |
| F-011 | שבב "ספריא" לפי טבלת `source` | 2496–2518 | `DbBookSource.originOf` | נשמר עם שינוי: מסד אישי תמיד "personal" (AGENTS §3) | `tests/integration/sources/db-source.test.ts` "books carry origin and base-book flag" | "ספריא" בשורת הספר | — |
| F-012 | הודעה על קובץ נעול או בענן | `Util.readArrayBuffer` 2061 | `src/sources/read-failure.ts`; `registry.open`; `TextFilesSource.load` | שוחזר ושופר (סבב 2): הקובץ מדולג עם הסיבה בעברית (אוצריא נועלת אותו, הוא בענן, או השתנה), ושאר הקבצים נפתחים | `tests/integration/sources/registry.test.ts` "a file the browser cannot read says why it may be" | "N קבצים לא נפתחו" | — |
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
| F-028 | "איפוס מלא" | 7123 | — | **הוסר** גם עם שמירה, העבודה נשמרת בצד, כי הכלי לא יודע אם ההורדה הצליחה (סקירת סבב 2). | אין | לא נגיש | §3.1 |
| F-029 | אין ייבוא `alt_toc` | — | `detectKind`; `AltTocState.importFile` | שופר (TD-M7) | `tests/integration/state/alt-toc-export.test.ts` "an imported _alt_toc.json becomes the book's structures …" | גרירה | — |
| F-030 | רשימה וירטואלית | `rowHeight` 4491 | `src/ui/workspace/book-picker.tsx` `BookList` (`LIMIT=200`) | הוחלף: עד 200 לכל מקור, ואז חיפוש | חלקי: `tests/e2e/touch-targets.spec.ts` | "קבצים ומסדים" | מעבר ל־200 רק בחיפוש |
| F-031 | חיפוש תת־מחרוזת | `filterBooks` 4496 | `useBookSearch` | שופר: מתעלם מניקוד וגרשיים, מדרג | חלקי: `tests/e2e/maxlink.spec.ts` | "חיפוש ספר…" | — |
| F-032 | שבבי סינון | 1186; 4499 | `BookList`, קבוצה לכל מקור | הוחלף | `multi-source.spec.ts` (אותו מבחן) | כותרות הקבוצות | אין סינון לפי סוג |
| F-033 | תגיות ספר | `bookTag` 4505 | `SourceBadge`; `side-btn[aria-pressed]` | שונה: התג על הקבוצה | `multi-source.spec.ts` | רשימת הספרים | — |
| F-034 | מתג "פתיחה אל: מקור/יעד" | `setLoadInto` 4565 | `BookList.row`, כפתור לכל צד | הוחלף | `multi-source.spec.ts` | "מקור"/"יעד" בשורה | — |
| F-035 | הסרת ספר יחיד, עם ביטול | `removeBookAsked` 5293 | רק `AppStore.closeSource` | **הוסר** ריצת ההצעות שנוגעת בספר נסגרת, ו"ביטול" לא מחזיר אותה. אי אפשר לאשר הצעה לספר שאינו פתוח (סקירת סבב 2). | `tests/integration/state/export-completeness.test.ts` "close the database and open it again: …" (לסגירת מקור) | ✕ "סגירת <מקור>" | §3.1 |
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
| F-046 | בחירת שורות | `onLineClick` 4753 | `BookView.onClick` → `store.pickLine`, `store.toggleLine` | שוחזר (סבב 2): Ctrl/Cmd+לחיצה מוסיפה שורה או מסירה אותה; Ctrl+חץ ו־Ctrl+רווח מהמקלדת | `tests/integration/state/builder-selection.test.ts`; `tests/e2e/builder-selection.spec.ts` (גם Shift) | לחיצה, Shift+לחיצה, Ctrl+לחיצה | עד 200 שורות. בזמן עריכה Ctrl בוחר שורה אחת |
| F-047 | לחיצה עם סימון טקסט אינה בחירה | 7205 | `BookView.onClick` | נשמר | **אין** | הקורא | — |
| F-048 | ניווט מקלדת | `moveLineCursor` 4807 | `BookView.onKey` | שוחזר (סבב 2): ↑↓, ‏PgUp/PgDn, ‏Home/End, עם Shift לטווח | `builder-selection.spec.ts`; `accessibility.spec.ts` "keyboard only: …" | אזור השורות | — |
| F-049 | שורת מקור קובעת `activeLine` | 4791 | `builder.tsx` `PickedLineLinks`; `db-links-panel.tsx` | הוחלף | `db-links-state.test.ts` "the picked line: …" | הבונה, "קישורים מהמסד" | — |
| F-050 | תוכן עניינים | `Dialogs.toc` 5611 | `reader.tsx` `HeadingJump` | שונה: רשימה שטוחה, 200 תוצאות | `manual-editor.spec.ts` "… jump to a heading and to a line, …" | "מעבר לכותרת" | אין קיפול |
| F-051 | החלפת מקור ⇄ יעד | `swapSides` 4591 | `builder.tsx` `swap` | שונה | **אין** | "החלפה" | לפי קריאת הקוד, ref שהוקלד נשאר בטיוטה (לא הורץ) |
| F-052 | הצגת מקור ויעד, "ניקוי" | `renderBuilder` 4950 | `builder.tsx` `End`; `store.clearPicks` | נשמר | חלקי: `tests/integration/state/worker-restart.test.ts` | "ניקוי" | הכפתור לא נבדק |
| F-053 | בורר מבנה (5 מבנים) | `setKind` 5130 | נגזר מהבחירה | הוחלף ([ADR 0005](../adr/0005-ui-decisions.md) #3) | אין | — | — |
| F-054 | "עד שורה", "עד הבא", "עד הסוף" | `rangeRow` 5050 | `builder.tsx` `RangeButtons`; `store.setRangeEnd`, `store.rangeToEnd` | שוחזר (סבב 2): "עד שורה" (הקלדה), "טווח עד הקישור הבא", "עד סוף הספר", "בלי טווח" | `builder-selection.test.ts`; `builder-selection.spec.ts` | הבונה | — |
| F-055 | `effectiveEnd` | 4901 | `store.draft`; ההעדפה `rangeAutoEnd` | שוחזר בשינוי (סבב 2): הצעת סוף אוטומטית היא הגדרה לכל צד, כבויה בברירת המחדל. ב־V7 אין בורר "מבנה טווח" | `builder-selection.test.ts`; `tests/unit/state/preferences.test.ts` | "הגדרות טווחים" בבונה | — |
| F-056 | בורר סוג הקשר | 4996 | `builder.tsx`; `type-options.tsx` | שופר | `tests/e2e/manual-linking.spec.ts` "the link type picker is grouped into commentary types and link types" | "סוג הקשר" | — |
| F-057 | "מתקדם": heRef_2, ref_2, ref_1 | `advancedBlock` 5088 | `builder.tsx` | שונה: לפי סיווג ספריא | `manual-linking.spec.ts` "open → pick → create → undo/redo → export, offline" | "אפשרויות מתקדמות" | — |
| F-058 | משפט סיכום | `summarySentence` 4917 | `builder.tsx` `StoredAs` | הוחלף | `manual-linking.spec.ts` (`.stored-as`) | הבונה | לא מזכיר טווח או עוגן |
| F-059 | אזהרות מקדימות | 5018 | `store.draftProblems` | שופר | `store.test.ts` "a link to a heading line is refused, with the reason" | הבונה | — |
| F-060 | כפתור יצירה מושבת עם הסבר | `canCreate` 4942 | `Builder` | נשמר | חלקי: אותה בדיקה | "יצירת קישור", Ctrl+Enter | כשחסר צד, Ctrl+Enter שקט |
| F-061 | יצירה מרובה | `buildLinksFromSelection` 5173 | `store.drafts`; `createFromDraft` | שוחזר (סבב 2): קישור מכל שורה, בפקודה אחת ("יצירת N קישורים") עם ביטול אחד. שגיאה באחת חוסמת את כולן, וההודעה אומרת באיזו שורה. גם קישור זהה לקישור קיים חוסם שם המקום וציון ספריא נקבעים לכל שורה, והשדות של הצד עם כמה השורות כבויים (סקירת סבב 2). | `builder-selection.test.ts` "one link from each picked line …"; `identical-links.test.ts` "several picked lines …" | הבונה | כמה שורות בשני הצדדים נדחות, עם הסבר |
| F-062 | heRef אוטומטי | `computeHeRef` 3749 | `store.autoHeRef` | שונה: קודם heRef מהמסד | `store.test.ts` "open → pick → create → undo/redo → export"; `compat-edit.test.ts` "a cleared field and a blank database reference fall back to title and line" | "שם המקום ביעד" | שרשרת הכותרות לא נבדקת |
| F-063 | חסימה רק על שגיאות | 5195 | `store.createFromDraft` | נשמר | `store.test.ts` "a link to a heading line is refused, with the reason" | הבונה | — |
| F-064 | קיצור הטווח הקודם | `trimPrevious` 3299 | `store.trimAround` → `RangesState.trimFor` | שופר: באותו צעד ביטול, עם הודעה | `ranges.test.ts` "a new link inside another link's range cuts that range — in the same undo step" | אוטומטי | — |
| F-065 | אחרי היצירה | 5217 | `store.createFromDraft` | שונה: toast עם "ביטול" רק במצב "לחיצה ולחיצה" | `store.test.ts`; `manual-linking.spec.ts` | הבונה | — |
| F-066 | לשוניות מפרשים / קישורים | `renderLinkPanel` 5237 | `links-panel.tsx` `LinksPanel` | הוחלף | חלקי: `manual-linking.spec.ts` | "קישורים" | — |
| F-067 | פריט ברשימה | `linkItem` 5264 | `link-item.tsx` `LinkItem` | שונה | חלקי: `tests/e2e/db-links.spec.ts` | "קישורים" | עוגן ו־ref_2 רק ב־tooltip |
| F-068 | מעבר לשורת היעד | 5281 | `store.revealLink` | שופר: שני הצדדים | `store.test.ts` "showing a link keeps both its lines marked in the readers; …" | לחיצה על פריט | — |
| F-069 | מחיקה עם אישור | `UI.deleteLink` 5315 | `store.deleteLinks` | שונה: בלי אישור, עם "ביטול" (#42 C31) | `tests/integration/state/hebrew-counts.test.ts` "says what was deleted, with an undo action that brings it back" | "מחיקה" | — |
| F-070 | שחזור נחסם כשנוצר קישור זהה | `restore` 3120 | `AppStore.restoreLinks` | שוחזר (סבב 2) | `tests/integration/state/identical-links.test.ts` "restore: …" | "שחזור" | — |
| F-071 | דיאלוג עריכה | `Dialogs.editLink` 5395 | `store.editInBuilder` + `Builder` | הוחלף: עריכה בבונה | חלקי: `matched-words-persist.test.ts` | "עריכה בבונה" | אין הקלדת מספרים; אין E2E |
| F-072 | שמירת עריכה | 5495 | `createFromDraft` (ענף `editing`); `builder/identical` | שוחזר (סבב 2): עריכה לקישור זהה נחסמת, וגם "שמירה כקישור נוסף" | `identical-links.test.ts` "edit: …", "a copy saved as another link …" | "שמירת השינויים" | — |
| F-073 | "בחירה מחדש מהמסך" | 5466 | `pickLine` בזמן `editing`; Esc ב־`app.tsx` | הוחלף; Esc מבטל עריכה (סבב 2) | `compat-edit.test.ts` "moving the source line drops ref_1, …"; `builder-selection.spec.ts` | לחיצה בקורא, Esc | — |
| F-074 | לכידת עוגן | `captureAnchor` 4865 | `anchor-selection.ts` `anchorFromSelection` | שונה: לפי ה־DOM המחוטא | **אין** (רק `sanitize.test.ts` כתנאי מקדים) | סימון מילים | §3.2 |
| F-075 | דיאלוג "סמן" | `anchorLabel` 5544 | `store.pickAnchor` | שונה: הדיאלוג הוסר | אין | הבונה | §3.1 |
| F-076 | אופסט גלוי → גולמי | `rawOffsetFromVisible` 2124 | `src/core/text/offsets.ts` | שונה ומוצדק (AGENTS §2.4) | `tests/unit/core/text/offsets.test.ts` 'אופסט גלוי→גולמי: "אב <b>ג</b> דה" 3..5 → 6..12' | פנימי | — |
| F-077 | עוגן דורש שורה אחת | 4946 | מבני | נשמר מבנית | אין | — | `editInBuilder` טוען עוגן וטווח יחד |

### 4.3 טווחים, מודל, ספריא, קישור אוטומטי, `alt_toc` (F-078–F-111)

| # | יכולת | V3 | V7 | מצב | בדיקת רגרסיה | נגיש למשתמש | מגבלה |
|---|---|---|---|---|---|---|---|
| F-078 | רק שורת הסיום נשמרת | `LinkService.build` 3031 | `src/core/links/model.ts` `LinkSide.end`; `convert.ts` | נשמר (AGENTS §3) | `links-json.test.ts` "a reversed or degenerate range is dropped with a warning (generator ignores it)" | הבונה | — |
| F-079 | סמנים לפי `rangeEndBasis` | `Ranges.markers` 3242 | `src/linking/ranges.ts` `rangeMarkers`; ההעדפה `rangeEndBasis` | שוחזר בבונה (סבב 2): "עוצר לפני": קישור או כותרת, קישור, כותרת, סוף הספר. **השלמת הטווחים נשארת "אוטומטית" בכוונה** | `builder-selection.test.ts`; `ranges.test.ts` "never crosses a chapter", ו־property "no overlap" | "הגדרות טווחים" בבונה | מגבלה מוצדקת: בהשלמה, בסיס אחר יוצר טווח שעובר כותרת של פרק, או טווחים חופפים (C15) |
| F-080 | `suggestEnd` | 3260 | `src/linking/ranges.ts` `suggestEnd` | שופר: נסוג מכותרת | unit "an end on a heading line steps back (Otzaria drops a range that ends on a heading)" | "טווח עד הקישור הבא" | — |
| F-081 | `validateSide` | 3269 | `validate.ts` `sideChecks` | שונה: מחוץ לספר = שגיאה ([POLICY_TO_CODES](POLICY_TO_CODES.md)) | `validate.test.ts` "policy: a range that ends past the book is an error; …" | בונה, בקרה, ייצוא | `export/range-ignored` בלי בדיקה |
| F-082 | `isEffective` | 3287 | `isRange` + `convert.ts` | שונה: סוף על כותרת נכתב עם אזהרה | `tests/unit/formats/link-range-end-bounds.test.ts` "is refused at import with a warning, …" | פנימי | — |
| F-083 | `trimPrevious` | 3299 | `trimBefore`; `RangesState.trimFor`; ההעדפה `rangeTrimPrevious` | שוחזר בבונה (סבב 2): המתג "קיצור הטווח הקודם", דולק בברירת המחדל. בהשלמת טווחים הקיצור פעיל תמיד | `builder-selection.test.ts`; `ranges.test.ts` "a cut imported link is 'edited'; undoing the cut makes it 'existing' again" | "הגדרות טווחים" בבונה | — |
| F-084 | `autoFillBook` | 3321 | `fillRanges`; `RangesState.fill` | שונה (review C15): גם כותרת עוצרת | unit "a book with no known length (a shadow book from a links file) is never touched"; integration "range completion of a book: one step, undoable, …" | "השלמת טווחים" | — |
| F-085 | `revert`/`reapply` | 3358 | `src/state/history.ts` | הוחלף: היסטוריה אחידה | `history.test.ts` "property: undoing every step of any sequence returns to the start" | Ctrl+Z | — |
| F-086 | מפתח ייחודיות ו־`dedup` | `dedupKey` 3021 | `identicalLinkKey` ב־`src/core/links/equality.ts`: כלל אחד ל־`export/duplicate`, למחיקת הכפולים ולבונה | שוחזר (סבב 2): קישור זהה נחסם ביצירה. קישור אחר בין אותן שורות מותר, עם הערה (`builder/same-lines`) | `identical-links.test.ts`; `validate.test.ts` "links that collapse into one stored link are flagged as duplicates" | בונה, בקרה, ייצוא | כפילויות בנתונים מיובאים נשארות ומסומנות, כדי שקובץ שלא נגעו בו ייצא זהה |
| F-087 | `validate` | 3045 | `validateLink`; `draftProblems` | שונה: קישור לכותרת חוסם. אין בדיקת "אותה שורה" | `validate.test.ts` "legacy: קישור משורת כותרת מדולג"; "legacy: שורה מחוץ לתחום נחסמת בייצוא" | בונה | §3.1 |
| F-088 | `checkIntegrity` | 3179 | — | הוסר: אין מפת dedup | חלקי: `history.test.ts` (property) | פנימי | — |
| F-089 | סיווג מפרש | `isDependent` 3222 | `connection-type.ts` `APP_DEPENDENT_TYPES`, `appPanelOf` | שופר: 9 סוגים, לפי האפליקציה | `tests/unit/core/connection-type-groups.test.ts` "agrees with where Otzaria shows a stored link (appPanelOf)" | בורר הסוג | — |
| F-090 | `typeLabel` | 3223 | `TYPE_LABELS`, `typeShown` | הוחלף (TD-H3) | חלקי: "every type has a Hebrew name and a short description" | רשימת הקישורים | — |
| F-091 | זיהוי ספר ספריא | 2978 | `sefaria-titles.ts` `isSefariaOwned` | שונה (B6): לפי רשימת כותרות | `tests/unit/core/sefaria-ref.test.ts` "the embedded snapshot classifies by exact title" | פנימי | — |
| F-092 | קודי `checkLink` | 2984 | `validate.ts` `sefariaChecks` | שופר | `validate.test.ts` "legacy: ref_1 ו-ref_2 יחד → שגיאה ; …"; `tests/contracts/field-route-matrix.test.ts` | בונה, בקרה, ייצוא | `sefaria/both-sides` בלי בדיקה |
| F-093 | בדיקות ספריא תמיד בייצוא | 3604 | `validateExport` | שונה: חוסמות בשליחה לספרייה | `validate.test.ts` "legacy: רשומה שיובאה בלי ref_2 — …"; `sefaria-refs.test.ts` | חלון הייצוא | — |
| F-094 | דיאלוג אוטומטי, 4 לשוניות | `Dialogs.auto` 5732 | `suggestions-panel.tsx`; `src/linking/automatic/index.ts` | הוחלף: לשונית "הצעות", הצעות לאישור | `tests/e2e/automatic-linking.spec.ts` "headings engine: run in the worker → table → approve all certain → card view → undo" | "הצעות" | — |
| F-095 | לפי כותרות, 3 מצבים | `buildStruct` 5999 | `src/linking/automatic/headings/`: האפשרות `headingMatch` | שוחזר (סבב 2): מבנה (ברירת המחדל), **תוכן הכותרת**, **תתי־סעיפים**. אפשרויות של אותו מנוע | `tests/unit/linking/headings/modes.test.ts` | "הגדרות השיטה" ← "אופן ההתאמה" | האופנים החדשים לא נמדדו על ספרים אמיתיים |
| F-096 | התאמה גמישה לכתיב | 3824 | `headings/align.ts` `compat` | נשמר: לשמות, סף 0.85 | `modes.test.ts` "flexible spelling of headings (v3 F-096)" (סבב 2) | פנימי | — |
| F-097 | "פסקאות כסעיפים" | `trySplit` 3862 | `paragraphsAsSections` | שוחזר (סבב 2): כשמספר השורות תחת כותרת שווה למספר הסעיפים בבסיס. "אפשרית" לכל היותר | `modes.test.ts` | "פסקאות רגילות כסעיפים" | — |
| F-098 | אבחון "אין מקבילה" | 3896 | `headings/index.ts` `unmatched` | הוחלף | `headings/engine.test.ts` "a chapter missing in the base is unmatched with a reason" | "בלי התאמה" | — |
| F-099 | לפי תגיות | `buildTag` 6055 | `pattern/engine.ts` `tagFinder` | שונה: חלק מ"לפי תבנית", הסוג `reference` | `tests/unit/linking/pattern/engine.test.ts` "the content of <sup> is the number; …" | "לפי תבנית" | — |
| F-100 | לפי Regex | `buildRegex` 6102 | `pattern/engine.ts`; `template.ts` | שופר (TD-H4), שומר ReDoS | `engine.test.ts` "the match on the visible text maps back to the raw span …"; `tests/e2e/pattern-and-ranges.spec.ts` | "התבנית" | — |
| F-101 | קובץ הערות לפי פרקים | `resolveTargets` 5970 | `pattern/engine.ts` (`chapter-line`) | נשמר ושופר | `engine.test.ts` "a number that does not grow moves to the next chapter; …" | "לאן ההפניה מצביעה" | — |
| F-102 | אבחון התבנית | `diagnose` 5958 | `pattern/engine.ts` (`pattern/shared-targets`, `pattern/unreferenced-targets`); `SuggestionsState.unreferencedTargets` | שוחזר (סבב 2): היעדים שהופנו פעמיים, והיעדים שלא הופנו. גם בסקירת ההצעות אחרי ד"ה או כותרות | `tests/unit/linking/pattern/engine.test.ts`; `tests/integration/state/unreferenced-targets.test.ts`; `v3-parity.spec.ts` "the target lines no suggestion points at …" | הערות הריצה, סקירת ההצעות | בתבנית: רק ביעד "מספר שורה". בסקירה: רק בזוג של ד"ה או כותרות |
| F-103 | דרגות ודאות, 300 שורות | `renderMatches` 5798 | `types.ts` `DEFAULT_THRESHOLDS`; `bulk-approve.tsx` | שופר | `store.test.ts` "run → approve all certain (one undo step) → …"; `tests/integration/state/bulk-approve.test.ts` | "אישור כל הוודאיות" | — |
| F-104 | `runMatches` | 5906 | `linking/ranges.ts` `applyRunRanges`; `sourceRange`, `targetRange` | שוחזר (סבב 2): טווח מקור ויעד בכל מנוע זוג: לפי המנוע, שורה אחת, או **עד ההתאמה הבאה** | `tests/unit/linking/run-ranges.test.ts` | "טווח בספר המקשר", "טווח בספר שאליו מקשרים" | מחושב לפי כל ההצעות של ההרצה, לא לפי הסימון. לא במראי מקומות, שיש להם אפשרות משלהם |
| F-105 | השלמת טווחים | `buildRanges` 6156 | `links-panel.tsx`; `RangesState.fill`, `RangesState.planFill` | שופר (סבב 2): תצוגה מקדימה, ואז צעד אחד שאפשר לבטל | `pattern-and-ranges.spec.ts`; `tests/integration/state/ranges.test.ts` "range completion has a preview" | "השלמת טווחים" | — |
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
| F-131 | דיאלוג הגדרות | 6525 | תפריט "הגדרות"; `resetPreferences` | הוחלף, ונוסף איפוס (סבב 2). האיפוס מחזיר גם את הגדרות הטווח | `preferences.test.ts` "reset …", "resetting the settings covers the range settings too"; `v3-parity.spec.ts` | הגדרות ← "איפוס ההגדרות לברירת המחדל" | — |
| F-132 | ערכת נושא | 6986 | `src/ui/theme/theme.ts` | שונה: הבחירה בתפריט | חלקי: `manual-linking.spec.ts` "dark theme and narrow screen keep the workspace usable" | "ערכת צבעים" | — |
| F-133 | צפיפות | CSS 136 | `prefs.density` ← `data-density` ב־`main.tsx` | שוחזר (סבב 2): ארבע רמות | `preferences.test.ts` "density …"; `v3-parity.spec.ts` "density in four levels" | הגדרות ← "צפיפות שורות הספר" | — |
| F-134 | רספונסיביות, מגע, reduced-motion, print | CSS 853 | `fitLayoutToWidth`; `app.css` | שוחזר (סבב 2): `prefers-reduced-motion` ו־`@media print` | `layout.spec.ts`; `touch-targets.spec.ts`; `v3-parity.spec.ts` "no motion …" | אוטומטי | ההדפסה מינימלית: הטקסטים, בלי הממשק |
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
| Ctrl+E | ייצוא | `app.tsx` | שוחזר (סבב 2) | `builder-selection.spec.ts` |
| Ctrl+H | היסטוריה | `app.tsx` | נשמר | `history-list.spec.ts` |
| F1 | עזרה | `app.tsx` | נשמר | `help.spec.ts` |
| Esc (שרשרת) | תפריט ← דיאלוג ← יומן ← ביטול "בחירה מחדש" | `menu.tsx`, `<dialog>`, `book-find.tsx`, `app.tsx` | שוחזר (סבב 2): היומן הוא דיאלוג, ו־Esc מבטל עריכה בבונה | `accessibility.spec.ts`; `builder-selection.spec.ts`; `v3-parity.spec.ts` |
| ↑↓ PgUp PgDn Home End | ניווט ובחירה | `reader.tsx` `onKey` | שוחזר (סבב 2), ונוספו Ctrl+חץ ו־Ctrl+רווח | `builder-selection.spec.ts` |
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
| נסיגות (25) | `offsets`, `gematria`, `similarity` ("נסיגה: …"); `validate.test.ts`; `links-json.test.ts`; `ranges.test.ts`; `history.test.ts` | חלקי. בסבב 2 חזרו ההתנהגויות ונבדקו: edit שיוצר כפילות נדחה, restore חסום (`identical-links.test.ts`), הסרת ספר ושחזורו (`remove-book.test.ts`). **לא נוידה:** "אופסט כמחרוזת" |
| סביבה וממשק (7) | `offline-single-file.spec.ts`, `helpers.ts` (`watchPage`), `scripts/package-release.mjs`; `accessibility.spec.ts` | חלקי. בלי מקבילה: "אין `<select>` מובנה" (סותר), רקע ליומן, גובה הטורים, "כל האייקונים ב־sprite" |

</div>
