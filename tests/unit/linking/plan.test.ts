import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../src/core/links/model";
import { notesBaseKey, planMaxLink, singleBookEngines, type PlanBook, type SingleEngineId } from "../../../src/linking/plan";

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

  it("does not link a book the database declares on several bases", () => {
    const lib = [book("d:1", "בראשית"), book("d:2", "שמות"), book("d:3", "מדרש לקח טוב", { bases: ["d:1", "d:2"], dependence: "midrash" })];
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
