const n = (x: number) => x.toLocaleString("he");

/**
 * The sentence under the repository analysis' progress bar (repository-dialog.tsx). Before the first book is read it says what
 * the wait is (#41 B25: "0 מתוך 3,372" stood for ~30 seconds on v52 with a cold cache — the first book waits for one scan of the
 * database's link tables; the books after it are quick).
 */
export function repoProgressText(p: { stage: "links" | "coverage"; done: number; total: number }): string {
  if (p.stage === "links" && p.done === 0)
    return `מכין את הקריאה: הכלי סורק פעם אחת את טבלאות הקישורים של המסד. במסד גדול זה לוקח עד דקה, ואחר כך ${n(p.total)} הספרים נקראים מהר.`;
  return `${p.stage === "links" ? "נקראו הקישורים של" : "חושב כיסוי של"} ${n(p.done)} מתוך ${n(p.total)} ספרים. אפשר לעצור, והספרים שנקראו נשמרים.`;
}
