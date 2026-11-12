import { pushTo } from "../../../core/collections";
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
  /**
   * another work of an author cited by name and a siman ("הריב"ש סי' קמ"ב" may be צוואת הריב"ש): a candidate
   * the place may confirm, scored below his responsa so that a place both have is no tie
   */
  readonly otherWork?: true;
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
  ["תהילים", "תהלים", "תילים", "תלים", "תה'"],
  ["ישעיהו", "ישעיה", "ישעי'"],
  ["ירמיהו", "ירמיה", "ירמי'"],
  ["יחזקאל", "יחזק'", "יחז'"],
  ["שיר השירים", 'שה"ש', 'שיר השירים', 'שיה"ש'],
  ["דברי הימים א", 'דה"א', "דברי הימים א'", 'דהי"א', 'דה"י א', "דה\"י א'"],
  ["דברי הימים ב", 'דה"ב', "דברי הימים ב'", 'דהי"ב', 'דה"י ב', "דה\"י ב'"],
  // 'ש"א', 'מ"א'… are numerals, and the database's names of other books (מגן אברהם, משנה ברורה): not
  // here — detect.ts reads them only as "(מ"א יד י)"
  ["שמואל א", 'שמ"א', "שמואל א'"],
  ["שמואל ב", 'שמ"ב', "שמואל ב'"],
  ["מלכים א", 'מל"א', "מלכים א'"],
  ["מלכים ב", 'מל"ב', "מלכים ב'"],
  ["בבא קמא", 'ב"ק', "בבא קמא"],
  ["בבא מציעא", 'ב"מ'],
  ["בבא בתרא", 'ב"ב'],
  ["עבודה זרה", 'ע"ז'],
  ["מועד קטן", 'מו"ק', 'מ"ק'],
  ["ראש השנה", 'ר"ה'],
  ["עירובין", "ערובין"],
  ["קידושין", "קדושין"],
  ["גיטין", "גטין"],
  // plene and Aramaic spellings of the Mishna's and the Yerushalmi's tractates ("בירושלמי (פ"ק דפיאה)", "(עוקצין ג:ח)")
  ["ביכורים", "בכורים"],
  ["בכורים", "ביכורים"],
  ["פאה", "פיאה"],
  ["כלאים", "כלאיים", "כלאין"],
  ["עוקצים", "עוקצין"],
  ["מדרש תהילים", 'שו"ט', "שוחר טוב", 'מדרש שו"ט'],
  ["בראשית רבה", 'ב"ר', 'בר"ר'],
  ["שמות רבה", 'ש"ר', 'שמו"ר'],
  ["ויקרא רבה", 'ו"ר', 'ויק"ר'],
  ["במדבר רבה", 'במ"ר', 'במד"ר', 'במדב"ר'],
  ["דברים רבה", 'ד"ר', 'דב"ר'],
  ["שיר השירים רבה", 'שהש"ר', 'שה"ש רבה'],
  ["רות רבה", 'רו"ר'],
  ["איכה רבה", 'איכ"ר'],
  ["קהלת רבה", 'קה"ר', 'קהל"ר'],
  ["אסתר רבה", 'אס"ר', 'אסת"ר'],
  ["בבא מציעא", "מציעא"],
  ["נדה", "נידה"],
  ["מגילה", "מגלה"],
  // the database's own names for it ("זוהר") fail the acronym guard (they do not start the title)
  ["ספר הזהר", "זוהר", "זהר", "הזוהר", "הזהר", "ספר הזוהר", 'זוה"ק', 'זה"ק'],
  ["תקוני הזהר", "תיקוני זוהר", "תיקוני הזוהר", "תקוני זוהר", "תקוני הזוהר", "תיקוני הזהר", "תקוני זהר", 'תקו"ז', 'תיקו"ז'],
];

/** the Rambam's topics by their old names (the censor's): "ע"ג", "עכו"ם" for עבודה זרה */
const OLD_TOPICS: Readonly<Record<string, readonly string[]>> = { "עבודה זרה וחוקות הגויים": ["עבודת גלולים", "עבודת כוכבים", "עבודת כוכבים ומזלות"] };

/** titles that are everyday words: "לב' דברים, א'" is "two things", "בשבת כ"ח" may be a date */
export const COMMON_TITLES: ReadonlySet<string> = new Set([
  "דברים", "שמות", "במדבר", "שופטים", "עזרא", "יונה", "רות", "שבת", "ברכות", "ביצה", "סוכה", "תמיד", "מכות", "נדרים", "חולין", "מנחות", "ערכין", "כריתות", "נזיר", "שבועות", "גיטין", "תענית", "מגילה", "חגיגה", "סוטה", "תמורה", "מעילה", "נדה", "בכורות", "זבחים", "פסחים",
]);

/** the parts of the Shulchan Aruch and the Tur: name → its abbreviations */
export const SA_PARTS: Readonly<Record<string, readonly string[]>> = {
  "אורח חיים": ['או"ח', "אורח חיים"],
  "יורה דעה": ['יו"ד', "יורה דעה"],
  "אבן העזר": ['אה"ע', 'אבה"ע', "אבן העזר"],
  "חושן משפט": ['חו"מ', 'ח"מ', "חושן משפט", "חשן משפט"],
};
const SA_NAMES = ["שולחן ערוך", 'שו"ע', "שלחן ערוך", 'ש"ע'];

const SA_COMMENTARY_TITLES = new Set(["משנה ברורה", "מגן אברהם", "שער הציון", "ביאור הלכה", "באר היטב", "טורי זהב", "שפתי כהן"]);

/**
 * A title in the library's spelling of the Shulchan Aruch: "שלחן ערוך" (16 commentaries: "אליה רבה על שלחן ערוך
 * אורח חיים", "הגהות רבי עקיבא איגר על שלחן ערוך …") and "חשן משפט" are the same work and part as "שולחן ערוך",
 * "חושן משפט".
 */
export const saSpelling = (title: string): string => title.replace(/(^|\s)שלחן ערוך(?=\s|,|$)/g, "$1שולחן ערוך").replace(/(^|\s)חשן משפט(?=\s|,|$)/g, "$1חושן משפט");

const BAVLI_SET = new Set(BAVLI);
/** the Mishna's tractates the Bavli has not: "משנה כסף", "משנה לחם" (books of the library) are no tractates */
const MISHNA_ONLY = new Set(["ברכות", "פאה", "דמאי", "כלאים", "שביעית", "תרומות", "מעשרות", "מעשר שני", "חלה", "ערלה", "ביכורים", "שקלים", "עדיות", "אבות", "מדות", "קינים", "כלים", "אהלות", "נגעים", "פרה", "טהרות", "מקואות", "מכשירין", "זבים", "טבול יום", "ידים", "עוקצים"]);
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
  if (t.startsWith("משנה ") && (BAVLI_SET.has(t.slice(5)) || MISHNA_ONLY.has(t.slice(5)))) return "mishna";
  if (SA_COMMENTARY_TITLES.has(t) || / על שולחן ערוך/.test(saSpelling(t))) return "sa-commentary";
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
  /** the Rambam's topics ("תרומות" for "משנה תורה, הלכות תרומות"), for "רמב"ם פ"ט מתרומות" (detect.ts) */
  readonly rambamTopics: { readonly topic: string; readonly target: AliasTarget }[] = [];
  private rambamWordsCache: { readonly words: readonly string[]; readonly target: AliasTarget }[] | null = null;
  /** the topics' words (letters, final forms unified) */
  get rambamTopicWords(): readonly { readonly words: readonly string[]; readonly target: AliasTarget }[] {
    this.rambamWordsCache ??= this.rambamTopics.map((x) => ({ words: (nameWords(x.topic) ?? []).map((w) => w.key), target: x.target }));
    return this.rambamWordsCache;
  }
  /** "יבמו'" → "יבמות": truncated one-word names of the Bavli and Tanakh (only written with a geresh) */
  private readonly truncated = new Map<string, AliasEntry | null>();
  /**
   * The responsa of an author, by the author's name as the titles write it ("תשובות הריב"ש" → "ריבש",
   * "שו"ת מהר"ם מינץ" → "מהרמ מינצ"), with the part of a work in parts ("… חלק ד" → 4). For "הריב"ש סי'
   * ת"ו", "בתשו' רמ"א סי' ס"ו", "בתשובת הרא"ש כלל ל"ה סי' ד'" (detect.ts).
   */
  readonly responsa = new Map<string, { readonly target: AliasTarget; readonly part: number | null }[]>();
  /** the first words of the authors' names (with and without the article "ה"), a quick test for the scan */
  readonly responsaFirst = new Set<string>();
  /**
   * the other books whose titles name an author of responsa (keys as in `responsa`): "חידושי הרשב"א על …",
   * "צוואת הריב"ש" — "<author> סי' ה" alone may be one of them, and the place decides (detect.ts)
   */
  readonly authorsElsewhere = new Map<string, AliasTarget[]>();
  /** names dropped by the guards (for the run's notes) */
  dropped = 0;
  /** database names of an author's several works, by first word (dropAuthorNames) */
  private readonly authorNames = new Map<string, AliasEntry[]>();
  /** while building: where each (book, section) sits in an entry's targets — findIndex per add was quadratic (A8) */
  private targetSlots: Map<AliasEntry, Map<string, number>> | null = new Map();

  static build(catalog: readonly CatalogBook[]): AliasIndex {
    const ix = new AliasIndex();
    const byTitle = new Map<string, BookRef[]>();
    for (const c of catalog) {
      const t = normTitle(c.book.title);
      pushTo(byTitle, t, c.book);
      ix.collections.set(c.book.key, collectionOf(c.book.title));
    }
    for (const c of catalog) {
      const coll = ix.collections.get(c.book.key)!;
      const title = normTitle(c.book.title);
      ix.add(title, { book: c.book, tier: "title", collection: coll });
      const topic = coll === "rambam" ? /^משנה תורה, הלכות (.+)$/.exec(title)?.[1] : undefined;
      if (topic) ix.rambamTopics.push({ topic, target: { book: c.book, tier: "derived", collection: coll } });
      // the old name of a topic, as printed editions wrote it ("פ"י מהל' ע"ג" — עבודת גלולים)
      if (topic && Object.hasOwn(OLD_TOPICS, topic)) for (const old of OLD_TOPICS[topic]!) ix.rambamTopics.push({ topic: old, target: { book: c.book, tier: "derived", collection: coll } });
      for (const d of derivedNames(title, coll, byTitle)) ix.add(d.name, { book: c.book, tier: d.secondary ? "secondary" : "derived", collection: coll, ...(d.section && { section: d.section }) });
      for (const a of c.aliases ?? []) {
        const name = normTitle(a);
        if (plausibleAcronym(name, title)) ix.add(name, { book: c.book, tier: "acronym", collection: coll }, true);
        else ix.dropped++;
      }
      const on = / על (.+)$/.exec(title);
      if (on) {
        const author = title.slice(0, title.length - on[0].length);
        const list = ix.commentariesOn.get(on[1]!) ?? [];
        list.push({ book: c.book, author });
        ix.commentariesOn.set(on[1]!, list);
      }
    }
    // "מדרש תנחומא" → "תנחומא": the database's name of this book (and maybe of "תנחומא בובר" too) is the title
    // without "מדרש" — a canonical form of THIS book, then (prune() drops the other's database name). Only a
    // name the database already gives it: "שמואל" (a sage, a book of the Tanakh) is no name of מדרש שמואל
    for (const c of catalog) {
      const x = /^מדרש (\S{4,})$/.exec(normTitle(c.book.title));
      const known = x ? ix.lookup(x[1]!) : undefined;
      if (x && (c.aliases ?? []).some((a) => normTitle(a) === x[1]) && !known?.targets.some((t) => t.tier === "title" || t.tier === "derived")) ix.add(x[1]!, { book: c.book, tier: "derived", collection: ix.collections.get(c.book.key)! });
    }
    ix.indexResponsa(catalog);
    ix.targetSlots = null; // add() is done; the guards below rewrite the target lists
    ix.dropAuthorNames();
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
    // a database name that ends in a number ("במדבר א") would swallow the location's first number
    const lastWord = words[words.length - 1]!;
    if (guarded && words.length > 1 && lastWord.key.length <= 2 && strictValue(lastWord.key) !== null && !normTitle(target.book.title).endsWith(` ${lastWord.key}`)) {
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
    const slotKey = `${target.book.key}|${target.section ?? ""}`;
    let slots = this.targetSlots?.get(entry);
    if (this.targetSlots && !slots) this.targetSlots.set(entry, (slots = new Map()));
    const same = slots ? (slots.get(slotKey) ?? -1) : entry.targets.findIndex((x) => x.book.key === target.book.key && x.section === target.section);
    if (same < 0) {
      slots?.set(slotKey, entry.targets.length);
      entry.targets.push(target);
    } else if (TIER_RANK[target.tier] < TIER_RANK[entry.targets[same]!.tier]) entry.targets[same] = target;
  }

  /**
   * A database name shared by more than MAX_SHARED books ("רמב"ם" → 61 books, "תוספות", "ירושלמי") names
   * a collection, not a book: it is dropped. Titles and derived names are never pruned.
   */
  /**
   * "הראב"ד" in book_acronym points at ONE of the many "השגות הראב"ד על …" books: it names the author,
   * not a book. A database name whose only book is "<author> על <base>", when the author has several
   * such books and the name says nothing of the base, is dropped.
   */
  private dropAuthorNames(): void {
    const works = new Map<string, number>();
    for (const list of this.commentariesOn.values()) for (const x of list) works.set(x.author, (works.get(x.author) ?? 0) + 1);
    for (const e of this.byKey.values()) {
      const keep = e.targets.filter((t) => {
        if (t.tier !== "acronym") return true;
        const m = / על (.+)$/.exec(normTitle(t.book.title));
        if (!m) return true;
        const author = normTitle(t.book.title).slice(0, -m[0].length);
        if ((works.get(author) ?? 0) < 2) return true;
        const baseKeys = new Set((nameWords(m[1]!) ?? []).map((w) => w.key));
        return e.words.some((w) => baseKeys.has(w.key));
      });
      if (keep.length !== e.targets.length) {
        this.dropped += e.targets.length - keep.length;
        // kept apart for "ש"ך חו"מ" (detect.ts authorPart) — only a name that can be the AUTHOR's: "ש"ך" of
        // "שפתי כהן", not "שו"ע" given to "ביאור הגר"א על שולחן ערוך …"
        const gone = e.targets.filter((t) => !keep.includes(t) && plausibleAcronym(e.text, normTitle(t.book.title).replace(/ על .+$/, "")));
        if (gone.length) {
          const list = this.authorNames.get(e.words[0]!.key) ?? [];
          list.push({ words: e.words, text: e.text, targets: gone, numeric: e.numeric });
          this.authorNames.set(e.words[0]!.key, list);
        }
        e.targets.splice(0, e.targets.length, ...keep);
      }
    }
  }

  /**
   * The names dropped as an author's ("ש"ך" for both "שפתי כהן על שולחן ערוך יורה דעה" and "… חושן משפט"),
   * starting at toks[i]: a name that does not say which work, until a part after it does ("ש"ך חו"מ סי'
   * צ"א", detect.ts).
   */
  authorNamesAt(toks: readonly Tok[], i: number): AliasMatch[] {
    const t = toks[i];
    if (!t || t.kind !== "word" || !t.gershayim) return [];
    // most words start no such name (the scan asks for every word)
    const k = t.key;
    if (!this.authorNames.has(k) && !this.authorNames.has(k.slice(1)) && !this.authorNames.has(k.slice(2))) return [];
    const out: AliasMatch[] = [];
    for (const prefix of prefixesOf(t)) {
      for (const e of this.authorNames.get(t.key.slice(prefix.length)) ?? []) {
        const end = matchWords(e.words, toks, i, prefix.length);
        if (end !== null) out.push({ entry: e, from: i, to: end, prefix });
      }
    }
    return out.sort((a, b) => b.to - a.to);
  }

  private prune(): void {
    for (const [key, e] of this.byKey) {
      // a name that is a title or a canonical form of some book never ALSO points at a database name's book
      // ("חושן משפט" is the Shulchan Aruch, not a gloss whose book_acronym says so)
      if (e.targets.some((t) => t.tier === "title" || t.tier === "derived") && e.targets.some((t) => t.tier === "acronym")) {
        const keep = e.targets.filter((t) => t.tier !== "acronym");
        this.dropped += e.targets.length - keep.length;
        e.targets.splice(0, e.targets.length, ...keep);
      }
      const books = new Set(e.targets.map((t) => t.book.key));
      if (!e.targets.length) {
        this.byKey.delete(key);
        const list = this.byFirst.get(e.words[0]!.key)!;
        list.splice(list.indexOf(e), 1);
        continue;
      }
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

  private indexResponsa(catalog: readonly CatalogBook[]): void {
    const authorOf = new Map<string, string>();
    for (const c of catalog) {
      const title = normTitle(c.book.title);
      const m = RESPONSA_TITLE.exec(title);
      if (!m) continue;
      const key = authorKey(m[1]!);
      if (!key) continue;
      const part = m[2] ? strictValue(m[2]) : null;
      const list = this.responsa.get(key) ?? [];
      list.push({ target: { book: c.book, tier: "derived", collection: this.collections.get(c.book.key)! }, part });
      this.responsa.set(key, list);
      const w0 = key.split(" ")[0]!;
      this.responsaFirst.add(w0).add(`ה${w0}`);
      authorOf.set(c.book.key, key);
    }
    if (!this.responsa.size) return;
    // an author whose name is in another book's title has other works: "<author> סי' ה" alone may be one of them
    for (const c of catalog) {
      if (authorOf.has(c.book.key)) continue;
      const words = (nameWords(normTitle(c.book.title)) ?? []).map((w) => (w.gershayimFromEnd && w.key.startsWith("ה") ? w.key.slice(1) : w.key));
      for (let a = 0; a < words.length; a++)
        for (let n = 1; n <= 3 && a + n <= words.length; n++) {
          const k = words.slice(a, a + n).join(" ");
          if (!this.responsa.has(k)) continue;
          const list = this.authorsElsewhere.get(k) ?? [];
          if (!list.some((x) => x.book.key === c.book.key)) list.push({ book: c.book, tier: "derived", collection: this.collections.get(c.book.key)! });
          this.authorsElsewhere.set(k, list);
        }
    }
  }

  private addTruncations(title: string, target: AliasTarget): void {
    if (title.includes(" ")) return;
    const key = title.replace(/[ךםןףץ]/g, (c) => FINAL_PLAIN[c]!);
    // stems of three letters or more, short of the word by one to three ("סנהד'" for סנהדרין, "יבמו'" for יבמות)
    for (let n = Math.max(3, key.length - 3); n <= key.length - 1; n++) {
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
        // "כפסחים ח' ע"ב" is a title with כ, "כאה"ע" a quoted name; "כתלים" is "walls", not כ + a spelling of
        // תהילים: with כ only a title or a quoted name
        if (prefix.endsWith("כ") && !e.targets.some((x) => x.tier === "title") && !e.words.some((w) => w.gershayimFromEnd || w.geresh)) continue;
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

/** words that start many titles: alone they name a genre, not a book ("תשובות רמ"א" is not the Radbaz) */
const GENERIC_WORDS = new Set(["משנה", "תוס'", "תוספות", "תוספ'", "תשובות", "תשובה", 'שו"ת', "שות", "חידושי", "חדושי", "ספר", "פירוש", "הגהות", "ביאור", "באור", "שאלות", "דרשות", "ליקוטי", "לקוטי", "קונטרס", "הלכות", "מסכת", "פרק", "ילקוט", "מדרש", "אגרת", "אגרות", "סדר", "תורת", "שער", "ספרי", "מאמר"]);

/**
 * an author's name alone ("הרמב"ם", "רמ"א", "הרא"ש") is how a citation says WHOSE words, before the place
 * ("הרמב"ם פ"ד מהל' תרומות", "הרא"ש פ"ק דב"ב"): book_acronym gives it to one of the author's books
 * (איגרות הרמב"ם, שו"ת רמ"א, תשובות הרא"ש), which then swallowed the place — 179 missed LINKER
 * citations in the sample of §6.8. Titles that start with the name ("רמב"ם …") are not affected.
 */
const AUTHOR_NAMES = new Set(['רמב"ם', 'רמב"ן', 'רמ"א', 'רשב"א', 'רא"ש', 'ריטב"א', 'ר"ן', 'רי"ף', 'רש"י', 'מהרש"א', 'מהרש"ל', 'רשב"ם', 'ראב"ד', 'ר"מ', 'רמב"ה', 'רא"ה']);

/** common abbreviations that are never a book's name ("חלק א", "עמוד א", "דיבור המתחיל") */
// "מ"ע", "ל"ת": מצוות עשה / לא תעשה ("סמ"ג [מ"ע סימן כ"א]"), not מאירת עיניים, whose name is "סמ"ע"
// "ירוש'" is the word for the Yerushalmi ("בירוש' פ"ק דסנהד'"), which the database gives to one of its tractates (הוריות)
const NOT_NAMES = new Set(['ח"א', 'ח"ב', 'ח"ג', 'ח"ד', 'ח"ה', 'ח"ו', 'ע"א', 'ע"ב', 'ד"ה', 'א"כ', 'ר"ל', 'ס"ס', 'ס"ה', 'א"ר', 'ר"א', 'ר"י', 'א"ל', 'מ"ע', 'ל"ת', 'מל"ת', "ירוש'", "ירושל'", "ירושלמי", "גמ'", "בבלי", "תלמוד"]);

/**
 * book_acronym is machine-made and noisy (42K names; "מלכות" for a commentary on הלכות שביתת יום
 * טוב, "ריב"ש" for אבן האזל). A name is kept only when it can come from the title: an unquoted single
 * word must be a word of the title (or the start of one); a quoted acronym's letters must appear in the
 * title's letters in order (a leading ה aside). Multi-word names are kept (they rarely collide).
 */
export function plausibleAcronym(name: string, title: string): boolean {
  if (NOT_NAMES.has(name)) return false;
  if (GENERIC_WORDS.has(name)) return false;
  if (AUTHOR_NAMES.has(name.replace(/^ה(?=.*")/, ""))) return false;
  const words = nameWords(name);
  if (!words) return false;
  const titleKeys = (nameWords(title) ?? []).map((w) => w.key);
  if (words.length > 1) return true;
  const w = words[0]!;
  // an unquoted single word must BE the title's first word ("חתם" no, "שמואל" for "אגרת שמואל על רות" no). Not
  // only its start: the database's truncations ("קידוש", "שבוע", "נדרי", "מצוד") lost their geresh and are
  // everyday words — "[בקידוש י"ט]" is the Kiddush of a festival; with the geresh they are read as truncations
  if (!w.gershayimFromEnd && !w.geresh) return titleKeys.length > 0 && titleKeys[0] === w.key;
  const letters = titleKeys.join("");
  const want = w.key.replace(/^ה/, "");
  let at = 0;
  for (const ch of want) {
    at = letters.indexOf(ch, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

/** a title of responsa: "תשובות הריב"ש", "שו"ת מהרי"ק", "שאלות ותשובות רמ"א", "שו"ת הרשב"א חלק ד" → the author, the part */
const RESPONSA_TITLE = /^(?:שו"ת|שות|תשובות|שאלות ותשובות)\s+(.+?)(?:\s+חלק\s+([א-ת]{1,2}))?$/;

/** An author's name as compared: letters only, final forms unified, the article of an acronym dropped ("הריב"ש" → "ריבש"). */
export function authorKey(name: string): string | null {
  const words = nameWords(name);
  if (!words?.length || words.length > 3) return null;
  return words.map((w) => (w.gershayimFromEnd && w.key.startsWith("ה") && w.key.length > 2 ? w.key.slice(1) : w.key)).join(" ");
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

const firstWordsCache = new WeakMap<ReadonlyMap<string, readonly BookRef[]>, Map<string, number>>();

/** how many Rambam topics start with each word */
function rambamFirstWords(byTitle: ReadonlyMap<string, readonly BookRef[]>): Map<string, number> {
  let m = firstWordsCache.get(byTitle);
  if (!m) {
    m = new Map();
    for (const t of byTitle.keys()) {
      const x = /^משנה תורה, הלכות (\S+)/.exec(t);
      if (x) m.set(x[1]!, (m.get(x[1]!) ?? 0) + 1);
    }
    firstWordsCache.set(byTitle, m);
  }
  return m;
}

/**
 * Plene/defective spellings of a Rambam topic as books write it: "מלווה ולווה" / "מלוה ולוה",
 * "גירושין" / "גרושין". Only doubled ו/י collapsed, and a י after the first letter of a long word dropped.
 */
function spellingVariants(topic: string): string[] {
  const out = new Set([topic]);
  const collapsed = topic.replace(/וו/g, "ו").replace(/יי/g, "י");
  out.add(collapsed);
  out.add(collapsed.split(" ").map((w) => (w.length >= 5 && w[1] === "י" ? w[0] + w.slice(2) : w)).join(" "));
  return [...out];
}

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
        // "הל' זכיה" for "זכייה ומתנה", "הל' רוצח" for "רוצח ושמירת נפש": the first word alone, when no other
        // topic starts with it ("שביתת עשור" / "שביתת יום טוב" share theirs)
        const first = topic.split(" ")[0]!;
        // …and not the start of another topic's first word ("מעשר" / "מעשרות")
        const words = rambamFirstWords(byTitle);
        const alone = topic.includes(" ") && first.length >= 4 && words.get(first) === 1 && ![...words.keys()].some((w) => w !== first && w.startsWith(first));
        const topics = alone ? [topic, first] : [topic];
        for (const lead of ['רמב"ם', 'הרמב"ם', "משנה תורה", "יד החזקה", ""]) {
          for (const hl of m[1] ? ["הלכות", "הל'", "הלכ'", "ה'"] : [""]) {
            for (const t of topics.flatMap(spellingVariants)) {
              const name = [lead, hl, t].filter(Boolean).join(" ");
              // "ה' שבת" alone is too close to the divine name: only with a lead word
              if (name !== t && !(hl === "ה'" && !lead && t.split(" ").length < 2)) out.push({ name });
            }
          }
        }
      }
      break;
    }
    case "sa": {
      const part = title.slice("שולחן ערוך, ".length);
      for (const p of (Object.hasOwn(SA_PARTS, part) ? SA_PARTS[part] : undefined) ?? [part]) {
        for (const n of [...SA_NAMES, 'רמ"א', 'הרמ"א']) out.push({ name: `${n} ${p}` });
        // "או"ח סי' א", "בחושן משפט סי' ק"צ" alone are the Shulchan Aruch (the Tur needs its own name before it)
        out.push({ name: p });
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
  // "שו"ת הרשב"א חלק ו" is cited "שו"ת הרשב"א ח"ו"
  const part = /^(.+) חלק ([א-ט])$/.exec(title);
  if (part) out.push({ name: `${part[1]} ח"${part[2]}` });
  // "מדרש תנחומא" is cited "תנחומא" (only when the word names nothing else: added after all names, build())
  return out;
}
