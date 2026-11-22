import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { hasCitationHint } from "../../../src/linking/automatic/citations/suitability";
import { SourceRegistry } from "../../../src/sources/registry";
import { citationsJob } from "../../../src/workers/citations-job";

/*
 * 2.1: the citations engine does not run on a book without a reason. The cheap check: does ANY line carry a sign of a
 * reference (a place word: דף, פרק, סימן, סעיף, פסוק, ע"א…, or a name of a source: רש"י, רמב"ם, גמרא…)? Measured on 70 books of the
 * official library (lengths 50-3,000 lines, seeded): 70 of 70 have such a line and 70 of 70 get suggestions, so nothing there is
 * skipped; the check exists for the books that really have none (a personal book of plain prose, a list).
 */
describe("hasCitationHint", () => {
  it.each(["כמו שאמרו בפרק ג ושם", 'עיין ברש"י על הפסוק', "ראה סימן קכח סעיף ב", 'בגמרא דף ג ע"ב', "ועוד שם בהלכה ה"])("%s: yes", (t) => expect(hasCitationHint(t)).toBe(true));
  it.each(["שלום עולם וברכה", "הלך האיש אל השוק וקנה לחם", "", "12 345 6789"])("%s: no", (t) => expect(hasCitationHint(t)).toBe(false));
  it("looks at the text a reader sees, not at tags or attributes", () => {
    expect(hasCitationHint('<span title="פרק ג">שלום</span>')).toBe(false);
    expect(hasCitationHint("<b>פרק</b> ג")).toBe(true);
  });
});

describe("citationsJob — suitability", () => {
  const text = (path: string, lines: string[]) => ({ path, blob: new Blob([strToU8(lines.join(String.fromCharCode(10)))]) });
  async function run(lines: string[]) {
    const reg = new SourceRegistry();
    const res = await reg.open([text("ספר.txt", lines), text("בראשית.txt", ["<h1>בראשית</h1>", "<h2>פרק א</h2>", "בראשית ברא"])]);
    const b = res.sources.flatMap((s) => s.books).find((x) => x.title === "ספר")!;
    return citationsJob(reg, { key: b.key, title: b.title, origin: b.origin }, {}, {});
  }
  it("a book with no sign of a reference: nothing runs, and the note says why", async () => {
    const r = await run(["<h1>ספר</h1>", "הלך האיש אל השוק", "וקנה לחם ויין", "ושב אל ביתו"]);
    expect(r.suggestions).toHaveLength(0);
    expect(r.notes.map((n) => n.code)).toEqual(["citations/skipped-no-references"]);
    expect(r.notes[0]!.text).toContain("אין");
  });
  it("a book with references runs as before", async () => {
    const r = await run(["<h1>ספר</h1>", "כמו שנאמר בבראשית פרק א ועוד"]);
    expect(r.notes.map((n) => n.code)).not.toContain("citations/skipped-no-references");
    expect(r.suggestions.length).toBeGreaterThan(0);
  });
});


describe("hasCitationHint with the names of the open books", () => {
  const names = new Set(["בראשית", "ברכות"]);
  it("a name and numbers, with no place word, passes — also with a prefix", () => {
    expect(hasCitationHint("כמו שנאמר (בראשית א, א) ועוד", (k) => names.has(k))).toBe(true);
    expect(hasCitationHint("כמו שנאמר בבראשית א", (k) => names.has(k))).toBe(true);
    expect(hasCitationHint("כמו שנאמר (בראשית א, א) ועוד")).toBe(false);
    expect(hasCitationHint("הלך האיש אל השוק", (k) => names.has(k))).toBe(false);
  });
});
