<div dir="rtl">

# מוכנות לתוסף אוצריא (בעיה 9)

**מצב:** המנועים כבר ניתנים להרצה בלי דף, בלי מסד ובלי Worker. **לא נבנה תוסף** ולא יעד בנייה של ספרייה: המסמך
אומר מה נאכף היום, מה ידוע על ממשק התוספים של אוצריא (ומה לא אומת), ומה נשאר.

## 1. מה נאכף היום

| מה | איפה |
|---|---|
| `core`, `matching`, `linking`, `formats` לא מייבאות Preact ולא שכבה שמעליהן | `tests/unit/architecture.test.ts` ("no layer imports a layer it may not depend on") |
| אף אחת מהן לא נוגעת בגלובל של דפדפן בקוד (`document`, `navigator`, `localStorage`, `indexedDB`, `window.<חבר של דפדפן>` ועוד; הערות ומחרוזות לא נספרות) | אותו קובץ, "the headless surface" |
| `src/linking/adapters.ts` מגיע, דרך הייבואים שלו בזמן ריצה, רק אל `core`, `matching` ו־`linking` (בלי `database`, `sources`, `workers`, `state`, `ui`, בלי `.tsx`) | אותו קובץ |
| המנועים רצים דרך ממשק המתאמים בלבד, בזיכרון, ב־Node, ונותנים בדיוק את מה ש־`runEngine` נותן על אותן שורות; ההתקדמות והביטול עוברים דרך הממשק | `tests/unit/linking/adapters.test.ts` (8 בדיקות, כולל מארח שמגביל קריאה; הספרים שלו נוצרים בקוד, כמו ב־`engine-steps.test.ts`) |

## 2. ממשק המתאמים (`src/linking/adapters.ts`)

מה שהמנועים צריכים מהעולם, בטיפוסי `core` בלבד:

| נמל | תפקיד | המקבילה באפליקציה היום |
|---|---|---|
| `BooksPort` | רשימת ספרים, שורות בחלונות (`lines(key, from, to)`), שורות כותרת | `src/app/books-service.ts` (דרך ה־Worker); בבדיקה: מערכים |
| `LinksPort` | הקישורים שכבר יש למארח, לסימון "כבר קיים" (קריאה בלבד) | `BooksService.existingLinks` |
| `RefPort` | הפיכת מראה מקום למקום (ספר ושורה) | `core/links/sefaria-ref.ts` והאינדקסים של מנוע מראי המקומות |
| `SearchPort` | חיפוש טקסט בספר | `workers/search-job.ts` |
| `SavePort` | לאן הולך קובץ שהכלי יצר | `Saver` (הורדה) ב־`state/services.ts` |
| `progress`, `cancel` | התקדמות, ו־`AbortSignal` לביטול | `EngineContext` |

**`adapters.ts` אינו מחובר לשום דבר:** אף קובץ ב־`src/` לא מייבא אותו (האפליקציה קוראת ספרים דרך `BooksService` וה־Worker, ולא דרכו). הוא חוזה ובדיקה שמוכיחים שהמנועים רצים בלי DOM, בלי מסד ובלי Worker, **לא** קוד שהאפליקציה או תוסף כבר משתמשים בו; עד שיש תוסף שמייבא אותו, כל מה שנאכף כאן הוא הבדיקה.

`runPair(adapters, engine, source, target, options)` קורא את שני הספרים בחלונות של עד 200 שורות (הקריאה הבאה מתחילה אחרי השורה האחרונה שחזרה, כך שמארח שמגביל קריאה, למשל ל־50 שורות, לא גורם לדילוג על שורות; רק קריאה ריקה מסיימת ספר), ומריץ את המנוע בפרוסות
(`runEngineSliced`), כמו `engineJob` ב־Worker. **הוא לא מחליף את `BooksService`**: זה הממשק העשיר של האפליקציה
(מקורות, מיפוי, RPC). תוסף שרוצה את כל שכבת `state` (AppStore) מממש `BooksService`; תוסף שרוצה רק את המנועים מממש
את הנמלים שיש לו.

קריאה בלבד על נתוני המארח (AGENTS.md §2.3): אין נמל שכותב ספרים או קישורים לספרייה של המארח. `SavePort` מקבל
קבצים שהכלי יצר.

## 3. מה ידוע על ממשק התוספים של אוצריא

נקרא ב־2026-11-22 מ־`Otzaria/otzaria`, `docs/plugin-sdk` (`README.md`, ‏SDK 1.1, אפריל 2026; `SPEC.md`; ‏`API_REFERENCE.md`),
בענף ברירת המחדל כפי שהוא ב־GitHub באותו יום. **לא הורץ תוסף מול אוצריא** ולא נבדקה גרסה מותקנת.

**נקרא במסמכים:**

- תוסף הוא ZIP (`.otzplugin`) עם HTML/JS ב־WebView, והאובייקט הגלובלי `Otzaria` (`Otzaria.call(method, payload)`, ‏`Otzaria.on`).
  מגרסה 0.9.98 גם **תוסף בלי ממשק** (`headless`), שרץ ברקע מקובץ JS אחד.
- קריאת ספרים: `library.getBookContent` (`{ bookId, offset?, limit?, section? }`, **עד 5,000 תווים לקריאה**), `library.getBookToc`,
  `library.getBookAltToc`/`listBookAltStructures`, `library.findBooks`. הרשאות: `library.books.read`, ‏`library.content.read`.
- קישורים קיימים: `library.getRawLinks` (טווח שורות עד 1,000, מחזיר את חמשת המפתחות של `links.json`), ‏`library.getLinks`
  (עד 200 שורות), ‏`library.getLinkTargetsSummary`. הרשאה: `library.links.read`.
- חיפוש: `search.fullText`, ‏`search.query` (`search.fulltext.read`).
- כתיבה: **ספר של הספרייה הוא לקריאה בלבד** (`error.permission_denied: library books are read-only`); כתיבה מותרת רק לספר אישי
  (`fs.user_files.write`). לתוסף יש **מרחב קבצים פרטי** בלי הרשאה (`fs.writeFile`/`readFile`, מכסה 100MB, תקרה של 10MB לפעולה).
- בנייה: על לינוקס ובאנדרואיד תוסף ללא ממשק נטען כסקריפט רגיל (`file://`) **בלי מודולים**: צריך קובץ JS אחד ארוז, בלי `import`.

**מה זה אומר:** תוסף יכול לקרוא טקסט, כותרות וקישורים קיימים ולהריץ את המנועים; **אין בממשק שנקרא דרך לכתוב קישורים לספרייה**, ולכן
התוצר נשאר ייצוא (`_links.json`) למרחב הפרטי של התוסף או להורדה — כמו באפליקציה היום.

**לא אומת (אל תסמכו על זה בלי בדיקה):**

- שה"שורה" שמחזירה `getBookContent` (חלוקה לפי `offset`/`section`) זהה למספור השורות של הקישורים (`line_index`), ושאפשר לשחזר ממנה
  את `anchorText` של סכמה 7 (גופי ההערות בתוך השורה). אם לא, אופסטים של עוגנים ומנוע ההערות לא יהיו זהים לגנרטור.
- שמות המקום (`heRef`) של שורות: אין בממשק שנקרא שיטה מפורשת; ייתכן שצריך לבנות אותם מ־`getBookToc`. בלעדיהם `heRef_2` נבנה מכותרות, חלש יותר.
- ביצועים ומגבלות זיכרון של WebView/מנוע רקע מול `src/linking` (כ־1.1MB מקור, טבלאות מראי המקומות), וקצב הקריאה מול ה־rate limit של ה־SDK
  (סעיף "Rate limiting" ב־README של ה־SDK; לא נקרא לפרטים).
- שהקובץ הארוז יעמוד במגבלות הגודל של החנות.

## 4. מה נשאר (לא נעשה) — והצעד הבא, ה־harness

**הצעד הבא (3.14, נדחה בכוונה):** harness שרץ ב־Node, בלי אוצריא: `vite.lib.config.ts` ו־`src/lib/index.ts` (`runPair`, `linking/adapters`, `formats/links-json`) כ־IIFE בלי `viteSingleFile`; סקריפט שטוען את החבילה ב־`vm` עם `Otzaria.call` מדומה שמחזיר `library.getBookContent` בחלונות של 5,000 תווים ו־`library.getRawLinks`; הרצת headings על זוג מה־fixture ובדיקה שהתוצאה זהה ל־`runEngine`; וכלל ב־`architecture.test.ts` ש־`src/lib` מייבא רק שכבות טהורות. הוא יוכיח שהחבילה נטענת ורצה בסביבה בלי DOM; הוא **לא** יוכיח את מספור השורות מול `line_index`, את גודל החבילה מול מגבלת החנות ואת ביצועי ה־WebView, ואת אלה אפשר לבדוק רק מול אוצריא אמיתית.

מה שנשאר בכלל:


1. **יעד בנייה לספרייה**: תצורת Vite שנייה (`vite.lib.config.ts`), פלט JS אחד בלי `viteSingleFile` ובלי לגעת בבניית השחרור
   (תקציב 1.9MiB ב־`scripts/package-release.mjs`), עם מחסום `src/lib/index.ts` שמייצא רק את `linking/adapters`, `runEngine` ואת
   `formats/links-json`; ובדיקה ש"המחסום עולה ב־Node" (מוסיפים ל־`architecture.test.ts` כלל ש־`src/lib` מייבא רק `core`, `matching`, `linking`, `formats`).
2. **מתאם לאוצריא**: מימוש של `BooksPort` מעל `library.getBookContent`/`getBookToc` (חלונות של 5,000 תווים → שורות; לאמת את הנקודות שבסעיף 3),
   ו־`LinksPort` מעל `library.getRawLinks`.
3. **שמירה**: `SavePort` מעל `fs.writeFile` (פרטי) ומסירה למשתמש; ללא כתיבה לספרייה.
4. **Worker משלו** לתוסף: `runEngineSliced` נותן את החוט בין פרוסות, אבל בלי Worker ממשק התוסף עדיין מרגיש את זה.
5. **ADR** "המנועים כספרייה", לפני שמתחייבים על שם חבילה וגרסאות.
6. **בדיקה מול אוצריא אמיתית** (גרסה 0.9.98 ומעלה) של סעיף 3 "לא אומת".


## 5. Proof of Concept מול ה־API האמיתי של אוצריא: מה עדיין חסר (סבב התיקונים לפני מיזוג PR 3)

**אין כאן אינטגרציה.** אף קובץ ב־`src/` אינו מייבא את `linking/adapters.ts` (נבדק ב־grep, ורק הערה ב־`adapters.ts` עצמו מזכירה את המסמך הזה), אין יעד בנייה לספרייה, ושום מסך או מסמך אחר אינו אומר שיש תוסף. בעיה 9 נשארת פתוחה. מה ש־PoC אמיתי צריך להוכיח, בסדר הזה, ורק מול אוצריא מותקנת (0.9.98 ומעלה):

1. **מספור שורות.** `library.getBookContent` (חלון של עד 5,000 תווים) מול `line_index` של הקישורים: שורה ב־`getBookContent` היא שורה בקובץ הקישורים? בלי זה אופסטים של עוגנים ומנוע ההערות לא זהים לגנרטור. בדיקה: ספר אחד, 50 שורות ידועות, השוואה שורה מול שורה.
2. **`BooksPort` אמיתי** מעל `getBookContent`/`getBookToc` (חלונות של 5,000 תווים → שורות; `heRef` מהתוכן או מ־`getBookToc`), ו־`LinksPort` מעל `library.getRawLinks`.
3. **חבילה אחת בלי `import`** (IIFE) שנטענת כתוסף `headless` על לינוקס ובאנדרואיד (`file://`, בלי מודולים): `vite.lib.config.ts` ו־`src/lib/index.ts` (§4), וגודל החבילה מול מגבלת החנות.
4. **ביצועים ב־WebView או במנוע הרקע:** `runEngineSliced` על ספר אמיתי גדול, והקצב מול ה־rate limit של ה־SDK. עד שיש מדידה אין לומר שהמנועים "רצים בתוסף".
5. **שמירה:** `SavePort` מעל `fs.writeFile` (מרחב פרטי של התוסף, עד 10MB לפעולה) ומסירה למשתמש. אין כתיבה לספרייה: ספר של הספרייה הוא לקריאה בלבד.
6. **ADR** "המנועים כספרייה", לפני שמתחייבים על שם חבילה וגרסאות.

מה **לא** נעשה ולא נבדק בסבב הזה: הרצה מול אוצריא, חבילת IIFE, `Otzaria.call` אמיתי או מדומה, וחנות התוספים.

</div>
