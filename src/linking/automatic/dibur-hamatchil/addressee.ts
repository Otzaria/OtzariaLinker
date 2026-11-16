/*
 * WHOSE words a commentary line quotes. A commentary on the Talmud quotes the Gemara most of the
 * time, but a line that opens "רש"י ד"ה X" / "תוס' ד"ה X" / "<b>שם תוס'</b> בד"ה X" quotes the
 * lemma X of רש"י or תוספות — an INTERMEDIATE commentator — and belongs to that commentator's line,
 * not to the Gemara line where the same words may also stand (the owner's requirements,
 * otzaria-library docs/דרישות-סקריפט-התאמת-דיבור-המתחיל.md §2; failure modes F8–F10 of the
 * otzaria-commentary-linker-qa skill). The lines after it that do not name anyone again (בא"ד, שם,
 * a bare בד"ה) stay with that commentator until a heading, a new main-text label (גמרא / משנה /
 * מתני') or another commentator's name.
 *
 * The names are ideas of `linker/dibur_matcher.py` (otzaria-library @48748247, organization code)
 * — its `_NAME_DH_PATTERNS`, extended with the commentators the database actually has as "X על Y"
 * books — matched here on search keys (hebrew-tokens.ts), with the prefixes ב/ו/וב peeled.
 */
import { searchKey, type HebToken } from "../../../matching/hebrew-tokens";

export interface Commentator {
  /** stable id ("rashi") */
  readonly key: string;
  /** the name as a reader writes it */
  readonly name: string;
}

interface Entry extends Commentator {
  /** search keys of the name in a line (רש"י → "רשי") */
  readonly names: readonly string[];
  /** a name written as one word with ד"ה glued on (רד"ה = רש"י ד"ה, תוד"ה = תוספות ד"ה) */
  readonly glued: readonly string[];
  /** search keys of the book title before " על " ("רש\"י על שבת" → "רשי") */
  readonly titles: readonly string[];
}

const ENTRIES: readonly Entry[] = [
  { key: "rashi", name: 'רש"י', names: ["רשי", "פרשי", "פירשי", "פירוש רשי"], glued: ["רדה", "רשדה"], titles: ["רשי"] },
  { key: "tosafot", name: "תוספות", names: ["תוס", "תוספ", "תוספות", "תוספת", "חוס"], glued: ["תודה"], titles: ["תוספות"] },
  { key: "rashbam", name: 'רשב"ם', names: ["רשבמ"], glued: [], titles: ["רשבמ"] },
  { key: "ran", name: 'ר"ן', names: ["רנ", "הרנ"], glued: [], titles: ["רנ", "הרנ"] },
  { key: "rosh", name: 'רא"ש', names: ["ראש", "הראש"], glued: [], titles: ["ראש"] },
  { key: "rif", name: 'רי"ף', names: ["ריפ", "הריפ"], glued: [], titles: ["ריפ"] },
  { key: "maharsha", name: 'מהרש"א', names: ["מהרשא"], glued: [], titles: ["מהרשא"] },
  { key: "ritva", name: 'ריטב"א', names: ["ריטבא", "הריטבא"], glued: [], titles: ["ריטבא"] },
  { key: "rashba", name: 'רשב"א', names: ["רשבא", "הרשבא"], glued: [], titles: ["רשבא"] },
  { key: "ramban", name: 'רמב"ן', names: ["רמבנ", "הרמבנ"], glued: [], titles: ["רמבנ"] },
  { key: "bartenura", name: "ברטנורא", names: ["רעב", "הרעב", "ברטנורא"], glued: [], titles: ["ברטנורא", "רעב"] },
];

const PREFIXES = ["", "ב", "ו", "וב"];
const byName = new Map<string, Entry>();
const byGlued = new Map<string, Entry>();
for (const e of ENTRIES) {
  for (const p of PREFIXES) {
    for (const n of e.names) if (!n.includes(" ")) byName.set(p + n, e);
    for (const g of e.glued) byGlued.set(p + g, e);
  }
}

/** The commentator a token names (ברש"י, ובתוס', תוספות…), else null. A one-word name needs its quote mark. */
export function commentatorOfToken(t: HebToken | undefined): Commentator | null {
  if (!t) return null;
  const e = byName.get(t.key);
  if (!e) return null;
  // "רש"י", "תוס'": written with gershayim / geresh; a bare "רשי" or "תוספות" (a full word) is fine too
  if (t.acronym || t.truncated || t.key.length >= 5 || t.key.endsWith("רשי")) return { key: e.key, name: e.name };
  return null;
}

/** "רד"ה" / "תוד"ה": a commentator name with ד"ה glued on. */
export function commentatorOfGlued(t: HebToken | undefined): Commentator | null {
  if (!t || !t.acronym) return null;
  const e = byGlued.get(t.key);
  return e ? { key: e.key, name: e.name } : null;
}

/**
 * The commentator a BOOK is, by its title: "רש"י על מועד קטן" → רש"י, "תוספות על נזיר" → תוספות.
 * Only when the whole part before " על " is the name ("תוספות הרא"ש על נדה" is not תוספות).
 */
export function commentatorOfTitle(title: string): Commentator | null {
  const at = title.indexOf(" על ");
  if (at <= 0) return null;
  const head = searchKey(title.slice(0, at));
  const e = ENTRIES.find((x) => x.titles.includes(head));
  return e ? { key: e.key, name: e.name } : null;
}
