<div dir="rtl">

# מדריך למפתחים

המבנה והשכבות: [`ARCHITECTURE.md`](ARCHITECTURE.md). הבדיקות: [`TESTING.md`](TESTING.md). שחרור:
[`RELEASE_PROCESS.md`](RELEASE_PROCESS.md). כללים מחייבים: [`../AGENTS.md`](../AGENTS.md) §2.

## 1. התקנה ובנייה

```
npm ci              # Node 24 ומעלה; גרסאות נעולות
npm run dev         # שרת פיתוח של Vite
npm run build       # dist/OtzariaLinker.html
```

**מה `npm run build` עושה:**

1. `vite build` בונה את `index.html` ואת `src/app/main.tsx` לקובץ אחד, `dist/index.html`:
   - `vite-plugin-singlefile` מטמיע JS ו־CSS; `assetsInlineLimit` אינסופי מטמיע גופנים ותמונות.
   - ה־Worker (`sources.worker.ts?worker&inline`) נבנה כ־IIFE ומוטמע כ־blob.
   - `build/plugins/wasm-base64.ts` מטמיע את ה־WASM של מפענח zstd כמחרוזת base64 (sql.js כבר אינו בתוצר).
   - `build/plugins/build-info.ts` מגדיר `__APP_VERSION__`, `__APP_COMMIT__` ו־`__APP_BUILD_DATE__`.
     התאריך הוא **תאריך ה־commit**, כדי שבנייה חוזרת תפיק אותם בתים. בבנייה מקומית מעץ עבודה מלוכלך,
     ל־commit נוסף `-dirty`. הגרסה וה־commit מוצגים בתחתית תפריט ההגדרות, והגרסה נכתבת גם לקובץ הפרויקט.
   - `build/plugins/license-notice.ts` כותב בראש הקובץ את הודעת ה־GPL ואת הרישיונות של כל חבילה מוטמעת.
2. `scripts/package-release.mjs` סורק את התוצר ונכשל אם יש בו משאב רשת או ממשק רשת, ואז יוצר
   `dist/OtzariaLinker.html`, `dist/OtzariaLinker-<version>.html` ו־`dist/SHA256SUMS`.

גודל התוצר כ־1MB (הסקריפט נכשל מעל 1.5MiB, `BUDGET`). רוב המשקל: שני הגופנים, ה־WASM והאייקונים.

**שרת הפיתוח** נוח לעבודה על הממשק, אבל הוא רץ מ־`http://localhost` ולא מ־`file://`. בעיות של Worker,
WASM או CSP מופיעות רק בקובץ הבנוי. לכן בודקים את התוצר: `npm run build`, ופותחים את
`dist/OtzariaLinker.html` מהדיסק, או מריצים `npx playwright test`.

## 2. מפת הקוד בקצרה

| רוצים לשנות… | איפה |
|---|---|
| מה נכתב לקובץ הקישורים | `src/formats/links-json/convert.ts` (רשומה), `serialize.ts` (בתים וסדר מפתחות), `export.ts` (קבצים ותוכנית) |
| כלל שקובע אם קישור תקין | `src/core/links/validate.ts`. הבדיקה והייצוא משתמשים באותו כלל אוטומטית |
| איך אוצריא תשמור קישור | `src/core/links/stored-form.ts`, `connection-type.ts`, `titles.ts` |
| קריאה ממסד | `src/database/otzaria/reader.ts`, `links-reader.ts`; מסד במבנה אחר: `src/database/generic/`, `src/core/db-mapping.ts`; עמודי SQLite ב־`src/database/sqlite/lazy/` |
| זיהוי קבצים | `src/sources/detect.ts`, `src/sources/registry.ts` |
| פעולת משתמש | מתודה ב־`AppStore` (`src/state/store.ts`), שקוראת ל־`apply()`, או במודול שה־store חושף: הצעות `src/state/suggestions.ts`, ייבוא וייצוא `exchange.ts`, בדיקת איכות `quality.ts`, וגם `maxlink.ts`, `db-links.ts`, `alt-toc.ts`, `ranges.ts`. מודול כזה מקבל ממשק `Host` צר ומשנה קישורים רק דרך `history.commit` |
| מסך או פאנל | `src/ui/workspace/`, `src/ui/screens/`, `src/ui/dialogs/` |
| הגדרה או פריסה | `src/state/preferences.ts`, ותפריט בסרגל העליון (`src/ui/shell/app-bar.tsx`) |
| צבעים ומידות | `src/ui/theme/tokens.css` (טוקנים בלבד), `app.css` |
| אייקונים | `src/ui/icons/icon-data.ts`: קובץ שנוצר אוטומטית, ומקורות האייקונים (Otzaria Icons, Fluent) רשומים בכותרת שלו. אין עדיין במאגר סקריפט שמפיק אותו מחדש; זה פער ידוע. אל תערכו אותו ידנית |

## 3. דיבוג

**`globalThis.__linker`.** `main.tsx` חושף את ה־`AppStore` בחלון, לדיבוג ולבדיקות E2E (הנתונים לא יוצאים
מהדף). בקונסול של DevTools:

```js
__linker.sources.value                       // המקורות הפתוחים והספרים שלהם
__linker.allLinks.value                      // כל הקישורים בפרויקט
__linker.linkState.value.undo.map(c => c.label)   // ההיסטוריה
__linker.draftProblems.value                 // למה הבונה לא מאפשר ליצור
__linker.suggestions.run.value?.result.notes // ההערות של ריצת המנוע האחרונה
__linker.prefs.layout.value                  // הפריסה
```

אפשר גם לקרוא למתודות (`__linker.undo()`, `__linker.quality.run()`, `__linker.exchange.prepareExport()`), כמו שהממשק עושה.

**האם ה־Worker עלה?** בהפעלה, `main.tsx` שולח `ping` ל־Worker ושם את התשובה ב־`<html data-engine>`:
`SQLite 3.x · בדיקת zstd` כשהכול תקין, או `שגיאה: …`. אם אין ערך כלל, ה־Worker לא עלה. זה גם מה
שבדיקת `offline-single-file.spec.ts` בודקת.

**ה־Worker עצמו** מופיע ב־DevTools כ־`blob:` (Sources ← Threads ב־Chrome). שגיאה שם חוזרת לממשק
כ־`{code, message}` דרך `src/workers/rpc.ts`, ו־`AppStore.runTask` מציג את ההודעה. קוד `cancelled`
מוצג כ"הפעולה בוטלה".

**Watchdog.** `src/app/main.tsx` מחליף את ה־Worker כשהוא זורק שגיאה לא מטופלת, או כשהוא לא עונה ל־`alive`
ארבע שניות אחרי ביטול. כל הקריאות הממתינות נדחות בקוד `worker/restarted`, ו־`AppStore.workerLost` מנקה
את המקורות ומודיע למשתמש. אם בזמן דיבוג המקורות "נעלמים", חפשו את ההודעה הזו. `tests/e2e/robustness.spec.ts`
מכסה את זה עם `tests/fixtures/db/hostile/cycle.db`.

**מצב שנשמר בדפדפן:**

| מה | איפה |
|---|---|
| העדפות ופריסה | `localStorage`, מפתח `otzaria-linker:prefs:v1` |
| שמירה אוטומטית | IndexedDB, מסד `otzaria-linker`, מאגר `kv`, מפתח `autosave:v1`; עותק שממתין להחלטת המשתמש ב־`autosave:v1:recovered` |

מחיקתם מחזירה את הכלי למצב התחלתי.

**בדיקות E2E שנכשלו:** Playwright שומר trace (`trace: "retain-on-failure"`) תחת `test-results/`. פותחים
עם `npx playwright show-trace <קובץ trace.zip>`. `SHOTS_DIR=<תיקייה>` גורם ל־`manual-linking.spec.ts`
לשמור צילומי מסך של כל שלב.

**מנוע הד"ה מול מסד אמיתי:** `DH_REPORT=<קובץ>` עם הבדיקה המקומית כותב את כל ההחטאות לקובץ
([`TESTING.md`](TESTING.md) §4).

## 4. ביצועים

מספרים שנמדדו על `seforim.db` אמיתי (4.5GB, סכמה 7), מגופי ה־commit של הקורא:

| פעולה | זמן |
|---|---|
| פתיחת המסד ורשימת 8,154 ספרים | 53ms |
| כל שורות בראשית | 61ms |
| משנה ברורה, 18,119 שורות | 567ms |
| שער הציון, 18,680 שורות עם הערות | 590ms |
| 26,959 הקישורים של בראשית א–נ | 1.1s |

מה שמחזיק את זה:
- **הקורא העצל** קורא רק עמודים שהשאילתה נוגעת בהם, ומחפש באינדקס במקום לסרוק טווח. כמה מפתחות
  ממוינים נקראים בהליכה אחת על העץ (`seekIndexMany`).
- **`LineStore`** (`src/state/lines.ts`) מביא שורות בנתחים של 200, ומחזיק עד 400 נתחים (כ־80 אלף שורות)
  לכל הספרים יחד.
- **הקורא בממשק** מרנדר נתח רק כשהוא מתקרב למסך (`IntersectionObserver` עם שוליים של 1500px), ושורות
  מחוץ למסך זולות בזכות `content-visibility: auto`.
- **רשימות ארוכות** מוגבלות: חיפוש ספרים עד 200 תוצאות; קישורים והצעות בעמודים של 300; בדיקה בעמודים
  של 200.
- **מנועים** רצים ב־Worker, אבל `engineJob` קורא את **שני הספרים כולם** לזיכרון ה־Worker. באצווה,
  `batchJob` מחזיק זוג אחד בכל פעם. ספר טקסט נשמר במטמון של עד 32 ספרים לכל מקור.
- **ההיסטוריה** שומרת רק את השינוי של כל פעולה, לא תמונת מצב, ומוגבלת ל־500 פקודות.
- **חיפוש בספר** (`searchJob`) קורא את הספר בנתחים של 500 שורות (`registry.scan`; במסד, האינדקס של
  השורות נסרק פעם אחת ולא בכל נתח), דוחה את רוב השורות בבדיקה מהירה לפני הנרמול המלא, נעצר אחרי 1,000
  תוצאות ומשחרר את ה־Worker כל 25ms כדי שביטול יגיע. נמדד: 701 השורות של ה־fixture בכ־22ms; במסד
  האמיתי משנה ברורה (18,119 שורות) ב־251ms ושער הציון (18,680 שורות, עם הערות) ב־170–250ms.

## 5. הוספת יכולות

### 5.1 מנוע אוטומטי

החוזה: [`AUTOMATION_ENGINE.md`](AUTOMATION_ENGINE.md) §1.

1. תיקייה `src/linking/automatic/<id>/` עם `index.ts` שמייצא `run<Name>Engine(source, target, options, ctx)`.
   קוד טהור: בלי DOM, בלי Preact, בלי I/O. מותר לייבא רק מ־`core` ומ־`matching`.
2. מוסיפים את המזהה ל־`EngineId` (`types.ts`), רשומה ל־`ENGINES`, ענף ל־`runEngine` ולטיפוס
   `EngineOptions` (`index.ts`). מכאן הוא מופיע בבורר של לשונית "הצעות", לזוג ספרים ולאצווה.
   האצווה מזווגת "פירוש ← בסיס" לפי השם (`src/linking/batch.ts`); מנוע שהזוג שלו אחר צריך זיווג משלו.
3. מזהה הצעה **דטרמיניסטי** מאותו קלט, כדי שאישורים ודחיות ישרדו הרצה חוזרת.
4. האופסטים של עוגן נמדדים על `EngineLine.text`, שהוא `anchorText` של השורה.
5. `ctx.progress` מדי כמה מאות פריטים, ובדיקת `ctx.signal.aborted` בלולאות.
6. נימוקים ואזהרות בעברית פשוטה, עם `code` יציב.
7. בדיקות יחידה, ובדיקה על נתונים אמיתיים (fixture או בדיקה מקומית עם `OTZARIA_DB`).
8. קישור מרבי (`AUTOMATION_ENGINE.md` §5): מנוע של **זוג** ספרים נכנס לתכנון רק כשיש לו כלל ב־
   `src/linking/plan.ts` (`PAIR_ENGINES`, `stepsFor`). מנוע של **ספר אחד** (כל מנוע רשום שאינו ב־
   `PAIR_ENGINES`) נכנס לבד, לכל ספר שנבחר, וצריך רק את ה־runner שלו ב־`SINGLE_BOOK_RUNNERS`
   (`src/workers/maxlink-job.ts`): `(registry, source, options, ctx) → Promise<EngineResult>`.

### 5.2 פורמט ייבוא

1. `src/formats/<format>/` עם פרסור שמחזיר רשומות ובעיות לכל רשומה, וקובץ המרה אחד אל המודל.
2. זיהוי לפי תוכן ב־`src/sources/detect.ts` (`DetectedKind`), עם בדיקה ב־`tests/unit/sources/detect.test.ts`.
3. ניתוב ב־`SourceRegistry.route`. מסמך טקסט חוזר ב־`OpenResult.documents`; עדכנו את הטיפוס גם
   ב־`src/state/services.ts`.
4. ניתוב ב־`AppStore.openFiles` אל `ExchangeState` (`src/state/exchange.ts`), והייבוא שם כפעולה אחת דרך `history.commit`.

### 5.3 פורמט ייצוא

`planExport` ו־`validateExport` הם המקור לשאלה "מה ייכתב". פורמט ייצוא חדש בונה על `ExportPlan.written`
ולא מפעיל כללים משלו. כתיבה דטרמיניסטית: אותו קלט, אותם בתים.

### 5.4 סוג מקור

מחלקה שמממשת `BookSource` (`src/sources/book-source.ts`): `books()`, `lines(key, from, to)` שמחזיר
`SourceLine` עם `anchorText`, `heading` ו־`existsInDb`, `existingLinks()` ו־`close()`. מפתח ספר הוא
`"<sourceId>:<id>"`. מוסיפים ערך ל־`SourceKind` (`src/core/books.ts`) ותווית ב־`sources-panel.tsx`.

### 5.5 פעולת Worker

1. חתימה ב־`SourcesApi` (`src/workers/sources-api.ts`).
2. מטפל ב־`sourcesHandlers` (`src/workers/sources-handlers.ts`, המימוש היחיד; מקבל `ctx` עם `signal` ו־`progress`).
   פעולה ארוכה חייבת לבדוק את `ctx.signal`; אחרת ה־watchdog יחליף את ה־Worker אחרי ביטול.
3. מתודה ב־`BooksService` (`src/state/services.ts`) ושורה אחת ב־`booksService` (`src/app/books-service.ts`),
   המיפוי היחיד בין השניים. האפליקציה מעבירה לו את `call()` של ה־RPC (שמחבר את ה־watchdog לביטול).
4. אין זיופים לכתוב: הבדיקות משתמשות ב־`registryService` (`tests/support/books-service.ts`), שמריץ את אותם
   מטפלים ואותו מיפוי בלי postMessage (`inProcessCall`).

### 5.6 סוג קשר

הסוגים הם ה־enum של הגנרטור (`CONNECTION_TYPES`). מוסיפים רק בסוף (המזהה במסד הוא האינדקס ועוד 1),
עם מחרוזות ב־`KNOWN`, תווית ב־`TYPE_LABELS`, ועדכון של `SOURCE_VIEW_TYPES` / `APP_DEPENDENT_TYPES` אם
צריך. סוג שהגנרטור עוד לא מכיר יישמר אצלו כ־OTHER, ולכן עדכנו קודם את
[`contracts/LINK_FORMATS.md`](contracts/LINK_FORMATS.md) §1.5.

### 5.7 הגדרה

שדה ב־`Preferences` עם ברירת מחדל ובדיקת ערך (`loadPreferences`), ופריט בתפריט בסרגל העליון. מה
שאינו העדפה אישית (קישורים, החלטות על הצעות) שייך לפרויקט ולא להעדפות.

## 6. ידע מגרסה 3 שעדיין נכון

גרסה 3 תועדה ב־[`legacy/docs-v3/`](../legacy/docs-v3/). הלקחים שעדיין חלים עברו למסמכים החדשים:
כללי הטווחים, העוגנים, `"Conection Type"`, שורות כותרת ומלכודת הגרשיים בספריא
([`USER_GUIDE.md`](USER_GUIDE.md) §14, [`../AGENTS.md`](../AGENTS.md) §3); הפלטה מזרע `#2C1B02`
(`src/ui/theme/tokens.css`); איסור פונט אייקונים ([`../AGENTS.md`](../AGENTS.md) §2.1). מה שהשתנה מאז:
[`audit/TECHNICAL_DEBT.md`](audit/TECHNICAL_DEBT.md) ו־[`contracts/OTZARIA_COMPATIBILITY.md`](contracts/OTZARIA_COMPATIBILITY.md) §6.

</div>
