# סקירה ארכיטקטונית וסקירת קוד: OtzariaLinker, ‏rewrite/v2 @ 9d90a73

<div dir="rtl">

סוקר בלתי תלוי. נבדק הקוד עצמו, ולא המסמכים או ההערות שבו. כל טענת נכונות מסומנת:
- **REPRODUCED**: שוחזרה בבדיקת vitest או בסקריפט על הקוד של ה-commit הזה.
- **READ**: נקבעה מקריאת הקוד בלבד.

קובצי השחזור נכתבו תחת `tmp-review/` ב-worktree ונמחקו בסוף. קטעי הבדיקה החשובים מובאים כאן, כדי שאפשר יהיה להפוך אותם לבדיקות רגרסיה.

היקף הסקירה: `src/state/**`, ‏`src/workers/**`, ‏`src/app/**`, ‏`src/projects/**`, ‏`src/linking/**`, ‏`src/matching/**`, ‏`src/database/**`, ‏`src/formats/**`, ‏`src/core/links/validate.ts`. בסך הכול כ-196 קבצים וכ-37.8 אלף שורות.

**איך להריץ שחזור:** לבדיקות תחת `tmp-review/<x>/` הוגדר config שמרחיב את `vite.config.ts` עם `include: ["tmp-review/<x>/**/*.test.ts"]`. מריצים מ-PowerShell, עם `Set-Location` לתיקייה באות C גדולה:

```
npx vitest run --config tmp-review/<x>/vitest.config.ts --silent=false
```

## טבלת סיכום

### באגי נכונות

| # | חומרה | תחום | בשורה אחת | אימות |
|---|---|---|---|---|
| C1 | High | undo/redo, ייצוא | "שחזור" של רשומת ספרייה שנמחקה, או עריכה שלא שינתה כלום, הופכים אותה ל-`edited`. אם יש בה שגיאה היא מוחזקת, והקובץ שנכתב מוחק אותה מהספרייה | REPRODUCED |
| C2 | High | זהות ספרים | אחרי הפעלה מחדש של ה-worker, הקישורים שומרים מפתחות `s1:7` שמצביעים עכשיו על ספר אחר. עריכה מעבירה את הקישור לספר הזר | REPRODUCED |
| C3 | High | worker, watchdog | כל בקשה שבוטלה מפעילה watchdog. חיפוש ב-Ctrl+F בזמן שמנוע רץ מפיל את ה-worker ואת המנוע. מנועים סינכרוניים אינם ניתנים לביטול בכלל | REPRODUCED (סימולציה) + READ |
| C4 | High | קובצי ספרייה (A3) | אישור "העותק שבפרויקט עדכני" נשמר לפי כותרת בלבד. הוא חל גם על פרויקט ישן שנפתח אחר כך, וייצוא מחליף את קובץ הספרייה בעותק ישן | REPRODUCED |
| C5 | High | מנוע כותרות | במצב lenient (ברירת המחדל), "פרק בא לו" נקרא כפרק 3, ושורות מקושרות "ודאי" לפרק הלא נכון | REPRODUCED |
| C6 | High | העברה למהדורה (relink) | סוף טווח עובר דרך `moves`. טווח של 3 שורות הופך ל-30, ועדיין מסומן "ודאי" | REPRODUCED |
| C7 | Medium | בדיקת ייצוא, LineStore | מעל 400 chunks, ה-cache מפנה שורות לפני הבדיקה. שגיאות "שורת כותרת" ו"לא במסד" יורדות בשקט ל-info, והקישורים נכתבים | REPRODUCED |
| C8 | Medium | LineStore | chunk שנכשל נשאר שגיאה לתמיד. chunk שהיה בדרך בזמן `forgetAll` חוזר ל-cache אחרי הניקוי | REPRODUCED |
| C9 | Medium | links-json writer | קובץ ספרייה שלא נגעו בו לא יוצא byte-identical: ‏`126.0` נכתב `126`. בסידור אשכנז יש 4,711 שורות diff | REPRODUCED (על קובץ חי) |
| C10 | Medium | פרויקטים, autosave | דחיית הצעות לא נחשבת "שינוי לא שמור", לא נכנסת ל-autosave ואין לה undo | REPRODUCED |
| C11 | Medium | טווחים | `trimBefore` חותך טווח כך שהוא נגמר על שורת כותרת, ואז אוצריא משמיטה את הטווח | REPRODUCED |
| C12 | Medium | קורא SQLite (מסד ממופה) | אינדקסים עם COLLATE NOCASE, אינדקס חלקי, מספור `sqlite_autoindex` ועמודות GENERATED. בכל המקרים שורות נעלמות בשקט | REPRODUCED |
| C13 | Medium | הצעות, maxlink | כשל בקריאת קישורי המסד נבלע (`catch {}`). ההצעות מוצגות "ממתינה" במקום "כבר קיים", ואפשר לאשר כפילויות | READ |
| C14 | Low | מסד ממופה | BLOB טקסט שמתחיל ב-"x " או "x?" מזוהה כ-zlib. העמודה נחסמת כבינארית | REPRODUCED |
| C15 | Low | טווחים | `fillRanges` חוצה כותרות פרק, וכלל המרקר שלו שונה מזה של `suggestEnd` | REPRODUCED |
| C16 | Low | ממשק, משימות | יש משבצת `task` אחת. כשמשימה ראשונה מסתיימת היא מוחקת את כפתור הביטול של משימה שנייה שעדיין רצה | REPRODUCED |
| C17 | Low | alt_toc reader | בנייה בזמן ריבועי: ‏26,609 רשומות לוקחות 3,083ms, לעומת 1.6ms עם push | REPRODUCED (מדידה) |
| C18 | Low | autosave | כל עריכה מסדרת את הפרויקט כולו ב-UI thread: ‏220–350ms ו-43M תווים, לפרויקט של 112,905 קישורים | REPRODUCED (מדידה) |
| C19 | Low | קורא SQLite | varint של 9 בתים נקרא כמספר לא מסומן. rowid שלילי שובר את `get`/`getMany` | REPRODUCED |

### תחזוקתיות

| # | חומרה | תחום | בשורה אחת |
|---|---|---|---|
| M1 | Medium | state | `AppStore` הוא god object: 1,126 שורות ו-12 אחריויות. ממשקי ה-Host הם בפועל ה-store עצמו, ומודולים כותבים ל-signals של מודולים אחרים |
| M2 | Medium | worker API | כל פעולה מוגדרת 4 פעמים: SourcesApi, ‏Handlers, ‏BooksService ומיפוי. יש טיפוסים כפולים "מבנית", ומתודות אופציונליות שקיימות רק בשביל fakes של בדיקות |
| M3 | Medium | מנועים | פונקציות-על: DH היא closure של 990 שורות, ‏CitationScanner 1,230 שורות, ‏plan.ts 886 שורות. יש גם רשימות פרמטרים פוזיציוניים ודגלים בוליאניים |
| M4 | Medium | לוגיקה משוכפלת | 7 מפרשי גימטריה עם כללים שונים, 6 בוני heRef_2, ‏4 מימושים של HtmlCharCounter ו-2 מסלולי CSV |
| M5 | Medium | טיפול בשגיאות | יש 25 `catch {}` שקטים, 4 סוגי שגיאה בקורא המסד (גם RangeError), ושני חוזי ביטול שונים במנועים |
| M6 | Medium | מודל ה-jobs | בדיקות `signal` בתוך המנועים מתות ב-worker. הוויתור על ה-CPU לא אחיד בין ה-jobs. תוצאת max-link עוברת בהודעה אחת, ואיחוד ההצעות רץ ב-UI thread |
| M7 | Low | הערות | הערות שמצדיקות התנהגות בעייתית במקום לתקן אותה, כמו ב-C7, ‏C11, ‏C13 ו-C15 |
| M8 | Low | בדיקת ארכיטקטורה | `architecture.test.ts` בודק רק specifiers סטטיים. הוא לא מזהה מעגלים בתוך שכבה, ומתיר ל-state להריץ חישוב כבד ב-UI thread |

---

## חלק א' — באגי נכונות

### C1 — High — שחזור או עריכה "ריקה" של רשומת ספרייה מוחקים אותה מהספרייה בייצוא

**מיקום:**
- `src/state/history.ts:214-217` ‏(`restoreChange`): ‏`status: before.keyOrder ? "edited" : "new"`.
- `src/state/history.ts:199-204` ‏(`editChange`) מסמן `existing→edited` בלי לבדוק אם משהו השתנה.
- `src/core/links/validate.ts:271-274` ‏(`asExported`) מוריד שגיאה לאזהרה רק כשהסטטוס הוא `existing`.
- `src/formats/links-json/export.ts:55-62` מחזיק בצד רשומה שיש בה error.

**שחזור (REPRODUCED):**
- הקלט: קובץ ספרייה עם שתי רשומות. לראשונה יש `heRef_2: ""`, שזו שגיאה `export/heref-missing` (גם רשומות ישנות בספרייה נראות כך).
- `planExport` לפני השינוי: 2 רשומות נכתבות. נכון, כי "רשומה שלא נגעו בה נכתבת כמו שהיא".
- `deleteChange("f0")` ואחריו `restoreChange("f0")`: הסטטוס הופך ל-`edited`. ‏`planExport` כותב רשומה **אחת**, ו-f0 מוחזקת בגלל `export/heref-missing`.
- `editChange(s, "f0", { declaredType: "commentary" })`, כלומר אותו סוג בדיוק (למשל "שינוי סוג" על בחירה מעורבת): אותה תוצאה, רשומה אחת נכתבת.

```ts
s = commit(s, "delete", [deleteChange(s, "f0")!]);
s = commit(s, "restore", [restoreChange(s, "f0")!]);
planExport([...s.links.values()], ctx).files[0].records  // 1, expected 2
```

**סיבה:** המצב "existing" מקודד בשדה `status` בלבד. ‏`delete` דורס אותו ל-`deleted`, ו-`restore` מנחש `edited` לפי `keyOrder`. ‏`editChange` לא משווה בין before ל-after.

**השפעה:** הקובץ שנכתב **מחליף** את קובץ הספרייה, ולכן רשומה שהמשתמש לא שינה נמחקת מהספרייה. ה-UI מציג אותה כ"מוחזקת", ומשתמש סביר יבין מזה "לא נכתבה, נשארת כמו שהיא", אבל היא נמחקת. הכלל הזה סותר את AGENTS.md §3: "רשומה מיובאת שלא נגעו בה נכתבת גם כשיש בה שגיאה".

**תיקון:**
- `deleteChange` ישמור את הסטטוס הקודם (`{ status: "deleted", wasStatus }`), ו-`restoreChange` יחזיר אותו.
- `editChange` (וגם `store.createFromDraft`/`dropAnchors`/`ranges.ts:134`/`relink.ts:139`) יחזיר `null` כשהרשומה זהה לפי `linkToRecord`. עדיף לחשב את `existing` מהשוואה לרשומה המקורית (`fileIndex` + טקסט מקורי) ולא מסטטוס.

**בדיקת רגרסיה:** שני המקרים שלמעלה. אחרי `restore` או עריכה "ריקה", ‏`planExport` כותב 2 רשומות, ו-`counts.kept === 2`.

**סטטוס:** תוקן ב־71fd320, בדיקה: `tests/unit/formats/export.test.ts`, ‏`tests/unit/state/history.test.ts`

---

### C2 — High — מפתחות סשן ישנים אחרי הפעלה מחדש של ה-worker: עריכה מעבירה קישור לספר אחר

**מיקום:**
- `src/state/store.ts:346-360` ‏(`workerLost`) מנקה מקורות אבל משאיר את הקישורים עם `book.key` כמו `"s1:7"`.
- `src/sources/registry.ts:277-279`: ‏`nextId()` = `s${++seq}`, ו-worker חדש מתחיל שוב מ-`s1`.
- `src/sources/db/db-source.ts:194-196`: מפתח ספר = `${sourceId}:${bookId}`.
- `src/state/store.ts:391-393` ‏(`bookOf`) מחפש קודם לפי key.

**שחזור (REPRODUCED, ב-AppStore עם service מזויף):**
1. פותחים `official.db` (מקבל s1, ספר 7 = "ספר א") ו-`personal.db` (מקבל s2, ספר 7 = "ספר זר"). יוצרים קישור "ספר א" → "ספר ב".
2. `store.workerLost(...)`, כמו ב-watchdog, ו-seq מתאפס.
3. פותחים שוב, הפעם את `personal.db` ראשון.
   - `bookOf(link.source.book)` מחזיר את **"ספר זר"**, והקישור עדיין אומר "ספר א".
4. `editInBuilder(id)` ואחריו `createFromDraft()` (למשל כדי לשנות סוג) מחזירים קישור **"ספר זר" → "ספר אחר"**.

**השפעה:**
- **עריכה:** הקישור עובר בשקט לספר אחר ולכותרת אחרת, ונכתב כך בייצוא.
- **עוד לפני עריכה:** סימוני הקורא, `validation()` (עובדות שורה, כותרת), ‏`isSefariaOwned` ו-relink עובדים על הספר הלא נכון.
- **הקשר ל-C3:** C3 מגביר את התדירות, כי כל ביטול של מנוע שרץ יותר מ-4 שניות מפעיל את ה-worker מחדש.

**תיקון:**
1. ב-`workerLost`: ‏`rebindLinks` לכל הקישורים, ל-`unresolved:<title>`. זו אותה פעולה ש-`openProject` עושה, ו-`attachLinks` כבר יודע לקשור אותם מחדש.
2. מזהי מקור ייחודיים גלובלית, למשל `s${generation}.${seq}` או מזהה אקראי, שה-UI ימסור ל-worker ב-`open`.
3. לנקות גם את `pick`/`editing` ואת `suggestions.run`, כי גם בהם יש מפתחות.

**בדיקת רגרסיה:** התרחיש שלמעלה. אחרי `workerLost` ופתיחה בסדר הפוך, ‏`bookOf(l.source.book)?.title === l.source.book.title`, ועריכה שומרת על "ספר א".

---

### C3 — High — ה-watchdog מפיל את ה-worker בכל ביטול, גם של בקשה שלא קשורה; מנוע סינכרוני לא ניתן לביטול

**מיקום:**
- `src/app/main.tsx:41-50`: ‏`call()` רושם `watchdog` על ה-`abort` של **כל** signal. ה-watchdog שולח `alive` ומפעיל מחדש אם אין תשובה תוך 4 שניות.
- `src/state/book-find.ts:36,48-52`: כל חיפוש חדש מבטל את הקודם.
- `src/workers/engine-job.ts:7-17` ו-`src/linking/automatic/index.ts:71`: ‏`runEngine` סינכרוני לגמרי.
- `src/workers/sources-handlers.ts:26`: ‏`diffBooks` בכלל לא מקבל ctx.

**שחזור (REPRODUCED בסימולציה):**
- ה-worker המזויף הוא חוט יחיד: בזמן שמנוע סינכרוני רץ, שום הודעה לא מטופלת.
- הקוד של `startWorker`/`restartWorker`/`watchdog`/`call` הועתק מ-`main.tsx` כמו שהוא.
- המהלך:
  1. מנוע שלא בוטל רץ 6 שניות.
  2. המשתמש מקליד ב-Ctrl+F. החיפוש הקודם, שעוד ממתין בתור, מבוטל.
  3. התוצאה: `['lost: הפעולה שבוטלה לא נעצרה…', 'engine failed: worker/restarted']`.
- המנוע שהמשתמש **לא** ביטל נהרג, וכל המקורות הפתוחים נסגרים.
- תיבת החיפוש אינה מושבתת בזמן משימה (`store.task` לא נבדק ב-`book-find.tsx`/`reader.tsx`).

**קריאה (READ):**
- ב-worker, הודעת `cancel` מטופלת רק כשה-event loop פנוי. מנוע סינכרוני (DH על זוהר: 157 שניות לפי התיעוד) לא מוותר על ה-CPU, ולכן `ctx.signal.aborted` בתוך המנועים לעולם לא true בזמן ריצה ב-worker.
- המשמעות: כל "ביטול" של מנוע שרץ יותר מ-4 שניות הוא הפעלה מחדש של ה-worker, כולל אובדן המקורות, ומוביל ל-C2.
- תוצאות חלקיות (`engine/aborted`) לא מגיעות לממשק אף פעם.

**סיבה:** ה-watchdog מניח ש"בקשה בוטלה" פירושו "ה-worker תקוע בגללה". בפועל הבקשה רק ממתינה בתור מאחורי job אחר.

**תיקון:**
- להפעיל watchdog רק כשהבקשה שבוטלה היא **הבקשה שרצה עכשיו** ב-worker (ה-worker יחזיר `started` עם id). לבקשה שעוד בתור מספיק לשלוח cancel ולמחוק אותה מהתור.
- watchdog אחד לכל ביטול, ולא listener לכל call שחולק signal.
- להריץ מנועים בפרוסות עם ויתור על ה-CPU, למשל `await` של `setTimeout(0)` כל N שורות, כמו ב-citations-job.
- לחלופין, worker נפרד למנועים, כדי שהפעלה מחדש שלו לא תסגור את המקורות.

**בדיקת רגרסיה:**
- הסימולציה שלמעלה: המנוע מסתיים בהצלחה, ואין `lost`.
- בדיקה שביטול של חיפוש שממתין בתור לא קורא ל-`restartWorker`.

---

### C4 — High — אישור "העותק שבפרויקט עדכני" דולף בין פרויקטים ועוקף את ההגנה A3

**מיקום:**
- `src/state/db-links.ts:261-266`: ‏`linksFile` מחזיר `confirmed-new` לפי `newFileOk.has(title)` עוד **לפני** הבדיקה `if (f) return "unverified"`.
- `src/state/db-links.ts:272-277`: האישור הוא signal מחוץ ל-`LinkState`. אין לו undo, והוא לא מתאפס ב-`openProject`.

**שחזור (REPRODUCED):**
1. `openProject(P1)`, עם עותק של 3 רשומות של קובץ "ספר א". המצב: `unverified`.
2. `confirmNewFile("ספר א")`, כמו בחלון הייצוא.
3. `openProject(P0)`: פרויקט או autosave ישן, עם עותק של רשומה **אחת** של אותו קובץ.
4. `linksFile("ספר א")` מחזיר `confirmed-new`. ‏`planExport` כותב `ספר א_links.json: 1 records`, ו-`held: 0`.

**השפעה:** ייצוא מחליף את קובץ הספרייה בעותק ישן, ומוחק את כל הרשומות שנוספו מאז. זה בדיוק התרחיש ש-A3 נועד לחסום. אותו דבר קורה אחרי undo של ייבוא הקובץ.

**תיקון:** לקשור את האישור לטביעת האצבע (`LibraryFile.hash`) של העותק שאושר, ולשמור אותו כ-`FileChange` בתוך `LinkState` (כלומר עם undo). ‏`openProject` ינקה אישורים של כותרות שהעותק שלהן הוחלף.

**בדיקת רגרסיה:** התרחיש שלמעלה מחזיר `unverified`, ו-`export/file-unverified` מחזיק את הקובץ.

**סטטוס:** תוקן ב־843bd19, בדיקה: `tests/integration/state/library-file.test.ts`

---

### C5 — High — מנוע הכותרות קורא שמות פרקים כמספרים (lenient, ברירת המחדל) ומקשר "ודאי" לפרק הלא נכון

**מיקום:**
- `src/linking/automatic/headings/numbering.ts:124-147` ‏(`parseNumeral`) ו-`:214`.
- ברירת המחדל: `headings/index.ts:88` ו-`option-specs.ts:67`.

**שחזור (REPRODUCED):**
- הקלט: פירוש על משנה יומא, עם הכותרות "פרק א", ‏"פרק ב" … "פרק בא לו". בבסיס יש "פרק א" עד "פרק ח".
- **lenient:** שורות מתחת ל"פרק בא לו" מקושרות ל"משנה 3-1" ו"משנה 3-2" עם `certain`.
- **strict:** אין הצעה.

`parseHeading` במצב lenient:

| כותרת | נקראת כ- |
|---|---|
| "פרק במה מדליקין" | 47 |
| "פרק כל כתבי" | 50 |
| "פרק אלו טריפות" | 37 |
| "פרק גיד הנשה" | 17 |
| "פרק אין עומדין" | 61 |

**סיבה:** אחרי מילת "פרק", כל מילה של עד 4 אותיות נקראת כגימטריה, ושאר הכותרת נזרק כ"כותרת משנה".

**השפעה:**
- "אישור כל הוודאיות" מאשר קישורים שגויים בבת אחת. מקרים אמיתיים: יומא פרק ז "בא לו" ונדה פרק ו "בא סימן".
- מנוע DH קורא את אותה כותרת כשם (`windows.ts headingNumber`), כך שהמנועים חלוקים זה על זה.

**תיקון:** במצב lenient לקבל ספרה לא קנונית רק כשהיא מסיימת את הכותרת, או כשאחריה מפריד (`-`, ‏`:`) או מילת סוג נוספת. אחרת לקרוא את הכותרת כשם. אפשר גם לצמצם את lenient לצורות המתועדות בלבד: יה, יו, ער, רחצ.

**בדיקת רגרסיה:** `parseHeading("<h2>פרק בא לו</h2>")` מחזיר אלמנט שם, וזוג יומא שלמעלה לא נותן `certain` מקטע "בא לו".

---

### C6 — High — relink מותח טווח שסופו זז, ומשאיר אותו "ודאי"

**מיקום:** `src/linking/relink.ts:93-110` ‏(`moveSide`). סוף הטווח עובר דרך `relocated(side.end)`, כלומר דרך `moves`, ומתקבל אם `e > to` (שורה 97).

**שחזור (REPRODUCED):**
- הקלט: 40 שורות ייחודיות. במהדורה החדשה שורה 12 הועברה לסוף הספר.
- `findMoves` מחזיר `[[12,39]]`.
- קישור עם יעד 10..12 מקבל `verdict: "certain"`, יעד 10..**39**, והסיבה "השורה זהה במהדורה החדשה".

**סיבה:**
- ההעברה דרך `moves` היא לשורות שזזו מחוץ לסדר, ובכל זאת היא משמשת לסוף הטווח.
- השורות שבתוך הטווח לא נבדקות.

**השפעה:** הכפתור "העברת הבטוחים" (`store.applyRelink`) מחיל את כל ה-certain בבת אחת, וטווח של 3 שורות הופך בשקט לטווח של 30.

**תיקון:**
- לסוף הטווח להשתמש רק במיפוי המונוטוני `mapping.to`.
- לדרוש שאורך הטווח החדש יהיה קרוב לאורך הישן.
- להוריד ל-review כששורה פנימית נמחקה, השתנתה או זזה.

**בדיקת רגרסיה:** התרחיש שלמעלה נותן `review`, או סוף 11, ואף פעם לא `certain` עם 39.

---

### C7 — Medium — מעל 400 chunks, בדיקת הייצוא מאבדת את עובדות השורות ומורידה שגיאות ל-info בשקט

**מיקום:**
- `src/state/lines.ts:12,45-49`: ‏`MAX_CHUNKS = 400`, עם פינוי FIFO. גישה ל-chunk לא מרעננת אותו, אף שההערה אומרת "most recently used".
- `src/state/store.ts:781-807` ‏(`loadLinkLines`) טוען chunk אחרי chunk.
- `src/state/store.ts:895-903` ‏(`validation().line` עם `lines.peek`).
- `src/core/links/validate.ts:197`: עובדה חסרה הופכת ל-`info` בשם `export/line-not-verified`.
- גם `dbLinks.matchDb` (`existingPeek`) ו-`fillSefariaRefs` נשענים על אותו cache.

**שחזור (REPRODUCED, ב-AppStore עם service מזויף):**
- ספר של 200,000 שורות, שבו כל שורה ה-200 היא כותרת.
- 500 קישורים, כל אחד אל שורת כותרת ב-chunk אחר, כלומר 1,000 chunks נדרשים בסך הכול.
- אחרי `loadLinkLines` ואז `validateExport(..., store.validation())`, רק **400** קישורים מקבלים `export/heading-line`. ‏100 האחרים מקבלים info ונכתבים.

**השפעה:**
- בפרויקט גדול, למשל אחרי max-link על ספרייה, קישורים לשורות כותרת או לשורות שאינן במסד נכתבים בלי שגיאה, ואוצריא משמיטה אותם.
- גם "כבר קיים במסד" (`export/in-db`) לא נבדק.
- זה סותר את "a link with an error is held back (never written silently)".

**תיקון:**
- הבדיקה לא צריכה לעבור דרך cache של תצוגה. אפשרות אחת: `loadLinkLines` יחזיר מפה פרטית של עובדות (`LineFacts`) לכל הקצוות, ו-`validation()` יקבל אותה.
- אפשרות שנייה: לנעול (pin) את ה-chunks עד סוף הבדיקה.
- ב-LRU, לרענן גם ב-`state()`.

**בדיקת רגרסיה:** התרחיש שלמעלה מחזיר 500 מתוך 500.

---

### C8 — Medium — LineStore: שגיאה נדבקת לתמיד, ו-chunk שהיה בדרך חוזר ל-cache אחרי `forgetAll`

**מיקום:**
- `src/state/lines.ts:28-51` ‏(`ensure`/`put`): ה-promise מבצע `put` גם אחרי `drop`.
- `src/state/lines.ts:101-106` ו-`:132-136`: ‏`line()`/`existingAt()` טוענים רק כשאין state, ולכן chunk במצב error לא נטען שוב לעולם.
- `src/ui/workspace/reader.tsx:315-318` מציג את השגיאה, בלי כפתור "נסו שוב".

**שחזור (REPRODUCED):**
1. `line("s1:5", 3)` מתחיל טעינה. ה-worker עסוק ב-job, ולכן הבקשה ממתינה.
2. `restartWorker`: ‏`failAll` דוחה את הבקשה, ואז `forgetAll()`.
3. ה-rejection מגיע ב-microtask **אחרי** הניקוי ומבצע `put(error)`.
4. המשתמש פותח שוב את המסד, ושוב מקבל s1, כמו ב-C2. ‏`errorAt("s1:5", 3)` מחזיר "הפעולה שבוטלה לא נעצרה…". ‏`fetches: 1`, כלומר אין ניסיון חוזר.

**השפעה:**
- אחרי ביטול של משימה ארוכה (C3), חלקים מהספר שנפתח מחדש מציגים "שגיאה בטעינת שורות" עד שה-chunk מפונה.
- כל שגיאה חולפת, כמו קריאת Blob שנכשלה, נשארת לתמיד.

**תיקון:**
- מונה דור (`generation`) ב-`ChunkCache`, ש-`drop` מקדם. ‏`put` של דור ישן לא יירשם.
- מצב error יקבל `retryAfter`, או ש-`line()` יטען שוב chunk במצב error.

**בדיקת רגרסיה:** התרחיש שלמעלה מחזיר `errorAt === null`, ו-`line()` טוען מחדש.

---

### C9 — Medium — קובץ ספרייה שלא נגעו בו לא יוצא byte-identical

**מיקום:**
- `src/formats/links-json/parse.ts:81-94` ו-`convert.ts:200,242,262-270`: המודל שומר את הערך המספרי בלבד.
- `serialize.ts`.
- מסווג הבדיקה: `tests/validation/library-links.test.ts:240-256`.

**שחזור (REPRODUCED, על הקובץ החי `otzaria-library/MoreBooks/links/סידור אשכנז_links.json`, ‏2,932 רשומות):**
- parse → `recordToLink` → `linkToRecord` → `serializeLinksJson(detectLayout)` נותן **4,711 שורות שונות**, כולן מהצורה `"line_index_1": 71.0` שהופך ל-`71`.
- בכל עותק הספרייה: ‏459,381 ערכי `.0` ב-352 קבצים.
- בנוסף, ברשומה סינתטית: `line_index_1: 0` נכתב כ-1, ‏`_end` שאינו אחרי ההתחלה נמחק, ו-`start: 4.5` נכתב כ-4.

**למה זה לא נתפס:** `docs/validation/REAL_DATA_REPORT.md` מסווג את הקבצים האלה כ"סדר מפתחות אחר". המסווג משווה ערכים אחרי `JSON.parse`, ושם `126.0 === 126`.

**השפעה:**
- `planExport` כותב מחדש כל קובץ מיובא, ולכן PR לספרייה יכיל diff רעש של אלפי שורות.
- זה סותר את החוזה "קובץ שלא נגעו בו חייב לצאת byte-identical".

**תיקון:**
- לשמור לכל רשומה מיובאת את טקסט ה-JSON הגולמי שלה (או לפחות את הטוקן המספרי), ולכתוב אותו כמו שהוא כשהסטטוס הוא `existing`.
- לתקן את המסווג כך שיזהה number-format לפני key-order.

**בדיקת רגרסיה:** fixture עם `126.0`, הזחה של 4 ו-`line_index_1: 0`. ‏`planExport` ללא שינויים מחזיר טקסט זהה.

**סטטוס:** תוקן ב־34e0771, בדיקה: `tests/unit/formats/links-byte-identical.test.ts`. התיקון שונה מההצעה: טקסט גולמי נשמר רק לרשומה שהכותב היה מאיית אחרת (ולא לכל רשומה, כדי לא להכפיל את גודל הפרויקט), ו־`floatKeys` בצורת הקובץ מכסה את 351 הקבצים שכל המספרים שלהם `N.0`. הטקסט נכתב כשהוא מפוענח בדיוק לרשומה שהקישור כותב עכשיו, ולא לפי `status === existing`, כי סטטוס לבדו אינו מגן מטקסט ישן או מזויף. בדיקה 3 על הספרייה: 6,875 → 7,228 קבצים זהים (החיים: 750 → 752).

---

### C10 — Medium — דחיית הצעות לא "מלכלכת" את הפרויקט, לא נשמרת ב-autosave ואין לה undo

**מיקום:**
- `src/state/suggestions.ts:262-274`: ‏`reject`/`reset` כותבים ל-`rejected` מחוץ ל-`LinkState`.
- `:256`: ‏`approve` מוחק דחיות, גם זה מחוץ להיסטוריה.
- `src/state/store.ts:154`: ‏`dirty` לפי `revision` בלבד.
- `store.ts:1027-1041`: ה-autosave מאזין ל-`revision` בלבד.
- אותו דבר נכון ל-`dbMappings` ול-`libraryOverrides`, שגם הם נשמרים בפרויקט.

**שחזור (REPRODUCED):** אחרי ש-300 דחיות נכתבות, `{ dirty: false, autosaves: 0, inProjectText: 300 }`.

**השפעה:**
- סגירת הלשונית לא מזהירה (`app.tsx:40`), וה-autosave לא שומר. עבודה של שעה על סינון הצעות אובדת.
- Ctrl+Z לא מבטל דחייה.
- undo של אישור לא מחזיר את הדחייה שה-approve מחק.
- כל זה סותר את הכלל (AGENTS §2.5) ש"כל פעולת משתמש היא פקודה אחת שאפשר לבטל".

**תיקון:** להכניס את `rejected` (וגם `dbMappings`/`libraryOverrides`) ל-`LinkState`, כמו שנעשה ל-`altToc`/`files`: ‏`Command.rejections` עם before/after. כך `revision` מתקדם, ו-autosave, ‏dirty ו-undo עובדים אוטומטית.

**בדיקת רגרסיה:** `reject` מסמן dirty, autosave נכתב, ו-`undo` מחזיר את ההצעה ל-pending.

**סטטוס:** תוקן ב־c20f17d, בדיקה: `tests/integration/state/store.test.ts`

---

### C11 — Medium — `trimBefore` חותך טווח כך שהוא נגמר על כותרת

**מיקום:**
- `src/linking/ranges.ts:89-99`: ‏`trimBefore` לא קורא ל-`backFromHeading`.
- `src/state/ranges.ts:62-68`: ‏`trimFor` מעביר `headings: new Set()`, עם ההערה "it needs no headings".

**שחזור (REPRODUCED):**
- קישור עם טווח 10..59, וכותרת בשורה 50.
- נוצר קישור חדש בשורה 51, השורה שאחרי הכותרת, שהיא המקום הנפוץ ביותר לפתוח קישור.
- הטווח הקודם מקוצר ל-50, שהיא שורת הכותרת. גם עם הכותרות האמיתיות מתקבל 50.

**השפעה:**
- אוצריא משמיטה טווח שנגמר על כותרת (`validate.ts:205` ‏`export/range-end-heading`), ומשאירה קישור לשורה אחת.
- הטווח שהמשתמש בנה אובד בשקט, כחלק מצעד ה-undo של יצירת הקישור.

**תיקון:** `backFromHeading` ב-`trimBefore`, ו-`trimFor` ישתמש ב-`RangesState.headingCache`.

**בדיקת רגרסיה:** `trimBefore([10..59], {50}, 51)` מחזיר סוף 49.

---

### C12 — Medium — הקורא העצל משתמש באינדקסים שאין לו דרך להשתמש בהם נכון (מסד ממופה)

**מיקום:**
- `src/database/sqlite/lazy/ddl.ts:146-155` ‏(`parseCreateIndex`) ו-`:169-188` ‏(`parseColumn`).
- `sqlite-file.ts:137-139` ו-`:275-277` ‏(`alignRow`).
- `record.ts:90-117` ‏(`compareUtf8`).
- המשתמש: `src/database/generic/mapped-reader.ts:185,279,466`.

**שחזור (REPRODUCED, מסדים שנבנו ב-sql.js):**

| מקרה | SQLite מחזיר | הקורא מחזיר |
|---|---|---|
| R1: `book TEXT COLLATE NOCASE` עם אינדקס `(book, ord)` | 2 שורות לספר 'B' | `[]` |
| R2: `CREATE INDEX … WHERE level IS NULL` | 3 שורות (כולל הכותרת) | 2, הכותרת נעלמה |
| R3: ‏`uid TEXT UNIQUE` לפני `PRIMARY KEY(book, ord)` | `autoindex_1` הוא `uid` | ה-PK, ו-0 שורות לכל ספר |
| UTF-16le עם מפתחות 'é' ו-'א' | שורות לשני הספרים | שני ספרים ריקים |
| עמודת `GENERATED ALWAYS AS … VIRTUAL` | `[1,1,2,"hello"]` | `[1,1,"hello",null]` (עמודות זזות) |

**סיבה:**
- collation של עמודה, WHERE של אינדקס חלקי, סדר האילוצים ב-DDL, קידוד המסד ועמודות VIRTUAL לא מפוענחים.
- הקורא מניח BINARY, אינדקס מלא, `autoindex_1` = PK ו-UTF-8.

**השפעה:** במסד הרשמי (UTF-8, בלי COLLATE ובלי WHERE) אין פגיעה. אבל באשף המיפוי של "מקורות אוניברסליים" ספרים שלמים או שורות נעלמים, **בלי שום אזהרה**.

**תיקון:**
- לסמן אינדקס כלא-seekable (וגם לא לסריקה) כשיש WHERE, ‏collation שאינו BINARY, ‏DESC, או יותר מאילוץ ייחודיות אחד בלי מיפוי מדויק.
- להעביר את ה-encoding ל-`compareValues`.
- לדלג על עמודות VIRTUAL ב-`alignRow`.
- כשהקורא לא בטוח, לסרוק את הטבלה ולא להשתמש באינדקס.

**בדיקות רגרסיה:** חמשת המקרים שבטבלה, כל אחד מול `SELECT` של sql.js.

**סטטוס:** תוקן ב־b43b766, בדיקה: `tests/integration/database/sqlite-features.test.ts`. NOCASE, אינדקס חלקי ו־DESC: האינדקס אינו בשימוש (סריקה). מספור `sqlite_autoindex` ממומש כמו ב־SQLite ונבדק מול `PRAGMA index_xinfo` (28 אינדקסים). UTF-16 ועמודות STORED נתמכים. עמודה VIRTUAL נקראת NULL, ומיפוי שלה נדחה בעברית, וכך גם טבלת WITHOUT ROWID שהמפתח שלה NOCASE או DESC.

---

### C13 — Medium — כשל בקריאת קישורי המסד נבלע, והצעות שכבר קיימות מוצגות כחדשות

**מיקום:**
- `src/state/suggestions.ts:218-226` ‏(`loadDbLinkKeys`).
- `src/workers/maxlink-job.ts:213-220` (וגם `:105`, ‏`:323`).
- `src/workers/citations-job.ts:116,198`.

**קריאה (READ):**
- `catch { /* a source without links (text files) or a read error: nothing to compare with */ }`.
- ההערה עצמה אומרת ששגיאת קריאה, למשל `db/corrupt`, ‏`worker/restarted` או ביטול, נבלעת.
- `dbLinkKeys` נשאר ריק, ולכן `SuggestionsState.state` מסמן "pending" במקום "exists" לכל הצעה שכבר יש במסד.

**השפעה:**
- "אישור כל הוודאיות" יוצר כפילויות של קישורים שכבר בספרייה. הייצוא מזהיר על זה רק אם ה-chunks טעונים (C7).
- ב-max-link, ‏`partByLinks` ו-`linkedLines` הופכים שגיאה ל"אין חלק" ול"אין מה להעביר", בלי הערה בדוח.

**תיקון:**
- `registry.existingLinks` יחזיר `DbLinksUnavailable` מפורש למקור בלי קישורים, כמו `dbLinkSummary`, ויזרוק רק על שגיאה אמיתית.
- הקוראים יבדילו בין המקרים: מקור בלי קישורים הוא תקין. על שגיאה צריך הודעה, ולהשבית את "אישור הכול".

**בדיקת רגרסיה:** service ש-`existingLinks` שלו זורק `db/corrupt`. ‏`runEngine` מציג אזהרה, ו-`approve` של הוודאיות נחסם או מזהיר.

**סטטוס:** תוקן ב־6e9f06b (במצב, ובחלונית ההצעות; ה-workers של max-link וציטוטים לא בתחום הזה), בדיקה: `tests/integration/state/store.test.ts`

---

### C14 — Low — ‏BLOB של טקסט שמתחיל ב-"x " מזוהה כ-zlib

**מיקום:** `src/database/generic/text-codec.ts:22` ‏(`blobKind`).

**שחזור (REPRODUCED):**
- `blobKind` מחזיר `zlib` עבור `"x y…"`, ‏`"x^2 + 1"`, ‏`"x?"` ו-`"x} y"`.
- `decode("x marks the spot")` זורק `db/compressed-corrupt`.
- `previewSchema` מסווג את העמודה כ-binary, ו-`mappingProblems` חוסם את המיפוי.

**סיבה:** הבית 0x78 ואחריו בית FLG שמקיים `%31==0` מתאימים בדיוק לתווי ASCII נפוצים. בנוסף, המונה `undecodable` לא מוצג בשום מקום.

**תיקון:** לסווג zlib רק אם inflate הצליח. אם נכשל ואם הבתים הם UTF-8 תקין, להחזיר טקסט. לדווח את `undecodable` כאזהרה.

**בדיקת רגרסיה:** `decode` של `"x marks the spot"` מחזיר את הטקסט.

**סטטוס:** תוקן ב־3a95dc4, בדיקה: `tests/unit/database/text-codec.test.ts`. "inflate הצליח" לבדו אינו מספיק: fflate אינו בודק את ה־Adler-32, ו־`"x^ab"` נפרס למחרוזת ריקה. לכן zlib מזוהה רק כשגם סכום הביקורת תואם. המונה `undecodable` עדיין אינו מוצג (צריך ערוץ אזהרות מאוחר מה־worker).

---

### C15 — Low — ‏`fillRanges` חוצה כותרות פרק ומשאיר טווח חופף

**מיקום:** `src/linking/ranges.ts:112-126`. הוא משתמש רק בתחילות קישורים כמרקרים, בניגוד לכותרת הקובץ (שורות 6-9) ול-`suggestEnd`.

**שחזור (REPRODUCED):**
- כותרות {0, 20, 50}, וקישורים ב-10 וב-60: ‏`fillRanges` קובע 10→**59**, בעוד ש-`suggestEnd` נותן 19.
- קישור A עם 10..30 וקישור B שמתחיל ב-11: אין שום edit, והחפיפה נשארת.

**תיקון:** להשתמש ב-`rangeMarkers(..., "auto")`, ולהוציא edit שמסיר טווח כש-`want <= s.line`.

**בדיקת רגרסיה:** שני המקרים.

---

### C16 — Low — משבצת `task` אחת למשימות במקביל

**מיקום:** `src/state/store.ts:1095-1110` ‏(`runTask`): ה-`finally` מבצע `this.task.value = null` בלי לבדוק שזו המשימה שלו.

**שחזור (REPRODUCED):**
- משימה A רצה, ואחריה מתחילה משימה B, למשל גרירת קבצים (`openFiles` לא חסום כשיש משימה).
- `task` מציג את B, וכפתור הביטול של A נעלם.
- A מסתיימת, ו-`task` הופך ל-`null` בזמן ש-B עדיין רצה, בלי התקדמות ובלי ביטול.

**תיקון:** רשימת משימות, או לפחות `if (this.task.peek()?.id === myId)` ב-`finally`. בנוסף, לחסום או לתזמן בתור משימה שנייה.

**בדיקת רגרסיה:** התרחיש שלמעלה. B נשארת ב-`task` אחרי ש-A מסתיימת.

**סטטוס:** תוקן ב־0f1f04d, בדיקה: `tests/integration/state/store.test.ts`

---

### C17 — Low — בניית alt_toc בזמן ריבועי

**מיקום:** `src/database/otzaria/alt-toc-reader.ts:47-55` ‏(`rowsOf.set(sid, [...(rowsOf.get(sid) ?? []), …])`).

**שחזור (REPRODUCED, במדידה):**
- ערוך השולחן Seifim (structure 1209) הוא המבנה הגדול ביותר במסד האמיתי, עם 26,609 רשומות.
- התבנית הזו לוקחת **3,083ms**, ו-push לוקח 1.6ms.
- כל הזמן הזה ה-worker חסום. בזמן כזה גם watchdog עלול להפיל אותו (C3).

**תיקון:** `pushTo` מ-`core/collections`, שכבר קיים בקוד.

**בדיקת רגרסיה:** מבנה סינתטי של 30 אלף רשומות נבנה בפחות מ-100ms.

**סטטוס:** תוקן ב־a82a7c9, בדיקה: `tests/integration/database/alt-toc-reader.test.ts` (וגם `alt-toc-real-db.local.test.ts`). במסד האמיתי: 5,071ms → ‏106ms. במבנה הסינתטי: 10,207ms → ‏104ms. התקציב בבדיקה הוא 1,000ms, כי הזמן כולל קריאת עמודים.

---

### C18 — Low — כל עריכה מסדרת את כל הפרויקט ב-UI thread

**מיקום:** `src/state/store.ts:1027-1041`. ה-autosave קורא ל-`projectText()` 1.5 שניות אחרי כל שינוי של `revision`.

**שחזור (REPRODUCED, במדידה):**
- 112,905 קישורים, כמו קובץ הספרייה הגדול ביותר.
- `projectText()` לוקח 350, ‏218 ו-238 ms, ומייצר מחרוזת של 42.8M תווים (כ-86MB ב-UTF-16).
- כל זה נכתב ל-IndexedDB אחרי **כל** קליק.

**תיקון:**
- סדרה מצטברת: לשמור את `Command` האחרון כ-delta, ולשמור snapshot מלא מדי פעם.
- לחלופין, להעביר את הסדרה ל-worker. ולפחות `requestIdleCallback`, וגם לא לסדר כשאין שינוי מאז הכתיבה הקודמת.

**בדיקת רגרסיה:** בדיקת ביצועים עם תקציב, למשל עדכון autosave של פחות מ-30ms ל-100 אלף קישורים.

---

### C19 — Low — varint של 9 בתים ו-rowid שלילי

**מיקום:** `src/database/sqlite/lazy/record.ts:9-21` ‏(`readVarint`).

**שחזור (REPRODUCED):**
- טבלה עם ה-rowids ‏-2, ‏-1 ו-5.
- `scan` מחזיר `18446744073709552000` פעמיים.
- `getMany([5])` מחזיר מפה ריקה, ו-`get(t, -1)` מחזיר `null`.

**סיבה:** הערך נקרא כמספר לא מסומן ב-double, בלי two's complement.

**תיקון:** BigInt עם `BigInt.asIntN(64)`, והמרה ל-Number כשהערך בטווח הבטוח.

**בדיקת רגרסיה:** שלושת ה-rowids שלמעלה.

**סטטוס:** תוקן ב־9b00b18, בדיקה: `tests/integration/database/lazy-sqlite-rowids.test.ts`.

---

## חלק ב' — תחזוקתיות

### M1 — Medium — ‏`AppStore` הוא god object, וה-Host interfaces הם בפועל ה-store עצמו

**ממצאים:**
- `src/state/store.ts` הוא 1,126 שורות, עם 40 signals ציבוריים ו-12 אחריויות: מקורות, קורא ובחירה, בונה, קישורים, אשף מיפוי, relink, הקשר בדיקה (validation), כללי ספריא, פרויקטים, autosave, הודעות ומשימות, ו-diagnostics.
- יש 8 מודולים נוספים, וכל אחד מקבל את `this` כ-"Host". ‏`GuidedHost` מכיל 19 חברים, `ExchangeHost` ‏15, ‏`SuggestionsHost` ‏13 ו-`DbLinksHost` ‏12. חלק מהם `Signal` שאפשר לכתוב אליו (`screen`, ‏`sideTab`, ‏`exportPurpose`, ‏`linkState`).
- מודולים כותבים ל-state של מודולים אחרים:
  - `state/maxlink.ts:233-236` כותב ל-`suggestions.run`, ל-`suggestions.dbLinkKeys` ול-`suggestions.current`.
  - `state/exchange.ts:344` כותב ל-`savedRevision`.
  - `state/db-links.ts:292` קורא ל-`exchange.importLinksFile`.
  - `db-links` ו-`exchange` מבצעים `commit` ישירות ל-`linkState`. הכלל "רק דרך `store.apply`" הפך ל"כל מודול שיש לו את ה-signal".
- מצב שמשפיע על ייצוא מפוזר בין `LinkState` (שיש לו undo), ‏signals של מודולים (`newFileOk`, ‏`rejected`, ‏`libraryOverrides`, ‏`dbMappings`, ‏`projectLibraryChoices`) ו-cache של תצוגה (`lines`). משם באו C4, ‏C7 ו-C10.

**השפעה:**
- אי אפשר לבדוק מודול בלי store כמעט מלא.
- זרימת הנתונים (מי משנה מה) לא ניתנת למעקב.
- ה-UI צמוד ל-store: ב-`builder.tsx` וב-`suggestions-panel.tsx` יש 48 הפניות `store.` בכל אחד, וב-`reader.tsx` ‏38.

**המלצה:**
1. כל מצב שמשפיע על הייצוא, כלומר כל החלטה של המשתמש, ייכנס ל-`LinkState`/`Command`, כך שיהיה לו undo ו-dirty.
2. מודול יחשוף פעולות (פקודות) ולא signals שאפשר לכתוב אליהם. ה-Host יכיל קריאה בלבד ופונקציה `dispatch(command)`.
3. לפצל את `store.ts`: ‏`SourcesState` (מקורות, זהות ספרים), ‏`BuilderState`, ‏`ProjectState` (פרויקט ו-autosave), ו-`RulesContext` (validation).

**בדיקה:** בדיקת ארכיטקטורה שאוסרת על `src/state/*.ts` לכתוב `.value =` ל-signal שהוגדר במודול אחר.

---

### M2 — Medium — כל פעולת worker מוגדרת 4 פעמים, והקוד כולל מתודות אופציונליות בשביל fakes

**ממצאים:**
- כל פעולה מוגדרת ב-`workers/sources-api.ts` (SourcesApi), ב-`workers/sources-handlers.ts` (Handlers), ב-`state/services.ts` (BooksService, עם חתימה אחרת: opts אחרון) וב-`app/books-service.ts` (מיפוי).
- טיפוסים מוגדרים פעמיים "מבנית, בלי import":
  - `InputFile`, ‏`OpenedSource` ו-`OpenResult`, ב-`sources/registry.ts:30-41` וב-`state/services.ts:17-35`.
  - `CallOptions`, ב-`rpc.ts:76` וב-`services.ts:37`.
  - `BatchItem` מול `BatchResultItem`.
  - התוצאה של `diffBooks` מוגדרת inline פעם שנייה.
- **קוד שנכתב רק בשביל בדיקות:** `dbLinkSummary?`, ‏`dbLinksPage?` ו-`runMaxLink?` אופציונליים ב-`services.ts:62-68`. לפי ההערה, "Optional so that test fakes without databases need not implement it". בגלל זה יש בקוד הייצור ענפים שמתים באפליקציה: `db-links.ts:84` ‏(`available`), ‏`maxlink.ts:110,168` עם ההודעה "קישור מרבי אינו זמין בגרסה הזו".

**השפעה:** פעולה חדשה דורשת 4 עריכות מתואמות, וטעות בחתימה נתפסת רק חלקית. ה-fakes מכתיבים את ה-API.

**המלצה:**
- `BooksService = { [K in keyof SourcesApi]: (...args, opts?) => Promise<…> }`, נגזר אוטומטית מ-SourcesApi. אז `booksService(call)` הוא Proxy גנרי.
- הטיפוסים המשותפים יעברו ל-`core`.
- המתודות יהיו חובה, והבדיקות ישתמשו ב-`registryService()` שכבר קיים.

---

### M3 — Medium — פונקציות-על במנועים ופרמטרים פוזיציוניים

**פונקציות-על:**
- `runDiburHamatchilEngine` (`dibur-hamatchil/engine.ts:260-1247`) היא closure של כ-990 שורות. כ-30 lambdas פנימיות חולקות מצב משתנה: `chain`, ‏`prev`, ‏`active`, ‏`lastNamed`, ‏`crossedHeading`.
- `CitationScanner` (`citations/detect.ts:165-1395`) הוא כ-1,230 שורות של מצב ibid משתנה.
- `linking/plan.ts` (886 שורות) מערבב ספירת ראיות, גילוי יחסים ובניית צעדים.

**פרמטרים פוזיציוניים ודגלים בוליאניים:**
- `detect.ts:760`: ‏`emitUnit(toks, line, from, to, candidates, unit, addr, commentators: boolean, rule?)`.
- `citations/engine.ts:684`: ‏`explain(c, t, r, narrowed, anchored: boolean, anchorAllowed: boolean, notesLine: boolean)`.
- `footnotes/engine.ts:307,403,490,569`: פונקציות עם 6 או 7 פרמטרים.

**השפעה:** אף חלק פנימי לא ניתן לבדיקת יחידה, אלא רק דרך המנוע כולו. מכאן שבדיקות הרגרסיה הן בדיקות מדידה על ספרייה.

**המלצה:**
- לפצל את DH לשלבים: extract → windows → search → place → order-filter → shape, כל שלב פונקציה טהורה.
- להשתמש באובייקטי אפשרויות במקום דגלים.

---

### M4 — Medium — לוגיקת קישור משוכפלת

**ממצאים (REPRODUCED לגבי ההבדלים):**

**7 מפרשי מספרים עבריים**, עם כללים שונים:
- `core/text/gematria.ts:32`
- `citations/numbers.ts:40`
- `pattern/numerals.ts:50`
- `dibur-hamatchil/windows.ts:61`
- `dibur-hamatchil/markers.ts:27`
- `headings/numbering.ts:124`
- `footnotes/markers.ts:124`

אותו טוקן מקבל ערכים שונים במפרשים שונים:

| טוקן | תוצאות |
|---|---|
| "עליה" | `headingNumber` = 115, כי `endsWith("יה")` ב-`windows.ts:69` מקבל כל קידומת שסכומה 100. ‏citations ו-pattern מחזירים null |
| "שבת" | 702 ב-`noteNumberOf` |
| "יה" | citations מחזיר null, ‏pattern ו-DH מחזירים 15 |

**6 בוני heRef_2:**
- `dibur-hamatchil/engine.ts:432-449`
- `headings/index.ts:456-461`
- `footnotes/engine.ts:692-707`, שמתעלם מה-heRef של המסד
- `pattern/engine.ts:626-644`
- `citations/engine.ts:418`
- `state/store.ts:autoHeRef`

לאותה שורת בסיס מתקבלים "בראשית פרק א" ו-"בראשית, פרק א", לפי המנוע ש-`merge.ts` בחר כנציג.

**שני מושגים של "כותרת":** ‏DH משתמש ב-`l.heading ?? headingLevel(l.text)` (`engine.ts:437`, ‏`windows.ts:110`), וכל השאר משתמשים ב-`l.heading` בלבד.

**ארבעה מימושים של HtmlCharCounter:**
- `core/text/offsets.ts:25,57`
- `core/text/sanitize.ts:22-47`
- `database/otzaria/line-notes.ts:73-98`

**שני מסלולי CSV:** `formats/links-csv/parse.ts` ו-`formats/records/records.ts`, עם זיהוי מפריד ופירוש מספרים שונים.

**השפעה:** C5 הוא תוצאה ישירה של השכפול. תיקון של כלל אחד (למשל של הגנרטור) מחייב 4 עד 7 שינויים מתואמים.

**המלצה:**
- `core/text/hebrew-numeral.ts` אחד, עם מדיניות מפורשת: `{ canonical: "strict" | "allow-15-16" | "sum" }`.
- `heRefIndex(book)` אחד ב-`linking/`: ה-heRef של המסד קודם, ואחרת כותרת ומסלול הכותרות.
- tokenizer אחד של HtmlCharCounter.
- `links-csv` כמקרה פרטי של `records`.
- בדיקות: טבלת טוקנים מול מדיניות, ובדיקה שכל המנועים נותנים אותו heRef2 לאותה שורה.

---

### M5 — Medium — טיפול בשגיאות לא אחיד

**ממצאים:**
- יש 25 `catch {}` שקטים ב-`src`, ובחלקם ההערה מתעדת שגם שגיאת קריאה נבלעת (C13).
- קורא המסד זורק ארבעה סוגי שגיאה:
  - `SqliteFormatError`
  - `LinkerError("db/corrupt")` ב-`record.ts`
  - `Error` רגיל ב-`record.ts:81` וב-`sqlite-file.ts:208,218,228,234,239`
  - `RangeError` של DataView ברשומה פגומה (REPRODUCED, ‏`record.ts:44-88`). הוא מגיע למשתמש באנגלית דרך `registry.ts:302`.
- חוזה הביטול שונה בין המנועים:
  - headings, ‏DH ו-citations מחזירים תוצאה חלקית עם `engine/aborted`.
  - footnotes ו-pattern מחזירים תוצאה ריקה עם `footnotes/aborted` ו-`pattern/aborted`.
  - לכן `maxlink-job.ts:195` מריץ את `notesAsCommentary`, כלומר ריצת headings מלאה, **אחרי** ביטול של footnotes.
  - `library-benchmark.test.ts:412` סופר רק `engine/aborted`.
- `runTask` מציג `e.message` של כל שגיאה, כולל הודעות פנימיות באנגלית.

**המלצה:**
- היררכיה אחת: `LinkerError` עם קוד, ו-`toRpcError` ימפה כל השאר ל-`internal` עם הודעה בעברית.
- `decodeRecord` יבדוק גבולות.
- חוזה ביטול אחד: כל מנוע זורק `AbortError`, או שכולם מחזירים `{aborted: true}`.
- לאסור `catch {}` בלי log, למשל עם כלל lint.

---

### M6 — Medium — מודל ה-jobs ב-worker

**ממצאים (READ):**
- מנועים סינכרוניים (`runEngine`) מכילים בדיקות `ctx.signal.aborted`, אבל ב-worker אלה **קוד מת**, כי הודעת cancel לא נקראת עד סוף הריצה (ראו C3). הבדיקות האלה עובדות רק בתהליך עצמו, כלומר בבדיקות וב-benchmark.
- הוויתור על ה-CPU לא אחיד:
  - `citations-job.ts:47` ו-`search-job.ts:48` מוותרים עם `setTimeout(0)`.
  - `engine-job` ו-`diffJob` לא מוותרים. ל-`diffJob` אין בכלל ctx, ולכן אין לו ביטול ואין התקדמות.
  - `maxlink-job` מוותר רק כשיש I/O אמיתי. ‏`await` שנענה מ-cache הוא microtask, ולא מאפשר לטפל בהודעות.
- `MaxLinkJobResult` כולו, כל ההצעות עם reasons ו-alternatives, עובר ב-`postMessage` אחד. אחר כך `mergeSuggestions` רץ ב-UI thread (`state/maxlink.ts:211`).
- `maxlinkJob` שומר את `results` של כל זוגות הספרים לטובת `runThrough`, בניגוד להערה "bounded memory".
- ב-`RpcClient.call` (`rpc.ts:107-114`), ה-listener של abort לא מוסר כשהקריאה מסתיימת. ב-`main.tsx:48` כל call מוסיף watchdog נוסף על אותו signal. ‏signal ששימש ל-N קריאות (`prepareSefariaCsv` ב-`exchange.ts`) יפעיל N watchdogs.

**המלצה:**
- `Job` אחיד: async, מוותר על ה-CPU כל N יחידות עבודה, מקבל ctx, ומחזיר תוצאה חלקית בפורמט אחד.
- worker נפרד לחישוב, כדי שהפעלה מחדש שלו לא תסגור את המקורות.
- לשלוח תוצאות max-link במנות (streaming) ולאחד אותן ב-worker.
- להסיר את ה-listeners כשה-promise מסתיים.

---

### M7 — Low — הערות שמצדיקות התנהגות בעייתית

| מיקום | ההערה | מה היא מכסה |
|---|---|---|
| `state/ranges.ts:62-68` | "header-free: it needs no headings" | הסיבה ל-C11 |
| `linking/ranges.ts:105-110` | "as in v3" | סותרת את כלל המודול בשורות 6-9 (C15) |
| `suggestions.ts:223`, ‏`maxlink-job.ts:218` | "…or a read error: nothing to compare with" | C13 |
| `services.ts:59-67` | "Optional so that test fakes…" | M2 |
| `validate.ts:197` | "לא נטענה, ולכן לא נבדק" כ-info | C7 |
| `windows.ts:68` | "canonical spelling only" | נמצאת מעל בדיקת `endsWith` שאינה קנונית (M4) |
| `lines.ts:46` | "re-insert = most recently used" | ה-cache הוא בפועל FIFO |

**המלצה:** הערה שמסבירה למה משהו לא נבדק צריכה להפוך לבדיקה או לבאג פתוח.

---

### M8 — Low — מה `architecture.test.ts` לא בודק

**ממצאים:**
- הבדיקה עוברת על regex של `import … from` סטטי בלבד. היא לא תופסת:
  - `import("…")` דינמי;
  - import של קובץ בלי `from`, כמו `import "./x.css"`;
  - מעגלים בתוך שכבה, למשל `state/store` ↔ `state/*` דרך Host;
  - שימוש בטיפוסים שמשוכפלים במקום להיות מיובאים (M2).
- הטבלה מתירה ל-`state` לייבא את `linking`/`matching`. בפועל `planRelink` ו-`mergeSuggestions` (על כל תוצאות max-link) רצים ב-UI thread.

**המלצה:**
- להוסיף בדיקת מעגלים, למשל עם madge או גרף פשוט.
- לאסור על `state` לייבא מודולי חישוב כבדים (`merge`, ‏`relink`, ‏`matching/*`), ולהעביר את החישוב ל-worker.

---

## מה טוב ושכדאי לשמור

- **`state/history.ts`:** מודל פקודות טהור ואימוטבילי. ‏before/after לכל קישור, alt_toc ו-files באותה פקודה, ו-`rebindLinks` שמעדכן גם את ההיסטוריה. זה הבסיס הנכון. צריך רק להכניס אליו את המצב שעדיין מחוץ לו (C4, ‏C10).
- **`workers/rpc.ts`:** פרוטוקול קטן ומוקלד, עם שגיאות `{code, message}` שעוברות structured clone, ‏throttle להתקדמות, ו-`inProcessCall` שמריץ בבדיקות את אותם handlers שה-worker מריץ.
- **`asExported` ו-`FILE_LEVEL_CODES`:** כלל אחד לייצוא ולבדיקת האיכות, ושני המסלולים לא סותרים זה את זה (התיקון ב-C1 שומר עליו).
- **`projects/project-format.ts`:** בונה מחדש כל קישור, שדה אחרי שדה, מקלט לא אמין, ומשתמש ב-`defineProperty` נגד prototype pollution. סכימה עם שדות אופציונליים, בלי לשבור גרסאות.
- **`option-specs.ts`:** אפשרויות המנועים מוגדרות כנתונים. אותו מפרט מציג את הטופס וגם מאמת את מה שמגיע ל-worker, כולל סדר הספים ו-regex בטוח.
- **הקורא העצל של SQLite על המסד הרשמי:** payload ו-overflow, עמוד 65536, ‏`walkTable`/`getMany`/`seekMany`, ו-zstd עם מילון לפי dictID. כל אלה נבדקו ונמצאו נכונים במסלול UTF-8/BINARY.
- **`linking/merge.ts`:** לא תלוי בסדר הקלט. ‏`monotoneChain` (Fenwick) נכון.
- **בדיקות property** ל-`sanitizeBookHtml`, ו-fixture אמיתי (`seforim-v7-mini.db`) עם תיעוד המקור.

</div>
