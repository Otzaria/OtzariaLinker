import { SEFARIA_REF_PREFIXES } from "./sefaria-ref-prefixes";

/*
 * Builds the canonical English Sefaria ref the weekly sync needs (ref_1/ref_2, LINK_FORMATS §1.8) from
 * the Hebrew heRef the Otzaria database stores on a Sefaria book's line (compatibility review B1).
 *
 * The generator writes the English ref and the Hebrew heRef in the same walk, so they have the same
 * shape: "<prefix><address>", the address being numbers joined by ":" in English and Hebrew numerals
 * joined by ", " in Hebrew; a Talmud folio is "2a"/"2b" ↔ "ב."/"ב:". The one thing the database lacks
 * is the English prefix: SEFARIA_REF_PREFIXES, learned from the library's own records (301 prefixes;
 * Bavli, Tanakh, Mishneh Torah, Shulchan Aruch, Mishnah Berurah, Mishnah, Rashi/Tosafot on Bavli,
 * Zohar Chadash…). Measured on all 284,585 ref_1/ref_2 of the library against [DB]: 100% exact in
 * every family, except 149 Tosafot on Kiddushin records the sync had already moved to a newer Sefaria
 * text than the database (scripts/sefaria-ref-pairs.py). A heRef whose prefix is not in the table, or
 * whose address does not parse, gives null — the export then asks the user for the ref; it never guesses.
 */
const VALUE: Readonly<Record<string, number>> = Object.assign(Object.create(null) as Record<string, number>, {
  א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9, י: 10, כ: 20, ך: 20, ל: 30, מ: 40, ם: 40, נ: 50, ן: 50,
  ס: 60, ע: 70, פ: 80, ף: 80, צ: 90, ץ: 90, ק: 100, ר: 200, ש: 300, ת: 400,
});

/** A Hebrew numeral as the generator writes one ("קכג", "טו", "א רצ" = 1290); null when it is not one. */
function numeral(raw: string): number | null {
  const tok = raw.replace(/["'״׳]/g, "");
  if (!tok) return null;
  const parts = tok.split(" ");
  if (parts.length === 2) {
    const a = numeral(parts[0]!);
    const b = numeral(parts[1]!);
    return a === null || b === null ? null : a * 1000 + b;
  }
  if (parts.length !== 1) return null;
  let n = 0;
  for (const c of tok) {
    const v = VALUE[c];
    if (v === undefined) return null;
    n += v;
  }
  // only a well-formed numeral counts: "הקדמה" adds up to 154 but is a word, not a number
  return n > 0 && n < 1000 && toNumeral(n) === tok ? n : null;
}

/** 1–999 the way the generator writes it: hundreds, tens, units, with טו/טז. */
function toNumeral(n: number): string {
  let s = "ת".repeat(Math.floor(n / 400));
  let r = n % 400;
  if (r >= 100) (s += "קרש"[Math.floor(r / 100) - 1]!), (r %= 100);
  if (r === 15) return `${s}טו`;
  if (r === 16) return `${s}טז`;
  if (r >= 10) (s += "יכלמנסעפצ"[Math.floor(r / 10) - 1]!), (r %= 10);
  if (r) s += "אבגדהוזחט"[r - 1]!;
  return s;
}

/** One address token: a numeral, or (first token only) a folio "ב." / "ב:". */
function addressToken(tok: string, first: boolean): string | null {
  const t = tok.trimStart();
  if (first && (t.endsWith(".") || t.endsWith(":"))) {
    const n = numeral(t.slice(0, -1));
    return n === null ? null : `${n}${t.endsWith(".") ? "a" : "b"}`;
  }
  const n = numeral(t);
  return n === null ? null : String(n);
}

interface Entry {
  en: string;
  offsets?: readonly number[];
}
let byHe: Map<string, Entry> | undefined;
const table = (): Map<string, Entry> => (byHe ??= new Map(SEFARIA_REF_PREFIXES.map(([he, en, offsets]) => [he, { en, ...(offsets && { offsets }) }])));

/** The English Sefaria ref of a line whose database heRef is `heRef`, or null when it cannot be built exactly. */
export function sefariaRefFromHeRef(heRef: string | null | undefined): string | null {
  if (!heRef) return null;
  const toks = heRef.split(", ");
  // the longest prefix whose remainder is all address tokens
  for (let cut = toks.length - 1; cut >= 1; cut--) {
    const entry = table().get(`${toks.slice(0, cut).join(", ")}, `);
    if (!entry) continue;
    const addr = toks.slice(cut).map((t, i) => addressToken(t, i === 0));
    if (addr.some((a) => a === null)) return null;
    const out = addr as string[];
    // depth-2 offsets: added to the second number only (the first stays as the section)
    if (entry.offsets && out.length === 2 && /^\d+$/.test(out[0]!)) {
      const off = entry.offsets[Number(out[0]) - 1];
      if (off === undefined) return null;
      out[1] = String(Number(out[1]) + off);
    }
    return entry.en + out.join(":");
  }
  return null;
}
