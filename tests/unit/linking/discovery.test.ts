import { describe, expect, it } from "vitest";
import { discoverPairs, type DiscoveryBook } from "../../../src/linking/discovery";

/* Discovery of base/commentary pairs (2.8/2.9): proposals with a confidence and the reason, never a link on a name alone. */
const b = (key: string, title: string, origin: "personal" | "otzaria", more: Partial<DiscoveryBook> = {}): DiscoveryBook => ({ key, title, origin, ...more });
const lib = [
  b("p:1", 'חידושים על ברכות', "personal", { lineCount: 1000 }),
  b("p:2", "פירוש על ספר אישי", "personal", { lineCount: 500 }),
  b("p:3", "ספר אישי", "personal", { lineCount: 2000 }),
  b("p:4", "הערות על בראשית", "personal", { lineCount: 300 }),
  b("p:5", "ביאור על ספר שאין", "personal", { lineCount: 400 }),
  b("p:6", "חיבור בלי שם של פירוש", "personal", { lineCount: 50 }),
  b("p:7", "שיעורים על ברכות", "personal", { lineCount: 800, linkedTo: { ברכות: 700 }, linkedLines: 700, category: "תלמוד בבלי" }),
  b("o:1", "ברכות", "otzaria", { lineCount: 6000, category: "תלמוד בבלי" }),
  b("o:2", "בראשית", "otzaria", { lineCount: 1500 }),
  b("p:8", "ברכות", "personal", { lineCount: 20 }), // a personal book that shares a title with the Talmud (the audit's collision)
];

describe("discoverPairs", () => {
  const out = discoverPairs(lib);
  const of = (title: string) => out.proposals.find((p) => p.dependant.title === title)!;

  it("'X על Y' with Y a book of the same source: a proposal to it, medium", () => {
    const p = of("פירוש על ספר אישי");
    expect(p.base!.key).toBe("p:3");
    expect(p.confidence).toBe("medium");
    expect(p.baseIsOfficial).toBe(false);
    expect(p.reasons.join(" ")).toContain('"פירוש על ספר אישי"');
  });

  it("Y a book of the official library: a proposal to it", () => {
    expect(of("הערות על בראשית").base!.key).toBe("o:2");
    expect(of("הערות על בראשית").kind).toBe("notes");
    expect(of("הערות על בראשית").baseIsOfficial).toBe(true);
  });

  it("a title two books share is not guessed: the official one wins only as the planner's rule says, and the confidence is low, with the note", () => {
    const p = of("חידושים על ברכות");
    expect(p.confidence).toBe("low");
    expect(p.reasons.join(" ")).toMatch(/ברכות/);
  });

  it("existing links to that base, or the same folder, raise it to high; what the links already cover is stated", () => {
    const p = of("שיעורים על ברכות");
    expect(p.confidence).toBe("high");
    expect(p.status).toBe("linked");
    expect(p.existingLines).toBe(700);
    expect(p.reasons.join(" ")).toContain("קישורים");
  });

  it("two books share the base's title: the links the book already has say WHICH (by book, not by title)", () => {
    const books = [
      b("p:20", "ספר הנר על ברכות", "personal", { lineCount: 600, linkedLines: 500, linkedTo: { ברכות: 500 }, linkedKeys: { "o:1": 500 } }),
      b("o:1", "ברכות", "otzaria", { lineCount: 6000 }),
      b("p:8", "ברכות", "personal", { lineCount: 20 }),
    ];
    const p = discoverPairs(books, { dependants: (x) => x.key === "p:20" }).proposals[0]!;
    expect(p.base.key).toBe("o:1");
    expect(p.confidence).toBe("high");
    expect(p.reasons.join(" ")).toContain("הקישורים הקיימים");
    // without the keys the title alone cannot tell: the planner's rule (the dependant's own source first) picks the personal one, low
    const blind = discoverPairs(books.map((x) => ({ ...x, linkedKeys: undefined as never })), { dependants: (x) => x.key === "p:20" }).proposals[0]!;
    expect(blind.base.key).toBe("p:8");
  });

  it("a base that is not open and a title that names none are listed as unresolved, with the reason, not as proposals", () => {
    expect(out.proposals.some((p) => p.dependant.title === "ביאור על ספר שאין")).toBe(false);
    expect(out.unresolved.map((u) => u.book.title)).toContain("ביאור על ספר שאין");
    expect(out.unresolved.find((u) => u.book.title === "ביאור על ספר שאין")!.reason).toContain("ספר שאין");
    expect(out.proposals.some((p) => p.dependant.title === "חיבור בלי שם של פירוש")).toBe(false);
  });

  it("no proposal is ever final: every one says it needs review (the engines then place lines; the user approves)", () => {
    expect(out.proposals.every((p) => p.requiresReview === true)).toBe(true);
  });

  it("the summary counts what was found, by confidence and by where the base is", () => {
    expect(out.summary.titled).toBe(5);
    expect(out.summary.proposals).toBe(out.proposals.length);
    expect(out.summary.officialBase + out.summary.personalBase).toBe(out.proposals.length);
    expect(out.summary.unresolved).toBe(out.unresolved.length);
  });

  it("is deterministic and keeps the library's order", () => {
    expect(discoverPairs(lib)).toEqual(out);
    expect(out.proposals.map((p) => p.dependant.key)).toEqual(lib.map((x) => x.key).filter((k) => out.proposals.some((p) => p.dependant.key === k)));
  });

  it("only the books the caller asks about are proposed as dependants (the personal database's, say), against everything open as bases", () => {
    const only = discoverPairs(lib, { dependants: (x) => x.key === "p:2" });
    expect(only.proposals.map((p) => p.dependant.key)).toEqual(["p:2"]);
  });
});

describe("discoverPairs — QA round 2 (G)", () => {
  const dep = (more: Partial<DiscoveryBook> = {}) => b("p:20", "ספר הנר על ברכות", "personal", { lineCount: 600, ...more });
  const both = [b("o:1", "ברכות", "otzaria", { lineCount: 6000 }), b("p:8", "ברכות", "personal", { lineCount: 20 })];

  it("a book with linked lines but no known length is 'unknown', not 'linked' (one line of 100,000 is not 'linked')", () => {
    const p = discoverPairs([dep({ lineCount: undefined as never, linkedLines: 1, linkedKeys: { "o:1": 1 } }), ...both], { dependants: (x) => x.key === "p:20" }).proposals[0]!;
    expect(p.status).toBe("unknown");
  });
  it("with the length known the shares are as before", () => {
    const st = (linked: number) => discoverPairs([dep({ linkedLines: linked, linkedKeys: { "o:1": linked } }), ...both], { dependants: (x) => x.key === "p:20" }).proposals[0]!.status;
    expect([st(0), st(10), st(500)]).toEqual(["unlinked", "partly-linked", "linked"]);
  });
  it("a title that exists in BOTH databases is marked 'ambiguous-title', with the other books' keys, and the reasons say so", () => {
    const p = discoverPairs([dep({ linkedLines: 500, linkedTo: { ברכות: 500 } }), ...both], { dependants: (x) => x.key === "p:20" }).proposals[0]!;
    expect(p.markers).toContain("ambiguous-title");
    expect(p.sameTitleKeys).toEqual([p.base.key === "o:1" ? "p:8" : "o:1"]);
    expect(p.reasons.join(" ")).toContain("כמה ספרים בשם");
  });
  it("links counted by TITLE alone say so in the reasons when two books share the title (they are not proof of which one)", () => {
    const p = discoverPairs([dep({ linkedLines: 500, linkedTo: { ברכות: 500 } }), ...both], { dependants: (x) => x.key === "p:20" }).proposals[0]!;
    expect(p.reasons.join(" ")).toContain("לפי שם הספר בלבד");
  });
  it("links counted by book KEY do confirm it, and the marker still shows that the title is shared", () => {
    const p = discoverPairs([dep({ linkedLines: 500, linkedTo: { ברכות: 500 }, linkedKeys: { "o:1": 500 } }), ...both], { dependants: (x) => x.key === "p:20" }).proposals[0]!;
    expect(p.base.key).toBe("o:1");
    expect(p.confidence).toBe("high");
    expect(p.markers).toContain("ambiguous-title");
  });
  it("a title only one book has carries no marker", () => {
    const p = discoverPairs([dep(), b("o:1", "ברכות", "otzaria", { lineCount: 6000 })], { dependants: (x) => x.key === "p:20" }).proposals[0]!;
    expect(p.markers).toEqual([]);
    expect(p.sameTitleKeys).toBeUndefined();
  });
});

