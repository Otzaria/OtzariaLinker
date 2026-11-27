<div dir="rtl">

# מפת המנועים מול גרסה 3 (V7 §2.1)

**מה זה.** מיפוי של כל מנוע ושל כל שיטת־משנה בכלי הנוכחי: מה הוא עושה, איפה הקוד, אילו בדיקות מכסות אותו, ומה המקבילה
שלו בגרסה 3 (`legacy/OtzariaLinker-v3.html`, ופריטי ה־F-xxx של [`FEATURE_INVENTORY.md`](../audit/FEATURE_INVENTORY.md)). לכל
התנהגות של גרסה 3 נקבע אחד משלושה: **נשמר** (עם שם קובץ הבדיקה ושם הבדיקה שמוכיחה זאת), **שונה במכוון** (עם הנימוק
הכתוב), או **אבד**. כשלא נמצאה בדיקה, נכתב "לא נמצאה בדיקה".

דרישה: V7 §2.1. ענף הבסיס: `v7/02-linking-correctness`. תאריך: 2026-11-26. מספרי השורות של גרסה 3 הם של
`legacy/OtzariaLinker-v3.html` (זהים ל־`index.html` של `baseline-pre-2.0`).

**איך לקרוא.** בגרסה 3 היה דיאלוג "קישור אוטומטי" אחד עם ארבע לשוניות (F-094): `buildStruct` (לפי כותרות, 5999),
`buildTag` (לפי תגיות, 6055), `buildRegex` (לפי תבנית, 6102) ו־`buildRanges` (השלמת טווחים, 6156). כולן יצרו קישורים
ישירות דרך `runMatches` (5906). בכלי הנוכחי מנוע **מציע** והמשתמש מאשר ([`AUTOMATION_ENGINE.md`](../AUTOMATION_ENGINE.md) §1).
הלשוניות התפזרו כך: "לפי כותרות" ← מנוע הכותרות; "לפי תגיות" ו"לפי תבנית" ← מנוע התבנית (התגית היא אפשרות `tag`);
"השלמת טווחים" ← כללי הטווחים. דיבור המתחיל, הערות שוליים, מראי מקומות וכל התזמור (קישור מרבי, אצווה, איחוד, גילוי,
מעבר מהדורה, כיסוי) **אין להם מקבילה** בגרסה 3.

## 1. טבלת סיכום

| מנוע / שיטה | קבצים עיקריים | בדיקות (עיקריות) | F-xxx בגרסה 3 | מצב |
|---|---|---|---|---|
| חוזה משותף (ודאות, אישור) | `automatic/types.ts`, `index.ts`, `steps.ts`, `state/suggestions.ts` | `bulk-approve.test.ts`, `engine-steps.test.ts`, `option-specs.test.ts` | F-094, F-103, F-104 | שונה במכוון |
| כותרות + התאמת כותרות | `automatic/headings/`, `title-fit.ts` | `unit/linking/headings/` (4 קבצים, 54 בדיקות), `title-fit*.test.ts`, `integration/linking/headings/` | F-095–F-098 | **אבד חלקית** |
| דיבור המתחיל | `automatic/dibur-hamatchil/` | `unit/linking/dibur-hamatchil/` (9 קבצים, 138 בדיקות), `integration/linking/dibur-hamatchil/` | — | חדש |
| הערות שוליים | `automatic/footnotes/` | `unit/linking/footnotes/` (3 קבצים, 98 בדיקות), `integration/linking/footnotes/` | F-101 (רעיון), F-099 (חלקית) | חדש |
| תבנית (כולל תגיות) | `automatic/pattern/` | `unit/linking/pattern/` (4 קבצים, 72 בדיקות), `e2e/pattern-and-ranges.spec.ts` | F-099, F-100, F-101, F-102 | שונה במכוון; **אבד חלקית** |
| מראי מקומות | `automatic/citations/`, `workers/citations-job.ts` | `unit/linking/citations/` (13 קבצים, 245 בדיקות), `e2e/citations.spec.ts` | — | חדש |
| מסנן השורות | `automatic/source-filter.ts` | `source-filter*.test.ts`, `line-gate.property.test.ts`, `e2e/source-filter.spec.ts` | — | חדש |
| קישור מרבי (הרצה ודוח) | `state/maxlink.ts`, `workers/maxlink-job.ts`, `maxlink-report.ts` | `integration/workers/maxlink-job.test.ts`, `integration/state/maxlink*.test.ts`, `e2e/maxlink*.spec.ts` | — | חדש |
| תכנון | `plan.ts` | `plan*.test.ts` (`plan.test.ts`: 79 בדיקות), `validation/planner-*.test.ts` | — | חדש |
| אצווה | `batch.ts`, `batch-job.ts` | `batch.test.ts`, `batch-job*.test.ts`, `batch-editions.test.ts` | — | חדש |
| איחוד | `merge.ts` | `merge.test.ts` (42 בדיקות), `merge-fixround.test.ts`, `merge-representative.test.ts` | — | חדש |
| גילוי זוגות | `discovery.ts` | `discovery.test.ts`, `discovery-fixround.test.ts` | — | חדש |
| מעבר מהדורה | `relink.ts` | `relink.test.ts`, `e2e/relink.spec.ts` | — | חדש |
| מיפוי מהדורות | `edition-map.ts`, `matching/line-diff.ts` | `edition-map.test.ts`, `line-diff.test.ts` | — | חדש |
| טווחים (וגם "המשך לקטע הקודם") | `ranges.ts`, `state/ranges.ts` | `unit/linking/ranges.test.ts`, `integration/state/ranges.test.ts`, `continuation.test.ts` | F-054, F-055, F-064, F-079–F-085, F-105 | שונה במכוון; **אבד חלקית** |
| כיסוי | `coverage.ts`, `state/coverage.ts` | `coverage*.test.ts`, `integration/state/coverage*.test.ts` | F-042 (רק ספירה) | חדש |

הנתיבים בטבלה יחסיים ל־`src/linking/` ול־`tests/` (חוץ ממה שמתחיל ב־`state/`, `workers/` או `matching/`, שהם תחת `src/`).

## 2. החוזה המשותף של המנועים

**מה.** כל מנוע זוגי הוא פונקציה טהורה `(source, target, options, ctx) → EngineResult` שמחזירה הצעות עם ציון, דרגת ודאות,
נימוקים ו־`unmatched`. `ENGINES` ו־`runEngine` מנתבים, `engineSteps` מריץ את המנוע כצעדים שאפשר לבטל ביניהם, ו־`SuggestionsState`
הופך אישור לקישורים בפקודה אחת שאפשר לבטל.

**איפה.** `src/linking/automatic/types.ts` (`confidenceOf`, `DEFAULT_THRESHOLDS`, `capSpanned`), `src/linking/automatic/index.ts`
(`ENGINES`, `runEngine`, `runEngineSliced`, `engineSteps`), `src/linking/automatic/steps.ts`, `src/linking/automatic/option-specs.ts`,
`src/linking/automatic/sort.ts`, `src/state/suggestions.ts`.

**בדיקות.** `tests/unit/linking/engine-steps.test.ts`, `tests/unit/linking/option-specs.test.ts`, `tests/unit/linking/suggestion-sort.test.ts`,
`tests/integration/state/bulk-approve.test.ts`, `tests/e2e/automatic-linking.spec.ts`.

**גרסה 3.** F-094 (`Dialogs.auto` 5732), F-103 (`renderMatches` 5798), F-104 (`runMatches` 5906).

| התנהגות בגרסה 3 | מצב | ראיה / נימוק |
|---|---|---|
| F-103: ספים ≥0.95 ודאי, ≥0.85 כנראה | נשמר (הורחב: "אפשרית" מ־0.6 ו"עמומה") | `DEFAULT_THRESHOLDS` ב־`types.ts`. `tests/unit/linking/v3-kept.test.ts`: "F-103: ≥0.95 certain, ≥0.85 high …" (נוספה בסבב הזה) |
| F-103: סינון אצווה חל גם על מה שלא מוצג | נשמר | `bulk-approve.test.ts`: "the default levels are certain and high; the preview's count is exactly what is approved, and one undo takes it all back" |
| F-104: רשומה אחת בהיסטוריה לכל ההחלה | נשמר | אותה בדיקה, וגם `integration/state/maxlink.test.ts`: "runs into ONE suggestions run; approve all certain is one undoable action; the report follows" |
| F-104: התקדמות ו־yield לממשק | שונה במכוון: הריצה ב־Worker, עם `ctx.progress` וביטול | `engine-steps.test.ts`: "a cancel that arrives as a message while the engine runs stops it at its next line" |
| F-104: `heRef` לכל התאמה | נשמר (`heRef2` בכל הצעה) | `headings/engine.test.ts`: "heRef2: the base line's heRef when given, else title + Hebrew path" |
| F-104: הטווחים נמשכים "עד ההתאמה **הנבחרת** הבאה פחות 1", לפי מבנה הקישור (`kindId`) שהמשתמש בחר | שונה. כל מנוע קובע את הטווח שלו (כותרות: הקטע; תבנית: `range-end`), ואין בחירת מבנה לריצה. "השלמת טווחים" אחרי האישור נותנת את הכלל הישן | הנימוק הכללי הוא חוזה ההצעות (AUTOMATION_ENGINE §1). **נימוק מפורש לכלל "עד הנבחרת הבאה" לא נמצא.** ‏e2e: `pattern-and-ranges.spec.ts`: "pattern method → approve → range completion → undo" |
| F-104: ריבועי (TD-M1) | תוקן | `quadratic.test.ts` ("linear on hostile sizes"), אבל רק לתכנון ולמראי מקומות |

## 3. כותרות (`headings/`, `title-fit.ts`)

**מה.** כל שורת תוכן בפירוש יורשת את המקום המבני של הכותרות שמעליה (פרק › פסוק, סימן › סעיף, דף › עמוד), ומקושרת לשורה או לטווח
ברמה העמוקה ביותר שמתאימה בבסיס. הרמות מותאמות לפי סוג ומספר ולא לפי עומק התגית, ושמות מותאמים גם בדמיון. שומרי עקביות
(`consistency.ts`, `quote.ts`) רק מורידים ודאות. `titleFit` עונה **לפני** ההרצה אם לפירוש יש כותרות של הבסיס (פסק מייעץ:
`fit` / `partial` / `undecided` / `unfit`), ובקישור מרבי `unfit` מדלג על שלב הכותרות.

**איפה.** `src/linking/automatic/headings/index.ts` (`runHeadingsEngine`, `headingsSteps`), `align.ts` (`align`, `sameUnit`),
`structure.ts` (`analyzeBook`, `buildUnits`), `numbering.ts` (`parseHeading`), `consistency.ts` (`assessNumbering`), `quote.ts`
(`QuoteChecker`); `src/linking/title-fit.ts` (`titleFit`, `titleGateAdvice`, `TITLE_FIT`).

**בדיקות.** `tests/unit/linking/headings/engine.test.ts`, `consistency.test.ts`, `number-only.test.ts`, `numbering.test.ts`;
`tests/integration/linking/headings/fixture.test.ts` (אונקלוס על בראשית), `real-db.local.test.ts` (מקומי);
`tests/unit/linking/title-fit.test.ts`, `title-fit-advice.test.ts`, `tests/integration/linking/title-fit.test.ts`,
`tests/integration/workers/title-fit-job.test.ts`, `maxlink-title-advice.test.ts`, `tests/unit/ui/pair-fit.test.ts`,
`tests/validation/title-fit-sample.test.ts`; e2e: `automatic-linking.spec.ts` ("headings engine: run in the worker → table → approve all certain → card view → undo").

**גרסה 3.** F-095 (`buildStruct` 5999, `Domain.structuralMatch` 3850, `_contentScore` 3824), F-096 (`Util.Heb.phraseSimilarity` 2334),
F-097 (`trySplit` 3862), F-098 (אבחון 6044–6047), ושלוש הבדיקות העצמיות "התאמה מבנית" (§22).

| התנהגות בגרסה 3 | מצב | ראיה / נימוק |
|---|---|---|
| F-095: הקישור נוצר בין **שורות הכותרת** עצמן | שונה במכוון: שורת תוכן ← שורה או טווח של תוכן, ואף פעם לא כותרת | TD-C2 (הייצוא דילג על כל הקישורים האלה, `TECHNICAL_DEBT.md`). `engine.test.ts`: "never targets a heading line, at either end of a range"; "a line with only a chapter above it links to the chapter's content range, never its heading" |
| F-095 `structural`: חתימת נתיב זהה מהשורש | נשמר והורחב: יישור לפי סוג ומספר, עם דילוג על רמה חסרה בקנס | `engine.test.ts`: "a פסוק heading lands on the base line numbered (N) in the same chapter — certain"; "levels are matched by kind, not by tag depth; a base grouping level absent from the commentary is skipped". ‏`fixture.test.ts`: "links every verse of the targum to its verse, matching the database's links" |
| F-095 `subsections`: רק כותרות־עלה | שונה: תמיד הרמה העמוקה שמתאימה; רמה בפירוש שאין בבסיס ← טווח ההורה (`heading/partial-matches`) | `engine.test.ts`: "a verse missing in the base gives a PARTIAL link to the chapter, with a warning" |
| F-095 `content`: בונוס על הורה זהה ועל אותה רמה | שונה: יישור הנתיב כולו, ושומר "מקום הקטע" (`heading/outside-section`) | `consistency.test.ts`: "a full match in another section loses to the partial match inside its own section" |
| F-096: התאמה גמישה לכתיב, **מתג** למשתמש, סף 0.82, ציון ×0.95 | **אבד חלקית.** שמות מושווים ב־`phraseSimilarity` עם סף קבוע `NAME_MIN = 0.85` (`align.ts`), בלי מתג ובלי סף שהמשתמש קובע. הכתיב של מספרים: `numbering: "lenient"` | **לא נמצאה בדיקה** ל־`heading/similar-name`. למספרים: `engine.test.ts`: "summed numerals (יה, רחצ) match canonical ones in lenient mode only" |
| F-097: "פסקאות כסעיפים" (`implicitSeifim`): N פסקאות תחת כותרת = N ילדים בבסיס ← פיצול אחד לאחד ×0.8 | **אבד.** פסקאות בלי מספור מקושרות כולן לטווח ההורה. הקרוב: `inlineMarkers` מפצל רק שורות **ממוספרות** "(יב)" כשהמספור מקביל | `engine.test.ts`: "auto mode uses the (N) numbers because they run parallel to the base's". **נימוק לביטול הפיצול לפי ספירה לא נמצא** |
| F-098: "במקור אין מקבילה ביעד" | נשמר (`unmatched` עם קוד וסיבה) | `engine.test.ts`: "a chapter missing in the base is unmatched with a reason" |
| F-098: "ביעד אין מקבילה במקור" | **אבד** במנוע (אין קוד כזה; יש `heading/base-gaps` למספור חסר בבסיס בלבד). הכיסוי (§16) מראה שורות בסיס בלי קישור, אבל לא כאבחון של הריצה | `engine.test.ts`: "notes numbering gaps in the base" (רק פערי מספור) |
| בדיקות עצמיות "התאמה מבנית" (3): "בלי גמישות רק כותרת זהה מתאימה", "עם גמישות גם הקיצור מתאים", "כל התאמה נושאת ציון ודאות" | השלישית נשמרת במהות (לכל הצעה `score` ו־`confidence`); שתי הראשונות **לא הועברו** | `e2e/legacy-baseline.spec.ts` מריץ אותן רק על גרסה 3 עצמה |

## 4. דיבור המתחיל (`dibur-hamatchil/`)

**מה.** לכל שורה בפירוש מחלץ את הד"ה (הדגשה, "וכו'", פיסוק, מקף; עד 12 מילים) ומחפש אותו בבסיס: רצף מילים משוקלל לפי נדירות,
עם גשרים לראשי תיבות, קיצורים ומילים דבוקות. החיפוש מצומצם לחלון של הכותרת המשותפת, עם סולם הקלות A–D, ירושה לשורות
בא"ד ו"שם", קריאת סימני ההערות של ספריא בבסיס, ושובר שוויון לפי ההקשר והסדר. ההצעה כתובה בכיוון בסיס ← פירוש עם עוגן.

**איפה.** `src/linking/automatic/dibur-hamatchil/engine.ts` (`runDiburHamatchilEngine`, `diburHamatchilSteps`, `anchorPolicy`,
`monotoneChain`), `extract.ts` (`extractDh`), `search.ts` (`bestRun`), `windows.ts` (`headingWindowPlan`, `headingWindows`),
`confidence.ts`, `markers.ts`, `addressee.ts`, `tie-break.ts`. משתמש ב־`src/matching/token-match.ts` וב־`word-weights.ts`.

**בדיקות.** `tests/unit/linking/dibur-hamatchil/` (`addressee`, `engine`, `extract`, `matched`, `performance`, `requirements`, `scopes`,
`structure`, `tie-break`); `tests/integration/linking/dibur-hamatchil/mini-db.test.ts` ("certain + high suggestions agree with the
database's commentary links"), `real-db.local.test.ts`; e2e: `engines.spec.ts` ("dibur hamatchil: Rashi on Bereshit against Bereshit
from the real database slice"), `automatic-linking.spec.ts` (המילים שהותאמו).

**גרסה 3.** אין. בגרסה 3 `dibur_hamatchil` הוא רק סוג קשר ברשימה (`Config` 1859). הליבה היא ניוד של `runLinkingParser`
מ־`otzaria-link-generator` (AUTOMATION_ENGINE §3). אין התנהגות של גרסה 3 שיכלה לאבוד.

**V7 §2.14 (#43).** הסקריפט `build_artzot_hachaim_links.py` של הבעלים מתבצע עכשיו כהגדרה של המנוע הזה (AUTOMATION_ENGINE §3.3). נוספה רק
האפשרות `itemRanges`: פסקאות ההמשך של ס"ק הן טווח בצד הפירוש, ולא קישור לכל פסקה. `tests/integration/linking/dibur-hamatchil/artzot-hachaim.test.ts`
משווה את הרשומות לפלט של הסקריפט על שורות אמיתיות מ־`seforim-v7-mini.db`.

## 5. הערות שוליים (`footnotes/`)

**מה.** מקשר סימני הערה בספר הראשי (`<sup>`, `<sub>`, סוגריים, תגית או ביטוי של המשתמש) לשורות בספר ההערות שנפתחות באותו
סימן. כשהמספור מתחיל מחדש, הספר מחולק לפרקים ביישור גלובלי או לפי כותרות; יש מצב "לפי מיקום" להערות בלי מספר. העוגן הוא
הטווח הגולמי של הסימן. מדווח על סימנים בלי הערה, הערות בלי סימן, סימן בשורת כותרת ושורות הערה שאינן נפתחות בסימן.

**איפה.** `src/linking/automatic/footnotes/engine.ts` (`runFootnotesEngine`), `markers.ts` (`detectMarkers`, `compileStyle`),
`chapters.ts` (`resetChapters`, `pairSections`), `align.ts` (`alignChapters`).

**בדיקות.** `tests/unit/linking/footnotes/engine.test.ts`, `markers.test.ts`, `markers-redos.test.ts`;
`tests/integration/linking/footnotes/golden.test.ts` ("finds exactly the 16 links, in every chapter mode and with both alignments"),
`real-db.local.test.ts`, `v52-encyclopedia.local.test.ts`; e2e: `engines.spec.ts` ("footnotes: markers in the main book are matched to the notes book").

**גרסה 3.** אין מקבילה ישירה: המנוע הוא ניוד של Link-Notes @`b1e0670` (הערת הקובץ). שני רעיונות קרובים בגרסה 3:

| התנהגות בגרסה 3 | מצב | ראיה / נימוק |
|---|---|---|
| F-101: "קובץ הערות מחולק לפרקים", איפוס במספור ← הפרק הבא | נשמר והורחב (יישור גלובלי, כותרות, איפוס ב־2) | `engine.test.ts`: "follows the restarts (no headings): first chapter certain, inferred chapters lower"; "a notes chapter that restarts at 2 (its 1 is elsewhere) is still split" |
| F-102: "יעדים בלי הפניה" | נשמר כאן (ולא בתבנית) | `engine.test.ts`: "markers without notes and notes without markers are reported, with a diagnosis" |
| F-099: תוכן `<sup>` הוא מספר | שונה: כאן המספר הוא **מספר ההערה**, לא מספר שורה. המשמעות של גרסה 3 (מספר שורה) נשמרה במנוע התבנית (§6) | — |

## 6. תבנית (`pattern/`), כולל "לפי תגיות"

**מה.** בכל שורת מקור תבנית (מוכנה מ־`presets.ts` או תבנית משלכם עם מצייני מקום) מוצאת הפניות. כל הפניה נקראת כמספר
(גרסה 3) או כנתיב של רמות ("סימן ה סעיף ג"), ומכוונת לפי `target`: `line` (מספר שורה ביעד, ברירת המחדל של גרסה 3, עכשיו
התבנית המוכנה `v3`), `chapter-line` (שורה N בפרק הנוכחי), או `tree` (מקום בעץ הכותרות). במקום תבנית אפשר לקרוא את המספר
מתוכן תגית (`tag`, למשל `sup`). רץ רק בזוג (`noBatch`), לא באצווה ולא בקישור מרבי.

**איפה.** `src/linking/automatic/pattern/engine.ts` (`runPatternEngine`, `readReferences`, `DEFAULT_PATTERN`), `presets.ts`
(`PATTERN_PRESETS`), `template.ts` (`compilePattern`), `tree.ts` (`TargetTree`), `numerals.ts`, `books.ts`.

**בדיקות.** `tests/unit/linking/pattern/engine.test.ts`, `presets.test.ts`, `tree.test.ts`, `numerals.test.ts`;
`tests/integration/linking/pattern/real-db.local.test.ts`; e2e: `pattern-and-ranges.spec.ts`, `engines.spec.ts` ("engine settings (advanced): a custom marker tag is passed to the worker; a dangerous regex blocks the run").

**גרסה 3.** F-099 (`buildTag` 6055), F-100 (`buildRegex` 6102), F-101 (`resolveTargets` 5970), F-102 (`diagnose` 5958). הקוד
מצהיר על המקור בהערת הראש של `engine.ts`.

| התנהגות בגרסה 3 | מצב | ראיה / נימוק |
|---|---|---|
| F-100: תבנית ברירת המחדל, קבוצה 1 = מספר, מספר שורה ביעד | נשמר (התבנית המוכנה `v3`, עם כמתים חסומים) | `engine.test.ts`: "the number is a 1-based line number of the target; Hebrew numerals are read" |
| F-100: התאמה ראשונה בלבד בכל שורה | נשמר כברירת מחדל (`matches: "all"` אופציונלי) | `engine.test.ts`: "only the first match of a line by default; every match with matches: all" |
| F-100: רץ על טקסט בלי תגיות, והאופסט זז (TD-H4) | שונה במכוון: הטקסט הגלוי ממופה חזרה לאופסט גולמי | הערת `engine.ts` ("v3 wrote stripped offsets as raw — TD-H4"). `engine.test.ts`: "the match on the visible text maps back to the raw span the generator counts the same way" |
| F-100: בדיקת תקינות חיה לביטוי | נשמר, ועכשיו גם שומר ReDoS (`checkCustomPattern`) | `engine.test.ts`: "a dangerous or empty-matching pattern is refused before anything runs"; e2e `engines.spec.ts` (למעלה) |
| F-099: תוכן התגית הוא מספר השורה, העוגן הוא התגית, גימטריה אופציונלית | נשמר | `engine.test.ts`: "the content of <sup> is the number; the anchor is the whole element; the pattern is not used"; "gematria off reads digits only" |
| F-099: מתעלם משורות כותרת | נשמר | `engine.test.ts`: "heading lines of the source are never searched" |
| F-099: סוג ברירת המחדל `linker` | **שונה בלי נימוק כתוב**: ברירת המחדל במנוע היא `reference` גם במצב תגית (`declaredType` פתוח לשינוי) | לא נמצאה בדיקה |
| F-101: פרקים לפי כותרות, איפוס ← הפרק הבא | נשמר (`target: "chapter-line"`), ועכשיו גם מזהיר כשמספר הסדרות שונה ממספר הפרקים | `engine.test.ts`: "a number that does not grow moves to the next chapter; the label reads back from heRef_2"; "more numbering series than chapters: the extra ones are reported, the rest marked for review" |
| F-102: הפניות שלא נפתרו | נשמר (`unmatched` עם סיבה לכל שורה) | `engine.test.ts`: "a number past the end, or pointing at a heading line, is reported and not suggested" |
| F-102: יעדים כפולים | נשמר כהערת ריצה (`pattern/shared-targets`) | **לא נמצאה בדיקה** |
| F-102: יעדים בלי הפניה (שאינם כותרות) | **אבד** במנוע התבנית (קיים רק במנוע ההערות, §5) | — |

## 7. מראי מקומות (`citations/`)

**מה.** קורא ספר אחד ומוצא בו הפניות ("ברכות יג:", "רמב"ם הל' שבת פ"ב ה"ג", "שם", "לעיל"), מזהה את הספר המצוטט מתוך שמות
וקיצורים, מפענח את המקום ומאתר את השורה בכל הספרים הפתוחים. רץ כמנוע של ספר אחד (`singleBook`) ב־`citationsJob`, עם שער
התאמה לספר (`citationGate`) ודרגת ודאות לפי סוג הראיה.

**איפה.** `src/linking/automatic/citations/engine.ts` (`runCitationsEngine`, `CitationRun`, `scoreOf`), `detect.ts` (`CitationScanner`),
`aliases.ts` (`AliasIndex`), `address.ts` (`parseAddress`), `resolve.ts`, `named.ts`, `self.ts`, `altdaf.ts`, `numbers.ts`,
`suitability.ts` (`citationGate`), `knowledge.ts`; `src/workers/citations-job.ts`.

**בדיקות.** `tests/unit/linking/citations/` (13 קבצים, ביניהם `engine`, `detect`, `gate`, `v7-round`); `tests/integration/linking/citations/mini-db.test.ts`,
`real-db.local.test.ts`, `v52-v7.local.test.ts`; `tests/integration/workers/citations-suitability.test.ts`, `citations-gate-fixround.test.ts`;
`tests/integration/state/citations-chain.test.ts`; `tests/validation/citations-gate.test.ts`, `citations-knowledge.test.ts`;
e2e: `citations.spec.ts`.

**גרסה 3.** אין. אין התנהגות של גרסה 3 שיכלה לאבוד.

## 8. מסנן השורות (`source-filter.ts`)

**מה.** מגביל את ההרצה לשורות שנפתחות בסימן (`[א]`, `(א)`, `א)`, `<b>ד"ה</b>` או ביטוי משלכם), או לכל השורות חוץ מהן. הסימן מוחלף
ברווחים רק לצורך ההתאמה, כך שהאופסטים נשארים של השורה המקורית. הסינון שייך **להרצה** ולא למנוע: `LineGate.judge` לפני,
`LineGate.guard` אחרי כל מנוע (זוג, אצווה, קישור מרבי, מראי מקומות).

**איפה.** `src/linking/automatic/source-filter.ts` (`compileSourceFilter`, `applySourceFilter`, `blankMarker`, `LineGate`, `runLineFilter`,
`previewSourceFilter`); מחובר ב־`engineSteps`, `workers/maxlink-job.ts`, `workers/citations-job.ts`.

**בדיקות.** `tests/unit/linking/source-filter.test.ts`, `source-filter-markers.test.ts`, `source-filter-bidi.test.ts`, `line-gate.property.test.ts`,
`line-filter-job.test.ts`; `tests/integration/state/line-filter-run.test.ts` ("max-link with the filter in the dibur-hamatchil form: no engine links an excluded line");
`tests/integration/linking/source-filter-real-db.test.ts`; e2e: `source-filter.spec.ts`.

**גרסה 3.** אין (גיליון #27, AUTOMATION_ENGINE §10.1).

## 9. קישור מרבי: הרצה, עבודה ודוח

**מה.** "קישור מרבי" מקבל קבוצת ספרים, מתכנן (§10) איזה מנוע רץ על איזה ספר או זוג, מריץ ספר אחר ספר ב־Worker (זוג אחד בזיכרון,
מטמון של ארבעה ספרים), ומאחד (§12) לריצה אחת. העבודה נשמרת ב־IndexedDB: השהיה, המשך אחרי טעינה, טביעות אצבע ל"הרצה מחדש של
מה שהשתנה", והרצה חוזרת של מה שנכשל. הדוח סופר לפי ספר, מנוע ודרגה, ויוצא ל־CSV.

**איפה.** `src/state/maxlink.ts` (`MaxLinkState`), `src/workers/maxlink-job.ts` (`maxlinkJob`, `fingerprintsJob`, `partByLinks`,
`SINGLE_BOOK_RUNNERS`), `src/linking/maxlink-report.ts` (`buildReport`, `reportCsv`).

**בדיקות.** `tests/integration/workers/maxlink-job.test.ts` ("reads a pair once for all of its engines (one pair in memory at a time)"),
`maxlink-ambiguous-base.test.ts`, `maxlink-title-advice.test.ts`; `tests/integration/state/maxlink.test.ts`, `maxlink-job.test.ts`
("pause keeps the finished books (shown as the run), resume runs only the rest"), `maxlink-stored-result.test.ts`;
`tests/unit/state/maxlink-selection.test.ts`; `tests/unit/linking/maxlink-report.test.ts`, `sections.test.ts`; `tests/unit/formats/csv-injection.test.ts`;
`tests/integration/linking/maxlink-real-db.local.test.ts`, `v52-slice.local.test.ts`; e2e: `maxlink.spec.ts`, `maxlink-job.spec.ts`
("max-link job: a failing book, pause → reload → continue → run the failed one again → per-book report"), `guided-flow.spec.ts`.

**גרסה 3.** אין. בגרסה 3 כל לשונית רצה על זוג אחד בנפרד, בלי תזמור ובלי איחוד.

**V7 §2.15.** הרצה חדשה של ספרים שכבר הסתיימו משתמשת בתוצאה הקודמת ("לא השתנה") כשטביעת האצבע זהה, והגדרה ששונתה מריצה אותם שוב.
ספרי ספריא שבין הספר לבסיסים שלו הם עכשיו חלק מטביעת האצבע. `tests/integration/state/maxlink-reuse.test.ts`.

## 10. תכנון (`plan.ts`)

**מה.** `planMaxLink` קובע לכל ספר קשרים לפי הראיה החזקה ביותר: `book_base_text` במסד, השם ("הערות על Y", "X על Y"), הקישורים
שכבר במסד, והקורפוס (משנה ← בבלי). מכל קשר נגזרים שלבים (`pair` או `single`) עם השיטות שמתאימות, שער כותרות (`titleGate`),
והערכת זמן. הוא מסמן בסיס שנבחר לפי כלל בין כמה מהדורות (`ambiguousBase`), ומכבד בחירות המשתמש (`PlanChoices`).

**איפה.** `src/linking/plan.ts` (`planMaxLink`, `PAIR_ENGINES`, `singleBookEngines`, `evidenceFromCounts`, `competingTargets`, `targetHierarchies`,
`notesBaseKey`, `relationsOf`, `estimateMs`).

**בדיקות.** `tests/unit/linking/plan.test.ts` ("a commentary gets headings and dibur-hamatchil against its base; a targum only headings";
"a notes book runs the footnotes engine with the MAIN book as the source"), `plan-fixround.test.ts`, `plan-targets.test.ts`,
`plan-ambiguous-base.test.ts`, `quadratic.test.ts`; `tests/integration/state/guided-pair-controls.test.ts`;
`tests/validation/planner-evidence.test.ts`, `planner-gaps.test.ts`, `planner-unplanned.test.ts`, `multibase.test.ts`.

**גרסה 3.** אין.

## 11. אצווה (`batch.ts`, `batch-job.ts`)

**מה.** `pairByTitle` מזווג כל ספר "X על <בסיס>" עם הבסיס ששמו מופיע בו, בלי לנחש: שם בצורה אחרת, בסיס שאינו פתוח או כמה
בסיסים שווים — לא מזווג, עם סיבה. בחירת מהדורה לפי כלל (`resolveBaseKey`) מגבילה את התוצאה ל"אפשרית" (`capUndecided`) עד שהמשתמש
בוחר. `batch-job.ts` מחזיק את מודל העבודה ספר אחר ספר: סדר הריצה, מזהים יציבים, טביעות אצבע, וחתימת הצעדים.

**איפה.** `src/linking/batch.ts` (`pairByTitle`, `pairOne`, `resolveBaseKey`, `editionKey`, `capUndecided`, `titleIndex`);
`src/linking/batch-job.ts` (`jobFromPlan`, `runOrder`, `stepsSignature`, `bookFingerprint`, `stableId`, `withStableIds`, `jobTotals`, `jobCsv`).

**בדיקות.** `tests/unit/linking/batch.test.ts` ("explains every book it does not pair, and never guesses between equals"),
`batch-job.test.ts`, `batch-job-stored-options.test.ts`, `run-order-ties.test.ts`; `tests/integration/state/batch-editions.test.ts`
("a base chosen by a rule: nothing above 'possible', and the row and the run say why"); `tests/integration/linking/v52-editions.local.test.ts`;
e2e: `engines.spec.ts` ("batch: a folder of commentaries, each against the base its title names").

**גרסה 3.** אין (כל הרצה בגרסה 3 היא על הזוג שבפאנלים).

## 12. איחוד (`merge.ts`)

**מה.** `mergeSuggestions` מאחד את הצעות כל המנועים לרשימה אחת: אותן שתי שורות בכל כיוון ובכל סוג (`linePairKey`) הן הצעה
אחת; הסכמה של שני מנועים מעלה דרגה אחת לכל היותר; טווח גס שמכיל יעד מדויק מתקפל אליו; סתירה מוכרעת לפי הראיות (`settle`)
או נשארת "עמומה"; זוג ספרים שהמנועים סותרים בו, או שסותר את הספרייה, מאבד את ה"ודאיות". האיחוד אף פעם לא ממציא קישור.

**איפה.** `src/linking/merge.ts` (`mergeSuggestions`, `mergeItems`, `linePairKey`, `applyPairMinimums`, `PAIR_DISAGREEMENT`, `REFERENCE_DISAGREEMENT`).

**בדיקות.** `tests/unit/linking/merge.test.ts` ("headings (commentary → base) and dibur-hamatchil (base → commentary, anchored) are ONE link";
"is independent of the order of its input"), `merge-fixround.test.ts`, `merge-representative.test.ts`; `tests/unit/state/rejection-keys.test.ts`;
`tests/validation/merge-replay.test.ts`.

**גרסה 3.** אין איחוד. הקרוב: מפתח הייחודיות של `LinkService` (F-086), שכלל את הסוג. כאן "אותו קישור" אינו תלוי בסוג ובכיוון,
במכוון (AGENTS.md §3, "הצעה 'כבר קיים' גם כשהסוג או הכיוון שונים").

## 13. גילוי זוגות (`discovery.ts`)

**מה.** `discoverPairs` מציע זוגות פירוש/בסיס (ושל ספר הערות ובסיסו) בין ספרים פתוחים, גם בין מסד אישי לרשמי, עם ודאות וסיבות,
ותמיד עם `requiresReview`: הוא אינו מקשר דבר. הראיות: השם, הקישורים שכבר יש לספר, והקטגוריה. שם שמציין ספר שאינו פתוח הוא `unresolved`.

**איפה.** `src/linking/discovery.ts` (`discoverPairs`, `THIN_LINKED_SHARE`).

**בדיקות.** `tests/unit/linking/discovery.test.ts` ("a title two books share is not guessed: the official one wins only as the planner's rule says, and the confidence is low, with the note"),
`discovery-fixround.test.ts`; `tests/integration/linking/v52-editions.local.test.ts`, `v52-slice.local.test.ts`; `tests/validation/v52-run.test.ts`, `v52-fixround.test.ts`.

**גרסה 3.** אין.

## 14. מעבר מהדורה (`relink.ts`)

**מה.** `planRelink` מקבל את מיפוי השורות בין מהדורה ישנה לחדשה (§15) ומחליט לכל קישור של הפרויקט: `certain` (כל הקצוות על שורה
זהה), `review` (שורה ערוכה, שורה שזזה, או טווח שתוכנו השתנה) או `lost` (השורה נמחקה, ולא מועבר לעולם). עוגן עובר רק לשורה זהה,
או כשמילותיו מופיעות פעם אחת בשורה הערוכה.

**איפה.** `src/linking/relink.ts` (`planRelink`); הממשק: `src/ui/dialogs/relink-dialog.tsx`.

**בדיקות.** `tests/unit/linking/relink.test.ts` ("an edited line goes to review; a deleted line is lost and never moved";
"an anchor on an edited line is re-found when its words occur exactly once"), `tests/unit/core/pipeline-fields.test.ts`; e2e: `relink.spec.ts`.

**גרסה 3.** אין.

## 15. מיפוי מהדורות (`edition-map.ts`, `matching/line-diff.ts`)

**מה.** `diffLines` מיישר שורות בין שתי מהדורות בשלושה מעברים: עוגנים של שורות ייחודיות (patience), LCS בכל פער, ושורות ערוכות לפי
דמיון מילים (רק `changed`, אף פעם `same`). `findMoves` מוצא שורה שזזה מילה במילה, ו־`wordDiff` משווה שורה ערוכה. `edition-map.ts`
הופך את היישור לשורות קריאות (`same`, `changed`, `moved`, `moved-in`, `deleted`, `inserted`) ולקובץ CSV של מיפוי השורות.

**איפה.** `src/matching/line-diff.ts` (`diffLines`, `findMoves`, `wordDiff`); `src/linking/edition-map.ts` (`editionRows`, `rowCounts`, `lineMappingCsv`);
הממשק: `src/ui/dialogs/edition-diff.tsx`.

**בדיקות.** `tests/unit/matching/line-diff.test.ts` ("property: the mapping is strictly increasing and never maps two old lines to one new line");
`tests/unit/linking/edition-map.test.ts` ("repeated or blank lines are never paired as moves (that would be a guess)").

**גרסה 3.** אין. מגבלה ידועה: פסקה שפוצלה או מוזגה נעשית "אבדה" (AUTOMATION_ENGINE §9, 2.11).

## 16. טווחים (`ranges.ts`, `state/ranges.ts`)

**מה.** הכללים הטהורים: `rangeMarkers` (הסמנים: תחילות קישורים בצד הזה וכותרות), `suggestEnd` (שורה לפני הסמן הבא, אחרת סוף הספר,
ונסוג משורת כותרת), `trimBefore` (קיצור טווח שבולע קישור חדש), `fillRanges` (השלמת טווחים לספר) ו־`applyRangeEdit`. `RangesState`
קורא את כותרות הספר פעם אחת, ומבצע כל פעולה כפקודה אחת שאפשר לבטל: "טווח עד הקישור הבא" בבונה, הקיצור בזמן יצירת קישור
(`store.trimAround`), ו"השלמה" בפאנל הקישורים. השלמה על ספר של ספריא בייצוא לשליחה נחסמת עם הסבר.

**חדש ב־V7, בלי מקבילה בגרסה 3:** "המשך לקטע הקודם" (#44, V7 §2.13). הכלל הטהור הוא `planContinuation` ו־`cancelContinuationEdit`
ב־`src/linking/ranges.ts`. הוא מוצא את הקטע הקודם: השורה האחרונה לפני השורה שנבחרה שקישור בצד הזה מכסה. כל קישור שמכסה אותה עובר בירושה.
הטווח שלו מורחב, אם הייצוא מקבל טווח לקישור הזה לפי `validateLink`. אחרת נוצר קישור נפרד עם אותו צד שני, סוג ושם. קישור שכבר מגיע לשורה
לא נוגעים בו, ולא נוצר קישור שכבר קיים (כלל "אותן שורות" של `equality.ts`, גם מול המסד). `RangesState.planContinue` מחזיר תצוגה מקדימה,
`applyContinue` מבצע פקודה אחת, וכותרת באמצע דורשת `crossHeading`. `cancelContinuation` מבטל את ההמשך בפקודה נפרדת. המקור נשמר ב־`Link.continued`,
בפרויקט בלבד. הממשק: `ContinuePrevious` ב־`builder.tsx`, והשורה "ביטול ההמשך" ב־`link-item.tsx`. בדיקות: `tests/unit/linking/continuation.test.ts`,
`tests/integration/state/continuation.test.ts`, `tests/e2e/continuation.spec.ts`.

**איפה.** `src/linking/ranges.ts`, `src/state/ranges.ts` (`RangesState`: `suggestEnd`, `trimFor`, `fill`), `src/state/store.ts` (`trimAround`),
`src/ui/workspace/builder.tsx` (`RangeButtons`), `src/ui/workspace/links-panel.tsx` (כפתור "השלמה").

**בדיקות.** `tests/unit/linking/ranges.test.ts`, `tests/integration/state/ranges.test.ts`; e2e: `pattern-and-ranges.spec.ts`.

**גרסה 3.** `Ranges` 3242–3365 (`markers`, `suggestEnd`, `trimPrevious`, `autoFillBook`, `revert`, `reapply`), `buildRanges` 6156,
`rangeRow` 5050, `effectiveEnd` 4901; F-054, F-055, F-064, F-079–F-085, F-105.

| התנהגות בגרסה 3 | מצב | ראיה / נימוק |
|---|---|---|
| F-080: `suggestEnd` = שורה לפני הסמן הבא, אחרת סוף הספר, לא לפני ההתחלה | נשמר | `ranges.test.ts`: "one line before the next marker; the last range runs to the end of the book"; "a next marker right after the start gives no range" |
| F-079: סמנים לפי `rangeEndBasis` (`auto`/`links`/`headings`/`book`) | **אבד חלקית.** הכלל קיים ונבדק בפונקציה, אבל אין הגדרה: המצב תמיד קורא עם `"auto"` | `ranges.test.ts`: "markers are the starts of this side's links plus the headings, sorted and unique" (בודק את ארבעת הערכים) |
| F-055: `rangeAutoEnd` — הצעה אוטומטית לסוף הטווח כשלא הוקלד | שונה: ההצעה רק בלחיצה על "טווח עד הקישור הבא" | לא נמצא נימוק כתוב. בדיקת מצב: `integration/state/ranges.test.ts`: "until the next link: stops one line before the next link, and before a heading". **לא נמצאה בדיקת e2e לכפתור** |
| F-054: כפתור "עד הסוף" | **אבד** (בבונה יש רק "טווח עד הקישור הבא" ו"בלי טווח") | — |
| F-064/F-083: קיצור הטווח הקודם ל־`newStart-1`, באותה פעולה | נשמר | `ranges.test.ts`: "only a range of this book and side that starts before the new line and reaches it is cut"; `integration/state/ranges.test.ts`: "a new link inside another link's range cuts that range — in the same undo step" |
| F-064: המתג `rangeTrimPrevious` (אפשר לכבות) | **אבד.** הקיצור תמיד פועל, עם הודעה | לא נמצא נימוק כתוב |
| F-083: הקיצור יכול לנחות על כותרת | שונה במכוון: נסוג מהכותרת | ביקורת C11, הערת `trimBefore`. `ranges.test.ts`: "a cut never ends on a heading: it steps back from it (review C11)" |
| F-083: קישורי מסד נקצרים כמו כל קישור | שונה במכוון: קישור מסד לא נוגעים בו | AGENTS.md §3 (קישורי מסד לא נערכים). `ranges.test.ts`: "database links are never changed" |
| F-083 / TD-H8: ביטול לא מחזיר את הסטטוס (`EDITED`→`EXISTING`) | תוקן במבנה: `Change` שומר את הקישור כולו לפני ואחרי | `tests/unit/linking/v3-kept.test.ts`: "TD-H8 (F-083): undoing a range cut gives back the record exactly as it was, 'existing' again" (נוספה בסבב הזה) |
| F-084: `autoFillBook` — עד ההתחלה הבאה פחות 1; `onlyRanged` ברירת מחדל | נשמר | `ranges.test.ts`: "only ranged links by default: each runs to one line before the next start, the last to the end"; "onlyRanged false turns single-line links into ranges too" |
| F-084: נסוג משורת כותרת | נשמר | `ranges.test.ts`: "an end on a heading steps back; no change is reported when nothing changes" |
| F-084: ספר־צל לא נוגעים בו (`skippedNoText`) | נשמר | `ranges.test.ts`: "a book with no known length (a shadow book from a links file) is never touched" |
| F-084: הסמנים הם תחילות קישורים בלבד, ולכן טווח חוצה כותרות פרק | שונה במכוון: נעצר לפני הכותרת הבאה | הערת `fillRanges` ("v3 used only link starts, so a range ran across chapter headings"), ביקורת C15. `ranges.test.ts`: "a range stops before the next heading, as suggestEnd does — it never crosses a chapter (review C15)" |
| F-084: טווח שבולע את תחילת הקישור הבא נשאר | שונה במכוון: הטווח מוסר | ביקורת C15. `ranges.test.ts`: "a range that swallows the next link's start is removed, not left overlapping (review C15)" |
| F-085 / F-105: `revert`/`reapply`; ההשלמה מוחלת לתצוגה מקדימה, ואישור או סגירה מחליטים | שונה במכוון: פקודה אחת בהיסטוריה עם "ביטול" בהודעה | AGENTS.md §2.5 (כל שינוי בקישורים הוא פקודה אחת דרך `commit`). `integration/state/ranges.test.ts`: "range completion of a book: one step, undoable, and a second run changes nothing" |
| F-105: בחירת צד ו"רק טווחיים" | נשמר | `ranges.test.ts`: "works on the target side the same way"; e2e `pattern-and-ranges.spec.ts` |
| (חדש) השלמה על ספר של ספריא בייצוא לשליחה | נוסף | `integration/state/ranges.test.ts`: "a submission: no ranges are made on the Sefaria side, and the notice says why; for private use they are" |

## 17. כיסוי (`coverage.ts`, `state/coverage.ts`)

**מה.** לכל שורה בספר קטגוריה אחת: `not-suitable`, `unlinked`, `linked`, `multiple`, `partial`, ובנוסף `candidate` (הצעה ממתינה) ו־`doubtful`
(קישור שהבדיקה סימנה). קישורי המסד הם מצב נפרד (`counted` / `none` / `unknown` / `failed`), כך שכשל קריאה אינו "אין קישורים".
`unlinkedRanges` נותן רצפים של שורות בלי קישור. `CoverageState` מחשב לספר, שומר בפרויקט, ונותן טבלה לכל המסד בעצלות ועם ביטול.

**איפה.** `src/linking/coverage.ts` (`coverageOfLines`, `unlinkedRanges`, `coverageSummary`, `coverageCounts`, `candidateLines`, `doubtfulLines`, `linksReadingText`);
`src/state/coverage.ts` (`CoverageState`).

**בדיקות.** `tests/unit/linking/coverage.test.ts` ("a range covers the lines after its start: its own line is linked, the rest are partial"),
`coverage-fixround.test.ts`; `tests/unit/ui/coverage-compute.test.ts`; `tests/integration/state/coverage.test.ts`
("is lazy and cancellable: the next book is read only when asked for, and a cancel stops at the next one"), `coverage-links-reading.test.ts`, `repository-races.test.ts`.

**גרסה 3.** אין מנוע כזה. הקרוב: F-042 (ספירת השורות עם קישור בשורת התחתית של פאנל). זה נשמר במהות ומורחב.

## 18. פערים שנמצאו

כל מה ש"אבד" או שלא נמצאה לו הוכחה, עם בדיקה מוצעת. מה שמסומן "החלטה" דורש קודם הכרעה של הבעלים אם להחזיר את ההתנהגות
או לתעד שהיא בוטלה.

| # | פער | סוג | בדיקה מוצעת |
|---|---|---|---|
| 1 | F-097 "פסקאות כסעיפים": פירוש עם N פסקאות לא ממוספרות תחת כותרת, ובבסיס N ילדים | **אבד** (החלטה) | `tests/unit/linking/headings/engine.test.ts`: "סימן א" בפירוש עם 3 פסקאות מול "סימן א" עם 3 סעיפים בבסיס. היום: שלוש הצעות לטווח הסימן. אם מחזירים: פיצול אחד לאחד, לכל היותר "אפשרית" |
| 2 | F-098 "ביעד אין מקבילה במקור" כאבחון של ריצת הכותרות | **אבד** | באותו קובץ: בסיס עם 3 פרקים ופירוש על 2. לצפות להערת ריצה שמונה את הפרק שאין לו קישור |
| 3 | F-096: התאמת שם בדמיון (`heading/similar-name`) | לא נמצאה בדיקה | `engine.test.ts`: "הלכות שבת" בפירוש מול "הל' שבת" בבסיס ← הצעה עם `heading/similar-name`, ושמות שונים (מתחת ל־0.85) ← `unmatched` |
| 4 | F-096: מתג "התאמה גמישה לכתיב" וסף שהמשתמש קובע | אבד חלקית (החלטה) | אם מחזירים: `option-specs.test.ts`, אפשרות שמגיעה ל־`align`. אם לא: שורה ב־AUTOMATION_ENGINE §2 |
| 5 | בדיקות עצמיות "התאמה מבנית" של גרסה 3 ("בלי גמישות רק כותרת זהה", "עם גמישות גם הקיצור") | לא הועברו | ייפתרו עם 3–4 |
| 6 | F-104: טווח "עד ההתאמה הנבחרת הבאה" ובחירת מבנה הקישור לריצה | שונה בלי נימוק כתוב | תיעוד הנימוק ב־AUTOMATION_ENGINE §1.3. הזרימה "אישור ← השלמה" כבר נבדקת ב־`pattern-and-ranges.spec.ts` |
| 7 | F-099: סוג ברירת המחדל במצב תגית (`linker` בגרסה 3, `reference` עכשיו) | שונה בלי נימוק כתוב | `pattern/engine.test.ts`: מצב `tag` בלי `declaredType` ← הסוג שהוחלט, עם הנימוק בהערה |
| 8 | F-102: "יעדים בלי הפניה" במנוע התבנית | **אבד** (קיים במנוע ההערות) | `pattern/engine.test.ts`: יעד `line` עם שורות שאף הפניה לא מגיעה אליהן ← הערת ריצה עם מספרן |
| 9 | F-102: `pattern/shared-targets` (יעדים כפולים) | לא נמצאה בדיקה | `pattern/engine.test.ts`: שתי הפניות לאותה שורה ← ההערה `pattern/shared-targets` עם "1 שורות" |
| 10 | F-079: הגדרת `rangeEndBasis` | אבד חלקית (החלטה) | אם מחזירים: `integration/state/ranges.test.ts` עם `basis: "links"` ← הטווח חוצה כותרת. הפונקציה כבר נבדקת |
| 11 | F-064: מתג `rangeTrimPrevious` | **אבד** (החלטה) | אם מחזירים: `integration/state/ranges.test.ts`, יצירת קישור בתוך טווח כשהמתג כבוי ← הטווח לא קוצר |
| 12 | F-054: כפתור "עד הסוף" בבונה | **אבד** | `tests/e2e/manual-linking.spec.ts`: בחירת שורה, "עד הסוף" ← `end` = השורה האחרונה בספר |
| 13 | F-055: `rangeAutoEnd` (הצעת סוף בלי לחיצה) | שונה בלי נימוק כתוב; לכפתור "טווח עד הקישור הבא" אין e2e | e2e: בחירת שורה, לחיצה על "טווח עד הקישור הבא" ← הבחירה מגיעה לשורה לפני הקישור הבא |
| 14 | TD-H8: ביטול קיצור או השלמה מחזיר `existing` | **נסגר**: נשמר, `v3-kept.test.ts` | — |
| 15 | F-103: `confidenceOf` (הספים, `ambiguityMargin`) | **נסגר**: נשמר, `v3-kept.test.ts` | — |
| 16 | TD-M1 (ריבועיות) במנועי הזוג | בדיקת הריבועיות מכסה רק תכנון ומראי מקומות | `quadratic.test.ts`: הכותרות והתבנית על ספר של 50,000 שורות, בזמן חסום |

## 19. מה לא נבדק במסמך הזה

- הבדיקות לא הורצו לצורך המסמך. "נשמר" אומר שקיימת בדיקה בשם הזה שבודקת את ההתנהגות, לפי קריאת הקוד שלה או שמה.
- בדיקות `*.local.test.ts` רצות רק עם מסד אמיתי (`OTZARIA_DB`), ולא נבחנו כאן.
- פריטי ממשק של דיאלוג "קישור אוטומטי" בגרסה 3 (300 שורות עם תיבות סימון, מעבר לשונית שמבטל תצוגה מקדימה) לא מופו: הם חלק
  מהממשק ולא מהמנועים.

</div>
