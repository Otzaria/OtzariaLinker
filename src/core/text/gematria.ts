const ONES = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
const TENS = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"];
const HUNDREDS = ["", "ק", "ר", "ש", "ת", "תק", "תר", "תש", "תת", "תתק"];

/** Number → Hebrew numeral. Supports thousands (`א׳`…) and never returns an empty string. */
export function toGematria(num: number): string {
  const v = Math.trunc(Number(num));
  if (!Number.isFinite(v) || v <= 0) return String(num);
  let out = "";
  if (v >= 1000) {
    const thousands = Math.floor(v / 1000);
    out += (thousands < 1000 ? toGematria(thousands) : String(thousands)) + "׳";
  }
  let n = v % 1000;
  if (n === 0) return out;
  out += HUNDREDS[Math.floor(n / 100)] ?? "";
  n %= 100;
  // 15 and 16 are written ט״ו / ט״ז to avoid spelling divine names.
  if (n === 15) out += "טו";
  else if (n === 16) out += "טז";
  else out += (TENS[Math.floor(n / 10)] ?? "") + (ONES[n % 10] ?? "");
  return out;
}

const VALUES: Readonly<Record<string, number>> = {
  א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9, י: 10, כ: 20, ך: 20, ל: 30, מ: 40, ם: 40,
  נ: 50, ן: 50, ס: 60, ע: 70, פ: 80, ף: 80, צ: 90, ץ: 90, ק: 100, ר: 200, ש: 300, ת: 400,
};
const IGNORED = new Set(['"', "'", "״", "׳", " "]);

/** Hebrew numeral → number, or null when the string is not a valid numeral. */
export function fromGematria(s: string): number | null {
  let n = 0;
  let any = false;
  for (const ch of String(s)) {
    if (IGNORED.has(ch)) continue;
    const v = VALUES[ch];
    if (v == null) return null;
    n += v;
    any = true;
  }
  return any ? n : null;
}

/** A number token from a line: decimal digits, or (optionally) a Hebrew numeral. */
export function parseNumberToken(tok: unknown, allowGematria = true): number | null {
  const t = String(tok ?? "").trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return allowGematria ? fromGematria(t) : null;
}
