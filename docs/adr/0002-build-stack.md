<div dir="rtl">

# ADR 0002 — Vite + TypeScript, Workers קלאסיים ו־WASM מוטמע

**מצב:** התקבל · 2026-11-11

## החלטה

| רכיב | בחירה | גרסה |
|---|---|---|
| שפה | TypeScript במצב strict, כולל `noUncheckedIndexedAccess` | 7.0.2 |
| Bundler | Vite (Rolldown) | 8.3.8 |
| הטמעה לקובץ יחיד | `vite-plugin-singlefile` | 2.3.4 |
| WASM | פלאגין מקומי `build/plugins/wasm-base64.ts` | — |
| Workers | `?worker&inline` עם `worker.format: "iife"` | — |

כל הגרסאות נעולות (`.npmrc: save-exact`, `package-lock.json`). ה־CI מתקין עם `npm ci`.

## ראיות (ניסוי, 2026-11-11, Chrome ו־Edge, `file://`, רשת מנותקת)

| ניסוי | Chrome | Edge |
|---|---|---|
| Classic worker מ־`blob:` | עובד | עובד |
| **Module worker מ־`blob:`** | **נכשל** (`onerror` בלי הודעה) | **נכשל** |
| sql.js ב־classic worker, WASM מ־base64, `CREATE`/`INSERT`/`SELECT` | עובד | עובד |
| `Blob.slice()` בתוך ה־Worker (הבסיס לקריאה עצלה של קובץ ענק) | עובד | עובד |
| `origin` של העמוד | `file://` | `file://` |
| בקשות רשת | 0 | 0 |

מסקנה: **Workers חייבים להיבנות כ־classic (IIFE)**. ב־format `es`, ש־Vite משתמש בו
כברירת מחדל, ה־Worker לא עולה כשהקובץ נפתח מהדיסק. בדיקת E2E
(`tests/e2e/offline-single-file.spec.ts`) שומרת על ההתנהגות הזו.

## למה פלאגין WASM מקומי

- `import x from "…wasm?inline"` נכשל ב־Vite 8 על Windows (`os error 123` בפענוח הנתיב).
- `?init` ו־`?url` מוציאים קובץ נפרד, וזה שובר את ההפצה כקובץ יחיד.
- הפלאגין הוא 20 שורות: קורא את הקובץ מ־`node_modules` ומייצא מחרוזת base64. המזהה
  מסתיים ב־`.b64`, כדי שפלאגין ה־wasm של Vite לא יתפוס אותו.

## Content-Security-Policy

התוצר נושא CSP ב־`<meta>`: `default-src 'none'`, בלי `connect-src` לרשת, ו־`worker-src blob: data:`.
זו שכבת הגנה שנייה: גם אם קוד עתידי ינסה `fetch` לכתובת חיצונית, הדפדפן יחסום אותו.
ה־CSP נבדק עם ה־Worker וה־WASM בשני הדפדפנים.

## שחזוריות

תאריך הבנייה שמוטמע בקובץ הוא **תאריך ה־commit**, לא "עכשיו". לכן בנייה חוזרת של אותו
commit אמורה להפיק קובץ זהה בבית. תהליך ה־Release מוודא זאת בבנייה כפולה.

## חלופות שנדחו

- **esbuild/Rollup ישירות:** אפשרי, אבל Vite נותן שרת פיתוח, Workers ו־CSS בלי הגדרות נוספות.
- **בלי bundler (ES modules ישירות):** `file://` חוסם `import` של קבצים מקומיים ב־Chrome.

</div>
