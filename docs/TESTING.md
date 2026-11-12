<div dir="rtl">

# בדיקות

הכלים וההחלטות: [ADR 0004](adr/0004-testing-stack.md). הבסיס מגרסה 3: [`audit/REGRESSION_BASELINE.md`](audit/REGRESSION_BASELINE.md).

## 1. סוגי הבדיקות

| סוג | איפה | כלי | רץ ב־`npm test` |
|---|---|---|---|
| יחידה | `tests/unit/` | Vitest (Node) | כן |
| אינטגרציה | `tests/integration/` | Vitest | כן, חוץ מ־`*.local.test.ts` בלי `OTZARIA_DB` |
| חוזה | `tests/contracts/` | Vitest, על רשומות אמיתיות מהספרייה | כן |
| Property | בתוך בדיקות Vitest | fast-check | כן |
| ארכיטקטורה | `tests/unit/architecture.test.ts` | Vitest, סריקת `import` | כן |
| E2E | `tests/e2e/` | Playwright, Chrome ו־Edge המותקנים | לא: `npx playwright test` |
| בסיס רגרסיה של v3 | `tests/e2e/legacy-baseline.spec.ts` | Playwright | לא: `npm run test:legacy` |
| מול מסד אמיתי | `tests/integration/**/real-db.local.test.ts` | Vitest | רק עם `OTZARIA_DB` |

## 2. הרצה

```
npm test                                            # unit + integration + contracts
npx vitest run tests/unit/core/text/offsets.test.ts # קובץ אחד
npx vitest run tests/unit/linking                   # תיקייה
npm run test:watch                                  # מצב צפייה
npm run build && npx playwright test                # E2E על הקובץ הבנוי
npx playwright test tests/e2e/qa.spec.ts --project=chrome
npm run test:e2e                                    # build + E2E
npm run test:legacy                                 # 93 הבדיקות העצמיות של v3
npm run check                                       # typecheck + npm test + E2E
```

**E2E רץ על התוצר, לא על שרת הפיתוח.** `playwright.config.ts` פותח את `dist/OtzariaLinker.html`
מ־`file://`, עם `offline: true` ו־`locale: "he-IL"`, ב־Chrome וב־Edge (`channel`), בלי להוריד דפדפנים.
לכן אחרי שינוי בקוד צריך `npm run build` לפני `npx playwright test`. המטריצה: Chrome ו־Edge (המותקנים במחשב) ו־Firefox (של Playwright: `npx playwright install firefox`).

כל בדיקת E2E משתמשת ב־`watchPage` (`tests/e2e/helpers.ts`) ונכשלת על **כל** בקשה שאינה `file:`, `data:`
או `blob:`, ועל כל שגיאה לא מטופלת בדף.

| קובץ E2E | מה הוא בודק |
|---|---|
| `offline-single-file.spec.ts` | הקובץ עולה אופליין, וה־Worker מריץ sql.js ו־zstd תחת ה־CSP |
| `manual-linking.spec.ts` | פתיחת מסד וקובץ, בחירה, יצירה, undo/redo, ייצוא; ערכה כהה ומסך צר |
| `automatic-linking.spec.ts` | מנוע הכותרות ב־Worker, טבלה, "אישור כל הוודאיות", כרטיס, undo |
| `engines.spec.ts` | מנוע ההערות על זוג טקסטים, מנוע הד"ה על רש"י ובראשית מהמסד האמיתי החלקי, וקישור באצווה |
| `robustness.spec.ts` | מסד עם מעגל בעץ העמודים נדחה עם הודעה, והקובץ הבא עדיין נפתח |
| `qa.spec.ts` | הבדיקה מוצאת כפול וקישור לכותרת; התיקון הקבוצתי מוחק רק את ההעתק |
| `db-links.spec.ts` | קישורי המסד של ספר: סיכום, סינון לפי ספר ולפי סוג, העתקה לפרויקט, וייצוא שמוחזק עד אישור (כלל ההחלפה) |
| `legacy-baseline.spec.ts` | 93/93 הבדיקות העצמיות של `legacy/OtzariaLinker-v3.html` |

## 3. Property tests

fast-check משמש איפה שיש אינווריאנטה שקל לנסח ושקשה לכסות בדוגמאות:

| קובץ | מה נבדק |
|---|---|
| `tests/unit/core/text/offsets.test.ts` | כל אופסט שמיוצא חוזר לאינדקס הגלוי שהתכוונו אליו |
| `tests/unit/core/text/sanitize.test.ts` | ה־HTML המסונן מכיל בדיוק את התווים הגלויים של השורה הגולמית |
| `tests/unit/state/history.test.ts` | undo מחזיר כל תמונת מצב |
| `tests/unit/core/text/gematria.test.ts`, `tests/unit/matching/hebrew-tokens.test.ts`, `tests/unit/linking/footnotes/markers.test.ts`, `tests/unit/linking/dibur-hamatchil/engine.test.ts` | גימטריה, טוקנים ואופסטים גולמיים, סימני הערות, המנוע |

## 4. בדיקות מקומיות מול מסד אמיתי

הקבצים שבטבלה רצים רק כשמשתנה הסביבה `OTZARIA_DB` מצביע על `seforim.db` (`describe.runIf`). המסד נפתח
לקריאה בלבד (`openSync(path, "r")`) ואף פעם לא נכתב. בלי המשתנה הם מדולגים, וב־CI הם לא רצים.

| קובץ | מה הוא מודד |
|---|---|
| `tests/integration/database/real-db.local.test.ts` | הקורא העצל ו־`OtzariaDbReader` מול המסד המלא |
| `tests/integration/linking/headings/real-db.local.test.ts` | מנוע הכותרות על 13 זוגות, מול הקישורים שבמסד |
| `tests/integration/linking/dibur-hamatchil/real-db.local.test.ts` | מנוע הד"ה על ספרים שלמים |
| `tests/integration/linking/footnotes/real-db.local.test.ts` | מנוע ההערות על מדרש ויסעו ועל 25 ספרים עם `line_note` |
| `tests/integration/database/db-links-real-db.local.test.ts` | רשימת קישורי המסד של בראשית, ברכות ומשנה ברורה, עם זמנים; ועם `OTZARIA_LIBRARY` גם השחזור של רשומות הספרייה מהמסד |

```bash
# bash
OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db npx vitest run tests/integration/linking/headings/real-db.local.test.ts
```

```powershell
# PowerShell
$env:OTZARIA_DB = "C:/ProgramData/otzaria/books/seforim.db"
npx vitest run tests/integration/linking/dibur-hamatchil/real-db.local.test.ts
```

`DH_REPORT=<קובץ>` עם בדיקת הד"ה כותב את כל ההחטאות לקובץ. הבדיקות מדפיסות precision, recall ועוגנים
מדויקים; התוצאות שנמדדו מסוכמות ב־[`AUTOMATION_ENGINE.md`](AUTOMATION_ENGINE.md). הריצה על ספרים שלמים
לוקחת דקות (ה־timeout של כל בדיקה עד 10 דקות).

## 4א. אימות מול נתונים אמיתיים (`npm run validate:real`)

שמונה בדיקות שמשוות את הכלי לנתונים האמיתיים שבמחשב: המסד העדכני של אוצריא, עותק git של ספריית
אוצריא ומסדים זרים. הן לא רצות ב־`npm test` (תצורה נפרדת, `vitest.validation.config.ts`), וכל אחת
מדולגת בלי משתני הסביבה שלה. הממצאים והמספרים: [`validation/REAL_DATA_REPORT.md`](validation/REAL_DATA_REPORT.md).

| משתנה | מה |
|---|---|
| `OTZARIA_DB` | `seforim.db` העדכני. נפתח לקריאה בלבד; כל בדיקה מוודאת בסוף שגודל הקובץ וזמן השינוי שלו לא השתנו |
| `OTZARIA_LIBRARY` | שכפול git של `Otzaria/otzaria-library`. הקבצים נקראים **כפי שהם ב־commit** (`git cat-file`), לא מהעותק העובד: עם `core.autocrlf=true` בעותק העובד יש CRLF בכל קובץ |
| `OTZARIA_EXTRA_DBS` | קבצים נוספים, מופרדים ב־`;` (מסדים זרים, מסדי האפליקציה, PDF) |
| `VALIDATION_OUT` | לא חובה: תיקייה שאליה כל בדיקה כותבת את תוצאותיה כ־JSON (מהן נבנה הדוח) |
| `PYTHON` | לא חובה: המפרש של האורקל (ברירת המחדל `py -3 -I` ב־Windows, `python3 -I` בשאר) |
| `VALIDATE_ENGINES` | לא חובה, בדיקה 5: רשימת מנועים (`headings,dibur-hamatchil`) |
| `VALIDATE_PAIRS_STRIDE` | לא חובה, בדיקה 5: מדגם **נפרד** של זוגות (למשל `104729`: 19 זוגות שאינם במדגם הראשי), לבדיקת כיוונון על זוגות שלא כוונן עליהם |

**האורקל** (`scripts/validation/db_oracle.py`) הוא קורא עצמאי: `sqlite3` של פייתון ו־libzstd (חבילת
`zstandard`), במצב `mode=ro`. הבדיקות משוות אליו את מה שהקורא העצל של הכלי מחזיר. הפלט שלו נכתב
לתיקייה זמנית ונמחק בסוף.

| קובץ | בדיקה |
|---|---|
| `tests/validation/db-reading.test.ts` | 1. כל הספרים (כותרת, מקור, `isBaseBook`, קטגוריה, מספר שורות); מדגם של ~320 ספרים: כל שורה (טקסט ו־heRef), `line_note`, הכותרות מול `tocEntry`, alt_toc, והקישורים בשני חלונות של 40 שורות |
| `tests/validation/anchors.test.ts` | 2. עוגני `link_anchor` מכל סוג מול מודל העוגנים; ועוגנים מקובצי הספרייה מול מה שנשמר |
| `tests/validation/library-links.test.ts` | 3. כל `_links.json` בספרייה: ייבוא וייצוא בית־בבית, פסקי הבדיקה, והשוואה למה שהגנרטור שמר בפועל |
| `tests/validation/library-texts.test.ts` | 4. ספרי ‎.txt מהספרייה מול אותם ספרים במסד |
| `tests/validation/engines.test.ts` | 5. המנועים מול הקישורים שכבר במסד (ומול רשומות ההערות של הספרייה). מנוע חדש = רשומה אחת ב־`engine-harness.ts` |
| `tests/validation/foreign-dbs.test.ts` | 6. מסדים זרים: מסד אוצריא, אשף המיפוי או סירוב מנומק; בלי כתיבה |
| `tests/validation/performance.test.ts` | 7. זמנים וזיכרון על המסד האמיתי |
| `tests/validation/browser/real-db.spec.ts` | 8. הקובץ הבנוי ב־Chrome פותח את המסד האמיתי דרך בוחר הקבצים (`npm run validate:browser`) |

```powershell
$env:OTZARIA_DB = "C:/ProgramData/otzaria/books/seforim.db"
$env:OTZARIA_LIBRARY = "C:/Users/User/Documents/DEV/otzaria-library"
$env:OTZARIA_EXTRA_DBS = "C:/ProgramData/otzaria/books/lexical.db;C:/ProgramData/otzaria/databases/user_books.db"
$env:VALIDATION_OUT = "$env:TEMP/otzaria-validation"
npm run validate:real                                                   # 1–7, כ־40 דקות
npx vitest run --config vitest.validation.config.ts tests/validation/anchors.test.ts   # בדיקה אחת
npm run build; npm run validate:browser                                 # 8
```

## 5. Fixtures

**רק נתונים אמיתיים**, וכל fixture מתעד את מקורו. אסור להמציא מבנה של סכמה. החריג היחיד הוא מסדים
זדוניים לבדיקות עמידות, שהם פגומים בכוונה.

| Fixture | מה יש בו | איך הופק |
|---|---|---|
| `tests/fixtures/db/seforim-v7-mini.db` | פרוסה אמיתית של `seforim.db` (סכמה 7): בראשית, אונקלוס, ספר עם `line_note`, שורות רש"י שמקושרות לבראשית; קישורים עם עוגנים, טווחים, coverage ו־suppressed sides; מילון ה־zstd הרשמי | `scripts/fixtures/make_mini_db.py` |
| `tests/fixtures/linking/footnotes/midrash-vayisau.json` | הזוג היחיד בספרייה שמקושר ב־FOOTNOTES, עם 16 הקישורים | `scripts/fixtures/make_footnotes_fixture.py` (דורש את חבילת `zstandard`) |
| `tests/fixtures/contracts/*.json` | רשומות אמיתיות מקובצי הספרייה, עם השורות שהן הפיקו במסד | `tests/fixtures/contracts/tools/*.py`, תיעוד ב־[`README.md`](../tests/fixtures/contracts/README.md) |
| `tests/fixtures/schemas/v0.sql` … `v7.sql` | ה־DDL של כל גרסת סכמה | [`contracts/DATABASE_SUPPORT_MATRIX.md`](contracts/DATABASE_SUPPORT_MATRIX.md) |
| `tests/fixtures/db/hostile/cycle.db`, `bracket.db` | מסדים זדוניים: עמוד שמצביע על עצמו, ו־`[` שלא נסגר ב־DDL. משמשים את `tests/integration/database/hostile.test.ts` ואת `robustness.spec.ts` | נוצרו בסקירת האבטחה ממסד קטן שנוצר (לא נתונים של ספרייה), תיעוד ב־[`README.md`](../tests/fixtures/db/hostile/README.md) |
| `tests/fixtures/db/generic/*.db` | מסדים **במבנה שאינו של אוצריא**, לאשף המיפוי: ספרים+שורות (שורות לא לפי הסדר, שורה יתומה, קישורים), טבלה אחת עם אינדקס וכותרות HTML, WITHOUT ROWID עם BLOB ב־gzip/zlib/UTF-8, ומסד בלי טקסט. סינתטיים בכוונה: התכונה נועדה למבנים שלא תוכננו לאוצריא. מסד 50 אלף השורות והמסדים הפגומים נבנים בזמן הבדיקה | `scripts/fixtures/make_generic_dbs.py` |

הפקה מחדש (המסד נפתח ב־`mode=ro`):

```
py -3 -I scripts/fixtures/make_mini_db.py C:/ProgramData/otzaria/books/seforim.db
py -3 -I scripts/fixtures/make_footnotes_fixture.py C:/ProgramData/otzaria/books/seforim.db
py -3 -I scripts/fixtures/make_generic_dbs.py
```

`make_mini_db.py` שומר את ה־DDL המדויק של המקור ומעתיק שורות כמו שהן (BLOB דחוס נשאר דחוס).
`book.totalLines` נשאר הערך של המקור, אף שיש בפרוסה רק חלק מהשורות: בדיקות סופרות שורות ולא סומכות עליו.

## 6. כללים

- כל שינוי בהתנהגות מגיע עם בדיקה, באותו commit. שינוי מכוון מעדכן את הבדיקה; לא מוחקים אותה.
- שמות הבדיקות שהועברו מגרסה 3 נשארים בעברית ובניסוח המקורי, כדי שאפשר יהיה לעקוב שאף אחת לא אבדה.
- בזמן עבודה מריצים את הבדיקות הקשורות לשינוי; לפני PR את הכול (`npm run check`).
- CI (`.github/workflows/ci.yml`) מריץ typecheck, `npm test`, build, E2E ב־Chrome וב־Edge, ובודק שבנייה
  חוזרת נותנת אותו SHA-256.

</div>
