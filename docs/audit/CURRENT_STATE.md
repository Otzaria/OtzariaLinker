<div dir="rtl">

# מצב קיים — ארכיטקטורה כפי שהיא ממומשת בפועל

מספרי השורות מתייחסים ל־`index.html` בתג `baseline-pre-2.0` (`18872b9`). פריסת השורות זהה ב־`legacy/OtzariaLinker-v3.html`.
הממצאים על המסד האמיתי נבדקו ב־2026-11-11 מול `C:\ProgramData\otzaria\books\seforim.db`
(4,492,886,016 בתים, `schema_meta.db_schema_version=7`, `db_version=37`). הבדיקה נעשתה בקריאה בלבד: `immutable=1` ו־`fs.readSync`.

---

## 1. מפת הקובץ

| טווח שורות | מה יש שם |
|---|---|
| 1–944 | `<head>`: meta, favicon כ־data-URI, הערת כללי הברזל, ו־CSS מ־A1 עד A16 (טוקנים 41–139, צפיפות 136–138, ערכה כהה 109, רספונסיביות 853–943) |
| 945–1018 | `<body>`, ואחריו sprite אייקונים (B) 952–1015, **60 `<symbol>`** |
| 1020–1055 | C1 סרגל עליון |
| 1057–1172 | C2 מסך המקורות: 4 כרטיסים ו־5 `input[type=file]` |
| 1174–1266 | C3 מסך העורך: 4 עמודות (`#paneBooks`, `#paneSource`, `#paneMid`, `#paneTarget`) |
| 1268–1271 | C4 מסך העזרה (ריק; מוזרק) |
| 1273–1294 | C5 שכבות: `#dialogHost`, מגירת יומן, `#busyOverlay`, `#toasts` |
| 1300–1487 | D1 sql.js glue (Emscripten) |
| 1488–1491 | D2 `window.__SQL_WASM_B64__` (שורה **1490**, 879,667 תווים) |
| 1492–1506 | D3 JSZip (שורה **1505**, 97,246 תווים) |
| 1507–1809 | D4 `LazySqlite` (בתוך הקובץ, נכתב לכלי) |
| 1810–1842 | E: כותרת קוד האפליקציה |
| 1843–1971 | §1 `Config` |
| 1973–2388 | §2 `Util` (כולל `Util.Heb` 2203–2348) |
| 2390–2800 | §3 `Data` |
| 2801–4032 | §4 `Domain` |
| 4033–4426 | §5 `Kit` |
| 4428–5383 | §6 `UI` |
| 5384–6655 | §7 `Dialogs` |
| 6656–6973 | §8 `HELP_HTML` (מחרוזת template אחת) |
| 6974–7332 | §9 `Boot` |
| 7334–7785 | §10 `window.runSelfTests` ו־`_runSelfTests` |
| 7787–7791 | §11 `Boot.init()`, ו־`?selftest` |

היקף: כ־2,550 שורות CSS ו־HTML, כ־5,950 שורות JS של האפליקציה, ו־1,465,835 בתים, מהם כ־977KB בשתי השורות הענקיות.

## 2. המודולים וה־API הציבורי

כל מודול הוא IIFE שמחזיר אובייקט (`const X = (() => {...})()`). הסדר בקובץ הוא סדר ההערכה,
ולכן **סדר ההגדרה הוא מנגנון התלויות**. מודול שנוגע במודול שאחריו עושה זאת רק בתוך גוף פונקציה, בזמן ריצה.

### `Config` (1846–1971): בלי תלויות
`COMMENTATOR_TYPES`, `REFERENCE_TYPES`, `DEPENDENT_RAW`, `CONNECTION_TYPE_KEY`, `LINK_KINDS`, `KIND_BY_ID`,
`DEFAULTS`, `load()`, `get(k)`, `set(k,v)` (כל `set` כותב מיד ל־`localStorage`), `all()`, `reset()`.
מצב פנימי: `settings`.

### `Util` (1976–2388): בלי תלויות (משתמש ב־`document`)
- יומן: `log.{debug,info,warn,error,onLine,buffer,clear,dump}`. מאגר של 5000, וכל הודעה נכתבת גם לקונסול.
- DOM: `$`, `$$`, `h(tag, props, kids)` (`props.html` הוא `innerHTML`), `icon()` (מחרוזת), `iconEl()`, `esc()`.
- קבצים: `readText` (UTF-8), `readArrayBuffer`, `splitLines`, `fileStem`, `download(name, content|Blob, mime)`, `formatBytes`.
- טקסט: `headingLevel`, `isHeading`, `stripTags` (מפענח רק `nbsp`, `quot`, `#39`, `lt`, `gt`, `amp`, ועושה `trim`), `rawOffsetFromVisible`, `countVisibleChars`.
- גימטריה: `toGematria`, `fromGematria`, `parseNumberToken`.
- `Heb`: `stripNikud`, `normalize`, `stem`, `skeleton`, `levenshtein`, `wordSimilarity`, `phraseSimilarity`. שלוש מפות memo עם עד 50k ערכים כל אחת.
- שונות: `anchorLabelFromHeRef`, `withAnchorLabel`, `yieldUI`, `debounce`, `uid`, `rangeLabel`, `clamp`, `plural`.

### `Data` (2397–2800): תלוי ב־`Util`, ובזמן ריצה בגלובלים `initSqlJs`, `LazySqlite`, `JSZip`
ציבורי: `mkBook(o)`, `FileBookRepository.{fromFiles,fromFolder}`, `openSqlite(file, sourceKind, thresholdMb, onProgress) → {repo, books, mode}`,
`JsonLinksRepository.parseFiles(files) → [{sourceTitle, fileName, records}]`, `ExportWriter.buildZip(linksByBook, altTocByBook, report, indent) → Blob`.
פרטי: `diagnoseWrongDb`, `DbBookRepository(db, kind)`, `getSQL()`, `LazyDbBookRepository(lazy, kind)`.
לשני ה־repos יש אותו ממשק בקירוב: `listBooks`, `loadLines(id)`, `loadLinksForBook(id, cap)`.
ההבדל: ב־sql.js הם **סינכרוניים**, וב־`LazySqlite` הם **א־סינכרוניים**.

### `Domain` (2804–4032): תלוי ב־`Util`, `Config` ו־`Data.mkBook`
ציבורי: `state`, `reset`, `withScratchState`, `addBooks`, `findBookByTitle`, `removeBook`, `restoreBook`, `getLines`,
`lineContent`, `lineCount`, `headingIndexes`, `hasText`, `ensureBookLoaded`, `importJsonRecords`, `LinkService`
(`build`, `validate`, `exists`, `ownerOf`, `takenByOther`, `describe`, `add`, `addSilent`, `remove`, `restore`, `edit`, `snapshot`,
`applySnapshot`, `checkIntegrity`, `live`, `pending`, `forSourceLine`, `sourceLinesWithLinks`, `targetLinesWithLinks`),
`Ranges` (`markers`, `suggestEnd`, `validateSide`, `isEffective`, `trimPrevious`, `autoFillBook`, `revert`, `reapply`),
`ExportBuilder` (`build`, `anchorOffsets`, `report`, `buildCsv`), `History` (`onChange`, `push`, `undo`, `redo`, `undoTo`,
`canUndo`, `canRedo`, `entries`, `clear`), `Sefaria` (`loadTitles`, `hasTitles`, `isSefariaBook`, `checkLink`),
`AltToc` (`get`, `set`, `count`, `validate`, `toNodes`, `forExport`), `GlobalIndex` (`size`, `booksIndexed`, `clear`, `build`, `search`),
`describeSide`, `isDependent`, `typeLabel`, `computeHeRef`, `flatHeadings`, `buildTocTree`, `structuralMatch`.
פרטי: `dedupKey`, `pathStem`, `importDbLinkRows`, `activeHeadings`, `richHeadings`, `_contentScore`, `paragraphLines`,
`_headingCache` (WeakMap לפי מערך השורות), `_dbLinksLoaded` (Set).

### `Kit` (4037–4426): תלוי ב־`Util`, ובמזהי DOM של האפליקציה
`toast`, `busy`, `busyMsg`, `open({title, icon, subtitle(html), size, body, footer, onClose}) → {el, body, foot, scrim, close}`,
`closeTop`, `closeAll`, `anyDialogOpen`, `confirm`, `alert` (ההודעה היא HTML), `prompt`, `menu`, `closeMenu`, `menuOpen`,
`selectEl`, `simpleSelect`, `field` (help הוא HTML), `checkbox` (**לא בשימוש**), `switchRow`, `banner` (HTML), `emptyState` (text הוא HTML).

### `UI` (4431–5383): תלוי ב־`Domain`, `Kit` ו־`Config`; בזמן ריצה גם ב־`Dialogs`
`ui`, `show`, `updateChips`, `renderBooks`, `currentBooks`, `bookTag`, `rowHeight`, `moveLineCursor`, `activateLine`,
`moveBookCursor`, `openCursorBook`, `removeBookAsked`, `setLoadInto`, `openBook`, `openBookInto`, `swapSides`, `renderPane`,
`goToLine`, `toggleFind`, `runFind`, `stepFind`, `onLineClick`, `captureAnchor`, `renderBuilder`, `setKind`, `clearSelection`,
`createFromSelection`, `buildLinksFromSelection`, `effectiveEnd`, `selStart`, `renderLinkPanel`, `deleteLink`, `refreshAll`,
`updateHistoryButtons`, `appendLog`, `rebuildLog`. מתוכם `bookTag`, `rowHeight`, `buildLinksFromSelection`, `effectiveEnd`
ו־`selStart` מיוצאים אבל לא נקראים מבחוץ.

### `Dialogs` (5387–6655): תלוי ב־`UI.ui` בזמן ההערכה; בזמן ריצה גם ב־`Boot`
`editLink`, `anchorLabel`, `importReport`, `toc`, `locate`, `auto` (עם `buildStruct`, `buildTag`, `buildRegex`, `buildRanges`,
`renderMatches`, `runMatches`, `diagnose` ו־`resolveTargets` כפרטיים), `altToc`, `history`, `exportDialog`, `settings`, `renderHelp`.

### `Boot` (6977–7332)
`init`, `applyTheme`, `applyAllSettings`, `saveOfflineCopy`, `refreshEnter` (לא בשימוש מבחוץ), `isOnlineCopy`.
פרטי: `PRISTINE_HTML`, `toggleLog`, `logOpen`, `setStatus`, `handleDbFile`, `wireFileInput`, `wire` (~233 שורות).

### גלובלים על `window`
`initSqlJs` (`var`), `__SQL_WASM_B64__`, `JSZip`, `LazySqlite` (וגם `LazySqlite._parseColumns`), `runSelfTests`.
`Config`, `Util` ושאר המודולים הם `const` ברמת הסקריפט: נגישים מהקונסול, אבל לא כמאפייני `window`.

### תלויות בזמן ריצה בפועל, כולל תלויות לאחור

```
Config ← Util ← Data ← Domain ← Kit ← UI ⇄ Dialogs → Boot
                                     UI → Dialogs : renderHelp (4472), anchorLabel (5046), editLink (5285)
                                Dialogs → Boot    : isOnlineCopy/saveOfflineCopy (6445–6450, 6634), applyAllSettings/applyTheme (6533, 6545, 6550, 6557, 6566)
                                Dialogs → DOM של Boot: document.querySelector("#btnLog").click() (5603)
                                    Kit → מזהי האפליקציה: #toasts, #busyOverlay, #dialogHost, ו־5 סלקטורים ב־setBackgroundInert (4159)
```

## 3. מצב משותף

### `Domain.state` (2812–2818): מיוצא, ומשתנה ישירות גם מבחוץ
| שדה | טיפוס | הערה |
|---|---|---|
| `books` | `Book[]` | כל הספרים, כולל ספרי־צל. `importJsonRecords` דוחף אליו ישירות (3429, 3459) |
| `links` | `Link[]` | כולל `EXISTING` ו־`DELETED` (מחיקה רכה). לא מתכווץ אף פעם |
| `dedup` | `Map<key, Link>` | מפתח `dedupKey` 3021 → הקישור החי |
| `altToc` | `Map<book.id, Struct[]>` | `{key, heTitle, title?, entries:[{heTitle, line(1-based), level}]}` |
| `sefariaTitles` | `Set<string>` או `null` | — |

**Book** (`Data.mkBook` 2401): `{id:"B<n>", source, dbBookId, title, path, lineCount, isSefaria, _lines, _repo, _lazyRepo}`.
ספר־צל שנוצר מקישור במסד מקבל `id:"X"+targetBookId` (3386).
**Link** (`LinkService.build` 3026): `{id:"L<n>", status, sourceBook, sourceLineIndex, sourceRangeEnd, targetBook, targetLineIndex,
targetRangeEnd, connectionType, heRef, ref1, ref2, anchor}`, ולפעמים גם `_prevStatus`.
**anchor** הוא `{startVisible, endVisible, label}` (מהמסך או מהמסד) או `{rawStart, rawEnd, label}` (מקובץ JSON).

### `UI.ui` (4436–4456): מיוצא, ו־`Boot` ו־`Dialogs` כותבים אליו ישירות
`screen`, `prevScreen`, `sourceBook`, `targetBook`, `srcSel`/`tgtSel` (Set), `srcLast`/`tgtLast`, `srcVisible`/`tgtVisible`,
`activeLine`, `panelTab`, `bookFilter`, `bookSearch`, `loadInto`, `kind`, `connType`, `anchor`, `srcEndOverride`/`tgtEndOverride`,
`heRefOverride`, `ref1`, `ref2`, `cursor{src,tgt,books}`, `find{src,tgt:{term,hits,pos}}`, `reselect{link,side}`, `advancedBuilder`.

### Singletons ומצב מודולרי נוסף
`Config.settings` · `Util._buffer/_listeners/_uid` ו־memo של `Heb` · `Data._seq/_SQL` · `Domain._dbLinksLoaded/_headingCache`,
`History` (undo/redo עד 200), `GlobalIndex.entries/indexed` · `Kit.stack/openMenu/busyDepth/dlgSeq` · `UI.filtered/scrollBound` ·
`Dialogs.helpRendered` · `Boot.PRISTINE_HTML` (כ־1.46M תווים).

## 4. זרימות נתונים

**פתיחת מסד**: `#fileDb change` → `Boot.handleDbFile` 7049 (סוג לפי שם) → `Data.openSqlite` 2707.
- **sql.js** (קובץ עד הסף): `getSQL` מפענח את ה־base64 ל־`Uint8Array` ומריץ `initSqlJs({wasmBinary})` → `readArrayBuffer(file)`
  (הקובץ כולו) → `new SQL.Database` → `DbBookRepository` (זיהוי סכימה ועמודות, מפת `source`) → `listBooks()` (ממוין לפי כותר).
- **עצל** (מעל הסף): `readBytes = file.slice().arrayBuffer()` → `new LazySqlite(readBytes, size, {cachePages:1500})` →
  `init()` (header ו־`sqlite_master`) → `LazyDbBookRepository` → `listBooks()` (סריקת `book` לפי rowid).
→ `Domain.addBooks` → סטטוס.

**פתיחת ספר**: לחיצה ברשימה → `UI.openBook` → `openBookInto` 4571 → `Domain.ensureBookLoaded` 2936.
- עצל: `await _lazyRepo.loadLines(id)`. sql.js: `getLines` (סינכרוני).
- בפעם הראשונה לכל ספר: `loadLinksForBook` → `importDbLinkRows` 3377. כל שורה במסד הופכת ל־Link `EXISTING`. יעד שלא נטען הופך לספר־צל.
→ `UI.refreshAll` → `renderPane` ×2, `renderLinkPanel`, `renderBuilder`, `renderBooks`.

**יצירה ידנית**: לחיצה על שורות → `onLineClick` (`ui.*Sel`) → `refreshAll` → `renderBuilder` (`buildLinksFromSelection({dryRun})` ו־`validate`)
→ Ctrl+Enter → `createFromSelection` → `validate` → `Ranges.trimPrevious` → `LinkService.add` → `History.push`.

**ייבוא JSON**: `#fileJson` → `JsonLinksRepository.parseFiles` → `Domain.importJsonRecords` → סטטוס, ו־`Dialogs.importReport` כשצריך.

**יצירה אוטומטית**: `Dialogs.auto` → (`structuralMatch` | תגיות | Regex → `resolveTargets`) → `diagnose` → `renderMatches` → `runMatches` → `LinkService.add` ×N → `History.push`.

**ייצוא**: `Dialogs.exportDialog` → `ExportBuilder.build(state.links, {onlyNew})` → `{linksByBook: Map(title→records), report, stats, problems}`.
ZIP: `AltToc.forExport()` → `Data.ExportWriter.buildZip` → `Util.download`. ב־JSON וב־CSV: `Util.download` לכל קובץ.

## 5. מנועי SQLite

### הבחירה
`Data.openSqlite` 2709: `useLazy = file.size/1048576 > Config.get("lazyThresholdMb")` (ברירת מחדל 700, טווח 10–8000).
אין נפילה למנוע השני כשאחד נכשל.

### מה כל מנוע קורא

| טבלה | sql.js (`DbBookRepository` 2459) | עצל (`LazyDbBookRepository` 2594) |
|---|---|---|
| `sqlite_master` | שמות טבלאות (2465) | פענוח עצמי (1767) |
| `book` | `id`, כותר (4 שמות אפשריים), `sourceId/source_id/source`, `ORDER BY title` | סריקה מלאה. `title` לפי `parseColumns`; `sourceId/source_id`; rowid = id |
| `line` | `lineIndex` (5 שמות), `content` (**4 שמות; אם אין אף אחד, `"content"`**), `bookId` (3 שמות). `WHERE bookId=? ORDER BY lineIndex` | `indexEqFirstCol(idx_line_book_index, bookId)` → `scanRange(line, minId, maxId)` מסונן לפי Set. עמודות `lineIndex` ו־`content` לפי `parseColumns` |
| `source` | `id`, `name/title` | סריקה. `name` לפי אינדקס העמודה |
| `link` | `id, sourceLineId, targetBookId, targetLineIndex, connectionTypeId WHERE sourceBookId=? LIMIT 20000` + JOIN `book`, `connection_type` | `indexEqFirstCol(idx_link_source_book)` → `rowById(link)` לכל קישור (עד 3000) → `rowById(book)` לכל כותר. עמודות `targetBookId`, `sourceLineId`, `targetLineIndex`, `connectionTypeId` |
| `connection_type` | `name` (JOIN) | סריקה. הערך האחרון ברשומה |
| `link_anchor` | **סריקה מלאה** `WHERE side=0` כשיש ≤4000 קישורים בספר | לא נקרא |
| `link_range` | **סריקה מלאה** (`linkId, side, endLineIndex`) באותו תנאי | לא נקרא |
| אינדקסים נדרשים | — | `idx_line_book_index` (חובה; בלעדיו שגיאה 2601), `idx_link_source_book` (בלעדיו אין קישורים קיימים) |

### `LazySqlite`: יכולות ומגבלות (נבדקו מול הקוד 1515–1807)
**יכול**: header (גודל עמוד, כולל 65536; reserved; page count), varint, serial types, overflow chains (`_readPayload`), סריקת
B-tree של טבלה (סוגי עמודים 13 ו־5), `scanRange` עם גיזום, `rowById`, ו־`indexEqFirstCol` על אינדקס (סוגים 10 ו־2) עם השוואה
על העמודה הראשונה בלבד. מטמון LRU של עמודים: 1500 עמודים, 24MB.
**לא יכול**: טבלאות `WITHOUT ROWID` (הוא זורק על סוגי עמודים 2 ו־10 ב־`_walkTable`); קריאת WAL (רואה רק את הקובץ הראשי);
קידוד UTF-16 (מניח UTF-8, לא קורא את header offset 56); ערך ברירת מחדל של עמודה שנוספה ב־`ALTER TABLE ADD COLUMN`
(יוחזר `undefined`); שאילתות, JOIN ומיון; כתיבה.
**`parseColumns` (1784)**: מפרק את `CREATE TABLE` לפי פסיקים ברמה 0, **בלי לזהות הערות `--`**.
מול המסד האמיתי (הורץ ב־Node על הקוד המוטמע):
`book` → `[…,"heShortDesc","no","orderIndex",…]` (העמודה `heDesc` נבלעה בהערה, ו־`notesContent` נקראה `"no"`); `link_range` →
`["linkId","side","endLineId","for"]` (במקום `endLineIndex`); `line` → `["id","bookId","lineIndex","heRef","tocEntryId"]`
(`charCount` נבלעה). העמודות שהכלי צריך היום (`title`, `sourceId`, `lineIndex`, `targetLineIndex` ועוד) נמצאות לפני ההערות,
ולכן האינדקסים שלהן נכונים. **במקרה, לא בתכנון.**

## 6. מסדי סכמה 6/7: בדיקה קונקרטית

מהמסד האמיתי (סכמה 7): `line(id, bookId, lineIndex, heRef, tocEntryId, charCount)`, **בלי `content`**. התוכן נמצא ב־
`line_content(id INTEGER PRIMARY KEY, content TEXT NOT NULL)`, ובפועל `typeof(content)='blob'`: מסגרת zstd (`28 B5 2F FD`) עם
מילון מ־`zstd_dict(id, dict BLOB)` (שורה אחת). בטבלאות: 7,643,689 ב־`line` וב־`line_content`, 6,905,668 ב־`link`, 1,739,663
ב־`link_range`, 2,749,397 ב־`link_anchor`, 277,146 ב־`line_note` (`WITHOUT ROWID`; הערות שוליים שהוצאו מגוף השורה), ו־8,154 ב־`book`.
`link` עדיין כוללת את `targetLineIndex`, ו־`link_range` כוללת את `endLineIndex`.

> לפי `DbCapabilities.hasSplitLineContent` באפליקציה (`lib/migration/database/db_capabilities.dart` ב־`upstream/dev`), הפיצול
> ל־`line_content` התחיל בסכמה 6. הדחיסה ב־zstd היא לפי `LineContentCodec` (`line_content_codec.dart`): כל ערך BLOB במסד
> שיש בו `zstd_dict` הוא מסגרת zstd עם dictionary.

**התוצאה בכלי:**

| מסלול | מה קורה | ראיה |
|---|---|---|
| עצל (כל `seforim.db` אמיתי: 4.5GB, מעל 700MB) | `colIndex("line","content") = -1` → `v[-1]` הוא `undefined` → **כל השורות ריקות**, בלי שגיאה | הורץ: בראשית (bookId 1) החזיר 1,584 שורות, **0 לא־ריקות** |
| עצל: ביצועים | ה־rowids של שורות הספר אינם רציפים (`1, 2, 34, …`). `scanRange(min,max)` סורק את כל הטווח | בראשית: **3,769,355 רשומות נסרקו, 12,457 קריאות עמוד (~195MB), 6.8 שניות** ב־Node מדיסק מקומי. `DEVELOPERS.md` §11 מדבר על 30–100ms |
| sql.js (מסד קטן מהסף בסכמה 6/7) | `C.content` נופל ל־`"content"` → `SELECT … "content"` → **"no such column"**. השגיאה נזרקת מ־`getLines` (2908), שאין סביבו try ב־`renderPane`, ולכן כל `refreshAll` נכשל | קריאת קוד 2489, 2522, 2908, 4650 |
| גם אם תתווסף JOIN ל־`line_content` | `decodeValue` מחזיר `Uint8Array` לעמודת BLOB, ו־`String()` נותן `"40,181,47,253,…"`. **אין מפענח zstd בקובץ**: אין "zstd" ב־WASM של sql.js, וב־JSZip יש רק pako (deflate) | בדיקת ה־WASM: 0 מופעים |
| `connection_type` | ערכי enum: `COMMENTARY`…`FOOTNOTES` (24). אחרי `toLowerCase` ערכים כמו `mesorat_hashas`, `ein_mishpat`, `mishnah_in_talmud`, `sifrei_mitzvot` ו־`footnotes` לא קיימים ב־`Config` (שם הם עם רווחים, ו־`mitsvot`) | שאילתה על המסד; 3395 |
| `link_anchor` (sql.js בלבד) | `charStart`/`charEnd` נשמרים כ־`startVisible`/`endVisible` (3397). אם הם אופסטים גולמיים, הייצוא ימיר אותם שוב. **לא אומת**. בנוסף, בסכמה 7 הערות השוליים הוצאו ל־`line_note`, ולכן טקסט השורה במסד שונה מקובץ ה־txt שמולו הגנרטור מחשב אופסטים | 2548, 3397, 3628–3630 |

**שורה תחתונה:** הכלי הנוכחי **אינו מסוגל להציג טקסט ממסד בסכמה 6 או 7**, ובמסלול העצל הוא נכשל בשקט.
רשימת הספרים, מספרי השורות והקישורים הקיימים (בלי עוגנים וטווחים) כן נקראים.

## 7. ספריות מוטמעות

| ספרייה | גרסה | רישיון | ראיה |
|---|---|---|---|
| sql.js (glue ו־WASM) | לא מודפסת בקוד. ה־WASM מכיל **SQLite 3.49.1** (`2025-02-18 13:38:58 873d4e27…`), ולכן כנראה sql.js 1.13.x | sql.js MIT, SQLite Public Domain. **אין הודעת רישיון בקובץ** | פענוח שורה 1490: 659,730 בתי WASM; דגלי הידור `ENABLE_FTS3`, `ENABLE_FTS3_PARENTHESIS`, `ENABLE_NORMALIZE`, `OMIT_LOAD_EXTENSION` |
| JSZip | **3.10.1** | MIT או GPLv3 (רישיון כפול), כולל pako (MIT) | כותרת בשורות 1494–1503 |
| LazySqlite | פנימי | — | 1507–1809 |
| אייקונים | 60 symbols, נכתבו ביד | — | 952–1015 |
| פלטה וטוקנים | נגזרו מ־`ColorScheme.fromSeed(#2C1B02, tonalSpot)` של אוצריא | — | CSS A1 |

## 8. תהליך השחרור

`.github/workflows/add-release-html.yml`: מופעל ב־`release: published`, והרשאה `contents: write`. השלבים:
checkout לתג ← `cp index.html Otzaria-Link-Manager-<version>.html` (הקידומת `v` מוסרת) ← `gh release upload --clobber` ←
`PATCH` של תווית הנכס ל־"מנהל הקישורים של אוצריא גרסא <version>.html". **אין build, אין בדיקות ואין אימות** שהקובץ נטען או
שהבדיקות העצמיות עוברות. הנכס הוא בדיוק `index.html` של התג.

## 9. סטיות בין התיעוד לקוד

| טענה בתיעוד | בקוד |
|---|---|
| 66 בדיקות (`DEVELOPERS` §12, `AGENTS` §5.1) | 93 (`README` §13/§16 נכון) |
| "fuzzer של 1,500 פעולות" | 1200 (7609). ה־1500 הוא בבדיקת הסימטריה (7709) |
| טעינת ספר עצלה "30–100ms, ~1MB" | 6.8 שניות ו־~195MB בסכמה 7 (§6) |
| `AGENTS` §1: "~1.4MB, ~7,500 שורות"; §7: "6,000 שורות" | 1.47MB, 7,794 שורות |
| `DEFAULTS.density`: "comfortable \| compact" | 4 ערכים (6560–6565, CSS 136–138) |
| טולטיפ `#chipPending`: "פתיחת יומן הפעולות" | פותח את חלון ההיסטוריה (7149) |
| `_report.txt`: "דולגו (שורת כותרת)" | הספירה כוללת גם שורות מחוץ לתחום (3539, 3545) |
| `AltToc.validate`: "הצומת יושמט" | `toNodes` לא משמיט כפילויות (3993) |
| "Domain לא נוגע ב־DOM / UI בלי לוגיקה עסקית" | ראו TD-M2 ב־TECHNICAL_DEBT.md |

</div>
