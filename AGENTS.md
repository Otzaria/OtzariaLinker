# AGENTS.md — הוראות לכלי AI שעורכים את המאגר

<div dir="rtl">

המסמך הזה נקרא על ידי כלי AI (Claude Code, Codex, Cursor וכד') לפני עריכה. בני אדם: ראו
[`CONTRIBUTING.md`](CONTRIBUTING.md) ו־[`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md).

## 1. מה המאגר

OtzariaLinker 2.0: כלי ליצירה, עריכה, ייבוא וייצוא של קובצי `_links.json` לספריית אוצריא.
**קוד המקור מודולרי** (TypeScript + Preact, תחת `src/`), ו־Vite **בונה ממנו קובץ HTML אחד**,
`dist/OtzariaLinker.html`, שהמשתמש פותח מ־`file://` בלי רשת ([ADR 0001](docs/adr/0001-modular-source-single-file-distribution.md)).

```
src/            הקוד (שכבות: docs/ARCHITECTURE.md)
tests/          unit · integration · contracts · e2e · fixtures
build/plugins/  פלאגינים של Vite: WASM כ־base64, פרטי build, הודעות רישיון
scripts/        package-release.mjs (אחרי build) · fixtures/*.py (הפקת fixtures)
docs/           adr · contracts · audit · research · מדריכים
legacy/         OtzariaLinker-v3.html (בסיס רגרסיה, byte-exact) · docs-v3/
```

לפני שינוי מהותי קראו את [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). לפני נגיעה בפורמט, במסד או
בעוגנים קראו את החוזים ב־[`docs/contracts/`](docs/contracts/).

## 2. כללים מחייבים

הפרה של אחד מהם שוברת את הכלי אצל משתמשים או את מצבו המשפטי. אם משימה נראית כדורשת הפרה, עצרו ושאלו.

### 2.1 אין רשת ואין משאב חיצוני בתוצר
אסור `fetch`/`XMLHttpRequest`/`WebSocket` לכתובת חיצונית, `<script src>` או `<link href>` לרשת,
`@import` או `url()` לרשת, `importScripts` מרשת, פונט או אייקון מ־CDN, ופונט אייקונים בכלל.
(בגרסה ישנה פונט אייקונים מ־Google Fonts הציג בלי רשת את שמות האייקונים כטקסט.)
נאכף בשלוש שכבות:
- `scripts/package-release.mjs` סורק את התוצר ונכשל על כל אחד מהדפוסים האלה;
- ה־CSP שב־`index.html` (`default-src 'none'`, `connect-src blob: data:`);
- כל בדיקות ה־E2E רצות עם `offline: true` ומוודאות שאין אף בקשה שאינה `file:`/`data:`/`blob:` (`tests/e2e/helpers.ts`).

### 2.2 קובץ אחד, Workers קלאסיים, WASM מוטמע
- Worker נבנה כ־`?worker&inline` עם `worker.format: "iife"` (`vite.config.ts`). **Module worker
  מ־`blob:` לא עולה תחת `file://` ב־Chrome וב־Edge** ([ADR 0002](docs/adr/0002-build-stack.md)). אל תשנו ל־`"es"`.
- WASM נטען דרך `virtual:wasm-b64/<path>.b64` (`build/plugins/wasm-base64.ts`). לא `?url`, לא `?init`
  ולא `?inline`: הראשונים מוציאים קובץ נפרד, והאחרון נכשל ב־Vite 8 על Windows.
- אסור להוסיף משאב שהבנייה תוציא כקובץ נפרד.

### 2.3 קריאה בלבד על נתוני המשתמש
- מסדים נקראים דרך הקורא העצל (`src/database/sqlite/lazy/`) עם `Blob.slice`. אין ממשק כתיבה, ואין
  להוסיף אחד. sql.js משמש רק לבדיקת `ping` על מסד בזיכרון.
- התוצר היחיד הוא הורדה דרך `Saver` (`src/state/services.ts`).
- גם סקריפטים ובדיקות פותחים מסד אמיתי לקריאה בלבד (`mode=ro` בפייתון, `openSync(path, "r")` ב־Node).

### 2.4 אופסטים של עוגן זהים לגנרטור
- `src/core/text/offsets.ts` הוא מימוש מחדש של ההתנהגות של `HtmlCharCounter` בגנרטור: תג לא נספר, entity של עד 10
  תווים (כולל `&` ו־`;`) נספר כתו אחד, ו־`<` בלי `>` מסתיר את המשך השורה. האופסטים הם UTF-16 code units. אל "תתקנו" את זה.
- העוגן נמדד על `SourceLine.anchorText` (בסכמה 7: השורה עם גופי ההערות, `reader.anchorText`), ולא על `text`.
- `sanitizeBookHtml` חייב להשאיר בדיוק את אותם תווים גלויים, באותו סדר. יש לזה בדיקות property.
- ההמרה בין 1-based (קובץ) ל־0-based (מודל) נעשית **רק** ב־`src/formats/links-json/convert.ts`.
- עוגן שיובא מקובץ נשמר כאופסט גולמי ונכתב חזרה כמו שהוא.

### 2.5 קישורים משתנים רק דרך `history.commit`
מסכים קוראים signals וקוראים למתודות של `AppStore`. כל שינוי בקישורים עובר ב־`store.apply` ←
`commit` (`src/state/history.ts`), וכל פעולת משתמש היא פקודה אחת שאפשר לבטל.

### 2.6 גבולות השכבות
נאכפים ב־`tests/unit/architecture.test.ts`: כל שכבה מייבאת רק את השכבות שמותרות לה, ו־`core`,
`matching`, `linking`, `formats` לא מייבאות Preact. הטבלה ב־[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
אם הבדיקה נכשלת, הזיזו את הקוד; אל תרחיבו את הטבלה בלי סיבה כתובה.

### 2.7 רישוי ושימוש חוזר
- הפרויקט ב־**GPL-3.0-or-later**.
- **אסור להעתיק קוד מהמזלגות SeforimLibrary, SeforimAcronymizer ו־SeforimMagicIndexer** (AGPL-3.0, זכויות
  של צד שלישי). מותר לממש מחדש את הרעיון ואת חוזה הנתונים. ההפניות בקוד (`Generator.kt:2276`) הן מקור
  לבדיקה, לא קוד שהועתק. מודולים שהערותיהם אומרות "port" (`offsets.ts`, `line-notes.ts`, `stored-form.ts`,
  `titles.ts`, `connection-type.ts`, `html.ts`) הם מימוש מחדש של ההתנהגות המתועדת של הגנרטור, לא העתקה.
  כך גם כותבים קוד חדש מהסוג הזה.
- **מאגרים מחוץ לארגון Otzaria: רעיונות בלבד.** בלי קוד ובלי טבלאות נתונים.
- מאגרי הארגון (Link-Notes, otzaria-link-generator ועוד) מותר לנייד; ציינו בהערה את המקור ואת ה־commit.
- חבילה חדשה בתוצר: רישיון תואם GPL-3, והוספה לרשימת `licenseNotice` ב־`vite.config.ts`.
- הפרטים: [`docs/research/REUSE_MATRIX.md`](docs/research/REUSE_MATRIX.md) §0 ו־§8.

### 2.8 commits
- **אין** `Co-Authored-By` ואין שורת ייחוס לכלי AI, ב־commit או ב־PR.
- הסגנון: [`CONTRIBUTING.md`](CONTRIBUTING.md).

### 2.9 דברים שלא נוגעים בהם
- `legacy/OtzariaLinker-v3.html`: בסיס רגרסיה, byte-exact (`-text` ב־`.gitattributes`).
- `src/ui/icons/icon-data.ts`: קובץ שנוצר אוטומטית. אל תערכו ידנית.
- `"Conection Type"` עם n אחת (`CONNECTION_TYPE_KEY`). הגנרטור מתעלם מ־`"Connection Type"`.
- סדר `CONNECTION_TYPES` (`src/core/links/connection-type.ts`): המזהה במסד הוא האינדקס ועוד 1. מוסיפים רק בסוף.
- Fixtures אמיתיים בלבד, עם תיעוד מקור. אסור להמציא מבנה של סכמה ([ADR 0004](docs/adr/0004-testing-stack.md)).

## 3. עובדות שכדאי לדעת לפני שמתקנים "באג"

| נראה כמו באג | למה זה נכון |
|---|---|
| אין שדה "תחילת טווח" | הטווח הוא `line_index_N` ועוד `line_index_N_end` לאותו צד בלבד. `_end` שאינו אחרי ההתחלה מתעלם |
| שורה נחשבת כותרת רק אם היא **מתחילה** ב־`<h1`–`<h6` | פורט של `detectHeaderLevel`. גרסה 3 חיפשה `<hN` בכל השורה וחסמה קישורים בטעות |
| שמות ספרים בלי נרמול | הגנרטור מתאים כותרות בהתאמה מדויקת. נרמול "משפר" יגרום לקישורים שייזרקו |
| `path_2` נחתך בנקודה האחרונה | כך הגנרטור גוזר כותרת. לכן תמיד כותבים `<כותרת>.txt` |
| רשומת `source`, או רשומה שמתהפכת, מאבדת עוגן | כך הגנרטור. ראו [`DH_ANCHOR_DIRECTION.md`](docs/research/DH_ANCHOR_DIRECTION.md) |
| אין קישור הפוך "כדי שיופיע בשני הספרים" | האפליקציה מציגה כל קישור בשני הצדדים. רשומה הפוכה היא קישור כפול |
| קישורי מסד (`provenance: "db"`) לא נערכים ולא מיוצאים | אי אפשר לשחזר מהם רשומה זהה ([`LINK_FORMATS.md`](docs/contracts/LINK_FORMATS.md) §4.4). "העתקה לפרויקט" יוצרת קישור **חדש** (`db-copy`), משוחזר ([§4.5](docs/contracts/LINK_FORMATS.md)) |
| קישור `db-copy` מוחזק בייצוא כשקובץ הקישורים של הספר לא בפרויקט | הקובץ מחליף את כל הקובץ של הספר בספרייה, והקישור מעיד שכנראה יש כזה (`export/db-copy-no-file`) |
| קובץ שיובא נכתב חזרה בסדר המקורי | קובץ שלא נגעו בו חייב לצאת byte-identical, כדי שה־diff בספרייה יהיה מינימלי |
| ייצוא של ספר בלי קובץ מיובא מסומן "קובץ חדש" | קובץ קישורים מחליף את כל הקובץ של הספר בספרייה |
| ספר שכל הקישורים המיובאים שלו נמחקו מקבל קובץ `[]` | אחרת הקובץ הישן נשאר בספרייה והמחיקה לא מגיעה |
| רשומה מיובאת שלא נגעו בה נכתבת גם כשיש בה שגיאה | היא כבר בספרייה; השמטה שלה מהקובץ הייתה מוחקת אותה. רק קישור חדש או ערוך מוחזק |
| מפירוש אל הבסיס שלו הסוג הוא `source`, לא `commentary` | רק ספרי בסיס של ספריא מסומנים `isBaseBook`, ולכן הגנרטור שומר `commentary` מהפירוש כמו שהוא, והאפליקציה מציגה אותו הפוך. `export/reversed-dependency` מזהיר; מנוע הכותרות כותב `source` |
| הצעה "כבר קיים" גם כשהסוג או הכיוון שונים | `linePairKey`: אותן שתי שורות, בפרויקט או במסד הפתוח. הצעה כזו לא מוסיפה כלום. זו הרמה "אותן שורות" של כלל השוויון היחיד, `src/core/links/equality.ts`; אל תכתבו כלל שוויון שני |
| חסר `ref_1`/`ref_2` הוא אזהרה ולא שגיאה | רק הסנכרון השבועי צריך אותו; הגנרטור מתעלם ממנו |
| דחייה של הצעה נשמרת לפי שמות ספרים ושורות (`rejectionKey`) | מפתחות הספרים בסשן (`s3:1234`) משתנים בכל פתיחה |
| QA וייצוא משתמשים באותה `validateExport` | אסור שיחלקו. אל תוסיפו כלל רק לאחד מהם |

## 4. איפה החוזים

| חוזה | קובץ |
|---|---|
| פורמט `_links.json`, טבלאות הקישורים במסד, המודל | [`docs/contracts/LINK_FORMATS.md`](docs/contracts/LINK_FORMATS.md), [`LINK_SCHEMA_MATRIX.md`](docs/contracts/LINK_SCHEMA_MATRIX.md) |
| סכמות 0–7, דחיסה, מסדים אישיים | [`docs/contracts/DATABASE_SUPPORT_MATRIX.md`](docs/contracts/DATABASE_SUPPORT_MATRIX.md) |
| התנהגות באוצריא ומלכודות | [`docs/contracts/OTZARIA_COMPATIBILITY.md`](docs/contracts/OTZARIA_COMPATIBILITY.md) |
| מודל הקישור הפנימי | `src/core/links/model.ts` |
| מה הגנרטור ישמור בפועל | `src/core/links/stored-form.ts` |
| כללי הייצוא | `src/core/links/validate.ts` |
| מנוע אוטומטי | `src/linking/automatic/types.ts` ([`docs/AUTOMATION_ENGINE.md`](docs/AUTOMATION_ENGINE.md)) |
| זיהוי זוגות באצווה | `src/linking/batch.ts` (`pairByTitle`) |
| יישור שורות בין שתי מהדורות (בלי ממשק עדיין) | `src/matching/line-diff.ts` |
| ספר ושורה כפי שכל מקור מחזיר | `src/core/books.ts`, `src/sources/book-source.ts` |
| state ← עולם חיצוני | `src/state/services.ts` |
| פעולות ה־Worker | `src/workers/sources-api.ts` |
| קובץ פרויקט | `src/projects/project-format.ts` |
| בדיקות חוזה על רשומות אמיתיות | `tests/contracts/`, `tests/fixtures/contracts/README.md` |

## 5. איך בודקים שינוי

```
npm ci
npm run typecheck
npx vitest run tests/unit/<area>/<file>.test.ts     # רק הבדיקות הקשורות לשינוי
npm test                                           # כל ה־unit/integration/contract
npm run build && npx playwright test               # E2E על הקובץ הבנוי, אופליין, Chrome + Edge
npm run check                                      # הכול
```

- התחילו מהבדיקות של הקבצים שנגעתם בהם. הריצו את הכול לפני שמסיימים.
- `tests/unit/architecture.test.ts` חייבת לעבור תמיד.
- נגעתם בייצוא או בפרסור: `tests/contracts/` ו־`tests/unit/formats/` חייבות לעבור. ייבוא ואחריו ייצוא
  של קובץ שלא שונה חייב לצאת זהה.
- נגעתם במנוע: הבדיקות שלו תחת `tests/unit/linking/` ו־`tests/integration/linking/`. אם יש לכם מסד
  אמיתי, גם הבדיקות המקומיות (`OTZARIA_DB`, [`docs/TESTING.md`](docs/TESTING.md)).
- שיניתם התנהגות במכוון: עדכנו את הבדיקה באותו commit. אל תמחקו אותה.

## 6. הרחבות נפוצות (בקצרה)

הפירוט: [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md) §5.

- **מנוע אוטומטי חדש:** תיקייה ב־`src/linking/automatic/<id>/` עם פונקציה טהורה
  `(source, target, options, ctx) → EngineResult`; הוספה ל־`EngineId`, ל־`ENGINES` ול־`runEngine`
  (`src/linking/automatic/index.ts`); מזהי הצעה דטרמיניסטיים; בדיקות על נתונים אמיתיים.
- **פורמט ייבוא/ייצוא חדש:** תיקייה ב־`src/formats/<format>/`; זיהוי ב־`src/sources/detect.ts`;
  ניתוב ב־`SourceRegistry.route`; ייבוא ב־`AppStore`. ההמרה למודל במקום אחד בלבד.
- **סוג מקור חדש:** מחלקה שמממשת `BookSource` (`src/sources/book-source.ts`), ניתוב ב־`registry.ts`.
  `SourceKind` ב־`src/core/books.ts`.

## 7. סגנון

- הערות בקוד ושמות באנגלית. ההערה מסבירה **למה**, ומפנה לחוזה או למקור (`Generator.kt:2318`, `@sha`).
- כל מחרוזת למשתמש בעברית, בגוף פונה, ואומרת מה קרה **ומה לעשות**. שגיאה שהמשתמש רואה היא
  `LinkerError` עם קוד יציב (`src/core/errors.ts`).
- צבעים רק כטוקנים ב־`src/ui/theme/tokens.css` (הפלטה של אוצריא, זרע `#2C1B02`). גוון ביניים:
  `color-mix()` על טוקן. לפריסה: תכונות לוגיות (`margin-inline`…). לצורה גרפית (כמו סימן וי מגבולות):
  תכונות פיזיות, אחרת היא מתהפכת ב־RTL.
- אייקונים: רק מ־`src/ui/icons/` (Otzaria Icons, ו־Fluent רק לפעולות כלליות).

## 8. כשמשהו לא ברור

- פורמט, מסד, עוגן: `docs/contracts/`. אם אין שם תשובה, **אל תנחשו**. קישור שגוי שקט גרוע מקישור חסר.
- למה משהו בנוי כך: `docs/adr/` ו־`git log` (גופי ה־commit מתעדים מדידות והחלטות).
- מה גרסה 3 עשתה: `legacy/OtzariaLinker-v3.html`, [`docs/audit/`](docs/audit/), ו־`legacy/docs-v3/`.

</div>
