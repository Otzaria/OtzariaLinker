import { describe, expect, it } from "vitest";
import { discoverPairs, type DiscoveryBook } from "../../../src/linking/discovery";

/*
 * Fix round, claims 8 and 9: discovery never decides a base book by its name alone. A proposal says HOW it was decided (`selection`):
 *   confirmed  the name AND another kind of evidence agree on this very book (links to this book by KEY, or a unique title with links,
 *              or the same category), and nothing points the other way
 *   review     the name alone, a unique title: a candidate for the user to look at
 *   ambiguous  the title is shared by another open book and no link tells which, or the links do not fit the chosen book (they reach
 *              lines it does not have): flagged, never to be linked automatically
 * The shape of the v52 case "ספר הנר על ברכות" is reproduced with invented numbers and no book text.
 */
const b = (key: string, title: string, origin: "personal" | "otzaria", more: Partial<DiscoveryBook> = {}): DiscoveryBook => ({ key, title, origin, ...more });
const only = (key: string) => ({ dependants: (x: DiscoveryBook) => x.key === key });
const one = (books: DiscoveryBook[], key: string) => discoverPairs(books, only(key)).proposals[0]!;

describe("discoverPairs — how the base was decided (selection)", () => {
  it("a unique title and nothing else is 'review': the name alone", () => {
    const p = one([b("p:1", "פירוש על בראשית", "personal", { lineCount: 100 }), b("o:1", "בראשית", "otzaria", { lineCount: 1500 })], "p:1");
    expect(p.selection).toBe("review");
    expect(p.markers).toEqual([]);
    expect(p.evidence).toMatchObject({ name: true, category: false, links: "none", structure: "unknown", sameTitleBooks: 0 });
  });

  it("a unique title and the same category: confirmed (two kinds of evidence)", () => {
    const p = one([b("p:1", "פירוש על בראשית", "personal", { lineCount: 100, category: "תנך" }), b("o:1", "בראשית", "otzaria", { lineCount: 1500, category: "תנך" })], "p:1");
    expect(p.selection).toBe("confirmed");
  });

  it("a unique title and existing links to it: confirmed", () => {
    const p = one([b("p:1", "פירוש על בראשית", "personal", { lineCount: 100, linkedLines: 90, linkedTo: { בראשית: 90 }, linkedKeys: { "o:1": 90 } }), b("o:1", "בראשית", "otzaria", { lineCount: 1500 })], "p:1");
    expect(p.selection).toBe("confirmed");
    expect(p.evidence.links).toBe("key");
  });

  describe("the v52 shape: 'ברכות' is a personal book and an official one", () => {
    const personal = b("p:8", "ברכות", "personal", { lineCount: 2779 });
    const official = b("o:1", "ברכות", "otzaria", { lineCount: 2875, category: "תלמוד בבלי" });
    const dep = (more: Partial<DiscoveryBook> = {}) => b("p:20", "ספר הנר על ברכות", "personal", { lineCount: 600, category: "תלמוד בבלי", ...more });

    it("links counted by title alone prove nothing about which one: ambiguous, even with the same category", () => {
      const p = one([dep({ linkedLines: 500, linkedTo: { ברכות: 556 } }), personal, official], "p:20");
      expect(p.selection).toBe("ambiguous");
      expect(p.markers).toContain("ambiguous-title");
      expect(p.evidence.links).toBe("title-shared");
      expect(p.sameTitleKeys).toHaveLength(1);
    });

    it("no links at all: ambiguous (the name fits both)", () => {
      expect(one([dep(), personal, official], "p:20").selection).toBe("ambiguous");
    });

    it("links to the official one by KEY that fit its length: confirmed, and the marker still says the title is shared", () => {
      const p = one([dep({ linkedLines: 500, linkedTo: { ברכות: 556 }, linkedKeys: { "o:1": 556 }, linkedMaxLine: { "o:1": 2810 } }), personal, official], "p:20");
      expect(p.base.key).toBe("o:1");
      expect(p.selection).toBe("confirmed");
      expect(p.markers).toContain("ambiguous-title");
      expect(p.evidence.structure).toBe("fits");
    });

    it("links by key to the personal book that reach lines it does not have: ambiguous, flagged links-exceed-base", () => {
      const p = one([dep({ linkedLines: 500, linkedKeys: { "p:8": 556 }, linkedMaxLine: { "p:8": 2810 } }), personal, official], "p:20");
      expect(p.base.key).toBe("p:8");
      expect(p.selection).toBe("ambiguous");
      expect(p.markers).toContain("links-exceed-base");
      expect(p.evidence.structure).toBe("exceeds");
      expect(p.reasons.join(" ")).toContain("מעבר לסוף");
    });

    it("a base that is not shared but whose links reach past its end is ambiguous too: the name is not the whole story", () => {
      const p = one([b("p:1", "פירוש על בראשית", "personal", { lineCount: 100, linkedKeys: { "o:1": 5 }, linkedMaxLine: { "o:1": 5000 } }), b("o:1", "בראשית", "otzaria", { lineCount: 1500 })], "p:1");
      expect(p.selection).toBe("ambiguous");
    });
  });

  it("the summary counts proposals by selection", () => {
    const out = discoverPairs([b("p:1", "פירוש על בראשית", "personal", { lineCount: 100 }), b("o:1", "בראשית", "otzaria", { lineCount: 1500 })], only("p:1"));
    expect(out.summary.bySelection).toEqual({ confirmed: 0, review: 1, ambiguous: 0 });
  });
});
