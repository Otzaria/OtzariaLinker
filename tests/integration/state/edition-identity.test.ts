import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { strToU8 } from "fflate";
import initSqlJs from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import type { Link } from "../../../src/core/links/model";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * V7 §1.1 (the owner's round 2, items 1–6 and 11): a link is bound to its book by title, origin, the label of its source and
 * the book's EDITION (state/edition.ts) — through closing a database, a worker replacement and a project restore. Two personal
 * databases whose books have the same title are two books: a link of one never moves to the other because it is the one left
 * open. What the project knows of each book (its lines and edition) is kept per book, not per title.
 *
 * The databases: tests/fixtures/db/pdc-personal-mini.db (a real Personal-DB-Creator slice, its book "PLACEHOLDER base" has 4
 * lines), and the same file with one line's text changed through sql.js (the schema untouched): another edition of that book.
 */
const require = createRequire(import.meta.url);
const ORIGINAL = new Uint8Array(readFileSync("tests/fixtures/db/pdc-personal-mini.db"));
let EDITED: Uint8Array;
beforeAll(async () => {
  const SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
  const db = new SQL.Database(ORIGINAL);
  // line 1 of "PLACEHOLDER base" (book 11): another text, the same number of lines
  db.run("UPDATE line_content SET content = 'PLACEHOLDER line 11/1 — another edition' WHERE id = (SELECT id FROM line WHERE bookId = 11 AND lineIndex = 1)");
  EDITED = db.export();
  db.close();
});
const TIME = 1_700_000_000_000;
const db = (path: string, bytes: Uint8Array, lastModified = TIME) => ({ path, blob: new File([bytes as Uint8Array<ArrayBuffer>], path.split("/").at(-1)!, { lastModified }) });
const A = () => db("a.db", ORIGINAL);
const B = () => db("b.db", EDITED);
const BIUR = () => ({ path: "mine/ביאור.txt", blob: new Blob([strToU8(["<h1>ביאור</h1>", "ביאור ראשון", "ביאור שני", "ביאור שלישי"].join("\n"))]) });
const BASE = "PLACEHOLDER base";

/** a store over a registry that can be replaced, as the worker host replaces a lost worker */
function newStore() {
  let current = registryService(new SourceRegistry());
  let workers = 1;
  const service = new Proxy({} as BooksService, { get: (_t, k) => (current as unknown as Record<string | symbol, unknown>)[k] });
  const store = new AppStore(service, { save: () => {} }, loadPreferences(null));
  const loseWorker = () => {
    const r = new SourceRegistry();
    r.useIdPrefix(`w${++workers}-`);
    current = registryService(r);
    store.workerLost("העובד הופעל מחדש.");
  };
  return { store, loseWorker };
}
/** the editions read in the background, and what waits on them (a code without editions only lets the reads finish) */
const settle = (s: AppStore) => (s as Partial<AppStore>).editionsSettled?.call(s) ?? new Promise((r) => setTimeout(r, 20));
const sourceOf = (s: AppStore, label: string) => s.sources.value.find((x) => x.info.label === label)!;
const baseIn = (s: AppStore, label: string) => sourceOf(s, label).books.find((b) => b.title === BASE)!.key;
const keyOf = (s: AppStore, title: string) => [...s.books.value.values()].find((b) => b.title === title)!.key;

/** the link to a.db's book (BIUR 1 → base 1) and the one to b.db's (BIUR 2 → base 3) */
const toA = (s: AppStore) => s.allLinks.value.find((l) => l.source.line === 1)!;
const toB = (s: AppStore) => s.allLinks.value.find((l) => l.source.line === 2)!;

async function worked(): Promise<{ store: AppStore; project: string }> {
  const { store } = newStore();
  await store.openFiles([A()]);
  await store.openFiles([B()]);
  await store.openFiles([BIUR()]);
  const link = (line: number, label: string, target: number) => {
    store.pickLine("source", keyOf(store, "ביאור"), line);
    store.pickLine("target", baseIn(store, label), target);
    expect(store.createFromDraft()).not.toBeNull();
  };
  link(1, "a.db", 1);
  link(2, "b.db", 3);
  await settle(store);
  return { store, project: store.projectText() };
}
/** where a link's target is: the label of the source of the book it is bound to, or "unresolved" */
const whereIs = (s: AppStore, l: Link) => {
  const b = s.bookOf(l.target.book);
  return b ? s.sourceLabelOf(b.key) : "unresolved";
};

describe("two personal databases with a book of the same title (item 11)", () => {
  const orders: [string, (s: AppStore, p: string) => Promise<void>][] = [
    ["a, b, project", async (s, p) => (await s.openFiles([A()]), await s.openFiles([B(), BIUR()]), s.openProject("p", p))],
    ["b, a, project", async (s, p) => (await s.openFiles([B()]), await s.openFiles([A(), BIUR()]), s.openProject("p", p))],
    ["project, a, b", async (s, p) => (s.openProject("p", p), await s.openFiles([A(), BIUR()]), await s.openFiles([B()]))],
    ["project, b, a", async (s, p) => (s.openProject("p", p), await s.openFiles([B(), BIUR()]), await s.openFiles([A()]))],
    ["a, project, b", async (s, p) => (await s.openFiles([A(), BIUR()]), s.openProject("p", p), await s.openFiles([B()]))],
    ["b, project, a", async (s, p) => (await s.openFiles([B(), BIUR()]), s.openProject("p", p), await s.openFiles([A()]))],
  ];
  for (const [name, open] of orders)
    it(`each link comes back to its own database: ${name}`, async () => {
      const { project } = await worked();
      const { store } = newStore();
      await open(store, project);
      await settle(store);
      expect(whereIs(store, toA(store))).toBe("a.db");
      expect(whereIs(store, toB(store))).toBe("b.db");
      expect(store.linksOfBook(baseIn(store, "a.db")).map((l) => l.target.line)).toEqual([1]);
      expect(store.linksOfBook(baseIn(store, "b.db")).map((l) => l.target.line)).toEqual([3]);
    });

  it("the project keeps one record per book, not per title: each with its own edition (items 4, 6)", async () => {
    const { project } = await worked();
    const lines = (JSON.parse(project).bookLines as { title: string; source?: string; edition?: string }[]).filter((b) => b.title === BASE);
    expect(lines.map((b) => b.source).sort()).toEqual(["a.db", "b.db"]);
    expect(lines[0]!.edition).toMatch(/^4:[0-9a-f]{16}$/);
    expect(lines[0]!.edition).not.toBe(lines[1]!.edition);
  });

  it("closing a: its link waits for a, and is not attached to b's book of that title (items 2, 3)", async () => {
    const { store } = await worked();
    await store.closeSource(sourceOf(store, "a.db").info.id);
    await settle(store);
    expect(whereIs(store, toA(store))).toBe("unresolved");
    expect(toA(store).target.book.source).toBe("a.db");
    expect(whereIs(store, toB(store))).toBe("b.db");
    expect(store.linksOfBook(baseIn(store, "b.db")).map((l) => l.target.line)).toEqual([3]);
    // a again: back on its book
    await store.openFiles([A()]);
    expect(whereIs(store, toA(store))).toBe("a.db");
  });

  it("closing both, then opening them in the other order: each link on its own book", async () => {
    const { store } = await worked();
    await store.closeSource(sourceOf(store, "b.db").info.id);
    await store.closeSource(sourceOf(store, "a.db").info.id);
    await store.openFiles([B()]);
    expect(whereIs(store, toA(store))).toBe("unresolved");
    expect(whereIs(store, toB(store))).toBe("b.db");
    await store.openFiles([A()]);
    expect(whereIs(store, toA(store))).toBe("a.db");
    expect(whereIs(store, toB(store))).toBe("b.db");
  });

  it("a worker replacement keeps the source of every link: the books opened again in any order bind right (item 3)", async () => {
    const { project } = await worked();
    const { store, loseWorker } = newStore();
    await store.openFiles([A(), B(), BIUR()]);
    store.openProject("p", project);
    loseWorker();
    expect(toA(store).target.book.source).toBe("a.db");
    expect(toB(store).target.book.source).toBe("b.db");
    await store.openFiles([B(), BIUR()]);
    expect(whereIs(store, toA(store))).toBe("unresolved");
    expect(whereIs(store, toB(store))).toBe("b.db");
    await store.openFiles([A()]);
    expect(whereIs(store, toA(store))).toBe("a.db");
  });

  it("restored with only b open: a's link stays unresolved, a.db is listed to open, and the user is asked before any binding", async () => {
    const { project } = await worked();
    const { store } = newStore();
    await store.openFiles([B(), BIUR()]);
    store.openProject("p", project);
    await settle(store);
    expect(whereIs(store, toA(store))).toBe("unresolved");
    expect(store.missingSources.value.map((s) => s.label)).toEqual(["a.db"]);
    // in the export too, a's link is not b's book: its lines are not checked against b's text
    const qa = (await store.quality.run())!;
    expect(qa.issues.some((i) => i.link.id === toA(store).id && i.problem.code === "export/book-changed")).toBe(false);
    const offer = store.notices.value.find((n) => n.action?.label === "קשרו לספר הפתוח");
    expect(offer?.text).toContain('"a.db"');
    expect(offer?.text).toContain('"b.db"');
    // the user says it is the same book: bound, and the check says its text is not the saved edition
    offer!.action!.run();
    expect(whereIs(store, toA(store))).toBe("b.db");
    const after = (await store.quality.run())!;
    expect(after.issues.some((i) => i.link.id === toA(store).id && i.problem.code === "export/book-changed")).toBe(true);
  });
});

describe("a renamed or copied database: the edition decides (items 2, 5)", () => {
  it("a.db renamed: its links bind to the renamed file by edition, never to b's book", async () => {
    const { project } = await worked();
    const { store } = newStore();
    await store.openFiles([B(), BIUR()]);
    await store.openFiles([db("a renamed.db", ORIGINAL, TIME + 1)]);
    store.openProject("p", project);
    await settle(store);
    expect(whereIs(store, toA(store))).toBe("a renamed.db");
    expect(whereIs(store, toB(store))).toBe("b.db");
    // the renamed file is the same edition: nothing changed
    const qa = (await store.quality.run())!;
    expect(qa.issues.some((i) => i.problem.code === "export/book-changed")).toBe(false);
    // saved again, the book is named by its new label
    const again = JSON.parse(store.projectText());
    expect(again.links.find((l: { source: { line: number } }) => l.source.line === 1).target.book.source).toBe("a renamed.db");
  });

  it("two databases with the same file name (two folders): each link binds by its edition", async () => {
    const { store: a } = newStore();
    await a.openFiles([db("x/user_books.db", ORIGINAL)]);
    await a.openFiles([db("y/user_books.db", EDITED)]);
    await a.openFiles([BIUR()]);
    const [first, second] = a.sources.value.filter((s) => s.info.label === "user_books.db").map((s) => s.books.find((b) => b.title === BASE)!.key);
    a.pickLine("source", keyOf(a, "ביאור"), 1);
    a.pickLine("target", first!, 1);
    a.createFromDraft();
    a.pickLine("source", keyOf(a, "ביאור"), 2);
    a.pickLine("target", second!, 3);
    a.createFromDraft();
    await settle(a);
    const project = a.projectText();
    // two records of one title and one label: two books, two editions
    expect((JSON.parse(project).bookLines as { title: string }[]).filter((b) => b.title === BASE)).toHaveLength(2);
    for (const order of [["y", "x"], ["x", "y"]] as const) {
      const { store } = newStore();
      await store.openFiles([BIUR()]);
      store.openProject("p", project);
      for (const dir of order) await store.openFiles([db(`${dir}/user_books.db`, dir === "x" ? ORIGINAL : EDITED)]);
      await settle(store);
      // the sources of that name, in the order they were opened
      const named = store.sources.value.filter((s) => s.info.label === "user_books.db");
      const baseOf = (dir: "x" | "y") => named[order.indexOf(dir)]!.books.find((b) => b.title === BASE)!.key;
      expect(store.bookOf(toA(store).target.book)?.key).toBe(baseOf("x"));
      expect(store.bookOf(toB(store).target.book)?.key).toBe(baseOf("y"));
    }
  });

  it("a project without editions (saved before V7) is not bound to a renamed file silently: the user is asked", async () => {
    const { project } = await worked();
    const old = JSON.parse(project);
    for (const b of old.bookLines) delete b.edition;
    const { store } = newStore();
    await store.openFiles([db("a renamed.db", ORIGINAL, TIME + 1), BIUR()]);
    store.openProject("p", JSON.stringify(old));
    await settle(store);
    expect(whereIs(store, toA(store))).toBe("unresolved");
    const offer = store.notices.value.find((n) => n.action?.label === "קשרו לספר הפתוח")!;
    offer.action!.run();
    expect(whereIs(store, toA(store))).toBe("a renamed.db");
  });
});

describe("a changed book is said by its identity, not by its title (item 4)", () => {
  it("b.db replaced by another edition under the same name: only b's link is 'changed', and its text change is seen with the same line count", async () => {
    const { project } = await worked();
    const { store } = newStore();
    // the same names; b.db now holds a's text (the same 4 lines, another text in line 1)
    await store.openFiles([A(), db("b.db", ORIGINAL, TIME + 5), BIUR()]);
    store.openProject("p", project);
    await settle(store);
    expect(whereIs(store, toB(store))).toBe("b.db");
    const qa = (await store.quality.run())!;
    const changed = qa.issues.filter((i) => i.problem.code === "export/book-changed");
    expect(changed.map((i) => i.link.id)).toEqual([toB(store).id]);
    expect(changed[0]!.problem.message).toContain("מספר השורות לא השתנה");
    expect(store.notices.value.some((n) => n.kind === "warning" && n.details?.some((d) => d.includes('"b.db"')))).toBe(true);
    // "checked": the new edition becomes the project's, for b's book only
    store.acceptBookChange([toB(store).target.book]);
    expect((await store.quality.run())!.issues.some((i) => i.problem.code === "export/book-changed")).toBe(false);
  });
});
