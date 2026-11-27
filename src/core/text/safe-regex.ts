import { backtrackingCost } from "./regex-cost";

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
/** a bounded `{n,m}` wider than this (m - n) costs like an unbounded one and is counted with them (QA round 2) */
const WIDE_RANGE = 8;
/** every unbounded quantifier is rewritten to at most this many repetitions (security review #7) */
export const QUANTIFIER_CAP = 64;
/**
 * The most backtracking work (regex-cost.ts) a pattern may need at one position of a line. What the
 * guard accepted before stays in: two capped quantifiers over the same letters (`a{1,500}a{1,500}b`,
 * `.*x.*y`, ~8,600) and every preset (at most ~6,400). On a 20,000-character line of the worst text
 * for it, a pattern at this bound ran 0.16–0.25 s in V8; `a{1,8}` five times (~70,000) is refused.
 */
export const MAX_BACKTRACKING_COST = 10_000;

export type PatternCheck = { readonly ok: true; readonly regex: RegExp } | { readonly ok: false; readonly reason: string };

/**
 * Accepts a user pattern only when it cannot obviously blow up. `limits.maxLength` raises the length
 * limit for an expression EXPANDED from a template whose typed form was held to the default
 * (pattern/template.ts); every other rule is the same. JavaScript regexes backtrack and a
 * synchronous run cannot be interrupted, so a pattern like `(a+)+$` on a long line would freeze the
 * worker. Refused: invalid syntax, more than 300 characters, back-references, a quantified group
 * that itself contains a quantifier or an alternation ("nested quantifiers" — the classic
 * catastrophic shape), more than 2 unbounded quantifiers, and patterns that match the empty string.
 * A bounded range wider than WIDE_RANGE (`{1,500}`) counts as unbounded and its width is capped like
 * theirs, so `a{1,500}a{1,500}a{1,500}b` is refused instead of running for minutes.
 * Then every unbounded quantifier is BOUNDED (`*` → `{0,64}`, `+` → `{1,64}`, `{n,}` → `{n,n+64}`, `{n,m}` → `{n,min(m,n+64)}`),
 * so even a polynomial pattern like `a*a*b` costs at most ~line × 64² steps; markers are short, so
 * no real marker pattern is affected. Last, the work the bounded pattern can need at one position
 * of a line is bounded (regex-cost.ts, MAX_BACKTRACKING_COST): the shape rules alone let chains of
 * narrow ranges (`a{1,8}a{1,8}…`), alternations that overlap (`(a|aa)(a|aa)…`) and optional
 * groups through, and those multiply. Lines longer than MAX_CUSTOM_REGEX_INPUT are not searched.
 */
export function checkCustomPattern(pattern: string, flags = "", limits: { readonly maxLength?: number } = {}): PatternCheck {
  const p = String(pattern ?? "");
  const maxLength = limits.maxLength ?? MAX_PATTERN_LENGTH;
  if (!p.trim()) return { ok: false, reason: "הביטוי ריק." };
  if (p.length > maxLength) return { ok: false, reason: `הביטוי ארוך מדי (יותר מ־${maxLength} תווים).` };
  if (/\\[1-9]|\\k</.test(p)) return { ok: false, reason: "הפניות חוזרות (כמו \\1) אינן מותרות: הן עלולות להקפיא את הכלי." };
  const shape = quantifierShape(p);
  if (shape.nested) return { ok: false, reason: "קבוצה עם כמת שבתוכה עוד כמת או חלופות (למשל (a+)+) עלולה להקפיא את הכלי. כתבו את הביטוי בלי קינון." };
  if (shape.unbounded > MAX_UNBOUNDED_QUANTIFIERS) return { ok: false, reason: `יותר מ־${MAX_UNBOUNDED_QUANTIFIERS} כמתים בלתי מוגבלים או רחבים (*, + או טווח כמו {1,500}). צמצמו אותם, למשל ל־{1,4}.` };
  const safeFlags = [...new Set(String(flags).replace(/[^imsu]/g, ""))].join("") + "g";
  let regex: RegExp;
  try {
    new RegExp(p, safeFlags); // syntax check on what the user wrote
    regex = new RegExp(boundQuantifiers(p), safeFlags);
  } catch (e) {
    return { ok: false, reason: `ביטוי רגולרי לא תקין: ${(e as Error).message}` };
  }
  // the rules above are about shapes; this bounds the work itself — what runs, after the capping (Issue #41 B16)
  let cost: number;
  try {
    cost = backtrackingCost(regex.source, safeFlags, { cap: QUANTIFIER_CAP, budget: MAX_BACKTRACKING_COST });
  } catch {
    cost = Infinity;
  }
  if (cost > MAX_BACKTRACKING_COST)
    return {
      ok: false,
      reason:
        "הביטוי עלול להקפיא את הכלי: כמה חלקים בו יכולים להתאים לאותם תווים זה אחר זה (למשל a{1,8}a{1,8}a{1,8}, או (a|aa)(a|aa)), ויש יותר מדי דרכים לחלק ביניהם שורה. אחדו חלקים סמוכים לחלק אחד (a{3,24}), צמצמו טווחים, או הפרידו ביניהם בתו קבוע.",
    };
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
    const brace = c === "{" ? /^\{(\d+),(\d*)\}/.exec(p.slice(i)) : null;
    if ((c === "*" || c === "+") && !afterQuantifier) {
      out += `{${c === "*" ? 0 : 1},${QUANTIFIER_CAP}}`;
      afterQuantifier = true;
    } else if (brace) {
      const n = Number(brace[1]);
      out += `{${brace[1]},${brace[2] ? Math.min(Number(brace[2]), n + QUANTIFIER_CAP) : n + QUANTIFIER_CAP}}`;
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
        const wide = m[2] && m[3] ? Number(m[3]) - Number(m[1] || 0) > WIDE_RANGE : false;
        q = (m[2] && !m[3]) || wide ? "unbounded" : Number(m[3] || m[1]) > 1 ? "bounded" : null;
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
