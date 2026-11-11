<div dir="rtl">

# ארכיטקטורה

המסמך מתאר את מבנה הקוד ב־`src/` כפי שהוא ב־HEAD. ההחלטות עצמן, עם הנימוקים והראיות, נמצאות
ב־[`adr/`](adr/README.md).

## 1. התמונה הכללית

- **קוד מודולרי, הפצה כקובץ אחד.** TypeScript ו־Preact תחת `src/`. Vite ו־`vite-plugin-singlefile`
  מטמיעים הכול (JS, CSS, גופנים, אייקונים, WASM, Worker) ב־`dist/OtzariaLinker.html`
  ([ADR 0001](adr/0001-modular-source-single-file-distribution.md), [ADR 0002](adr/0002-build-stack.md)).
- **שני חוטים.** חוט הממשק מחזיק את המצב ואת המסכים. **Worker אחד** (`src/workers/sources.worker.ts`)
  מחזיק את כל המקורות הפתוחים: קריאת SQLite לפי עמודים, פענוח zstd, פענוח קבצים, וגם הרצת המנועים
  האוטומטיים. ה־Worker נבנה כ־classic (IIFE), כי module worker מ־`blob:` לא עולה תחת `file://`.
  `src/app/main.tsx` מחזיק אותו עם watchdog: Worker שקרס, או שלא עונה לבדיקת `alive` ארבע שניות אחרי
  ביטול, מוחלף בחדש. המקורות הפתוחים אובדים (`AppStore.workerLost`), הקישורים בפרויקט לא.
- **מצב אחד.** `AppStore` (`src/state/store.ts`) מחזיק signals לכל מה שהמסכים מציגים, ומתודה לכל פעולה של
  המשתמש. הקישורים משתנים **רק** דרך `history.commit`, ולכן כל פעולה ניתנת לביטול
  ([ADR 0003](adr/0003-ui-framework.md), [ADR 0005](adr/0005-ui-decisions.md)).
- **מודל קישור אחד** (`src/core/links/model.ts`), בלי תלות בפורמט. כל פורמט ממיר אליו ובחזרה בגבול שלו.

## 2. השכבות

כל תיקייה ראשית ב־`src/` היא שכבה. שכבה מייבאת רק מעצמה ומהשכבות שבטבלה. הכלל נאכף ב־
`tests/unit/architecture.test.ts`, שסורק כל `import`/`export … from` בקוד.

| שכבה | מותר לייבא מ־ | טהורה (בלי Preact) |
|---|---|---|
| `core` | — | כן |
| `matching` | `core` | כן |
| `linking` | `core`, `matching` | כן |
| `formats` | `core` | כן |
| `database` | `core` | — |
| `sources` | `core`, `database`, `formats` | — |
| `projects` | `core`, `formats` | — |
| `diagnostics` | `core` | — |
| `workers` | `core`, `database`, `matching`, `linking`, `formats`, `sources`, `diagnostics` | — |
| `state` | `core`, `linking`, `matching`, `formats`, `projects`, `diagnostics` | — |
| `ui` | `core`, `state`, `linking`, `matching`, `formats`, `diagnostics` | — |
| `app` | הכול | — |

שתי השלכות חשובות:
- `state` **לא** מכיר את `sources`, `database` ו־`workers`. מה שהוא צריך מהעולם מוגדר כממשקים ב־
  `src/state/services.ts` (`BooksService`, `Saver`, `KeyValueStore`), שהצורה שלהם תואמת מבנית את
  `src/sources/registry.ts`. האפליקציה מחברת את המימוש האמיתי; הבדיקות מעבירות זיוף בזיכרון.
- `ui` לא מכיר את ה־Worker ולא את קובץ הפרויקט. הוא קורא signals וקורא למתודות של `AppStore`.

חריג אחד: `ui` מייבא את `docs/USER_GUIDE.md?raw` כטקסט, לחלון העזרה. זה נתון ולא קוד, והבדיקה מתירה
רק ייבוא `?raw` של קובץ ‎`.md` שנמצא ישירות ב־`docs/`.

## 3. אחריות כל שכבה

| שכבה | מה יש בה | קבצים מרכזיים |
|---|---|---|
| `core` | המודל והכללים, בלי I/O: קישור, ספר ושורה, סוגי קשר, כללי שמות ספרים, "מה הגנרטור ישמור", ולידציה; טקסט: אופסטים, סינון HTML, נרמול עברי, גימטריה, פענוח קידוד; שגיאות עם קוד | `links/model.ts`, `links/stored-form.ts`, `links/validate.ts`, `links/connection-type.ts`, `links/titles.ts`, `text/offsets.ts`, `text/sanitize.ts`, `books.ts`, `errors.ts` |
| `matching` | השוואת טקסט עברי: טוקנים עם אופסטים גולמיים, דמיון מילים, צעד יישור עם גשרים (ראשי תיבות, קיצורים, מילים דבוקות), משקלי מילים; יישור שורות בין שתי מהדורות של ספר (שלב 11, עדיין בלי ממשק) | `hebrew-tokens.ts`, `token-match.ts`, `similarity.ts`, `word-weights.ts`, `line-diff.ts` |
| `linking` | המנועים האוטומטיים (פונקציות טהורות מספרים להצעות), זיהוי זוגות לאצווה, ודוח האיכות | `automatic/types.ts`, `automatic/index.ts`, `automatic/{headings,dibur-hamatchil,footnotes}/`, `batch.ts`, `qa.ts` |
| `formats` | `_links.json`: פרסור שמדווח לכל רשומה, המרה 1-based ↔ 0-based, כתיבה דטרמיניסטית, תוכנית ייצוא ו־ZIP | `links-json/{parse,record,convert,serialize,export}.ts` |
| `database` | קורא SQLite עצל לפי עמודים, מפענח zstd, קורא מסדי אוצריא לפי יכולות (סכמות 0–7), שחזור שורות עם הערות (סכמה 7), קריאת קישורים קיימים; sql.js לבדיקת הפעלה בלבד | `sqlite/lazy/sqlite-file.ts`, `compression/zstd.ts`, `otzaria/{capabilities,reader,line-notes,links-reader}.ts` |
| `sources` | "דלת אחת" לכל מה שהמשתמש פתח: זיהוי לפי תוכן, ZIP בטוח, ספרים מקובצי טקסט, ספרים ממסד | `registry.ts`, `detect.ts`, `archives/safe-unzip.ts`, `text/text-source.ts`, `db/db-source.ts`, `book-source.ts` |
| `projects` | קובץ הפרויקט: כתיבה, קריאה ואימות | `project-format.ts` |
| `diagnostics` | יומן מובנה וחסום בגודל, בלי טקסט ספרים. **עדיין לא מחובר לשום מקום ב־HEAD** | `log.ts` |
| `workers` | פרוטוקול RPC טיפוסי עם ביטול והתקדמות; ה־Worker; הרצת מנוע על שני ספרים שלמים, ואצווה של זוגות (זוג אחד בזיכרון בכל פעם); חיפוש בטקסט של ספר, בנתחים | `rpc.ts`, `sources.worker.ts`, `sources-api.ts`, `engine-job.ts`, `search-job.ts` |
| `state` | `AppStore`; היסטוריה עם undo/redo ומעבר לכל נקודה בה; מטמון שורות; חיפוש בכל קורא; העדפות ופריסה; ממשקי השירותים | `store.ts`, `history.ts`, `lines.ts`, `book-find.ts`, `preferences.ts`, `services.ts` |
| `ui` | המסכים: מסך פתיחה, סרגל עליון, סביבת עבודה, קוראים, חיפוש בקורא, בונה, רשימות, הצעות, בדיקה, רשימת היסטוריה, חלונות ייצוא, מעבר מהדורה ועזרה; ערכת נושא ואייקונים | `app.tsx`, `screens/home.tsx`, `workspace/*.tsx`, `dialogs/*.tsx`, `help/`, `theme/`, `icons/` |
| `app` | נקודת ההרכבה: יוצר את ה־Worker ומחליף אותו כשהוא קורס או נתקע, מתאים אותו ל־`BooksService`, `Saver` של הורדות, אחסון IndexedDB לשמירה האוטומטית, ומרנדר | `main.tsx`, `idb-store.ts` |

## 4. זרימת הנתונים

### 4.1 פתיחת קבצים

```
גרירה / בורר קבצים
  → ui/files.ts            InputFile { path, blob }  (שום דבר לא נקרא כאן)
  → AppStore.openFiles     runTask: התקדמות וביטול בסרגל העליון
  → BooksService.open      RPC אל ה־Worker
  → SourceRegistry.open    לכל קובץ: 4KiB ראשונים → detectKind
       sqlite      → DbBookSource.open   (OtzariaDbReader על blobSource: File.slice)
       zip         → safeUnzip → ‎.txt לספרים, ‎.json לקישורים/פרויקט
       text        → TextFilesSource (כל קובצי הטקסט של הפתיחה יחד)
       links-json / project → טקסט מפוענח, מוחזר כמסמך
       אחר         → skipped, עם סיבה בעברית
  ← OpenResult { sources (+ספרים), documents, skipped }
  → AppStore: sources.value; importLinksFile / openProject לכל מסמך; הודעות
```

### 4.2 קריאת שורות

```
Reader (ui) → LineStore (state/lines.ts): נתחים של 200 שורות, עד 400 נתחים במטמון
  → BooksService.lines → Worker → BookSource.lines → SourceLine[]
  ← tick.value משתנה → הקוראים מרנדרים מחדש
```

`SourceLine` נושא שני טקסטים: `text` (כפי שהשורה שמורה, להצגה) ו־`anchorText` (המחרוזת שהגנרטור
סופר עליה אופסטים; בסכמה 7 היא כוללת את גופי ההערות). הוא נושא גם `heading`, `heRef` ו־`existsInDb`.

### 4.3 יצירה ושינוי של קישורים

```
בחירה בקוראים → AppStore.pick / draft (computed) → validateLink (חי)
  → createFromDraft / deleteLinks / setType / approveSuggestions / importLinksFile / openProject
  → store.apply(label, changes) → history.commit → linkState.value (revision + 1)
```

כל `Change` הוא זוג `before`/`after` לקישור אחד, וכל פעולה היא `Command` אחד עם תווית בעברית.
undo מחזיר בדיוק את מה שהפעולה שינתה. ההיסטוריה מוגבלת ל־500 פקודות.

### 4.4 מנועים אוטומטיים

```
SuggestionsPanel → AppStore.runEngine(engine, sourceKey, targetKey)
  → BooksService.runEngine → Worker: engineJob קורא את שני הספרים כולם (anchorText)
  → runEngine (linking, טהור) → EngineResult { suggestions, notes, unmatched }
  ← AppStore.run; מצב כל הצעה נגזר: pending / approved / rejected / exists
  → approveSuggestions → קישורים "auto:<id>" דרך history.commit

אצווה: AppStore.runBatch(engine, sourceId)
  → pairByTitle (linking/batch.ts): כל ספר במקור ← ספר הבסיס ששמו מופיע ב"… על <בסיס>"
  → BooksService.runBatch → Worker: batchJob מריץ engineJob זוג אחר זוג; כשל בזוג לא עוצר
  ← כל ההצעות ב־run אחד, ו־run.batch עם שורת סיכום לכל ספר
```

המנוע לא יוצר קישורים. "אושרה" פירושו "קיים קישור `auto:<id>`", ולכן undo מחזיר את ההצעה ל"ממתינה".
"כבר קיים" נבדק לפי `linePairKey` (אותן שתי שורות, בכל סוג וכיוון) מול קישורי הפרויקט ומול קישורי המסד
של ספרי הריצה (`dbLinkKeys`). דחיות נשמרות לפי `rejectionKey` (מנוע, שמות ספרים, שורות, עוגן), שאינו
תלוי במפתחות הסשן.

### 4.5 ייצוא ובדיקה

```
AppStore.prepareExport / runQualityCheck
  → טעינת הנתחים שבהם נמצאים קצוות כל הקישורים
  → planExport / runQa  — שניהם על validateExport, עם ValidationContext של השורות שנטענו
  → חלון הייצוא / לשונית הבדיקה → Saver (הורדה)
```

## 5. החלטות מרכזיות

| החלטה | איפה |
|---|---|
| קוד מודולרי, הפצה כקובץ HTML יחיד; v3 נשמר ב־`legacy/` | [ADR 0001](adr/0001-modular-source-single-file-distribution.md) |
| Vite + TypeScript strict; Workers קלאסיים; WASM כ־base64; CSP; בנייה שחוזרת על עצמה | [ADR 0002](adr/0002-build-stack.md) |
| Preact + Signals; `core` בלי Preact; HTML של ספר רק דרך המסנן | [ADR 0003](adr/0003-ui-framework.md) |
| Vitest, fast-check, Playwright על הדפדפנים המותקנים; E2E על התוצר | [ADR 0004](adr/0004-testing-stack.md) |
| מסך פתיחה מודרך, ארבעה טורים, בונה, שלוש תצוגות להצעות, מתג מתקדם, גופני אוצריא | [ADR 0005](adr/0005-ui-decisions.md) |
| קורא SQLite משלנו במקום sql.js: מסד של כמה ג'יגה לא נכנס לזיכרון | [`contracts/DATABASE_SUPPORT_MATRIX.md`](contracts/DATABASE_SUPPORT_MATRIX.md) §7 |
| מסד מסווג לפי הטבלאות שקיימות בו, לא לפי מספר הסכמה המוצהר | `src/database/otzaria/capabilities.ts`, [`DATABASE_SUPPORT_MATRIX.md`](contracts/DATABASE_SUPPORT_MATRIX.md) §4 |
| הכלי מציג "מה הגנרטור ישמור" (`storedForm`), לא רק מה שהמשתמש בחר | [`contracts/LINK_FORMATS.md`](contracts/LINK_FORMATS.md) §1.5 |
| כיוון הרשומה של מנוע הד"ה | [`research/DH_ANCHOR_DIRECTION.md`](research/DH_ANCHOR_DIRECTION.md) |
| מה מותר לנייד מאילו מאגרים | [`research/REUSE_MATRIX.md`](research/REUSE_MATRIX.md) §0, §8 |

## 6. מקורות האמת לכללים חיצוניים

הכלי מחקה את הגנרטור של אוצריא (`SeforimLibrary`), את הסנכרון השבועי של `otzaria-library` ואת
האפליקציה. הגרסאות שנבדקו, וההפניות לשורות, מופיעות ב־[`contracts/LINK_FORMATS.md`](contracts/LINK_FORMATS.md)
("גרסאות שנקראו") וב־[`contracts/OTZARIA_COMPATIBILITY.md`](contracts/OTZARIA_COMPATIBILITY.md). הערות
בקוד מפנות לאותן שורות (`Generator.kt:2276-2329`). כשהגנרטור משתנה, מעדכנים קודם את החוזה ואת
הבדיקות שלו, ורק אחר כך את הקוד.

## 7. מה ממומש ומה לא (HEAD)

ממומש: פתיחת מסדי אוצריא (0–7), קובצי טקסט, תיקיות ו־ZIP; קריאה עצלה; חיפוש בטקסט הספר (ב־Worker,
`search-job.ts`); בונה ידני עם ולידציה חיה; שלושה מנועים אוטומטיים, לזוג ספרים או באצווה, עם הגדרות
במצב מתקדם; ייבוא וייצוא `_links.json`; ייבוא קישורים מ־CSV/TSV; מעבר קישורים למהדורה חדשה של ספר; בדיקת
איכות; היסטוריית פעולות; פרויקטים, שמירה אוטומטית ושחזור; עזרה בתוך הכלי (המדריך עצמו, `ui/help/markdown.ts`).

לא ממומש: מיפוי מסדי SQLite כלליים, ייבוא JSON כללי, חיבור `diagnostics` לממשק, `alt_toc`. הרשימה למשתמש: [`USER_GUIDE.md`](USER_GUIDE.md#מגבלות-ידועות).

</div>
