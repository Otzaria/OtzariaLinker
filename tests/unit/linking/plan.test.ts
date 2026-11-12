import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../src/core/links/model";
import { EVIDENCE_MIN, evidenceFromCounts, evidenceToFollow, LINKED_MIN, linkedFields, linkedProps, notesBaseKey, planMaxLink, singleBookEngines, type PlanBook, type SingleEngineId } from "../../../src/linking/plan";

const book = (key: string, title: string, more: Partial<PlanBook> = {}): PlanBook => ({ key, title, origin: "otzaria", ...more });
/** the pair relations alone: the citations engine (single-book) would add a step for every selected book */
const planPairs = (input: Parameters<typeof planMaxLink>[0]) => planMaxLink({ singleEngines: [], ...input });
const steps = (p: ReturnType<typeof planMaxLink>) => p.steps.map((s) => `${s.engine}:${s.source.title}${s.kind === "pair" ? `>${s.target.title}` : ""}`);

describe("notesBaseKey: which titles are notes books", () => {
  it("reads the notes-companion patterns Otzaria's library uses", () => {
    expect(notesBaseKey("הערות על מדרש תנחומא")).toBe("מדרש תנחומא");
    expect(notesBaseKey("הערות באותיות על מדרש ויסעו (ילקוט מדרשים)")).toBe("מדרש ויסעו (ילקוט מדרשים)");
    expect(notesBaseKey("הערות שוליים על מכילתא דרבי שמעון בן יוחאי")).toBe("מכילתא דרבי שמעון בן יוחאי");
    expect(notesBaseKey("הערות לספר דוגמה")).toBe("דוגמה"); // the safe name; "ספר " is a title prefix on both sides
  });
  it("leaves commentaries and other words alone", () => {
    expect(notesBaseKey("כפי אהרן הערות על ספר חוקי חיים")).toBeNull();
    expect(notesBaseKey('רש"י על בראשית')).toBeNull();
    expect(notesBaseKey("הערותיו של הרב")).toBeNull();
    expect(notesBaseKey("הערות")).toBeNull();
  });
});

describe("planMaxLink — relations by title", () => {
  const lib = [
    book("db:1", "בראשית", { origin: "sefaria", isBaseBook: true }),
    book("t:1", 'רש"י על בראשית'),
    book("t:2", "תרגום אונקלוס על בראשית"),
    book("t:3", "ספר דוגמה"),
    book("t:4", "הערות לספר דוגמה"),
    book("t:5", "חידושים"),
    book("t:6", "פירוש על ויקרא"),
  ];

  it("a commentary gets headings and dibur-hamatchil against its base; a targum only headings", () => {
    const p = planPairs({ selected: ["t:1", "t:2"], library: lib });
    expect(steps(p)).toEqual(['headings:רש"י על בראשית>בראשית', 'dibur-hamatchil:רש"י על בראשית>בראשית', "headings:תרגום אונקלוס על בראשית>בראשית"]);
    expect(p.books[1]!.decisions.join(" ")).toContain("תרגום");
    expect(p.steps.every((s) => s.kind === "pair" && s.relation.via === "title")).toBe(true);
    expect(p.steps[0]!.why).toContain("כותרות");
  });

  it("a notes book runs the footnotes engine with the MAIN book as the source", () => {
    const p = planPairs({ selected: ["t:4"], library: lib });
    expect(steps(p)).toEqual(["footnotes:ספר דוגמה>הערות לספר דוגמה"]);
    expect(p.steps[0]!.why).toContain("הערות");
  });

  it("selecting a base book brings in the open commentaries and notes written on it", () => {
    expect(steps(planPairs({ selected: ["db:1"], library: lib }))).toHaveLength(3);
    expect(steps(planPairs({ selected: ["t:3"], library: lib }))).toEqual(["footnotes:ספר דוגמה>הערות לספר דוגמה"]);
  });

  it("lists every selected book it cannot link, with the reason; never a step twice", () => {
    const p = planPairs({ selected: ["t:5", "t:6", "t:1", "db:1", "t:1"], library: lib });
    const row = (k: string) => p.books.find((b) => b.book.key === k)!;
    expect(row("t:5").skipped).toContain("אין לו ספר בסיס");
    expect(row("t:6").skipped).toContain("ויקרא");
    expect(row("t:1").skipped).toBeUndefined();
    expect(p.books).toHaveLength(4);
    expect(new Set(p.steps.map((s) => s.id)).size).toBe(p.steps.length);
    expect(p.identified).toBe(2);
  });

  it("unticked engines do not run, and the book says why", () => {
    const p = planPairs({ selected: ["t:1", "t:4"], library: lib, engines: new Set(["headings"]) });
    expect(steps(p)).toEqual(['headings:רש"י על בראשית>בראשית']);
    expect(p.books.find((b) => b.book.key === "t:4")!.skipped).toContain("לא סומנו");
    expect(p.perEngine).toEqual({ headings: 1 });
  });
});

describe("planMaxLink — the database's declaration (book_base_text)", () => {
  it("wins over the title, and says so when they disagree", () => {
    const lib = [book("d:382", "שולחן ערוך, אורח חיים"), book("d:3860", "משנה ברורה", { bases: ["d:382"], dependence: "commentary" }), book("d:9", "פירוש על משנה ברורה", { bases: ["d:382"] })];
    const p = planPairs({ selected: ["d:3860", "d:9"], library: lib });
    expect(steps(p)).toContain("headings:משנה ברורה>שולחן ערוך, אורח חיים");
    expect(p.steps.find((s) => s.source.key === "d:3860")!.kind === "pair" && (p.steps.find((s) => s.source.key === "d:3860") as { relation: { via: string } }).relation.via).toBe("base-text");
    expect(p.books[1]!.decisions.join(" ")).toContain("לפי המסד");
  });

  it("a book on several bases: one relation per base, each scoped to the section headed by that base", () => {
    const lib = [book("d:1", "בראשית"), book("d:2", "שמות"), book("d:3", "מדרש לקח טוב", { bases: ["d:1", "d:2"], dependence: "midrash" })];
    const p = planPairs({ selected: ["d:3"], library: lib });
    expect(steps(p)).toEqual(["headings:מדרש לקח טוב>בראשית", "dibur-hamatchil:מדרש לקח טוב>בראשית", "headings:מדרש לקח טוב>שמות", "dibur-hamatchil:מדרש לקח טוב>שמות"]);
    const scopes = p.steps.map((s) => (s.kind === "pair" ? s.relation.scope : undefined));
    expect(scopes.map((x) => x?.section)).toEqual(["בראשית", "בראשית", "שמות", "שמות"]);
    expect(p.books[0]!.decisions.join(" ")).toContain("2 ספרים");
  });

  it("several declared bases, only one open: still scoped (never the whole book against one base)", () => {
    const lib = [book("d:1", "בראשית"), book("d:3", "חזקוני", { bases: ["d:1", "d:9"] })];
    const p = planPairs({ selected: ["d:3"], library: lib });
    expect(p.steps.every((s) => s.kind === "pair" && s.relation.scope?.section === "בראשית")).toBe(true);
  });

  it("a notes book on several bases is not planned", () => {
    const lib = [book("d:1", "בראשית"), book("d:2", "שמות"), book("d:3", "הערות לתורה", { bases: ["d:1", "d:2"] })];
    const p = planPairs({ selected: ["d:3"], library: lib });
    expect(p.steps).toEqual([]);
    expect(p.books[0]!.skipped).toContain("2 ספרים");
  });

  it("dependenceType targum: no dibur-hamatchil even without 'תרגום' in the title", () => {
    const lib = [book("d:1", "בראשית"), book("d:2", "אונקלוס", { bases: ["d:1"], dependence: "targum" })];
    expect(steps(planPairs({ selected: ["d:2"], library: lib }))).toEqual(["headings:אונקלוס>בראשית"]);
  });

  it("a 'הערות על X' notes book is planned with the real outcome: the footnotes engine anchors every record, which cancels the merge (B5)", () => {
    const lib = [book("d:1", "מדרש ויסעו"), book("d:2", "הערות על מדרש ויסעו", { bases: ["d:1"] })];
    const p = planPairs({ selected: ["d:2"], library: lib });
    expect(steps(p)).toEqual(["footnotes:מדרש ויסעו>הערות על מדרש ויסעו"]);
    expect(p.steps[0]!.why).toContain("מבטלים את המיזוג");
    expect(p.steps[0]!.why).not.toContain("נמחקים בשקט");
  });
});

describe("planMaxLink — single-book engines (the citations slot)", () => {
  it("the citations engine is the one single-book engine", () => {
    expect(singleBookEngines()).toEqual(["citations"]);
  });

  it("a registered single-book engine runs once on every selected book, related or not", () => {
    const lib = [book("d:1", "בראשית"), book("t:1", 'רש"י על בראשית'), book("t:2", "חידושים")];
    const fake = "citations" as unknown as SingleEngineId;
    const p = planMaxLink({ selected: ["t:1", "t:2"], library: lib, singleEngines: [fake] });
    expect(steps(p)).toEqual(['headings:רש"י על בראשית>בראשית', 'dibur-hamatchil:רש"י על בראשית>בראשית', 'citations:רש"י על בראשית', "citations:חידושים"]);
    expect(p.books[1]!.skipped).toBeUndefined(); // a book without relations is still read by the single-book engine
    const off = planMaxLink({ selected: ["t:2"], library: lib, singleEngines: [fake], engines: new Set(["headings"]) });
    expect(off.steps).toEqual([]);
  });

  it("pairs from the same relation are planned once even when both books are selected", () => {
    const lib: BookRef[] = [book("d:1", "בראשית"), book("t:1", 'רש"י על בראשית')];
    expect(planMaxLink({ selected: ["d:1", "t:1"], library: lib, singleEngines: [] }).steps).toHaveLength(2);
    // with the citations engine (the default): one more step for each selected book
    expect(steps(planMaxLink({ selected: ["d:1", "t:1"], library: lib }))).toEqual(['headings:רש"י על בראשית>בראשית', 'dibur-hamatchil:רש"י על בראשית>בראשית', "citations:בראשית", 'citations:רש"י על בראשית']);
  });
});

describe("planMaxLink — a translation is linked as a translation (compatibility review B8)", () => {
  it("headings on a translation of a base book declares targum, which the generator stores as TARGUM", async () => {
    const { storedForm } = await import("../../../src/core/links/stored-form");
    // an Otzaria translation of a Sefaria base book (a Sefaria translation of a Sefaria book would be
    // Sefaria↔Sefaria, which the generator never imports from a file)
    const lib = [book("s:1", "בראשית", { origin: "sefaria", isBaseBook: true }), book("o:7", "תרגום חדש על בראשית", { isBaseBook: false, bases: ["s:1"], dependence: "targum" })];
    const p = planPairs({ selected: ["o:7"], library: lib });
    expect(steps(p)).toEqual(["headings:תרגום חדש על בראשית>בראשית"]);
    const step = p.steps[0]!;
    expect(step.kind === "pair" && step.options).toEqual({ declaredType: "targum" });
    const f = storedForm({ source: { book: lib[1]!, line: 3 }, target: { book: lib[0]!, line: 2 }, declaredType: "targum" });
    expect([f.stored, f.flipped]).toEqual(["TARGUM", true]); // shown by the app as a translation of the base
  });

  it("a translation whose title does not name its base keeps 'source' (targum would be downgraded to OTHER)", () => {
    const lib = [book("s:1", "בראשית", { origin: "sefaria", isBaseBook: true }), book("s:9", "תרגום יונתן", { bases: ["s:1"], dependence: "targum" })];
    const p = planPairs({ selected: ["s:9"], library: lib });
    const step = p.steps.find((s) => s.engine === "headings")!;
    expect(step.kind === "pair" && step.options).toBeUndefined();
  });
});

describe("planMaxLink — intermediate commentators", () => {
  const lib = [
    book("db:1", "מועד קטן", { origin: "sefaria", isBaseBook: true }),
    book("db:2", 'רש"י על מועד קטן', { bases: ["db:1"] }),
    book("db:3", "תוספות על מועד קטן", { bases: ["db:1"] }),
    book("t:1", "קרן אורה על מועד קטן"),
    book("t:2", "תוספות הרא\"ש על מועד קטן"),
  ];
  it("a commentary on a tractate is also read against רש\"י and תוספות on it — dibur-hamatchil only", () => {
    const s = steps(planPairs({ selected: ["t:1"], library: lib }));
    expect(s).toContain("dibur-hamatchil:קרן אורה על מועד קטן>רש\"י על מועד קטן");
    expect(s).toContain("dibur-hamatchil:קרן אורה על מועד קטן>תוספות על מועד קטן");
    expect(s.filter((x) => x.startsWith("headings:") && x.includes(">תוספות"))).toEqual([]);
    // only the lines that name the commentator (dibur-hamatchil addressedOnly)
    const step = planPairs({ selected: ["t:1"], library: lib }).steps.find((x) => x.kind === "pair" && x.target.key === "db:3");
    expect(step?.kind === "pair" && step.options).toEqual({ addressedOnly: true });
  });
  it("a commentator is not read against itself, and \"תוספות הרא\"ש\" is not תוספות", () => {
    const s = steps(planPairs({ selected: ["db:3", "t:2"], library: lib }));
    expect(s).not.toContain("dibur-hamatchil:תוספות על מועד קטן>תוספות על מועד קטן");
    expect(s).toContain("dibur-hamatchil:תוספות על מועד קטן>רש\"י על מועד קטן");
    expect(s).toContain("dibur-hamatchil:תוספות הרא\"ש על מועד קטן>תוספות על מועד קטן");
  });
  it("no pairs when dibur-hamatchil is unticked", () => {
    const s = steps(planPairs({ selected: ["t:1"], library: lib, engines: new Set(["headings"]) }));
    expect(s.some((x) => x.includes(">רש\"י") || x.includes(">תוספות"))).toBe(false);
  });
});

describe("planMaxLink — the links the database already has (PlanBook.linkedBases)", () => {
  const lib = [
    book("db:1", "טור", { origin: "sefaria", isBaseBook: true }),
    book("db:2", "בית יוסף", { origin: "sefaria", linkedBases: ["db:1"] }),
    book("db:3", "בראשית", { origin: "sefaria", isBaseBook: true }),
    book("db:4", 'רש"י על בראשית', { origin: "sefaria", bases: ["db:3"] }),
    book("db:5", "שפתי חכמים", { origin: "sefaria", bases: ["db:4"], linkedBases: ["db:3"] }),
    book("db:6", "בבא קמא", { origin: "sefaria", isBaseBook: true }),
    book("db:7", "בבא מציעא", { origin: "sefaria", isBaseBook: true }),
    book("db:8", "חידושי הלכות", { linkedBases: ["db:6", "db:7"] }),
    book("db:9", "ספר בלי קשר"),
  ];

  it("pairs a commentary with no declaration and no 'X על Y' by its COMMENTARY links, from either side", () => {
    for (const selected of [["db:2"], ["db:1"]]) {
      const p = planMaxLink({ selected, library: lib, singleEngines: [] });
      expect(steps(p)).toEqual(["headings:בית יוסף>טור", "dibur-hamatchil:בית יוסף>טור"]);
    }
    const p = planMaxLink({ selected: ["db:2"], library: lib, singleEngines: [] });
    expect(p.books[0]!.decisions[0]).toContain("לפי הקישורים שבמסד");
  });

  it("a commentary on a commentary is linked to the base of its base too, unscoped", () => {
    const p = planMaxLink({ selected: ["db:5"], library: lib, singleEngines: [] });
    expect(steps(p)).toEqual(expect.arrayContaining(['headings:שפתי חכמים>רש"י על בראשית', "headings:שפתי חכמים>בראשית"]));
    const rel = p.steps.find((s) => s.kind === "pair" && s.target.key === "db:3");
    expect(rel?.kind === "pair" && rel.relation.scope).toBeUndefined();
  });

  it("several unrelated linked bases: each through its own section", () => {
    const p = planMaxLink({ selected: ["db:8"], library: lib, singleEngines: [] });
    const pairs = p.steps.filter((s) => s.kind === "pair");
    expect(pairs.map((s) => s.kind === "pair" && s.relation.scope?.section).sort()).toEqual(["בבא מציעא", "בבא מציעא", "בבא קמא", "בבא קמא"]);
  });

  it("no links, no declaration, no title: still not planned", () => {
    expect(planMaxLink({ selected: ["db:9"], library: lib, singleEngines: [] }).books[0]!.skipped).toBeTruthy();
  });

  it("the title wins over the links when it resolves", () => {
    const l2 = [...lib, book("t:1", "פירוש על טור", { linkedBases: ["db:3"] })];
    expect(steps(planMaxLink({ selected: ["t:1"], library: l2, singleEngines: [] }))).toEqual(["headings:פירוש על טור>טור", "dibur-hamatchil:פירוש על טור>טור"]);
  });
});

describe("planMaxLink — a Mishnah tractate and its Bavli (MISHNAH_IN_TALMUD)", () => {
  const lib = [
    book("db:1", "משנה שבת", { origin: "sefaria", isBaseBook: true }),
    book("db:2", "שבת", { origin: "sefaria", isBaseBook: true }),
    book("db:3", "תלמוד ירושלמי שבת", { origin: "sefaria", isBaseBook: true }),
    book("db:4", "משנה פאה", { origin: "sefaria", isBaseBook: true }),
    book("db:5", "משנה ברורה", { origin: "sefaria", dependence: "commentary" }),
    book("db:6", "ברורה"),
    book("db:7", "משנה תורה, הלכות שבת", { origin: "sefaria", isBaseBook: true }),
  ];

  it("dibur-hamatchil Mishnah → Bavli, written as mishnah_in_talmud, from either side", () => {
    for (const selected of [["db:1"], ["db:2"]]) {
      const p = planMaxLink({ selected, library: lib, singleEngines: [] });
      expect(steps(p)).toEqual(["dibur-hamatchil:משנה שבת>שבת"]);
      const s = p.steps[0]!;
      expect(s.kind === "pair" && s.relation.kind).toBe("mishnah-in-talmud");
      expect(s.kind === "pair" && s.options).toEqual({ declaredType: "mishnah_in_talmud" });
      expect(s.why).toContain("משנה בתלמוד");
    }
    expect(planMaxLink({ selected: ["db:2"], library: lib, singleEngines: [] }).books[0]!.decisions.join(" ")).toContain('המשנה "משנה שבת" מובאת בו');
  });

  it("never the Yerushalmi, a tractate with no Bavli, a commentary or another work named משנה", () => {
    for (const k of ["db:3", "db:4", "db:5", "db:7"]) expect(planMaxLink({ selected: [k], library: lib, singleEngines: [] }).steps).toEqual([]);
  });

  it("two Bavli books of that name: not a guess", () => {
    const l2 = [...lib, book("t:1", "שבת", { origin: "personal" })];
    expect(planMaxLink({ selected: ["db:1"], library: l2, singleEngines: [] }).steps.length).toBe(1); // the official library wins over a personal copy
    const l3 = [...lib, book("db:9", "שבת", { origin: "sefaria" })];
    expect(planMaxLink({ selected: ["db:1"], library: l3, singleEngines: [] }).steps).toEqual([]);
  });
});

describe("planMaxLink — TARGUM and MIDRASH links as evidence (PlanBook.linkedKinds)", () => {
  const torah = ["בראשית", "שמות", "ויקרא", "במדבר", "דברים"].map((t, i) => book(`db:${i + 1}`, t, { origin: "sefaria", isBaseBook: true }));
  const lib = [
    ...torah,
    book("m:1", "תרגום ותפסיר רסג", { linkedBases: torah.map((b) => b.key), linkedKinds: Object.fromEntries(torah.map((b) => [b.key, "targum" as const])) }),
    book("db:6", "מדרש אגדה", { origin: "sefaria", isBaseBook: true, linkedBases: torah.map((b) => b.key), linkedKinds: Object.fromEntries(torah.map((b) => [b.key, "midrash" as const])) }),
    book("m:2", "תפסיר רסג למגילת אסתר", { linkedBases: ["db:7"], linkedKinds: { "db:7": "targum" } }),
    book("db:7", "אסתר", { origin: "sefaria", isBaseBook: true }),
  ];

  it("a translation on the five books: headings only, each book through its own section", () => {
    const p = planMaxLink({ selected: ["m:1"], library: lib, singleEngines: [] });
    expect(steps(p).sort()).toEqual(torah.map((b) => `headings:תרגום ותפסיר רסג>${b.title}`).sort());
    expect(p.steps.every((s) => s.kind === "pair" && s.relation.scope?.section === s.target.title && s.relation.dependence === "targum")).toBe(true);
    expect(p.books[0]!.decisions.join(" ")).toContain("כתרגום");
  });

  it("a midrash on the five books: headings and dibur-hamatchil, scoped", () => {
    const p = planMaxLink({ selected: ["db:6"], library: lib, singleEngines: [] });
    expect(p.steps).toHaveLength(10);
    expect(p.steps.every((s) => s.kind === "pair" && s.relation.scope && s.relation.dependence === "midrash")).toBe(true);
  });

  it("a translation shown only by its TARGUM links (no 'תרגום' in the title) still runs headings only", () => {
    expect(steps(planMaxLink({ selected: ["m:2"], library: lib, singleEngines: [] }))).toEqual(["headings:תפסיר רסג למגילת אסתר>אסתר"]);
  });

  it("evidenceFromCounts: COMMENTARY at any count, TARGUM / MIDRASH from LINKED_MIN; stored base → dependant", () => {
    const row = (bookKey: string, c: Partial<Record<"commentaryOut" | "commentaryIn" | "targumOut" | "targumIn" | "midrashOut" | "midrashIn", number>>) => ({
      bookKey, title: bookKey, origin: "sefaria" as const, out: 0, in: 0, commentaryOut: 0, commentaryIn: 0, targumOut: 0, targumIn: 0, midrashOut: 0, midrashIn: 0, ...c,
    });
    const ev = evidenceFromCounts("db:1", [row("a", { commentaryOut: 1 }), row("b", { targumOut: LINKED_MIN }), row("c", { midrashOut: LINKED_MIN - 1 }), row("d", { midrashIn: 400 })]);
    // counted; "complete" only for this book's own side (its summary counts every book it is linked to)
    expect(ev).toEqual([
      { dependant: "a", base: "db:1", count: 1 },
      { dependant: "b", base: "db:1", kind: "targum", count: LINKED_MIN },
      { dependant: "db:1", base: "d", kind: "midrash", count: 400, complete: true },
    ]);
    expect(linkedFields(ev).get("b")).toEqual({ linkedBases: ["db:1"], linkedKinds: { "db:1": "targum" }, linkedCounts: { "db:1": LINKED_MIN }, linkedComplete: false });
    expect(linkedFields(ev).get("db:1")!.linkedComplete).toBe(true);
    expect(linkedFields([{ dependant: "b", base: "db:1" }, { dependant: "b", base: "db:1", kind: "targum" }]).get("b")!.linkedKinds).toEqual({});
  });

  it("linkedFields: the larger count per type when both sides were read, summed over the types", () => {
    // "ספרא" ← "ויקרא": 3 COMMENTARY links and 1,833 MIDRASH ones
    const f = linkedFields([
      { dependant: "s", base: "v", count: 3, complete: true },
      { dependant: "s", base: "v", count: 3 },
      { dependant: "s", base: "v", kind: "midrash", count: 1833 },
    ]).get("s")!;
    expect(f.linkedCounts).toEqual({ v: 1836 });
    expect(f.linkedKinds).toEqual({}); // a commentary stays a commentary
    expect(linkedProps(f)).toEqual({ linkedBases: ["v"], linkedCounts: { v: 1836 }, linkedComplete: true });
    expect(linkedProps(undefined)).toEqual({});
  });
});

describe("planMaxLink — the existing links beside the declaration and the title (counted evidence)", () => {
  type Pair = Extract<ReturnType<typeof planMaxLink>["steps"][number], { kind: "pair" }>;
  const pairs = (p: ReturnType<typeof planMaxLink>) => p.steps.filter((s): s is Pair => s.kind === "pair");
  const lib = [
    book("db:1", "ברכות", { origin: "sefaria", isBaseBook: true }),
    book("db:2", 'פסקי הרא"ש על ברכות', { origin: "sefaria", dependence: "commentary" }),
    book("db:3", "מעדני יום טוב על ברכות", { origin: "sefaria", bases: ["db:1"], linkedBases: ["db:2", "db:1"], linkedCounts: { "db:2": 1503, "db:1": 81 }, linkedComplete: true }),
    book("db:4", "ויקרא", { origin: "sefaria", isBaseBook: true }),
    // a midrash on ויקרא by its MIDRASH links alone (3 COMMENTARY + 1,833 MIDRASH)
    book("db:5", "ספרא", { origin: "sefaria", isBaseBook: true, linkedBases: ["db:4"], linkedCounts: { "db:4": 1836 } }),
    book("db:6", 'מלבי"ם על ויקרא', { origin: "sefaria", bases: ["db:4"], linkedBases: ["db:4", "db:5"], linkedCounts: { "db:4": 1911, "db:5": 1905 }, linkedComplete: true }),
    book("db:7", "דברים", { origin: "sefaria", isBaseBook: true }),
    // the haftarot: one COMMENTARY link from דברים does not make ישעיהו a commentary on it
    book("db:8", "ישעיהו", { origin: "sefaria", isBaseBook: true, linkedBases: ["db:7"], linkedCounts: { "db:7": 1 } }),
    book("db:9", "פירוש על דברים", { origin: "sefaria", bases: ["db:7"], linkedBases: ["db:7", "db:8"], linkedCounts: { "db:7": 3000, "db:8": 233 }, linkedComplete: true }),
  ];

  it('a commentary the library links to another commentary on its base gets that one too ("מעדני יום טוב" on the Rosh)', () => {
    const p = planPairs({ selected: ["db:3"], library: lib });
    expect(steps(p)).toEqual(expect.arrayContaining(['headings:מעדני יום טוב על ברכות>פסקי הרא"ש על ברכות', 'dibur-hamatchil:מעדני יום טוב על ברכות>פסקי הרא"ש על ברכות', "headings:מעדני יום טוב על ברכות>ברכות"]));
    const r = pairs(p).find((s) => s.target.key === "db:2")!.relation;
    expect(r.via).toBe("links");
    expect(r.scope).toBeUndefined();
    expect(r.caveats.join(" ")).toContain("1,503");
  });

  it("below EVIDENCE_MIN, or a book not written on one of its bases, is not a base", () => {
    const few = lib.map((b) => (b.key === "db:3" ? { ...b, linkedCounts: { "db:2": EVIDENCE_MIN - 1, "db:1": 81 } } : b));
    expect(steps(planPairs({ selected: ["db:3"], library: few })).some((s) => s.includes('>פסקי הרא"ש'))).toBe(false);
    expect(steps(planPairs({ selected: ["db:9"], library: lib })).some((s) => s.includes(">ישעיהו"))).toBe(false);
    // counted only from the other side (no linkedCounts): the declaration alone, as before
    const uncounted = lib.map((b) => (b.key === "db:3" ? { ...b, linkedCounts: undefined, linkedComplete: undefined } : b));
    expect(steps(planPairs({ selected: ["db:3"], library: uncounted })).some((s) => s.includes('>פסקי הרא"ש'))).toBe(false);
  });

  it('a midrash on the same base counts by its MIDRASH links; a text of its own gets dibur-hamatchil only ("מלבי"ם על ויקרא" ← "ספרא")', () => {
    const s = steps(planPairs({ selected: ["db:6"], library: lib }));
    expect(s).toEqual(expect.arrayContaining(['dibur-hamatchil:מלבי"ם על ויקרא>ספרא', 'headings:מלבי"ם על ויקרא>ויקרא']));
    expect(s).not.toContain('headings:מלבי"ם על ויקרא>ספרא');
  });

  it("an intermediate commentator as the sibling: dibur-hamatchil only, the lines that do not name it left for review", () => {
    const talmud = [
      book("k:1", "כתובות", { origin: "sefaria", isBaseBook: true }),
      book("k:2", "תוספות על כתובות", { origin: "sefaria", bases: ["k:1"] }),
      book("k:3", 'רש"י על כתובות', { origin: "sefaria", bases: ["k:1"] }),
      book("k:4", 'מהרש"א - חידושי הלכות על מסכת כתובות', { origin: "sefaria", bases: ["k:1"], linkedBases: ["k:1", "k:2"], linkedCounts: { "k:1": 629, "k:2": 645 }, linkedComplete: true }),
    ];
    const p = planPairs({ selected: ["k:4"], library: talmud });
    const toTos = p.steps.filter((x): x is Pair => x.kind === "pair" && x.target.key === "k:2");
    expect(toTos.map((x) => x.engine)).toEqual(["dibur-hamatchil"]);
    expect(toTos[0]!.options).toEqual({ addressedOnly: "cap" });
    expect(toTos[0]!.relation.dhOnly).toBe("intermediate");
    // רש"י, with no links counted, keeps the planner's usual step to the other commentators
    const toRashi = p.steps.find((x): x is Pair => x.kind === "pair" && x.target.key === "k:3")!;
    expect(toRashi.options).toEqual({ addressedOnly: true });
  });

  it("a sibling written on this book is its commentary, not its base", () => {
    const l2 = [...lib, book("db:10", "הגהות על מעדני יום טוב", { bases: ["db:3"] })];
    const l3 = l2.map((b) => (b.key === "db:3" ? { ...b, linkedBases: ["db:2", "db:10"], linkedCounts: { "db:2": 1503, "db:10": 500 } } : b));
    expect(steps(planPairs({ selected: ["db:3"], library: l3 })).some((s) => s.includes("מעדני יום טוב על ברכות>הגהות"))).toBe(false);
  });

  const torah = [
    book("tn:1", "בראשית", { origin: "sefaria", isBaseBook: true }),
    book("tn:2", "שמות", { origin: "sefaria", isBaseBook: true }),
    book("tn:3", 'רש"י על בראשית', { origin: "sefaria", bases: ["tn:1"] }),
    book("tn:4", 'רש"י על שמות', { origin: "sefaria", bases: ["tn:2"] }),
    book("tn:5", "מזרחי", { origin: "sefaria", bases: ["tn:1", "tn:2"], linkedBases: ["tn:3", "tn:4"], linkedCounts: { "tn:3": 1601, "tn:4": 1188 }, linkedComplete: true }),
    book("tn:6", "יריעות שלמה על התורה", { origin: "sefaria", bases: ["tn:1", "tn:2"], linkedBases: ["tn:5", "tn:3"], linkedCounts: { "tn:5": 522, "tn:3": 361 }, linkedComplete: true }),
    book("tn:7", "שפתי חכמים", { origin: "sefaria", bases: ["tn:3", "tn:4"], linkedBases: ["tn:1", "tn:2"], linkedCounts: { "tn:1": 1470, "tn:2": 1145 }, linkedComplete: true }),
  ];

  it("in a book on several bases, the sibling is read in the part of the base it is written on", () => {
    const p = planPairs({ selected: ["tn:5"], library: torah });
    const r = pairs(p).filter((s) => s.target.key === "tn:3" || s.target.key === "tn:4");
    // רש"י is an intermediate commentator: dibur-hamatchil only (Relation.dhOnly)
    expect(r.map((s) => `${s.engine}>${s.target.title}@${s.relation.scope?.section}`).sort()).toEqual(['dibur-hamatchil>רש"י על בראשית@בראשית', 'dibur-hamatchil>רש"י על שמות@שמות']);
  });

  it('a sibling written on two parts of the book has no one part to read ("יריעות שלמה" ← "מזרחי")', () => {
    const s = steps(planPairs({ selected: ["tn:6"], library: torah }));
    expect(s.some((x) => x.endsWith(">מזרחי"))).toBe(false);
    expect(s).toContain('dibur-hamatchil:יריעות שלמה על התורה>רש"י על בראשית');
  });

  it('the base of its base, in the part of the commentary it explains ("שפתי חכמים" → "בראשית")', () => {
    const p = planPairs({ selected: ["tn:7"], library: torah });
    const r = pairs(p).filter((s) => s.target.key === "tn:1");
    expect(r.map((s) => s.relation.scope?.section)).toEqual(['רש"י על בראשית', 'רש"י על בראשית']);
  });

  it('a handful of links to the base of its base is not a relation ("ר"ן על פסחים" → "פסחים", 4 links)', () => {
    const rif = [
      book("r:1", "פסחים", { origin: "sefaria", isBaseBook: true }),
      book("r:2", 'רי"ף פסחים', { origin: "sefaria", bases: ["r:1"] }),
      book("r:3", 'ר"ן על פסחים', { origin: "sefaria", bases: ["r:2"], linkedBases: ["r:2", "r:1"], linkedCounts: { "r:2": 900, "r:1": 4 }, linkedComplete: true }),
    ];
    expect(steps(planPairs({ selected: ["r:3"], library: rif })).some((s) => s.endsWith(">פסחים"))).toBe(false);
    const many = rif.map((b) => (b.key === "r:3" ? { ...b, linkedCounts: { "r:2": 900, "r:1": LINKED_MIN } } : b));
    expect(steps(planPairs({ selected: ["r:3"], library: many })).some((s) => s.endsWith(">פסחים"))).toBe(true);
  });

  const zohar = [
    book("z:1", "תקוני הזהר", { origin: "otzaria" }),
    book("z:2", "תקוני הזהר מסודר על פי הגרא", { origin: "otzaria" }),
    book("z:3", "ביאור הגרא על תקוני הזהר", { origin: "otzaria", linkedBases: ["z:2"], linkedCounts: { "z:2": 9052 }, linkedComplete: true }),
  ];

  it('a title whose base the library never links the book to gives way to the one it does ("ביאור הגרא על תקוני הזהר")', () => {
    const p = planPairs({ selected: ["z:3"], library: zohar });
    expect(steps(p)).toEqual(["headings:ביאור הגרא על תקוני הזהר>תקוני הזהר מסודר על פי הגרא", "dibur-hamatchil:ביאור הגרא על תקוני הזהר>תקוני הזהר מסודר על פי הגרא"]);
    expect(p.books[0]!.decisions.join(" ")).toContain('השם מציין את "תקוני הזהר"');
  });

  it("…only when the book's own links were read, and never over a declaration", () => {
    const partial = zohar.map((b) => (b.key === "z:3" ? { ...b, linkedComplete: undefined } : b));
    expect(steps(planPairs({ selected: ["z:3"], library: partial }))[0]).toBe("headings:ביאור הגרא על תקוני הזהר>תקוני הזהר");
    const declared = zohar.map((b) => (b.key === "z:3" ? { ...b, bases: ["z:1"] } : b));
    expect(steps(planPairs({ selected: ["z:3"], library: declared })).some((s) => s.endsWith(">תקוני הזהר"))).toBe(true);
    const linkedToo = zohar.map((b) => (b.key === "z:3" ? { ...b, linkedBases: ["z:2", "z:1"], linkedCounts: { "z:2": 9052, "z:1": 3 } } : b));
    expect(steps(planPairs({ selected: ["z:3"], library: linkedToo }))[0]).toBe("headings:ביאור הגרא על תקוני הזהר>תקוני הזהר");
  });

  it('a base book is not a commentary on another by a stray link ("שמות" → "יחזקאל", 1 COMMENTARY link)', () => {
    const tanakh = [
      book("y:1", "שמות", { origin: "sefaria", isBaseBook: true }),
      book("y:2", "יחזקאל", { origin: "sefaria", isBaseBook: true, linkedBases: ["y:1"], linkedCounts: { "y:1": 1 }, linkedComplete: true }),
      book("y:3", "חידושים על שמות בלי שם", { origin: "sefaria", linkedBases: ["y:1"], linkedCounts: { "y:1": 1 }, linkedComplete: true }),
    ];
    expect(planPairs({ selected: ["y:2"], library: tanakh }).steps).toEqual([]);
    const many = tanakh.map((b) => (b.key === "y:2" ? { ...b, linkedCounts: { "y:1": LINKED_MIN } } : b));
    expect(planPairs({ selected: ["y:2"], library: many }).steps.length).toBe(2);
    // a book that is not a base text keeps its single link, as before; so does an uncounted one
    expect(planPairs({ selected: ["y:3"], library: tanakh }).steps.length).toBe(2);
    const uncounted = tanakh.map((b) => (b.key === "y:2" ? { ...b, linkedCounts: undefined } : b));
    expect(planPairs({ selected: ["y:2"], library: uncounted }).steps.length).toBe(2);
  });

  it("evidenceToFollow: the strongly linked bases whose own base only their links tell", () => {
    const books = new Map(lib.map((b) => [b.key, b] as const));
    const ev = [
      { dependant: "db:6", base: "db:5", count: 1905, complete: true },
      { dependant: "db:6", base: "db:4", count: 1911, complete: true },
      { dependant: "db:3", base: "db:2", count: 1503, complete: true }, // "… על ברכות": its title says
      { dependant: "db:9", base: "db:8", count: EVIDENCE_MIN - 1, complete: true },
      { dependant: "x", base: "db:8", count: 5000 }, // the other side's summary
    ];
    expect(evidenceToFollow(ev, books)).toEqual(["db:5"]); // not "ויקרא": the dependant's declared base
  });
});

describe("planMaxLink — a commentary on a commentary, declared on both (book_base_text chain)", () => {
  const lib = [
    book("db:1", "שולחן ערוך, אורח חיים", { origin: "sefaria", isBaseBook: true }),
    book("db:2", "מגן אברהם", { origin: "sefaria", bases: ["db:1"], dependence: "commentary" }),
    book("db:3", "טורי זהב על שולחן ערוך אורח חיים", { origin: "sefaria", bases: ["db:1"], dependence: "commentary" }),
    book("db:4", "מחצית השקל על אורח חיים", { origin: "sefaria", bases: ["db:1", "db:2"], dependence: "commentary" }),
    book("db:5", "פרי מגדים על אורח חיים", { origin: "sefaria", bases: ["db:1", "db:2", "db:3"], dependence: "commentary" }),
    book("db:6", "בראשית", { origin: "sefaria", isBaseBook: true }),
    book("db:7", "שמות", { origin: "sefaria", isBaseBook: true }),
    book("db:8", "חזקוני", { origin: "sefaria", bases: ["db:6", "db:7"], dependence: "commentary" }),
  ];
  const pairs = (p: ReturnType<typeof planMaxLink>) => p.steps.filter((s) => s.kind === "pair") as Extract<ReturnType<typeof planMaxLink>["steps"][number], { kind: "pair" }>[];

  it("one intermediate: linked to it unscoped, and to the root through it", () => {
    const p = planMaxLink({ selected: ["db:4"], library: lib, singleEngines: [] });
    const toMid = pairs(p).filter((s) => s.target.key === "db:2");
    const toRoot = pairs(p).filter((s) => s.target.key === "db:1");
    expect(toMid.map((s) => s.engine)).toEqual(["headings", "dibur-hamatchil"]);
    expect(toMid.every((s) => !s.relation.scope && !s.relation.through)).toBe(true);
    expect(toRoot.map((s) => s.engine)).toEqual(["headings", "dibur-hamatchil"]);
    expect(toRoot.every((s) => s.relation.through?.map((t) => t.book.key).join() === "db:2" && !s.relation.scope)).toBe(true);
    expect(toRoot[0]!.why).toContain("לפי הקישורים שכבר יש במסד");
  });

  it("two intermediates: each through its own section, the root through both", () => {
    const p = planMaxLink({ selected: ["db:5"], library: lib, singleEngines: [] });
    expect(pairs(p).filter((s) => s.target.key === "db:2" || s.target.key === "db:3").every((s) => s.relation.scope?.section === s.target.title)).toBe(true);
    const root = pairs(p).find((s) => s.target.key === "db:1")!;
    expect(root.relation.through!.map((t) => [t.book.key, t.scope?.section])).toEqual([["db:2", "מגן אברהם"], ["db:3", "טורי זהב על שולחן ערוך אורח חיים"]]);
  });

  it("bases that are not one chain stay one section per base", () => {
    const p = planMaxLink({ selected: ["db:8"], library: lib, singleEngines: [] });
    expect(pairs(p).every((s) => s.relation.scope && !s.relation.through)).toBe(true);
  });
});
