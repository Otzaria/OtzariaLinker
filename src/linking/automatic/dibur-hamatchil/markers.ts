/*
 * Note markers of the commentary inside the base: books imported from Sefaria keep the places of
 * their commentaries' notes as empty inline elements in the base line,
 *     <i data-commentator="Notes by Rabbi Yehoshua Hartman" data-label="6"></i>
 * (data-label: the note's number as printed; "data-order" alone, or a label like "⚬", numbers
 * nothing). A commentary whose lines open with the same numbers — "(6) …" — is a book of notes,
 * and each note belongs where its marker is, whatever text it quotes. Measured on the real database
 * (REAL_DATA_REPORT.md §7.1): the notes of R' Hartman on נתיבות עולם quote the Maharal's words from
 * OTHER places ("[לשונו להלן לפני ציון 23]"), so the ד"ה search found those words verbatim a few
 * lines away and 70 of 207 certain/high suggestions were wrong; the database links every note to the
 * line of its marker. 423 books of the database carry such markers (162 commentators), among them
 * the Shulchan Arukh, the Tur, the Yerushalmi and the Zohar.
 */
import { fromGematria } from "../../../core/text/gematria";
import type { EngineLine } from "../types";

/** A commentator's markers: note number → base line indexes (ascending). */
export interface CommentatorMarkers {
  readonly commentator: string;
  readonly byNumber: ReadonlyMap<number, readonly number[]>;
}

const TAG_RE = /<[a-z][a-z0-9]*\b[^>]*\bdata-commentator\s*=\s*(["'])([^"']*)\1[^>]*>/gi;
const LABEL_RE = /\bdata-label\s*=\s*(["'])([^"']*)\1/i;

/** The number a label or a note opening spells: digits, or Hebrew letters (gematria); else null. */
export function noteNumberOf(s: string): number | null {
  const t = s.trim();
  if (/^\d{1,4}$/.test(t)) return Number(t);
  if (/^[א-ת]{1,4}['"׳״]?$|^[א-ת]{1,3}["״][א-ת]$/.test(t)) return fromGematria(t.replace(/['"׳״]/g, ""));
  return null;
}

/** Every commentator that has numbered markers in the base, by name. */
export function baseMarkers(lines: readonly EngineLine[]): CommentatorMarkers[] {
  const by = new Map<string, Map<number, number[]>>();
  for (const l of lines) {
    if (!l.text.includes("data-commentator")) continue;
    for (const m of l.text.matchAll(TAG_RE)) {
      const label = LABEL_RE.exec(m[0]);
      const n = label ? noteNumberOf(label[2]!) : null;
      if (n === null) continue;
      let byNumber = by.get(m[2]!);
      if (!byNumber) by.set(m[2]!, (byNumber = new Map()));
      const at = byNumber.get(n);
      if (!at) byNumber.set(n, [l.index]);
      else if (at.at(-1) !== l.index) at.push(l.index);
    }
  }
  return [...by].map(([commentator, byNumber]) => ({ commentator, byNumber }));
}

const OPENING_RE = /^\s*(?:<[^>]*>\s*)*[([]\s*([^()[\]<>\s]{1,5})\s*[)\]]/;

/**
 * The note numbers a commentary line opens with — "(12)", "[יב]", "(א)" — at most two: a line may
 * number its paragraph before the note ("(א) (טז) …" in הגהות שארית ציון, where (טז) is the marker's).
 */
export function openingNoteNumbers(html: string): number[] {
  const out: number[] = [];
  let rest = html;
  for (let k = 0; k < 2; k++) {
    const m = OPENING_RE.exec(rest);
    const n = m ? noteNumberOf(m[1]!) : null;
    if (n === null) break;
    out.push(n);
    rest = rest.slice(m![0].length);
  }
  return out;
}
