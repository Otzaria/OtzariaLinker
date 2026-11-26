import type { BookRef } from "../../../src/core/links/model";
import type { EngineBook } from "../../../src/linking/automatic";

/*
 * The generated pair of tests/unit/linking/adapters.test.ts (and engine-steps.test.ts): a base of distinct words under chapter
 * headings, and a commentary quoting the opening words of each line. Code-made books, so the headless tests need no database.
 */
const LETTERS = "אבגדהוזחטיכלמנסעפצקרשת";
export const word = (n: number): string => {
  let s = "";
  for (let k = 0; k < 3; k++, n = Math.floor(n / LETTERS.length)) s += LETTERS[n % LETTERS.length];
  return s;
};

export function pairTexts(n: number): { base: string[]; comm: string[] } {
  const base: string[] = [];
  const comm: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 50 === 0) {
      const h = `<h2>פרק ${word(9000 + i / 50)}</h2>`;
      base.push(h);
      comm.push(h);
    }
    const w = [0, 1, 2, 3, 4, 5].map((k) => word(6 * i + k));
    base.push(w.join(" "));
    comm.push(`<b>${w[0]} ${w[1]} ${w[2]}.</b> פירוש`);
  }
  return { base, comm };
}

export const asEngineBook = (book: BookRef, ts: readonly string[]): EngineBook => ({
  book,
  lines: ts.map((text, index) => ({ index, text, heading: /^<h([1-6])/.test(text) ? Number(text[2]) : null, heRef: null })),
});
