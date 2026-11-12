import { closesAt, opensAt, parseAddress, type AddrElem, type Address, type Kind } from "./address";
import { normTitle, SA_PARTS, TIER_RANK, type AliasIndex, type AliasMatch, type AliasTarget, type Collection } from "./aliases";
import { looseWord, type NamedUnit, type NamedUnitIndex, type UnitKind } from "./named";
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
  /**
   * forward: name then location; reversed: "פ"ג מהל' שבת"; relative: "לעיל/לקמן" + daf of the base book;
   * named: a unit cited by its name ("בפרק הזהב", "בפרשת וירא"), maybe with a location after it
   */
  readonly form: "forward" | "reversed" | "relative" | "named";
  /** form "named": the unit the name stands for */
  readonly unit?: CitedUnit;
  /** a collection word right before ("ירושלמי", "רמב"ם", "גמ'") */
  readonly qualifier?: Collection;
  /** the citation was moved to a commentary named right before it ("תוס'") */
  readonly commentator?: string;
  readonly numericName: boolean;
  /**
   * the rule that read the book or the place, beyond the form (engine.ts scores and explains it):
   * "rambam-topic-full" / "-first" / "-initials" — "רמב"ם פ"ט מתרומות"
   */
  readonly rule?: string;
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
    private readonly sourceTitle = "",
    /** chapter and parsha names (from the library's alt_toc); without it no unit is cited by name */
    private readonly units?: NamedUnitIndex,
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
      const next = this.forward(toks, i, line) ?? this.named(toks, i, line) ?? this.reversed(toks, i, line) ?? this.relative(toks, i, line) ?? (this.ibidOn ? this.ibid(toks, i, line) : null);
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
      // "כמ"ש באה"ע סי' קמ"א": a name that is also running text ("מ"ש" — מה שכתב) is a name only after a chapter ("פ"ב דמ"ש")
      if (RUNNING_TEXT_NAMES.has(m.entry.text)) continue;
      // "בחולין שם", "בנזיר (שם)": the book with the last citation's location
      const shem = isWord(toks[m.to], "שם") ? m.to + 1 : opensAt(toks, m.to) && isWord(toks[m.to + 1], "שם") && closesAt(toks, m.to + 2) ? m.to + 3 : -1;
      if (this.ibidOn && shem > 0 && this.last) {
        const cands = this.own(m.entry.targets).filter((c) => this.last!.c.candidates.some((p) => p.book.key === c.book.key));
        if (cands.length) {
          const end = shem;
          return this.emit(toks, line, { from: i, to: end, candidates: cands, name: m.entry.text, elems: this.last.elems, evidence: "strong", bracketed: false, ibid: "book", ibidOf: this.last.c.seq, form: "forward", numericName: false, m });
        }
      }
      // "ב"ח ח"מ סי' ר"ב", "טור או"ח סי' א": a part of the Tur / Shulchan Aruch after the name
      const sec = m.entry.targets.some((t) => t.section) ? null : sectionAt(toks, m.to);
      const addr = (sec && parseAddress(toks, sec.next)) || parseAddress(toks, m.to, { enclosed: opensBefore(toks, i) });
      if (!addr) continue;
      // "ע"ז נ"ב ע"א", "ר"ה לב.": a tractate whose name is a numeral, with a daf and its amud
      const dafOfTractate = addr.elems[0]!.amud !== undefined && m.entry.targets.some((t) => t.collection === "bavli");
      if (m.entry.numeric && !addr.elems[0]!.explicit && !dafOfTractate) {
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
    // "רמב"ם פ"ט מתרומות", "פ"ה מה' מכירה", "פרק ו' מהלכו' אישות": a topic of the Rambam, told by the
    // author's name right before or by a word for "הלכות"; the same words without them are the tractate
    const rambamBefore = [1, 2].some((b) => wordIn(before(toks, i, b), QUALIFIERS) === "rambam");
    let topic: RambamTopic | null = null;
    if (!m?.entry.targets.some((t) => t.collection === "rambam")) {
      topic = rambamTopicAt(this.aliases, toks, j);
      if (topic && !topic.hilchot && !rambamBefore) topic = null;
      // "הרמב"ם פ"ב דכתובות" is not the tractate; a topic we cannot read is not guessed
      if (!topic && rambamBefore) return m ? this.drop("rambam-topic-unknown") : null;
    }
    if (!m && !topic) return null;
    j = topic ? topic.to : m!.to;
    const elems: AddrElem[] = [{ kind: "perek", n: head.n, explicit: true, numeral: { n: head.n, form: "gershayim", common: false } }];
    let to = j;
    const rest = parseAddress(toks, j, { after: "perek" });
    if (rest && !rest.elems.some((e) => e.kind === "perek")) {
      elems.push(...rest.elems);
      to = rest.to;
    }
    if (isDate(toks, to)) return this.drop("date");
    const cands = this.own(topic ? [topic.target] : m!.entry.targets);
    if (!cands.length) return this.drop("self");
    const name = topic ? topic.target.book.title : m!.entry.text;
    return this.emit(toks, line, { from: i, to, candidates: cands, name, elems, evidence: "strong", bracketed: false, ibid: "none", form: "reversed", numericName: false, ...(m && !topic && { m }), ...(topic && { rule: `rambam-topic-${topic.how}` }) });
  }

  /**
   * A unit cited by its NAME: "בפרק הזהב", "פ' המדיר דכתובות", "ביבמות פרק האשה רבה", "בפרשת וירא",
   * "בזוהר פרשת ויקהל". The names are the library's own (alt_toc: the Bavli's chapters, the Torah's
   * parshiyot). A name shared by several units is not guessed: a tractate named next to it, or the
   * book this commentary is on, must pick one. A location right after it ("(דף ס"ד ע"ב)", "[יבמות צ:]",
   * "(י"ב, י"ד)") is resolved in the unit's book, and only inside the unit (engine.ts).
   */
  private named(toks: readonly Tok[], i: number, line: number): number | null {
    if (!this.units?.size) return null;
    const head = unitWordAt(toks, i);
    if (!head) return null;
    const found = this.units.matchAt(toks, head.next, head.kinds);
    if (!found) return null;
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
    if (matches.some((x) => namedFor(x).size)) {
      matches = matches.filter((x) => namedFor(x).has(x.unit.book.key));
      context = "named";
    } else if (this.baseTractate && matches.some((x) => x.unit.book.key === this.baseTractate)) {
      matches = matches.filter((x) => x.unit.book.key === this.baseTractate);
      context = "base";
    } else if (matches.some((x) => x.full)) {
      // the name alone: the unit whose whole name it is — unless the words also start the names of two
      // or more other units ("ר"פ האשה" may be פסחים' "האשה", or יבמות' "האשה רבה", כתובות' "האשה שנפלו"…)
      if (matches.filter((x) => !x.full).length >= 2) return this.drop("unit-ambiguous");
      matches = matches.filter((x) => x.full);
    }
    if (matches.length > 1 && matches.some((x) => x.full)) matches = matches.filter((x) => x.full);
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
    };
    return this.emitUnit(toks, line, from, end, candidates, unit, addr, u.kind === "chapter");
  }

  private emitUnit(toks: readonly Tok[], line: number, from: number, to: number, candidates: readonly AliasTarget[], unit: CitedUnit, addr: Address | null, commentators: boolean): number | null {
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
    // …and so does "המ"ל (שם)", "הרשב"א [שם]", "הרמב"ם ז"ל (שם)": an author's name before the bracket
    // (past ז"ל) — a quoted name with the article, or a commentator's ("רש"י (שם)")
    let at = beforeIndex(toks, i, 1);
    if (at >= 0 && HONORIFICS.has(wordShape(toks[at]!))) at = beforeIndex(toks, i, 2);
    const author = at >= 0 && at < i - 1 ? toks[at] : undefined;
    const quotedAuthor = author?.kind === "word" && author.gershayim && author.text[0] === "ה" && !NOT_AUTHORS.has(wordShape(author));
    if (author?.kind === "word" && !numeralOf(author) && !this.aliases.matchAt(toks, at).length && (quotedAuthor || wordIn(author, COMMENTATORS) || wordIn(author, QUALIFIERS) === "rambam")) return this.drop("ibid-other-book");
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
      unit?: CitedUnit;
      /** a commentator's name before it retargets the citation (default true) */
      commentators?: boolean;
      /** the rule that read it, beyond its form (Citation.rule) */
      rule?: string;
    },
  ): number | null {
    let candidates = c.candidates;
    const qualifier = qualifierBefore(toks, c.from);
    let commentator: string | undefined;
    if ((c.ibid === "none" || c.ibid === "book") && c.commentators !== false) {
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
      ...(c.unit && { unit: c.unit }),
      ...(c.rule && { rule: c.rule }),
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
  return wordIn(t, COMMENTATORS) ?? undefined;
}

/** "לעיל כ"ג ע"א תוס' ד"ה…": a commentator right after the location, and the token after it */
function commentatorAfter(toks: readonly Tok[], i: number): { who: string; next: number } | undefined {
  let j = i;
  while (toks[j]?.kind === "punct" && ")],".includes(toks[j]!.text)) j++;
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
      if (num?.kind === "word" && (num.gershayim || num.geresh)) {
        const n = num.gershayim ? (num.gershayimAt === num.text.length - 1 ? strictValue(num.text) : null) : strictValue(num.text);
        if (n && (word || n <= 30)) return { n, next: i + 2 };
      }
    }
  }
  return null;
}

/** words for "הלכות" between the ד/מ and a Rambam topic ("מה' מכירה", "מהלכו' אישות") */
const HILCHOT = new Set(["ה'", "הל'", "הלכות", "הלכו'", "הלכ'"]);

interface RambamTopic {
  readonly target: AliasTarget;
  /** token index just past the topic */
  readonly to: number;
  /** a word for "הלכות" was written */
  readonly hilchot: boolean;
  /** all the topic's words, its first word alone, or its initials ("מא"ב" — איסורי ביאה) */
  readonly how: "full" | "first" | "initials";
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
    return hit.length === 1 ? { target: hit[0]!.target, to: k + 1, how: "initials" } : null;
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
  if (same.length !== 1 || topics.some((x) => x !== same[0] && x.words[0]!.startsWith(raw) && x.words[0] !== raw)) return null;
  return { target: same[0]!.target, to: k + 1, how: "first" };
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
