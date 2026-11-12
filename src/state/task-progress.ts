/*
 * What the progress of a long task says besides the bar (audit F21: six minutes on the real database
 * with a bar and nothing else): a count when the task knows its units, and how long is left once an
 * estimate means something — after a few seconds and a few percent, never in the last moments.
 */
export const ETA_AFTER_MS = 8_000;
const ETA_MIN_FRACTION = 0.03;

/** "עוד כ־4 דקות", or null while an estimate would be a guess. */
export function remainingText(startedAt: number, done: number, total: number, now: number): string | null {
  const elapsed = now - startedAt;
  if (total <= 0 || done <= 0 || elapsed < ETA_AFTER_MS) return null;
  const f = done / total;
  if (f < ETA_MIN_FRACTION || f >= 1) return null;
  const left = (elapsed * (1 - f)) / f;
  if (left < 45_000) return "עוד פחות מדקה";
  const min = Math.round(left / 60_000);
  if (min < 60) return min <= 1 ? "עוד כדקה" : `עוד כ־${min.toLocaleString("he")} דקות`;
  const h = Math.round(left / 3_600_000);
  return h <= 1 ? "עוד כשעה" : `עוד כ־${h.toLocaleString("he")} שעות`;
}

/** "120 מתוך 300" of a unit ("ספר", "שלב"). */
export const countOf = (unit: string, n: number, of: number): string => `${unit} ${Math.min(n, of).toLocaleString("he")} מתוך ${of.toLocaleString("he")}`;
