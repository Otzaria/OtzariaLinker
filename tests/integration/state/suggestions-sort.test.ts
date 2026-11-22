import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { CONFIDENCE_ORDER } from "../../../src/linking/automatic";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * Issue 8 in the state: the suggestions list has a sort order (default: the engine's book order); the table and the
 * one-at-a-time views read the same ordered list, so "next pending" follows it, and the engine's own list (which merge,
 * rejection keys and the stored run read) is never reordered.
 */
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const heb = (n: number) => ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"][n]!;
const text = (path: string, lines: string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });
const commentary = (title: string) => text(`${title}.txt`, [`<h1>${title}</h1>`, "<h2>פרק א</h2>", ...Array.from({ length: 10 }, (_, i) => [`<h3>פסוק ${heb(i + 1)}</h3>`, `ביאור לפסוק ${i + 1}`]).flat()]);
// no verse headings: found by its opening words, so not everything is certain
const noHeadings = text("פירוש קצר על בראשית.txt", ["<h1>פירוש קצר על בראשית</h1>", "בראשית ברא - בשביל התורה.", "והארץ היתה תהו ובהו - תמהה ומשוממה.", "ורוח אלהים מרחפת - כסא הכבוד.", "ויבדל אלהים - ראהו שאינו כדאי."]);

async function ran() {
  const store = new AppStore(registryService(new SourceRegistry()), { save: () => undefined }, loadPreferences(null));
  const g = store.guided;
  g.start();
  await g.addBooks([commentary("ביאור א על בראשית"), noHeadings]);
  g.next();
  g.next();
  await g.addBases([DB]);
  g.next();
  expect(await g.run()).toBe(true);
  return store;
}

describe("the suggestions' sort order", () => {
  it("defaults to the engine's order; 'worst first' orders the view, not the run", async () => {
    const sg = (await ran()).suggestions;
    const run = sg.run.value!.result.suggestions;
    expect(sg.sortOrder.value).toBe("book");
    expect(sg.ordered.value).toBe(run);
    const levels = new Set(run.map((s) => s.confidence));
    expect(levels.size).toBeGreaterThan(1); // the fixture has more than one level, or the sort proves nothing

    const before = run.map((s) => s.id);
    sg.sortOrder.value = "worst";
    const ordered = sg.ordered.value;
    expect(ordered).toHaveLength(run.length);
    const rank = ordered.map((s) => CONFIDENCE_ORDER.indexOf(s.confidence));
    expect(rank).toEqual([...rank].sort((a, b) => b - a)); // weakest level first
    expect(sg.run.value!.result.suggestions.map((s) => s.id)).toEqual(before);
  });

  it("choosing an order puts the one-at-a-time views on the top of the new list", async () => {
    const sg = (await ran()).suggestions;
    sg.setSort("best");
    expect(sg.sortOrder.value).toBe("best");
    expect(sg.current.value).toBe(sg.ordered.value[0]!.id);
    sg.setSort("worst");
    expect(sg.current.value).toBe(sg.ordered.value[0]!.id);
    sg.setSort("book");
    expect(sg.current.value).toBe(sg.run.value!.result.suggestions[0]!.id);
  });

  it("'next pending' follows the sorted order", async () => {
    const sg = (await ran()).suggestions;
    sg.setSort("worst");
    const ordered = sg.ordered.value;
    sg.show(ordered[0]!.id);
    expect(sg.neighbour(1)).toBe(ordered[1]!.id);
    expect(sg.neighbour(-1)).toBeNull();
    // decide the second: "next pending" from the first skips it
    sg.reject([ordered[1]!.id]);
    expect(sg.neighbour(1, true)).toBe(ordered[2]!.id);
    sg.setSort("best");
    const best = sg.ordered.value;
    sg.show(best[0]!.id);
    expect(sg.neighbour(1)).toBe(best[1]!.id);
  });
});
