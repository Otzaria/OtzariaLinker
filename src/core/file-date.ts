/**
 * The date in a downloaded file's name: the user's own (local) date, "YYYY-MM-DD". `toISOString()` is UTC, and in Israel from
 * 22:00 (21:00 in winter) until midnight it names a file by yesterday (V7 live run 3).
 */
export function localDateStamp(d: Date = new Date()): string {
  const p2 = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
