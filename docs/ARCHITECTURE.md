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
| `core` | המודל והכללים, בלי I/O: קישור, ספר ושורה, סוגי קשר, כללי שמות ספרים, "מה הגנרטור ישמור", ולידציה, **כלל השוויון האחד** בין קישורים, קישורי מסד (שאילתה, סיכום, מקור משוער) ושחזור רשומה מקישור מסד; טקסט: אופסטים, הטקסט הנראה של שורה עם המיפוי לגולמי, שמירה מפני ביטוי רגולרי של משתמש, סינון HTML, נרמול עברי, גימטריה, פענוח קידוד; שגיאות עם קוד | `links/model.ts`, `links/stored-form.ts`, `links/validate.ts`, `links/equality.ts`, `links/db-links.ts`, `links/from-db.ts`, `links/connection-type.ts`, `links/titles.ts`, `text/offsets.ts`, `text/visible-map.ts`, `text/safe-regex.ts`, `text/sanitize.ts`, `books.ts`, `errors.ts` |
| `matching` | השוואת טקסט עברי: טוקנים עם אופסטים גולמיים, דמיון מילים, צעד יישור עם גשרים (ראשי תיבות, קיצורים, מילים דבוקות), משקלי מילים; יישור שורות בין שתי מהדורות של ספר (`line-diff.ts`; הממשק: חלון "מעבר למהדורה חדשה", `ui/dialogs/relink-dialog.tsx`) | `hebrew-tokens.ts`, `token-match.ts`, `similarity.ts`, `word-weights.ts`, `line-diff.ts` |
| `linking` | המנועים האוטומטיים (פונקציות טהורות מספרים להצעות), זיהוי זוגות לאצווה, קישור מרבי (מתכנן, איחוד הצעות, דוח), כללי הטווחים ("עד הקישור הבא", קיצור, השלמה), ודוח האיכות | `automatic/types.ts`, `automatic/index.ts`, `automatic/{headings,dibur-hamatchil,footnotes,citations,pattern}/`, `batch.ts`, `plan.ts`, `merge.ts`, `maxlink-report.ts`, `ranges.ts`, `qa.ts` |
| `formats` | `_links.json`: פרסור שמדווח לכל רשומה, המרה 1-based ↔ 0-based, כתיבה דטרמיניסטית, זיהוי ושחזור של פריסת הקובץ (הזחה, שורה אחרונה, escape של לא־ASCII), תוכנית ייצוא ו־ZIP; ייבוא קישורים מגיליון CSV/TSV; ייבוא מ־JSON, JSON Lines או גיליון בפורמט אחר (טבלת רשומות ומיפוי שדות); קובצי `alt_toc` (קריאה, אימות וכתיבה); דוח הייצוא `_report.txt`; CSV בפורמט ספריא | `links-json/{parse,record,convert,serialize,export,layout}.ts`, `links-csv/parse.ts`, `records/records.ts`, `alt-toc/{file,export}.ts`, `report/export-report.ts`, `sefaria-csv/write.ts` |
| `database` | קורא SQLite עצל לפי עמודים, מפענח zstd, קורא מסדי אוצריא לפי יכולות (סכמות 0–7), שחזור שורות עם הערות (סכמה 7), קריאת קישורים קיימים (לפי שורה, ולפי ספר מהאינדקסים `idx_link_source_book`/`idx_link_target_book`); קורא של מסד במבנה אחר לפי מיפוי (תצוגה מקדימה, פענוח טקסט, אינדקס סדר לכל ספר); קריאת מבני `alt_toc` ממסד אוצריא. sql.js אינו בתוצר: בדיקת ההפעלה (`workers/self-check.ts`) קוראת מסד זעיר מוטמע באותו קורא עצל, ו־sql.js נשאר רק בבדיקות | `sqlite/lazy/{sqlite-file,byte-source,ddl,record}.ts`, `compression/zstd.ts`, `otzaria/{capabilities,reader,line-notes,links-reader,alt-toc-reader}.ts`, `generic/{preview,text-codec,mapped-reader}.ts` |
| `sources` | "דלת אחת" לכל מה שהמשתמש פתח: זיהוי לפי תוכן, ZIP בטוח, ספרים מקובצי טקסט, ספרים ממסד, ספרים ממסד במבנה אחר לפי מיפוי; רשימת הקישורים הקיימים של ספר (מערכים צפופים, ספירה, סינון ודפדוף) | `registry.ts`, `detect.ts`, `archives/safe-unzip.ts`, `text/text-source.ts`, `db/db-source.ts`, `db/mapped-source.ts`, `db/pending.ts`, `db/link-listing.ts`, `book-source.ts` |
| `projects` | קובץ הפרויקט: כתיבה, קריאה ואימות | `project-format.ts` |
| `diagnostics` | יומן מובנה וחסום בגודל, בלי טקסט ספרים. מחובר ל־`AppStore` דרך `state/diagnostics.ts`, ונשמר כקובץ JSONL מתפריט ההגדרות (`AppStore.saveDiagnostics`) | `log.ts` |
| `workers` | פרוטוקול RPC טיפוסי עם ביטול והתקדמות; ה־Worker; הרצת מנוע על שני ספרים שלמים, אצווה של זוגות, ותוכנית קישור מרבי (זוג אחד בזיכרון בכל פעם); מנוע מראי המקומות על ספר אחד (המקור בנתחים, אינדקס מקומות לכל ספר מצוטט, במטמון חסום); חיפוש בטקסט של ספר, בנתחים; בדיקת הפעלה (`self-check.ts`: הקורא העצל והמפענח של zstd על דוגמאות זעירות) | `rpc.ts`, `sources.worker.ts`, `sources-api.ts`, `sources-handlers.ts` (המימוש היחיד של `SourcesApi`; גם בבדיקות, בלי postMessage), `engine-job.ts`, `citations-job.ts`, `maxlink-job.ts`, `search-job.ts`, `self-check.ts` |
| `state` | `AppStore`; היסטוריה עם undo/redo ומעבר לכל נקודה בה; מטמון שורות; חיפוש בכל קורא; קישור מרבי (תכנון, הרצה, דוח חי); העדפות ופריסה; קישורי המסד בלשונית הקישורים והעתקתם לפרויקט; מבני `alt_toc`; פעולות הטווחים; יומן האבחון; ממשקי השירותים | `store.ts`, `history.ts`, `lines.ts`, `book-find.ts`, `preferences.ts`, `db-links.ts`, `maxlink.ts`, `alt-toc.ts`, `ranges.ts`, `diagnostics.ts`, `services.ts` |
| `ui` | המסכים: מסך פתיחה, סרגל עליון, סביבת עבודה, קוראים, חיפוש בקורא, בונה, רשימות, הצעות (כולל הגדרות המנועים במצב מתקדם), בדיקה, רשימת היסטוריה, חלונות ייצוא, אשף מיפוי למסד במבנה אחר, ייבוא רשומות עם מיפוי שדות, מבני `alt_toc`, מעבר מהדורה ועזרה; ערכת נושא ואייקונים | `app.tsx`, `screens/home.tsx`, `workspace/*.tsx`, `dialogs/*.tsx`, `help/`, `theme/`, `icons/` |
| `app` | נקודת ההרכבה: יוצר את ה־Worker ומחליף אותו כשהוא קורס או נתקע, מתאים אותו ל־`BooksService`, `Saver` של הורדות, אחסון IndexedDB לשמירה האוטומטית, ומרנדר | `main.tsx`, `books-service.ts` (המיפוי היחיד `BooksService` ← `SourcesApi`), `idb-store.ts` |

## 4. זרימת הנתונים

### 4.1 פתיחת קבצים

```
גרירה / בורר קבצים
  → ui/files.ts            InputFile { path, blob }  (שום דבר לא נקרא כאן)
  → AppStore.openFiles     runTask: התקדמות וביטול בסרגל העליון
  → BooksService.open      RPC אל ה־Worker
  → SourceRegistry.open    לכל קובץ: 4KiB ראשונים → detectKind
       sqlite      → DbBookSource.open   (OtzariaDbReader על blobSource: File.slice)
                     לא במבנה של אוצריא (db/no-books) → needsMapping: תצוגה מקדימה + ניחוש + אסימון
       zip         → safeUnzip → ‎.txt לספרים, ‎.json לקישורים/פרויקט
       text        → TextFilesSource (כל קובצי הטקסט של הפתיחה יחד)
       links-json / project → טקסט מפוענח, מוחזר כמסמך
       אחר         → skipped, עם סיבה בעברית
  ← OpenResult { sources (+ספרים), documents, skipped, needsMapping? }
  → AppStore: sources.value; importLinksFile / openProject לכל מסמך; הודעות
  → needsMapping: מיפוי שמור לאותה טביעת מבנה → openMapped מיד; אחרת pendingDbs → אשף המיפוי
       (ui/dialogs/db-mapping-dialog.tsx) → AppStore.openMapped → BooksService.openMapped
       → Worker: SourceRegistry.openMapped(token, mapping) → MappedDbSource (סריקה אחת אם אין אינדקס)
```

הטיפוסים של המיפוי (`DbMapping`, `SchemaPreview`, `PendingDb`) והכללים הטהורים שלו (ניחוש, בדיקה, קריאה
מ־JSON) נמצאים ב־`core/db-mapping.ts`, כדי שגם `state`, `ui` ו־`projects` יוכלו להחזיק אותם.

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

מראי מקומות (ספר אחד): AppStore.runCitations(sourceKey)
  → BooksService.runCitations → Worker: citationsJob: registry.scan (נתחים) → ההפניות והספרים שהן מציינות
  → לכל ספר מצוטט: registry.heRefs (בלי טקסט) או הכותרות → אינדקס מקומות (במטמון) → CitationRun.finish
  ← EngineResult, כמו מנוע של זוג

אצווה: AppStore.runBatch(engine, sourceId)
  → pairByTitle (linking/batch.ts): כל ספר במקור ← ספר הבסיס ששמו מופיע ב"… על <בסיס>"
  → BooksService.runBatch → Worker: batchJob מריץ engineJob זוג אחר זוג; כשל בזוג לא עוצר
  ← כל ההצעות ב־run אחד, ו־run.batch עם שורת סיכום לכל ספר

קישור מרבי: AppStore.planMaxLink(scope) → MaxLinkState.plan → planMaxLink (linking/plan.ts, טהור)
  קשר לכל ספר: book_base_text של המסד (SourceBook.bases) ← "הערות … על Y" ← "X על Y"
  שלבים: pair (headings, dibur-hamatchil לפירוש; footnotes לספר הערות) ו־single (מנוע ספר אחד)
→ AppStore.runMaxLink(plan) → BooksService.runMaxLink → Worker: maxlinkJob (זוג אחד בזיכרון; כשל בשלב לא עוצר)
  ← StepResult לכל שלב, ומפתחות הקישורים שבמסד לספרים שנקראו
→ mergeSuggestions (linking/merge.ts, טהור): כפילויות, הסכמה, הכלה, סתירה, כיול זוג ספרים מול קישורי המסד, "כבר קיים"
  ← run אחד עם run.maxlink; הדוח (buildReport) מחושב חי מול suggestionState
```

המנוע לא יוצר קישורים. "אושרה" פירושו "קיים קישור `auto:<id>`", ולכן undo מחזיר את ההצעה ל"ממתינה".
"כבר קיים" נבדק לפי `linePairKey` — הרמה "אותן שורות" של כלל השוויון האחד (`core/links/equality.ts`:
אותן שתי שורות לפי שם הספר, בכל סוג וכיוון; `linking/merge.ts` משתמש באותה פונקציה) — מול קישורי הפרויקט
(כולל קישורים שאושרו מריצה אחרת; רק אישורי הריצה הנוכחית מוחרגים) ומול קישורי המסד של ספרי הריצה
(`dbLinkKeys`). דחיות נשמרות לפי `rejectionKey` (מנוע, שמות ספרים, שורות, עוגן), שאינו
תלוי במפתחות הסשן.

### 4.5 קישורי המסד (שלב 10)

```
לשונית "קישורים" ← "קישורים מהמסד" (ui/workspace/db-links-panel.tsx)
  → DbLinksState.loadSummary(book)  → BooksService.dbLinkSummary → Worker: SourceRegistry.dbLinkSummary
       → DbBookSource.linkListing: DbLinksReader.bookLinks — מזהי הקישורים מ־idx_link_source_book
         ו־idx_link_target_book, ושורות link בהליכה אחת לפי סדר (בלי סריקת טבלה), נשמר לספר (עד 3)
       ← DbLinkSummary: לפי סוג, לפי הספר השני, לפי כיוון
  → DbLinksState.loadPage(filter)   → dbLinksPage → LinkListing.page → DbLinksReader.byIds (רק לעמוד)
  → DbLinksState.adopt(links)       → core/links/from-db.ts adoptDbLink → history.commit (פעולה אחת)
```

מקור שאין לו `linkListing` (מסד במבנה אחר) מקבל רשימה מ־`existingLinks` של כל הספר
(`listingFromLinks`); קובצי טקסט אומרים שאין להם קישורים. ל־`validation()` של `AppStore` נוספו
`linksFile` (האם קובץ הקישורים של ספר בפרויקט: כלל הייצוא של `db-copy`) ו־`existing` (כלל השוויון מול
קישורי המסד שנטענו).

### 4.6 ייצוא ובדיקה

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

ממומש: פתיחת מסדי אוצריא (0–7), מסדי SQLite במבנה אחר דרך אשף מיפוי, קובצי טקסט, תיקיות ו־ZIP; קריאה עצלה; חיפוש בטקסט הספר (ב־Worker,
`search-job.ts`); קישורי המסד כרשימה לקריאה בלבד, עם קיבוץ, סינון, תצוגה לפי שורה והעתקה לפרויקט
(שלב 10); בונה ידני עם ולידציה חיה; ארבעה מנועים אוטומטיים: כותרות, דיבור המתחיל והערות שוליים (לזוג ספרים, באצווה, או כולם יחד בקישור מרבי), ומראי מקומות (מספר אחד אל כל הספרים הפתוחים)
(תכנון לפי המסד ולפי השם, איחוד הצעות בלי כפילויות, דוח לפי ספר ושיטה), עם הגדרות במצב מתקדם; ייבוא וייצוא `_links.json`; ייבוא קישורים מ־CSV/TSV; מעבר קישורים למהדורה חדשה של ספר; בדיקת
איכות; היסטוריית פעולות; פרויקטים, שמירה אוטומטית ושחזור; עזרה בתוך הכלי (המדריך עצמו, `ui/help/markdown.ts`); מבני כותרות אלטרנטיביים (`alt_toc`), דוח
`_report.txt` ו־CSV בפורמט ספריא (`core/alt-toc/`, `formats/{alt-toc,report,sefaria-csv}/`, `state/alt-toc.ts`).

לא ממומש: — (ייבוא JSON/JSON Lines/גיליון בפורמט אחר עובר דרך מיפוי שדות, `formats/records/`; `diagnostics` מחובר: יומן אבחון ב־`state/diagnostics.ts`, נשמר מתפריט ההגדרות.) הרשימה למשתמש: [`USER_GUIDE.md`](USER_GUIDE.md#מגבלות-ידועות).

</div>
