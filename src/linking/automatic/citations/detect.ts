import type { BookRef } from "../../../core/links/model";
import { amudOnlyAt, closesAt, opensAt, parseAddress, type AddrElem, type Address, type Kind } from "./address";
import { collectionOf, COMMON_TITLES, normTitle, SA_PARTS, TIER_RANK, type AliasIndex, type AliasMatch, type AliasTarget, type Collection } from "./aliases";
import { looseWord, type NamedUnit, type NamedUnitIndex, type UnitKind } from "./named";
import { toGematria } from "../../../core/text/gematria";
import { numeralOf, strictValue } from "./numbers";
import { StructureTracker, type InternalRef } from "./self";
import { citationTokens, hasHebrewText, unifyFinals, wordShape, type Tok } from "./text";

/*
 * Citation spans in one line: a book name followed by a location ("בראשית א, ב", "ב"ק (דף לג ע"ב)",
 * "רמב"ם הל' שבת פ"א ה"ב", "או"ח סי' כ"ז"), the reversed form ("פ"ג מהל' תרומות", "בפ"ק דכריתות
 * (דף ה')") and "ibid" ("(שם)", "שם פסוק ד", "בחולין שם"). Pure; the scanner keeps the ibid context
 * across lines and chunks. Which book a citation means is decided later, by resolution: a name may
 * stand for several books (ברכות: the Bavli, or the Mishna with a chapter/mishna location).
 *
 * False-positive guards (REUSE_MATRIX §4.4, §5.6, LinkerToOtzaria's rules as ideas):
 *   • the location must be real evidence (address.ts: a marker, quote marks, brackets, or two numbers);
 *   • a name that is itself a numeral (ט"ז, מ"א) counts only before an explicit marker;
 *   • a month name or "לחודש" after the numbers makes it a date ("שבת ט"ו בשבט");
 *   • "ד"ה" right after a Talmud location points INTO a commentary: only with that commentary's name;
 *   • a commentator's name right before ("תוס' (מנחות צג.)", "רמב"ן (ב"ב לה.)") retargets the citation
 *     to that commentary when the library has it, and drops it otherwise;
 *   • the source book itself is never a target.
 */

export type IbidKind = "none" | "full" | "partial" | "book";

export interface Citation {
  /** order of detection in the run */
  readonly seq: number;
  /** 0-based source line */
  readonly line: number;
  /** raw offsets of the span in the line's anchor text */
  readonly rawStart: number;
  readonly rawEnd: number;
  /** the span as written (quote marks normalised), for reasons and tests */
  readonly text: string;
  readonly candidates: readonly AliasTarget[];
  /** the name as matched ("ב"ק"), or "שם" for ibid */
  readonly name: string;
  readonly elems: readonly AddrElem[];
  readonly evidence: Address["evidence"];
  readonly bracketed: boolean;
  readonly ibid: IbidKind;
  /** seq of the citation an ibid refers to */
  readonly ibidOf?: number;
  /**
   * forward: name then location; reversed: "פ"ג מהל' שבת"; relative: "לעיל/לקמן" + daf of the base book;
   * named: a unit cited by its name ("בפרק הזהב", "בפרשת וירא"), maybe with a location after it;
   * internal: a place in the citing book itself ("לעיל סי' ה", "לקמן כלל ז") — self.ts
   */
  readonly form: "forward" | "reversed" | "relative" | "named" | "internal";
  /** form "internal" (and an ibid of one): which way it points and where it was written */
  readonly internal?: InternalRef;
  /**
   * the words after "ד"ה" when the citation was moved to a commentator ("תוס' … ד"ה רבי מאיר"): the
   * commentator's line on the daf is the one whose heading starts with them (engine.ts, refineDibur)
   */
  readonly dh?: readonly string[];
  /** form "named": the unit the name stands for */
  readonly unit?: CitedUnit;
  /** a collection word right before ("ירושלמי", "רמב"ם", "גמ'") */
  readonly qualifier?: Collection;
  /** the citation was moved to a commentary named right before it ("תוס'") */
  readonly commentator?: string;
  /** the books it named before it was moved to the commentary: "ושם תוד"ה" after "רש"י … ד"ה" is on the same tractate */
  readonly movedFrom?: readonly AliasTarget[];
  readonly numericName: boolean;
  /**
   * the rule that read the book or the place, beyond the form (engine.ts scores and explains it):
   * "rambam-topic-full" / "-first" / "-initials" — "רמב"ם פ"ט מתרומות"; "base-daf" — "דף לה" in a commentary on a tractate
   */
  readonly rule?: string;
  /** the chapter was written as an ordinal word ("בפרק קמא דסנהדרין") */
  readonly ordinal?: true;
}

/** A chapter or parsha cited by its name. */
export interface CitedUnit {
  readonly kind: UnitKind;
  /** the name as the library's structure writes it, or as written for a level of a named book */
  readonly name: string;
  /** the cited words' loose key (named.ts): how the unit is found in another book's structure or references */
  readonly key: string;
  /** the unit in the book the names were read from (a Bavli tractate, a book of the Torah); absent for a
   * level of a named book's references ("בזוהר פרשת ויקהל") */
  readonly base?: NamedUnit;
  /** how the book was told: named next to the unit, the commentary's base, or the name alone */
  readonly context: "named" | "base" | "unique";
  /** the words written are only the start of the structure's name ("פרק האשה" for "האשה שהיא עושה") */
  readonly partial: boolean;
  /**
   * a name several tractates share, told apart only by the daf after it ("בפ' כיצד (י"ט ע"א)"): the unit
   * in each candidate book; the daf must fall inside one of them (engine.ts)
   */
  readonly bases?: readonly NamedUnit[];
  /** the name was written as its initials ("פ' אע"פ") */
  readonly initials?: boolean;
}

export interface DetectOptions {
  /** resolve "שם" (ibid). Default true. */
  readonly ibid?: boolean;
  /** how many lines back "שם" may reach (no heading between). Default 6. */
  readonly ibidWindow?: number;
  /** the citing book itself: "לעיל סי' ה" / "לקמן כלל ז" link inside it (self.ts). Without it, no internal references. */
  readonly self?: BookRef;
}

const MONTHS = new Set(["תשרי", "חשון", "חשוון", "מרחשון", "כסלו", "כסליו", "טבת", "שבט", "אדר", "ניסן", "אייר", "איר", "סיון", "סיוון", "תמוז", "אב", "אלול", "לחודש", "לחדש", "בחודש", "בחדש", "לירח"].map(unifyFinals));

/** collection words; a prefix letter (ב, ו, ה, ל, כ, ד) may be glued to them */
const QUALIFIERS: readonly (readonly [string, Collection])[] = [
  ["ירושלמי", "yerushalmi"], ["ירוש'", "yerushalmi"],
  ["גמ'", "bavli"], ["גמרא", "bavli"], ["בבלי", "bavli"], ['ש"ס', "bavli"], ["תלמוד", "bavli"], ["גמרא'", "bavli"],
  ["משנה", "mishna"], ["מתני'", "mishna"], ["מתניתין", "mishna"], ["תנן", "mishna"], ["משנה'", "mishna"],
  ["תוספתא", "tosefta"],
  ['רמב"ם', "rambam"], ["רמבם", "rambam"],
  ["טור", "tur"],
  ['שו"ע', "sa"], ["שולחן", "sa"], ["שלחן", "sa"],
];

/** commentator names whose commentary a Talmud/Tanakh citation may point into */
const COMMENTATORS: readonly (readonly [string, string])[] = [
  ["תוס'", "תוספות"], ["תוספות", "תוספות"], ["תוספ'", "תוספות"],
  ['רש"י', 'רש"י'], ['פרש"י', 'רש"י'], ['פירש"י', 'רש"י'],
  ['רמב"ן', 'רמב"ן'], ['רשב"א', 'רשב"א'], ['ריטב"א', 'ריטב"א'], ['ר"ן', 'ר"ן'], ['רא"ש', 'רא"ש'], ['רי"ף', 'רי"ף'],
  ['מהרש"א', 'מהרש"א'], ['רשב"ם', 'רשב"ם'], ['מאירי', "מאירי"], ['מהרש"ל', 'מהרש"ל'], ['רע"ב', 'ברטנורא'], ["ברטנורא", "ברטנורא"],
  ['תוי"ט', "תוספות יום טוב"], ['אבן עזרא', "אבן עזרא"], ['ראב"ע', "אבן עזרא"], ['רד"ק', 'רד"ק'],
  // "תו' ב"ק כ"ג ע"ב ד"ה ואי": the shortest form books write תוספות
  ["תו'", "תוספות"],
  // "תוד"ה" — תוספות דיבור המתחיל, one word
  ['תוד"ה', "תוספות"],
];

const PREFIX_LETTERS = /^[ובהלכדמש]{1,2}/;

function shapeOf(t: Tok, stripPrefix: number): string {
  const s = wordShape(t);
  return stripPrefix ? s.slice(stripPrefix) : s;
}

/** The word as one of `list`, allowing up to two glued prefix letters. */
function wordIn<T>(t: Tok | undefined, list: readonly (readonly [string, T])[]): T | null {
  if (!t || t.kind !== "word") return null;
  // a map per list, and its words' letters: most words of a line are none of them (the scan calls this per word)
  let m = WORD_LISTS.get(list) as { byShape: Map<string, T>; keys: Set<string> } | undefined;
  if (!m) {
    m = { byShape: new Map(list.map(([w, v]) => [w, v] as const)), keys: new Set(list.map(([w]) => unifyFinals(w.replace(/["']/g, "")))) };
    WORD_LISTS.set(list, m);
  }
  for (let p = 0; p <= 2; p++) {
    if (p && !PREFIX_LETTERS.test(t.text.slice(0, p))) break;
    if (!m.keys.has(p ? t.key.slice(p) : t.key)) continue;
    const v = m.byShape.get(shapeOf(t, p));
    if (v !== undefined) return v;
  }
  return null;
}
const WORD_LISTS = new WeakMap<object, unknown>();

export class CitationScanner {
  readonly citations: Citation[] = [];
  private seq = 0;
  private last: { c: Citation; line: number; elems: readonly AddrElem[] } | null = null;
  /** the last citation is beyond the ibid window (FAR_WINDOW at most) */
  private lastFar = false;
  private lastLineSeen = -1;
  private headingSince = false;
  /** spans that looked like citations but were dropped, by reason (for the notes) */
  readonly dropped = new Map<string, number>();
  private readonly ibidOn: boolean;
  private readonly window: number;
  /** the book a commentary is on ("… על גיטין"), the target of "לעיל"/"לקמן" */
  private readonly base: AliasTarget | null;
  /** the citing book's own levels, for its internal references (self.ts) */
  readonly structure: StructureTracker;
  private readonly selfTarget: AliasTarget | null;

  constructor(
    private readonly aliases: AliasIndex,
    private readonly sourceKey: string,
    options: DetectOptions = {},
    private readonly sourceTitle = "",
    /** chapter and parsha names (from the library's alt_toc); without it no unit is cited by name */
    private readonly units?: NamedUnitIndex,
  ) {
    this.ibidOn = options.ibid ?? true;
    this.window = options.ibidWindow ?? 6;
    this.base = baseOf(aliases, sourceTitle);
    this.structure = new StructureTracker(sourceTitle);
    this.selfTarget = options.self ? { book: options.self, tier: "derived", collection: collectionOf(options.self.title) } : null;
    this.titleCommentator = titleCommentatorOf(sourceTitle);
  }

  /** the commentator whose words this book is a glossary of ("אוצר לעזי רש"י" → רש"י), or null */
  private readonly titleCommentator: string | null;

  /** "<book> רבה" for books of the Tanakh, when the library has it */
  private midrashOf(targets: readonly AliasTarget[]): AliasTarget[] {
    const out: AliasTarget[] = [];
    for (const t of targets) for (const x of this.aliases.lookup(`${normTitle(t.book.title)} רבה`)?.targets ?? []) if (x.tier === "title" && !out.some((y) => y.book.key === x.book.key)) out.push({ ...x, tier: "derived" });
    return this.own(out);
  }

  /** Feeds one line (in book order). Heading lines are not linked but break the ibid chain. `heRef`: the line's own reference, for internal references. */
  scanLine(line: number, text: string, heading: number | null, heRef?: string | null): void {
    if (heading !== null) {
      this.headingSince = true;
      this.structure.heading(heading, text);
      this.contextCache = undefined;
      return;
    }
    this.structure.content(heRef);
    const toks = citationTokens(text);
    if (!hasHebrewText(toks)) return;
    if (this.last && (line - this.last.line > FAR_WINDOW || this.headingSince)) this.last = null;
    // past the window, "שם" with a place of its own may still reach the last citation ("ibid-far"); "(שם)" alone may not
    this.lastFar = !!this.last && line - this.last.line > this.window;
    this.headingSince = false;
    this.lastLineSeen = line;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.kind !== "word") continue;
      const next = this.forward(toks, i, line) ?? this.authorPart(toks, i, line) ?? this.responsa(toks, i, line) ?? this.rambamNamed(toks, i, line) ?? this.numericTanakh(toks, i, line) ?? this.named(toks, i, line) ?? this.reversed(toks, i, line) ?? this.relative(toks, i, line) ?? this.internal(toks, i, line) ?? this.dibur(toks, i, line) ?? this.bareNamed(toks, i, line) ?? (this.ibidOn ? (this.ibid(toks, i, line) ?? this.implicit(toks, i, line)) : null);
      if (next !== null) i = next - 1;
    }
  }

  private drop(reason: string): null {
    this.dropped.set(reason, (this.dropped.get(reason) ?? 0) + 1);
    return null;
  }

  /** "<name> <location>" or "<name> שם" at toks[i]; returns the index past the citation. */
  private forward(toks: readonly Tok[], i: number, line: number): number | null {
    // "בכסף משנה פ"ג דנדרים", "בלחם משנה פ"ג מהל' נדרים": a commentary on the Rambam named before a reversed
    // citation is whose words on it (reversed() moves the citation there), not "כסף" and a mishna 83
    if (rambamCommentatorAt(toks, i) && perekAt(toks, i + 2)) return null;
    const matches = this.aliases.matchAt(toks, i);
    for (const m of matches) {
      // "כמ"ש באה"ע סי' קמ"א": a name that is also running text ("מ"ש" — מה שכתב) is a name only after a chapter ("פ"ב דמ"ש")
      if (RUNNING_TEXT_NAMES.has(m.entry.text)) continue;
      // "בחולין שם", "בנזיר (שם)": the book with the last citation's location
      const shem = isWord(toks[m.to], "שם") ? m.to + 1 : opensAt(toks, m.to) && isWord(toks[m.to + 1], "שם") && closesAt(toks, m.to + 2) ? m.to + 3 : -1;
      if (this.ibidOn && shem > 0 && this.last && (!this.lastFar || !this.last.c.ibid || this.last.c.ibid === "none")) {
        const cands = this.own(m.entry.targets).filter((c) => this.last!.c.candidates.some((p) => p.book.key === c.book.key));
        if (cands.length) {
          const end = shem;
          return this.emit(toks, line, { from: i, to: end, candidates: cands, name: m.entry.text, elems: this.last.elems, evidence: "strong", bracketed: false, ibid: "book", ibidOf: this.last.c.seq, form: "forward", numericName: false, m, ...(this.lastFar && { rule: "ibid-far" }) });
        }
      }
      // "ב"ח ח"מ סי' ר"ב", "טור או"ח סי' א": a part of the Tur / Shulchan Aruch after the name
      const sec = m.entry.targets.some((t) => t.section) ? null : sectionAt(toks, m.to);
      // "תנחומא, משפטים ב", "בזוה"ק בשלח (נב:)", "זוה"ק (כי תשא קפח.)": a named level of the book's own
      // references (its parshiyot), then the place under it
      const level = sec ? null : this.namedLevel(toks, i, line, m);
      if (level !== null) return level;
      const addr = (sec && parseAddress(toks, sec.next)) || parseAddress(toks, m.to, { enclosed: opensBefore(toks, i), dafLetter: m.entry.targets.some((t) => t.collection === "bavli") });
      if (!addr) continue;
      // "ע"ז נ"ב ע"א", "ר"ה לב.": a tractate whose name is a numeral, with a daf and its amud
      // …or "ע"ז כ"ו א'": a quoted daf and a lone amud letter
      const amudLetterAfter = addr.elems.length === 2 && addr.elems[0]!.numeral.form === "gershayim" && addr.elems[1]!.kind === "?" && addr.elems[1]!.n <= 2 && addr.elems[1]!.numeral.form !== "gershayim" && addr.elems[1]!.numeral.form !== "digits";
      const dafOfTractate = (addr.elems[0]!.amud !== undefined || addr.elems[0]!.maybeAmud !== undefined || amudLetterAfter) && m.entry.targets.some((t) => t.collection === "bavli");
      // "(תה' צט ז)": a Tanakh name that is also a numeral, with chapter and verse in brackets closing after them
      const bracketVerse = opensBefore(toks, i) && addr.closed && addr.elems.length === 2 && addr.elems.every((e) => e.kind === "?") && m.entry.targets.every((t) => t.collection === "tanakh");
      if (m.entry.numeric && !addr.elems[0]!.explicit && !dafOfTractate && !bracketVerse) {
        this.drop("numeric-name");
        continue;
      }
      if (isDate(toks, addr.to)) return this.drop("date");
      // "לכבוד [שבת (95)]": digits alone in a bracket of their own are a note's number, not a daf
      if (addr.bracketed && addr.elems.length === 1 && addr.elems[0]!.numeral.form === "digits" && addr.elems[0]!.amud === undefined) return this.drop("note-number");
      // "בשני דברים א'", "כמה שבועות ב'": a title that is an everyday word after a number or a quantifier is the word
      if (m.entry.targets.some((t) => COMMON_TITLES.has(t.book.title)) && quantifierBefore(toks, i)) return this.drop("quantity");
      // "ובשו"ת חת"ס או"ח סי' ס"ב": a part of the Shulchan Aruch named alone, right after a work of responsa, is that work's part
      if (m.entry.targets.every((t) => t.collection === "sa") && isSaPartAlone(m.entry.text) && responsaWordBefore(toks, i)) return this.drop("part-of-another-work");
      let cands = this.own(m.entry.targets);
      let elems = addr.elems;
      // "ובמדרש רבה [ויקרא פכ"ב]", "ברבות [בראשית פי"א]", "ובמד"ר [במדבר פי"ב]": the midrash on that book, not the book
      if (m.entry.targets.every((t) => t.collection === "tanakh") && rabbahBefore(toks, i)) {
        const midrash = this.midrashOf(m.entry.targets);
        if (!midrash.length) return this.drop("midrash-not-in-library");
        return this.emit(toks, line, { from: i, to: addr.bracketed && addr.closed ? addr.to + 1 : addr.to, candidates: midrash, name: m.entry.text, elems, evidence: addr.evidence, bracketed: addr.closed, ibid: "none", form: "forward", numericName: false, commentators: false, rule: "midrash-rabbah" });
      }
      // "שו"ת הרשב"א ח"ו סי' ה": a work in parts, each its own book ("… חלק ו"): the part picks the book
      const part = elems[0]!.kind === "chelek" && elems.length > 1 ? this.partBook(m, elems[0]!.n) : null;
      if (part) {
        cands = this.own(part);
        elems = elems.slice(1);
      }
      if (sec && addr.from === sec.next) cands = withSection(cands, sec.part);
      // "נ"ב עיין במג"א סק"א" in a commentary on the Shulchan Aruch: a ס"ק with no siman is in the siman the citing
      // line is on (its own reference), in a commentary on the same part
      let rule: string | undefined = part ? "part-book" : undefined;
      if (elems[0]!.kind === "sk" && this.base?.collection === "sa") {
        const siman = this.hereSiman();
        const base = normTitle(this.base.book.title);
        const same = cands.filter((c) => c.collection === "sa-commentary" && saBaseOf(c.book.title) === base);
        if (siman !== null && same.length) {
          cands = same;
          elems = [{ kind: "siman", n: siman, explicit: true, numeral: { n: siman, form: "gershayim", common: false } }, ...elems];
          rule = "sk-here";
        }
      }
      if (!cands.length) return this.drop("self");
      // "ב"ק (דף ט:)": the closing bracket belongs to the span; in "(בראשית א, ב)" neither bracket does
      const to = addr.bracketed && addr.closed ? addr.to + 1 : addr.to;
      return this.emit(toks, line, { from: i, to, candidates: cands, name: m.entry.text, elems, evidence: addr.evidence, bracketed: addr.closed, ibid: "none", form: "forward", numericName: m.entry.numeric, m, ...(rule && { rule }) });
    }
    return null;
  }

  /**
   * Responsa by their author and siman: "הריב"ש סי' ת"ו", "במהרי"ק בסי' פ"ו", "בתשו' רמ"א סי' ס"ו", "רמ"א
   * בתשו' סי' ס"ו", "בתשובת הרא"ש כלל ל"ה סי' ד'", "בתשו' רדב"ז ח"א סי' רס"ז". The author is read from
   * the library's own titles of responsa (aliases.ts). Without a word for responsa next to the name, only an
   * author with no other book in the library ("הרא"ש סי' ה" may be his work on the Talmud), and never an
   * author's name alone that names many works (רמב"ם, רמ"א, רא"ש — AUTHOR_NAMES). A work in parts needs its part.
   */
  private responsa(toks: readonly Tok[], i: number, line: number): number | null {
    const t = toks[i]!;
    if (t.kind !== "word" || !this.aliases.responsa.size) return null;
    // most words are neither a word for responsa nor the start of an author's name
    const first = this.aliases.responsaFirst;
    if (!first.has(t.key) && !first.has(t.key.slice(1)) && !first.has(t.key.slice(2)) && !/^[ובלד]{0,2}(?:תשו|תשובת|תשובות|תשובה|שות|בתשו)$/.test(t.key)) return null;
    let j = i;
    const lead = RESPONSA_WORD.test(wordShape(t));
    if (lead) j++;
    const a = toks[j];
    if (!a || a.kind !== "word") return null;
    let found: { key: string; to: number } | null = null;
    for (const p of lead ? [0] : [0, 1, 2]) {
      if (p && !/^[ובלדכש]{1,2}$/.test(a.text.slice(0, p))) break;
      for (let n = 3; n >= 1; n--) {
        const words = toks.slice(j, j + n);
        if (words.length < n || words.some((w) => w.kind !== "word")) continue;
        const first = words[0]!;
        const k0 = first.key.slice(p);
        if (!k0) continue;
        const keys = [k0, ...words.slice(1).map((w) => w.key)];
        // the article of an acronym ("הריב"ש") is not part of the name
        const variants = first.gershayim && keys[0]!.startsWith("ה") && keys[0]!.length > 2 ? [keys.join(" "), [keys[0]!.slice(1), ...keys.slice(1)].join(" ")] : [keys.join(" ")];
        const hit = variants.find((k) => this.aliases.responsa.has(k));
        if (hit && (n > 1 || first.gershayim || k0.length >= 4)) {
          found = { key: hit, to: j + n };
          break;
        }
      }
      if (found) break;
    }
    if (!found) return null;
    let k = found.to;
    // "רמ"א בתשו' סי' ס"ו", "הרא"ש בתשובות כלל פ"ה"
    const trail = !lead && toks[k]?.kind === "word" && RESPONSA_WORD.test(wordShape(toks[k]!));
    if (trail) k++;
    const named = lead || trail;
    if (!named && AUTHOR_NAMES_KEYS.has(found.key)) return null;
    const addr = parseAddress(toks, k, { enclosed: opensBefore(toks, k) || opensBefore(toks, i) });
    if (!addr) return null;
    let elems = addr.elems;
    let books = this.aliases.responsa.get(found.key)!;
    if (elems[0]!.kind === "chelek" && elems.length > 1) {
      const n = elems[0]!.n;
      books = books.filter((b) => b.part === n);
      elems = elems.slice(1);
    } else if (books.some((b) => b.part !== null)) books = books.filter((b) => b.part === null);
    const e = elems[0]!;
    if (!e.explicit || (e.kind !== "siman" && e.kind !== "klal" && e.kind !== "teshuva")) return null;
    const own = this.own(books.map((b) => b.target));
    if (own.length !== 1) return books.length ? this.drop("responsa-ambiguous") : null;
    // the author's other books ("צוואת הריב"ש") are candidates too when no word says "responsa": the place decides
    const others = named ? [] : this.own(this.aliases.authorsElsewhere.get(found.key) ?? []).map((x) => ({ ...x, otherWork: true as const }));
    // an author of many works ("חתם סופר": dozens of "חידושי חתם סופר על …") names none of them by his name alone
    if (others.length > MAX_OTHER_WORKS) return this.drop("responsa-ambiguous");
    const cands = [...own, ...others];
    if (isDate(toks, addr.to)) return this.drop("date");
    const to = addr.bracketed && addr.closed ? addr.to + 1 : addr.to;
    return this.emit(toks, line, { from: i, to, candidates: cands, name: toks.slice(i, found.to).map((x) => wordShape(x)).join(" "), elems, evidence: addr.evidence, bracketed: addr.closed, ibid: "none", form: "forward", numericName: false, commentators: false, rule: named ? "responsa-named" : "responsa-author" });
  }

  /**
   * "רמב"ם מלכים פי"א ה"א", "הרמב"ם [שכירות פ"ב ה"ג]", "רמב"ם ת"ת פ"ג, הי"ב", "וברמב"ם (הל' ת"ת פ"ג ה"ט)":
   * the author, then a topic of the Mishneh Torah (whole, its first word, or its initials — topicAt), then a
   * chapter. The chapter is required: "הרמב"ם שבת" is no place.
   */
  private rambamNamed(toks: readonly Tok[], i: number, line: number): number | null {
    if (wordIn(toks[i], QUALIFIERS) !== "rambam" || !this.aliases.rambamTopics.length) return null;
    let k = i + 1;
    const open = opensAt(toks, k);
    if (open) k++;
    const w = toks[k];
    const hl = w?.kind === "word" && HILCHOT.has(wordShape(w).replace(/^ו?ב/, ""));
    if (hl) k++;
    // "הרמב"ם ס"ל פ"א": an abbreviation of running text is no topic
    if (toks[k]?.kind === "word" && COMMON_ABBREVIATIONS.has(wordShape(toks[k]!))) return null;
    const topic = topicAt(this.aliases, toks, k, 0);
    if (!topic) return null;
    const parsed = parseAddress(toks, topic.to, { enclosed: open || opensBefore(toks, i) });
    // "ה[רמב"ם מעשה"ק י ה]": or a chapter and a halacha as two bare numbers
    const twoBare = !!parsed && parsed.elems.length === 2 && parsed.elems.every((e) => e.kind === "?" && e.amud === undefined && e.maybeAmud === undefined && e.to === undefined);
    if (!parsed || (!twoBare && (parsed.elems[0]!.kind !== "perek" || !parsed.elems[0]!.explicit))) return null;
    // after a topic of the Rambam "פ"ג" is chapter 3 (not also the number 83)
    const { alsoNumber: _n, ...first } = parsed.elems[0]!;
    const addr = { ...parsed, elems: [first, ...parsed.elems.slice(1)] };
    if (isDate(toks, addr.to)) return this.drop("date");
    const cands = this.own([topic.target]);
    if (!cands.length) return this.drop("self");
    const to = addr.bracketed && addr.closed ? addr.to + 1 : addr.to;
    return this.emit(toks, line, { from: i, to, candidates: cands, name: topic.target.book.title, elems: addr.elems, evidence: addr.evidence, bracketed: addr.closed, ibid: "none", form: "forward", numericName: false, rule: `rambam-named-${topic.how}` });
  }

  /**
   * "ש"ך חו"מ סי' צ"א", "הש"ך ביו"ד סי' רל"ב": a name the database gives to an author's several works, then
   * a part of the Shulchan Aruch that picks one of them ("שפתי כהן על שולחן ערוך חושן משפט").
   */
  private authorPart(toks: readonly Tok[], i: number, line: number): number | null {
    for (const m of this.aliases.authorNamesAt(toks, i)) {
      const sec = sectionAt(toks, m.to);
      if (!sec) continue;
      const cands = this.own(withSection(m.entry.targets, sec.part).filter((t) => !t.section));
      if (cands.length !== 1) continue;
      const addr = parseAddress(toks, sec.next);
      if (!addr || !addr.elems[0]!.explicit) continue;
      if (isDate(toks, addr.to)) return this.drop("date");
      return this.emit(toks, line, { from: i, to: addr.to, candidates: cands, name: m.entry.text, elems: addr.elems, evidence: addr.evidence, bracketed: false, ibid: "none", form: "forward", numericName: m.entry.numeric, m, rule: "author-part" });
    }
    return null;
  }

  /** the book "<name> חלק <n>" (a title of the library), for a name and a part written after it */
  private partBook(m: AliasMatch, n: number): AliasTarget[] | null {
    const name = normTitle(m.entry.text);
    for (const t of [name, ...m.entry.targets.map((x) => normTitle(x.book.title))]) {
      const hit = this.aliases.lookup(`${t} חלק ${toGematria(n)}`)?.targets.filter((x) => x.tier === "title");
      if (hit?.length) return hit;
    }
    return null;
  }

  /**
   * "<book> [פרשת] <parsha> <place>" for a book that is not the Torah itself: "(תנחומא, משפטים ב)",
   * "מדרש תנחומא תזריע י"א", "בזוה"ק בשלח (נב:)", "בזוה"ק (וארא כד:)". The parsha's name is one of the
   * library's own (the Torah's alt_toc, named.ts), written whole; the place after it is required (a name
   * alone is "בזוהר פרשת ויקהל", named()). Resolved in the book: a level of its references by that name
   * (Tanchuma: "מדרש תנחומא, משפטים, ב"), or its daf structure (the Zohar, engine.ts).
   */
  private namedLevel(toks: readonly Tok[], i: number, line: number, m: AliasMatch): number | null {
    if (!this.units?.size || m.entry.targets.some((t) => t.collection !== "other")) return null;
    let k = m.to;
    if (toks[k]?.kind === "punct" && toks[k]!.text === ",") k++;
    const open = opensAt(toks, k);
    if (open) k++;
    const w = toks[k];
    if (w?.kind === "word" && !w.gershayim && (/^ו?ב?(?:פרשת|פרשה)$/.test(w.text) || (w.geresh && /^ו?ב?פ$/.test(w.text)))) k++;
    const found = this.units.matchAt(toks, k, ["parsha"]);
    const full = found ? found.matches.filter((x) => x.full) : [];
    if (!found || !full.length || new Set(full.map((x) => x.unit.name)).size !== 1) return null;
    let at = found.to;
    // "בזוה"ק בשלח (נב:)": the place may open its own bracket after the name
    const inner = !open && opensAt(toks, at);
    const addr = parseAddress(toks, at, { enclosed: open || inner || opensBefore(toks, i) });
    if (!addr) return null;
    // "דתניא (ויקרא כב, כג)", "דספרא (בראשית מח, יט)": a book of the Torah (also a parsha's name) with a chapter
    // and a verse is the Torah's verse, quoted after a word that happens to be a book's name
    // ("ותניא (דברים ו)", "עין יעקב (דברים לג:כח)", "בתורת כהנים (ויקרא כו, יד-מג)"): only a daf after it is the
    // book's own page ("בזוה"ק בראשית (נב.)")
    if (!addr.elems.some((e) => e.kind === "daf" || e.amud !== undefined) && this.aliases.matchAt(toks, k).some((x) => x.entry.targets.some((t) => t.collection === "tanakh"))) return null;
    // a parsha of the Torah and a chapter and verse after it is the Torah ("ויקרא (ה, א)") — not this book's level
    if (isDate(toks, addr.to)) return this.drop("date");
    const cands = this.own(m.entry.targets);
    if (!cands.length) return this.drop("self");
    const name = full[0]!.unit.name;
    const key = toks.slice(k, found.to).map((t) => looseWord(t.key)).join(" ");
    const to = addr.bracketed && addr.closed ? addr.to + 1 : addr.to;
    const unit: CitedUnit = { kind: "parsha", name, key, context: "named", partial: false };
    at = to;
    return this.emitUnit(toks, line, i, at, cands, unit, addr, false, "named-level");
  }

  /**
   * "(מ"א יד י)", "(ש"ב א ו)": a book of the Tanakh whose usual name is a numeral — and is also the database's
   * name of another book (מ"א מגן אברהם, מ"ב משנה ברורה), so it is not in the name index. Only right after
   * an opening bracket, with a chapter and a verse as bare numbers and the bracket closing after them.
   * A chapter alone too ("(ש"א ט"ו)", "(מ"א ב)"), and "שיר" for שיר השירים ("(שיר ד')") — a word, so only
   * in this shape.
   */
  private numericTanakh(toks: readonly Tok[], i: number, line: number): number | null {
    const t = toks[i]!;
    if (!opensBefore(toks, i) || t.geresh || (!t.gershayim && t.text !== "שיר")) return null;
    const shape = wordShape(t);
    const title = Object.hasOwn(NUMERIC_TANAKH, shape) ? NUMERIC_TANAKH[shape] : shape === "שיר" ? "שיר השירים" : undefined;
    const targets = title ? this.aliases.lookup(title)?.targets.filter((x) => x.tier === "title" && x.collection === "tanakh") : undefined;
    if (!targets?.length) return null;
    const addr = parseAddress(toks, i + 1, { enclosed: true });
    if (!addr || !addr.closed || addr.elems.length > 2 || !addr.elems.every((e) => e.kind === "?" && e.maybeAmud === undefined && e.to === undefined)) return null;
    // a chapter alone must be written as a numeral ("(ש"א ט"ו)", "(שיר ד')", "(מ"א ב)"), not an everyday word
    if (addr.elems.length === 1 && addr.elems[0]!.numeral.common) return null;
    const cands = this.own(targets.map((x) => ({ ...x, tier: "derived" as const })));
    if (!cands.length) return this.drop("self");
    return this.emit(toks, line, { from: i, to: addr.to, candidates: cands, name: wordShape(t), elems: addr.elems, evidence: addr.evidence, bracketed: true, ibid: "none", form: "forward", numericName: true });
  }

  /** "פ"ג מהל' תרומות ה"א", "בפ"ק דכריתות (דף ה')", "בפרק ב' ממסכת טהרות" at toks[i]. */
  private reversed(toks: readonly Tok[], i: number, line: number): number | null {
    const head = perekAt(toks, i);
    if (!head) return null;
    let j = head.next;
    // "ממסכת טהרות" / "דמסכת" — the name follows the word "מסכת"
    let m = this.aliases.matchAt(toks, j).find((x) => x.prefix.endsWith("ד") || x.prefix.endsWith("מ"));
    // "בפ"ב דמסכת ע"ז": the word "מסכת" with the ד, then a tractate by any of its names
    const t = toks[j];
    if (!m && t?.kind === "word" && /^[דמ](?:מסכת|מס'|מס)$/.test(wordShape(t))) m = this.aliases.matchAt(toks, j + 1).find((x) => x.prefix === "" && x.entry.targets.some((y) => TALMUDIC_COLLECTIONS.has(y.collection)));
    // "רמב"ם פ"ט מתרומות", "פ"ה מה' מכירה", "פרק ו' מהלכו' אישות": a topic of the Rambam, told by the
    // author's name right before or by a word for "הלכות"; the same words without them are the tractate
    // …or by a commentary on the Rambam named right before ("בכסף משנה פ"ג דנדרים", "כ"מ פ"ה מק"פ")
    const rambamBefore = [1, 2].some((b) => wordIn(before(toks, i, b), QUALIFIERS) === "rambam") || !!rambamCommentatorBefore(toks, i, true);
    let topic: RambamTopic | null = null;
    // "פ"ט ה"י מהל' עדות", "פ"ו הל' כ"ו מהל' ערכין": the halacha written before the topic
    let pre: Address | null = null;
    if (!m) {
      const h = parseAddress(toks, j, { after: "perek" });
      if (h && h.elems.length === 1 && h.elems[0]!.kind === "halacha" && h.elems[0]!.explicit) {
        const tp = rambamTopicAt(this.aliases, toks, h.to);
        if (tp && (tp.hilchot || rambamBefore)) {
          pre = h;
          j = h.to;
        }
      }
    }
    if (!m?.entry.targets.some((t) => t.collection === "rambam")) {
      topic = rambamTopicAt(this.aliases, toks, j);
      if (topic && !topic.hilchot && !rambamBefore) topic = null;
      // "הרמב"ם בפ"ו מאבות" (שמונה פרקים, on the tractate): a topic read loosely loses to a tractate's name
      if (topic && m && !topic.hilchot && (topic.how === "word" || topic.how === "abbrev")) topic = null;
      // "הרמב"ם פ"ב דכתובות" is not the tractate; a topic we cannot read is not guessed
      if (!topic && rambamBefore) return m ? this.drop("rambam-topic-unknown") : null;
    }
    if (!m && !topic) return null;
    j = topic ? topic.to : m!.to;
    const elems: AddrElem[] = [{ kind: "perek", n: head.n, explicit: true, numeral: { n: head.n, form: "gershayim", common: false } }, ...(pre && topic ? pre.elems : [])];
    let to = j;
    const rest = parseAddress(toks, j, { after: "perek" });
    if (rest && !rest.elems.some((e) => e.kind === "perek") && !(pre && topic)) {
      elems.push(...rest.elems);
      to = rest.to;
    }
    if (isDate(toks, to)) return this.drop("date");
    let cands = this.own(topic ? [topic.target] : m!.entry.targets);
    // "בפ"ק דיבמו'": a name only the Bavli has (a truncation, a nickname) — a chapter is the Mishna's as well
    if (!topic && cands.length && cands.every((x) => x.collection === "bavli")) cands = [...cands, ...this.siblings(cands, "mishna").map((x) => ({ ...x, tier: "secondary" as const }))];
    if (!cands.length) return this.drop("self");
    const name = topic ? topic.target.book.title : m!.entry.text;
    return this.emit(toks, line, { from: i, to, candidates: cands, name, elems, evidence: "strong", bracketed: false, ibid: "none", form: "reversed", numericName: false, ...(m && !topic && { m }), ...(topic && { rule: `rambam-topic-${topic.how}` }), ...(head.ordinal && { ordinal: true }) });
  }

  /**
   * A unit cited by its NAME: "בפרק הזהב", "פ' המדיר דכתובות", "ביבמות פרק האשה רבה", "בפרשת וירא",
   * "בזוהר פרשת ויקהל". The names are the library's own (alt_toc: the Bavli's chapters, the Torah's
   * parshiyot). A name shared by several units is not guessed: a tractate named next to it, or the
   * book this commentary is on, must pick one. A location right after it ("(דף ס"ד ע"ב)", "[יבמות צ:]",
   * "(י"ב, י"ד)") is resolved in the unit's book, and only inside the unit (engine.ts).
   */
  private named(toks: readonly Tok[], i: number, line: number, bare = false): number | null {
    if (!this.units?.size) return null;
    const head = bare ? { next: i, kinds: ["chapter"] as UnitKind[] } : unitWordAt(toks, i);
    if (!head) return null;
    const found = this.units.matchAt(toks, head.next, head.kinds);
    if (!found) return null;
    // with no word for "chapter", only a whole name, and only one of four letters or more ("בהחובל", "ביש נוחלין")
    if (bare && (!found.matches.some((x) => x.full) || found.initials || (found.to - head.next === 1 && toks[head.next]!.key.length < 4))) return null;
    // the span starts at "ריש"/"סוף" before the chapter word, so a commentator before it is seen
    const prev = toks[i - 1];
    const from = prev?.kind === "word" && !prev.gershayim && !prev.geresh && POSITION_BEFORE.test(prev.text) ? i - 1 : i;
    // "בירושלמי דשבת פרק במה מדליקין", "במשנה פ' הזהב": another collection's chapter (numbered
    // differently in places), or a chapter of the Rambam / the Tur — not the Bavli's
    if (found.matches.some((x) => x.unit.kind === "chapter"))
      for (let back = 1; back <= 3; back++) {
        const q = wordIn(before(toks, from, back), QUALIFIERS);
        if (q && q !== "bavli") return this.drop("unit-other-collection");
      }
    let k = found.to;
    // what names the book: a tractate/book right before ("ביבמות פרק", "בזוהר פרשת") or right after
    // ("דכתובות", "בכתובות", "דמס' שבת"), or a book with a location in brackets ("[יבמות צ:]")
    const beforeBook = this.bookBefore(toks, from);
    let afterBook: AliasMatch | null = null;
    let addr: Address | null = null;
    const glued = this.aliases.matchAt(toks, k).find((m) => m.prefix !== "" && /[דבמ]$/.test(m.prefix));
    if (glued) {
      afterBook = glued;
      k = glued.to;
      addr = parseAddress(toks, k, { after: "perek" });
    } else if (opensAt(toks, k)) {
      const inside = this.aliases.matchAt(toks, k + 1).find((m) => m.prefix === "");
      const a = inside ? parseAddress(toks, inside.to, { enclosed: true }) : parseAddress(toks, k);
      if (a) {
        afterBook = inside ?? null;
        addr = a;
      }
    } else addr = parseAddress(toks, k);
    if (addr && addr.elems.some((e) => e.kind === "perek")) addr = null; // "פרק X פרק ב": not this unit's location
    // a chapter's name with no "פרק" is a name only with a daf in brackets right after it, which must then fall
    // inside that chapter (engine.ts) — "ביש נוחלין (קלח:)", "בהחובל [פ"ז ע"א]"
    if (bare && (!addr || !addr.closed || afterBook || (addr.elems[0]!.kind !== "daf" && addr.elems[0]!.amud === undefined))) return null;

    // a partial name must be distinctive — one word of 4+ letters ("פרק זה", "בפרק אחד" are not "זה
    // בורר", "אחד דיני ממונות") — and, when two or more words matched, the next word must not
    // contradict the name ("פרק אלו הן הנשרפין" is not "אלו הן הנחנקין")
    const matched = found.to - head.next;
    const nextTok = toks[found.to];
    const contradicts = matched >= 2 && nextTok?.kind === "word" && !nextTok.gershayim && !nextTok.geresh && !this.aliases.matchAt(toks, found.to).length;
    let matches = found.matches.filter((x) => x.full || (!contradicts && (matched >= 2 || toks[head.next]!.key.length >= 4)));
    if (!matches.length) return this.drop("unit-partial-name");
    let context: CitedUnit["context"] = "unique";
    // a book that is not one of the indexed ones (the Zohar, a midrash) before a parsha: a level of ITS references
    const ofBook = beforeBook && !beforeBook.some((t) => matches.some((x) => x.unit.book.key === t.book.key)) && !this.tractateKeys(beforeBook).size ? beforeBook : null;
    if (ofBook && matches.every((x) => x.unit.kind === "parsha")) {
      const cands = this.own(ofBook);
      if (!cands.length) return this.drop("self");
      const name = matches[0]!.unit.name;
      const key = toks.slice(head.next, found.to).map((t) => looseWord(t.key)).join(" ");
      const to = addr ? (addr.bracketed && addr.closed ? addr.to + 1 : addr.to) : found.to;
      const unit: CitedUnit = { kind: "parsha", name, key, context: "named", partial: false };
      return this.emitUnit(toks, line, from, to, cands, unit, addr, false);
    }
    if (ofBook) return this.drop("unit-of-another-book");
    // the unit's book: named next to it (a tractate for a chapter, a book of the Torah for a parsha),
    // else the book this commentary is on
    if (afterBook && !this.tractateKeys(afterBook.entry.targets).size && !afterBook.entry.targets.some((t) => matches.some((x) => x.unit.book.key === t.book.key))) {
      // "פ' X (ויקרא י, א)": a location of another book follows — the unit alone, the location is its own citation
      afterBook = null;
      addr = null;
    }
    const near = [...(afterBook ? afterBook.entry.targets : []), ...(beforeBook ?? [])];
    const tractates = this.tractateKeys(near);
    const torah = new Set(near.filter((t) => t.collection === "tanakh").map((t) => t.book.key));
    const namedFor = (x: { unit: NamedUnit }) => (x.unit.kind === "chapter" ? tractates : torah);
    // "בפ' כיצד (י"ט ע"א)": a name several tractates share, with a daf after it — the daf tells which
    const dafAfter = !!addr && (addr.elems[0]!.kind === "daf" || addr.elems[0]!.amud !== undefined);
    const byDaf = (list: typeof matches) => {
      const units = list.map((x) => x.unit).filter((u) => u.kind === "chapter" && u.collection === "bavli");
      if (units.length < 2 || new Set(units.map((u) => u.book.key)).size !== units.length) return null;
      const cands = this.own(units.map((u) => ({ book: u.book, tier: "derived" as const, collection: u.collection })));
      if (cands.length !== units.length) return null;
      const end = addr!.bracketed && addr!.closed ? addr!.to + 1 : addr!.to;
      const unit: CitedUnit = { kind: "chapter", name: units[0]!.name, key: toks.slice(head.next, found.to).map((t) => looseWord(t.key)).join(" "), context: "unique", partial: list.some((x) => !x.full), bases: units, ...(found.initials && { initials: true }) };
      return this.emitUnit(toks, line, from, end, cands, unit, addr, true);
    };
    if (matches.some((x) => namedFor(x).size)) {
      matches = matches.filter((x) => namedFor(x).has(x.unit.book.key));
      context = "named";
    } else if (this.baseTractate && matches.some((x) => x.unit.book.key === this.baseTractate)) {
      matches = matches.filter((x) => x.unit.book.key === this.baseTractate);
      context = "base";
    } else if (matches.some((x) => x.full)) {
      // the name alone: the unit whose whole name it is — unless the words also start the names of two
      // or more other units ("ר"פ האשה" may be פסחים' "האשה", or יבמות' "האשה רבה", כתובות' "האשה שנפלו"…)
      if (matches.filter((x) => !x.full).length >= 2) return (dafAfter ? byDaf(matches) : null) ?? this.drop("unit-ambiguous");
      matches = matches.filter((x) => x.full);
    }
    if (matches.length > 1 && matches.some((x) => x.full)) matches = matches.filter((x) => x.full);
    if (matches.length > 1 && dafAfter && context === "unique") {
      const r = byDaf(matches);
      if (r !== null) return r;
    }
    if (matches.length !== 1) return this.drop(matches.length ? "unit-ambiguous" : "unit-not-in-book");
    const u = matches[0]!.unit;
    // the tier of the name that told the book ("יבמות" written as the title), else a derived reading
    const told = context === "named" ? near.find((t) => t.book.key === u.book.key && (t.tier === "title" || t.tier === "derived")) : undefined;
    const candidates = this.own([{ book: u.book, tier: told?.tier ?? "derived", collection: u.collection }]);
    if (!candidates.length) return this.drop("self");
    const end = addr ? (addr.bracketed && addr.closed ? addr.to + 1 : addr.to) : afterBook && !addr ? afterBook.to : found.to;
    const unit: CitedUnit = {
      kind: u.kind,
      name: u.name,
      key: toks.slice(head.next, found.to).map((t) => looseWord(t.key)).join(" "),
      base: u,
      context,
      partial: !matches[0]!.full,
      ...(found.initials && { initials: true }),
    };
    return this.emitUnit(toks, line, from, end, candidates, unit, addr, u.kind === "chapter", bare ? "named-bare" : undefined);
  }

  /**
   * A Bavli chapter by its name with no word for "chapter", glued to ב/ד ("ביש נוחלין (קלח:)", "בהחובל [פ"ז
   * ע"א]", "דהמפקיד (לה.)"): named() on the word without its prefix letters.
   */
  private bareNamed(toks: readonly Tok[], i: number, line: number): number | null {
    const t = toks[i]!;
    if (!this.units?.size || t.kind !== "word" || t.gershayim || t.geresh) return null;
    for (const p of [1, 2]) {
      if (!/^(?:[בד]|ו[בד])$/.test(t.text.slice(0, p)) || t.key.length - p < 2) continue;
      const stripped = [...toks];
      stripped[i] = { ...t, text: t.text.slice(p), key: t.key.slice(p) };
      const r = this.named(stripped, i, line, true);
      if (r !== null) return r;
    }
    return null;
  }

  private emitUnit(toks: readonly Tok[], line: number, from: number, to: number, candidates: readonly AliasTarget[], unit: CitedUnit, addr: Address | null, commentators: boolean, rule?: string): number | null {
    if (isDate(toks, to)) return this.drop("date");
    const next = this.emit(toks, line, {
      from,
      to,
      candidates,
      name: unit.name,
      elems: addr ? addr.elems : [],
      evidence: addr ? addr.evidence : "strong",
      bracketed: !!addr?.closed,
      ibid: "none",
      form: "named",
      numericName: false,
      unit,
      commentators,
      ...(rule && { rule }),
    });
    // "שם" after a unit cited by name alone has no location to complete
    if (!addr) this.last = null;
    return next;
  }

  /** a book named right before toks[i] ("ביבמות פרק", "בזוהר פרשת", "במס' שבת פ'"), with its targets */
  private bookBefore(toks: readonly Tok[], i: number): AliasTarget[] | null {
    // the longest name first: "בתוספות על ברכות פרשת" is not "ברכות"
    for (let j = Math.max(0, i - 4); j < i; j++) {
      const m = this.aliases.matchAt(toks, j).find((x) => x.to === i && (x.prefix === "" || /^ו?[בד]$/.test(x.prefix)));
      if (m) return m.entry.targets;
    }
    return null;
  }

  /** the Bavli books of the tractates among `targets` (a tractate named as the Bavli, the Mishna, "מס' X") */
  private tractateKeys(targets: readonly AliasTarget[]): Set<string> {
    const out = new Set<string>();
    for (const t of targets) {
      if (!TALMUDIC_COLLECTIONS.has(t.collection)) continue;
      const tr = tractateOfTitle(t.book.title, t.collection);
      const b = tr ? this.aliases.tractates.get(tr)?.get("bavli") : undefined;
      if (b) out.add(b.book.key);
    }
    return out;
  }

  /** the Bavli book of the tractate this commentary is on ("… על כתובות", "… על משנה נזיר" → that tractate) */
  private baseTractateCache: string | null | undefined;
  private get baseTractate(): string | null {
    if (this.baseTractateCache === undefined) {
      const on = / על (.+)$/.exec(normTitle(this.sourceTitle))?.[1];
      const targets = on ? (this.aliases.lookup(on)?.targets.filter((t) => t.tier === "title") ?? []) : [];
      this.baseTractateCache = [...this.tractateKeys(targets)][0] ?? null;
    }
    return this.baseTractateCache;
  }

  /**
   * "לעיל כ"ג ע"א", "לקמן ה' ע"ב": a daf of the book this commentary is on ("… על גיטין" → גיטין).
   * Only a daf: "לעיל סי' ג" in a halachic work points back into the work itself.
   */
  private relative(toks: readonly Tok[], i: number, line: number): number | null {
    const t = toks[i]!;
    if (!this.base || t.gershayim || t.geresh) return null;
    // a commentary on the Shulchan Aruch: "בסימן רפ"ו ס"ג", "וכדלקמן בסימן ש"כ" — a siman of the base
    if (this.base.collection === "sa") {
      const at = RELATIVE.test(t.text) ? i + 1 : i;
      const addr = parseAddress(toks, at);
      const e = addr?.elems[0];
      if (!addr || !e || e.kind !== "siman" || !e.explicit || addr.elems.some((x) => x.kind === "sk")) return null;
      // "ובמ"א סימן ז'", "הט"ז לקמן בסימן ח'", "בסימן מ"ח במ"ב סק"א": another book named right before
      // or after the siman is the one meant — not the base
      // (two words back, past "לקמן"/"כמ"ש": "הט"ז לקמן בסימן ח'", "רש"ל בתשובה סימן צ"ז", "לבוש בסימן נ"ח")
      const named = (x: Tok | undefined) => !!x && x.kind === "word" && !RELATIVE.test(x.text) && !COMMON_ABBREVIATIONS.has(wordShape(x)) && (((x.gershayim || x.geresh) && !numeralOf(x)) || OTHER_WORK.test(x.text));
      const titled = (back: number) => {
        const at = beforeIndex(toks, i, back); // its index, not toks.indexOf: that was a scan per marker (A8)
        const x = toks[at];
        return !!x && x.kind === "word" && this.aliases.matchAt(toks, at).length > 0;
      };
      if (named(before(toks, i, 1)) || named(before(toks, i, 2)) || titled(1) || titled(2) || named(toks[addr.to]) || named(toks[addr.to + 1])) return this.drop("siman-of-another-book");
      return this.emit(toks, line, { from: i, to: addr.to, candidates: [this.base], name: t.text, elems: addr.elems, evidence: addr.evidence, bracketed: addr.closed, ibid: "none", form: "relative", numericName: false });
    }
    if (!RELATIVE.test(t.text)) return this.baseDaf(toks, i, line);
    const addr = parseAddress(toks, i + 1, { enclosed: opensBefore(toks, i) });
    if (!addr) return null;
    const e = addr.elems[0]!;
    const isDaf = e.kind === "daf" || (e.kind === "?" && (e.amud !== undefined || e.maybeAmud !== undefined || (addr.elems[1]?.kind === "?" && (addr.elems[1]!.n === 1 || addr.elems[1]!.n === 2) && addr.elems.length === 2)));
    if (!isDaf) return null;
    const to = addr.bracketed && addr.closed ? addr.to + 1 : addr.to;
    return this.emit(toks, line, { from: i, to, candidates: [this.base], name: t.text, elems: addr.elems, evidence: addr.evidence, bracketed: addr.closed, ibid: "none", form: "relative", numericName: false });
  }

  /**
   * "לעיל סי' ה", "לקמן סעיף ג ס"ק ב", "כמ"ש לעיל כלל ז' סי' ח'", "עיין לקמן באות ז": a place in the citing
   * book itself (self.ts). Only with a level named by its word (a bare number, or a daf, says nothing of
   * which level), and not when another book is named next to it ("הט"ז לקמן סי' ח'", "לעיל סי' ה בט"ז")
   * — that is the other book's own "לקמן". Resolved once the whole book was read (engine.ts).
   */
  private internal(toks: readonly Tok[], i: number, line: number): number | null {
    const t = toks[i]!;
    if (!this.selfTarget || t.gershayim || t.geresh || !RELATIVE.test(t.text)) return null;
    const addr = parseAddress(toks, i + 1, { enclosed: opensBefore(toks, i) });
    const e = addr?.elems[0];
    if (!addr || !e || !e.explicit || e.kind === "daf" || e.kind === "?" || addr.elems.some((x) => x.kind === "daf" || x.amud !== undefined)) return null;
    const named = (x: Tok | undefined) => !!x && x.kind === "word" && !RELATIVE.test(x.text) && !COMMON_ABBREVIATIONS.has(wordShape(x)) && (((x.gershayim || x.geresh) && !numeralOf(x) && !LOCATION_WORD.test(wordShape(x))) || OTHER_WORK.test(x.text));
    const titled = (at: number) => at >= 0 && toks[at]?.kind === "word" && this.aliases.matchAt(toks, at).length > 0;
    if (named(before(toks, i, 1)) || named(before(toks, i, 2)) || titled(beforeIndex(toks, i, 1)) || titled(beforeIndex(toks, i, 2))) return this.drop("internal-of-another-book");
    const after = addr.closed ? addr.to + 1 : addr.to;
    if (named(toks[after]) || titled(after)) return this.drop("internal-of-another-book");
    const to = addr.bracketed && addr.closed ? addr.to + 1 : addr.to;
    // "(לעיל פסוק טו)" in a midrash is a verse of the Torah, of a chapter the text does not say: the citation
    // before it was another verse's in two of three cases checked by hand (§6.8) — no link
    if (e.kind === "pasuk") return null;
    const dir = /לעיל$/.test(t.text) ? -1 : 1;
    return this.emit(toks, line, { from: i, to, candidates: [this.selfTarget], name: t.text, elems: addr.elems, evidence: addr.evidence, bracketed: addr.closed, ibid: "none", form: "internal", numericName: false, commentators: false, internal: { dir, here: this.structure.here() } });
  }

  /**
   * A commentator's words on a daf told by the context: "וכתבו בתוס' [ד"ה רבי" after "[יבמות פ"ז ע"ב]",
   * "רש"י שם ד"ה שלא", "ובתוס' שם [ד"ה אבל]", "התוס' בדף ט"ו ע"ב ד"ה במאי", "תוד"ה הן". The commentator's
   * name, maybe "שם", maybe a daf with no tractate, and then "ד"ה" (required: "תוס' שם" alone is often
   * another place). The tractate is the last citation's (a daf of the Bavli, near: as "שם"), or the one this
   * book comments on; the link is to that commentary on the daf (the line of the ד"ה is not looked up).
   */
  private dibur(toks: readonly Tok[], i: number, line: number): number | null {
    const t = toks[i]!;
    const who = wordIn(t, COMMENTATORS);
    if (!who) return null;
    const compact = /^ו?ב?תוד"ה$/.test(wordShape(t).replace(/^ה/, ""));
    let k = i + 1;
    const skip = () => {
      while (toks[k]?.kind === "punct" && "([".includes(toks[k]!.text)) k++;
    };
    if (!compact) {
      skip();
      if (isWord(toks[k], "שם")) k++;
      skip();
    }
    let elems: readonly AddrElem[] | null = null;
    let to = k;
    if (!compact) {
      const addr = parseAddress(toks, k);
      if (addr && addr.elems.length === 1 && (addr.elems[0]!.kind === "daf" || addr.elems[0]!.amud !== undefined)) {
        elems = addr.elems;
        k = addr.to;
        skip();
      }
      const d = toks[k];
      // "ד"ה", or "תוד"ה" after the place ("התוס' [שם פ"ז ע"א [תוד"ה היום]]")
      if (!d || d.kind !== "word" || !d.gershayim || !/^ו?ב?(?:תו)?דה$/.test(d.key)) return null;
    }
    // the ד"ה and the first word of its heading belong to the span
    to = toks[k + (compact ? 0 : 1)]?.kind === "word" ? k + (compact ? 1 : 2) : k + (compact ? 0 : 1);
    const last = this.last && !this.lastFar && line - this.last.line <= this.window ? this.last : null;
    // the last citation's tractate — the one it named, also when it was moved to a commentator ("רש"י ד"ה …, ותוד"ה …")
    const named = (x: { c: Citation }) => (x.c.movedFrom ?? x.c.candidates).filter((y) => y.collection === "bavli");
    const lastDaf = last && last.elems.length && (last.elems[0]!.kind === "daf" || last.elems[0]!.amud !== undefined) && named(last).length ? last : null;
    const books = lastDaf ? named(lastDaf) : this.base?.collection === "bavli" ? [this.base] : null;
    if (!books?.length) return null;
    // no daf written and none before it: in a commentary on the tractate, the daf the citing line is on ("רש"י ד"ה X")
    const here = !elems && !lastDaf ? this.hereDaf() : null;
    const place = elems ?? lastDaf?.elems ?? here;
    if (!place) return null;
    const moved = this.toCommentary(books, who);
    if (!moved.length) return this.drop("commentator-not-in-library");
    const dh = diburWordsAt(toks, compact ? i : k);
    return this.emit(toks, line, { ...(dh && { dh }), from: i, to: Math.max(to, i + 1), candidates: moved, name: wordShape(t), elems: place, evidence: "strong", bracketed: false, ibid: elems || !lastDaf ? "none" : "partial", ...(lastDaf && !elems && { ibidOf: lastDaf.c.seq }), form: "forward", numericName: false, commentators: false, rule: here ? "dibur-here" : "dibur-context", commentator: who, movedFrom: books });
  }

  /**
   * "ד"ה חוץ: דף לה", "וכן בדף מ"ו ע"ב": the word "דף" and a number with no tractate, in a commentary on
   * a tractate ("פסקי תוספות על יבמות") — a daf of that tractate. Only the full word "דף" ("ד'" is also
   * "ארבע"), only a daf, and not when a book we do not know is named right before ("במהרש"א דף ט'").
   * Weaker than "לעיל"/"לקמן" (which say "in this tractate"): the book is inferred, so at most "high".
   */
  private baseDaf(toks: readonly Tok[], i: number, line: number): number | null {
    const t = toks[i]!;
    if (this.base?.collection !== "bavli" || !DAF_WORD.test(t.text) || t.gershayim || t.geresh) return null;
    const addr = parseAddress(toks, i, { enclosed: opensBefore(toks, i) });
    const e = addr?.elems[0];
    if (!addr || !e || e.kind !== "daf" || !e.explicit || addr.elems.length > 1) return null;
    const named = (x: Tok | undefined) => !!x && x.kind === "word" && (x.gershayim || x.geresh) && !numeralOf(x) && !COMMON_ABBREVIATIONS.has(wordShape(x)) && !/^ו?ד"ה$/.test(wordShape(x)) && !wordIn(x, COMMENTATORS) && !wordIn(x, QUALIFIERS);
    if (named(before(toks, i, 1))) return this.drop("daf-of-another-book");
    // "בסוף גיטין מייתי לה הש"ס. [דף פ"ט]": a tractate named a few words before is the daf's book
    for (let j = Math.max(0, i - 8); j < i; j++) if (this.aliases.matchAt(toks, j).some((m) => m.entry.targets.some((x) => x.collection === "bavli"))) return this.drop("daf-of-another-book");
    const to = addr.bracketed && addr.closed ? addr.to + 1 : addr.to;
    return this.emit(toks, line, { from: i, to, candidates: [this.base], name: t.text, elems: addr.elems, evidence: addr.evidence, bracketed: addr.closed, ibid: "none", form: "relative", numericName: false, rule: "base-daf" });
  }

  /**
   * A location in brackets with no book before it — "(א, כ"ז)", "(ל"ב, ה')", "(פסוק כז)", "[מ"ד ע"א]",
   * "(ס"ט:)" — is the book the context gives: the citation right before it, when it is near (the same
   * line, or the last few lines with no heading between) and of the same shape (a daf after a daf; chapter
   * and verse after a chapter-and-verse book); else, for chapter and verse, the book of the Torah the
   * headings above name ("ספר בראשית", "פרשת וירא"), or the book of the Tanakh this one comments on; for
   * a daf, the tractate this one comments on. Read as "שם" without the word, so at most "high".
   */
  private implicit(toks: readonly Tok[], i: number, line: number): number | null {
    const t = toks[i]!;
    if (!opensBefore(toks, i) || t.kind === "punct" || isWord(t, "שם")) return null;
    // "(מ"א ה)": a book of the Tanakh by its numeral name (numericTanakh), not a place
    if (t.kind === "word" && Object.hasOwn(NUMERIC_TANAKH, wordShape(t))) return null;
    const addr = parseAddress(toks, i, { enclosed: true });
    if (!addr || !addr.closed) return null;
    const es = addr.elems;
    const isDafElem = (e: AddrElem) => e.kind === "daf" || e.amud !== undefined;
    const daf = es.length === 1 && isDafElem(es[0]!) && (es[0]!.amud !== undefined || es[0]!.explicit);
    const pair = es.length === 2 && es.every((e) => e.kind === "?" && e.amud === undefined && e.maybeAmud === undefined && e.to === undefined);
    const verse = (es.length === 1 && es[0]!.kind === "pasuk") || (es.length === 2 && es[0]!.kind === "perek" && es[1]!.kind === "pasuk");
    if (!daf && !pair && !verse) return null;
    if (isDate(toks, addr.to + 1)) return null;
    // "[ג.] מכות דף ו'": a bracket opening the line, or followed by a book's name, marks the book's own
    // sections (כסף נבחר), not a place of the citation before it
    const after = toks[addr.closed ? addr.to + 1 : addr.to];
    if (toks.slice(0, i).every((x) => x.kind === "punct") || (after?.kind === "word" && this.aliases.matchAt(toks, addr.closed ? addr.to + 1 : addr.to).length)) return null;
    // "פ' ד' אחין ([ד' ל"ב])": a chapter or a book named just before is the place's own, read with it or not at all
    for (let j = Math.max(0, i - 6); j < i - 1; j++) if (unitWordAt(toks, j) || perekAt(toks, j) || this.aliases.matchAt(toks, j).length) return null;
    const last = this.last && line - this.last.line <= IMPLICIT_WINDOW ? this.last : null;
    // a verse alone ("([פסוק ה])"): in a midrash the citation before it is often a verse quoted from another
    // book or chapter (§6.8) — no link
    if (verse && es.length === 1) return null;
    // "בע"ג ([מ"ו.])", "וההיא דבתרא ([דף ל"ב])": a name right before the bracket is the place's own book
    const prevWord = before(toks, i, 1);
    if (prevWord?.kind === "word" && (((prevWord.gershayim || prevWord.geresh) && !numeralOf(prevWord) && !COMMON_ABBREVIATIONS.has(wordShape(prevWord))) || TRACTATE_NICKNAMES.test(prevWord.text))) return null;
    // "כביבמות ([צ.])": a tractate with prefix letters matchAt does not take ("כב", "וכב")
    if (prevWord?.kind === "word" && !prevWord.gershayim && [2, 3].some((p) => /^[וכבדלמה]+$/.test(prevWord.text.slice(0, p)) && this.aliases.lookup(prevWord.text.slice(p))?.targets.some((x) => x.collection === "bavli" || x.collection === "tanakh"))) return null;
    if (last && last.elems.length && !last.c.internal) {
      const lastDaf = isDafElem(last.elems[0]!);
      const sameShape = daf ? lastDaf && last.c.candidates.some((x) => x.collection === "bavli") : !lastDaf && (last.line === line || last.c.candidates.every((x) => x.collection === "tanakh"));
      const elems = sameShape ? mergeIbid(last.elems, es) : null;
      // chapter and verse in the same line as a citation of the Tanakh: "high"; anything farther — a daf ("בסוף
      // השולח (דף מ"ח)" names its own tractate by a chapter's name), or a verse a line or more after another
      // book's ("(ל"ב, ח')" after Psalms, in a book on the Torah) — "possible" (hand check, §6.8)
      const near = !daf && last.line === line && last.c.candidates.every((x) => x.collection === "tanakh");
      // in a book on the Torah, a verse farther from the last citation is the Torah's (the headings say which book)
      const ctxFirst = !daf && !near ? this.contextBook() : null;
      if (elems && !ctxFirst) return this.emit(toks, line, { from: i, to: addr.to, candidates: last.c.candidates, name: "", elems, evidence: addr.evidence, bracketed: true, ibid: "partial", ibidOf: last.c.seq, form: "forward", numericName: false, rule: near ? "implicit-previous" : "implicit-previous-far" });
    }
    const ctx = daf ? (this.base?.collection === "bavli" ? this.base : null) : verse && es.length === 1 ? null : this.contextBook();
    if (!ctx) return null;
    // a book named a few words before is the location's book, not the context's ("בסוף גיטין … [דף פ"ט]")
    for (let j = Math.max(0, i - 8); j < i; j++) if (this.aliases.matchAt(toks, j).length) return null;
    const prev = before(toks, i, 1);
    if (prev?.kind === "word" && (prev.gershayim || prev.geresh) && !numeralOf(prev) && !COMMON_ABBREVIATIONS.has(wordShape(prev))) return null;
    const cands = this.own([ctx]);
    if (!cands.length) return null;
    return this.emit(toks, line, { from: i, to: addr.to, candidates: cands, name: "", elems: es, evidence: addr.evidence, bracketed: true, ibid: "none", form: "forward", numericName: false, commentators: false, rule: "implicit-context" });
  }

  /** the book of the Tanakh the context names: a heading above ("ספר שמות", "פרשת וירא"), else the book this one comments on */
  private contextCache: AliasTarget | null | undefined;
  private contextBook(): AliasTarget | null {
    if (this.contextCache !== undefined) return this.contextCache;
    let found: AliasTarget | null = null;
    for (const name of this.structure.names().reverse()) {
      const n = normTitle(name).replace(/^ספר /, "");
      const book = this.aliases.lookup(n)?.targets.find((x) => x.tier === "title" && x.collection === "tanakh");
      if (book) {
        found = book;
        break;
      }
      const parsha = /^פרשת (.+)$/.exec(n)?.[1];
      if (parsha && this.units?.size) {
        const toks = citationTokens(parsha);
        const m = this.units.matchAt(toks, 0, ["parsha"]);
        const full = m && m.to === toks.length ? m.matches.filter((x) => x.full) : [];
        if (full.length === 1) {
          found = { book: full[0]!.unit.book, tier: "derived", collection: "tanakh" };
          break;
        }
      }
    }
    if (!found) {
      const on = / על (.+)$/.exec(normTitle(this.sourceTitle))?.[1];
      found = (on && this.aliases.lookup(on)?.targets.find((x) => x.tier === "title" && x.collection === "tanakh")) || null;
    }
    return (this.contextCache = found);
  }

  /** "(שם)", "(שם ד)", "שם פסוק ד", "שם דף ה ע"ב" at toks[i]. */
  private ibid(toks: readonly Tok[], i: number, line: number): number | null {
    const t = toks[i]!;
    if (!this.last || (t.text !== "שם" && t.text !== "ושם") || t.gershayim || t.geresh) return null;
    // "הפ"ת שם סק"ט": "שם" after a name we do not know refers to THAT book, not to our last citation
    const prev = toks[i - 1];
    if (prev?.kind === "word" && (prev.gershayim || prev.geresh) && !numeralOf(prev) && !this.aliases.matchAt(toks, i - 1).length) return this.drop("ibid-other-book");
    // …and so does "המ"ל (שם)", "הרשב"א [שם]", "הרמב"ם ז"ל (שם)": an author's name before the bracket
    // (past ז"ל) — a quoted name with the article, or a commentator's ("רש"י (שם)")
    let at = beforeIndex(toks, i, 1);
    if (at >= 0 && HONORIFICS.has(wordShape(toks[at]!))) at = beforeIndex(toks, i, 2);
    const author = at >= 0 && at < i - 1 ? toks[at] : undefined;
    const quotedAuthor = author?.kind === "word" && author.gershayim && author.text[0] === "ה" && !NOT_AUTHORS.has(wordShape(author));
    if (author?.kind === "word" && !numeralOf(author) && !this.aliases.matchAt(toks, at).length && (quotedAuthor || wordIn(author, COMMENTATORS) || wordIn(author, QUALIFIERS) === "rambam")) return this.drop("ibid-other-book");
    const inBracket = toks[i - 1]?.kind === "punct" && "([".includes(toks[i - 1]!.text);
    const side = this.ibidAmud(toks, i, line, inBracket);
    if (side !== undefined) return side;
    // "(שם שם לב)": the same book and the same chapter — the numbers replace the deepest level
    // "(שם שם לב)", "(שם, שם, י"ח)"
    const twice = isWord(toks[i + 1], "שם") ? 1 : toks[i + 1]?.kind === "punct" && toks[i + 1]!.text === "," && isWord(toks[i + 2], "שם") ? 2 : 0;
    const addr = parseAddress(toks, i + 1 + twice, { enclosed: inBracket });
    if (this.lastFar && !addr) return null;
    if (!addr) {
      // only "(שם)" — a bare "שם" in running text is the word "there"/"name"
      if (inBracket && closesAt(toks, i + 1)) return this.emit(toks, line, { from: i, to: i + 1, candidates: this.last.c.candidates, name: "שם", elems: this.last.elems, evidence: "strong", bracketed: true, ibid: "full", ibidOf: this.last.c.seq, form: "forward", numericName: false, ...(this.last.c.internal && { internal: this.last.c.internal }) });
      return null;
    }
    if (!inBracket && addr.evidence !== "strong") return null;
    const elems = mergeIbid(this.last.elems, addr.elems);
    if (!elems) return this.drop("ibid-shape");
    return this.emit(toks, line, { from: i, to: addr.to, candidates: this.last.c.candidates, name: "שם", elems, evidence: addr.evidence, bracketed: inBracket || addr.bracketed, ibid: "partial", ibidOf: this.last.c.seq, form: "forward", numericName: false, ...(this.last.c.internal && { internal: this.last.c.internal }), ...((this.lastFar || t.text === "ושם" || twice === 2) && { rule: this.lastFar ? "ibid-far" : "ibid-v4" }) });
  }

  /** The siman the citing line is on: the first level of its own reference, when it is a number ("משנה ברורה, תמה, א" → 445). */
  private hereSiman(): number | null {
    const k = this.structure.here().keys?.[0];
    return k && /^n\d+$/.test(k) ? Number(k.slice(1)) : null;
  }

  /**
   * The daf the citing line is on, from its own reference, in a commentary on a tractate ("תוספות על בבא
   * קמא, כג:, ב" → כג:), or null.
   */
  private hereDaf(): AddrElem[] | null {
    if (this.base?.collection !== "bavli") return null;
    const key = this.structure.here().keys?.find((k) => /^d\d+[ab]$/.test(k));
    if (!key) return null;
    const n = Number(key.slice(1, -1));
    return [{ kind: "daf", n, amud: key.endsWith("a") ? 1 : 2, explicit: true, numeral: { n, form: "gershayim", common: false } }];
  }

  /**
   * "ושם ע"ב ד"ה אלא", "(שם ע"א)": the other amud of the last citation's daf. With a ד"ה after it, only when the
   * last citation was a commentator's (its words on that amud); a ד"ה with no commentator is dropped as usual.
   * Undefined when this is not "שם" and an amud alone.
   */
  private ibidAmud(toks: readonly Tok[], i: number, line: number, inBracket: boolean): number | null | undefined {
    const a = amudOnlyAt(toks, i + 1);
    const last = this.last;
    if (!a || !last || this.lastFar) return undefined;
    const prev = last.elems[0];
    // "התוס' ע"ז כ"ו א' ד"ה … ושם ע"ב ד"ה": the daf may have been written with a lone amud letter
    const letterAmud = last.elems.length === 2 && prev?.kind === "?" && last.elems[1]!.kind === "?" && last.elems[1]!.n <= 2 && last.elems[1]!.numeral.form !== "gershayim" && last.c.candidates.some((c) => c.collection === "bavli");
    if (!prev || (last.elems.length !== 1 && !letterAmud) || (!letterAmud && prev.kind !== "daf" && prev.amud === undefined)) return undefined;
    const to = i + 1 + a[1];
    const dh = diburWordsAt(toks, to);
    if (dh && !last.c.commentator) return this.drop("dibur-without-commentator");
    const elems: AddrElem[] = [{ ...prev, kind: "daf", amud: a[0], explicit: true }];
    const { maybeAmud: _m, amudGlued: _g, ...daf } = elems[0]!;
    return this.emit(toks, line, { from: i, to: dh ? Math.min(to + 2, toks.length) : to, candidates: last.c.candidates, name: "שם", elems: [daf], evidence: "strong", bracketed: inBracket, ibid: "partial", ibidOf: last.c.seq, form: "forward", numericName: false, rule: "ibid-amud", ...(last.c.commentator && { commentator: last.c.commentator, ...(dh && { dh }), ...(last.c.movedFrom && { movedFrom: last.c.movedFrom }) }), ...(last.c.internal && { internal: last.c.internal }) });
  }

  /**
   * A commentary named right before the citation by one of its names in the library — an acronym
   * ("אוה"ח", "גו"א", "רמב"ן") the database gives to "<author> על <book>" — when that commentary is on the
   * cited book: the citation is its words there. Only quoted acronyms (a plain word is too often running text).
   */
  private libraryCommentaryBefore(toks: readonly Tok[], from: number, candidates: readonly AliasTarget[]): { name: string; targets: AliasTarget[] } | null {
    const at = beforeIndex(toks, from, 1);
    const last = toks[at];
    if (at < 0 || last?.kind !== "word" || !last.gershayim || numeralOf(last)) return null;
    for (let start = Math.max(0, at - 2); start <= at; start++) {
      for (const m of [...this.aliases.matchAt(toks, start), ...this.aliases.authorNamesAt(toks, start)]) {
        // "וכמ"ש בשבת (פט.)" is "as written", not כ + "מ"ש" (מלאכת שלמה)
        if (m.to !== at + 1 || m.prefix.includes("כ") || RUNNING_TEXT_NAMES.has(m.entry.text) || COMMON_ABBREVIATIONS.has(wordShape(toks[start]!))) continue;
        const targets: AliasTarget[] = [];
        for (const c of candidates) {
          const on = this.aliases.commentariesOn.get(c.book.title.replace(/[״]/g, '"')) ?? [];
          // the acronym must be the AUTHOR's initials ("אוה"ח" — אור החיים): book_acronym also gives "לח"מ" to לחם שמים
          const letters = keyOfName(m.entry.text).replace(/ /g, "");
          for (const t of m.entry.targets) {
            const x = on.find((y) => y.book.key === t.book.key);
            if (!x || targets.some((y) => y.book.key === t.book.key)) continue;
            const author = keyOfName(x.author).replace(/^ה(?=\S)/, "").split(" ");
            if (author.join("") === letters || abbreviates(letters, author)) targets.push({ book: t.book, tier: c.tier, collection: c.collection });
          }
        }
        const own = this.own(targets);
        if (own.length) return { name: m.entry.text, targets: own };
      }
    }
    return null;
  }

  /** the targets without the source book itself */
  private own(targets: readonly AliasTarget[]): AliasTarget[] {
    return targets.filter((t) => t.book.key !== this.sourceKey);
  }

  private emit(
    toks: readonly Tok[],
    line: number,
    c: {
      from: number;
      to: number;
      candidates: readonly AliasTarget[];
      name: string;
      elems: readonly AddrElem[];
      evidence: Address["evidence"];
      bracketed: boolean;
      ibid: IbidKind;
      ibidOf?: number;
      form: Citation["form"];
      numericName: boolean;
      m?: AliasMatch;
      unit?: CitedUnit;
      /** a commentator's name before it retargets the citation (default true) */
      commentators?: boolean;
      /** the rule that read it, beyond its form (Citation.rule) */
      rule?: string;
      ordinal?: boolean;
      internal?: InternalRef;
      /** the citation was already moved to this commentator's book */
      commentator?: string;
      /** the words of the ד"ה after it */
      dh?: readonly string[];
      /** the books named before the citation was moved to a commentator */
      movedFrom?: readonly AliasTarget[];
    },
  ): number | null {
    // "אם ישב בסוכה ח' ימים", "עד שבועות מ"ד ימים": numbers followed by what they count are a quantity, not a place
    const lastElem = c.elems.at(-1);
    if (!c.bracketed && lastElem && !lastElem.explicit && lastElem.amud === undefined && countedAt(toks, c.to)) return this.drop("quantity");
    let candidates = c.candidates;
    let movedFrom = c.movedFrom;
    const qualifier = qualifierBefore(toks, c.from);
    let commentator: string | undefined = c.commentator;
    let rule = c.rule;
    let diburWords: readonly string[] | null = c.dh ?? null;
    if ((c.ibid === "none" || c.ibid === "book") && c.commentators !== false) {
      // "בירושלמי פ"ח דכתובות": the qualifier adds that collection's book of the same tractate
      if (qualifier && !candidates.some((x) => x.collection === qualifier)) candidates = [...candidates, ...this.siblings(candidates, qualifier)];
      // a commentator named right before ("תוס' פסחים ל"א") or right after ("לעיל כ"ג ע"א תוס' ד"ה"):
      // the citation points into that commentary
      const before = commentatorBefore(toks, c.from);
      // after the place, only with its ד"ה or "שם" ("לעיל כ"ג ע"א תוס' ד"ה", "(דף ל) בתוס' שם"): "(ב"מ פד:),
      // כרש"י ובעלי התוספות" is a comparison, not the commentary's words on the daf
      const afterAny = before ? undefined : commentatorAfter(toks, c.to);
      // "זבחים מ"ו ב' תוד"ה אבל": the commentator's word is itself the ד"ה
      const after = afterAny && (isDibur(toks, afterAny.next) || isWord(toks[afterAny.next], "שם") || diburWordsAt(toks, afterAny.next - 1)) ? afterAny : undefined;
      const who = before ?? after?.who;
      let lib: { name: string; targets: AliasTarget[] } | null = null;
      const dh = isDibur(toks, after ? after.next : c.to);
      const named = candidates.some((x) => / על /.test(x.book.title));
      // "תוס' (מנחות צג.) ד"ה X", "יבמות מ"ז ע"ב תוד"ה במקום": the words of the ד"ה
      if (who && !named) diburWords = diburWordsAt(toks, after ? after.next : c.to) ?? (after ? diburWordsAt(toks, after.next - 1) : null);
      if (who && !named) {
        const moved = this.toCommentary(candidates, who);
        if (!moved.length) {
          this.drop("commentator-not-in-library");
          return c.to;
        }
        movedFrom = candidates;
        candidates = moved;
        commentator = who;
      } else if (!named && (lib = this.libraryCommentaryBefore(toks, c.from, candidates)) !== null) {
        // "ובאוה"ח [שמות ג, ד]", "ובגו"א [ויקרא פ"א]": a commentary's name in the library, on the cited book
        movedFrom = candidates;
        candidates = lib.targets;
        commentator = lib.name;
        rule = rule ?? "commentator-named";
        if (dh) diburWords = diburWordsAt(toks, c.to);
      } else if (dh && !named) {
        this.drop("dibur-without-commentator");
        return c.to;
      } else if (!who && this.titleCommentator && candidates.length && candidates.every((x) => x.collection === "bavli" || x.collection === "tanakh")) {
        // a glossary of a commentator's words ("אוצר לעזי רש"י"): "(חולין פד:)" is where HE wrote it
        const moved = this.toCommentary(candidates, this.titleCommentator);
        if (moved.length) {
          movedFrom = candidates;
          candidates = moved;
          commentator = this.titleCommentator;
          rule = "title-commentator";
        }
      } else if (!who && candidates.length && candidates.every((x) => x.collection === "rambam")) {
        // "המל"מ [בפ"א מהל' תמידין]", "הראב"ד פי"ו מאישות": a commentary on the Rambam named right before —
        // its words on that chapter; when the library does not have it, the Rambam's chapter stays
        const rc = rambamCommentatorBefore(toks, c.from, c.form === "reversed");
        const moved = rc ? this.toCommentary(candidates, rc) : [];
        if (moved.length) {
          candidates = moved;
          commentator = rc;
        }
      }
    }
    candidates = [...candidates].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
    const first = toks[c.from]!;
    const lastTok = toks[c.to - 1]!;
    const cit: Citation = {
      seq: this.seq++,
      line,
      rawStart: first.rawStart,
      rawEnd: lastTok.rawEnd,
      text: toks.slice(c.from, c.to).map((t) => wordShape(t)).join(" "),
      candidates,
      name: c.name,
      elems: c.elems,
      evidence: c.evidence,
      bracketed: c.bracketed,
      ibid: c.ibid,
      ...(c.ibidOf !== undefined && { ibidOf: c.ibidOf }),
      form: c.form,
      ...(qualifier && { qualifier }),
      ...(commentator && { commentator }),
      ...(commentator && movedFrom && { movedFrom }),
      ...(c.unit && { unit: c.unit }),
      ...(rule && { rule }),
      ...(c.ordinal && { ordinal: true }),
      ...(c.internal && { internal: c.internal }),
      ...(commentator && diburWords?.length && { dh: diburWords }),
      numericName: c.numericName,
    };
    this.citations.push(cit);
    this.last = { c: cit, line, elems: c.elems };
    return c.to;
  }

  /** "תוס'" + a citation of כתובות → "תוספות על כתובות", when the library has it. */
  private toCommentary(candidates: readonly AliasTarget[], who: string): AliasTarget[] {
    const exact: AliasTarget[] = [];
    const loose: AliasTarget[] = [];
    const whoKey = keyOfName(who);
    for (const c of candidates) {
      const list = (this.aliases.commentariesOn.get(c.book.title.replace(/[״]/g, '"')) ?? []).filter((x) => x.book.key !== this.sourceKey);
      // the commentary whose author IS the name ("תוספות", "רש"י"); else one whose author has it as a word
      // ("חידושי הרמב"ן"); several → all of them (resolution calls a tie ambiguous)
      const same = list.filter((x) => keyOfName(x.author) === whoKey);
      for (const x of same) exact.push({ book: x.book, tier: c.tier, collection: c.collection });
      if (!same.length) for (const x of list.filter((x) => keyOfName(x.author).split(" ").some((k) => k === whoKey || k === `ה${whoKey}`))) loose.push({ book: x.book, tier: c.tier, collection: c.collection });
    }
    // "התוס' בפ"ב דע"ז": תוספות on the Gemara, not תוספות יום טוב on the Mishna of the same name — an author who
    // IS the name, on one of the books, wins over authors who only have it as a word
    return exact.length ? exact : loose;
  }

  /** the book of the same tractate in another collection (the Yerushalmi of כתובות…) */
  private siblings(candidates: readonly AliasTarget[], coll: Collection): AliasTarget[] {
    const out: AliasTarget[] = [];
    for (const c of candidates) {
      const t = tractateOfTitle(c.book.title, c.collection);
      const sib = t ? this.aliases.tractates.get(t)?.get(coll) : undefined;
      if (sib && sib.book.key !== this.sourceKey && !out.some((x) => x.book.key === sib.book.key)) out.push(sib);
    }
    return out;
  }

  get lastLine(): number {
    return this.lastLineSeen;
  }
}

const keyOfName = (s: string): string => unifyFinals(s.replace(/["'׳״]/g, "")).replace(/\s+/g, " ").trim();

/** The part of the Shulchan Aruch a commentary on it is on ("שולחן ערוך, אורח חיים"), or null. */
function saBaseOf(title: string): string | null {
  const t = normTitle(title);
  if (Object.hasOwn(SA_COMMENTARY_BASE, t)) return SA_COMMENTARY_BASE[t]!;
  const part = / על שולחן ערוך,? (.+)$/.exec(t)?.[1];
  return part ? `שולחן ערוך, ${part}` : null;
}

/** the commentaries on the Shulchan Aruch whose titles do not say so */
const SA_COMMENTARY_BASE: Readonly<Record<string, string>> = {
  "משנה ברורה": "שולחן ערוך, אורח חיים",
  "מגן אברהם": "שולחן ערוך, אורח חיים",
  "ביאור הלכה": "שולחן ערוך, אורח חיים",
  "שער הציון": "שולחן ערוך, אורח חיים",
};

/**
 * The book a commentary is on — the target of "לעיל/לקמן <daf>" (a tractate) and of a bare "סימן"
 * (the Shulchan Aruch): "… על גיטין" → גיטין; "… על שולחן ערוך אורח חיים" → "שולחן ערוך, אורח חיים".
 */
function baseOf(aliases: AliasIndex, sourceTitle: string): AliasTarget | null {
  const title = sourceTitle.replace(/[״]/g, '"');
  const on = / על (.+)$/.exec(title)?.[1];
  const names = [on, on && /^שולחן ערוך (.+)$/.exec(on) ? `שולחן ערוך, ${on.slice("שולחן ערוך ".length)}` : undefined, Object.hasOwn(SA_COMMENTARY_BASE, title) ? SA_COMMENTARY_BASE[title] : undefined];
  for (const n of names) {
    if (!n) continue;
    const t = aliases.lookup(n)?.targets.find((x) => x.tier === "title" && (x.collection === "bavli" || x.collection === "sa"));
    if (t) return t;
  }
  return null;
}

/** names that are far more often words of running text when they open a citation: "מ"ש" (מעשר שני / מה שכתב) */
const RUNNING_TEXT_NAMES = new Set(['מ"ש']);

/** quoted abbreviations of running text that name no book ("כמ"ש בסימן…", "ע"ש") */
const COMMON_ABBREVIATIONS = new Set(['כמ"ש', 'וכמ"ש', 'כמש"כ', 'וכמש"כ', 'ע"ש', 'וע"ש', 'עיי"ש', "וכו'", "כו'", 'א"כ', 'מ"מ', 'הנ"ל', 'כנ"ל', 'ז"ל', 'ע"פ', "עי'", "ועי'", 'ס"ל', 'דס"ל', 'וכ"כ', 'כ"כ', "כדאי'", "עיין", 'ר"ל', 'ג"כ', 'וכ"ש', 'כ"ש', "אפי'", "ואפי'"]);
/** quoted words with the article that are not an author ("הנ"ל", "ה"ה" — הוא הדין) */
const NOT_AUTHORS = new Set(['הנ"ל', 'ה"ה', 'הנז"ל', 'הע"ה']);
/** honorifics after an author's name ("הרמב"ם ז"ל (שם)") */
const HONORIFICS = new Set(['ז"ל', 'זצ"ל', 'ז"ל:', 'נ"י', 'שליט"א', 'זלה"ה', 'ע"ה']);
/** words that name another work before a siman ("בתשובה סימן צ"ז") */
const OTHER_WORK = /^[וב]{0,2}(?:תשובה|תשובות|תשו|ספר|ס|שו"ת|שות)$/;

/** a location word with quote marks ("ס"ק", "סי'", "הל'"): not another book's name before an internal reference */
const LOCATION_WORD = /^[ובד]{0,2}(?:ס"ק|סק'|סי'|סע'|סעי'|הל'|פ'|פר'|ס"ס|ססי'|או')$/;

/** words for "responsa" before or after an author's name ("בתשו'", "בתשובת", "שו"ת", "בתשובות") */
const RESPONSA_WORD = /^[ובלד]{0,2}(?:תשו'|תשובת|תשובות|תשובה|שו"ת|שות|בתשו')$/;
/** authors whose name alone names many works ("רמ"א סי' נ"ג" is the Shulchan Aruch's gloss): only with a word for responsa */
const AUTHOR_NAMES_KEYS = new Set(["רמבמ", "רמבנ", "רמא", "רשבא", "ראש", "ריטבא", "רנ", "ריפ", "רשי", "מהרשא", "מהרשל", "רשבמ", "ראבד", "רמ"]);

/** an author with more other works than this: his name alone and a siman are no reference to his responsa */
const MAX_OTHER_WORKS = 3;

/** past the ibid window, how far "שם" with a place of its own (or "<book> שם") may still reach, scored lower */
const FAR_WINDOW = 15;

/** "בבתרא", "דקמא", "במציעא": a tractate by its nickname (the Bavot), right before a place */
const TRACTATE_NICKNAMES = /^[ובד]{0,2}(?:בתרא|קמא|מציעא)$/;

/** how many lines back a bare location in brackets may take its book from the citation before it */
const IMPLICIT_WINDOW = 3;

/** the word "דף" with a ב/ו ("בדף", "ובדף") — not "ד'" */
const DAF_WORD = /^(?:ו?ב)?דף$/;

/** "לעיל", "לקמן", with a prefix ("ולקמן", "דלעיל", "כדלקמן") */
const RELATIVE = /^(?:[ודכ]{0,2})(?:לעיל|לקמן|להלן)$/;

/** the tractate of a Talmud/Mishna title (the inverse of the derived names) */
function tractateOfTitle(title: string, coll: Collection): string | null {
  const t = title.replace(/[״]/g, '"');
  if (coll === "bavli") return t;
  if (coll === "mishna") return t.replace(/^משנה /, "");
  if (coll === "yerushalmi") return t.replace(/^תלמוד ירושלמי /, "");
  if (coll === "tosefta") return t.replace(/^תוספתא /, "");
  return null;
}

/** A part of the Tur / Shulchan Aruch at toks[i] ("או"ח", "חו"מ", "אורח חיים"). */
function sectionAt(toks: readonly Tok[], i: number): { part: string; next: number } | null {
  const t = toks[i];
  if (!t || t.kind !== "word") return null;
  // "ב"ח בח"מ סי' רמ"ב": the part may carry a ב
  const shape = wordShape(t);
  const one = /^ב./.test(shape) && Object.values(SA_PARTS).some((n) => n.includes(shape.slice(1))) ? shape.slice(1) : shape;
  const two = toks[i + 1]?.kind === "word" ? `${one} ${wordShape(toks[i + 1]!)}` : "";
  for (const [part, names] of Object.entries(SA_PARTS)) {
    if (two && names.includes(two)) return { part, next: i + 2 };
    if (names.includes(one)) return { part, next: i + 1 };
  }
  return null;
}

/** A part given after the name: a Shulchan Aruch book must BE that part; another book gets it as its first level. */
function withSection(cands: readonly AliasTarget[], part: string): AliasTarget[] {
  const out: AliasTarget[] = [];
  for (const c of cands) {
    // a book named for one part (שולחן ערוך, יורה דעה; ש"ך על … יורה דעה) must be THAT part
    const named = Object.keys(SA_PARTS).find((p) => c.book.title.includes(p));
    if (named) {
      if (named === part) out.push(c);
    } else out.push({ ...c, section: part });
  }
  return out;
}

const isOpen = (t: Tok | undefined): boolean => t?.kind === "punct" && "([".includes(t.text);

/**
 * A bracket opens right before toks[i] — or before a word for "see" there: "(עיין שבת נה)", "(ועי' ב"ק
 * כג:)" are bracketed citations as much as "(שבת נה)".
 */
const opensBefore = (toks: readonly Tok[], i: number): boolean => isOpen(toks[i - 1]) || (isOpen(toks[i - 2]) && toks[i - 1]?.kind === "word" && SEE_WORDS.has(wordShape(toks[i - 1]!)));

/** words for "see" that open a bracketed citation ("(עיין שבת נה)") */
const SEE_WORDS: ReadonlySet<string> = new Set(["עיין", "ועיין", "עי'", "ועי'", "ע'", "וע'", "עיי'", "ועיי'", "ראה", "וראה", "יעויין", "ויעויין", "יעוין", "ויעוין", "עיינן"]);

const isWord = (t: Tok | undefined, text: string): boolean => t?.kind === "word" && t.text === text && !t.gershayim && !t.geresh;

/** "בשבת ט"ו בשבט", "ר"ה תש"פ": a date, not a citation */
function isDate(toks: readonly Tok[], i: number): boolean {
  // "בשבת כ"ח יום לשבט": a month within the next three words
  for (let j = i; j < i + 3; j++) {
    const t = toks[j];
    if (!t || t.kind !== "word") return false;
    if (MONTHS.has(t.key) || (t.key.length > 2 && MONTHS.has(t.key.slice(1)))) return true;
  }
  return false;
}

/**
 * The words of a ד"ה at toks[j] ("ד"ה רבי מאיר", "תוד"ה במקום", past a closing bracket or a comma): up to
 * four words, to the first punctuation. Null when there is no ד"ה there.
 */
function diburWordsAt(toks: readonly Tok[], j: number): string[] | null {
  while (toks[j]?.kind === "punct" && ")],[(".includes(toks[j]!.text)) j++;
  const t = toks[j];
  if (!t || t.kind !== "word" || !t.gershayim || !/^ו?ב?(?:ה?תו)?דה$/.test(t.key)) return null;
  const out: string[] = [];
  for (let k = j + 1; k < toks.length && out.length < 4; k++) {
    const w = toks[k]!;
    if (w.kind !== "word") break;
    out.push(w.key);
  }
  return out.length ? out : null;
}

/** "ד"ה" (dibur hamatchil) right after the location */
function isDibur(toks: readonly Tok[], i: number): boolean {
  let j = i;
  if (toks[j]?.kind === "punct" && ")]".includes(toks[j]!.text)) j++;
  if (toks[j]?.kind === "punct" && toks[j]!.text === ",") j++;
  const t = toks[j];
  return !!t && t.kind === "word" && t.gershayim && /^ו?ב?דה$/.test(t.key);
}

/** the word right before the citation (skipping one opening bracket) */
function before(toks: readonly Tok[], i: number, back = 1): Tok | undefined {
  const at = beforeIndex(toks, i, back);
  return at < 0 ? undefined : toks[at];
}

/** the index of that word, or -1 */
function beforeIndex(toks: readonly Tok[], i: number, back = 1): number {
  let j = i - 1;
  let seen = 0;
  while (j >= 0) {
    const t = toks[j]!;
    if (t.kind === "punct") {
      if (!"([,".includes(t.text)) return -1;
      j--;
      continue;
    }
    if (++seen === back) return j;
    j--;
  }
  return -1;
}

function qualifierBefore(toks: readonly Tok[], i: number): Collection | undefined {
  for (let back = 1; back <= 2; back++) {
    const q = wordIn(before(toks, i, back), QUALIFIERS);
    if (q) return q;
  }
  return undefined;
}

function commentatorBefore(toks: readonly Tok[], i: number): string | undefined {
  const t = before(toks, i, 1);
  // "התוס' בסוף פ"א דביצה", "רש"י ריש פ"ב": a word for where in the chapter between them
  if (t?.kind === "word" && !t.gershayim && !t.geresh && POSITION_BEFORE.test(t.text)) return wordIn(before(toks, i, 2), COMMENTATORS) ?? undefined;
  return wordIn(t, COMMENTATORS) ?? undefined;
}

/**
 * The commentaries on the Rambam by the names books cite them ("המל"מ", "הלח"מ", "הכ"מ", "הראב"ד", "המ"מ"), as
 * the library's "<author> על משנה תורה, …" write the author. "כ"מ" and "מ"מ" are also "וכן משמע", "מכל מקום":
 * only with the article.
 */
const RAMBAM_COMMENTATORS: readonly (readonly [string, string, boolean])[] = [
  ['מל"מ', "משנה למלך", false], ["משנה למלך", "משנה למלך", false],
  ['לח"מ', "לחם משנה", false], ["לחם משנה", "לחם משנה", false],
  ['כ"מ', "כסף משנה", true], ["כסף משנה", "כסף משנה", false],
  ['מ"מ', "מגיד משנה", true], ["מגיד משנה", "מגיד משנה", false], ['ה"ה', "מגיד משנה", false],
  ['ראב"ד', 'השגות הראב"ד', false], ["השגות", 'השגות הראב"ד', false],
  ["אור שמח", "אור שמח", false],
];

/** a two-word name of a Rambam commentator starting at toks[i] ("בכסף משנה", "ולחם משנה"), with ו/ב/ל/ד */
function rambamCommentatorAt(toks: readonly Tok[], i: number): boolean {
  const a = toks[i];
  const b = toks[i + 1];
  if (a?.kind !== "word" || b?.kind !== "word" || a.gershayim || a.geresh) return false;
  for (const [name] of RAMBAM_COMMENTATORS) {
    const words = name.split(" ");
    if (words.length !== 2 || wordShape(b) !== words[1]) continue;
    for (let p = 0; p <= 2; p++) {
      if (p && !/^[ובלד]$/.test(a.text[p - 1]!)) break;
      if (a.text.slice(p) === words[0]) return true;
    }
  }
  return false;
}

/** a Rambam commentator's name ending right before toks[i] (past ז"ל), with ו/ב/ל/ד and the article */
function rambamCommentatorBefore(toks: readonly Tok[], i: number, loose = false): string | undefined {
  let at = beforeIndex(toks, i, 1);
  if (at >= 0 && HONORIFICS.has(wordShape(toks[at]!))) at = beforeIndex(toks, i, 2);
  if (at < 0) return undefined;
  for (const [name, author, article] of RAMBAM_COMMENTATORS) {
    const words = name.split(" ");
    const first = toks[at - words.length + 1];
    if (!first || first.kind !== "word") continue;
    if (words.length === 2 && (toks[at]?.kind !== "word" || wordShape(toks[at]!) !== words[1])) continue;
    const shape = wordShape(first);
    for (let p = 0; p <= 2; p++) {
      if (p && !/^[ובלד]$/.test(shape[p - 1]!)) break;
      const rest = shape.slice(p);
      // loose: right before a chapter and a topic of the Rambam ("ועיי' כ"מ פ"ה מק"פ") "כ"מ" needs no article
      // ("וכ"מ" is still "וכן משמע")
      if (((!article || (loose && !shape.startsWith("ו"))) && rest === words[0]) || rest === `ה${words[0]}`) return author;
    }
  }
  return undefined;
}

/** "לעיל כ"ג ע"א תוס' ד"ה…": a commentator right after the location, and the token after it */
function commentatorAfter(toks: readonly Tok[], i: number): { who: string; next: number } | undefined {
  let j = i;
  // "ובקדושין דף י"ו ע"ב (תוד"ה והא)": also into a bracket that opens after the place
  while (toks[j]?.kind === "punct" && ")],([".includes(toks[j]!.text)) j++;
  const who = wordIn(toks[j], COMMENTATORS);
  return who ? { who, next: j + 1 } : undefined;
}

const TALMUDIC_COLLECTIONS: ReadonlySet<Collection> = new Set(["bavli", "mishna", "yerushalmi", "tosefta"]);

/** "ריש", "בסוף", "ובתחילת" right before a chapter word: part of the span */
const POSITION_BEFORE = /^ו?ב?(?:ריש|סוף|תחלת|תחילת)$/;

/**
 * The word that opens a unit cited by name: "פרק", "פ'", "פר'", "ר"פ", "ס"פ" (a chapter) and "פרשת"
 * (a parsha), with up to two prefix letters ("בפרק", "ובפ'", "דר"פ", "לפרשת"). Measured on the real
 * library (docs/AUTOMATION_ENGINE.md §6.8): "פ' X" / "פרשה X" / "פרש' X" with a parsha name are nearly
 * always a section of the citing book or of another book arranged by parshiyot ("עיין לקמן פ'
 * ואתחנן הגה י"ד"), not the Torah — so a parsha needs "פרשת". No ה: "הפרשת תרומה" is a noun.
 */
function unitWordAt(toks: readonly Tok[], i: number): { next: number; kinds: UnitKind[] } | null {
  const t = toks[i];
  if (!t || t.kind !== "word") return null;
  for (let p = 0; p <= 2; p++) {
    if (p && !/^[ובדמל]$/.test(t.text[p - 1]!)) break;
    const rest = t.text.slice(p);
    if (!rest) break;
    if (!t.gershayim && !t.geresh) {
      if (rest === "פרק") return { next: i + 1, kinds: ["chapter"] };
      if (rest === "פרשת") return { next: i + 1, kinds: ["parsha"] };
    } else if (t.geresh && !t.gershayim) {
      // "מפ'" is usually "מפרש" (explains): no מ before the abbreviation
      if (p && t.text.slice(0, p).includes("מ")) continue;
      if (rest === "פ" || rest === "פר") return { next: i + 1, kinds: ["chapter"] };
    } else if (t.gershayim && !t.geresh && t.gershayimAt - p === 1 && (rest === "רפ" || rest === "ספ")) return { next: i + 1, kinds: ["chapter"] };
  }
  return null;
}

/** A perek opening a reversed citation: "פ"ג", "בפי"א", "דבפ"ק", "פרק ג'", "בפרק ב'". */
function perekAt(toks: readonly Tok[], i: number): { n: number; next: number; ordinal?: true } | null {
  const t = toks[i]!;
  if (t.kind !== "word") return null;
  for (let p = 0; p <= 2; p++) {
    if (p && !PREFIX_LETTERS.test(t.text.slice(0, p))) break;
    const text = t.text.slice(p);
    if (t.gershayim && !t.geresh && t.gershayimAt - p >= 1 && text.startsWith("פ") && t.gershayimAt === t.text.length - 1) {
      const rest = text.slice(1);
      const n = rest === "ק" ? 1 : strictValue(rest);
      if (n) return { n, next: i + 1 };
    }
    // "רפ"ב", "ספ"ג" (ריש / סוף פרק): a chapter of at most 30 ("ספ"ר" is not chapter 200)
    if (t.gershayim && !t.geresh && t.gershayimAt - p >= 2 && t.gershayimAt === t.text.length - 1 && /^[רס]פ/.test(text)) {
      const rest = text.slice(2);
      const n = rest === "ק" ? 1 : strictValue(rest);
      if (n && n <= 30) return { n, next: i + 1 };
    }
    // "פרק ג'", and "פ' ז'" / "פר' י"ב" — the abbreviation with a quoted numeral (a bare one is a word)
    const word = !t.gershayim && !t.geresh && text === "פרק";
    const abbrev = t.geresh && !t.gershayim && (text === "פ" || text === "פר");
    if (word || abbrev) {
      const num = toks[i + 1];
      // "בפרק קמא דסנהדרין", "פ' שני דכתובות": an ordinal word (the reversed form needs the book after it)
      const ordinal = num?.kind === "word" && !num.gershayim && !num.geresh ? ORDINALS[num.key] : undefined;
      if (ordinal) return { n: ordinal, next: i + 2, ordinal: true };
      if (num?.kind === "word" && (num.gershayim || num.geresh)) {
        const n = num.gershayim ? (num.gershayimAt === num.text.length - 1 ? strictValue(num.text) : null) : strictValue(num.text);
        if (n && (word || n <= 30)) return { n, next: i + 2 };
      }
    }
  }
  return null;
}

/** books of the Tanakh whose usual short name is a numeral (and another book's name in the database) */
const NUMERIC_TANAKH: Readonly<Record<string, string>> = { 'ש"א': "שמואל א", 'ש"ב': "שמואל ב", 'מ"א': "מלכים א", 'מ"ב': "מלכים ב" };

/** ordinal words for a chapter ("פרק קמא", "פ' שלישי") */
const ORDINALS: Readonly<Record<string, number>> = { קמא: 1, ראשונ: 1, תנינא: 2, שני: 2, שלישי: 3, רביעי: 4, חמישי: 5, ששי: 6, שישי: 6, שביעי: 7, שמיני: 8, תשיעי: 9, עשירי: 10 };

/** words for "הלכות" between the ד/מ and a Rambam topic ("מה' מכירה", "מהלכו' אישות") */
const HILCHOT = new Set(["ה'", "הל'", "הלכות", "הלכו'", "הלכ'"]);

interface RambamTopic {
  readonly target: AliasTarget;
  /** token index just past the topic */
  readonly to: number;
  /** a word for "הלכות" was written */
  readonly hilchot: boolean;
  /** all the topic's words, its first word alone, or its initials ("מא"ב" — איסורי ביאה) */
  /** "abbrev": the starts of words anywhere in it ("יו"ט"); "word": a later word of it ("לולב") */
  readonly how: "full" | "first" | "initials" | "abbrev" | "word";
}

/**
 * A Rambam topic after a chapter ("פ"ט מתרומות", "מה' אישות", "מהל' גזלה", "מא"ב"): the ד/מ is glued to
 * the first word (with an article: "מהמ"א"), maybe a word for "הלכות" first. The topic is read from
 * the library's own titles ("משנה תורה, הלכות X"), compared loosely (named.ts: "גזלה" = "גזילה"):
 * all its words; or its first word, when that is the first word of no other topic and starts no other
 * topic's first word ("מעשר" may be מעשרות); or its initials, when only one topic has them.
 */
function rambamTopicAt(aliases: AliasIndex, toks: readonly Tok[], j: number): RambamTopic | null {
  const t = toks[j];
  if (!t || t.kind !== "word" || !aliases.rambamTopics.length) return null;
  for (const p of [1, 2]) {
    if (!/^(?:[דמ]|[דמ]ה)$/.test(t.text.slice(0, p))) continue;
    const rest = shapeOf(t, p);
    if (HILCHOT.has(rest)) {
      const r = topicAt(aliases, toks, j + 1, 0);
      return r && { ...r, hilchot: true };
    }
    // the article only before initials ("מהמ"א"); "מהלכות" is מ + הלכות, handled above
    if (p === 2 && !t.gershayim) continue;
    const r = topicAt(aliases, toks, j, p);
    if (r) return { ...r, hilchot: false };
  }
  return null;
}

function topicAt(aliases: AliasIndex, toks: readonly Tok[], k: number, strip: number): Omit<RambamTopic, "hilchot"> | null {
  const t = toks[k];
  if (!t || t.kind !== "word" || t.key.length - strip < 2) return null;
  const topics = aliases.rambamTopicWords;
  if (t.gershayim) {
    const letters = t.key.slice(strip);
    const hit = topics.filter((x) => x.words.length >= letters.length && [...letters].every((ch, n) => x.words[n]![0] === ch));
    if (hit.length === 1) return { target: hit[0]!.target, to: k + 1, how: "initials" };
    if (hit.length > 1) return null;
    // "יו"ט" (שביתת יום טוב), "מע"ק" (מעשה הקרבנות), "אה"ט" (שאר אבות הטומאות), "ס"ת" (…וספר תורה): the
    // start of each of two or more words in a row, anywhere in the topic, past a ו or an article
    const loose = topics.filter((x) => abbreviates(letters, x.words));
    return loose.length === 1 ? { target: loose[0]!.target, to: k + 1, how: "abbrev" } : null;
  }
  if (t.geresh) return null;
  const key = (n: number): string | null => {
    const x = toks[k + n];
    if (!x || x.kind !== "word" || x.gershayim || x.geresh) return null;
    return looseWord(n ? x.key : x.key.slice(strip));
  };
  let best: (typeof topics)[number] | null = null;
  let tie = false;
  for (const x of topics) {
    if (!x.words.every((w, n) => key(n) === looseWord(w))) continue;
    if (best && best.words.length === x.words.length) tie = true;
    else if (!best || x.words.length > best.words.length) {
      best = x;
      tie = false;
    }
  }
  if (best && !tie) return { target: best.target, to: k + best.words.length, how: "full" };
  const first = key(0);
  if (!first || first.length < 3) return null;
  const raw = t.key.slice(strip);
  const same = topics.filter((x) => looseWord(x.words[0]!) === first);
  if (same.length === 1 && !topics.some((x) => x !== same[0] && x.words[0]!.startsWith(raw) && x.words[0] !== raw)) return { target: same[0]!.target, to: k + 1, how: "first" };
  if (same.length) return null;
  // "מהל' לולב" (שופר וסוכה ולולב), "מה' סוכה": a later word of one topic only, past its ו
  if (raw.length < 4) return null;
  const later = topics.filter((x) => x.words.slice(1).some((w) => looseWord(w.replace(/^ו(?=.{3})/, "")) === first));
  if (later.length !== 1 || topics.some((x) => looseWord(x.words[0]!) === first)) return null;
  return { target: later[0]!.target, to: k + 1, how: "word" };
}

/** the letters are the starts of two or more words in a row of `words` (each start past a ו or an article ה) */
function abbreviates(letters: string, words: readonly string[]): boolean {
  const go = (w: number, at: number, used: number): boolean => {
    if (at === letters.length) return used >= 2;
    if (w >= words.length) return false;
    const word = words[w]!;
    for (const skip of [0, 1]) {
      if (skip && !/^[וה]/.test(word)) continue;
      const body = word.slice(skip);
      for (let n = Math.min(body.length, letters.length - at); n >= 1; n--) if (body.slice(0, n) === letters.slice(at, at + n) && go(w + 1, at + n, used + 1)) return true;
    }
    return false;
  };
  for (let start = 0; start < words.length; start++) if (go(start, 0, 0)) return true;
  return false;
}

/** "מדרש רבה", "ברבות", "במד"ר" (maybe "פרשה"/"פ'" after it) right before a book of the Tanakh: its midrash rabbah */
const RABBAH_WORDS: ReadonlySet<string> = new Set(["רבות", "ברבות", "וברבות", 'מד"ר', 'במד"ר', 'ובמד"ר', 'מדר"ר', 'במדר"ר', 'ובמדר"ר']);
const PARSHA_WORDS: ReadonlySet<string> = new Set(["פרשה", "בפרשה", "פ'", "פר'", "פרש'"]);

function rabbahBefore(toks: readonly Tok[], i: number): boolean {
  let at = beforeIndex(toks, i, 1);
  if (at >= 0 && PARSHA_WORDS.has(wordShape(toks[at]!))) at = beforeIndex(toks, at, 1);
  if (at < 0) return false;
  const w = wordShape(toks[at]!);
  // "רבה" alone is also a word ("תהום רבה (בראשית ח:ב)"): only after "מדרש"
  if (w === "רבה") return toks[at - 1]?.kind === "word" && /^ו?ב?מדרש$/.test(toks[at - 1]!.text);
  return RABBAH_WORDS.has(w);
}

/** words that count, right before a title that is also an everyday word ("שני דברים", "כמה שבועות") */
const QUANTIFIERS: ReadonlySet<string> = new Set(["שני", "שתי", "שלשה", "שלושה", "שלש", "שלוש", "ארבעה", "ארבע", "חמשה", "חמישה", "ששה", "שבעה", "שמונה", "תשעה", "עשרה", "כמה", "הרבה", "מספר", "ובשני", "בשני", "לשני", "בכמה", "וכמה", "באלו", "אלו", "לכמה"]);

function quantifierBefore(toks: readonly Tok[], i: number): boolean {
  const at = beforeIndex(toks, i, 1);
  const t = at >= 0 && at === i - 1 ? toks[at] : undefined;
  // words only: a number before the title is most often the last citation's place ("בסנהדרין דף פ' ובזבחים")
  return !!t && t.kind === "word" && QUANTIFIERS.has(t.text);
}

/** what numbers count rather than locate: "ח' ימים", "מ"ד שנים" */
const COUNTED: ReadonlySet<string> = new Set(["ימים", "יום", "יומין", "שנים", "שנה", "שנין", "שעות", "חדשים", "חודשים", "פעמים", "אמות", "דורות", "אלף", "אלפים", "מאות", "רבוא", "זוז", "זוזים", "מנה", "סלעים"]);

const countedAt = (toks: readonly Tok[], i: number): boolean => toks[i]?.kind === "word" && COUNTED.has(toks[i]!.text);

/** a part's name alone ("או"ח", "חושן משפט") */
const isSaPartAlone = (name: string): boolean => Object.values(SA_PARTS).some((names) => names.includes(normTitle(name)));

/** a word for responsa up to three words before toks[i] ("ובשו"ת חת"ס או"ח") */
function responsaWordBefore(toks: readonly Tok[], i: number): boolean {
  for (let back = 1; back <= 3; back++) {
    const t = before(toks, i, back);
    if (!t) return false;
    if (t.kind === "word" && RESPONSA_WORD.test(wordShape(t))) return true;
  }
  return false;
}

/**
 * Glossaries of one commentator's words (data, from the library's titles): their citations of the Talmud and
 * the Tanakh are where HE wrote the word — "(חולין פד:)" in "אוצר לעזי רש"י" is Rashi on Chullin 84b
 * (LIBRARY_BENCHMARK §6.4: 6 of 30 REFERENCE misses).
 */
const COMMENTATOR_GLOSSARIES: readonly (readonly [string, string])[] = [['לעזי רש"י', 'רש"י']];

function titleCommentatorOf(title: string): string | null {
  const t = normTitle(title);
  if (/ על /.test(t)) return null;
  for (const [words, who] of COMMENTATOR_GLOSSARIES) if (t.includes(words)) return who;
  return null;
}

/**
 * The location of "שם <new>" given the last citation's: explicit kinds replace from the same kind
 * on ("שם פסוק ד" keeps the chapter); bare numbers replace the deepest levels ("שם ד", "שם ג, ד"); a
 * new daf replaces everything.
 */
export function mergeIbid(prev: readonly AddrElem[], next: readonly AddrElem[]): AddrElem[] | null {
  if (!prev.length) return null;
  const first = next[0]!;
  const isDaf = (e: AddrElem) => e.kind === "daf" || e.amud !== undefined || e.maybeAmud !== undefined;
  // "(שם י:)" after a verse is not that verse's book: a daf follows only a daf
  if (isDaf(first) !== isDaf(prev[0]!)) return null;
  if (isDaf(first)) return [...next];
  if (first.kind !== "?") {
    const at = prev.findIndex((e) => e.kind === first.kind);
    if (at >= 0) return [...prev.slice(0, at), ...next];
    const second: readonly Kind[] = ["pasuk", "seif", "sk", "halacha", "mishna"];
    if (second.includes(first.kind)) return [...prev.slice(0, 1), ...next];
    return [...next];
  }
  if (next.length > prev.length) return null;
  return [...prev.slice(0, prev.length - next.length), ...next];
}
