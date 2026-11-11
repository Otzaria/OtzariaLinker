import type { BookRef } from "../../../core/links/model";
import { strictValue } from "./numbers";
import { citationTokens, unifyFinals, type Tok } from "./text";

/*
 * Book names → books. The index is built from what the open sources give: every title, the
 * database's book_acronym (42K names in the official library) and canonical forms derived here from
 * the titles themselves ("משנה תורה, הלכות שבת" → "הלכות שבת", "רמב"ם הל' שבת"; "תלמוד ירושלמי
 * ברכות" → "ירושלמי ברכות"; "שולחן ערוך, אורח חיים" → "שו"ע או"ח"). A small table of spellings that
 * no title or derivation produces (תהלים, ישעיה, ב"ק…) is written here as facts.
 *
 * Names are compared on letters with final forms unified, WITH the shape of their quote marks: an
 * acronym (ב"ק) matches only a word written with gershayim before the same letter, a truncation
 * (הל') only a word with a final geresh. One or two prefix letters (ו, ב, ל, מ, ד, ה, כ, ש) may be
 * glued to the first word ("ובב"מ", "דבפ"ק").
 *
 * Guards (REUSE_MATRIX §5.6, "a missing link is better than a wrong one"):
 *   • a one-word name of ≤3 letters without quote marks is dropped (קמא, ברש, אוח…);
 *   • a name that is itself a numeral (ט"ז, מ"א, ש"ך) is kept but marked `numeric`: it counts only
 *     before an explicit location marker (detect.ts);
 *   • a name shared by several books stays one entry with several targets; resolution keeps the
 *     ones whose location exists and calls a remaining tie ambiguous.
 */

export type Collection = "tanakh" | "bavli" | "mishna" | "yerushalmi" | "tosefta" | "rambam" | "sa" | "sa-commentary" | "tur" | "other";

/** One book of the library as the engine sees it. `aliases` are extra names (book_acronym). */
export interface CatalogBook {
  readonly book: BookRef;
  readonly aliases?: readonly string[];
}

/**
 * title: the exact title; derived: a canonical form built here (or a fact-table spelling); acronym: a
 * name from the database's book_acronym; secondary: a name that fits this book only in a weaker
 * reading (a bare tractate name read as the Mishna).
 */
export type AliasTier = "title" | "derived" | "acronym" | "secondary";

export interface AliasTarget {
  readonly book: BookRef;
  readonly tier: AliasTier;
  readonly collection: Collection;
  /** a named first level of the book's references the name stands for ("אורח חיים" of the Tur) */
  readonly section?: string;
}

export interface AliasWord {
  readonly key: string;
  /** letters after the gershayim (1 = before the last letter); 0 = none */
  readonly gershayimFromEnd: number;
  readonly geresh: boolean;
}

export interface AliasEntry {
  readonly words: readonly AliasWord[];
  /** the name as written (for reasons) */
  readonly text: string;
  readonly targets: AliasTarget[];
  /** the name reads as a numeral (ט"ז, מ"א): it needs an explicit location marker after it */
  readonly numeric: boolean;
}

export interface AliasMatch {
  readonly entry: AliasEntry;
  /** token index of the first word, and just past the last */
  readonly from: number;
  readonly to: number;
  /** prefix letters peeled off the first word ("ו", "ב", "וב"…) */
  readonly prefix: string;
}

/* ---------- facts: collections and spellings ---------- */

const TANAKH = [
  "בראשית", "שמות", "ויקרא", "במדבר", "דברים", "יהושע", "שופטים", "שמואל א", "שמואל ב", "מלכים א", "מלכים ב", "ישעיהו", "ירמיהו", "יחזקאל",
  "הושע", "יואל", "עמוס", "עובדיה", "יונה", "מיכה", "נחום", "חבקוק", "צפניה", "חגי", "זכריה", "מלאכי", "תהילים", "משלי", "איוב", "שיר השירים",
  "רות", "איכה", "קהלת", "אסתר", "דניאל", "עזרא", "נחמיה", "דברי הימים א", "דברי הימים ב",
];

const BAVLI = [
  "ברכות", "שבת", "עירובין", "פסחים", "יומא", "סוכה", "ביצה", "ראש השנה", "תענית", "מגילה", "מועד קטן", "חגיגה", "יבמות", "כתובות", "נדרים", "נזיר",
  "סוטה", "גיטין", "קידושין", "בבא קמא", "בבא מציעא", "בבא בתרא", "סנהדרין", "מכות", "שבועות", "עבודה זרה", "הוריות", "זבחים", "מנחות", "חולין",
  "בכורות", "ערכין", "תמורה", "כריתות", "מעילה", "תמיד", "נדה",
];

/** spellings no title produces: [title, ...other names] */
const SPELLINGS: readonly (readonly string[])[] = [
  ["תהילים", "תהלים", "תילים", "תלים"],
  ["ישעיהו", "ישעיה", "ישעי'"],
  ["ירמיהו", "ירמיה", "ירמי'"],
  ["יחזקאל", "יחזק'", "יחז'"],
  ["שיר השירים", 'שה"ש', 'שיר השירים'],
  ["דברי הימים א", 'דה"א', "דברי הימים א'"],
  ["דברי הימים ב", 'דה"ב', "דברי הימים ב'"],
  ["שמואל א", 'שמ"א', "שמואל א'"],
  ["שמואל ב", 'שמ"ב', "שמואל ב'"],
  ["מלכים א", 'מל"א', "מלכים א'"],
  ["מלכים ב", 'מל"ב', "מלכים ב'"],
  ["בבא קמא", 'ב"ק', "בבא קמא"],
  ["בבא מציעא", 'ב"מ'],
  ["בבא בתרא", 'ב"ב'],
  ["עבודה זרה", 'ע"ז'],
  ["מועד קטן", 'מו"ק'],
  ["ראש השנה", 'ר"ה'],
  ["עירובין", "ערובין"],
  ["קידושין", "קדושין"],
  ["נדה", "נידה"],
  ["מגילה", "מגלה"],
];

/** the parts of the Shulchan Aruch and the Tur: name → its abbreviations */
export const SA_PARTS: Readonly<Record<string, readonly string[]>> = {
  "אורח חיים": ['או"ח', "אורח חיים"],
  "יורה דעה": ['יו"ד', "יורה דעה"],
  "אבן העזר": ['אה"ע', 'אבה"ע', "אבן העזר"],
  "חושן משפט": ['חו"מ', 'ח"מ', "חושן משפט", "חשן משפט"],
};
const SA_NAMES = ["שולחן ערוך", 'שו"ע', "שלחן ערוך", 'ש"ע'];

const SA_COMMENTARY_TITLES = new Set(["משנה ברורה", "מגן אברהם", "שער הציון", "ביאור הלכה", "באר היטב", "טורי זהב", "שפתי כהן"]);

const BAVLI_SET = new Set(BAVLI);
const TANAKH_SET = new Set(TANAKH);

/** The collection a title belongs to, from the title's shape (works for every source, also text files). */
export function collectionOf(title: string): Collection {
  const t = title.replace(/[״"]/g, '"').replace(/\s+/g, " ").trim();
  if (TANAKH_SET.has(t)) return "tanakh";
  if (BAVLI_SET.has(t)) return "bavli";
  if (t.startsWith("תלמוד ירושלמי ")) return "yerushalmi";
  if (t.startsWith("תוספתא ")) return "tosefta";
  if (t.startsWith("משנה תורה, הלכות ") || t.startsWith("משנה תורה, ")) return "rambam";
  if (t.startsWith("שולחן ערוך, ")) return "sa";
  if (t === "טור") return "tur";
  if (t.startsWith("משנה ") && t !== "משנה ברורה" && !t.startsWith("משנה תורה") && t.split(" ").length <= 3) return "mishna";
  if (SA_COMMENTARY_TITLES.has(t) || / על שולחן ערוך/.test(t)) return "sa-commentary";
  return "other";
}

/* ---------- names ---------- */

/** A name → its words, or null when it has no Hebrew word. */
export function nameWords(name: string): AliasWord[] | null {
  const words = citationTokens(name).filter((t) => t.kind === "word");
  if (!words.length) return null;
  return words.map((t) => ({ key: t.key, gershayimFromEnd: t.gershayim ? t.text.length - t.gershayimAt : 0, geresh: t.geresh }));
}

const wordsKey = (w: readonly AliasWord[]): string => w.map((x) => `${x.key}${x.gershayimFromEnd ? `"${x.gershayimFromEnd}` : ""}${x.geresh ? "'" : ""}`).join(" ");

export class AliasIndex {
  private readonly byFirst = new Map<string, AliasEntry[]>();
  private readonly byKey = new Map<string, AliasEntry>();
  readonly collections = new Map<string, Collection>();
  /** "תוספות על כתובות" → by base title → commentary books, for "תוס' (כתובות ב.)" */
  readonly commentariesOn = new Map<string, { book: BookRef; author: string }[]>();
  /** "כתובות" → the Bavli, Mishna, Yerushalmi and Tosefta books of that tractate (a qualifier picks one) */
  readonly tractates = new Map<string, Map<Collection, AliasTarget>>();
  /** "יבמו'" → "יבמות": truncated one-word names of the Bavli and Tanakh (only written with a geresh) */
  private readonly truncated = new Map<string, AliasEntry | null>();
  /** names dropped by the guards (for the run's notes) */
  dropped = 0;

  static build(catalog: readonly CatalogBook[]): AliasIndex {
    const ix = new AliasIndex();
    const byTitle = new Map<string, BookRef[]>();
    for (const c of catalog) {
      const t = normTitle(c.book.title);
      byTitle.set(t, [...(byTitle.get(t) ?? []), c.book]);
      ix.collections.set(c.book.key, collectionOf(c.book.title));
    }
    for (const c of catalog) {
      const coll = ix.collections.get(c.book.key)!;
      const title = normTitle(c.book.title);
      ix.add(title, { book: c.book, tier: "title", collection: coll });
      for (const d of derivedNames(title, coll, byTitle)) ix.add(d.name, { book: c.book, tier: d.secondary ? "secondary" : "derived", collection: coll, ...(d.section && { section: d.section }) });
      for (const a of c.aliases ?? []) ix.add(normTitle(a), { book: c.book, tier: "acronym", collection: coll }, true);
      const on = / על (.+)$/.exec(title);
      if (on) {
        const author = title.slice(0, title.length - on[0].length);
        const list = ix.commentariesOn.get(on[1]!) ?? [];
        list.push({ book: c.book, author });
        ix.commentariesOn.set(on[1]!, list);
      }
    }
    ix.prune();
    for (const list of ix.byFirst.values()) list.sort((a, b) => b.words.length - a.words.length);
    for (const c of catalog) {
      const coll = ix.collections.get(c.book.key)!;
      const tractate = tractateOf(normTitle(c.book.title), coll);
      if (tractate) {
        const m = ix.tractates.get(tractate) ?? new Map<Collection, AliasTarget>();
        if (!m.has(coll)) m.set(coll, { book: c.book, tier: "derived", collection: coll });
        ix.tractates.set(tractate, m);
      }
      if (coll === "bavli" || coll === "tanakh") ix.addTruncations(normTitle(c.book.title), { book: c.book, tier: "derived", collection: coll });
    }
    return ix;
  }

  private add(name: string, target: AliasTarget, guarded = false): void {
    const words = nameWords(name);
    if (!words) return;
    const one = words.length === 1 ? words[0]! : null;
    if (guarded && one && !one.gershayimFromEnd && !one.geresh && one.key.length <= 3) {
      this.dropped++;
      return;
    }
    // a one-letter word alone (ב, מ) is never a book name
    if (one && one.key.length < 2) return;
    const key = wordsKey(words);
    let entry = this.byKey.get(key);
    if (!entry) {
      const numeric = words.length === 1 && (words[0]!.gershayimFromEnd === 1 || words[0]!.geresh) && strictValue(words[0]!.key) !== null;
      entry = { words, text: name, targets: [], numeric };
      this.byKey.set(key, entry);
      const list = this.byFirst.get(words[0]!.key) ?? [];
      list.push(entry);
      this.byFirst.set(words[0]!.key, list);
    }
    const same = entry.targets.findIndex((x) => x.book.key === target.book.key && x.section === target.section);
    if (same < 0) entry.targets.push(target);
    else if (TIER_RANK[target.tier] < TIER_RANK[entry.targets[same]!.tier]) entry.targets[same] = target;
  }

  /**
   * A database name shared by more than MAX_SHARED books ("רמב"ם" → 61 books, "תוספות", "ירושלמי") names
   * a collection, not a book: it is dropped. Titles and derived names are never pruned.
   */
  private prune(): void {
    for (const [key, e] of this.byKey) {
      const books = new Set(e.targets.map((t) => t.book.key));
      if (books.size <= MAX_SHARED) continue;
      const keep = e.targets.filter((t) => t.tier !== "acronym");
      if (keep.length === e.targets.length) continue;
      this.dropped += e.targets.length - keep.length;
      e.targets.splice(0, e.targets.length, ...keep);
      if (!keep.length) {
        this.byKey.delete(key);
        const list = this.byFirst.get(e.words[0]!.key)!;
        list.splice(list.indexOf(e), 1);
      }
    }
  }

  private addTruncations(title: string, target: AliasTarget): void {
    if (title.includes(" ")) return;
    const key = title.replace(/[ךםןףץ]/g, (c) => FINAL_PLAIN[c]!);
    for (let n = 3; n <= key.length - 1 && key.length - n <= 3; n++) {
      const k = key.slice(0, n);
      const prev = this.truncated.get(k);
      if (prev === null) continue;
      if (prev && prev.targets[0]!.book.key !== target.book.key) {
        this.truncated.set(k, null); // two titles share the stem: no guess
        continue;
      }
      this.truncated.set(k, { words: [{ key: k, gershayimFromEnd: 0, geresh: true }], text: `${k}'`, targets: [target], numeric: false });
    }
  }

  get size(): number {
    return this.byKey.size;
  }

  /** The names that start at toks[i], longest first. */
  matchAt(toks: readonly Tok[], i: number): AliasMatch[] {
    const t = toks[i];
    if (!t || t.kind !== "word") return [];
    const out: AliasMatch[] = [];
    for (const prefix of prefixesOf(t)) {
      const first = t.key.slice(prefix.length);
      for (const e of this.byFirst.get(first) ?? []) {
        const end = matchWords(e.words, toks, i, prefix.length);
        if (end !== null) out.push({ entry: e, from: i, to: end, prefix });
      }
    }
    if (!out.length && t.geresh && !t.gershayim) {
      for (const prefix of prefixesOf(t)) {
        const e = this.truncated.get(t.key.slice(prefix.length));
        if (e) out.push({ entry: e, from: i, to: i + 1, prefix });
      }
    }
    return out.sort((a, b) => b.to - a.to || a.prefix.length - b.prefix.length);
  }

  /** A whole name as written (for "ibid" book words and tests). */
  lookup(name: string): AliasEntry | undefined {
    const w = nameWords(normTitle(name));
    return w ? this.byKey.get(wordsKey(w)) : undefined;
  }
}

/** a database name shared by more books than this names a collection, not a book */
const MAX_SHARED = 3;
const FINAL_PLAIN: Readonly<Record<string, string>> = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };

/** The tractate a title belongs to ("משנה כתובות", "תלמוד ירושלמי כתובות", "כתובות" → "כתובות"). */
function tractateOf(title: string, coll: Collection): string | null {
  switch (coll) {
    case "bavli":
      return title;
    case "mishna":
      return title.slice("משנה ".length);
    case "yerushalmi":
      return title.slice("תלמוד ירושלמי ".length);
    case "tosefta":
      return title.slice("תוספתא ".length);
    default:
      return null;
  }
}

export const TIER_RANK: Readonly<Record<AliasTier, number>> = { title: 0, derived: 1, acronym: 2, secondary: 3 };

/** Title text as compared: quote marks unified, runs of spaces collapsed. Never written anywhere. */
export function normTitle(s: string): string {
  return s.replace(/[״“”]/g, '"').replace(/[׳‘’]/g, "'").replace(/\s+/g, " ").trim();
}

const PREFIX_RE = /^(?:ו?[בלמדהכש]|ו|ד[ב]|ש[ב]|וד|ומ|וה|ול|וכ|וש)$/;

/** "", and the prefixes the first word may carry ("ו", "ב", "וב", "דב"…), shortest first. */
function prefixesOf(t: Tok): string[] {
  const out = [""];
  const limit = t.gershayim ? Math.min(2, t.gershayimAt - 1) : Math.min(2, t.key.length - 2);
  for (let n = 1; n <= limit; n++) {
    const p = t.key.slice(0, n);
    if (PREFIX_RE.test(p)) out.push(p);
  }
  return out;
}

function matchWords(words: readonly AliasWord[], toks: readonly Tok[], i: number, prefixLen: number): number | null {
  let j = i;
  for (let w = 0; w < words.length; w++) {
    // commas and hyphens inside a title ("שולחן ערוך, אורח חיים") may be written or not
    while (w > 0 && toks[j]?.kind === "punct" && (toks[j]!.text === "," || toks[j]!.text === "-")) j++;
    const t = toks[j];
    if (!t || t.kind !== "word") return null;
    const a = words[w]!;
    const key = w === 0 ? t.key.slice(prefixLen) : t.key;
    if (key !== a.key) return null;
    const g = t.gershayim ? t.text.length - t.gershayimAt : 0;
    if (g !== a.gershayimFromEnd || t.geresh !== a.geresh) return null;
    if (w > 0 && !t.glued && toks[j - 1]?.kind === "punct" && "()[]".includes(toks[j - 1]!.text)) return null;
    j++;
  }
  return j;
}

/* ---------- derived names ---------- */

interface Derived {
  name: string;
  secondary?: boolean;
  section?: string;
}

function derivedNames(title: string, coll: Collection, byTitle: ReadonlyMap<string, readonly BookRef[]>): Derived[] {
  const out: Derived[] = [];
  for (const s of SPELLINGS) if (s[0] === title) for (const n of s.slice(1)) out.push({ name: n });
  switch (coll) {
    case "bavli":
      out.push({ name: `מסכת ${title}` }, { name: `מס' ${title}` }, { name: `גמרא ${title}` }, { name: `תלמוד בבלי ${title}` }, { name: `בבלי ${title}` });
      break;
    case "mishna": {
      const tractate = title.slice("משנה ".length);
      out.push({ name: `מסכת ${tractate}`, secondary: true });
      // "ברכות פ"א מ"ב": a bare tractate name with a chapter/mishna location means the Mishna
      out.push({ name: tractate, secondary: true });
      for (const s of SPELLINGS) if (s[0] === tractate) for (const n of s.slice(1)) out.push({ name: n, secondary: true });
      out.push({ name: `משנה מסכת ${tractate}` }, { name: `מתני' ${tractate}` });
      break;
    }
    case "yerushalmi": {
      const tractate = title.slice("תלמוד ירושלמי ".length);
      out.push({ name: `ירושלמי ${tractate}` }, { name: `ירוש' ${tractate}` }, { name: `ירושלמי מסכת ${tractate}` });
      for (const s of SPELLINGS) if (s[0] === tractate) for (const n of s.slice(1)) out.push({ name: `ירושלמי ${n}` });
      break;
    }
    case "tosefta": {
      const tractate = title.slice("תוספתא ".length);
      out.push({ name: `תוספתא מסכת ${tractate}` });
      for (const s of SPELLINGS) if (s[0] === tractate) for (const n of s.slice(1)) out.push({ name: `תוספתא ${n}` });
      break;
    }
    case "rambam": {
      const m = /^משנה תורה, (הלכות )?(.+)$/.exec(title);
      if (m) {
        const topic = m[2]!;
        for (const lead of ['רמב"ם', 'הרמב"ם', "משנה תורה", "יד החזקה", ""]) {
          for (const hl of m[1] ? ["הלכות", "הל'", "הלכ'"] : [""]) {
            const name = [lead, hl, topic].filter(Boolean).join(" ");
            if (name !== topic) out.push({ name });
          }
        }
      }
      break;
    }
    case "sa": {
      const part = title.slice("שולחן ערוך, ".length);
      for (const p of SA_PARTS[part] ?? [part]) {
        for (const n of SA_NAMES) out.push({ name: `${n} ${p}` });
        // "או"ח סי' א" alone is the Shulchan Aruch (the Tur needs its own name before it)
        if (p.includes('"')) out.push({ name: p });
      }
      break;
    }
    case "tur":
      for (const [part, abbrevs] of Object.entries(SA_PARTS)) for (const p of abbrevs) out.push({ name: `טור ${p}`, section: part });
      break;
    default:
      break;
  }
  // "X א" titles are often cited "X א'"
  const last = /^(.+) ([אבגד])$/.exec(title);
  if (last) out.push({ name: `${last[1]} ${last[2]}'` });
  void byTitle;
  return out;
}
