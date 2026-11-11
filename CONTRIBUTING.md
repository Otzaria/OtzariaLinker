<div dir="rtl">

# תרומה לפרויקט

תודה שאתם עוזרים. לפני שינוי מהותי קראו את [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). מי שעובד עם כלי
AI: גם [`AGENTS.md`](AGENTS.md), שכלליו מחייבים כל שינוי.

## התקנה

- Node.js 22 ומעלה.
- `npm ci` (הגרסאות נעולות: `.npmrc` עם `save-exact`, ו־`package-lock.json`).
- לבדיקות E2E: Chrome ו־Edge מותקנים במחשב. Playwright משתמש בהם ישירות, בלי להוריד דפדפנים.

## פקודות

| פקודה | מה היא עושה |
|---|---|
| `npm run dev` | שרת פיתוח של Vite, לעבודה על הממשק |
| `npm run build` | בונה את `dist/OtzariaLinker.html` (ועותק עם גרסה, ו־`SHA256SUMS`) ובודקת שאין בו משאב רשת |
| `npm run typecheck` | TypeScript במצב strict |
| `npm test` | בדיקות unit, integration ו־contract (Vitest) |
| `npx vitest run <קובץ>` | קובץ בדיקה אחד |
| `npm run test:e2e` | בונה, ומריץ Playwright על הקובץ הבנוי, אופליין, ב־Chrome וב־Edge |
| `npm run test:legacy` | 93 הבדיקות העצמיות של גרסה 3 (בסיס רגרסיה) |
| `npm run check` | typecheck, `npm test` ו־E2E |

פירוט: [`docs/TESTING.md`](docs/TESTING.md).

## סגנון commit

לפי `git log`: Conventional Commits באנגלית, עם תחום כשיש.

```
feat(linking): Dibur Hamatchil engine (stage 8.2)
fix(core): match the generator's anchor rules exactly
test(fixtures): real FOOTNOTES pair from the library for the footnotes engine
docs(adr): UI decisions
chore: license the project under GPL-3.0-or-later
```

- סוגים בשימוש: `feat`, `fix`, `test`, `docs`, `build`, `chore`. תחום = השכבה או התיקייה (`core`, `database`,
  `linking`, `formats`, `sources`, `state`, `ui`, `workers`, `projects`).
- גוף ה־commit מסביר **למה**, ומה נבדק או נמדד (מספרים מנתונים אמיתיים, אם יש).
- **בלי `Co-Authored-By`** ובלי שורת ייחוס לכלי AI.

## בדיקות

- כל שינוי בהתנהגות מגיע עם בדיקה, באותו commit.
- שיניתם התנהגות במכוון? עדכנו את הבדיקה הקיימת. אל תמחקו אותה.
- נתוני בדיקה הם נתונים אמיתיים עם תיעוד מקור. אסור להמציא מבנה של סכמה ([ADR 0004](docs/adr/0004-testing-stack.md)).

## רשימת בדיקה ל־PR

- [ ] `npm run typecheck` ו־`npm test` עוברים (כולל `tests/unit/architecture.test.ts`).
- [ ] `npm run build` עובר, ו־`npx playwright test` עובר על הקובץ הבנוי.
- [ ] אין משאב רשת חדש, אין Worker במבנה module, אין קובץ נוסף בתוצר.
- [ ] אין כתיבה לקובצי המשתמש.
- [ ] נגעתם בייצוא או בפרסור: קובץ שיובא ולא שונה יוצא byte-identical.
- [ ] נגעתם בעוגנים: האופסטים זהים לכללי הגנרטור (`src/core/text/offsets.ts`).
- [ ] מחרוזות חדשות למשתמש בעברית, ואומרות מה לעשות.
- [ ] אין קוד שהועתק מ־SeforimLibrary או ממאגר מחוץ לארגון Otzaria (ראו [`AGENTS.md`](AGENTS.md) §2.7).
- [ ] התיעוד עודכן אם השתנתה התנהגות שהמשתמש רואה (`docs/USER_GUIDE.md`) או חוזה (`docs/contracts/`).
- [ ] החלטה ארכיטקטונית חדשה מתועדת ב־ADR חדש ([`docs/adr/`](docs/adr/README.md)).

## רישיון

תרומה למאגר מתפרסמת תחת GPL-3.0-or-later.

</div>
