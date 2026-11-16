import { describe, expect, it } from "vitest";
import { CONNECTION_TYPES, canonicalTypeString } from "../../../src/core/links/connection-type";
import { dbLinkId, dbLinkOrigin } from "../../../src/core/links/db-links";
import { linePairIdentity, linkMatchIndex, matchLink, storedLinkIdentity } from "../../../src/core/links/equality";
import { adoptDbLink, type AdoptContext } from "../../../src/core/links/from-db";
import type { BookRef, Link } from "../../../src/core/links/model";
import { storedForm } from "../../../src/core/links/stored-form";
import { validateLink, type ValidationContext } from "../../../src/core/links/validate";
import { categoryOf } from "../../../src/linking/qa";

/*
 * Database links as first-class data (stage 10): the ONE equality rule, the origin a database link
 * most likely has, and turning a stored database link back into a links-file record ("העתקה
 * לפרויקט"). Books and lines are shaped like the real ones in tests/fixtures/db/seforim-v7-mini.db.
 */
const book = (key: string, title: string, origin: BookRef["origin"], isBaseBook: boolean): BookRef => ({ key, title, origin, isBaseBook });
const BERESHIT = book("s1:1", "בראשית", "sefaria", true);
const RASHI = book("s1:3695", 'רש"י על בראשית', "sefaria", false);
const ARZOT = book("s1:8050", "ארצות החיים", "otzaria", false);
const MEIR = book("s1:8051", "המאיר לארץ על ארצות החיים", "otzaria", false);
const MB = book("s1:3860", "משנה ברורה", "sefaria", false);
const SHAAR = book("s1:5976", "שער הציון", "otzaria", false);
// an Otzaria base book and a commentary on it (between two Sefaria books the generator stores nothing from a file)
const OBASE = book("s2:1", "ספר יצירה", "otzaria", true);
const OCOMM = book("s2:2", "פירוש על ספר יצירה", "otzaria", false);

const dbLink = (source: BookRef, sLine: number, target: BookRef, tLine: number, type: string, over: Partial<Link> = {}): Link => ({
  id: `s1:link:${sLine * 1000 + tLine}`,
  status: "existing",
  provenance: "db",
  source: { book: source, line: sLine },
  target: { book: target, line: tLine },
  declaredType: type,
  heRef2: `${target.title} ${tLine + 1}`,
  ...over,
});

const ctx = (over: Partial<AdoptContext> = {}): AdoptContext => ({
  line: (b, i) => ({ anchorText: "אב <b>ג</b> דה", heRef: `${b.title} ${i + 1}` }),
  hasLinksFile: () => false,
  ...over,
});
const codes = (r: { problems: { code: string; severity: string }[] }) => r.problems.map((p) => `${p.severity}:${p.code}`);

describe("the equality rule (core/links/equality.ts)", () => {
  it("a 'source' record from the commentary's file IS the 'commentary' link from the base's file", () => {
    const fromRashi = { source: { book: OCOMM, line: 4 }, target: { book: OBASE, line: 2 }, declaredType: "source" };
    const fromBase = { source: { book: OBASE, line: 2 }, target: { book: OCOMM, line: 4 }, declaredType: "commentary" };
    const stored = dbLink(OBASE, 2, OCOMM, 4, "commentary");
    expect(storedLinkIdentity(fromRashi)).toBe(storedLinkIdentity(fromBase));
    expect(storedLinkIdentity(fromRashi)).toBe(storedLinkIdentity(stored));
    expect(matchLink(fromRashi, linkMatchIndex([stored]))).toBe("same-link");
  });

  it("another type on the same two lines is 'same-lines', not the same link", () => {
    const ix = linkMatchIndex([dbLink(BERESHIT, 2, RASHI, 4, "commentary")]);
    expect(matchLink({ source: { book: RASHI, line: 4 }, target: { book: BERESHIT, line: 2 }, declaredType: "reference" }, ix)).toBe("same-lines");
    expect(matchLink({ source: { book: RASHI, line: 5 }, target: { book: BERESHIT, line: 2 }, declaredType: "source" }, ix)).toBeNull();
  });

  it("books are matched by title, not by session key (a link imported before its book was opened)", () => {
    const unresolved = { ...OBASE, key: "unresolved:ספר יצירה" };
    const ix = linkMatchIndex([dbLink(OBASE, 2, OCOMM, 4, "commentary")]);
    expect(matchLink({ source: { book: OCOMM, line: 4 }, target: { book: unresolved, line: 2 }, declaredType: "source" }, ix)).toBe("same-link");
    expect(linePairIdentity({ source: { book: unresolved, line: 2 }, target: { book: OCOMM, line: 4 } })).toBe(linePairIdentity({ source: { book: OCOMM, line: 4 }, target: { book: OBASE, line: 2 } }));
  });

  it("a database link is taken as stored — never re-converted (a stored COMMENTARY into a base book stays as is)", () => {
    const odd = dbLink(OCOMM, 4, OBASE, 2, "commentary");
    expect(storedLinkIdentity(odd)).toBe("פירוש על ספר יצירה#4>ספר יצירה#2:COMMENTARY");
    // the same record from a file WOULD be converted (flipped, because the title names its base)
    expect(storedLinkIdentity({ ...odd, provenance: "user" })).toBe("ספר יצירה#2>פירוש על ספר יצירה#4:COMMENTARY");
  });

  it("records the generator never stores have no identity, only a line pair", () => {
    expect(storedLinkIdentity({ source: { book: ARZOT, line: 1 }, target: { book: MEIR, line: 2 }, declaredType: "linker" })).toBeNull();
    expect(storedLinkIdentity({ source: { book: BERESHIT, line: 1 }, target: { book: RASHI, line: 2 }, declaredType: "commentary" })).toBeNull();
  });

  it("ranges and anchors are not part of the identity (records that differ in them merge into one link)", () => {
    const a = dbLink(ARZOT, 322, MEIR, 1306, "commentary");
    const b = { ...a, source: { ...a.source, end: 330 }, dbAnchors: [{ side: 0 as const, charStart: 28 }] };
    expect(storedLinkIdentity(a)).toBe(storedLinkIdentity(b));
  });
});

describe("where a database link most likely came from", () => {
  it("LINKER, Sefaria↔Sefaria, personal, otherwise the library", () => {
    expect(dbLinkOrigin(dbLink(RASHI, 1, BERESHIT, 1, "linker"))).toBe("linker");
    expect(dbLinkOrigin(dbLink(BERESHIT, 1, RASHI, 1, "commentary"))).toBe("sefaria");
    expect(dbLinkOrigin(dbLink(MB, 1, SHAAR, 1, "commentary"))).toBe("library");
    expect(dbLinkOrigin(dbLink({ ...ARZOT, origin: "personal" }, 1, MEIR, 1, "commentary"))).toBe("personal");
  });
  it("the database id is read back from a db link's id only", () => {
    expect(dbLinkId(dbLink(ARZOT, 1, MEIR, 2, "commentary", { id: "s3:link:13469515" }))).toBe(13469515);
    expect(dbLinkId({ id: "s3:link:5", provenance: "user" })).toBeNull();
  });
});

describe("copying a database link into the project (core/links/from-db.ts)", () => {
  it("a base → commentary link with an anchor stays in the base's file, unflipped, anchor in raw offsets", () => {
    // real: link 13469515 of seforim.db, from pninimToOtzaria/links/ארצות החיים_links.json (commentary, start)
    const db = dbLink(ARZOT, 322, MEIR, 1306, "commentary", { dbAnchors: [{ side: 0, charStart: 3, charEnd: 5 }] });
    const r = adoptDbLink(db, "c:1", ctx());
    expect(r.link).toMatchObject({ provenance: "db-copy", status: "new", source: { book: ARZOT, line: 322 }, target: { book: MEIR, line: 1306 }, declaredType: "commentary", anchor: { rawStart: 6, rawEnd: 12 } });
    expect(storedLinkIdentity(r.link!)).toBe(storedLinkIdentity(db));
    expect(codes(r)).toContain("info:adopt/heref");
    expect(codes(r)).toContain("warning:adopt/no-links-file");
  });

  it("without an anchor the library's convention wins: the commentary's own file, type 'source'", () => {
    const db = dbLink(ARZOT, 322, MEIR, 1306, "commentary");
    const r = adoptDbLink(db, "c:1", ctx());
    expect(r.link).toMatchObject({ source: { book: MEIR, line: 1306 }, target: { book: ARZOT, line: 322 }, declaredType: "source", heRef2: "ארצות החיים 323" });
    expect(storedForm(r.link!).flipped).toBe(true);
    expect(codes(r)).toContain("info:adopt/direction");
  });

  it("a file the project already holds decides the direction", () => {
    const db = dbLink(ARZOT, 322, MEIR, 1306, "commentary");
    const r = adoptDbLink(db, "c:1", ctx({ hasLinksFile: (t) => t === "ארצות החיים" }));
    expect(r.link).toMatchObject({ source: { book: ARZOT }, declaredType: "commentary" });
    expect(codes(r)).not.toContain("warning:adopt/no-links-file");
  });

  it("the anchor label is carried by heRef_2 (' אות X'), as the generator reads it", () => {
    // real: 4192761 משנה ברורה → שער הציון, label "יב"
    const db = dbLink(MB, 9463, SHAAR, 9327, "commentary", { dbAnchors: [{ side: 0, charStart: 3, label: "יב" }] });
    const r = adoptDbLink(db, "c:1", ctx());
    expect(r.link).toMatchObject({ source: { book: MB }, anchor: { rawStart: 6, label: "יב" }, heRef2: "שער הציון 9328 אות יב" });
  });

  it("ranges move with their side when the record is flipped", () => {
    const db = dbLink(ARZOT, 332, MEIR, 313, "commentary", { source: { book: ARZOT, line: 332 }, target: { book: MEIR, line: 313, end: 316 } });
    const r = adoptDbLink(db, "c:1", ctx());
    expect(r.link!.source).toEqual({ book: MEIR, line: 313, end: 316 });
    expect(storedForm(r.link!).storedTarget).toEqual({ book: MEIR, line: 313, end: 316 });
  });

  it("a targum stored base → targum is reproduced from the targum's file with its own type when the title names the base", () => {
    const TARGUM = book("s1:9", "תרגום על ארצות החיים", "otzaria", false);
    const BASE = { ...ARZOT, isBaseBook: true };
    const db = dbLink(BASE, 5, TARGUM, 5, "targum");
    const r = adoptDbLink(db, "c:1", ctx());
    expect(r.link).toMatchObject({ source: { book: TARGUM }, declaredType: "targum" });
    expect(storedLinkIdentity(r.link!)).toBe(storedLinkIdentity(db));
  });

  it("what a file cannot carry is said: target-side anchors, Sefaria's hidden side, several anchors, OTHER", () => {
    const db = dbLink(MB, 1, SHAAR, 1, "other", { dbAnchors: [{ side: 0, charStart: 0 }, { side: 0, charStart: 3 }, { side: 1, charStart: 0, charEnd: 2 }], dbSuppressed: [1] });
    const c = codes(adoptDbLink(db, "c:1", ctx()));
    expect(c).toEqual(expect.arrayContaining(["warning:adopt/anchors-extra", "warning:adopt/anchor-target", "warning:adopt/suppressed", "info:adopt/type-other"]));
  });

  it("LINKER, Sefaria↔Sefaria and links no record can produce are refused, with the reason", () => {
    expect(adoptDbLink(dbLink(RASHI, 1, BERESHIT, 1, "linker"), "c:1", ctx())).toMatchObject({ link: null, problems: [{ code: "adopt/linker", severity: "error" }] });
    expect(adoptDbLink(dbLink(BERESHIT, 1, RASHI, 1, "commentary"), "c:1", ctx())).toMatchObject({ link: null, problems: [{ code: "adopt/sefaria-both" }] });
    // a dependant type (not COMMENTARY: "source" could make that one) stored from a non-base book INTO
    // a base book, without "X על <base>": any file record is downgraded to OTHER or stored reversed
    const BASE = { ...MEIR, title: "ספר בסיס", isBaseBook: true };
    expect(adoptDbLink(dbLink(ARZOT, 1, BASE, 1, "targum"), "c:1", ctx()).problems.map((p) => p.code)).toEqual(["adopt/not-reproducible"]);
    expect(adoptDbLink(dbLink(ARZOT, 1, BASE, 1, "commentary"), "c:1", ctx()).link).toMatchObject({ source: { book: BASE }, declaredType: "source" });
  });

  it("every writable stored type round-trips: the copy is stored as the very same link", () => {
    for (const t of CONNECTION_TYPES.filter((x) => x !== "LINKER" && x !== "SOURCE")) {
      const db = dbLink(ARZOT, 10, MEIR, 20, canonicalTypeString(t));
      const r = adoptDbLink(db, "c:1", ctx());
      expect(r.link, t).not.toBeNull();
      expect(storedLinkIdentity(r.link!), t).toBe(storedLinkIdentity(db));
    }
  });
});

describe("validation of copied links and of links already in the database", () => {
  const vctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({ lineCount: () => 5000, line: () => ({ exists: true, heading: null, anchorLength: 50 }), ...over });
  const copy: Link = { id: "c:1", status: "new", provenance: "db-copy", source: { book: MEIR, line: 1306 }, target: { book: ARZOT, line: 322 }, declaredType: "source", heRef2: "ארצות החיים 323" };

  it("a copy waits for its book's links file: a new file would replace the library's", () => {
    const v = (status: "imported" | "confirmed-new" | "missing") => validateLink(copy, vctx({ linksFile: () => status })).map((p) => `${p.severity}:${p.code}`);
    expect(v("missing")).toContain("error:export/db-copy-no-file");
    expect(v("imported")).not.toContain("error:export/db-copy-no-file");
    expect(v("confirmed-new")).not.toContain("error:export/db-copy-no-file");
    expect(v("imported")).toContain("info:export/db-copy");
    expect(categoryOf("export/db-copy-no-file")).toBe("db-copy");
  });

  it("a user's link that the database already has is reported — exact, or only the same lines", () => {
    const ix = linkMatchIndex([dbLink(ARZOT, 322, MEIR, 1306, "commentary")]);
    const existing = (l: Link) => matchLink(l, ix);
    const user: Link = { ...copy, id: "u:1", provenance: "user" };
    expect(validateLink(user, vctx({ existing })).map((p) => p.code)).toContain("export/in-db");
    expect(validateLink({ ...user, declaredType: "reference" }, vctx({ existing })).map((p) => p.code)).toContain("export/in-db-other-type");
    // a copy IS that link: no report; an imported file record neither (it is where the link came from)
    expect(validateLink(copy, vctx({ existing })).map((p) => p.code)).not.toContain("export/in-db");
    expect(categoryOf("export/in-db")).toBe("in-db");
  });
});

describe("copying a database link with a range on a Sefaria side (compatibility review B1)", () => {
  it("keeps the start line only, and says why", () => {
    // שער הציון → משנה ברורה, a reference over three lines of the Sefaria book
    const db = dbLink(SHAAR, 4, MB, 10, "reference", { target: { book: MB, line: 10, end: 12 } });
    const r = adoptDbLink(db, "c:1", ctx({ hasLinksFile: () => true }));
    expect(r.link!.target).toEqual({ book: MB, line: 10 });
    expect(codes(r)).toContain("warning:adopt/sefaria-range");
    // an Otzaria side keeps its range
    const local = adoptDbLink(dbLink(SHAAR, 4, ARZOT, 10, "reference", { target: { book: ARZOT, line: 10, end: 12 } }), "c:2", ctx({ hasLinksFile: () => true }));
    expect(local.link!.target).toEqual({ book: ARZOT, line: 10, end: 12 });
  });
});
