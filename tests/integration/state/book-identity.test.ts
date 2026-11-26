import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * Issue #41 B18 (V7 §1.1): a project names a book by title AND origin. When a library book of the same
 * title is open as well, a link of the personal book must come back to the personal book — in every order
 * the sources and the project are opened — and never silently to the library's edition.
 */
const PDC = () => ({ path: "personal.db", blob: new Blob([readFileSync("tests/fixtures/db/pdc-personal-mini.db")]) });
const text = (path: string, lines: readonly string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });
const SAME_TITLE = () => text("library/PLACEHOLDER base.txt", ["<h1>PLACEHOLDER base</h1>", "שורה אחת", "שורה שתיים", "שורה שלוש", "שורה ארבע", "שורה חמש"]);
const BIUR = () => text("mine/ביאור.txt", ["<h1>ביאור</h1>", "ביאור ראשון", "ביאור שני"]);

const newStore = () => new AppStore(registryService(new SourceRegistry()), { save: () => {} }, loadPreferences(null));
const keyOf = (store: AppStore, title: string, origin?: string) => [...store.books.value.values()].find((b) => b.title === title && (!origin || b.origin === origin))!.key;

/** a project with one manual link from "ביאור" to line 2 of the PERSONAL "PLACEHOLDER base" */
async function savedProject(): Promise<string> {
  const store = newStore();
  await store.openFiles([PDC()]);
  await store.openFiles([BIUR()]);
  const personal = keyOf(store, "PLACEHOLDER base", "personal");
  store.pickLine("source", keyOf(store, "ביאור"), 1);
  store.pickLine("target", personal, 2);
  expect(store.createFromDraft()).not.toBeNull();
  expect(store.allLinks.value[0]!.target.book.origin).toBe("personal");
  return store.projectText();
}

describe("book identity across sources (B18)", () => {
  const orders: [string, (s: AppStore, project: string) => Promise<void>][] = [
    ["personal first, then the library book, then the project", async (s, p) => (await s.openFiles([PDC()]), await s.openFiles([SAME_TITLE(), BIUR()]), s.openProject("p", p))],
    ["library book first, then personal, then the project", async (s, p) => (await s.openFiles([SAME_TITLE(), BIUR()]), await s.openFiles([PDC()]), s.openProject("p", p))],
    ["the project first, then the library book, then personal", async (s, p) => (s.openProject("p", p), await s.openFiles([SAME_TITLE(), BIUR()]), await s.openFiles([PDC()]))],
    ["the project first, then personal, then the library book", async (s, p) => (s.openProject("p", p), await s.openFiles([PDC()]), await s.openFiles([SAME_TITLE(), BIUR()]))],
  ];
  for (const [name, open] of orders)
    it(`the personal book keeps its link: ${name}`, async () => {
      const project = await savedProject();
      const store = newStore();
      await open(store, project);
      const link = store.allLinks.value.find((l) => l.provenance !== "db")!;
      expect(link.target.book.key).toBe(keyOf(store, "PLACEHOLDER base", "personal"));
      expect(link.target.book.origin).toBe("personal");
    });

  it("with only the library book of that name open, the link stays unresolved instead of moving to it", async () => {
    const project = await savedProject();
    const store = newStore();
    await store.openFiles([SAME_TITLE(), BIUR()]);
    store.openProject("p", project);
    const link = store.allLinks.value.find((l) => l.provenance !== "db")!;
    expect(link.target.book.key.startsWith("unresolved:")).toBe(true);
    expect(link.target.book.origin).toBe("personal");
  });

  it("save, reopen, save again: the identity does not drift", async () => {
    const project = await savedProject();
    const a = newStore();
    await a.openFiles([SAME_TITLE(), BIUR()]);
    await a.openFiles([PDC()]);
    a.openProject("p", project);
    const again = a.projectText();
    const b = newStore();
    await b.openFiles([PDC()]);
    await b.openFiles([SAME_TITLE(), BIUR()]);
    b.openProject("p", again);
    expect(b.allLinks.value.find((l) => l.provenance !== "db")!.target.book.key).toBe(keyOf(b, "PLACEHOLDER base", "personal"));
  });

  it("an old project without a known origin still binds by title (a library book first, as before)", async () => {
    const project = (await savedProject()).replaceAll('"origin":"personal"', '"origin":"unknown"');
    const store = newStore();
    await store.openFiles([SAME_TITLE(), BIUR()]);
    await store.openFiles([PDC()]);
    store.openProject("p", project);
    const link = store.allLinks.value.find((l) => l.provenance !== "db")!;
    expect(link.target.book.key).toBe(keyOf(store, "PLACEHOLDER base", "otzaria"));
  });
});
