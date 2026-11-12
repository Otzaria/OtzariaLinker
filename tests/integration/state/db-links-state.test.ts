import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storedLinkIdentity } from "../../../src/core/links/equality";
import type { Link } from "../../../src/core/links/model";
import { countVisibleChars } from "../../../src/core/text/offsets";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * Database links in the application state (stage 10), end to end without UI, on the real
 * schema-7 slice: list a book's links, filter, the picked line's links, copy one into the project,
 * and the export's rule that a copied link never silently replaces the book's library file.
 *
 * The expected record is REAL: pninimToOtzaria/links/ארצות החיים_links.json in Otzaria/otzaria-library
 * @aa2c293b — the record that produced link 13469515 (ארצות החיים 323 → המאיר לארץ 1307, start 33).
 */
const LIBRARY_RECORD = { line_index_1: 323, heRef_2: 'המאיר לארץ על ארצות החיים, סימן יא, סעיף ד ס"ק יח', path_2: "המאיר לארץ על ארצות החיים.txt", line_index_2: 1307, start: 33, "Conection Type": "commentary" };

function makeStore() {
  const reg = new SourceRegistry();
  const service = registryService(reg);
  const saved: { name: string; data: Uint8Array | string }[] = [];
  const store = new AppStore(service, { save: (name, data) => saved.push({ name, data }) }, loadPreferences(null));
  return { store, saved };
}
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };

async function opened() {
  const { store, saved } = makeStore();
  await store.openFiles([DB]);
  const byTitle = (t: string) => [...store.books.value.values()].find((b) => b.title === t)!;
  const arzot = byTitle("ארצות החיים");
  const meir = byTitle("המאיר לארץ על ארצות החיים");
  store.showBook("source", arzot.key);
  store.showBook("target", meir.key);
  store.dbLinks.side.value = "source";
  await store.dbLinks.loadSummary(arzot.key);
  return { store, saved, arzot, meir };
}

describe("database links in the links tab", () => {
  it("summary and a filtered page of the book in the source reader", async () => {
    const { store, meir } = await opened();
    const s = store.dbLinks.summary.value;
    expect(s && "total" in s && s).toMatchObject({ total: 6, out: 6, in: 0 });
    store.dbLinks.setFilter({ otherBookKey: meir.key });
    await store.dbLinks.loadPage();
    const list = store.dbLinks.list.value!;
    expect(list.total).toBe(3);
    expect(list.links.every((l) => l.target.book.key === meir.key && l.provenance === "db")).toBe(true);
  });

  it("the picked line: project links and database links, kept apart", async () => {
    const { store, arzot, meir } = await opened();
    store.pickLine("source", arzot.key, 322);
    await store.lines.loadExisting(arzot.key, 322, 322);
    let v = store.dbLinks.lineLinks("source")!;
    expect(v.project).toEqual([]);
    expect(v.db!.map((l) => l.id)).toEqual([expect.stringMatching(/:link:13469515$/)]);
    // a project link on the same line shows on the project side only
    store.pickLine("target", meir.key, 1308);
    store.createFromDraft();
    store.pickLine("source", arzot.key, 322);
    v = store.dbLinks.lineLinks("source")!;
    expect(v.project).toHaveLength(1);
    expect(v.db).toHaveLength(1);
  });

  it("copying a database link rebuilds the library's record — and the export will not replace the book's file blindly", async () => {
    const { store, saved, arzot } = await opened();
    await store.dbLinks.loadPage();
    const dbl = store.dbLinks.list.value!.links.find((l) => l.id.endsWith(":link:13469515"))!;
    expect(await store.dbLinks.adopt([dbl])).toBe(1);
    const copy = store.allLinks.value[0]!;
    expect(copy).toMatchObject({ provenance: "db-copy", status: "new", source: { line: 322 }, target: { line: 1306 }, declaredType: "commentary" });
    expect(storedLinkIdentity(copy)).toBe(storedLinkIdentity(dbl));
    // the anchor: the library's raw offset, and the generator's visible count of it is the database's
    const text = store.lines.peek(arzot.key, 322)!.anchorText;
    expect(countVisibleChars(text, copy.anchor!.rawStart)).toBe(dbl.dbAnchors![0]!.charStart);
    expect(copy.anchor!.rawStart).toBe(LIBRARY_RECORD.start);
    expect(store.dbLinks.inProject(dbl)).toBe("same-link");
    // copying it again adds nothing
    expect(await store.dbLinks.adopt([dbl])).toBe(0);

    // the book's links file is not in the project: held back, with the reason
    let plan = (await store.exchange.prepareExport())!;
    expect(plan.files).toEqual([]);
    expect(plan.heldBack[0]!.problems.map((p) => p.code)).toContain("export/db-copy-no-file");

    // the user confirms the library has no file for the book: a new file is written
    store.dbLinks.confirmNewFile("ארצות החיים");
    plan = (await store.exchange.prepareExport())!;
    expect(plan.files.map((f) => [f.name, f.isNewFile])).toEqual([["ארצות החיים_links.json", true]]);
    store.exchange.saveExport(plan);
    const rec = JSON.parse(saved[0]!.data as string)[0];
    const { heRef_2: _h, ...same } = LIBRARY_RECORD;
    expect(rec).toMatchObject(same);
    expect(rec.heRef_2).toBe("המאיר לארץ על ארצות החיים 1307"); // the database's reference, not the file's

    store.undo(); // the copy goes away as one action
    expect(store.allLinks.value).toEqual([]);
  });

  it("loading the book's library file replaces the copy by the original record", async () => {
    const { store } = await opened();
    await store.dbLinks.loadPage();
    await store.dbLinks.adopt(store.dbLinks.list.value!.links.filter((l) => l.id.endsWith(":link:13469515")));
    // the next record of the same file (real too)
    const other = { ...LIBRARY_RECORD, heRef_2: 'המאיר לארץ על ארצות החיים, סימן יא, סעיף ד ס"ק יט', line_index_2: 1309, start: 55 };
    const file = { path: "pninimToOtzaria/links/ארצות החיים_links.json", blob: new Blob([JSON.stringify([LIBRARY_RECORD, other])]) };
    const unrelated = { path: "pninimToOtzaria/links/אחר_links.json", blob: new Blob(["[]"]) };
    expect(await store.dbLinks.loadLinksFiles([unrelated, file], ["ארצות החיים"])).toEqual(["ארצות החיים"]);
    expect(store.allLinks.value.map((l) => l.provenance).sort()).toEqual(["file", "file"]);
    const plan = (await store.exchange.prepareExport())!;
    expect(plan.heldBack).toEqual([]);
    expect(plan.files.map((f) => [f.name, f.isNewFile, f.records])).toEqual([["ארצות החיים_links.json", false, 2]]);
  });

  it("the quality check reports a project link the database already has", async () => {
    const { store, arzot, meir } = await opened();
    store.pickLine("source", arzot.key, 322);
    store.pickLine("target", meir.key, 1306);
    store.draftType.value = "commentary";
    store.draftTypeTouched.value = true;
    expect(store.createFromDraft()).not.toBeNull();
    const report = (await store.quality.run())!;
    const inDb = report.issues.filter((i) => i.category === "in-db");
    expect(inDb.map((i) => i.problem.code)).toEqual(["export/in-db"]);
    // the same rule decides "already exists" in the builder's live check
    store.pickLine("source", arzot.key, 322);
    store.pickLine("target", meir.key, 1306);
    expect(store.draftProblems.value.map((p) => p.code)).toContain("export/in-db");
  });

  it("LINKER and Sefaria↔Sefaria links are refused with the reason, nothing is added", async () => {
    const { store } = await opened();
    const bereshit = [...store.books.value.values()].find((b) => b.title === "בראשית")!;
    store.showBook("source", bereshit.key);
    await store.dbLinks.loadSummary(bereshit.key);
    store.dbLinks.setFilter({ types: ["LINKER", "TARGUM"] });
    await store.dbLinks.loadPage();
    const links: Link[] = store.dbLinks.list.value!.links.slice(0, 50);
    expect(links.some((l) => l.declaredType === "linker")).toBe(true);
    expect(await store.dbLinks.adopt(links)).toBe(0);
    expect(store.notices.value.at(-1)!.text).toMatch(/לא הועתקו/);
  });
});

describe("what 'copy to the project' can copy (product audit F11)", () => {
  it("one rule for the row button and 'select the shown': Sefaria↔Sefaria links are not selectable", async () => {
    const { store } = makeStore();
    await store.openFiles([DB]);
    const bereshit = [...store.books.value.values()].find((b) => b.title === "בראשית")!;
    store.showBook("source", bereshit.key);
    store.dbLinks.side.value = "source";
    await store.dbLinks.loadSummary(bereshit.key);
    await store.dbLinks.loadPage();
    const shown = store.dbLinks.list.value!.links;
    expect(shown.length).toBeGreaterThan(0);
    const sefariaBoth = shown.filter((l) => l.source.book.origin === "sefaria" && l.target.book.origin === "sefaria");
    expect(sefariaBoth.length).toBeGreaterThan(0);
    for (const l of sefariaBoth) expect(store.dbLinks.whyNotCopyable(l)).toContain("אי אפשר");
    // whatever passes the rule is really copied: nothing selected is refused
    const copyable = shown.filter((l) => !store.dbLinks.whyNotCopyable(l));
    const made = await store.dbLinks.adopt(copyable);
    expect(made).toBe(copyable.length);
    expect(store.notices.value.some((n) => n.text.includes("לא הועתקו"))).toBe(false);
  });
});
