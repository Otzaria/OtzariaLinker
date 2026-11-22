import { stripTags } from "../../../core/text/html";
import { hebrewTokens } from "../../../matching/hebrew-tokens";

/*
 * Whether a line shows ANY sign of a reference: a place word (דף, פרק, סימן, סעיף, פסוק, הלכה, ע"א…) or the name of a source
 * (רש"י, רמב"ם, שו"ע, גמרא, משנה, תוספות, מדרש, זוהר…), with the one-letter prefixes Hebrew glues on (ב, ו, כ, ל, מ, ה, ש).
 * A cheap first look, far below the scanner's cost: a book none of whose lines passes it has no citations to find, and the
 * citations engine does not run on it (workers/citations-job.ts). It is deliberately broad — a false "yes" costs a run, a false
 * "no" loses links — and measured (the place-word part alone, before the names of the open books were added): 70 seeded books of the official library, 70 pass, and the engine finds links in all 70. The skip is for what has no sign at all.
 */
const Q = `["״”]`;
const WORDS = [
  "דף",
  "דפים",
  "פרק",
  "פרקים",
  `פ${Q}[א-ת]`,
  "פ'",
  "סימן",
  "סימנים",
  "סי'",
  "סעיף",
  "סע'",
  `ס${Q}ק`,
  "הלכה",
  "הלכות",
  "הל'",
  "פסוק",
  "פסוקים",
  `ע${Q}[אב]`,
  "עמוד",
  "עמ'",
  "שם",
  "גמ'",
  "גמרא",
  "משנה",
  "תוס'",
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

/**
 * `knowsName`: whether a search key begins a name of an open book (AliasIndex.hasFirstWord), so that "(בראשית א, א)" — a name and
 * numbers, no place word — passes too; the one-letter and two-letter prefixes are tried (בבראשית, ובבראשית).
 */
export function hasCitationHint(html: string, knowsName?: (key: string) => boolean): boolean {
  const text = stripTags(html);
  if (HINT.test(text)) return true;
  if (!knowsName) return false;
  for (const t of hebrewTokens(text)) {
    const k = t.key;
    if (knowsName(k) || (k.length > 3 && knowsName(k.slice(1))) || (k.length > 4 && knowsName(k.slice(2)))) return true;
  }
  return false;
}
