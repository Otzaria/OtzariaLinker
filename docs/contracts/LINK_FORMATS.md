<div dir="rtl">

# פורמטי הקישורים: קלט הספרייה, טבלאות ה־DB והמודל הפנימי של הכלי

מסמך חוזה, שלב 2. כל טענה כאן נבדקה מול **קוד המקור** ומול **נתונים אמיתיים**, ולא מול תיעוד בלבד. במקומות שבהם התיעוד סותר את הקוד, הקוד מנצח, והסתירה מצוינת.

## גרסאות שנקראו

| קיצור | מאגר | commit |
|---|---|---|
| **[F]** | `Otzaria/SeforimLibrary`, ענף `otzaria`. זה הגנרטור הסמכותי. **לא** `kdroidFilter/SeforimLibrary` | `23f1f8f16d2070d6b0459cc684722f4d029ad115` (2026-11-10) |
| **[A]** | `Otzaria/otzaria`, `upstream/dev` (האפליקציה) | `ea1f00d20edb723d69cd099c95e5db4304b9394b` (2026-11-11) |
| **[L]** | `Otzaria/otzaria-library`, `main` | `17eb3cc5a6fc1556bcfe5890c8596c40a55fdb10` (2026-11-11) |
| **[DB]** | `seforim.db` אמיתי, `db_version=37`, `db_schema_version=7` | — |

### קיצורי נתיבים

- **`G`** = `[F] generator/otzariasqlite/src/commonMain/kotlin/io/github/kdroidfilter/seforimlibrary/otzariasqlite/Generator.kt`
- **`MLR`** = `[F] generator/sefariasqlite/src/jvmMain/kotlin/io/github/kdroidfilter/seforimlibrary/sefariasqlite/manuallinks/ManualLinksRefresh.kt`
- **`MLJ`** = אותה תיקייה, `ManualLinksJson.kt`
- **`SCI`** = אותה תיקייה, `SefariaCorpusIndex.kt`
- **`DBSQ`** = `[F] dao/src/commonMain/sqldelight/io/github/kdroidfilter/seforimlibrary/db/Database.sq`
- **`DLP`** = `[A] lib/data/data_providers/database_library_provider.dart`

ה־fixtures נמצאים ב־[`tests/fixtures/contracts/`](../../tests/fixtures/contracts/README.md).

---

## 0. שינויים בתיעוד החי מאז הגרסה שהכלי מקשר אליה

הכלי מקשר ל־`docs/קישורים-וכותרות.md` בגרסת `b8301732` (2026-08-15). מאז נכנסו לקובץ חמישה commits: `4b84221f`, `c0daae51`, `afed7db9`, `1560e44c` ו־`765121d2`. התוספות הן +90 ו־−18 שורות:

1. **מלכודת הגרשיים הפוכה מהגרסה הישנה.** בגרסה הישנה נאמר ש־`רשי על יבמות.txt` "לא מזוהה כספריא", כאילו זה מצב תקין. בגרסה החדשה ה־path_2 של יעד ספריא **חייב** לשאת את כתיב ספריא המדויק, `רש"י על שבת.txt` עם גרשיים, ואז `ref_2` חובה. הכתיב המנוקה הוא באג נתונים: 739 רשומות של דיקטא נפלו בשקט ל־`irrelevant`. נוסף נוהל להוספת ספר ספריא עם גרשיים דרך `.github/data/sefaria_he_titles.txt`. נאמר במפורש שאין שום מפת כינויים (commit `c0daae51`: "כתוב את path_2 בכתיב הספר שב-DB, והסר את מנגנון הכינויים").
2. **שם השגיאה השתנה:** `… is unexcluded Sefaria↔Sefaria` הוא היום `… is Sefaria↔Sefaria`.
3. **נוסף פרק "איך מריצים מיגרציה (`migrate`)":**
   - כל שינוי ב־`manual_links_sync.json` מפיל את ה־`refresh` השבועי ב־`config_drift`.
   - adapters רצים רק ב־`bootstrap` וב־`migrate`.
4. **alt_toc:**
   - כמה אחים יכולים לחלוק שורה. "שורה כפולה תחת אותו הורה" כבר אינה שגיאה.
   - נוסף פרק "מבנים שנוצרים אוטומטית": `Seifim`, `SimanNames`/`Topic` ו־`Chapters`.
   - האזהרה: אסור ליצור `_alt_toc.json` שמשכפל מבנה אוטומטי. קובץ כזה גם **מונע** ירושת `Chapters`.
   - רק `Topic`, `Simanim` ו־`Seifim` מוזרקים לגוף הטקסט.

**פרקי הקישורים עצמם (3–5, 8) לא השתנו בטקסט מאז `b8301732`.** הם כבר שגויים מול הקוד בכמה נקודות. ראו §1.9 וגם `OTZARIA_COMPATIBILITY.md` §5.

---

## 1. פורמט (א): קלט הספרייה — `<כותרת>_links.json`

### 1.1 איתור הקבצים

- הגנרטור קורא את כל `*.json` בתיקייה **אחת**, `<sourceDirectory>/links`. קבצים שמסתיימים ב־`_headings` מסוננים (`G:58-75`, `G:2059-2061`).
  - בספרייה עצמה הקבצים יושבים ב־`<root>/links/`. רשימת השורשים שהסנכרון השבועי מנהל נמצאת ב־`[L] manual_links_sync.json`, `links_roots`.
- **כותרת ספר-המקור = שם הקובץ בלי `_links`**, כמות שהוא, בלי נרמול (`G:2066`, `G:2184`).
- **שני קבצים עם אותה כותרת:** האחרון שנמצא מנצח, והראשון נזרק כולו (`G:2062-2066`).
- **קובץ פגום:** אם רשומה אחת אינה עוברת deserialization (למשל `heRef_2` חסר, או מספר שאינו מספר), **הקובץ כולו נזרק** עם WARN אחד (`G:2807-2836`). זה מכוון: "A corrupt final JSON record must discard the whole input".

### 1.2 סכימת הרשומה כפי שהגנרטור מפענח אותה

המקור: `G:2844-2861`, `data class LinkData`. ה־Json מוגדר עם `ignoreUnknownKeys = true, coerceInputValues = true` (`G:128-131`).

| שדה | טיפוס ב־Kotlin | חובה? | משמעות ובסיס | מה קורה בערך לא תקין |
|---|---|---|---|---|
| `line_index_1` | `Double` | **חובה** | שורה בספר-המקור, **1-based**. `toInt()-1` (`G:2263`) | חסר או לא-מספרי: הקובץ כולו נזרק. ‎`39.0` תקין, ‎`39.7` נקטע ל־39. **‎`0` או שלילי עובר `coerceAtLeast(0)` וממופה לשורה הראשונה, בלי שגיאה** (`G:2263-2264`). מעבר לסוף הספר: `getLineIdCached` מחזיר null והרשומה מדולגת בשקט (`G:777-779`, `G:2266-2270`) |
| `line_index_2` | `Double` | **חובה** | שורה בספר-היעד, 1-based | כמו ב־`line_index_1` |
| `path_2` | `String` | **חובה** | נתיב ספר-היעד. הכותרת נגזרת ממנו (§1.3) | יעד שלא נמצא: הרשומה נספרת ונזרקת, עם WARN מסכם אחד (`G:2245-2259`, `G:2135-2173`) |
| `heRef_2` | `String` | **חובה** (אין ברירת מחדל) | תווית תצוגה. **בגנרטור משמשת רק לחילוץ `label` של עוגן** (`G:2420-2427`). ב־DB היא **לא נשמרת** | חסר: הקובץ כולו נזרק |
| `"Conection Type"` | `String`, ברירת מחדל `""` | אופציונלי | `ConnectionType.fromString` (§1.5). שימו לב ל־n האחת | חסר, `null` או `""`: `OTHER`. לא מוכר: `OTHER`. בשם `"Connection Type"` (שני n) המפתח מתעלם (`ignoreUnknownKeys`), ולכן `OTHER` |
| `start` | `Double?` | אופציונלי | אופסט **גולמי** בשורת המקור, בתוך התוכן ה**שמור** (§1.6) | שלילי, מעבר לאורך, או שורה ללא תוכן: העוגן נזרק עם WARN, הקישור נשאר (`G:2396-2404`) |
| `end` | `Double?` | אופציונלי | קצה **בלעדי** גולמי | אם הוא מחוץ ל־`start..length` הוא מתבטל בשקט, ונשאר עוגן-נקודה (`G:2405`) |
| `line_index_1_end` | `Double?` | אופציונלי | שורת **סיום** כוללנית, 1-based, בצד המקור של **הקובץ** | הפוך, חסר או שורת כותרת: WARN, הטווח נזרק והקישור נשאר. שווה להתחלה: אין טווח (`G:2367-2374`) |
| `line_index_2_end` | `Double?` | אופציונלי | כנ"ל, לצד היעד | כנ"ל |
| `ref_1`, `ref_2`, `anchor_src_hash`, `anchor_context` | — | לא נקראים ב־build | שדות **פייפליין** (§1.8). ה־build מתעלם מהם | — |
| כל מפתח אחר | — | — | מתעלמים ממנו | — |

**אין שדה "תחילת טווח"** ואין `heRef_2_end` בגנרטור. ‎`heRef_2_end` מוכר רק בייבוא האישי של האפליקציה (§2.5).

### 1.3 פתרון ספרים ל־`path_2`

ההמרה ל־title (`G:2236-2243`, ובאותה צורה `linkTargetTitleOf` ב־`G:866-870`):
- אם יש `\`: הרכיב האחרון אחרי `\`, ואז `substringBeforeLast('.', whole)`.
- אחרת: `Paths.get(path).fileName`, ואז `substringBeforeLast('.')`.
- **התיקייה אינה משנה דבר.** רק שם הקובץ נחשב, והוא נחתך **בנקודה האחרונה**. כותרת שיש בה נקודה ואין לה סיומת תיחתך. כתבו תמיד `.txt`.

החיפוש הוא `booksByTitle[targetTitle]`: **התאמה מדויקת** מול `book.title` (`G:754`, `G:2245`).

כותרת ספר אוצריא ב־DB היא שם הקובץ **אחרי נרמול**: `CategoryLabels.bookTitle(stem)`, בקובץ `[F] generator/common/src/jvmMain/.../common/ids/CategoryKeys.kt:23-35,70-74` (נקרא ב־`G:1300`). הנרמול:
- `"` → `״`
- `''` → `״`
- `׳׳` → `״`
- `` ` `` ו־`'` המעוקלים → `׳`
- רווחים מכווצים
- `תנך` → `תנ״ך`

**שם קובץ הקישורים ו־`path_2` אינם עוברים את הנרמול הזה.** לכן צריך לכתוב את הכותרת **כפי שהיא ב־DB**:

| צד | איך הכותרת כתובה ב־DB | ספירה ב־[DB] |
|---|---|---|
| ספר אוצריא | תמיד `״`, אף פעם לא `"` ASCII | 0 כותרות עם `"` |
| ספר ספריא | כתיב ספריא. לרוב `"` ASCII, לפעמים `״` | 1,216 עם `"`, 123 עם `״` |

דוגמה אמיתית: הקובץ `MoreBooks/links/וזה לשונו - שובבי׳׳ם_links.json` **נזרק כולו**, כי ב־DB הספר הוא `וזה לשונו - שובבי״ם` (`notes-companion.json`). בגלל אותה בעיה הספרייה עצמה מחזיקה `bootstrap_file_renames` ב־`[L] manual_links_sync.json`, למשל `מהרי''ק_links.json` → `מהרי״ק_links.json`.

**ספר שהוצל ע"י ספריא:** ספר אוצריא שכותרתו זהה ל־heRef של ספר ספריא אינו מיובא (`G:1316`, `G:1823-1847`; גם `G:949-951`). קישורים אליו נפתרים לספר הספריא.

### 1.4 שערי דילוג ברמת הרשומה (`G:2233-2338`, לפי הסדר)

1. היעד לא נמצא → `continue` (נספר). אם היעד הוא "הערות על …" ממוזג, הדילוג שקט (`G:2246-2258`).
2. **שני הצדדים ספריא** → `continue` (`G:2261`). "ספריא" כאן = `source.name` מכיל "sefaria" (`G:758-764`). ב־[DB] רק המקור `Sefaria` עונה לזה.
3. שורה לא קיימת (out of range) → `continue`.
4. **שורת כותרת בצד כלשהו** → `continue` (`G:2273`):
   - שורת כותרת = שורה ש־`startsWith("<h1".."<h6", ignoreCase)` (`G:1662-1673`). הבדיקה היא קידומת בלבד: רווח מוביל, או תג אחר לפני `<h2`, אינם כותרת.
   - כותרת שהטקסט שלה ריק לא נכנסת לטבלת `line` כלל (`G:1555-1558`). לכן גם קישור אליה נופל בשלב 3.
5. **`"Conection Type"` שמתפרש כ־`LINKER`** → `continue` (`G:2278-2281`). רשומות `"linker"` **לעולם אינן מיובאות**. שכבת `LINKER` ב־DB מגיעה רק מ־`LinkerToOtzaria` (§1.10).
6. יחסי חריגה (malformed) נבלעים, חוץ משגיאות SQL, `IllegalStateException` ו־batch (`G:2331-2338`).

### 1.5 סוג הקשר: מחרוזת → enum → מה שנשמר

הנרמול (`[F] core/.../models/Link.kt:121-156`): `trim().lowercase().replace(' ', '_')`. רק רווח ← קו תחתון, בלי `-`.

| מחרוזת אחרי נרמול | enum |
|---|---|
| `commentary` | COMMENTARY |
| `super_commentary`, `supercommentary` | SUPER_COMMENTARY |
| `targum` | TARGUM |
| `reference` | REFERENCE |
| `source` | SOURCE |
| `midrash` | MIDRASH |
| `quotation`, `quotation_auto`, `quotation_auto_tanakh` | QUOTATION |
| `mesorat_hashas` | MESORAT_HASHAS |
| `ein_mishpat`, `ein_mishpat_/_ner_mitsvah`, `ein_mishpat_/_ner_mitzvah` | EIN_MISHPAT |
| `dibur_hamatchil` | DIBUR_HAMATCHIL |
| `parshanut` | PARSHANUT |
| `mishnah_in_talmud` | MISHNAH_IN_TALMUD |
| `related`, `related_passage` | RELATED |
| `linker` | LINKER |
| `sifrei_mitzvot` (**רק עם z**) | SIFREI_MITZVOT |
| `essay` | ESSAY |
| `allusion` | ALLUSION |
| `liturgy` | LITURGY |
| `elucidation`, `ellucidation` | ELUCIDATION |
| `explication` | EXPLICATION |
| `law` | LAW |
| `summary` | SUMMARY |
| `footnotes`, `footnote` | FOOTNOTES |
| `""`, `none`, `other`, וכל ערך לא מוכר | OTHER |

ה־enum מכיל **24 ערכים**, ו־id = מיקום + 1. טבלת `connection_type` ב־[DB] זהה: 1=COMMENTARY … 15=LINKER … 24=FOOTNOTES, כולל 5=SOURCE שלעולם לא נשמר בקישור.

**הסוג הנשמר שונה מהמוצהר בשני מקרים** (`G:2275-2291`):
- **`source`**: הרשומה **מתהפכת** (המקור והיעד מתחלפים), ונשמרת כ־`COMMENTARY`. זה הסוג הנפוץ ביותר בספרייה: 260,620 מתוך 531,203 רשומות.
- **downgrade ל־`OTHER`**: מתקיים כש־
  - הסוג הוא אחד מ־`SOURCE_VIEW_TYPES`, כלומר `COMMENTARY`, `SUPER_COMMENTARY`, `TARGUM`, `MIDRASH`, `PARSHANUT`, `DIBUR_HAMATCHIL`, `EIN_MISHPAT`, `ELUCIDATION` או `FOOTNOTES` (`Link.kt:102-112`);
  - וגם היעד `isBaseBook` והמקור אינו;
  - וגם כותרת המקור **אינה** בצורת "X על <בסיס>" (`G:357-371`).
  
  במקרה כזה הקישור נשמר כ־`OTHER`, וממילא אינו מפרש. אם הכותרת **כן** מכריזה על התלות, הרשומה מתהפכת ונשמרת בסוג המקורי.
  - `isBaseBook` מוגדר רק לספרי רשימת העדיפות של ספריא, למשל בראשית וגיטין.
  - דוגמה אמיתית: `dependent-downgraded-to-other.json`.

### 1.6 עוגן-מילה: `start`/`end` → `link_anchor`

`buildLinkAnchor` (`G:2390-2413`):
- `charStart = countVisibleChars(content, start)`.
- `charEnd = countVisibleChars(content, end)`, אם `end` תקף.
- `side = 0`, תמיד.
- `label = anchorLabelFromHeRef(heRef_2)`: הטקסט אחרי `" אות "` **האחרון**. נדרשים 1–6 תווים, כולם אותיות `א-ת`, `"`, `׳` או `״`. אחרת `null`.

**`content` הוא תוכן השורה השמור בזמן ה־build:**
- לספר אוצריא זה ה־`.txt` עצמו, שורה כפי שפוצלה ע"י `exactLineSequence`: פיצול ב־CR, LF ו־CRLF, ו־newline בסוף הקובץ מוסיף שורה ריקה (`[F] .../BoundedGeneratorInput.kt:165-191`).
- ה־BOM מוסר מהשורה הראשונה.
- אם companion "הערות על X" מוזג לשורה, ההערות מוזרקות inline (§1.11).

**`countVisibleChars`** נמצאת ב־`[F] generator/common/src/commonMain/kotlin/io/github/kdroidfilter/seforimlibrary/common/HtmlCharCounter.kt:23-52`. הכללים:
- כל מה שבין `<` ל־`>` אינו נספר. **`<` בודד ללא `>` "בולע" את כל שאר השורה.**
- `&` נספר כתו אחד. אם יש `;` בתוך 9 התווים שאחריו, כל ה־entity נבלע. בלי `;` רק ה־`&` נספר.
- כל code unit אחר של UTF-16 נספר כ־1. **ניקוד וטעמים נספרים**, כל סימן בנפרד. תו מחוץ ל־BMP נספר כ־2.
- האופסטים הם אינדקסים של **UTF-16 code units**. רשומה עם `start` שלפניו surrogate נדחית ע"י הפייפליין (`MLR:752-756`).

נבדק על נתונים אמיתיים: בכל 9 הדוגמאות ב־`anchor-point.json`, הנוסחה על טקסט ה־DB נותנת בדיוק את `link_anchor.charStart`.

**מגבלות:**
- העוגן נכתב **רק כשהרשומה אינה מתהפכת** (`G:2318-2321`). רשומת `source` עם `start` מאבדת את העוגן.
- אין עוגן בצד היעד (side 1) מקובץ.
- כמה רשומות לאותו זוג שורות ולאותו סוג, עם `start` שונה, יוצרות **קישור אחד עם כמה עוגנים**: ה־PK הוא `(linkId, side, charStart)`, ו־`INSERT OR IGNORE`.

**הדוגמה המתועדת** היא `"אב <b>ג</b> דה"` עם `start=6,end=12`, שנותנים `charStart=3,charEnd=5` (`[F] .../jvmTest/.../OtzariaLinkAnchorsTest.kt:44-78`). הקצה הבלעדי 5 כולל גם את הרווח שאחרי `ג`. עבור `ג` לבדה נכון לכתוב `end=7`, או `end=11` אחרי `</b>`. לשניהם `charEnd=4`.

### 1.7 טווחים: `*_end` → `link_range` + `link_coverage`

`queueRangeSide` (`G:2355-2382`):
- הקישור עצמו מעוגן בשורת ההתחלה.
- `link_range(side, endLineId, endLineIndex)` מקבל את השורה האחרונה.
- `link_coverage(lineId, linkId, side)` מקבל שורה **לכל שורה שאחרי הראשונה**, חוץ משורות כותרת.

**ה־side נקבע לפי הכיוון ה*נשמר*:**
- בלי היפוך: `line_index_1_end` → side 0, ו־`line_index_2_end` → side 1.
- **בהיפוך מתחלפים** (`G:2322-2329`). אומת ב־`range-to-line.json`: רשומות `source` עם `line_index_1_end` נשמרו ב־side 1.

**"הקובץ אוטוריטטיבי":** לכל link id שנגעו בו בריצה, נמחקים פעם אחת לכל קובץ ה־`link_range` וה־`link_coverage` הקודמים (`G:2207-2217`). אחר כך `insertRange` הוא upsert שבו **הטווח הרחב ביותר מנצח** (`[F] .../LinkRangeQueries.sq:6-11`).

### 1.8 `ref_1`/`ref_2`: שדות הפייפליין השבועי, לא של ה־build

ה־build מתעלם מהם. מי שקורא אותם הוא `refreshManualLinks` (`sync-manual-links.yml`). הוא עובר על כל קובץ בשורשי `links_roots`, **לפני** בניית ה־DB, ו**כותב מחדש את `line_index_1/2`** לפי ה־ref.

**שער בתים** (`MLJ:215-228`; המראה ב־PR gate: `[L] .github/scripts/validate_manual_links_refs.py:167-186`):
- אסור BOM.
- **אסור CR.** שימו לב: `core.autocrlf=true` ב־Windows יוצר CRLF ב־checkout.
- לכל היותר LF אחד בסוף הקובץ.
- המבנה חייב להיות מערך של אובייקטים.
- `STRICT_DUPLICATE_DETECTION`: מפתח כפול באותו אובייקט הוא שגיאה.

**ולידציית רשומה** (`MLJ:268-298`):
- `line_index_1/2`: מספר JSON **שלם** ≥1. ‎`39.0` עובר, כי `stripTrailingZeros` מנרמל אותו.
- `heRef_2` ו־`path_2`: טקסט לא ריק.
- `start`: מספר שלם ≥0.
- `anchor_context`: אובייקט עם `before` ו־`after` בלבד.

**סיווג צד ספריא** (`MLR:482-547`, `SCI:56,188-199`):
- `sourceTitle` = שם הקובץ בלי `_links.json`.
- `targetTitle` = הרכיב האחרון של `path_2`, אחרי המרת `\`→`/`, **רק אם הוא מסתיים ב־`.txt`**. אחרת null, ולכן "לא ספריא".
- "ספריא" = ספירה 1 בדיוק של heTitle ראשי באינדקס ייצוא ספריא. **התאמת מחרוזת מדויקת**, בלי נרמול גרשיים.

| מצב | תוצאה |
|---|---|
| `ref_1` וגם `ref_2` | שגיאה |
| `ref_1` ומקור לא-ספריא, או יעד ספריא | `ref_1 side classification changed` |
| `ref_2` ויעד לא-ספריא, או מקור ספריא | `ref_2 side classification changed` |
| שני הצדדים ספריא | `… is Sefaria↔Sefaria` |
| מקור ספריא בלי `ref_1` | `new_source_ref_required`. יש חריג bootstrap ל־`tashmaToOtzaria`/`משנה ברורה` בלבד |
| יעד ספריא בלי `ref_2` | `new_target_ref_required`. יש חריג ל־adapters, רק ב־`bootstrap`/`migrate` |
| `end` (קצה עוגן) כשאחד הצדדים מנוהל ספריא | `unsupported_sefaria_range` (`MLR:503-505`) |
| `start` כשהיעד ספריא והמקור אינו | שגיאה: "start is allowed only on a Sefaria source with an anchor hash or a local↔local record" (`MLR:507-509`) |
| `ref_1` + `start` **בלי** `anchor_src_hash` | שגיאה ב־`refresh`: `pending_anchor_hash is forbidden in refresh` (`MLR:724-729`). מותר רק ב־bootstrap |

**צורת ה־ref:** ציטוט ספריא **קנוני באנגלית**, ובדיוק במחרוזת שהאינדקס פולט (`SCI:62`, `exactlyOne`).
- כולל רווחים כפולים. דוגמה אמיתית: `"Mishnah Berurah,  1:1"`.
- ה־PR gate בודק צורה מול `.github/data/sefaria_ref_prefixes.tsv` ואת `index_offsets_by_depth` (`validate_manual_links_refs.py:126-164`).

**`*_end` של צד ספריא לעולם אינו מתעדכן.** הפייפליין משכתב רק `line_index_1/2` (אין `_end` ב־`MLR`). לכן טווח בצד ספריא (`L->R+ref_2`, 11 רשומות חיות) עלול להיסחף.

שדות שהכלי בפייפליין רשאי **להוסיף** לרשומה: `ref_1`, `ref_2`, `anchor_src_hash`, `anchor_context` (`MLJ:213`). כל שדה אחר → `Refusing to insert`.

**רשומה ערוכה בכלי** (`src/core/links/pipeline-fields.ts`, סקירת התאימות B2): העוגן הוסר, שורת המקור זזה או הטקסט שלה השתנה ← `anchor_src_hash` ו־`anchor_context` מוסרים (אחרת `anchor_src_hash without start`, `MLR:713-716`); העוגן זז באותה שורה ← רק `anchor_context` מוסר. צד שעבר לשורה או לספר אחר בעריכה, וה־`ref` שלו לא השתנה ← ה־`ref` מוסר עם אזהרה, כי הסנכרון היה מחזיר את השורה ל־ref הישן בשקט (`MLR:589`, `711`); הבדיקה מבקשת ref חדש כשהצד ספריא. מעבר למהדורה חדשה (relink) שומר את ה־refs: הם מציינים את אותו מקום, והסנכרון מיישר את השורה לפיהם.

**`heRef_2` ריק** (או רווחים בלבד) הוא שגיאה בייצוא (`export/heref-missing`): `MLJ:271,302-304` דורש טקסט לא ריק, והרענון נכשל כולו. הכלי לא מייצר ערך כזה: כל מקור (בונה, מנועים, העתקה מהמסד) נופל ל"שם הספר ומספר השורה".

### 1.9 קבצי קלט אחרים שהגנרטור מכיר

| קלט | איפה | הערה |
|---|---|---|
| `alt_toc/<כותרת>_alt_toc.json` | `G:2435` (`processAltTocStructures`), מודל ב־`G:2863-2878` | **אינו קישור**. מערך מבנים `{key (חובה), title?, heTitle?, nodes:[{heTitle (חובה), line (1-based, חובה), children?}]}`. נכתב לטבלאות `alt_toc_*`. קובץ שמכוון לספר ספריא מדולג |
| `links/*.csv` של ספריא | `[F] .../sefariasqlite/SefariaLinksImporter.kt:378-400`, `280-286` | עמודות `Citation 1`, `Citation 2`, `Conection Type`, `Char Level Data 1/2` (אופציונלי), `Suppression Mask 1/2` (חובה ב־schema 3+). **זה ייצוא ספריא בלבד**, לפי refs, לספרי ספריא. הוא אינו מסלול קלט לספרי אוצריא |
| Phase-2 LINKER (`*.jsonl` של `LinkerToOtzaria` + sidecar TSV) | `[F] .../sefariasqlite/GenerateLinkerLinks.kt:25-50` | פנימי לפייפליין. **מחליף** את כל קישורי `LINKER` בכל ריצה |
| מפת Dicta `{שורה:[{start,end,refs}]}` | `G:2826-2833` | מזוהה ו**נזרק** (ההמרה לא מומשה) |
| `GenerateHavroutaLinks.kt` | `[F] generator/otzariasqlite/src/jvmMain/.../GenerateHavroutaLinks.kt` | יוצר רק שורות `link` |

**אין שום קלט CSV למסלול אוצריא.** ‎"ייצוא CSV" בכלי אינו נקרא ע"י הגנרטור לספרי אוצריא.

### 1.10 שכבת `LINKER`

`LINKER` היא שכבה חד-כיוונית של ציטוטים שזוהו אוטומטית: 2,488,652 קישורים ב־[DB].
- כל קישור נושא עוגן-טווח (`charEnd` לא null, `label` null) ב־side 0, ולעתים `link_range` ב־side 1 **בלי `link_coverage`**. לכן ב־[DB] יש 1.74M `link_range` ורק 0.99M `link_coverage`.
- היא נבנית מחדש מאפס בכל build. **כלי חיצוני אינו יכול להפיק אותה**: רשומות `"linker"` בקובץ מדולגות.

### 1.11 "הערות על X": מיזוג במקום קישור

`buildHearotMergePlans` (`G:875-1030`) ו־`[F] .../HearotCompanionMerge.kt:16-24` פועלים כך:
- הקלט: קובץ הקישורים של הבסיס, ובו רשומות שה־`path_2` שלהן הוא `הערות על …`. החריג: `הערות על חברותא…` מטופל בדקדוק משלו.
- לכל companion כזה נבנית **תוכנית מיזוג**. התוכנית מתקבלת רק אם כל התנאים מתקיימים:
  - כל שורת הערה שאינה ריקה ואינה כותרת מקושרת;
  - אין `*_end`;
  - אין `<i>` בהערה;
  - אין כבר footnotes בשורת הבסיס;
  - **אין רשומה עם `start` על שורת בסיס שמקבלת הערה.**
- **מיזוג שהתקבל:**
  - ה־companion אינו נכנס כספר.
  - הערותיו מוזרקות inline לשורות הבסיס, ואחר כך מוצאות ל־`line_note` (schema 7).
  - **כל הרשומות אליו מדולגות בשקט** (`G:2248-2249`).
  - אומת: 16 דוגמאות ב־`notes-companion.json`. לשורת הבסיס יש `line_note`, ואין ספר `הערות על …`.
- **עוגן מבטל:** `anchoredBaseLines` כולל כל רשומה עם `start` בקובץ הבסיס (לא רק אל ה־companion). לכן רשומה עם עוגן על שורת בסיס שמקבלת הערה **מבטלת** את המיזוג, וקישוריו נשמרים. מנוע ההערות של הכלי כותב עוגן בכל רשומה, ולכן הקישורים שלו לעולם אינם "נמחקים בשקט". הכלי אומר את התוצאה האמיתית (`export/companion-merged` לרשומה בלי עוגן, `export/companion-merge-cancelled` לרשומה עם עוגן), ומזהיר כשקובץ הבסיס שנטען ממזג היום את ההערות ורשומה חדשה עם עוגן על אחת משורות ההערה תבטל את המיזוג (`export/companion-merge-broken`).
- **מיזוג שנדחה:** ה־companion נשאר ספר רגיל וקישוריו נכנסים כרגיל. כך ב־[DB] יש 16 קישורי `FOOTNOTES` בלבד, ל־`הערות באותיות על …`, שאינו בתבנית.

---

## 2. פורמט (ב): טבלאות הקישורים ב־DB, כפי שהאפליקציה קוראת אותן

### 2.1 הסכימה (`DBSQ`, ו־[DB] זהה)

```
link(id, sourceBookId, targetBookId, sourceLineId, targetLineId, targetLineIndex /*0-based*/,
     targetBookOrderIndex, connectionTypeId, baseProvenance /*0 none,1 inferred title,2 Sefaria declared*/)
link_anchor(linkId, side /*0 src,1 tgt*/, charStart /*visible*/, charEnd /*visible, exclusive, NULL=point*/, label, PK(linkId,side,charStart))
link_range(linkId, side, endLineId, endLineIndex /*0-based, inclusive*/, PK(linkId,side))
link_coverage(lineId, linkId, side, PK(...))         -- כל שורה מכוסה אחרי הראשונה, בלי כותרות
link_suppressed_side(linkId, side, reasonMask 1..15) -- צד שספריא מסתירה; דליל
connection_type(id, name)                            -- 24 שורות, id = ordinal+1
line(id, bookId, lineIndex /*0-based*/, heRef, tocEntryId, charCount)
line_content(id, content)  -- zstd עם מילון zstd_dict
line_note(lineId, noteIndex, charPos /*visible*/, hasMarker, body)                -- schema 7
```

ההגדרות: `DBSQ:376` (link), `411-434` (link_anchor), `436-449` (link_range), `451-462` (link_coverage), `466-476` (link_suppressed_side), `656-671` (line_note).

**קואורדינטות `link_anchor` מ־schema 7 מתייחסות ל"שורה המלאה":** השורה השמורה, כשגוף כל `line_note` מוחזר ל־`charPos` שלו (`DBSQ:411-417`). השחזור: `[F] generator/common/src/commonMain/.../common/notes/LineNoteRehydration.kt:22-43`, שמכניס `<i class="footnote">BODY</i>`.

ספירות ב־[DB]:

| טבלה | שורות |
|---|---|
| `link` | 6,905,668: ‏LINKER 2.49M, ‏COMMENTARY 2.34M, ‏OTHER 1.57M, ‏EIN_MISHPAT 138K, ‏REFERENCE 115K… ‏FOOTNOTES 16, ‏LAW 1. **אפס** ESSAY, SUMMARY, ELUCIDATION, DIBUR_HAMATCHIL, PARSHANUT |
| `link_anchor` | 2,749,397 |
| `link_range` | 1,739,663 |
| `link_coverage` | 993,490 |
| `link_suppressed_side` | 298,895 |
| `line_note` | 277,146 |

### 2.2 קריאה קדמית (הספר הפתוח = צד המקור השמור)

הקוד: `DLP:863-937` (ספר שלם), `DLP:1016+` (חלון), `DLP:597-605` (חלון רשמי).

```
anchors(linkId, anchorLineId) = link.sourceLineId של הספר
                              ∪ link_coverage(side=0).lineId          -- קישור-טווח מופיע בכל שורה מכוסה
JOIN line sl(anchorLineId), line tl(targetLineId), book tb, connection_type ct
LEFT JOIN link_range lr ON side=1 ; LEFT JOIN line rl(lr.endLineId)  -- קצה הטווח של צד היעד
LEFT JOIN link_anchor side=0 (רק כש-anchorLineId = l.sourceLineId; מקובץ ל-spans)
LEFT JOIN link_anchor side=1 (linkedAnchor)
WHERE NOT EXISTS link_suppressed_side(side=0)
```

`_linkFromRow` (`DLP:830-860`) מחזיר `Link`, וממיר את האינדקסים ל־**1-based**:

| שדה ב־`Link` | מקור |
|---|---|
| `index1` | `sl.lineIndex+1` |
| `index2` | `tl.lineIndex+1` |
| `heRef` | `line.heRef` של **שורת היעד** ב־DB, ואם אין, כותרת הספר. **לא `heRef_2` מהקובץ** |
| `path2` | כותרת ספר היעד |
| `index2End` | `link_range.endLineIndex+1` |
| `heRefEnd` | heRef של שורת הסיום |
| `anchorStart/End/Label/anchorSpans` | מ־`link_anchor` |

### 2.3 קריאה הפוכה (הספר הפתוח = צד היעד השמור): אין שורות מראה ב־DB

**הגנרטור אינו כותב קישורים הפוכים.** האפליקציה מסנתזת אותם (`DLP:610-729`):
- הסוגים: `inverseQueryTypes`. אלה תלויי-הטקסט, ובנוסף **כל סוגי ההפניה** כשקיימת `link_suppressed_side`. כך הוא ב־[DB] (`[A] lib/models/link_types.dart:89-110`).
- `LINKER` **אינו** מוחזר. הוא חד-כיווני.
- תלויי-טקסט מוצגים כ־`SOURCE` (`[A] lib/data/data_providers/link_visibility_sql.dart:27-30`). שאר הסוגים נשארים בשמם.
- `link_coverage(side=1)` נכלל, כדי שקישור שמכסה כמה שורות ביעד יופיע בכל אחת.
- העוגן מ־side 1. קצה הטווח מ־side 0.
- `link_suppressed_side(side=1)` מסנן.

### 2.4 בחירת ספר

הבחירה היא `SELECT id FROM book WHERE title = ? [AND categoryId = ?]`, התאמה מדויקת (`DLP:731-747`).

### 2.5 קישורים אישיים: לא ב־`seforim.db`

האפליקציה מקבלת קבצי קישורים מהמשתמש אל `user_books.db`, טבלת `user_link`. הפירוט ב־`OTZARIA_COMPATIBILITY.md` §4. ההבדלים העיקריים מה־build:

| נושא | ייבוא אישי | build רשמי |
|---|---|---|
| שמירה | לפי **כותרת + אינדקס 0-based**, לא lineId | lineId |
| עוגנים | `anchorOffsetsAreRaw=true`: האופסטים נשמרים **גולמיים** ומומרים בזמן תצוגה | נקודות גלויות |
| `heRef_2` | **נשמר** (`targetRef`), וגם `heRef_2_end` | לא נשמר |
| שגיאה בודדת | **כל הקובץ נדחה** | הרשומה מדולגת בשקט |
| סוג ריק | `REFERENCE` | `OTHER` |
| `"linker"` | נשמר כ־`COMMENTARY` | מדולג |
| `"source"` | נשמר כ־`SOURCE`, בלי היפוך | מתהפך ל־`COMMENTARY` |

---

## 3. פורמט (ג): המלצה למודל הפנימי של הכלי

מטרות המודל:
1. לייצא רשומת `_links.json` שה־build וה־pipeline יקבלו.
2. לייבא גם קבצים קיימים וגם קישורים מה־DB בלי להמציא מידע.
3. לסמן במפורש מה ידוע ומה נגזר.

```ts
type Side = 'source' | 'target';              // כיוון הקובץ, לא הכיוון השמור ב-DB
interface BookRef {
  dbTitle: string;          // הכותרת המדויקת ב-DB (אחרי CategoryLabels.normalize לספרי אוצריא; כתיב ספריא לספרי ספריא)
  fileStem?: string;        // שם הקובץ בספרייה, אם שונה (מלכודת ׳׳/״) — לתצוגה ולאזהרה בלבד
  origin: 'sefaria' | 'otzaria' | 'personal' | 'unknown';   // לפי source.name / רשימת sefaria_he_titles
  isBaseBook?: boolean;     // משפיע על downgrade ל-OTHER
}
interface LinkModel {
  id: string; status: 'NEW' | 'EDITED' | 'EXISTING' | 'DELETED';
  source: { book: BookRef; line0: number; end0?: number };   // 0-based, end כולל; end0 === line0 ⇒ לא טווח
  target: { book: BookRef; line0: number; end0?: number };
  declaredType: string;     // הערך הגולמי שייכתב ל-"Conection Type" (lower-case, כמו בספרייה)
  storedType: ConnectionType; flipped: boolean;              // נגזר בכל רגע מ-declaredType+BookRef (חוקי §1.5), לא נערך ידנית
  heRef2: string;           // חובה בקובץ; ב-DB אינו קיים — ביבוא מ-DB: heRef של שורת היעד
  ref1?: string; ref2?: string;                              // לעולם לא שניהם
  anchor?: { rawStart: number; rawEnd?: number; label?: string;   // מקור האמת לייצוא: אופסטים גולמיים בשורת המקור
             visibleStart: number; visibleEnd?: number;           // נגזר (countVisibleChars), לתצוגה ולהשוואה ל-DB
             contentHash: string };                               // hash של שורת המקור שעליה חושב — לזיהוי סחיפה
  passthrough?: Record<string, unknown>;   // anchor_src_hash, anchor_context ושדות לא מוכרים — נשמרים כמות שהם
  provenance: 'file' | 'db' | 'user';      // מאיפה יובא
}
```

### כללי חובה למודל

- **הכותרות נשמרות בכתיב ה־DB.** את `path_2` כותבים כ־`<dbTitle>.txt`. נתיב תיקייה מיותר: הגנרטור מתעלם ממנו.
- **`storedType`/`flipped` מחושבים**, ולא מוצגים כשדה עריכה. ה־UI צריך להציג למשתמש את הסוג **האפקטיבי** ואת הפאנל שבו הקישור יופיע.
- **עוגן נשמר גולמי.** ‏`visible*` נגזר ממנו. כשהמשתמש מסמן על טקסט מוצג, ההמרה (`rawOffsetFromVisible`) נעשית מול **אותה מחרוזת שהגנרטור יראה**:
  - לספר אוצריא: שורת ה־`.txt`, אחרי הסרת BOM ופיצול `exactLineSequence`.
  - לשורה מה־DB עם `line_note`: אחרי `LineNoteRehydration`.
- **`passthrough`** מבטיח round-trip בלי אובדן לשדות פייפליין.

---

## 4. כללי המרה ומה הולך לאיבוד

### 4.1 קובץ → מודל

| קלט | מודל |
|---|---|
| `line_index_X` | `line0 = round(line_index_X) - 1`. ערך לא שלם או <1: אזהרה. הגנרטור קוטע ומצמיד ל־0, הפייפליין דוחה |
| `line_index_X_end` | `end0 = value - 1`. אם `end0 <= line0`, ה־build מתעלם (אזהרה) |
| `"Conection Type"` | `declaredType`, כולל ריק. `storedType`/`flipped` לפי §1.5 |
| `start`/`end` | `rawStart/rawEnd`. ה־`visible*` מחושבים מול התוכן |
| `ref_1`/`ref_2` | ‏`ref1`/`ref2` |
| `anchor_src_hash`, `anchor_context`, שאר המפתחות | `passthrough` |
| שם הקובץ ו־`path_2` | `BookRef.dbTitle` אחרי חיפוש **מדויק**. אם הוא נכשל, לנסות `CategoryLabels.normalize` ולסמן "יידחה ב־build" |

### 4.2 מודל → קובץ

- הכתיבה היא **בכיוון הקובץ**.
- את `source` כותבים כ־`"source"` רק כשזו הכוונה, כלומר כשהקובץ הוא של הספר התלוי.
- סדר השדות קבוע. אין BOM, השורות ב־LF, ולכל היותר LF אחד בסוף.
- **לא לכתוב** בכל אחד מהמקרים הבאים:
  - `"linker"`;
  - `end` ברשומה שנוגעת בספריא;
  - `start` ברשומת `local→Sefaria`;
  - `start` חדש עם `ref_1` בלי `anchor_src_hash`;
  - `start` ברשומת `source`;
  - שורת כותרת בקצה;
  - `ref_1` וגם `ref_2` באותה רשומה.

### 4.3 DB → מודל (ייבוא קישור קיים)

| שדה DB | מודל |
|---|---|
| `link.sourceLineId`/`targetLineId` → `line.lineIndex` | `line0`, אחרי **היפוך חזרה** לפי הכיוון הרצוי (ראו האובדן להלן) |
| `link_range(side)` → `endLineIndex` | `end0` לצד המתאים, לפי הכיוון השמור |
| `link_anchor(side=0)` | `visibleStart/End/label`. את `rawStart` צריך **לשחזר**: `rawOffsetFromVisible(rehydratedLine, charStart)` |
| `connection_type.name` | `storedType`. את `declaredType` צריך **לנחש** |
| `line.heRef` של שורת היעד | `heRef2`, ערך מקורב |

### 4.4 מה אבד בכל כיוון

**קובץ → DB.** כל אלה אינם ב־DB:

| מה | גורל |
|---|---|
| `heRef_2` | נשמרת רק האות, וגם זה רק אם הופיע `" אות X"` |
| `"Conection Type"` המקורי | `source` הופך ל־`COMMENTARY`; `quotation_auto` ל־`QUOTATION`; ריק ולא מוכר ל־`OTHER`; לפעמים downgrade ל־`OTHER` |
| כיוון הקובץ | מתהפך ב־`source` ובהיפוך תלות |
| `start` ברשומות מתהפכות | נזרק |
| `end` לא תקף | נזרק |
| `ref_*`, `anchor_*` | לא נשמרים |
| רשומות כפולות | מתלכדות (אותו id) |
| רשומות אל companion ממוזג | נעלמות |
| `line_index` לא שלם או ≤0 | "מתוקן" בשקט |

**DB → קובץ: לא ניתן לשחזר רשומה זהה.**

| מה | למה לא ניתן |
|---|---|
| `heRef_2` | לא קיים ב־DB. אפשר לשים את `line.heRef` של היעד, אבל הוא שונה. לדוגמה: בקובץ `"גיטין נב:, א"`, וה־heRef ב־DB הוא heRef של ספריא |
| `declaredType` | עמום. `COMMENTARY` מתהפך יכול לבוא מ־`"source"` בקובץ של התלוי, או מ־`"commentary"` מהבסיס. `OTHER` יכול לבוא מ־`""`, `"other"`, `"none"`, ערך לא מוכר, או downgrade |
| הקובץ שהרשומה ישבה בו | עמום. כל אחד משני הספרים יכול להיות "המקור" של קובץ |
| `rawStart` | ניתן לשחזור רק עד כדי שקילות: כל אופסט בתוך רצף תגים נותן אותו `charStart`. ה־`rawOffsetFromVisible` של הכלי, שמדלג על תגים פותחים, מחזיר את הגרסה הקנונית |
| `ref_*`, `anchor_context`, `anchor_src_hash` | לא קיימים |
| `link_coverage` | נגזר. לא צריך לשחזר |

**קישורים שאין להם בכלל ייצוג בקובץ:**
- `LINKER`;
- עוגן ב־side 1;
- `link_suppressed_side`;
- טווחי ספריא בצד ספריא, כי ה־pipeline דוחה `end` ואינו מרענן `_end`;
- קישור ספריא↔ספריא.

**מסקנה:** ייבוא מה־DB הוא **קריאה בלבד ("קיים")**, ואסור לייצא אותו חזרה לקובץ כאילו נכתב בו. עריכה של קישור DB אפשרית רק כשמקורו ידוע: קובץ ספרייה שנטען, `provenance:'file'`. במקרה כזה עורכים את רשומת הקובץ. מה שהכלי כן עושה הוא **שחזור** מפורש של רשומה, כקישור חדש בפרויקט (`provenance:'db-copy'`), עם כל מה שאבד או נוחש מדווח: §4.5.

### 4.5 קישורי DB כנתון: מקור, כלל השוויון, ושחזור לרשומה

#### מאיפה בא קישור ב־DB

ה־DB **אינו שומר** מאיפה בא קישור. `baseProvenance` מתעד את מקור **הכיוון** (בסיס→תלוי: 2 מוצהר בספריא, 1 מפענוח "X על Y", 0 אחר), לא את מקור הקישור (`SefariaLinksImporter.kt:1120-1133`). לכן הכלי מסיק את המקור מהסוג השמור ומשני הספרים (`src/core/links/db-links.ts`, `dbLinkOrigin`):

| מקור משוער | איך מזהים | מי כותב | ב־[DB] | ניתן לכתוב כרשומת `_links.json`? |
|---|---|---|---|---|
| **LINKER** | סוג 15 | `LinkerToOtzaria` + `GenerateLinkerLinks.kt`, מחליף את כל השכבה בכל בנייה | 2,488,652 | **לא.** רשומת `"linker"` מדולגת (§1.4 שער 5) |
| **ספריא** | שני הספרים `source.name` ספריא | ייצוא ה־CSV של ספריא (`SefariaLinksImporter.kt:540-600`), ועוגני מפרשים שהגנרטור מסיק (`insertCommentaryAnchors`, `:734`; `SefariaSparseCommentaryLinks.kt:147`) | 3,901,778 | **לא.** ספריא↔ספריא מדולג (§1.4 שער 2) |
| **ספריית אוצריא** | כל השאר: לפחות ספר אחד שאינו מספריא, לא LINKER | `_links.json` של הספרייה (`G:2233-2338`), **או** סקריפט של הגנרטור. דוגמה: `GenerateHavroutaLinks.kt` יוצר COMMENTARY/FOOTNOTES בין חברותא לגמרא. במסד יש 5,414 קישורי `חברותא על ברכות`↔`ברכות`, ובספרייה **אין** קובץ `חברותא על ברכות_links.json` | 515,238: ‏COMMENTARY 506,261, ‏TARGUM 6,012, ‏QUOTATION 1,775, ‏OTHER 838, ‏REFERENCE 323, ‏FOOTNOTES 16, ‏RELATED 13. מהם 19,303 עם עוגן ב־side 0, 0 עם עוגן ב־side 1, 0 עם `link_suppressed_side`, 6,897 עם `link_range` | **כן, כשחזור** (להלן) |
| **אישי** | מסד שאינו רשמי (`kind ≠ official`) | המשתמש | — | כמו "ספריית אוצריא" |

#### כלל השוויון (אחד, `src/core/links/equality.ts`)

- **"אותו קישור" (`same-link`):** הזהות שהגנרטור נותן לקישור שמור, `IdAllocator.linkId(srcLineId, tgtLineId, connectionTypeId)` (`[F] generator/common/src/jvmMain/.../common/ids/IdAllocator.kt:73`): שורת המקור **השמורה**, שורת היעד השמורה, והסוג **השמור**. לקישור מקובץ מחשבים קודם את `storedForm` (היפוך `source`, downgrade ל־OTHER, היפוך תלוי בכותרת). קישור DB נלקח כמו שהוא. שתי רשומות עם אותה זהות הן **שורה אחת** ב־DB, מכל קובץ, בכל כיוון ובכל איות של הסוג.
- **"אותן שורות" (`same-lines`):** אותן שתי שורות, בכל כיוון ובכל סוג.
- **ספרים לפי שם מדויק**, לא לפי מפתח הסשן: כך הגנרטור פותר את `path_2` ואת שם הקובץ (§1.3).
- **טווח ועוגן אינם חלק מהזהות:** רשומות שנבדלות רק בהם מתלכדות לקישור אחד (כמה עוגנים, הטווח הרחב).

השימושים: בדיקת האיכות (`export/in-db` כש"אותו קישור", `export/in-db-other-type` כש"אותן שורות"), הצעה "כבר קיים" (הרמה "אותן שורות", `linePairKey`), "כבר בפרויקט" ברשימת קישורי ה־DB, דילוג על העתקה כפולה, ומיזוג ההצעות במנוע הקישור המרבי.

#### שחזור רשומה מקישור DB (`src/core/links/from-db.ts`)

לקישור ששמור S→T בסוג X בונים כל רשומה שהגנרטור היה שומר **כאותו קישור בדיוק**, ובודקים כל אחת ב־`storedForm`:

| מועמד | קובץ | רשומה | מתי תקף |
|---|---|---|---|
| A | של S | S→T, `"x"` | כשהגנרטור אינו הופך או מוריד (רוב הסוגים) |
| B | של T | T→S, `"source"` | רק X = COMMENTARY |
| C | של T | T→S, `"x"` | סוג תלוי, S ספר בסיס, ו־T בשם "… על S" (`G:2283-2291`) |

הבחירה: (1) עוגן ב־side 0 ⇒ A, כי רק רשומה שאינה מתהפכת שומרת עוגן (`G:2318-2321`); (2) קובץ שכבר בפרויקט; (3) מוסכמת הספרייה: קובץ התלוי עם `"source"`; (4) A. מועמד שאינו תקף נזרק. אם אף אחד אינו תקף (סוג תלוי שאינו COMMENTARY, מספר שאינו בסיס אל ספר בסיס, בלי "X על") — אין רשומה, והכלי אומר זאת.

| שדה | איך משוחזר | נאמן? |
|---|---|---|
| שורות וטווחים | מ־`line.lineIndex` ו־`link_range`, כל צד עם הצד שלו (בהיפוך הצדדים מתחלפים, כמו ב־`G:2322-2329`) | כן |
| סוג | `canonicalTypeString(stored)`, או `"source"` במועמד B | הסוג השמור כן. **האיות** המקורי לא (`"Commentary"`, `quotation_auto`, סוג לא מוכר ⇒ `OTHER`) |
| קובץ וכיוון | לפי הבחירה למעלה | ניחוש כשיש שני מועמדים; מדווח (`adopt/direction`) |
| `start`/`end` | `rawOffsetFromVisible(anchorText, charStart/charEnd)` על השורה המלאה (§1.6, §2.1). רק העוגן הראשון של side 0 | עד כדי שקילות (§4.4): האופסט הקנוני. כל עוגן נוסף היה רשומה נפרדת (`adopt/anchors-extra`) |
| תווית עוגן | `withAnchorLabel(heRef_2, label)` ⇒ `" אות X"` | כן |
| `heRef_2` | `line.heRef` של שורת היעד **של הרשומה** ב־DB | **לא.** בספרי אוצריא ה־heRef ב־DB הוא לרוב "שם הספר ומספר שורה" (`adopt/heref`) |
| עוגן ב־side 1, `link_suppressed_side` | — | אין להם ייצוג בקובץ (`adopt/anchor-target`, `adopt/suppressed`) |
| `ref_1`/`ref_2`, `anchor_src_hash`, `anchor_context` | — | לא ב־DB. כשאחד הצדדים ספריא, הבדיקה מבקשת `ref_*` כרגיל |

**נמדד מול הספרייה** (`tests/integration/database/db-links-real-db.local.test.ts` עם `OTZARIA_LIBRARY`, [L] `aa2c293b` מול [DB]): כל קובץ שני מתיקיות `links_roots` שמצבן `present` ב־`manual_links_sync.json`, עד 250 רשומות מכל קובץ. כל רשומה הותאמה לקישור ה־DB שלה לפי כלל השוויון, הועתקה בחזרה ב־`adoptDbLink`, והושוותה לרשומה המקורית.

| | רשומות |
|---|---|
| נבדקו (377 קבצים) | 45,838 |
| ספר המקור או היעד לא נמצא ב־DB בשם מדויק | 16,986 |
| אין ב־DB קישור עם אותה זהות | 381 |
| **נמצאו ב־DB** | **28,471** |
| בלי שקובץ הספר טעון: אותו קובץ, שורות, טווחים, איות סוג ו־`start`/`end` | 28,221 (99.1%) |
| בלי שקובץ הספר טעון: נבחר הקובץ השני | 250 — קובץ אחד של ספר בסיס שכותב `"commentary"` אל פירוש בלי עוגן; השחזור כתב `"source"` בקובץ הפירוש, שהוא אותו קישור שמור |
| כשקובץ הספר טעון: זהה בכל השדות חוץ מ־`heRef_2` | 28,471 (100%) |
| `heRef_2` זהה | 750 (2.6%) |

הבחירה בפועל: 27,200 רשומות `"source"` בקובץ התלוי, 1,271 בכיוון השמור (כולן עם עוגן או בלי מועמד אחר). **המסקנה:** שורות, טווחים, סוג, קובץ (כשהקובץ טעון) ועוגן גולמי משוחזרים נאמנה. `heRef_2` אינו משוחזר, ולכן הכלי מדווח עליו בכל העתקה. הקובץ והכיוון הם ניחוש רק כשקובץ הספר לא טעון, ואז הייצוא ממילא מחכה לו.

**כלל ההחלפה.** קובץ קישורים מחליף את כל הקובץ של הספר בספרייה (§1.1, `G:2062-2066`). קישור DB שמקורו "ספריית אוצריא" מעיד שכנראה **יש** לספר קובץ. לכן `db-copy` מוחזק בייצוא (`export/db-copy-no-file`) עד שקובץ הקישורים של ספר המקור שלו נמצא בפרויקט, או שהמשתמש אישר במפורש שאין לספר קובץ. כשהקובץ נטען ויש בו רשומה עם אותה זהות, ההעתק מוסר והרשומה המקורית נשארת.

**הכלל חל על הקובץ כולו, ומורחב** (סקירות האבטחה והתאימות, 2026-11): (1) בעיה של קובץ (`FILE_LEVEL_CODES` ב־`validate.ts`) מחזיקה את **כל** הקישורים של הספר, אחרת קישור אחר של אותו ספר היה כותב קובץ שמחליף את קובץ הספרייה; (2) קישור חדש של ספר שהמסד הרשמי מסמן `book_has_links.hasSourceLinks = 1` מוחזק באותו אופן (`export/library-file-not-loaded`) — הסימן רחב (7,700 מתוך 8,154 ספרים ב־[DB], כי LINKER וספריא נספרים בו), אבל אין במסד סימן מדויק יותר; (3) רק ייבוא של **קובץ ספרייה** (`<ספר>_links.json`) שפורסר נחשב "הקובץ טעון" (`LinkState.files`, מתבטל עם הייבוא). גיליון או קובץ רשומות הם קישורים חדשים (`provenance: "import"`); (4) עותק של קובץ ספרייה מפרויקט שמור אינו מאומת (`export/file-unverified`) עד שהקובץ נטען שוב ונמצא זהה, או שהמשתמש מאשר.

</div>
