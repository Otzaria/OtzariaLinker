import { stripNikud } from "../../../core/text/hebrew";
import { fromGematria, toGematria } from "../../../core/text/gematria";
import { stripTags } from "../../../core/text/html";
import { hebrewTokens } from "../../../matching/hebrew-tokens";

/*
 * Whether a line shows ANY sign of a reference: a place word (דף, פרק, סימן, סעיף, פסוק, הלכה, ע"א…) or the name of a source
 * (רש"י, רמב"ם, שו"ע, גמרא, משנה, תוספות, מדרש, זוהר…), with the one-letter prefixes Hebrew glues on (ב, ו, כ, ל, מ, ה, ש).
 * A cheap first look, far below the scanner's cost: a book none of whose lines passes it has no citations to find, and the
 * citations engine does not run on it (workers/citations-job.ts). It is deliberately broad — a false "yes" costs a run, a false
 * "no" loses links — and measured (the place-word part alone, before the names of the open books were added): 70 seeded books of the official library, 70 pass, and the engine finds links in all 70. The skip is for what has no sign at all.
 * Honestly: the gate is close to a no-op for any book of running Hebrew text. "שם" (in prose: "there") and "משנה" alone pass a line,
 * so only a book with none of the words (a list, a few lines of plain prose) is skipped. It was kept wide on purpose (a false "no" loses
 * links), and the 70/70 measurement says it filters nothing in the official library; it is not a quality filter.
 * Abbreviations are written with a geresh (U+05F3) as often as with an apostrophe, and some books carry nikud: both are read.
 */
const Q = `["״”]`;
// the mark of an abbreviation: the ASCII apostrophe, the Hebrew geresh (U+05F3, what the library mostly writes) or a typographic one
const G = `['׳’]`;
const WORDS = [
  "דף",
  "דפים",
  "פרק",
  "פרקים",
  `פ${Q}[א-ת]`,
  `פ${G}`,
  "סימן",
  "סימנים",
  `סי${G}`,
  "סעיף",
  `סע${G}`,
  `ס${Q}ק`,
  "הלכה",
  "הלכות",
  `הל${G}`,
  "פסוק",
  "פסוקים",
  `ע${Q}[אב]`,
  "עמוד",
  `עמ${G}`,
  "שם",
  `גמ${G}`,
  "גמרא",
  "משנה",
  `תוס${G}`,
  "תוספות",
  `רש${Q}י`,
  `רמב${Q}ם`,
  `שו${Q}ע`,
  "מדרש",
  "זוהר",
  "פרשת",
  "מצוה",
].join("|");
const HINT = new RegExp(`(?:^|[\\s(\\[,;:.\\-])[ובכלמהש]{0,2}(?:${WORDS})(?=$|[\\s)\\].,;:\\-])`);

// the place words alone: no "שם", no name of a source ("משנה", "גמרא", רש"י…), which prose uses as freely as a reference does
const PLACE_WORDS_ONLY = ["דף", "דפים", "פרק", "פרקים", `פ${Q}[א-ת]`, `פ${G}`, "סימן", "סימנים", `סי${G}`, "סעיף", `סע${G}`, `ס${Q}ק`, "הלכה", "הלכות", `הל${G}`, "פסוק", "פסוקים", `ע${Q}[אב]`, "עמוד", `עמ${G}`, "פרשת", "מצוה"].join("|");
const PLACE_HINT = new RegExp(`(?:^|[\\s(\\[,;:.\\-])[ובכלמהש]{0,2}(?:${PLACE_WORDS_ONLY})(?=$|[\\s)\\].,;:\\-])`);

/** A place word (דף, פרק, סימן, סעיף, פסוק, הלכה, ע"א…) with no number needed: what a line says when it points somewhere. A bare "שם" or "משנה" is not one. */
export function hasPlaceWord(html: string): boolean {
  return PLACE_HINT.test(stripNikud(stripTags(html)));
}

/**
 * `knowsName`: whether a search key begins a name of an open book (AliasIndex.hasFirstWord), so that "(בראשית א, א)" — a name and
 * numbers, no place word — passes too; the one-letter and two-letter prefixes are tried (בבראשית, ובבראשית).
 */
export function hasCitationHint(html: string, knowsName?: (key: string) => boolean): boolean {
  // nikud and cantillation sit inside the words ("פֶּרֶק"), so they go first; the quote marks are handled by the patterns
  const text = stripNikud(stripTags(html));
  if (HINT.test(text)) return true;
  if (!knowsName) return false;
  for (const t of hebrewTokens(text)) {
    const k = t.key;
    if (knowsName(k) || (k.length > 3 && knowsName(k.slice(1))) || (k.length > 4 && knowsName(k.slice(2)))) return true;
  }
  return false;
}

/*
 * A STRONG sign (fix round before the merge of PR 2, issue #23): a place word followed by a number — "דף יג", "פרק ב", "סימן קכח" — an amud
 * ("ע"א"), a chapter abbreviation ("פ"ג"), or the name of an open book followed by a number ("בראשית א"). The weak hint above passes on a bare
 * "שם" or "משנה"; a line of running prose that mentions the Mishnah says nothing about a reference. The book-level gate
 * (workers/citations-job.ts, CITATION_GATE) counts strong lines.
 */
const NUM = String.raw`(?:\d{1,4}|[א-ת]["״׳']?[א-ת]?["״׳']?[א-ת]?)`;
const PLACE_WORDS = ["דף", "דפים", "פרק", "פרקים", "פ", "סימן", "סימנים", "סי", "סעיף", "סע", "הלכה", "הלכות", "הל", "פסוק", "פסוקים", "עמוד", "עמ", "פרשת", "מצוה"];
const EDGE_BEFORE = String.raw`(?:^|[\s(\[,;:.\-])`;
const EDGE_AFTER = String.raw`(?=$|[\s)\].,;:\-])`;
// the place word, then a space or an abbreviation mark (so "פה" or "פי" are not "פ" and a numeral), then the number
const STRONG = new RegExp(`${EDGE_BEFORE}[ובכלמהש]{0,2}(?:${PLACE_WORDS.join("|")})(?:[.'׳’]\\s{0,2}|\\s{1,2})(${NUM})${EDGE_AFTER}`, "g");

/** A Hebrew numeral written the one canonical way (יג, כג, קכח; not "על", which is a word that adds up to 100). */
function isNumeral(s: string): boolean {
  const bare = s.replace(/["״׳']/g, "").replace(/ך/g, "כ").replace(/ם/g, "מ").replace(/ן/g, "נ").replace(/ף/g, "פ").replace(/ץ/g, "צ");
  const n = fromGematria(bare);
  return n !== null && n > 0 && n < 1000 && toGematria(n) === bare;
}
/** an amud: ע"א / ע"ב on its own */
const AMUD = new RegExp(`${EDGE_BEFORE}ע${Q}[אב]${EDGE_AFTER}`);
/** פ"ג, פ"יב: a chapter in the abbreviation */
const CHAPTER_ABBR = new RegExp(`${EDGE_BEFORE}[ובכלמהש]{0,2}פ${Q}[א-ת]{1,2}${EDGE_AFTER}`);

export type CitationHint = "none" | "weak" | "strong";

/** none: no sign; weak: hasCitationHint; strong: a place word and a number, an amud, a chapter abbreviation, or an open book's name and a number. */
export function citationHintStrength(html: string, knowsName?: (key: string) => boolean): CitationHint {
  const text = stripNikud(stripTags(html));
  if (AMUD.test(text) || CHAPTER_ABBR.test(text)) return "strong";
  STRONG.lastIndex = 0;
  for (let m = STRONG.exec(text); m; m = STRONG.exec(text)) {
    const n = m[1]!;
    if (/^\d/.test(n) || isNumeral(n)) return "strong";
  }
  if (knowsName) {
    // the name of an open book and TWO numbers after it ("בראשית א, ב", "ישעיה ב ג"): chapter and verse. One number is not enough: a word that
    // begins the title of a book and a single letter follow each other all the time in prose (measured: the one-number form passed 98% of lines)
    const tokens = hebrewTokens(text);
    const num = (k: string | undefined) => k !== undefined && (/^\d+$/.test(k) || (k.length <= 3 && isNumeral(k)));
    for (let i = 0; i < tokens.length - 2; i++) {
      const k = tokens[i]!.key;
      if (!(knowsName(k) || (k.length > 3 && knowsName(k.slice(1))) || (k.length > 4 && knowsName(k.slice(2))))) continue;
      if (num(tokens[i + 1]!.key) && num(tokens[i + 2]!.key)) return "strong";
    }
  }
  return hasCitationHint(html, knowsName) ? "weak" : "none";
}

/**
 * The book-level gate of the citations engine (workers/citations-job.ts): a book is run when ONE line has a strong sign of an address — a place word and a
 * number, an amud, a chapter abbreviation, or the name of an open book and two numbers ("(בראשית א, ב)"). A reference with no number has no address to
 * link to, so lines that only mention a place or a source ("ראה בסימן שלמעלה", a bare "שם") open nothing. Before the fix round it was "one line with
 * any weak hint, the names of the open books included", which passed every book (150 of 150 in a seeded sample of the official library). The numbers
 * behind the new one are in docs/AUTOMATION_ENGINE.md §10.7. The user can run the engine on a book it skips anyway (CitationsOptions.noGate).
 */
export const CITATION_GATE = { strongLines: 1 } as const;

/** Counts the strong signs over the non-heading lines of a book, one line at a time; `add` says when the gate is open. */
export function citationGate(knowsName?: (key: string) => boolean): { add(html: string): boolean; readonly strong: number } {
  let strong = 0;
  return {
    add(html: string): boolean {
      if (citationHintStrength(html, knowsName) === "strong") strong++;
      return strong >= CITATION_GATE.strongLines;
    },
    get strong() {
      return strong;
    },
  };
}
