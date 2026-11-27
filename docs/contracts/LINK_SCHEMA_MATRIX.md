<div dir="rtl">

# חוזה: טבלאות הקישורים לפי סכמה

**מצב:** מחקר שלב 2/3 · 2026-11-11

המסמך משלים את [DATABASE_SUPPORT_MATRIX.md](DATABASE_SUPPORT_MATRIX.md), שבו מוגדרים המקורות, ציר הגרסאות
ואלגוריתם הזיהוי. מספרי השורות ב־`Database.sq` מתייחסים למזלג `Otzaria/SeforimLibrary` בקומיט `23f1f8f1`.
הספירות נלקחו מהמסד האמיתי (`db_version=37`, סכמה 7).

## 1. מטריצה

✔ = קיים, ◐ = נוסף בתוך הגרסה בלי העלאת מספר, ✖ = אין.

| טבלה / עמודה | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | נכנס ב־ |
|---|---|---|---|---|---|---|---|---|---|
| `connection_type(id, name)` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | `802a66d5` (2025-07-04). לפני כן `link.connectionType TEXT` |
| `link` (id, source/target Book/Line, connectionTypeId) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | — |
| `link.targetLineIndex` | ◐ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | `bf48fa23` (2026-04-22) |
| `link.targetBookOrderIndex` | ✖ | ◐ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | `52b93e2b` (2026-05-31) |
| `link.isDeclaredBase` | ✖ | ◐ | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | `521838d6`. הוחלף ב־`77559026` |
| `link.baseProvenance` | ✖ | ✖ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | `77559026` (2026-07-15) |
| `book_has_links` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | `9ff25fc1` (2025-07-05) |
| `link_anchor` | ✖ | ◐ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | `b7e044ea` (2026-07-12) |
| `link_range` + `link_coverage` | ✖ | ◐ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | `fad55ea3` (2026-07-12) |
| `link_suppressed_side` | ✖ | ✖ | ✖ | ✔ | ✔ | ✔ | ✔ | ✔ | `6e02d5c2` (2026-08-30) |
| קואורדינטות עוגן כוללות גוף הערות | — | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ | `0684c735` (2026-10-18) |

**העמודות של טבלאות הצד לא השתנו מאז שנוצרו.** אומת על ה־fixtures של v1, v3 ו־v7.

### 1.1 אינדקסים לפי סכמה

| אינדקס | 0 | 1–4 | 5–7 | הערה |
|---|---|---|---|---|
| `idx_link_source_book(sourceBookId)`, `idx_link_target_book(targetBookId)`, `idx_link_target_line(targetLineId)` | ✔ | ✔ | ✔ | |
| `idx_link_type_source_line(connectionTypeId, sourceLineId)` | ✔ | ✔ | ✔ | `a873f1bf` |
| `idx_link_source_line(sourceLineId)` | ✔ | ✔ | ✖ | הוסר ב־`94d1f718` (2026-09-29), כי הוא קידומת של הבא |
| `idx_link_type(connectionTypeId)` | ✔ | ✔ | ✖ | הוסר ב־`5b550275` |
| `idx_link_type_source_order(connectionTypeId, sourceLineId, targetLineIndex)` | ✔ | ✖ | ✖ | הוחלף ב־`52b93e2b` |
| `idx_link_source_targetorder(sourceLineId, targetBookOrderIndex, targetLineIndex)` | ✖ | ✔ | ✔ | covering לסדר המפרשים |
| `idx_link_type_target_line(connectionTypeId, targetLineId)` | ✖ | ✔ | ✔ | `521838d6`, לתצוגת SOURCE |
| `sqlite_autoindex_link_anchor_1(linkId, side, charStart)` | — | ✔ | ✔ | ה־PK. אין אינדקס נוסף |
| `sqlite_autoindex_link_range_1(linkId, side)`, `idx_link_range_end_line(endLineId)` | — | ✔ | ✔ | |
| `sqlite_autoindex_link_coverage_1(lineId, linkId, side)`, `idx_link_coverage_link(linkId)` | — | ✔ | ✔ | |
| `sqlite_autoindex_link_suppressed_side_1(linkId, side)` | — | — | ✔ (מ־3) | |
| `idx_book_has_source_links`, `idx_book_has_target_links` | ✔ | ✔ | ✔ | אינדקסים על דגלים. לא נחוצים לנו |

מסדים ישנים בתוך גרסה 5 עדיין עשויים לכלול את שלושת האינדקסים שהוסרו. הקורא לא מסתמך על אף אינדקס שאינו
מופיע בעמודת "5–7".

## 2. `link`, `Database.sq:376-394`

| עמודה | משמעות |
|---|---|
| `id` | מזהה יציב בין בניות, מוקצה על ידי IdAllocator. **לא רציף.** במסד האמיתי מגיע עד 13,629,455 עבור 6.9M שורות |
| `sourceBookId`, `sourceLineId` | הצד השמור "מקור" (side 0) |
| `targetBookId`, `targetLineId` | הצד השמור "יעד" (side 1) |
| `targetLineIndex` | עותק של `line.lineIndex` של `targetLineId` (מתחיל מ־0). חוסך JOIN |
| `targetBookOrderIndex` | עותק של `book.orderIndex` של היעד, לצורך מיון בלי JOIN |
| `connectionTypeId` | מצביע ל־`connection_type.id` |
| `baseProvenance` | 0 = NONE, 1 = INFERRED_TITLE (פענוח "X על Y"), 2 = SEFARIA_DECLARED (`base_text_titles`). במסד האמיתי: 5,085,997 / 12,970 / 1,806,701 |

**כיוון האחסון.**
- **בסיס → תלוי.** בקישור של טקסט תלוי, הבסיס הוא ה־source. לדוגמה, ב־COMMENTARY: source=`בראשית`,
  target=`אוצר מדרשים`. כך נאמר בהערה של `link_anchor` (`Database.sq:410-425`) ואומת בדגימה.
- **LINKER** הוא כיוון אחד בלבד: source הוא השורה המצטטת, target הוא המקור המצוטט
  (`core/.../models/Link.kt`, ההערה ל־`LINKER`). לדוגמה, `כלי יקר על בראשית` → `מדרש אגדה`.
- **SOURCE (id 5)** הוא סוג **וירטואלי** ש"לעולם אינו נשמר" (`Link.kt`, `SOURCE`). במסד האמיתי יש 0 שורות
  מסוג 5.
  - האפליקציה גוזרת אותו בשאילתה הפוכה: היא מחפשת `targetLineId IN (…)` עבור סוגים תלויים, ומציגה אותם
    כ־SOURCE (`lib/data/data_providers/link_visibility_sql.dart:23-30`;
    `database_library_provider.dart:603-660`).
  - קישורי הפניה (REFERENCE ודומיהם) נקראים בשני הכיוונים רק כשיש `link_suppressed_side`, כלומר מסכמה 3
    (`LinkTypes.inverseQueryTypes(bidirectional: hasSuppressedSide)`).

### 2.1 `connection_type`

הערכים קבועים לפי ordinal+1. ערכים חדשים נוספים רק בסוף (`core/.../models/Link.kt:51-…`). במסד האמיתי:

| id | name | קישורים |
|---|---|---|
| 1 | COMMENTARY | 2,342,614 |
| 2 | SUPER_COMMENTARY | 24,886 |
| 3 | TARGUM | 40,741 |
| 4 | REFERENCE | 115,025 |
| 5 | SOURCE (וירטואלי) | 0 |
| 6 | MIDRASH | 10,689 |
| 7 | QUOTATION | 31,715 |
| 8 | MESORAT_HASHAS | 45,879 |
| 9 | EIN_MISHPAT | 137,622 |
| 10 | DIBUR_HAMATCHIL | 0 |
| 11 | PARSHANUT | 0 |
| 12 | MISHNAH_IN_TALMUD | 2,390 |
| 13 | RELATED | 80,755 |
| 14 | OTHER | 1,569,855 |
| 15 | LINKER | 2,488,652 |
| 16 | SIFREI_MITZVOT | 14,063 |
| 17 | ESSAY | 0 |
| 18 | ALLUSION | 751 |
| 19 | LITURGY | 12 |
| 20 | ELUCIDATION | 0 |
| 21 | EXPLICATION | 2 |
| 22 | LAW | 1 |
| 23 | SUMMARY | 0 |
| 24 | FOOTNOTES | 16 |

- **לפי שם, לא לפי id.** מסדים ישנים יכולים להכיל פחות סוגים. מסד אישי יכול להכיל ids אחרים (ב־PDC יש רק
  `SOURCE`). לכן ממפים תמיד לפי `name`.
- **נרמול:** `trim().lowercase()`, ורווח שקול ל־`_`. ערך לא מוכר נשמר כ־OTHER.

## 3. `link_anchor`, `Database.sq:410-434`

PK הוא `(linkId, side, charStart)`, ולכן ייתכנו כמה עוגנים לכל צד של קישור.

| עמודה | משמעות |
|---|---|
| `side` | 0 = העוגן בטקסט של שורת ה־source. מכיוון ש־source הוא הבסיס, סמני מפרשים הם side 0. 1 = עוגן בצד היעד, למשל טווח של ציטוט |
| `charStart` | נקודת העוגן (מקום הכנסת סמן) או תחילת טווח |
| `charEnd` | NULL = עוגן נקודה (סמן inline). אחרת סוף טווח **בלעדי** |
| `label` | הסמן המודפס, כשהמקור מצהיר עליו (למשל "א" בשו"ע/מ"ב) |

**יחידות הקואורדינטות: תווים גלויים**, לפי `countVisibleChars`
(`generator/common/src/commonMain/kotlin/.../HtmlCharCounter.kt:15-23`):
- תגיות `<…>` מדולגות.
- כל ישות `&…;` נספרת כתו אחד. הספירה מוותרת אחרי 10 תווים בלי `;`, ואז `&` נספר כתו רגיל.
- הספירה היא ב־**UTF-16 code units** (Kotlin `Char`). בעברית, כולל ניקוד וטעמים (BMP), זה זהה לנקודות קוד.
  תו מחוץ ל־BMP נספר כ־2.
- **מסכמה 7 נספרת השורה המלאה:** הטקסט השמור, ובתוכו גוף כל `line_note` (בתווים גלויים) **במקום
  `charPos` שלו**, לפי סדר `noteIndex` (`Database.sq:410-425, 656-663`). לכן עוגן יכול ליפול בתוך גוף הערה
  או לחצות אותו. עד סכמה 6 ההערות היו בתוך השורה עצמה, כך שהתוצאה זהה בפועל.
  - **מסקנה לכלי:** כדי לחשב או לכתוב עוגן מול מסד 7 צריך לשחזר את השורה המלאה. מפענחים את ה־`body`
    הדחוס ומכניסים אותו ב־`charPos`.

**הפילוח במסד האמיתי:**

| side | סוג | label | שורות |
|---|---|---|---|
| 0 | טווח | — | 2,565,568 (בעיקר LINKER: ביטוי הציטוט) |
| 0 | נקודה | יש | 176,845 |
| 0 | נקודה | אין | 1,330 |
| 1 | טווח | — | 5,654 |

## 4. `link_range` (`Database.sq:436-450`) ו־`link_coverage` (`:452-465`)

- **`link_range(linkId, side, endLineId, endLineIndex)`.** קישור שהציטוט שלו משתרע על כמה שורות.
  - שורת `link` מעוגנת ב**שורה הראשונה** של הטווח. השורה הזו מתעדת את **השורה האחרונה** (כולל) של הצד
    הנפרש.
  - `endLineIndex` מתחיל מ־0 ומשוכפל לטובת תצוגה.
  - במסד האמיתי: side 0 = 62,762, side 1 = 1,676,901.
- **`link_coverage(lineId, linkId, side)`.**
  - שורה אחת לכל שורה מכוסה **מעבר לראשונה**. השורה הראשונה נמצאת דרך `link.sourceLineId/targetLineId`.
  - שורות כותרת לא נכללות.
  - נועדה ל־seek מהיר לשאלה "אילו קישורים מכסים את שורה X".
- **צמד חובה.** טבלה אחת בלי השנייה אינה שמישה (`db_capabilities.dart:141-143`).

## 5. `link_suppressed_side` (`Database.sq:467-477`), `book_has_links` (`:482-491`)

### 5.1 `link_suppressed_side(linkId, side, reasonMask)`

צד שספריא לא מציגה.

- **הטבלה דלילה.** צריך LEFT JOIN, או לבדוק `NOT EXISTS`.
- `reasonMask` הוא OR של ביטים (`core/.../models/LinkRange.kt:57-72`):

  | ביט | שם | משמעות |
  |---|---|---|
  | 1 | ANCHOR_NOT_SEGMENT | העוגן אינו ברמת סגמנט |
  | 2 | OTHER_TOO_COARSE | הצד השני גס מדי |
  | 4 | WHOLE_PEREK | פרק שלם |
  | 8 | WHOLE_PARASHA | פרשה שלמה |

- `CHECK` אוסר ערך 0 ואוסר ביטים מעל 15.
- **שימוש באפליקציה:** כשמציגים את צד X, מסננים `NOT EXISTS (… ss.side = X)` (`link_visibility_sql.dart:15-22`).
- במסד האמיתי: side 0 = 133,963 שורות, side 1 = 164,932. הרוב הוא ביט 1.

### 5.2 `book_has_links(bookId, hasSourceLinks, hasTargetLinks)`

- דגלי 0/1 ברמת ספר. לכל ספר יש שורה (8,154).
- משמשת לסינון מהיר של ספרים בלי קישורים. אין בה מידע על סוג הקישור.
- אפשר להסתמך עליה רק כ־hint: היא נכתבת בבנייה, ו־delta אמור לעדכן אותה.

## 6. קישורים במסדים אישיים

| מסד | טבלה | מבנה | כתובת הצד השני |
|---|---|---|---|
| `user_books.db` | `user_link` | `sourceTitle`, `sourceCategoryId`, `sourceIsUserBook`, `sourceLineIndex`, `targetTitle`, `targetCategoryId`, `targetIsUserBook`, `targetRef`, `targetLineIndex`, `anchorStart`, `anchorEnd`, `anchorLabel`, `sourceLineIndexEnd`, `targetLineIndexEnd`, `targetRefEnd`, `connectionType TEXT`, `source`, `sourceDb`, `targetDb` (`lib/migration/database/daos/database.dart:881-906` @ `a6be90800`) | כל צד: כותרת + דגל אישי/רשמי + slug של מסד מצורף, ו־lineIndex. **אין** `line.id`. העוגן והטווח הם עמודות בשורה. הפירוט: §6.1 |
| `user_books.db` | `link` | צורה ישנה בלי `targetLineIndex`/`targetBookOrderIndex` (`database.dart:726-745` @ `a6be90800`). לא נמצא קוד שכותב אליה; במסד אמיתי 0 שורות | — |
| מסד מצורף / PDC | `external_link` | `sourceBookId`, `sourceLineIndex` (מ־0), `targetSource`, `targetTitle`, `targetRef`, `targetLineIndex`, `connectionType TEXT` (`docs/personal_databases.md`; PDC `builder.dart`) | `targetSource`: `'official'`, ‏library_id של מסד אחר, או NULL (כל המסדים לפי עדיפות). `targetRef` עדיף, ונפתר דרך `line_ref`/`heRef`. אחרת `targetLineIndex`. אם `connectionType` הוא NULL, מתייחסים אליו כ־REFERENCE |

- **יכולת `external_link`:** מספיקות שלוש עמודות, `sourceBookId`, `sourceLineIndex` ו־`targetTitle`
  (`db_capabilities.dart:203-207`). כל השאר אופציונליות.
- **PDC:** כותב `connectionType='SOURCE'` לקישורים לספרייה הרשמית. COMMENTARY מתהפך ל־SOURCE.
- **נמדד על v52** ([`PERSONAL_DB_V52_AUDIT.md`](../research/PERSONAL_DB_V52_AUDIT.md) §4): `targetSource` הוא רק `official` או
  ה־`library_id` של המסד עצמו (קישור פנימי: `FOOTNOTES` בסיס ← הערות, `REFERENCE`, `SOURCE`, `COMMENTARY`);
  `targetRef` ב־`official` שווה ל־`heRef` של שורת היעד ברשמית ב־562,808 מ־562,808; `connectionType` הוא טקסט חופשי
  (`FOOTNOTES`, `SOURCE`, `REFERENCE`, `COMMENTARY`), לא `connection_type.id`. אין מזהה קישור: המזהה בכלי הוא
  `<מקור>:ext:<rowid>`. הקורא ממומש (#13); fixture: `tests/fixtures/db/pdc-personal-mini.db` (DDL אמיתי של v52, שורות
  placeholder, `scripts/fixtures/make_pdc_mini_db.py`).

### 6.1 `user_link` של `user_books.db` (Issue #41 B20)

נקרא בקוד של אוצריא, `Otzaria/otzaria` @ `a6be90800`, לקריאה בלבד. `DB` = `lib/migration/database/daos/database.dart`,
`UIM` = `lib/user_content_import/models/user_import_models.dart`, `UCR` = `lib/user_content_import/repository/user_content_repository.dart`,
`ULL` = `lib/user_content_import/services/user_links_loader.dart`, `TBR` = `lib/data/repository/text_book_repository.dart`,
`BS` = `lib/models/book_source.dart`, `LT` = `lib/models/link_types.dart`.

**שתי צורות של הטבלה.**

| צורה | עמודות | מקור |
|---|---|---|
| `title` (הנוכחית) | כל צד לפי `<side>Title` + `<side>IsUserBook` (+ `<side>CategoryId`, `<side>Db`); `sourceLineIndex`, `targetLineIndex`, `targetRef`, `anchorStart/End/Label`, `sourceLineIndexEnd`, `targetLineIndexEnd`, `targetRefEnd`, `connectionType`, `source` | `DB:881-906`; אינדקסים `idx_user_link_source_line (sourceTitle, sourceIsUserBook, sourceLineIndex)`, `idx_user_link_target_line (targetTitle, targetIsUserBook, targetLineIndex)` |
| `book-id` (הראשונה) | `sourceBookId` (FK לספר אישי במסד), `sourceLineIndex`, `targetTitle`, `targetCategoryId`, `targetIsUserBook`, `targetRef`, `targetLineIndex`, `connectionType`. אין עוגנים, טווחים או slug | `DB` @ `65db26bd2`. השדרוג: `_ensureUserLinkSchema` / `_rebuildUserLinkTable` (`DB:248-334`), שורה ישנה נשמרת עם `sourceIsUserBook=1` |

- עמודות נוספו ב־`ALTER` (`DB:274-295`): `anchorStart`, `anchorEnd`, `anchorLabel`, `sourceLineIndexEnd`, `targetLineIndexEnd`,
  `targetRefEnd`, `source`, `sourceDb`, `targetDb`. לכן טבלה אמיתית יכולה להיות בלי חלק מהן, והן אופציונליות.
- **מה המשמעות של כל שדה:**
  - **`lineIndex` מ־0** בשני הצדדים (`UIM:340-341`). התצוגה מוסיפה 1 (`ULL:104-120`). הייבוא מקובץ מוריד 1 (`user_content_importer.dart:869,889`).
  - **`<side>IsUserBook`**: 1 = ספר אישי של `user_books.db` עצמו; 0 = הספרייה הרשמית (`UIM:350`; `BS:19-21`). NULL נקרא כ־0
    (`as int? ?? 0`, `UCR:673-692`).
  - **`<side>Db`**: slug של מסד מצורף שבו הצד. כשהוא קיים, הדגל 0 והקטגוריה NULL (`UIM:373-376`). slug לא חוקי לא נחשב, והדגל
    קובע (`UIM:399-405`, `BS:23-29`). ה־slug הוא `schema_meta.library_id` של המסד, ואם אין, שם הקובץ בלי סיומת, אחרי ניקוי
    (`attached_library_probe.dart:203-229`).
  - **`<side>CategoryId`**: מצמצם כותרת שנמצאת פעמיים. NULL = כל קטגוריה (`UCR:565-567, 609-611`).
  - **`*LineIndexEnd`**: סוף טווח, 0-based, כולל (`UIM:367-369`).
  - **`anchorStart`/`anchorEnd`/`anchorLabel`**: בצד **המקור**, אופסטים **גולמיים** כפי שנכתבו ב־`start`/`end` של קובץ ה־native
    (`UIM:360-365`; `ULL:115-116`, `anchorOffsetsAreRaw: true`). אלה לא האופסטים הגלויים של `link_anchor`.
  - **`targetRef`**: תווית בלבד. הייבוא כבר פתר אותה לשורה (`user_link_ref_resolver.dart:13-37`). שורה בלי `targetLineIndex`
    לא מוצגת (`ULL:64-70`).
  - **`connectionType`**: שם הסוג כטקסט (`LT`). קישור נכנס מוצג בסוג ההפוך (`LT:123-127`), וקישורי `LINKER` לא מוצגים מצד היעד
    (`UCR:623`). הייבוא שומר `LINKER` כ־`COMMENTARY` (OTZARIA_COMPATIBILITY §4).
- **איך האפליקציה קוראת:** לספר שנפתח היא קוראת `forward` (שורות שהצד המקור שלהן הוא הספר: כותרת + דגל + `sourceDb IS ?`)
  ו־`inverse` (שורות שהיעד שלהן הוא הספר) (`UCR:555-637`), וממזגת אותן עם הקישורים מהמסד הרשמי (`TBR:244-263`). לכן קישור
  אישי מופיע גם בספר רשמי.

**מה הכלי עושה** (`src/database/otzaria/user-links-reader.ts`, `src/sources/db/db-source.ts`):

- **זיהוי:** `capabilities.userLinkSchema` לפי העמודות שקיימות (`USER_LINK_REQUIRED`). העמודות שחסרות בהן אופציונליות.
  טבלה בלי עמודת חובה (כולל `targetIsUserBook`, בלעדיה צד היה מנוחש), או טבלה `WITHOUT ROWID`, לא נקראת. במקרה כזה
  יש אזהרה `db/user-link-not-read`, ולכל ספר במסד יש `SourceBook.linksUnread`. אז הכיסוי הוא "לא ידוע" (`LinksReading`
  `unknown`/`unreadable`), סיכום הקישורים נושא `unread`, סכום הספרים בפאנל מדלג על הספר, ובשורה של הספר במאגר כתוב שאינו זמין. אף
  אחד מהם לא אומר "0 קישורים".
- **קריאה:** סריקה אחת של הטבלה, שנשמרת כמערכים (`UserLinkIndex`). הדף קורא שורות לפי rowid. לספר של המסד מוצגות השורות
  שמתחילות בו ("יוצאים") ושורות שמסתיימות בו ואינן מתחילות בו ("נכנסים"). קישור בתוך הספר נספר פעם אחת. המזהה הוא
  `<מקור>:user:<rowid>`, עם `dbTable: "user_link"` ו־provenance `db`. אפשר להציג ולהעתיק לפרויקט, אבל לא לייצא כמו שהוא
  (AGENTS §3).
- **הצד השני:** צד אישי (דגל 1, בלי slug) הוא ספר של המסד הזה לפי כותרת מדויקת, ועם קטגוריה אם יש. אם אין ספר כזה, הצד
  לא נפתר (`unresolved:`, origin `personal`). צד רשמי נפתר רק בספרייה הפתוחה. צד עם slug נפתר רק במסד שה־slug שלו
  (`otzariaSlug`) שווה. אם המקור לא פתוח, הצד לא נפתר (origin `otzaria`/`personal`). צד אף פעם לא נקשר לספר באותה כותרת מסוג
  אחר.
- **טווח ועוגן:** `*End` עובר דרך `rangeEnd` כמו כל טווח במסד. סוף שאינו מספר שלם, שאינו אחרי ההתחלה, או שגדול
  מ־`MAX_BOOK_LINES` לא נלקח. הסוף נחתך לפי אורך הספר כשהאורך ידוע. העוגן הוא `Link.anchor` (`RawAnchor`), כמו בקובץ.
  "העתקה לפרויקט" מעתיקה אותו כמו שהוא לרשומה שלא מתהפכת, ואם הרשומה מתהפכת היא מזהירה `adopt/anchor-lost`.
- **סוג:** NULL או ריק נחשב REFERENCE. כל שם אחר עובר דרך `parseConnectionType`, ושם לא מוכר נחשב OTHER.
- **שורות שאינן קישור:** שורה עם מספר שורה שאינו מספר שלם חיובי נספרת ב־`unlisted.badLine`. שורה בלי `targetLineIndex`, או
  עם דגל שאינו מספר שלם, נספרת ב־`noPlace`. שורת `book-id` שהספר שלה לא קיים נספרת ב־`orphanSource`.
- **כמה טבלאות במסד אחד** (`link` + `external_link` + `user_link`): כל קישור מופיע פעם אחת. שורה בטבלה מאוחרת יותר, שחוזרת
  על שורה של טבלה קודמת (אותו כיוון, שורה, ספר ושורה בצד השני, וסוג), נושרת. `DbLinkSummary.tables.userLink` אומר כמה
  שורות נתנה הטבלה.
- **מגבלות:**
  1. שורה ששני הצדדים שלה מחוץ למסד (רשמי ← רשמי, `8a37b7a91`) לא מוצגת. הכלי מציג קישורים לפי ספרי המסד, וספר הספרייה
     לא מקבל את הקישורים האישיים שלו מ־`user_books.db`.
  2. שני ספרים אישיים באותה כותרת, ושורה בלי קטגוריה: הכלי בוחר את הראשון (המזהה הנמוך). האפליקציה מציגה את השורה בשניהם.
  3. בצד היעד, `LINKER` מוצג כקישור נכנס, בסוג השמור ולא בסוג ההפוך.
  4. אין מסד `user_books.db` אמיתי עם קישורים בבדיקות. הבדיקות רצות על fixtures מה־DDL האמיתי
     (`tests/fixtures/schemas/user-books.sql`, `user-books-user-link-v1.sql`), עם שורות placeholder.

## 7. איך לקרוא, לכל ספר

הסדר הבא תקף בכל סכמה. כל שלב מותנה ביכולת שנמצאה.

```
1. ct = map(connection_type.id → name)                 // סריקה, 24 שורות
2. יוצאים:  link WHERE sourceBookId = B                // seek ב־idx_link_source_book, ואחריו rowid
   נכנסים: link WHERE targetBookId = B                 // seek ב־idx_link_target_book
   (במסד ≥1: לשורה אחת, idx_link_source_targetorder / idx_link_target_line)
3. לכל linkId (ממוינים, כדי שה־seeks יהיו רציפים):
   a. anchors[linkId]    ← link_anchor     (PK seek, linkId)          אם hasLinkAnchors
   b. range[linkId,side] ← link_range      (PK seek)                   אם hasLinkRanges
   c. hidden[linkId,side]← link_suppressed_side (PK seek)              אם קיים (סכמה ≥3)
4. coverage: רק כשרוצים "אילו קישורים מכסים שורה" → link_coverage PK seek לפי lineId
5. נרמול לרשומה אחידה:
   { linkId, type: ct[connectionTypeId],
     from: {book: sourceBookId, line: lineIndex(sourceLineId), endLine?: range[...,0]},
     to:   {book: targetBookId, line: targetLineIndex ?? lineIndex(targetLineId), endLine?: range[...,1]},
     anchors: [...], hiddenSides: mask, baseProvenance ?? 0 }
   lineIndex(lineId): seek ב־INTEGER PK של line (מפתח rowid). שומרים מטמון לפי ספר.
6. SOURCE וירטואלי: ההיפוך נעשה בתצוגה, לא באחסון.
```

**עלויות:**
- ספר גדול, כמו בראשית, עשוי לכלול עשרות אלפי קישורים. כל קישור דורש seek בטבלת `link` (b-tree של כ־6.9M
  שורות, עומק 3–4), ועוד 1–3 seeks בטבלאות הצד.
- ייצוא של **כל** הקישורים יעיל יותר בסריקה רציפה של `link` ושל כל טבלת צד, עם מיזוג לפי linkId, מאשר
  במיליוני seeks.
- `link_anchor`, `link_range` ו־`link_suppressed_side` הן טבלאות rowid עם PK מורכב. לכן seek הוא שני שלבים:
  autoindex → rowid → רשומה. בסריקה מלאה של הטבלה עצמה השלב הזה נחסך.

</div>
