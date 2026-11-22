/*
 * CSV cells, in two kinds that must not be confused (QA round 2, D).
 *
 * HUMAN reports (the QA report, the link comparison, the max-link and job reports, the line mapping) are opened
 * by a person in Excel or Calc. A cell that begins with = + - @, a tab or a CR is read there as a formula, and
 * titles, heRefs and reasons come from files and databases nobody vouches for. `humanCsvCell` quotes every
 * value and puts a single quote in front of such a text; Excel shows the text as it is and drops the quote.
 * Numbers are written as they are (a negative number is not a formula).
 *
 * BYTE-CONTRACT files (the Sefaria `links.csv`, formats/sefaria-csv/write.ts) are read by a program with a fixed
 * byte format: their cells are NOT neutralised (a leading quote would change the citation), and they have
 * their own writer (`csvField`), which quotes a field holding `"`, `,`, LF or CR.
 */

const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell of a human-oriented CSV: always quoted, a formula-like text neutralised. */
export function humanCsvCell(value: unknown): string {
  const raw = value ?? "";
  const text = String(raw);
  const safe = typeof raw !== "number" && typeof raw !== "bigint" && FORMULA_START.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
