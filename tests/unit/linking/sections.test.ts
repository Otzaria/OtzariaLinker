import { describe, expect, it } from "vitest";
import { headingLevel } from "../../../src/core/text/html";
import { partsOf, sectionFor, sectionNames } from "../../../src/linking/sections";
import { partByLinks } from "../../../src/workers/maxlink-job";
import type { EngineBook } from "../../../src/linking/automatic/types";

const book = (texts: readonly string[]): EngineBook => ({
  book: { key: "c", title: "חזקוני", origin: "otzaria" },
  lines: texts.map((text, index) => ({ index, text, heading: headingLevel(text) })),
});
const TORAH = book([
  "<h1>חזקוני</h1>", "<h2>הקדמה</h2>", "פתיחה",
  "<h2>בראשית</h2>", "<h3>פרק א</h3>", "בראשית ברא", "<h3>פרק ב</h3>", "ויכלו",
  "<h2>ספר שמות</h2>", "<h3>פרק א</h3>", "ואלה שמות",
]);

describe("sectionFor", () => {
  it("the lines under the heading that names the base, up to the next heading of its level; original line numbers kept", () => {
    const s = sectionFor(TORAH, "בראשית")!;
    expect(s.heading).toBe("בראשית");
    expect(s.book.lines.map((l) => l.index)).toEqual([4, 5, 6, 7]);
    expect(sectionFor(TORAH, "שמות")!.book.lines.map((l) => l.index)).toEqual([9, 10]); // "ספר " is ignored
  });

  it("a supercommentary's base 'X על Y' is found by Y", () => {
    expect(sectionNames('רש"י על בראשית')).toEqual(new Set(["רשי על בראשית", "בראשית"]));
    expect(sectionFor(TORAH, 'רש"י על בראשית')!.book.lines.length).toBe(4);
  });

  it("no heading names the base: null; the title heading never counts", () => {
    expect(sectionFor(TORAH, "ויקרא")).toBeNull();
    expect(sectionFor(TORAH, "חזקוני")).toBeNull();
  });

  it("the highest level wins: a part beats a parsha of the same name inside it", () => {
    const b = book(["<h1>ספר</h1>", "<h2>בראשית</h2>", "<h3>בראשית</h3>", "א", "<h3>נח</h3>", "ב", "<h2>שמות</h2>", "ג"]);
    expect(sectionFor(b, "בראשית")!.book.lines.map((l) => l.index)).toEqual([2, 3, 4, 5]);
  });

  it("a base that comes back later contributes every part", () => {
    const b = book(["<h1>ספר</h1>", "<h2>בראשית</h2>", "א", "<h2>שמות</h2>", "ב", "<h2>בראשית</h2>", "ג"]);
    expect(sectionFor(b, "בראשית")!.book.lines.map((l) => l.index)).toEqual([2, 6]);
  });
});

describe("partsOf / partByLinks: a part the library links to a base it is not named after (פרי מגדים)", () => {
  // "אשל אברהם" is on the מגן אברהם, "משבצות זהב" on the ט"ז
  const lines = ["<h1>פרי מגדים</h1>", "<h2>הקדמה</h2>", "פתיחה", "<h2>משבצות זהב</h2>"];
  for (let i = 0; i < 120; i++) lines.push(`ט"ז ${i}`);
  lines.push("<h2>אשל אברהם</h2>");
  for (let i = 0; i < 120; i++) lines.push(`מג"א ${i}`);
  const PM = book(lines);
  const at = (i: number) => ({ book: { key: "c", title: "פרי מגדים", origin: "otzaria" as const }, line: i });
  const linksTo = (key: string, from: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ source: { book: { key, title: key, origin: "otzaria" as const }, line: i }, target: at(from + i) }));
  const registry = (links: unknown[]) => ({ existingLinks: async () => links }) as unknown as Parameters<typeof partByLinks>[0];

  it("partsOf: the headings at the shallowest level below the title", () => {
    expect(partsOf(PM).map((p) => p.heading)).toEqual(["הקדמה", "משבצות זהב", "אשל אברהם"]);
  });

  it("the part that holds the links to the base is its section; links spread over parts give none", async () => {
    const reg = registry([...linksTo("taz", 4, 110), ...linksTo("ma", 125, 115)]);
    const cache = new Map();
    expect((await partByLinks(reg, PM, "taz", cache))!.heading).toBe("משבצות זהב");
    expect((await partByLinks(reg, PM, "ma", cache))!.heading).toBe("אשל אברהם");
    expect(await partByLinks(registry([...linksTo("taz", 4, 60), ...linksTo("taz", 125, 60)]), PM, "taz", new Map())).toBeNull();
    expect(await partByLinks(registry(linksTo("taz", 4, 50)), PM, "taz", new Map())).toBeNull(); // under PART_MIN
  });
});
