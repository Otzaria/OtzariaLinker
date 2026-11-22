import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { stripTags } from "../../../src/core/text/html";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * Issue #23, the chain as far as this repository can run it, over the real Bereshit slice (tests/fixtures/db/seforim-v7-mini.db):
 *   text → recognised reference → target book → ref → anchor → export (_links.json) → import into a fresh session → the same links, on the same words.
 * NOT covered here, and never claimed: loading the file into Otzaria and clicking the anchor (needs the app; docs/contracts/OTZARIA_COMPATIBILITY.md).
 */
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const LINES = ["<h1>ספר דוגמה</h1>", "כמו שנאמר (בראשית א, א) בפסוק הראשון ובעוד מקום", "וכן מבואר בבראשית א ב בהמשך הדברים", "שורה בלי הפניה לשום מקום, רק מילים רגילות של הסבר"];
const COMMENTARY = { path: "ספר דוגמה.txt", blob: new Blob([strToU8(LINES.join("\n"))]) };

function makeStore() {
  const saved: { name: string; data: Uint8Array | string }[] = [];
  const store = new AppStore(registryService(new SourceRegistry()), { save: (name, data) => saved.push({ name, data }) }, loadPreferences(null));
  return { store, saved };
}
const keyOf = (store: AppStore, title: string) => [...store.books.value.values()].find((b) => b.title === title)!.key;

async function exported(citationType: "reference" | "inline-linker") {
  const { store, saved } = makeStore();
  await store.openFiles([DB, COMMENTARY]);
  expect(await store.suggestions.runCitations(keyOf(store, "ספר דוגמה"), { citationType })).toBe(true);
  const found = store.suggestions.run.value!.result.suggestions;
  const approvable = found.filter((s) => s.confidence === "certain" || s.confidence === "high");
  store.suggestions.approve(approvable.map((s) => s.id));
  store.exportPurpose.value = "private";
  const plan = (await store.exchange.prepareExport())!;
  store.exchange.saveExport(plan);
  // one file: the browser is handed it under its own name (the saver); its text is what the plan holds
  const file = plan.files.find((f) => f.name.endsWith("_links.json"))!;
  expect(saved.at(-1)!.name).toBe(file.name);
  expect(saved.at(-1)!.data).toBe(file.text);
  return { store, found, approvable, plan, file, text: file.text, records: JSON.parse(file.text) as Record<string, unknown>[] };
}

describe("citations: text → export → import (issue #23, as far as this repository can run it)", () => {
  it("the references the text writes out are recognised, aimed at Bereshit, and the line without one is left alone", async () => {
    const { found, approvable } = await exported("reference");
    expect(found.map((s) => s.source.line).sort()).toEqual([1, 2]);
    expect(found.every((s) => s.target.book.title === "בראשית")).toBe(true);
    expect(approvable.length).toBe(2);
    // the first mentions chapter א, verse א; the second chapter א, verse ב
    expect(found.find((s) => s.source.line === 1)!.heRef2).toContain("א");
  });

  it("the export is a valid _links.json: every approved link is written, nothing held back, each record names its target book and line", async () => {
    const { plan, records, approvable } = await exported("reference");
    expect(plan.heldBack).toEqual([]);
    expect(records).toHaveLength(approvable.length);
    for (const r of records) {
      expect(r["path_2"]).toBe("בראשית.txt");
      expect(Number.isInteger(r["line_index_1"]) && Number.isInteger(r["line_index_2"])).toBe(true);
      expect(String(r["heRef_2"])).toContain("בראשית");
    }
  });

  it("with the private INLINE_LINKER type the record carries the words of the reference as start/end, on the source line", async () => {
    const { records } = await exported("inline-linker");
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(String(r["Conection Type"]).toLowerCase()).toBe("inline_linker");
      const line = LINES[(r["line_index_1"] as number) - 1]!;
      const visible = stripTags(line);
      const words = visible.slice(r["start"] as number, r["end"] as number);
      // the anchor is the reference as written in the line (a name and numbers), not a word of the prose around it
      expect(words).toMatch(/בראשית/);
      expect(words).toMatch(/[א-ת]/);
    }
  });

  it("imported into a fresh session the same file gives the same links, on the same lines and words, with no problem the check would block", async () => {
    for (const type of ["reference", "inline-linker"] as const) {
      const first = await exported(type);
      const { store } = makeStore();
      await store.openFiles([DB, COMMENTARY]);
      // INLINE_LINKER is a type only the personal import of Otzaria knows: for the library the check holds it back, and it must (private use only)
      store.exportPurpose.value = "private";
      store.exchange.importLinksFile("ספר דוגמה_links.json", first.text);
      const links = store.allLinks.value;
      expect(links, type).toHaveLength(first.records.length);
      const key = (l: { source: { line: number }; target: { line: number; book: { title: string } } }) => `${l.source.line}>${l.target.book.title}#${l.target.line}`;
      expect(links.map(key).sort(), type).toEqual(first.store.allLinks.value.map(key).sort());
      const qa = (await store.quality.run())!;
      expect(qa.issues.filter((i) => i.problem.severity === "error" && !["in-db", "db-copy", "library-file", "unverified"].includes(i.category)), type).toEqual([]);
      // a file that was not touched is written back byte for byte
      store.exportPurpose.value = "private";
      const again = (await store.exchange.prepareExport())!;
      expect(again.written.length, type).toBe(first.records.length);
    }
  });
});
