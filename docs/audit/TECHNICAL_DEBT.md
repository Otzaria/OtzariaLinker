<div dir="rtl">

# חוב טכני — מדורג לפי חומרה

מספרי השורות מתייחסים ל־`index.html` בתג `baseline-pre-2.0` (`18872b9`). פריסת השורות זהה ב־`legacy/OtzariaLinker-v3.html`.
"הורץ" פירושו שהממצא אומת בהרצה: קוד הליבה (`Config` עד `Domain`, ו־`LazySqlite`) הוצא מהקובץ והורץ ב־Node, מול נתוני דמה
או מול `seforim.db` האמיתי. כל השאר מבוסס על קריאת קוד.

**דרגות:** C — קריטי (פלט שגוי או כלי שאינו שמיש). H — גבוה (אובדן נתונים או שגיאה שקטה). M — בינוני. L — נמוך.

---

## C — קריטי

### TD-C1. מסד בסכמה 6/7 אינו קריא: השורות ריקות או שהממשק קורס *(הורץ)*
- **עצל** (כל `seforim.db` אמיתי): `LazyDbBookRepository` 2598 מחפש `line.content`, שאינו קיים. `colIndex` מחזיר `-1`, ו־`v[-1]`
  הוא `undefined`, ולכן `loadLines` 2662 מחזיר מחרוזות ריקות **בלי שגיאה**. בראשית: 1,584 שורות, 0 לא־ריקות. אין כותרות,
  ולכן אין `heRef`, אין תוכן עניינים, אין הצעות טווח ואין יצירה אוטומטית. אפשר עדיין ליצור קישורים "עיוורים".
- **sql.js**: `DbBookRepository` 2489 נופל ל־`"content"`, ו־`loadLines` 2522 זורק "no such column". `getLines` 2908 נקרא מתוך
  `renderPane` 4650 בלי try, ולכן **כל `refreshAll` זורק**, כל עוד הספר פתוח.
- גם אחרי JOIN ל־`line_content`: הערכים הם מסגרות zstd עם dictionary (`zstd_dict`), ואין בקובץ מפענח zstd.
- **כיוון**: שכבת `BookTextSource` עם זיהוי יכולות (בדומה ל־`DbCapabilities` באפליקציה); מפענח zstd ב־WASM עם dictionary;
  בדיקת אינטגרציה מול מסד בסכמה 7 מוקטן.

### TD-C2. "קישור אוטומטי ← לפי כותרות" יוצר קישורים שהייצוא מדלג על כולם *(הורץ)*
- `structuralMatch` 3879/3890 פולט `srcIdx`/`tgtIdx` = אינדקס **שורת הכותרת**. `runMatches` 5925 יוצר מהם קישורים.
  `ExportBuilder.build` 3552–3561 מדלג על כל קישור שאחד מקצותיו הוא כותרת (חוק הגנרטור).
- בהרצה: שני ספרים עם `<h2>סימן א/ב</h2>` → 2 התאמות → `written 0, skipped 2`. רק פיצול `implicitSeifim` (שורות פסקה)
  עוקף את זה.
- `validate` אמנם מזהיר על כל קישור, אבל דרך זו (`runMatches`) לא מריצה `validate`, ולכן המשתמש מגלה את זה רק בדיאלוג הייצוא.
- **כיוון**: למפות כותרת לשורה הראשונה שאינה כותרת אחריה (או לטווח הפסקה), ולהוסיף בדיקה מקצה לקצה "התאמה → ייצוא ≥1".

### TD-C3. בדיקת ה־fuzzer לא יכולה להיכשל
- 7622: `t("…1200 פעולות…", () => broke === null || broke)`. כש־`broke` הוא `"integrity@57"` (מחרוזת לא ריקה), הבדיקה
  **עוברת**. בדיקת הנסיגה החשובה ביותר לשלמות `dedup` מגינה רק מפני חריגה שנזרקת מבחוץ, ולא מפני שבירת שלמות.
- **כיוון**: `() => broke === null`, ולהדפיס את `broke` כהודעת כישלון. לוודא שהבדיקה עוברת אחרי התיקון לפני שמסתמכים עליה.

### TD-C4. XSS: HTML של ספר נכנס ל־`innerHTML` כמו שהוא
- `renderPane` 4684: `<div class="lc">${highlight(c, findRe)}</div>`. ה־HTML של השורה מקובץ txt, מתיקייה או ממסד (כולל
  "מסד פרטי") עובר כמו שהוא. `<img src=x onerror=…>`, `<svg onload>`, `<a href="javascript:…">` ו־`<style>` (שמשנה את כל
  הממשק) — כולם פעילים. העותק המקוון (`isOnlineCopy`, `http(s)`) מריץ את זה בדומיין של האתר.
- `highlight` 4621 מפצל לפי `/(<[^>]*>)/` ומזריק `<mark>` לתוך ישויות (`&amp;` כשמחפשים "amp"). זה לא XSS, אבל זה משבש את הטקסט.
- שאר ה־sinks נבדקו ונמצאו בטוחים, כי הם עוברים `esc` או `text`: `paintBooks` 4550, `summarySentence`, `Kit.confirm` (בכל
  הקריאות `esc`), `editLink` 5400, `auto` 5746, `altToc` 6232, `renderMatches` 5848, `setStatus`, ו־`importReport`.
  `Kit.alert/confirm/banner/field(help)/emptyState(text)/open(subtitle)` מקבלים HTML **בחוזה שלהם**, ולכן כל קורא עתידי בסיכון.
- **כיוון**: sanitizer עם allowlist (תגיות עיצוב וכותרות, בלי מאפייני `on*`, `style` ו־URL-ים), ו־CSP
  `script-src 'self' 'wasm-unsafe-eval'` בעותק הבנוי. API של Kit שמקבל טקסט כברירת מחדל ו־`SafeHtml` במפורש.

---

## H — גבוה

### TD-H1. אין התמדה לעבודה, ואין אזהרה לפני סגירה
רק ההגדרות נשמרות (`localStorage` 1953–1959). קישורים, ספרים, `alt_toc` והיסטוריה נשמרים בזיכרון בלבד. רענון או סגירה של
הלשונית מוחקים את כל העבודה. אין `beforeunload` (0 מופעים). **כיוון**: autosave ל־IndexedDB (רק קישורים NEW/EDITED/DELETED
ו־alt_toc, עם מזהי ספרים יציבים), שחזור בפתיחה, ואזהרה כשיש קישורים ממתינים.

### TD-H2. היקף הייצוא כברירת מחדל כולל אלפי קישורי EXISTING מהמסד
`exportDialog` 6424: ברירת המחדל היא `all`. `ensureBookLoaded` 2944–2952 מוסיף לכל ספר מסד שנפתח עד 20,000 (sql.js) או 3,000
(עצל) קישורים קיימים כ־`EXISTING`. כולם נכתבים ל־`<title>_links.json`:
- במסלול העצל **בלי עוגנים ובלי טווחים** (2696), כלומר מידע הולך לאיבוד.
- עם סוגי קשר מהמסד (TD-H3).
- עם `path_2 = title + ".txt"` של ספר־צל.
התוצאה עלולה להיות שכפול של הקורפוס כקובץ ידני. ב־sql.js, ספר עם יותר מ־4000 קישורים מאבד גם הוא עוגנים וטווחים
(`SATELLITE_LIMIT` 2531). **כיוון**: ברירת המחדל "רק חדשים ושנערכו". קישורי מסד לקריאה בלבד, או טעינה מלאה של
עוגנים וטווחים לפני שמאפשרים לייצא אותם.

### TD-H3. סוגי קשר מהמסד ממופים באופן שאובד מידע *(נבדק מול המסד)*
`importDbLinkRows` 3395 עושה רק `toLowerCase()`. במסד: `MESORAT_HASHAS`, `EIN_MISHPAT`, `MISHNAH_IN_TALMUD`, `SIFREI_MITZVOT`
ו־`FOOTNOTES`. ב־`Config` 1867–1876: `"mesorat hashas"`, `"ein mishpat"`, `"mishnah in talmud"`, `"sifrei mitsvot"`, ואין
`footnotes` בכלל. `typeLabel` מציג את הערך הגולמי, ומפתח הייחודיות שונה מקישור זהה שנוצר בכלי, ולכן שניהם יחיו יחד.
בייצוא נכתב ערך שאולי לא מוכר ל־`ConnectionType.fromString` של הגנרטור (**לא אומת**). **כיוון**: טבלת מיפוי מפורשת מ־enum
של המסד לערך הגולמי, עם בדיקה.

### TD-H4. אופסטי העוגן במצב Regex זזים *(הורץ)*
`buildRegex` 6138–6144: ההתאמה רצה על `stripTags(c)`, שעושה `trim` ומפענח רק 6 ישויות. `aStart` נלקח מ־`m.index` שם,
אבל `rawOffsetFromVisible` סופר כל ישות כתו אחד ולא חותך רווחים. דוגמה: `"  &#1488; סימן יב"` → `aStart = 8` → raw 14
(`" יב"`), כשהערך הנכון הוא 10. במצב תגיות (6088) החישוב נכון, כי `countVisibleChars` מחושב על ה־raw. אבל האורך נלקח מ־
`stripTags(m[1]).length`, ושם אותה סטייה אפשרית. **כיוון**: לחשב את ההתאמות על "טקסט גלוי" שנבנה באותה פונקציה שסופרת
אופסטים (מיפוי visible↔raw אחד).

### TD-H5. `parseColumns` מתעלם מהערות SQL, ואינדקסי העמודות זזים *(הורץ)*
`LazySqlite` 1784: פיצול לפי פסיקים ברמה 0 בלי להסיר `-- …`. מול המסד האמיתי: `book.heDesc` נעלמה ו־`notesContent` נקראה
`"no"`; `link_range.endLineIndex` נקראה `"for"`; `line.charCount` נעלמה. העמודות שהכלי קורא היום נמצאות לפני ההערות, ולכן
הן בסדר **במקרה**. כל עמודה נוספת שתיקרא (למשל `orderIndex`, או `endLineIndex` לטווחים במסלול העצל) תקבל ערך של עמודה אחרת.
**כיוון**: לקרוא את מספר העמודות מ־`PRAGMA table_info` כשאפשר, ובמסלול העצל להסיר הערות (`--` ו־`/* */`) ומחרוזות לפני הפיצול,
ולהוסיף בדיקה עם DDL אמיתי.

### TD-H6. טעינה עצלה סורקת טווח rowid במקום לבצע seek לכל שורה *(הורץ)*
`loadLines` 2661 ו־`lineIdToIndex` 2637 משתמשים ב־`scanRange(ids[0], ids[last])`. בסכמה 7 השורות של ספר מפוזרות: בראשית
סרקה 3.77M רשומות, 12,457 עמודים, כ־195MB ו־6.8 שניות. `loadLinksForBook` עושה עוד `lineIdToIndex`, כלומר סריקה שנייה
באותו גודל, ועוד `rowById` לכל קישור (עד 3000 seeks). **כיוון**: `rowById` לכל id ממוין, או מיזוג seek+scan לפי צפיפות;
ולקרוא את `lineIndex` ישירות מרשומת האינדקס `(bookId, lineIndex, rowid)`, שכבר מכילה אותו.

### TD-H7. `getLines` זורק בתוך לולאת הרינדור
`getLines` 2904 מריץ את `loadLines` הסינכרוני בלי try ובלי cache לשגיאה. כשהוא נכשל, `renderPane`, `refreshAll`, `validate`
ו־`ExportBuilder.build` זורקים שוב ושוב. `openBookInto` 4582 תופס רק את הקריאה הראשונה. **כיוון**: מצב ספר מפורש
(`loading/ready/error`) והצגת שגיאה בפאנל.

### TD-H8. ביטול של `trimPrevious` או `autoFillBook` לא מחזיר את הסטטוס *(הורץ)*
`Ranges.trimPrevious` 3311 ו־`autoFillBook` 3351 משנים `EXISTING`→`EDITED`. `Ranges.revert` 3358 מחזיר רק את `*RangeEnd`.
בהרצה: אחרי autofill ו־revert, הסטטוס נשאר `EDITED`. גם "שחזור" בלשונית השלמת הטווחים וסגירת הדיאלוג (5755, 6211) משאירים את
הקישורים `EDITED`. הם נספרים כ"ממתינים" (`updateChips`) ונכנסים לייצוא "רק חדשים ושנערכו". **כיוון**: לשמור את `prevStatus`
ב־`changes`.

### TD-H9. `sql.js` לעולם אינו משחרר מסד
אין `db.close()` בקובץ. אחרי `Domain.reset` (2820), אחרי הסרת כל הספרים או אחרי טעינת מסד שני, ה־heap של ה־WASM עדיין
מחזיק את כל קובץ המסד (עד 700MB בברירת המחדל). בנוסף, `readArrayBuffer` מחזיק עותק JS זמני של הקובץ. ההגדרה מאפשרת
`lazyThresholdMb` עד 8000, אבל מעל ~2GB `ArrayBuffer` ו־WASM32 נכשלים. **כיוון**: מחזור חיים מפורש ל־repo (`close()`), ותקרה
ריאלית לסף.

### TD-H10. עוגני `link_anchor` מהמסד נשמרים כ"גלויים" *(לא אומת)*
`importDbLinkRows` 3397: `{startVisible: charStart, endVisible: charEnd}`. בייצוא, `anchorOffsets` 3628 מריץ עליהם
`rawOffsetFromVisible`. אם `charStart` במסד הוא אופסט גולמי (כמו בקובץ JSON), נוצרת המרה כפולה. בסכמה 7 הערות השוליים
הוצאו ל־`line_note`, ולכן טקסט השורה במסד אינו זהה לטקסט שמולו נוצרו האופסטים. **כיוון**: לברר את הסמנטיקה ב־SeforimLibrary
ובגנרטור, ואז להגדיר `anchor.kind = raw|visible` במודל.

---

## M — בינוני

### TD-M1. אלגוריתמים ריבועיים
| איפה | סיבוכיות | הערה |
|---|---|---|
| `runMatches` 5912 `nextAfter` = `Array.find` על מערך ממוין, לכל התאמה | O(M²) | מתועד ב־`DEVELOPERS` §14 |
| `runMatches` 5924 `computeHeRef` → `activeHeadings` 3740 סורק מ־0 | O(M·N) | גם ב־`buildCsv` 3694–3695 לכל קישור |
| `Ranges.autoFillBook` 3339 `starts.find` לכל קישור | O(L²) | |
| `importDbLinkRows` 3382 `state.books.find` לכל שורה | O(R·B), עד 20,000×8,154 | |
| `importJsonRecords` 3425/3455 `findBookByTitle` ליניארי לכל רשומה | O(R·B) | |
| `Domain.removeBook` 2886 `touched.includes` בלולאה | O(L·T) | |
| `Ranges.markers` 3242 סורק את כל `state.links` וממיין, **בכל קריאה** | O(L log L) | `effectiveEnd` נקרא כמה פעמים בכל `refreshAll` (`previewRange` ×2, `summarySentence`, `rangeRow`, `buildLinksFromSelection`) |
| `sourceLinesWithLinks`/`targetLinesWithLinks` 3203 | O(L) לכל רינדור פאנל | |
| `refreshAll` 5342 בונה מחדש 2 פאנלים, את הבונה ואת רשימת הספרים בכל לחיצה | O(visible) | `goToLine` רק מגדיל את `*Visible`, והפאנלים אינם וירטואליים |

**כיוון**: אינדקסים לפי ספר (`Map<bookId, Link[]>` ממוין), `bisect`, `heRef` מצטבר לכל ספר, ורינדור וירטואלי מבוסס־diff.

### TD-M2. חציית שכבות
- **Kit מכיר את האפליקציה**: `setBackgroundInert` 4159 (חמישה סלקטורים של מסכים), `#toasts`, `#busyOverlay`, `#dialogHost`.
- **Dialogs → Boot** (תלות לאחור): 6445, 6450, 6533, 6545, 6550, 6557, 6566, 6634. בנוסף, `importReport` לוחץ על `#btnLog` 5603.
- **UI ⇄ Dialogs** (מעגל בזמן ריצה): 4472, 5046, 5285 ↔ `UI.*` בכל הדיאלוגים.
- **לוגיקה עסקית מחוץ ל־Domain**, מעבר לחריגה המוצהרת:
  - `Dialogs.runMatches`: כלל "עד ההתאמה הבאה" ו־heRef.
  - `resolveTargets`: מספור לפי פרקים.
  - `buildTag`/`buildRegex`: חילוץ התאמות ועוגנים.
  - `diagnose`.
  - `numberInGematria` ו"מילוי מכותרות" (`alt_toc`).
  - `editLink.save`: בניית שינויים ו־validate.
  - `Boot.handleDbFile` 7051: סיווג סוג המסד לפי שם קובץ.
  - `Boot` 7241–7248: עדכון הבחירה מלכידת עוגן.
  - כל פקודות ה־undo/redo נבנות כסגירות (closures) ב־UI וב־Dialogs (4765, 5217, 5308, 5327, 5525, 5942, 6204).
- **Domain תלוי בהגדרות UI משתנות**: `Config.get` ב־`validate` 3056/3066, ב־`Ranges.markers` 3243 וב־`LinkService.build` 3034.
  הכללים לא טהורים, והבדיקות משנות את ההגדרות ושומרות אותן ל־`localStorage` (7493, 7513).
- **ידע על שמות קבצים מפוזר**: `ExportWriter` 2781/2788, `exportDialog` 6497/6501/6503 ו־`report` 3660.

### TD-M3. מצב גלובלי שאפשר לשנות מכל מקום
`Domain.state` ו־`UI.ui` מיוצאים ומשתנים ישירות: הבדיקות כותבות `D.state.links.length = 0` 12 פעמים, `Boot` כותב ל־`ui.*`,
ו־`Dialogs` כותב ל־`ui.reselect`. אובייקטי Link משתנים במקום, גם עוקפים את `LinkService` (`Ranges.*` 3309, 3349, ו־6206).
**כיוון**: store עם פעולות מוגדרות ו־selectors, ו־Link בלתי משתנה או עם מתודות בלבד.

### TD-M4. התנגשות כותרים ושמות קבצים לא מנוקים בייצוא
`ExportBuilder.build` 3606 ו־`AltToc.forExport` 4011 ממפים לפי `title`. שני ספרים עם אותו כותר (למשל אחד ממסד ואחד מ־txt,
או אותו שם בשתי תת־תיקיות) מתמזגים לקובץ אחד. `links/${title}_links.json` לא מנקה תווים: `/`, `\`, `:`, `"`, `?` בכותר
יוצרים תת־תיקייה ב־ZIP או שם קובץ שאינו חוקי ב־Windows. **כיוון**: מפתח קובץ = `pathStem` של הנתיב, ניקוי תווים, וזיהוי התנגשות.

### TD-M5. פורמט "JSON נפרדים" יורה N הורדות
6500–6504: `Util.download` בלולאה. דפדפנים חוסמים או שואלים על הורדות מרובות, ואין משוב על הורדה שנחסמה. גם ב־CSV.

### TD-M6. ל־CSV אין שער תחום
`buildCsv` 3681 מדלג על כותרות, אבל לא על אינדקס מחוץ לתחום, ולא מדווח בעיות.

### TD-M7. `alt_toc`: אין ייבוא, והולידציה מבטיחה דבר שהקוד לא עושה
אין דרך לטעון `alt_toc/*.json` קיים. העריכה אפשרית רק ממצב ריק. האזהרה "הצומת יושמט" (3985) לא מתממשת ב־`toNodes`.
העורך זמין לספר המקור בלבד (7266). שמירת `alt_toc` לא נרשמת בהיסטוריה.

### TD-M8. טיפול חסר בשגיאות
- JSON פגום נכתב ליומן בלבד (2761). הסטטוס מראה "יובאו 0 מתוך 0" בלי דיאלוג.
- `Dialogs.locate.doIndex` 5698: `try/finally` בלי `catch`, כלומר unhandled rejection.
- `linkItem` 5283: `openBookInto(...).then(...)` בלי `catch`.
- `swapSides` 4603 בולע שגיאות בשקט.
- `LazySqlite` לא מזהה WAL או קידוד שאינו UTF-8, ולא מזהה מסד "חי" שאוצריא כותבת אליו.
- `LazyDbBookRepository.loadLines` לא מאמת שעמודת התוכן קיימת (TD-C1).
- `getSQL` מפענח base64 בלולאת `charCodeAt` בכל טעינה ראשונה. זה תקין, אבל ללא חיווי.

### TD-M9. שינוי הגדרה כלשהי מאפס את הבונה
`applyAllSettings` 6998–6999 מציב `ui.kind = defaultKind` ו־`ui.connType = defaultType`, והוא נקרא מכל `setNum`/`setSwitch`
ומהצפיפות (6545, 6550, 6566). שינוי "טעינה בגלילה" מוחק את המבנה והסוג שהמשתמש בחר.

### TD-M10. החזקת זיכרון
- `PRISTINE_HTML` 6983: כ־1.46M תווים לכל הסשן. ה־base64 של ה־WASM (880K) נשאר ב־`window` וגם בטקסט ה־`<script>`.
- `book._lines` של כל ספר שנפתח נשמר לתמיד, גם במסלול העצל (אין פינוי).
- `History` מחזיק עד 200 פעולות, כולל snapshot של ספר שהוסר עם כל השורות שלו (2892).
- `GlobalIndex` עם `includeDb` טוען את כל השורות (3925) ולא משחרר (מתועד).
- יומן ה־DOM לא חסום (5360), למרות שהמאגר חסום ל־5000.
- שלוש מפות memo של `Heb` עד 50k כל אחת. מטמון עמודים של `LazySqlite` עד 24MB.

### TD-M11. מיון וגבולות שונים בין שני המנועים
רשימת הספרים בעצל אינה ממוינת (2647, ובsql.js `ORDER BY title`). תקרת קישורים: 3000 מול 20000. עוגנים וטווחים: אין מול
יש (רק עד 4000). אותו מסד נראה אחרת לפי גודל הקובץ.

### TD-M12. בדיקות לא מבודדות
החבילה כותבת להגדרות (`Config.set` 7493 → `localStorage`) בלי `try/finally`. אם משהו זורק בין 7493 ל־7513, `rangeEndBasis`
נשאר `links` לתמיד. `withScratchState` לא משחזר את `_dbLinksLoaded`, את `GlobalIndex` או את מוני `uid` ו־`_seq`.
הבדיקות האחרונות (7751–7777) תלויות ב־DOM החי, ובדיקת "גובה הטורים" עוברת אוטומטית כשהעורך מוסתר (7761).

---

## L — נמוך

| # | ממצא | איפה |
|---|---|---|
| L1 | `?selftest` נבדק כתת־מחרוזת (`?xselftesty` מפעיל) | 7791 |
| L2 | `rowHeight` מבחין רק בין `compact` ושאר הערכים (`spacious` ו־`dense` = 32) | 4493 |
| L3 | הערת `DEFAULTS.density` מציינת שני ערכים; יש 4 | 1933 |
| L4 | `redo` של הסרת ספר לא מאפס את `ui.sourceBook`/`targetBook`, והספר המוסר נשאר פתוח בפאנל | 5310 |
| L5 | `undoTo(i)` ("חזרה לכאן") מבטל גם את הפעולה שנבחרה. התווית מטעה | 6401, 3724 |
| L6 | "דולגו (שורת כותרת)" בדוח כולל גם שורות מחוץ לתחום | 3650 |
| L7 | תאריך מקומי ב־`_report.txt`, כך ששני ייצואים זהים שונים ב־diff | 3639 |
| L8 | טולטיפ `#chipPending` שגוי | 1029 / 7149 |
| L9 | `Kit.menu`: `role: isPicker ? "menu" : "menu"` | 4233 |
| L10 | `Ctrl+Enter` יוצר קישור גם מתוך שדה טקסט בבונה. זה מכוון, אבל לא מתועד | 7298 |
| L11 | `Domain.reset` לא מנקה את `#stSefaria` ולא מאפס `sefariaTitles`; האיפוס לא מנקה את הסטטוס של ספריא | 7128 |

---

## פונקציות ארוכות

| פונקציה | שורות | אורך משוער |
|---|---|---|
| `_runSelfTests` | 7344–7785 | ~440 |
| `Boot.wire` | 7085–7317 | ~233 |
| `Dialogs.altToc` (כולל `render`/`paintRows`/`numberInGematria`) | 6222–6380 | ~159 |
| `Dialogs.editLink` | 5395–5531 | ~137 |
| `DbBookRepository` (factory) | 2459–2570 | ~112 |
| `Dialogs.settings` | 6525–6635 | ~111 |
| `LazyDbBookRepository` (factory) | 2594–2702 | ~109 |
| `Dialogs.renderMatches` | 5798–5903 | ~106 |
| `Dialogs.exportDialog` | 6420–6520 | ~101 |
| `ExportBuilder.build` | 3515–3614 | ~100 |
| `UI.renderBuilder` | 4950–5047 | ~98 |
| `Kit.menu` | 4226–4319 | ~94 |
| `Domain.importJsonRecords` | 3414–3501 | ~88 |
| `UI.renderPane` | 4636–4700 | ~65 |
| `Dialogs.buildRanges` | 6156–6217 | ~62 |
| `Dialogs.buildStruct` / `buildRegex` / `runMatches` / `structuralMatch` | — | ~50 כל אחת |

## קוד כפול

- **בורר סוג קשר** (שתי קבוצות) נבנה 4 פעמים: 4996, 5404, 5789, 6578. **בורר מבנה** 3 פעמים: 4976, 5782, 6573.
- **`side === "src" ? … : …`**: עשרות מופעים (`Ranges`, `UI`, `Dialogs`). כל מתודה ב־`Ranges` מחלצת מחדש start/end/book.
  חסר accessor `sideOf(link, side)`.
- `Ranges.reapply` מול לולאה זהה בתוך `buildRanges` 6206.
- `plural` מוגדר מחדש ב־`renderMatches` 5801, למרות שקיים `Util.plural`.
- שערי כותרת בייצוא: `build` 3552–3561 מול `buildCsv` 3689–3690.
- שלושה מנרמלי טקסט: `GlobalIndex.norm` 3907, `_normStrict`/`_normLoose` 3777–3778, ו־`Heb.normalize` 2248.
- `DbBookRepository` מול `LazyDbBookRepository`: מיפוי שורה לספר, טעינת `source`, זיהוי ספריא וצורת השורה של קישור.
- איפוס `find` (`{term:"",hits:[],pos:-1}`) חמש פעמים: 4574, 4576, 4599, 4725, 4730.
- `D.state.links.length = 0; D.state.dedup.clear(); D.state.books.length = 0;` 12 פעמים בבדיקות.

## קוד מת

`Kit.checkbox` 4397 (0 קריאות) · `LinkService.exists` 3073 ו־`ownerOf` 3075 (0) · `LazySqlite._parseColumns` 1805 (0) ·
`LazySqlite.scanTable` קיים רק כעטיפה ל־`_walkTable` · ייצוא לא מנוצל: `UI.bookTag`, `rowHeight`, `buildLinksFromSelection`,
`effectiveEnd`, `selStart`, `Boot.refreshEnter`, `Domain.headingIndexes` · `lazy._stats` (2723) משמש רק ללוג DEBUG ·
`Book.lineCount` מתעדכן אבל `lineCount()` תמיד קורא `getLines().length`.

## מה ישבר עם מסדי סכמה 7 (ריכוז)

1. טקסט השורות: TD-C1 (ריק בשקט בעצל, חריגה ב־sql.js, zstd לא נתמך).
2. ביצועי טעינה: TD-H6 (rowids מפוזרים; 6.8 שניות לספר קטן).
3. סוגי קשר: TD-H3 (enum באותיות גדולות, מילים מחוברות בקו תחתון, `FOOTNOTES`).
4. פענוח DDL עם הערות: TD-H5.
5. אופסטי עוגן מול `line_note` (הערות שוליים שהוצאו מהשורה): TD-H10. **שאלה פתוחה**: מול איזה טקסט הגנרטור מחשב `start/end`?
6. `link`/`link_range` עדיין כוללות `targetLineIndex`/`endLineIndex`, ולכן שאילתות הקישורים עצמן עובדות.

</div>
