import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import { exportVerdicts, validateExport, validateLink, type LineFacts, type ValidationContext } from "../../../src/core/links/validate";

const book = (title: string, extra: Partial<BookRef> = {}): BookRef => ({ key: `k:${title}`, title, origin: "otzaria", isBaseBook: false, ...extra });
const A = book("ספר א");
const B = book("ספר ב");
const SEF = book("בראשית", { origin: "sefaria", isBaseBook: true });

/** Books of 10 lines; line 0 is a heading, line 5 an empty heading; every line is 20 chars. */
const ctx: ValidationContext = {
  lineCount: () => 10,
  line: (_b, i): LineFacts | undefined => (i === 9 ? undefined : { exists: i !== 5, heading: i === 0 || i === 5 ? 2 : null, anchorLength: 20 }),
};
const link = (over: Partial<Link> = {}): Link => ({
  id: "x", status: "new", provenance: "user",
  source: { book: A, line: 1 }, target: { book: B, line: 2 },
  declaredType: "reference", heRef2: "ספר ב 3", ...over,
});
const TECH_WORDS = /ref_[12]|heRef|anchor_src_hash|Conection|path_2|הגנרטור/;
const codes = (l: Link) => validateLink(l, ctx).map((p) => `${p.severity}:${p.code}`);

describe("validateLink — generator gates", () => {
  it("a clean link has no problems", () => expect(codes(link())).toEqual([]));
  it("legacy: קישור משורת כותרת מדולג", () => expect(codes(link({ source: { book: A, line: 0 } }))).toContain("error:export/heading-line"));
  it("an empty heading line does not exist in the database", () => expect(codes(link({ target: { book: B, line: 5 } }))).toContain("error:export/line-not-in-db"));
  it("legacy: שורה מחוץ לתחום נחסמת בייצוא", () => expect(codes(link({ target: { book: B, line: 10 } }))).toContain("error:export/line-out-of-range"));
  it("an unloaded line is reported as not verified, not guessed", () => expect(codes(link({ target: { book: B, line: 9 } }))).toEqual(["info:export/line-not-verified"]));
  // V3 F-087 (legacy validate, OtzariaLinker-v3.html:3045): a link from a line to the very same line was an error. The generator
  // knows a book by its title, so two editions of one title (a text file and the database) are the same book here too.
  it("legacy F-087: a link from a line to the very same line is an error; internal links of a book are not", () => {
    const same = link({ source: { book: A, line: 3 }, target: { book: A, line: 3 } });
    expect(codes(same)).toContain("error:export/same-line");
    const p = validateLink(same, ctx).find((x) => x.code === "export/same-line")!;
    expect(p.message).toContain("שורה 4");
    expect(p.message).not.toMatch(TECH_WORDS);
    // another edition of the same title is the same book for Otzaria
    expect(codes(link({ source: { book: A, line: 3 }, target: { book: { ...A, key: "other-edition" }, line: 3 } }))).toContain("error:export/same-line");
    // legitimate internal links: another line of the same book, a range that starts on the line, a range that holds it
    expect(codes(link({ source: { book: A, line: 3 }, target: { book: A, line: 4 } }))).not.toContain("error:export/same-line");
    expect(codes(link({ source: { book: A, line: 3 }, target: { book: A, line: 3, end: 6 } }))).not.toContain("error:export/same-line");
    expect(codes(link({ source: { book: A, line: 2, end: 6 }, target: { book: A, line: 3 } }))).not.toContain("error:export/same-line");
    // the same line number in another book is an ordinary link
    expect(codes(link({ source: { book: A, line: 3 }, target: { book: B, line: 3 } }))).not.toContain("error:export/same-line");
    // the very same range on both sides is the very same lines
    expect(codes(link({ source: { book: A, line: 3, end: 6 }, target: { book: A, line: 3, end: 6 } }))).toContain("error:export/same-line");
  });
  it("linker is never imported; an unknown type becomes OTHER", () => {
    expect(codes(link({ declaredType: "linker" }))).toContain("error:export/linker");
    expect(codes(link({ declaredType: "sifrei mitsvot" }))).toContain("warning:export/unknown-type");
  });
  it("for private use an unknown type is an error: the app's personal import rejects the whole file for it", () => {
    const priv = validateLink(link({ declaredType: "sifrei mitsvot" }), { ...ctx, purpose: "private" }).map((p) => `${p.severity}:${p.code}`);
    expect(priv).toContain("error:export/unknown-type");
  });
  it("a links file whose source title is no open book: the generator drops the whole file", () => {
    // real library case: "וזה לשונו - שובבי׳׳ם_links.json" — the database spells the book "…שובבי״ם"
    const unknown: BookRef = { key: "unresolved:וזה לשונו - שובבי׳׳ם", title: "וזה לשונו - שובבי׳׳ם", origin: "unknown" };
    expect(codes(link({ provenance: "file", status: "existing", source: { book: unknown, line: 1 } }))).toContain("warning:export/source-unknown");
    expect(codes(link())).not.toContain("warning:export/source-unknown");
  });
  /*
   * #18: the hold stays (a links file REPLACES the library's file of its source book), but the text said
   * "the database has links, so there is probably a file" — the mark is wide (it counts Sefaria's and
   * automatic links), and a commentary linked to a Gemara writes ITS OWN file. The message now names the
   * file that would be replaced, says why the mark is only a hint, and shows the way out.
   */
  it("library-file-not-loaded names the file, says the database mark is only a hint, and offers the commentary's own file", () => {
    const held = validateLink(link(), { ...ctx, linksFile: () => "missing", libraryMayHaveFile: () => true });
    const p = held.find((x) => x.code === "export/library-file-not-loaded")!;
    expect(p.severity).toBe("error"); // the hold is not weakened
    expect(p.message).toContain("ספר א_links.json");
    expect(p.message).toContain("ספריא"); // the mark counts Sefaria's links too
    expect(p.message).toMatch(/ייתכן/); // not stated as a fact
    expect(p.message).toContain("הקובץ של ספר המקור"); // it is the SOURCE book's file that is replaced
    expect(p.message).toMatch(/פירוש.*קובץ משלו/); // a commentary written as the source has a file of its own
    expect(p.message).not.toMatch(TECH_WORDS);
  });
  /* #18 with the library's file names: the message says whether the library HAS a file of that name; the hold is the same */
  it("library-file-not-loaded tells a book the library lists a file for from one it does not, and holds both", () => {
    const base = { ...ctx, linksFile: () => "missing" as const, libraryMayHaveFile: () => true, libraryFileListLabel: "רשימת הקבצים של הספרייה מ־2026-11-22" };
    const listed = validateLink(link(), { ...base, libraryFileListed: () => true }).find((x) => x.code === "export/library-file-not-loaded")!;
    expect(listed.severity).toBe("error");
    expect(listed.message).toContain("בספרייה יש קובץ בשם");
    expect(listed.message).toContain("2026-11-22");
    const unlisted = validateLink(link(), { ...base, libraryFileListed: () => false }).find((x) => x.code === "export/library-file-not-loaded")!;
    expect(unlisted.severity).toBe("error"); // the hold does not depend on the list being current
    expect(unlisted.message).toContain("אין קובץ בשם");
    expect(unlisted.message).toContain("2026-11-22");
    expect(unlisted.message).toContain("אם נוסף מאז");
    // without a list the text is the earlier one
    expect(validateLink(link(), base).find((x) => x.code === "export/library-file-not-loaded")!.message).toContain("ייתכן שבספרייה אין לו קובץ");
  });
  /*
   * docs/audit/POLICY_TO_CODES.md: the conditions of the filtering policy that had a code but no test of their own
   * (the codes were there; these lock them).
   */
  it("policy: a range that ends past the book is an error; an unknown target book is a warning; a commentary written towards its own base is flagged", () => {
    expect(codes(link({ target: { book: B, line: 3, end: 12 } }))).toContain("error:export/range-out-of-range");
    expect(codes(link({ target: { book: book("ספר שאינו פתוח", { origin: "unknown" }), line: 3 } }))).toContain("warning:export/target-unknown");
    const base = book("בסיס");
    const dep = book("פירוש על בסיס");
    expect(codes(link({ source: { book: dep, line: 1 }, target: { book: base, line: 2 }, declaredType: "commentary" }))).toContain("warning:export/reversed-dependency");
  });

  it("policy: when it is not known which book is the base, the link says so (info) and is not held", () => {
    const unknownBase = (title: string): BookRef => ({ key: `k:${title}`, title, origin: "otzaria" }); // no isBaseBook: a text file
    const got = codes(link({ source: { book: unknownBase("פירוש א"), line: 1 }, target: { book: unknownBase("ספר ב"), line: 2 }, declaredType: "commentary" }));
    expect(got).toContain("info:export/base-unknown");
    expect(got.filter((c) => c.startsWith("error:"))).toEqual([]);
  });

  // CHANGED on the reviewer's decision, with the user's approval (fix round before merge, task 2): the list is a snapshot, so a listed
  // book the database does not mark is no longer HELD (error export/library-file-not-loaded) but WARNED about
  // (warning export/library-file-snapshot). The private-export, database-mark and Sefaria-title parts below are unchanged.
  it("a book the library LISTS a file for, that the database does not mark, is warned about for the library only (no longer held) — a private export stays clean", () => {
    const listed = { ...ctx, linksFile: () => "missing" as const, libraryFileListed: () => true, libraryFileListLabel: "הרשימה" };
    const held = (purpose?: "private" | "submission") => validateLink(link(), { ...listed, ...(purpose && { purpose }) }).some((x) => x.code === "export/library-file-not-loaded");
    const warned = (purpose?: "private" | "submission") => validateLink(link(), { ...listed, ...(purpose && { purpose }) }).some((x) => x.code === "export/library-file-snapshot");
    expect(held()).toBe(false);
    expect(held("submission")).toBe(false);
    expect(warned()).toBe(true);
    expect(warned("submission")).toBe(true);
    expect(held("private")).toBe(false); // the app's personal import replaces nothing in the library
    expect(warned("private")).toBe(false);
    // the database's own mark still holds in every purpose, as before the list existed
    expect(validateLink(link(), { ...ctx, linksFile: () => "missing" as const, libraryMayHaveFile: () => true, purpose: "private" }).some((x) => x.code === "export/library-file-not-loaded")).toBe(true);
    // a user's own book that only shares a Sefaria title is refused by sefaria/not-library-edition: no second code
    const own = { ...listed, sefariaTitle: () => true, sefariaOwned: () => false };
    expect(validateLink(link(), own).map((x) => x.code)).not.toContain("export/library-file-not-loaded");
  });

  it("db links cannot be exported as file records", () => expect(codes(link({ provenance: "db", status: "existing" }))).toContain("error:export/db-link"));
  it("a companion 'הערות על X' target is silently dropped by the generator", () => {
    expect(codes(link({ target: { book: book("הערות על ספר א"), line: 2 } }))).toContain("warning:export/companion-merged");
  });
  it("an Otzaria title with ASCII quotes never matches the database", () => {
    expect(codes(link({ target: { book: book('רש"י על ספר'), line: 2 } }))).toContain("error:export/title-not-normalized");
  });
  it("range end on a heading, and anchors outside the line", () => {
    expect(codes(link({ target: { book: B, line: 3, end: 5 } }))).toContain("warning:export/range-end-heading");
    expect(codes(link({ anchor: { rawStart: 25 } }))).toContain("warning:export/anchor-out-of-line");
    expect(codes(link({ anchor: { rawStart: 3, rawEnd: 2 } }))).toContain("warning:export/anchor-end-ignored");
  });
  it("an anchor on a record that the generator flips is dropped", () => {
    expect(codes(link({ declaredType: "source", anchor: { rawStart: 1 } }))).toContain("warning:export/anchor-dropped-flip");
  });
});

describe("validateLink — Sefaria rules (legacy §10 ref_1/ref_2)", () => {
  // Compatibility review B1: for a submission to the library (the default) a missing ref_2 is an
  // ERROR — the weekly sync throws new_target_ref_required and the whole refresh fails. For private use
  // it is a warning. (The builder never blocks on it: it validates as "private", and the export fills
  // the ref from the database heRef when it can.) An untouched imported record is written anyway.
  it("יעד ספריא בלי ref_2 → שגיאה לשליחה לספרייה, אזהרה לשימוש פרטי ; עם ref_2 — כלום", () => {
    expect(codes(link({ target: { book: SEF, line: 2 } }))).toContain("error:sefaria/ref2-required");
    expect(validateLink(link({ target: { book: SEF, line: 2 } }), { ...ctx, purpose: "private" }).map((p) => `${p.severity}:${p.code}`)).toContain("warning:sefaria/ref2-required");
    expect(codes(link({ target: { book: SEF, line: 2 }, ref2: "Genesis 1:3" })).filter((c) => c.includes("ref2-required"))).toEqual([]);
  });
  it("legacy: רשומה שיובאה בלי ref_2 — השגיאה מדווחת, והייצוא כותב אותה כמו שהיא", () => {
    expect(codes(link({ target: { book: SEF, line: 2 }, status: "existing", provenance: "file" }))).toContain("error:sefaria/ref2-required");
  });
  it("a range end on a Sefaria side drifts in the sync: sefaria/range-side", () => {
    expect(codes(link({ target: { book: SEF, line: 2, end: 4 }, ref2: "Genesis 1:3" }))).toContain("error:sefaria/range-side");
    expect(codes(link({ source: { book: A, line: 1, end: 3 }, target: { book: SEF, line: 2 }, ref2: "Genesis 1:3" }))).not.toContain("error:sefaria/range-side");
  });
  it("Sefaria-owned is the library's list when given (B6): a DB-Sefaria book outside it must not carry ref_2", () => {
    const lecha = book("לכה דודי", { origin: "sefaria" });
    const owned = (b: BookRef) => b.title === "בראשית";
    const c2 = (l: Link) => validateLink(l, { ...ctx, sefariaOwned: owned }).map((p) => `${p.severity}:${p.code}`);
    expect(c2(link({ target: { book: lecha, line: 2 } })).filter((c) => c.startsWith("error:sefaria"))).toEqual([]);
    expect(c2(link({ target: { book: lecha, line: 2 }, ref2: "Lekha Dodi 1" }))).toContain("error:sefaria/ref2-side");
  });
  it("legacy: ref_1 ו-ref_2 יחד → שגיאה ; ref_2 על יעד שאינו ספריא → שגיאה", () => {
    expect(codes(link({ ref1: "a", ref2: "b" }))).toContain("error:sefaria/both-refs");
    expect(codes(link({ ref2: "Genesis 1:3" }))).toContain("error:sefaria/ref2-side");
  });
  it("anchors into Sefaria and anchor ranges touching Sefaria are refused by the pipeline", () => {
    const into = codes(link({ target: { book: SEF, line: 2 }, ref2: "Genesis 1:3", anchor: { rawStart: 1, rawEnd: 3 } }));
    expect(into).toContain("error:sefaria/anchor-into-sefaria");
    expect(into).toContain("error:sefaria/anchor-range");
  });
});

describe("validateExport", () => {
  it("links that collapse into one stored link are flagged as duplicates", () => {
    const base = book("בסיס", { isBaseBook: true });
    const dep = book("פירוש על בסיס");
    const a = link({ id: "a", source: { book: dep, line: 3 }, target: { book: base, line: 4 }, declaredType: "source" });
    const b = link({ id: "b", source: { book: base, line: 4 }, target: { book: dep, line: 3 }, declaredType: "commentary" });
    const res = validateExport([a, b], ctx);
    expect(res.get("a")!.map((p) => p.code)).not.toContain("export/duplicate");
    expect(res.get("b")!.map((p) => p.code)).toContain("export/duplicate");
  });

  it("two editions of one book open together (a text file and the database) are one book: same title, one stored link", () => {
    const base = book("בסיס", { isBaseBook: true });
    const dep = book("פירוש על בסיס");
    const depText = { ...dep, key: "text:פירוש על בסיס" };
    const a = link({ id: "a", source: { book: dep, line: 3 }, target: { book: base, line: 4 }, declaredType: "source" });
    const b = link({ id: "b", source: { book: depText, line: 3 }, target: { book: base, line: 4 }, declaredType: "source" });
    expect(validateExport([a, b], ctx).get("b")!.map((p) => p.code)).toContain("export/duplicate");
  });
});

describe("heRef_2 is never blank (compatibility review B3)", () => {
  it("an empty or whitespace heRef_2 is an error: the weekly sync rejects it", () => {
    expect(codes(link({ heRef2: "" }))).toContain("error:export/heref-missing");
    expect(codes(link({ heRef2: "   " }))).toContain("error:export/heref-missing");
  });
});

describe("'הערות על X' — the real outcome (compatibility review B5, Generator.kt:1004-1008)", () => {
  const C = book("הערות על ספר א");
  it("an unanchored record is merged; an anchored one cancels the merge and keeps the link", () => {
    expect(codes(link({ target: { book: C, line: 2 } }))).toContain("warning:export/companion-merged");
    const anchored = codes(link({ target: { book: C, line: 2 }, anchor: { rawStart: 3 } }));
    expect(anchored).toContain("info:export/companion-merge-cancelled");
    expect(anchored).not.toContain("warning:export/companion-merged");
  });

  it("a new anchored record on a note line the library's file merges today is warned about", () => {
    const merged = link({ id: "f1", provenance: "file", status: "existing", target: { book: C, line: 2 } });
    const anchoredSameLine = link({ id: "n1", target: { book: C, line: 3 }, anchor: { rawStart: 3 } });
    const anchoredOtherLine = link({ id: "n2", source: { book: A, line: 4 }, target: { book: C, line: 4 }, anchor: { rawStart: 3 } });
    const out = validateExport([merged, anchoredSameLine, anchoredOtherLine], ctx);
    expect(out.get("n1")!.map((p) => p.code)).toContain("export/companion-merge-broken");
    expect(out.get("n2")!.map((p) => p.code)).not.toContain("export/companion-merge-broken");
  });
});

describe("plain words for everyone, field names apart (audit F14)", () => {
  // every link here trips problems whose old text named the file's fields or the generator
  const cases: Link[] = [
    link({ declaredType: "linker" }),
    link({ heRef2: " " }),
    link({ target: { book: SEF, line: 2 } }),
    link({ source: { book: SEF, line: 2 }, target: { book: B, line: 2 } }),
    link({ ref1: "Genesis 1:1", ref2: "Genesis 1:2" }),
    link({ target: { book: SEF, line: 2, end: 4 }, ref2: "Genesis 1:3", anchor: { rawStart: 1, rawEnd: 4 } }),
    link({ source: { book: SEF, line: 2 }, ref1: "Genesis 1:3", anchor: { rawStart: 1 } }),
    link({ source: { book: book("פירוש על ספר ב"), line: 1 }, target: { book: book("ספר ב", { isBaseBook: true }), line: 2 }, declaredType: "commentary" }),
    link({ provenance: "db-copy" }),
  ];
  const problems = cases.flatMap((l) => validateLink(l, ctx));
  const TECH = /ref_[12]|heRef|anchor_src_hash|Conection|path_2|הגנרטור|\((?:start|end|source|linker)\)/;

  it("no message names a field of the links file", () => {
    expect(problems.length).toBeGreaterThan(10);
    for (const p of problems) expect(p.message, p.code).not.toMatch(TECH);
  });

  it("the field names are kept in the detail, for advanced mode", () => {
    const detail = (code: string) => problems.find((p) => p.code === code)?.detail;
    expect(detail("export/heref-missing")).toBe("heRef_2");
    expect(detail("sefaria/ref2-required")).toBe("ref_2");
    expect(detail("sefaria/ref1-side")).toBe("ref_1");
    expect(detail("sefaria/both-refs")).toBe("ref_1, ref_2");
    expect(detail("sefaria/pending-anchor-hash")).toContain("anchor_src_hash");
    expect(detail("export/linker")).toContain("linker");
  });
});

describe('private use: where a "source" link is written (PRIVATE_TO_BASE)', () => {
  const COMM = book("ביאור על בראשית", { origin: "personal" });
  const src = (over: Partial<Link> = {}) => link({ source: { book: COMM, line: 1 }, target: { book: SEF, line: 2 }, declaredType: "source", ref2: "Genesis 1:2", ...over });
  const run = (l: Link, c: ValidationContext) => validateExport([l], c).get(l.id)!;

  it("for private use it says, in plain words, that the link goes to the base's file as a commentary", () => {
    const p = run(src(), { ...ctx, purpose: "private" }).find((x) => x.code === "export/private-source-to-base")!;
    expect(p.severity).toBe("info");
    expect(p.message).toContain('בקובץ הקישורים של "בראשית"');
    expect(p.message).toContain("בפאנל המפרשים");
    expect(p.message).not.toMatch(/Conection|source|_links/);
    expect(p.detail).toContain('"commentary" ב־בראשית_links.json');
  });

  it("not for the library, nor for other types", () => {
    expect(run(src(), ctx).map((x) => x.code)).not.toContain("export/private-source-to-base");
    expect(run(src({ declaredType: "reference" }), { ...ctx, purpose: "private" }).map((x) => x.code)).not.toContain("export/private-source-to-base");
  });
});

/*
 * Otzaria's personal import reverses a dependent link only from a personal book into one that is not
 * (user_content_importer.dart:806-860, upstream/dev 36dad5bc; checked through the app's code by
 * scripts/live-test/dart/linker_bundle_test.dart, case R1). The generator decides by base books.
 */
describe("private use: Otzaria's personal import reverses a dependent link (export/private-reversed)", () => {
  const MINE = book("ספר שלי"); // a text book of the user's
  const RASHI = book('רש"י על בראשית', { origin: "sefaria" }); // the library's commentary
  const PDB = book("ספר במסד אישי", { origin: "personal" });
  const side = (b: BookRef) => (b === MINE || b === A || b === B ? "personal" : "other");
  const priv: ValidationContext = { ...ctx, purpose: "private", personalImportSide: side };
  const run = (l: Link, c: ValidationContext = priv) => validateExport([l], c).get(l.id)!.map((p) => `${p.severity}:${p.code}`);

  it("a personal base with a library commentary: warned, in plain words", () => {
    const l = link({ source: { book: MINE, line: 1 }, target: { book: RASHI, line: 2 }, declaredType: "commentary", ref2: "Rashi on Genesis 1:1:1" });
    expect(run(l)).toContain("warning:export/private-reversed");
    const p = validateLink(l, priv).find((x) => x.code === "export/private-reversed")!;
    expect(p.message).toContain('"רש"י על בראשית" יהיה הבסיס');
    expect(p.message).not.toMatch(/Conection|_links|isUserBook/);
  });

  it("not where the import and the library agree, not for the library, not for links-panel types", () => {
    // a personal commentary on a library base book: both reverse it (the generator by "X על <base>")
    expect(run(link({ source: { book: book("פירוש על בראשית"), line: 1 }, target: { book: SEF, line: 2 }, declaredType: "commentary", ref2: "Genesis 1:2" }), { ...priv, personalImportSide: (b) => (b === SEF ? "other" : "personal") })).not.toContain("warning:export/private-reversed");
    expect(run(link({ declaredType: "commentary" }))).not.toContain("warning:export/private-reversed"); // personal → personal
    expect(run(link({ source: { book: PDB, line: 1 }, declaredType: "commentary" }))).not.toContain("warning:export/private-reversed"); // database → personal
    expect(run(link({ source: { book: MINE, line: 1 }, target: { book: RASHI, line: 2 }, declaredType: "reference", ref2: "x" }))).not.toContain("warning:export/private-reversed");
    expect(run(link({ source: { book: MINE, line: 1 }, target: { book: RASHI, line: 2 }, declaredType: "commentary", ref2: "x" }), { ...ctx, personalImportSide: side })).not.toContain("warning:export/private-reversed");
    // a side whose place is unknown: no guess
    expect(run(link({ source: { book: MINE, line: 1 }, target: { book: RASHI, line: 2 }, declaredType: "commentary", ref2: "x" }), { ...priv, personalImportSide: () => undefined })).not.toContain("warning:export/private-reversed");
  });

  it('a "source" link from a library commentary to a personal base stays "source": at the base it would be reversed', () => {
    const l = link({ source: { book: RASHI, line: 2 }, target: { book: MINE, line: 1 }, declaredType: "source", ref1: "Rashi on Genesis 1:1:1" });
    const out = validateExport([l], priv).get(l.id)!;
    expect(out.map((p) => p.code)).not.toContain("export/private-source-to-base");
    const kept = out.find((p) => p.code === "export/private-source-kept")!;
    expect(kept.severity).toBe("warning");
    expect(kept.message).toContain('"ספר שלי" הוא ספר אישי');
    // with a personal commentary it still moves
    const ok = link({ source: { book: B, line: 2 }, target: { book: MINE, line: 1 }, declaredType: "source" });
    expect(validateExport([ok], priv).get(ok.id)!.map((p) => p.code)).toContain("export/private-source-to-base");
  });
});

/*
 * A personal book named like a book of the library (scripts/live-test/dart, "title clashes"): a text book
 * of the user's makes Otzaria reject the whole file; a personal database's book binds to the library's.
 */
describe("private use: a personal book named like a library book (export/private-title-in-library)", () => {
  const MINE = book("בראשית"); // the user's text file, named like the library's book
  const PDB = book("שמות", { origin: "personal" });
  const priv: ValidationContext = {
    ...ctx,
    purpose: "private",
    personalImportSide: (b) => (b === MINE || b === A || b === B ? "personal" : "other"),
    libraryHasTitle: (b) => b === MINE || b === PDB,
  };
  const codes = (l: Link, c: ValidationContext = priv) => validateLink(l, c).map((p) => `${p.severity}:${p.code}`);

  it("a text book: an error (the whole file is rejected); a personal database's book: a warning", () => {
    expect(codes(link({ source: { book: MINE, line: 1 } }))).toContain("error:export/private-title-in-library");
    expect(codes(link({ target: { book: MINE, line: 1 } }))).toContain("error:export/private-title-in-library");
    expect(codes(link({ source: { book: PDB, line: 1 } }))).toContain("warning:export/private-title-in-library");
    const p = validateLink(link({ source: { book: MINE, line: 1 } }), priv).find((x) => x.code === "export/private-title-in-library")!;
    expect(p.message).toContain("דוחה את כל קובץ הקישורים");
    expect(p.message).not.toMatch(/_links|Ambiguous/);
  });

  it("not for the library, and not when no library book has the title", () => {
    expect(codes(link({ source: { book: MINE, line: 1 } }), { ...priv, purpose: "submission" })).not.toContain("error:export/private-title-in-library");
    expect(codes(link())).not.toContain("error:export/private-title-in-library");
  });
});

/*
 * Fix round before merge (task 2): the list of the library's links-file names is a SNAPSHOT (a date and a commit). It is
 * a hint, never a block: a book it lists, that the database does not mark, is written with a visible warning that
 * says the list is a snapshot, from when, and that the user can check the file in the library. The database's own mark
 * still holds, as before; a private export stays clean.
 */
describe("the library's link-file list is a hint (a warning), not a hold", () => {
  const LABEL = "תמונת מצב של רשימת קובצי הקישורים של הספרייה מ־2026-11-22 (3207ad3f)";
  const snap = { ...ctx, linksFile: () => "missing" as const, libraryFileListed: () => true, libraryFileListLabel: LABEL };
  const FILE_LEVEL = ["export/library-file-not-loaded", "export/file-held", "export/file-unverified"];

  it("a listed book that the database does not mark is warned about, not held", () => {
    const got = validateLink(link(), snap);
    expect(got.filter((p) => p.severity === "error")).toEqual([]);
    const w = got.find((p) => p.code === "export/library-file-snapshot")!;
    expect(w.severity).toBe("warning");
    expect(got.some((p) => FILE_LEVEL.includes(p.code))).toBe(false);
  });

  it("the warning says it is a snapshot, from when, that the file may exist and replaced, and that the user can check it", () => {
    const m = validateLink(link(), snap).find((p) => p.code === "export/library-file-snapshot")!.message;
    expect(m).toContain("2026-11-22");
    expect(m).toContain("תמונת מצב");
    expect(m).toContain("ספר א_links.json");
    expect(m).toMatch(/יחליף/); // writing the file replaces the library's
    expect(m).toMatch(/בדקו/); // the user can look at the existing file
    expect(m).not.toMatch(TECH_WORDS);
  });

  it("the export plan writes the listed book's file and carries the warning (nothing is held)", () => {
    const v = exportVerdicts([link()], snap);
    expect(v.heldBack).toEqual([]);
    expect(v.written).toHaveLength(1);
    expect(v.warned.map((w) => w.problems.map((p) => p.code))).toEqual([["export/library-file-snapshot"]]);
  });

  it("the user can still confirm or load the file, and then there is nothing to warn about", () => {
    for (const state of ["confirmed-new", "imported"] as const)
      expect(validateLink(link(), { ...snap, linksFile: () => state }).map((p) => p.code)).not.toContain("export/library-file-snapshot");
  });

  it("a private export stays clean, and so does a user's own book that only shares a Sefaria title", () => {
    expect(validateLink(link(), { ...snap, purpose: "private" }).map((p) => p.code)).toEqual([]);
    expect(validateLink(link(), { ...snap, sefariaTitle: () => true, sefariaOwned: () => false }).map((p) => p.code)).not.toContain("export/library-file-snapshot");
  });

  it("a book the list does not name gets no warning of this kind", () => {
    expect(validateLink(link(), { ...snap, libraryFileListed: () => false }).map((p) => p.code)).toEqual([]);
  });

  it("when the database also marks the book, the hold stays and its text says the list is a snapshot, not a fact", () => {
    const p = validateLink(link(), { ...snap, libraryMayHaveFile: () => true }).find((x) => x.code === "export/library-file-not-loaded")!;
    expect(p.severity).toBe("error");
    expect(p.message).toContain("2026-11-22");
    expect(p.message).toMatch(/ייתכן/);
    expect(validateLink(link(), { ...snap, libraryMayHaveFile: () => true }).map((x) => x.code)).not.toContain("export/library-file-snapshot");
  });
});

/*
 * V7 live test 17 (docs/reviews/V7_LIVE_OTZARIA_TESTS.md, finding א): in Otzaria 0.9.98.3 a links file whose target book is
 * not in the user's library is refused WHOLE (importFiles is atomic) — the valid links of the file too. The tool cannot know
 * the user's personal folder, so a private export says it once per target book that is the user's own text book.
 */
describe("private use: a target that is the user's own text book (live test 17)", () => {
  const MINE = book("ספר שלי");
  const OTHER = book("ספר אחר שלי");
  const priv: ValidationContext = { ...ctx, purpose: "private", personalImportSide: (b) => (b === MINE || b === OTHER ? "personal" : "other") };
  const codes = (ls: Link[], c: ValidationContext = priv) => [...validateExport(ls, c).values()].flat().map((p) => `${p.severity}:${p.code}`);
  it("is warned: the whole file is refused if the book is not in the personal folder", () => {
    const l = link({ source: { book: MINE, line: 1 }, target: { book: OTHER, line: 2 }, declaredType: "reference" });
    expect(codes([l])).toContain("warning:export/private-target-must-exist");
    const p = validateLink(l, priv).find((x) => x.code === "export/private-target-must-exist")!;
    expect(p.message).toContain("ספר אחר שלי");
    expect(p.message).toContain("כל קובץ הקישורים");
  });
  it("not for a library target, and not for the library purpose", () => {
    expect(codes([link({ source: { book: MINE, line: 1 }, target: { book: SEF, line: 2 }, declaredType: "commentary", ref2: "Genesis 1:2" })])).not.toContain("warning:export/private-target-must-exist");
    expect(codes([link({ source: { book: MINE, line: 1 }, target: { book: OTHER, line: 2 }, declaredType: "reference" })], { ...ctx, personalImportSide: priv.personalImportSide })).not.toContain("warning:export/private-target-must-exist");
  });
});

describe("the INLINE_LINKER note says the whole file is refused by a version without it (live test 16)", () => {
  it("names the whole links file", async () => {
    const { inlineLinkerVersionNote } = await import("../../../src/core/links/connection-type");
    expect(inlineLinkerVersionNote()).toContain("כל קובץ הקישורים");
  });
});
