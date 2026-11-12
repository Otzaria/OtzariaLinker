/*
 * A guard for regular expressions typed by the user (engine options). JavaScript regexes backtrack
 * and a synchronous run cannot be interrupted, so a careless pattern could freeze the worker; every
 * place that runs a user pattern compiles it through checkCustomPattern and skips lines longer than
 * MAX_CUSTOM_REGEX_INPUT.
 */

/** Longest line a custom pattern is run on — a bound on the damage of a slow pattern. */
export const MAX_CUSTOM_REGEX_INPUT = 20_000;
export const MAX_PATTERN_LENGTH = 300;
const MAX_UNBOUNDED_QUANTIFIERS = 2;
/** every unbounded quantifier is rewritten to at most this many repetitions (security review #7) */
export const QUANTIFIER_CAP = 64;

export type PatternCheck = { readonly ok: true; readonly regex: RegExp } | { readonly ok: false; readonly reason: string };

/**
 * Accepts a user pattern only when it cannot obviously blow up. JavaScript regexes backtrack and a
 * synchronous run cannot be interrupted, so a pattern like `(a+)+$` on a long line would freeze the
 * worker. Refused: invalid syntax, more than 300 characters, back-references, a quantified group
 * that itself contains a quantifier or an alternation ("nested quantifiers" — the classic
 * catastrophic shape), more than 2 unbounded quantifiers, and patterns that match the empty string.
 * Then every unbounded quantifier is BOUNDED (`*` → `{0,64}`, `+` → `{1,64}`, `{n,}` → `{n,n+64}`),
 * so even a polynomial pattern like `a*a*b` costs at most ~line × 64² steps; markers are short, so
 * no real marker pattern is affected. Lines longer than MAX_CUSTOM_REGEX_INPUT are not searched.
 */
export function checkCustomPattern(pattern: string, flags = ""): PatternCheck {
  const p = String(pattern ?? "");
  if (!p.trim()) return { ok: false, reason: "הביטוי ריק." };
  if (p.length > MAX_PATTERN_LENGTH) return { ok: false, reason: `הביטוי ארוך מדי (יותר מ־${MAX_PATTERN_LENGTH} תווים).` };
  if (/\\[1-9]|\\k</.test(p)) return { ok: false, reason: "הפניות חוזרות (כמו \\1) אינן מותרות: הן עלולות להקפיא את הכלי." };
  const shape = quantifierShape(p);
  if (shape.nested) return { ok: false, reason: "קבוצה עם כמת שבתוכה עוד כמת או חלופות (למשל (a+)+) עלולה להקפיא את הכלי. כתבו את הביטוי בלי קינון." };
  if (shape.unbounded > MAX_UNBOUNDED_QUANTIFIERS) return { ok: false, reason: `יותר מ־${MAX_UNBOUNDED_QUANTIFIERS} כמתים בלתי מוגבלים (* או +). צמצמו אותם, למשל ל־{1,4}.` };
  const safeFlags = [...new Set(String(flags).replace(/[^imsu]/g, ""))].join("") + "g";
  let regex: RegExp;
  try {
    new RegExp(p, safeFlags); // syntax check on what the user wrote
    regex = new RegExp(boundQuantifiers(p), safeFlags);
  } catch (e) {
    return { ok: false, reason: `ביטוי רגולרי לא תקין: ${(e as Error).message}` };
  }
  if (new RegExp(p, safeFlags.replace("g", "")).test("")) return { ok: false, reason: "הביטוי מתאים גם למחרוזת ריקה, ולכן היה מסמן כל מקום בשורה." };
  return { ok: true, regex };
}

/** Rewrites unbounded quantifiers outside character classes to bounded ones (see QUANTIFIER_CAP). */
export function boundQuantifiers(p: string): string {
  let out = "";
  let inClass = false;
  /** the previous token was a quantifier — a following "?" is its lazy marker, not a new quantifier */
  let afterQuantifier = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "\\") {
      out += c + (p[i + 1] ?? "");
      i++;
      afterQuantifier = false;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      out += c;
      continue;
    }
    if (c === "[") {
      inClass = true;
      afterQuantifier = false;
      out += c;
      continue;
    }
    const brace = c === "{" ? /^\{(\d+),\}/.exec(p.slice(i)) : null;
    if ((c === "*" || c === "+") && !afterQuantifier) {
      out += `{${c === "*" ? 0 : 1},${QUANTIFIER_CAP}}`;
      afterQuantifier = true;
    } else if (brace) {
      out += `{${brace[1]},${Number(brace[1]) + QUANTIFIER_CAP}}`;
      i += brace[0].length - 1;
      afterQuantifier = true;
    } else {
      out += c;
      afterQuantifier = c === "}" || c === "?" ? afterQuantifier && c !== "?" : false;
    }
  }
  return out;
}

/** Counts unbounded quantifiers and finds a quantified group that contains a quantifier or "|". */
function quantifierShape(p: string): { nested: boolean; unbounded: number } {
  const stack: { inner: boolean }[] = [];
  let unbounded = 0;
  let nested = false;
  let inClass = false;
  let lastGroupInner = false;
  let lastWasGroup = false;
  const markInner = () => stack.forEach((g) => (g.inner = true));
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "\\") {
      i++;
      lastWasGroup = false;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      lastWasGroup = false;
      continue;
    }
    if (c === "(") {
      stack.push({ inner: false });
      lastWasGroup = false;
      continue;
    }
    if (c === ")") {
      lastGroupInner = stack.pop()?.inner ?? false;
      if (lastGroupInner) markInner();
      lastWasGroup = true;
      continue;
    }
    if (c === "|") {
      markInner();
      lastWasGroup = false;
      continue;
    }
    // "?" (optional / lazy) is bounded and never makes a group catastrophic on its own
    let q: "unbounded" | "bounded" | null = null;
    let len = 1;
    if (c === "*" || c === "+") q = "unbounded";
    else if (c === "{") {
      const m = /^\{(\d*)(,?)(\d*)\}/.exec(p.slice(i));
      if (m) {
        len = m[0].length;
        q = m[2] && !m[3] ? "unbounded" : Number(m[3] || m[1]) > 1 ? "bounded" : null;
      }
    }
    if (q) {
      if (q === "unbounded") unbounded++;
      if (lastWasGroup && lastGroupInner) nested = true;
      markInner();
      i += len - 1;
    }
    lastWasGroup = false;
  }
  return { nested, unbounded };
}
