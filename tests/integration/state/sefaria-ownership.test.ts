import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * Product audit F1, F2, F12 end to end, with the audit's own inputs (scripts/audit/make_inputs.py):
 * a text file or a personal database named "בראשית" is the user's book, not the library's Sefaria
 * book; the official database's "בראשית" is. The engines, the builder, the quality check and the
 * export decide it by one rule (core/links/sefaria-titles.ts).
 */
const require = createRequire(import.meta.url);
const GEN1 = ["בראשית ברא אלהים את השמים ואת הארץ.", "והארץ היתה תהו ובהו וחשך על פני תהום ורוח אלהים מרחפת על פני המים.", "ויאמר אלהים יהי אור ויהי אור.", "וירא אלהים את האור כי טוב ויבדל אלהים בין האור ובין החשך."];
const DH = ["בראשית ברא", "תהו ובהו", "יהי אור", "כי טוב"];
const HEB = ["א", "ב", "ג", "ד"];
const BASE_LINES = ["<h1>בראשית</h1>", "<h2>פרק א</h2>", ...GEN1];
const COMM_LINES = ["<h1>ביאור חדש על בראשית</h1>", "<h2>פרק א</h2>", ...DH.flatMap((d, i) => [`<h3>פסוק ${HEB[i]}</h3>`, `${d} - ביאור: כאן בא הסבר קצר על הפסוק.`])];
const txt = (path: string, lines: string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });
const BASE = txt("s1/בראשית.txt", BASE_LINES);
const COMM = txt("s1/ביאור חדש על בראשית.txt", COMM_LINES);
const MINI = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };

/** a personal database in the Otzaria schema (v5), as make_inputs.py builds it: source "אישי", no Sefaria books */
async function personalDb(name: string, books: [string, string[]][]) {
  const SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
  const db = new SQL.Database();
  db.exec(readFileSync("tests/fixtures/schemas/v5.sql", "utf8"));
  db.run("insert into source(id,name) values(1,'אישי')");
  db.run("insert into category(id,parentId,title,level) values(1,null,'ספרייה אישית',0)");
  let lid = 1;
  books.forEach(([title, lines], i) => {
    db.run("insert into book(id,categoryId,sourceId,title,totalLines) values(?,?,?,?,?)", [i + 1, 1, 1, title, lines.length]);
    lines.forEach((ln, j) => db.run("insert into line(id,bookId,lineIndex,content,heRef,charCount) values(?,?,?,?,?,?)", [lid++, i + 1, j, ln, null, ln.length]));
  });
  return { path: name, blob: new Blob([new Uint8Array(db.export())]) };
}

function makeStore() {
  const saved: { name: string; data: Uint8Array | string }[] = [];
  return { store: new AppStore(registryService(), { save: (name, data) => saved.push({ name, data }) }, loadPreferences(null)), saved };
}
const bookOf = (store: AppStore, title: string, sourceLabel?: string) =>
  [...store.books.value.values()].find((b) => b.title === title && (!sourceLabel || store.sources.value.find((s) => b.key.startsWith(`${s.info.id}:`))?.info.label === sourceLabel))!;

async function dhRunApproved(store: AppStore) {
  const comm = bookOf(store, "ביאור חדש על בראשית");
  const base = bookOf(store, "בראשית");
  expect(await store.suggestions.runEngine("dibur-hamatchil", comm.key, base.key)).toBe(true);
  const ids = store.suggestions.run.value!.result.suggestions.map((s) => s.id);
  expect(ids.length).toBe(4);
  store.suggestions.approve(ids);
  return store.allLinks.value;
}
/** why links were held back: the errors */
const heldCodes = (plan: { heldBack: { problems: { code: string; severity: string }[] }[] }) => [...new Set(plan.heldBack.flatMap((h) => h.problems.filter((p) => p.severity === "error").map((p) => p.code)))].sort();

describe("a text file named like a Sefaria book is the user's book (F2)", () => {
  it("is not Sefaria-owned: no ref_2 in the builder, anchors from dibur-hamatchil, a clean private export", async () => {
    const { store } = makeStore();
    await store.openFiles([BASE, COMM]);
    const base = bookOf(store, "בראשית");
    expect(store.isSefariaOwned(store.refOf(base.key))).toBe(false);
    expect(store.sefariaNamedBooks(base.key.split(":")[0]!)).toEqual(["בראשית"]);
    const links = await dhRunApproved(store);
    expect(links.every((l) => l.anchor !== undefined)).toBe(true);
    store.exportPurpose.value = "private";
    const plan = (await store.exchange.prepareExport())!;
    expect(plan.heldBack).toEqual([]);
    expect(plan.written.length).toBe(4);
  });

  it("sent to the library it is held back in plain words — never with a request for English refs", async () => {
    const { store } = makeStore();
    await store.openFiles([BASE, COMM]);
    await dhRunApproved(store);
    const plan = (await store.exchange.prepareExport())!;
    expect(heldCodes(plan)).toEqual(["sefaria/not-library-edition"]);
    // the quality check says the same as the export (one validation)
    const q = store.validation();
    expect(q.sefariaOwned!(store.refOf(bookOf(store, "בראשית").key))).toBe(false);
  });

  it("the source switch makes it the library's book: the engines then write no anchor (F1) and the rules apply", async () => {
    const { store } = makeStore();
    await store.openFiles([BASE, COMM]);
    const base = bookOf(store, "בראשית");
    const sid = base.key.slice(0, base.key.indexOf(":"));
    store.setLibrarySource(sid, true);
    expect(store.isLibrarySource(sid)).toBe(true);
    expect(store.isSefariaOwned(store.refOf(base.key))).toBe(true);
    const links = await dhRunApproved(store);
    expect(links.every((l) => !l.anchor && l.target.book.title === "בראשית")).toBe(true);
    // a text file has no database reference to build ref_2 from: for the library it waits for one,
    // for private use it is written — and nothing about the anchor, in either mode
    let plan = (await store.exchange.prepareExport())!;
    expect(heldCodes(plan)).toEqual(["sefaria/ref2-required"]);
    store.exportPurpose.value = "private";
    plan = (await store.exchange.prepareExport())!;
    expect(plan.heldBack).toEqual([]);
    store.setLibrarySource(sid, false);
    expect(store.isSefariaOwned(store.refOf(base.key))).toBe(false);
  });

  it("a folder that is a library checkout (it has the library's Sefaria list) is the library", async () => {
    const { store } = makeStore();
    await store.openFiles([txt("otzaria-library/books/בראשית.txt", BASE_LINES), txt("otzaria-library/.github/data/sefaria_he_titles.txt", ["בראשית"])]);
    const base = bookOf(store, "בראשית");
    expect(store.isSefariaOwned(store.refOf(base.key))).toBe(true);
  });
});

describe("a personal database in the Otzaria schema (F12, F2)", () => {
  it("is labelled personal, its books are 'personal', and its בראשית is not Sefaria-owned", async () => {
    const { store } = makeStore();
    await store.openFiles([await personalDb("אישי-מקורות.db", [["בראשית", BASE_LINES]])]);
    const src = store.sources.value[0]!;
    expect(src.info.library).toBe(false);
    expect(src.books.every((b) => b.origin === "personal")).toBe(true);
    expect(store.isSefariaOwned(store.refOf(bookOf(store, "בראשית").key))).toBe(false);
  });

  it("the official database is the library: its בראשית is Sefaria-owned even beside the user's", async () => {
    const { store } = makeStore();
    await store.openFiles([MINI]);
    await store.openFiles([await personalDb("אישי-מקורות.db", [["בראשית", BASE_LINES]])]);
    const [official, personal] = store.sources.value;
    expect(official!.info.library).toBe(true);
    expect(official!.books.find((b) => b.title === "בראשית")!.origin).toBe("sefaria");
    expect(store.isSefariaOwned(store.refOf(bookOf(store, "בראשית", "seforim.db").key))).toBe(true);
    expect(store.isSefariaOwned(store.refOf(bookOf(store, "בראשית", "אישי-מקורות.db").key))).toBe(false);
    // a bare title names the library's book while any open edition of it is the library's
    expect(store.isSefariaOwned({ title: "בראשית" })).toBe(true);
    expect(personal!.info.library).toBe(false);
  });
});
