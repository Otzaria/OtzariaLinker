<div dir="rtl">

# ביקורת: מסד אישי `otzarya-unofficial-books` גרסה 52

מסמך מחקר. הוא מתעד מה נמדד במסד אישי אמיתי של Personal-DB-Creator (PDC), כדי לבסס את קורא `external_link` ([issue #13](https://github.com/Otzaria/OtzariaLinker/issues/13)) ואת ה־fixtures שלו. המסמך אינו חוזה: החוזים נשארים ב־[`DATABASE_SUPPORT_MATRIX.md`](../contracts/DATABASE_SUPPORT_MATRIX.md) (§3 דחיסה, §5.2–5.3 מסדים אישיים) וב־[`LINK_SCHEMA_MATRIX.md`](../contracts/LINK_SCHEMA_MATRIX.md) (§6 קישורים במסדים אישיים).

**זכויות יוצרים.** הקובץ מכיל ספרים שיש עליהם הגבלת זכויות יוצרים. הוא נפתח **לקריאה בלבד** (`new DatabaseSync(path, { readOnly: true })` ב־`node:sqlite`), לא הועתק, ואף טקסט ספר לא נכנס לריפו. כאן מופיעים רק שמות ספרים כתוויות קצרות. מסד המקור לא נמצא בריפו ולא יהיה: ה־fixture העתידי נבנה מה־DDL שבסעיף 2 עם טקסט גנרי (AGENTS.md §2.3, ADR 0004).

**איך לקרוא את המספרים.** כל מספר מסומן באחד משני אופנים:

- **(אומת)**: נמדד מחדש בעת כתיבת המסמך, בשאילתת SQL לקריאה בלבד על הקובץ (או על המסד הרשמי המקומי), ב־2026-11-22.
- **(ביקורת קודמת)**: נלקח מהרצה קודמת של ביקורת מלאה, כולל פענוח zstd של כל 6,617,071 השורות (84 שניות). לא נמדד מחדש כאן.

מה שאינו מסומן ב־(אומת) הוא "ביקורת קודמת". סעיף 8 מפרט מה לא נמדד בכלל.

## 1. עובדות הקובץ

| מדד | ערך | סטטוס |
|---|---|---|
| שם הקובץ | `otzarya-unofficial-books-52.db` | — |
| תאריך המדידה | 2026-11-22 | — |
| גודל | 1,741,164,544 בתים = `page_size` × `page_count` | אומת |
| SHA-256 | `8679a2ea55828701581600cdae363d4ee97f48813b10f7277ce4385405417992` | אומת |
| `PRAGMA user_version` | 0 | אומת |
| `PRAGMA application_id` | 0 | אומת |
| `page_size` / `page_count` / `freelist_count` | 4096 / 425,089 / 0 | אומת |
| קידוד / `journal_mode` | UTF-8 / delete | אומת |
| `PRAGMA quick_check` | `ok`, 12.3 שניות (§9.1) | אומת |
| `PRAGMA integrity_check` | לא הורץ | — |

`schema_meta` (8 שורות, אומת): `display_name`, `library_name`, `description`, `author` (`YairDaniel11`), `library_id` (`otzarya-unofficial-books`), `db_version` (`52`), `update_manifest_url`, `update_public_key`. **אין `db_schema_version`**, ולכן `declaredSchema` ריק והסכמה מוסקת מהטבלאות (`line_content` ובלי `line_note` ובלי `contentHash`: סכמה 6). זה תואם את "היסטוריה" ב־[DATABASE_SUPPORT_MATRIX §5.3](../contracts/DATABASE_SUPPORT_MATRIX.md) (לפני `15cbc67`), אבל החוזה לא אומר שזו צורת ה־PDC הנפוצה בפועל.

## 2. סכמה

16 טבלאות, 0 views (אומת): `author`, `book`, `book_author`, `book_generation`, `category`, `connection_type`, `external_link`, `generation`, `line`, `line_content`, `line_toc`, `schema_meta`, `source`, `tocEntry`, `tocText`, `zstd_dict`.

אינדקסים בשם (אומת): `idx_line_book_index`, `idx_toc_book`, `idx_external_link_source`.

DDL מדויק של `external_link` (מ־`sqlite_master`, אומת):

```sql
CREATE TABLE external_link (
  sourceBookId INTEGER NOT NULL, sourceLineIndex INTEGER NOT NULL,
  targetSource TEXT, targetTitle TEXT NOT NULL, targetRef TEXT,
  targetLineIndex INTEGER, connectionType TEXT)
CREATE INDEX idx_external_link_source ON external_link(sourceBookId, sourceLineIndex)
```

זו טבלת rowid בלי מפתח ראשי. ה־DDL זהה לתיאור ב־[LINK_SCHEMA_MATRIX §6](../contracts/LINK_SCHEMA_MATRIX.md) (7 עמודות, `connectionType TEXT`).

DDL של שאר הטבלאות שהכלי קורא (אומת):

```sql
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)
CREATE TABLE book (
  id INTEGER PRIMARY KEY, categoryId INTEGER NOT NULL, sourceId INTEGER NOT NULL,
  title TEXT NOT NULL, heShortDesc TEXT, orderIndex INTEGER NOT NULL DEFAULT 999,
  totalLines INTEGER NOT NULL DEFAULT 0, isBaseBook INTEGER NOT NULL DEFAULT 0,
  hasSourceConnection INTEGER NOT NULL DEFAULT 0, hasAltStructures INTEGER NOT NULL DEFAULT 0,
  fileType TEXT DEFAULT 'txt')
CREATE TABLE line (
  id INTEGER PRIMARY KEY, bookId INTEGER NOT NULL, lineIndex INTEGER NOT NULL,
  heRef TEXT, tocEntryId INTEGER)
CREATE TABLE line_content (id INTEGER PRIMARY KEY NOT NULL, content BLOB NOT NULL)
CREATE TABLE zstd_dict (id INTEGER PRIMARY KEY NOT NULL, dict BLOB NOT NULL)
CREATE TABLE connection_type (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)
CREATE TABLE tocEntry (
  id INTEGER PRIMARY KEY, bookId INTEGER NOT NULL, parentId INTEGER, textId INTEGER NOT NULL,
  level INTEGER NOT NULL, lineId INTEGER, isLastChild INTEGER NOT NULL DEFAULT 0,
  hasChildren INTEGER NOT NULL DEFAULT 0)
CREATE INDEX idx_line_book_index ON line(bookId, lineIndex)
```

מה שאין (אומת מרשימת הטבלאות): `link`, `link_anchor`, `link_range`, `link_coverage`, `link_suppressed_side`, `book_has_links`, `line_ref`, `line_dh`, `line_note`, `book_version`, `version_line`. אין בטבלת `book` את `contentHash`, `dependenceType`, `heRef`.

הערה: ב־`line_content` ההצהרה היא `BLOB NOT NULL`; ברשמי היא `TEXT NOT NULL` ([DATABASE_SUPPORT_MATRIX §3.1](../contracts/DATABASE_SUPPORT_MATRIX.md), הצהרת העמודה). ‏`connection_type` מכיל שורה אחת: `1 = SOURCE` (אומת).

## 3. ספירות

| מדד | ערך | סטטוס |
|---|---|---|
| `external_link` | 1,287,793 שורות; `rowid` 1…1,287,793 רציף | אומת |
| `book` | 3,372 | אומת |
| ספרים בלי אף קישור, לא יוצא ולא נכנס פנימי (`external_link`) | 1,993 (59.1% מ־3,372); 1,224 ספרים עם קישור יוצא | אומת |
| `line` | 6,617,071 | אומת |
| `line.id` מרבי | 10,332,667,988 (ל־2^32 = 4,294,967,296, ולכן הוא גדול ממנו פי 2.4) | אומת |
| `zstd_dict` | שורה אחת, `id = 32768`, 112,640 בתים | אומת |
| `line.heRef` שאינו NULL | 0 (העמודה ריקה בכל השורות) | אומת |
| ספרים עם `external_link` יוצא | 1,224 | אומת |
| שורות מקור ייחודיות ב־`external_link` | 726,616 | אומת |
| `line_content` | 6,617,071, כולן `blob`, כולן zstd עם `dictID=32768`, אפס שגיאות פענוח | ביקורת קודמת |
| `tocEntry` / `tocText` / `line_toc` | 794,983 / 184,551 / 5,716,058 | ביקורת קודמת |
| `category` / `source` / `generation` / `author` | 340 / 1 / 5 / 396 | ביקורת קודמת |
| נפח `line_content` | 1,039,911,231 בתים דחוס, 3,482,194,374 מפוענח | ביקורת קודמת |
| `line.id = bookId·2^20 + lineIndex + 1` | בכל 6,617,071 השורות (סכמת PDC) | ביקורת קודמת |
| `book.totalLines` = מספר שורות `line` | בכל 3,372 הספרים | ביקורת קודמת |
| שורות כותרת (`^<h[1-6]`) | 795,007 מתוך 6,617,071 | ביקורת קודמת |

### 3.1 `external_link` לפי `connectionType` (אומת)

| `connectionType` | שורות |
|---|---|
| `FOOTNOTES` | 686,930 |
| `SOURCE` | 569,639 |
| `REFERENCE` | 30,915 |
| `COMMENTARY` | 309 |
| `NULL` | 0 |
| **סך הכול** | **1,287,793** |

### 3.2 `external_link` לפי `targetSource` (אומת)

| `targetSource` | שורות | `targetRef` |
|---|---|---|
| `official` | 562,808 (כולן `SOURCE`) | תמיד מלא (ביקורת קודמת) |
| `otzarya-unofficial-books` (= `library_id` של המסד עצמו) | 724,985 | תמיד NULL (אומת: 724,985 NULL, כולם במחלקה הזו) |

אין NULL ב־`targetSource` ואין `targetSource` של מסד אחר. `targetLineIndex` אינו NULL באף שורה (אומת).

### 3.3 לפי מחלקה: `targetSource` × `connectionType` (אומת)

| מחלקה | שורות |
|---|---|
| official / SOURCE | 562,808 |
| own / FOOTNOTES | 686,930 |
| own / REFERENCE | 30,915 |
| own / SOURCE | 6,831 |
| own / COMMENTARY | 309 |

## 4. משמעות `external_link`

כל הקישורים של המסד כאן. אין `link`. הכלי כיום מזהה את הטבלה כיכולת (`externalLinks: has("external_link")`) אך אין אף קורא שלה; זה issue #13.

| עמודה | משמעות | סטטוס |
|---|---|---|
| `sourceBookId`, `sourceLineIndex` | הצד השמור "מקור": ספר **של המסד הזה** לפי `book.id`, ו־`lineIndex` מבוסס 0. 0 ספרים חסרים, 0 מחוץ לטווח | ביקורת קודמת |
| `targetSource` | `official` או `library_id` של המסד עצמו (§3.2) | אומת |
| `targetTitle` | כותרת הספר ביעד, התאמה מדויקת. ב־`official`: 162 כותרות, כולן נמצאות ברשמי המקומי ובלי עמימות | ביקורת קודמת |
| `targetRef` | ב־`official`: **שווה ל־`heRef` של השורה הרשמית** באותו (כותרת, `targetLineIndex`) ב־562,808 מתוך 562,808 | ביקורת קודמת |
| `targetLineIndex` | תמיד מלא, מבוסס 0, בצד היעד | אומת (מלא), ביקורת קודמת (0-based) |
| `connectionType` | טקסט חופשי, **לא** `connection_type.id`. ארבעת הערכים של §3.1 מזוהים כולם ב־`parseConnectionType` | אומת (ערכים), ביקורת קודמת (זיהוי) |

**כיוון.**

- `official / SOURCE`: המקור הוא השורה האישית (הספר התלוי), היעד הוא הספרייה הרשמית (הבסיס). זה כיוון **הפוך** מהאחסון הרשמי (בסיס → תלוי). `SOURCE` הוא הסוג הווירטואלי שברשמי אינו נשמר, וכך כותב PDC (COMMENTARY מתהפך ל־SOURCE; [LINK_SCHEMA_MATRIX §6](../contracts/LINK_SCHEMA_MATRIX.md)). הקורא חייב לתייג אותו "שמור תלוי → בסיס" ולא כקישור `source` של הגנרטור (ראו [`DH_ANCHOR_DIRECTION.md`](DH_ANCHOR_DIRECTION.md) על כיוון ועוגנים).
- `own / FOOTNOTES`: בסיס → הערה (כיוון אחסון רשמי). בכל 686,930 השורות הספר ביעד הוא ספר שכותרתו `"הערות על " + כותרת המקור` (ביקורת קודמת).
- `own / REFERENCE` ו־`own / SOURCE`: פנימיים בין ספרי המסד (ביקורת קודמת).

**מה אין בטבלה** (מהסכמה, אומת): אין עוגני תווים (`charStart`/`charEnd`), אין קצות טווח (`*_end`), אין צד מוסתר, ואין עמודת מזהה. מכאן שהקורא לא מייצר עוגן, טווח או צד מוסתר, ו**המזהה היציב של קישור הוא `ext:<rowid>`** (ה־`rowid` רציף 1…1,287,793, אומת). `rowid` יציב כל עוד הקובץ לא נבנה מחדש; בבנייה מחדש של PDC המזהים משתנים, וזה גבול המזהה.

## 5. ממצאי איכות

| ממצא | מספר | סטטוס |
|---|---|---|
| יעד פנימי מחוץ לטווח (`targetLineIndex >= totalLines` של ספר היעד) | **162** (כולם בשורות של "ברכות", `own / SOURCE`) | אומת (JOIN על הכותרת) |
| קישורים פנימיים הפוכים כפולים | **618 רשומות = 309 זוגות** (אותו זוג שורות נשמר גם `COMMENTARY` וגם `SOURCE` בכיוון ההפוך) | אומת (618 רשומות), ביקורת קודמת (309 זוגות זהים ל־`COMMENTARY`) |
| התנגשות כותרות בין המסד האישי לרשמי | **36** כותרות זהות | אומת |
| `own / SOURCE` שמצביעים על "ברכות" | 6,522 שורות; `targetLineIndex` מרבי 2,874 | אומת |
| אורך "ברכות" האישי / הרשמי | 2,779 / 2,875 שורות (מזהים 9386 / 103) | אומת |
| יעד שהוא שורת כותרת | 1,469 (`own / SOURCE` 1,210, `own / REFERENCE` 259) | ביקורת קודמת |
| מקור שהוא שורת כותרת | 12 (כולם `own / FOOTNOTES`) | ביקורת קודמת |
| מקור שהוא שורה ריקה | 2 (`official / SOURCE`) | ביקורת קודמת |
| `official`: `targetRef` ≠ `heRef` / כותרת לא נמצאת או עמומה / `lineIndex` מחוץ לטווח | 0 / 0 / 0 | ביקורת קודמת |

**התנגשות הכותרות "ברכות".** לכל 6,522 קישורי `own / SOURCE` האלה `targetSource` הוא ה־`library_id` של המסד, אבל הכותרת "ברכות" קיימת פעמיים: ספר אישי (פיוט, 2,779 שורות) וספר רשמי (תלמוד בבלי, 2,875 שורות). ה־`targetLineIndex` המרבי, 2,874, מתאים לאורך הרשמי ולא לאישי, ו־162 קישורים חורגים מהספר האישי. המסקנה הזהירה: היעד המכוון הוא כנראה הספר הרשמי, ו־`targetSource` שגוי. **אין אישור סופי**, ולכן הקורא לא "מתקן" את היעד: הוא פותר לפי `targetSource` (הספר האישי). **הקורא מסמן כעת בכל קישור `dbFlags`** (`target-out-of-range`, `header-target`, `header-source`, `reverse-duplicate`, `ambiguous-title`, ואחר כך גם `source-out-of-range`: שורת מקור מעבר לסוף ספר המקור) וסופר אותם בסיכום (`DbLinkSummary.flags`). שורה שאי אפשר להפוך לקישור (מספר שורה שאינו שלם חיובי, אין יעד ואין ref, ספר מקור שאינו קיים) נספרת ב־`DbLinkSummary.unlisted` ולא נעלמת בשקט. נמדד מול המסד האמיתי והמסד הרשמי (`external-links-real-db.local.test.ts`): ב־6,522 הקישורים אל "ברכות": **162 יעד מחוץ לטווח, 1,210 יעד שהוא כותרת, 6,522 כותרת עמומה** (אותם 162 ו־1,210 של §5 והביקורת הקודמת); זמן בניית הרשימה 7.8 שניות. כשבמסד שני ספרים באותה כותרת, הראשון (המזהה הנמוך) נבחר, בקורא ובמרשם כאחד.

**כפילות הפוכה.** לפי AGENTS.md §3 קישור הפוך הוא קישור כפול (האפליקציה מציגה כל קישור בשני הצדדים). הקורא לא מוחק את אחד מהם ומציג את שניהם. הכפילות מסומנת `reverse-duplicate` בשני הקישורים של הזוג (309 זוגות ב־v52; נבדק בבדיקת האינטגרציה על fixture, ובסריקה: `scripts/audit/personal-db-audit.mjs`).

## 6. `line.id` מעל 2^32 מול `Int32Array`

`line.id` מגיע ל־10,332,667,988 (אומת), כלומר מעל 2^31 וגם מעל 2^32. כל מערך typed של 32 ביט שמחזיק `line.id` (למשל `Int32Array` או `Uint32Array`) חותך את הערך בשקט. בסכמת PDC `line.id = bookId·2^20 + lineIndex + 1`, ולכן ספר שה־`bookId` שלו מעל 4,095 כבר חורג מ־2^32, והמזהה המרבי כאן שייך לספר 9,854 (ביקורת קודמת: המזהים 1…9,854).

השלכה: נתיב `external_link` לא צריך `line.id` (כתובת שורה = `(bookId, lineIndex)`), אבל כל קורא שמצרף `line.id` ל־`link` במסד PDC ייכשל בשקט. נדרשת בדיקה עם `line.id > 2^32` ושימוש ב־`Float64Array` או ב־`number[]` במקומות האלה. פענוח varint ב־`record.ts` תקין לערכים כאלה לפי קריאת הקוד; **לא נבדק על קובץ**.

## 7. התנגשות `dictID 32768`

| מסד | `zstd_dict.id` | גודל המילון | סטטוס |
|---|---|---|---|
| v52 האישי | 32768 | **112,640 בתים** | אומת |
| הרשמי המקומי (`seforim.db`, `db_version=39`, `db_schema_version=7`) | 32768 | **2,097,152 בתים** | אומת |

אותו מזהה, שני מילונים שונים בגודלם (בגיבוב: SHA-256 `61b5d6f5…f728` מול `7b08b7c3…a396`; ביקורת קודמת). לכן:

- כל מסד נפתח ומפוענח **עם המילון של עצמו** מתוך `zstd_dict` שלו. אסור להניח שה־`dictID` בכותרת המסגרת מזהה מילון ברמת הסשן.
- **נבדק בפועל (2026-11-22):** `tests/integration/database/dictionary-collision-real-db.local.test.ts` פותח את שני המסדים יחד, בשני הסדרים, ו־`sharedDictionaries.isConflicted(32768)` הוא true; מכל מסד נקראות שורות של 3 ספרים לפחות, מפוענחות עם המילון של עצמו (הרצה מקומית עם `OTZARIA_DB` ו־`OTZARIA_PERSONAL_DB`: 1 passed).
- [DATABASE_SUPPORT_MATRIX §3.4](../contracts/DATABASE_SUPPORT_MATRIX.md) מניח שמסד PDC מעתיק את המילון הרשמי. ב־v52 זה לא נכון: המילון קטן בהרבה ושונה.
- מסד אישי שדחוס במילון הרשמי **בלי** `zstd_dict` משלו לא נפתר נכון בבריכת מילונים שבוחרת לפי dictID בלבד (B19, issue #41): כשרק v52 פתוח, הוא קיבל את המילון של v52. **תוקן (2026-11-26):** הבריכה שואלת רק את המילון הרשמי (לפי SHA-256) או קובץ מילון שהמשתמש פתח; `tests/integration/database/zstd.test.ts` (על מילון שני עם אותו dictID) ו־`dictionary-identity-real-db.local.test.ts` (על הרשמי האמיתי). מסד v52 עצמו לא היה זמין בבדיקה הזו. מאז, `isConflicted(32768)` כששני המסדים פתוחים הוא false: רק הרשמי מותר לשאילה.

## 8. מה לא נמדד

- `PRAGMA integrity_check` (נמדד רק `quick_check`, §9.1).
- זמן קריאה של `external_link` **בקורא העצל של הכלי** נמדד (הבדיקה המקומית `external-links-real-db.local.test.ts`: 724,985 שורות פנימיות ב־3.6 שניות, 119,385 שורות יוצאות של ספר אחד ב־0.37 שנייה; מצוטט ב־[DATABASE_SUPPORT_MATRIX](../contracts/DATABASE_SUPPORT_MATRIX.md) §5.3). לא נמדד: זיכרון (RSS) בזמן הקריאה.
- הרצת OtzariaLinker כולו (ממשק) על המסד.
- התאמה מול גרסאות אחרות של המסד הרשמי (נבדק רק מול `db_version=39`), ויציבות `targetLineIndex` ב־`official` בין גרסאות.
- מקור המילון של 112,640 הבתים.
- בדיקה סמנטית (שהיעד באמת הוא מה שהמפרש התכוון אליו): הדגימה ב־§9.4 בודקת קיום, טווח, כותרת וחוסר ריקנות, לא משמעות.
- מספרי "ביקורת קודמת" ב־§1–§7 שלא נמדדו מחדש בסקריפט (שורות כותרת בטקסט המפוענח, 6,617,071 שורות מפוענחות) נשארים מסומנים; §9 מוסיף מדידות מחדש של חלקם (מסומנות "סקריפט").

## 9. השלמה: מדידות הסקריפט `scripts/audit/personal-db-audit.mjs`

הסקריפט (קריאה בלבד, `node:sqlite` עם `readOnly: true`; פלט מצרפי בלבד) נכתב כדי שאפשר יהיה לשחזר: `node scripts/audit/personal-db-audit.mjs <db> --official <seforim.db> --phase stats|sample|graph|quick-check`. הריצה כאן: 2026-11-22, אותו SHA-256 של §1. **שלושה חלקים נפרדים:** סטטיסטיקה (§9.1–9.3), דגימה (§9.4: איך נבחרו) והערכה (§9.5: מה נמצא). אין כאן טקסט ספרים, רק שמות ספרים במספר קטן.

### 9.1 קובץ ושלמות

| מדד | ערך |
|---|---|
| `PRAGMA quick_check` | `ok`, 12.3 שניות (המסד 1.74GB על דיסק מקומי) |
| `foreign_key_list` | 0 מפתחות זרים בכל 16 הטבלאות; `foreign_key_check`: 0 הפרות |
| מפתחות ראשיים | כל הטבלאות בעלות PK; **`external_link` אין לה PK** (טבלת rowid) |
| `index_list` של `external_link` | אינדקס אחד: `idx_external_link_source(sourceBookId, sourceLineIndex)`, לא ייחודי (אין אינדקס על היעד) |
| `index_list` של `line` | `idx_line_book_index(bookId, lineIndex)`; ל־`line_content` אין אינדקס מלבד ה־PK |
| כלל `line.id = bookId·2^20 + lineIndex + 1` | 200,000 מ־200,000 שורות שנבדקו |

### 9.2 ספירות ופילוחים (סטטיסטיקה)

| מדד | ערך |
|---|---|
| זוגות ספרים ייחודיים (מקור, מקור־יעד, כותרת־יעד) | 1,420 |
| זוגות שורות ייחודיים | 1,287,793 (= מספר השורות) |
| שורות מקור ייחודיות / שורות יעד ייחודיות / ספרי מקור | 726,616 / 740,234 / 1,224 |
| `connectionType` שאינו מוכר ל־`parseConnectionType` | 0 ערכים, 0 שורות (רק FOOTNOTES, SOURCE, REFERENCE, COMMENTARY) |
| כפילות באותו כיוון: זהה בכל העמודות / אותן שתי שורות ואותו סוג | 0 / 0 |
| אותן שתי שורות בסוגים שונים | 0 קבוצות |
| כפילות הפוכה פנימית | 618 שורות = 309 זוגות |
| ספרים בלי אף קישור (יוצא או נכנס פנימי) | 1,993 מ־3,372 |
| התפלגות דרגה יוצאת (ספרים): 0 / 1–9 / 10–99 / 100–999 / 1,000–9,999 / 10,000–99,999 / 100,000+ | 2,148 / 118 / 381 / 584 / 114 / 26 / 1 |

**פילוח לפי קטגוריית שורש** (ספרים; שורות; ספרים עם קישור יוצא; בלי אף קישור):

| קטגוריה | ספרים | שורות | עם יוצא | בלי קישור |
|---|---|---|---|---|
| תלמוד בבלי | 887 | 3,260,723 | 617 | 202 |
| תנ״ך | 641 | 642,010 | 537 | 67 |
| שו״ת | 587 | 288,396 | 1 | 586 |
| ספרות עזר | 481 | 1,171,047 | 26 | 432 |
| מדרש | 170 | 29,986 | 0 | 170 |
| קבלה | 163 | 256,323 | 0 | 163 |
| הלכה | 141 | 349,143 | 12 | 129 |
| חסידות | 92 | 208,015 | 0 | 92 |
| מחשבת ישראל | 67 | 61,156 | 8 | 53 |
| בית שני | 45 | 15,707 | 21 | 3 |
| ספרי מוסר | 37 | 114,761 | 0 | 37 |
| סדר התפילה | 31 | 57,414 | 0 | 31 |
| משנה | 28 | 161,285 | 0 | 28 |
| תלמוד ירושלמי | 2 | 1,105 | 2 | 0 |

**ספרים מובילים.** יוצאים (שורות): אנציקלופדיה תלמודית אות מ 119,385; אות כ 67,937; אות ח 61,081; אות י 45,001; אות ל 35,380 (כל 15 הראשונים הם ספרי האנציקלופדיה התלמודית, חוץ מ"מפתח האנציקלופדיה התלמודית" 27,466 ו"קובץ מסכת כתובות" 23,982). נכנסים פנימיים: ספרי "הערות על אנציקלופדיה תלמודית אות …", כל אחד מקבל בדיוק את מספר השורות היוצאות של ספר האות. נכנסים רשמיים: בבא בתרא 57,917 (מ־29 ספרים), שבת 23,691 (8), קידושין 19,377 (26), תהילים 18,889 (11), בבא קמא 17,876 (19).

**סימנים לפי שורה (סריקה אחת, `tocEntry.lineId` כתחליף לשורת כותרת):** יעד פנימי מחוץ לטווח 162; יעד פנימי שהוא שורת TOC 1,469; מקור שהוא שורת TOC 12; יעד רשמי מחוץ לטווח 0 (מול המסד הרשמי המקומי `db_version=39`); כותרת יעד שלא נפתרה 0. (אותם מספרים של §5, כעת מהסקריפט.)

**ספרים שנראים כמפרשים בלי קישור (ניחוש, לא ביקורת תוכן):** מבין 759 ספרים שנראים כמפרשים (131 לפי קטגוריה, 154 "הערות על …", 655 "X על Y" כש־Y ספר קיים; חפיפות), **135 בלי אף קישור**: 100 לפי קטגוריה, 50 לפי כותרת "X על Y" (חפיפה ביניהם); לפי שורש: קבלה 40, הלכה 25, תלמוד בבלי 23, סדר התפילה 17, משנה 14, תנ״ך 11, מחשבת ישראל 4, חסידות 1. (המדד שונה מהמדד ב־§3, "58 בלי קישור", כי הסקריפט בודק גם קטגוריה וגם כותרת מול ספרי המסד הרשמי; מספרי §3 נשארים כפי שנמדדו שם.)

### 9.3 גרף היחסים

הפירוט ב־[PERSONAL_DB_RELATION_MAP.md](PERSONAL_DB_RELATION_MAP.md).

### 9.4 הדגימה (איך נבחרה)

- **דגימה אקראית מרובדת, זרע 52** (`mulberry32`): 60 קישורים מכל אחת מ־5 שכבות של (פנימי/רשמי × סוג): official/SOURCE (562,808), internal/FOOTNOTES (686,930), internal/SOURCE (6,831), internal/COMMENTARY (309), internal/REFERENCE (30,915). סה״כ 300. הדגימה אינה פרופורציונלית לגודל השכבה בכוונה: היא נותנת מדד לכל שכבה, ולא לכל המסד.
- **דגימה ממוקדת כישלון, אותו זרע:** עד 60 מכל אחת מהאוכלוסיות שזוהו בסריקה: יעד מחוץ לטווח (162), יעד שהוא שורת TOC (1,469), מקור שהוא שורת TOC (12), יעד שלא נפתר (0).
- **בדיקה לכל קישור** מול הטבלאות האמיתיות, והטקסט המפוענח עם המילון של כל מסד: ספר המקור קיים; שורת המקור בטווח, קיימת, מפוענחת, אינה כותרת (`<h1>`–`<h6>` בתחילתה) ואינה ריקה; ספר היעד נמצא (פנימי: במסד; רשמי: לפי כותרת מדויקת במסד הרשמי); שורת היעד בטווח, קיימת, אינה כותרת ואינה ריקה; ביעד רשמי עם `targetRef`: שווה ל־`heRef` של שורת הרשמי.

### 9.5 תוצאות ההערכה (ספירות בלבד)

| שכבה (60 בכל אחת) | מקור תקין | יעד נמצא | יעד בטווח | יעד אינו כותרת | `targetRef` = heRef | עבר הכול |
|---|---|---|---|---|---|---|
| official/SOURCE | 60 | 60 | 60 | 60 | 60 מתוך 60 | 60 |
| internal/FOOTNOTES | 60 | 60 | 60 | 60 | — | 60 |
| internal/COMMENTARY | 60 | 60 | 60 | 60 | — | 60 |
| internal/REFERENCE | 60 | 60 | 60 | 60 | — | 60 |
| internal/SOURCE | 60 | 60 | 60 | **51** | — | **51** |

הכישלון היחיד בדגימה האקראית: 9 מ־60 קישורי internal/SOURCE מצביעים על שורת כותרת. **הדגימה הממוקדת:** 60 מ־60 מהאוכלוסייה "יעד מחוץ לטווח" נכשלו בטווח (כל 60 חורגים), 60 מ־60 מ"יעד שהוא שורת TOC" הם אכן שורות כותרת בטקסט המפוענח, ו־12 מ־12 "מקור שהוא שורת TOC" הם שורות כותרת. כלומר הסימון לפי `tocEntry.lineId` מדויק בדגימות האלה (כל 132 הנדגמים אושרו בטקסט המפוענח), אך לא נמדד כמה כותרות אינן ב־`tocEntry`. כל 300 הנדגמים: 0 שורות שלא ניתן לפענח.

מגבלות: 60 מכל שכבה אינו מספיק למדידת שיעור נדיר (שכבת 309 הקישורים נדגמה בכחמישית); שיעור הכישלון בשכבת internal/SOURCE (15%) הוא מדידה על 60 קישורים, ולא על 6,831.


</div>
