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
 *
 * The commentators of the Shulchan Aruch (ש"ך, ט"ז, מג"א, סמ"ע, ב"ש, ח"מ, באה"ט, פת"ש, מ"ב, בה"ל, קצה"ח) are
 * the idea of Otzaria/otzaria-link-generator @c51c4c9fa817dbe58ce401f395da04465d5c2609 (src/data/
 * halachaCommentators.ts, an organization repo, so portable under AGENTS.md §2.7): a commentator's id, its
 * written forms ("ש"ך", "שפתי כהן") and its book "X על שולחן ערוך <חלק>". Only the names are taken, as search
 * keys; the routing stays this engine's own (a name counts only before ד"ה, see extract.ts).
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
  /**
   * Titles of the commentator's book written WITHOUT " על " ("מגן אברהם", "משנה ברורה"): the whole title. With
   * `part`, the title is also followed by the SA part it is on ("באר היטב אורח חיים").
   */
  readonly whole?: readonly string[];
  readonly part?: true;
}

/** the search keys of written forms ("ש\"ך", "שפתי כהן"): the keys are derived, never hand-typed */
const keysOf = (...forms: string[]): string[] => forms.map((f) => searchKey(f));

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
  // the commentators of the Shulchan Aruch (see the header)
  { key: "shach", name: 'ש"ך', names: keysOf('ש"ך', "שפתי כהן"), glued: [], titles: keysOf("שפתי כהן", 'ש"ך') },
  { key: "taz", name: 'ט"ז', names: keysOf('ט"ז', "טורי זהב"), glued: [], titles: keysOf("טורי זהב", 'ט"ז') },
  { key: "sma", name: 'סמ"ע', names: keysOf('סמ"ע', "מאירת עינים", "מאירת עיניים"), glued: [], titles: keysOf("מאירת עיניים", "מאירת עינים", 'סמ"ע') },
  { key: "magen_avraham", name: 'מג"א', names: keysOf('מג"א', 'מ"א'), glued: [], titles: keysOf("מגן אברהם"), whole: keysOf("מגן אברהם") },
  { key: "beit_shmuel", name: 'ב"ש', names: keysOf('ב"ש', "בית שמואל"), glued: [], titles: keysOf("בית שמואל"), whole: keysOf("בית שמואל") },
  { key: "chelkat_mechokek", name: 'ח"מ', names: keysOf('ח"מ', "חלקת מחוקק"), glued: [], titles: keysOf("חלקת מחוקק"), whole: keysOf("חלקת מחוקק") },
  { key: "baer_heitev", name: 'באה"ט', names: keysOf('באה"ט', "באר היטב"), glued: [], titles: keysOf("באר היטב"), whole: keysOf("באר היטב"), part: true },
  { key: "pitchei_teshuva", name: 'פת"ש', names: keysOf('פ"ת', 'פתח"ת', 'פת"ש', "פתחי תשובה"), glued: [], titles: keysOf("פתחי תשובה") },
  { key: "mishna_berura", name: 'מ"ב', names: keysOf('מ"ב', 'משנ"ב', "משנה ברורה"), glued: [], titles: keysOf("משנה ברורה"), whole: keysOf("משנה ברורה") },
  { key: "biur_halacha", name: 'בה"ל', names: keysOf('בה"ל', "ביאור הלכה"), glued: [], titles: keysOf("ביאור הלכה"), whole: keysOf("ביאור הלכה") },
  { key: "ketzot", name: 'קצה"ח', names: keysOf('קצה"ח', "קצות החושן"), glued: [], titles: keysOf("קצות החושן") },
];

/** the parts of the Shulchan Aruch, as the library's titles write them (it spells "חשן משפט" without a vav) */
const SA_PARTS = new Set(keysOf("אורח חיים", "יורה דעה", "אבן העזר", "חושן משפט", "חשן משפט"));

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
  if (at > 0) {
    const head = searchKey(title.slice(0, at));
    const e = ENTRIES.find((x) => x.titles.includes(head));
    return e ? { key: e.key, name: e.name } : null;
  }
  // a commentator of the Shulchan Aruch whose book is its name alone: "מגן אברהם", "באר היטב אורח חיים"
  const key = searchKey(title);
  for (const e of ENTRIES) {
    if (!e.whole) continue;
    if (e.whole.includes(key)) {
      // "באר היטב" alone names no part of the Shulchan Aruch: not a book of the library
      if (e.part) continue;
      return { key: e.key, name: e.name };
    }
    if (e.part && e.whole.some((w) => key.startsWith(`${w} `) && SA_PARTS.has(key.slice(w.length + 1)))) return { key: e.key, name: e.name };
  }
  return null;
}
