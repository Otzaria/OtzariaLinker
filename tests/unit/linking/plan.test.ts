import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../src/core/links/model";
import { evidenceFromCounts, LINKED_MIN, linkedFields, notesBaseKey, planMaxLink, singleBookEngines, type PlanBook, type SingleEngineId } from "../../../src/linking/plan";

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
    expect(ev).toEqual([{ dependant: "a", base: "db:1" }, { dependant: "b", base: "db:1", kind: "targum" }, { dependant: "db:1", base: "d", kind: "midrash" }]);
    expect(linkedFields(ev).get("b")).toEqual({ linkedBases: ["db:1"], linkedKinds: { "db:1": "targum" } });
    expect(linkedFields([{ dependant: "b", base: "db:1" }, { dependant: "b", base: "db:1", kind: "targum" }]).get("b")!.linkedKinds).toEqual({});
  });
});
