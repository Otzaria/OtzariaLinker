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

ארבעה קבצים רצים רק כשמשתנה הסביבה `OTZARIA_DB` מצביע על `seforim.db` (`describe.runIf`). המסד נפתח
לקריאה בלבד (`openSync(path, "r")`) ואף פעם לא נכתב. בלי המשתנה הם מדולגים, וב־CI הם לא רצים.

| קובץ | מה הוא מודד |
|---|---|
| `tests/integration/database/real-db.local.test.ts` | הקורא העצל ו־`OtzariaDbReader` מול המסד המלא |
| `tests/integration/linking/headings/real-db.local.test.ts` | מנוע הכותרות על 13 זוגות, מול הקישורים שבמסד |
| `tests/integration/linking/dibur-hamatchil/real-db.local.test.ts` | מנוע הד"ה על ספרים שלמים |
| `tests/integration/linking/footnotes/real-db.local.test.ts` | מנוע ההערות על מדרש ויסעו ועל 25 ספרים עם `line_note` |

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

הפקה מחדש (המסד נפתח ב־`mode=ro`):

```
py -3 -I scripts/fixtures/make_mini_db.py C:/ProgramData/otzaria/books/seforim.db
py -3 -I scripts/fixtures/make_footnotes_fixture.py C:/ProgramData/otzaria/books/seforim.db
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
