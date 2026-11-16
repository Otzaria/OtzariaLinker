import { checkCustomPattern, MAX_PATTERN_LENGTH } from "../../../core/text/safe-regex";
import { KIND_IDS, kindOfWord, kindWord } from "../headings/numbering";
import { NUMERAL_SOURCE } from "./numerals";

/*
 * Pattern TEMPLATES: a regular expression with named placeholders for the parts of a structure
 * reference, so a preset (and a user's own pattern) says what each number IS, not only where it is:
 *
 *   (?<![א-ת])סימן\s{1,2}{סימן}(?:,?\s{1,2}סעיף\s{1,2}{סעיף})?     "סימן ה סעיף ג" → סימן 5 › סעיף 3
 *
 * Placeholders (Hebrew or English):
 *   {סימן} {פרק} {ס"ק} …  a numeral that is a LEVEL of that kind (every kind of headings/numbering.ts),
 *                         levels in the order they appear in the template → a nested path
 *   {מספר} / {num}        a numeral whose kind is read from the words matched before it ("סי' ה" → סימן)
 *   {דף} / {daf}          the daf; {עמוד} / {amud} its side (".", ":", "ע"א", "עמוד ב")
 *   {עד} / {to}           the end of a range of the deepest level ("סעיף ג-ה", "ס"ק א ב")
 *   {שם_ספר} / {book}     a book name ("ברכות", "ב"ק"): the reference counts only when it names the target
 *   {שם} / {name}         a named heading ("פרשת נח", "שער הבטחון"), matched against the target's headings
 *
 * Plain named groups work too: (?<siman>…) by kind id, (?<n>…) for the v3 "just a number". A template
 * without levels keeps v3's behaviour (the number is the first group).
 *
 * Each placeholder becomes a uniquely named group (g0, g1…), so one kind may appear in two
 * alternatives ("דף ב." | "(ב:)"). The template itself is limited like any user pattern
 * (MAX_PATTERN_LENGTH); the expanded expression goes through the same guard (checkCustomPattern).
 */

export type GroupRole =
  | { readonly role: "level"; readonly kind: string }
  | { readonly role: "any" }
  | { readonly role: "daf" }
  | { readonly role: "amud" }
  | { readonly role: "to" }
  | { readonly role: "book" }
  | { readonly role: "name" }
  | { readonly role: "n" };

export interface GroupSpec {
  /** the group's name in the compiled expression */
  readonly name: string;
  readonly spec: GroupRole;
}

export type CompiledPattern =
  | { readonly ok: true; readonly regex: RegExp; readonly groups: readonly GroupSpec[]; readonly source: string }
  | { readonly ok: false; readonly reason: string };

/** the expanded expression may be longer than what the user typed (each numeral is ~50 characters) */
const MAX_EXPANDED_LENGTH = 3000;

const AMUD_SOURCE = "ע[\"״'׳]{1,2}\\s?[אב](?![א-ת])|עמוד\\s[אב](?![א-ת])|[.:](?![א-ת\\d])";
// lazy second word: "ברכות דף ב" is the book ברכות, "בבא קמא דף ב" still finds בבא קמא
const BOOK_SOURCE = "[א-ת\"״'׳]{2,12}(?:\\s[א-ת]{2,8})??";
const NAME_SOURCE = "[א-ת\"״'׳]{2,10}(?:\\s[א-ת\"״'׳]{2,10})?(?:\\s[א-ת\"״'׳]{2,10})?";

const SPECIAL: Readonly<Record<string, GroupRole>> = {
  מספר: { role: "any" }, num: { role: "any" },
  דף: { role: "daf" }, daf: { role: "daf" },
  עמוד: { role: "amud" }, amud: { role: "amud" },
  עד: { role: "to" }, to: { role: "to" },
  שם_ספר: { role: "book" }, book: { role: "book" },
  שם: { role: "name" }, name: { role: "name" },
};

function roleOf(word: string): GroupRole | null {
  const special = SPECIAL[word];
  if (special) return special;
  if (KIND_IDS.includes(word)) return word === "daf" ? { role: "daf" } : word === "amud" ? { role: "amud" } : { role: "level", kind: word };
  const kind = kindOfWord(word);
  if (kind) return kind === "daf" ? { role: "daf" } : kind === "amud" ? { role: "amud" } : { role: "level", kind };
  return null;
}

function bodyOf(spec: GroupRole): string {
  switch (spec.role) {
    case "amud": return AMUD_SOURCE;
    case "book": return BOOK_SOURCE;
    case "name": return NAME_SOURCE;
    default: return NUMERAL_SOURCE;
  }
}

/** `{…}` that is a placeholder, not a quantifier `{1,3}`: letters, quotes and "_" */
const PLACEHOLDER_RE = /\{([A-Za-z_א-ת"'״׳]{2,12})\}/g;
const NAMED_GROUP_RE = /\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g;

/** Expands the placeholders of a template; unknown words are reported. */
export function expandTemplate(template: string): { source: string; groups: GroupSpec[] } | { error: string } {
  const groups: GroupSpec[] = [];
  let error: string | null = null;
  // named groups the user wrote: kind ids, "n", "to", "amud", "book", "name"
  const source0 = template.replace(NAMED_GROUP_RE, (whole, name: string) => {
    const spec: GroupRole | null = name === "n" ? { role: "n" } : roleOf(name);
    if (!spec) return whole;
    const g = `g${groups.length}`;
    groups.push({ name: g, spec });
    return `(?<${g}>`;
  });
  const source = source0.replace(PLACEHOLDER_RE, (whole, word: string) => {
    const spec = roleOf(word);
    if (!spec) {
      error ??= `"{${word}}" אינו שם מוכר של חלק בהפניה. אפשר למשל {סימן}, {סעיף}, {ס"ק}, {פרק}, {דף}, {עמוד}, {מספר}, {עד}.`;
      return whole;
    }
    const g = `g${groups.length}`;
    groups.push({ name: g, spec });
    return `(?<${g}>${bodyOf(spec)})`;
  });
  return error ? { error } : { source, groups };
}

/**
 * A template → a guarded, compiled expression and the meaning of its groups. Refused like any user
 * pattern: too long (as typed), unknown placeholder, or what checkCustomPattern refuses.
 */
export function compilePattern(template: string, flags = ""): CompiledPattern {
  const t = String(template ?? "").trim();
  if (!t) return { ok: false, reason: "הביטוי ריק." };
  if (t.length > MAX_PATTERN_LENGTH) return { ok: false, reason: `הביטוי ארוך מדי (יותר מ־${MAX_PATTERN_LENGTH} תווים).` };
  const e = expandTemplate(t);
  if ("error" in e) return { ok: false, reason: e.error };
  const check = checkCustomPattern(e.source, flags, { maxLength: MAX_EXPANDED_LENGTH });
  if (!check.ok) return check;
  // "d": group indices, to trim the anchor when a range end turns out not to be a number
  const regex = new RegExp(check.regex.source, check.regex.flags + "d");
  return { ok: true, regex, groups: e.groups, source: e.source };
}

/** The levels a template describes, for the UI: "סימן › סעיף › ס"ק". Empty for a v3-style pattern. */
export function describeLevels(template: string): string {
  const e = expandTemplate(String(template ?? ""));
  if ("error" in e) return "";
  const words: string[] = [];
  for (const g of e.groups) {
    const w = g.spec.role === "level" ? kindWord(g.spec.kind) : g.spec.role === "daf" ? "דף" : g.spec.role === "any" ? "מספר" : g.spec.role === "name" ? "שם" : "";
    if (w && words[words.length - 1] !== w && !words.includes(w)) words.push(w);
  }
  return words.join(" › ");
}
