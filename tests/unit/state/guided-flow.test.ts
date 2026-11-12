import { describe, expect, it } from "vitest";
import { baseTitleKey } from "../../../src/core/links/titles";
import { planMaxLink, type PlanBook } from "../../../src/linking/plan";
import type { QaReport } from "../../../src/linking/qa";
import type { Link } from "../../../src/core/links/model";
import {
  dbStepNeeded,
  durationText,
  estimateRunMs,
  groupBooks,
  missingBases,
  nextStep,
  parseGuidedRecord,
  prevStep,
  resolveStep,
  stepReady,
  summarizeQa,
  type FlowFacts,
} from "../../../src/state/guided-flow";

/* The guided flow's pure parts: which step comes next, what the books are, what the check means. */

const facts = (f: Partial<FlowFacts> = {}): FlowFacts => ({ books: 0, missingBases: 0, baseChoices: 0, links: 0, ...f });

describe("guided flow — steps", () => {
  it("nothing chosen: only the first step; 'next' leads nowhere", () => {
    const f = facts();
    expect(stepReady("files", f)).toBe(true);
    expect(stepReady("books", f)).toBe(false);
    expect(nextStep("files", f)).toBeNull();
    expect(prevStep("files", f)).toBeNull();
  });

  it("the database step is skipped when every base is there and none is open twice — both ways", () => {
    const f = facts({ books: 4 });
    expect(dbStepNeeded(f)).toBe(false);
    expect(nextStep("files", f)).toBe("books");
    expect(nextStep("books", f)).toBe("plan");
    expect(prevStep("plan", f)).toBe("books");
  });

  it("a missing base, or a base open in two sources, asks for the database step", () => {
    for (const f of [facts({ books: 300, missingBases: 1 }), facts({ books: 5, baseChoices: 1 })]) {
      expect(nextStep("books", f)).toBe("db");
      expect(nextStep("db", f)).toBe("plan");
      expect(prevStep("plan", f)).toBe("db");
    }
  });

  it("the last step needs links: no approved link, no 'next' after the run", () => {
    expect(nextStep("run", facts({ books: 2 }))).toBeNull();
    expect(nextStep("run", facts({ books: 2, links: 10 }))).toBe("finish");
  });

  it("an address or a reload asks for a step that cannot be shown: the furthest one that can", () => {
    expect(resolveStep("finish", facts())).toBe("files"); // after a reload nothing is open
    expect(resolveStep("finish", facts({ books: 3 }))).toBe("run");
    expect(resolveStep("finish", facts({ books: 3, links: 1 }))).toBe("finish");
    expect(resolveStep("db", facts({ books: 3 }))).toBe("books"); // skipped: the step before it
    expect(resolveStep("db", facts({ books: 3, missingBases: 2 }))).toBe("db");
  });
});

describe("guided flow — the books, grouped", () => {
  const book = (key: string, title: string): PlanBook => ({ key, title, origin: "otzaria" });
  const folder = [
    ...Array.from({ length: 3 }, (_, i) => book(`s1:${i}`, `פירוש ${i + 1} על בראשית`)),
    book("s1:10", "ספר דוגמה"),
    book("s1:11", "הערות על ספר דוגמה"),
    book("s1:12", "חידושים"),
    book("s1:13", "ביאור על משלי"),
  ];
  const plan = (library: PlanBook[]) => planMaxLink({ selected: folder.map((b) => b.key), library, engines: new Set(["headings", "dibur-hamatchil", "footnotes"]) });
  const keys = (books: PlanBook[]) => new Set(books.map((b) => baseTitleKey(b.title)));

  it("without the bases: what is missing, and for which books", () => {
    const p = plan(folder);
    expect(missingBases(p, keys(folder))).toEqual([
      { title: "בראשית", books: ["פירוש 1 על בראשית", "פירוש 2 על בראשית", "פירוש 3 על בראשית"] },
      { title: "משלי", books: ["ביאור על משלי"] },
    ]);
    const groups = groupBooks(p, missingBases(p, keys(folder)));
    expect(groups.map((g) => g.text)).toEqual([
      '"הערות על ספר דוגמה" — ספר הערות, והספר שעליו נכתב: "ספר דוגמה"',
      '"ספר דוגמה" — ספר בסיס: ספרים אחרים כאן כתובים עליו',
      '3 ספרים כתובים על "בראשית", שאינו בין הספרים שבחרתם — צריך אותו ממסד אוצריא',
      '"ביאור על משלי" כתוב על "משלי", שאינו בין הספרים שבחרתם — צריך אותו ממסד אוצריא',
      "ספר אחד בלי קשר — למה:",
    ]);
    expect(groups.at(-1)!.books[0]!.why).toBeTruthy(); // the planner's own reason
  });

  it("with the bases open: one line for the 300 commentaries, nothing missing", () => {
    const library = [...folder, book("s2:1", "בראשית"), book("s2:2", "משלי")];
    const p = plan(library);
    expect(missingBases(p, keys(library))).toEqual([]);
    const texts = groupBooks(p).map((g) => g.text);
    expect(texts[0]).toBe('3 פירושים על "בראשית"');
    expect(texts).toContain('"ביאור על משלי" — פירוש על "משלי"');
  });
});

describe("guided flow — time, record, check", () => {
  it("estimates a run from the audit's measurements, in words", () => {
    expect(durationText(estimateRunMs(1200, 300))).toBe("כ־20 שניות");
    expect(durationText(estimateRunMs(1800, 8154))).toBe("כ־6 דקות");
    expect(durationText(estimateRunMs(3, 4))).toBe("פחות מ־5 שניות");
  });

  it("the saved record: read back, broken or foreign text ignored", () => {
    const r = { v: 1, step: "run", sources: [{ label: "מאות", kind: "text-files", books: 300, files: ["a.txt"] }], purpose: "private", links: 3000, done: false, savedAt: 5 };
    expect(parseGuidedRecord(JSON.stringify(r))).toEqual(r);
    expect(parseGuidedRecord("{")).toBeNull();
    expect(parseGuidedRecord(JSON.stringify({ ...r, step: "nowhere" }))).toBeNull();
    expect(parseGuidedRecord(JSON.stringify({ ...r, purpose: "x" }))!.purpose).toBe("submission");
    expect(parseGuidedRecord(null)).toBeNull();
  });

  it("the check in short: one line per kind and severity, with its one action", () => {
    const link = (id: string) => ({ id, source: { book: { key: "a", title: "א", origin: "otzaria" }, line: 1 }, target: { book: { key: "b", title: "ב", origin: "otzaria" }, line: 1 } }) as unknown as Link;
    const report: QaReport = {
      checked: 5,
      clean: 1,
      bySeverity: { error: 2, warning: 2, info: 1 },
      byCategory: {},
      issues: [
        { link: link("1"), category: "sefaria", problem: { code: "sefaria/not-library-edition", severity: "error", message: "" } },
        { link: link("2"), category: "sefaria", problem: { code: "sefaria/not-library-edition", severity: "error", message: "" } },
        { link: link("3"), category: "duplicate", problem: { code: "export/duplicate", severity: "warning", message: "" } },
        { link: link("4"), category: "anchor", problem: { code: "export/anchor-on-notes-line", severity: "warning", message: "" } },
        { link: link("5"), category: "unverified", problem: { code: "export/line-not-verified", severity: "info", message: "" } },
      ],
    };
    const g = summarizeQa(report, "submission");
    expect(g.map((x) => [x.severity, x.category, x.count, x.action, x.ids])).toEqual([
      ["error", "sefaria", 2, "private", []],
      ["warning", "duplicate", 1, "delete-duplicates", ["3"]],
      ["warning", "anchor", 1, "drop-anchor", ["4"]],
    ]);
    // for private use the library's rules no longer offer "private"
    expect(summarizeQa(report, "private")[0]!.action).toBe("workspace");
    for (const x of g) expect(x.text).not.toMatch(/ref_|heRef|line_index|Conection|path_2/);
  });
});
