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
| E2E | `tests/e2e/` | Playwright: Chrome ו־Edge המותקנים, ו־Firefox של Playwright | לא: `npx playwright test` |
| בסיס רגרסיה של v3 | `tests/e2e/legacy-baseline.spec.ts` | Playwright | לא: `npm run test:legacy` |
| השוואה חזותית | `tests/visual/` (§2א) | Playwright, `toHaveScreenshot`, ה־Chromium הנעול של Playwright | לא: `npm run test:visual`; ב־CI כן (job `visual`, Windows) |
| מול מסד אמיתי | `tests/integration/**/*.local.test.ts` (§4) | Vitest | רק עם `OTZARIA_DB` |

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
npm run test:visual                                 # build + השוואת צילומי המסכים (§2א)
npm run test:visual:update                          # אחרי שינוי מכוון בממשק: כתיבה מחדש של הצילומים שהשתנו
npm run check                                       # typecheck + npm test + E2E
```

**E2E רץ על התוצר, לא על שרת הפיתוח.** `playwright.config.ts` פותח את `dist/OtzariaLinker.html`
מ־`file://`, עם `offline: true` ו־`locale: "he-IL"`. לכן אחרי שינוי בקוד צריך `npm run build` לפני
`npx playwright test`. המטריצה היא שלושה פרויקטים: `chrome` ו־`edge` (`channel`: הדפדפנים המותקנים במחשב,
`npx playwright install chrome msedge` אם חסרים) ו־`firefox` (הבנייה של Playwright: `npx playwright install firefox`).
`legacy-baseline.spec.ts` לא רץ ב־Firefox (`testIgnore`). כל מפרט רץ אפוא בשלושה דפדפנים; לדפדפן אחד:
`--project=chrome`.

**WebKit (Safari) — אופציונלי, כבוי.** פרויקט רביעי, `webkit`, קיים רק כש־`PW_WEBKIT=1`. הדפדפן הוא הורדה נפרדת
(`npx playwright install --with-deps webkit`), ולא נבדק אם הקובץ היחיד עולה בו מ־`file://` (Worker קלאסי מ־`blob:`,
WASM מוטמע). ב־CI הוא רץ רק כשמשתנה המאגר `E2E_WEBKIT` הוא `true` (Settings → Secrets and variables → Actions →
Variables), ב־job שאינו מכשיל את הריצה (`continue-on-error`).

```powershell
npx playwright install --with-deps webkit   # הורדה; פעם אחת
$env:PW_WEBKIT = "1"; npx playwright test --project=webkit
```

כל בדיקת E2E משתמשת ב־`watchPage` (`tests/e2e/helpers.ts`) ונכשלת על **כל** בקשה שאינה `file:`, `data:`
או `blob:`, ועל כל שגיאה לא מטופלת בדף.

| קובץ E2E | מה הוא בודק |
|---|---|
| `offline-single-file.spec.ts` | הקובץ עולה אופליין מ־`file://`, וה־Worker קורא בקורא ה־SQLite העצל וב־zstd תחת ה־CSP (`data-engine`) |
| `manual-linking.spec.ts` | פתיחת מסד וקובץ, בחירה, יצירה, undo/redo, ייצוא; ערכה כהה ומסך צר |
| `automatic-linking.spec.ts` | מנוע הכותרות ב־Worker, טבלה, "אישור כל הוודאיות", כרטיס, undo |
| `engines.spec.ts` | מנוע ההערות על זוג טקסטים; הגדרות המנוע במצב מתקדם (תגית מותאמת עוברת ל־Worker, ביטוי רגולרי מסוכן חוסם את ההרצה); מנוע הד"ה על רש"י ובראשית מהמסד האמיתי החלקי; וקישור באצווה |
| `citations.spec.ts` | מנוע מראי המקומות: ספר טקסט שמצטט את בראשית מקושר למסד הפתוח, ואז מאושר |
| `maxlink.spec.ts` | קישור מרבי על "תיקייה" של פירוש וספר הערות מול המסד: תכנון, הרצה, דוח, אישור הוודאיות, undo |
| `qa.spec.ts` | הבדיקה מוצאת כפול וקישור לכותרת; התיקון הקבוצתי מוחק רק את ההעתק |
| `db-links.spec.ts` | קישורי המסד של ספר: סיכום, סינון לפי ספר ולפי סוג, העתקה לפרויקט, וייצוא שמוחזק עד אישור (כלל ההחלפה) |
| `db-mapping.spec.ts` | מסד SQLite שאינו במבנה של אוצריא: גרירה, אשף המיפוי, פתיחה וקריאת השורות |
| `records-import.spec.ts` | קישורים מקובץ JSON בפריסה אחרת (שמות שדות משלו, מספור מ־0): ניחוש, תיקון שדה, תצוגה מקדימה וייבוא |
| `relink.spec.ts` | מעבר למהדורה חדשה של ספר: השוואה, והעברת הקישורים הבטוחים |
| `alt-toc.spec.ts` | עורך מבני הכותרות: מבנה חדש מכותרות הספר, מספור בגימטריה, שמירה (עם undo) וייצוא ZIP עם `links/`, `alt_toc/` ו־`_report.txt` |
| `manual-editor.spec.ts` | העורך הידני במגע (`hasTouch`, בלי עכבר): קפיצה לשורה ולכותרת, בחירת שתי שורות בהקשה ויצירת קישור בכפתור, סימון שורות בלי קישור |
| `book-search.spec.ts` | חיפוש בטקסט הספר: <kbd>Ctrl</kbd>+<kbd>F</kbd>, שאילתה בלי ניקוד שמוצאת טקסט מנוקד, הבא/הקודם, רשימת התוצאות, קפיצה והדגשה, <kbd>Esc</kbd> |
| `history-list.spec.ts` | רשימת ההיסטוריה: הפעולות מהחדשה לישנה, מעבר אחורה וקדימה בעכבר ובמקלדת |
| `help.spec.ts` | <kbd>F1</kbd> ולחצן העזרה פותחים את המדריך, פרקים מנווטים בתוכו בלי לעזוב את הדף, <kbd>Esc</kbd> סוגר |
| `robustness.spec.ts` | מסד עם מעגל בעץ העמודים נדחה עם הודעה, והקובץ הבא עדיין נפתח |
| `legacy-baseline.spec.ts` | 93/93 הבדיקות העצמיות של `legacy/OtzariaLinker-v3.html` (לא רץ ב־Firefox) |

## 2א. השוואה חזותית (`npm run test:visual`, ובכל ריצה של CI)

`tests/visual/screens.spec.ts` מגיע ל־15 מסכים וחלונות כמו בדיקות ה־E2E (המסד החלקי, מסדי ה־fixtures של אשף
המיפוי וספרי טקסט קטנים, בלי מסד אמיתי), ומשווה צילום של החלון לצילום הבסיס:

| קבוצה | הצילומים |
|---|---|
| מסכים | מסך הפתיחה; דף משימה (`#/start/...`); הזרימה המודרכת בשלב "הספרים שנמצאו"; סביבת העבודה עם שני ספרים, קישור קיים ושתי שורות בבונה; לשונית הבדיקה |
| מצבים עמוסים | טבלת ההצעות אחרי מנוע הכותרות; 50 הצעות עם שלוש הערות של המנוע לספר בשם עברי ארוך (שם הקובץ נחתך בשני מקומות); טבלת הקישורים אחרי מיזוג, עם 7 קישורים נבחרים וסרגל הפעולות; לוח עבודת הקישור המרבי עם ספר שנכשל, ודוח הקישור המרבי |
| חלונות | הייצוא; העזרה (<kbd>F1</kbd>); אשף המיפוי עם הניחוש והנימוקים; אשף המיפוי כש"לא נמצאו ספרים"; השוואה ומיזוג (המסד מול שתי גרסאות של קובץ קישורים) |
| הודעות | חמש הודעות שגיאה: האחרונה בשורה אחת, ו"עוד 4 הודעות · כולן שגיאות" |

כל מסך נבדק בשלושה רוחבים, `desktop` (1280×800), `tablet` (768×1024) ו־`phone` (390×844), וכל צילום פעמיים,
בהיר וכהה: 21 בדיקות לכל רוחב (14 הראשונות, ושבע של מסכי סבב V6: כיסוי, סימון שורות בלי קישור, בחירת ספרים, יעדים נוספים, alt_toc, דף סוגי הקישור, התוכנית המודרכת) + בדיקה אחת של שוליים צרים בשולחן עבודה בלבד = 64 בדיקות, 134 צילומים (נמדד ב־2026-11-22 בספירת קובצי png). הרוחב הוא בלוק `describe` שנקבע **לפני**
שהדף נפתח, כי הפריסה ההתחלתית נבחרת לפי רוחב החלון (מתחת ל־1200 פיקסלים רשימת הספרים עוברת ללשונית "ספרים"
של החלונית, מתחת ל־900 הכול עמודה אחת). ערכת הצבעים מתחלפת בתוך הבדיקה (`page.emulateMedia`), כי האפליקציה
עוקבת אחרי `prefers-color-scheme` בזמן אמת; כך מגיעים לכל מסך פעם אחת לשני הצבעים. RTL נבדק בכל צילום (הממשק
כולו מימין לשמאל), ובמיוחד שמות קבצים כיחידה משמאל לימין בתוך טקסט עברי, ציון ספריא באנגלית בבונה, ושם עברי
ארוך שנחתך. הצילומים נשמרים ב־`tests/visual/__screenshots__/win32/<רוחב>/<מסך>-<light|dark>.png`.

### מה עושה את הצילום זהה ממחשב Windows אחד לאחר

| מה משתנה בין מחשבים | מה עושים |
|---|---|
| גרסת הדפדפן (Chrome מתעדכן לבד; במחשב שלנו 157, ב־runner מה שבתמונה) | Chromium headless shell של Playwright, שהגרסה שלו נעולה בגרסת `@playwright/test` (‏1.65.0 → Chromium 158.0.8127.18): `npx playwright install chromium-headless-shell` |
| גופן הממשק (Segoe UI, ‏Cascadia Mono/Consolas): גרסאות שונות בין בניות של Windows, וחסרים בתמונת שרת | `tests/visual/stable.ts` מצל על כל שם גופן מערכת שה־CSS מזכיר (`Segoe UI`, `Arial`, `Consolas`, `Cascadia Mono`, `David` ועוד) בגופן מוטמע: Assistant (OFL, ‏`tests/visual/fonts/`, מאתר הארגון) לטקסט, ו־Frank Ruhl CLM של האפליקציה לאשכולות עם טעמים, שאין ב־Assistant. גופן רשת באותו שם גובר על הגופן המותקן; שום דבר ב־`src/` לא משתנה. גופני הספרים מוטמעים ממילא |
| גופן שבכל זאת הגיע מהמערכת | לפני כל צילום `fontLeaks` שואל את Chrome (DevTools, `CSS.getPlatformFontsForNode`) איזה גופן צייר כל אלמנט, ונכשל כשגופן מערכת צייר יותר גליפים ממספר הסמלים באלמנט (טקסט עברי או לטיני). סמלים שאין לאף גופן מוטמע (▾ ◂ ← → ✓) באים מגופני הליבה של Windows (Segoe UI Symbol, ‏Cambria Math, ‏Arial), שיש בכל Windows |
| ClearType: במחשב שלנו הצילומים הישנים היו עם שוליים צבעוניים של subpixel (נמדד: פיקסלים עם R≠G≠B בקצוות של טקסט כהה), והם תלויים בהגדרות ClearType של המכונה | `--disable-lcd-text`: החלקה בגווני אפור בלבד |
| GPU ודרייבר | `--disable-gpu`: רינדור תוכנה |
| פרופיל הצבע של המסך, DPI | `--force-color-profile=srgb`, `deviceScaleFactor: 1`, `--disable-font-subpixel-positioning` |
| שעון, אזור, תנועה | `locale: "he-IL"`, `timezoneId` קבוע, `reducedMotion`, `animations: "disabled"`, `caret: "hide"`; משכי זמן ממוסכים (`timeMasks`) |
| מצב שתלוי בתזמון | ההודעות מתנקות לפני כל צילום (הודעת הצלחה נעלמת אחרי 5 שניות), חוץ משגיאות בצילום ההודעות, שנשארות עד שסוגרים; העכבר מחוץ לכל פקד ושום פקד במיקוד; גלילת החלונית הצדדית ושל סביבת העבודה מתאפסת לראש |

אין תקציב של פיקסלים שונים (`maxDiffPixels: 0`): סף של 0.2% העביר בשקט שינוי בתווית של לחצן. רעש של החלקת קצוות
נבלע בסף הצבע של כל פיקסל (`threshold`, ברירת המחדל 0.2). תקציב לא היה עוזר גם בהבדל אמיתי של סביבה: הבדל ברסטור
של גופן נוגע בכל קצה של כל אות, אלפי פיקסלים, ולא בעשרות.

**נמדד:** אחרי כתיבת הבסיס, כל הרצת השוואה עברה 90/90 צילומים: שתיים רצופות לפני המיזוג של `rewrite/v2` (febc144) ושתיים אחריו, על אותו בסיס, ובדיקת הגופנים לא מצאה טקסט בגופן מערכת באף מסך. זמן ריצה ב־4 workers (כמו ב־CI): 1.3–3.1 דקות במחשב הפיתוח (20 ליבות לוגיות; הטווח לפי העומס על המחשב, שהיה בשימוש בזמן המדידות). ב־runner של 4 ליבות צפוי יותר; ל־job יש `timeout-minutes: 20`. במבנה הקודם, פרויקט לכל רוחב ולכל צבע, אותם 90 צילומים לקחו 2.7–3.9 דקות: כל פרויקט הפעיל סט חדש של workers, ולכל מסך הגיעו שש פעמים במקום שלוש.

### למה Windows ב־CI ולא לינוקס

ההשוואה רצה ב־`ci.yml` בכל push ו־PR, ב־job נפרד, `visual`, על `windows-latest`, מול צילומי `win32` שבמאגר; הבדל
מכשיל את הריצה, ו־`test-results/` (הצילום, הבסיס וההפרש, `*-actual.png`, `*-expected.png`, `*-diff.png`) עולה
כ־artifact בשם `visual-diffs`. ב־CI בסיס חסר נכשל בלי שנכתב (`updateSnapshots: "none"`).

- **לינוקס** היה דורש צעד ידני: אי אפשר לייצר בסיס לינוקס במחשב פיתוח של Windows, ולכן מישהו היה צריך להריץ
  workflow, להסתכל ב־90 צילומים ולשמור אותם, ושוב בכל שינוי מכוון בממשק. גם הרסטור שונה (FreeType מול
  DirectWrite), כך שבסיס לינוקס לא היה מתאים למה שמפתח רואה ב־Windows.
- **Windows** עובד בלי צעד ידני: הבסיס נוצר במחשב הפיתוח ונבדק ב־runner באותם תנאים — אותו קובץ Chromium,
  אותם קובצי גופן, אותו רסטור (DirectWrite; ‏`windows-latest` היא תמונת Windows Server, ובנייתה לא נבדקה כאן),
  החלקה באפור, רינדור תוכנה, sRGB ו־DPI קבוע. במחשב הפיתוח: Windows 11 ‏26H2.
- **מה לא אומת:** לא הרצנו על runner (אין push מהמחשב הזה). הסיכון שנשאר: הבדל של DirectWrite בין בניית Windows
  של המפתח לבניית התמונה של ה־runner ברסטור של אותו גופן, והבדל בגליפים של סמלים מגופני הליבה. אם הריצה הראשונה
  נכשלת בהבדלים דקים בקצוות של כל הטקסט ולא במבנה (ראו `*-diff.png`), זו הסביבה: מריצים את ה־workflow הידני
  `.github/workflows/visual-baselines.yml` (Actions → Visual baselines → Run workflow), שכותב את כל הבסיס על
  `windows-latest` ומעלה אותו כ־artifact (`visual-baselines-win32`), מסתכלים, ושומרים במאגר. מאותו רגע ה־runner
  הוא המקור, ומפתח מעדכן בסיס דרך ה־workflow הזה.
- גם שדרוג של `@playwright/test` מחליף את Chromium, ויכול להזיז פיקסלים: עדכון כזה מגיע עם בסיס חדש, באותו PR.

### הרצה ועדכון

```
npm run test:visual                                                     # build + השוואה
npx playwright test -c playwright.visual.config.ts -g "phone"           # רוחב אחד, אחרי build
npx playwright test -c playwright.visual.config.ts -g "mapping wizard"  # מסך אחד בשלושת הרוחבים
npm run test:visual:update                                              # שינוי מכוון בממשק: build + כתיבה מחדש של מה שהשתנה
```

התקנה חד־פעמית: `npx playwright install --no-remove chromium-headless-shell` (בלי `--no-remove` Playwright מוחק
מהמטמון דפדפנים של גרסאות אחרות שלו).

**אחרי שינוי מכוון בממשק** (למשל כשענף עיצוב ממוזג), שתי פקודות:

1. `npm run test:visual` — ההשוואה נכשלת בכל מסך שהשתנה, ו־`test-results/` מחזיקה לכל אחד את הצילום, הבסיס וההפרש
   (`*-actual.png`, `*-expected.png`, `*-diff.png`). **מסתכלים** בכולם: כל הבדל צריך להיות השינוי שהתכוונו אליו.
   הבדיקה נעצרת בצילום הראשון שנכשל, הבהיר; הכהה נבדק בשלב הבא.
2. `npm run test:visual:update` — כותב מחדש רק את הצילומים שהשתנו (`--update-snapshots=changed`; ‏`=all` כותב את
   כולם), בשני הצבעים ובשלושת הרוחבים, בהרצה אחת של כשתי דקות. `git status tests/visual` מראה מה נכתב; צילום כהה
   שהשתנה ולא נראה בשלב 1 פותחים ובודקים לפני commit. בסיס שנכתב בלי שמישהו ראה אותו לא בודק כלום. בסוף מוחקים
   את `test-results/`.

## 3. Property tests

fast-check משמש איפה שיש אינווריאנטה שקל לנסח ושקשה לכסות בדוגמאות (12 קבצים; הרשימה נבנית מ־`grep -rl "fc.assert" tests`):

| קובץ | מה נבדק |
|---|---|
| `tests/unit/core/text/offsets.test.ts` | כל אופסט שמיוצא חוזר לאינדקס הגלוי שהתכוונו אליו; מונוטוניות; `visibleUnits` ו־`countVisibleChars` מסכימים |
| `tests/unit/core/text/sanitize.test.ts` | ה־HTML המסונן מכיל בדיוק את התווים הגלויים של השורה הגולמית, ואף תגית לא נושאת תכונה או מטפל אירועים |
| `tests/unit/core/text/gematria.test.ts` | גימטריה: 1–999 הולכים ושבים, גרש וגרשיים מתעלמים |
| `tests/unit/core/text/find.test.ts` | חיפוש בספר: המסלול המהיר של `htmlToPlainText` שווה לסריקה המלאה, וכל קטע מהטקסט המקופל נמצא בו (הדחייה המהירה לא מסתירה התאמה) |
| `tests/unit/core/alt-toc.test.ts` | מבני כותרות: צמתים ← רשומות ← צמתים הוא זהות, בכל עומק |
| `tests/unit/matching/hebrew-tokens.test.ts` | כל טוקן הוא קטע מהקלט שלא שונה, שאותיותיו הן המפתח שלו |
| `tests/unit/matching/line-diff.test.ts` | יישור שורות בין מהדורות: ההתאמה עולה ממש ואינה ממפה שתי שורות ישנות לחדשה אחת |
| `tests/unit/state/history.test.ts` | undo של כל רצף פעולות מחזיר להתחלה; מעבר לנקודה `p` משאיר בדיוק `p` פעולות |
| `tests/unit/linking/merge.test.ts` | איחוד הצעות (קישור מרבי): בלתי תלוי בסדר הקלט, אידמפוטנטי, ולא מאבד קישור |
| `tests/unit/linking/citations/numbers.test.ts` | מספרים עבריים במראי מקומות: כל n בין 1 ל־999 נקרא חזרה, ומספור בסדר לא קנוני נדחה |
| `tests/unit/linking/footnotes/markers.test.ts` | הטקסט הגלוי של העוגן הוא בדיוק הסימן (אופסטים של הגנרטור), לכל סגנון סימן |
| `tests/unit/linking/dibur-hamatchil/engine.test.ts` | העוגן הוא קטע משורת הבסיס שלא שונתה, ומפתח החיפוש שלו הוא של הד"ה; הקלט לא משתנה |

**`FC_SEED`.** `tests/setup/fast-check.ts` (מוגדר ב־`setupFiles` של Vitest) קורא את `FC_SEED`: מספר שלם נקבע
כזרע גלובלי של fast-check. בלעדיו כל ריצה מקומית שונה, וכך מכוסה יותר שטח. ב־CI ובשחרור הזרע נגזר
מה־commit (`FC_SEED=$((16#${GITHUB_SHA:0:7})) npm test`), כך שבנייה אדומה חוזרת בדיוק, ו־commit אחר עדיין בודק
קלטים אחרים. כשבדיקה נכשלת, fast-check מדפיס את הזרע והנתיב. להרצה חוזרת:
`FC_SEED=<הזרע> npx vitest run tests/unit/core/text/offsets.test.ts` (ב־PowerShell: `$env:FC_SEED = "<הזרע>"`).

## 4. בדיקות מקומיות מול מסד אמיתי

הקבצים שבטבלה (`*.local.test.ts` תחת `tests/integration/`) רצים רק כשמשתנה הסביבה `OTZARIA_DB` מצביע על
`seforim.db` (`describe.runIf`). המסד נפתח לקריאה בלבד (`openSync(path, "r")`) ואף פעם לא נכתב. בלי
המשתנה הם מדולגים, וב־CI הרגיל הם לא רצים. משתני ההרצה האחרים אופציונליים, חוץ מהמסומן.

**דילוג אינו שקט.** ב־CI, ה־job `tests` כותב דוח JSON לכל סוג (unit, integration, contracts), ו־
`scripts/ci/skipped-tests.mjs` מדפיס כל קובץ שדולג, כמה בדיקות, ואיזה משתנה חסר לו (גם בסיכום של הריצה ב־Actions).
הוא **מכשיל** את הצעד כש: קובץ `*.local.test.ts` דולג אף שכל משתני הנתונים שלו מוגדרים (התנאי שלו שבור); קובץ שאינו
תלוי נתונים דולג בלי `.skip`/`.todo`/`skipIf`/`runIf` בקוד שלו; או דוח חסר. מקומית:

```powershell
npx vitest run tests/integration --reporter=default --reporter=json --outputFile=reports/integration.json
node scripts/ci/skipped-tests.mjs reports/integration.json
```

**הבדיקות הכבדות ב־CI: `.github/workflows/heavy.yml`, ידני בלבד** (Actions → Heavy tests → Run workflow; לא ב־push ולא
ב־PR). צריך runner שיש בו הנתונים (ברירת המחדל `self-hosted`; ל־runner של GitHub אין מסד), ונתיבים כקלט: `otzaria_db`
(חובה), `personal_db`, `library`, `extra_dbs`. הקלט `suites`: `local` (קובצי `*.local.test.ts`), `validation`
(`npm run validate:real`, §4א), `browser` (`npm run validate:browser`; צריך Chrome מותקן ב־runner) או `all`. נתיב שניתן
ואינו קיים מכשיל מיד; אחרי הריצה אותו דוח דילוגים, והתוצאות (`reports/`, `VALIDATION_OUT`) עולות כ־artifact.

| קובץ | מה הוא מודד | משתני סביבה |
|---|---|---|
| `tests/integration/database/real-db.local.test.ts` | הקורא העצל ו־`OtzariaDbReader` מול המסד המלא | `OTZARIA_DB` |
| `tests/integration/database/dictionary-identity-real-db.local.test.ts` | מילון הדחיסה הרשמי: טביעת האצבע הקבועה (`OFFICIAL_DICTIONARY_SHA256`), ו־400 מסגרות אמיתיות שמפוענחות במילון של המסד ובמילון שאול כמו libzstd של Node; מילון אחר עם אותו dictID לא נשאל (B19) | `OTZARIA_DB` |
| `tests/integration/database/dictionary-collision-real-db.local.test.ts` | הרשמי ו־v52 פתוחים יחד (אותו dictID 32768, מילונים שונים), בשני הסדרים: כל מסד נקרא במילון שלו, ורק הרשמי מותר לשאילה | `OTZARIA_DB` ו־`OTZARIA_PERSONAL_DB` |
| `tests/integration/database/alt-toc-real-db.local.test.ts` | מבני `alt_toc` של ספרים שאינם של ספריא (ספר העיטור, תרגום ותפסיר רס"ג) במסד האמיתי | `OTZARIA_DB` |
| `tests/unit/headless/sdk-catalog.local.test.ts` | כל שיטה של ה־SDK שליבת התוסף קוראת קיימת ב־`spec.json` של אוצריא, עם ההרשאה שדוגמת התוסף מבקשת ו־`minAppVersion` שמכסה אותה; המגבלות של המתאם הן המספרים שב־README של ה־SDK ([`PLUGIN_READINESS.md`](PLUGIN_READINESS.md)) | `OTZARIA_SRC` (עותק של `Otzaria/otzaria`) |
| `tests/integration/database/db-links-real-db.local.test.ts` | רשימת קישורי המסד של בראשית, ברכות ומשנה ברורה, עם זמנים; והשחזור של רשומות הספרייה מהמסד | `OTZARIA_DB`; הבלוק השני רק עם `OTZARIA_LIBRARY` |
| `tests/integration/database/fix-round-measure.local.test.ts` | מדידות סבב התיקון לפני מיזוג (PR1): עלות חלוקה לטווחים ב־`external_link`, זיכרון, ביטול סריקה משותפת, מיפוי של מסד גדול, וצעד של 200 שורות על הספר הגדול של הספרייה. מדפיס מספרים מצטברים בלבד; `MEASURE_OUT=<קובץ>` מוסיף אותם גם לקובץ | `OTZARIA_PERSONAL_DB` ו־`OTZARIA_DB` |
| `tests/integration/database/external-links-real-db.local.test.ts` | `external_link` של מסד אישי אמיתי (PDC, v52): שורות יוצאות של שלושת הספרים הגדולים והסריקה הפנימית, מול SQLite, עם זמנים | `OTZARIA_PERSONAL_DB` |
| `tests/integration/linking/headings/real-db.local.test.ts` | מנוע הכותרות על 13 זוגות, מול הקישורים שבמסד | `OTZARIA_DB` |
| `tests/integration/linking/dibur-hamatchil/real-db.local.test.ts` | מנוע הד"ה על ספרים שלמים | `OTZARIA_DB`; `DH_REPORT=<קובץ>` כותב את כל ההחטאות |
| `tests/integration/linking/footnotes/real-db.local.test.ts` | מנוע ההערות על מדרש ויסעו ועל 25 ספרים עם `line_note` | `OTZARIA_DB` |
| `tests/integration/linking/citations/real-db.local.test.ts` | מנוע מראי המקומות על מדגם של ספרים מכל הקטגוריות, מול קישורי המראי מקום שבמסד (דיוק ושחזור לפי רמת ודאות), וזמן על ספר גדול | `OTZARIA_DB`; `CITATIONS_REPORT=<קובץ.json>` (כל ההצעות ששפטו), `CITATIONS_ONLY=<שם ספר>`, `CITATIONS_SHARD=k/n` (כל n־י ספר, להרצה מקבילה; אז הספים לא נבדקים), `CITATIONS_SAMPLE=heldout`/`heldout2` (מדגם שלא כוונן עליו, בלי ספים; AUTOMATION_ENGINE §6.8) |
| `tests/integration/linking/maxlink-real-db.local.test.ts` | קישור מרבי על ספר בסיס שלם: תכנון, הרצה, איחוד והשוואה לקישורי המסד (כמה כבר קיימים, וכמה סותרים) | `OTZARIA_DB`; `MAXLINK_BASES="ברכות,בראשית"` (ברירת מחדל: ברכות), `MAXLINK_LOG=<קובץ>` |
| `tests/integration/live-test/bundle-real-db.local.test.ts` | לפני בדיקה בתוך אוצריא (§4ב): אף ספר של החבילה לא קיים בספרייה הרשמית, ו־`בראשית` במסד כמו שהחבילה מניחה | `OTZARIA_DB` |

```bash
# bash
OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db npx vitest run tests/integration/linking/headings/real-db.local.test.ts
```

```powershell
# PowerShell
$env:OTZARIA_DB = "C:/ProgramData/otzaria/books/seforim.db"
npx vitest run tests/integration/linking/dibur-hamatchil/real-db.local.test.ts
```

הבדיקות מדפיסות precision, recall ועוגנים
מדויקים; התוצאות שנמדדו מסוכמות ב־[`AUTOMATION_ENGINE.md`](AUTOMATION_ENGINE.md). הריצה על ספרים שלמים
לוקחת דקות (ה־timeout של כל בדיקה עד 10 דקות).

## 4א. אימות מול נתונים אמיתיים (`npm run validate:real`)

שמונה בדיקות שמשוות את הכלי לנתונים האמיתיים שבמחשב: המסד העדכני של אוצריא, עותק git של ספריית
אוצריא ומסדים זרים. הן לא רצות ב־`npm test` (תצורה נפרדת, `vitest.validation.config.ts`), וכל אחת
מדולגת בלי משתני הסביבה שלה. הממצאים והמספרים: [`validation/REAL_DATA_REPORT.md`](validation/REAL_DATA_REPORT.md).
"האם הכלי מפיק לפחות את הקישורים שכבר יש", לכל סוג קישור ועל כל הספרייה: [`validation/LIBRARY_BENCHMARK.md`](validation/LIBRARY_BENCHMARK.md).

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
| `tests/validation/multibase.test.ts` | 5ב. קישור מרבי על ספרים שכתובים על כמה בסיסים (חלק לכל בסיס; בלי חלק רק ד"ה, עד "אפשרית"), מול קישורי COMMENTARY שבמסד, לפי מנוע ושלב. `VALIDATE_MULTIBASE_N` (ברירת מחדל 30) |
| `tests/validation/library-benchmark.test.ts` | 5ג. **מדד הספרייה**: הקישור המרבי על כל ספר (או מדגם מרובד), מול **כל** סוגי הקישורים שבמסד — כמה מהקיימים הכלי מפיק מחדש, בדיוק לפי ודאות, וההצעות החדשות. רץ ברקע, בכמה תהליכים, עם מטמון להמשך (`BENCH_*`). התוצאות והפערים: [`validation/LIBRARY_BENCHMARK.md`](validation/LIBRARY_BENCHMARK.md) |
| `tests/validation/library-benchmark-whatif.test.ts` | 5ד. מנוע זוגות על זוגות שהמתכנן לא מקשר (כמה קישורים יסגור קשר חסר) |
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

## 4ב. בדיקה בתוך אפליקציית אוצריא (שלב 20)

**לא בוצעה.** זו בדיקה ידנית, בכ־20 דקות, של מה שהכלי מייצא בתוך האפליקציה עצמה: ייבוא דרך תיקיית ספרים
אישיים ודרך "ייבוא נתונים", הצגה בחלוניות, לחיצה, שורה מדויקת, עוגנים, טווחים, פירוש ומקור, ספרי ספריא,
`user_books.db`, ועדכון תוכן. הצעדים, התוצאה הצפויה לכל בדיקה (עם הפניות לקוד של אוצריא) וטבלת התוצאות:
[`LIVE_TESTING.md`](LIVE_TESTING.md).

| קובץ | תפקיד |
|---|---|
| `scripts/live-test/bundle.ts` | החבילה: חמישה ספרים קטנים ו־12 קישורים, נכתבים בקוד של הכלי (`planExport`, עוגנים, `ref_*`, מעבר למהדורה) |
| `scripts/live-test/make-bundle.mjs` | כותב את החבילה לתיקייה (ברירת מחדל `live-test-bundle/`), דרך ה־module runner של Vite |
| `scripts/live-test/inspect-user-links.py` | מה האפליקציה שמרה ב־`user_books.db` (קריאה בלבד) |
| `tests/integration/live-test/bundle.test.ts` | רץ ב־`npm test`: החבילה דטרמיניסטית, עוברת את `validateExport` ואת הפרסור של הכלי, העוגנים על המילים, העובדות על בראשית מול `seforim-v7-mini.db`, ושערי הייבוא של האפליקציה |
| `tests/integration/live-test/bundle-real-db.local.test.ts` | מול המסד המלא (§4) |

```
node scripts/live-test/make-bundle.mjs
npx vitest run tests/integration/live-test/bundle.test.ts
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
| `tests/fixtures/schemas/user-books.sql`, `user-books-user-link-v1.sql` | ה־DDL של `user_books.db` של אוצריא (`database.dart` @ `a6be90800`) ושל `user_link` הראשונה (@ `65db26bd2`) | [`contracts/LINK_SCHEMA_MATRIX.md`](contracts/LINK_SCHEMA_MATRIX.md) §6.1 |
| `tests/fixtures/db/hostile/cycle.db`, `bracket.db` | מסדים זדוניים: עמוד שמצביע על עצמו, ו־`[` שלא נסגר ב־DDL. משמשים את `tests/integration/database/hostile.test.ts` ואת `robustness.spec.ts` | נוצרו בסקירת האבטחה ממסד קטן שנוצר (לא נתונים של ספרייה), תיעוד ב־[`README.md`](../tests/fixtures/db/hostile/README.md) |
| `tests/fixtures/db/generic/*.db` | מסדים **במבנה שאינו של אוצריא**, לאשף המיפוי: ספרים+שורות (שורות לא לפי הסדר, שורה יתומה, קישורים), טבלה אחת עם אינדקס וכותרות HTML, WITHOUT ROWID עם BLOB ב־gzip/zlib/UTF-8, ומסד בלי טקסט. סינתטיים בכוונה: התכונה נועדה למבנים שלא תוכננו לאוצריא. מסד 50 אלף השורות והמסדים הפגומים נבנים בזמן הבדיקה | `scripts/fixtures/make_generic_dbs.py` |
| `tests/fixtures/db/wizard/*.db` | **מבנה אחד לכל קובץ** לבדיקת הזיהוי של האשף: ספר ברשומה, שורה ברשומה, ספרים+שורות (עם FK ובלי), JSON, פרקים, מהדורות, BLOB ב־UTF-8/UTF-16/Windows-1255, zlib/zstd, קטעים, מפתח מורכב, קישורים, תוכן עניינים, מסד UTF-16; ובלי ספרים: הגדרות+יומן, FTS5, מבטים, קטלוג, טבלאות ריקות. סינתטיים בכוונה, 1KiB לעמוד | `scripts/fixtures/make_wizard_dbs.py` |

הפקה מחדש (המסד נפתח ב־`mode=ro`):

```
py -3 -I scripts/fixtures/make_mini_db.py C:/ProgramData/otzaria/books/seforim.db
py -3 -I scripts/fixtures/make_footnotes_fixture.py C:/ProgramData/otzaria/books/seforim.db
py -3 -I scripts/fixtures/make_generic_dbs.py
py -3 -I scripts/fixtures/make_wizard_dbs.py      # Python 3.14+ (zstd ב־compression.zstd)
```

`make_mini_db.py` שומר את ה־DDL המדויק של המקור ומעתיק שורות כמו שהן (BLOB דחוס נשאר דחוס).
`book.totalLines` נשאר הערך של המקור, אף שיש בפרוסה רק חלק מהשורות: בדיקות סופרות שורות ולא סומכות עליו.

## 6. כללים

- כל שינוי בהתנהגות מגיע עם בדיקה, באותו commit. שינוי מכוון מעדכן את הבדיקה; לא מוחקים אותה.
- שמות הבדיקות שהועברו מגרסה 3 נשארים בעברית ובניסוח המקורי, כדי שאפשר יהיה לעקוב שאף אחת לא אבדה.
- בזמן עבודה מריצים את הבדיקות הקשורות לשינוי; לפני PR את הכול (`npm run check`).
- CI (`.github/workflows/ci.yml`) מחולק ל־jobs לפי סוג בדיקה, כדי שריצה אדומה תגיד מה נכשל: `typecheck`; `security`
  (`npm audit --omit=dev`, מדווח ולא מכשיל); `tests` (unit, integration ו־contracts כצעדים נפרדים עם `FC_SEED` שנגזר
  מה־commit, ודוח הדילוגים, §4); `build` (כולל סריקת הרשת ותקציב הגודל); `reproducible` (אותו commit נבנה פעמיים
  בתיקייה אחת ופעם בעותק שני, וה־SHA-256 זהה); `e2e` (Chrome, Edge ו־Firefox, job לכל דפדפן, על הקובץ ש־`build` בנה;
  בתוכם גם הנגישות, האופליין ובסיס הרגרסיה של v3); `e2e-webkit` (אופציונלי, §2); ו־`visual` על `windows-latest`, מול
  צילומי הבסיס שבמאגר, והבדל מכשיל את הריצה (§2א). הפירוט: [`RELEASE_PROCESS.md`](RELEASE_PROCESS.md) §4. בשחרור רץ
  רצף מקביל ב־job אחד, בלי ההשוואה החזותית. הבדיקות הכבדות: `heavy.yml`, ידני (§4).

</div>
