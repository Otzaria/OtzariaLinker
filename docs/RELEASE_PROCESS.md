<div dir="rtl">

# תהליך השחרור

## 1. מה המשתמש מוריד

כל שחרור ב־GitHub נושא שלושה קבצים:

| קובץ | למה |
|---|---|
| `OtzariaLinker.html` | **שם קבוע.** הקישור `https://github.com/Otzaria/OtzariaLinker/releases/latest/download/OtzariaLinker.html` מוביל תמיד לגרסה האחרונה. אסור לשנות את השם |
| `OtzariaLinker-<version>.html` | אותם בתים, עם מספר הגרסה בשם, לשמירה לצד גרסאות קודמות |
| `SHA256SUMS` | ה־SHA-256 של שני הקבצים, לאימות |

שלושתם נוצרים ב־`scripts/package-release.mjs`, שרץ בסוף `npm run build`.

## 2. הבנייה (`npm run build`)

1. `vite build` → `dist/index.html`, קובץ אחד שכולל הכול ([`DEVELOPER_GUIDE.md`](DEVELOPER_GUIDE.md) §1).
2. `scripts/package-release.mjs`:
   - **שומר אופליין** (סריקת התוצר בביטויים רגולריים): נכשל אם יש בו `<script src>` שאינו `data:`/`blob:`,
     `<link href>` ל־`http(s)`, `@import` או `url()` ל־`http(s)`, או `importScripts`. הוא נכשל גם על
     **ממשקי רשת בקוד עצמו**: קריאה חשופה ל־`fetch(` (שיטות שלנו בשם `fetch`, כמו `this.fetch`, מותרות),
     `XMLHttpRequest`, `WebSocket`, `EventSource` ו־`sendBeacon`. הוא מדפיס את כל הממצאים ויוצא בשגיאה;
   - מעתיק ל־`OtzariaLinker.html` ול־`OtzariaLinker-<version>.html` (הגרסה מ־`package.json`);
   - כותב `SHA256SUMS`;
   - **תקציב גודל:** נכשל אם `OtzariaLinker.html` גדול מ־1.75MiB (הקבוע `BUDGET` ב־`scripts/package-release.mjs`). הקובץ
     נפתח בלחיצה כפולה במחשבים רגילים, ולכן גדילה צריכה להיות החלטה: מעלים את `BUDGET` רק בכוונה. אחרי
     שהוסר sql.js מהתוצר הקובץ היה כ־1MB (לפני ההסרה כ־1.8MB); התקציב הועלה מ־1.5MiB ב־2026-11-16, כשנתוני מראי המקומות (שמות פרקים, הלכות הרמב"ם) וניהול הקישורים הקיימים הביאו אותו לכ־1.6MB;
   - מדפיס את הגודל ואת ה־hash.

## 3. בנייה שחוזרת על עצמה

אותו commit חייב לתת אותם בתים:
- התאריך שמוטמע הוא תאריך ה־commit (`git log -1 --format=%cI`), לא "עכשיו" (`build/plugins/build-info.ts`).
- ב־CI ה־commit נלקח מ־`GITHUB_SHA`. בבנייה מקומית מעץ עבודה עם שינויים נוסף `-dirty`, ולכן בנייה כזו
  אינה זהה לבנייה של ה־commit.
- ה־ZIP שהכלי מייצא נכתב עם תאריך שינוי קבוע, מאותה סיבה.
- הגרסאות של כל החבילות נעולות (`.npmrc` עם `save-exact`, `package-lock.json`, `npm ci`).

`ci.yml` בודק את זה בכל push ו־PR, ו־`release.yml` בודק את זה מה־tag לפני שהקבצים מועלים: בונה, שומר את
ה־SHA-256, מוחק את `dist`, בונה שוב ומשווה (`test "$sha1" = "$sha2"`).

## 4. CI (`.github/workflows/ci.yml`)

רץ על push ל־`main` ול־`rewrite/**`, ועל כל pull request, ב־`ubuntu-latest` עם Node 24 (כמו בפיתוח; בדיקות zstd צריכות את `zstdCompressSync` עם מילון):

`npm ci` → `npm run typecheck` → `npm test` (עם `FC_SEED` שנגזר מה־commit, [`TESTING.md`](TESTING.md) §3) →
`npm run build` (כולל הסריקה ותקציב הגודל, §2) → התקנת Chrome, Edge ו־Firefox (`npx playwright install
--with-deps chrome msedge firefox`) → `npx playwright test` (שלושת הדפדפנים) → בדיקת בנייה חוזרת →
העלאת `dist/OtzariaLinker.html` כ־artifact (`OtzariaLinker-html`).

## 5. שחרור (`.github/workflows/release.yml`)

השחרור מופעל **כשמפרסמים GitHub Release**. אין צורך להעלות קבצים ידנית.

1. מעדכנים את `version` ב־`package.json` (וב־`package-lock.json`, למשל `npm version 4.0.0 --no-git-tag-version`),
   ומתעדים את השינויים.
2. commit, ומיזוג ל־`main`.
3. יוצרים tag בשם `v<version>` בדיוק (למשל `v4.0.0-alpha.1`), ומפרסמים Release ממנו. גרסת אלפא או בטא:
   מסמנים "pre-release".
4. ה־workflow:
   - עושה checkout ל־tag;
   - **נכשל אם ה־tag אינו `v` + הגרסה שב־`package.json`**;
   - מריץ typecheck, `npm test` (עם אותו `FC_SEED` מה־commit), build (עם הסריקה ותקציב הגודל) ו־E2E אופליין
     בתוצר ב־Chrome, ב־Edge וב־Firefox;
   - **בודק שהבנייה חוזרת על עצמה מה־tag:** בונה שוב ממחיקת `dist` ומשווה את ה־SHA-256 (§3). אי־התאמה
     מכשילה את ה־workflow לפני ההעלאה;
   - מעלה את `OtzariaLinker.html`, `OtzariaLinker-<version>.html` ו־`SHA256SUMS` ל־Release (`--clobber`).
5. בודקים שהקישור הקבוע מוריד את הגרסה החדשה, ושה־hash תואם ל־`SHA256SUMS`.

אם ה־workflow נכשל, ל־Release לא יהיו קבצים. מתקנים, ומריצים שוב את ה־job (או מוחקים את ה־Release
וה־tag ויוצרים מחדש).

**שימו לב:** הקישור `releases/latest/download/OtzariaLinker.html` של GitHub מצביע על ה־Release האחרון שאינו pre-release.
כל עוד יש רק גרסאות pre-release, ייתכן שהקישור לא יעבוד. בדקו את זה לפני שמפרסמים את הקישור.

## 5א. הקישור הקבוע והכפתור "הורדת הכלי" (נבדק 2026-11-22)

מצב הקישור `releases/latest/download/OtzariaLinker.html` לפני השחרור היציב הראשון של 4.x: **404**. סיבה:
`gh release list` מראה רק v1, v2 ו־v3 (v3 הוא "Latest"), והנכס היחיד של v3 הוא `Otzaria-Link-Manager-v3.html`.
גרסאות pre-release (כמו `4.0.0-alpha.*`) אינן "latest". **אין לצרף עותק בשם `OtzariaLinker.html` ל־v3** (זה כלי אחר).

מה צריך לעשות (פעולת בעלים, לא קוד):

1. מוודאים ש־`version` ב־`package.json` הוא `4.0.0` (או 4.x יציבה אחרת), ועוברים את §3–§4 כרגיל.
2. מפרסמים את ה־Release ו**לא** מסמנים "pre-release". ה־workflow מעלה את `OtzariaLinker.html`.
3. בודקים: `curl -sIL https://github.com/Otzaria/OtzariaLinker/releases/latest/download/OtzariaLinker.html` מחזיר 200
   (ו־`gh release list` מסמן את 4.x כ־Latest). רק אז מעדכנים את ה־README: הקישור הקבוע כבר מוצג שם, עם הסבר שעדיין
   לא עובד, ומוחקים את ההסבר.
4. הכפתור "הורדת הכלי לעבודה בלי אינטרנט" (`src/ui/shell/offline-download.tsx`) לא תלוי ב־Release: זה קישור יחסי
   באותו מקור (`OtzariaLinker.html`) שמופיע רק כשהכלי נפתח מ־http(s). הוא עובד כל עוד `pages.yml` מעתיק את הקובץ
   ל־`_site/OtzariaLinker.html` (בדיקה: `tests/unit/release-asset-name.test.ts`). **לא אומת** מול האתר החי.

## 6. אימות למשתמש

```powershell
Get-FileHash .\OtzariaLinker.html -Algorithm SHA256
```

```bash
sha256sum -c --ignore-missing SHA256SUMS
```

הערך צריך להתאים לשורה של `OtzariaLinker.html` ב־`SHA256SUMS`. מי שרוצה לוודא שהקובץ נבנה מהקוד:
checkout ל־tag, `npm ci`, `npm run build`, והשוואת ה־hash.

## 7. רישיון בתוצר

`build/plugins/license-notice.ts` כותב בראש הקובץ הבנוי את הודעת ה־GPL-3.0-or-later, קישור לקוד המקור
ב־tag של הגרסה, ואת הרישיון המלא של כל חבילה מוטמעת (`preact`, `@preact/signals`, `fflate`,
`zstd-wasm-decoder`). חבילה חדשה בתוצר מוסיפים לרשימה ב־`vite.config.ts`, אחרת ההודעה שלה חסרה.

</div>
