# V7 — מטריצת משימות

<div dir="rtl">

מקור הדרישות: מסמך המשימה של V7 (סעיפים §0–§12), Issues ‏#9–#47, וממצאי הסקירה העצמאית ב־#40 (A), ‏#41 (B) ו־#42 (C).
בסיס העבודה: `main` ‏`9123d3f`, שעליו מוזגו PRs ‏#5, #28, #29 ו־#30. העבודה התחילה ב־26.11.2026.

המטריצה מתעדכנת לאורך העבודה, כדי שאפשר יהיה להמשיך בדיוק מהמקום שבו נעצרה. "ראיה" היא שם קובץ בדיקה, ושורת התוצאה לפני
התיקון ואחריו, כמו שהן מופיעות בגוף ה־commit.

**סטטוסים:** `TODO` · `IN_PROGRESS` · `FIXED` (תוקן, ויש בדיקה שנכשלה לפני ועוברת אחרי) · `VERIFIED` (נבדק גם בהרצה
אמיתית: E2E, מסד אמיתי או אוצריא) · `PARTIAL` · `BLOCKED` · `DEFERRED` · `ALREADY_IMPLEMENTED`

## 0. Baseline (לפני השינויים, `9123d3f`)

| בדיקה | תוצאה | זמן |
|---|---|---|
| `npm ci` | עבר | 34 שניות |
| `npm run typecheck` | עבר | 15 שניות |
| `npm test` | `Tests 1 failed \| 2590 passed \| 75 skipped (2666)`. הכשל: בדיקת זמן ב־`personal-csv.test.ts` (5192ms מול סף 2500ms) בזמן עומס. כשהיא רצה לבדה: `3 passed` | 33 שניות |
| `npm run build` | עבר. `OtzariaLinker.html` שוקל 1,963,455 בתים, ‏sha256 `083d6c36…3a80` | 2 שניות |
| `npx playwright test` (Chrome, Edge, Firefox) | `9 failed \| 2 skipped \| 324 passed`. שמונה מהכשלים ב־Firefox, ורובם timeouts ושגיאות סגירת הקשר בזמן עומס כבד (שלושה סוכנים עבדו במקביל) | 9.6 דקות |
| `test:visual` | `79 passed` | 47 שניות |

סביבה: Windows 11, ‏Node 24.19.0, ‏npm 11.17.0, ‏Playwright 1.65.0, ‏Git 2.52. בכונן Z פנויים 1.8TB, ובכונן C פנויים 44GB. זיכרון: 32GB, מהם כ־9GB פנויים.
אוצריא מותקנת ב־`C:\Program Files\otzaria`. המסד הרשמי: `C:\ProgramData\otzaria\books\seforim.db` (4.77GB, קריאה בלבד).
**מסד v52:** לא נמצא בהתחלה. הבעלים מסר אותו במהלך העבודה (`C:UsersUserDocumentsDEVotzarya-unofficial-books-52.db`, ‏1.74GB), והוא נקרא לקריאה בלבד.
**`gh` אינו מחובר** (ה־token פג), לכן פתיחת PRs דרכו חסומה. ‏`git push` עובד דרך Credential Manager, וקריאת Issues נעשית דרך ה־API הציבורי.

## 1. ממצאי #40 (A)

| מזהה | נושא | PR | סטטוס | ראיה / הערה |
|---|---|---|---|---|
| A1 | מסנן השורות לא חל על כל השיטות | 2 | FIXED | `LineGate` הוא שכבה של ההרצה כולה: זוג, אצווה, קישור מרבי, זרימה מודרכת ומראי מקומות, עם שומר על התוצאה. ‏`line-filter-run.test.ts`: לפני `[2,3,4,5,6,8,9]` במקום `[2,5,8]`, אחרי `6 passed`. property על ארבעה מנועים. המסנן נכלל בטביעת האצבע של העבודה |
| A2 | שם הספר בכותרת הקורא | 3 | FIXED | `tests/e2e/reader-title.spec.ts`: לפני, ב־Chrome: 10.4px ב־1280, ‏37.9px ב־1440, ‏3.1px ב־1024. אחרי: `18 passed` (‏6 רוחבים × 3 דפדפנים), ו־`9 passed` ב־360–1920. ה־visual לא השתנה |

## 2. ממצאי #41 (B)

| מזהה | נושא | PR | סטטוס | ראיה / הערה |
|---|---|---|---|---|
| B1 | האיחוד מעלה דיבור המתחיל חלש ל"גבוהה" | 2 | FIXED | `merge-evidence.test.ts`: לפני `7 failed | 1 passed (8)`, אחרי `8 passed`. הכלה מעלה רק על ראיה בלתי תלויה (חיפוש בכל הבסיס, טווח עד 20 שורות), הטווח נשאר חלופה, `MergedSuggestion.evidence`. ‏V7_MATCHING_BENCHMARK §2: "גבוהה" במבחן 95.3% ← 96.2%, ביורה דעה 98.0% ← 98.9%. 924/846 של הממצא לא שוחזר (410/3 במשנה ברורה) |
| B2 | מילה אחת בלי כותרות ב"גבוהה" | 2 | FIXED | `evidence-caps.test.ts`: לפני `3 failed | 2 passed (5)`, אחרי `5 passed`. בחיפוש בכל הבסיס: מילה אחת "אפשרית", שתיים "גבוהה" לכל היותר. המחיר במחצית הבדיקה: 672 נשפטות ב־99.1% ירדו ל"אפשרית" (V7_MATCHING_BENCHMARK §3) |
| B3 | סימן בתוך `<b>` מפיל את השורה | 2 | FIXED | `blankMarker` שומר על התגיות ועל האופסטים. ‏`source-filter-markers.test.ts`: לפני `4 failed \| 1 passed`, אחרי `5 passed` (עם property של אופסטים) |
| B4 | אצווה בוחרת בשקט ספר רשמי | 2 | FIXED | כלל אחד לכל המסלולים (`resolveBaseKey`, ‏`capUndecided`). לפני `6 failed \| 9 passed`, אחרי `15 passed`. מול v52 והרשמי: ‏36 כותרות משותפות, ומקרה אחד מסומן עכשיו כעמום |
| B5 | אין בחירת סוג קשר בדיבור המתחיל | 3 | TODO | |
| B6 | שער מראי מקומות ל"ברכות יג:" | 2 | FIXED | לפני `8 failed \| 9 passed`, אחרי `17 passed` |
| B7 | ציטוט עם ד"ה בלי שם מפרש | 2 | FIXED | קישור לדף, לכל היותר "אפשרית" |
| B8 | מספר ערבי אחרי שם ספר שהוא גם מילה | 2 | FIXED | `quantityLike` מגביל ל"אפשרית". על המדגמים: 0 מקרים לפני ואחרי |
| B9 | עוגן במראי מקומות לספר אישי | 2 | FIXED | בסוג `inline-linker` גם ספר אישי מקבל עוגן. ‏v52, ‏8 ספרים: 1,982 הצעות, כולן עם עוגן |
| B10 | CR בודד בספר טקסט | 1 | FIXED | `tests/unit/sources/text-source.test.ts`: לפני `1 failed \| 10 passed`, אחרי `11 passed`. הפיצול נשאר כמו בגנרטור, ונוספה אזהרה `source/lone-cr` |
| B11 | ביטול מראי מקומות שקט, ו־0/0 | 3 | TODO | |
| B12 | הערות "1 טקסט" | 2 | FIXED | `bareSeries`. בדיקות יחידה: לפני `31 failed \| 108 passed`, אחרי `143 passed`. ‏v52, אנציקלופדיה תלמודית: אות ו' עלתה מ־0 ל־2,763 הצעות (זהות לריצה הידנית), ובכל 22 האותיות מ־504 ל־362,308. מגבלה: באותיות א' ומ' ספר ההערות גדול מדי ליישור הגלובלי |
| B13 | ניתוב שו"ע למפרש | 2 | FIXED | `בש"ך ס"ק ג` מנותב לשורה `(ג)` של המפרש, ונוספה היררכיית יעדים (`TargetHierarchy`). לפני `9 failed \| 32 passed`, אחרי `41 passed`. לא נמדד על שו"ע אמיתי |
| B14 | כיסוי לא סופר הצעות ממתינות | 3 | FIXED | `tests/unit/ui/coverage-summary.test.ts`: על הלוגיקה הישנה `2 failed \| 2 passed`, אחרי `4 passed` |
| B15 | ZIP bomb מנפח זיכרון | 1 | FIXED | `safe-unzip*.test.ts`: לפני `10 failed \| 19 passed` (פצצה של 128MiB עברה כולה בחתיכה אחת), אחרי `29 passed`. החתיכות של 16KiB, ונוספו נתיבים כפולים או חריגים וביטול. מגבלה: אחרי שהחילוץ התחיל הוא סינכרוני, ולכן ביטול נבדק רק בין חתיכות |
| B16 | ReDoS בכמתים צרים | 1 | FIXED | `regex-cost.ts`: חסם עלות של backtracking (`MAX_BACKTRACKING_COST`). ‏`safe-regex.test.ts`: לפני `3 failed \| 6 passed`, אחרי `9 passed`. ‏`regex-cost.test.ts`: `12 passed`, וכל ביטוי שמתקבל רץ בפחות מ־2 שניות על 20,000 תווים |
| B17 | מפתח Autosave אחד לכל החלונות | 1 | VERIFIED | `autosave-windows.test.ts`: לפני `5 failed \| 2 passed`, אחרי `7 passed`. ‏E2E אמיתי עם שני טאבים, ‏`tests/e2e/autosave-tabs.spec.ts`: על ה־build הישן `Expected [4,5] Received []`, ועכשיו `15 passed` (repeat-each=5, שלושה דפדפנים) |
| B18 | ספר אישי נקשר לספר רשמי באותו שם | 1 | FIXED | `book-identity.test.ts`: לפני `5 failed \| 2 passed`, אחרי `7 passed`. ארבעה סדרי פתיחה, ושמירה ופתיחה חוזרת |
| B19 | מילון zstd מושאל לפי dictID | 1 | VERIFIED | `zstd.test.ts`: לפני `7 failed \| 12 passed`, אחרי `19 passed`. ‏`dictionary-identity-real-db.local.test.ts` מול `seforim.db`: `1 passed`. טביעת האצבע הרשמית: `7b08b7c3…a396`. מול v52: `dictionary-collision-real-db.local.test.ts` עבר בשני סדרי הפתיחה |
| B20 | `user_link` נקרא בשקט כאפס | 1 | FIXED | `user-links.test.ts`: לפני `8 failed`, אחרי `8 passed`. ‏`user-links-state.test.ts`: לפני `2 failed \| 1 passed`, אחרי `3 passed`. הסכמה לפי אוצריא `a6be90800`, ומתועדת ב־LINK_SCHEMA_MATRIX §6.1. המגבלות ב־QA_V7_PR1 |
| B21 | פתיחת פרויקט מעל עבודה שלא נשמרה | 1 | FIXED | `autosave-windows.test.ts` (B21): העבודה נשמרת בתור השחזור, ויש הודעה עם פעולת שחזור. הכרעה: אין דיאלוג חוסם (משתמש שגרר פרויקט התכוון לפתוח אותו), אלא שמירה בצד ושחזור |
| B22 | לחיצה שנייה על "אישור" דוחה | 3 | TODO | |
| B23 | טבלת הצעות צרה | 3 | TODO | |
| B24 | הודעות כשל בפתיחה | 3 | TODO | |
| B25 | ניתוח מאגר "0 מתוך" | 3 | TODO | |
| B26 | כפתור כיסוי מוביל ללשונית בדיקה | 3 | TODO | |
| B27 | ריבוי והטיות בעברית | 3 | FIXED | `hebrew-counts.test.ts`: לפני `2 failed \| 1 passed`, אחרי עובר. ה־visual לא השתנה |
| B28 | עזרה אופליין מפנה למסמכים חסרים | 3 | TODO | |

## 3. ממצאי #42 (C)

| מזהה | נושא | PR | סטטוס | ראיה / הערה |
|---|---|---|---|---|
| C1 | קצה טווח לא חסום | 1 | FIXED | `maxlink-job.test.ts` ו־`db-link-ranges.test.ts`: לפני `2 failed \| 22 passed`, אחרי `27 passed` |
| C2 | עץ B עוין | 1 | FIXED | `hostile.test.ts`: לפני `4 failed \| 4 passed` (DAG של 39 עמודים החזיר 2,323,698 שורות ב־7.8 שניות), אחרי `68 passed` |
| C3 | מילון נשאר בבריכה אחרי כשל | 1 | FIXED | `db-qa-round2.test.ts`: לפני `2 failed`, אחרי `13 passed`. ובמיזוג: גם התנגשות מזהים בבנאי השאירה מילון במאגר. ב־`zstd.test.ts`: לפני `1 failed`, אחרי עובר |
| C4 | `fallbackListings` בלי תקרה | 1 | FIXED | `fallback-listings.test.ts`: לפני `2 failed \| 1 passed`, אחרי `14 passed` |
| C5 | חסימת ממשק בייבוא ושמירה | 4 | TODO | |
| C6 | תקציב גודל | 4 | TODO | |
| C7 | כיסוי 200 ספרים בחוט הראשי | 4 | TODO | |
| C8 | `existingLinks` גדול | 4 | TODO | |
| C9 | ביטוי חוזר בבסיס | 2 | FIXED | עם B2 (`repeatsOf`, `dh/repeated-phrase`, `dh/alt-repeat`): "ודאית" של ביטוי חוזר 115 ← 29 |
| C10 | שער זוגות לדיבור המתחיל | 2 | FIXED | `pair-fit.test.ts`: לפני `4 failed (4)`, אחרי `4 passed`. `linking/pair-fit.ts`, ב־`maxlinkJob`; `StepResult.pairFit`, `MaxLinkJobOptions.forcedPairs`. 16 זוגות לא קשורים: 908 ← 0 "ודאית"/"גבוהה"; 37 זוגות אמיתיים `suitable`. הממשק: לא |
| C11 | ניקוד וכיווניות בסימן | 2 | FIXED | `source-filter-bidi.test.ts`: לפני `10 failed \| 1 passed`, אחרי `11 passed` |
| C12 | `sharesTitle` מדויק בלבד | 2 | FIXED | `editionKey` משמש רק לזיהוי עמימות. לפני `3 failed \| 16 passed`, אחרי `19 passed` |
| C13 | פרק מיותר בספר הערות | 2 | FIXED | לפני `2 failed \| 140 passed`, אחרי `142 passed` |
| C14 | "נקראו הקישורים מהמסד: אין" לספר טקסט | 3 | FIXED | `coverage-links-reading.test.ts`: לפני `1 failed \| 6 passed`. נוסף מצב קריאה `no-database` |
| C15 | "גבוהה" בטווח רחב בכותרות | 2 | FIXED | `range-width.test.ts`: לפני `2 failed (2)`, אחרי `2 passed`; `title-fit.test.ts`: `2 failed | 11 passed (13)` ← `13 passed`. `RANGE_WIDTH`: מעל 5 "גבוהה", מעל 20 "אפשרית" |
| C16 | תצוגה מקדימה למסנן רק ב"זוג" | 3 | TODO | |
| C17 | טווח יעד בציטוט | 2 | FIXED | נשמר ב־`INLINE_LINKER`, ובייצוא פרטי. ‏1,490 טווחים ב־v52 |
| C18 | הצעות לשורת כותרת | 2 | FIXED | `contentStart`. ב־heldout2 ירד מ־178 ל־133 |
| C19 | עוגן לא עקבי | 2 | FIXED | שם המפרש נכלל, והסוגריים מאוזנים. רגרסיה שה־benchmark מצא (הפניה שנייה בתוך אותם סוגריים) תוקנה |
| C20 | חלק שגוי (חו"מ במקום יו"ד) | 2 | FIXED | `partContext` מתוך השורה, ההקשר או הכותרת |
| C21 | החמצות בזיהוי מראי מקומות | 2 | PARTIAL | `<sup>`, ‏`׃`, טווח דפים, `שמ"א ג ד` ומספר חשוף. לא טופלו: "שבת לא-לב" בלי עמוד, ו"ושם ע"ב ד"ה" |
| C22 | אזהרה מטעה על `INLINE_LINKER` | 1 | FIXED | `links-json.test.ts`: לפני `1 failed \| 19 passed`. נוסף הקוד `record/inline-linker`. התמיכה נמדדה שוב: הגרסה האחרונה היא עדיין 0.9.98.3+809 |
| C23 | CSV אישי ושדה רב־שורתי | 1 | FIXED | `personal-csv.test.ts`: כלל חדש `csv/line-break`. ה־CSV של ספריא לא שונה, כי הוא חוזה בתים עם גרסה 3 (`csv-injection.test.ts`). אחרי: `348 passed` |
| C24 | `saveExport` חוזר בשקט | 1 | FIXED | `alt-toc-export.test.ts`: לפני `1 failed` |
| C25 | CSV ספריא ונוסחאות | 1 | ALREADY_IMPLEMENTED | בכוונה: חוזה בתים עם גרסה 3, ונבדק ב־`csv-injection.test.ts` |
| C26 | ARIA במפרידים | 3 | FIXED | `tests/e2e/splitter-aria.spec.ts`: לפני `Expected "0" Received ""`, אחרי, יחד עם accessibility ו־layout: `30 passed` ב־3 דפדפנים |
| C27 | מטרות מגע | 3 | FIXED | `tests/e2e/touch-targets.spec.ts` (‏360×740, מגע): לפני, 22 פקדים קטנים מ־43.5px. אחרי: `2 passed` (‏Chrome, ‏Edge). ‏Firefox לא תומך באמולציית מגע |
| C28 | שם קובץ פרויקט בלי תאריך | 3 | TODO | |
| C29 | מקרי קצה בפתיחת מקורות | 1 | PARTIAL | עותק זהה בשם אחר, וקובץ ריק: תוקנו (`open-twice.test.ts`: לפני `2 failed \| 8 passed`, אחרי `10 passed`; ‏`registry.test.ts`: לפני `1 failed`, אחרי עובר). נשארו: הקובץ "B" בדיאלוג ההשוואה, ו־Esc באשף המיפוי (PR3) |
| C30 | IndexedDB: הבטחה דחויה במטמון, `onblocked` | 1 | FIXED | `tests/unit/app/idb-store.test.ts`: לפני `3 failed`, אחרי `3 passed` |
| C31 | פעולות שקטות | 3 | TODO | |
| C32 | גרסה alpha בהגדרות | 4 | TODO | |

## 4. Issues ודרישות נוספות

| מקור | נושא | PR | סטטוס | הערה |
|---|---|---|---|---|
| §1.1 | זהות ספר יציבה | 1 | PARTIAL | origin ותווית מקור (B18). טביעת אצבע של מהדורה: לא |
| §1.2 | שמירה, Dirty State, ריבוי טאבים | 1 | FIXED | B17, B21, C30. נוסף `store.autosave` עם הסטטוסים idle/pending/saved/failed, והודעה אחת על כשל. החיווי בממשק: PR3 |
| §1.6 | כפילות מקורות | 1 | FIXED | C29 |
| §1.7 | השוואה ומיזוג (#15) | 1 | FIXED | שקילות סמנטית, ‏ref מול תצוגה, סתירה (כפילות שנכנסה למיזוג), ורשומה שלא נקראה. round-trip כ־property עם 200 ריצות. הפירוט ב־QA_V7_PR1 |
| §1.9 | תוצאת ייצוא לכל קישור | 1 | FIXED | `exportOutcomes` (נכתב, לא שונה, מוזג, נחסם, צריך תיקון, לא נתמך): property עם 400 ריצות. נוספו ספירה לפני ואחרי לקובץ שמוחלף, ייצוא כפול שנותן בתים זהים, ותיקון של ספירה כפולה ב־CSV של ספריא |
| #43 | סקריפט ארצות החיים | 2 | TODO | |
| #44 | ירושת קישור לקטע המשך | 2 | FIXED | §2.13. "המשך לקטע הקודם" בבונה: תצוגה מקדימה, ואז פקודה אחת (`store.ranges.planContinue`/`applyContinue`, הכלל ב־`linking/ranges.ts` `planContinuation`). הרחבת הטווח רק כשהייצוא מקבל אותו (`validateLink`), אחרת קישור נפרד; בלי כפילויות; כותרת באמצע דורשת אישור; "ביטול ההמשך" בשורת הקישור; המקור נשמר בפרויקט (`continued`) ואינו נכתב לקובץ. `continuation.test.ts` (unit + integration): לפני `Tests 22 failed (22)`, אחרי `22 passed`. E2E: `continuation.spec.ts` ‏`1 passed` (Chrome) |
| #45 | העדפת ספר ראשי | 2 | TODO | |
| #46 | מאגרי GitHub | 4 | TODO | |
| #47 | AI | 4 | TODO | אופציונלי |

## 5. הכרעות

- **B21, בלי דיאלוג חוסם:** פתיחת פרויקט היא פעולה מפורשת של המשתמש. לכן במקום לחסום אותה, העבודה הקודמת נשמרת בתור
  השחזור, שנשמר ב־IndexedDB, ומופיעה הודעה עם "החזרת העבודה הקודמת". כך אין אובדן נתונים, גם אחרי רענון, וגם בלי שינוי בממשק.
- **B17, Web Locks:** כדי לדעת שחלון נסגר משתמשים ב־lock שהדפדפן משחרר בעצמו. בלי Web Locks (`live()` מחזיר null),
  מפתחות של חלונות אחרים לא נוגעים, כי אין דרך לדעת שהם נסגרו. רק המפתח הישן, היחיד, עובר לתור.
- **B10, CR בודד:** הפיצול נשאר כמו בגנרטור של הספרייה, ונוספה אזהרה. שינוי הפיצול היה מזיז את השורות בספרייה.
- **C23:** ה־CSV של ספריא נשאר חוזה בתים עם גרסה 3. רק ה־CSV האישי, שאוצריא קוראת שורה אחר שורה, חוסם מעבר שורה בשדה.

</div>
