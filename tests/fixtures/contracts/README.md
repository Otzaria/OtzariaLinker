<div dir="rtl">

# Fixtures של חוזה הקישורים — מקור ואופן הפקה

הקבצים כאן הם **רשומות אמיתיות** מקובצי `*_links.json` של `Otzaria/otzaria-library`, יחד עם השורות שהן הפיקו בפועל ב־`seforim.db` אמיתי. הם משמשים כבסיס לבדיקות של שכבת ההמרה (קובץ ↔ מודל פנימי ↔ DB). הניתוח המלא נמצא ב־[`docs/contracts/LINK_FORMATS.md`](../../../docs/contracts/LINK_FORMATS.md) וב־[`docs/contracts/OTZARIA_COMPATIBILITY.md`](../../../docs/contracts/OTZARIA_COMPATIBILITY.md).

## מקור

| רכיב | גרסה |
|---|---|
| ספרייה (קלט) | `Otzaria/otzaria-library` @ `17eb3cc5a6fc1556bcfe5890c8596c40a55fdb10` (main, 2026-11-11). נסרקו רק שורשי `*/links/` החיים, בלי `extraBooks/` |
| DB | `C:/ProgramData/otzaria/books/seforim.db`, `db_version=37`, `db_schema_version=7`. נפתח לקריאה בלבד (`mode=ro`) |
| גנרטור (להשוואה) | `Otzaria/SeforimLibrary` @ `23f1f8f16d2070d6b0459cc684722f4d029ad115` (ענף `otzaria`) |

ה־DB נבנה מתמונת ספרייה **מוקדמת** מ־`17eb3cc5`. לכן ייתכן ש־`line_index` של רשומות שמנוהלות ע"י `ref_*` זז מאז. מזהי `line.id` ו־`link.id` תקפים רק ל־build הזה. `lineIndex` ב־DB הוא 0-based, ו־`line_index_*` בקובץ הוא 1-based.

## מבנה כל קובץ

```
{ "_comment": "...", "_provenance": {...}, "examples": [ {
    "shape": "L->R+ref_1",              // צורת הרשומה (L=שורה, R=טווח; +anchor/+ref_1/+ref_2/+footnotes/+hearot)
    "file": "MoreBooks/links/אסתר_links.json", "recordIndex": 83,
    "record": { ...הרשומה כפי שהיא בקובץ... },
    "resolution": { "status", "sourceTitle", "targetTitle", "sourceBook", "targetBook", "sourceLine", "targetLine" },
    "dbRows": [ { "link": {..., "storedDirection": "as_file|flipped"}, "link_anchor": [...], "link_range": [...],
                  "link_coverage_rows": {"side": count}, "link_suppressed_side": [...] } ],
    "anchorCheck": { "rawStart", "expectedCharStart", "dbCharStart", "matchesGeneratorFormula", ... }   // רק בעוגנים
} ] }
```

המשמעות של `status`:
- `matched`: נמצא קישור ב־DB בין שתי השורות.
- `book_not_found_or_ambiguous`: אחד הצדדים לא נמצא לפי **כותרת מדויקת**. זו התוצאה הצפויה בשני מקרים: ספר "הערות על X" שמוזג אל הבסיס, או מלכודת שם.
- `line_not_found`: אחת השורות לא נמצאה.
- `no_db_link_between_lines`: לא נמצא קישור בין השורות.

## הקבצים

| קובץ | מה יש בו | מספר דוגמאות |
|---|---|---|
| `line-to-line.json` | שורה→שורה מקומי↔מקומי. כולל רשומות `"source"` שנשמרו הפוך כ־`COMMENTARY`, וקובץ MoreBooks שהיעד שלו (`עולת ראיה`) לא קיים ב־DB, ולכן הוא נזרק בשקט | 10 |
| `line-to-line-sefaria-ref.json` | שורה→שורה עם `ref_2` (יעד ספריא) או `ref_1` (מקור ספריא) | 16 |
| `line-to-range.json` | `line_index_2_end`: מקומי, `ref_1` (תרגום רס"ג) ו־`ref_2` (`reference` → בראשית). בדוגמת ה־`ref_2` יש גם קישור `LINKER` מקביל על אותו זוג שורות | 16 |
| `range-to-line.json` | `line_index_1_end` עם `ref_2`. כולן `"source"`, ולכן הטווח נשמר ב־side 1 | 10 |
| `anchor-point.json` | עוגן-מילה עם `start` בלבד. ב־`anchorCheck` מחושב `countVisibleChars` על טקסט השורה מה־DB, ובכל 9 הדוגמאות הוא שווה ל־`link_anchor.charStart` | 9 |
| `notes-companion.json` | רשומות אל `הערות על X` (`footnotes` ו־`commentary`). היעד אינו ספר ב־DB, ולשורות הבסיס יש `line_note` (מיזוג). כולל קובץ שנזרק כולו כי שמו כתוב ב־`׳׳` ולא ב־`״` | 16 |
| `dependent-downgraded-to-other.json` | `commentary` מספר שאינו בסיס אל ספר בסיס (בראשית) → נשמר כ־`OTHER` | 1 (המופע היחיד בספרייה החיה) |
| `db-only-shapes.json` | צורות שאין להן אף רשומת קלט ב־`_links.json` החיים: טווח→טווח, עוגן-טווח של `LINKER`, עוגן בצד 1 (`QUOTATION`), `link_suppressed_side` | 3 + 10 + 5 + 5 |

## מה **לא** קיים בספרייה החיה (נבדק על כל 531,203 הרשומות)

- אין אף רשומה עם `end`, כלומר עוגן-טווח מקובץ. כל העוגנים הם עוגני-נקודה.
- אין אף רשומה עם טווח בשני הצדדים. טווח→טווח קיים רק בקישורי ספריא (מ־CSV), ולכן הוא מופיע רק ב־`db-only-shapes.json`.
- אין רשומות עם `"Conection Type": "linker"`. הגנרטור מדלג עליהן בכל מקרה.
- אין כפילויות זהות (אותו `line_index_1`, `line_index_2`, `path_2`, סוג ו־`start`) בתוך קובץ.

## הפקה מחדש

הסקריפטים נמצאים ב־`tools/`. הם דורשים `py -3`, `zstandard`, clone של הספרייה ב־sparse checkout של `*/links/` (הנתיב מוגדר ב־`LIB` שב־`extract.py`), ו־DB לקריאה בלבד.

```
py -3 -I tools/extract.py <scratch-dir>            # → raw_examples.json
py -3 -I tools/downgrade.py <scratch-dir>/downgrade.json
py -3 -I tools/build_fixtures.py <scratch-dir>/raw_examples.json <this-dir> <scratch-dir>/downgrade.json
```

הסקריפטים קוראים את ה־DB רק דרך `file:...?mode=ro` עם `PRAGMA query_only=ON`, ולעולם אינם כותבים אליו.

</div>
