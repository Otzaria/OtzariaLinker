import { closesAt, parseAddress, type AddrElem, type Address, type Kind } from "./address";
import { SA_PARTS, TIER_RANK, type AliasIndex, type AliasMatch, type AliasTarget, type Collection } from "./aliases";
import { numeralOf, strictValue } from "./numbers";
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
  /** forward: name then location; reversed: "פ"ג מהל' שבת"; relative: "לעיל/לקמן" + daf of the base book */
  readonly form: "forward" | "reversed" | "relative";
  /** a collection word right before ("ירושלמי", "רמב"ם", "גמ'") */
  readonly qualifier?: Collection;
  /** the citation was moved to a commentary named right before it ("תוס'") */
  readonly commentator?: string;
  readonly numericName: boolean;
}

export interface DetectOptions {
  /** resolve "שם" (ibid). Default true. */
  readonly ibid?: boolean;
  /** how many lines back "שם" may reach (no heading between). Default 6. */
  readonly ibidWindow?: number;
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
];

const PREFIX_LETTERS = /^[ובהלכדמש]{1,2}/;

function shapeOf(t: Tok, stripPrefix: number): string {
  const s = wordShape(t);
  return stripPrefix ? s.slice(stripPrefix) : s;
}

/** The word as one of `list`, allowing up to two glued prefix letters. */
function wordIn<T>(t: Tok | undefined, list: readonly (readonly [string, T])[]): T | null {
  if (!t || t.kind !== "word") return null;
  for (let p = 0; p <= 2; p++) {
    if (p && !PREFIX_LETTERS.test(t.text.slice(0, p))) break;
    const s = shapeOf(t, p);
    for (const [w, v] of list) if (s === w) return v;
  }
  return null;
}

export class CitationScanner {
  readonly citations: Citation[] = [];
  private seq = 0;
  private last: { c: Citation; line: number; elems: readonly AddrElem[] } | null = null;
  private lastLineSeen = -1;
  private headingSince = false;
  /** spans that looked like citations but were dropped, by reason (for the notes) */
  readonly dropped = new Map<string, number>();
  private readonly ibidOn: boolean;
  private readonly window: number;
  /** the book a commentary is on ("… על גיטין"), the target of "לעיל"/"לקמן" */
  private readonly base: AliasTarget | null;

  constructor(
    private readonly aliases: AliasIndex,
    private readonly sourceKey: string,
    options: DetectOptions = {},
    sourceTitle = "",
  ) {
    this.ibidOn = options.ibid ?? true;
    this.window = options.ibidWindow ?? 6;
    this.base = baseOf(aliases, sourceTitle);
  }

  /** Feeds one line (in book order). Heading lines are not linked but break the ibid chain. */
  scanLine(line: number, text: string, heading: number | null): void {
    if (heading !== null) {
      this.headingSince = true;
      return;
    }
    const toks = citationTokens(text);
    if (!hasHebrewText(toks)) return;
    if (this.last && (line - this.last.line > this.window || this.headingSince)) this.last = null;
    this.headingSince = false;
    this.lastLineSeen = line;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.kind !== "word") continue;
      const next = this.forward(toks, i, line) ?? this.reversed(toks, i, line) ?? this.relative(toks, i, line) ?? (this.ibidOn ? this.ibid(toks, i, line) : null);
      if (next !== null) i = next - 1;
    }
  }

  private drop(reason: string): null {
    this.dropped.set(reason, (this.dropped.get(reason) ?? 0) + 1);
    return null;
  }

  /** "<name> <location>" or "<name> שם" at toks[i]; returns the index past the citation. */
  private forward(toks: readonly Tok[], i: number, line: number): number | null {
    const matches = this.aliases.matchAt(toks, i);
    for (const m of matches) {
      // "בחולין שם": the book with the last citation's location
      if (this.ibidOn && isWord(toks[m.to], "שם") && this.last) {
        const cands = this.own(m.entry.targets).filter((c) => this.last!.c.candidates.some((p) => p.book.key === c.book.key));
        if (cands.length) {
          const end = m.to + 1;
          return this.emit(toks, line, { from: i, to: end, candidates: cands, name: m.entry.text, elems: this.last.elems, evidence: "strong", bracketed: false, ibid: "book", ibidOf: this.last.c.seq, form: "forward", numericName: false, m });
        }
      }
      // "ב"ח ח"מ סי' ר"ב", "טור או"ח סי' א": a part of the Tur / Shulchan Aruch after the name
      const sec = m.entry.targets.some((t) => t.section) ? null : sectionAt(toks, m.to);
      const addr = (sec && parseAddress(toks, sec.next)) || parseAddress(toks, m.to, { enclosed: opensBefore(toks, i) });
      if (!addr) continue;
      if (m.entry.numeric && !addr.elems[0]!.explicit) {
        this.drop("numeric-name");
        continue;
      }
      if (isDate(toks, addr.to)) return this.drop("date");
      let cands = this.own(m.entry.targets);
      if (sec && addr.from === sec.next) cands = withSection(cands, sec.part);
      if (!cands.length) return this.drop("self");
      // "ב"ק (דף ט:)": the closing bracket belongs to the span; in "(בראשית א, ב)" neither bracket does
      const to = addr.bracketed && addr.closed ? addr.to + 1 : addr.to;
      return this.emit(toks, line, { from: i, to, candidates: cands, name: m.entry.text, elems: addr.elems, evidence: addr.evidence, bracketed: addr.closed, ibid: "none", form: "forward", numericName: m.entry.numeric, m });
    }
    return null;
  }

  /** "פ"ג מהל' תרומות ה"א", "בפ"ק דכריתות (דף ה')", "בפרק ב' ממסכת טהרות" at toks[i]. */
  private reversed(toks: readonly Tok[], i: number, line: number): number | null {
    const head = perekAt(toks, i);
    if (!head) return null;
    let j = head.next;
    // "ממסכת טהרות" / "דמסכת" — the name follows the word "מסכת"
    const m = this.aliases.matchAt(toks, j).find((x) => x.prefix.endsWith("ד") || x.prefix.endsWith("מ"));
    if (!m) return null;
    j = m.to;
    const elems: AddrElem[] = [{ kind: "perek", n: head.n, explicit: true, numeral: { n: head.n, form: "gershayim", common: false } }];
    let to = j;
    const rest = parseAddress(toks, j, { after: "perek" });
    if (rest && !rest.elems.some((e) => e.kind === "perek")) {
      elems.push(...rest.elems);
      to = rest.to;
    }
    if (isDate(toks, to)) return this.drop("date");
    const cands = this.own(m.entry.targets);
    if (!cands.length) return this.drop("self");
    return this.emit(toks, line, { from: i, to, candidates: cands, name: m.entry.text, elems, evidence: "strong", bracketed: false, ibid: "none", form: "reversed", numericName: false, m });
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
        const x = before(toks, i, back);
        return !!x && x.kind === "word" && this.aliases.matchAt(toks, toks.indexOf(x)).length > 0;
      };
      if (named(before(toks, i, 1)) || named(before(toks, i, 2)) || titled(1) || titled(2) || named(toks[addr.to]) || named(toks[addr.to + 1])) return this.drop("siman-of-another-book");
      return this.emit(toks, line, { from: i, to: addr.to, candidates: [this.base], name: t.text, elems: addr.elems, evidence: addr.evidence, bracketed: addr.closed, ibid: "none", form: "relative", numericName: false });
    }
    if (!RELATIVE.test(t.text)) return null;
    const addr = parseAddress(toks, i + 1, { enclosed: opensBefore(toks, i) });
    if (!addr) return null;
    const e = addr.elems[0]!;
    const isDaf = e.kind === "daf" || (e.kind === "?" && (e.amud !== undefined || e.maybeAmud !== undefined || (addr.elems[1]?.kind === "?" && (addr.elems[1]!.n === 1 || addr.elems[1]!.n === 2) && addr.elems.length === 2)));
    if (!isDaf) return null;
    const to = addr.bracketed && addr.closed ? addr.to + 1 : addr.to;
    return this.emit(toks, line, { from: i, to, candidates: [this.base], name: t.text, elems: addr.elems, evidence: addr.evidence, bracketed: addr.closed, ibid: "none", form: "relative", numericName: false });
  }

  /** "(שם)", "(שם ד)", "שם פסוק ד", "שם דף ה ע"ב" at toks[i]. */
  private ibid(toks: readonly Tok[], i: number, line: number): number | null {
    const t = toks[i]!;
    if (!this.last || t.text !== "שם" || t.gershayim || t.geresh) return null;
    // "הפ"ת שם סק"ט": "שם" after a name we do not know refers to THAT book, not to our last citation
    const prev = toks[i - 1];
    if (prev?.kind === "word" && (prev.gershayim || prev.geresh) && !numeralOf(prev) && !this.aliases.matchAt(toks, i - 1).length) return this.drop("ibid-other-book");
    const inBracket = toks[i - 1]?.kind === "punct" && "([".includes(toks[i - 1]!.text);
    // "(שם שם לב)": the same book and the same chapter — the numbers replace the deepest level
    const twice = isWord(toks[i + 1], "שם") ? 1 : 0;
    const addr = parseAddress(toks, i + 1 + twice, { enclosed: inBracket });
    if (!addr) {
      // only "(שם)" — a bare "שם" in running text is the word "there"/"name"
      if (inBracket && closesAt(toks, i + 1)) return this.emit(toks, line, { from: i, to: i + 1, candidates: this.last.c.candidates, name: "שם", elems: this.last.elems, evidence: "strong", bracketed: true, ibid: "full", ibidOf: this.last.c.seq, form: "forward", numericName: false });
      return null;
    }
    if (!inBracket && addr.evidence !== "strong") return null;
    const elems = mergeIbid(this.last.elems, addr.elems);
    if (!elems) return this.drop("ibid-shape");
    return this.emit(toks, line, { from: i, to: addr.to, candidates: this.last.c.candidates, name: "שם", elems, evidence: addr.evidence, bracketed: inBracket || addr.bracketed, ibid: "partial", ibidOf: this.last.c.seq, form: "forward", numericName: false });
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
    },
  ): number | null {
    let candidates = c.candidates;
    const qualifier = qualifierBefore(toks, c.from);
    let commentator: string | undefined;
    if (c.ibid === "none" || c.ibid === "book") {
      // "בירושלמי פ"ח דכתובות": the qualifier adds that collection's book of the same tractate
      if (qualifier && !candidates.some((x) => x.collection === qualifier)) candidates = [...candidates, ...this.siblings(candidates, qualifier)];
      // a commentator named right before ("תוס' פסחים ל"א") or right after ("לעיל כ"ג ע"א תוס' ד"ה"):
      // the citation points into that commentary
      const before = commentatorBefore(toks, c.from);
      const after = before ? undefined : commentatorAfter(toks, c.to);
      const who = before ?? after?.who;
      const dh = isDibur(toks, after ? after.next : c.to);
      const named = candidates.some((x) => / על /.test(x.book.title));
      if (who && !named) {
        const moved = this.toCommentary(candidates, who);
        if (!moved.length) {
          this.drop("commentator-not-in-library");
          return c.to;
        }
        candidates = moved;
        commentator = who;
      } else if (dh && !named) {
        this.drop("dibur-without-commentator");
        return c.to;
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
      numericName: c.numericName,
    };
    this.citations.push(cit);
    this.last = { c: cit, line, elems: c.elems };
    return c.to;
  }

  /** "תוס'" + a citation of כתובות → "תוספות על כתובות", when the library has it. */
  private toCommentary(candidates: readonly AliasTarget[], who: string): AliasTarget[] {
    const out: AliasTarget[] = [];
    const whoKey = keyOfName(who);
    for (const c of candidates) {
      const list = (this.aliases.commentariesOn.get(c.book.title.replace(/[״]/g, '"')) ?? []).filter((x) => x.book.key !== this.sourceKey);
      // the commentary whose author IS the name ("תוספות", "רש"י"); else one whose author has it as a word
      // ("חידושי הרמב"ן"); several → all of them (resolution calls a tie ambiguous)
      const exact = list.filter((x) => keyOfName(x.author) === whoKey);
      const word = exact.length ? exact : list.filter((x) => keyOfName(x.author).split(" ").some((k) => k === whoKey || k === `ה${whoKey}`));
      for (const x of word) out.push({ book: x.book, tier: c.tier, collection: c.collection });
    }
    return out;
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
  const names = [on, on && /^שולחן ערוך (.+)$/.exec(on) ? `שולחן ערוך, ${on.slice("שולחן ערוך ".length)}` : undefined, SA_COMMENTARY_BASE[title]];
  for (const n of names) {
    if (!n) continue;
    const t = aliases.lookup(n)?.targets.find((x) => x.tier === "title" && (x.collection === "bavli" || x.collection === "sa"));
    if (t) return t;
  }
  return null;
}

/** quoted abbreviations of running text that name no book ("כמ"ש בסימן…", "ע"ש") */
const COMMON_ABBREVIATIONS = new Set(['כמ"ש', 'וכמ"ש', 'כמש"כ', 'וכמש"כ', 'ע"ש', 'וע"ש', 'עיי"ש', "וכו'", "כו'", 'א"כ', 'מ"מ', 'הנ"ל', 'כנ"ל', 'ז"ל', 'ע"פ', "עי'", "ועי'", 'ס"ל', 'דס"ל', 'וכ"כ', 'כ"כ', "כדאי'", "עיין", 'ר"ל', 'ג"כ', 'וכ"ש', 'כ"ש', "אפי'", "ואפי'"]);
/** words that name another work before a siman ("בתשובה סימן צ"ז") */
const OTHER_WORK = /^[וב]{0,2}(?:תשובה|תשובות|תשו|ספר|ס|שו"ת|שות)$/;

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

const opensBefore = (toks: readonly Tok[], i: number): boolean => toks[i - 1]?.kind === "punct" && "([".includes(toks[i - 1]!.text);

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
  let j = i - 1;
  let seen = 0;
  while (j >= 0) {
    const t = toks[j]!;
    if (t.kind === "punct") {
      if (!"([,".includes(t.text)) return undefined;
      j--;
      continue;
    }
    if (++seen === back) return t;
    j--;
  }
  return undefined;
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
  return wordIn(t, COMMENTATORS) ?? undefined;
}

/** "לעיל כ"ג ע"א תוס' ד"ה…": a commentator right after the location, and the token after it */
function commentatorAfter(toks: readonly Tok[], i: number): { who: string; next: number } | undefined {
  let j = i;
  while (toks[j]?.kind === "punct" && ")],".includes(toks[j]!.text)) j++;
  const who = wordIn(toks[j], COMMENTATORS);
  return who ? { who, next: j + 1 } : undefined;
}

/** A perek opening a reversed citation: "פ"ג", "בפי"א", "דבפ"ק", "פרק ג'", "בפרק ב'". */
function perekAt(toks: readonly Tok[], i: number): { n: number; next: number } | null {
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
    if (text === "פרק" && !t.gershayim && !t.geresh) {
      const num = toks[i + 1];
      if (num?.kind === "word" && (num.gershayim || num.geresh)) {
        const n = num.gershayim ? (num.gershayimAt === num.text.length - 1 ? strictValue(num.text) : null) : strictValue(num.text);
        if (n) return { n, next: i + 2 };
      }
    }
  }
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
