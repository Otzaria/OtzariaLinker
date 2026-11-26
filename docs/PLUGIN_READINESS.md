<div dir="rtl">

# מוכנות לתוסף אוצריא (בעיה 9, V7 §4.15)

**מצב (V7):** יש **תשתית** לתוסף, לא תוסף מלא: ליבה בלי ממשק (`src/headless/`) מעל המנועים והפורמטים הקיימים, עם API מתועד;
מתאמים ל־`Otzaria.call` לקריאת ספרים, קריאת קישורים, חיפוש ושמירה, עם התקדמות וביטול; **חבילה נפרדת** (`npm run build:plugin` →
`dist-plugin/otzaria-linker-core.js`, סקריפט קלאסי אחד) שאינה חלק מ־`dist/OtzariaLinker.html`; harness שמדמה את `Otzaria.call`
עם המגבלות המתועדות של ה־SDK; בדיקות תאימות; דוגמת שימוש; מדידת גודל; ובדיקה מול קטלוג ה־SDK של אוצריא. **לא** נבנה ממשק לתוסף,
**לא** פורסם דבר בחנות, ו**לא** הורץ תוסף בתוך אוצריא (§6 אומר למה).

הקוד בשכבות: `src/headless/` מייבא רק `core`, `matching`, `linking`, `formats` (טהורה, בלי Preact, בלי גלובל של דפדפן). המנועים
אינם תלויים בממשק. באותה שכבה גם זיהוי מאגר ספרים בתיקיות (`repo-layout.ts`), שהמריץ ל־Node משתמש בו ([`HEADLESS.md`](HEADLESS.md)).

## 1. מה נאכף

| מה | איפה |
|---|---|
| `core`, `matching`, `linking`, `formats`, `headless` לא מייבאות Preact ולא שכבה שמעליהן | `tests/unit/architecture.test.ts` ("no layer imports a layer it may not depend on") |
| אף אחת מהן לא נוגעת בגלובל של דפדפן בקוד (`document`, `navigator`, `localStorage`, `indexedDB`, `window.<חבר של דפדפן>` ועוד; הערות ומחרוזות לא נספרות) | אותו קובץ, "the headless surface" |
| `src/linking/adapters.ts` מגיע רק אל `core`, `matching`, `linking`; `src/headless/plugin-entry.ts` (הכניסה של החבילה) רק אל `core`, `matching`, `linking`, `formats`, `headless`; ושום קובץ מחוץ ל־`headless`/`cli` אינו מייבא אותן (בניית ה־HTML לא משתנה) | אותו קובץ, "the headless surface" ו־"the plugin entry and the cli layer" |
| המנועים דרך הנמלים, בזיכרון, ב־Node, נותנים בדיוק את מה ש־`runEngine` נותן; התקדמות וביטול עוברים בנמלים | `tests/unit/linking/adapters.test.ts` (8 בדיקות) |
| אותו דבר **דרך `Otzaria.call` מדומה**: הספרים נקראים בחלונות של עד 5,000 תווים, קישורים בחלונות של עד 1,000 שורות (וחלון שנחתך נקרא שוב קטן יותר), קריאה שהוגבלה בקצב ממתינה וממשיכה, הרשאה שנדחתה היא `LinkerError` בעברית, שמירה רק למרחב הפרטי ועד 10MB, ושום קריאה שכותבת לספרייה | `tests/unit/headless/otzaria-host.test.ts` (8 בדיקות) |
| ה־API של הליבה: אישור כמו באפליקציה, "כבר קיים" מול הקישורים של המארח, וייצוא שנקרא חזרה לאותן רשומות | `tests/unit/headless/core.test.ts` (5 בדיקות) |
| החבילה: סקריפט אחד בלי `import`/`require`/רשת/גלובל של דפדפן, מתחת ל־512KiB, נטען ב־`vm` ריק ומגדיר רק `OtzariaLinkerCore`, נותן דרכו בדיוק את `runEngine`, ודוגמת השימוש רצה מלחיצה על הכפתור עד קובץ שנשמר | `tests/unit/headless/plugin-bundle.test.ts` (4 בדיקות; בונה את החבילה לתיקייה זמנית) |
| כל שיטה שהליבה קוראת קיימת ב־`spec.json` של ה־SDK, עם ההרשאה שהדוגמה מבקשת, ו־`minAppVersion` של הדוגמה מכסה אותן; הקבועים של המתאם הם המספרים שב־README של ה־SDK | `tests/unit/headless/sdk-catalog.local.test.ts` (מקומית: `OTZARIA_SRC=<עותק של Otzaria/otzaria>`) |

## 2. ממשק המתאמים (`src/linking/adapters.ts`)

מה שהמנועים צריכים מהעולם, בטיפוסי `core` בלבד:

| נמל | תפקיד | באפליקציה | בתוסף (`src/headless/otzaria-host.ts`) |
|---|---|---|---|
| `BooksPort` | רשימת ספרים, שורות בחלונות (`lines(key, from, to)`), שורות כותרת | `src/app/books-service.ts` (דרך ה־Worker) | `library.getBookMetadata`, ‏`library.getBookContent` (עד 5,000 תווים לקריאה, `rawDivineNames: true`) |
| `LinksPort` | הקישורים שכבר יש למארח, לסימון "כבר קיים" (קריאה בלבד) | `BooksService.existingLinks` | `library.getRawLinks` (עד 1,000 שורות לחלון), דרך `formats/links-json/convert.ts` |
| `RefPort` | הפיכת מראה מקום למקום | `core/links/sefaria-ref.ts` | — (לא מומש; `library.resolveRef` קיים ב־SDK) |
| `SearchPort` | חיפוש טקסט בספר | `workers/search-job.ts` | `search.fullText` |
| `SavePort` | לאן הולך קובץ שהכלי יצר | `Saver` (הורדה) | `fs.writeFile` במרחב הפרטי של התוסף (`linker/<שם>`), עד 10MB |
| `progress`, `cancel` | התקדמות, ו־`AbortSignal` לביטול | `EngineContext` | אותו דבר; כל קריאה ל־SDK בודקת את הביטול |

קריאה שהוחזרה עם `error.rate_limited` נשלחת שוב אחרי המתנה (דלי של 50 אסימונים, אסימון כל 10ms). `getBookContent` פטורה מהמגביל רק
כשההרשאה **ניתנה בפועל**, ולכן גם היא עוברת דרך אותו מנגנון.

קריאה בלבד על נתוני המארח (AGENTS.md §2.3): אין נמל שכותב ספרים או קישורים לספרייה. ספר של הספרייה הוא לקריאה בלבד גם בצד של
אוצריא (`error.permission_denied: library books are read-only`).

## 2א. ה־API של הליבה (`src/headless/core.ts`, ‏`CORE_API_VERSION` 1.0.0)

| פונקציה | מה עושה | על מה היא נשענת |
|---|---|---|
| `createLinkerCore(adapters)` | הליבה מעל הנמלים של מארח | — |
| `core.engines()` | המנועים: מזהה, שם, `pair` או `single`, תיאור | `linking/automatic` `ENGINES` |
| `core.books()` | הספרים של המארח | `BooksPort.list` |
| `core.runPair(engine, sourceKey, targetKey, options?)` | מריץ מנוע של זוג ומחזיר `{ result, exists }`: ההצעות, ומזהי ההצעות ששתי השורות שלהן כבר מקושרות אצל המארח | `runPair` (adapters), `linePairKey` (כלל השוויון היחיד) |
| `core.approve(run, { minConfidence?, ids?, already? })` | הקישורים שאישור ההצעות כותב, בלי מה שכבר קיים ובלי כפילות (`already`: מה שנבחר בריצה של מנוע אחר). ברירת המחדל: רק "ודאית" | `linking/approve.ts` — **אותו קוד** שהאפליקציה מאשרת בו (`state/suggestions.ts` הועבר אליו) |
| `core.exportFiles(links, { purpose? })` | קובצי `_links.json`, לפי כללי הייצוא. ברירת המחדל `private`: כללי הסנכרון של הספרייה הם אזהרות | `formats/links-json/export.ts` `planExport` → `validateExport` |
| `core.save(plan)` | מוסר כל קובץ ל־`SavePort` | `SavePort` |

ובחבילה (`OtzariaLinkerCore`, ‏`src/headless/plugin-entry.ts`): `forOtzaria({ books, call?, progress?, cancel? })` — הליבה מעל
`Otzaria.call` שה־SDK מזריק, בקריאה אחת; וגם `createLinkerCore`, `otzariaAdapters`, `otzariaBookKey`, `engines`, `version`,
`SDK_LIMITS`. החבילה צריכה מהסביבה רק את מה שיש בכל WebView: `setTimeout`, `performance`, `TextEncoder`, `AbortController`.

## 3. מה ידוע על ממשק התוספים של אוצריא

נקרא ב־`Otzaria/otzaria` `docs/plugin-sdk` (README, ‏`API_REFERENCE.md`, ‏`spec.json`), בעותק המקומי ב־`a6be90800` (22.11.2026),
וגם במימוש (`lib/plugins/bridge/plugin_bridge_adapter.dart`). **לא הורץ תוסף מול אוצריא.**

**נקרא במסמכים ומומש:** תוסף הוא ZIP (`.otzplugin`); `Otzaria.call(method, payload)` מחזיר `{ success, data, error }`; תוסף
`headless` (מ־0.9.98) רץ מקובץ JS אחד, ובלינוקס ובאנדרואיד בלי מודולים; `getBookContent` מחזיר מחרוזת של עד 5,000 תווים, ו־`offset`
ו־`limit` נספרים בתווים של הטקסט המסונן (לכן `rawDivineNames: true`: העוגנים נספרים על הטקסט השמור); `getRawLinks` מחזיר רשומות
1-based בחמשת המפתחות של `links.json`, בחלון של עד 1,000 שורות, נחתך אחרי 10,000 קישורים, ו־`endLine` הוא המשך תקף רק כשלא נחתך;
`fs.*` הוא מרחב פרטי (100MB, עד 10MB לפעולה); המגביל, ה־timeout של 30 שניות.

**לא אומת (אל תסמכו על זה בלי בדיקה מול אוצריא):**

- שהטקסט של `getBookContent` הוא שורות הספר מחוברות ב־`"\n"` (במימוש: `DataRepository.getBookText`), כך ששורה בו היא `line_index`
  של הקישורים. ה־harness מניח את זה.
- גופי ההערות של סכמה 7 אינם בטקסט הזה, ולכן `anchorText` של שורה עם הערות קצר מזה של הגנרטור: עוגנים על שורות כאלה ומנוע
  ההערות **אינם אמינים** בתוסף.
- אין בממשק שנקרא `heRef` לכל שורה: בתוסף `heRef` הוא `null`, והמנועים נופלים לכותרות (חלש יותר ל־`heRef_2`).
- ביצועים ב־WebView: ספר גדול נקרא כולו לזיכרון (המנועים צריכים את כולו), ו־`getBookContent` טוען ספר שלם בצד של אוצריא בקריאה
  הראשונה. לא נמדד.

## 4. החבילה וה־harness

```
npm run build:plugin        # vite.plugin.config.ts → dist-plugin/otzaria-linker-core.js (IIFE, משתנה גלובלי OtzariaLinkerCore)
npx vitest run tests/unit/headless
OTZARIA_SRC=Z:/DEV/otzaria npx vitest run tests/unit/headless/sdk-catalog.local.test.ts
```

- **גודל (26.11.2026):** 289,712 בתים, 96,332 אחרי gzip (המנועים, כולל טבלאות מראי המקומות, ו־`formats/links-json`). הבדיקה מחזיקה
  אותו מתחת ל־512KiB. ה־SDK לא מתעד תקרת גודל לחבילה; המגבלות שנבדקו הן מכסת 100MB של המרחב הפרטי ו־10MB לפעולה.
- **הבנייה נפרדת:** תיקייה משלה (`dist-plugin/`, ב־`.gitignore`), כניסה משלה, בלי `viteSingleFile`, בלי Worker, בלי WASM; לא נוגעת
  ב־`dist/OtzariaLinker.html` ובתקציב 2MiB שלו.
- **ה־harness** (`tests/support/otzaria-sim.ts`): `Otzaria.call` מדומה שמחזיק את המגבלות המתועדות ונכשל כמו שהמסמכים אומרים
  (`error.invalid_params` לחלון גדול מדי, `error.rate_limited` כשהדלי ריק, `error.permission_denied`, `error.forbidden` לנתיב מחוץ
  למרחב). הוא **מודל של המסמכים, לא של אוצריא**: מה שהמסמכים לא אומרים (§3 "לא אומת") הוא מה שהוא מניח.

## 5. דוגמת שימוש

`docs/examples/otzaria-plugin/`: `manifest.json` של תוסף `headless` (כפתור בסרגל הקורא, ההרשאות שהליבה צריכה, `minAppVersion`
0.9.98), ו־`plugin.js`: בלחיצה בפירוש "X על Y" הוא מריץ כותרות ודיבור המתחיל מול Y, מאשר את הוודאיות, ושומר את הקבצים בתיקיית התוסף.
`main.js` של התוסף הוא החבילה ואחריה `plugin.js`, בקובץ אחד:

```
npm run build:plugin
cat dist-plugin/otzaria-linker-core.js docs/examples/otzaria-plugin/plugin.js > <תיקיית התוסף>/main.js
cp docs/examples/otzaria-plugin/manifest.json <תיקיית התוסף>/
```

הדוגמה **אינה לפרסום**. היא נבדקת ב־`plugin-bundle.test.ts` מול ה־harness: לחיצה על הכפתור, הודעת הצלחה, קבצים רק בתיקיית התוסף; ספר
שאינו "X על Y" נדחה במילים בלי לקרוא דבר.

## 6. הרצה בתוך אוצריא המבודדת: לא נעשתה, ולמה

העותק המבודד (`Z:\DEV\otzaria-livetest\app`, מצב נייד; [`reviews/V7_LIVE_OTZARIA_TESTS.md`](reviews/V7_LIVE_OTZARIA_TESTS.md)) קיים,
אבל הרצת תוסף בו **לא בטוחה ולא מהירה** בסבב הזה:

- תוסף `headless` דורש שתי הרשאות שכבויות כברירת מחדל (`app.startup_contributions`, ‏`app.run_on_startup`) ואישור במסך ההתקנה, ואת
  ההפעלה עצמה — לחיצה על כפתור בסרגל הקורא. כל אלה הם נהיגה בממשק, והסבב הקודם תיעד לחיצה שנפלה על חלון אחר של המשתמש.
- התקנת תוסף כותבת למסד התוספים (`plugins_host.db`) ולתיקיית התוספים. במצב נייד אלה אמורים להיות תחת `otzaria_data`, אבל זה לא נבדק
  לתוספים (הבידוד אומת לספרייה ולהגדרות), ואימות "לפני ואחרי" מלא של `C:\ProgramData\otzaria` לא תוכנן לזה.
- מצב הפיתוח (טעינה מתיקייה, `localhost`) מחייב הפעלת כלי פיתוח באפליקציה — עוד שינוי הגדרות בממשק.

לכן ההוכחה כאן היא מול המסמכים (harness וקטלוג), ו**שלוש השאלות של §3 "לא אומת" נשארות פתוחות** עד הרצה כזו.

## 7. מה נשאר

1. **הרצה מול אוצריא אמיתית** (0.9.98 ומעלה), בעותק מבודד עם אימות לפני ואחרי: מספור השורות של `getBookContent` מול `line_index`
   (ספר אחד, 50 שורות ידועות), זמן קריאה של ספר גדול, וזיכרון ב־WebView.
2. **ממשק לתוסף** (בחירת ספרים, תצוגת ההצעות לאישור, הורדה): כאן אין. `plugin.js` הוא דוגמה בלבד.
3. **`heRef` ושורות עם הערות:** מתאם שבונה `heRef` מ־`library.getBookToc`, ובדיקה אם יש דרך לקבל את גופי ההערות.
4. **Worker** לתוסף עם ממשק: `runEngineSliced` משחרר את החוט בין פרוסות, אבל בלי Worker הממשק עדיין ירגיש ספר גדול.
5. **ADR** "המנועים כספרייה" לפני שמתחייבים על שם חבילה וגרסאות; ופרסום בחנות רק אחרי 1–2.

</div>
