import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { stripTags } from "../../../src/core/text/html";
import { SourceRegistry } from "../../../src/sources/registry";
import { AppStore } from "../../../src/state/store";
import { loadPreferences } from "../../../src/state/preferences";
import { registryService } from "../../support/books-service";
import { engineJob } from "../../../src/workers/engine-job";

/*
 * Issue #27 on a real base (the Bereshit slice of tests/fixtures/db/seforim-v7-mini.db) and a commentary file written the way the issue
 * describes: some lines open with a marker "[א]" and quote the base after it, other lines also quote it but have no marker. Only the
 * marked lines are linked; the link points at the line of the ORIGINAL file and the matched words are found at their original offsets.
 */
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const text = (path: string, lines: string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });

async function setup() {
  const reg = new SourceRegistry();
  const opened = await reg.open([DB]);
  const base = opened.sources.flatMap((s) => s.books).find((b) => b.title === "בראשית")!;
  // three verses of the real base, and the first words of each, as a commentary would quote them
  const verses = (await reg.lines(base.key, 0, 40)).filter((l) => l.heading === null && stripTags(l.text).split(/\s+/).length >= 6).slice(0, 3);
  // the verses of this database open with their own number, "(א) ": the commentary quotes the words after it
  const quote = (i: number) => stripTags(verses[i]!.text).replace(/^\(\S+\)\s*/, "").split(/\s+/).slice(0, 3).join(" ");
  const lines = ["<h1>פירוש על בראשית</h1>", `[א] <b>${quote(0)}</b> – פירוש ראשון על הדברים`, `<b>${quote(1)}</b> – שורה שאינה מסומנת בסוגריים מרובעות`, `[ב] <b>${quote(2)}</b> – פירוש שלישי על הדברים`];
  const comm = await reg.open([text("פירוש על בראשית.txt", lines)]);
  const dep = comm.sources.flatMap((s) => s.books).find((b) => b.title === "פירוש על בראשית")!;
  return { reg, base, dep, lines, quote, verses };
}

describe("a source filter over a real base", () => {
  it("without the filter every quoting line is linked", async () => {
    const { reg, base, dep } = await setup();
    const r = await engineJob(reg, "dibur-hamatchil", dep, base, { anchors: "off" }, {});
    expect(r.suggestions.map((s) => s.source.line).sort()).toEqual([1, 2, 3]);
  });

  it("with [א]-style lines only: the marked lines, at their original line numbers, and the quoted words at their original offsets", async () => {
    const { reg, base, dep, lines, quote, verses } = await setup();
    const r = await engineJob(reg, "dibur-hamatchil", dep, base, { anchors: "off", sourceFilter: { prefix: { preset: "square" } } }, {});
    const found = [...r.suggestions].sort((a, b) => a.source.line - b.source.line);
    expect(found.map((s) => s.source.line)).toEqual([1, 3]);
    for (const s of found) {
      const line = lines[s.source.line]!;
      const words = quote(s.source.line === 1 ? 0 : 2);
      expect(line.slice(s.matched!.source!.rawStart, s.matched!.source!.rawEnd)).toBe(words);
      expect(s.matched!.source!.rawStart).toBe(line.indexOf(words));
      // the target is the verse that was quoted
      expect(s.target.line).toBe(verses[s.source.line === 1 ? 0 : 2]!.index);
    }
    expect(r.notes.map((n) => n.code)).toContain("source-filter/applied");
  });

  it("the preview says which lines would enter, before anything runs (state method)", async () => {
    const { lines } = await setup();
    const store = new AppStore(registryService(new SourceRegistry()), { save: () => {} }, loadPreferences(null));
    await store.openFiles([text("פירוש על בראשית.txt", lines)]);
    const key = [...store.books.value.values()].find((b) => b.title === "פירוש על בראשית")!.key;
    const p = await store.suggestions.previewSourceFilter(key, { prefix: { preset: "square" } }, "dibur-hamatchil");
    expect(p).toMatchObject({ total: 3, included: 2, excluded: 1, headings: 1 });
    expect(p && "includedSample" in p && p.includedSample.map((x) => [x.line, x.prefix])).toEqual([[1, "[א]"], [3, "[ב]"]]);
    expect(p && "excludedSample" in p && p.excludedSample.map((x) => x.line)).toEqual([2]);
    expect(await store.suggestions.previewSourceFilter(key, { prefix: { regex: "(a+)+$" } }, "dibur-hamatchil")).toHaveProperty("error");
  });
});
