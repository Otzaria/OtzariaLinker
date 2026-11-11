<div dir="rtl">

# ADR 0004 — Vitest, fast-check ו־Playwright על הדפדפנים המותקנים

**מצב:** התקבל · 2026-11-11

| סוג | כלי | איפה |
|---|---|---|
| יחידה, אינטגרציה, Contract, Golden | Vitest 5 (Node) | `tests/unit`, `tests/integration`, `tests/contracts` |
| Property-based | fast-check 4 (MIT) | בתוך בדיקות Vitest |
| E2E | Playwright 1.65, `channel: chrome` ו־`msedge` | `tests/e2e` |
| בסיס רגרסיה | 93 הבדיקות העצמיות של v3, דרך Playwright | `tests/e2e/legacy-baseline.spec.ts` |

## עקרונות

- **E2E רץ על התוצר, לא על שרת הפיתוח.** הבדיקה פותחת את `dist/OtzariaLinker.html`
  מ־`file://` כשהרשת מנותקת, כלומר בדיוק כמו המשתמש.
- **Playwright משתמש בדפדפנים המותקנים** (Chrome, Edge), ולכן לא נדרשת הורדת דפדפנים.
  Firefox ייתווסף ל־CI. במכונת הפיתוח הנוכחית הוא לא מותקן.
- **שמות הבדיקות שהועברו מגרסה 3 נשארים בעברית ובניסוח המקורי.** כך אפשר לעקוב אחרי
  כל בדיקה ישנה ולוודא שאף אחת לא אבדה (`docs/audit/REGRESSION_BASELINE.md`).
- **Fixtures אמיתיים בלבד לסכמות.** אסור "להמציא" מבנה של סכמה. כל fixture מתעד את מקורו.

</div>
