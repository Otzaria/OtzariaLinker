<div dir="rtl">

# חוזה: תמיכה במסדי אוצריא — סכמות 0–7, דחיסה, מסדים אישיים

**מצב:** מחקר שלב 2/3 · 2026-11-11 · מקורות מאומתים מול המסד האמיתי

המסמך קובע מה הכלי צריך לדעת כדי לקרוא כל מסד אוצריא: הרשמי `seforim.db` בכל סכמה,
מסדים אישיים ומסדי SQLite כלליים. טבלאות הקישורים מפורטות בנפרד ב־
[LINK_SCHEMA_MATRIX.md](LINK_SCHEMA_MATRIX.md). ה־DDL המלא של כל סכמה נמצא ב־
`tests/fixtures/schemas/v0.sql`…`v7.sql`.

## 0. מקורות

| מקור | מיקום | גרסה שנקראה |
|---|---|---|
| המחולל (המזלג, **לא** kdroidFilter) | `Otzaria/SeforimLibrary`, ענף `otzaria` | `23f1f8f1` (2026-11-10) |
| האפליקציה | `Otzaria/otzaria`, `upstream/dev` | `ea1f00d20` (2026-11-11) |
| Personal-DB-Creator (PDC) | `YairDaniel11/Personal-DB-Creator` | `8103ad1` (סכמה 7 נכנסה ב־`15cbc67`, 2026-11-02) |
| המסד האמיתי | `C:\ProgramData\otzaria\books\seforim.db`, נפתח `mode=ro` בלבד | `db_version=37`, `db_schema_version=7` |

כל מספרי השורות במזלג מתייחסים ל־`23f1f8f1`. נתיב ה־DDL הוא
`dao/src/commonMain/sqldelight/io/github/kdroidfilter/seforimlibrary/db/Database.sq`, ובהמשך המסמך הוא נקרא בקיצור
`Database.sq`. הכלים ששימשו למחקר נמצאים ב־`DEV/_linker-research/db/`: `timeline.py` ו־`timeline.txt` (ציר
השינויים של כל ה־DDL), `gen_fixtures.py`, `stats.py`, `qp.py` ו־`zstd-js/`.

## 1. איך נקבע מספר הסכמה (ולמה 1–4 "מוזרות")

- **מי כותב.** `stampSchemaVersion` כותב את `schema_meta.db_schema_version`
  (`generator/common/.../patch/StampSchemaVersionCli.kt:51-129`). הכתיבה עצמה מתבצעת ב־`INSERT OR REPLACE`
  בשורות 116-121. לפני הכתיבה הפונקציה מוודאת שהטבלאות הנדרשות קיימות (שורות 58-79).
- **סכמות 1–4.** בתחילה ערך ברירת המחדל היה **`PatchDbSchema.CURRENT_VERSION`**, כלומר גרסת פורמט
  ה־patch ולא גרסה של ה־DDL (`06b190c2`, 2026-05-13). לכן המספרים 1–4 סופרים שינויים בחוזה ה־delta.
  שינויים רבים ב־DDL נכנסו **בלי** העלאת מספר.
- **מסכמה 5 ואילך.** הקבוע הוא `CURRENT_DB_SCHEMA_VERSION` (`PatchTables.kt:24`, כיום 7). החוזה הקפוא של כל
  גרסה מוגדר ב־`PatchTables.kt:128-164`.
- **באפליקציה.** הסכמה הגבוהה שהאפליקציה קוראת היא `DatabaseConstants.readableDbSchemaVersion = 7`
  (`lib/data/constants/database_constants.dart:21`, עלה ל־7 ב־`02946f854`). מסד בסכמה גבוהה יותר נחסם כולו
  (`sqlite_data_provider.dart:147-153`). מלבד זה הקריאה מבוססת **יכולות**
  (`lib/migration/database/db_capabilities.dart`), לא מספר.

### 1.1 ציר הגרסאות

| סכמה | נכנסה ב־ | תאריך | מה השתנה | מיקום טקסט השורה |
|---|---|---|---|---|
| **0** (לפני `schema_meta`) | עד `eca22651^` | עד 2026-05-12 | מסד kdroid/מוקדם. מזהים `AUTOINCREMENT`, ולכן יש `sqlite_sequence`. אין `schema_meta`, `link_anchor`, `link_range` | `line.content` |
| **1** | `5f5b0044` (פורמט) + `06b190c2` (חתימה) | 2026-05-13 | `schema_meta`. מזהים יציבים בלי AUTOINCREMENT (`eca22651`). בתוך גרסה 1 נוספו בלי העלאה: `link.targetBookOrderIndex` (`52b93e2b`), `generation`/`book_generation` (`54d55d50`), `book.heDesc` (`1db022dd`), `link_anchor` (`b7e044ea`), `link_range`+`link_coverage` (`fad55ea3`), `book_version`+`version_line` (`6ff6c9c3`, 2026-07-12) | `line.content` |
| **2** | `151b9a9f` | 2026-07-15 | `book.dependenceType`, `collectiveTitleHe/En`, `book_base_text`. `link.isDeclaredBase` הוחלף ב־`link.baseProvenance` (`77559026`). `category.heDesc/heShortDesc` (`67f2cefe`) | `line.content` |
| **3** | `6e02d5c2` | 2026-08-30 | `link_suppressed_side`. `line_ref` נוסף ב־`c841b738` (2026-08-31) עוד בתוך 3 | `line.content` |
| **4** | `995884f4` | 2026-08-31 | `line_ref` בחוזה. `line_dh` (`e384f5ef`) **בלי** `dhDisplay` | `line.content` |
| **5** | `2f870f17` | 2026-09-04 | `line_dh.dhDisplay TEXT NOT NULL`. ב־2026-09-29 הוסרו האינדקסים `idx_link_type`, `idx_line_heref` ו־`idx_link_source_line` | `line.content` |
| **6** | `07d40cd8` | 2026-09-29 | **פיצול**: הטקסט עבר מ־`line` ל־`line_content(id, content)`. `version_line.content` הפך nullable, ו־NULL פירושו "זהה לשורת הבסיס". הדחיסה נכנסה כסכמה 7 (`1b991830`) ו**קופלה לתוך 6** באותו יום (`48c5c971`, 2026-10-01). כלומר מסד 6 **עשוי** להיות דחוס | `line_content.content` (TEXT או מסגרת zstd) |
| **7** | `0684c735` (+`d79955e8`) | 2026-10-18 | `banner`, `book_banner`, `book_protection`, `line_divine_name`, `line_note`, `line_note_divine_name`, `book.contentHash`. עידונים בלי העלאה: `line_note.hasMarker` (`2ee8572f`), `span` ארוז (`9db5643f`), `banner` (`94d3cfff`, 2026-10-21) | `line_content.content` ו־`line_note.body`, דחוסים |

**אימות.** ה־fixture `v7.sql`, שנבנה מ־`Database.sq` במזלג בתוספת שלבי הפיצול והדחיסה, זהה **לחלוטין** למסד
האמיתי: אותן טבלאות, אותן עמודות לפי סדר, טיפוס, NOT NULL, DEFAULT ו־PK, ואותם אינדקסים. ההבדל היחיד הוא
`sqlite_stat1/4`. ההשוואה נעשתה ב־`cmp.py`.

**מגבלות ה־fixtures.**
- כל קובץ הוא מצב ה־DDL ב**קומיט האחרון** של אותה גרסה. מסדים שנבנו מוקדם יותר באותה גרסה עשויים להיות
  חסרים עמודות או טבלאות שנוספו בלי העלאה; הפירוט מופיע בכותרת כל קובץ.
- ב־v4 נבחר `f211b80e^`, כלומר `line_dh` בלי `dhDisplay`.
- ב־v6 נבחר `55bf874b^`, בלי טבלאות הצד של סוף גרסה 6.
- הפיצול של v6/v7 לא קיים ב־`Database.sq` עצמו. הוא שוחזר מ־`SplitLineContentCli.kt:177-181`
  (`line_content`) ומ־`:261-270` (`version_line`).

### 1.2 מסדים לפני `schema_meta`

`schema_meta` נוסף ב־`eca22651` (2026-05-12). הכתיבה של `db_version`/`db_schema_version` החלה ב־`06b190c2`
למחרת. מסד ישן מזוהה כך:

1. אין טבלה `schema_meta`, או שהיא קיימת בלי המפתח `db_schema_version`. האפליקציה מחזירה null
   (`database.dart:141-150`).
2. קיימת `sqlite_sequence`, כי עד `eca22651` כל ה־PK היו `AUTOINCREMENT`.
3. בדרך כלל אין `link_anchor`/`link_range`, ואין `link.targetBookOrderIndex`.
4. יש `line.content`, ו־`tocEntry` בלי `lineIndex`. העמודה `tocEntry.lineIndex` הוסרה ב־`d71a8b3d`
   (2025-07-04), אבל `user_books.db` שומר אותה (§5).
5. מסדים קדומים מאוד (2025-07) הכילו `link.connectionType TEXT` במקום `connectionTypeId`, ו־FTS בשם
   `line_search` (טבלה וירטואלית). הכלי צריך **להתעלם** מטבלאות וירטואליות, כמו שהאפליקציה עושה
   (`db_capabilities.dart:224-226`).

## 2. מטריצת תכונות לפי סכמה

✔ = קיים, ◐ = תלוי בתאריך הבנייה בתוך הגרסה, ✖ = אין. השורות מתארות את מסלול ה־**official**.

| יכולת / טבלה | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|---|
| `schema_meta` | ✖ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `book`, `category`, `source`, `line` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `category_closure` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| טקסט ב־`line.content` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✖ | ✖ |
| `line_content` (+ `version_line.content` nullable) | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ | ✔ |
| `zstd_dict` + מסגרות zstd | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ◐ (מ־2026-10-01) | ✔ |
| `tocText`, `tocEntry`, `line_toc` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `alt_toc_structure`, `alt_toc_entry`, `line_alt_toc` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `book_version`, `version_line` | ✖ | ◐ (מ־07-12) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `book.dependenceType`, `collectiveTitle*`, `book_base_text` | ✖ | ✖ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `line_ref` | ✖ | ✖ | ✖ | ◐ | ✔ | ✔ | ✔ | ✔ |
| `line_dh` (`dhDisplay` מ־5) | ✖ | ✖ | ✖ | ✖ | ✔ (בלי) | ✔ | ✔ | ✔ |
| `line_note`, `line_divine_name`, `banner`… | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ◐ חלקי | ✔ |
| `book.contentHash` | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ |
| קישורים | ראו [LINK_SCHEMA_MATRIX](LINK_SCHEMA_MATRIX.md) | | | | | | | |

### 2.1 סיווג Sefaria/מקור

- **`book.sourceId` → `source.name`.** במסד האמיתי יש 15 מקורות: `Sefaria` (5,818 ספרים),
  `DictaToOtzaria` (1,167), `MoreBooks` (466), `National-LibraryToOtzaria` (271), `OnYourWayToOtzaria` (123)
  ועוד. הטבלה קיימת מ־`34a00d7b` (2025-11-08), כלומר גם בסכמה 0 המאוחרת.
- **תלות ומבנה** (מסכמה 2):
  - `book.dependenceType` מקבל את הערכים `commentary`, `targum`, `midrash`, `guides`, נשמרים כמו שהם.
  - `book.collectiveTitleHe`.
  - `book_base_text(bookId → baseBookId)`.
  - `book.isBaseBook` ודגלי `has*Connection` קיימים מסכמה 0.
- **נראות בסגנון Sefaria.** `link_suppressed_side` (מסכמה 3) ו־`link.baseProvenance` (מסכמה 2).
  פירוט ב־LINK_SCHEMA_MATRIX.

## 3. דחיסה (סכמה 7, ו־6 מאוחרת)

### 3.1 העובדות

| נושא | ערך | מקור |
|---|---|---|
| טבלה | `zstd_dict(id INTEGER PRIMARY KEY NOT NULL, dict BLOB NOT NULL)` | `CompressLineContentCli.kt:177-190` |
| מספר מילונים ברשמי | **אחד בדיוק**. ה־CI נכשל על 2 שורות או על מילון אחר | `test_ci_workflows.py:510-514` |
| `zstd_dict.id` ברשמי | **= dictID של המילון** = 32768 | `CompressLineContentCli.kt:178` (`Zstd.getDictIdFromDict`) |
| המילון | 2,097,152 בתים, magic `37 A4 30 EC`, dictID 32768 (LE בבתים 4-7), SHA-256 `7b08b7c3534c9f9cd0e8f18414b4326aeeb64cfd574cc0f12d83b6f92bd6a396` (`OFFICIAL_DICTIONARY_SHA256`) | `LineContentCompression.kt:28`; נמדד על המסד (2026-11-26, `node:sqlite` עם `readOnly`) |
| מקור המילון | משאב קבוע `generator/common/src/jvmMain/resources/zstd/line_content.zdict`. "קפוא": החלפתו מחייבת full-rebase ומספר סכמה חדש | `LineContentCompression.kt:11-18, 25-36` |
| רמה | 19 (zstd-jni) | `LineContentCompression.kt:21` |
| פרמטרי מסגרת | בלי checksum, content size קיים, dictID כתוב בכותרת, single-segment | `:68-74`; אומת בבתים |
| מה דחוס | כל `line_content.content`, כל `version_line.content` שאינו NULL, וכל `line_note.body` (סכמה 7) | `CompressLineContentCli.kt:26-36, 129-152` |
| סימון דחוס/רגיל | **אין עמודת דגל.** הסימן הוא `typeof(value)='blob'` **וגם** 4 הבתים הראשונים `28 B5 2F FD`. ערך TEXT הוא טקסט רגיל | `CompressLineContentCli.kt:300-308`; `line_content_codec.dart:70-75, 109-116` |
| הצהרת העמודה | `content TEXT NOT NULL`. ה־BLOB נשמר בעמודה מוצהרת TEXT (מותר ב־SQLite) | DDL |
| מגבלת גודל | 16MB מפוענח (`MAX_LINE_BYTES`/`maxLineBytes`). מסגרת בלי content size או מעל המגבלה נחשבת פגומה | `LineContentCompression.kt:24`; `line_content_codec.dart:29, 160-164` |
| קידוד | UTF-8 אחרי הפענוח | — |

**מבנה כותרת המסגרת** (מאומת):
- `28B52FFD 22 0080 15`: FHD=0x22, כלומר single-segment, Dict_ID של 2 בתים, FCS של בית אחד. אחריו
  dictID=0x8000 ו־FCS=21.
- `28B52FFD 62 0080 2B9A`: FCS של 2 בתים, והערך הוא 0x9A2B+256=39,723.

את ה־dictID ואת גודל התוכן אפשר לקרוא מהכותרת **בלי** לפענח.

### 3.2 מדידות במסד האמיתי

| מדד | ערך |
|---|---|
| קובץ | `page_size=16384`, `page_count=274,224` (≈4.49GB), `encoding=UTF-8`, `journal_mode=delete`, `auto_vacuum=0` |
| `line` / `line_content` | 7,643,689 שורות (`sqlite_stat1`). המזהים 1…10,588,493 **לא רציפים**, גם לא בתוך ספר. לדוגמה, בספר 1 הטווח הוא 1…6,174,410 עבור 1,584 שורות |
| `link` | 6,905,668 |
| `link_anchor` / `link_range` / `link_coverage` / `link_suppressed_side` | 2,749,397 / 1,739,663 / 993,490 / 298,895 |
| `line_note` | 277,146 (כולן מסגרות) |
| `version_line` | 1,129,618, מתוכן 704,405 NULL ("זהה לבסיס") |
| `tocEntry` / `tocText` / `alt_toc_entry` | 1,581,593 / 179,379 / 451,244 |
| `book` / `category` / `connection_type` | 8,154 / 1,426 / 24 |
| גודל מסגרת (3,000 שורות אקראיות) | ממוצע 170B, חציון 67B, p90 352B, p99 1,382B. המסגרת הגדולה במסד: 915,434B |
| יחס דחיסה (13 דוגמאות) | 8,170B → 42,089B (פי 5.2). שורות קצרות מאוד, כמו `<h2>דף י:</h2>`, דווקא **גדלות** בכמה בתים |
| `typeof` של 200,000 שורות `line_content` ראשונות | 100% `blob` |

הפענוח בפייתון אומת: `zstandard.ZstdDecompressor(dict_data=ZstdCompressionDict(dict))` על 11 שורות, הערה
אחת ושורת מהדורה. התוצאות נשמרו ב־`_linker-research/db/samples/`.

### 3.3 איך האפליקציה מפענחת (Dart/FFI)

הקוד ב־`lib/migration/database/line_content_codec.dart` (upstream/dev):

- **codec לכל חיבור** (`of`, שורות 39-45). אם יש `zstd_dict`, הקוד טוען **את כל** השורות. כל אחת עוברת
  `ZSTD_createDDict`, ונשמרת במפה **לפי `ZSTD_getDictID_fromDDict`**, לא לפי `zstd_dict.id` (שורות
  129-142). שני מילונים עם אותו dictID מסומנים כשגיאה.
- **פענוח ערך** (`text()`, שורות 70-75): null נשאר null, `String` מוחזר כמו שהוא, ו־`Uint8List` מפוענח
  כמסגרת.
- **שלבי הפענוח** (שורות 157-189):
  1. `ZSTD_getFrameContentSize`. ערך שלילי או גבוה מ־16MB גורם לשגיאה.
  2. `ZSTD_getDictID_fromFrame` → בחירת DDict. אם המילון חסר, הקוד טוען את המילונים מחדש פעם אחת
     (שורות 78-102).
  3. `ZSTD_decompress_usingDDict`, ובדיקה ש־`written == size`.
- **libzstd** נטענת דרך `zstandard_native` (`lib/utils/file/zstd_library.dart`).
- **כתיבה במסד האישי:** `LineContentEncoder`/`LineContentWriter` (`line_content_encoder.dart`), ברמה 3. פירוט
  ב־§5.

### 3.4 Personal-DB-Creator

- **המילון הרשמי מועתק — בגרסאות מסוימות של PDC; לא ב־v52.** PDC מאתר את `seforim.db` הרשמי בנתיבים קבועים
  (`lib/src/engine/seforim_db.dart:20-38`) ומשתמש במילון רק אם יש **שורה אחת** ב־`zstd_dict` (שורות 101-106).
  המילון נשמר **ב־id של השורה הרשמית** (`builder.dart:421`), ובמקרה זה הערך זהה ל־dictID.
  **נמדד על `otzarya-unofficial-books` v52** ([`PERSONAL_DB_V52_AUDIT.md`](../research/PERSONAL_DB_V52_AUDIT.md)): ב־`zstd_dict`
  מילון משלו של 112,640 בתים, **באותו dictID 32768** של המילון הרשמי (2,097,152 בתים). שני מילונים שונים באותו
  מזהה, ולכן כל מסד נקרא עם המילון **שלו** (נבדק בפועל על שני המסדים הפתוחים יחד: `dictionary-collision-real-db.local.test.ts`) (`LineContentCodec`: מילוני המסד גוברים על ה־`DictionaryPool`).
  **dictID אינו זהות (B19, issue #41):** 400 מסגרות אמיתיות של הרשמי שפוענחו במילון של v52 נתנו 2 זהות, 2 טקסט **שונה בלי
  שגיאה** ו־396 כשלים. לכן ה־`DictionaryPool` שומר כל מילון עם טביעת האצבע שלו (SHA-256) ועם המסד שהביא אותו, ומסד בלי
  מילון משלו **שואל** רק את המילון הרשמי (לפי `OFFICIAL_DICTIONARY_SHA256`) או קובץ מילון שהמשתמש פתח (שיוך מפורש), ורק
  כשיש בדיוק אחד כזה. המילון של מסד אחר עם אותו מזהה לעולם לא נשאל (השגיאה `db/compressed-unknown-dictionary` מציינת אותו).
  כשל פענוח במילון שאול הוא `db/dictionary-mismatch`, וגם טקסט שאינו UTF-8 תקין ממנו; כשל במילון של המסד עצמו הוא
  `db/compressed-corrupt` (וכך גם checksum שגוי, כשלמסגרת יש). מילון שאול משמש רק כל עוד המסד שהביא אותו פתוח.
- אין אימון מילון ואין משאב מילון מצורף לתוכנה.
- **רמה 19** (`zstd.dart:129`).
- **מתי דוחסים:** כשיש לפחות 3MB טקסט או `forceCompress` (`builder.dart:390-394`). אז **כל** שורות
  `line_content` הן מסגרות. אחרת כולן TEXT (`test/schema7_test.dart:91-99`).
- `version_line` ו־`line_note` נוצרות ריקות.

### 3.5 מפענח JS/WASM

הבדיקה המלאה, עם הוכחת Node, נמצאת ב־`_linker-research/db/zstd-js/` (`proof.mjs`, `proof-output.txt`,
`worker-inline-demo.cjs`, `worker-output.txt`).

| חבילה | גרסה | רישיון | סוג | gz מוטמע | מילון מאומן | הוכחה על הנתונים האמיתיים |
|---|---|---|---|---|---|---|
| **`zstd-wasm-decoder`** | 0.2.3 (2025-12-08) | Apache-2.0/MIT + BSD-3 | WASM, מפענח בלבד, 23KB (perf: 37KB) | ≈15-22KB | ✔ `new ZstdDecoder({dictionary}).init(module)` | **PASS 13/13**, כולל מסגרת סינתטית של 12MB. אתחול 4-7ms, 5-7µs למסגרת |
| `@bokuweb/zstd-wasm` | 0.0.27 | MIT | WASM של zstd מלא | ≈118KB | ✔ `decompressUsingDict` (מעתיק 2MB בכל קריאה) | PASS. 430µs דרך ה־API הרשמי, 27-36µs בקריאה ישירה ל־`_ZSTD_decompress_usingDict` עם מצביע קבוע |
| `zstd-codec` | 0.1.5 | MIT | emscripten CJS | ≈221KB | ✔ | PASS בקטנות, **OOM** במסגרת של 12MB, אתחול 49-303ms |
| `fzstd` | 0.1.1 | MIT | JS טהור | 3.9KB | ✖ קורא את ה־dictID ומתעלם ממנו | **FAIL**: פלט שגוי **בלי שגיאה** |
| `zstddec` (three.js) | 0.3.4 | MIT | WASM | 30KB | ✖ רק `ZSTD_decompress` | FAIL (פלט ריק) |
| `@oneidentity/zstd-js`, `numcodecs`, `@hpcc-js/wasm-zstd`, `@foxglove/wasm-zstd`, `@dweb-browser/zstd-wasm`, `zstd-wasm` | — | — | — | — | ✖ אין API למילון | לא הורץ |

**המלצה: `zstd-wasm-decoder`.** משתמשים **רק במחלקה `ZstdDecoder`**, מופע אחד לכל Worker.

**הטמעה:**
1. לוקחים את `_esm/zstd-wasm.min.js` ומחליפים את ה־`export` ב־`self.ZstdDecoder=o`.
2. מוסיפים את ה־wasm כ־base64.
3. מקמפלים סינכרונית: `new WebAssembly.Module(bytes)`.
4. בונים את המפענח: `new ZstdDecoder({dictionary}).init(m)`.
5. לכל שורה: `decompressSync(frame, contentSize)`.

ההדגמה ב־Worker הצליחה: 13/13, אתחול 5.4ms.

**מלכודות:**
- **תקרת מילון קשיחה של 2,097,152 בתים** (`r=2097152` במקור, אומת). המילון הנוכחי בדיוק בגודל הזה. אם
  אוצריא תחליף מילון לגדול יותר, החבילה תיכשל. לכן שומרים את `@bokuweb/zstd-wasm` בקריאה ישירה כ־fallback
  מאחורי אותו ממשק.
- **`setupZstdDecoder({dictionaries})` שבור:** הוא מזהה dictID 0 ו"מרעיל" את המאגר.
- **המאגר (`decompressSync(f,size,{dictionary})`) נכשל** על מסגרת של 12MB.
- **אין תקרת פלט אמיתית** (600MB). את מגבלת 16MB אוכפים בעצמנו מתוך FCS שבכותרת.
- **דרישות דפדפן:** wasm SIMD, bulk-memory ו־sign-ext, כלומר Chrome/Edge 91+, Firefox 89+, Safari 16.4+.
- **זיכרון:** כ־16MB wasm לכל מופע.

## 4. אלגוריתם זיהוי

שלבים 1–3 קוראים רק את עמוד 1 ואת `sqlite_master`, ואינם קוראים נתונים.

```
1. כותרת הקובץ (100 בתים):
   - magic "SQLite format 3\0", אחרת: לא SQLite.
   - page_size (offset 16, הערך 1 פירושו 65536).
   - בתים 18/19 == 2 → WAL. קובץ -wal שלא מוזג אינו נראה לקורא. מסרבים, או מציגים אזהרה ש"התוכן
     עשוי להיות לא עדכני" (האפליקציה דוחה מסד מצורף עם -wal או journal חם).
   - text encoding (offset 56): 1=UTF-8 בכל המסדים שנבדקו. 2/3 (UTF-16) → מפענחים TEXT בהתאם.
   - schema format (offset 44) ≤ 4.
2. sqlite_master: אוספים טבלאות, אינדקסים ו־SQL. מתעלמים מ־VIRTUAL ומ־sqlite_*. מפרקים עמודות מה־
   CREATE (אין PRAGMA ב־LazySqlite). חובה לטפל ב־"WITHOUT ROWID", ב־INTEGER PRIMARY KEY (alias ל־rowid),
   ב־DEFAULT ובהערות "--" בתוך ה־DDL (קיימות במסד האמיתי).
3. declared = schema_meta['db_schema_version'] (int) אם קיים, אחרת null.
4. inferred, לפי יכולות, מהגבוה לנמוך:
   line_note או book.contentHash            → 7
   line_content ואין line.content           → 6
   line_dh.dhDisplay                         → 5
   line_dh או line_ref                       → 4  (line_ref לבד ⇒ 3 מאוחרת או 4)
   link_suppressed_side                      → 3
   book_base_text או book.dependenceType     → 2
   schema_meta (גם בלי מפתח)                 → 1
   book+line, ואין schema_meta (sqlite_sequence מחזק) → 0
   אין book או line                          → "generic" (§6)
5. החלטה:
   - הקריאה תמיד לפי יכולות (כמו DbCapabilities באפליקציה), לא לפי המספר.
   - declared > 7 → "סכמה עתידית". ממשיכים לפי יכולות ומציגים אזהרה (האפליקציה חוסמת; אנחנו כלי
     קריאה בלבד, ולכן מספיקה אזהרה).
   - declared ≠ inferred → רושמים אזהרה. מסד אחרי delta מקבל ADD COLUMN, ומסד אישי מצהיר 7 עם טבלאות ריקות.
6. סוג המסד:
   - official: אין library_id ב־schema_meta, יש link ו־connection_type, ובדרך כלל source='Sefaria'.
   - PDC / מצורף: schema_meta.library_id (+library_name, author) ו/או טבלת external_link.
   - user_books: יש user_link / user_import_file / book.isPersonal, ואין schema_meta.
7. דחיסה: יש zstd_dict → טוענים את כל השורות, ומציעים אותם גם ל**מאגר המילונים של ה־Worker** (`DictionaryPool`):
   מסד בלי המילון שואל ממנו רק את המילון הרשמי (SHA-256, `OFFICIAL_DICTIONARY_SHA256`) או קובץ מילון שהמשתמש פתח
   (זיהוי לפי magic), לא מילון אחר שרק המזהה שלו זהה (§3.4). מילון המסד עצמו תמיד קודם; שני מילונים שונים שמותר
   לשאול עם אותו dictID פוסלים את ה־id (לא מנחשים). ממפים dictID→מילון לפי **כותרת המילון** (magic
   EC30A437 LE, ואז dictID ב־u32 LE בבתים 4-7), לא לפי zstd_dict.id. מפענחים **לכל ערך בנפרד**:
   - TEXT → כמו שהוא.
   - BLOB עם magic 28B52FFD → zstd.
   - BLOB אחר → שגיאה.
   - NULL ב־version_line → טקסט שורת הבסיס.
```

## 5. מסדים אישיים

### 5.1 `user_books.db`: ספרייה אישית של האפליקציה (קריאה/כתיבה)

- **צורה.** נפתח עם אותו `MyDatabase` (`user_books_database_holder.dart:12-13, 65-78`). ה־DDL שלו
  (`lib/migration/database/daos/database.dart:389-958`) הוא **הצורה הישנה, שלפני סכמה 6**:
  - `line.content` בתוך `line`.
  - **אין** `schema_meta`, `line_content`, `link_anchor`/`link_range`, ואין טבלאות סכמה 7.
  - יש `tocEntry.lineIndex`.
  - יש `db_meta(key, value)`.
- **טבלאות משתמש:**
  - `book` עם עמודות נוספות: `isContentExternal`, `externalLibraryId`, `isPersonal`, `filePath`, `fileType`,
    `fileSize`, `lastModified`, `pages`, `volume`.
  - `user_link` מבוסס כותרת ו־lineIndex, כולל `anchorStart/anchorEnd/anchorLabel` וקצות טווח. הכלי קורא אותו (Issue #41 B20) בשתי הצורות שלו, ובטבלה שאינו יכול לקרוא הוא מזהיר `db/user-link-not-read` ולא מציג 0 קישורים: [`LINK_SCHEMA_MATRIX.md`](LINK_SCHEMA_MATRIX.md) §6.1.
  - `user_alt_toc_*`, `user_book_version`, `user_import_file`, `user_sidecar_*`.
  - מטמוני PDF/DOCX.
- **מזהים.** `book.id` הוא AUTOINCREMENT **וחופף** למזהים הרשמיים. ההפרדה נעשית רק במפתח עם תחילית מקור:
  `uid:`, `id:` או `db:<slug>:` (`lib/data/book_identity.dart:41-74`).
- **`lineIndex` מתחיל מ־0.**
- **דחיסה מעורבת בתוך `line.content` עצמו.**
  - `LineContentWriter` מעתיק את **המילון הרשמי האחרון** (`ORDER BY id DESC LIMIT 1`,
    `line_content_encoder.dart:214`) ומכניס אותו עם id = dictID.
  - דוחס רק ספרים מעל `minBookChars`, ברירת מחדל ≈1.5M תווים (שורה 168), ברמה 3.
  - שורה שלא חוסכת נשארת TEXT.
  - מילונים ישנים לא נמחקים, ולכן ייתכנו **כמה מילונים**.
  - המסקנה: **TEXT ו־BLOB באותה עמודה, ולפעמים כמה מילונים.**

### 5.2 מסד מצורף ("מסדי ספרים אישיים", קריאה בלבד)

- **פורמט.** כל קובץ SQLite "בפורמט seforim.db", לפי `docs/personal_databases.md` ב־upstream/dev.
  **אף טבלה אינה חובה.** המינימום השימושי הוא `book`+`line`.
- **בדיקת הקבלה.** `AttachedLibraryProbe.probeSync` (`lib/attached_libraries/repository/attached_library_probe.dart:58-135`)
  דורש רק טבלת `book`. היא דוחה journal חם, ופותחת קובץ WAL כ־immutable.
- **מטא־נתונים** מגיעים מ־`schema_meta`:
  - `library_id`: slug של עד 64 תווים. אם חסר, נגזר משם הקובץ.
  - `library_name`, `db_version`, `description`, `author`.
  - `update_manifest_url`, `update_public_key`.
- **קישורים חוצי־מסד:** `external_link(sourceBookId, sourceLineIndex, targetSource, targetTitle, targetRef,
  targetLineIndex, connectionType)`. פירוט ב־LINK_SCHEMA_MATRIX §6.

### 5.3 Personal-DB-Creator

ה־DDL המלא ב־`lib/src/engine/builder.dart:181-294`.

- **`schema_meta`:** `library_id`, `db_version`, `db_schema_version='7'`, `display_name`, `library_name`,
  `description`, `author` (`builder.dart:405-418`). הכתיבה עם `journal_mode=OFF`, ובסוף VACUUM.
- **תת־קבוצה של סכמה 7:**
  - `book` רזה, עם `fileType` ו־`contentHash`.
  - `line` מפוצלת + `line_content`.
  - `line_ref`, `line_dh`, `book_version`/`version_line` וטבלאות סכמה 7 **נוצרות ריקות**.
  - `tocEntry` + `tocText` + `line_toc`, ו־`connection_type` (רק `'SOURCE'`).
- **בלי `link`.** כל הקישורים עוברים ל־`external_link` עם אינדקס `idx_external_link_source(sourceBookId,
  sourceLineIndex)`. **ממומש (#13):** `src/database/otzaria/external-links-reader.ts` ו־`DbBookSource`
  (`src/sources/db/db-source.ts`) קוראים אותה לקריאה בלבד: קישורים יוצאים מהאינדקס, קישורים אל ספר מאותו מסד
  מסריקה עצלה אחת של הטבלה (נמדד על v52: 724,985 שורות ב־3.6 שניות; 119,385 שורות יוצאות של ספר אחד ב־0.37 שנייה),
  והיעד נפתר דרך ה־`SourceRegistry`: `'official'` לפי כותרת מדויקת בספרייה הפתוחה ו־`targetRef` מול `heRef` של
  שורותיה (עדיף על `targetLineIndex`), `library_id` של המסד עצמו לפי כותרת באותו מסד, ובלי ספר פתוח — הכותרת
  בלבד (`unresolved:`), לא נזרק. `connectionType` NULL = REFERENCE; `SOURCE` נשמר כמו שהוא (בכיוון תלוי ← בסיס:
  העתקה לפרויקט נדחית, כי אף רשומה בקובץ לא תיישמר כך). אין בטבלה עוגנים, טווחים או צד מוסתר: לא מוצג דבר כזה.
  **מסד שיש בו גם `link` וגם `external_link`** מציג את שתיהן, כל קישור פעם אחת (שורת `external_link` שחוזרת על שורת `link` של אותה שורה, אותו ספר וקו יעד ואותו סוג נושרת, גם כשהשורה נושאת `targetRef` (השורה נפתרת לפני ההשוואה); הכפילות מזוהה רק בקישורים יוצאים, כי בנכנסים אין שורת הצד השני בלי קריאה נוספת); לכל קישור המזהה והמקור (`db`) שלו, ובשדה `dbTable` (`link` או `external_link`). הסיכום אומר מה המיזוג עשה (`DbLinkSummary.tables`: כמה קישורים נתנה כל טבלה, כמה כפילויות נושרו, וכמה שורות נכנסות של `external_link` לא הושוו עם `link`, ולכן קישור שיושב בשתיהן עלול להופיע בהן פעמיים). **נמדד (2026-11-22, קריאה בלבד):** אין מסד אמיתי כזה בשימוש: הרשמי המקומי (`seforim.db`) יש בו `link` ו־`link_anchor` בלי `external_link`, ו־v52 יש בו `external_link` בלי `link`; `user_books.db` של אוצריא יש בו `link` (0 שורות) ו־`user_link` בלי `external_link`. לכן המיזוג נבדק רק על fixture שנבנה מה־DDL האמיתי (`external-links-both-tables.test.ts`). **דגלים לכל קישור** (`dbFlags`, בסיכום `flags`; לא כלל ייצוא, קישור `db` לא מיוצא): יעד מחוץ לטווח (נבדק רק כשאורך הספר ידוע: ספר הספרייה פתוח, ובלי `targetRef` שקובע את השורה), יעד או מקור שהוא כותרת (שורה עם ערך ב־`tocEntry`, תחליף קרוב: v52 794,983 ערכים מול 795,007 שורות כותרת; רק כשמספור `line.id` הוא של PDC), כפילות הפוכה (פנימי; קישור משורה לעצמה אינו כזה), כותרת עמומה (אותה כותרת בספר של המסד ובספרייה הפתוחה), מקור מחוץ לספר (שורת מקור מעבר ל־`totalLines`). שורות עם מספר שורה שאינו מספר שלם חיובי, בלי יעד ובלי ref, או עם ספר מקור שאינו קיים אינן קישורים: הן נספרות ב־`DbLinkSummary.unlisted` (`badLine`, `noPlace`, `orphanSource`). בדיקת מספור `line.id` נעשית גם על ערכי `tocEntry` מפוזרים בכל הטבלה. **מגבלות ידועות:** שורה עם `targetSource` NULL ("כל מקור, הספרייה קודם") נפתרת כך גם כיוצאת וגם כנכנסת: היא מגיעה לספר
  של המסד רק כשהספרייה הפתוחה אינה מכילה את הכותרת; שורה בלי `targetLineIndex` ובלי `targetRef` שנפתר אינה קישור (לא נספרת, לא מוצגת);
  שני ספרים באותה כותרת במסד: הראשון (המזהה הנמוך) נבחר.
- **`line.id`** עולה על 2^32 (ב־v52 עד 10,332,667,988). רשימת הקישורים של מסד עם טבלת `link` מחזיקה מזהים כ־Float64
  (#13); הנתיב של `external_link` מעולם לא נזקק ל־`line.id` (כתובת שורה היא `(bookId, lineIndex)`).
- **מזהים.**
  - `line.id = bookId·2^20 + i + 1` ו־`tocEntry.id = bookId·2^20 + n` (`builder.dart:27-28`): דלילים
    וגדולים.
  - `lineIndex` = שורת הקובץ פחות 1, כלומר מתחיל מ־0.
  - שורות `<hN>` הופכות ל־TOC.
- **היסטוריה.** לפני `15cbc67`: מסד לא דחוס החזיק `line.content`, ומסד דחוס החזיק `line_content`+`zstd_dict`.
  לא היה `db_schema_version`.

## 6. מתאם כללי ("כל טבלת SQLite → ספרים/שורות")

מה המתאם צריך לטפל בו (מקובץ מ־`DbCapabilities` ומהמסדים שלמעלה):

1. **שלוש צורות טקסט:**
   - `line.content` (סכמות 0–5, `user_books`, PDC ישן).
   - `line_content` לפי אותו id, **רק** כשאין `line.content` (`db_capabilities.dart:115-116`).
   - כל אחת מהן עם ערכים מעורבים TEXT/BLOB.
2. **כתובת שורה = `(bookId, lineIndex)`.** אף פעם לא לפי `line.id`, כי המזהים לא רציפים, דלילים
   (2^20 ב־PDC) וחופפים בין מסדים. `lineIndex` מתחיל מ־0 בכל המקורות שנבדקו.
3. **`heRef`** יכול להיות NULL. התצוגה של האפליקציה במקרה כזה היא `<title> <lineIndex+1>`.
4. **עמודות אופציונליות.** אם אין `category` או `book.categoryId`, כל הספרים נכנסים לשורש אחד. `orderIndex`,
   `heDesc` ומחברים אופציונליים. בונים SELECT עם `NULL AS col` לעמודה חסרה (`DbCapabilities.column`).
5. **TOC.** אם אין `tocEntry.lineIndex`, עוברים דרך `lineId` → `line.lineIndex`. אם יש `lineIndex` (`user_books`,
   סכמה 0 מוקדמת), משתמשים בו ישירות.
6. **צמדים שאינם שמישים לבד:** `link_range`+`link_coverage`, `book_version`+`version_line`, `link`+
   `connection_type`+`line`.
7. **מיפוי חופשי** של טבלה זרה (למשל `texts(book TEXT, idx INT, body TEXT)`): המשתמש בוחר טבלה,
   עמודת ספר (מזהה או כותרת), עמודת סדר ועמודת טקסט. אופציונלית גם עמודת ref.
   - הסדר נקבע ב־ORDER BY על עמודת הסדר. אם אין אינדקס מתאים, נדרשת סריקה מלאה ומיון בזיכרון.
   - הטקסט יכול להיות HTML עם ישויות. ספירת התווים לעוגנים היא ספירת **תווים גלויים** (LINK_SCHEMA_MATRIX §3).
   - **מימוש:** אשף המיפוי (`src/core/db-mapping.ts`, `src/database/generic/`, `src/sources/db/mapped-source.ts`;
     תיאור ב־[`IMPORT_EXPORT.md`](../IMPORT_EXPORT.md) §2.1). בלי אינדקס מתאים: מעבר אחד שבונה לכל ספר מערך rowid
     לפי הסדר, במקום מיון של השורות עצמן בזיכרון.
8. **WAL, טבלאות וירטואליות ו־VIEW** (VIEW מופיע ב־`sqlite_master` בלי b-tree) לא נקראים כטבלאות. מסד
   שקובץ ה־header שלו מצהיר UTF-16 (offset 56 = 2/3) **כן** נקרא (`record.ts`), ונבדק על fixture.

### 6.1 אילו מבנים האשף מזהה ופותח (סבב V5, 2026-11-16)

**איך הניחוש עובד** (`src/core/db-guess.ts`): כל עמודת טקסט בכל טבלה היא מועמדת. ראיות מוסיפות או מורידות
נקודות, וכל ראיה נשמרת כסיבה שהאשף מציג: אורך הערכים, מילים לערך, אחוז האותיות העבריות, ערכים חוזרים, עמודת
סדר, קשר לטבלת שמות (FOREIGN KEY, שם העמודה, או ערכים שכולם מזהים בטבלה האחרת), וסימני אזהרה (טבלת יומן או
הגדרות, עמודת זמן, טבלת מפתח־ערך, טבלת קטלוג, טבלת קישורים, תיאור או מראה מקום במקום טקסט, מבט שקורא מהטבלה,
אחסון פנימי של אינדקס חיפוש, "ספרים" של שורה אחת). מועמדת מוצעת רק עם מיפוי, ציון של 5 לפחות, ובלי שגיאה ב־
`mappingProblems` (לא מציעים מה שלא ייפתח). כשאין כזאת, האשף אומר **"לא נמצאו ספרים במסד הזה"** ולמה,
ולא מציע טבלה. מיפוי ידני נשאר זמין, ו**"בדיקת המיפוי"** קוראת את 6 השורות הראשונות של 3 הספרים הראשונים
(עד 20,000 רשומות מכל טבלה, בלי טבלת קישורים) לפני הפתיחה.

**מקרא.** "אוטומטי" = האשף מציע את המיפוי הנכון בעצמו. "ידני" = אפשר למפות בשדות האשף. "fixture" = נבדק על
קובץ ב־`tests/fixtures/db/wizard/` (`scripts/fixtures/make_wizard_dbs.py`, סינתטי בכוונה, בדיקות ב־
`tests/integration/database/wizard-structures.test.ts`). **אף מבנה עם ספרים לא נבדק על מסד אמיתי במבנה זר**:
לא היה במחשב מסד כזה. "לפני" = מה האשף עשה ב־`rewrite/v2` (2870b63) על אותו fixture.

| מבנה | fixture | לפני | אחרי: אוטומטי | ידני | הערות |
|---|---|---|---|---|---|
| ספר שלם ברשומה (שורות מופרדות במעבר שורה) | `book-per-row.db` | הוצע, וכל ספר הוצג **כשורה אחת** | ✔ יחידת טקסט "כמה שורות בכל רשומה" | ✔ | גם פרק ברשומה (עם עמודת ספר וסדר) |
| שורה ברשומה, שם הספר בעמודה | `line-per-row.db` | ✔ | ✔ | ✔ | |
| טבלת ספרים + שורות, עם FOREIGN KEY ואינדקס | `books-lines-fk.db` | ✔ | ✔ (הסיבה מציינת את ה־FK; קריאה עצלה מהאינדקס) | ✔ | |
| טבלת ספרים + שורות, בלי FK, בלי שמות מרמזים, בלי אינדקס | `books-lines-nofk.db` | לא הוצע ניחוש | ✔ לפי הערכים (כל ערכי העמודה הם מזהים בטבלה האחרת) | ✔ | בלי אינדקס: מעבר אחד על הטבלה |
| JSON של פרקים (מערך של מערכים, או `{title, verses}`) | `json-chapters.db` | הוצע, וכל ספר הוצג כשורה אחת של JSON גולמי | ✔ יחידת טקסט "JSON"; כותרת של אובייקט = שורת כותרת | ✔ | JSON שאינו תקין מוצג כטקסט, עם אזהרה |
| ספרים ← פרקים ← שורות | `chapters-lines.db` | **שגוי בשקט**: שמות הפרקים הוצגו כשורות | ✔ טבלת ביניים "פרק" (`via.kind = part`), סדר (פרק, שורה) | ✔ | שם הפרק אינו מוצג כשורת כותרת. טבלת שורות WITHOUT ROWID עם טבלת ביניים: לא נתמך |
| כמה מהדורות לכל ספר | `versions.db` | **שגוי בשקט**: שמות המהדורות הוצגו כשורות | ✔ טבלת ביניים "מהדורה": כל מהדורה ספר, "שם — מהדורה" | ✔ | |
| טקסט ב־BLOB, UTF-8 | `blob-utf8.db` | ✔ | ✔ | ✔ | |
| טקסט ב־BLOB, UTF-16 (עם או בלי BOM) | `blob-utf16.db` | "בינארי", לא הוצע ניחוש | ✔ | ✔ | בלי BOM: רק כשכמעט כל יחידה היא ASCII/עברית/פיסוק |
| טקסט ב־BLOB, Windows-1255 | `legacy-encoding.db` (`line`) | "בינארי" | ✔ | ✔ | תלוי ב־`TextDecoder("windows-1255")` (קיים ב־Chrome/Edge/Firefox וב־Node) |
| Windows-1255 שנשמר כ־TEXT | `legacy-encoding.db` (`old_line`) | **הוצע**, והטקסט הוצג כסימני שאלה | ✖ נפסל, עם הסבר | ✖ (אזהרה) | הבתים מוחלפים ב־U+FFFD כבר בפענוח הרשומה; אי אפשר לשחזר |
| דחוס zlib / gzip | `zlib.db` | ✔ | ✔ | ✔ | |
| דחוס zstd בלי מילון | `zstd.db` | ✔ | ✔ | ✔ | |
| דחוס zstd עם מילון שאינו במסד | — (seforim.db אמיתי, `line_content`) | "בינארי" | ✖ נאמר במפורש: "טקסט דחוס ב־zstd שצריך מילון" | ✖ | מסד אוצריא נפתח בנתיב שלו, לא באשף |
| טקסט מחולק לקטעים באורך קבוע (חוצים שורות) | `chunked.db` | הוצע, וכל קטע הוצג כשורה (שורות חתוכות) | ✔ יחידת טקסט "קטעים": מחוברים, ואז מפוצלים | ✔ | זיהוי: מעברי שורה + רוב הקטעים באותו אורך |
| מפתח מורכב (ספר, פרק, פסוק), טבלת rowid | `composite-key-rowid.db` | **סדר שגוי בשקט** (לפי rowid) | ✔ סדר משני (`orderThen`) | ✔ (שדה "סדר משני") | |
| מפתח מורכב, WITHOUT ROWID | `composite-key.db` | ✔ (במקרה: לפי סדר המפתח) | ✔ מפורש | ✔ | |
| טבלת קישורים לפי מזהה שורה | `links-table.db` | ✔ | ✔ | ✔ (מצב מתקדם) | רק כשרשומה היא שורה אחת |
| טבלת קישורים לפי (ספר, מספר שורה) | `links-table.db` (`cross_refs`) | לא נקרא | ✖ | ✖ | |
| תוכן עניינים בטבלה נפרדת | `toc-table.db` | השורות ✔, הטבלה לא נקראה בשקט | השורות ✔; האשף אומר שטבלת התוכן אינה נקראת | ✖ | כותרות רק מ־`<hN>` או מעמודת רמה |
| מסד שקובץ ה־header שלו UTF-16 | `utf16-database.db` | ✔ | ✔ | ✔ | |
| בלי אינדקסים | `books-lines-nofk.db` ועוד | ✔ (סריקה) | ✔ (סריקה; האשף אומר מראש) | ✔ | |
| **בלי ספרים:** הגדרות + יומן | `settings-log.db` | **הוצע**: "ספרים" בשם INFO/ERROR, השורות חותמות זמן | ✔ "לא נמצאו ספרים", עם הסיבות | ✔ | |
| **בלי ספרים:** אינדקס FTS5 בלי תוכן | `fts-contentless.db` | "לא מצאתי ניחוש סביר" | ✔ "לא נמצאו ספרים" + "האינדקס אינו שומר את הטקסט" | ✖ | |
| אינדקס FTS5 עם תוכן (`<x>_content`) | `fts-stored.db` | הוצע בלי הסבר | ✔ מוצע, עם אזהרה ושמות העמודות c0, c1… | ✔ | הטבלה הווירטואלית עצמה לא נקראת |
| **בלי ספרים:** ספרים רק דרך VIEW (טבלת מפתח־ערך) | `views-only.db` | **הוצע**: "ספרים" בשם title/line | ✔ "לא נמצאו ספרים" + "מבטים אינם נקראים" | חלקי: רק אם המבט בוחר עמודות ושורות בלי לחשב | |
| **בלי ספרים:** קטלוג (פרטי ספרים בלי טקסט) | `catalog.db` | **הוצע**: שמות מחברים כשורות | ✔ "לא נמצאו ספרים" | ✔ | |
| **בלי ספרים:** טבלאות ריקות | `empty-tables.db` | "לא מצאתי ניחוש סביר" | ✔ "כל הטבלאות ריקות" | — | |

**מסדים אמיתיים** (נקראו לקריאה בלבד, `openSync(path, "r")`; ה־"לפני" הוא `guessMapping` של 2870b63 על אותה
תצוגה מקדימה). אף אחד מהם אינו מחזיק טקסט ספרים שהאשף יכול לקרוא, ובכולם התשובה הנכונה היא "אין ספרים":

| מסד (סוג) | גודל | לפני | אחרי |
|---|---|---|---|
| `seforim.db` (אוצריא, סכמה 7, נקרא כאילו זר; הטקסט ב־zstd עם מילון) | 4.6GB | הוצע: "מהדורות" מ־`book_version`, שורות מ־`line_dh` (לא נפתח: WITHOUT ROWID) | אין ספרים; "טקסט דחוס ב־zstd שצריך מילון" |
| `lexical.db` (מילון צורות) | 83MB | הוצע: יומן שינויים כספרים | אין ספרים |
| `otzar-HB_catalog.db` (קטלוג) | 38MB | הוצע: מחברים כשורות | אין ספרים |
| קטלוג ספרים של תוכנה אחרת | 7MB | הוצע: מחברים כשורות | אין ספרים |
| שני מילונים עבריים (ערך ← פירושים) | 3MB | הוצע: טבלת סוגי הקישור | אין ספרים (מועמד חלש: "מילון, לא ספרים") |
| `user_books.db` של אוצריא (טבלאות `book`/`line` ריקות) | 3.5MB | הוצע: טבלת הקישורים, עם דגל 0/1 כמזהה ספר | אין ספרים |

**שמירה בפרויקט.** השדות החדשים של `DbMapping` (`lines.unit`, `lines.orderThen`, `via`) אופציונליים, ולכן
`PROJECT_VERSION` לא עלה: מיפוי ישן נקרא בדיוק כמו קודם (`parseDbMapping`, בדיקה ב־
`tests/unit/projects/project-db-mappings.test.ts`). קורא ישן שפוגש מיפוי חדש מתעלם מהשדות החדשים: הוא יפתח
את המסד כ"כל רשומה היא שורה" (ספר שלם בשורה אחת), בלי לכתוב או לאבד דבר.

## 7. דרישות LazySqlite ותוכנית שאילתות

ה־EXPLAIN QUERY PLAN נלקח מהמסד האמיתי (`qp.py`). LazySqlite לא מריץ SQL, ולכן העמודה "גישה" מתארת את
הניווט הנדרש ב־b-tree.

| צורך | טבלאות (≤5) | טבלאות (6–7) | גישה | אינדקס |
|---|---|---|---|---|
| רשימת ספרים | `book`, `source`, `category`, `book_base_text` | אותו דבר | **סריקה** של טבלאות קטנות (8K/1.4K) | `idx_book_order` לא נחוץ: ממיינים בזיכרון |
| עץ קטגוריות | `category` (+`category_closure`) | אותו דבר | סריקה | — |
| שורות ספר בסדר, בדפים | `line` (כולל `content`) | `line` → `line_content` | **seek** ב־`idx_line_book_index(bookId, lineIndex)` מ־lineIndex≥k, ואז seek ב־rowid לכל שורה | `idx_line_book_index`, ואחריו INTEGER PK של `line`/`line_content` |
| נוסח מהדורה | `version_line` (מ־1 מאוחרת) | אותו דבר, NULL ⇒ בסיס | seek ב־PK `(versionId, lineId)` | `sqlite_autoindex_version_line_1` |
| הערות שוליים | — | `line_note` (7) | seek ב־PK `(lineId, …)`. הטבלה **WITHOUT ROWID**: ה־b-tree הוא אינדקס | PK |
| TOC | `tocEntry` + `tocText` (+`line_toc`) | אותו דבר | seek ב־`idx_toc_book(bookId)`, ואז rowid ב־`tocText` | `idx_toc_book`, `idx_toc_line` |
| alt_toc | `alt_toc_structure` → `alt_toc_entry` (+`line_alt_toc`) | אותו דבר | seek ב־`sqlite_autoindex_alt_toc_structure_1(bookId, key)`, ואז `idx_alt_toc_entry_structure` | שניהם |
| קישורים יוצאים מספר | `link` | אותו דבר | seek ב־`idx_link_source_book` | ‎+ rowid lookups |
| קישורים נכנסים | `link` | אותו דבר | seek ב־`idx_link_target_book` | |
| עוגנים, טווח, הסתרה | `link_anchor`, `link_range`, `link_suppressed_side` | אותו דבר | seek ב־autoindex לפי `linkId`, ואחריו rowid | `sqlite_autoindex_link_anchor_1` וכו' |
| כיסוי שורה בטווח | `link_coverage` | אותו דבר | seek ב־autoindex `(lineId, …)`, **covering** | |
| ref → שורה | `line_ref` (4+) | אותו דבר | seek ב־PK (WITHOUT ROWID) | |
| ייצוא כל הקישורים | `link` | אותו דבר | **סריקה מלאה** (6.9M שורות, כ־10% מהקובץ) | — |

**דרישות מימוש שנגזרות מכך:**

1. **b-tree:**
   - טבלה (0x0D/0x05) ואינדקס (0x0A/0x02).
   - seek בינארי לפי מפתח מורכב, עם השוואת רשומות לפי כללי SQLite: NULL < מספרים < TEXT < BLOB. TEXT
     בהשוואה BINARY.
   - איטרציה מ־cursor.
2. **טבלאות WITHOUT ROWID** (`line_note`, `line_ref`, `line_dh`, `line_divine_name`, `line_note_divine_name`):
   ה־b-tree שלהן הוא b-tree של אינדקס, והרשומה המלאה נמצאת במפתח.
3. **עמודים עודפים (overflow).** מסגרת של עד 915KB חוצה כ־56 עמודים. חישוב ה־local payload לפי נוסחת
   SQLite, שונה לטבלה ולאינדקס.
4. **רשומות קצרות מה־DDL.** `ALTER TABLE ADD COLUMN` (הוספת `book.contentHash` ב־delta מ־6 ל־7, ועמודות
   ב־patch fan ב־`849f7548`) משאיר רשומות ישנות עם פחות עמודות. חסרה ⇒ ערך ה־**DEFAULT** מה־DDL.
5. **INTEGER PRIMARY KEY.** העמודה נשמרת כ־NULL ברשומה, והערך האמיתי הוא ה־rowid.
6. **מטמון עמודים** (LRU). עמוד הוא 16KB, וקריאת `File.slice` לכל עמוד.
   - אינדקס `line` של ספר אחד הוא כמה עמודים בודדים.
   - קריאת ספר של 1,500 שורות: כ־1,500 seeks ב־`line_content`. כדאי למיין לפי rowid ולקרוא ברצף.
7. **אין צורך ב־`sqlite_stat*`.** אין גם תמיכה בכתיבה, journal או WAL.

## 8. עובדות שנמדדו באימות מול המסד (2026-11-11)

נמדד על `seforim.db` של המחשב (4,492,886,016 בתים, `db_schema_version=7`) בבדיקות של `tests/validation/`
(הדוח: [`validation/REAL_DATA_REPORT.md`](../validation/REAL_DATA_REPORT.md)):

- **`lineIndex` רציף.** בכל 8,154 הספרים השורות הן 0…n-1 בלי חורים, ו־`book.totalLines` שווה למספר שורות
  `line` של הספר.
- **`link.targetLineIndex` המשוכפל** שווה ל־`line.lineIndex` של `targetLineId` בכל 68,484 הקישורים שנבדקו.
- **`link_anchor` רק בארבעה סוגים:** LINKER (2,488,652 קישורים מעוגנים), COMMENTARY (177,681), QUOTATION
  (6,440, לרוב בצד 1 ועם `charEnd`) ו־OTHER (3). לעוגני COMMENTARY אין `charEnd`.
- **`tocEntry.level`:** בספרי ספריא הוא קטן באחד מרמת ה־`<hN>` של אותה שורה (`<h1>` ⇐ 0); בספרי אוצריא
  הוא שווה לה. בספרי ספריא יש גם רשומות `tocEntry` על שורות שאינן כותרת (`שמות רבה`: 517 רשומות מול 53
  שורות `<hN>`). ב־11 ספרי אוצריא במדגם `tocText` שונה מטקסט הכותרת: בלי ניקוד, ומקף (־) הופך לרווח. הכלי מציג את שורות ה־`<hN>`
  עצמן, כמו שהגנרטור מחליט מה כותרת.
- **`line_note`:** 630 ספרים. בספר שאוחד אליו "הערות על X", השורה במסד היא שורת ה־‎.txt עם
  `<sup class="footnote-marker">` במקום `<sup>`, וגוף ההערה עובר ל־`line_note`; אחרי השחזור
  (`rehydrateLine`) הגוף עומד מיד אחרי ה־`</sup>` של הסמן ב־16,793 מתוך 16,833 שורות כאלה שנבדקו.

## 9. זהות של קובץ, של ספר ושל מהדורה (V7 §1.1)

הכלי צריך לענות על שלוש שאלות: האם הקובץ הזה כבר פתוח, לאיזה ספר שייך קישור שנשמר, והאם הספר השתנה מאז.

### 9.1 קובץ שכבר פתוח

- **מסד:** לפי התוכן. הזהות היא גודל, 100 בתי הכותרת של SQLite, SHA-256 של שלוש דגימות של 64KiB (התחלה, אמצע, סוף),
  וזמן השינוי (`fileIdentity`, `src/sources/registry.ts`). עותק בשם אחר הוא אותו מסד.
- **ספר טקסט (קובץ, תיקייה, ZIP):** שם הקובץ, גודל, זמן השינוי, וטביעת FNV של 64KiB הראשונים ו־4KiB האחרונים
  (`textIdentity`). התיקייה אינה חלק מהזהות: קובץ שנבחר לבד, כשהוא כבר פתוח בתוך התיקייה שלו, הוא אותו ספר. ספר שכבר
  פתוח לא נפתח שוב, והמשתמש שומע שהוא פתוח. קבצים חדשים באותה בחירה נפתחים כמקור משלהם (V3 F-016).
- הזהות זולה בכוונה: בתיקיית ספרייה יש אלפי ספרים, והבתים הראשונים נקראים בכל מקרה כדי לזהות את הקידוד.

### 9.2 לאיזה ספר שייך קישור

קישור בפרויקט שומר את הספר לפי **כותרת, מקור (origin) ותווית המקור** (`StoredBook.source`: שם המסד או התיקייה).
אותו דבר קורה כשסוגרים מקור וכשה־Worker מוחלף: הקישור נשאר "לא פתור" עם הכותרת, ה־origin והתווית, ומחכה לספר הזה בדיוק.

כשספר בכותרת הזו נפתח (`resolveTitle`, `src/state/store.ts`):

1. ספר אחד מאותו origin ממקור עם אותה תווית: הקישור נקשר אליו. אם הוא השתנה, הבדיקה אומרת זאת (9.3).
2. אין ספר כזה (הקובץ שונה שם או הועתק), או שיש שניים עם אותה תווית: מחליטה **המהדורה**. הכלי קורא את המהדורה של
   הספרים הפתוחים בכותרת הזו, ונקשר רק לספר שהמהדורה שלו שווה למהדורה שנשמרה.
3. אין התאמה, או שאין מהדורה שמורה (פרויקט ישן): הקישור **לא** נקשר, גם אם רק ספר אחד בכותרת הזו פתוח. המשתמש
   מקבל הודעה עם הכפתור "קשרו לספר הפתוח". אם בחר בו, הבדיקה מסמנת אם מספר השורות או הטקסט השתנו.

קישור בלי תווית (ייבוא לפי כותרת, פרויקט מלפני V7) נקשר כמו קודם: לפי כותרת ו־origin.

כששני מקורות פתוחים באותו שם (למשל שני `user_books.db` משתי תיקיות) ובשניהם ספר באותה כותרת, הפרויקט שומר בקישור גם את
המהדורה (`StoredBook.edition`). רק כך אפשר להבדיל ביניהם.

### 9.3 המהדורה, והאם הספר השתנה

**המהדורה** (`editionFingerprint`, `src/core/text/fingerprint.ts`) היא מספר השורות של הספר וטביעת FNV של 32 שורות
מדגם: הראשונה, האחרונה, ושורות במרווחים שווים ביניהן (בספר קצר: כל השורות), כל אחת עם המספר שלה. היא נקראת בעצלות, רק
לספרים שקישורים משתמשים בהם (`readEdition`, `src/state/edition.ts`).

הפרויקט שומר לכל ספר (`ProjectFile.bookLines`) את הכותרת, ה־origin, התווית, מספר השורות והמהדורה. ספר שנפתח עם מספר שורות
אחר, או עם אותו מספר ומהדורה אחרת, "השתנה" (`export/book-changed`). זה נבדק לפי הספר עצמו, לא לפי הכותרת: ספר אחר באותה
כותרת אינו "השתנה".

**למה לא hash מלא.** נמדד על `seforim.db` (4,769,005,568 בתים, 8,259 ספרים, קריאה בלבד, 2026-11-27,
`tests/integration/database/edition-fingerprint-real-db.local.test.ts`):

| מה | זמן |
|---|---|
| מהדורה של 300 ספרים מפוזרים במסד, קריאה קרה | 6.7 שניות בסך הכול. חציון 16.5ms לספר, p95 65ms, מקסימום 127ms |
| מהדורה של 10 הספרים הגדולים (35,105–190,453 שורות) | חציון 136ms לספר, מקסימום 344ms |
| טביעה של כל השורות, לשלושת הספרים הגדולים | 2.5–5.7 שניות לספר |

גם הזהות של המסד כולו (9.1) אינה מספיקה: עדכון של הספרייה משנה את המסד, גם כשרוב הספרים לא השתנו. מהדורה לכל ספר עונה
בדיוק על השאלה "האם הספר הזה הוא אותו ספר", ועולה כמה שורות לספר.

**המגבלה:** שינוי בשורה שאינה במדגם, שלא משנה את מספר השורות, לא נראה. המהדורה מבדילה בין "אותו ספר" ל"מהדורה אחרת",
ואינה מוכיחה שאף תו לא השתנה.

</div>
