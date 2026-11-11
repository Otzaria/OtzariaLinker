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
   - **שומר אופליין:** נכשל אם בתוצר יש `<script src>` שאינו `data:`/`blob:`, `<link href>` לרשת,
     `@import` או `url()` לרשת, או `importScripts` מרשת;
   - מעתיק ל־`OtzariaLinker.html` ול־`OtzariaLinker-<version>.html` (הגרסה מ־`package.json`);
   - כותב `SHA256SUMS` ומדפיס את הגודל ואת ה־hash.

## 3. בנייה שחוזרת על עצמה

אותו commit חייב לתת אותם בתים:
- התאריך שמוטמע הוא תאריך ה־commit (`git log -1 --format=%cI`), לא "עכשיו" (`build/plugins/build-info.ts`).
- ב־CI ה־commit נלקח מ־`GITHUB_SHA`. בבנייה מקומית מעץ עבודה עם שינויים נוסף `-dirty`, ולכן בנייה כזו
  אינה זהה לבנייה של ה־commit.
- ה־ZIP שהכלי מייצא נכתב עם תאריך שינוי קבוע, מאותה סיבה.
- הגרסאות של כל החבילות נעולות (`.npmrc` עם `save-exact`, `package-lock.json`, `npm ci`).

`ci.yml` בודק את זה בכל push ו־PR: בונה, שומר את ה־SHA-256, מוחק את `dist`, בונה שוב ומשווה.

## 4. CI (`.github/workflows/ci.yml`)

רץ על push ל־`main` ול־`rewrite/**`, ועל כל pull request, ב־`ubuntu-latest` עם Node 22:

`npm ci` → `npm run typecheck` → `npm test` → `npm run build` → התקנת Chrome ו־Edge →
`npx playwright test` → בדיקת בנייה חוזרת → העלאת `dist/OtzariaLinker.html` כ־artifact (`OtzariaLinker-html`).

## 5. שחרור (`.github/workflows/release.yml`)

השחרור מופעל **כשמפרסמים GitHub Release**. אין צורך להעלות קבצים ידנית.

1. מעדכנים את `version` ב־`package.json` (וב־`package-lock.json`, למשל `npm version 2.0.0 --no-git-tag-version`),
   ומתעדים את השינויים.
2. commit, ומיזוג ל־`main`.
3. יוצרים tag בשם `v<version>` בדיוק (למשל `v2.0.0-alpha.1`), ומפרסמים Release ממנו. גרסת אלפא או בטא:
   מסמנים "pre-release".
4. ה־workflow:
   - עושה checkout ל־tag;
   - **נכשל אם ה־tag אינו `v` + הגרסה שב־`package.json`**;
   - מריץ typecheck, `npm test`, build ו־E2E אופליין ב־Chrome וב־Edge;
   - מעלה את `OtzariaLinker.html`, `OtzariaLinker-<version>.html` ו־`SHA256SUMS` ל־Release (`--clobber`).
5. בודקים שהקישור הקבוע מוריד את הגרסה החדשה, ושה־hash תואם ל־`SHA256SUMS`.

אם ה־workflow נכשל, ל־Release לא יהיו קבצים. מתקנים, ומריצים שוב את ה־job (או מוחקים את ה־Release
וה־tag ויוצרים מחדש).

**שימו לב:** הקישור `releases/latest/download/...` של GitHub מצביע על ה־Release האחרון שאינו pre-release.
כל עוד יש רק גרסאות pre-release, ייתכן שהקישור לא יעבוד. בדקו את זה לפני שמפרסמים את הקישור.

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
ב־tag של הגרסה, ואת הרישיון המלא של כל חבילה מוטמעת (`preact`, `@preact/signals`, `sql.js`, `fflate`,
`zstd-wasm-decoder`). חבילה חדשה בתוצר מוסיפים לרשימה ב־`vite.config.ts`, אחרת ההודעה שלה חסרה.

</div>
