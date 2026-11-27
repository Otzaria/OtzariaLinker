import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { citationsJob } from "../../../src/workers/citations-job";

/*
 * Fix round, claim 11 (issue #23): the suitability gate of the citations engine barely filtered books: any word that begins the title of an open book
 * opened it (the names of the open books were part of the test), and so did one bare "שם" or "משנה". It now asks for ONE line with an address: a place
 * word and a number, or the name of an open book and two numbers ("(בראשית א, ב)"). Lines that only mention a place or a source open nothing: a
 * reference with no number has no address to link to. A user who knows better runs the engine anyway (noGate).
 * Measured (docs/AUTOMATION_ENGINE.md §10.7, tests/validation/citations-gate.test.ts, two samples of 150 books): it skips 3 of 20 books in which the engine
 * finds nothing certain, and loses none of the 280 in which it does. It still passes almost every book: nearly all books of the library have an address.
 * Synthetic lines, neutral words; no book text.
 */
const text = (path: string, lines: string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });
async function run(lines: string[], options: Record<string, unknown> = {}) {
  const reg = new SourceRegistry();
  const res = await reg.open([text("ספר.txt", lines), text("בראשית.txt", ["<h1>בראשית</h1>", "<h2>פרק א</h2>", "בראשית ברא"])]);
  const b = res.sources.flatMap((s) => s.books).find((x) => x.title === "ספר")!;
  return citationsJob(reg, { key: b.key, title: b.title, origin: b.origin }, options, {});
}
const skipped = (r: Awaited<ReturnType<typeof run>>) => r.notes.map((n) => n.code).includes("citations/skipped-no-references");
/** prose that only MENTIONS the name of an open book ("בראשית"): the old gate counted that as a sign of a reference */
const MENTIONS = Array.from({ length: 40 }, (_, i) => `הלך האיש אל השוק וסיפר על בראשית ${i % 2 ? "אל חברו" : "בדרך"}`);

describe("citationsJob — the gate asks for a place, not for the name of a book", () => {
  it("forty lines that mention an open book's name in prose, with no place and no number: skipped, and the note says how to run it anyway", async () => {
    const r = await run(["<h1>ספר</h1>", ...MENTIONS]);
    expect(skipped(r)).toBe(true);
    expect(r.notes.find((n) => n.code === "citations/skipped-no-references")!.text).toContain("בכל זאת");
    expect(r.suggestions).toHaveLength(0);
  });

  it("the same book, run anyway by the user (noGate): no skip note, the engine runs", async () => {
    const r = await run(["<h1>ספר</h1>", ...MENTIONS], { noGate: true });
    expect(skipped(r)).toBe(false);
  });

  it("one line with a place word and a number opens it, as before (control)", async () => {
    const r = await run(["<h1>ספר</h1>", ...MENTIONS, "כמו שנאמר בבראשית פרק א ועוד"]);
    expect(skipped(r)).toBe(false);
    expect(r.suggestions.length).toBeGreaterThan(0);
  });

  it("a name and two numbers opens it with no place word at all, as 'ישעיה ב, ג' does (a book that cites the way Tanakh is cited)", async () => {
    // (the one-line base here has no verse to resolve to: what is asked is whether the engine RUNS)
    expect(skipped(await run(["<h1>ספר</h1>", ...MENTIONS, "כמו שנאמר (בראשית א, א) ועוד"]))).toBe(false);
  });

  it("a four-line book whose only form is '<book> <daf>:' runs (issue #41 B6: it was skipped before, the form being 'weak')", async () => {
    const lines = ["<h1>ספר</h1>", "כמו שנאמר בראשית יג: ועוד", "ועיין בראשית ב. ושם", "וכן (בראשית ג:) ועוד", "ועוד בבראשית ד. ושם"];
    expect(skipped(await run(lines))).toBe(false);
  });

  it("lines that only mention a place or a source, with no number, open nothing however many there are: there is no address to link to", async () => {
    const lines = ["<h1>ספר</h1>", ...Array.from({ length: 60 }, () => "ראה בסימן ובסעיף שלמעלה ושם בגמרא")];
    expect(skipped(await run(lines))).toBe(true);
    expect(skipped(await run(lines, { noGate: true }))).toBe(false);
  });
});
