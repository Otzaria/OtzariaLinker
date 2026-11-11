import { hebrewTokens } from "../../../matching/hebrew-tokens";
import { STOP_WORDS } from "../../../matching/word-weights";
import type { EngineBook } from "../types";
import { extractDh } from "../dibur-hamatchil/extract";

/*
 * The quote check of the headings engine: a structural link is not trusted to the line when the
 * commentary line's OWN quote (its explicit ד"ה) contradicts it.
 *
 * Measured on the real database (REAL_DATA_REPORT.md §7): "ביאור הגרא על תיקונים" and the base
 * mark the same pages, but at slightly different points — the commentary's last notes of a page
 * often explain words the base prints on the next one. The structure cannot see that; 142 of 3,553
 * links were "certain" and wrong, most of the remaining "certain" errors of the sample, and
 * Talmud commentaries show the same at amud boundaries.
 *
 * The check is deliberately narrow, so that it only ever LOWERS confidence and never decides a
 * target: the line must mark its ד"ה (bold, "וכו'", punctuation, dash), the first ≤4 words must hold a
 * real word (not only stop words), and they must occur verbatim (search keys) in a NEIGHBOURING
 * stretch of the base and NOT in the chosen range. Everything else is "unknown" and changes nothing.
 */

/** words of the ד"ה compared: enough to be specific, few enough to survive a variant reading */
const PHRASE_WORDS = 4;
/** neighbouring stretch on each side: as long as the target, at least this many lines */
const MIN_SPAN = 3;

export type QuoteVerdict = "confirmed" | "contradicted" | "unknown";

export interface QuoteCheck {
  verdict: QuoteVerdict;
  /** base position where the quote was found, for "contradicted" */
  at?: number;
}

export class QuoteChecker {
  private readonly keys: (string[] | undefined)[] = [];
  private readonly stretches = new Map<string, { text: string; starts: number[] }>();

  /** `content(p)`: base position p is a content line (not a heading). */
  constructor(
    private readonly base: EngineBook,
    private readonly content: (p: number) => boolean,
  ) {}

  /** the ד"ה of a commentary line as " k1 k2 k3 ", or null when the line does not mark a usable one */
  static phrase(text: string): string | null {
    const ex = extractDh(text);
    if (ex.kind !== "dh" || !ex.explicit || ex.dh.length < 2) return null;
    const words = ex.dh.slice(0, PHRASE_WORDS).map((t) => t.key);
    if (!words.some((k) => k.length >= 3 && !STOP_WORDS.has(k))) return null;
    return ` ${words.join(" ")} `;
  }

  check(phrase: string, start: number, end: number): QuoteCheck {
    if (this.find(phrase, start, end) !== null) return { verdict: "confirmed" };
    const span = Math.max(MIN_SPAN, end - start + 1);
    const before = this.find(phrase, Math.max(0, start - span), start - 1);
    if (before !== null) return { verdict: "contradicted", at: before };
    const after = this.find(phrase, end + 1, Math.min(this.base.lines.length - 1, end + span));
    if (after !== null) return { verdict: "contradicted", at: after };
    return { verdict: "unknown" };
  }

  private tokens(p: number): string[] {
    let k = this.keys[p];
    if (!k) {
      k = this.content(p) ? hebrewTokens(this.base.lines[p]!.text).map((t) => t.key) : [];
      this.keys[p] = k;
    }
    return k;
  }

  /** Content lines from..to joined into one word string (a quote may run across lines); cached per stretch. */
  private find(phrase: string, from: number, to: number): number | null {
    if (from > to) return null;
    const id = `${from}-${to}`;
    let s = this.stretches.get(id);
    if (!s) {
      let text = " ";
      const starts: number[] = [];
      for (let p = from; p <= to; p++) {
        const k = this.tokens(p);
        if (!k.length) continue;
        starts.push(text.length, p);
        text += `${k.join(" ")} `;
      }
      s = { text, starts };
      this.stretches.set(id, s);
    }
    const at = s.text.indexOf(phrase);
    if (at < 0) return null;
    let line = from;
    for (let i = 0; i < s.starts.length; i += 2) if (s.starts[i]! <= at + 1) line = s.starts[i + 1]!;
    return line;
  }
}
